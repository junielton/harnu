// A ready item that main refuses at the reprobe used to stay in the hero forever: every click ended in
// "0 cleaned", and the autopilot spent its per-cycle cap on it every hour. A refusal is now remembered
// (with a TTL), so the item leaves the hero showing the reason, the autopilot skips it, and after
// REFUSAL_DEMOTE_AFTER identical refusals it is demoted to Needs review with that reason.

import { describe, expect, it } from 'vitest'
import {
  applyFailures,
  planCycle,
  pruneFailures,
  rememberReprobeRefusal,
  REFUSAL_DEMOTE_AFTER,
  REFUSAL_TTL_MS,
  type CycleFailure
} from '../src/main/gc/autopilot-core'
import {
  createCycleState,
  runGcCycle,
  withFailures,
  type GcCycleDeps
} from '../src/main/gc/gc-cycle'
import { submitManualClean, type ManualCleanDeps } from '../src/main/gc/gc-manual'
import { expectedOf } from '../src/main/gc/gc-confirm'
import { createJobQueue } from '../src/main/gc/gc-jobs-core'
import { defaultGcPrefs, type GcPrefs } from '../src/main/gc/gc-prefs'
import type { GcOps, GcItemResult } from '../src/main/gc/pipeline-core'
import type { WorktreeBundle } from '../src/main/gc/bundle-core'
import { bundle, DAY, NOW, reapItem } from './gc-fixtures'

const prefs = (over: Partial<GcPrefs> = {}): GcPrefs => ({
  ...defaultGcPrefs(),
  autopilot: true,
  firstReportAcknowledged: true,
  ...over
})

const ready = (name: string, daysAgo = 5): WorktreeBundle =>
  bundle(`/ws/wt/${name}`, 'ready', {
    lastSignOfLifeAt: NOW - daysAgo * DAY,
    item: reapItem(`/ws/wt/${name}`, { diskBytes: 1_000_000 })
  })

const refusedAtReprobe = (id: string, error: string): GcItemResult => ({
  id,
  ok: false,
  haltedAt: 'reprobe',
  error,
  freedBytes: 0
})

describe('rememberReprobeRefusal', () => {
  it('records a refusal that describes the item, counting identical ones', () => {
    const f = new Map<string, CycleFailure>()
    const r = refusedAtReprobe('a', 'cannot-unregister')
    expect(rememberReprobeRefusal(f, r, NOW)).toBe(true)
    expect(f.get('a')).toMatchObject({ step: 'reprobe', error: 'cannot-unregister', count: 1 })
    rememberReprobeRefusal(f, r, NOW + 1000)
    expect(f.get('a')).toMatchObject({ count: 2, at: NOW + 1000 })
  })

  it('starts the count over when the reason changes', () => {
    const f = new Map<string, CycleFailure>()
    rememberReprobeRefusal(f, refusedAtReprobe('a', 'cannot-unregister'), NOW)
    rememberReprobeRefusal(f, refusedAtReprobe('a', 'cannot-unregister'), NOW)
    rememberReprobeRefusal(f, refusedAtReprobe('a', 'tip-unknown'), NOW)
    expect(f.get('a')).toMatchObject({ error: 'tip-unknown', count: 1 })
  })

  it('compares the code only: the engine text after a colon does not make two refusals differ', () => {
    const f = new Map<string, CycleFailure>()
    rememberReprobeRefusal(f, refusedAtReprobe('a', 'cannot-unregister: no match'), NOW)
    rememberReprobeRefusal(f, refusedAtReprobe('a', 'cannot-unregister: two matches'), NOW)
    expect(f.get('a')).toMatchObject({ count: 2 })
  })

  it.each([
    'docker-unavailable',
    'probe-failed: ENOENT git',
    'changed-since-scan',
    'changed-since-confirm',
    'needs-confirmation',
    'missing-expected',
    'unknown-item',
    'session-open',
    'dirty',
    'main-checkout'
  ])('does not record %s: it is the moment or the click, not the item', (error) => {
    const f = new Map<string, CycleFailure>()
    expect(rememberReprobeRefusal(f, refusedAtReprobe('a', error), NOW)).toBe(false)
    expect(f.size).toBe(0)
  })

  it('ignores a success and a halt after the reprobe', () => {
    const f = new Map<string, CycleFailure>()
    rememberReprobeRefusal(f, { id: 'a', ok: true, haltedAt: null, freedBytes: 1 }, NOW)
    rememberReprobeRefusal(
      f,
      { id: 'a', ok: false, haltedAt: 'drop-deps', error: 'cannot-unregister', freedBytes: 0 },
      NOW
    )
    expect(f.size).toBe(0)
  })
})

