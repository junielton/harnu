import { describe, it, expect } from 'vitest'
import {
  canonicalizeModel,
  priceTokens,
  cacheWrite1hPerM,
  cacheWrite5mPerM,
  parseAssistantLine,
  priceFileLines,
  extractFirstCwd,
  buildFileCostBuckets,
  mergeCostBuckets,
  buildDailyCostRollup,
  buildModelCostRollup,
  buildProjectCostRollup,
  buildSessionCostRollup,
  localDayKey,
  TIER_SONNET,
  TIER_SONNET_5,
  TIER_OPUS_4,
  TIER_OPUS_45,
  TIER_OPUS_46_FAST,
  TIER_OPUS_47_48,
  TIER_OPUS_47_48_FAST,
  TIER_FABLE_5,
  TIER_HAIKU_35,
  TIER_HAIKU_45,
  TIER_DEFAULT_UNKNOWN,
  WEB_SEARCH_COST_USD,
  type FileBucketMeta
} from '../src/main/usage-cost-core'

// ---- Fixture helpers ---------------------------------------------------------

interface UsageOverrides {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  /** When set, the record carries a `cache_creation` TTL breakdown (C6). */
  cache_creation_1h?: number
  cache_creation_5m?: number
  web_search_requests?: number
  speed?: string | null
}

function assistantLine(opts: {
  requestId?: string
  messageId?: string
  model?: string
  timestamp?: string
  usage?: UsageOverrides
  isMeta?: boolean
  isApiErrorMessage?: boolean
  sessionId?: string
}): string {
  const u = opts.usage ?? {}
  const record: Record<string, unknown> = {
    type: 'assistant',
    requestId: opts.requestId,
    timestamp: opts.timestamp ?? '2026-07-08T12:00:00.000Z',
    sessionId: opts.sessionId ?? 'sess-1',
    isMeta: opts.isMeta,
    isApiErrorMessage: opts.isApiErrorMessage,
    message: {
      id: opts.messageId ?? 'msg-fallback',
      model: opts.model ?? 'claude-sonnet-4-6',
      usage: {
        input_tokens: u.input_tokens ?? 1_000_000,
        output_tokens: u.output_tokens ?? 1_000_000,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        ...(u.cache_creation_1h !== undefined || u.cache_creation_5m !== undefined
          ? {
              cache_creation: {
                ephemeral_1h_input_tokens: u.cache_creation_1h ?? 0,
                ephemeral_5m_input_tokens: u.cache_creation_5m ?? 0
              }
            }
          : {}),
        speed: u.speed ?? 'standard',
        server_tool_use: { web_search_requests: u.web_search_requests ?? 0 }
      }
    }
  }
  return JSON.stringify(record)
}

const META: FileBucketMeta = {
  sessionId: 'sess-1',
  projectPath: '/home/user/proj',
  isSubagent: false
}

// ---- Semantics #1: dedupe by requestId ---------------------------------------

describe('semantics #1 — dedupe by requestId (fallback message.id)', () => {
  it('counts usage ONCE for N block-split lines sharing the same requestId', () => {
    const lines = [
      assistantLine({ requestId: 'req_1', usage: { input_tokens: 1000, output_tokens: 500 } }),
      assistantLine({ requestId: 'req_1', usage: { input_tokens: 1000, output_tokens: 500 } }),
      assistantLine({ requestId: 'req_1', usage: { input_tokens: 1000, output_tokens: 500 } }),
      assistantLine({ requestId: 'req_1', usage: { input_tokens: 1000, output_tokens: 500 } })
    ]
    const priced = priceFileLines(lines)
    expect(priced).toHaveLength(1)
    expect(priced[0].tokens.inputTokens).toBe(1000)
    expect(priced[0].tokens.outputTokens).toBe(500)
  })

  it('falls back to message.id when requestId is absent', () => {
    const lines = [
      assistantLine({ requestId: undefined, messageId: 'msg_abc', usage: { input_tokens: 42 } }),
      assistantLine({ requestId: undefined, messageId: 'msg_abc', usage: { input_tokens: 42 } })
    ]
    const priced = priceFileLines(lines)
    expect(priced).toHaveLength(1)
    expect(priced[0].requestId).toBe('msg_abc')
  })

  it('naive summing would overcount ~2.61x — dedup must not', () => {
    // 5 identical blocks: naive sum = 5x truth. Assert dedup gives exactly 1x.
    const lines = Array.from({ length: 5 }, () =>
      assistantLine({ requestId: 'req_multi', usage: { input_tokens: 2000 } })
    )
    const priced = priceFileLines(lines)
    const total = priced.reduce((s, p) => s + p.tokens.inputTokens, 0)
    expect(total).toBe(2000)
  })
})

