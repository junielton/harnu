/**
 * Pure parse/fold core for the statusLine telemetry bridge.
 *
 * Mirrors the `usage-parse.ts` (pure) / `usage.ts` (shell) split: no electron /
 * node runtime deps beyond types, so it's unit-testable in the `node` vitest env
 * (`tests/statusline-parse.test.ts`). The imperative shell that tails the inbox
 * and pushes IPC lives in `statusline.ts`; install helpers in `statusline-install.ts`.
 */

/** Telemetry for ONE session, normalized from a statusLine JSON blob. */
export interface SessionTelemetry {
  sessionId: string
  /**
   * The session's working directory (`cwd`, or `workspace.current_dir`) from the
   * statusLine blob — `null` when the blob omits it. Lets the footer correlate a
   * still-synthetic session (keyed `synthetic-<uuid>`) to its real telemetry
   * (keyed by the Claude uuid) by folder, BEFORE the synth→real migration (BUG-8).
   */
  cwd: string | null
  modelId: string
  modelName: string
  costUsd: number | null
  linesAdded: number | null
  linesRemoved: number | null
  durationMs: number | null
  /** context_window.used_percentage — `null` early in a session and post-/compact. */
  contextPercent: number | null
  contextWindowSize: number | null
  exceeds200k: boolean
  effortLevel: string | null
  thinkingEnabled: boolean
  outputStyle: string | null
  pr: { number: number; url: string; reviewState: string | null } | null
  /** Rate-limits are GLOBAL to the subscription, but arrive per session. */
  rateLimits: { fiveHour: RateWindow | null; sevenDay: RateWindow | null }
  /** Epoch ms when THIS blob was written (the inbox file mtime). */
  updatedAtMs: number
  /**
   * Epoch ms of the reading that produced `rateLimits`, when it is not `updatedAtMs`: set only
   * on a record the telemetry store composed (T389 P1W6), where another writer can move
   * `updatedAtMs` without refreshing the windows. Absent on a parsed blob.
   */
  rateLimitsAtMs?: number
}

export interface RateWindow {
  usedPercent: number
  /** `resets_at` arrives as epoch SECONDS on the wire; normalized to epoch ms here. */
  resetsAtMs: number | null
}

/** Fleet aggregate folded from the live per-session telemetry map. */
export interface FleetTelemetry {
  /** Sum of non-null costUsd across live (non-expired) sessions. */
  totalCostUsd: number
  /** Count of live (non-expired) sessions with telemetry. */
  sessionCount: number
  /** Rate-limit "from the horse's mouth": the most-recently-updated window. */
  fiveHour: RateWindow | null
  sevenDay: RateWindow | null
  /**
   * Epoch ms of the blob that provided each window (`null` when the window is).
   * Lets the renderer weigh cockpit freshness against the `/usage` poll instead
   * of preferring a frozen cockpit forever.
   */
  fiveHourAtMs: number | null
  sevenDayAtMs: number | null
}

/** Drop telemetry older than this (orphaned/closed sessions). */
export const TELEMETRY_TTL_MS = 24 * 3600_000

function numOrNull(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}

function strOrNull(x: unknown): string | null {
  return typeof x === 'string' ? x : null
}

function parseWindow(w: unknown): RateWindow | null {
  if (!w || typeof w !== 'object') return null
  const obj = w as Record<string, unknown>
  const used = numOrNull(obj.used_percentage)
  if (used === null) return null
  const resetsAtS = numOrNull(obj.resets_at)
  return { usedPercent: used, resetsAtMs: resetsAtS === null ? null : resetsAtS * 1000 }
}

/**
 * Parse the raw statusLine JSON blob. Fail-safe: returns `null` on invalid JSON
 * or a missing `session_id` (never throws). `resets_at` epoch-s → epoch-ms; a
 * `null` `used_percentage` is preserved as `null` (never a fake 0%).
 */
