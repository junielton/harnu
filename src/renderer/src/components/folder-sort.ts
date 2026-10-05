/**
 * Folder sort (sidebar folder ordering). Mirrors `session-sort.ts`.
 *
 * - `recent` — most-recent activity first (max session `modified`/`fileMtime`
 *   across the folder; an empty/unparseable date sinks via -Infinity). Matches
 *   the legacy main-process order, so this mode is behaviour-preserving.
 * - `name`   — case-insensitive A→Z over `alias`. Stable across session output:
 *   a folder never moves just because one of its sessions emitted a line, which
 *   is the whole point (folder-sort spec 2026-06-22 §2).
 *
 * Both modes are pure + stable (equal keys keep input order via the index
 * tiebreak) and return a NEW array — the input is never mutated. Pure so it
 * stays unit-testable.
 */
export type FolderSortMode = 'recent' | 'name'

type SortableSession = {
  modified: string
  fileMtime: number
}

type SortableFolder = {
  alias: string
  sessions: SortableSession[]
}

/**
 * Most-recent activity (ms) of a folder. Duplicates the main-process
 * `folderActivity` (`claude-reader.ts`) intentionally so the renderer sort is
 * self-contained and independently testable; the two are idempotent for the
 * `recent` mode (both sort by the same key).
 */
export function folderActivity(f: SortableFolder): number {
  let max = -Infinity
  for (const s of f.sessions) {
    const t = Date.parse(s.modified)
    const candidate = Number.isFinite(t) && t > 0 ? t : s.fileMtime
    if (candidate > max) max = candidate
  }
  return max
}

export function sortFolders<T extends SortableFolder>(folders: T[], mode: FolderSortMode): T[] {
  const decorated = folders.map((f, i) => ({ f, i }))

  const cmp =
    mode === 'name'
      ? (a: { f: T; i: number }, b: { f: T; i: number }): number =>
          a.f.alias.localeCompare(b.f.alias, undefined, { sensitivity: 'base' })
      : (a: { f: T; i: number }, b: { f: T; i: number }): number =>
          folderActivity(b.f) - folderActivity(a.f)

  return decorated.sort((a, b) => cmp(a, b) || a.i - b.i).map((x) => x.f)
}
