import { describe, it, expect, vi } from 'vitest'
import {
  createCycleState,
  formatBytes,
  runGcCycle,
  withFailures,
  type GcCycleDeps,
  type GcGather
} from '../src/main/gc/gc-cycle'
import { bucketFeed } from '../src/main/gc/gc-buckets'
import { buildBundles } from '../src/main/gc/bundle-core'
import { planCycle } from '../src/main/gc/autopilot-core'
import { createJobQueue } from '../src/main/gc/gc-jobs-core'
import { defaultGcPrefs, type GcPrefs } from '../src/main/gc/gc-prefs'
import { GcStepError, type GcOps } from '../src/main/gc/pipeline-core'
import {
  housekeepingArgv,
  type HousekeepingPlan,
  type HousekeepingResult
} from '../src/main/gc/housekeeping-core'
import type { CycleRecord } from '../src/main/gc/gc-wire'
import type { WorktreeBundle } from '../src/main/gc/bundle-core'
import { bundle, DAY, NOW, reapItem } from './gc-fixtures'
import { bundlesOf, pr, scanInput, OTHER } from './gc-scan-fixtures'

const GIB = 1024 ** 3

const live = (over: Partial<GcPrefs> = {}): GcPrefs => ({
  ...defaultGcPrefs(),
  autopilot: true,
  firstReportAcknowledged: true,
  ...over
})

const corpse = (name: string, daysAgo = 5, over: Parameters<typeof bundle>[2] = {}) =>
  bundle(`/ws/wt/${name}`, 'corpse', {
    lastSignOfLifeAt: NOW - daysAgo * DAY,
    item: reapItem(`/ws/wt/${name}`, { diskBytes: GIB }),
    ...over
  })

const noHousekeeping: GcGather['housekeeping'] = {
  volumes: [],
  containers: [],
  dirExists: () => true,
  knownFolders: [],
  protectedProjects: new Set()
}

interface Rig {
  deps: GcCycleDeps
  log: string[]
  notices: Array<{ title: string; body: string }>
  cycles: CycleRecord[]
  gathered: WorktreeBundle[][]
  hk: HousekeepingPlan[]
  actors: string[]
  ops: GcOps
  cleanGit: ReturnType<typeof vi.fn>
}

function rig(
  bundles: WorktreeBundle[],
  prefs: GcPrefs,
  opts: {
    ops?: Partial<GcOps>
    hkResult?: HousekeepingResult
    hkThrows?: boolean
    gather?: () => Promise<GcGather>
    queue?: ReturnType<typeof createJobQueue>
    state?: ReturnType<typeof createCycleState>
  } = {}
): Rig {
  const log: string[] = []
  const notices: Array<{ title: string; body: string }> = []
  const cycles: CycleRecord[] = []
  const gathered: WorktreeBundle[][] = []
  const hk: HousekeepingPlan[] = []
  const actors: string[] = []
  const cleanGit = vi.fn(async (b: WorktreeBundle) => {
    log.push(`cleanGit ${b.item.path}`)
  })
  const ops: GcOps = {
    reprobe: async (b) => {
      log.push(`reprobe ${b.item.path}`)
      return { ok: true }
    },
    stopStacks: async () => undefined,
    removeContainers: async () => undefined,
    removeVolumes: async (names) => {
      log.push(`removeVolumes ${names.join(',')}`)
    },
    dropDeps: async () => 100,
    recheck: async () => ({ ok: true }),
    cleanGit,
    ...opts.ops
  }
  let n = 0
  const deps: GcCycleDeps = {
    prefs: () => prefs,
    gather:
      opts.gather ??
      (async () => ({ bundles: structuredClone(bundles), housekeeping: noHousekeeping })),
    opsFor: (actor) => {
      actors.push(actor)
      return ops
    },
    queue:
      opts.queue ??
      createJobQueue({
        newId: () => `job-${++n}`,
        emitProgress: () => undefined,
        emitDone: () => undefined
      }),
    housekeeping: async (plan) => {
      log.push('housekeeping')
      hk.push(plan)
      if (opts.hkThrows) throw new Error('docker exploded')
      return opts.hkResult ?? { buildCacheBytes: 0, imageBytes: 0, volumeBytes: 0, errors: [] }
    },
    notify: (x) => notices.push(x),
    emitCycle: (r) => cycles.push(r),
    onGathered: (g) => gathered.push(g.bundles),
    state: opts.state ?? createCycleState(),
    now: () => NOW
  }
  return { deps, log, notices, cycles, gathered, hk, actors, ops, cleanGit }
}

