/**
 * Pure parser for `claude -p "/usage"` output. Kept free of Electron/Node side
 * effects so it is unit-testable in the `node` vitest environment (see
 * `tests/usage-parse.test.ts`). The imperative spawn + polling lives in
 * `usage.ts`; this module only turns the client's text into a snapshot.
 *
 * Sample input (Claude Code 2.1.x, subscription auth):
 *
 *   You are currently using your subscription to power your Claude Code usage
 *
 *   Current session: 39% used · resets Jun 10, 8:40pm (America/Sao_Paulo)
 *   Current week (all models): 11% used · resets Jun 15, 4pm (America/Sao_Paulo)
 *   Current week (Sonnet only): 5% used · resets Jun 15, 4pm (America/Sao_Paulo)
 */

/** One usage window. `key` is `'session'`, `'week_all'`, or a model name. */
export interface UsageBucket {
  key: string
  /** 0..100, may be fractional. */
  usedPercent: number
  /** Raw reset string from the CLI, e.g. `"Jun 10, 8:40pm (America/Sao_Paulo)"`. */
  resetsAtText: string
  /** Best-effort epoch ms of the reset moment, or `null` when unparseable. */
  resetsAtMs: number | null
}

export interface ParsedUsage {
  available: boolean
  /**
   * True when the subscription preamble ("…using your subscription…") is present,
   * even if no data lines parsed. Distinguishes an incomplete poll (subscription
   * user, table not yet printed) from a genuine non-subscription "unavailable".
   */
  subscription: boolean
  session: UsageBucket | null
  weekAll: UsageBucket | null
  perModel: UsageBucket[]
}

/**
 * Renderer-facing display state:
 * - `ready` — has usage data to show (possibly `stale`).
 * - `loading` — subscription user, but the first usable snapshot hasn't arrived
 *   yet (the panel shows a skeleton).
 * - `unavailable` — genuinely no usage to show (non-subscription / API-key user,
 *   or `/usage` unsupported); the panel hides.
 */
export type UsageStatus = 'ready' | 'loading' | 'unavailable'

/**
 * The renderer-facing snapshot. Extends `ParsedUsage` with freshness metadata.
 * `stale` is true only when a refresh failed (or returned incomplete) and we are
 * showing the last-good data. Exported as the wire type consumed by the preload
 * bridge.
 */
export interface UsageSnapshot extends ParsedUsage {
  /** Epoch ms the displayed data was fetched (stays put while `stale`). */
  fetchedAtMs: number
  stale: boolean
  status: UsageStatus
}

/** Outcome of one `claude -p "/usage"` run. */
export type UsageRunOutcome = { ok: true; stdout: string } | { ok: false }

// The preamble the official client prints for subscription auth. Present even on
// the frequent `-p` runs where the async usage table itself never arrives.
const SUBSCRIPTION_RE = /using your subscription/i

// Separator-agnostic: match the percentage, then skip to `resets <rest of line>`.
const SESSION_RE = /Current session:\s*(\d+(?:\.\d+)?)%\s*used.*?resets\s*(.+)/i
const WEEK_ALL_RE = /Current week \(all models\):\s*(\d+(?:\.\d+)?)%\s*used.*?resets\s*(.+)/i
const PER_MODEL_RE = /Current week \(([^)]+?)\s+only\):\s*(\d+(?:\.\d+)?)%\s*used.*?resets\s*(.+)/gi

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11
}

/**
 * Parse a localized absolute reset string into epoch ms. The CLI omits the year
 * and reports in the user's local timezone, so we build a local-time `Date` with
 * the inferred year (rolling forward across the Dec→Jan boundary). The IANA tz
 * suffix (`(America/Sao_Paulo)`) is informational and ignored — it is the user's
 * own local zone in practice. Returns `null` if month/day or time can't be read.
 */
