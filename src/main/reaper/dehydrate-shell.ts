/**
 * Imperative shell for Cleanup's dehydrate / rehydrate (T250): the lstat, git
 * and `du` probes that feed `dehydrate-core.ts`, and the one recursive removal.
 *
 * Deliberately free of `electron` so the real-git integration tests can load it
 * (`tests/reaper-dehydrate-shell.test.ts`). Every subprocess goes through an
 * injected {@link ExecFn}: production passes the scanner's login-PATH runner
 * (BUG-34), tests pass a plain `execFile`.
 */

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import {
  parseDuMulti,
  parseTrackedStatus,
  type EntryPresence,
  type EphemeralEntryFacts,
  type TrackedFingerprint
} from './dehydrate-core'

/** Runs `file args`; rejects on a non-zero exit with the `execFile` error shape (`code`). */
export type ExecFn = (
  file: string,
  args: readonly string[],
  opts: { timeout: number; maxBuffer: number }
) => Promise<{ stdout: string }>

/**
 * `ls-files` over a tracked `vendor/` can list tens of thousands of files; a
 * buffer overflow rejects, which reads as `probe-failed` and skips the path —
 * fail-closed, but a generous buffer keeps an honest answer the common case.
 */
const GIT_BUDGET = { timeout: 30_000, maxBuffer: 32 << 20 } as const
/**
 * A cold `du` over a multi-GiB `node_modules` blows through the scanner's old
 * 10 s budget and blanks exactly the number this feature needs; the spec asks
 * to raise it and cap concurrency instead (`MEASURE_CONCURRENCY`).
 */
const DU_BUDGET = { timeout: 60_000, maxBuffer: 1 << 20 } as const

/**
 * Global `--literal-pathspecs` for the commands that take pathspecs (`ls-files`,
 * `status`): a directory named `:(glob)x` is a name, never magic. `check-ignore`
 * takes plain pathnames and REFUSES the flag ("pathspec magic not supported by
 * this command") with exit 128, so it is called with `literal: false`.
 */
function git(
  exec: ExecFn,
  worktree: string,
  args: string[],
  literal = true
): Promise<{ stdout: string }> {
  return exec(
    'git',
    [...(literal ? ['--literal-pathspecs'] : []), '-C', worktree, ...args],
    GIT_BUDGET
  )
}

async function presenceOf(abs: string): Promise<EntryPresence> {
  try {
    const st = await fs.lstat(abs)
    if (st.isSymbolicLink()) return 'symlink'
    return st.isDirectory() ? 'dir' : 'other'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent'
    return 'unreadable'
  }
}

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p)
  } catch {
    return null
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

/**
 * Probe every entry: `lstat` always (cheap, and a live worktree still needs its
 * presence known so the core can name what it skipped), and — for present
 * directories only, and only when `git` is true — guards 2 and 3 in one
 * `check-ignore` and one `ls-files` call per worktree.
 *
 * Entries are passed without a trailing slash on purpose: `check-ignore` fails
 * the WHOLE call with exit 128 ("beyond a symbolic link") for `link/`, which
 * would turn one seeded symlink into `probe-failed` for every entry.
 */
export async function probeEphemeralEntries(
  exec: ExecFn,
  worktree: string,
  entries: readonly string[],
  opts: { git: boolean } = { git: true }
): Promise<EphemeralEntryFacts[]> {
  const realRoot = await realOrNull(worktree)
  const facts: EphemeralEntryFacts[] = []
  for (const rel of entries) {
    const abs = path.join(worktree, rel)
    const presence = await presenceOf(abs)
    const realParent = await realOrNull(path.dirname(abs))
    facts.push({
      path: rel,
      presence,
      contained: realRoot !== null && realParent !== null && isInside(realRoot, realParent),
      ignored: null,
      tracked: null
    })
  }

  const dirs = facts.filter((f) => f.presence === 'dir').map((f) => f.path)
  if (!opts.git || dirs.length === 0) return facts

  // Guard 2. Exit 0 = at least one ignored (listed), 1 = none ignored, else error.
  // Newline output, not `-z`: check-ignore accepts `-z` only with `--stdin` and
  // exits 128 otherwise — which read as `probe-failed` for every entry and made
  // the whole feature a silent no-op. `core.quotepath=off` keeps UTF-8 names
  // verbatim; a name git still quotes simply fails to match and is skipped as
  // `not-ignored` — the fail-closed direction.
  let ignored: Set<string> | null
  try {
    const { stdout } = await git(
      exec,
      worktree,
      ['-c', 'core.quotepath=off', 'check-ignore', '--', ...dirs],
      false
    )
    ignored = new Set(stdout.split('\n').filter(Boolean))
  } catch (err) {
    ignored = (err as { code?: unknown }).code === 1 ? new Set() : null
  }

  // Guard 3 — independent of the ignore rules: does git track ANY file under it?
  let trackedFiles: string[] | null
  try {
    const { stdout } = await git(exec, worktree, ['ls-files', '-z', '--', ...dirs])
    trackedFiles = stdout.split('\0').filter(Boolean)
  } catch {
    trackedFiles = null
  }

  for (const f of facts) {
    if (f.presence !== 'dir') continue
    f.ignored = ignored === null ? null : ignored.has(f.path)
    f.tracked =
      trackedFiles === null
        ? null
        : trackedFiles.some((t) => t === f.path || t.startsWith(`${f.path}/`))
  }
  return facts
}

async function contentHash(abs: string): Promise<string> {
  try {
    return createHash('sha1')
      .update(await fs.readFile(abs))
      .digest('hex')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'absent'
    if (code === 'EISDIR') return 'dir' // a submodule's gitlink shows up as a directory
    throw err
  }
}

/**
 * Every tracked path that differs from HEAD, keyed to `status:content-hash`.
 * Hashing the content, not just the status, is what makes "byte-identical"
 * checkable: an already-modified file edited again keeps its `M` status.
 */
export async function trackedFingerprint(
  exec: ExecFn,
  worktree: string
): Promise<TrackedFingerprint> {
  const { stdout } = await git(exec, worktree, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=no'
  ])
  const out: TrackedFingerprint = new Map()
  for (const [file, xy] of parseTrackedStatus(stdout)) {
    out.set(file, `${xy}:${await contentHash(path.join(worktree, file))}`)
  }
  return out
}

