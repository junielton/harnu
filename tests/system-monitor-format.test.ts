import { describe, it, expect } from 'vitest'
import { selfSample } from '../src/renderer/src/components/system-monitor-format'
import type { ProcSample } from '../src/preload'

function proc(overrides: Partial<ProcSample> = {}): ProcSample {
  return { pid: 1, name: 'node', cpuPct: 1, rssBytes: 1_000_000, ...overrides }
}

describe('selfSample', () => {
  it('subtracts every listed descendant from the subtree total', () => {
    const out = selfSample({ cpuPct: 10, rssBytes: 900_000_000 }, [
      proc({ pid: 2, cpuPct: 1, rssBytes: 83_000_000 }),
      proc({ pid: 3, cpuPct: 0, rssBytes: 1_000_000 }),
      proc({ pid: 4, cpuPct: 0, rssBytes: 106_000_000 })
    ])
    expect(out.rssBytes).toBe(900_000_000 - 83_000_000 - 1_000_000 - 106_000_000)
    expect(out.cpuPct).toBe(9)
  })

  it('is null when the total is unknown', () => {
    const out = selfSample({ cpuPct: null, rssBytes: null }, [proc()])
    expect(out).toEqual({ cpuPct: null, rssBytes: null })
  })

  it('is null when any one descendant reading is unknown, not a partial sum', () => {
    const out = selfSample({ cpuPct: 10, rssBytes: 900_000_000 }, [
      proc({ rssBytes: 83_000_000 }),
      proc({ rssBytes: null })
    ])
    expect(out.rssBytes).toBeNull()
  })

  it('returns the full total unchanged when there are no descendants', () => {
    const out = selfSample({ cpuPct: 3, rssBytes: 500_000_000 }, [])
    expect(out).toEqual({ cpuPct: 3, rssBytes: 500_000_000 })
  })
})
