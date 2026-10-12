// AC-C4 (main side): "Freed" no longer claims space that is still on disk. A clean's bytes split
// into what was actually deleted (the dependency folders) and what only moved to the OS trash (the
// checkout), end to end: executor → pipeline → job queue → cycle → `list_cleanup`.

import { describe, expect, it, vi } from 'vitest'
import { cleanItem, type ExecutorDeps } from '../src/main/reaper/executor-core'
import type { ReapItem } from '../src/main/reaper/reaper-core'
import type { Tombstone } from '../src/main/reaper/journal'
import { GcStepError, runBundle, type GcOps } from '../src/main/gc/pipeline-core'
import { createJobQueue } from '../src/main/gc/gc-jobs-core'
import {
  createCycleState,
  runGcCycle,
  type GcCycleDeps,
  type GcGather
} from '../src/main/gc/gc-cycle'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import { cleanupListing } from '../src/main/mcp/cleanup-listing'
import type { CycleRecord } from '../src/main/gc/gc-wire'
import { bundle, DAY, NOW, reapItem } from './gc-fixtures'
import { snapshot } from './gc-snapshot-fixtures'

const GB = 1e9

// ---- executor ---------------------------------------------------------------------------------

function worktreeItem(over: Partial<ReapItem> = {}): ReapItem {
  return {
    id: 'item-1',
    repoPath: '/repo',
    kind: 'worktree',
    branch: 'feat/x',
    path: '/repo/wt-x',
    hidden: false,
    ageDays: 12,
    diskBytes: 1000,
    checkpoints: [],
    verdict: 'harvestable',
    blockers: [],
    needsRemoteDelete: false,
    justifiedBy: 'gh-merged',
    ...over
  }
}

function execDeps(over: Partial<ExecutorDeps> = {}): { deps: ExecutorDeps; journal: Tombstone[] } {
  const journal: Tombstone[] = []
  const deps: ExecutorDeps = {
    probeStatus: vi.fn(async () => ({ trackedDirty: false, untracked: [] })),
    hasUnpushed: vi.fn(async () => false),
    trash: vi.fn(async () => undefined),
    git: vi.fn(async () => ''),
    resolveSha: vi.fn(async () => 'sha123'),
    archiveTip: vi.fn(async (_r: string, _ref: string, sha: string) => sha),
    archiveWip: vi.fn(async () => 'wipsha1'),
    detachSidebar: vi.fn(async () => undefined),
    canUnregister: vi.fn(async () => true),
    removeWorktreeAdmin: vi.fn(async () => true),
    appendTombstone: vi.fn(async (t: Tombstone) => {
      journal.push(t)
    }),
    now: () => 1_800_000_000_000,
    ...over
  }
  return { deps, journal }
}

describe('executor: what went to the trash is recorded at trash time', () => {
  it('measures the folder right before it is trashed and journals path, bytes and time', async () => {
    const order: string[] = []
    const { deps, journal } = execDeps({
      measureBytes: vi.fn(async () => {
        order.push('measure')
        return 750_000
      }),
      trash: vi.fn(async () => {
        order.push('trash')
      })
    })
    const result = await cleanItem(worktreeItem(), { deleteRemote: false }, deps)
    expect(result.ok).toBe(true)
    expect(order).toEqual(['measure', 'trash'])
    expect(result.trashedBytes).toBe(750_000)
    expect(journal[0]).toMatchObject({
      trashedPath: '/repo/wt-x',
      trashedBytes: 750_000,
      trashedAt: 1_800_000_000_000
    })
  })

  it('still records WHERE it went when the size could not be measured', async () => {
    const { deps, journal } = execDeps({ measureBytes: vi.fn(async () => null) })
    const result = await cleanItem(worktreeItem(), { deleteRemote: false }, deps)
    expect(result.trashedBytes).toBeUndefined()
    expect(journal[0]).toMatchObject({ trashedPath: '/repo/wt-x', trashedBytes: null })
  })

  it('a measuring failure never stops the clean', async () => {
    const { deps, journal } = execDeps({
      measureBytes: vi.fn(async () => {
        throw new Error('du: permission denied')
      })
    })
    const result = await cleanItem(worktreeItem(), { deleteRemote: false }, deps)
    expect(result.ok).toBe(true)
    expect(journal[0]).toMatchObject({ trashedPath: '/repo/wt-x', trashedBytes: null })
  })

  it('records nothing when the trash step failed: nothing went there', async () => {
    const { deps, journal } = execDeps({
      measureBytes: vi.fn(async () => 5),
      trash: vi.fn(async () => {
        throw new Error('trash is full')
      })
    })
    const result = await cleanItem(worktreeItem(), { deleteRemote: false }, deps)
    expect(result.ok).toBe(false)
    expect(result.trashedBytes).toBeUndefined()
    expect(journal[0]!.trashedPath ?? null).toBeNull()
  })

  it('a branch-only item trashes nothing and records nothing', async () => {
    const measure = vi.fn(async () => 1)
    const { deps, journal } = execDeps({ measureBytes: measure })
    await cleanItem(
      worktreeItem({ kind: 'local-branch', path: undefined }),
      { deleteRemote: false },
      deps
    )
    expect(measure).not.toHaveBeenCalled()
    expect(journal[0]!.trashedPath ?? null).toBeNull()
  })
})

