/**
 * The seam between the Mission dropdown and guided walks (Missions v4 mission dropdown S-6, AC-18 and AC-19;
 * design.md §6 "Mission dropdown" → "Test it (the entry for guided walks)").
 *
 * The dropdown owns where a walk STARTS from: a "Test it" control on an open step, on the open milestone and,
 * at the end of a mission, on the whole mission. It does not own what a walk is. Each control asks
 * {@link walkEntryAvailable} for its source and is drawn only when the answer is yes; a click calls
 * {@link startWalk} and the dropdown then closes itself. Opening the walk's pane, in the helper stack and never
 * inside the dropdown, is the provider's job.
 *
 * The shipped provider answers no and does nothing, so no control that does nothing reaches a user. The
 * guided-walk work installs its own with {@link setWalkEntryProvider} and decides there, per source, when a walk
 * is offered. The dropdown changes nothing for it.
 *
 * The installed provider is reactive (a shallow ref): a provider that reads reactive state in `available`
 * makes the controls appear and disappear as that state changes, and one installed after the dropdown mounted
 * is picked up without a remount.
 */
import { shallowRef } from 'vue'

/** What a walk starts from: one step, one milestone or the whole mission. */
export type WalkSource =
  | { kind: 'step'; missionId: string; stepId: string }
  | { kind: 'milestone'; missionId: string; milestoneId: string }
  | { kind: 'mission'; missionId: string }

/** The two answers a walk provider gives: whether a walk can start from a source, and starting it. */
export interface WalkEntryProvider {
  available(source: WalkSource): boolean
  start(source: WalkSource): void
}

/** The shipped provider: no walk is offered, and starting one does nothing. */
const SHIPPED: WalkEntryProvider = {
  available: () => false,
  start: () => undefined
}

const current = shallowRef<WalkEntryProvider>(SHIPPED)

/** Whether a walk can start from this source: the one question that decides whether a control is drawn. */
export function walkEntryAvailable(source: WalkSource): boolean {
  return current.value.available(source)
}

/** Start the walk for this source. The caller closes the dropdown afterwards; the provider opens the walk. */
export function startWalk(source: WalkSource): void {
  current.value.start(source)
}

/** Install the provider that answers for walks; `null` brings the shipped one back. */
export function setWalkEntryProvider(provider: WalkEntryProvider | null): void {
  current.value = provider ?? SHIPPED
}
