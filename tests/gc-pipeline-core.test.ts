import { describe, it, expect } from 'vitest'
import { GcStepError, runBatch, runBundle, type GcOps } from '../src/main/gc/pipeline-core'
import type { WorktreeBundle } from '../src/main/gc/bundle-core'
import type { ReapItem } from '../src/main/reaper/reaper-core'

const REPO = '/ws/org/proj/www'

function bundle(name: string, over: Partial<WorktreeBundle> = {}): WorktreeBundle {
  const path = `/ws/org/proj/worktrees/PROJ-0000-${name}`
  const item: ReapItem = {
    id: `${REPO}::worktree::${path}`,
    repoPath: REPO,
    kind: 'worktree',
    branch: `feat/${name}`,
    path,
    hidden: false,
    ageDays: 12,
    diskBytes: 1_000_000,
    checkpoints: [],
    verdict: 'harvestable',
    blockers: [],
    needsRemoteDelete: false,
    untracked: [],
    justifiedBy: 'ancestor',
    hydration: null
  }
  return {
    item,
    fate: { fate: 'merged', signal: 'ancestor', strong: true },
    session: 'none',
    lastSignOfLifeAt: 1,
    stackIds: ['app'],
    sharedStackIds: [],
    ownedVolumes: ['pgdata'],
    depsBytes: 4096,
    keep: false,
    neverClean: false,
    isMainCheckout: false,
    pathsResolved: true,
    nestedWorktrees: [],
    foreignCheckouts: [],
    bucket: 'ready',
    reason: null,
    ...over
  }
}

interface Fake {
  ops: GcOps
  /** Op names in the order they were invoked. */
  calls: string[]
  /** The first argument each op received, by op name (last call wins). */
  args: Record<string, unknown>
}

type Overrides = Partial<GcOps>

/** A recording GcOps. Every op succeeds unless overridden. */
function fakeOps(over: Overrides = {}, bytes = 4096): Fake {
  const calls: string[] = []
  const args: Record<string, unknown> = {}
  const rec = <K extends keyof GcOps>(name: K, fn: GcOps[K]): GcOps[K] =>
    ((...a: unknown[]) => {
      calls.push(name)
      args[name] = a[0]
      return (fn as (...x: unknown[]) => unknown)(...a)
    }) as GcOps[K]
  const ops: GcOps = {
    reprobe: rec('reprobe', async () => ({ ok: true })),
    stopStacks: rec('stopStacks', async () => undefined),
    removeContainers: rec('removeContainers', async () => undefined),
    removeVolumes: rec('removeVolumes', async () => undefined),
    dropDeps: rec('dropDeps', async () => bytes),
    recheck: rec('recheck', async () => ({ ok: true })),
    cleanGit: rec('cleanGit', async () => undefined)
  }
  for (const key of Object.keys(over) as (keyof GcOps)[]) {
    ;(ops as unknown as Record<string, unknown>)[key] = rec(key, over[key] as never)
  }
  return { ops, calls, args }
}

// Delta 4, item D: the recheck runs twice, right before drop-deps and right before cleanGit.
const FULL = [
  'reprobe',
  'stopStacks',
  'removeContainers',
  'removeVolumes',
  'recheck',
  'dropDeps',
  'recheck',
  'cleanGit'
]
const OPTS = { removeVolumes: true }

function boom(message = 'boom'): () => Promise<never> {
  return async () => {
    throw new Error(message)
  }
}

describe('GcStepError', () => {
  it('is an Error carrying the step it failed in', () => {
    const err = new GcStepError('trash', 'disk full')
    expect(err).toBeInstanceOf(Error)
    expect(err.step).toBe('trash')
    expect(err.message).toContain('disk full')
  })
})