const cleanedPaths = (r: Rig): string[] =>
  r.log.filter((l) => l.startsWith('cleanGit ')).map((l) => l.slice('cleanGit '.length))

describe('runGcCycle: only corpses reach the pipeline (AC-3)', () => {
  it('sends exactly the two corpses to runBatch when a decide bundle sits beside them', async () => {
    const r = rig(
      [corpse('a', 9), bundle('/ws/wt/d', 'decide'), corpse('b', 5), bundle('/ws/wt/l', 'alive')],
      live()
    )
    const record = await runGcCycle(r.deps, 'timer')
    expect(cleanedPaths(r)).toEqual(['/ws/wt/a', '/ws/wt/b'])
    expect(r.log.filter((l) => l.startsWith('reprobe '))).toEqual([
      'reprobe /ws/wt/a',
      'reprobe /ws/wt/b'
    ])
    expect(record.mode).toBe('clean')
    expect(record.cleaned.map((c) => c.id)).toEqual([
      '/ws/org/proj/www::worktree::/ws/wt/a',
      '/ws/org/proj/www::worktree::/ws/wt/b'
    ])
  })

  it('runs it through the autopilot actor, so tombstones are marked as unattended', async () => {
    const r = rig([corpse('a')], live())
    await runGcCycle(r.deps, 'timer')
    expect(r.actors).toEqual(['autopilot'])
  })

  it('cleans nothing while the autopilot is off, but still gathers for the Containers feed', async () => {
    const r = rig([corpse('a')], live({ autopilot: false }))
    const record = await runGcCycle(r.deps, 'timer')
    expect(record.mode).toBe('off')
    expect(r.log).toEqual([])
    expect(r.gathered).toHaveLength(1)
    expect(r.notices).toEqual([])
  })

  it('cleans nothing while the worktrees category is off', async () => {
    const r = rig([corpse('a')], live({ categories: { worktrees: false, dockerCache: false } }))
    await runGcCycle(r.deps, 'timer')
    expect(cleanedPaths(r)).toEqual([])
  })

  it('caps the batch and reports the rest as deferred', async () => {
    const r = rig([corpse('a', 9), corpse('b', 8), corpse('c', 7)], live({ maxItemsPerCycle: 2 }))
    const record = await runGcCycle(r.deps, 'timer')
    expect(cleanedPaths(r)).toEqual(['/ws/wt/a', '/ws/wt/b'])
    expect(record.deferred).toBe(1)
  })

  it('skips a corpse on the neverClean list', async () => {
    const r = rig([corpse('a'), corpse('b')], live({ neverClean: ['/ws/wt/a'] }))
    await runGcCycle(r.deps, 'timer')
    expect(cleanedPaths(r)).toEqual(['/ws/wt/b'])
  })

  it('never removes a volume, whatever the prefs say (D1)', async () => {
    const withVolume = corpse('a', 5, { stackIds: ['s1'], ownedVolumes: ['v1'] })
    const r = rig([withVolume], live())
    await runGcCycle(r.deps, 'timer')
    expect(cleanedPaths(r)).toEqual(['/ws/wt/a'])
    expect(r.log.some((l) => l.startsWith('removeVolumes'))).toBe(false)
    // Even a stale prefs file that still carries the retired switches turns nothing on.
    const stale = {
      ...live(),
      removeVolumes: true,
      categories: { worktrees: true, volumes: true, dockerCache: true }
    }
    const r2 = rig([withVolume], stale as GcPrefs)
    await runGcCycle(r2.deps, 'timer')
    expect(r2.log.some((l) => l.startsWith('removeVolumes'))).toBe(false)
  })

  it('hands runBatch removeVolumes:false', async () => {
    const seen: unknown[] = []
    const withVolume = corpse('a', 5, { stackIds: ['s1'], ownedVolumes: ['v1'] })
    const r = rig([withVolume], live(), {
      ops: {
        reprobe: async (b) => {
          seen.push(b.ownedVolumes)
          return { ok: true }
        }
      }
    })
    await runGcCycle(r.deps, 'timer')
    expect(seen).toEqual([['v1']])
    expect(r.log).not.toContain('removeVolumes v1')
  })
})