// ---- pipeline ---------------------------------------------------------------------------------

function pipelineBundle(diskBytes: number | null, depsBytes: number | null) {
  return bundle('/ws/wt/a', 'ready', {
    lastSignOfLifeAt: NOW - 5 * DAY,
    depsBytes,
    item: reapItem('/ws/wt/a', { diskBytes })
  })
}

function pipelineOps(over: Partial<GcOps> = {}, deps = 400): GcOps {
  return {
    reprobe: async () => ({ ok: true }),
    stopStacks: async () => undefined,
    removeContainers: async () => undefined,
    removeVolumes: async () => undefined,
    dropDeps: async () => deps,
    recheck: async () => ({ ok: true }),
    cleanGit: async () => undefined,
    ...over
  }
}

describe('runBundle: freed now vs in the trash', () => {
  it('freed is what the deps freed; the trashed bytes are what the executor measured', async () => {
    const r = await runBundle(
      pipelineBundle(1_000, 400),
      pipelineOps({ cleanGit: async () => ({ trashedBytes: 550 }) }),
      { removeVolumes: false }
    )
    expect(r.ok).toBe(true)
    expect(r.freedBytes).toBe(400)
    expect(r.trashedBytes).toBe(550)
  })

  it('with no measurement it estimates the checkout as disk size minus the deps just freed', async () => {
    const r = await runBundle(pipelineBundle(1_000, 400), pipelineOps(), { removeVolumes: false })
    expect(r.freedBytes).toBe(400)
    expect(r.trashedBytes).toBe(600)
  })

  it('the estimate never goes negative and is 0 when the disk size is unknown', async () => {
    const small = await runBundle(pipelineBundle(300, 400), pipelineOps(), { removeVolumes: false })
    expect(small.trashedBytes).toBe(0)
    const unknown = await runBundle(pipelineBundle(null, 400), pipelineOps(), {
      removeVolumes: false
    })
    expect(unknown.trashedBytes).toBe(0)
  })

  it('a malformed answer from cleanGit is not trusted: the estimate stands', async () => {
    const r = await runBundle(
      pipelineBundle(1_000, 400),
      pipelineOps({ cleanGit: async () => ({ trashedBytes: -5 }) as never }),
      { removeVolumes: false }
    )
    expect(r.trashedBytes).toBe(600)
  })

  it('a clean that halts AFTER the folder was trashed still reports what is in the trash', async () => {
    const r = await runBundle(
      pipelineBundle(1_000, 400),
      pipelineOps({
        cleanGit: async () => {
          throw new GcStepError('prune', 'prune: locked', { trashedBytes: 600 })
        }
      }),
      { removeVolumes: false }
    )
    expect(r.ok).toBe(false)
    expect(r.haltedAt).toBe('prune')
    expect(r.freedBytes).toBe(400)
    expect(r.trashedBytes).toBe(600)
  })

  it('a clean that halts before the trash reports nothing in the trash', async () => {
    const r = await runBundle(
      pipelineBundle(1_000, 400),
      pipelineOps({
        cleanGit: async () => {
          throw new GcStepError('archive', 'archive: no space')
        }
      }),
      { removeVolumes: false }
    )
    expect(r.freedBytes).toBe(400)
    expect(r.trashedBytes ?? 0).toBe(0)
  })
})

// ---- job queue --------------------------------------------------------------------------------

describe('job queue: both sums travel with progress and done', () => {
  it('sums trashedBytes beside freedBytes', async () => {
    const progress: Array<{ freedBytes: number; trashedBytes: number }> = []
    const done: Array<{ freedBytes: number; trashedBytes: number }> = []
    const queue = createJobQueue({
      newId: () => 'j1',
      emitProgress: (p) => progress.push(p),
      emitDone: (d) => done.push(d)
    })
    const { finished } = queue.submit('manual', ['a', 'b'], async (reporter) => {
      const a = { id: 'a', ok: true, haltedAt: null, freedBytes: 10, trashedBytes: 100 }
      const b = { id: 'b', ok: true, haltedAt: null, freedBytes: 5 }
      reporter.onItem(a)
      reporter.onItem(b)
      return [a, b]
    })
    await finished
    expect(progress.map((p) => [p.freedBytes, p.trashedBytes])).toEqual([
      [10, 100],
      [15, 100]
    ])
    expect(done[0]).toMatchObject({ freedBytes: 15, trashedBytes: 100 })
    expect(queue.jobs()[0]).toMatchObject({ freedBytes: 15, trashedBytes: 100 })
  })
})

