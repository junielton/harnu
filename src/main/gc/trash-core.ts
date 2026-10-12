// The "in the trash" side of Cleanup (unit C). A clean moves a checkout to the OS trash, so the
// disk space only comes back when the trash is emptied. Harnu records what IT trashed (the journal
// line carries `trashedPath`, `trashedBytes` and `trashedAt`) so it can say how much that is and
// empty exactly those items, never the user's other trash. This file is the pure part: the ledger
// view and the freedesktop `.trashinfo` format. The disk side is trash-shell.ts.

import type { Tombstone } from '../reaper/journal'

/** The "in the trash" card of the snapshot. */
export interface GcTrashCard {
  /** Bytes of what Harnu moved to the trash and that is still there. */
  inTrashBytes: number
  inTrashCount: number
  /**
   * Whether Harnu can empty only its own items on this machine (the freedesktop trash on Linux).
   * Elsewhere the OS offers no way to tell Harnu's items from the user's, and Harnu leaves the
   * trash alone.
   */
  canEmpty: boolean
  /** Where the OS keeps the trash, for the message shown when Harnu cannot empty it. */
  location: string
}

export const NO_TRASH: GcTrashCard = {
  inTrashBytes: 0,
  inTrashCount: 0,
  canEmpty: false,
  location: ''
}

/** One folder Harnu moved to the trash, as the journal recorded it. */
export interface TrashedEntry {
  /** The journal line's identity: stable, so an "emptied" mark survives a restart. */
  key: string
  path: string
  bytes: number | null
  at: number
  repoPath: string
  branch: string | null
}

/** `trashedAt|trashedPath`: the move is the identity (a path can be trashed again later). */
export const trashKey = (at: number, path: string): string => `${at}|${path}`

/**
 * The folders Harnu moved to the trash, newest first, minus those already emptied or found gone.
 * Journal lines without a recorded path (older, or nothing trashed) are not Harnu's to empty.
 */
export function trashedEntries(
  journal: readonly Tombstone[],
  settled: ReadonlySet<string>
): TrashedEntry[] {
  const out: TrashedEntry[] = []
  for (const t of journal) {
    if (typeof t.trashedPath !== 'string' || !t.trashedPath) continue
    const at = typeof t.trashedAt === 'number' ? t.trashedAt : t.at
    const key = trashKey(at, t.trashedPath)
    if (settled.has(key)) continue
    out.push({
      key,
      path: t.trashedPath,
      bytes: typeof t.trashedBytes === 'number' ? t.trashedBytes : null,
      at,
      repoPath: t.repoPath,
      branch: t.branch
    })
  }
  return out.sort((a, b) => b.at - a.at)
}

// ---- freedesktop trash (XDG Trash specification 1.0) -------------------------------------------

/** What a `.trashinfo` file says: where the item came from, and when it was trashed. */
export interface TrashInfo {
  /** Absolute original path, or the path relative to the trash's top directory. */
  path: string
  relative: boolean
  /** The `DeletionDate` as local wall-clock time, in ms; NaN when it cannot be read. */
  deletedAt: number
}

/** `%20`-style decoding of the `Path=` key, tolerant of a stray `%`. */
function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * Reads one `.trashinfo`. `topdir` is the trash's own top directory when the trash is a
 * per-volume one (`<mount>/.Trash-<uid>`): its `Path=` is relative to that directory. The home
 * trash always writes absolute paths. Null for a file that is not a trashinfo at all.
 */
export function parseTrashInfo(text: string): TrashInfo | null {
  let path: string | null = null
  let date: string | null = null
  let inSection = false
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '[Trash Info]') {
      inSection = true
      continue
    }
    if (trimmed.startsWith('[')) inSection = false
    if (!inSection) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq)
    const value = trimmed.slice(eq + 1)
    if (key === 'Path') path ??= decodePath(value)
    else if (key === 'DeletionDate') date ??= value
  }
  if (path === null) return null
  const m = date ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(date) : null
  const deletedAt = m
    ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).getTime()
    : Number.NaN
  return { path, relative: !path.startsWith('/'), deletedAt }
}

/**
 * How far a trashinfo's `DeletionDate` may sit from the moment Harnu recorded the move and still
 * be the same move. The date has one-second resolution and no time zone, and Harnu records its
 * time just after the move returns, so a minute either way is generous and a later trashing of a
 * folder at the same path (a worktree recreated there) is never mistaken for it.
 */
export const TRASH_MATCH_WINDOW_MS = 60_000

/**
 * Whether a trashinfo describes this exact move: same original path, trashed within the window.
 * A relative `Path=` is joined to `topdir` first; without a `topdir` it cannot match.
 */
export function matchesTrashed(
  info: TrashInfo,
  entry: Pick<TrashedEntry, 'path' | 'at'>,
  topdir: string | null
): boolean {
  let original = info.path
  if (info.relative) {
    if (topdir === null) return false
    original = `${topdir.replace(/\/+$/, '')}/${info.path}`
  }
  if (original.replace(/\/+$/, '') !== entry.path.replace(/\/+$/, '')) return false
  return (
    Number.isFinite(info.deletedAt) && Math.abs(info.deletedAt - entry.at) <= TRASH_MATCH_WINDOW_MS
  )
}