describe('runGcCycle: the first cycle only reports (AC-3)', () => {
  const unacknowledged = live({ firstReportAcknowledged: false })

  it('deletes nothing and says what it found', async () => {
    const r = rig([corpse('a'), corpse('b')], unacknowledged)
    const record = await runGcCycle(r.deps, 'timer')
    expect(record.mode).toBe('report')
    expect(r.log).toEqual([])
    expect(record.found).toBe(2)
    expect(r.notices).toEqual([
      { title: 'Workspace cleanup', body: 'Found 2 corpses, 2.0 GiB — enable automatic cleanup?' }
    ])
    expect(record.notified).toBe(true)
  })

  it('says "1 corpse" for one', async () => {
    const r = rig([corpse('a')], unacknowledged)
    await runGcCycle(r.deps, 'timer')
    expect(r.notices[0]!.body).toBe('Found 1 corpse, 1.0 GiB — enable automatic cleanup?')
  })

  it('does not repeat the report notice until the count changes', async () => {
    const state = createCycleState()
    const first = rig([corpse('a')], unacknowledged, { state })
    await runGcCycle(first.deps, 'timer')
    const second = rig([corpse('a')], unacknowledged, { state })
    await runGcCycle(second.deps, 'timer')
    expect(second.notices).toEqual([])
    const third = rig([corpse('a'), corpse('b')], unacknowledged, { state })
    await runGcCycle(third.deps, 'timer')
    expect(third.notices).toHaveLength(1)
  })

  it('stays quiet when there is nothing to report', async () => {
    const r = rig([bundle('/ws/wt/d', 'decide')], unacknowledged)
    await runGcCycle(r.deps, 'timer')
    expect(r.notices).toEqual([])
  })

  it('never runs Docker housekeeping before the report is acknowledged', async () => {
    const r = rig([corpse('a')], unacknowledged)
    await runGcCycle(r.deps, 'timer')
    expect(r.hk).toEqual([])
  })
})

describe('runGcCycle: one notification at most (AC-3)', () => {
  it('posts a single notice for a cycle that cleaned several worktrees', async () => {
    const r = rig([corpse('a'), corpse('b')], live())
    const record = await runGcCycle(r.deps, 'timer')
    expect(r.notices).toHaveLength(1)
    expect(r.notices[0]!.body).toBe('Cleaned 2 worktrees, freed 200 B')
    expect(record.notified).toBe(true)
  })

  it('posts none when every item was refused', async () => {
    const r = rig([corpse('a')], live(), {
      ops: { reprobe: async () => ({ ok: false, reason: 'changed-since-scan' }) }
    })
    const record = await runGcCycle(r.deps, 'timer')
    expect(r.notices).toEqual([])
    expect(record.notified).toBe(false)
  })

  it('posts none for a cycle with nothing to do', async () => {
    const r = rig([], live())
    await runGcCycle(r.deps, 'timer')
    expect(r.notices).toEqual([])
  })

  it('pushes the cycle record to the renderer once', async () => {
    const r = rig([corpse('a')], live())
    const record = await runGcCycle(r.deps, 'timer')
    expect(r.cycles).toEqual([record])
    expect(r.deps.state.last).toBe(record)
  })
})

