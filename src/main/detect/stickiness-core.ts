/**
 * Blocked-stickiness core (A2 two-tier state detection — T3).
 *
 * The anti-flicker guard on the screen-derived `TaskState`. A screen scrape runs
 * frame-to-frame; a spinner repaint or an identical re-render must NOT bounce a
 * pane out of `needs-input` (blocked) just because a single intermediate frame
 * failed to re-match the prompt. So a `needs-input` state is STICKY: it holds
 * until the bottom buffer actually CHANGES (the prompt was answered / replaced),
 * mirroring how the hook FSM keeps `needs-input` until a real transition
 * (`hook-state.ts` — "a 20-minute blocked session stays visibly blocked").
 *
 * `working ↔ idle` carry no stickiness here — they flip freely on each scrape
 * (their debounce is the snapshot cadence in the shell, plan T6). Only the
 * headline blocked state is protected, because a false un-block is the costly
 * error (you stop noticing an agent that needs you).
 *
 * Pure + deterministic; the "did the screen change" decision is computed by
 * `bottom-lines-core.linesChanged` in the shell and passed in as a bool, keeping
 * this a trivial, fully-covered reducer.
 */

import type { TaskState } from '../hook-state'

/**
 * Apply blocked-stickiness when folding a freshly-merged state over the previous
 * one.
 *
 * @param prev          - the session's current `TaskState`.
 * @param next          - the newly-merged `TaskState` from this scrape.
 * @param screenChanged - whether the normalized bottom buffer changed since the
 *                        scrape that produced `prev`.
 * @returns `prev` held at `needs-input` when the screen is unchanged; otherwise
 *          `next`.
 */
export function applyStickiness(
  prev: TaskState,
  next: TaskState,
  screenChanged: boolean
): TaskState {
  // Hold a blocked pane until the screen actually changes — a spinner frame or
  // an identical re-render (screenChanged === false) can never un-block it.
  if (prev === 'needs-input' && !screenChanged) return 'needs-input'
  return next
}
