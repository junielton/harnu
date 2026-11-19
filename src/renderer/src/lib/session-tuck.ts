/**
 * Tucking the session away (T790, design.md §6 "Tucking the session away").
 *
 * The session/helper divider stops at the 0.4 floor; pulling it {@link SESSION_TUCK_ARM_PX} further
 * arms the tuck. Pure, so the rules are unit-testable without a DOM.
 */
import { clampSplitRatio } from './split-orientation'

/** How far past the floor (px, on the drag axis) the divider must be pulled to arm the tuck. */
export const SESSION_TUCK_ARM_PX = 80

export interface DividerDragInput {
  /** The session area's share when the drag began. */
  startRatio: number
  /** Pointer travel on the drag axis since mousedown (px); negative shrinks the session area. */
  deltaPx: number
  /** The size of the row along the drag axis (px). */
  totalPx: number
}

export interface DividerDragResult {
  /** The ratio to apply: always inside [0.4, 0.8]. */
  ratio: number
  /** True once the divider is pulled far enough past the floor that releasing tucks the session. */
  armed: boolean
}

export function resolveDividerDrag(input: DividerDragInput): DividerDragResult {
  const { startRatio, deltaPx, totalPx } = input
  return { ratio: clampSplitRatio(startRatio + deltaPx / totalPx), armed: false }
}
