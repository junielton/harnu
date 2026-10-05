import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  runDrainPass,
  createDrainScheduler,
  setDrainPoke,
  pokeManifestDrain,
  type DrainPassDeps,
  type DrainCardView
} from '../src/main/manifest-drain'

/**
 * T113 — background manifest drain. `runDrainPass` is the main-process drain
 * driver: it walks the stamped Ready queue in declared order (the renderer
 * loop it replaces lived in `RoadmapBoard.vue` and died with the component —
 * the live failure this card escalated on). Pure core: every effect (load,
 * plan/reserve, worktree, spawn, bind, refund, progress events) is an injected
 * dep, mirroring the ADR-0001 pure-core convention.
 */

function card(over: Partial<DrainCardView> & { slug: string }): DrainCardView {
  return { status: 'ready', ...over }
}

/** A deps stub where every card auto-plans and every spawn succeeds. */
function makeDeps(
  cards: DrainCardView[],
  wipLimit = 5
): {
  deps: DrainPassDeps
  calls: {
    planned: string[]
    spawned: Array<{ folder: string; prompt: string; adopted?: unknown }>
    bound: Array<{
      slug: string
      sessionId: string
      dispatchedWith: string
      executedIn: string | undefined
    }>
    released: string[]
    worktrees: string[]
    rolledBack: Array<{ repoRoot: string; path: string; createdBranch: string | null }>
    resolvedBranches: string[]
    events: Array<Record<string, unknown>>
  }
} {
  const calls = {
    planned: [] as string[],
    spawned: [] as Array<{ folder: string; prompt: string; adopted?: unknown }>,
    bound: [] as Array<{
      slug: string
      sessionId: string
      dispatchedWith: string
      executedIn: string | undefined
    }>,
    released: [] as string[],
    worktrees: [] as string[],
    rolledBack: [] as Array<{ repoRoot: string; path: string; createdBranch: string | null }>,
    resolvedBranches: [] as string[],
    events: [] as Array<Record<string, unknown>>
  }
  let seq = 0
  const deps: DrainPassDeps = {
    loadState: async () => ({ cards, wipLimit }),
    plan: async (_folder, slug) => {
      calls.planned.push(slug)
      return {
        ok: true,
        mode: 'auto',
        prompt: `boot:${slug}`,
        grantId: `g-${slug}`,
        grantBudgetRemaining: 3
      }
    },
    resolveRouting: async () => ({ model: 'sonnet', effort: 'high' }),
    createWorktree: async (_folder, slug) => {
      calls.worktrees.push(slug)
      return {
        path: `/wt/${slug}`,
        repoRoot: '/repo',
        createdBranch: `card/${slug}`,
        adopted: { path: `/wt/${slug}`, gitBranch: `card/${slug}` }
      }
    },
    spawnSession: async (folder, prompt, _routing, adopted) => {
      calls.spawned.push({ folder, prompt, adopted })
      seq += 1
      return { ok: true, sessionId: `synthetic-${seq}` }
    },
    rollbackWorktree: async (repoRoot, path, createdBranch) => {
      calls.rolledBack.push({ repoRoot, path, createdBranch })
      return { rolledBack: true, branchDeleted: createdBranch }
    },
    bindSession: async (_folder, slug, sessionId, dispatchedWith, _substrate, executedIn) => {
      calls.bound.push({ slug, sessionId, dispatchedWith, executedIn })
      return true
    },
    resolveBranch: async (spawnFolder) => {
      calls.resolvedBranches.push(spawnFolder)
      return `branch-of:${spawnFolder}`
    },
    releaseGrant: (grantId) => {
      calls.released.push(grantId)
    },
    emit: (e) => {
      calls.events.push(e as unknown as Record<string, unknown>)
    }
  }
  return { deps, calls }
}

