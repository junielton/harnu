import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseParityLines,
  parityReport,
  type ParityRecord
} from '../../src/main/companion/parity-core'
import { compareTelemetryRows } from '../../src/main/companion/ingest/parity-telemetry-rule'

const FIXTURE = resolve(
  import.meta.dirname,
  '..',
  'fixtures',
  'companion-parity',
  'telemetry',
  'a3-readings.ndjson'
)

const base = {
  v: 1 as const,
  stream: 'telemetry' as const,
  owner: 'legacy' as const,
  reason: 'mode-shadow' as const,
  disposition: 'record-only' as const,
  sk: 'aaaaaaaaaaaa',
  k: 'reading',
  cli: '2.1.290',
  mod: '0.1.0'
}
const D = { pct: 19, window: 200000, usd: 0.5, h5: 21, d7: 54, r5: 1_000_000, r7: 2_000_000 }
const row = (
  source: 'legacy' | 'companion',
  t: number,
  d: Partial<Record<keyof typeof D, number | null>> & { afterAbort?: boolean } = {}
): ParityRecord => ({ ...base, source, t, d: { ...D, ...d } })

describe('telemetry parity rule (spec P1W6 §13)', () => {
  it('pairs each statusLine sample with the nearest companion sample within 5 s', () => {
    const out = compareTelemetryRows([
      row('legacy', 10_000),
      row('companion', 10_300),
      row('companion', 14_000)
    ])
    expect(out).toEqual([])
  })

  it('equal within the tolerances: |Δpct| ≤ 1, |Δusd| ≤ 0.01, |Δrate| ≤ 1, resets within 60 s', () => {
    const near = compareTelemetryRows([
      row('legacy', 10_000),
      row('companion', 10_100, { pct: 20, usd: 0.509, h5: 22, d7: 53, r5: 1_000_000 + 60_000 })
    ])
    expect(near).toEqual([])
    const far = compareTelemetryRows([row('legacy', 10_000), row('companion', 10_100, { pct: 21 })])
    expect(far).toHaveLength(1)
    expect(far[0]!.class).toBeNull()
    expect(
      compareTelemetryRows([row('legacy', 1), row('companion', 2, { usd: 0.52 })])[0]!.class
    ).toBeNull()
    expect(
      compareTelemetryRows([row('legacy', 1), row('companion', 2, { r5: 1_000_000 + 61_000 })])[0]!
        .class
    ).toBeNull()
  })

  it('T1: a statusLine sample with no companion sample in the window is explained', () => {
    const out = compareTelemetryRows([row('legacy', 10_000), row('companion', 20_000)])
    expect(out.map((d) => d.class)).toEqual(['T1'])
  })

  it('T3: the first reading of a resumed session has no windows', () => {
    const out = compareTelemetryRows([
      row('legacy', 10_000),
      row('companion', 10_200, { h5: null, d7: null, r5: null, r7: null }),
      row('legacy', 40_000),
      row('companion', 40_100)
    ])
    expect(out.map((d) => d.class)).toEqual(['T3'])
  })

  it('a window missing from a LATER companion reading is unexplained', () => {
    const out = compareTelemetryRows([
      row('legacy', 10_000),
      row('companion', 10_100),
      row('legacy', 40_000),
      row('companion', 40_100, { h5: null, r5: null })
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.class).toBeNull()
  })

  it('T2 needs the abort evidence of P1W5: without it a missing context is unexplained', () => {
    const missing = { pct: null, window: null }
    const without = compareTelemetryRows([
      row('legacy', 10_000),
      row('companion', 10_100),
      row('legacy', 40_000),
      row('companion', 40_100, missing)
    ])
    expect(without[0]!.class).toBeNull()
    const withAbort = compareTelemetryRows([
      row('legacy', 10_000),
      row('companion', 10_100),
      row('legacy', 40_000),
      row('companion', 40_100, { ...missing, afterAbort: true } as never)
    ])
    expect(withAbort[0]!.class).toBe('T2')
  })

  it('the committed live trace of LV-P1W6-b: the companion and the statusLine agree', () => {
    const live = join(FIXTURE, '..', 'lv-p1w6-b-live.ndjson')
    const records = parseParityLines(readFileSync(live, 'utf8'))
    const report = parityReport('telemetry', records)
    expect(report.facts).toBe(records.length)
    expect(report.unexplained).toEqual([])
  })

  it('the committed A3 trace: two sessions of readings, all pairs equal or T1', () => {
    const records = parseParityLines(readFileSync(FIXTURE, 'utf8'))
    expect(records.length).toBe(5)
    const report = parityReport('telemetry', records)
    expect(report.sessions).toBe(1)
    expect(report.unexplained).toEqual([])
    expect(report.explained).toEqual({ T1: 1 }) // the 90 s statusLine blob has no companion twin
    void join
  })
})
