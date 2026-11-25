/**
 * Guided walks: which criteria a closed run settles (T787, amends spec D-2, V-12 and M-3).
 *
 * Pure and Electron-free, so the main process (which settles) and the pane (which says why a row stays open)
 * read the same rule. When a mission-source run ends, a criterion settles only on TWO independent signals:
 * the operator's Done and the agent's own read-only check agreeing. That is exactly `closedHow:
 * 'done-check'` with a `pass` report.
 *
 * Never key on `state === 'verified'` or on the close-out's "passed" count: a check with nothing to check from
 * here is also `verified` (`closedHow: 'done-nothing'`), with a single signal, and a reflexive Enter alone
 * could then write a false record.
 */
import type { Run, RunCheck } from './walk-machine'

/** A check of the script that answers a mission criterion. */
export interface CriterionAnswer {
  checkId: string
  criterionId: string
}

/** One criterion the run's end settles, with the agent's own words as evidence. */
export interface SettlePlan {
  checkId: string
  criterionId: string
  evidence: string
}

/** Done and the agent's check agreed: the only two-signal close. */
export function hasTwoSignals(rc: RunCheck): boolean {
  return rc.closedHow === 'done-check' && rc.report?.result === 'pass'
}

/** The criteria an ended run settles, in the script's order. Empty until the run has ended. */
export function planSettle(run: Run, answers: readonly CriterionAnswer[]): SettlePlan[] {
  if (run.state !== 'ended') return []
  const out: SettlePlan[] = []
  for (const a of answers) {
    const rc = run.checks.find((c) => c.id === a.checkId)
    if (!rc || !rc.countable || !hasTwoSignals(rc)) continue
    out.push({
      checkId: a.checkId,
      criterionId: a.criterionId,
      evidence: rc.report?.evidence ?? ''
    })
  }
  return out
}

/** Why a criterion a check answered stays open after the run: the words the close-out pairs with it. */
export type OpenWhy =
  'caveat' | 'failed' | 'skipped' | 'notReached' | 'nothingFromHere' | 'preClosed' | 'notWritten'

/**
 * The reason a check's criterion was not settled by the run. `notWritten` is the one odd case: the check did
 * close on two signals, yet the criterion is still open (the mission could not be written, or the run ended
 * before this rule existed), so the close-out sends the operator to the Mission as before.
 */
export function whyNotSettled(rc: RunCheck | undefined): OpenWhy {
  if (!rc) return 'notReached'
  if (hasTwoSignals(rc)) return 'notWritten'
  if (rc.state === 'failed') return 'failed'
  if (rc.state === 'skipped') return 'skipped'
  if (rc.state === 'todo' || rc.state === 'awaiting') return 'notReached'
  if (rc.closedHow === 'pre-closed') return 'preClosed'
  if (rc.state === 'verified') return 'nothingFromHere'
  return 'caveat'
}
