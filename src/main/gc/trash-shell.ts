// The disk side of "Empty what Harnu moved to the trash" (unit C, AC-C5).
//
// A clean moves a checkout to the OS trash. To empty exactly that and nothing else, Harnu identifies
// the entry the move created WHILE it makes the move (`recordTrash`: the trash listing before and
// after, plus a fingerprint of the entry), and later deletes an entry only when everything in that
// record still matches (`emptyHarnuTrash`). It never searches the trash by original path and time,
// which cannot tell its own entry from one the user created by restoring the folder and trashing
// it again.
//
// Only the freedesktop trash (Linux) is emptied. macOS gets the same record (a name and an inode
// in `~/.Trash`) so the figure can be checked, but Harnu leaves that trash alone; Windows records
// nothing. env-bound (`node:fs`), but every directory comes in through `TrashEnv`, so tests drive
// it with a fake trash. The format and the fingerprint comparison are in trash-core.ts.

import { promises as fs, type Stats } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { rawRm } from '../raw-fs'
import {
  originalPathOf,
  parseTrashInfo,
  type GcTrashCard,
  type TrashedEntry,
  type TrashEntryRecord,
  type TrashListEntry
} from './trash-core'

export interface TrashEnv {
  platform: NodeJS.Platform
  /** `$XDG_DATA_HOME/Trash` (Linux), `~/.Trash` (macOS). */
  homeTrash: string
  /** The user id, for a per-volume trash (`<mount>/.Trash-<uid>`); null when unknown. */
  uid: number | null
  /**
   * Whether a directory is a mount point. A per-volume trash only counts at one; tests inject it
   * because a fake mount point lives on the same device as everything else.
   */
  isMountPoint?: (dir: string) => Promise<boolean>
}

/** The real environment: the user's home trash on this machine. */
export function defaultTrashEnv(): TrashEnv {
  const platform = process.platform
  const dataHome = process.env.XDG_DATA_HOME
  const homeTrash =
    platform === 'darwin'
      ? path.join(os.homedir(), '.Trash')
      : path.join(
          dataHome && path.isAbsolute(dataHome)
            ? dataHome
            : path.join(os.homedir(), '.local', 'share'),
          'Trash'
        )
  return {
    platform,
    homeTrash,
    uid: typeof process.getuid === 'function' ? process.getuid() : null
  }
}

/** The trash Harnu can empty entry by entry, or none. */
export const canEmptySelectively = (platform: NodeJS.Platform): boolean => platform === 'linux'

/** Where Harnu can name an entry exactly at all. */
const canRecord = (platform: NodeJS.Platform): boolean =>
  platform === 'linux' || platform === 'darwin'

/**
 * Where the OS keeps the trash, for the message shown when Harnu cannot empty it. Null on Windows:
 * the renderer says "Recycle Bin" itself, in the app's language.
 */
export function trashLocation(platform: NodeJS.Platform, homeTrash: string): string | null {
  if (platform === 'darwin') return '~/.Trash'
  if (platform === 'win32') return null
  return homeTrash
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const errCode = (err: unknown): unknown =>
  typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p)
  } catch {
    return null
  }
}

const isRealDir = (s: Stats | null): s is Stats => !!s && s.isDirectory() && !s.isSymbolicLink()

/** A name that can only name a file directly inside `files/` or `info/`. */
const safeName = (name: string): boolean =>
  name.length > 0 && name !== '.' && name !== '..' && !/[\\/\0]/.test(name)

async function defaultIsMountPoint(dir: string): Promise<boolean> {
  try {
    const here = await fs.stat(dir)
    const parent = await fs.stat(path.dirname(dir))
    return here.dev !== parent.dev || path.dirname(dir) === dir
  } catch {
    return false
  }
}

/** Every ancestor directory of a path, nearest first. */
function ancestors(p: string): string[] {
  const out: string[] = []
  let dir = path.dirname(p)
  while (dir && dir !== path.dirname(dir)) {
    out.push(dir)
    dir = path.dirname(dir)
  }
  return out
}

interface TrashDir {
  dir: string
  /** The mount point a per-volume trash belongs to; null for the home trash. */
  topdir: string | null
}

/**
 * The trash directories an item trashed from `original` could land in: the home trash, and the
 * per-volume trash of any ANCESTOR THAT IS A MOUNT POINT. A per-volume trash that is a symlink is
 * refused (a planted link must not make Harnu delete somewhere else), and so is a `.Trash/<uid>`
 * whose `.Trash` is a symlink or lacks the sticky bit, as the freedesktop spec requires.
 */
