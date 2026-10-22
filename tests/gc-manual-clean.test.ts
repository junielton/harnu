import { describe, it, expect, vi } from 'vitest'
import { submitManualClean, type ManualCleanDeps } from '../src/main/gc/gc-manual'
import { expectedOf, orphanExpectedOf } from '../src/main/gc/gc-confirm'
import type { GcCleanOptions } from '../src/main/gc/gc-wire'
import { createCycleState } from '../src/main/gc/gc-cycle'
import { createJobQueue, type GcJobDone, type GcJobProgress } from '../src/main/gc/gc-jobs-core'
import { defaultGcPrefs, type GcPrefs } from '../src/main/gc/gc-prefs'
import { GcStepError, type GcOps } from '../src/main/gc/pipeline-core'
import type { WorktreeBundle } from '../src/main/gc/bundle-core'
import type { OrphanVolumeItem } from '../src/main/gc/gc-housekeeping-input'
import { bundle, NOW, reapItem } from './gc-fixtures'

const prefs = (over: Partial<GcPrefs> = {}): GcPrefs => ({ ...defaultGcPrefs(), ...over })

const orphan = (name: string, sizeBytes = 4_096): OrphanVolumeItem => ({
  id: `volume:${name}`,
  name,
  sizeBytes,
  project: 'lost',
  reason: {
    code: 'no-known-worktree',
    detail: 'No known worktree uses the compose project "lost".'
  }
})

interface Rig {
  deps: ManualCleanDeps
  normal: string[]
  forced: string[]
  progress: GcJobProgress[]
  done: GcJobDone[]
  removedVolumes: string[][]
  gather: ReturnType<typeof vi.fn>
}

function fakeOps(log: string[], over: Partial<GcOps> = {}): GcOps {
  return {
    reprobe: async (b) => {
      log.push(`reprobe ${b.item.path}`)
      return { ok: true }
    },
    stopStacks: async () => undefined,
    removeContainers: async () => undefined,
    removeVolumes: async (names) => {
      log.push(`removeVolumes ${names.join(',')}`)
    },
    dropDeps: async () => 7,
    recheck: async () => ({ ok: true }),
    cleanGit: async (b) => {
      log.push(`cleanGit ${b.item.path}`)
    },
    ...over
  }
}

function rig(
  bundles: WorktreeBundle[],
  opts: {
    prefs?: GcPrefs
    orphans?: OrphanVolumeItem[]
    normalOps?: Partial<GcOps>
    forcedOps?: Partial<GcOps>
    gatherGate?: Promise<void>
    volumeError?: string
    /** What a gather started right before the removal sees; defaults to the job's own orphans. */
    freshOrphans?: () => Promise<OrphanVolumeItem[]>
    /** What a fresh probe of a worktree's uncommitted work reads right now; default: the scan's stamp. */
    workStamp?: (path: string) => Promise<string | null>
  } = {}
): Rig {
  const normal: string[] = []
  const forced: string[] = []
  const progress: GcJobProgress[] = []
  const done: GcJobDone[] = []
  const removedVolumes: string[][] = []
  let n = 0
  const gather = vi.fn(async () => {
    await opts.gatherGate
    return { bundles: structuredClone(bundles), orphanVolumes: opts.orphans ?? [] }
  })
  const deps: ManualCleanDeps = {
    prefs: () => opts.prefs ?? prefs(),
    gather,
    opsFor: (_actor, isForced) =>
      isForced ? fakeOps(forced, opts.forcedOps) : fakeOps(normal, opts.normalOps),
    freshOrphans: async () => (opts.freshOrphans ? opts.freshOrphans() : (opts.orphans ?? [])),
    workStampOf:
      opts.workStamp ??
      (async (p) => bundles.find((b) => b.item.path === p)?.item.workStamp ?? null),
    removeOrphanVolumes: async (names) => {
      removedVolumes.push(names)
      return {
        buildCacheBytes: 0,
        imageBytes: 0,
        volumeBytes: 4_096 * names.length,
        errors: opts.volumeError ? [opts.volumeError] : []
      }
    },
    queue: createJobQueue({
      newId: () => `job-${++n}`,
      emitProgress: (p) => progress.push(p),
      emitDone: (d) => done.push(d)
    }),
    state: createCycleState(),
    now: () => NOW
  }
  return { deps, normal, forced, progress, done, removedVolumes, gather }
}

const settle = (r: Rig): Promise<void> => r.deps.queue.idle()