describe('applyFailures: a remembered refusal', () => {
  const failure = (count: number): CycleFailure => ({
    step: 'reprobe',
    error: 'cannot-unregister',
    at: NOW,
    count
  })

  it('keeps the item ready but marks it, so the hero and the autopilot can leave it out', () => {
    const a = ready('a')
    const [out] = applyFailures([a], new Map([[a.item.id, failure(1)]]))
    expect(out.bucket).toBe('ready')
    expect(out.reprobeRefusal).toEqual({ code: 'cannot-unregister', count: 1 })
  })

  it('demotes it to Needs review with that reason after identical refusals', () => {
    const a = ready('a')
    const [out] = applyFailures([a], new Map([[a.item.id, failure(REFUSAL_DEMOTE_AFTER)]]))
    expect(out.bucket).toBe('review')
    expect(out.reason).toMatchObject({ code: 'cleanup-failed' })
    expect(out.reason?.detail).toContain('cannot-unregister')
    expect(out.reprobeRefusal).toEqual({ code: 'cannot-unregister', count: REFUSAL_DEMOTE_AFTER })
  })

  it('leaves a halt after the reprobe as it was: an immediate cleanup-failed decision', () => {
    const a = ready('a')
    const [out] = applyFailures(
      [a],
      new Map([[a.item.id, { step: 'trash', error: 'EBUSY', at: NOW }]])
    )
    expect(out.bucket).toBe('review')
    expect(out.reprobeRefusal).toBeUndefined()
  })
})

describe('pruneFailures: a remembered refusal', () => {
  it('lapses after its own, shorter TTL', () => {
    const a = ready('a')
    const f = new Map<string, CycleFailure>([
      [a.item.id, { step: 'reprobe', error: 'tip-unknown', at: NOW - REFUSAL_TTL_MS - 1, count: 1 }]
    ])
    pruneFailures(f, [a], NOW)
    expect(f.size).toBe(0)
  })

  it('is forgotten once a scan no longer calls the item ready (the scan owns that fact now)', () => {
    const a = ready('a')
    const review = { ...a, bucket: 'review' as const }
    const f = new Map<string, CycleFailure>([
      [a.item.id, { step: 'reprobe', error: 'tip-unknown', at: NOW, count: 1 }]
    ])
    pruneFailures(f, [review], NOW)
    expect(f.size).toBe(0)
  })

  it('is forgotten when the tip moved: it was refused for the commit it had then', () => {
    const a = ready('a')
    const f = new Map<string, CycleFailure>([
      [a.item.id, { step: 'reprobe', error: 'tip-unknown', at: NOW, count: 1, tip: 'b'.repeat(40) }]
    ])
    pruneFailures(f, [a], NOW)
    expect(f.size).toBe(0)
  })
})

describe('the autopilot skips a refused item', () => {
  it('plans only the items that were not refused', () => {
    const a = ready('a', 9)
    const b = ready('b', 5)
    const [marked, plain] = applyFailures(
      [a, b],
      new Map([[a.item.id, { step: 'reprobe', error: 'tip-unknown', at: NOW, count: 1 }]])
    )
    const plan = planCycle([marked, plain], prefs())
    expect(plan.toClean.map((x) => x.item.path)).toEqual(['/ws/wt/b'])
    expect(plan.found).toBe(1)
  })
})

