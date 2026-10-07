import { describe, it, expect } from 'vitest'
import {
  parseStatusLineBlob,
  foldFleetTelemetry,
  type SessionTelemetry
} from '../src/main/statusline-parse'

// A fixed "now" (epoch ms) so TTL / recency math is deterministic.
const NOW = 1_700_000_000_000
// resets_at arrives on the wire as epoch SECONDS.
const RESET_5H_S = 1_700_003_600 // +1h
const RESET_7D_S = 1_700_600_000

const FULL = JSON.stringify({
  session_id: 'sess-abc',
  transcript_path: '/p/t.jsonl',
  model: { id: 'claude-opus-4-8', display_name: 'Opus' },
  output_style: { name: 'default' },
  cost: {
    total_cost_usd: 0.01234,
    total_duration_ms: 45000,
    total_lines_added: 156,
    total_lines_removed: 23
  },
  context_window: {
    total_input_tokens: 1000,
    total_output_tokens: 200,
    context_window_size: 200000,
    used_percentage: 64,
    remaining_percentage: 36,
    current_usage: { foo: 1 }
  },
  exceeds_200k_tokens: false,
  effort: { level: 'high' },
  thinking: { enabled: true },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: RESET_5H_S },
    seven_day: { used_percentage: 41.2, resets_at: RESET_7D_S }
  },
  pr: { number: 42, url: 'https://x/42', review_state: 'pending' }
})

describe('parseStatusLineBlob', () => {
  it('maps a complete blob, normalizing resets_at epoch-s → epoch-ms', () => {
    const t = parseStatusLineBlob(FULL, NOW)!
    expect(t.sessionId).toBe('sess-abc')
    expect(t.modelId).toBe('claude-opus-4-8')
    expect(t.modelName).toBe('Opus')
    expect(t.costUsd).toBe(0.01234)
    expect(t.linesAdded).toBe(156)
    expect(t.linesRemoved).toBe(23)
    expect(t.durationMs).toBe(45000)
    expect(t.contextPercent).toBe(64)
    expect(t.contextWindowSize).toBe(200000)
    expect(t.exceeds200k).toBe(false)
    expect(t.effortLevel).toBe('high')
    expect(t.thinkingEnabled).toBe(true)
    expect(t.outputStyle).toBe('default')
    expect(t.pr).toEqual({ number: 42, url: 'https://x/42', reviewState: 'pending' })
    expect(t.rateLimits.fiveHour).toEqual({ usedPercent: 23.5, resetsAtMs: RESET_5H_S * 1000 })
    expect(t.rateLimits.sevenDay).toEqual({ usedPercent: 41.2, resetsAtMs: RESET_7D_S * 1000 })
    expect(t.updatedAtMs).toBe(NOW)
  })

  it('preserves a null used_percentage as null (never a fake 0%)', () => {
    const raw = JSON.stringify({
      session_id: 's',
      context_window: { used_percentage: null, current_usage: null }
    })
    expect(parseStatusLineBlob(raw, NOW)!.contextPercent).toBeNull()
  })

  it('tolerates a missing context_window entirely', () => {
    const t = parseStatusLineBlob(JSON.stringify({ session_id: 's' }), NOW)!
    expect(t.contextPercent).toBeNull()
    expect(t.contextWindowSize).toBeNull()
  })

  it('returns null rate windows when rate_limits is absent', () => {
    const t = parseStatusLineBlob(JSON.stringify({ session_id: 's' }), NOW)!
    expect(t.rateLimits.fiveHour).toBeNull()
    expect(t.rateLimits.sevenDay).toBeNull()
  })

  it('fills one window and leaves the other null when only five_hour is present', () => {
    const raw = JSON.stringify({
      session_id: 's',
      rate_limits: { five_hour: { used_percentage: 10, resets_at: RESET_5H_S } }
    })
    const t = parseStatusLineBlob(raw, NOW)!
    expect(t.rateLimits.fiveHour).toEqual({ usedPercent: 10, resetsAtMs: RESET_5H_S * 1000 })
    expect(t.rateLimits.sevenDay).toBeNull()
  })

  it('returns null pr when absent, and null reviewState when pr lacks review_state', () => {
    expect(parseStatusLineBlob(JSON.stringify({ session_id: 's' }), NOW)!.pr).toBeNull()
    const raw = JSON.stringify({ session_id: 's', pr: { number: 7, url: 'u' } })
    expect(parseStatusLineBlob(raw, NOW)!.pr).toEqual({ number: 7, url: 'u', reviewState: null })
  })

  it('maps exceeds_200k_tokens', () => {
    const raw = JSON.stringify({ session_id: 's', exceeds_200k_tokens: true })
    expect(parseStatusLineBlob(raw, NOW)!.exceeds200k).toBe(true)
  })

  it('extracts cwd (top-level), for the BUG-8 footer correlation', () => {
    const raw = JSON.stringify({ session_id: 's', cwd: '/home/u/repo' })
    expect(parseStatusLineBlob(raw, NOW)!.cwd).toBe('/home/u/repo')
  })

  it('falls back to workspace.current_dir when cwd is absent', () => {
    const raw = JSON.stringify({
      session_id: 's',
      workspace: { current_dir: '/home/u/wt', project_dir: '/home/u/repo' }
    })
    expect(parseStatusLineBlob(raw, NOW)!.cwd).toBe('/home/u/wt')
  })

  it('prefers top-level cwd over workspace.current_dir', () => {
    const raw = JSON.stringify({
      session_id: 's',
      cwd: '/home/u/a',
      workspace: { current_dir: '/home/u/b' }
    })
    expect(parseStatusLineBlob(raw, NOW)!.cwd).toBe('/home/u/a')
  })

  it('leaves cwd null when neither cwd nor workspace.current_dir is present', () => {
    expect(parseStatusLineBlob(JSON.stringify({ session_id: 's' }), NOW)!.cwd).toBeNull()
  })

  it('returns null on invalid JSON without throwing', () => {
    expect(parseStatusLineBlob('{not json', NOW)).toBeNull()
    expect(parseStatusLineBlob('', NOW)).toBeNull()
  })

  it('returns null when session_id is missing', () => {
    expect(parseStatusLineBlob(JSON.stringify({ cost: { total_cost_usd: 1 } }), NOW)).toBeNull()
  })
})