export function parseStatusLineBlob(raw: string, fileMtimeMs: number): SessionTelemetry | null {
  let obj: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    obj = parsed as Record<string, unknown>
  } catch {
    return null
  }

  const sessionId = strOrNull(obj.session_id)
  if (!sessionId) return null

  // cwd: Claude Code sends `cwd` top-level and `workspace.current_dir`; prefer the
  // former, fall back to the latter, so the footer can correlate by folder (BUG-8).
  const workspace = (obj.workspace ?? {}) as Record<string, unknown>
  const cwd = strOrNull(obj.cwd) ?? strOrNull(workspace.current_dir)

  const model = (obj.model ?? {}) as Record<string, unknown>
  const cost = (obj.cost ?? {}) as Record<string, unknown>
  const ctx = (obj.context_window ?? {}) as Record<string, unknown>
  const effort = (obj.effort ?? {}) as Record<string, unknown>
  const thinking = (obj.thinking ?? {}) as Record<string, unknown>
  const outputStyle = (obj.output_style ?? {}) as Record<string, unknown>
  const rateLimits = (obj.rate_limits ?? {}) as Record<string, unknown>

  let pr: SessionTelemetry['pr'] = null
  if (obj.pr && typeof obj.pr === 'object') {
    const p = obj.pr as Record<string, unknown>
    pr = {
      number: numOrNull(p.number) ?? 0,
      url: strOrNull(p.url) ?? '',
      reviewState: strOrNull(p.review_state)
    }
  }

  return {
    sessionId,
    cwd,
    modelId: strOrNull(model.id) ?? '',
    modelName: strOrNull(model.display_name) ?? '',
    costUsd: numOrNull(cost.total_cost_usd),
    linesAdded: numOrNull(cost.total_lines_added),
    linesRemoved: numOrNull(cost.total_lines_removed),
    durationMs: numOrNull(cost.total_duration_ms),
    contextPercent: numOrNull(ctx.used_percentage),
    contextWindowSize: numOrNull(ctx.context_window_size),
    exceeds200k: obj.exceeds_200k_tokens === true,
    effortLevel: strOrNull(effort.level),
    thinkingEnabled: thinking.enabled === true,
    outputStyle: strOrNull(outputStyle.name),
    pr,
    rateLimits: {
      fiveHour: parseWindow(rateLimits.five_hour),
      sevenDay: parseWindow(rateLimits.seven_day)
    },
    updatedAtMs: fileMtimeMs
  }
}

/**
 * Fold the live per-session telemetry into a fleet aggregate. Entries older than
 * {@link TELEMETRY_TTL_MS} (relative to `nowMs`) are ignored. The fleet rate-limit
 * windows are taken from the most-recently-updated session that has each window.
 */
export function foldFleetTelemetry(
  perSession: ReadonlyMap<string, SessionTelemetry>,
  nowMs: number
): FleetTelemetry {
  let totalCostUsd = 0
  let sessionCount = 0
  let fiveHour: RateWindow | null = null
  let sevenDay: RateWindow | null = null
  let fiveHourAt = -Infinity
  let sevenDayAt = -Infinity

  for (const t of perSession.values()) {
    if (nowMs - t.updatedAtMs > TELEMETRY_TTL_MS) continue
    sessionCount++
    if (t.costUsd !== null) totalCostUsd += t.costUsd
    // The windows' own stamp: a blob that only moved `linesAdded` must not re-stamp a window the
    // companion read an hour ago as fresh (lesson framework/005, "preferred source, no bound").
    const windowsAt = t.rateLimitsAtMs ?? t.updatedAtMs
    if (t.rateLimits.fiveHour && windowsAt > fiveHourAt) {
      fiveHour = t.rateLimits.fiveHour
      fiveHourAt = windowsAt
    }
    if (t.rateLimits.sevenDay && windowsAt > sevenDayAt) {
      sevenDay = t.rateLimits.sevenDay
      sevenDayAt = windowsAt
    }
  }

  return {
    totalCostUsd,
    sessionCount,
    fiveHour,
    sevenDay,
    fiveHourAtMs: fiveHour ? fiveHourAt : null,
    sevenDayAtMs: sevenDay ? sevenDayAt : null
  }
}