async function candidateTrashes(original: string, env: TrashEnv): Promise<TrashDir[]> {
  const out: TrashDir[] = [{ dir: env.homeTrash, topdir: null }]
  if (env.platform !== 'linux' || env.uid === null) return out
  const mountPoint = env.isMountPoint ?? defaultIsMountPoint
  for (const top of ancestors(original)) {
    if (!(await mountPoint(top))) continue
    const own = path.join(top, `.Trash-${env.uid}`)
    if (isRealDir(await lstatOrNull(own))) out.push({ dir: own, topdir: top })
    const shared = path.join(top, '.Trash')
    const sharedStat = await lstatOrNull(shared)
    if (isRealDir(sharedStat) && (sharedStat.mode & 0o1000) !== 0) {
      const mine = path.join(shared, String(env.uid))
      if (isRealDir(await lstatOrNull(mine))) out.push({ dir: mine, topdir: top })
    }
  }
  return out
}

/** The entry names a trash directory holds right now. */
async function namesIn(t: TrashDir, env: TrashEnv): Promise<Set<string>> {
  if (env.platform === 'darwin') return new Set(await fs.readdir(t.dir))
  let files: string[]
  try {
    files = await fs.readdir(path.join(t.dir, 'info'))
  } catch (err) {
    if (errCode(err) === 'ENOENT') return new Set()
    throw err
  }
  return new Set(
    files.filter((f) => f.endsWith('.trashinfo')).map((f) => f.slice(0, -'.trashinfo'.length))
  )
}

/**
 * Runs the move and names the exact entry it created. The trash is listed before and after: one new
 * entry, whose own record says it came from `original`, is Harnu's. Two new entries (or one that
 * came from elsewhere) mean something else was trashed at the same moment, and then Harnu records
 * nothing rather than guess. The move itself always runs, and its failure always propagates.
 */
export async function recordTrash(
  env: TrashEnv,
  original: string,
  doTrash: () => Promise<void>
): Promise<TrashEntryRecord | null> {
  if (!canRecord(env.platform)) {
    await doTrash()
    return null
  }
  let dirs: TrashDir[] = []
  let before: Array<Set<string>> | null = null
  try {
    dirs = await candidateTrashes(original, env)
    before = await Promise.all(dirs.map((d) => namesIn(d, env)))
  } catch {
    before = null
  }
  await doTrash()
  if (!before) return null
  try {
    const fresh: Array<{ dir: TrashDir; name: string }> = []
    for (const [i, d] of dirs.entries()) {
      for (const name of await namesIn(d, env)) {
        if (!before[i]!.has(name)) fresh.push({ dir: d, name })
      }
    }
    if (fresh.length !== 1 || !safeName(fresh[0]!.name)) return null
    return await describe(env, original, fresh[0]!.dir, fresh[0]!.name)
  } catch {
    return null
  }
}

/** Fingerprints one new entry; null when it does not belong to `original`. */
async function describe(
  env: TrashEnv,
  original: string,
  t: TrashDir,
  name: string
): Promise<TrashEntryRecord | null> {
  if (env.platform === 'darwin') {
    // A name in ~/.Trash is the folder's own, or the folder's with a time stamp added when taken.
    if (!name.startsWith(path.basename(original))) return null
    const data = await fs.lstat(path.join(t.dir, name))
    return {
      kind: 'macos',
      trashDir: t.dir,
      name,
      dev: data.dev,
      ino: data.ino,
      ctimeMs: data.ctimeMs
    }
  }
  const data = await fs.lstat(path.join(t.dir, 'files', name))
  const infoFile = path.join(t.dir, 'info', `${name}.trashinfo`)
  const infoStat = await fs.lstat(infoFile)
  const info = parseTrashInfo(await fs.readFile(infoFile, 'utf8'))
  if (!info || info.deletionDate === null) return null
  const from = originalPathOf(info, t.topdir)
  if (from === null || from.replace(/\/+$/, '') !== original.replace(/\/+$/, '')) return null
  return {
    kind: 'freedesktop',
    trashDir: t.dir,
    name,
    deletionDate: info.deletionDate,
    dev: data.dev,
    ino: data.ino,
    ctimeMs: data.ctimeMs,
    infoIno: infoStat.ino,
    infoMtimeMs: infoStat.mtimeMs
  }
}

// ---- observing a recorded entry -----------------------------------------------------------------

/**
 * `present`: exactly Harnu's entry. `gone`: nothing is there any more. `changed`: something is at
 * that name, but it is not what Harnu moved (a restore and a new trashing, a swapped folder, a
 * trash directory that became a symlink). `unknown`: it cannot be told (a volume that is not
 * mounted, a trash that cannot be read, a platform that offers nothing).
 */
