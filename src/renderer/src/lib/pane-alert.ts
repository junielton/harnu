/**
 * Pure helpers for the agent-pane OS alert (2026-07-13 agent-pane-routing
 * design §4). Two concerns kept framework-free so they unit-test without a
 * Pinia store or fake timers:
 *
 *  - **Coalescing**: a burst of N agent-opened panes landing in a
 *    non-visible folder must raise ONE native notification saying N, not N
 *    notifications. `enqueuePaneAlert`/`drainPaneAlert` are the pure counter;
 *    the store (`helpers.ts`) owns the impure `setTimeout` debounce around
 *    them, mirroring its existing `scheduleFlush` pattern.
 *  - **Target session**: a clicked alert activates "the folder's most
 *    recently active session" (the design's chosen least-surprising target,
 *    since a pane belongs to a folder, not a session). `mostRecentlyActive`
 *    mirrors the `recentKey` comparator `session-sort.ts` already uses for
 *    the sidebar's "recent" sort mode.
 */

/** Per-folder pending-alert counter, keyed by folder path. */
export type PaneAlertQueue = Map<string, number>

export function createPaneAlertQueue(): PaneAlertQueue {
  return new Map()
}

/** Record one more pending pane for `folder`; returns the new pending count. */
export function enqueuePaneAlert(queue: PaneAlertQueue, folder: string): number {
  const next = (queue.get(folder) ?? 0) + 1
  queue.set(folder, next)
  return next
}

/** Take (and clear) the pending count for `folder`. `0` when nothing was queued. */
export function drainPaneAlert(queue: PaneAlertQueue, folder: string): number {
  const count = queue.get(folder) ?? 0
  queue.delete(folder)
  return count
}

/** The minimal session shape `mostRecentlyActive` needs. */
export interface RecencyEntry {
  sessionId: string
  modified: string
}

/**
 * Pick the entry with the newest `modified` timestamp. An unparseable/empty
 * date sinks to the end (treated as `-Infinity`, matching `session-sort.ts`);
 * ties keep the first-seen entry. `null` on an empty list.
 */
export function mostRecentlyActive<T extends RecencyEntry>(entries: T[]): T | null {
  if (entries.length === 0) return null
  let best = entries[0]
  let bestMs = Date.parse(best.modified)
  if (!Number.isFinite(bestMs)) bestMs = -Infinity
  for (const entry of entries.slice(1)) {
    const ms = Date.parse(entry.modified)
    const val = Number.isFinite(ms) ? ms : -Infinity
    if (val > bestMs) {
      best = entry
      bestMs = val
    }
  }
  return best
}