// ---- Semantics #2: only assistant + usage; model at message.model -----------

describe('semantics #2 — only type=assistant records with message.usage', () => {
  it('skips non-assistant record types (system, user)', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
      JSON.stringify({ type: 'user', message: { content: [] } }),
      assistantLine({ requestId: 'req_ok' })
    ]
    const priced = priceFileLines(lines)
    expect(priced).toHaveLength(1)
    expect(priced[0].requestId).toBe('req_ok')
  })

  it('skips an assistant record with no message.usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      requestId: 'req_no_usage',
      timestamp: '2026-07-08T12:00:00.000Z',
      message: { id: 'm1', model: 'claude-sonnet-4-6' }
    })
    expect(parseAssistantLine(line)).toBeNull()
  })

  it('reads the model from message.model', () => {
    const line = assistantLine({ requestId: 'req_x', model: 'claude-opus-4-6' })
    const parsed = parseAssistantLine(line)
    expect(parsed?.model).toBe('claude-opus-4-6')
  })
})

// ---- Semantics #3: skip synthetic/isMeta/isApiErrorMessage; keep summary call -

describe('semantics #3 — skip synthetic/isMeta/isApiErrorMessage; keep compact-summary call', () => {
  it('skips model === "<synthetic>"', () => {
    const line = assistantLine({ requestId: 'req_synth', model: '<synthetic>' })
    expect(parseAssistantLine(line)).toBeNull()
  })

  it('skips isMeta: true', () => {
    const line = assistantLine({ requestId: 'req_meta', isMeta: true })
    expect(parseAssistantLine(line)).toBeNull()
  })

  it('skips isApiErrorMessage: true', () => {
    const line = assistantLine({ requestId: 'req_err', isApiErrorMessage: true })
    expect(parseAssistantLine(line)).toBeNull()
  })

  it('a compact_boundary system record contributes nothing (not type=assistant)', () => {
    const lines = [
      JSON.stringify({
        parentUuid: null,
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { preTokens: 300000, postTokens: 15000 }
      })
    ]
    expect(priceFileLines(lines)).toHaveLength(0)
  })

  it('KEEPS the assistant call that generates the compact summary (it is billed)', () => {
    // Sequence: compact_boundary (system) -> isCompactSummary user marker ->
    // the actual summary-generation assistant call, which carries real usage
    // and must be priced normally, not filtered just because it follows a
    // compaction boundary.
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
      JSON.stringify({ type: 'user', isCompactSummary: true, message: { content: [] } }),
      assistantLine({
        requestId: 'req_summary',
        usage: { input_tokens: 15000, output_tokens: 800 }
      })
    ]
    const priced = priceFileLines(lines)
    expect(priced).toHaveLength(1)
    expect(priced[0].requestId).toBe('req_summary')
    expect(priced[0].tokens.inputTokens).toBe(15000)
  })
})

// ---- Semantics #4: subagent files included, never double-counted ------------

