import type { TaskState } from '../../../preload'

/**
 * Pure attention-signal logic (attention-badge spec §4.1). Mirrors
 * `session-sort.ts` / `hook-state.ts`: no Pinia, no electron, no DOM — so it's
 * unit-testable in isolation (`tests/attention.test.ts`). The store wires the
 * count to `document.title` + the OS badge.
 */

/** The minimal slice the counter inspects. */
export interface AttentionSession {
  taskState?: TaskState
}

/**
 * How many fleet sessions are waiting on you. Today: `taskState === 'needs-input'`.
 * `failed` is an already-notified edge, not a persistent actionable queue, so it
 * does not count.
 */
export function countNeedsInput(sessions: readonly AttentionSession[]): number {
  let n = 0
  for (const s of sessions) if (s.taskState === 'needs-input') n++
  return n
}

/**
 * Window title for a given count + app base name. `0` → just the name; `> 0` →
 * `"<prefix> <baseName>"`. Pure (the App resolves the i18n base + prefix strings);
 * this only decides the prefix/branch.
 */
export function formatWindowTitle(
  count: number,
  baseName: string,
  attentionPrefix: string
): string {
  return count > 0 ? `${attentionPrefix} ${baseName}` : baseName
}
