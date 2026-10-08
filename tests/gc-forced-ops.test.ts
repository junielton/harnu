import { describe, expect, it, vi } from 'vitest'
import { asExecutable, createForcedGcOps } from '../src/main/gc/gc-forced-ops'
import { createGcOps, type GcShellDeps } from '../src/main/gc/gc-shell'
import { runBundle } from '../src/main/gc/pipeline-core'
import type { SessionPresence, WorktreeBundle } from '../src/main/gc/bundle-core'
import type { ExecutorDeps } from '../src/main/reaper/executor-core'
import type { Tombstone } from '../src/main/reaper/journal'
import { withActor } from '../src/main/gc/gc-actor'
import { defaultGcPrefs, type GcPrefs } from '../src/main/gc/gc-prefs'
import type { DehydrateDeps } from '../src/main/reaper/dehydrate-core'
import {
  COMPOSE_WORKING_DIR_LABEL,
  type InspectedContainer,
  type StackGroup
} from '../src/main/containers/containers-core'
import { bundle, DAY, NOW, reapItem } from './gc-fixtures'

const WT = '/ws/org/proj/worktrees/PROJ-0000-slug'
const TIP = 'a'.repeat(40)
const BRANCH = 'feat/PROJ-0000-slug'

function container(id: string, dir: string): InspectedContainer {
  return {
    id,
    name: `ctr-${id}`,
    image: 'postgres:16',
    labels: { [COMPOSE_WORKING_DIR_LABEL]: dir },
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    createdAt: 1,
    ports: [],
    mounts: []
  }
}

const stack = (id: string, containers: InspectedContainer[]): StackGroup => ({
  id,
  name: id,
  kind: 'compose',
  project: id,
  containers
})

/** A dirty, not-proven-merged worktree: exactly what the executor would refuse on its own. */
function reviewBundle(over: Partial<WorktreeBundle> = {}): WorktreeBundle {
  return {
    ...bundle(WT, 'review', { reason: { code: 'dirty', detail: '2 modified tracked files.' } }),
    item: reapItem(WT, {
      branch: BRANCH,
      verdict: 'blocked',
      blockers: ['dirty'],
      justifiedBy: null
    }),
    fate: { fate: 'closed-unmerged', signal: null, strong: false },
    lastSignOfLifeAt: NOW - 10 * DAY,
    localTip: TIP,
    graceDays: 2,
    stackIds: ['app'],
    ownedVolumes: ['pgdata'],
    ...over
  }
}

interface Rig {
  deps: GcShellDeps
  order: string[]
  git: string[][]
  archived: string[]
  tombstones: Tombstone[]
  setStacks(s: StackGroup[]): void
}

function rig(
  over: {
    presence?: SessionPresence
    head?: string | null
    archiveWipThrows?: boolean
    trackedDirty?: boolean
  } = {}
): Rig {
  const order: string[] = []
  const git: string[][] = []
  const archived: string[] = []
  const tombstones: Tombstone[] = []
  let stacks = [stack('app', [container('c1', `${WT}/api`)])]
  const executor: ExecutorDeps = {
    probeStatus: async () => ({ trackedDirty: over.trackedDirty ?? true, untracked: ['notes.md'] }),
    hasUnpushed: async () => true,
    trash: async () => {
      order.push('trash')
    },
    git: async (_repo, args) => {
      git.push(args)
      order.push(`git ${args.join(' ')}`)
      return ''
    },
    resolveSha: async () => TIP,
    archiveTip: async (_repo, ref) => {
      order.push('archiveTip')
      archived.push(ref)
      return ref
    },
    archiveWip: async (_repo, ref) => {
      order.push('archiveWip')
      if (over.archiveWipThrows) throw new Error('disk full')
      archived.push(ref)
      return ref
    },
    detachSidebar: async () => undefined,
    canUnregister: async () => true,
    removeWorktreeAdmin: async () => true,
    appendTombstone: async (t) => {
      tombstones.push(t)
    },
    now: () => NOW
  }
  const dehydrate: DehydrateDeps = {
    isSessionLive: async () => false,
    readManifest: async () => ({ ephemeral: ['node_modules'], setup: [] }),
    probeEntries: async () => [
      { path: 'node_modules', presence: 'dir', contained: true, ignored: true, tracked: false }
    ],
    trackedFingerprint: async () => new Map(),
    removeDir: async () => {
      order.push('removeDir')
    },
    recordDehydrated: async () => undefined
  }
  const ok = (done: string[]) => ({ done, error: null })
  return {
    deps: {
      executor,
      dehydrate,
      docker: {
        stop: vi.fn(async (ids: string[]) => {
          order.push('docker stop')
          return ok(ids)
        }),
        removeContainers: vi.fn(async (ids: string[]) => {
          order.push('docker rm')
          // As docker does: a removed container is gone from every later listing.
          stacks = stacks
            .map((st) => ({ ...st, containers: st.containers.filter((c) => !ids.includes(c.id)) }))
            .filter((st) => st.containers.length > 0)
          return ok(ids)
        }),
        removeVolumes: vi.fn(async (names: string[]) => {
          order.push('docker volume rm')
          return ok(names)
        })
      },
      listStacks: async () => ({ stacks }),
      presenceOf: async () => over.presence ?? 'none',
      headOf: async () => (over.head === undefined ? TIP : over.head),
      isProtectedNow: () => false,
      realpath: async (p: string) => p,
      listWorktrees: async () => ['/ws/org/proj/www', WT],
      findForeignCheckouts: async () => []
    },
    order,
    git,
    archived,
    tombstones,
    setStacks: (s) => {
      stacks = s
    }
  }
}

