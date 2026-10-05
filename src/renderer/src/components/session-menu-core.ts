import type { TaskState } from '../../../preload'

/**
 * Inputs the "Restart session" menu item's visibility decision needs.
 * Pure and side-effect-free so it's unit-testable without mounting
 * `SessionMenu.vue` or standing up the full sessions Pinia store.
 */
export interface RestartVisibilityInput {
  isSynthetic: boolean
  isLive: boolean
  taskState: TaskState | undefined
}

/**
 * Whether the "Restart session" menu item should be shown.
 *
 * Synthetic sessions never show it — they have their own Retry/Dismiss
 * recovery pair (see `SessionMenu.vue`'s `entries` computed) since a
 * synthetic has no JSONL on disk to resume from.
 *
 * A real (disk-backed) session shows it when live (kill + respawn in place,
 * the original behavior) OR once it has ended — `taskState` is `'failed'`
 * or `'completed'`. The ended case exists because reselecting an ended
 * session's sidebar row does NOT respawn it on its own: the session's
 * cached `LiveTerminal` is reattached (frozen scrollback), not recreated —
 * only an explicit Restart disposes it and spawns fresh. Any other
 * `taskState` (`'idle'`, `'working'`, `'needs-input'`, `'stopped'`, or
 * `undefined` for a dormant disk session never opened this app run) means
 * there's nothing this action would meaningfully change over just selecting
 * the row, so it stays hidden.
 */
export function shouldShowRestart(input: RestartVisibilityInput): boolean {
  if (input.isSynthetic) return false
  if (input.isLive) return true
  return input.taskState === 'failed' || input.taskState === 'completed'
}