describe('foldFleetTelemetry', () => {
  function tele(over: Partial<SessionTelemetry> & { sessionId: string }): SessionTelemetry {
    return {
      sessionId: over.sessionId,
      cwd: null,
      modelId: 'm',
      modelName: 'M',
      costUsd: null,
      linesAdded: null,
      linesRemoved: null,
      durationMs: null,
      contextPercent: null,
      contextWindowSize: null,
      exceeds200k: false,
      effortLevel: null,
      thinkingEnabled: false,
      outputStyle: null,
      pr: null,
      rateLimits: { fiveHour: null, sevenDay: null },
      updatedAtMs: NOW,
      ...over
    }
  }

  it('sums costUsd across sessions, ignoring nulls', () => {
    const m = new Map<string, SessionTelemetry>([
      ['a', tele({ sessionId: 'a', costUsd: 0.1 })],
      ['b', tele({ sessionId: 'b', costUsd: 0.25 })],
      ['c', tele({ sessionId: 'c', costUsd: null })]
    ])
    const f = foldFleetTelemetry(m, NOW)
    expect(f.totalCostUsd).toBeCloseTo(0.35)
    expect(f.sessionCount).toBe(3)
  })

  it('picks the most-recent rate window by updatedAtMs', () => {
    const older = tele({
      sessionId: 'a',
      updatedAtMs: NOW - 10_000,
      rateLimits: { fiveHour: { usedPercent: 10, resetsAtMs: NOW }, sevenDay: null }
    })
    const newer = tele({
      sessionId: 'b',
      updatedAtMs: NOW,
      rateLimits: { fiveHour: { usedPercent: 40, resetsAtMs: NOW }, sevenDay: null }
    })
    const f = foldFleetTelemetry(
      new Map([
        ['a', older],
        ['b', newer]
      ]),
      NOW
    )
    expect(f.fiveHour?.usedPercent).toBe(40)
    expect(f.fiveHourAtMs).toBe(NOW) // provenance: when the winning window was produced
    expect(f.sevenDay).toBeNull()
    expect(f.sevenDayAtMs).toBeNull()
  })

  it('discards entries older than the 24h TTL', () => {
    const stale = tele({ sessionId: 'old', costUsd: 5, updatedAtMs: NOW - 25 * 3600_000 })
    const fresh = tele({ sessionId: 'new', costUsd: 1, updatedAtMs: NOW })
    const f = foldFleetTelemetry(
      new Map([
        ['old', stale],
        ['new', fresh]
      ]),
      NOW
    )
    expect(f.totalCostUsd).toBe(1)
    expect(f.sessionCount).toBe(1)
  })

  it('window freshness follows the reading', () => {
    // A companion window stamped T, then a statusLine blob that changed only linesAdded: the
    // record's updatedAtMs moved, the windows did not (lesson framework/005).
    const T = NOW - 600_000
    const w = { usedPercent: 21, resetsAtMs: NOW + 3_600_000 }
    const moved = tele({
      sessionId: 'a',
      rateLimits: { fiveHour: w, sevenDay: w },
      rateLimitsAtMs: T,
      updatedAtMs: NOW
    })
    const f = foldFleetTelemetry(new Map([['a', moved]]), NOW)
    expect(f.fiveHourAtMs).toBe(T)
    expect(f.sevenDayAtMs).toBe(T)
    // across sessions the window stamp, not the record stamp, picks the freshest
    const other = tele({
      sessionId: 'b',
      rateLimits: { fiveHour: { usedPercent: 30, resetsAtMs: null }, sevenDay: null },
      updatedAtMs: NOW - 300_000
    })
    const both = foldFleetTelemetry(
      new Map([
        ['a', moved],
        ['b', other]
      ]),
      NOW
    )
    expect(both.fiveHour?.usedPercent).toBe(30)
    expect(both.fiveHourAtMs).toBe(NOW - 300_000)
  })

  it('returns a zeroed aggregate for an empty map', () => {
    expect(foldFleetTelemetry(new Map(), NOW)).toEqual({
      totalCostUsd: 0,
      sessionCount: 0,
      fiveHour: null,
      sevenDay: null,
      fiveHourAtMs: null,
      sevenDayAtMs: null
    })
  })
})