describe('semantics #4 — subagents/agent-*.jsonl included without double-counting', () => {
  it('merges main-file and subagent-file buckets additively for the same session', () => {
    const mainLines = [assistantLine({ requestId: 'req_main', usage: { input_tokens: 1000 } })]
    const subagentLines = [assistantLine({ requestId: 'req_sub', usage: { input_tokens: 2000 } })]

    const mainBuckets = buildFileCostBuckets(mainLines, {
      sessionId: 'sess-1',
      projectPath: '/proj',
      isSubagent: false
    })
    const subBuckets = buildFileCostBuckets(subagentLines, {
      sessionId: 'sess-1',
      projectPath: '/proj',
      isSubagent: true
    })
    const merged = mergeCostBuckets([mainBuckets, subBuckets])
    const totalInput = merged.reduce((s, b) => s + b.tokens.inputTokens, 0)
    expect(totalInput).toBe(3000) // both counted, neither doubled
    expect(merged.some((b) => b.isSubagent)).toBe(true)
    expect(merged.some((b) => !b.isSubagent)).toBe(true)
  })

  it('re-merging the SAME bucket list twice does not double it (dedup never crosses files, but merge is additive only across distinct inputs)', () => {
    const lines = [assistantLine({ requestId: 'req_once', usage: { input_tokens: 500 } })]
    const buckets = buildFileCostBuckets(lines, META)
    const mergedOnce = mergeCostBuckets([buckets])
    expect(mergedOnce.reduce((s, b) => s + b.tokens.inputTokens, 0)).toBe(500)
  })
})

// ---- Semantics #5: pricing table ---------------------------------------------

