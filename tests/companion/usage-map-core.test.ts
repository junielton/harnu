import { describe, expect, it } from 'vitest'
import { mapTurnCompleted, mapUsageMeasured } from '../../src/main/companion/ingest/usage-map-core'
import { parseStatusLineBlob } from '../../src/main/statusline-parse'

/** Smoke A3 (docs/studies/T389-smoke-evidence.md): the mod's reading and the statusLine blob. */
const FIVE_ISO = '2026-10-02T18:00:00.000Z'
const SEVEN_ISO = '2026-10-05T19:00:00.000Z'
const A3_WIRE = {
  source: 'measure',
  context: { window: 200000, tokens: 37302, percent: 19 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 21, resetsAt: FIVE_ISO },
    { kind: 'seven_day', percentUsed: 54, resetsAt: SEVEN_ISO }
  ],
  costUsd: 0.0185783,
  changed: ['context', 'cost']
}
const A3_BLOB = JSON.stringify({
  session_id: 'sess-a3',
  cost: { total_cost_usd: 0.0185783 },
  context_window: {
    total_input_tokens: 37302,
    context_window_size: 200000,
    used_percentage: 19
  },
  rate_limits: {
    five_hour: { used_percentage: 21, resets_at: Date.parse(FIVE_ISO) / 1000 },
    seven_day: { used_percentage: 54, resets_at: Date.parse(SEVEN_ISO) / 1000 }
  }
})
const AT = 1_790_000_000_000

describe('usage map (AC-P1W6-3)', () => {
  it('equals the statusLine figures', () => {
    const sl = parseStatusLineBlob(A3_BLOB, AT)!
    const m = mapUsageMeasured(A3_WIRE, AT, '/tmp/example-project')!
    expect(m.part.cost?.usd).toBe(sl.costUsd)
    expect(m.part.context?.percent).toBe(sl.contextPercent)
    expect(m.part.context?.window).toBe(sl.contextWindowSize)
    expect(m.part.rateLimits?.fiveHour).toEqual(sl.rateLimits.fiveHour)
    expect(m.part.rateLimits?.sevenDay).toEqual(sl.rateLimits.sevenDay)
    expect(m.part.rateLimits?.fiveHour?.resetsAtMs).toBe(Date.parse(FIVE_ISO))
    expect(m.part.cwd).toBe('/tmp/example-project')
  })

  it('stamps every group with the host receive time, never the mod clock', () => {
    const m = mapUsageMeasured({ ...A3_WIRE }, AT, null)!
    expect(m.part.cost?.atMs).toBe(AT)
    expect(m.part.context?.atMs).toBe(AT)
    expect(m.part.rateLimits?.atMs).toBe(AT)
  })

  it('a window-only context is not a reading of the context group (smoke A3)', () => {
    const m = mapUsageMeasured(
      { ...A3_WIRE, context: { window: 200000 }, rateLimits: [] },
      AT,
      null
    )!
    expect(m.part.context).toBeUndefined()
    expect(m.tokens).toBeNull()
  })

  it('an empty rateLimits list is not a reading (smoke A2: the resume handshake)', () => {
    const m = mapUsageMeasured({ ...A3_WIRE, rateLimits: [] }, AT, null)!
    expect(m.part.rateLimits).toBeUndefined()
    expect(m.part.cost?.usd).toBe(0.0185783)
  })

  it('maps five_hour and seven_day, records spend_limit, ignores the rest', () => {
    const m = mapUsageMeasured(
      {
        ...A3_WIRE,
        rateLimits: [
          { kind: 'seven_day', percentUsed: 54, resetsAt: SEVEN_ISO },
          { kind: 'spend_limit', percentUsed: 101, resetsAt: SEVEN_ISO },
          { kind: 'something_new', percentUsed: 5 }
        ]
      },
      AT,
      null
    )!
    expect(m.part.rateLimits).toEqual({
      fiveHour: null,
      sevenDay: { usedPercent: 54, resetsAtMs: Date.parse(SEVEN_ISO) },
      atMs: AT
    })
    expect(m.spendLimit).toEqual({ percentUsed: 101, resetsAtMs: Date.parse(SEVEN_ISO) })
  })

  it('only unknown kinds is no reading at all', () => {
    const m = mapUsageMeasured(
      { ...A3_WIRE, rateLimits: [{ kind: 'something_new', percentUsed: 5 }] },
      AT,
      null
    )!
    expect(m.part.rateLimits).toBeUndefined()
  })

  it('clamps percentUsed to [0, 1000] and rejects non-finite numbers (SEC-3c)', () => {
    const m = mapUsageMeasured(
      {
        ...A3_WIRE,
        costUsd: Number.NaN,
        context: { window: 200000, tokens: Infinity, percent: 250 },
        rateLimits: [
          { kind: 'five_hour', percentUsed: 5000, resetsAt: FIVE_ISO },
          { kind: 'seven_day', percentUsed: -3, resetsAt: 'not a date' }
        ]
      },
      AT,
      null
    )!
    expect(m.part.cost).toBeUndefined()
    expect(m.part.context).toEqual({ percent: 100, window: 200000, atMs: AT })
    expect(m.part.rateLimits?.fiveHour?.usedPercent).toBe(1000)
    expect(m.part.rateLimits?.sevenDay).toEqual({ usedPercent: 0, resetsAtMs: null })
  })

  it('a malformed payload maps to null and never throws', () => {
    for (const bad of [null, undefined, 3, 'x', [], { rateLimits: 'x', context: 5, costUsd: {} }]) {
      expect(() => mapUsageMeasured(bad, AT, null)).not.toThrow()
    }
    expect(mapUsageMeasured(null, AT, null)).toBeNull()
    const junk = mapUsageMeasured({ rateLimits: 'x', context: 5, costUsd: {} }, AT, null)
    expect(junk?.part.cost).toBeUndefined()
    expect(junk?.part.context).toBeUndefined()
    expect(junk?.part.rateLimits).toBeUndefined()
  })

  it('a negative cost is rejected', () => {
    expect(mapUsageMeasured({ ...A3_WIRE, costUsd: -1 }, AT, null)!.part.cost).toBeUndefined()
  })

  it('carries the read-only extras for the ledger: source, startedAt and model', () => {
    const m = mapUsageMeasured({ ...A3_WIRE, source: 'read', startedAt: 5, model: 'm' }, AT, null)!
    expect(m.source).toBe('read')
    expect(m.startedAt).toBe(5)
    expect(m.model).toBe('m')
    expect(m.tokens).toBe(37302)
  })
})

