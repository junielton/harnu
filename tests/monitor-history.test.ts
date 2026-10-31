import { describe, it, expect } from 'vitest'
import {
  HISTORY_LENGTH,
  appendSample,
  harnuHistoryKey,
  sessionHistoryKey,
  type MonitorHistory
} from '../src/renderer/src/lib/monitor-history'
import type { MonitorSample, SessionSample, ProcSample } from '../src/preload'

const proc = (pid: number, rss: number | null): ProcSample => ({
  pid,
  name: 'p',
  cpuPct: 1,
  rssBytes: rss
})
const session = (
  key: string,
  rss: number | null,
  state: 'live' | 'parked' = 'live'
): SessionSample => ({
  sessionKey: key,
  kind: 'claude-resume',
  state,
  cpuPct: rss === null ? null : 1,
  rssBytes: rss,
  procs: [],
  idleMs: 0,
  parkable: true,
  reason: 'active',
  sweepRank: null,
  savedBytes: null
})
const sample = (harnu: ProcSample[], sessions: SessionSample[], atMs = 0): MonitorSample => ({
  atMs,
  heap: { atMs, usedBytes: 1, limitBytes: 100, status: 'ok' },
  harnu,
  sessions
})

describe('monitor history ring buffer (T591 AC-7)', () => {
  it('keeps 40 samples — about 60 s at the 1.5 s cadence', () => {
    expect(HISTORY_LENGTH).toBe(40)
  })

  it('records one RSS reading per process key and per session key', () => {
    const h = appendSample(new Map(), sample([proc(7, 100)], [session('s1', 500)]))
    expect(h.get(harnuHistoryKey(7))).toEqual([100])
    expect(h.get(sessionHistoryKey('s1'))).toEqual([500])
  })

  it('keeps only the newest 40 readings, oldest dropped first', () => {
    let h: MonitorHistory = new Map()
    for (let i = 1; i <= 100; i++) h = appendSample(h, sample([], [session('s1', i)]))
    const series = h.get(sessionHistoryKey('s1'))!
    expect(series).toHaveLength(HISTORY_LENGTH)
    expect(series[0]).toBe(61)
    expect(series[series.length - 1]).toBe(100)
  })

  it('prunes a key that is absent from the latest sample', () => {
    let h = appendSample(new Map(), sample([proc(1, 10)], [session('gone', 5), session('stay', 6)]))
    h = appendSample(h, sample([], [session('stay', 7)]))
    expect(h.has(harnuHistoryKey(1))).toBe(false)
    expect(h.has(sessionHistoryKey('gone'))).toBe(false)
    expect(h.get(sessionHistoryKey('stay'))).toEqual([6, 7])
  })

  it('stays bounded by live keys × 40 however many keys come and go', () => {
    let h: MonitorHistory = new Map()
    for (let i = 0; i < 500; i++) h = appendSample(h, sample([proc(i, 1)], [session(`s${i}`, 1)]))
    expect(h.size).toBe(2)
    for (const series of h.values()) expect(series.length).toBeLessThanOrEqual(HISTORY_LENGTH)
  })

  it('records a parked (unknown) reading as null, never as 0', () => {
    const h = appendSample(new Map(), sample([], [session('s1', null, 'parked')]))
    expect(h.get(sessionHistoryKey('s1'))).toEqual([null])
  })

  it('does not mutate the previous history', () => {
    const before: MonitorHistory = new Map([[sessionHistoryKey('s1'), [1]]])
    appendSample(before, sample([], [session('s1', 2)]))
    expect(before.get(sessionHistoryKey('s1'))).toEqual([1])
  })
})