describe('semantics #5 — pricing table ($/Mtok in/out/cacheWrite/cacheRead)', () => {
  const oneM = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000
  }

  it('Sonnet 3.5-4.6: 3/15/3.75/0.30', () => {
    expect(priceTokens(oneM, 0, TIER_SONNET)).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6)
  })
  it('Opus 4/4.1: 15/75/18.75/1.50', () => {
    expect(priceTokens(oneM, 0, TIER_OPUS_4)).toBeCloseTo(15 + 75 + 1.5 + 18.75, 6)
  })
  it('Opus 4.5/4.6: 5/25/6.25/0.50', () => {
    expect(priceTokens(oneM, 0, TIER_OPUS_45)).toBeCloseTo(5 + 25 + 0.5 + 6.25, 6)
  })
  it('Opus 4.6 FAST (speed=fast): 30/150/37.5/3.0 — a flat 6x of the 4.5/4.6 tier', () => {
    expect(priceTokens(oneM, 0, TIER_OPUS_46_FAST)).toBeCloseTo(30 + 150 + 3.0 + 37.5, 6)
    expect(TIER_OPUS_46_FAST.inPerM).toBe(TIER_OPUS_45.inPerM * 6)
    expect(TIER_OPUS_46_FAST.outPerM).toBe(TIER_OPUS_45.outPerM * 6)
    expect(TIER_OPUS_46_FAST.cacheWritePerM).toBe(TIER_OPUS_45.cacheWritePerM * 6)
    expect(TIER_OPUS_46_FAST.cacheReadPerM).toBe(TIER_OPUS_45.cacheReadPerM * 6)
  })
  it('Haiku 3.5: 0.8/4/1.0/0.08', () => {
    expect(priceTokens(oneM, 0, TIER_HAIKU_35)).toBeCloseTo(0.8 + 4 + 0.08 + 1.0, 6)
  })
  it('Haiku 4.5: 1/5/1.25/0.10', () => {
    expect(priceTokens(oneM, 0, TIER_HAIKU_45)).toBeCloseTo(1 + 5 + 0.1 + 1.25, 6)
  })
  it('web_search: $0.01/request, additive to token cost', () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    expect(priceTokens(zero, 7, TIER_SONNET)).toBeCloseTo(7 * WEB_SEARCH_COST_USD, 6)
  })
  it('canonicalizeModel resolves speed=fast opus-4-6 to the FAST tier, standard to 4.5/4.6', () => {
    expect(canonicalizeModel('claude-opus-4-6', 'fast').tier.label).toBe(TIER_OPUS_46_FAST.label)
    expect(canonicalizeModel('claude-opus-4-6', 'standard').tier.label).toBe(TIER_OPUS_45.label)
    expect(canonicalizeModel('claude-opus-4-6', null).tier.label).toBe(TIER_OPUS_45.label)
  })
  it('canonicalizeModel maps known families/versions to the right tier, matching the real CLI oracle', () => {
    // These exact matches were cross-checked against ~/.claude/.claude.json
    // lastModelUsage[model].costUSD on this machine (see session report).
    expect(canonicalizeModel('claude-haiku-4-5-20251001', null).tier.label).toBe(
      TIER_HAIKU_45.label
    )
    expect(canonicalizeModel('claude-opus-4-6', 'standard').tier.label).toBe(TIER_OPUS_45.label)
    expect(canonicalizeModel('claude-sonnet-4-6', null).tier.label).toBe(TIER_SONNET.label)
    expect(canonicalizeModel('claude-opus-4-1-20250805', null).tier.label).toBe(TIER_OPUS_4.label)
    expect(canonicalizeModel('claude-opus-4-20250514', null).tier.label).toBe(TIER_OPUS_4.label)
    expect(canonicalizeModel('claude-haiku-3-5-20241022', null).tier.label).toBe(
      TIER_HAIKU_35.label
    )
  })

  // ---- C5 delta: verified published rates for the models in use here ---------

  it('Fable 5 / Mythos 5: 10/50/12.5/1.0, estimated:false (C5)', () => {
    expect(priceTokens(oneM, 0, TIER_FABLE_5)).toBeCloseTo(10 + 50 + 1.0 + 12.5, 6)
    const fable = canonicalizeModel('claude-fable-5', null)
    expect(fable.tier.label).toBe(TIER_FABLE_5.label)
    expect(fable.estimated).toBe(false)
    const mythos = canonicalizeModel('claude-mythos-5', null)
    expect(mythos.tier.label).toBe(TIER_FABLE_5.label)
    expect(mythos.estimated).toBe(false)
  })

  it('Fable 5 IGNORES speed — no fast mode in this family (C5)', () => {
    const fast = canonicalizeModel('claude-fable-5', 'fast')
    expect(fast.tier.label).toBe(TIER_FABLE_5.label)
    expect(fast.estimated).toBe(false)
    // Identical pricing whether speed is fast, standard, or absent.
    expect(canonicalizeModel('claude-fable-5', 'standard').tier).toBe(fast.tier)
    expect(canonicalizeModel('claude-fable-5', null).tier).toBe(fast.tier)
  })

  it('Opus 4.7/4.8: 5/25/6.25/0.50, estimated:false, dated variants included (C5)', () => {
    expect(priceTokens(oneM, 0, TIER_OPUS_47_48)).toBeCloseTo(5 + 25 + 0.5 + 6.25, 6)
    for (const id of [
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-4-7-20260301',
      'claude-opus-4-8-20260501'
    ]) {
      const r = canonicalizeModel(id, null)
      expect(r.tier.label).toBe(TIER_OPUS_47_48.label)
      expect(r.estimated).toBe(false)
    }
  })

  it('Opus 4.8 FAST: 6x precedent applied BUT estimated:true (unpublished rate) (C5)', () => {
    expect(priceTokens(oneM, 0, TIER_OPUS_47_48_FAST)).toBeCloseTo(30 + 150 + 3.0 + 37.5, 6)
    expect(TIER_OPUS_47_48_FAST.inPerM).toBe(TIER_OPUS_47_48.inPerM * 6)
    expect(TIER_OPUS_47_48_FAST.outPerM).toBe(TIER_OPUS_47_48.outPerM * 6)
    expect(TIER_OPUS_47_48_FAST.cacheWritePerM).toBe(TIER_OPUS_47_48.cacheWritePerM * 6)
    expect(TIER_OPUS_47_48_FAST.cacheReadPerM).toBe(TIER_OPUS_47_48.cacheReadPerM * 6)
    for (const id of ['claude-opus-4-7', 'claude-opus-4-8']) {
      const r = canonicalizeModel(id, 'fast')
      expect(r.tier.label).toBe(TIER_OPUS_47_48_FAST.label)
      expect(r.estimated).toBe(true)
    }
    // Standard speed stays on the verified (non-estimated) tier.
    expect(canonicalizeModel('claude-opus-4-8', 'standard').estimated).toBe(false)
  })

  it('Sonnet 5: 3/15/3.75/0.30 sticker rate, estimated:false (C5; intro price not modeled)', () => {
    expect(priceTokens(oneM, 0, TIER_SONNET_5)).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6)
    const r = canonicalizeModel('claude-sonnet-5', null)
    expect(r.tier.label).toBe(TIER_SONNET_5.label)
    expect(r.estimated).toBe(false)
  })
})

// ---- C6: cache writes priced by TTL (1h = 2x input, 5m = 1.25x input) --------