describe('runBundle — happy path', () => {
  it('runs every op in the fixed order and reports the freed bytes', async () => {
    const f = fakeOps({}, 8192)
    const b = bundle('a')
    const r = await runBundle(b, f.ops, OPTS)
    expect(f.calls).toEqual(FULL)
    expect(r.ok).toBe(true)
    expect(r.haltedAt).toBeNull()
    expect(r.id).toBe(b.item.id)
    expect(r.freedBytes).toBe(8192)
    expect(r.error).toBeUndefined()
  })

  it('hands the bundle stack ids to the docker ops and the owned volumes to removeVolumes', async () => {
    const f = fakeOps()
    await runBundle(
      bundle('a', { stackIds: ['app', 'cache'], ownedVolumes: ['pgdata', 'redis'] }),
      f.ops,
      OPTS
    )
    expect(f.args.stopStacks).toEqual(['app', 'cache'])
    expect(f.args.removeContainers).toEqual(['app', 'cache'])
    expect(f.args.removeVolumes).toEqual(['pgdata', 'redis'])
  })

  it('hands the bundle itself to reprobe, dropDeps and cleanGit', async () => {
    const f = fakeOps()
    const b = bundle('a')
    await runBundle(b, f.ops, OPTS)
    expect(f.args.reprobe).toBe(b)
    expect(f.args.dropDeps).toBe(b)
    expect(f.args.cleanGit).toBe(b)
  })
})

describe('runBundle — halting on a failed step', () => {
  it('stopStacks throws: halts at stop-stack and nothing destructive follows', async () => {
    const f = fakeOps({ stopStacks: boom('cannot stop') })
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r.ok).toBe(false)
    expect(r.haltedAt).toBe('stop-stack')
    expect(r.error).toContain('cannot stop')
    expect(r.freedBytes).toBe(0)
    expect(f.calls).toEqual(['reprobe', 'stopStacks'])
    for (const never of ['cleanGit', 'dropDeps', 'removeContainers', 'removeVolumes']) {
      expect(f.calls).not.toContain(never)
    }
  })

  it('removeContainers throws: halts at rm-containers', async () => {
    const f = fakeOps({ removeContainers: boom() })
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r.ok).toBe(false)
    expect(r.haltedAt).toBe('rm-containers')
    expect(f.calls).toEqual(['reprobe', 'stopStacks', 'removeContainers'])
    expect(r.freedBytes).toBe(0)
  })

  it('removeVolumes throws: halts at rm-volumes', async () => {
    const f = fakeOps({ removeVolumes: boom() })
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r.ok).toBe(false)
    expect(r.haltedAt).toBe('rm-volumes')
    expect(f.calls).toEqual(['reprobe', 'stopStacks', 'removeContainers', 'removeVolumes'])
    expect(r.freedBytes).toBe(0)
  })

  it('dropDeps throws: halts at drop-deps and cleanGit is not called', async () => {
    const f = fakeOps({ dropDeps: boom() })
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r.ok).toBe(false)
    expect(r.haltedAt).toBe('drop-deps')
    expect(f.calls).not.toContain('cleanGit')
    expect(r.freedBytes).toBe(0)
  })

  it('cleanGit throws a GcStepError: halts at the step it names', async () => {
    const f = fakeOps({
      cleanGit: async () => {
        throw new GcStepError('trash', 'disk full')
      }
    })
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r.ok).toBe(false)
    expect(r.haltedAt).toBe('trash')
    expect(r.error).toContain('disk full')
  })

  it.each(['archive', 'trash', 'prune', 'branch-delete', 'detach'] as const)(
    'cleanGit throws a GcStepError for %s: halts there',
    async (step) => {
      const f = fakeOps({
        cleanGit: async () => {
          throw new GcStepError(step, 'nope')
        }
      })
      const r = await runBundle(bundle('a'), f.ops, OPTS)
      expect(r.haltedAt).toBe(step)
    }
  )

  it('cleanGit throws a plain Error: halts at archive, the first git step', async () => {
    const f = fakeOps({ cleanGit: boom('exploded') })
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r.ok).toBe(false)
    expect(r.haltedAt).toBe('archive')
    expect(r.error).toContain('exploded')
  })

  it('never lets a throw escape as a rejection', async () => {
    const f = fakeOps({ stopStacks: boom() })
    await expect(runBundle(bundle('a'), f.ops, OPTS)).resolves.toBeDefined()
  })
})

describe('runBundle — reprobe (Review Focus 4)', () => {
  it('not ok: halts at reprobe with the reason, and no other op is called', async () => {
    const f = fakeOps({
      reprobe: async () => ({ ok: false, reason: 'changed-since-scan' })
    })
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r.ok).toBe(false)
    expect(r.haltedAt).toBe('reprobe')
    expect(r.error).toBe('changed-since-scan')
    expect(r.freedBytes).toBe(0)
    expect(f.calls).toEqual(['reprobe'])
  })

  it('a throwing reprobe also halts at reprobe, before anything else', async () => {
    const f = fakeOps({ reprobe: boom('probe crashed') })
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r.ok).toBe(false)
    expect(r.haltedAt).toBe('reprobe')
    expect(r.error).toContain('probe crashed')
    expect(f.calls).toEqual(['reprobe'])
  })
})