export type Observed = 'present' | 'gone' | 'changed' | 'unknown'

/** The directory this record points at is a trash directory of this user, and not a lookalike. */
function allowedTrashDir(rec: TrashEntryRecord, env: TrashEnv): boolean {
  if (rec.kind === 'macos') return env.platform === 'darwin' && rec.trashDir === env.homeTrash
  if (env.platform !== 'linux') return false
  if (rec.trashDir === env.homeTrash) return true
  if (env.uid === null) return false
  const base = path.basename(rec.trashDir)
  return (
    base === `.Trash-${env.uid}` ||
    (base === String(env.uid) && path.basename(path.dirname(rec.trashDir)) === '.Trash')
  )
}

/** The device of the nearest directory that exists above `p`: tells an unmounted volume from a deleted folder. */
async function nearestDev(p: string): Promise<number | null> {
  let dir = p
  for (let i = 0; i < 64; i++) {
    try {
      return (await fs.stat(dir)).dev
    } catch {
      const up = path.dirname(dir)
      if (up === dir) return null
      dir = up
    }
  }
  return null
}

/**
 * Every directory from the trash dir down to the entry's parent is a REAL directory (not a symlink),
 * and the entry itself is not reached through one. lstat on each component: `fs.lstat(a/b/c)` alone
 * follows symlinks in `a` and `b`, which is exactly how a swapped `files/` redirects a delete.
 */
async function chainIsReal(dirs: readonly string[]): Promise<boolean> {
  for (const d of dirs) if (!isRealDir(await lstatOrNull(d))) return false
  return true
}

const dataDirs = (rec: TrashEntryRecord): string[] =>
  rec.kind === 'macos' ? [rec.trashDir] : [rec.trashDir, path.join(rec.trashDir, 'files')]

export async function observeEntry(rec: TrashEntryRecord, env: TrashEnv): Promise<Observed> {
  if (!canRecord(env.platform)) return 'unknown'
  if (!allowedTrashDir(rec, env) || !safeName(rec.name)) return 'changed'
  const dirStat = await lstatOrNull(rec.trashDir)
  if (!dirStat) {
    // The trash directory is not there. If the volume it lived on is not mounted, the answer is
    // unknown (the entry may well be there when the disk comes back), not gone.
    const dev = await nearestDev(rec.trashDir)
    return dev !== null && dev !== rec.dev ? 'unknown' : 'gone'
  }
  if (!isRealDir(dirStat)) return 'changed'
  // `files/` (and, for the record, `info/`) must be real directories too, not links to somewhere else.
  if (!(await chainIsReal(dataDirs(rec)))) return 'changed'
  if (rec.kind === 'freedesktop' && !(await chainIsReal([path.join(rec.trashDir, 'info')]))) {
    return 'changed'
  }
  const dataPath =
    rec.kind === 'macos'
      ? path.join(rec.trashDir, rec.name)
      : path.join(rec.trashDir, 'files', rec.name)
  let data: Stats
  try {
    data = await fs.lstat(dataPath)
  } catch (err) {
    if (errCode(err) === 'ENOENT') return 'gone'
    return 'unknown'
  }
  if (data.dev !== rec.dev || data.ino !== rec.ino || data.ctimeMs !== rec.ctimeMs) return 'changed'
  if (rec.kind === 'macos') return 'present'
  const infoFile = path.join(rec.trashDir, 'info', `${rec.name}.trashinfo`)
  try {
    const info = await fs.lstat(infoFile)
    if (info.ino !== rec.infoIno || info.mtimeMs !== rec.infoMtimeMs) return 'changed'
    const parsed = parseTrashInfo(await fs.readFile(infoFile, 'utf8'))
    return parsed?.deletionDate === rec.deletionDate ? 'present' : 'changed'
  } catch (err) {
    return errCode(err) === 'ENOENT' ? 'changed' : 'unknown'
  }
}

export interface ObservedLedger {
  /** Exactly Harnu's, still there. */
  present: TrashedEntry[]
  /** Nothing is there any more (the user emptied or restored it): settled. */
  gone: TrashedEntry[]
  /** Cannot be checked, or no longer exactly what Harnu moved. Never counted as space in the trash, never deleted, never forgotten. */
  unknown: TrashedEntry[]
}

/**
 * Splits the ledger by what can be verified. One lstat or two per entry; no directory is listed,
 * so a gather costs the same however large the user's trash is.
 */