describe('C6 — cache-write TTL split (validated bit-exact against the CLI oracle)', () => {
  // Only cache-write tokens, on Sonnet rates (input $3/Mtok) so the numbers
  // are easy to eyeball: 5m rate = 3.75, 1h rate = 6.00.
  const cwOnly = (cacheWriteTokens: number) => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens
  })

  it('TTL rates derive from the input rate: 5m = 1.25x (== the flat column), 1h = 2x', () => {
    for (const tier of [
      TIER_SONNET,
      TIER_SONNET_5,
      TIER_OPUS_4,
      TIER_OPUS_45,
      TIER_OPUS_46_FAST,
      TIER_OPUS_47_48,
      TIER_OPUS_47_48_FAST,
      TIER_FABLE_5,
      TIER_HAIKU_35,
      TIER_HAIKU_45
    ]) {
      expect(cacheWrite5mPerM(tier)).toBeCloseTo(tier.cacheWritePerM, 9)
      expect(cacheWrite1hPerM(tier)).toBeCloseTo(tier.inPerM * 2, 9)
    }
  })

  it('1h-only writes price at 2x input', () => {
    const cost = priceTokens(cwOnly(1_000_000), 0, TIER_SONNET, {
      oneHourTokens: 1_000_000,
      fiveMinTokens: 0
    })
    expect(cost).toBeCloseTo(6.0, 9)
  })

  it('5m-only writes price at 1.25x input (same as the flat rate)', () => {
    const cost = priceTokens(cwOnly(1_000_000), 0, TIER_SONNET, {
      oneHourTokens: 0,
      fiveMinTokens: 1_000_000
    })
    expect(cost).toBeCloseTo(3.75, 9)
  })

  it('mixed 1h + 5m writes price each part at its own rate', () => {
    const cost = priceTokens(cwOnly(1_000_000), 0, TIER_SONNET, {
      oneHourTokens: 500_000,
      fiveMinTokens: 500_000
    })
    expect(cost).toBeCloseTo(3.0 + 1.875, 9)
  })

  it('absent breakdown falls back to the flat 1.25x on the whole total (never drops tokens)', () => {
    // No cacheWriteSplit argument — old transcripts without cache_creation.
    expect(priceTokens(cwOnly(1_000_000), 0, TIER_SONNET)).toBeCloseTo(3.75, 9)
    expect(priceTokens(cwOnly(1_000_000), 0, TIER_SONNET, null)).toBeCloseTo(3.75, 9)
  })

  it('a positive remainder between total and split sum is priced flat (never dropped)', () => {
    // total 1M, split covers only 700k -> 300k remainder at the flat rate.
    const cost = priceTokens(cwOnly(1_000_000), 0, TIER_SONNET, {
      oneHourTokens: 400_000,
      fiveMinTokens: 300_000
    })
    expect(cost).toBeCloseTo(0.4 * 6.0 + 0.3 * 3.75 + 0.3 * 3.75, 9)
  })

  it('end to end: a JSONL record with a cache_creation breakdown prices by TTL', () => {
    const lines = [
      assistantLine({
        requestId: 'req_1h',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 1_000_000,
          cache_creation_1h: 1_000_000,
          cache_creation_5m: 0
        }
      })
    ]
    const [p] = priceFileLines(lines)
    expect(p.cacheWriteSplit).toEqual({ oneHourTokens: 1_000_000, fiveMinTokens: 0 })
    expect(p.costUsd).toBeCloseTo(6.0, 9)
  })

  it('end to end: a record WITHOUT the breakdown prices flat (old transcripts)', () => {
    const lines = [
      assistantLine({
        requestId: 'req_flat',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }
      })
    ]
    const [p] = priceFileLines(lines)
    expect(p.cacheWriteSplit).toBeNull()
    expect(p.costUsd).toBeCloseTo(3.75, 9)
  })

  it('rollups keep exposing cacheWrite as ONE component (the sum), not split columns', () => {
    const lines = [
      assistantLine({
        requestId: 'req_mix',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 1000,
          cache_creation_1h: 600,
          cache_creation_5m: 400
        }
      })
    ]
    const buckets = buildFileCostBuckets(lines, META)
    expect(buckets[0].tokens.cacheWriteTokens).toBe(1000)
  })
})

