import { describe, expect, it } from 'vitest'
import type { SessionTelemetry } from '../src/main/statusline-parse'
import { TELEMETRY_TTL_MS } from '../src/main/statusline-parse'
import {
  FOOTER_TELEMETRY_TTL_MS,
  PAYLOAD_SKEW_MS,
  SILENT_GRACE_MS,
  isSilentSession,
  prettyModelName,
  selectFooterTelemetry,
  transcriptTelemetry
} from '../src/renderer/src/lib/footer-telemetry'
import { footerSessionChips } from '../src/renderer/src/components/footer-format'

const NOW = 1_790_000_000_000
const HOUR = 3_600_000
const SID = '11111111-1111-4111-8111-111111111111'

const rec = (over: Partial<SessionTelemetry> = {}): SessionTelemetry => ({
  sessionId: SID,
  cwd: '/tmp/example-project',
  modelId: 'claude-opus-4-8',
  modelName: 'Opus 4.8',
  costUsd: 5.84,
  linesAdded: 3,
  linesRemoved: 1,
  durationMs: 1000,
  contextPercent: 17,
  contextWindowSize: 200_000,
  exceeds200k: false,
  effortLevel: 'high',
  thinkingEnabled: true,
  outputStyle: null,
  pr: null,
  rateLimits: { fiveHour: null, sevenDay: null },
  updatedAtMs: NOW - 1_000,
  ...over
})

describe('the renderer TTL mirrors the main one', () => {
  it('is the same 24 h', () => {
    expect(FOOTER_TELEMETRY_TTL_MS).toBe(TELEMETRY_TTL_MS)
  })
})

describe('selectFooterTelemetry (AC-1)', () => {
  it('serves a fresh record as live', () => {
    const live = rec()
    expect(selectFooterTelemetry({ live, lastKnown: null, transcript: null, now: NOW })).toEqual({
      kind: 'live',
      tele: live
    })
  })

  it('live telemetry wins over last-known and over the transcript', () => {
    const live = rec({ costUsd: 9 })
    const old = rec({ costUsd: 1, updatedAtMs: NOW - 3 * 24 * HOUR })
    const out = selectFooterTelemetry({
      live,
      lastKnown: old,
      transcript: { modelId: 'claude-sonnet-5-5', contextPercent: 4, atMs: NOW - 5 },
      now: NOW
    })
    expect(out.kind).toBe('live')
    expect(out.kind === 'live' && out.tele.costUsd).toBe(9)
  })

  it('never serves a record past the TTL as live — it becomes stale with its age', () => {
    const old = rec({ updatedAtMs: NOW - 3 * 24 * HOUR })
    const out = selectFooterTelemetry({ live: old, lastKnown: null, transcript: null, now: NOW })
    expect(out).toEqual({ kind: 'stale', tele: old, ageMs: 3 * 24 * HOUR, reason: 'expired' })
  })

  it('the TTL boundary: exactly at the TTL is still live, one ms past is stale', () => {
    const at = rec({ updatedAtMs: NOW - TELEMETRY_TTL_MS })
    expect(
      selectFooterTelemetry({ live: at, lastKnown: null, transcript: null, now: NOW }).kind
    ).toBe('live')
    const past = rec({ updatedAtMs: NOW - TELEMETRY_TTL_MS - 1 })
    expect(
      selectFooterTelemetry({ live: past, lastKnown: null, transcript: null, now: NOW }).kind
    ).toBe('stale')
  })

  it('uses the retained last-known record when there is no live one', () => {
    const old = rec({ updatedAtMs: NOW - 40 * HOUR })
    const out = selectFooterTelemetry({ live: null, lastKnown: old, transcript: null, now: NOW })
    expect(out).toEqual({ kind: 'stale', tele: old, ageMs: 40 * HOUR, reason: 'expired' })
  })

  it('prefers the newest of the live-but-aged and the retained record', () => {
    const a = rec({ costUsd: 1, updatedAtMs: NOW - 50 * HOUR })
    const b = rec({ costUsd: 2, updatedAtMs: NOW - 30 * HOUR })
    const out = selectFooterTelemetry({ live: a, lastKnown: b, transcript: null, now: NOW })
    expect(out.kind === 'stale' && out.tele.costUsd).toBe(2)
  })

  it('falls back to the transcript when no record exists, flagged as stale', () => {
    const out = selectFooterTelemetry({
      live: null,
      lastKnown: null,
      transcript: { modelId: 'claude-opus-4-8', contextPercent: 42, atMs: NOW - 2 * HOUR },
      now: NOW
    })
    expect(out.kind).toBe('stale')
    if (out.kind !== 'stale') return
    expect(out.reason).toBe('none')
    expect(out.ageMs).toBe(2 * HOUR)
    expect(out.tele.modelName).toBe('Opus 4.8')
    expect(out.tele.contextPercent).toBe(42)
    expect(out.tele.costUsd).toBeNull()
    expect(out.tele.effortLevel).toBeNull()
  })

  it('the record beats the transcript even when the transcript is newer (richer data)', () => {
    const old = rec({ updatedAtMs: NOW - 40 * HOUR })
    const out = selectFooterTelemetry({
      live: null,
      lastKnown: old,
      transcript: { modelId: 'claude-opus-4-8', contextPercent: 1, atMs: NOW - 10 },
      now: NOW
    })
    expect(out.kind === 'stale' && out.reason).toBe('expired')
  })

  it('is none when there is nothing at all, or an empty transcript', () => {
    expect(
      selectFooterTelemetry({ live: null, lastKnown: null, transcript: null, now: NOW })
    ).toEqual({
      kind: 'none'
    })
    expect(
      selectFooterTelemetry({
        live: null,
        lastKnown: null,
        transcript: { modelId: '', contextPercent: null, atMs: NOW },
        now: NOW
      })
    ).toEqual({ kind: 'none' })
  })

  it('a transcript-derived record renders only the chips the transcript can supply', () => {
    const out = selectFooterTelemetry({
      live: null,
      lastKnown: null,
      transcript: { modelId: 'claude-sonnet-5-5', contextPercent: 8, atMs: NOW - HOUR },
      now: NOW
    })
    if (out.kind !== 'stale') throw new Error('expected stale')
    const chips = footerSessionChips(out.tele, null)
    expect(chips.map((c) => [c.key, c.value])).toEqual([
      ['model', 'Sonnet 5.5'],
      ['context', '8%']
    ])
  })
})

