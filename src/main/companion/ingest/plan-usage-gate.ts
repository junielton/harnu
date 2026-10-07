/**
 * The plan-usage gate's one instance (T389 P1W6 §7.4): the state `usage.ts` reads before it
 * spawns and the telemetry adapter writes when an owned reading arrives. The decisions are in
 * `plan-usage-gate-core.ts`; this is the module-level holder, so the poller needs no reference
 * to the companion host.
 *
 * It also carries what the `planUsage` parity rule compares: the newest owned reading's figures,
 * and an observer the host registers to be told about each poll result.
 */

import { emptyGate, noteReading, shouldPoll, type PlanUsageGateState } from './plan-usage-gate-core'

/** The figures of one owned reading, as the parity rule compares them with a poll. */
export interface PlanReading {
  /** Host receive time. */
  at: number
  h5: number | null
  d7: number | null
  r5: number | null
  r7: number | null
}

/** The two windows of a `/usage` snapshot the rule looks at. */
export interface PlanPollWindows {
  session: { usedPercent: number; resetsAtMs: number | null } | null
  weekAll: { usedPercent: number; resetsAtMs: number | null } | null
}

let state: PlanUsageGateState = emptyGate()
let latest: PlanReading | null = null
let observer: ((poll: PlanPollWindows, reading: PlanReading | null, now: number) => void) | null =
  null

/** An owned reading with `windows` known windows arrived (host receive time `hostNow`). */
export function noteLeasedReading(
  r: { owned: boolean; windows: number; hostNow: number },
  detail?: Omit<PlanReading, 'at'>
): void {
  const next = noteReading(state, r)
  if (next === state) return
  state = next
  if (detail && next.lastLeasedReadingAt === r.hostNow) latest = { at: r.hostNow, ...detail }
}

/** The kill switch, or no session owning `planUsage` any more: the next tick polls. */
export function clearPlanUsageGate(): void {
  state = emptyGate()
  latest = null
}

/** Called by the poller's timer tick and its refresh on focus; `usage:refresh` never asks. */
export function planUsagePollAllowed(now: number = Date.now()): boolean {
  return shouldPoll(state, now)
}

export const planUsageGateState = (): PlanUsageGateState => state
export const latestPlanReading = (): PlanReading | null => latest

/** The host's hook for the parity ledger. `null` removes it. */
export function setPlanUsagePollObserver(fn: typeof observer): void {
  observer = fn
}

/** `usage.ts` calls this with each poll's windows; it never throws into the poller. */
export function reportPlanUsagePoll(poll: PlanPollWindows, now: number = Date.now()): void {
  try {
    observer?.(poll, latest, now)
  } catch {
    // the ledger is evidence, never a dependency of the poller
  }
}