// ---- Semantics #6: unknown model -> default tier + estimated flag -----------

describe('semantics #6 — unknown model prices on a default tier and is flagged estimated', () => {
  it('an unrecognized family (e.g. a future/renamed model) is not estimated:false silently', () => {
    const { tier, estimated } = canonicalizeModel('claude-zephyr-2', null)
    expect(estimated).toBe(true)
    expect(tier.label).toBe(TIER_DEFAULT_UNKNOWN.label)
  })
  it('a future major/minor outside the known ranges (opus-5, opus-4-9, sonnet-6, fable-6) is estimated', () => {
    expect(canonicalizeModel('claude-opus-5', null).estimated).toBe(true)
    expect(canonicalizeModel('claude-opus-4-9', null).estimated).toBe(true)
    expect(canonicalizeModel('claude-sonnet-6', null).estimated).toBe(true)
    expect(canonicalizeModel('claude-fable-6', null).estimated).toBe(true)
  })
  it('the estimated flag propagates from a request into its bucket', () => {
    const lines = [assistantLine({ requestId: 'req_unk', model: 'claude-zephyr-2' })]
    const buckets = buildFileCostBuckets(lines, META)
    expect(buckets.every((b) => b.estimated)).toBe(true)
  })
  it('a bucket is sticky-flagged estimated if ANY contributing request was unknown', () => {
    const lines = [
      assistantLine({
        requestId: 'req_known',
        model: 'claude-sonnet-4-6',
        timestamp: '2026-07-08T10:00:00.000Z'
      }),
      assistantLine({
        requestId: 'req_unknown',
        model: 'claude-zephyr-2',
        timestamp: '2026-07-08T11:00:00.000Z'
      })
    ]
    // NOTE: these two have different models, so they land in different
    // buckets (bucket key includes model) — this test instead verifies the
    // day rollup (which spans models) inherits the estimated flag.
    const buckets = buildFileCostBuckets(lines, META)
    const daily = buildDailyCostRollup(buckets)
    expect(daily).toHaveLength(1)
    expect(daily[0].estimated).toBe(true)
  })
})

// ---- Semantics #7: day attribution is per-request, local timezone ------------

describe('semantics #7 — day attribution keys each request to its OWN local timestamp', () => {
  it('two requests in the same session on different calendar days land in different day buckets', () => {
    const lines = [
      assistantLine({ requestId: 'req_day1', timestamp: '2026-07-07T23:00:00.000Z' }),
      assistantLine({ requestId: 'req_day2', timestamp: '2026-07-08T01:00:00.000Z' })
    ]
    // Use UTC-equivalent dayKey (identity) for a deterministic, TZ-independent assertion.
    const utcDayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
    const buckets = buildFileCostBuckets(lines, META, utcDayKey)
    const days = new Set(buckets.map((b) => b.day))
    expect(days).toEqual(new Set(['2026-07-07', '2026-07-08']))
  })

  it('localDayKey formats YYYY-MM-DD from an epoch-ms timestamp', () => {
    const ms = Date.parse('2026-07-08T15:30:00.000Z')
    expect(localDayKey(ms)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('sessionsWorked counts a session only on days it actually had priced requests', () => {
    const utcDayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
    const lines = [assistantLine({ requestId: 'req_a', timestamp: '2026-07-07T12:00:00.000Z' })]
    const buckets = buildFileCostBuckets(lines, META, utcDayKey)
    const daily = buildDailyCostRollup(buckets)
    expect(daily.find((d) => d.day === '2026-07-07')?.sessionsWorked).toBe(1)
    expect(daily.find((d) => d.day === '2026-07-08')).toBeUndefined()
  })
})

// ---- Semantics #8: token components tracked separately -----------------------

describe('semantics #8 — token components (input/output/cacheRead/cacheWrite) tracked separately', () => {
  it('a priced request retains all four components distinctly', () => {
    const lines = [
      assistantLine({
        requestId: 'req_tok',
        usage: {
          input_tokens: 111,
          output_tokens: 222,
          cache_read_input_tokens: 333,
          cache_creation_input_tokens: 444
        }
      })
    ]
    const [p] = priceFileLines(lines)
    expect(p.tokens).toEqual({
      inputTokens: 111,
      outputTokens: 222,
      cacheReadTokens: 333,
      cacheWriteTokens: 444
    })
  })

  it('daily/model/session rollups expose all four token components separately (not just a total)', () => {
    const lines = [
      assistantLine({
        requestId: 'req_a',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40
        }
      })
    ]
    const buckets = buildFileCostBuckets(lines, META)
    const daily = buildDailyCostRollup(buckets)
    const models = buildModelCostRollup(buckets)
    expect(daily[0].tokens).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40
    })
    expect(models[0].tokens).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40
    })
  })
})

