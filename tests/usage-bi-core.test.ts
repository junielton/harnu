import { describe, it, expect } from 'vitest'
import {
  buildFileAnatomySignals,
  buildSessionAnatomy,
  buildDailyModelBreakdown,
  enrichWindows,
  projectWindowPeak,
  contextWindowFor,
  CONTEXT_WINDOW_DEFAULT,
  CONTEXT_WINDOW_1M,
  type FileAnatomySignals,
  type SessionHourlyPoint
} from '../src/main/usage-bi-core'
import type { CostBucket } from '../src/main/usage-cost-core'
import type { WindowRecord } from '../src/main/usage-history-core'

// ---- Fixture helpers ---------------------------------------------------------

function assistantLine(opts: {
  requestId: string
  model?: string
  timestamp?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: opts.requestId,
    timestamp: opts.timestamp ?? '2026-07-08T12:00:00.000Z',
    message: {
      id: `msg-${opts.requestId}`,
      model: opts.model ?? 'claude-sonnet-4-6',
      usage: {
        input_tokens: opts.inputTokens ?? 1000,
        output_tokens: opts.outputTokens ?? 500,
        cache_read_input_tokens: opts.cacheReadTokens ?? 0,
        cache_creation_input_tokens: opts.cacheWriteTokens ?? 0
      }
    }
  })
}

function userLine(opts: {
  content: unknown
  timestamp?: string
  isMeta?: boolean
  isSidechain?: boolean
}): string {
  return JSON.stringify({
    type: 'user',
    timestamp: opts.timestamp ?? '2026-07-08T12:00:00.000Z',
    isMeta: opts.isMeta,
    isSidechain: opts.isSidechain,
    message: { role: 'user', content: opts.content }
  })
}

function customTitleLine(customTitle: string): string {
  return JSON.stringify({ type: 'custom-title', customTitle })
}
function aiTitleLine(aiTitle: string): string {
  return JSON.stringify({ type: 'ai-title', aiTitle })
}

const META = { sessionId: 'sess-1', isSubagent: false }
const SUB_META = { sessionId: 'sess-1', isSubagent: true }

// ---- Turn counting (part A "turns") ------------------------------------------

describe('buildFileAnatomySignals — real-user-turn counting', () => {
  it('counts a plain string-content user record as a turn', () => {
    const s = buildFileAnatomySignals([userLine({ content: 'hello there' })], META)
    expect(s.turns).toBe(1)
    expect(s.firstUserText).toBe('hello there')
  })

  it('EXCLUDES a tool_result-only user record (not something the human typed)', () => {
    const lines = [
      userLine({ content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] })
    ]
    const s = buildFileAnatomySignals(lines, META)
    expect(s.turns).toBe(0)
  })

  it('counts a mixed array (text + tool_result) as one real turn', () => {
    const lines = [
      userLine({
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: 'ok' },
          { type: 'text', text: 'and also this' }
        ]
      })
    ]
    const s = buildFileAnatomySignals(lines, META)
    expect(s.turns).toBe(1)
    expect(s.firstUserText).toBe('and also this')
  })

  it('excludes isMeta user records', () => {
    const s = buildFileAnatomySignals(
      [userLine({ content: 'a system-injected message', isMeta: true })],
      META
    )
    expect(s.turns).toBe(0)
  })

  it('excludes isSidechain user records', () => {
    const s = buildFileAnatomySignals(
      [userLine({ content: 'a subagent-visible turn', isSidechain: true })],
      META
    )
    expect(s.turns).toBe(0)
  })

  it('excludes an empty-string content turn', () => {
    const s = buildFileAnatomySignals([userLine({ content: '' })], META)
    expect(s.turns).toBe(0)
  })

  it('a subagent file NEVER contributes turns, even with real user content', () => {
    const s = buildFileAnatomySignals([userLine({ content: 'a subagent task prompt' })], SUB_META)
    expect(s.turns).toBe(0)
    expect(s.firstUserText).toBe('')
  })

  it('keeps only the FIRST real user text as the title fallback candidate', () => {
    const lines = [userLine({ content: 'first' }), userLine({ content: 'second' })]
    const s = buildFileAnatomySignals(lines, META)
    expect(s.turns).toBe(2)
    expect(s.firstUserText).toBe('first')
  })
})

// ---- Title markers ------------------------------------------------------------