/**
 * What a Cleanup row would send back: the facts shown for every listed item, and the
 * confirmation of every review worktree and orphan volume among them (override with `confirm`).
 */
function shown(
  bundles: WorktreeBundle[],
  orphans: OrphanVolumeItem[] = [],
  confirm?: string[]
): GcCleanOptions {
  const expected: GcCleanOptions['expected'] = {}
  for (const b of bundles) expected[b.item.id] = expectedOf(b)
  for (const o of orphans) expected[o.id] = orphanExpectedOf(o)
  return {
    expected,
    confirmed: confirm ?? [
      ...bundles.filter((b) => b.bucket !== 'ready').map((b) => b.item.id),
      ...orphans.map((o) => o.id)
    ]
  }
}

const readyOpts = (...bs: WorktreeBundle[]): GcCleanOptions => shown(bs)

describe('gc:clean is a background job (AC-4)', () => {
  it('acknowledges before the batch runs', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const b = bundle('/ws/wt/a', 'ready')
    const r = rig([b], { gatherGate: gate })
    const ack = submitManualClean(r.deps, [b.item.id], readyOpts(b))
    expect(ack).toEqual({ jobId: 'job-1', queued: false })
    expect(r.normal).toEqual([])
    release()
    await settle(r)
    expect(r.normal).toEqual(['reprobe /ws/wt/a', 'cleanGit /ws/wt/a'])
  })

  it('streams one progress event per requested id, then one done', async () => {
    const a = bundle('/ws/wt/a', 'ready')
    const b = bundle('/ws/wt/b', 'ready')
    const r = rig([a, b])
    submitManualClean(r.deps, [a.item.id, b.item.id], readyOpts(a, b))
    await settle(r)
    expect(r.progress.map((p) => p.done)).toEqual([1, 2])
    expect(r.done).toHaveLength(1)
    expect(r.done[0]).toMatchObject({
      kind: 'manual',
      done: 2,
      total: 2,
      freedBytes: 14,
      error: null
    })
  })

  it('queues a second request behind a running one instead of running it in parallel', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const a = bundle('/ws/wt/a', 'ready')
    const b = bundle('/ws/wt/b', 'ready')
    const r = rig([a, b], { gatherGate: gate })
    const first = submitManualClean(r.deps, [a.item.id], readyOpts(a))
    const second = submitManualClean(r.deps, [b.item.id], readyOpts(b))
    expect(first.queued).toBe(false)
    expect(second.queued).toBe(true)
    await new Promise((res) => setTimeout(res, 5))
    expect(r.gather).toHaveBeenCalledTimes(1)
    release()
    await settle(r)
    expect(r.normal).toEqual([
      'reprobe /ws/wt/a',
      'cleanGit /ws/wt/a',
      'reprobe /ws/wt/b',
      'cleanGit /ws/wt/b'
    ])
  })

  it('ignores a repeated id', async () => {
    const a = bundle('/ws/wt/a', 'ready')
    const r = rig([a])
    submitManualClean(r.deps, [a.item.id, a.item.id], readyOpts(a))
    await settle(r)
    expect(r.normal.filter((l) => l.startsWith('cleanGit'))).toHaveLength(1)
  })
})

describe('refusals leave a result and call no op (AC-8)', () => {
  async function refused(
    b: WorktreeBundle,
    over: Parameters<typeof rig>[1] = {},
    opts?: GcCleanOptions
  ) {
    const r = rig([b], over)
    submitManualClean(r.deps, [b.item.id], opts ?? shown([b]))
    await settle(r)
    expect(r.normal).toEqual([])
    expect(r.forced).toEqual([])
    return r.done[0]!.results[0]!
  }

  it('refuses a review worktree the operator did not confirm', async () => {
    const d = bundle('/ws/wt/d', 'review')
    const res = await refused(d, {}, shown([d], [], []))
    expect(res).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'needs-confirmation' })
  })

  it('refuses an in-use worktree even when confirmed', async () => {
    const l = bundle('/ws/wt/l', 'in-use')
    expect((await refused(l, {}, shown([l], [], [l.item.id]))).error).toBe('in-use')
  })

  it('refuses a main checkout even when confirmed', async () => {
    const m = bundle('/ws/wt/m', 'review', { isMainCheckout: true })
    expect((await refused(m)).error).toBe('main-checkout')
  })

  it('refuses a path added to neverClean after the snapshot was taken', async () => {
    const a = bundle('/ws/wt/a', 'ready')
    const res = await refused(a, { prefs: prefs({ neverClean: ['/ws/wt/a'] }) })
    expect(res.error).toBe('never-clean')
  })

  it('reports an id that is no longer known', async () => {
    const r = rig([])
    submitManualClean(r.deps, ['gone'], { expected: {}, confirmed: [] })
    await settle(r)
    expect(r.done[0]!.results[0]).toMatchObject({ id: 'gone', ok: false, error: 'unknown-item' })
  })

  it('still emits progress for a refused item', async () => {
    const d = bundle('/ws/wt/d', 'review')
    const r = rig([d])
    submitManualClean(r.deps, [d.item.id], shown([d], [], []))
    await settle(r)
    expect(r.progress).toHaveLength(1)
  })
})

