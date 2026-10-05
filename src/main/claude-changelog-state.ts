import type { ClaudeRelease } from './claude-changelog-parse'

/**
 * Persisted state for the Claude Code changelog watcher (stored at
 * `<userData>/claude-changelog.json`). Pure logic only — no fs, no electron — so
 * the seed/unread/merge rules are unit-testable in the node vitest env.
 */
export interface ClaudeChangelogState {
  /** Cached release list (newest-first). Lets the UI render instantly/offline. */
  releases: ClaudeRelease[]
  /** Version up to which the user has read. '' before the first successful fetch. */
  lastReadVersion: string
  /** Epoch ms of the last successful fetch. 0 = never fetched. */
  lastFetchedAt: number
}

export const EMPTY_STATE: ClaudeChangelogState = {
  releases: [],
  lastReadVersion: '',
  lastFetchedAt: 0
}

/**
 * How many cached releases sit above `lastReadVersion` (i.e. are unread). If the
 * read marker isn't in the list anymore (rolled off the top-N, or never set),
 * every release counts as unread — a safe over-count, never a silent zero.
 */
export function unreadCount(state: ClaudeChangelogState): number {
  const idx = state.releases.findIndex((r) => r.version === state.lastReadVersion)
  return idx === -1 ? state.releases.length : idx
}

export function hasUnread(state: ClaudeChangelogState): boolean {
  return unreadCount(state) > 0
}

/**
 * Fold a freshly-fetched release list into the prior state.
 *
 * - Empty fetch (network/parse failure) → keep the prior state untouched.
 * - First successful fetch ever (`lastFetchedAt === 0 && lastReadVersion === ''`)
 *   → seed `lastReadVersion` to the newest version so the backlog is silent: no
 *   dot, no notification. Only versions published *after* this fire.
 * - Otherwise → adopt the new list and report `hasNew` when the unread count rose
 *   (a newer version than the read marker appeared). Idempotent: re-fetching the
 *   same list reports `hasNew: false`.
 */
export function applyFetched(
  prev: ClaudeChangelogState,
  fetched: ClaudeRelease[],
  now: number
): { next: ClaudeChangelogState; hasNew: boolean } {
  if (fetched.length === 0) return { next: prev, hasNew: false }

  const base: ClaudeChangelogState = { ...prev, releases: fetched, lastFetchedAt: now }

  if (prev.lastFetchedAt === 0 && prev.lastReadVersion === '') {
    return { next: { ...base, lastReadVersion: fetched[0].version }, hasNew: false }
  }

  const hasNew = unreadCount(base) > unreadCount(prev)
  return { next: base, hasNew }
}

/** Mark everything read: advance the read marker to the newest version. */
export function markRead(state: ClaudeChangelogState): ClaudeChangelogState {
  return { ...state, lastReadVersion: state.releases[0]?.version ?? state.lastReadVersion }
}
