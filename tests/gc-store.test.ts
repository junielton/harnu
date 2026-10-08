import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { bundle, NOW, reapItem } from './gc-fixtures'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type {
  GcCleanAck,
  GcJobDone,
  GcJobInfo,
  GcJobProgress,
  GcSnapshot
} from '../src/main/gc/gc-wire'
import type { Bucket, DecideReason } from '../src/main/gc/bundle-core'
import { useGcStore } from '../src/renderer/src/stores/gc'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { CHANGED_SINCE_CONFIRM } from '../src/renderer/src/lib/gc-jobs'
import { i18n } from '../src/renderer/src/i18n'

const t = (key: string, named?: Record<string, unknown>): string =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key)) as string

const MIB = 1024 ** 2

function wt(name: string, bucket: Bucket, bytes: number, reason?: DecideReason) {
  const b = bundle(`/ws/${name}`, bucket, { reason })
  b.item = reapItem(`/ws/${name}`, { diskBytes: bytes })
  return b
}

function snap(over: Partial<GcSnapshot> = {}): GcSnapshot {
  return {
    scannedAt: NOW,
    bundles: [
      wt('c1', 'corpse', 500 * MIB),
      wt('c2', 'corpse', 400 * MIB),
      wt('d1', 'decide', 900 * MIB)
    ],
    orphanVolumes: [],
    prefs: defaultGcPrefs(),
    lastCycle: null,
    nextCycleAt: null,
    ...over
  }
}

interface Api {
  push: Record<string, (p: unknown) => void>
  gcSnapshot: ReturnType<typeof vi.fn>
  gcClean: ReturnType<typeof vi.fn>
  gcKeep: ReturnType<typeof vi.fn>
  gcUnkeep: ReturnType<typeof vi.fn>
  gcJobs: ReturnType<typeof vi.fn>
  gcAckFirstReport: ReturnType<typeof vi.fn>
  gcSetPrefs: ReturnType<typeof vi.fn>
}

function installApi(first: GcSnapshot = snap(), jobs: GcJobInfo[] = []): Api {
  const push: Api['push'] = {}
  const sub =
    (name: string) =>
    (cb: (p: unknown) => void): (() => void) => {
      push[name] = cb
      return () => delete push[name]
    }
  const api: Api = {
    push,
    gcSnapshot: vi.fn(async () => first),
    gcClean: vi.fn(async (): Promise<GcCleanAck> => ({ jobId: 'j1', queued: false })),
    gcKeep: vi.fn(async () => defaultGcPrefs()),
    gcUnkeep: vi.fn(async () => defaultGcPrefs()),
    gcJobs: vi.fn(async () => jobs),
    gcAckFirstReport: vi.fn(async () => ({ ...defaultGcPrefs(), firstReportAcknowledged: true })),
    gcSetPrefs: vi.fn(async (p: unknown) => p)
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      ...api,
      onGcProgress: sub('progress'),
      onGcDone: sub('done'),
      onGcCycle: sub('cycle')
    }
  }
  ;(globalThis as unknown as { document: unknown }).document = { hasFocus: () => true }
  return api
}

