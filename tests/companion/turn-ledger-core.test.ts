import { describe, expect, it } from 'vitest'
import {
  COST_SETTLE_MS,
  createLedgerCore,
  measuredUsdByDay,
  summarizeLedger,
  type TurnLedgerRecord
} from '../../src/main/companion/ingest/turn-ledger-core'

const SID = '11111111-1111-4111-8111-111111111111'
const PATH = '/tmp/example-project'
const T0 = 1_790_000_000_000

const tok = (input: number, output: number, cacheRead: number, cacheCreation: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheCreationTokens: cacheCreation
})

type TurnRec = Extract<TurnLedgerRecord, { k: 'turn' }>
const turns = (rs: TurnLedgerRecord[]): TurnRec[] => rs.filter((r): r is TurnRec => r.k === 'turn')

/** The three turns of smoke D7 (docs/studies/T389-smoke-evidence.md) and its cost readings. */
function replayD7() {
  const core = createLedgerCore()
  const out: TurnLedgerRecord[] = []
  const push = (rs: TurnLedgerRecord[]): void => void out.push(...rs)
  push(core.usage(SID, T0, { costUsd: 0, projectPath: PATH, startedAt: T0 - 400 })) // session start
  push(core.turnStarted(SID, T0 + 1_000, 'turn-1'))
  push(core.usage(SID, T0 + 2_000, { costUsd: 0.0289258, projectPath: PATH })) // after the first step
  push(
    core.turnCompleted(SID, T0 + 2_500, {
      turnId: 'turn-s',
      agentId: 'agent-1',
      durationMs: 1252,
      reason: 'answer',
      usage: { model: 'claude-haiku-4-5-20251001', ...tok(10, 68, 0, 18021) }
    })
  )
  push(
    core.turnCompleted(SID, T0 + 8_000, {
      turnId: 'turn-1',
      durationMs: 7246,
      reason: 'answer',
      usage: { model: 'claude-haiku-4-5-20251001', ...tok(18, 262, 49303, 14155) }
    })
  )
  push(core.usage(SID, T0 + 8_013, { costUsd: 0.05744455, projectPath: PATH })) // follows by ~13 ms
  push(core.turnStarted(SID, T0 + 9_000, 'turn-2'))
  push(
    core.turnCompleted(SID, T0 + 10_600, {
      turnId: 'turn-2',
      durationMs: 1582,
      reason: 'answer',
      usage: { model: 'claude-haiku-4-5-20251001', ...tok(10, 95, 32273, 504) }
    })
  )
  push(core.usage(SID, T0 + 10_613, { costUsd: 0.06216485, projectPath: PATH }))
  return { core, out }
}