/** A recheck that passes its first call (before drop-deps) and answers `later` after. */
function passesOnce(later: GcOps['recheck']): GcOps['recheck'] {
  let calls = 0
  return async (b) => (calls++ === 0 ? { ok: true } : later(b))
}

describe('runBundle — recheck right before cleanGit (delta 2, item 4)', () => {
  it('hands the bundle to recheck, after drop-deps and before cleanGit', async () => {
    const f = fakeOps()
    const b = bundle('a')
    await runBundle(b, f.ops, OPTS)
    expect(f.args.recheck).toBe(b)
    expect(f.calls.lastIndexOf('recheck')).toBe(f.calls.indexOf('dropDeps') + 1)
    expect(f.calls.indexOf('cleanGit')).toBe(f.calls.lastIndexOf('recheck') + 1)
  })

  it('a session that appeared after drop-deps halts at archive, and cleanGit never runs', async () => {
    const f = fakeOps(
      { recheck: passesOnce(async () => ({ ok: false, reason: 'session-open' })) },
      8192
    )
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r).toEqual({
      id: bundle('a').item.id,
      ok: false,
      haltedAt: 'archive',
      error: 'changed-mid-run',
      freedBytes: 8192
    })
    expect(f.calls).not.toContain('cleanGit')
  })

  it('a recheck that says the confirmed work changed names that, not changed-mid-run', async () => {
    const f = fakeOps(
      { recheck: passesOnce(async () => ({ ok: false, reason: 'work-changed-since-confirm' })) },
      8192
    )
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r).toMatchObject({ ok: false, haltedAt: 'archive', error: 'work-changed-since-confirm' })
    expect(f.calls).not.toContain('cleanGit')
  })

  it('any other recheck reason, even a made-up one, still reads changed-mid-run', async () => {
    const f = fakeOps({ recheck: async () => ({ ok: false, reason: 'because i said so' }) })
    expect(await runBundle(bundle('a'), f.ops, OPTS)).toMatchObject({ error: 'changed-mid-run' })
  })

  it('a throwing recheck halts the same way', async () => {
    const f = fakeOps({ recheck: passesOnce(boom('presence unavailable')) }, 8192)
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r).toMatchObject({ ok: false, haltedAt: 'archive', error: 'changed-mid-run' })
    expect(r.freedBytes).toBe(8192)
    expect(f.calls).not.toContain('cleanGit')
  })
})

describe('runBundle — recheck right before drop-deps (delta 4, item D)', () => {
  it('runs after the docker steps and right before dropDeps', async () => {
    const f = fakeOps()
    await runBundle(bundle('a'), f.ops, OPTS)
    expect(f.calls.indexOf('recheck')).toBe(f.calls.indexOf('removeVolumes') + 1)
    expect(f.calls.indexOf('dropDeps')).toBe(f.calls.indexOf('recheck') + 1)
  })

  it('P2: a session that appeared during the docker steps halts at drop-deps, before dropDeps', async () => {
    const f = fakeOps({ recheck: async () => ({ ok: false, reason: 'session-open' }) })
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r).toEqual({
      id: bundle('a').item.id,
      ok: false,
      haltedAt: 'drop-deps',
      error: 'changed-mid-run',
      freedBytes: 0
    })
    expect(f.calls).toEqual([
      'reprobe',
      'stopStacks',
      'removeContainers',
      'removeVolumes',
      'recheck'
    ])
  })

  it('a throwing recheck before drop-deps halts the same way', async () => {
    const f = fakeOps({ recheck: boom('presence unavailable') })
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r).toMatchObject({ ok: false, haltedAt: 'drop-deps', error: 'changed-mid-run' })
    expect(f.calls).not.toContain('dropDeps')
    expect(f.calls).not.toContain('cleanGit')
  })

  it('runs with no stack too, right after the reprobe', async () => {
    const f = fakeOps({ recheck: async () => ({ ok: false, reason: 'head-moved' }) })
    const r = await runBundle(bundle('a', { stackIds: [], ownedVolumes: [] }), f.ops, OPTS)
    expect(r).toMatchObject({ ok: false, haltedAt: 'drop-deps', freedBytes: 0 })
    expect(f.calls).toEqual(['reprobe', 'recheck'])
  })
})

