/**
 * Browser-style back/forward over the sessions the operator viewed
 * (docs/specs/2026-10-06-session-nav-history.md §5.1).
 *
 * Pure: no Vue, no store imports. The sessions store owns one instance, records
 * every selection through `push`, and asks `back` / `forward` which session to
 * show next. Liveness is injected per call (`isLive`) so a closed or deleted
 * session is skipped without the history having to be told about removals.
 *
 * In memory only (spec D-2): a restart starts with an empty history.
 */
export interface NavHistory {
  /** Record a visit. No-op when `id` is already under the cursor. Truncates forward entries; caps at `max`. */
  push(id: string): void
  /** Move the cursor back to the nearest entry that `isLive` accepts and that differs from the current id. Returns the id, or null. */
  back(isLive: (id: string) => boolean): string | null
  forward(isLive: (id: string) => boolean): string | null
  /** The id under the cursor, or null when empty. */
  current(): string | null
  /** Rewrite every entry `from` → `to` (synthetic → real migration). */
  rename(from: string, to: string): void
}

export function createNavHistory(max = 50): NavHistory {
  let entries: string[] = []
  // Index of the entry being shown; -1 while empty.
  let cursor = -1

  function current(): string | null {
    return cursor >= 0 ? entries[cursor] : null
  }

  function push(id: string): void {
    if (current() === id) return
    entries = entries.slice(0, cursor + 1)
    entries.push(id)
    if (entries.length > max) entries = entries.slice(entries.length - max)
    cursor = entries.length - 1
  }

  /**
   * Walk from the cursor in `step` direction to the first entry that is live
   * and differs from the current id (an equal entry would be a press that
   * visibly does nothing). The cursor only moves on a hit.
   */
  function walk(step: 1 | -1, isLive: (id: string) => boolean): string | null {
    const here = current()
    for (let i = cursor + step; i >= 0 && i < entries.length; i += step) {
      const id = entries[i]
      if (id !== here && isLive(id)) {
        cursor = i
        return id
      }
    }
    return null
  }

  return {
    push,
    back: (isLive) => walk(-1, isLive),
    forward: (isLive) => walk(1, isLive),
    current,
    rename(from, to) {
      entries = entries.map((id) => (id === from ? to : id))
    }
  }
}