const progress = (over: Partial<GcJobProgress> = {}): GcJobProgress => ({
  jobId: 'j1',
  done: 0,
  total: 2,
  freedBytes: 0,
  current: null,
  results: [],
  ...over
})
const done = (over: Partial<GcJobDone> = {}): GcJobDone => ({
  jobId: 'j1',
  kind: 'manual',
  done: 2,
  total: 2,
  freedBytes: 900 * MIB,
  results: [],
  error: null,
  ...over
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('gc store', () => {
  it('loads the snapshot and derives the model, hero and summary', async () => {
    installApi()
    const gc = useGcStore()
    await gc.init()
    expect(gc.model?.totals.corpse.count).toBe(2)
    expect(gc.hero).toMatchObject({ kind: 'clean', count: 2, bytes: 900 * MIB })
    expect(gc.pill).toEqual({ kind: 'idle' }) // 'needs you' is for failures, not for the whole Decide list
    expect(gc.reclaimableBytes).toBe(1800 * MIB)
  })

  it('cleaning the corpses sends ids + expected facts and no confirmed list', async () => {
    const api = installApi()
    const gc = useGcStore()
    await gc.init()
    const ids = gc.model!.corpses.map((b) => b.id)
    const ack = await gc.cleanCorpses()
    expect(ack?.jobId).toBe('j1')
    const [sentIds, opts] = api.gcClean.mock.calls[0]
    expect(sentIds).toEqual(ids)
    expect(opts.confirmed).toBeUndefined()
    expect(Object.keys(opts.expected)).toEqual(ids)
    expect('confirmDecide' in opts).toBe(false)
  })

  it('removing Decide items confirms each id explicitly', async () => {
    const api = installApi()
    const gc = useGcStore()
    await gc.init()
    const d1 = gc.model!.needsYou[0].id
    await gc.cleanSelected([d1])
    const [sentIds, opts] = api.gcClean.mock.calls[0]
    expect(sentIds).toEqual([d1])
    expect(opts.confirmed).toEqual([d1])
    expect(opts.expected[d1].reasonCode).toBe('dirty')
  })

  it('does not call the engine when nothing valid is left to clean', async () => {
    const api = installApi()
    const gc = useGcStore()
    await gc.init()
    expect(await gc.cleanSelected(['ghost'])).toBeNull()
    expect(api.gcClean).not.toHaveBeenCalled()
  })

  it('the chip follows gc:progress and re-attaches from gc:jobs', async () => {
    const running: GcJobInfo = {
      jobId: 'j9',
      kind: 'manual',
      state: 'running',
      done: 3,
      total: 12,
      freedBytes: 1397 * MIB,
      current: null,
      results: [],
      error: null
    }
    const api = installApi(snap(), [running])
    const gc = useGcStore()
    await gc.init()
    expect(gc.hero).toEqual({ kind: 'running', done: 3, total: 12, freedBytes: 1397 * MIB })
    api.push.progress(progress({ jobId: 'j9', done: 4, total: 12, freedBytes: 1500 * MIB }))
    expect(gc.hero).toMatchObject({ done: 4 })
    expect(gc.pill).toEqual({ kind: 'running', done: 4, total: 12 })
  })

  it('a cleaned block fades, then is dropped and the map re-flows — without waiting for done', async () => {
    const api = installApi()
    const gc = useGcStore()
    await gc.init()
    const c1 = gc.model!.corpses[0].id
    api.push.progress(
      progress({
        done: 1,
        current: gc.model!.corpses[1].id,
        results: [{ id: c1, ok: true, haltedAt: null, freedBytes: 500 * MIB }]
      })
    )
    expect(gc.blockState(c1)).toBe('done')
    expect(gc.model!.byId.has(c1)).toBe(true) // still drawn, faded
    vi.advanceTimersByTime(300)
    expect(gc.model!.byId.has(c1)).toBe(false) // gone, layout recomputed
    expect(gc.model!.totals.corpse.count).toBe(1)
  })

  it('done refreshes the snapshot, toasts success, and clears the transient state', async () => {
    const api = installApi()
    const gc = useGcStore()
    const ui = useUiStore()
    const toast = vi.spyOn(ui, 'pushToast')
    await gc.init()
    const after = snap({ bundles: [wt('d1', 'decide', 900 * MIB)] })
    api.gcSnapshot.mockResolvedValueOnce(after)
    api.push.done(
      done({
        results: [
          { id: 'a', ok: true, haltedAt: null, freedBytes: 500 * MIB },
          { id: 'b', ok: true, haltedAt: null, freedBytes: 400 * MIB }
        ]
      })
    )
    await vi.runAllTimersAsync()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][0]).toMatchObject({ kind: 'success' })
    expect(gc.hero.kind).toBe('empty')
    expect(gc.pill).toEqual({ kind: 'idle' })
  })

  it('a partial failure toasts a warning and the failed item is back in Decide with what ran', async () => {
    const api = installApi()
    const gc = useGcStore()
    const ui = useUiStore()
    const toast = vi.spyOn(ui, 'pushToast')
    await gc.init()
    const failed = gc.model!.corpses[0].id
    const reason: DecideReason = {
      code: 'cleanup-failed',
      detail: 'Cleanup stopped at step rm-volumes.'
    }
    const failedBundle = wt('c1', 'decide', 500 * MIB, reason)
    failedBundle.item.id = failed
    api.gcSnapshot.mockResolvedValueOnce(
      snap({ bundles: [failedBundle, wt('d1', 'decide', 900 * MIB)] })
    )
    api.push.done(
      done({
        done: 1,
        results: [
          { id: 'ok', ok: true, haltedAt: null, freedBytes: 400 * MIB },
          { id: failed, ok: false, haltedAt: 'rm-volumes', error: 'volume in use', freedBytes: 0 }
        ]
      })
    )
    await vi.runAllTimersAsync()
    expect(toast.mock.calls[0][0]).toMatchObject({ kind: 'warning' })
    expect(gc.failureOf(failed)).toMatchObject({ step: 'rm-volumes', error: 'volume in use' })
    expect(gc.blockState(failed)).toBe('failed')
    expect(gc.pill).toEqual({ kind: 'attention', count: 1 })
  })

  it('surfaces a changed-since-confirm refusal in the toast description', async () => {
    const api = installApi()
    const gc = useGcStore()
    const ui = useUiStore()
    const toast = vi.spyOn(ui, 'pushToast')
    await gc.init()
    api.push.done(
      done({
        done: 0,
        total: 1,
        results: [
          { id: 'x', ok: false, haltedAt: 'reprobe', error: CHANGED_SINCE_CONFIRM, freedBytes: 0 }
        ]
      })
    )
    await vi.runAllTimersAsync()
    expect(toast.mock.calls[0][0].description).toBeTruthy()
    expect(gc.failureOf('x')?.refusal).toBe('changed-since-confirm')
    expect(toast.mock.calls[0][0].description).toBe(t('cleanup.gc.refusal.changedSinceConfirm'))
  })

  it('names the refusal in the toast when every refused item has the same reason', async () => {
    const api = installApi()
    const gc = useGcStore()
    const ui = useUiStore()
    const toast = vi.spyOn(ui, 'pushToast')
    await gc.init()
    api.push.done(
      done({
        done: 0,
        total: 2,
        results: [
          { id: 'a', ok: false, haltedAt: 'reprobe', error: 'kept', freedBytes: 0 },
          { id: 'b', ok: false, haltedAt: 'reprobe', error: 'kept', freedBytes: 0 }
        ]
      })
    )
    await vi.runAllTimersAsync()
    expect(toast.mock.calls[0][0].description).toBe(t('cleanup.gc.refusal.kept'))
  })

  it('says how many were refused when the reasons differ', async () => {
    const api = installApi()
    const gc = useGcStore()
    const ui = useUiStore()
    const toast = vi.spyOn(ui, 'pushToast')
    await gc.init()
    api.push.done(
      done({
        done: 0,
        total: 2,
        results: [
          { id: 'a', ok: false, haltedAt: 'reprobe', error: 'kept', freedBytes: 0 },
          { id: 'b', ok: false, haltedAt: 'reprobe', error: 'alive', freedBytes: 0 }
        ]
      })
    )
    await vi.runAllTimersAsync()
    expect(toast.mock.calls[0][0].description).toBe(t('cleanup.gc.refusal.several', { n: 2 }))
  })

  it('an autopilot job drives the chip but raises no renderer toast (main notifies)', async () => {
    const api = installApi()
    const gc = useGcStore()
    const ui = useUiStore()
    const toast = vi.spyOn(ui, 'pushToast')
    await gc.init()
    api.push.done(
      done({ kind: 'autopilot', results: [{ id: 'a', ok: true, haltedAt: null, freedBytes: 1 }] })
    )
    await vi.runAllTimersAsync()
    expect(toast).not.toHaveBeenCalled()
  })

  it("a new clean forgets the previous run's failures", async () => {
    const api = installApi()
    const gc = useGcStore()
    await gc.init()
    api.push.done(
      done({ results: [{ id: 'x', ok: false, haltedAt: 'trash', error: 'e', freedBytes: 0 }] })
    )
    await vi.runAllTimersAsync()
    expect(gc.failureOf('x')).not.toBeNull()
    await gc.cleanCorpses()
    expect(gc.failureOf('x')).toBeNull()
  })

  it('enabling autopilot acknowledges the first report AND turns the pref on', async () => {
    const api = installApi()
    const gc = useGcStore()
    await gc.init()
    await gc.enableAutopilot()
    expect(api.gcAckFirstReport).toHaveBeenCalledTimes(1)
    const sent = api.gcSetPrefs.mock.calls[0][0]
    expect(sent.autopilot).toBe(true)
    // whole prefs object: main normalizes missing fields to defaults, so a partial would reset them
    expect(Object.keys(sent)).toEqual(Object.keys(defaultGcPrefs()))
  })

  it('keep and unkeep call the engine and refresh', async () => {
    const api = installApi()
    const gc = useGcStore()
    await gc.init()
    await gc.keep('id-1')
    await gc.unkeep('id-1')
    expect(api.gcKeep).toHaveBeenCalledWith('id-1')
    expect(api.gcUnkeep).toHaveBeenCalledWith('id-1')
    expect(api.gcSnapshot.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('keepMany keeps every id and refreshes once at the end', async () => {
    const api = installApi()
    const gc = useGcStore()
    await gc.init()
    const before = api.gcSnapshot.mock.calls.length
    await gc.keepMany(['a', 'b', 'c'])
    expect(api.gcKeep.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c'])
    expect(api.gcSnapshot.mock.calls.length).toBe(before + 1)
  })

  it('init is idempotent: one set of subscriptions', async () => {
    const api = installApi()
    const gc = useGcStore()
    await gc.init()
    await gc.init()
    expect(Object.keys(api.push).sort()).toEqual(['cycle', 'done', 'progress'])
  })
})