describe('runBundle — only a proven ready bundle runs (delta 2, item 2)', () => {
  const refused = { ok: false, haltedAt: 'reprobe', error: 'not-ready', freedBytes: 0 }

  it.each<[string, Partial<WorktreeBundle>]>([
    ['in-use', { bucket: 'in-use' }],
    ['keep', { keep: true }],
    ['neverClean', { neverClean: true }],
    ['a main checkout', { isMainCheckout: true }],
    ['review without confirmReview', { bucket: 'review' }]
  ])('refuses %s with zero ops called', async (_label, over) => {
    // A ready base, so keep / neverClean / main checkout are refused for the flag itself:
    // a hand-built or stale bundle can carry a ready bucket next to a protection flag.
    const b = bundle('a', over)
    const f = fakeOps()
    expect(await runBundle(b, f.ops, OPTS)).toEqual({ id: b.item.id, ...refused })
    expect(f.calls).toEqual([])
  })

  it.each([
    REPO,
    `${REPO}/`,
    '/ws/org/proj//www',
    // Delta 4, item F: . and .. segments resolve before the comparison.
    `${REPO}/.`,
    '/ws/org/proj/worktrees/../www'
  ])(
    'refuses a main checkout told by its path (%s), whatever its flag says (delta 3, item 6)',
    async (path) => {
      const base = bundle('a')
      const b = bundle('a', { item: { ...base.item, path }, isMainCheckout: false })
      const f = fakeOps()
      expect(await runBundle(b, f.ops, { ...OPTS, confirmReview: true })).toEqual({
        id: b.item.id,
        ...refused
      })
      expect(f.calls).toEqual([])
    }
  )

  it('refuses the main checkout when its repo path is the one spelled with .. (delta 4, item F)', async () => {
    const base = bundle('a')
    const b = bundle('a', {
      item: { ...base.item, path: REPO, repoPath: '/ws/org/proj/worktrees/../www' },
      isMainCheckout: false
    })
    const f = fakeOps()
    expect(await runBundle(b, f.ops, OPTS)).toEqual({ id: b.item.id, ...refused })
    expect(f.calls).toEqual([])
  })

  it('refuses a review bundle when confirmReview is false', async () => {
    const f = fakeOps()
    const r = await runBundle(bundle('a', { bucket: 'review' }), f.ops, {
      ...OPTS,
      confirmReview: false
    })
    expect(r).toMatchObject(refused)
    expect(f.calls).toEqual([])
  })

  it('runs a review bundle when the operator confirmed it', async () => {
    const f = fakeOps()
    const r = await runBundle(bundle('a', { bucket: 'review' }), f.ops, {
      ...OPTS,
      confirmReview: true
    })
    expect(r.ok).toBe(true)
    expect(f.calls[0]).toBe('reprobe')
    expect(f.calls).toContain('cleanGit')
  })

  it.each<[string, Partial<WorktreeBundle>]>([
    ['in-use', { bucket: 'in-use' }],
    ['keep', { keep: true }],
    ['neverClean', { neverClean: true }],
    ['a main checkout', { isMainCheckout: true }]
  ])('confirmReview still refuses %s', async (_label, over) => {
    const f = fakeOps()
    const r = await runBundle(bundle('a', { bucket: 'review', ...over }), f.ops, {
      ...OPTS,
      confirmReview: true
    })
    expect(r).toMatchObject(refused)
    expect(f.calls).toEqual([])
  })

  describe('confirmReview never overrides a shared stack (delta 3, item 4)', () => {
    const shared = { ok: false, haltedAt: 'reprobe', error: 'shared-stack', freedBytes: 0 }

    it('refuses a review shared-stack bundle the operator confirmed, with zero ops called', async () => {
      const b = bundle('a', {
        bucket: 'review',
        reason: { code: 'shared-stack', detail: '1 other stack also uses this worktree: app.' },
        stackIds: [],
        sharedStackIds: ['app']
      })
      const f = fakeOps()
      expect(await runBundle(b, f.ops, { ...OPTS, confirmReview: true })).toEqual({
        id: b.item.id,
        ...shared
      })
      expect(f.calls).toEqual([])
    })

    it('refuses a hand-built ready bundle that still lists a shared stack', async () => {
      const f = fakeOps()
      const r = await runBundle(bundle('a', { sharedStackIds: ['cache'] }), f.ops, OPTS)
      expect(r).toMatchObject(shared)
      expect(f.calls).toEqual([])
    })
  })

  it('runBatch passes confirmReview through to every bundle', async () => {
    const f = fakeOps()
    const bs = [bundle('a', { bucket: 'review' }), bundle('b', { bucket: 'review' })]
    const refusedAll = await runBatch(bs, f.ops, OPTS)
    expect(refusedAll.every((r) => r.error === 'not-ready')).toBe(true)
    expect(f.calls).toEqual([])
    const ran = await runBatch(bs, f.ops, { ...OPTS, confirmReview: true })
    expect(ran.every((r) => r.ok)).toBe(true)
  })
})

