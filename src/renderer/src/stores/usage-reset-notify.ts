/**
 * Pure detection for the usage-reset notification (usage-reset-notify spec).
 *
 * Fires when the tracked 5h rate-limit window is *superseded* by a new one
 * after having actually expired — not merely when "now" is past some
 * snapshot's `resetsAtMs`. The renderer's `rateLimits` (stores/usage.ts) is a
 * Vue `computed` keyed on poll data (fleet/snapshot), not on the clock: it
 * only changes when a new poll arrives, and by then the poll already reports
 * the NEXT window's own (future) `resetsAtMs`. So "now >= resetsAtMs" is
 * never observably true on a live `watch()` — the crossing has to be
 * inferred from the value CHANGING while the previous value was already in
 * the past. No electron, no i18n, no stores here — just the truth table —
 * so it's trivially unit-testable and the store just wires it to real data.
 */

/**
 * How long after the previous window's actual expiry we still consider a
 * newly-observed supersession worth notifying about. Guards against firing a
 * backlog notification when the app was asleep/closed and a stale baseline
 * only gets superseded long after it expired.
 */
export const USAGE_RESET_STALE_THRESHOLD_MS = 20 * 60 * 1000

/**
 * @param nowMs Current time.
 * @param prevResetsAtMs The previously-observed window's reset moment (the
 *   value seen on the prior check), or null/undefined if there's no prior
 *   baseline yet. A null baseline never notifies — this is also what makes a
 *   fresh app launch never fire a backlog notification for a window that
 *   already closed before the app started: the first-ever observation only
 *   establishes the baseline, it can't itself be "superseded."
 * @param nextResetsAtMs The newly-observed window's reset moment, or
 *   null/undefined when there's no rate-limit data at all.
 * @param lastNotifiedResetMs The (previous, superseded) resetsAtMs value we
 *   already notified for, or null if we haven't notified this session.
 */
export function shouldNotifyUsageReset(
  nowMs: number,
  prevResetsAtMs: number | null | undefined,
  nextResetsAtMs: number | null | undefined,
  lastNotifiedResetMs: number | null
): boolean {
  if (prevResetsAtMs == null || nextResetsAtMs == null) return false
  if (nextResetsAtMs === prevResetsAtMs) return false
  if (prevResetsAtMs > nowMs) return false
  if (prevResetsAtMs === lastNotifiedResetMs) return false
  if (nowMs - prevResetsAtMs >= USAGE_RESET_STALE_THRESHOLD_MS) return false
  return true
}