const FORCE = { removeVolumes: false, confirmReview: true }
const run = (b: WorktreeBundle, r: Rig) => runBundle(b, createForcedGcOps(r.deps), FORCE)

describe('asExecutable', () => {
  it('shows the executor a harvestable bundle without the confirmed blockers', () => {
    const forced = asExecutable(
      reviewBundle({
        item: reapItem(WT, { verdict: 'blocked', blockers: ['dirty', 'unpushed', 'other'] })
      })
    )
    expect(forced.item.verdict).toBe('harvestable')
    expect(forced.item.blockers).toEqual(['other'])
  })

  it('does not touch the original bundle', () => {
    const original = reviewBundle()
    asExecutable(original)
    expect(original.item.verdict).toBe('blocked')
    expect(original.bucket).toBe('review')
  })
})

describe('the forced path archives before anything destructive (AC-8)', () => {
  it('writes the tip and the working state before it stops a container', async () => {
    const r = rig()
    const result = await run(reviewBundle(), r)
    expect(result).toMatchObject({ ok: true, haltedAt: null })
    const at = (what: string): number => r.order.indexOf(what)
    expect(at('archiveTip')).toBeGreaterThanOrEqual(0)
    expect(at('archiveWip')).toBeGreaterThan(at('archiveTip'))
    for (const destructive of ['docker stop', 'docker rm', 'removeDir', 'trash']) {
      expect(at(destructive), destructive).toBeGreaterThan(at('archiveWip'))
    }
    // D1: even a confirmed review item never loses a volume.
    expect(r.order).not.toContain('docker volume rm')
  })

  it('writes the same archive refs the cleanup writes later, not a second set', async () => {
    const r = rig()
    await run(reviewBundle(), r)
    expect(r.archived).toHaveLength(4)
    expect(r.archived.slice(0, 2)).toEqual(r.archived.slice(2))
    expect(r.archived[0]).toMatch(/^refs\/archive\/feat\/PROJ-0000-slug\/.+\/tip$/)
  })

  it('refuses without touching docker or the disk when the archive fails', async () => {
    const r = rig({ archiveWipThrows: true })
    const result = await run(reviewBundle(), r)
    expect(result).toMatchObject({ ok: false, haltedAt: 'reprobe' })
    expect(result.error).toContain('archive-failed: disk full')
    expect(r.order).not.toContain('docker stop')
    expect(r.order).not.toContain('docker volume rm')
    expect(r.order).not.toContain('trash')
    expect(r.order).not.toContain('removeDir')
  })

  it('refuses a worktree with nothing to preserve it', async () => {
    const r = rig()
    const noBranch = reviewBundle({
      item: reapItem(WT, { branch: undefined, verdict: 'blocked', blockers: ['dirty'] })
    })
    const result = await run(noBranch, r)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('nothing would preserve')
    expect(r.order).toEqual([])
  })
})

