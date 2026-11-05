// U3.6 AC-2/AC-5: the capacity watcher's push reaches Activity (and the remote push) exactly once per
// notice, and the report-only list the pane shows comes from the newest report-mode record.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defaultGcPrefs, withDockerAcknowledged } from '../src/main/gc/gc-prefs'
import type { CycleRecord, DockerWatchRecord, GcSnapshot } from '../src/main/gc/gc-wire'
import { useGcStore } from '../src/renderer/src/stores/gc'
import { useNotificationsStore } from '../src/renderer/src/stores/notifications'
import { i18n } from '../src/renderer/src/i18n'
import { NOW } from './gc-fixtures'

const t = (key: string, named?: Record<string, unknown>): string =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key)) as string

const watch = (over: Partial<DockerWatchRecord> = {}): DockerWatchRecord => ({
  at: NOW,
  trigger: 'event',
  mode: 'act',
  mark: 3,
  capacity: { known: true, total: 31, used: 28, free: 3, source: 'default' },
  pressure: true,
  found: 0,
  acted: 0,
  refused: 0,
  failed: 0,
  deferred: 0,
  locked: false,
  paused: false,
  pausedReason: null,
  nothingLeft: true,
  items: [],
  notice: null,
  ...over
})

function install(snapshot: Partial<GcSnapshot> = {}): {
  push: Record<string, (p: unknown) => void>
  pushSend: ReturnType<typeof vi.fn>
  ack: ReturnType<typeof vi.fn>
  snap: GcSnapshot
} {
  const push: Record<string, (p: unknown) => void> = {}
  const sub =
    (name: string) =>
    (cb: (p: unknown) => void): (() => void) => {
      push[name] = cb
      return () => delete push[name]
    }
  const pushSend = vi.fn()
  const ack = vi.fn(async () => undefined)
  const snap = {
    scannedAt: NOW,
    bundles: [],
    orphanVolumes: [],
    orphanTranscripts: [],
    stackLeftovers: [],
    docker: { buildCacheReclaimableBytes: null, danglingImages: null },
    prefs: defaultGcPrefs(),
    lastCycle: null,
    dockerWatch: null,
    dockerNoticesPending: [],
    nextCycleAt: null,
    shelved: [],
    ...snapshot
  } as unknown as GcSnapshot
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      gcSnapshot: vi.fn(async () => snap),
      gcJobs: vi.fn(async () => []),
      gcRecoveryList: vi.fn(async () => []),
      gcRecoveryAck: vi.fn(async () => undefined),
      pushSend,
      gcAckDockerWatchNotices: ack,
      onGcRecoveryChanged: sub('recovery'),
      onGcShelvedChanged: sub('shelvedChanged'),
      onGcProgress: sub('progress'),
      onGcDone: sub('done'),
      onGcCycle: sub('cycle'),
      onGcDockerWatch: sub('dockerWatch'),
      onGcOpinionResult: sub('opinion'),
      onGcOpinionDone: sub('opinionDone')
    }
  }
  ;(globalThis as unknown as { document: unknown }).document = { hasFocus: () => true }
  return { push, pushSend, ack, snap }
}

beforeEach(() => {
  setActivePinia(createPinia())
  // The notification store prunes rows older than a week against the real clock.
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { window?: unknown }).window
})

describe('the out-of-capacity notice reaches Activity once (AC-2)', () => {
  it('a low notice makes one Activity row and one remote push', async () => {
    const { push, pushSend } = install()
    const store = useGcStore()
    await store.init()
    push.dockerWatch!(watch({ notice: { level: 'low', free: 3, total: 31, mark: 3 } }))
    const rows = useNotificationsStore().list
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: 'app',
      kind: 'warning',
      title: t('cleanup.gc.capacity.low.title'),
      target: { view: 'cleanup' }
    })
    expect(rows[0]!.description).toBe(t('cleanup.gc.capacity.low.body', { free: 3, total: 31 }))
    expect(pushSend).toHaveBeenCalledTimes(1)
    expect(pushSend.mock.calls[0]![0]).toMatchObject({
      kind: 'needs-input',
      title: t('cleanup.gc.capacity.low.title')
    })
  })

  it('says why nothing was freed when Cleanup is not acting (switch off, global pause)', async () => {
    const { push } = install()
    await useGcStore().init()
    push.dockerWatch!(
      watch({
        at: NOW,
        mode: 'off',
        notice: { level: 'low', free: 3, total: 31, mark: 3, autonomyOff: 'off' }
      })
    )
    push.dockerWatch!(
      watch({
        at: NOW + 1,
        mode: 'paused',
        notice: { level: 'zero', free: 0, total: 31, mark: 3, autonomyOff: 'paused' }
      })
    )
    const rows = useNotificationsStore().list
    expect(rows.map((r) => r.description)).toEqual([
      t('cleanup.gc.capacity.zero.bodyPaused'),
      t('cleanup.gc.capacity.low.bodyOff', { free: 3, total: 31 })
    ])
    expect(rows[0]!.description).toMatch(/paused/i)
    expect(rows[1]!.description).toMatch(/off/i)
  })

  it('a zero notice has its own wording', async () => {
    const { push } = install()
    await useGcStore().init()
    push.dockerWatch!(watch({ notice: { level: 'zero', free: 0, total: 31, mark: 3 } }))
    expect(useNotificationsStore().list[0]!.title).toBe(t('cleanup.gc.capacity.zero.title'))
  })

  it('a replayed record adds no second row and no second push', async () => {
    const { push, pushSend } = install()
    await useGcStore().init()
    const rec = watch({ notice: { level: 'low', free: 3, total: 31, mark: 3 } })
    push.dockerWatch!(rec)
    push.dockerWatch!(rec)
    expect(useNotificationsStore().list).toHaveLength(1)
    expect(pushSend).toHaveBeenCalledTimes(1)
  })

  it('a record without a notice records nothing', async () => {
    const { push, pushSend } = install()
    await useGcStore().init()
    push.dockerWatch!(watch())
    expect(useNotificationsStore().list).toHaveLength(0)
    expect(pushSend).not.toHaveBeenCalled()
  })

  it('a snapshot that carries a past notice never re-raises it', async () => {
    const { pushSend } = install({
      dockerWatch: watch({ notice: { level: 'zero', free: 0, total: 31, mark: 3 } })
    })
    const store = useGcStore()
    await store.init()
    await store.refresh()
    expect(useNotificationsStore().list).toHaveLength(0)
    expect(pushSend).not.toHaveBeenCalled()
    expect(store.dockerWatch?.notice?.level).toBe('zero')
  })
})