// ---- cycle ------------------------------------------------------------------------------------

function cycleRig(cleaned: { freed: number; trashed: number }) {
  const notices: Array<{ title: string; body: string }> = []
  const cycles: CycleRecord[] = []
  const b = bundle('/ws/wt/c', 'ready', {
    lastSignOfLifeAt: NOW - 5 * DAY,
    item: reapItem('/ws/wt/c', { diskBytes: GB })
  })
  const gather: GcGather = {
    bundles: [b],
    housekeeping: {
      volumes: [],
      containers: [],
      dirExists: () => true,
      knownFolders: [],
      protectedProjects: new Set()
    }
  }
  let n = 0
  const deps: GcCycleDeps = {
    prefs: () => ({ ...defaultGcPrefs(), autopilot: true, firstReportAcknowledged: true }),
    gather: async () => structuredClone(gather),
    opsFor: () =>
      pipelineOps({
        dropDeps: async () => cleaned.freed,
        cleanGit: async () => ({ trashedBytes: cleaned.trashed })
      }),
    queue: createJobQueue({
      newId: () => `job-${++n}`,
      emitProgress: () => undefined,
      emitDone: () => undefined
    }),
    housekeeping: async () => ({ buildCacheBytes: 0, imageBytes: 0, volumeBytes: 0, errors: [] }),
    notify: (x) => notices.push(x),
    emitCycle: (r) => cycles.push(r),
    state: createCycleState(),
    now: () => NOW
  }
  return { deps, notices, cycles }
}

describe('runGcCycle: the record and the notice say both numbers', () => {
  it('records freed-now and in-the-trash separately', async () => {
    const r = cycleRig({ freed: 400 * 1e6, trashed: 2 * GB })
    const record = await runGcCycle(r.deps, 'timer')
    expect(record.freedBytes).toBe(400 * 1e6)
    expect(record.trashedBytes).toBe(2 * GB)
  })

  it('the notice never calls the trashed bytes freed', async () => {
    const r = cycleRig({ freed: 400 * 1e6, trashed: 2 * GB })
    await runGcCycle(r.deps, 'timer')
    expect(r.notices).toEqual([
      {
        title: 'Workspace cleanup',
        body: 'Cleaned 1 worktree, 400 MB freed now · 2.00 GB in the trash'
      }
    ])
  })

  it('with nothing in the trash it says only what was freed now', async () => {
    const r = cycleRig({ freed: 400 * 1e6, trashed: 0 })
    await runGcCycle(r.deps, 'timer')
    expect(r.notices[0]!.body).toBe('Cleaned 1 worktree, 400 MB freed now')
  })
})

// ---- list_cleanup -----------------------------------------------------------------------------

describe('list_cleanup carries the matching totals (agent-facing)', () => {
  const opts = { denyFolders: [], home: '/home/u' }
  const lastCycle: CycleRecord = {
    at: NOW,
    trigger: 'timer',
    mode: 'clean',
    found: 1,
    foundBytes: GB,
    cleaned: [],
    freedBytes: 400 * 1e6,
    trashedBytes: 2 * GB,
    deferred: 0,
    housekeeping: null,
    notified: true,
    jobId: null
  }

  it('lists the last cycle as freed-now vs trashed, and what Harnu still has in the trash', () => {
    const snap = snapshot([], {
      lastCycle,
      trash: {
        inTrashBytes: 3 * GB,
        inTrashCount: 2,
        canEmpty: true,
        location: '~/.local/share/Trash'
      }
    })
    const listing = cleanupListing(snap, opts)
    expect(listing.lastCycle).toEqual({
      at: NOW,
      freedNowBytes: 400 * 1e6,
      trashedBytes: 2 * GB
    })
    expect(listing.totals.inTrashBytes).toBe(3 * GB)
    expect(listing.totals.inTrashCount).toBe(2)
  })

  it('has null/zero totals before any cycle or trashed item, never undefined', () => {
    const listing = cleanupListing(snapshot([]), opts)
    expect(listing.lastCycle).toBeNull()
    expect(listing.totals.inTrashBytes).toBe(0)
    expect(listing.totals.inTrashCount).toBe(0)
    expect(listing.totals.archives).toBe(0)
    expect(listing.totals.archiveBytes).toBe(0)
  })
})