export function parseResetText(text: string, nowMs: number): number | null {
  const md = /([A-Za-z]{3,})\s+(\d{1,2})/.exec(text)
  const tm = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text)
  if (!md || !tm) return null

  const month = MONTHS[md[1].slice(0, 3).toLowerCase()]
  if (month === undefined) return null
  const day = Number(md[2])

  let hour = Number(tm[1]) % 12
  if (tm[3].toLowerCase() === 'pm') hour += 12
  const minute = tm[2] ? Number(tm[2]) : 0

  const year = new Date(nowMs).getFullYear()
  let when = new Date(year, month, day, hour, minute, 0, 0).getTime()
  // Resets are in the future; a current-year date well in the past means the
  // reset belongs to next year (Dec→Jan wrap). 12h slack avoids clock-skew flaps.
  if (when < nowMs - 12 * 60 * 60 * 1000) {
    when = new Date(year + 1, month, day, hour, minute, 0, 0).getTime()
  }
  return when
}

function toBucket(key: string, pct: string, resetRaw: string, nowMs: number): UsageBucket {
  const resetsAtText = resetRaw.trim()
  return {
    key,
    usedPercent: parseFloat(pct),
    resetsAtText,
    resetsAtMs: parseResetText(resetsAtText, nowMs)
  }
}

export function parseUsageOutput(stdout: string, nowMs: number): ParsedUsage {
  const sessionM = SESSION_RE.exec(stdout)
  const weekAllM = WEEK_ALL_RE.exec(stdout)

  const session = sessionM ? toBucket('session', sessionM[1], sessionM[2], nowMs) : null
  const weekAll = weekAllM ? toBucket('week_all', weekAllM[1], weekAllM[2], nowMs) : null

  const perModel: UsageBucket[] = []
  PER_MODEL_RE.lastIndex = 0
  for (let m = PER_MODEL_RE.exec(stdout); m !== null; m = PER_MODEL_RE.exec(stdout)) {
    perModel.push(toBucket(m[1].trim(), m[2], m[3], nowMs))
  }

  return {
    available: Boolean(session || weekAll || perModel.length),
    subscription: SUBSCRIPTION_RE.test(stdout),
    session,
    weekAll,
    perModel
  }
}

/**
 * Fold one run outcome into a snapshot.
 *
 * - **Run with data** → authoritative `ready`.
 * - **Run with the subscription preamble but no data, WHEN we already hold good
 *   data** → an *incomplete* poll, not a downgrade (`claude -p "/usage"` returns
 *   only the preamble during its ~20–40s cooldown). Keep the last-good data,
 *   flagged `stale`, so the panel never flickers blank.
 * - **Run with no data and no prior data** (incomplete cold poll), or **a
 *   genuine "unavailable" output** (no preamble — API-key user / `/usage`
 *   unsupported) → `unavailable`. The panel hides; a later complete poll fills
 *   it in. Crucially this is NOT a sticky `loading`: the skeleton is the
 *   renderer's initial null-snapshot window, never a poller status, so an
 *   incomplete poll can't pin the skeleton forever.
 * - **Hard spawn failure** → keep last-good (`stale`); with none, `unavailable`.
 */
export function buildSnapshot(
  prev: UsageSnapshot | null,
  outcome: UsageRunOutcome,
  nowMs: number
): UsageSnapshot {
  if (outcome.ok) {
    const parsed = parseUsageOutput(outcome.stdout, nowMs)
    if (parsed.available) {
      return { ...parsed, fetchedAtMs: nowMs, stale: false, status: 'ready' }
    }
    // Incomplete poll (subscription preamble, no table) but we have good data:
    // keep it rather than downgrade. A genuine non-subscription output, or an
    // incomplete poll with nothing to fall back to, resolves to `unavailable`.
    if (parsed.subscription && prev && prev.available) {
      return { ...prev, stale: true }
    }
    return { ...parsed, fetchedAtMs: nowMs, stale: false, status: 'unavailable' }
  }
  if (prev && prev.available) {
    return { ...prev, stale: true }
  }
  return {
    available: false,
    subscription: false,
    session: null,
    weekAll: null,
    perModel: [],
    fetchedAtMs: nowMs,
    stale: false,
    status: 'unavailable'
  }
}