describe('runGcCycle: Docker housekeeping (AC-6)', () => {
  it('is never planned or run when the dockerCache category is off', async () => {
    const r = rig([corpse('a')], live({ categories: { worktrees: true, dockerCache: false } }))
    await runGcCycle(r.deps, 'timer')
    expect(r.hk).toEqual([])
    expect(r.log).not.toContain('housekeeping')
  })

  it('runs after the batch, with the cache age from the prefs and dangling images on', async () => {
    const r = rig([corpse('a')], live({ cacheMaxAgeDays: 3 }))
    await runGcCycle(r.deps, 'timer')
    expect(r.log).toEqual(['reprobe /ws/wt/a', 'cleanGit /ws/wt/a', 'housekeeping'])
    expect(r.hk[0]).toMatchObject({ builderPruneUntilHours: 72, danglingImages: true })
  })

  it('never plans an orphan volume, even when one is plainly orphaned', async () => {
    const gather = async (): Promise<GcGather> => ({
      bundles: [corpse('a')],
      housekeeping: {
        ...noHousekeeping,
        volumes: [{ name: 'lost_data', project: 'lost', sizeBytes: 9 }],
        containers: [
          {
            id: 'x'.repeat(64),
            name: 'lost-app-1',
            image: 'busybox',
            labels: {
              'com.docker.compose.project': 'lost',
              'com.docker.compose.project.working_dir': '/ws/gone'
            },
            state: 'exited',
            startedAt: null,
            finishedAt: null,
            createdAt: null,
            ports: [],
            mounts: []
          } as never
        ],
        dirExists: () => false
      }
    })
    const r = rig([], live(), { gather })
    await runGcCycle(r.deps, 'timer')
    expect(r.hk).toHaveLength(1)
    expect(r.hk[0]!.orphanVolumes).toEqual([])
    expect(housekeepingArgv(r.hk[0]!).some((a) => a[0] === 'volume')).toBe(false)
  })

  it('runs housekeeping even with no corpse to clean', async () => {
    const r = rig([], live())
    await runGcCycle(r.deps, 'timer')
    expect(r.hk).toHaveLength(1)
  })

  it('still runs when only the worktrees category is off', async () => {
    const r = rig([corpse('a')], live({ categories: { worktrees: false, dockerCache: true } }))
    await runGcCycle(r.deps, 'timer')
    expect(cleanedPaths(r)).toEqual([])
    expect(r.hk).toHaveLength(1)
  })

  it('does not run while the autopilot is off', async () => {
    const r = rig([corpse('a')], live({ autopilot: false }))
    await runGcCycle(r.deps, 'timer')
    expect(r.hk).toEqual([])
  })

  it('adds the reclaimed bytes to the cycle record and the notice', async () => {
    const r = rig([corpse('a')], live(), {
      hkResult: { buildCacheBytes: 2 * GIB, imageBytes: GIB, volumeBytes: 0, errors: [] }
    })
    const record = await runGcCycle(r.deps, 'timer')
    expect(record.freedBytes).toBe(100 + 3 * GIB)
    expect(record.housekeeping).toMatchObject({ buildCacheBytes: 2 * GIB, imageBytes: GIB })
    expect(r.notices).toHaveLength(1)
    expect(r.notices[0]!.body).toBe('Cleaned 1 worktree, freed 3.0 GiB')
  })

  it('notifies once when only the Docker cache was reclaimed', async () => {
    const r = rig([], live(), {
      hkResult: { buildCacheBytes: GIB, imageBytes: 0, volumeBytes: 0, errors: [] }
    })
    await runGcCycle(r.deps, 'timer')
    expect(r.notices).toEqual([
      { title: 'Workspace cleanup', body: 'Freed 1.0 GiB of Docker cache' }
    ])
  })

  it('keeps the worktree results when housekeeping throws', async () => {
    const r = rig([corpse('a')], live(), { hkThrows: true })
    const record = await runGcCycle(r.deps, 'timer')
    expect(record.cleaned).toHaveLength(1)
    expect(record.housekeeping?.errors).toEqual(['housekeeping: docker exploded'])
  })
})