describe('buildFileAnatomySignals — title markers (main file only)', () => {
  it('the LATEST custom-title / ai-title wins', () => {
    const lines = [customTitleLine('First name'), customTitleLine('Renamed again')]
    const s = buildFileAnatomySignals(lines, META)
    expect(s.customTitle).toBe('Renamed again')
  })

  it('a subagent file never contributes title markers', () => {
    const s = buildFileAnatomySignals(
      [customTitleLine('should not count'), aiTitleLine('nope')],
      SUB_META
    )
    expect(s.customTitle).toBe('')
    expect(s.aiTitle).toBe('')
  })
})

// ---- Timestamps span --------------------------------------------------------

describe('buildFileAnatomySignals — min/max timestamps span ALL record types', () => {
  it('spans user + assistant + title records, not just priced assistant ones', () => {
    const lines = [
      userLine({ content: 'start', timestamp: '2026-07-08T10:00:00.000Z' }),
      assistantLine({ requestId: 'r1', timestamp: '2026-07-08T10:05:00.000Z' }),
      customTitleLine('renamed') // no timestamp field -> ignored for span
    ]
    const s = buildFileAnatomySignals(lines, META)
    expect(s.minTs).toBe(Date.parse('2026-07-08T10:00:00.000Z'))
    expect(s.maxTs).toBe(Date.parse('2026-07-08T10:05:00.000Z'))
  })

  it('subagent files still contribute to min/max span', () => {
    const s = buildFileAnatomySignals(
      [assistantLine({ requestId: 'r1', timestamp: '2026-07-08T11:00:00.000Z' })],
      SUB_META
    )
    expect(s.minTs).toBe(Date.parse('2026-07-08T11:00:00.000Z'))
    expect(s.maxTs).toBe(Date.parse('2026-07-08T11:00:00.000Z'))
  })
})

// ---- Peak context % ----------------------------------------------------------

describe('contextWindowFor', () => {
  it('defaults to 200k', () => {
    expect(contextWindowFor('claude-sonnet-4-6')).toBe(CONTEXT_WINDOW_DEFAULT)
  })
  it('is 1M when the model id carries the [1m] marker', () => {
    expect(contextWindowFor('claude-sonnet-4-6[1m]')).toBe(CONTEXT_WINDOW_1M)
  })
})

describe('buildFileAnatomySignals — peakContextRatio', () => {
  it('is (input + cache-write + cache-read) / window, MAX over deduped requests, output excluded', () => {
    const lines = [
      assistantLine({
        requestId: 'r1',
        inputTokens: 50_000,
        outputTokens: 900_000, // must NOT count toward context
        cacheReadTokens: 30_000,
        cacheWriteTokens: 20_000
      }),
      assistantLine({ requestId: 'r2', inputTokens: 1000 }) // much smaller — not the peak
    ]
    const s = buildFileAnatomySignals(lines, META)
    // (50000 + 20000 + 30000) / 200000 = 0.5
    expect(s.peakContextRatio).toBeCloseTo(0.5, 10)
  })

  it('a subagent file never contributes peakContextRatio', () => {
    const s = buildFileAnatomySignals(
      [assistantLine({ requestId: 'r1', inputTokens: 199_000 })],
      SUB_META
    )
    expect(s.peakContextRatio).toBe(0)
  })
})

// ---- Hourly cutoff (90-day cap) ----------------------------------------------

describe('buildFileAnatomySignals — hourlyCutoffMs caps stored hourly detail', () => {
  it('drops a priced request older than the cutoff from `hourly`, but still prices it into tokens/cost', () => {
    const oldTs = Date.parse('2026-01-01T00:00:00.000Z')
    const lines = [assistantLine({ requestId: 'r_old', timestamp: '2026-01-01T00:00:00.000Z' })]
    const cutoff = oldTs + 1 // cutoff strictly after the request's timestamp
    const s = buildFileAnatomySignals(lines, META, cutoff)
    expect(s.hourly).toHaveLength(0)
    expect(s.requestCount).toBe(1) // still counted for cost/tokens
  })

  it('keeps a request at/after the cutoff in `hourly`', () => {
    const lines = [assistantLine({ requestId: 'r_new', timestamp: '2026-07-08T12:00:00.000Z' })]
    const cutoff = Date.parse('2026-01-01T00:00:00.000Z')
    const s = buildFileAnatomySignals(lines, META, cutoff)
    expect(s.hourly).toHaveLength(1)
  })
})

// ---- Session anatomy merge ---------------------------------------------------