describe('the cycle remembers what the reprobe refused', () => {
  function cycleRig(bundles: WorktreeBundle[], reprobe: GcOps['reprobe']) {
    const reprobed: string[] = []
    const ops: GcOps = {
      reprobe: async (b) => {
        reprobed.push(b.item.path ?? '')
        return reprobe(b)
      },
      stopStacks: async () => undefined,
      removeContainers: async () => undefined,
      removeVolumes: async () => undefined,
      dropDeps: async () => 0,
      recheck: async () => ({ ok: true }),
      cleanGit: async () => undefined
    }
    let n = 0
    const state = createCycleState()
    const deps: GcCycleDeps = {
      prefs: () => prefs({ maxItemsPerCycle: 1 }),
      gather: async () => ({
        bundles: structuredClone(bundles),
        housekeeping: {
          volumes: [],
          containers: [],
          dirExists: () => true,
          knownFolders: [],
          protectedProjects: new Set()
        }
      }),
      opsFor: () => ops,
      queue: createJobQueue({
        newId: () => `job-${++n}`,
        emitProgress: () => undefined,
        emitDone: () => undefined
      }),
      housekeeping: async () => ({ buildCacheBytes: 0, imageBytes: 0, volumeBytes: 0, errors: [] }),
      notify: () => undefined,
      emitCycle: () => undefined,
      state,
      now: () => NOW
    }
    return { deps, state, reprobed }
  }

  it('spends the cap on it once, then moves on to the next item', async () => {
    const stuck = ready('stuck', 9) // the oldest, so it is first in line every cycle
    const fine = ready('fine', 5)
    const r = cycleRig([stuck, fine], async (b) =>
      b.item.path === '/ws/wt/stuck' ? { ok: false, reason: 'cannot-unregister' } : { ok: true }
    )
    await runGcCycle(r.deps, 'timer')
    expect(r.reprobed).toEqual(['/ws/wt/stuck'])
    expect(r.state.failures.get(stuck.item.id)).toMatchObject({ step: 'reprobe', count: 1 })

    await runGcCycle(r.deps, 'timer')
    expect(r.reprobed).toEqual(['/ws/wt/stuck', '/ws/wt/fine'])
  })

  it('forgets a refusal for an item that cleaned', async () => {
    const a = ready('a')
    let refuse = true
    const r = cycleRig([a], async () =>
      refuse ? { ok: false, reason: 'cannot-unregister' } : { ok: true }
    )
    await runGcCycle(r.deps, 'timer')
    expect(r.state.failures.size).toBe(1)
    refuse = false
    r.state.failures.clear() // the TTL elapsed
    await runGcCycle(r.deps, 'timer')
    expect(r.state.failures.size).toBe(0)
  })

  it('withFailures shows the same marked bundle to every consumer', async () => {
    const a = ready('a')
    const state = createCycleState()
    state.failures.set(a.item.id, { step: 'reprobe', error: 'tip-unknown', at: NOW, count: 1 })
    const once = withFailures({ bundles: [a], housekeeping: {} as never }, state, NOW)
    const twice = withFailures(once, state, NOW)
    expect(twice.bundles[0].reprobeRefusal).toEqual({ code: 'tip-unknown', count: 1 })
    expect(twice.bundles[0].bucket).toBe('ready')
  })
})

describe('a manual clean remembers what the reprobe refused', () => {
  it('records the refusal so the item leaves the hero, and keeps the real reason', async () => {
    const a = ready('a')
    const state = createCycleState()
    let n = 0
    const done: GcItemResult[][] = []
    const ops: GcOps = {
      reprobe: async () => ({ ok: false, reason: 'cannot-unregister' }),
      stopStacks: async () => undefined,
      removeContainers: async () => undefined,
      removeVolumes: async () => undefined,
      dropDeps: async () => 0,
      recheck: async () => ({ ok: true }),
      cleanGit: async () => undefined
    }
    const deps: ManualCleanDeps = {
      prefs: () => defaultGcPrefs(),
      gather: async () => ({ bundles: structuredClone([a]), orphanVolumes: [] }),
      opsFor: () => ops,
      freshOrphans: async () => [],
      removeOrphanVolumes: async () => ({
        buildCacheBytes: 0,
        imageBytes: 0,
        volumeBytes: 0,
        errors: []
      }),
      queue: createJobQueue({
        newId: () => `job-${++n}`,
        emitProgress: () => undefined,
        emitDone: (d) => done.push(d.results)
      }),
      state,
      now: () => NOW
    }
    submitManualClean(deps, [a.item.id], { expected: { [a.item.id]: expectedOf(a) } })
    await deps.queue.idle()
    expect(done[0][0]).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'cannot-unregister' })
    expect(state.failures.get(a.item.id)).toMatchObject({
      step: 'reprobe',
      error: 'cannot-unregister',
      count: 1
    })
  })

  it('does not record the click-time refusals (a stale confirm, a missing confirmation)', async () => {
    const a = ready('a')
    const state = createCycleState()
    let n = 0
    const deps: ManualCleanDeps = {
      prefs: () => defaultGcPrefs(),
      gather: async () => ({ bundles: structuredClone([a]), orphanVolumes: [] }),
      opsFor: () => {
        throw new Error('no ops should be built')
      },
      freshOrphans: async () => [],
      removeOrphanVolumes: async () => ({
        buildCacheBytes: 0,
        imageBytes: 0,
        volumeBytes: 0,
        errors: []
      }),
      queue: createJobQueue({
        newId: () => `job-${++n}`,
        emitProgress: () => undefined,
        emitDone: () => undefined
      }),
      state,
      now: () => NOW
    }
    submitManualClean(deps, [a.item.id], { expected: {} }) // missing-expected
    await deps.queue.idle()
    expect(state.failures.size).toBe(0)
  })
})
