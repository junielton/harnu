import { describe, expect, it } from 'vitest'
import { isSilentSession } from '../src/renderer/src/lib/footer-telemetry'
import { createTelemetryStore } from '../src/main/telemetry-store'
import type { SessionTelemetry } from '../src/main/statusline-parse'

/**
 * T577 AC4: "Not reporting — restart session" is for a session NEITHER source reports for. The
 * renderer judges the composed record's `updatedAtMs`, so a companion-only session counts.
 */

const SID = 'sess-1'
const TURN_AT = 1_000_000

function store() {
  let t = TURN_AT
  const s = createTelemetryStore({
    now: () => t,
    captureFleet: () => {},
    cachePath: () => null,
    send: () => {}
  })
  return { s, at: (ms: number) => (t = ms) }
}

/** What the renderer's `isSessionSilent` reads: the newest payload stamp of the session. */
function lastPayloadAt(s: ReturnType<typeof store>['s']): number | null {
  const p = s.getTelemetryPayload()
  const all = [...p.perSession, ...p.lastKnown].filter((x) => x.sessionId === SID)
  return all.length ? Math.max(...all.map((x) => x.updatedAtMs)) : null
}

const silent = (s: ReturnType<typeof store>['s'], now: number): boolean =>
  isSilentSession({ lastAssistantAtMs: TURN_AT, lastPayloadAtMs: lastPayloadAt(s), now })

const SL = (updatedAtMs: number): SessionTelemetry => ({
  sessionId: SID,
  cwd: '/w',
  modelId: 'claude-sonnet-5-5',
  modelName: 'Sonnet 5.5',
  costUsd: 1,
  linesAdded: null,
  linesRemoved: null,
  durationMs: null,
  contextPercent: 10,
  contextWindowSize: 200_000,
  exceeds200k: false,
  effortLevel: null,
  thinkingEnabled: false,
  outputStyle: null,
  pr: null,
  rateLimits: { fiveHour: null, sevenDay: null },
  updatedAtMs
})

describe('the silent hint needs both sources to be quiet (T577 AC4)', () => {
  const NOW = TURN_AT + 5 * 60_000 // well past the grace

  it('neither source reported: silent', () => {
    expect(silent(store().s, NOW)).toBe(true)
  })

  it('only the statusLine reported since the turn: not silent', () => {
    const { s } = store()
    s.ingestStatusline(SL(TURN_AT + 1_000))
    expect(silent(s, NOW)).toBe(false)
  })

  it('only the companion reported since the turn (statusLine removed): not silent', () => {
    const { s } = store()
    s.ingestCompanion(
      SID,
      {
        cwd: '/w',
        cost: { usd: 2, atMs: TURN_AT + 1_000 },
        context: { percent: 12, window: 200_000, atMs: TURN_AT + 1_000 }
      },
      true
    )
    expect(silent(s, NOW)).toBe(false)
  })

  it('a stale statusLine blob and a companion that is not owned: still silent', () => {
    const { s } = store()
    s.ingestStatusline(SL(TURN_AT - 10 * 60_000))
    // not owned (shadow, no lease, unproven): the reading is dropped, it reports nothing
    s.ingestCompanion(SID, { cwd: '/w', cost: { usd: 2, atMs: TURN_AT + 1_000 } }, false)
    expect(silent(s, NOW)).toBe(true)
  })

  it('a stale statusLine blob and an owned, fresh companion: not silent', () => {
    const { s } = store()
    s.ingestStatusline(SL(TURN_AT - 10 * 60_000))
    s.ingestCompanion(SID, { cwd: '/w', cost: { usd: 2, atMs: TURN_AT + 1_000 } }, true)
    expect(silent(s, NOW)).toBe(false)
  })

  it('a companion that lost its lease falls back: silent again if the statusLine is quiet', () => {
    const { s } = store()
    s.ingestStatusline(SL(TURN_AT - 10 * 60_000))
    s.ingestCompanion(SID, { cwd: '/w', cost: { usd: 2, atMs: TURN_AT + 1_000 } }, true)
    s.dropCompanion(SID)
    expect(silent(s, NOW)).toBe(true)
  })
})
