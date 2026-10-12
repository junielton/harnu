// The disk side of "Empty what Harnu moved to the trash" (unit C, AC-C5). A clean moves a checkout
// to the OS trash; this finds exactly those items again and removes them, never anything else in
// the user's trash. Only the freedesktop trash (Linux) can be read item by item: its `info/*.trashinfo`
// records say where each item came from and when. macOS and Windows keep no such record Harnu can
// match, so there it does nothing and says where the trash is.
//
// env-bound (`node:fs`) but takes its directories as an argument, so tests drive it with a fake
// trash. The decisions (what counts as "the same move") are in trash-core.ts.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { matchesTrashed, parseTrashInfo, type GcTrashCard, type TrashedEntry } from './trash-core'

export interface TrashEnv {
  platform: NodeJS.Platform
  /** `$XDG_DATA_HOME/Trash`, normally `~/.local/share/Trash`. */
  homeTrash: string
  /** The user id, for a per-volume trash (`<mount>/.Trash-<uid>`); null when unknown. */
  uid: number | null
}

/** The trash Harnu can read selectively, or none. */
export const canEmptySelectively = (platform: NodeJS.Platform): boolean => platform === 'linux'

/** Where the OS keeps the trash, for the message shown when Harnu cannot empty it itself. */
export function trashLocation(platform: NodeJS.Platform, homeTrash: string): string {
  if (platform === 'darwin') return '~/.Trash'
  if (platform === 'win32') return 'Recycle Bin'
  return homeTrash
}

/** The `GcTrashCard` for what the ledger still holds. */
export function trashCard(
  present: readonly TrashedEntry[],
  unsupported: boolean,
  env: TrashEnv
): GcTrashCard {
  return {
    inTrashBytes: present.reduce((n, e) => n + (e.bytes ?? 0), 0),
    inTrashCount: present.length,
    canEmpty: !unsupported,
    location: trashLocation(env.platform, env.homeTrash)
  }
}

/** One item found in a trash directory. */
interface Found {
  /** The trash directory (`.../Trash` or `<mount>/.Trash-<uid>`). */
  trashDir: string
  /** The item's name inside `files/` and, plus `.trashinfo`, inside `info/`. */
  name: string
  entry: TrashedEntry
}

/** Every ancestor directory of a path, nearest first: where a per-volume trash could sit. */
function ancestors(p: string): string[] {
  const out: string[] = []
  let dir = path.dirname(p)
  while (dir && dir !== path.dirname(dir)) {
    out.push(dir)
    dir = path.dirname(dir)
  }
  return out
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** The trash directories an item trashed from `original` could be in: home, then per-volume. */
async function candidateTrashes(
  original: string,
  env: TrashEnv
): Promise<Array<{ dir: string; topdir: string | null }>> {
  const out: Array<{ dir: string; topdir: string | null }> = [{ dir: env.homeTrash, topdir: null }]
  for (const top of ancestors(original)) {
    const spots =
      env.uid === null
        ? []
        : [path.join(top, `.Trash-${env.uid}`), path.join(top, '.Trash', String(env.uid))]
    for (const dir of spots) if (await isDir(dir)) out.push({ dir, topdir: top })
  }
  return out
}

/** A trashinfo name that can only name a file directly inside `info/`. */
const safeName = (name: string): boolean =>
  name.length > 0 && name !== '.' && name !== '..' && !/[\\/\0]/.test(name)

/** Looks the entry up in every trash it could be in. The first trash holding the same move wins. */
async function locate(entry: TrashedEntry, env: TrashEnv): Promise<Found | null> {
  for (const { dir, topdir } of await candidateTrashes(entry.path, env)) {
    let names: string[]
    try {
      names = await fs.readdir(path.join(dir, 'info'))
    } catch {
      continue
    }
    for (const file of names) {
      if (!file.endsWith('.trashinfo')) continue
      const name = file.slice(0, -'.trashinfo'.length)
      if (!safeName(name)) continue
      let text: string
      try {
        text = await fs.readFile(path.join(dir, 'info', file), 'utf8')
      } catch {
        continue
      }
      const info = parseTrashInfo(text)
      if (info && matchesTrashed(info, entry, topdir)) return { trashDir: dir, name, entry }
    }
  }
  return null
}

export interface PresentResult {
  present: TrashedEntry[]
  gone: TrashedEntry[]
  /** True when this machine's trash cannot be read item by item: `present` is then every entry. */
  unsupported: boolean
}

/**
 * Splits the ledger into what is still in the trash and what is not (the user emptied it, or
 * restored it). Where the trash cannot be read, everything is reported present and `unsupported`
 * says the figure is the journal's word alone.
 */
export async function presentInTrash(
  entries: readonly TrashedEntry[],
  env: TrashEnv
): Promise<PresentResult> {
  if (!canEmptySelectively(env.platform)) {
    return { present: [...entries], gone: [], unsupported: true }
  }
  const present: TrashedEntry[] = []
  const gone: TrashedEntry[] = []
  for (const e of entries) ((await locate(e, env)) ? present : gone).push(e)
  return { present, gone, unsupported: false }
}

export interface EmptyResult {
  /** Ledger keys whose item was removed from the trash. */
  emptied: string[]
  /** Ledger keys whose item was no longer there. */
  missing: string[]
  failed: Array<{ key: string; error: string }>
  /** Bytes of what was emptied, from the journal. */
  emptiedBytes: number
  unsupported: boolean
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Permanently removes the items Harnu moved to the trash, and only those: each is found by its
 * own `.trashinfo` (same original path, same moment), then its data under `files/` and its record
 * under `info/` go. A symlink inside a trashed folder is removed, never followed. Where the trash
 * cannot be read item by item, nothing is touched.
 */
export async function emptyHarnuTrash(
  entries: readonly TrashedEntry[],
  env: TrashEnv
): Promise<EmptyResult> {
  const result: EmptyResult = {
    emptied: [],
    missing: [],
    failed: [],
    emptiedBytes: 0,
    unsupported: !canEmptySelectively(env.platform)
  }
  if (result.unsupported) return result
  for (const e of entries) {
    const found = await locate(e, env)
    if (!found) {
      result.missing.push(e.key)
      continue
    }
    try {
      // The data first: a record left behind without its data is harmless, the reverse is an
      // orphan the file manager cannot show.
      await fs.rm(path.join(found.trashDir, 'files', found.name), { recursive: true, force: true })
      await fs.rm(path.join(found.trashDir, 'info', `${found.name}.trashinfo`), { force: true })
      result.emptied.push(e.key)
      result.emptiedBytes += e.bytes ?? 0
    } catch (err) {
      result.failed.push({ key: e.key, error: messageOf(err) })
    }
  }
  return result
}
