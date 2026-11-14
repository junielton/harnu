/**
 * Missions v4 S-5 (R-25) — the ONE waiting list: what a mission waits on the operator for.
 *
 * Built here, once, from values that are already derived (the mission record, its linked
 * children's live state, the server's progress and the derived steps' gates). Nothing in this file
 * reads a file, the fleet or GitHub, writes anything, or wakes anything: a read of a mission calls it
 * with the result of the pure derive. The MCP read (`mission_get`), `mission:list`, the companion, Your
 * move and the renderer all read THIS list. None builds its own list, none adds a row, and the wording
 * of an item (`ask`, `why`) is written here and nowhere else.
 *
 * The list is typed with the v4 kinds from the start: {@link describeWaiting} gives every item its v4
 * kind ({@link WaitingKind}, the rank) and its `ask` and `why`. The v3 sources (the operator-owed kinds
 * of Mission v3 §3.12) feed the list through the adapter below, and an item stays a plain v3 item (its
 * `kind` and fields) so the readers and the stored shape of `mission:list` and `mission_get` do not
 * move. S-8 swaps the adapter's sources for the v4 record; S-23 switches the readers that use v3 views.
 *
 * Pure and Electron-free: tests import it with nothing mocked.
 */

import { OPERATOR_VERIFIER, type DeclaredEnd, type Mission } from '../mission-core'
import type { MissionChildState } from '../mcp/fleet-snapshot'
import type { MissionProgress } from '../mission-progress'
import type { MissionStepSignals } from './derive'

/** The `you` line when the operator owes this mission nothing (design §4). */
export const YOU_CLEAR = "— nothing, you're clear"

/** `ask`: what to do, at most this many characters (spec "Progress, next step and the waiting list"). */
export const WAITING_ASK_MAX = 90
/** `why`: what it unlocks, at most this many characters. */
export const WAITING_WHY_MAX = 60

/**
 * The v4 kinds of a waiting item, in the rank the v4 list will use: `main-failing` (a merged step
 * whose `main` fact is red), `unblock` (an operator-owned blocker, a decision included), `settle` (an
 * operator criterion to mark), `review` (pull requests that wait for the operator), `close` (ready to
 * close), `attach` (a session asks to lead or join).
 */
export type WaitingKind = 'main-failing' | 'unblock' | 'settle' | 'review' | 'close' | 'attach'

/**
 * Mission v3 §3.12 — one thing the operator owes a mission: the detail of a waiting item, by v3
 * kind. `mission_get` reports the whole ordered list as `youItems` (and its first item as the `you`
 * line). A pending decision (`decide`) is in it since S-5: before, only the renderer knew about it.
 */
export type MissionYouItem =
  | { kind: 'rescope'; end: DeclaredEnd }
  | { kind: 'close' }
  /** Campaign spec §3.4 — the operator paused the steward; it does not tick until they resume it. */
  | { kind: 'steward-paused'; reason: string; at: string }
  | { kind: 'blocker'; reason: string; unblocks: string }
  /** An undecided decision node: the operator's to choose, and the steps it blocks stay locked. */
  | { kind: 'decide'; stepId: string; title: string }
  | { kind: 'checks'; count: number; stepIds: string[] }
  | { kind: 'human-steps'; stepIds: string[] }
  | { kind: 'review-import' }
  /** Campaign spec §3.2 — a step is done, its PR merged, and the merge commit's CI on main is red. */
  | { kind: 'main-red'; stepId: string; pr: number }
  | { kind: 'approvals'; count: number; sessionId: string }
  | { kind: 'needs-input'; sessionId: string }

/** One entry of the waiting list: a v3 item. Its v4 kind, ask and why come from {@link describeWaiting}. */
export type WaitingItem = MissionYouItem

/** What one item says: its v4 kind, what to do (`ask`) and what it unlocks (`why`). */
export interface WaitingText {
  /** The v4 kind (rank) the item sorts under once the list is ranked (S-8). */
  rank: WaitingKind
  /** What to do, at most {@link WAITING_ASK_MAX} characters. */
  ask: string
  /** What it unlocks, at most {@link WAITING_WHY_MAX} characters. */
  why: string
}

