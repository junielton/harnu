/**
 * First-boot COPY of a folder's legacy per-repo data dir (`.capy/`) into the
 * current one ({@link DATA_DIR}) — memory, board, missions, canvases, `out/`.
 *
 * Deliberately a COPY, never a move: the legacy dir stays a real directory,
 * untouched, for the operator to delete by hand; there is no symlink and nothing
 * keeps the two in sync afterwards. Rolling back is deleting the new dir.
 *
 * Inert only if `DATA_DIR` is itself a legacy name (it returns `inactive` without
 * touching the disk: a copy made then would go stale at once, because the app would
 * keep writing the old dir). Since the flip it never is, so it copies on first boot.
 *
 * The copy lands in a temp sibling and is renamed onto the target in one step, so
 * a crash never leaves a half-populated target that a later boot would mistake
 * for a user's own dir. It never throws.
 */

import {
  chmod,
  cp,
  lstat,
  lutimes,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import * as path from 'node:path'
import { CANVAS_SUFFIX, LEGACY_CANVAS_SUFFIXES } from '../canvas-core'
import {
  DATA_DIR,
  LEGACY_DATA_DIRS,
  dataDirAppVersion,
  emitDataDirMigrated,
  ensureDataDirExcluded
} from '../data-dir'

/** `<target>/.migrated-from-<legacy name without its dot>` — present ⇒ "this copy is ours". */
export const MIGRATED_MARKER_PREFIX = '.migrated-from-'

export type DataDirOutcome =
  /** `DATA_DIR` is still a legacy name: nothing to do, nothing touched. */
  | { outcome: 'inactive' }
  /** Nothing to copy (no legacy dir), or already copied on an earlier boot. */
  | { outcome: 'noop'; reason: 'no-legacy' | 'already-migrated' }
  /** Copied `from` (a legacy name); `rewrittenMd` memory markdown files had their path text updated. */
  | { outcome: 'copied'; from: string; rewrittenMd: number }
  /** Both dirs exist and the target is not our copy: left alone, the operator must resolve it. */
  | { outcome: 'conflict'; from: string }
  | { outcome: 'error'; message: string }

export interface MigrateDataDirOptions {
  /** The target dir name. Test seam — production uses {@link DATA_DIR}. */
  dataDir?: string
  /** The legacy names to copy from. Test seam — production uses {@link LEGACY_DATA_DIRS}. */
  legacyDirs?: readonly string[]
  /** Stamped into the marker. */
  appVersion?: string
  now?: () => Date
}

const inFlight = new Map<string, Promise<DataDirOutcome>>()

/**
 * Copy `<folder>/<legacy>` to `<folder>/<DATA_DIR>` when the legacy dir is a real
 * directory and the target is missing. Single-flight per folder: concurrent calls
 * share one run.
 */
export function migrateDataDir(
  folder: string,
  opts: MigrateDataDirOptions = {}
): Promise<DataDirOutcome> {
  const target = opts.dataDir ?? DATA_DIR
  const legacyDirs = opts.legacyDirs ?? LEGACY_DATA_DIRS
  if (legacyDirs.includes(target)) return Promise.resolve({ outcome: 'inactive' })

  const root = path.resolve(folder)
  const key = `${root}\0${target}`
  const running = inFlight.get(key)
  if (running) return running
  const run = migrate(root, target, legacyDirs, opts)
    .then((res) => {
      if (res.outcome === 'copied') emitDataDirMigrated(root)
      return res
    })
    .finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}

async function migrate(
  root: string,
  target: string,
  legacyDirs: readonly string[],
  opts: MigrateDataDirOptions
): Promise<DataDirOutcome> {
  const tmp = path.join(root, `${target}.migrating`)
  try {
    let legacyName: string | null = null
    // Where the legacy content really lives: the dir itself, or what a symlinked one points to.
    let source = ''
    for (const name of legacyDirs) {
      const st = await lstat(path.join(root, name)).catch(() => null)
      if (st?.isDirectory()) {
        legacyName = name
        source = path.join(root, name)
        break
      }
      if (st?.isSymbolicLink()) {
        const real = await realpath(path.join(root, name)).catch(() => null)
        const realStat = real ? await stat(real).catch(() => null) : null
        if (!real || !realStat?.isDirectory()) {
          return {
            outcome: 'error',
            message: `${name} is a symlink that does not lead to a directory, so nothing was copied from it`
          }
        }
        // A link that already leads at the new dir (the old rename-plus-symlink layout) has nothing to copy.
        const realTarget = await realpath(path.join(root, target)).catch(() => null)
        if (realTarget === real) return { outcome: 'noop', reason: 'already-migrated' }
        legacyName = name
        source = real
        break
      }
    }
    if (!legacyName) return { outcome: 'noop', reason: 'no-legacy' }

    const targetPath = path.join(root, target)
    if (await lstat(targetPath).catch(() => null)) {
      const ours = await Promise.any(
        legacyDirs.map((n) => lstat(path.join(targetPath, markerName(n))))
      ).then(
        () => true,
        () => false
      )
      return ours
        ? { outcome: 'noop', reason: 'already-migrated' }
        : { outcome: 'conflict', from: legacyName }
    }

    // The temp sibling must never show up as untracked while it fills (best-effort).
    await ensureDataDirExcluded(root)
    await rm(tmp, { recursive: true, force: true }) // debris from a crashed earlier run
    await cp(source, tmp, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      errorOnExist: true
    })
    const rewrittenMd = await rewriteMemoryMarkdown(path.join(tmp, 'memory'), legacyName, target)
    await carryOverDefaultBoard(tmp)
    const now = (opts.now ?? ((): Date => new Date()))()
    await writeFile(
      path.join(tmp, markerName(legacyName)),
      `Copied from ${legacyName}/ on ${now.toISOString()} by app version ${opts.appVersion ?? dataDirAppVersion() ?? 'unknown'}.\n` +
        `The original ${legacyName}/ was left untouched; delete it by hand when you no longer need it.\n`
    )
    await restoreTimes(source, tmp)
    // Last look before the swap: someone may have created the target meanwhile.
    if (await lstat(targetPath).catch(() => null)) {
      await rm(tmp, { recursive: true, force: true })
      return { outcome: 'conflict', from: legacyName }
    }
    await rename(tmp, targetPath)
    // The new dir must never show up as untracked (best-effort; never throws).
    await ensureDataDirExcluded(root)
    return { outcome: 'copied', from: legacyName, rewrittenMd }
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    return { outcome: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The default canvas board (`out/canvas/board.<suffix>`) carries the legacy suffix in an
 * old data dir, but the app opens `board.harnucanvas.json`. Rename it inside the COPY so
 * the old board is not orphaned (the original is untouched). Other canvases are opened by
 * explicit path and keep their names.
 */
async function carryOverDefaultBoard(copy: string): Promise<void> {
  const dir = path.join(copy, 'out', 'canvas')
  const wanted = path.join(dir, `board${CANVAS_SUFFIX}`)
  if (await lstat(wanted).catch(() => null)) return
  for (const suffix of LEGACY_CANVAS_SUFFIXES) {
    const old = path.join(dir, `board${suffix}`)
    if ((await lstat(old).catch(() => null))?.isFile()) {
      await rename(old, wanted)
      return
    }
  }
}

function markerName(legacyName: string): string {
  return `${MIGRATED_MARKER_PREFIX}${legacyName.replace(/^\./, '')}`
}

/**
 * Rewrite `<legacy>/` → `<target>/` in every regular `.md` file under `memoryDir`
 * (the COPY, never the original) except the roadmap cards, keeping each file's timestamps. Symlinks are not
 * followed or written through. Returns how many files changed.
 */
async function rewriteMemoryMarkdown(
  memoryDir: string,
  legacyName: string,
  target: string
): Promise<number> {
  // Not preceded by a word character, so `my.capy/` is left alone but `~/.harnu/` and `(.capy/` match.
  const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(legacyName)}/`, 'g')
  const roadmapDir = path.join(memoryDir, 'roadmap')
  let changed = 0
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        // Roadmap cards carry a manifest approval stamp hashed over their body: rewriting them
        // would void every stamp. Stored `.capy/` text there is harmless (the old dir is kept
        // and links are mapped at read time), so the cards are copied byte-identical.
        if (p !== roadmapDir) await walk(p)
      } else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          const before = await readFile(p, 'utf8')
          const after = before.replace(pattern, `${target}/`)
          if (after === before) continue
          const st = await lstat(p)
          // `cp` keeps the original's mode, so a read-only page would refuse the write:
          // make the COPY writable for the rewrite, then give it its mode back.
          if ((st.mode & 0o200) === 0) await chmod(p, st.mode | 0o200)
          try {
            await writeFile(p, after)
          } finally {
            if ((st.mode & 0o200) === 0) await chmod(p, st.mode & 0o7777).catch(() => {})
          }
          await utimes(p, st.atime, st.mtime)
          changed++
        } catch (err) {
          // One unreadable or unwritable page must not abort the whole copy: it stays
          // as copied (its old path text is harmless — the original dir is kept).
          console.warn(
            `[data-dir] left ${p} unrewritten:`,
            err instanceof Error ? err.message : String(err)
          )
        }
      }
    }
  }
  await walk(memoryDir)
  return changed
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Give every directory (and symlink) in the copy the timestamps of its original.
 * `cp` preserves files', but a directory's mtime moves as its children land, and
 * the marker write moved the root's.
 */
async function restoreTimes(source: string, copy: string): Promise<void> {
  const walk = async (src: string, dst: string): Promise<void> => {
    const entries = await readdir(src, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(src, e.name), path.join(dst, e.name))
      else if (e.isSymbolicLink()) {
        const st = await lstat(path.join(src, e.name))
        await lutimes(path.join(dst, e.name), st.atime, st.mtime).catch(() => {})
      }
    }
    const st = await lstat(src)
    await utimes(dst, st.atime, st.mtime)
  }
  await walk(source, copy)
}
