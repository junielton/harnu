/**
 * Pure decisions behind the footer's two BUG-196 states (design.md §6 — Footer): which telemetry
 * the left cluster shows and how fresh it is, and whether a session has gone silent. Framework-
 * free (type-only imports) so `tests/footer-telemetry.test.ts` runs in the node vitest env.
 */
import type { SessionTelemetry } from '../../../preload'

/** Mirrors `TELEMETRY_TTL_MS` in `src/main/statusline-parse.ts` (a test pins them equal). */
export const FOOTER_TELEMETRY_TTL_MS = 24 * 3600_000

/** What the session transcript can supply when no telemetry record exists. */
export interface TranscriptFallback {
  modelId: string
  /** Context-window used %, or null when the transcript has no usage yet. */
  contextPercent: number | null
  /** Epoch ms of the assistant turn the values come from. */
  atMs: number
}

/**
 * - `live`  — a record inside the TTL: shown at full strength.
 * - `stale` — last known values, shown dimmed with their age. `reason` says why there is no live
 *   record: `expired` (a record exists but is past the TTL) or `none` (only the transcript could
 *   supply values).
 * - `none`  — nothing at all to show.
 */
export type FooterTelemetryState =
  | { kind: 'live'; tele: SessionTelemetry }
  | { kind: 'stale'; tele: SessionTelemetry; ageMs: number; reason: 'expired' | 'none' }
  | { kind: 'none' }

const MODEL_ID_RE = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i

/** `claude-opus-4-8[1m]` → `Opus 4.8`. An id this does not recognise is shown as it is. */
export function prettyModelName(modelId: string): string {
  const m = MODEL_ID_RE.exec(modelId)
  if (!m) return modelId
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  return `${family} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`
}

/** A transcript reading shaped like a telemetry record, so the chip selection stays one code path. */
export function transcriptTelemetry(
  sessionId: string,
  cwd: string | null,
  fb: TranscriptFallback
): SessionTelemetry {
  return {
    sessionId,
    cwd,
    modelId: fb.modelId,
    modelName: prettyModelName(fb.modelId),
    costUsd: null,
    linesAdded: null,
    linesRemoved: null,
    durationMs: null,
    contextPercent: fb.contextPercent,
    contextWindowSize: null,
    exceeds200k: false,
    effortLevel: null,
    thinkingEnabled: false,
    outputStyle: null,
    pr: null,
    rateLimits: { fiveHour: null, sevenDay: null },
    updatedAtMs: fb.atMs
  }
}

export function selectFooterTelemetry(args: {
  /** The session's record in the live map (any age: the TTL is judged here, against `now`). */
  live: SessionTelemetry | null
  /** The newest record main kept past the TTL for the session. */
  lastKnown: SessionTelemetry | null
  transcript: TranscriptFallback | null
  now: number
  /** Identity of the session, stamped on a transcript-derived record. */
  sessionId?: string
  cwd?: string | null
}): FooterTelemetryState {
  const { live, lastKnown, transcript, now } = args
  const newest =
    live && lastKnown
      ? live.updatedAtMs >= lastKnown.updatedAtMs
        ? live
        : lastKnown
      : (live ?? lastKnown)
  if (newest) {
    const ageMs = Math.max(0, now - newest.updatedAtMs)
    if (ageMs <= FOOTER_TELEMETRY_TTL_MS) return { kind: 'live', tele: newest }
    return { kind: 'stale', tele: newest, ageMs, reason: 'expired' }
  }
  if (transcript && (transcript.modelId || transcript.contextPercent != null)) {
    return {
      kind: 'stale',
      tele: transcriptTelemetry(args.sessionId ?? '', args.cwd ?? null, transcript),
      ageMs: Math.max(0, now - transcript.atMs),
      reason: 'none'
    }
  }
  return { kind: 'none' }
}

/** A session must stay quiet this long after an assistant turn before it is flagged. */
export const SILENT_GRACE_MS = 2 * 60_000

/**
 * A payload stamped up to this long before the turn still counts as that turn's. Main stamps a
 * payload when it parses the inbox file; the renderer stamps the turn when the (coalesced) watcher
 * event arrives, up to ~0.5 s later, so a healthy session's payload can look older than its turn.
 * Biased to silence: a stricter gap would flag healthy sessions, and the next turn re-checks anyway.
 */
export const PAYLOAD_SKEW_MS = 10_000

/**
 * True when a session answered (its transcript gained an assistant turn) at least
 * {@link SILENT_GRACE_MS} ago and no telemetry payload arrived for it since. The next payload
 * clears it by itself, since it moves `lastPayloadAtMs` past the turn.
 */
export function isSilentSession(args: {
  lastAssistantAtMs: number | null
  lastPayloadAtMs: number | null
  now: number
  graceMs?: number
}): boolean {
  const { lastAssistantAtMs, lastPayloadAtMs, now, graceMs = SILENT_GRACE_MS } = args
  if (lastAssistantAtMs == null) return false
  if (now - lastAssistantAtMs < graceMs) return false
  return lastPayloadAtMs == null || lastPayloadAtMs < lastAssistantAtMs - PAYLOAD_SKEW_MS
}