/** `s` cut to `max` characters, with an ellipsis when it was cut. */
function cap(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * The v4 kind, the ask and the why of one item: the ONE wording of an item. No consumer writes its
 * own; the companion and the rest read it from here.
 */
export function describeWaiting(item: MissionYouItem): WaitingText {
  const out = (rank: WaitingKind, ask: string, why: string): WaitingText => ({
    rank,
    ask: cap(ask, WAITING_ASK_MAX),
    why: cap(why, WAITING_WHY_MAX)
  })
  switch (item.kind) {
    case 'rescope':
      return out(
        'unblock',
        `Approve the new declared end: ${item.end.target}`,
        'The mission closes against the new end'
      )
    case 'close':
      return out('close', 'Close the mission: its end is verified', 'It leaves every surface')
    case 'steward-paused':
      return out(
        'unblock',
        `Resume the steward (${item.reason})`,
        'It does not tick until you resume it'
      )
    case 'blocker':
      return out('unblock', `Unblock: ${item.reason}`, `Unblocks when ${item.unblocks}`)
    case 'decide':
      return out('unblock', `Decide: ${item.title}`, 'The steps it blocks stay locked until then')
    case 'checks':
      return out(
        'settle',
        `Tick ${plural(item.count, 'due check')} on ${item.stepIds.join(', ')}`,
        'A step waits on your sign-off'
      )
    case 'human-steps':
      return out(
        'settle',
        `Confirm the human ${item.stepIds.length === 1 ? 'step' : 'steps'} ${item.stepIds.join(', ')}`,
        'The work moves on once you mark it'
      )
    case 'review-import':
      return out(
        'settle',
        'Review the imported end: it is a placeholder',
        'Approve a re-scope to replace it'
      )
    case 'main-red':
      return out(
        'main-failing',
        `main is red after #${item.pr}: ${item.stepId} fails CI once merged`,
        'Merged work is not safe until main is green'
      )
    case 'approvals':
      return out(
        'unblock',
        `Answer ${plural(item.count, 'pending approval')} from session ${item.sessionId.slice(0, 8)}`,
        'That session cannot go on until you answer'
      )
    case 'needs-input':
      return out(
        'unblock',
        `Session ${item.sessionId.slice(0, 8)} is waiting on you: open it and answer`,
        'That session cannot go on until you answer'
      )
  }
}

/** The kinds that block others: a pending decision is listed right after the last of them. */
const BLOCKING_FIRST: ReadonlySet<MissionYouItem['kind']> = new Set([
  'rescope',
  'close',
  'steward-paused',
  'blocker',
  'main-red'
])

/**
 * What the operator owes this mission, in this order (the v3 order, kept by the adapter): a re-scope
 * to approve, a pending close, a paused steward, each operator-owned blocker, the due checks (unticked
 * checks on a reached step — not `todo`/`blocked`), the `human` steps that are current or left behind
 * and not ticked, an imported end to review, red `main`, and the linked children's parked approvals
 * and needs-input. Each undecided decision node is listed after the last blocking item. A closed
 * mission owes nothing. A dead legacy draft (read as active) owes nothing either: stale is not an owed
 * kind.
 */
export function waitingList(
  m: Mission,
  children: readonly Pick<MissionChildState, 'sessionId' | 'pendingApprovals' | 'taskState'>[],
  progress: MissionProgress,
  /** The derived steps, for the gates (campaign spec §3.2); omitted = no gate items. */
  steps: readonly Pick<MissionStepSignals, 'stepId' | 'gates' | 'prNumber'>[] = []
): WaitingItem[] {
  if (m.status === 'closed') return []
  const items: MissionYouItem[] = []
  if (m.pendingRescope) items.push({ kind: 'rescope', end: m.pendingRescope })
  if (m.pendingClose) items.push({ kind: 'close' })
  if (m.stewardPause) {
    items.push({ kind: 'steward-paused', reason: m.stewardPause.reason, at: m.stewardPause.at })
  }
  for (const b of [...m.blockers, ...m.steps.flatMap((s) => s.blockers)]) {
    if (b.owner === 'operator')
      items.push({ kind: 'blocker', reason: b.reason, unblocks: b.unblocks })
  }
  const reached = (stepId: string): boolean => {
    const st = progress.states[stepId]
    return st !== undefined && st !== 'todo' && st !== 'blocked'
  }
  const due = m.steps.flatMap((s) =>
    reached(s.id) ? (s.checks ?? []).filter((c) => !c.ticked).map(() => s.id) : []
  )
  if (due.length > 0) items.push({ kind: 'checks', count: due.length, stepIds: [...new Set(due)] })
  // A `human` step is the operator's gate: it is owed until the OPERATOR ticks it
  // (proof verified by the 'operator' verifier) — a claim by the owner reads `done`
  // in progress but never clears it, and a gate the work moved past (a later step
  // running, or the mission otherwise reached it) must not drop off the list.
  const current = progress.current
  // The headline's own steps: `current` counts positions among them, so a side step
  // (`required: false`, campaign spec §3.2) must not shift the index.
  const counted = m.steps.filter((s) => s.kind !== 'fixed-start' && s.required !== false)
  const humans = counted
    .filter((s, i) => {
      if (s.verification !== 'human') return false
      if (s.proof === 'verified' && s.verifiedBy?.sessionId === OPERATOR_VERIFIER) return false
      // A decision the operator has made is finished — nothing left to confirm.
      if (s.decision?.chosen !== undefined) return false
      const isCurrent = current !== null && i + 1 >= current.from && i + 1 <= current.to
      return reached(s.id) || isCurrent || progress.leftBehind.includes(s.id)
    })
    .map((s) => s.id)
  if (humans.length > 0) items.push({ kind: 'human-steps', stepIds: humans })
  if (m.legacy?.needsReview.includes('declaredEnd')) items.push({ kind: 'review-import' })
  // A red main after a merge downgrades nothing stored — the step stays as it was —
  // but it is the operator's to know about (campaign spec §8 AC-1).
  for (const st of steps) {
    const state = progress.states[st.stepId]
    if (
      st.gates.main === 'red' &&
      st.prNumber !== null &&
      (state === 'done' || state === 'verified')
    ) {
      items.push({ kind: 'main-red', stepId: st.stepId, pr: st.prNumber })
    }
  }
  for (const c of children) {
    if (c.pendingApprovals > 0) {
      items.push({ kind: 'approvals', count: c.pendingApprovals, sessionId: c.sessionId })
    }
  }
  for (const c of children) {
    if (c.taskState === 'needs-input') items.push({ kind: 'needs-input', sessionId: c.sessionId })
  }
  // A pending decision waits on the operator like a blocker does: it is in the list (the renderer
  // used to add it on its own, so the chip, Activity and Your move never saw it), right after the
  // last blocking item.
  const decisions: MissionYouItem[] = m.steps
    .filter((s) => s.decision !== undefined && s.decision.chosen === undefined)
    .map((s) => ({ kind: 'decide', stepId: s.id, title: s.decision?.title ?? '' }))
  if (decisions.length > 0) {
    let at = 0
    items.forEach((it, i) => {
      if (BLOCKING_FIRST.has(it.kind)) at = i + 1
    })
    items.splice(at, 0, ...decisions)
  }
  return items
}

/** One {@link MissionYouItem} as an English sentence (the `you` line and a Your move card). */
export function youSentence(item: MissionYouItem): string {
  const s = (n: number): string => (n === 1 ? '' : 's')
  switch (item.kind) {
    case 'rescope':
      return `Approve the new declared end (${item.end.kind}: ${item.end.target}).`
    case 'close':
      return 'Close the mission — its end is verified and a close was requested.'
    case 'steward-paused':
      return `The steward is paused (${item.reason}) — resume it from the mission popover when ready.`
    case 'blocker':
      return `Unblock: ${item.reason} — unblocks when ${item.unblocks}.`
    case 'decide':
      return `Decide: ${item.title} — the steps it blocks stay locked until you choose.`
    case 'checks':
      return `Tick ${item.count} due check${s(item.count)} — on ${item.stepIds.join(', ')}.`
    case 'human-steps':
      return `Confirm the human step${s(item.stepIds.length)} ${item.stepIds.join(', ')}.`
    case 'review-import':
      return 'Review the imported end — it is a placeholder until you approve a re-scope.'
    case 'main-red':
      return `main is red after #${item.pr} — ${item.stepId} is merged but its merge commit fails CI.`
    case 'approvals':
      return `Answer ${item.count} pending approval${s(item.count)} in the Approval Inbox — from linked session ${item.sessionId.slice(0, 8)}.`
    case 'needs-input':
      return `Linked session ${item.sessionId.slice(0, 8)} is waiting on you (needs-input) — open it and answer.`
  }
}

/** The `you` line `mission_get` reports: the first item, plus "(+N more)". */
export function youLine(items: readonly MissionYouItem[]): string {
  if (items.length === 0) return YOU_CLEAR
  const more = items.length > 1 ? ` (+${items.length - 1} more)` : ''
  return `${youSentence(items[0])}${more}`
}
