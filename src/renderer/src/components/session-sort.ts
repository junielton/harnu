import type { TaskState } from '../../../preload'

/**
 * Session sort (sidebar ordering). Generalizes `sortByAttention` into the three
 * user-facing modes so a list can be reordered without surprising reshuffles:
 *
 * - `attention` — float the sessions that need a human: `needs-input` (blocked
 *   on an approval) first, then `failed`, everything else keeping order.
 * - `recent`    — newest `modified` first; an unparseable/empty date sinks to
 *   the end (treated as -Infinity).
 * - `name`      — case-insensitive A→Z over `summary` (falling back to
 *   `firstPrompt`).
 *
 * All modes are pure + stable: equal sort keys keep their input order via the
 * index tiebreak, and a new array is always returned (the input is never
 * mutated). Pure so it stays unit-testable.
 */
export type SessionSortMode = 'attention' | 'recent' | 'name'

type SortableSession = {
  taskState?: TaskState
  modified: string
  summary: string
  firstPrompt: string
}

function attentionRank(t?: TaskState): number {
  if (t === 'needs-input') return 0
  if (t === 'failed') return 1
  return 2
}

function recentKey(modified: string): number {
  const ms = Date.parse(modified)
  return Number.isFinite(ms) ? ms : -Infinity
}

function nameKey(session: SortableSession): string {
  return session.summary || session.firstPrompt || ''
}

export function sortSessions<T extends SortableSession>(sessions: T[], mode: SessionSortMode): T[] {
  const decorated = sessions.map((s, i) => ({ s, i }))

  const cmp =
    mode === 'attention'
      ? (a: { s: T; i: number }, b: { s: T; i: number }): number =>
          attentionRank(a.s.taskState) - attentionRank(b.s.taskState)
      : mode === 'recent'
        ? (a: { s: T; i: number }, b: { s: T; i: number }): number =>
            recentKey(b.s.modified) - recentKey(a.s.modified)
        : (a: { s: T; i: number }, b: { s: T; i: number }): number =>
            nameKey(a.s).localeCompare(nameKey(b.s), undefined, { sensitivity: 'base' })

  return decorated.sort((a, b) => cmp(a, b) || a.i - b.i).map((x) => x.s)
}
