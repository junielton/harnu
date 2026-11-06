import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useMonitorStore } from '../src/renderer/src/stores/monitor'
import { HISTORY_LENGTH } from '../src/renderer/src/lib/monitor-history'
import type { HeapSample, MonitorSample, SessionSample } from '../src/preload'

let sampleCb: ((s: MonitorSample) => void) | null = null
let monitorStart: ReturnType<typeof vi.fn>

const heap: HeapSample = { atMs: 0, usedBytes: 1, limitBytes: 100, status: 'ok' }
const row = (key: string, rss: number | null): SessionSample => ({
  sessionKey: key,
  kind: 'claude-resume',
  state: rss === null ? 'parked' : 'live',
  cpuPct: rss === null ? null : 1,
  rssBytes: rss,
  procs: [],
  idleMs: 0,
  parkable: true,
  reason: 'active',
  sweepRank: null,
  savedBytes: null
})
const sample = (sessions: SessionSample[]): MonitorSample => ({
  atMs: 0,
  heap,
  harnu: [{ pid: 9, name: 'main', cpuPct: 1, rssBytes: 100 }],
  sessions
})

beforeEach(() => {
  setActivePinia(createPinia())
  sampleCb = null
  monitorStart = vi.fn().mockResolvedValue(undefined)
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      onMonitorHeap: () => () => {},
      onMonitorSample: (cb: (s: MonitorSample) => void) => {
        sampleCb = cb
        return () => {}
      },
      monitorStart,
      monitorStop: vi.fn().mockResolvedValue(undefined)
    }
  }
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('monitor store — sparkline history (T591 AC-7)', () => {
  it('feeds the ring buffer from samples that already arrive, and never starts sampling', () => {
    const store = useMonitorStore()
    sampleCb!(sample([row('a', 10)]))
    sampleCb!(sample([row('a', 20)]))
    expect(store.sessionHistory('a')).toEqual([10, 20])
    expect(store.harnuHistory(9)).toEqual([100, 100])
    expect(monitorStart).not.toHaveBeenCalled()
  })

  it('prunes a session that left the sample and bounds every series', () => {
    const store = useMonitorStore()
    for (let i = 0; i < 100; i++) sampleCb!(sample([row('a', i), row('b', i)]))
    expect(store.sessionHistory('a')).toHaveLength(HISTORY_LENGTH)
    sampleCb!(sample([row('a', 1)]))
    expect(store.sessionHistory('b')).toEqual([])
  })

  it('returns an empty series for a key it never saw', () => {
    expect(useMonitorStore().sessionHistory('nope')).toEqual([])
  })
})