describe('the confirmation binds to what the operator saw (AC-8, delta 1)', () => {
  async function run(fresh: WorktreeBundle[], opts: GcCleanOptions, ids: string[]) {
    const r = rig(fresh)
    submitManualClean(r.deps, ids, opts)
    await settle(r)
    return r
  }

  it('refuses an item with no expected facts at all', async () => {
    const a = bundle('/ws/wt/a', 'ready')
    const r = await run([a], { confirmed: [] }, [a.item.id])
    expect(r.normal).toEqual([])
    expect(r.done[0]!.results[0]).toMatchObject({ ok: false, error: 'missing-expected' })
  })

  it('refuses a stack that started after the click, for a confirmed review item', async () => {
    const seen = bundle('/ws/wt/d', 'review', { stackIds: ['s1'] })
    const now = bundle('/ws/wt/d', 'review', { stackIds: ['s1', 's2'] })
    const r = await run([now], shown([seen]), [seen.item.id])
    expect(r.forced).toEqual([])
    expect(r.done[0]!.results[0]).toMatchObject({ ok: false, error: 'changed-since-confirm' })
  })

  it('refuses a stack that started after the click, for a ready item too', async () => {
    const seen = bundle('/ws/wt/a', 'ready')
    const now = bundle('/ws/wt/a', 'ready', { stackIds: ['s9'] })
    const r = await run([now], shown([seen]), [seen.item.id])
    expect(r.normal).toEqual([])
    expect(r.done[0]!.results[0]!.error).toBe('changed-since-confirm')
  })

  it('refuses a volume that appeared after the click', async () => {
    const seen = bundle('/ws/wt/a', 'ready', { stackIds: ['s1'], ownedVolumes: ['v1'] })
    const now = bundle('/ws/wt/a', 'ready', { stackIds: ['s1'], ownedVolumes: ['v1', 'v2'] })
    const r = await run([now], shown([seen]), [seen.item.id])
    expect(r.done[0]!.results[0]!.error).toBe('changed-since-confirm')
  })

  it('refuses a ready item that turned into a review item', async () => {
    const seen = bundle('/ws/wt/a', 'ready')
    const now = bundle('/ws/wt/a', 'review')
    const r = await run([now], shown([seen], [], [seen.item.id]), [seen.item.id])
    expect(r.normal).toEqual([])
    expect(r.forced).toEqual([])
    expect(r.done[0]!.results[0]!.error).toBe('changed-since-confirm')
  })

  it('refuses a head that moved since the click', async () => {
    const seen = bundle('/ws/wt/a', 'ready', { localTip: 'a'.repeat(40) })
    const now = bundle('/ws/wt/a', 'ready', { localTip: 'b'.repeat(40) })
    const r = await run([now], shown([seen]), [seen.item.id])
    expect(r.done[0]!.results[0]!.error).toBe('changed-since-confirm')
  })

  it('does not let one confirmed id confirm another', async () => {
    const d1 = bundle('/ws/wt/d1', 'review')
    const d2 = bundle('/ws/wt/d2', 'review')
    const r = await run([d1, d2], shown([d1, d2], [], [d1.item.id]), [d1.item.id, d2.item.id])
    const [first, second] = r.done[0]!.results
    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: false, error: 'needs-confirmation' })
    expect(r.forced).toEqual(['reprobe /ws/wt/d1', 'cleanGit /ws/wt/d1'])
  })

  it('cleans what matches what was shown, even when a size drifted', async () => {
    const a = bundle('/ws/wt/a', 'ready')
    const opts = shown([a])
    opts.expected![a.item.id]!.bytes = 1
    const r = await run([a], opts, [a.item.id])
    expect(r.done[0]!.results[0]).toMatchObject({ ok: true })
  })

  it('a confirmation for one folder cannot clean another folder with the same id', async () => {
    const shownA = bundle('/ws/wt/A', 'ready')
    const nowB = bundle('/ws/wt/B', 'ready', { item: reapItem('/ws/wt/B', { id: shownA.item.id }) })
    const r = await run([nowB], shown([shownA]), [shownA.item.id])
    expect(r.normal).toEqual([])
    expect(r.done[0]!.results[0]).toMatchObject({ ok: false, error: 'changed-since-confirm' })
  })

  it('has no blanket flag: a stray confirmDecide or confirmReview is ignored', async () => {
    const d = bundle('/ws/wt/d', 'review')
    const opts = {
      ...shown([d], [], []),
      confirmDecide: true,
      confirmReview: true
    } as GcCleanOptions
    const r = await run([d], opts, [d.item.id])
    expect(r.forced).toEqual([])
    expect(r.done[0]!.results[0]!.error).toBe('needs-confirmation')
  })
})

