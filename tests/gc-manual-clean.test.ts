import { describe, it, expect, vi } from 'vitest'
import { submitManualClean, type ManualCleanDeps } from '../src/main/gc/gc-manual'
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

const idOf = (path: string): string => reapItem(path).id
const settle = (r: Rig): Promise<void> => r.deps.queue.idle()

describe('gc:clean is a background job (AC-4)', () => {
  it('acknowledges before the batch runs', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const r = rig([bundle('/ws/wt/a', 'corpse')], { gatherGate: gate })
    const ack = submitManualClean(r.deps, [idOf('/ws/wt/a')], {})
    expect(ack).toEqual({ jobId: 'job-1', queued: false })
    expect(r.normal).toEqual([])
    release()
    await settle(r)
    expect(r.normal).toEqual(['reprobe /ws/wt/a', 'cleanGit /ws/wt/a'])
  })

  it('streams one progress event per requested id, then one done', async () => {
    const r = rig([bundle('/ws/wt/a', 'corpse'), bundle('/ws/wt/b', 'corpse')])
    submitManualClean(r.deps, [idOf('/ws/wt/a'), idOf('/ws/wt/b')], {})
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
    const r = rig([bundle('/ws/wt/a', 'corpse'), bundle('/ws/wt/b', 'corpse')], {
      gatherGate: gate
    })
    const first = submitManualClean(r.deps, [idOf('/ws/wt/a')], {})
    const second = submitManualClean(r.deps, [idOf('/ws/wt/b')], {})
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
    const r = rig([bundle('/ws/wt/a', 'corpse')])
    submitManualClean(r.deps, [idOf('/ws/wt/a'), idOf('/ws/wt/a')], {})
    await settle(r)
    expect(r.normal.filter((l) => l.startsWith('cleanGit'))).toHaveLength(1)
  })
})

describe('refusals leave a result and call no op (AC-8)', () => {
  async function refused(b: WorktreeBundle, over: Parameters<typeof rig>[1] = {}, opts = {}) {
    const r = rig([b], over)
    submitManualClean(r.deps, [b.item.id], opts)
    await settle(r)
    expect(r.normal).toEqual([])
    expect(r.forced).toEqual([])
    return r.done[0]!.results[0]!
  }

  it('refuses a Decide worktree without confirmDecide', async () => {
    const res = await refused(bundle('/ws/wt/d', 'decide'))
    expect(res).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'needs-confirmation' })
  })

  it('refuses an Alive worktree even when confirmed', async () => {
    const res = await refused(bundle('/ws/wt/l', 'alive'), {}, { confirmDecide: true })
    expect(res.error).toBe('alive')
  })

  it('refuses a main checkout even when confirmed', async () => {
    const res = await refused(
      bundle('/ws/wt/m', 'decide', { isMainCheckout: true }),
      {},
      { confirmDecide: true }
    )
    expect(res.error).toBe('main-checkout')
  })

  it('refuses a path added to neverClean after the snapshot was taken', async () => {
    const res = await refused(
      bundle('/ws/wt/a', 'corpse'),
      { prefs: prefs({ neverClean: ['/ws/wt/a'] }) },
      { confirmDecide: true }
    )
    expect(res.error).toBe('never-clean')
  })

  it('reports an id that is no longer known', async () => {
    const r = rig([])
    submitManualClean(r.deps, ['gone'], {})
    await settle(r)
    expect(r.done[0]!.results[0]).toMatchObject({ id: 'gone', ok: false, error: 'unknown-item' })
  })

  it('still emits progress for a refused item', async () => {
    const r = rig([bundle('/ws/wt/d', 'decide')])
    submitManualClean(r.deps, [idOf('/ws/wt/d')], {})
    await settle(r)
    expect(r.progress).toHaveLength(1)
  })
})