describe('the executor guards are waived only inside the forced ops (AC-8)', () => {
  it('cleans a still-dirty, unpushed, unmerged worktree', async () => {
    const r = rig({ trackedDirty: true })
    const result = await run(reviewBundle(), r)
    expect(result.ok).toBe(true)
    expect(r.order).toContain('trash')
  })

  it('deletes the unmerged local branch with -D, because its tip is archived', async () => {
    const r = rig()
    await run(reviewBundle(), r)
    expect(r.git).toContainEqual(['branch', '-D', BRANCH])
    expect(r.git).not.toContainEqual(['branch', '-d', BRANCH])
  })

  it('does not rewrite any other git command', async () => {
    const r = rig()
    await run(reviewBundle(), r)
    // The registration goes through the executor's own dep now, never a repo-wide prune.
    expect(r.git).not.toContainEqual(['worktree', 'prune'])
  })

  it('leaves the ordinary ops strict: they refuse the same bundle', async () => {
    const r = rig()
    const result = await runBundle(reviewBundle(), createGcOps(r.deps), { removeVolumes: true })
    expect(result.ok).toBe(false)
    expect(r.order).toEqual([])
  })
})

describe('what the force path still refuses (AC-8)', () => {
  it('a running session, even an idle one', async () => {
    const r = rig({ presence: 'open-idle' })
    const result = await run(reviewBundle(), r)
    expect(result).toMatchObject({ ok: false, haltedAt: 'reprobe' })
    expect(r.order).toEqual([])
  })

  it('a HEAD that moved since the scan', async () => {
    const r = rig({ head: 'b'.repeat(40) })
    const result = await run(reviewBundle(), r)
    expect(result).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'changed-since-scan' })
    expect(r.order).toEqual([])
  })

  it('a stack that started in the worktree after the scan', async () => {
    const r = rig()
    r.setStacks([
      stack('app', [container('c1', `${WT}/api`)]),
      stack('extra', [container('c2', `${WT}/web`)])
    ])
    const result = await run(reviewBundle(), r)
    expect(result).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'changed-since-scan' })
    expect(r.order).toEqual([])
  })

  it('a stack that now also runs from outside the worktree', async () => {
    const r = rig()
    r.setStacks([stack('app', [container('c1', `${WT}/api`), container('c3', '/ws/elsewhere')])])
    const result = await run(reviewBundle(), r)
    expect(result.ok).toBe(false)
    expect(r.order).toEqual([])
  })
})

describe('the forced ops keep the live protection and the actor (delta 1, item 3: M15, M18)', () => {
  const operatorOps = (r: Rig, prefs: () => GcPrefs) =>
    createForcedGcOps(withActor(r.deps, 'operator', prefs))

  it('refuses a Keep pressed after the scan, before anything is archived or stopped', async () => {
    const r = rig()
    const b = reviewBundle()
    const prefs = { ...defaultGcPrefs(), keep: { [b.item.id]: 'closed-unmerged' } }
    const result = await runBundle(
      b,
      operatorOps(r, () => prefs),
      FORCE
    )
    expect(result).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'protected-now' })
    expect(r.order).toEqual([])
  })

  it('refuses a path put on neverClean after the scan', async () => {
    const r = rig()
    const prefs = { ...defaultGcPrefs(), neverClean: [WT] }
    const result = await runBundle(
      reviewBundle(),
      operatorOps(r, () => prefs),
      FORCE
    )
    expect(result).toMatchObject({ ok: false, error: 'protected-now' })
    expect(r.order).toEqual([])
  })

  it('reads the prefs at the moment of the clean, not when the ops were built', async () => {
    const r = rig()
    let prefs = defaultGcPrefs()
    const ops = operatorOps(r, () => prefs)
    prefs = { ...prefs, neverClean: [WT] }
    const result = await runBundle(reviewBundle(), ops, FORCE)
    expect(result.ok).toBe(false)
  })

  it('stamps the operator on the journal line of a forced clean', async () => {
    const r = rig()
    const result = await runBundle(
      reviewBundle(),
      operatorOps(r, () => defaultGcPrefs()),
      FORCE
    )
    expect(result.ok).toBe(true)
    expect(r.tombstones).toHaveLength(1)
    expect(r.tombstones[0]).toMatchObject({ actor: 'operator' })
  })
})