describe('the explicit force path for review worktrees (AC-8)', () => {
  it('runs a confirmed review worktree through the forced ops, never the normal ones', async () => {
    const d = bundle('/ws/wt/d', 'review')
    const r = rig([d])
    submitManualClean(r.deps, [d.item.id], shown([d]))
    await settle(r)
    expect(r.forced).toEqual(['reprobe /ws/wt/d', 'cleanGit /ws/wt/d'])
    expect(r.normal).toEqual([])
    expect(r.done[0]!.results[0]).toMatchObject({ ok: true })
  })

  it('keeps a ready item on the normal ops even when its id is also confirmed', async () => {
    const a = bundle('/ws/wt/a', 'ready')
    const r = rig([a])
    submitManualClean(r.deps, [a.item.id], shown([a], [], [a.item.id]))
    await settle(r)
    expect(r.normal).toEqual(['reprobe /ws/wt/a', 'cleanGit /ws/wt/a'])
    expect(r.forced).toEqual([])
  })

  it('still stops at the reprobe when a live session appeared', async () => {
    const d = bundle('/ws/wt/d', 'review')
    const r = rig([d], {
      forcedOps: { reprobe: async () => ({ ok: false, reason: 'session-open' }) }
    })
    submitManualClean(r.deps, [d.item.id], shown([d]))
    await settle(r)
    expect(r.forced).toEqual([])
    expect(r.done[0]!.results[0]).toMatchObject({
      ok: false,
      haltedAt: 'reprobe',
      error: 'session-open'
    })
  })

  it("never removes a worktree bundle's volumes, ready or reviewed (D1)", async () => {
    const ready = bundle('/ws/wt/a', 'ready', { stackIds: ['s'], ownedVolumes: ['v1'] })
    const review = bundle('/ws/wt/d', 'review', { stackIds: ['t'], ownedVolumes: ['v2'] })
    const r = rig([ready, review])
    submitManualClean(r.deps, [ready.item.id, review.item.id], shown([ready, review]))
    await settle(r)
    expect(r.done[0]!.results.map((x) => x.ok)).toEqual([true, true])
    expect([...r.normal, ...r.forced].some((l) => l.startsWith('removeVolumes'))).toBe(false)
  })
})