describe('runDrainPass', () => {
  it('dispatches stamped ready cards in approved (declared) order and binds each', async () => {
    const cards = [
      card({ slug: 'b', approved: '2026-07-11T00:00:00.002Z' }),
      card({ slug: 'a', approved: '2026-07-11T00:00:00.001Z' }),
      card({ slug: 'zz-unstamped' }),
      card({
        slug: 'w1',
        status: 'in-progress',
        approved: '2026-07-11T00:00:00.000Z',
        session: 's'
      })
    ]
    const { deps, calls } = makeDeps(cards)
    const res = await runDrainPass('/repo', deps)

    expect(calls.spawned.map((s) => s.prompt)).toEqual(['boot:a', 'boot:b'])
    expect(calls.bound.map((b) => b.slug)).toEqual(['a', 'b'])
    expect(calls.bound[0].dispatchedWith).toBe('dispatched-with: sonnet·high')
    expect(res).toMatchObject({ total: 2, dispatched: 2, confirmNeeded: 0 })
  })

  it('spawns in the board folder for session substrate (no worktree cut)', async () => {
    const { deps, calls } = makeDeps([card({ slug: 'a', approved: '1' })])
    await runDrainPass('/repo', deps)
    expect(calls.worktrees).toEqual([])
    expect(calls.spawned[0].folder).toBe('/repo')
  })

  it('cuts a worktree for worktree substrate and spawns inside it', async () => {
    const { deps, calls } = makeDeps([card({ slug: 'a', approved: '1', substrate: 'worktree' })])
    await runDrainPass('/repo', deps)
    expect(calls.worktrees).toEqual(['a'])
    expect(calls.spawned[0].folder).toBe('/wt/a')
    expect(calls.bound.map((b) => b.slug)).toEqual(['a'])
  })

  // BUG-63: the renderer only learns about a just-created worktree's folder via
  // a fire-and-forget push debounced 250ms (`RELOAD_DEBOUNCE_MS`) — but the
  // drain dispatches into it in the same tick `createWorktree` returns, so
  // `spawnSession` must carry the `adopted` payload through so the bridge
  // command can register the folder synchronously BEFORE dispatching,
  // independent of that debounce.
  it("threads createWorktree's adopted payload into spawnSession for worktree substrate", async () => {
    const { deps, calls } = makeDeps([card({ slug: 'a', approved: '1', substrate: 'worktree' })])
    await runDrainPass('/repo', deps)
    expect(calls.spawned[0].adopted).toEqual({ path: '/wt/a', gitBranch: 'card/a' })
  })

  it('spawns with no adopted payload for session substrate (no worktree cut)', async () => {
    const { deps, calls } = makeDeps([card({ slug: 'a', approved: '1' })])
    await runDrainPass('/repo', deps)
    expect(calls.spawned[0].adopted).toBeUndefined()
  })

  // BUG-62: createWorktree succeeds, then the spawn fails — the worktree must
  // not be left orphaned on disk, and the failure must be attributable, not a
  // bare `continue`.
  it('rolls back a created worktree when the spawn after it fails, and surfaces the reason', async () => {
    const { deps, calls } = makeDeps([card({ slug: 'a', approved: '1', substrate: 'worktree' })])
    deps.spawnSession = async (folder, prompt) => {
      calls.spawned.push({ folder, prompt })
      return { ok: false, reason: 'FOLDER_NOT_FOUND: /wt/a' }
    }
    const res = await runDrainPass('/repo', deps)

    expect(calls.worktrees).toEqual(['a']) // the worktree WAS created
    expect(calls.spawned).toHaveLength(1) // the spawn WAS attempted
    expect(calls.rolledBack).toEqual([
      { repoRoot: '/repo', path: '/wt/a', createdBranch: 'card/a' }
    ])
    expect(calls.bound).toEqual([]) // never bound — nothing dispatched
    expect(calls.released).toEqual(['g-a']) // the reserved grant unit is refunded
    expect(res).toMatchObject({ total: 1, dispatched: 0, failed: 1 })
    expect(res.failedCards).toEqual([{ slug: 'a', reason: 'FOLDER_NOT_FOUND: /wt/a' }])
  })

  it('a spawn failure with no worktree substrate never attempts a rollback', async () => {
    const { deps, calls } = makeDeps([card({ slug: 'a', approved: '1' })])
    deps.spawnSession = async () => ({ ok: false, reason: 'boom' })
    const res = await runDrainPass('/repo', deps)
    expect(calls.rolledBack).toEqual([])
    expect(res.failedCards).toEqual([{ slug: 'a', reason: 'boom' }])
  })

  it('appends a note to the reason when the rollback itself fails to fully undo the worktree', async () => {
    const { deps } = makeDeps([card({ slug: 'a', approved: '1', substrate: 'worktree' })])
    deps.spawnSession = async () => ({ ok: false, reason: 'FOLDER_NOT_FOUND' })
    deps.rollbackWorktree = async () => ({ rolledBack: false, branchDeleted: null })
    const res = await runDrainPass('/repo', deps)
    expect(res.failedCards[0].reason).toContain('FOLDER_NOT_FOUND')
    expect(res.failedCards[0].reason).toContain('rollback also failed')
  })

  it('T190: resolves the branch of the SPAWN folder (not the card folder) and stamps it on bind', async () => {
    const { deps, calls } = makeDeps([card({ slug: 'a', approved: '1' })])
    await runDrainPass('/repo', deps)
    expect(calls.resolvedBranches).toEqual(['/repo'])
    expect(calls.bound[0]).toMatchObject({ slug: 'a', executedIn: 'branch-of:/repo' })
  })

  it('T190: for worktree substrate, resolves the branch of the CUT worktree path', async () => {
    const { deps, calls } = makeDeps([card({ slug: 'a', approved: '1', substrate: 'worktree' })])
    await runDrainPass('/repo', deps)
    expect(calls.resolvedBranches).toEqual(['/wt/a'])
    expect(calls.bound[0]).toMatchObject({ slug: 'a', executedIn: 'branch-of:/wt/a' })
  })

  it('T190: an unresolvable branch (detached HEAD) binds with executedIn undefined, never blocking the dispatch', async () => {
    const { deps, calls } = makeDeps([card({ slug: 'a', approved: '1' })])
    deps.resolveBranch = async () => undefined
    const res = await runDrainPass('/repo', deps)
    expect(calls.bound[0]).toMatchObject({ slug: 'a', executedIn: undefined })
    expect(res.dispatched).toBe(1)
  })

  it('excludes internal-substrate and already-bound cards from the queue', async () => {
    const { deps, calls } = makeDeps([
      card({ slug: 'int', approved: '1', substrate: 'internal' }),
      card({ slug: 'bound', approved: '2', session: 'sess-1' }),
      card({ slug: 'ok', approved: '3' })
    ])
    const res = await runDrainPass('/repo', deps)
    expect(calls.spawned.map((s) => s.prompt)).toEqual(['boot:ok'])
    expect(res.total).toBe(1)
  })

  it('dispatches nothing when WIP is already at the ceiling', async () => {
    const cards = [
      card({ slug: 'w1', status: 'in-progress' }),
      card({ slug: 'w2', status: 'in-progress' }),
      card({ slug: 'a', approved: '1' })
    ]
    const { deps, calls } = makeDeps(cards, 2)
    const res = await runDrainPass('/repo', deps)
    expect(calls.spawned).toEqual([])
    expect(res.dispatched).toBe(0)
  })

  it('pauses mid-batch when its own dispatches fill the WIP ceiling', async () => {
    const cards = [
      card({ slug: 'w1', status: 'in-progress' }),
      card({ slug: 'a', approved: '1' }),
      card({ slug: 'b', approved: '2' }),
      card({ slug: 'c', approved: '3' })
    ]
    const { deps, calls } = makeDeps(cards, 3)
    const res = await runDrainPass('/repo', deps)
    expect(calls.spawned.map((s) => s.prompt)).toEqual(['boot:a', 'boot:b'])
    expect(res).toMatchObject({ total: 3, dispatched: 2 })
  })

  it('skips a confirm-mode card without consuming WIP and keeps draining', async () => {
    const { deps, calls } = makeDeps([
      card({ slug: 'stale', approved: '1' }),
      card({ slug: 'ok', approved: '2' })
    ])
    const basePlan = deps.plan
    deps.plan = async (folder, slug) =>
      slug === 'stale' ? { ok: true, mode: 'confirm', reason: 'no-grant' } : basePlan(folder, slug)
    const res = await runDrainPass('/repo', deps)
    expect(calls.spawned.map((s) => s.prompt)).toEqual(['boot:ok'])
    expect(res).toMatchObject({ dispatched: 1, confirmNeeded: 1 })
  })

  it('refunds the reserved grant unit when the spawn fails and keeps draining', async () => {
    const { deps, calls } = makeDeps([
      card({ slug: 'dead', approved: '1' }),
      card({ slug: 'ok', approved: '2' })
    ])
    const baseSpawn = deps.spawnSession
    deps.spawnSession = async (folder, prompt, routing) =>
      prompt === 'boot:dead'
        ? { ok: false, reason: 'FOLDER_NOT_FOUND' }
        : baseSpawn(folder, prompt, routing)
    const res = await runDrainPass('/repo', deps)
    expect(calls.released).toEqual(['g-dead'])
    expect(calls.bound.map((b) => b.slug)).toEqual(['ok'])
    expect(res.dispatched).toBe(1)
    expect(res.failedCards).toEqual([{ slug: 'dead', reason: 'FOLDER_NOT_FOUND' }])
  })

  it('refunds the grant when the worktree cut fails', async () => {
    const { deps, calls } = makeDeps([card({ slug: 'a', approved: '1', substrate: 'worktree' })])
    deps.createWorktree = async () => null
    const res = await runDrainPass('/repo', deps)
    expect(calls.released).toEqual(['g-a'])
    expect(calls.spawned).toEqual([])
    expect(res.dispatched).toBe(0)
  })

  it('still counts a dispatch whose best-effort bind fails', async () => {
    const { deps, calls } = makeDeps([card({ slug: 'a', approved: '1' })])
    deps.bindSession = async () => false
    const res = await runDrainPass('/repo', deps)
    expect(calls.spawned).toHaveLength(1)
    expect(res.dispatched).toBe(1)
  })

  it('emits progress events including a terminal one', async () => {
    const { deps, calls } = makeDeps([
      card({ slug: 'a', approved: '1' }),
      card({ slug: 'b', approved: '2' })
    ])
    await runDrainPass('/repo', deps)
    const last = calls.events.at(-1)
    expect(last).toMatchObject({
      folder: '/repo',
      total: 2,
      dispatched: 2,
      confirmNeeded: 0,
      active: false
    })
    expect(calls.events.some((e) => e.active === true)).toBe(true)
  })

  it('emits nothing and dispatches nothing on an empty queue', async () => {
    const { deps, calls } = makeDeps([card({ slug: 'plain' })])
    const res = await runDrainPass('/repo', deps)
    expect(res).toMatchObject({ total: 0, dispatched: 0 })
    expect(calls.events).toEqual([])
    expect(calls.planned).toEqual([])
  })

  it('a posture auto-plan (grantId null) dispatches, and a failed spawn does NOT call releaseGrant', async () => {
    const { deps, calls } = makeDeps([
      card({ slug: 'a', approved: '1' }),
      card({ slug: 'b', approved: '2' })
    ])
    deps.plan = async (_folder, slug) => ({
      ok: true,
      mode: 'auto',
      prompt: `boot:${slug}`,
      grantId: null,
      grantBudgetRemaining: null
    })
    deps.spawnSession = async (folder, prompt) => {
      calls.spawned.push({ folder, prompt })
      return prompt === 'boot:a' ? { ok: true, sessionId: 'sess-a' } : { ok: false, reason: 'boom' } // b's spawn fails
    }
    const res = await runDrainPass('/repo', deps)
    expect(res).toMatchObject({ total: 2, dispatched: 1, confirmNeeded: 0 })
    expect(calls.released).toEqual([]) // nothing to refund on the grant-free path
  })

  it('the terminal event names each confirm-fallback card with its reason', async () => {
    const { deps, calls } = makeDeps([
      card({ slug: 'ok', approved: '1' }),
      card({ slug: 'stale', approved: '2' })
    ])
    const base = deps.plan
    deps.plan = async (folder, slug) =>
      slug === 'stale'
        ? { ok: true, mode: 'confirm', reason: 'manifest-stale' }
        : base(folder, slug)
    await runDrainPass('/repo', deps)
    const terminal = calls.events.at(-1)
    expect(terminal).toMatchObject({
      active: false,
      confirmNeeded: 1,
      confirmCards: [{ slug: 'stale', reason: 'manifest-stale' }]
    })
  })

  // BUG-62: a failed dispatch must be just as attributable in the emitted
  // event as a confirm fallback — the board/toast surface reads THIS, not
  // the return value of `runDrainPass`.
  it('the terminal event names each failed-dispatch card with its reason', async () => {
    const { deps, calls } = makeDeps([
      card({ slug: 'ok', approved: '1' }),
      card({ slug: 'dead', approved: '2', substrate: 'worktree' })
    ])
    const baseSpawn = deps.spawnSession
    deps.spawnSession = async (folder, prompt, routing) =>
      prompt === 'boot:dead' ? { ok: false, reason: 'TIMEOUT' } : baseSpawn(folder, prompt, routing)
    await runDrainPass('/repo', deps)
    const terminal = calls.events.at(-1)
    expect(terminal).toMatchObject({
      active: false,
      failed: 1,
      failedCards: [{ slug: 'dead', reason: 'TIMEOUT' }]
    })
  })

  it('cards left unattempted at the WIP ceiling are counted in wipBlocked (visible, never silent)', async () => {
    const cards = [
      card({ slug: 'w1', status: 'in-progress', session: 's1' }),
      card({ slug: 'w2', status: 'in-progress', session: 's2' }),
      card({ slug: 'q1', approved: '1' }),
      card({ slug: 'q2', approved: '2' })
    ]
    const { deps, calls } = makeDeps(cards, 2) // ceiling already full
    const res = await runDrainPass('/repo', deps)
    expect(res).toMatchObject({ total: 2, dispatched: 0, confirmNeeded: 0, wipBlocked: 2 })
    expect(calls.events.at(-1)).toMatchObject({ active: false, wipBlocked: 2 })
  })
})