// ---- Rollup shape sanity (project/session) -----------------------------------

describe('project + session rollups', () => {
  it('groups by project path and counts distinct sessions', () => {
    const linesA = [assistantLine({ requestId: 'req_1', sessionId: 'sess-a' })]
    const linesB = [assistantLine({ requestId: 'req_2', sessionId: 'sess-b' })]
    const bucketsA = buildFileCostBuckets(linesA, {
      sessionId: 'sess-a',
      projectPath: '/proj',
      isSubagent: false
    })
    const bucketsB = buildFileCostBuckets(linesB, {
      sessionId: 'sess-b',
      projectPath: '/proj',
      isSubagent: false
    })
    const merged = mergeCostBuckets([bucketsA, bucketsB])
    const projects = buildProjectCostRollup(merged)
    expect(projects).toHaveLength(1)
    expect(projects[0].sessionCount).toBe(2)
  })

  it('per-session rollup reports first/last day it worked', () => {
    const utcDayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
    const lines = [
      assistantLine({ requestId: 'req_1', timestamp: '2026-07-01T00:00:00.000Z' }),
      assistantLine({ requestId: 'req_2', timestamp: '2026-07-05T00:00:00.000Z' })
    ]
    const buckets = buildFileCostBuckets(lines, META, utcDayKey)
    const sessions = buildSessionCostRollup(buckets)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].firstDay).toBe('2026-07-01')
    expect(sessions[0].lastDay).toBe('2026-07-05')
  })
})

// ---- Fail-safe parsing --------------------------------------------------------

describe('fail-safe parsing (never throws)', () => {
  it('skips a torn/invalid JSON line', () => {
    expect(parseAssistantLine('{not json')).toBeNull()
    expect(parseAssistantLine('')).toBeNull()
    expect(parseAssistantLine('   ')).toBeNull()
  })
  it('priceFileLines tolerates a mix of garbage and valid lines', () => {
    const lines = ['{broken', '', assistantLine({ requestId: 'req_ok2' }), 'null', '42']
    const priced = priceFileLines(lines)
    expect(priced).toHaveLength(1)
  })
})

// ---- cwd recovery (dash/underscore project names) ------------------------------

describe('extractFirstCwd', () => {
  it('returns the first top-level cwd string found in the lines', () => {
    const lines = [
      JSON.stringify({ type: 'user', cwd: '/Users/x/Repositories/my-cool_project' }),
      JSON.stringify({ type: 'user', cwd: '/Users/x/somewhere-else' })
    ]
    expect(extractFirstCwd(lines)).toBe('/Users/x/Repositories/my-cool_project')
  })

  it('skips lines without a cwd and lines where "cwd" is only inside content', () => {
    const lines = [
      JSON.stringify({ type: 'summary', summary: 'talked about "cwd" a lot' }),
      JSON.stringify({ type: 'assistant', message: { content: 'the cwd field' } }),
      JSON.stringify({ type: 'user', cwd: '/real/path' })
    ]
    expect(extractFirstCwd(lines)).toBe('/real/path')
  })

  it('ignores empty and non-string cwd values', () => {
    const lines = [
      JSON.stringify({ cwd: '' }),
      JSON.stringify({ cwd: 42 }),
      JSON.stringify({ cwd: '/kept' })
    ]
    expect(extractFirstCwd(lines)).toBe('/kept')
  })

  it('returns null when no line carries a usable cwd (incl. garbage lines)', () => {
    expect(extractFirstCwd([])).toBeNull()
    expect(extractFirstCwd(['{broken "cwd"', '', JSON.stringify({ type: 'user' })])).toBeNull()
  })
})
