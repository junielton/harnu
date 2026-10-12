// The "in the trash" side of Cleanup (unit C). A clean moves a checkout to the OS trash, so the
// disk space only comes back when the trash is emptied. Harnu records, AT TRASH TIME, the exact
// trash entry its move created (the journal line carries `trashEntry`), so it can say how much of
// the trash is its own and empty exactly those entries, never the user's other trash. It never
// finds its items again by original path and time: a user who restores a folder and trashes it
// again creates a new entry with the same path, and that entry is theirs. This file is the pure
// part: the ledger view and the `.trashinfo` format. The disk side is trash-shell.ts.

import type { Tombstone } from '../reaper/journal'

/**
 * The entry a move created in the OS trash, identified when it was made. "Empty" deletes an entry
 * only if everything here still matches, so a restored-and-trashed-again folder (same path, same
 * name) is told apart by its new record file and by the rename having touched the folder.
 */
export type TrashEntryRecord =
  | {
      kind: 'freedesktop'
      /** The trash directory (`.../Trash`, or `<mount>/.Trash-<uid>`, or `<mount>/.Trash/<uid>`). */
      trashDir: string
      /** The entry's name inside `files/` and, plus `.trashinfo`, inside `info/`. */
      name: string
      /** The `.trashinfo`'s `DeletionDate`, exactly as written. */
      deletionDate: string
      /** The trashed folder itself (`files/<name>`): device, inode and change time. */
      dev: number
      ino: number
      ctimeMs: number
      /** The `.trashinfo` file: its inode and modification time. */
      infoIno: number
      infoMtimeMs: number
    }
  | {
      kind: 'macos'
      trashDir: string
      name: string
      dev: number
      ino: number
      ctimeMs: number
    }

/** One folder of the in-the-trash list the confirm dialog shows and sends back by id. */
export interface TrashListEntry {
  /** The ledger key: what `gc:trash:empty` is asked to delete. */
  id: string
  /** The folder's name, for the list. */
  name: string
  bytes: number | null
  at: number
}

/** The "in the trash" card of the snapshot. */
export interface GcTrashCard {
  /** What Harnu moved to the trash and that is verified to still be there, exactly. */
  inTrashBytes: number
  inTrashCount: number
  /** Those same entries, one by one: the dialog lists them and asks main to delete these ids. */
  entries: TrashListEntry[]
  /**
   * What Harnu moved to the trash but cannot check any more (no exact record, a volume that is not
   * mounted, a system whose trash it cannot read). Never claimed as space that is still there.
   */
  unverifiedBytes: number
  unverifiedCount: number
  /**
   * Whether Harnu can empty only its own entries on this machine (the freedesktop trash on Linux).
   * Elsewhere the OS offers no way to do it safely, and Harnu leaves the trash alone.
   */
  canEmpty: boolean
  /** Where the OS keeps the trash; null on Windows, where the renderer names the Recycle Bin. */
  location: string | null
}

export const NO_TRASH: GcTrashCard = {
  inTrashBytes: 0,
  inTrashCount: 0,
  entries: [],
  unverifiedBytes: 0,
  unverifiedCount: 0,
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
  /** The exact trash entry, or null for a line written before it was recorded (or when it could not be told). */
  exact: TrashEntryRecord | null
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
      branch: t.branch,
      exact: t.trashEntry ?? null
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
  /** The `DeletionDate` as written. */
  deletionDate: string | null
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

/** Reads one `.trashinfo`. Null for a file that is not one at all. */
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
  return { path, relative: !path.startsWith('/'), deletionDate: date, deletedAt }
}

/** The original path a trashinfo names, resolved against the trash's top directory when relative. */
export function originalPathOf(info: TrashInfo, topdir: string | null): string | null {
  if (!info.relative) return info.path
  return topdir === null ? null : `${topdir.replace(/\/+$/, '')}/${info.path}`
}

/** True when everything the record fingerprinted is what is observed now. */
export function sameFingerprint(a: TrashEntryRecord, b: TrashEntryRecord): boolean {
  if (a.kind !== b.kind || a.trashDir !== b.trashDir || a.name !== b.name) return false
  if (a.dev !== b.dev || a.ino !== b.ino || a.ctimeMs !== b.ctimeMs) return false
  if (a.kind === 'freedesktop' && b.kind === 'freedesktop') {
    return (
      a.deletionDate === b.deletionDate &&
      a.infoIno === b.infoIno &&
      a.infoMtimeMs === b.infoMtimeMs
    )
  }
  return true
}