describe('orphan volumes are removed only by a confirmed manual action (AC-7)', () => {
  it('refuses a volume id the operator did not confirm, and runs nothing', async () => {
    const o = orphan('lost_data')
    const r = rig([], { orphans: [o] })
    submitManualClean(r.deps, [o.id], shown([], [o], []))
    await settle(r)
    expect(r.removedVolumes).toEqual([])
    expect(r.done[0]!.results[0]).toMatchObject({ ok: false, error: 'needs-confirmation' })
  })

  it('refuses a volume confirmed by another id: it needs its own entry', async () => {
    const o = orphan('lost_data')
    const d = bundle('/ws/wt/d', 'review')
    const r = rig([d], { orphans: [o] })
    submitManualClean(r.deps, [o.id], shown([d], [o], [d.item.id]))
    await settle(r)
    expect(r.removedVolumes).toEqual([])
    expect(r.done[0]!.results[0]!.error).toBe('needs-confirmation')
  })

  it('refuses a confirmed volume that has no expected facts', async () => {
    const o = orphan('lost_data')
    const r = rig([], { orphans: [o] })
    submitManualClean(r.deps, [o.id], { confirmed: [o.id], expected: {} })
    await settle(r)
    expect(r.removedVolumes).toEqual([])
    expect(r.done[0]!.results[0]!.error).toBe('missing-expected')
  })

  it('removes a volume that the fresh plan still calls an orphan, with its own confirmation', async () => {
    const o = orphan('lost_data', 9_000)
    const r = rig([], { orphans: [o] })
    submitManualClean(r.deps, [o.id], shown([], [o]))
    await settle(r)
    expect(r.removedVolumes).toEqual([['lost_data']])
    expect(r.done[0]!.results[0]).toMatchObject({ id: o.id, ok: true, freedBytes: 9_000 })
  })

  it('refuses a volume that grew since the click', async () => {
    const seen = orphan('lost_data', 9_000)
    const r = rig([], { orphans: [orphan('lost_data', 12_000)] })
    submitManualClean(r.deps, [seen.id], shown([], [seen]))
    await settle(r)
    expect(r.removedVolumes).toEqual([])
    expect(r.done[0]!.results[0]!.error).toBe('changed-since-confirm')
  })

  it('re-plans the volume right before removing it: a folder that reappeared keeps it', async () => {
    const o = orphan('lost_data')
    // The job's gather (possibly older than the click) still calls it an orphan; a gather
    // started now sees the project folder back on disk.
    const r = rig([], { orphans: [o], freshOrphans: async () => [] })
    submitManualClean(r.deps, [o.id], shown([], [o]))
    await settle(r)
    expect(r.removedVolumes).toEqual([])
    expect(r.done[0]!.results[0]).toMatchObject({ ok: false, error: 'no-longer-orphan' })
  })

  it('refuses a volume whose size changed between the gather and the removal', async () => {
    const o = orphan('lost_data', 9_000)
    const r = rig([], { orphans: [o], freshOrphans: async () => [orphan('lost_data', 20_000)] })
    submitManualClean(r.deps, [o.id], shown([], [o]))
    await settle(r)
    expect(r.removedVolumes).toEqual([])
    expect(r.done[0]!.results[0]!.error).toBe('changed-since-confirm')
  })

  it('removes nothing when the fresh look cannot be taken', async () => {
    const o = orphan('lost_data')
    const r = rig([], {
      orphans: [o],
      freshOrphans: async () => {
        throw new Error('docker did not answer')
      }
    })
    submitManualClean(r.deps, [o.id], shown([], [o]))
    await settle(r)
    expect(r.removedVolumes).toEqual([])
    expect(r.done[0]!.results[0]).toMatchObject({ ok: false })
    expect(r.done[0]!.results[0]!.error).toContain('probe-failed')
  })

  it('looks once per volume that is about to go, and not for one it already refused', async () => {
    const a = orphan('a_data')
    const b = orphan('b_data')
    let looks = 0
    const r = rig([], {
      orphans: [a, b],
      freshOrphans: async () => {
        looks++
        return [a, b]
      }
    })
    submitManualClean(r.deps, [a.id, b.id], shown([], [a, b], [a.id]))
    await settle(r)
    expect(looks).toBe(1)
    expect(r.removedVolumes).toEqual([['a_data']])
  })

  it('refuses a volume that is no longer an orphan at execution time', async () => {
    const o = orphan('lost_data')
    const r = rig([], { orphans: [] })
    submitManualClean(r.deps, [o.id], shown([], [o]))
    await settle(r)
    expect(r.removedVolumes).toEqual([])
    expect(r.done[0]!.results[0]).toMatchObject({ ok: false, error: 'no-longer-orphan' })
  })

  it('reports a docker failure as a failed rm-volumes step', async () => {
    const o = orphan('lost_data')
    const r = rig([], { orphans: [o], volumeError: 'docker volume rm: in use' })
    submitManualClean(r.deps, [o.id], shown([], [o]))
    await settle(r)
    expect(r.done[0]!.results[0]).toMatchObject({
      ok: false,
      haltedAt: 'rm-volumes',
      error: 'docker volume rm: in use'
    })
  })

  it('handles bundles and volumes in one request, in order', async () => {
    const a = bundle('/ws/wt/a', 'ready')
    const o = orphan('lost_data')
    const r = rig([a], { orphans: [o] })
    submitManualClean(r.deps, [a.item.id, o.id], shown([a], [o]))
    await settle(r)
    expect(r.done[0]!.results.map((x) => x.id)).toEqual([a.item.id, o.id])
  })
})