export async function observeTrashEntries(
  entries: readonly TrashedEntry[],
  env: TrashEnv
): Promise<ObservedLedger> {
  const out: ObservedLedger = { present: [], gone: [], unknown: [] }
  for (const e of entries) {
    if (e.exact === null) {
      out.unknown.push(e)
      continue
    }
    const seen = await observeEntry(e.exact, env).catch((): Observed => 'unknown')
    if (seen === 'present') out.present.push(e)
    // Only a missing entry is settled. One that CHANGED (or cannot be read) stays listed as
    // something Harnu moved and can't check: a remount that renumbers a device must not make real
    // entries vanish from the ledger for good.
    else if (seen === 'gone') out.gone.push(e)
    else out.unknown.push(e)
  }
  return out
}

/** The `GcTrashCard` for what the ledger holds. */
export function trashCard(ledger: ObservedLedger, env: TrashEnv): GcTrashCard {
  const list: TrashListEntry[] = ledger.present.map((e) => ({
    id: e.key,
    name: path.basename(e.path),
    bytes: e.bytes,
    at: e.at
  }))
  const sum = (xs: readonly { bytes: number | null }[]): number =>
    xs.reduce((n, e) => n + (e.bytes ?? 0), 0)
  return {
    inTrashBytes: sum(list),
    inTrashCount: list.length,
    entries: list,
    unverifiedBytes: sum(ledger.unknown),
    unverifiedCount: ledger.unknown.length,
    canEmpty: canEmptySelectively(env.platform),
    location: trashLocation(env.platform, env.homeTrash)
  }
}

export interface EmptyResult {
  /** Ledger keys whose entry was removed from the trash. */
  emptied: string[]
  /** Ledger keys whose entry was no longer there. */
  missing: string[]
  /** Ledger keys whose entry is no longer exactly what Harnu moved: left alone. */
  changed: string[]
  /** Ledger keys with no exact record (a clean from before it existed): never emptied by Harnu. */
  unverifiable: string[]
  /** Ledger keys whose trash cannot be read right now (a disk not mounted): left alone, still listed. */
  unreachable: string[]
  failed: Array<{ key: string; error: string }>
  /** Bytes of what was emptied, from the journal. */
  emptiedBytes: number
  /** True when this machine's trash cannot be emptied entry by entry: nothing was touched. */
  unsupported: boolean
}

/**
 * Permanently removes the entries the operator confirmed (`ids`), and only those, and only while each
 * is still EXACTLY the entry Harnu recorded: same name, same fingerprint, and a trash directory that
 * is still a real one. Anything else is reported and left alone. A symlink inside a trashed folder is
 * removed, never followed.
 */
export async function emptyHarnuTrash(
  entries: readonly TrashedEntry[],
  ids: readonly string[],
  env: TrashEnv,
  /** Seams for tests: something that happens between the check and the delete. */
  hooks: {
    beforeDelete?: (e: TrashedEntry) => Promise<void>
    betweenDeletes?: (e: TrashedEntry) => Promise<void>
  } = {}
): Promise<EmptyResult> {
  const result: EmptyResult = {
    emptied: [],
    missing: [],
    changed: [],
    unverifiable: [],
    unreachable: [],
    failed: [],
    emptiedBytes: 0,
    unsupported: !canEmptySelectively(env.platform)
  }
  if (result.unsupported) return result
  const wanted = new Set(ids)
  for (const e of entries) {
    if (!wanted.has(e.key)) continue
    if (e.exact === null) {
      result.unverifiable.push(e.key)
      continue
    }
    const seen = await observeEntry(e.exact, env).catch((): Observed => 'unknown')
    if (seen === 'gone') result.missing.push(e.key)
    else if (seen === 'changed') result.changed.push(e.key)
    else if (seen === 'unknown') result.unreachable.push(e.key)
    else {
      const rec = e.exact
      try {
        await hooks.beforeDelete?.(e)
        // The check above and the delete below are two moments: re-lstat every component right
        // before each delete, so a directory swapped for a symlink in between redirects nothing.
        if (!(await chainIsReal(dataDirs(rec)))) {
          result.changed.push(e.key)
          continue
        }
        // The data first: a record left behind without its data is harmless, the reverse is an
        // orphan the file manager cannot show.
        await rawRm(path.join(rec.trashDir, 'files', rec.name), { recursive: true, force: true })
        await hooks.betweenDeletes?.(e)
        if (
          rec.kind === 'freedesktop' &&
          (await chainIsReal([rec.trashDir, path.join(rec.trashDir, 'info')]))
        ) {
          await rawRm(path.join(rec.trashDir, 'info', `${rec.name}.trashinfo`), { force: true })
        }
        result.emptied.push(e.key)
        result.emptiedBytes += e.bytes ?? 0
      } catch (err) {
        result.failed.push({ key: e.key, error: messageOf(err) })
      }
    }
  }
  return result
}
