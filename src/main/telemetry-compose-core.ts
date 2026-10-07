/**
 * The pure composition of one session's `SessionTelemetry` from its two writers (T389 P1W6 §7.3):
 * the statusLine blob and the companion's readings. No I/O, no clock, no Electron, and no import
 * from `src/main/companion`: the statusLine side must stay independent of companion state
 * (lesson framework/005), so the store and this file speak only in neutral shapes.
 *
 * The rule is a field partition (ARB-2c). A group has one writer at any moment and values are
 * never blended (ARB-2a): the companion writes a group from its first reading of that group in
 * the session; until then the statusLine writes it. Eight fields have no companion source and are
 * always the statusLine's.
 */

import type { RateWindow, SessionTelemetry } from './statusline-parse'

/** What the companion reported for one session. Every group is optional: absent = no figure yet. */
export interface CompanionPart {
  /** The binding's `hello.cwd`: used only when the statusLine has none. */
  cwd: string | null
  cost?: { usd: number; atMs: number }
  context?: { percent: number | null; window: number; tokens?: number; atMs: number }
  rateLimits?: { fiveHour: RateWindow | null; sevenDay: RateWindow | null; atMs: number }
  /** Slice S3: the last main-loop `turn.completed.usage.model`. */
  model?: { id: string; atMs: number }
}

const EXCEEDS_TOKENS = 200_000

/**
 * Folds one reading (`delta`) into what the session already holds. Absent is "no new figure": a
 * group the reading omits keeps its last value, so `rateLimits: []` (the resume handshake, smoke
 * A2) never clears the windows. A group the reading carries replaces the old one wholesale.
 */
export function mergePart(prev: CompanionPart | null, delta: CompanionPart): CompanionPart {
  const out: CompanionPart = { cwd: delta.cwd ?? prev?.cwd ?? null }
  const cost = delta.cost ?? prev?.cost
  const context = delta.context ?? prev?.context
  const rateLimits = delta.rateLimits ?? prev?.rateLimits
  const model = delta.model ?? prev?.model
  if (cost) out.cost = cost
  if (context) out.context = context
  if (rateLimits) out.rateLimits = rateLimits
  if (model) out.model = model
  return out
}

const hasGroup = (p: CompanionPart): boolean =>
  p.cost !== undefined ||
  p.context !== undefined ||
  p.rateLimits !== undefined ||
  p.model !== undefined

/** What a statusLine blob parses to when the companion is the only writer there is. */
function defaults(sid: string, cwd: string | null): SessionTelemetry {
  return {
    sessionId: sid,
    cwd,
    modelId: '',
    modelName: '',
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
    updatedAtMs: 0
  }
}

/**
 * `owned` is the arbiter's answer for the `telemetry` family. Not owned (mode `off` or `shadow`,
 * no lease, unproven), or nothing read yet: the statusLine record passes through, the very same
 * object. Otherwise the groups the companion has read are its own and the rest are the
 * statusLine's.
 */
export function compose(
  statusline: SessionTelemetry | null,
  part: CompanionPart | null,
  owned: boolean,
  sid: string
): SessionTelemetry | null {
  if (!owned || !part || !hasGroup(part)) return statusline
  const base = statusline ?? defaults(sid, part.cwd)
  const out: SessionTelemetry = { ...base, cwd: base.cwd ?? part.cwd }
  let newest = base.updatedAtMs
  if (part.cost) {
    out.costUsd = part.cost.usd
    newest = Math.max(newest, part.cost.atMs)
  }
  if (part.context) {
    out.contextPercent = part.context.percent
    out.contextWindowSize = part.context.window
    out.exceeds200k = (part.context.tokens ?? 0) > EXCEEDS_TOKENS
    newest = Math.max(newest, part.context.atMs)
  }
  if (part.rateLimits) {
    out.rateLimits = { fiveHour: part.rateLimits.fiveHour, sevenDay: part.rateLimits.sevenDay }
    out.rateLimitsAtMs = part.rateLimits.atMs
    newest = Math.max(newest, part.rateLimits.atMs)
  } else {
    // The statusLine's windows keep the statusLine's own stamp, whoever moved `updatedAtMs`.
    out.rateLimitsAtMs = base.rateLimitsAtMs ?? base.updatedAtMs
  }
  if (part.model) {
    out.modelId = part.model.id
    newest = Math.max(newest, part.model.atMs)
  }
  out.updatedAtMs = newest
  return out
}