describe('failure bookkeeping shared with the autopilot', () => {
  it('remembers a step that failed, so the autopilot does not retry it blindly', async () => {
    const a = bundle('/ws/wt/a', 'ready')
    const r = rig([a], {
      normalOps: {
        cleanGit: async () => {
          throw new GcStepError('trash', 'trash-folder: EBUSY')
        }
      }
    })
    submitManualClean(r.deps, [a.item.id], shown([a]))
    await settle(r)
    expect(r.deps.state.failures.get(a.item.id)).toMatchObject({ step: 'trash', at: NOW })
  })

  it('forgets a failure once the same item is cleaned', async () => {
    const a = bundle('/ws/wt/a', 'ready')
    const r = rig([a])
    r.deps.state.failures.set(a.item.id, { step: 'trash', error: 'x', at: NOW })
    submitManualClean(r.deps, [a.item.id], shown([a]))
    await settle(r)
    expect(r.deps.state.failures.size).toBe(0)
  })
})

describe('retry of a failed ready item keeps the safe path', () => {
  const failed = (path: string): WorktreeBundle =>
    bundle(path, 'review', {
      reason: { code: 'cleanup-failed', detail: 'Cleanup stopped at drop-deps: ENOTEMPTY' },
      retryAs: 'ready'
    })

  it('runs the normal ops with the guards on, not the forced ones, and needs no confirmation', async () => {
    const b = failed('/ws/wt/a')
    const r = rig([b])
    submitManualClean(r.deps, [b.item.id], shown([b], [], []))
    await settle(r)
    expect(r.forced).toEqual([])
    expect(r.normal).toContain('cleanGit /ws/wt/a')
    expect(r.done[0]!.results[0]).toMatchObject({ ok: true })
  })

  it('hands the executor a ready bundle, since the pipeline only runs ready or confirmed ones', async () => {
    const b = failed('/ws/wt/a')
    const seen: string[] = []
    const r = rig([b], {
      normalOps: {
        reprobe: async (x) => {
          seen.push(x.bucket)
          return { ok: true }
        }
      }
    })
    submitManualClean(r.deps, [b.item.id], shown([b], [], []))
    await settle(r)
    expect(seen).toEqual(['ready'])
  })

  it('still refuses a plain cleanup-failed review item that was never ready', async () => {
    const b = bundle('/ws/wt/a', 'review', {
      reason: { code: 'cleanup-failed', detail: 'x' }
    })
    const r = rig([b])
    submitManualClean(r.deps, [b.item.id], shown([b], [], []))
    await settle(r)
    expect(r.done[0]!.results[0]).toMatchObject({ ok: false, error: 'needs-confirmation' })
    expect(r.forced).toEqual([])
  })
})

describe('the forced path refuses work edited after the operator looked', () => {
  const dirty = (path: string, stamp: string | null): WorktreeBundle => {
    const b = bundle(path, 'review', { reason: { code: 'dirty', detail: 'x' } })
    b.item = reapItem(path, { workStamp: stamp })
    return b
  }

  it('halts with work-changed-since-confirm and runs nothing when the work stamp moved', async () => {
    const b = dirty('/ws/wt/a', 'stamp-1')
    const r = rig([b], { workStamp: async () => 'stamp-2' })
    submitManualClean(r.deps, [b.item.id], shown([b]))
    await settle(r)
    expect(r.done[0]!.results[0]).toMatchObject({
      ok: false,
      haltedAt: 'reprobe',
      error: 'work-changed-since-confirm'
    })
    expect(r.forced).toEqual([])
  })

  it('proceeds when the work is exactly what the dialog showed', async () => {
    const b = dirty('/ws/wt/a', 'stamp-1')
    const r = rig([b], { workStamp: async () => 'stamp-1' })
    submitManualClean(r.deps, [b.item.id], shown([b]))
    await settle(r)
    expect(r.done[0]!.results[0]).toMatchObject({ ok: true })
    expect(r.forced).toContain('cleanGit /ws/wt/a')
  })

  it('a worktree that was clean when shown and has uncommitted work now is refused too', async () => {
    const b = bundle('/ws/wt/a', 'review', { reason: { code: 'closed-unmerged', detail: 'x' } })
    const r = rig([b], { workStamp: async () => 'edited' })
    submitManualClean(r.deps, [b.item.id], shown([b]))
    await settle(r)
    expect(r.done[0]!.results[0]).toMatchObject({ error: 'work-changed-since-confirm' })
  })

  it('a probe that cannot read the work refuses (fail closed)', async () => {
    const b = dirty('/ws/wt/a', 'stamp-1')
    const r = rig([b], {
      workStamp: async () => {
        throw new Error('git exploded')
      }
    })
    submitManualClean(r.deps, [b.item.id], shown([b]))
    await settle(r)
    expect(r.done[0]!.results[0]!.error).toContain('probe-failed')
    expect(r.forced).toEqual([])
  })

  it('the stamp travels in the facts the dialog sends, through a real structuredClone', () => {
    const b = dirty('/ws/wt/a', 'stamp-1')
    expect(structuredClone(expectedOf(b)).workStamp).toBe('stamp-1')
  })
})

