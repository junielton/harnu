import { describe, it, expect } from 'vitest'
import { cpuPercent, type CpuTimeSample } from '../src/main/monitor/cpu-delta'

const TICKS_PER_SEC = 100

function sample(over: Partial<CpuTimeSample> = {}): CpuTimeSample {
  return { utime: 0, stime: 0, atMs: 0, ...over }
}

describe('cpuPercent', () => {
  it('returns null for a pid’s first-ever tick (no prior sample)', () => {
    expect(cpuPercent(null, sample({ atMs: 1000 }), TICKS_PER_SEC, 4)).toBeNull()
  })

  it('computes 100% for one full core saturated over one second', () => {
    // 100 jiffies (1 second at 100 ticks/sec) burned over exactly 1000ms wall time.
    const prev = sample({ utime: 0, stime: 0, atMs: 0 })
    const curr = sample({ utime: 100, stime: 0, atMs: 1000 })
    expect(cpuPercent(prev, curr, TICKS_PER_SEC, 4)).toBe(100)
  })

  it('splits user+kernel jiffies into the same total', () => {
    const prev = sample({ utime: 0, stime: 0, atMs: 0 })
    const curr = sample({ utime: 30, stime: 20, atMs: 1000 }) // 50 jiffies = 0.5s of CPU
    expect(cpuPercent(prev, curr, TICKS_PER_SEC, 4)).toBe(50)
  })

  it('is unnormalized — 2 full cores over 1s reports ~200%, not 100%', () => {
    const prev = sample({ utime: 0, stime: 0, atMs: 0 })
    const curr = sample({ utime: 200, stime: 0, atMs: 1000 })
    expect(cpuPercent(prev, curr, TICKS_PER_SEC, 4)).toBe(200)
  })

  it('clamps to coreCount * 100 against a bogus/anomalous delta', () => {
    const prev = sample({ utime: 0, stime: 0, atMs: 0 })
    // 1000 jiffies (10s of CPU) in 100ms of wall time — impossible on a 4-core box.
    const curr = sample({ utime: 1000, stime: 0, atMs: 100 })
    expect(cpuPercent(prev, curr, TICKS_PER_SEC, 4)).toBe(400)
  })

  it('returns null when wall time did not advance', () => {
    const prev = sample({ utime: 10, stime: 0, atMs: 500 })
    const curr = sample({ utime: 20, stime: 0, atMs: 500 })
    expect(cpuPercent(prev, curr, TICKS_PER_SEC, 4)).toBeNull()
  })

  it('returns null when wall time went backward', () => {
    const prev = sample({ utime: 10, stime: 0, atMs: 500 })
    const curr = sample({ utime: 20, stime: 0, atMs: 100 })
    expect(cpuPercent(prev, curr, TICKS_PER_SEC, 4)).toBeNull()
  })

  it('returns null when jiffies went backward (pid-reuse artifact)', () => {
    const prev = sample({ utime: 500, stime: 0, atMs: 0 })
    const curr = sample({ utime: 10, stime: 0, atMs: 1000 })
    expect(cpuPercent(prev, curr, TICKS_PER_SEC, 4)).toBeNull()
  })

  it('returns 0 for a genuinely idle process (no jiffies burned)', () => {
    const prev = sample({ utime: 10, stime: 5, atMs: 0 })
    const curr = sample({ utime: 10, stime: 5, atMs: 1000 })
    expect(cpuPercent(prev, curr, TICKS_PER_SEC, 4)).toBe(0)
  })
})
