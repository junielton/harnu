// @vitest-environment jsdom
// U3.7 AC-3: the store remembers that a squeeze was seen on default pools and that the advice was
// dismissed, across restarts (renderer-persisted), keyed by the engine's pools.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { DockerCapacityView, DockerWatchRecord, GcSnapshot } from '../src/main/gc/gc-wire'
import { useGcStore } from '../src/renderer/src/stores/gc'
import { NOW } from './gc-fixtures'

const watch = (capacity: DockerCapacityView | null, over: Partial<DockerWatchRecord> = {}) =>
  ({
    at: NOW,
    trigger: 'timer',
    mode: 'act',
    mark: 3,
    capacity,
    pressure: false,
    found: 0,
    acted: 0,
    refused: 0,
    failed: 0,
    deferred: 0,
    locked: false,
    paused: false,
    pausedReason: null,
    nothingLeft: false,
    items: [],
    notice: null,
    report: null,
    ...over
  }) as DockerWatchRecord

const cap = (
  free: number,
  source: 'default' | 'daemon.json' = 'default',
  total = 31
): DockerCapacityView => ({ known: true, total, used: total - free, free, source })

let push: ((r: DockerWatchRecord) => void) | null = null

function install(dockerWatch: DockerWatchRecord | null = null): void {
  const snap = {
    scannedAt: NOW,
    bundles: [],
    orphanVolumes: [],
    orphanTranscripts: [],
    stackLeftovers: [],
    docker: { buildCacheReclaimableBytes: null, danglingImages: null },
    prefs: defaultGcPrefs(),
    lastCycle: null,
    dockerWatch,
    dockerNoticesPending: [],
    dockerReport: null,
    nextCycleAt: null,
    shelved: []
  } as unknown as GcSnapshot
  const none = (): (() => void) => () => undefined
  ;(window as unknown as { api: unknown }).api = {
    gcSnapshot: vi.fn(async () => snap),
    gcJobs: vi.fn(async () => []),
    gcRecoveryList: vi.fn(async () => []),
    gcRecoveryAck: vi.fn(async () => undefined),
    pushSend: vi.fn(),
    gcAckDockerWatchNotices: vi.fn(async () => undefined),
    onGcRecoveryChanged: none,
    onGcShelvedChanged: none,
    onGcProgress: none,
    onGcDone: none,
    onGcCycle: none,
    onGcDockerWatch: (cb: (r: DockerWatchRecord) => void) => {
      push = cb
      return () => (push = null)
    },
    onGcOpinionResult: none,
    onGcOpinionDone: none
  }
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  push = null
})

describe('pool advice flags', () => {
  it('a squeeze on default pools puts the advice on offer', async () => {
    install()
    const gc = useGcStore()
    await gc.init()
    expect(gc.poolAdviceOffer).toBe(false)
    push!(watch(cap(3)))
    expect(gc.poolAdviceOffer).toBe(true)
  })

  it('plenty of free slots never offers it', async () => {
    install()
    const gc = useGcStore()
    await gc.init()
    push!(watch(cap(16)))
    expect(gc.poolAdviceOffer).toBe(false)
  })

  it('custom pools never offer it, squeeze or not', async () => {
    install()
    const gc = useGcStore()
    await gc.init()
    push!(watch(cap(1, 'daemon.json', 256)))
    expect(gc.poolAdviceOffer).toBe(false)
  })

  it('a squeeze already in the snapshot at load counts', async () => {
    install(watch(cap(2)))
    const gc = useGcStore()
    await gc.init()
    expect(gc.poolAdviceOffer).toBe(true)
  })

  it('stays on offer after the slots recover, until it is dismissed', async () => {
    install()
    const gc = useGcStore()
    await gc.init()
    push!(watch(cap(3)))
    push!(watch(cap(16), { at: NOW + 1 }))
    expect(gc.poolAdviceOffer).toBe(true)
  })

  it('dismissing hides it, and a restart keeps it hidden', async () => {
    install()
    const gc = useGcStore()
    await gc.init()
    push!(watch(cap(3)))
    gc.dismissPoolAdvice()
    expect(gc.poolAdviceOffer).toBe(false)

    setActivePinia(createPinia())
    install(watch(cap(2)))
    const again = useGcStore()
    await again.init()
    expect(again.poolAdviceOffer).toBe(false)
  })

  it('returns only when the pools change and a new squeeze is seen', async () => {
    install()
    const gc = useGcStore()
    await gc.init()
    push!(watch(cap(3)))
    gc.dismissPoolAdvice()
    push!(watch(cap(2, 'default', 62), { at: NOW + 5 }))
    expect(gc.poolAdviceOffer).toBe(true)
  })

  it('unknown capacity never offers it', async () => {
    install()
    const gc = useGcStore()
    await gc.init()
    push!(watch({ known: false, reason: 'rootless' }))
    expect(gc.poolAdviceOffer).toBe(false)
  })
})