describe('turn ledger core (spec P1W6 §7.5)', () => {
  it('smoke D7 replay (AC-P1W6-15)', () => {
    const { out } = replayD7()
    const ts = turns(out)
    expect(ts).toHaveLength(3)
    const sum = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
    for (const t of ts) {
      sum.input += t.tokens?.input ?? 0
      sum.output += t.tokens?.output ?? 0
      sum.cacheRead += t.tokens?.cacheRead ?? 0
      sum.cacheCreation += t.tokens?.cacheCreation ?? 0
    }
    expect(sum).toEqual({ input: 38, output: 425, cacheRead: 81576, cacheCreation: 32680 })
    const sub = ts.find((t) => t.agentId === 'agent-1')!
    expect(sub.costBasis).toBe('parent')
    expect(sub.costUsd).toBeNull()
    const main = ts.filter((t) => t.agentId === undefined)
    expect(main.every((t) => t.costBasis === 'measured')).toBe(true)
    expect(main.reduce((a, t) => a + (t.costUsd ?? 0), 0)).toBeCloseTo(0.06216485, 8)
    // the dollars of a subagent land in the parent turn: the first main turn carries both steps
    expect(main[0]!.costUsd).toBeCloseTo(0.05744455, 8)
    expect(main[1]!.costUsd).toBeCloseTo(0.0047203, 8)
    // wall time is the host time between the two edges; the CLI's duration sits beside it
    expect(main[0]).toMatchObject({
      durationMs: 7246,
      wallMs: 7_000,
      model: 'claude-haiku-4-5-20251001'
    })
  })

  it('a resumed session is never calibrated (AC-P1W6-16)', () => {
    const core = createLedgerCore()
    const out: TurnLedgerRecord[] = []
    out.push(...core.usage(SID, T0, { costUsd: 0.19, projectPath: PATH }))
    out.push(...core.turnStarted(SID, T0 + 100, 'a'))
    out.push(...core.usage(SID, T0 + 500, { costUsd: 0.25, projectPath: PATH }))
    expect(out[0]).toMatchObject({ k: 'open', costAtOpen: 0.19, fresh: false })
    // the history before the first reading is never attributed: no delta at the first reading
    expect(out.filter((r) => r.k === 'other')).toHaveLength(0)
    const s = summarizeLedger(out).get(SID)!
    expect(s.covered).toBe(false)
  })

  it('a fresh session with no gap is covered', () => {
    const { out } = replayD7()
    expect(summarizeLedger(out).get(SID)?.covered).toBe(true)
  })

  it('error turn without usage (AC-P1W6-17, Q13b)', () => {
    const core = createLedgerCore()
    core.usage(SID, T0, { costUsd: 0, projectPath: PATH })
    core.turnStarted(SID, T0 + 10, 'e')
    core.turnCompleted(SID, T0 + 900, {
      turnId: 'e',
      durationMs: 800,
      reason: 'error',
      failure: { type: 'api_error' }
    })
    // nothing yet: the cost may still follow; the deadline writes it
    const written = core.tick(T0 + 900 + COST_SETTLE_MS + 1)
    expect(turns(written)).toHaveLength(1)
    expect(turns(written)[0]).toMatchObject({
      tokens: null,
      model: null,
      reason: 'error',
      turnId: 'e'
    })
  })

  it('spend outside a turn is separate (AC-P1W6-18)', () => {
    const core = createLedgerCore()
    core.usage(SID, T0, { costUsd: 0, projectPath: PATH })
    const out = core.usage(SID, T0 + 5_000, { costUsd: 0.04, projectPath: PATH })
    expect(out).toEqual([{ v: 1, k: 'other', t: T0 + 5_000, sessionId: SID, costUsd: 0.04 }])
  })

  it('a turn that settles without a cost reading is written at the deadline', () => {
    const core = createLedgerCore()
    core.usage(SID, T0, { costUsd: 0, projectPath: PATH })
    core.turnStarted(SID, T0 + 10, 't')
    core.usage(SID, T0 + 20, { costUsd: 0.01, projectPath: PATH })
    core.turnCompleted(SID, T0 + 500, {
      turnId: 't',
      durationMs: 400,
      reason: 'answer',
      usage: { model: 'm', ...tok(1, 1, 1, 1) }
    })
    expect(core.tick(T0 + 500 + COST_SETTLE_MS - 1)).toEqual([])
    const w = core.tick(T0 + 500 + COST_SETTLE_MS + 1)
    expect(turns(w)[0]).toMatchObject({ costUsd: 0.01, costBasis: 'measured' })
  })

  it('a session with no cost ledger writes costBasis none and a null cost', () => {
    const core = createLedgerCore()
    core.turnStarted(SID, T0, 't')
    core.turnCompleted(SID, T0 + 500, { turnId: 't', durationMs: 500, reason: 'answer' })
    const w = core.tick(T0 + 500 + COST_SETTLE_MS + 1)
    expect(turns(w)[0]).toMatchObject({ costUsd: null, costBasis: 'none' })
  })

  it('a cost that goes backwards is a reset: gap, new baseline, no delta', () => {
    const core = createLedgerCore()
    core.usage(SID, T0, { costUsd: 0, projectPath: PATH })
    core.usage(SID, T0 + 10, { costUsd: 1.5, projectPath: PATH })
    const out = core.usage(SID, T0 + 20, { costUsd: 0.2, projectPath: PATH })
    expect(out).toEqual([{ v: 1, k: 'gap', t: T0 + 20, sessionId: SID, why: 'cost-reset' }])
    expect(core.usage(SID, T0 + 30, { costUsd: 0.3, projectPath: PATH })).toEqual([
      expect.objectContaining({ k: 'other', costUsd: expect.closeTo(0.1, 9) })
    ])
  })

  it('a new main turn flushes the one still settling', () => {
    const core = createLedgerCore()
    core.usage(SID, T0, { costUsd: 0, projectPath: PATH })
    core.turnStarted(SID, T0 + 10, 'a')
    core.usage(SID, T0 + 20, { costUsd: 0.02, projectPath: PATH })
    core.turnCompleted(SID, T0 + 100, { turnId: 'a', durationMs: 90, reason: 'answer' })
    const out = core.turnStarted(SID, T0 + 300, 'b')
    expect(turns(out)).toHaveLength(1)
    expect(turns(out)[0]).toMatchObject({ turnId: 'a', costUsd: 0.02 })
  })

  it('lease loss, dropped events and a restart write a gap and forget the session', () => {
    const core = createLedgerCore()
    core.usage(SID, T0, { costUsd: 0, projectPath: PATH })
    expect(core.gap(SID, T0 + 5, 'lease-lost')).toEqual([
      { v: 1, k: 'gap', t: T0 + 5, sessionId: SID, why: 'lease-lost' }
    ])
    expect(core.hasState(SID)).toBe(false)
    // the next reading is a new baseline, never a delta against what was lost
    const out = core.usage(SID, T0 + 9, { costUsd: 3, projectPath: PATH })
    expect(out.map((r) => r.k)).toEqual(['open'])
    // a gap for a session the core never saw writes nothing
    expect(core.gap('unknown', T0, 'dropped')).toEqual([])
  })

  it('a session the previous boot already ledgered gets a host-restart gap first', () => {
    const core = createLedgerCore({ knownSids: new Set([SID]) })
    const out = core.usage(SID, T0, { costUsd: 0, projectPath: PATH })
    expect(out.map((r) => (r.k === 'gap' ? `gap:${r.why}` : r.k))).toEqual([
      'gap:host-restart',
      'open'
    ])
    expect(summarizeLedger(out).get(SID)?.covered).toBe(false)
  })

  it('a rebound closes the old session with its last cost', () => {
    const core = createLedgerCore()
    core.usage(SID, T0, { costUsd: 0, projectPath: PATH })
    core.usage(SID, T0 + 10, { costUsd: 0.5, projectPath: PATH })
    expect(core.close(SID, T0 + 20)).toEqual([
      { v: 1, k: 'close', t: T0 + 20, sessionId: SID, costAtClose: 0.5 }
    ])
    expect(core.hasState(SID)).toBe(false)
  })

  it('aux spend is named, counted once (AC-P1W6-27)', () => {
    const core = createLedgerCore()
    const out: TurnLedgerRecord[] = []
    out.push(...core.usage(SID, T0, { costUsd: 0, projectPath: PATH }))
    out.push(...core.aux(SID, T0 + 100, 'fork', tok(5, 50, 0, 900)))
    // the dollars of the same request arrive as a cost delta with no turn open
    out.push(...core.usage(SID, T0 + 200, { costUsd: 0.03, projectPath: PATH }))
    const aux = out.filter((r) => r.k === 'aux')
    const other = out.filter((r) => r.k === 'other')
    expect(aux).toEqual([
      {
        v: 1,
        k: 'aux',
        t: T0 + 100,
        sessionId: SID,
        kind: 'fork',
        tokens: { input: 5, output: 50, cacheRead: 0, cacheCreation: 900 }
      }
    ])
    expect(other).toHaveLength(1)
    // calibration sums USD from `turn` and `other` only: the aux record adds no dollars
    const total = [...measuredUsdByDay(out, SID).values()].reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(0.03, 9)
  })

  it('measured dollars per local day sum turn and other records only', () => {
    const { out } = replayD7()
    out.push(...createLedgerCore().aux(SID, T0, 'complete', tok(1, 1, 1, 1)))
    const total = [...measuredUsdByDay(out, SID).values()].reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(0.06216485, 8)
  })

  it('a gap anywhere uncovers the session', () => {
    const { out } = replayD7()
    out.push({ v: 1, k: 'gap', t: T0 + 20_000, sessionId: SID, why: 'dropped' })
    expect(summarizeLedger(out).get(SID)?.covered).toBe(false)
  })

  it('records carry ids, counts and dollars only', () => {
    const { out } = replayD7()
    for (const r of out) {
      const json = JSON.stringify(r)
      expect(json).not.toMatch(/prompt|"text"|content|conn|spawn/i)
    }
  })
})