describe('transcriptTelemetry / prettyModelName', () => {
  it('prettifies Claude model ids and leaves unknown ones alone', () => {
    expect(prettyModelName('claude-opus-4-8')).toBe('Opus 4.8')
    expect(prettyModelName('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(prettyModelName('claude-opus-4-8[1m]')).toBe('Opus 4.8')
    expect(prettyModelName('claude-haiku-5')).toBe('Haiku 5')
    expect(prettyModelName('some-other-model')).toBe('some-other-model')
    expect(prettyModelName('')).toBe('')
  })

  it('carries the session id and the transcript time', () => {
    const t = transcriptTelemetry(SID, '/x', {
      modelId: 'claude-opus-4-8',
      contextPercent: null,
      atMs: 123
    })
    expect(t.sessionId).toBe(SID)
    expect(t.cwd).toBe('/x')
    expect(t.updatedAtMs).toBe(123)
    expect(t.contextPercent).toBeNull()
  })
})

describe('isSilentSession (AC-2)', () => {
  const turn = NOW - SILENT_GRACE_MS - 1_000
  it('is silent when an assistant turn is older than the grace and no payload followed', () => {
    expect(isSilentSession({ lastAssistantAtMs: turn, lastPayloadAtMs: null, now: NOW })).toBe(true)
    expect(
      isSilentSession({ lastAssistantAtMs: turn, lastPayloadAtMs: turn - 30_000, now: NOW })
    ).toBe(true)
  })

  it('waits out the grace window', () => {
    expect(
      isSilentSession({
        lastAssistantAtMs: NOW - SILENT_GRACE_MS + 1,
        lastPayloadAtMs: null,
        now: NOW
      })
    ).toBe(false)
    expect(
      isSilentSession({ lastAssistantAtMs: NOW - SILENT_GRACE_MS, lastPayloadAtMs: null, now: NOW })
    ).toBe(true)
  })

  it('the grace is at least two minutes', () => {
    expect(SILENT_GRACE_MS).toBeGreaterThanOrEqual(2 * 60_000)
  })

  it('a healthy session is not flagged: its payload can be stamped just BEFORE the turn event', () => {
    // main stamps the payload at parse time; the renderer stamps the turn after the watcher's
    // coalescing delay, so the payload of the very same turn can look slightly older than it
    expect(PAYLOAD_SKEW_MS).toBeGreaterThanOrEqual(1_000)
    expect(
      isSilentSession({
        lastAssistantAtMs: turn,
        lastPayloadAtMs: turn - PAYLOAD_SKEW_MS + 1,
        now: NOW
      })
    ).toBe(false)
    expect(
      isSilentSession({
        lastAssistantAtMs: turn,
        lastPayloadAtMs: turn - PAYLOAD_SKEW_MS - 1,
        now: NOW
      })
    ).toBe(true)
  })

  it('clears on the next payload for the session', () => {
    expect(
      isSilentSession({ lastAssistantAtMs: turn, lastPayloadAtMs: turn + 500, now: NOW })
    ).toBe(false)
  })

  it('a payload at the very instant of the turn counts as delivered', () => {
    expect(isSilentSession({ lastAssistantAtMs: turn, lastPayloadAtMs: turn, now: NOW })).toBe(
      false
    )
  })

  it('is never silent for a session that has not taken a turn', () => {
    expect(isSilentSession({ lastAssistantAtMs: null, lastPayloadAtMs: null, now: NOW })).toBe(
      false
    )
  })

  it('a newer assistant turn re-arms it after an earlier payload', () => {
    const payload = NOW - 10 * 60_000
    const newTurn = NOW - 3 * 60_000
    expect(
      isSilentSession({ lastAssistantAtMs: newTurn, lastPayloadAtMs: payload, now: NOW })
    ).toBe(true)
  })
})