describe('turn.completed mapping (spec P1W6 §7.5)', () => {
  const D7_TURN = {
    reason: 'answer',
    isAborted: false,
    durationMs: 7246,
    usage: {
      inputTokens: 18,
      outputTokens: 262,
      cacheReadTokens: 49303,
      cacheCreationTokens: 14155,
      model: 'claude-haiku-4-5-20251001'
    }
  }

  it('maps the smoke D7 turn', () => {
    expect(mapTurnCompleted(D7_TURN)).toEqual({
      reason: 'answer',
      durationMs: 7246,
      usage: D7_TURN.usage
    })
  })

  it('an error turn carries no usage and says so', () => {
    const m = mapTurnCompleted({
      reason: 'error',
      isAborted: false,
      durationMs: 800,
      failure: { type: 'api_error' }
    })!
    expect(m.usage).toBeUndefined()
    expect(m.failure).toEqual({ type: 'api_error' })
  })

  it('refuses non-finite or negative figures and unsafe model names (SEC-3c)', () => {
    expect(
      mapTurnCompleted({ ...D7_TURN, usage: { ...D7_TURN.usage, inputTokens: -1 } })!.usage
    ).toBeUndefined()
    expect(
      mapTurnCompleted({ ...D7_TURN, usage: { ...D7_TURN.usage, outputTokens: Infinity } })!.usage
    ).toBeUndefined()
    expect(
      mapTurnCompleted({ ...D7_TURN, usage: { ...D7_TURN.usage, model: 'x'.repeat(200) } })!.usage
    ).toBeUndefined()
    expect(mapTurnCompleted({ ...D7_TURN, durationMs: Number.NaN })!.durationMs).toBe(0)
    expect(mapTurnCompleted(null)).toBeNull()
    expect(mapTurnCompleted('x')).toBeNull()
  })
})