/** Which of `files` are still modified relative to HEAD. Throws on a git failure. */
export async function stillModified(
  exec: ExecFn,
  worktree: string,
  files: readonly string[]
): Promise<string[]> {
  if (files.length === 0) return []
  const { stdout } = await git(exec, worktree, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=no',
    '--',
    ...files
  ])
  const dirty = parseTrackedStatus(stdout)
  return files.filter((f) => dirty.has(f))
}

/**
 * The one step in the Reaper engine that does NOT go through `shell.trashItem`.
 *
 * Every other destructive step trashes, because the OS trash is the net under a
 * deletion. Here the net would be a lie: the trash lives on the same filesystem,
 * so trashing a dependency directory frees nothing until the trash is emptied,
 * and the reclaim figure the row showed would be false. Permanent removal is
 * defensible ONLY because of what reaches this function — a path `planDehydrate`
 * proved is listed as ephemeral, ignored by git, holding no tracked file, in a
 * worktree with no live session: regenerable content, not work.
 *
 * The final `lstat` re-check guards the window since the probe: a directory
 * swapped for a symlink is refused rather than followed.
 */
export async function removeEphemeralDir(abs: string): Promise<void> {
  const st = await fs.lstat(abs)
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`${path.basename(abs)} is no longer a plain directory; left in place`)
  }
  // `maxRetries` absorbs the transient EBUSY/EPERM Windows raises mid-walk; a
  // failure that survives it is reported per path by the caller.
  await fs.rm(abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}

// ---- disk measurement, cached ---------------------------------------------------

export interface FolderMeasure {
  /** The whole folder, or null when unmeasured. */
  total: number | null
  /** Each child's own size, keyed by its worktree-relative path. */
  byChild: Map<string, number | null>
}

interface CacheEntry {
  signature: string
  at: number
  measure: FolderMeasure
}

/**
 * The 2026-07-15 design's "du-equivalent cached by mtime", reinstated. A
 * directory's mtime moves when its direct entries change — an install rewriting
 * `node_modules`, a dehydration removing it — not on a deep edit, so the TTL
 * bounds how stale a figure can get between those.
 */
const measureCache = new Map<string, CacheEntry>()
const MEASURE_TTL_MS = 6 * 3_600_000
const MEASURE_CACHE_MAX = 2000

async function mtimeOf(p: string): Promise<number | null> {
  try {
    return (await fs.stat(p)).mtimeMs
  } catch {
    return null
  }
}

function unmeasured(children: readonly string[]): FolderMeasure {
  return { total: null, byChild: new Map(children.map((c) => [c, null])) }
}

/**
 * Size a folder and, in the same `du` traversal, each of `children` — listed
 * first so GNU du attributes their inodes to them (see `parseDuMulti`). Null on
 * Windows (no `du`), on any `du` failure, and on a partial answer: a non-zero
 * exit means some subtree went uncounted, and an undercount is not reported as
 * a measurement.
 */
export async function measureFolder(
  exec: ExecFn,
  root: string,
  children: readonly string[],
  now: number,
  platform: NodeJS.Platform = process.platform
): Promise<FolderMeasure> {
  if (platform === 'win32') return unmeasured(children)
  const childAbs = children.map((c) => path.join(root, c))
  const signature = JSON.stringify([
    children,
    await mtimeOf(root),
    ...(await Promise.all(childAbs.map(mtimeOf)))
  ])
  const cached = measureCache.get(root)
  if (cached && cached.signature === signature && now - cached.at < MEASURE_TTL_MS) {
    return cached.measure
  }
  let measure: FolderMeasure
  try {
    const { stdout } = await exec('du', ['-sb', '-0', ...childAbs, root], DU_BUDGET)
    const parsed = parseDuMulti(stdout, root, childAbs)
    measure = {
      total: parsed.total,
      byChild: new Map(children.map((c, i) => [c, parsed.byPath.get(childAbs[i]) ?? null]))
    }
  } catch {
    return unmeasured(children) // not cached: the next scan retries
  }
  if (measureCache.size >= MEASURE_CACHE_MAX) measureCache.clear()
  measureCache.set(root, { signature, at: now, measure })
  return measure
}

/** Forget a folder's cached size — after a dehydration or rehydrate changed it. */
export function forgetMeasure(root: string): void {
  measureCache.delete(root)
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