describe('an edit made WHILE the clean runs halts it too', () => {
  const dirty = (stackIds: string[] = []): WorktreeBundle => {
    const b = bundle('/ws/wt/a', 'review', { reason: { code: 'dirty', detail: 'x' }, stackIds })
    b.item = reapItem('/ws/wt/a', { workStamp: 'stamp-1' })
    return b
  }

  it('an edit while the stacks stop halts before any dependency is dropped', async () => {
    const b = dirty(['s1'])
    let stamp = 'stamp-1'
    const r = rig([b], {
      workStamp: async () => stamp,
      forcedOps: {
        stopStacks: async () => {
          stamp = 'edited-meanwhile'
        },
        dropDeps: async () => {
          r.forced.push('dropDeps')
          return 1
        }
      }
    })
    submitManualClean(r.deps, [b.item.id], shown([b]))
    await settle(r)
    expect(r.done[0]!.results[0]).toMatchObject({
      ok: false,
      haltedAt: 'drop-deps',
      error: 'work-changed-since-confirm'
    })
    expect(r.forced).not.toContain('dropDeps')
    expect(r.forced.some((l) => l.startsWith('cleanGit'))).toBe(false)
  })

  it('an edit while the dependencies are dropped halts before the checkout is trashed', async () => {
    const b = dirty()
    let stamp = 'stamp-1'
    const r = rig([b], {
      workStamp: async () => stamp,
      forcedOps: {
        dropDeps: async () => {
          stamp = 'edited-meanwhile'
          return 7
        }
      }
    })
    submitManualClean(r.deps, [b.item.id], shown([b]))
    await settle(r)
    expect(r.done[0]!.results[0]).toMatchObject({
      ok: false,
      haltedAt: 'archive',
      error: 'work-changed-since-confirm',
      freedBytes: 7
    })
    expect(r.forced.some((l) => l.startsWith('cleanGit'))).toBe(false)
  })

  it('an unchanged stamp lets the same run finish', async () => {
    const b = dirty(['s1'])
    const r = rig([b], { workStamp: async () => 'stamp-1' })
    submitManualClean(r.deps, [b.item.id], shown([b]))
    await settle(r)
    expect(r.done[0]!.results[0]).toMatchObject({ ok: true })
  })

  it('the guarded retry path does not run the work check (the guards already cover it)', async () => {
    const b = bundle('/ws/wt/a', 'review', {
      reason: { code: 'cleanup-failed', detail: 'x' },
      retryAs: 'ready'
    })
    const r = rig([b], {
      workStamp: async () => {
        throw new Error('must not be asked')
      }
    })
    submitManualClean(r.deps, [b.item.id], shown([b], [], []))
    await settle(r)
    expect(r.done[0]!.results[0]).toMatchObject({ ok: true })
  })
})

describe('a worktree whose work the scan could not read is refused with a way forward', () => {
  it('refuses with work-unreadable instead of comparing against nothing, and never probes', async () => {
    const b = bundle('/ws/wt/a', 'review', { reason: { code: 'dirty', detail: 'x' } })
    b.item = reapItem('/ws/wt/a', { workStamp: 'unknown' })
    const r = rig([b], {
      workStamp: async () => {
        throw new Error('must not matter')
      }
    })
    submitManualClean(r.deps, [b.item.id], shown([b]))
    await settle(r)
    expect(r.done[0]!.results[0]).toMatchObject({
      ok: false,
      haltedAt: 'reprobe',
      error: 'work-unreadable'
    })
    expect(r.forced).toEqual([])
  })
})
