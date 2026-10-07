/**
 * The `taskState` parity rule (AC-P1W5-15). The committed corpus under
 * `tests/fixtures/companion-parity/taskState/` is RECONSTRUCTED from the event orders and timings of
 * the smoke A4 traces (answer, auto-allowed tool, approved, denied, background subagent, Esc,
 * idle) and from the variants each explained class is written for; it is not a capture of a live
 * fleet. The real corpus is the ledger export of the flip gate (spec section 13).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  gateStatus,
  parityReport,
  parseParityLines,
  resetParityRulesForTests,
  type ParityRecord
} from '../../src/main/companion/parity-core'
import {
  TASK_STATE_GATE,
  compareTaskStateRows,
  registerTaskStateParityRule
} from '../../src/main/companion/parity-taskstate-rule'

const DIR = join(import.meta.dirname, '..', 'fixtures', 'companion-parity', 'taskState')
const T0 = 1_790_000_000_000

let n = 0
const row = (
  source: 'legacy' | 'companion',
  k: string,
  at: number,
  d: Record<string, string | null> = {},
  sk = 'aaaaaaaaaaaa'
): ParityRecord => ({
  v: 1,
  stream: 'taskState',
  source,
  owner: 'legacy',
  reason: 'mode-shadow',
  disposition: source === 'legacy' ? 'applied' : 'record-only',
  sk,
  t: T0 + at + n++ * 0, // host receive time
  ts: T0 + at,
  k,
  d,
  cli: '2.1.290',
  mod: '0.1.0'
})
const L = (s: string, at: number, ev = 'Stop', m: string | null = null) =>
  row('legacy', `state:${s}`, at, { ev, m })
const C = (s: string, at: number, ev = 'Stop') =>
  row('companion', `state:${s}`, at, { ev, m: null })
const hold = (at: number) => row('companion', 'hold:subagent', at, { n: 1 })

const classes = (rows: ParityRecord[]): (string | null)[] =>
  compareTaskStateRows(rows).map((d) => d.class)

beforeEach(() => {
  resetParityRulesForTests()
  registerTaskStateParityRule()
})

describe('matching', () => {
  it('a legacy transition matches a companion one to the same state in [t - 10 s, t + 2 s]', () => {
    expect(
      compareTaskStateRows([C('working', 0), L('working', 63), C('idle', 3294), L('idle', 3279)])
    ).toEqual([])
    // the legacy path is late: 10 s later still matches
    expect(compareTaskStateRows([C('working', 0), L('working', 10_000)])).toEqual([])
    // too late
    expect(classes([C('working', 0), L('working', 10_001)]).length).toBe(2)
    // the companion may be at most 2 s behind the legacy edge
    expect(compareTaskStateRows([L('working', 5_000), C('working', 7_000)])).toEqual([])
    expect(classes([L('working', 5_000), C('working', 7_001)]).length).toBe(2)
  })

  it('repeats collapse before matching', () => {
    expect(
      compareTaskStateRows([
        L('working', 0),
        L('working', 100),
        C('working', 5),
        C('working', 50),
        L('idle', 3000),
        C('idle', 2990)
      ])
    ).toEqual([])
  })

  it('only state and hold rows count: the hub event rows and other streams are ignored', () => {
    const ev = row('companion', 'event:Stop', 10, { state: null })
    const other = { ...L('working', 0), stream: 'identity' as const }
    expect(compareTaskStateRows([ev, other, C('working', 0), L('working', 5)])).toEqual([])
  })
})

describe('explained classes', () => {
  it('E1: a companion idle after an aborted or declined turn that legacy never closed', () => {
    expect(classes([L('working', 0), C('working', 0), C('idle', 5000, 'Stop')])).toEqual(['E1'])
  })

  it('E2: legacy idle while the companion holds a running subagent', () => {
    const rows = [
      L('working', 0),
      C('working', 0),
      hold(3294),
      L('idle', 3320),
      C('idle', 20_000),
      L('working', 20_100, 'UserPromptSubmit'),
      C('working', 20_080, 'UserPromptSubmit'),
      L('idle', 23_010),
      C('idle', 23_000)
    ]
    expect(classes(rows).sort()).toEqual(['E1', 'E2'])
  })

  it('E3: a companion needs-input and working pair shorter than the window that legacy never saw', () => {
    const rows = [
      L('working', 0),
      C('working', 0),
      C('needs-input', 2000, 'PermissionRequest'),
      C('working', 2500, 'PostToolUse'),
      L('idle', 4020),
      C('idle', 4000)
    ]
    expect(classes(rows)).toEqual(['E3', 'E3'])
  })

  it('E3 does not cover a needs-input that lasted longer than the window', () => {
    const rows = [
      L('working', 0),
      C('working', 0),
      C('needs-input', 2000, 'PermissionRequest'),
      C('working', 20_000, 'PostToolUse')
    ]
    expect(classes(rows).every((c) => c === null)).toBe(true)
    expect(classes(rows).length).toBeGreaterThan(0)
  })

  it('E4: legacy transitions before the first companion transition', () => {
    const rows = [
      L('working', 0),
      L('idle', 3300),
      L('working', 10_000),
      C('working', 10_010),
      L('idle', 13_010),
      C('idle', 13_000)
    ]
    expect(classes(rows)).toEqual(['E4', 'E4'])
  })

  it('E4 needs a companion: a session whose companion said nothing is not "before proof"', () => {
    expect(classes([L('working', 0), L('idle', 3000)])).toEqual([null, null])
  })

  it('E5: a legacy idle_prompt idle when the companion was already idle', () => {
    const rows = [
      L('working', 0),
      C('working', 0),
      C('idle', 5000, 'Stop'),
      L('idle', 65_000, 'Notification', 'idle_prompt')
    ]
    expect(classes(rows).sort()).toEqual(['E1', 'E5'])
  })
})

describe('unexplained, each fails the gate', () => {
  it('a legacy working or needs-input with no companion match', () => {
    expect(
      classes([C('working', 0), L('working', 0), L('needs-input', 4000, 'PermissionRequest')])
    ).toEqual([null])
  })

  it('a lost Stop: a legacy idle with no companion idle and no hold', () => {
    expect(classes([C('working', 0), L('working', 0), L('idle', 3300)])).toEqual([null])
  })

  it('a completed mismatch, in either direction', () => {
    expect(
      classes([C('working', 0), L('working', 0), L('completed', 9000, 'SessionEnd', 'logout')])
    ).toEqual([null])
    expect(classes([C('working', 0), L('working', 0), C('completed', 9000, 'SessionEnd')])).toEqual(
      [null]
    )
    expect(
      compareTaskStateRows([
        C('working', 0),
        L('working', 0),
        C('completed', 9000, 'SessionEnd'),
        L('completed', 9100, 'SessionEnd', 'logout')
      ])
    ).toEqual([])
  })

  it('an order inversion', () => {
    // legacy saw needs-input, working, needs-input; the companion saw the first pair's states in
    // the other order, so the second legacy edge can only match an earlier companion edge
    const rows = [
      L('needs-input', 1000, 'PermissionRequest'),
      L('working', 1500, 'PostToolUse'),
      L('needs-input', 2000, 'PermissionRequest'),
      C('working', 900, 'PostToolUse'),
      C('needs-input', 1900, 'PermissionRequest'),
      C('needs-input', 1950, 'PermissionRequest')
    ]
    expect(classes(rows).some((c) => c === null)).toBe(true)
  })

  it('a companion-only edge no class covers is not waved through', () => {
    expect(
      classes([L('working', 0), C('working', 0), C('needs-input', 20_000, 'PermissionRequest')])
    ).toEqual([null])
  })
})

describe('replay of the committed traces', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.ndjson'))

  it('the corpus is not empty', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const f of files) {
    it(`replay: ${f}`, () => {
      const records = parseParityLines(readFileSync(join(DIR, f), 'utf8'))
      const want = JSON.parse(
        readFileSync(join(DIR, f.replace(/\.ndjson$/, '.expect.json')), 'utf8')
      ) as {
        sessions: number
        explained: Record<string, number>
        unexplained: number
      }
      const report = parityReport('taskState', records)
      expect(report.unexplained).toEqual([])
      expect(report.sessions).toBe(want.sessions)
      expect(report.explained).toEqual(want.explained)
      expect(want.unexplained).toBe(0)
    })
  }
})

describe('the flip gate', () => {
  it('needs 200 sessions and 5 000 facts and zero unexplained', () => {
    expect(TASK_STATE_GATE).toEqual({ minSessions: 200, minFacts: 5000 })
    const small = { sessions: 11, facts: 120, explained: {}, unexplained: [] }
    expect(gateStatus(small, TASK_STATE_GATE).pass).toBe(false)
    const big = { sessions: 200, facts: 5000, explained: { E1: 40 }, unexplained: [] }
    expect(gateStatus(big, TASK_STATE_GATE).pass).toBe(true)
  })
})