describe('runGcCycle: a failing corpse is not retried every hour (spec §4)', () => {
  const failing: Partial<GcOps> = {
    cleanGit: async () => {
      throw new GcStepError('trash', 'trash-folder: EBUSY')
    }
  }

  it('turns into a Decide item "cleanup-failed" after a step failed', async () => {
    const state = createCycleState()
    const first = rig([corpse('a')], live(), { ops: failing, state })
    const record = await runGcCycle(first.deps, 'timer')
    expect(record.cleaned[0]).toMatchObject({ ok: false, haltedAt: 'trash' })

    let seen: WorktreeBundle[] = []
    const second = rig([corpse('a')], live(), { state })
    second.deps.onGathered = (g) => (seen = g.bundles)
    await runGcCycle(second.deps, 'timer')
    expect(cleanedPaths(second)).toEqual([])
    expect(seen[0]).toMatchObject({
      bucket: 'decide',
      reason: { code: 'cleanup-failed', detail: expect.stringContaining('trash') }
    })
  })

  it('does not remember a refusal at the reprobe: that item simply re-buckets next scan', async () => {
    const state = createCycleState()
    const refuse = rig([corpse('a')], live(), {
      ops: { reprobe: async () => ({ ok: false, reason: 'session-open' }) },
      state
    })
    await runGcCycle(refuse.deps, 'timer')
    const again = rig([corpse('a')], live(), { state })
    await runGcCycle(again.deps, 'timer')
    expect(cleanedPaths(again)).toEqual(['/ws/wt/a'])
  })

  it('tries again after a day', async () => {
    const state = createCycleState()
    await runGcCycle(rig([corpse('a')], live(), { ops: failing, state }).deps, 'timer')
    const later = rig([corpse('a')], live(), { state })
    later.deps.now = () => NOW + 25 * 3_600_000
    await runGcCycle(later.deps, 'timer')
    expect(cleanedPaths(later)).toEqual(['/ws/wt/a'])
  })

  it('forgets a failure once the worktree is gone', async () => {
    const state = createCycleState()
    await runGcCycle(rig([corpse('a')], live(), { ops: failing, state }).deps, 'timer')
    await runGcCycle(rig([], live(), { state }).deps, 'timer')
    expect(state.failures.size).toBe(0)
  })
})

describe('runGcCycle: shares the queue with manual cleaning (AC-4)', () => {
  it('waits for a manual job that is already running instead of running beside it', async () => {
    const queue = createJobQueue({
      newId: (() => {
        let n = 0
        return () => `job-${++n}`
      })(),
      emitProgress: () => undefined,
      emitDone: () => undefined
    })
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    queue.submit('manual', ['m'], async () => {
      await gate
      return []
    })
    const r = rig([corpse('a')], live(), { queue })
    const cycle = runGcCycle(r.deps, 'timer')
    await new Promise((res) => setTimeout(res, 5))
    expect(r.log).toEqual([])
    release()
    await cycle
    expect(cleanedPaths(r)).toEqual(['/ws/wt/a'])
  })
})