describe('the report-only list for the acknowledgement (AC-5)', () => {
  const item = (target: string): DockerWatchRecord['items'][number] => ({
    kind: 'network',
    target,
    reason: `empty ${target}`
  })
  const cycleWith = (at: number, items: DockerWatchRecord['items']): CycleRecord =>
    ({
      at,
      trigger: 'timer',
      mode: 'off',
      docker: {
        mode: 'report',
        found: items.length,
        acted: 0,
        refused: 0,
        failed: 0,
        deferred: 0,
        locked: false,
        paused: false,
        pausedReason: null,
        items
      }
    }) as unknown as CycleRecord

  it('is the items of the cycle report while unacknowledged', async () => {
    install({ lastCycle: cycleWith(NOW, [item('a'), item('b')]) })
    const store = useGcStore()
    await store.init()
    expect(store.dockerReport?.items.map((i) => i.target)).toEqual(['a', 'b'])
    expect(store.dockerReport?.found).toBe(2)
  })

  it('prefers a newer watcher report over an older cycle report', async () => {
    install({
      lastCycle: cycleWith(NOW, [item('old')]),
      dockerWatch: watch({ at: NOW + 5, mode: 'report', found: 1, items: [item('new')] })
    })
    const store = useGcStore()
    await store.init()
    expect(store.dockerReport?.items.map((i) => i.target)).toEqual(['new'])
  })

  it('is null once acknowledged', async () => {
    install({
      prefs: withDockerAcknowledged(defaultGcPrefs()),
      lastCycle: cycleWith(NOW, [item('a')])
    })
    const store = useGcStore()
    await store.init()
    expect(store.dockerReport).toBeNull()
  })

  it('is null when nothing would be done', async () => {
    install({ lastCycle: cycleWith(NOW, []) })
    const store = useGcStore()
    await store.init()
    expect(store.dockerReport).toBeNull()
  })
})

describe('a notice raised before the window existed (the boot pass) is delivered on attach', () => {
  const low = watch({ at: NOW - 5, notice: { level: 'low', free: 3, total: 31, mark: 3 } })
  const zero = watch({ at: NOW - 1, notice: { level: 'zero', free: 0, total: 31, mark: 3 } })

  it('the snapshot carries it: one Activity row and one push each, then it is acknowledged', async () => {
    const { pushSend, ack } = install({ dockerNoticesPending: [low, zero], dockerWatch: zero })
    await useGcStore().init()
    const rows = useNotificationsStore().list
    expect(rows.map((r) => r.title)).toEqual([
      t('cleanup.gc.capacity.zero.title'),
      t('cleanup.gc.capacity.low.title')
    ])
    expect(pushSend).toHaveBeenCalledTimes(2)
    expect(ack).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenCalledWith([low.at, zero.at])
  })

  it('a refresh that still carries it (the ack not applied yet) records nothing twice', async () => {
    const { pushSend } = install({ dockerNoticesPending: [low] })
    const store = useGcStore()
    await store.init()
    await store.refresh()
    expect(useNotificationsStore().list).toHaveLength(1)
    expect(pushSend).toHaveBeenCalledTimes(1)
  })

  it('the same notice arriving later by push is not recorded again', async () => {
    const { push, pushSend } = install({ dockerNoticesPending: [low] })
    await useGcStore().init()
    push.dockerWatch!(low)
    expect(useNotificationsStore().list).toHaveLength(1)
    expect(pushSend).toHaveBeenCalledTimes(1)
  })

  it('a pushed notice is acknowledged too, so a reload never replays it', async () => {
    const { push, ack } = install()
    await useGcStore().init()
    push.dockerWatch!(low)
    expect(ack).toHaveBeenCalledWith([low.at])
  })

  it('nothing pending: no ack, no rows', async () => {
    const { ack } = install()
    await useGcStore().init()
    expect(ack).not.toHaveBeenCalled()
    expect(useNotificationsStore().list).toHaveLength(0)
  })
})
