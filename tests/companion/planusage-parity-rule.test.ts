import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseParityLines,
  parityReport,
  type ParityRecord
} from '../../src/main/companion/parity-core'
import { comparePlanUsageRows } from '../../src/main/companion/ingest/parity-planusage-rule'

const FIXTURE = resolve(
  import.meta.dirname,
  '..',
  'fixtures',
  'companion-parity',
  'planUsage',
  'a-poll-vs-owned-reading.ndjson'
)

const T = 1_790_000_000_000
const base = {
  v: 1 as const,
  stream: 'planUsage' as const,
  source: 'legacy' as const,
  owner: 'legacy' as const,
  reason: 'no-binding' as const,
  disposition: 'applied' as const,
  sk: 'bbbbbbbbbbbb',
  k: 'poll',
  cli: '2.1.290',
  mod: '0.1.0'
}
const D = {
  s: 21,
  w: 54,
  rs: T + 3_600_000,
  rw: T + 400_000_000,
  h5: 21,
  d7: 54,
  r5: T + 3_600_000,
  r7: T + 400_000_000,
  age: 10_000
}
const row = (d: Partial<Record<keyof typeof D, number | null>> = {}, t = T): ParityRecord => ({
  ...base,
  t,
  d: { ...D, ...d }
})

describe('planUsage parity rule (spec P1W6 §13)', () => {
  it('a poll within a point of the freshest owned reading, resets within 5 min, is equal', () => {
    expect(comparePlanUsageRows([row()])).toEqual([])
    expect(comparePlanUsageRows([row({ s: 22, w: 53, rs: T + 3_600_000 + 299_000 })])).toEqual([])
  })

  it('more than a point apart is unexplained', () => {
    const out = comparePlanUsageRows([row({ s: 23 })])
    expect(out).toHaveLength(1)
    expect(out[0]!.class).toBeNull()
    expect(comparePlanUsageRows([row({ w: 56 })])[0]!.class).toBeNull()
  })

  it('resets more than 5 minutes apart are unexplained', () => {
    expect(comparePlanUsageRows([row({ rs: T + 3_600_000 + 301_000 })])[0]!.class).toBeNull()
  })

  it('P1: a reading older than 90 s explains a difference', () => {
    const out = comparePlanUsageRows([row({ s: 26, age: 91_000 })])
    expect(out.map((d) => d.class)).toEqual(['P1'])
  })

  it('P2: the pair straddles a window reset', () => {
    // the five-hour window reset 20 s ago; the reading is 60 s old, so it predates the reset
    const t = T + 1_000_000
    const out = comparePlanUsageRows([row({ s: 3, h5: 90, r5: t - 20_000, age: 60_000 }, t)])
    expect(out.map((d) => d.class)).toEqual(['P2'])
  })

  it('a poll with no owned reading is no comparison at all', () => {
    expect(
      comparePlanUsageRows([row({ h5: null, d7: null, r5: null, r7: null, age: null })])
    ).toEqual([])
  })

  it('a window one side lacks is a difference, not a pass', () => {
    expect(comparePlanUsageRows([row({ d7: null, r7: null })])[0]!.class).toBeNull()
  })

  it('the committed trace: two equal polls, then a 200 s old reading explained as P1', () => {
    const records = parseParityLines(readFileSync(FIXTURE, 'utf8'))
    expect(records).toHaveLength(3)
    const report = parityReport('planUsage', records)
    expect(report.facts).toBe(3)
    expect(report.explained).toEqual({ P1: 1 })
    expect(report.unexplained).toEqual([])
  })
})