describe('runBundle — volumes skipped at execution time (delta 3, item 5b)', () => {
  const inUse = [{ name: 'pgdata', reason: 'volume-in-use' as const }]

  it('reports the volumes removeVolumes skipped, and the item still cleans', async () => {
    const f = fakeOps({ removeVolumes: async () => ({ skipped: inUse }) })
    const r = await runBundle(bundle('a', { ownedVolumes: ['pgdata', 'redis'] }), f.ops, OPTS)
    expect(r).toMatchObject({ ok: true, haltedAt: null, skippedVolumes: inUse })
    expect(f.calls).toEqual(FULL)
  })

  it('keeps the skipped volumes on a later failure', async () => {
    const f = fakeOps({
      removeVolumes: async () => ({ skipped: inUse }),
      cleanGit: boom('disk full')
    })
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r).toMatchObject({ ok: false, haltedAt: 'archive', skippedVolumes: inUse })
  })

  it('leaves skippedVolumes out when nothing was skipped', async () => {
    for (const result of [undefined, { skipped: [] }]) {
      const f = fakeOps({ removeVolumes: async () => result })
      const r = await runBundle(bundle('a'), f.ops, OPTS)
      expect(r.ok).toBe(true)
      expect('skippedVolumes' in r).toBe(false)
    }
  })
})

describe('runBundle — skipped steps', () => {
  it('removeVolumes:false skips the volume step and runs everything else', async () => {
    const f = fakeOps()
    const r = await runBundle(bundle('a'), f.ops, { removeVolumes: false })
    expect(f.calls).toEqual([
      'reprobe',
      'stopStacks',
      'removeContainers',
      'recheck',
      'dropDeps',
      'recheck',
      'cleanGit'
    ])
    expect(r.ok).toBe(true)
  })

  it('no owned volumes: the volume step is skipped', async () => {
    const f = fakeOps()
    const r = await runBundle(bundle('a', { ownedVolumes: [] }), f.ops, OPTS)
    expect(f.calls).toEqual([
      'reprobe',
      'stopStacks',
      'removeContainers',
      'recheck',
      'dropDeps',
      'recheck',
      'cleanGit'
    ])
    expect(r.ok).toBe(true)
  })

  it('no stacks: the docker steps are skipped, dropDeps and cleanGit still run', async () => {
    const f = fakeOps()
    const r = await runBundle(bundle('a', { stackIds: [], ownedVolumes: [] }), f.ops, OPTS)
    expect(f.calls).toEqual(['reprobe', 'recheck', 'dropDeps', 'recheck', 'cleanGit'])
    expect(r.ok).toBe(true)
    expect(r.haltedAt).toBeNull()
  })

  it('no stacks: never calls any docker op even when volumes were listed', async () => {
    const f = fakeOps()
    await runBundle(bundle('a', { stackIds: [], ownedVolumes: ['pgdata'] }), f.ops, OPTS)
    expect(f.calls).not.toContain('stopStacks')
    expect(f.calls).not.toContain('removeContainers')
    expect(f.calls).not.toContain('removeVolumes')
  })
})