describe('the explicit force path for Decide worktrees (AC-8)', () => {
  it('runs a confirmed Decide worktree through the forced ops, never the normal ones', async () => {
    const r = rig([bundle('/ws/wt/d', 'decide')])
    submitManualClean(r.deps, [idOf('/ws/wt/d')], { confirmDecide: true })
    await settle(r)
    expect(r.forced).toEqual(['reprobe /ws/wt/d', 'cleanGit /ws/wt/d'])
    expect(r.normal).toEqual([])
    expect(r.done[0]!.results[0]).toMatchObject({ ok: true })
  })

  it('keeps a corpse on the normal ops even with confirmDecide set', async () => {
    const r = rig([bundle('/ws/wt/a', 'corpse')])
    submitManualClean(r.deps, [idOf('/ws/wt/a')], { confirmDecide: true })
    await settle(r)
    expect(r.normal).toEqual(['reprobe /ws/wt/a', 'cleanGit /ws/wt/a'])
    expect(r.forced).toEqual([])
  })

  it('still stops at the reprobe when a live session appeared', async () => {
    const r = rig([bundle('/ws/wt/d', 'decide')], {
      forcedOps: { reprobe: async () => ({ ok: false, reason: 'session-open' }) }
    })
    submitManualClean(r.deps, [idOf('/ws/wt/d')], { confirmDecide: true })
    await settle(r)
    expect(r.forced).toEqual([])
    expect(r.done[0]!.results[0]).toMatchObject({
      ok: false,
      haltedAt: 'reprobe',
      error: 'session-open'
    })
  })

  it('honors the removeVolumes pref for owned volumes', async () => {
    const b = bundle('/ws/wt/a', 'corpse', { stackIds: ['s'], ownedVolumes: ['v1'] })
    const on = rig([b])
    submitManualClean(on.deps, [b.item.id], {})
    await settle(on)
    expect(on.normal).toContain('removeVolumes v1')

    const off = rig([b], { prefs: prefs({ removeVolumes: false }) })
    submitManualClean(off.deps, [b.item.id], {})
    await settle(off)
    expect(off.normal.some((l) => l.startsWith('removeVolumes'))).toBe(false)
  })
})

describe('orphan volumes are removed only by a confirmed manual action (AC-7)', () => {
  it('refuses a volume id without confirmDecide, and runs nothing', async () => {
    const r = rig([], { orphans: [orphan('lost_data')] })
    submitManualClean(r.deps, ['volume:lost_data'], {})
    await settle(r)
    expect(r.removedVolumes).toEqual([])
    expect(r.done[0]!.results[0]).toMatchObject({ ok: false, error: 'needs-confirmation' })
  })

  it('removes a volume that the fresh plan still calls an orphan, with confirmDecide', async () => {
    const r = rig([], { orphans: [orphan('lost_data', 9_000)] })
    submitManualClean(r.deps, ['volume:lost_data'], { confirmDecide: true })
    await settle(r)
    expect(r.removedVolumes).toEqual([['lost_data']])
    expect(r.done[0]!.results[0]).toMatchObject({
      id: 'volume:lost_data',
      ok: true,
      freedBytes: 9_000
    })
  })

  it('refuses a volume that is no longer an orphan at execution time', async () => {
    const r = rig([], { orphans: [] })
    submitManualClean(r.deps, ['volume:lost_data'], { confirmDecide: true })
    await settle(r)
    expect(r.removedVolumes).toEqual([])
    expect(r.done[0]!.results[0]).toMatchObject({ ok: false, error: 'no-longer-orphan' })
  })

  it('reports a docker failure as a failed rm-volumes step', async () => {
    const r = rig([], { orphans: [orphan('lost_data')], volumeError: 'docker volume rm: in use' })
    submitManualClean(r.deps, ['volume:lost_data'], { confirmDecide: true })
    await settle(r)
    expect(r.done[0]!.results[0]).toMatchObject({
      ok: false,
      haltedAt: 'rm-volumes',
      error: 'docker volume rm: in use'
    })
  })

  it('handles bundles and volumes in one request, in order', async () => {
    const r = rig([bundle('/ws/wt/a', 'corpse')], { orphans: [orphan('lost_data')] })
    submitManualClean(r.deps, [idOf('/ws/wt/a'), 'volume:lost_data'], { confirmDecide: true })
    await settle(r)
    expect(r.done[0]!.results.map((x) => x.id)).toEqual([idOf('/ws/wt/a'), 'volume:lost_data'])
  })
})

describe('failure bookkeeping shared with the autopilot', () => {
  it('remembers a step that failed, so the autopilot does not retry it blindly', async () => {
    const r = rig([bundle('/ws/wt/a', 'corpse')], {
      normalOps: {
        cleanGit: async () => {
          throw new GcStepError('trash', 'trash-folder: EBUSY')
        }
      }
    })
    submitManualClean(r.deps, [idOf('/ws/wt/a')], {})
    await settle(r)
    expect(r.deps.state.failures.get(idOf('/ws/wt/a'))).toMatchObject({ step: 'trash', at: NOW })
  })

  it('forgets a failure once the same item is cleaned', async () => {
    const r = rig([bundle('/ws/wt/a', 'corpse')])
    r.deps.state.failures.set(idOf('/ws/wt/a'), { step: 'trash', error: 'x', at: NOW })
    submitManualClean(r.deps, [idOf('/ws/wt/a')], {})
    await settle(r)
    expect(r.deps.state.failures.size).toBe(0)
  })
})