describe('buildSessionAnatomy', () => {
  function anatomyOf(overrides: Partial<FileAnatomySignals>): FileAnatomySignals {
    return {
      sessionId: 'sess-1',
      isSubagent: false,
      minTs: null,
      maxTs: null,
      turns: 0,
      customTitle: '',
      aiTitle: '',
      firstUserText: '',
      peakContextRatio: 0,
      requestCount: 0,
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costByModel: {},
      estimated: false,
      hourly: [],
      ...overrides
    }
  }

  it('title cascade: custom-title > ai-title > first-user-text > uuid prefix', () => {
    const withCustom = buildSessionAnatomy(
      [anatomyOf({ customTitle: 'Renamed', aiTitle: 'Auto', firstUserText: 'hi' })],
      { sessionId: 'abcdef12-uuid', projectPath: '/p', subagentCount: 0 }
    )
    expect(withCustom.title).toBe('Renamed')

    const withAi = buildSessionAnatomy([anatomyOf({ aiTitle: 'Auto', firstUserText: 'hi' })], {
      sessionId: 'abcdef12-uuid',
      projectPath: '/p',
      subagentCount: 0
    })
    expect(withAi.title).toBe('Auto')

    const withFirstText = buildSessionAnatomy([anatomyOf({ firstUserText: 'hello world' })], {
      sessionId: 'abcdef12-uuid',
      projectPath: '/p',
      subagentCount: 0
    })
    expect(withFirstText.title).toBe('hello world')

    const withNothing = buildSessionAnatomy([anatomyOf({})], {
      sessionId: 'abcdef12-uuid',
      projectPath: '/p',
      subagentCount: 0
    })
    expect(withNothing.title).toBe('abcdef12')
  })

  it('truncates a long first-user-text title to 64 chars', () => {
    const longText = 'x'.repeat(200)
    const s = buildSessionAnatomy([anatomyOf({ firstUserText: longText })], {
      sessionId: 'sess-1',
      projectPath: '/p',
      subagentCount: 0
    })
    expect(s.title.length).toBeLessThanOrEqual(65) // 64 + ellipsis char
  })

  it('merges main + subagent files: turns/title/peakContext from main only; tokens/cost/span from all', () => {
    const main = anatomyOf({
      minTs: 1000,
      maxTs: 2000,
      turns: 3,
      customTitle: 'My session',
      peakContextRatio: 0.4,
      requestCount: 2,
      tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costByModel: { 'claude-sonnet-4-6': 0.01 }
    })
    const sub = anatomyOf({
      isSubagent: true,
      minTs: 500, // earlier than main — should still widen the span
      maxTs: 2500, // later than main — should still widen the span
      turns: 99, // must be ignored (subagent turns don't count)
      customTitle: 'should be ignored',
      peakContextRatio: 0.9, // must be ignored
      requestCount: 5,
      tokens: { inputTokens: 900, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costByModel: { 'claude-haiku-4-5': 0.02 }
    })

    const s = buildSessionAnatomy([main, sub], {
      sessionId: 'sess-1',
      projectPath: '/home/user/proj',
      subagentCount: 1
    })

    expect(s.startedAtMs).toBe(500)
    expect(s.endedAtMs).toBe(2500)
    expect(s.durationMs).toBe(2000)
    expect(s.turns).toBe(3) // main-only
    expect(s.title).toBe('My session')
    expect(s.peakContextPct).toBe(40) // main-only, rounded
    expect(s.requestCount).toBe(7) // 2 + 5, additive across files
    expect(s.tokens.inputTokens).toBe(1000) // 100 + 900
    expect(s.subagentCount).toBe(1)
    expect(s.costByModel).toEqual({ 'claude-sonnet-4-6': 0.01, 'claude-haiku-4-5': 0.02 })
    expect(s.costUsd).toBeCloseTo(0.03, 10)
  })
})

// ---- Daily model breakdown ---------------------------------------------------

describe('buildDailyModelBreakdown', () => {
  function bucket(overrides: Partial<CostBucket>): CostBucket {
    return {
      day: '2026-07-08',
      model: 'claude-sonnet-4-6',
      tierLabel: 'sonnet-3.5-4.6',
      estimated: false,
      projectPath: '/p',
      sessionId: 's1',
      isSubagent: false,
      requestCount: 1,
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      webSearchRequests: 0,
      costUsd: 0,
      ...overrides
    }
  }

  it('picks the highest-cost model as dominant, per day', () => {
    const buckets = [
      bucket({ day: '2026-07-08', model: 'claude-sonnet-4-6', costUsd: 5 }),
      bucket({ day: '2026-07-08', model: 'claude-opus-4-6', costUsd: 12 }),
      bucket({ day: '2026-07-09', model: 'claude-haiku-4-5', costUsd: 1 })
    ]
    const days = buildDailyModelBreakdown(buckets)
    expect(days).toHaveLength(2)
    expect(days[0].day).toBe('2026-07-08')
    expect(days[0].dominantModel).toBe('claude-opus-4-6')
    expect(days[0].costByModel).toEqual({ 'claude-sonnet-4-6': 5, 'claude-opus-4-6': 12 })
    expect(days[1].dominantModel).toBe('claude-haiku-4-5')
  })
})

// ---- Window enrichment --------------------------------------------------------

describe('enrichWindows', () => {
  const window: WindowRecord = {
    kind: 'fiveHour',
    resetsAtMs: 20_000,
    startedAtMs: 10_000,
    peakPct: 80,
    partial: false,
    closedAtMs: 20_000
  }

  function point(overrides: Partial<SessionHourlyPoint>): SessionHourlyPoint {
    return {
      hourStartMs: 10_000,
      model: 'claude-sonnet-4-6',
      sessionId: 's1',
      costUsd: 1,
      ...overrides
    }
  }

  it('a bucket whose hour-start is inside [startedAtMs, resetsAtMs) is attributed to the window', () => {
    const [w] = enrichWindows([window], [point({ hourStartMs: 15_000, costUsd: 3 })])
    expect(w.costDeltaUsd).toBe(3)
  })

  it('a bucket whose hour-start equals resetsAtMs is EXCLUDED (half-open interval)', () => {
    const [w] = enrichWindows([window], [point({ hourStartMs: 20_000, costUsd: 5 })])
    expect(w.costDeltaUsd).toBe(0)
  })

  it('a bucket whose hour-start equals startedAtMs is INCLUDED (half-open interval)', () => {
    const [w] = enrichWindows([window], [point({ hourStartMs: 10_000, costUsd: 2 })])
    expect(w.costDeltaUsd).toBe(2)
  })

  it('a bucket before startedAtMs is excluded', () => {
    const [w] = enrichWindows([window], [point({ hourStartMs: 9_999, costUsd: 7 })])
    expect(w.costDeltaUsd).toBe(0)
  })

  it('ranks top 5 sessions by cost and reports the dominant model', () => {
    const points = [
      point({ sessionId: 's1', costUsd: 10, model: 'claude-opus-4-6' }),
      point({ sessionId: 's2', costUsd: 50, model: 'claude-sonnet-4-6' }),
      point({ sessionId: 's3', costUsd: 5, model: 'claude-sonnet-4-6' }),
      point({ sessionId: 's4', costUsd: 3 }),
      point({ sessionId: 's5', costUsd: 2 }),
      point({ sessionId: 's6', costUsd: 1 }) // 6th session — should be dropped from top 5
    ]
    const [w] = enrichWindows([window], points, new Map([['s2', 'My session']]))
    expect(w.sessionsActive).toHaveLength(5)
    expect(w.sessionsActive[0]).toEqual({ sessionId: 's2', title: 'My session', costUsd: 50 })
    expect(w.sessionsActive.some((s) => s.sessionId === 's6')).toBe(false)
    expect(w.dominantModel).toBe('claude-sonnet-4-6') // 50 + 5 = 55 > opus's 10
  })

  it('dominantModel is null when the window has no priced cost', () => {
    const [w] = enrichWindows([window], [])
    expect(w.dominantModel).toBeNull()
    expect(w.sessionsActive).toHaveLength(0)
  })
})

// ---- Window-peak projection ---------------------------------------------------

describe('projectWindowPeak', () => {
  it('returns null when resetsAtMs is null', () => {
    expect(projectWindowPeak(50, null, 1000)).toBeNull()
  })

  it('projects linearly from the elapsed fraction', () => {
    // 5h window, 13% used at 28% elapsed -> ~46.4%
    const durationMs = 5 * 3600_000
    const resetsAtMs = 100_000 + durationMs
    const nowMs = 100_000 + durationMs * 0.28
    const pct = projectWindowPeak(13, resetsAtMs, nowMs, durationMs)
    expect(pct).not.toBeNull()
    expect(pct as number).toBeCloseTo(13 / 0.28, 5)
  })

  it('returns the current pct unprojected when under 10% elapsed (too noisy)', () => {
    const durationMs = 5 * 3600_000
    const resetsAtMs = 100_000 + durationMs
    const nowMs = 100_000 + durationMs * 0.05
    expect(projectWindowPeak(10, resetsAtMs, nowMs, durationMs)).toBe(10)
  })

  it('returns the current pct when elapsed <= 0 (clock skew / not yet started)', () => {
    const durationMs = 5 * 3600_000
    const resetsAtMs = 200_000 + durationMs
    expect(projectWindowPeak(7, resetsAtMs, 100_000, durationMs)).toBe(7)
  })
})