describe('runBatch', () => {
  it('item 1 fails at stop-stack and item 2 still runs and succeeds, in input order', async () => {
    const f = fakeOps({
      stopStacks: async (ids) => {
        if (ids.includes('stackA')) throw new Error('cannot stop')
      }
    })
    const a = bundle('a', { stackIds: ['stackA'] })
    const b = bundle('b', { stackIds: ['stackB'] })
    const results = await runBatch([a, b], f.ops, OPTS)
    expect(results.map((r) => r.id)).toEqual([a.item.id, b.item.id])
    expect(results[0]).toMatchObject({ ok: false, haltedAt: 'stop-stack' })
    expect(results[1]).toMatchObject({ ok: true, haltedAt: null })
    expect(f.calls).toEqual([
      'reprobe',
      'stopStacks',
      'reprobe',
      'stopStacks',
      'removeContainers',
      'removeVolumes',
      'recheck',
      'dropDeps',
      'recheck',
      'cleanGit'
    ])
  })

  it('runs items sequentially: ops of two bundles never interleave', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const order: string[] = []
    const slow =
      <T>(label: string, value: T) =>
      async (arg?: unknown): Promise<T> => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        const id =
          typeof arg === 'object' && arg !== null && 'item' in arg
            ? (arg as WorktreeBundle).item.id
            : String(arg)
        order.push(`${label}:${id}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return value
      }
    const ops: GcOps = {
      reprobe: slow('reprobe', { ok: true as const }),
      stopStacks: slow('stop', undefined),
      removeContainers: slow('rm', undefined),
      removeVolumes: slow('vol', undefined),
      dropDeps: slow('deps', 1),
      recheck: slow('recheck', { ok: true as const }),
      cleanGit: slow('git', undefined)
    }
    const a = bundle('a', { stackIds: ['stackA'], ownedVolumes: ['volA'] })
    const b = bundle('b', { stackIds: ['stackB'], ownedVolumes: ['volB'] })
    await runBatch([a, b], ops, OPTS)
    expect(maxInFlight).toBe(1)
    const lastOfA = order.lastIndexOf(`git:${a.item.id}`)
    const firstOfB = order.indexOf(`reprobe:${b.item.id}`)
    expect(lastOfA).toBeGreaterThanOrEqual(0)
    expect(firstOfB).toBeGreaterThan(lastOfA)
  })

  it('an empty batch resolves to an empty list', async () => {
    const f = fakeOps()
    expect(await runBatch([], f.ops, OPTS)).toEqual([])
    expect(f.calls).toEqual([])
  })

  it('every failure is isolated: a reprobe refusal on item 1 does not stop item 2', async () => {
    const f = fakeOps({
      reprobe: async (b) =>
        b.item.id.endsWith('-a') ? { ok: false, reason: 'changed-since-scan' } : { ok: true }
    })
    const results = await runBatch([bundle('a'), bundle('b')], f.ops, OPTS)
    expect(results[0]).toMatchObject({ ok: false, haltedAt: 'reprobe' })
    expect(results[1]).toMatchObject({ ok: true })
  })
})

describe('T321 definition of done', () => {
  it('(a) the stack is stopped before the checkout is cleaned', async () => {
    const timeline: string[] = []
    const f = fakeOps({
      stopStacks: async () => {
        timeline.push('stop:start')
        await new Promise((resolve) => setTimeout(resolve, 10))
        timeline.push('stop:done')
      },
      cleanGit: async () => {
        timeline.push('clean:start')
      }
    })
    await runBundle(bundle('a'), f.ops, OPTS)
    expect(timeline).toEqual(['stop:start', 'stop:done', 'clean:start'])
  })

  it('(b) with no stack the docker steps are skipped', async () => {
    const f = fakeOps()
    await runBundle(bundle('a', { stackIds: [], ownedVolumes: [] }), f.ops, OPTS)
    expect(f.calls).toEqual(['reprobe', 'recheck', 'dropDeps', 'recheck', 'cleanGit'])
  })

  it('(c) a stop failure halts before the checkout is touched', async () => {
    const f = fakeOps({ stopStacks: boom('docker daemon down') })
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r.haltedAt).toBe('stop-stack')
    expect(f.calls).not.toContain('cleanGit')
    expect(f.calls).not.toContain('dropDeps')
  })

  it('(d) the removeVolumes preference disables the volume step', async () => {
    const f = fakeOps()
    await runBundle(bundle('a'), f.ops, { removeVolumes: false })
    expect(f.calls).not.toContain('removeVolumes')
    expect(f.calls).toContain('removeContainers')
    expect(f.calls).toContain('cleanGit')
  })
})

// ---- runBundle never rejects (delta 6, F3) ---------------------------------------------

describe('runBundle never rejects, whatever an op answers (delta 6, F3)', () => {
  const garbage = <T>(value: unknown): T => value as T

  it.each([undefined, null, 'yes', 1, {}, { ok: 'true' }, { ok: 1 }])(
    'a reprobe answering %j halts that item at reprobe as probe-failed',
    async (answer) => {
      const f = fakeOps({ reprobe: async () => garbage(answer) })
      const r = await runBundle(bundle('a'), f.ops, OPTS)
      expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'probe-failed' })
      expect(r.freedBytes).toBe(0)
      expect(f.calls).toEqual(['reprobe'])
    }
  )

  it('a refusing reprobe with no reason still names an error', async () => {
    const f = fakeOps({ reprobe: async () => garbage({ ok: false }) })
    const r = await runBundle(bundle('a'), f.ops, OPTS)
    expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'probe-failed' })
  })

  it('runBatch: a reprobe answering undefined halts item 1, and item 2 still runs and succeeds', async () => {
    const f = fakeOps({
      reprobe: async (b) => (b.item.id.endsWith('-a') ? garbage(undefined) : { ok: true })
    })
    const results = await runBatch([bundle('a'), bundle('b')], f.ops, OPTS)
    expect(results[0]).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'probe-failed' })
    expect(results[1]).toMatchObject({ ok: true, haltedAt: null })
    expect(f.calls.filter((c) => c === 'cleanGit')).toHaveLength(1)
  })

  it.each([undefined, null, 'yes', { ok: 'true' }, { ok: 1 }])(
    'a recheck answering %j before cleanGit halts at archive, and cleanGit never runs',
    async (answer) => {
      const f = fakeOps({ recheck: passesOnce(async () => garbage(answer)) })
      const r = await runBundle(bundle('a'), f.ops, OPTS)
      expect(r).toMatchObject({ ok: false, haltedAt: 'archive', error: 'changed-mid-run' })
      expect(f.calls).not.toContain('cleanGit')
    }
  )

  it.each([undefined, { ok: 'true' }])(
    'a recheck answering %j before drop-deps halts there, and dropDeps never runs',
    async (answer) => {
      const f = fakeOps({ recheck: async () => garbage(answer) })
      const r = await runBundle(bundle('a'), f.ops, OPTS)
      expect(r).toMatchObject({ ok: false, haltedAt: 'drop-deps', error: 'changed-mid-run' })
      expect(f.calls).not.toContain('dropDeps')
      expect(f.calls).not.toContain('cleanGit')
    }
  )

  it.each([5, 'x', { skipped: 'x' }, { skipped: [null] }, { skipped: [{ name: 1 }] }])(
    'a removeVolumes answering %j halts at rm-volumes instead of throwing',
    async (answer) => {
      const f = fakeOps({ removeVolumes: async () => garbage(answer) })
      const r = await runBundle(bundle('a'), f.ops, OPTS)
      expect(r).toMatchObject({ ok: false, haltedAt: 'rm-volumes' })
      expect(typeof r.error).toBe('string')
      expect(f.calls).not.toContain('dropDeps')
      expect(f.calls).not.toContain('cleanGit')
    }
  )

  it.each([undefined, 'many', NaN, -1, Infinity])(
    'a dropDeps answering %s halts at drop-deps, and cleanGit never runs',
    async (answer) => {
      const f = fakeOps({ dropDeps: async () => garbage(answer) })
      const r = await runBundle(bundle('a'), f.ops, OPTS)
      expect(r).toMatchObject({ ok: false, haltedAt: 'drop-deps', freedBytes: 0 })
      expect(f.calls).not.toContain('cleanGit')
    }
  )

  it('an op that is not a function halts that item', async () => {
    const f = fakeOps()
    const ops = { ...f.ops, stopStacks: garbage<GcOps['stopStacks']>(undefined) }
    const r = await runBundle(bundle('a'), ops, OPTS)
    expect(r).toMatchObject({ ok: false, haltedAt: 'stop-stack' })
    expect(f.calls).not.toContain('cleanGit')
  })

  it.each<[string, unknown]>([
    [
      'a bundle with no item',
      (() => {
        const { item: _omit, ...rest } = bundle('a')
        return rest
      })()
    ],
    ['a bundle that is undefined', undefined],
    ['a bundle that is null', null],
    ['a bundle whose stack list is missing', { ...bundle('a'), sharedStackIds: undefined }]
  ])('%s returns a halted result instead of rejecting', async (_label, b) => {
    const f = fakeOps()
    const r = await runBundle(garbage<WorktreeBundle>(b), f.ops, OPTS)
    expect(r).toMatchObject({
      ok: false,
      haltedAt: 'reprobe',
      error: 'probe-failed',
      freedBytes: 0
    })
    expect(r.id).toBe((b as WorktreeBundle | null)?.item?.id ?? 'unknown')
    expect(f.calls).toEqual([])
  })

  it('runBatch: a malformed bundle never stops the ones after it', async () => {
    const f = fakeOps()
    const results = await runBatch([garbage<WorktreeBundle>(undefined), bundle('b')], f.ops, OPTS)
    expect(results[0]).toMatchObject({ id: 'unknown', ok: false, error: 'probe-failed' })
    expect(results[1]).toMatchObject({ ok: true, haltedAt: null })
  })
})

// ---- a nested worktree refuses even a confirmed review (delta 6, F1 concern 1) -----------

describe('runBundle refuses a bundle with a nested worktree (delta 6, F1)', () => {
  // The reprobe sees only this repo's `git worktree list`: a nested folder known only from
  // knownFolders (a worktree of another repo) would pass it, so the bundle's own list
  // refuses up front, whatever the operator confirmed.
  const confirm = { removeVolumes: true, confirmReview: true }

  it.each(['ready', 'review'] as const)(
    'a %s bundle listing a nested worktree is refused with zero ops, even confirmed',
    async (bucket) => {
      const f = fakeOps()
      const r = await runBundle(bundle('a', { bucket, nestedWorktrees: ['x'] }), f.ops, confirm)
      expect(r).toMatchObject({
        ok: false,
        haltedAt: 'reprobe',
        error: 'nested-worktree',
        freedBytes: 0
      })
      expect(f.calls).toEqual([])
    }
  )

  it.each<[string, unknown]>([
    ['missing', undefined],
    ['null', null],
    ['not an array', 'x']
  ])('a bundle whose list is %s is refused the same way', async (_label, value) => {
    const f = fakeOps()
    const b = bundle('a', { bucket: 'review' })
    if (value === undefined) delete (b as Partial<WorktreeBundle>).nestedWorktrees
    else (b as unknown as Record<string, unknown>).nestedWorktrees = value
    const r = await runBundle(b, f.ops, confirm)
    expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'nested-worktree' })
    expect(f.calls).toEqual([])
  })

  it('an empty list still proceeds', async () => {
    const f = fakeOps()
    const r = await runBundle(bundle('a', { nestedWorktrees: [] }), f.ops, OPTS)
    expect(r).toMatchObject({ ok: true, haltedAt: null })
    expect(f.calls).toEqual(FULL)
  })

  it('runBatch continues past a refused bundle', async () => {
    const f = fakeOps()
    const results = await runBatch(
      [bundle('a', { nestedWorktrees: ['x'] }), bundle('b')],
      f.ops,
      confirm
    )
    expect(results[0]).toMatchObject({ ok: false, error: 'nested-worktree' })
    expect(results[1]).toMatchObject({ ok: true, haltedAt: null })
  })
})

// ---- a foreign checkout refuses even a confirmed review (delta 7) -------------------------

describe('runBundle refuses a bundle with a foreign checkout (delta 7)', () => {
  const confirm = { removeVolumes: true, confirmReview: true }

  it.each(['ready', 'review'] as const)(
    'a %s bundle listing one is refused with zero ops, even confirmed',
    async (bucket) => {
      const f = fakeOps()
      const b = bundle('a', { bucket, foreignCheckouts: ['/x/.git'] })
      const r = await runBundle(b, f.ops, confirm)
      expect(r).toMatchObject({
        ok: false,
        haltedAt: 'reprobe',
        error: 'nested-worktree',
        freedBytes: 0
      })
      expect(f.calls).toEqual([])
    }
  )

  it.each<[string, unknown]>([
    ['missing', undefined],
    ['null', null],
    ['not an array', 'x']
  ])('a bundle whose list is %s is refused the same way', async (_label, value) => {
    const f = fakeOps()
    const b = bundle('a', { bucket: 'review' })
    if (value === undefined) delete (b as Partial<WorktreeBundle>).foreignCheckouts
    else (b as unknown as Record<string, unknown>).foreignCheckouts = value
    const r = await runBundle(b, f.ops, confirm)
    expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'nested-worktree' })
    expect(f.calls).toEqual([])
  })

  it('an empty list still proceeds', async () => {
    const f = fakeOps()
    const r = await runBundle(bundle('a', { foreignCheckouts: [] }), f.ops, OPTS)
    expect(r).toMatchObject({ ok: true, haltedAt: null })
    expect(f.calls).toEqual(FULL)
  })
})
