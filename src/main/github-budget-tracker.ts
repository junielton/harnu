/**
 * T611 U1 — the process-wide GitHub budget tracker.
 *
 * One instance per main process, shared by the runner (which counts every `gh` call), the poller
 * (which feeds it `gh api rate_limit`) and the consumers that slow down (mission caches, PR Stack).
 * Kept in its own electron-free module so `gh-runner.ts` and the cores can import it in a unit test
 * without pulling `electron` in. The prefs file and the IPC live in `github-budget.ts`.
 */

import {
  createBudgetTracker,
  gateCacheTtlMs,
  skipPrStackBackground,
  type BudgetTracker,
  type ThrottleState
} from './github-budget-core'

export const githubBudget: BudgetTracker = createBudgetTracker()

/** Current throttle state (`normal` until the first poll says otherwise). */
export function throttleState(): ThrottleState {
  return githubBudget.state()
}

/** TTL of the mission gate caches right now (60 s normal, 5 min low, forever while exhausted). */
export function missionCacheTtlMs(): number {
  return gateCacheTtlMs(githubBudget.state())
}

/** True when PR Stack should skip a BACKGROUND refresh (a load on open never asks). */
export function prStackBackgroundPaused(): boolean {
  return skipPrStackBackground(githubBudget.state(), githubBudget.getPrefs())
}

/** True when delivered missions should still be checked on GitHub (D-5, default off). */
export function checkDeliveredMissions(): boolean {
  return githubBudget.getPrefs().checkDelivered
}
