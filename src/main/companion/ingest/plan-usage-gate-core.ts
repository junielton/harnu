/**
 * The plan-usage gate, pure (T389 P1W6 §7.4). The `planUsage` family arbitrates one thing: whether
 * the `claude -p "/usage"` poll spawns. Plan limits already reach the renderer through the
 * telemetry store; the poll stays as the fallback and as the only source of the per-model weekly
 * rows. It runs unless a session whose binding owns `planUsage` reported a window within
 * PLAN_USAGE_STALE_MS.
 *
 * Time is the host's receive time, never the mod's clock. No I/O, no Electron.
 */

import { PLAN_USAGE_STALE_MS } from '../contract'

export interface PlanUsageGateState {
  /** Host receive time of the newest eligible reading, or null when there is none. */
  lastLeasedReadingAt: number | null
}

export const emptyGate = (): PlanUsageGateState => ({ lastLeasedReadingAt: null })

/**
 * Advances only for a reading with at least one known window from a binding that owns
 * `planUsage`. A reading from a session in `shadow`, without a lease or unproven is not owned; an
 * empty window list (the resume handshake, an API-key user) is not a reading.
 */
export function noteReading(
  s: PlanUsageGateState,
  r: { owned: boolean; windows: number; hostNow: number }
): PlanUsageGateState {
  if (!r.owned || r.windows < 1 || !Number.isFinite(r.hostNow)) return s
  const last = s.lastLeasedReadingAt
  return { lastLeasedReadingAt: last === null || r.hostNow > last ? r.hostNow : last }
}

/**
 * True when the poll should run: no eligible reading, or the newest one is older than
 * PLAN_USAGE_STALE_MS. A reading stamped in the future (the host clock moved back) counts as
 * stale: the fail-safe is to poll, which is what the legacy path does anyway.
 */
export function shouldPoll(s: PlanUsageGateState, hostNow: number): boolean {
  const last = s.lastLeasedReadingAt
  if (last === null) return true
  const age = hostNow - last
  return age < 0 || age > PLAN_USAGE_STALE_MS
}