describe('createDrainScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces multiple pokes for the same folder into one pass', async () => {
    const run = vi.fn(() => Promise.resolve())
    const s = createDrainScheduler(run, 300)
    s.poke('/repo')
    s.poke('/repo')
    s.poke('/repo')
    await vi.advanceTimersByTimeAsync(299)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('/repo')
  })

  it('a poke landing during a running pass schedules exactly one follow-up pass', async () => {
    let resolveRun: (() => void) | null = null
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve
        })
    )
    const s = createDrainScheduler(run, 300)
    s.poke('/repo')
    await vi.advanceTimersByTimeAsync(300)
    expect(run).toHaveBeenCalledTimes(1)

    s.poke('/repo') // lands mid-run
    s.poke('/repo')
    resolveRun?.()
    await vi.advanceTimersByTimeAsync(300)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('tracks folders independently', async () => {
    const run = vi.fn(() => Promise.resolve())
    const s = createDrainScheduler(run, 300)
    s.poke('/a')
    s.poke('/b')
    await vi.advanceTimersByTimeAsync(300)
    expect(run).toHaveBeenCalledWith('/a')
    expect(run).toHaveBeenCalledWith('/b')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('pokeManifestDrain is a no-op before the shell registers, forwards after', () => {
    setDrainPoke(null)
    expect(() => pokeManifestDrain('/repo')).not.toThrow()
    const seen: string[] = []
    setDrainPoke((folder) => seen.push(folder))
    pokeManifestDrain('/repo')
    expect(seen).toEqual(['/repo'])
    setDrainPoke(null)
  })

  it('never lets a rejected pass kill the scheduler', async () => {
    const run = vi
      .fn<(folder: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined)
    const s = createDrainScheduler(run, 300)
    s.poke('/repo')
    await vi.advanceTimersByTimeAsync(300)
    s.poke('/repo')
    await vi.advanceTimersByTimeAsync(300)
    expect(run).toHaveBeenCalledTimes(2)
  })
})