describe('end to end from the scanner fixtures (AC-5)', () => {
  it('cleans a merged worktree whose PR head is its HEAD', async () => {
    const r = rig(bundlesOf(scanInput()), live())
    await runGcCycle(r.deps, 'timer')
    expect(cleanedPaths(r)).toHaveLength(1)
  })

  it('leaves it alone when the PR head is not the worktree HEAD', async () => {
    const reused = scanInput({ prByBranch: new Map([['feat/slug', pr(OTHER)]]) })
    const bundles = bundlesOf(reused)
    expect(bundles[0]!.bucket).toBe('decide')
    const r = rig(bundles, live())
    const record = await runGcCycle(r.deps, 'timer')
    expect(r.log.filter((l) => l !== 'housekeeping')).toEqual([])
    expect(record.cleaned).toEqual([])
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [2048, '2.0 KiB'],
    [5 * 1024 ** 2, '5.0 MiB'],
    [1.5 * GIB, '1.5 GiB'],
    [3 * 1024 ** 4, '3.0 TiB']
  ])('%j → %j', (n, want) => {
    expect(formatBytes(n)).toBe(want)
  })
})

describe('withFailures: every consumer sees a halted item as Decide (delta 1, item 4)', () => {
  const failure = { step: 'trash', error: 'EBUSY', at: NOW }

  it('rewrites the gathered bundles and leaves the rest of the gather alone', () => {
    const state = createCycleState()
    const a = corpse('a')
    state.failures.set(a.item.id, failure)
    const gather: GcGather = { bundles: [a, corpse('b')], housekeeping: noHousekeeping }
    const out = withFailures(gather, state, NOW)
    expect(out.bundles[0]).toMatchObject({ bucket: 'decide', reason: { code: 'cleanup-failed' } })
    expect(out.bundles[1]!.bucket).toBe('corpse')
    expect(out.housekeeping).toBe(gather.housekeeping)
  })

  it('never feeds a cleanup-failed item to the Containers view as a corpse', () => {
    const state = createCycleState()
    const a = corpse('a')
    state.failures.set(a.item.id, failure)
    const feed = bucketFeed(
      withFailures({ bundles: [a], housekeeping: noHousekeeping }, state, NOW).bundles
    )
    expect(feed.get('/ws/wt/a')).toBe('decide')
  })

  it('drops failures that expired or whose worktree is gone', () => {
    const state = createCycleState()
    state.failures.set('gone', failure)
    const a = corpse('a')
    state.failures.set(a.item.id, { ...failure, at: NOW - 25 * 3_600_000 })
    const out = withFailures({ bundles: [a], housekeeping: noHousekeeping }, state, NOW)
    expect(out.bundles[0]!.bucket).toBe('corpse')
    expect(state.failures.size).toBe(0)
  })

  it('is idempotent, so the cycle can apply it again', () => {
    const state = createCycleState()
    const a = corpse('a')
    state.failures.set(a.item.id, failure)
    const once = withFailures({ bundles: [a], housekeeping: noHousekeeping }, state, NOW)
    expect(withFailures(once, state, NOW).bundles).toEqual(once.bundles)
  })
})

describe('detached worktrees are never a corpse for the autopilot (delta 1, item 3)', () => {
  it('buildBundles never buckets a detached worktree as a corpse', () => {
    const item = reapItem('/ws/wt/det', {
      kind: 'detached-worktree',
      branch: undefined,
      headSha: 'a'.repeat(40)
    })
    const [b] = buildBundles({
      items: [item],
      fateInputs: new Map(),
      stacks: [],
      stackPaths: new Map(),
      containers: [],
      sessions: new Map(),
      keep: new Set(),
      neverClean: new Set(),
      now: NOW,
      graceDays: 2,
      volumes: new Map(),
      knownFolders: [],
      protectedProjects: new Set()
    })
    expect(b!.bucket).not.toBe('corpse')
    expect(planCycle([b!], live()).toClean).toEqual([])
  })

  it('does not plan or run a hand-built corpse of a detached kind', async () => {
    const det = bundle('/ws/wt/det', 'corpse', {
      item: reapItem('/ws/wt/det', { kind: 'detached-worktree' })
    })
    expect(planCycle([det], live()).toClean).toEqual([])
    const r = rig([det], live())
    await runGcCycle(r.deps, 'timer')
    expect(cleanedPaths(r)).toEqual([])
  })
})
