// Claude transcripts a removed folder left behind (unit D, AC-D1). Removing a worktree takes the
// folder, never its `~/.claude/projects/<slug>/` transcripts, so they pile up as Cleanup's own
// exhaust. This lists the project folders whose every transcript names a folder that is gone and
// that no live or parked session uses, and trashes one on request.
//
// Everything fails closed: a transcript with no readable folder, an existence check that could
// not answer, an unlistable project folder, a slug that spells like a folder that still exists
// (slugs are lossy) or one holding a live/parked session keeps the whole project out of the list.
// Pure over an injected probe; `fsOrphanProbe`, `fsPathExistence` and `trashTranscriptSlug` are
// the thin real-filesystem shell, tested against a fake HOME in tests/gc-orphans-transcripts.test.ts.

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { cwdFromTranscriptHead, slugOfPath } from './gc-transcripts'
import type { GcExpected } from './gc-wire'

/** One project folder with orphaned transcripts, as the Cleanup screen lists it. */
export interface OrphanTranscriptItem {
  /** `transcripts:<slug>` */
  id: string
  /** The folder name under `~/.claude/projects`. */
  slug: string
  /** The folder every transcript here names, which is gone. */
  folder: string
  /** The repo group the row sits under. */
  repoLabel: string
  /** Everything the project folder holds: transcripts, subagent output, memory. */
  bytes: number
  /** How many sessions (top-level transcripts) it holds. */
  sessionCount: number
  /**
   * `proven`: the folder is positively known to be gone (Harnu removed it, git lists it as
   * prunable, or it sat under a known worktrees parent). `not-found`: it is missing and nothing
   * proves it gone (it could be on a drive that is not mounted): offered apart, with a stronger
   * confirm.
   */
  proof: 'proven' | 'not-found'
  /** The newest transcript's modification time, or null. */
  newestAt: number | null
  /** The project folder also holds Claude's auto-memory notes for that folder. */
  hasMemory: boolean
}

export const ORPHAN_TRANSCRIPT_PREFIX = 'transcripts:'
export const orphanTranscriptId = (slug: string): string => `${ORPHAN_TRANSCRIPT_PREFIX}${slug}`

export interface SlugFacts {
  slug: string
  files: Array<{
    name: string
    /** The transcript's file name without `.jsonl`: the session id. */
    sessionId: string
    bytes: number
    mtimeMs: number
    /** The folder the transcript names, or null when it cannot be told. */
    cwd: string | null
  }>
  /** Bytes of everything in the project folder that is not a top-level transcript. */
  extraBytes: number
  hasMemory: boolean
  /** The project folder could not be listed. */
  unlistable?: boolean
}

export interface OrphanProbe {
  listSlugs(): Promise<string[]>
  readSlug(slug: string): Promise<SlugFacts>
}

export type { Existence } from './gc-orphan-existence'
import type { Existence } from './gc-orphan-existence'
export { fsPathExistence } from './gc-orphan-existence'

export interface OrphanInput {
  probe: OrphanProbe
  exists(folder: string): Promise<Existence>
  /** Session ids with a running or parked (hibernated) session: their project is never listed. */
  protectedSessionIds: ReadonlySet<string>
  /** Folders that still exist and that Harnu knows (sidebar, repos, worktrees). */
  protectedFolders: readonly string[]
  /** Known repo checkouts, to name the group a folder belongs to. */
  repoPaths: readonly string[]
  /**
   * Whether a missing folder is positively proven gone (see gc-orphan-proof.ts). Absent proves
   * nothing: every missing folder is then only "not found".
   */
  proof?: (folder: string) => boolean
  /** The clock (epoch ms); defaults to now. */
  now?: number
  /**
   * A project whose newest transcript is younger than this is never listed (default 24 h): a
   * session still writing from a terminal outside Harnu is invisible to every other check, and
   * the parked-session set is in memory only, so it is empty after a restart.
   */
  quietMs?: number
}

/** The default quiet period before a project can be an orphan. */
export const ORPHAN_QUIET_MS = 24 * 3_600_000

const GENERIC_PARENTS = new Set(['worktrees', '.worktrees', 'trees', 'wt', 'tmp'])

const base = (p: string): string =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p

const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)

/**
 * The repo group a gone folder is listed under: the longest known repo it lies in; else the repo
 * above a `.claude/worktrees` folder; else the repo a `<repo>-worktrees` sibling names; else the
 * parent folder (the one above it when the parent is a generic `worktrees` folder).
 */
export function repoLabelFor(folder: string, repoPaths: readonly string[]): string {
  const norm = folder.replace(/\\/g, '/').replace(/\/+$/, '')
  const known = repoPaths
    .map((r) => r.replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter((r) => r !== '' && isUnder(norm, r))
    .sort((a, b) => b.length - a.length)[0]
  if (known) return base(known)
  const marker = '/.claude/worktrees/'
  const at = norm.indexOf(marker)
  if (at > 0) return base(norm.slice(0, at))
  const parent = norm.slice(0, norm.lastIndexOf('/'))
  const parentName = base(parent)
  const suffixed = /^(.+?)[-.]worktrees$/.exec(parentName)
  if (suffixed) return suffixed[1]!
  if (GENERIC_PARENTS.has(parentName)) return base(parent.slice(0, parent.lastIndexOf('/')))
  return parentName
}

/**
 * The orphaned project folders, biggest first. A project is listed only when it has transcripts,
 * every one names a folder, every such folder is provably gone, nothing in it is live or parked,
 * and no existing known folder spells the same slug.
 */
export async function planOrphanTranscripts(input: OrphanInput): Promise<OrphanTranscriptItem[]> {
  let slugs: string[]
  try {
    slugs = await input.probe.listSlugs()
  } catch {
    return []
  }
  const now = input.now ?? Date.now()
  const quietMs = input.quietMs ?? ORPHAN_QUIET_MS
  const aliveSlugs = new Set(input.protectedFolders.map(slugOfPath))
  const existence = new Map<string, Promise<Existence>>()
  const existsOnce = (folder: string): Promise<Existence> => {
    let known = existence.get(folder)
    if (!known) {
      known = input.exists(folder).catch((): Existence => 'unknown')
      existence.set(folder, known)
    }
    return known
  }
  const items: OrphanTranscriptItem[] = []
  for (const slug of slugs) {
    if (aliveSlugs.has(slug)) continue
    let facts: SlugFacts
    try {
      facts = await input.probe.readSlug(slug)
    } catch {
      continue
    }
    if (facts.unlistable || facts.files.length === 0) continue
    if (facts.files.some((f) => input.protectedSessionIds.has(f.sessionId))) continue
    // Anything written lately may belong to a live session we cannot see; a mtime in the future counts too.
    const newestWrite = Math.max(...facts.files.map((f) => f.mtimeMs))
    if (!Number.isFinite(newestWrite) || now - newestWrite < quietMs) continue
    const cwds = facts.files.map((f) => f.cwd)
    if (cwds.some((c) => c === null)) continue
    const folders = [...new Set(cwds as string[])]
    const states = await Promise.all(folders.map(existsOnce))
    // Missing is the only state that can be an orphan; a folder Harnu could not even look at is not.
    if (states.some((s) => s !== 'missing')) continue
    // A folder a known, existing folder is slug-equal to may be the same project.
    if (folders.some((f) => aliveSlugs.has(slugOfPath(f)))) continue
    const newest = newestWrite
    items.push({
      id: orphanTranscriptId(slug),
      slug,
      folder: folders[0]!,
      repoLabel: repoLabelFor(folders[0]!, input.repoPaths),
      bytes: facts.files.reduce((a, f) => a + f.bytes, 0) + facts.extraBytes,
      sessionCount: facts.files.length,
      proof: input.proof && folders.every((f) => input.proof!(f)) ? 'proven' : 'not-found',
      newestAt: Number.isFinite(newest) ? newest : null,
      hasMemory: facts.hasMemory
    })
  }
  return items.sort((a, b) => b.bytes - a.bytes || (a.slug < b.slug ? -1 : 1))
}

/** The facts a Cleanup row shows for an orphaned project, in the shape `gc:clean` expects back. */
export function orphanExpectedOf(item: OrphanTranscriptItem): GcExpected {
  return {
    bucket: 'orphan-transcripts',
    reasonCode: null,
    headSha: null,
    stackIds: [],
    ownedVolumes: [],
    bytes: item.bytes,
    path: item.folder,
    project: item.slug,
    proof: item.proof
  }
}

/** What differs from what the operator was shown (a session wrote more, the folder moved), or null. */
export function transcriptsChangedSince(
  item: OrphanTranscriptItem,
  seen: GcExpected
): 'bucket' | 'path' | 'size' | 'project' | 'proof' | null {
  if (seen.bucket !== 'orphan-transcripts') return 'bucket'
  if (item.folder !== seen.path) return 'path'
  if (item.slug !== (seen.project ?? null)) return 'project'
  if (item.bytes !== seen.bytes) return 'size'
  // The folder was proven gone when shown and is only "not found" now (or the other way round).
  if ((item.proof ?? null) !== (seen.proof ?? null)) return 'proof'
  return null
}

// ---- the real filesystem -----------------------------------------------------------------------

const HEAD_BYTES = 64 * 1024
/** A walk this long is a broken tree, not a project folder: sizes past it are approximate. */
const MAX_ENTRIES = 50_000

/** Total bytes under a folder (links not followed), and how many files, bounded. */
async function treeBytes(dir: string, budget: { left: number }): Promise<number> {
  let total = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    if (budget.left-- <= 0) return total
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += await treeBytes(p, budget)
    else if (e.isFile()) total += (await fs.lstat(p).catch(() => null))?.size ?? 0
  }
  return total
}

/**
 * A transcript's folder never changes as it grows, so the answer is kept for as long as the file
 * is the same file: keyed by path, modification time and size. An unreadable head is not an answer
 * and is read again next time.
 */
const headCache = new Map<string, string>()
const HEAD_CACHE_MAX = 5_000

async function cwdOfFile(
  file: string,
  st: { mtimeMs: number; size: number },
  onRead?: (file: string) => void
): Promise<string | null> {
  const key = `${file}\0${st.mtimeMs}\0${st.size}`
  const known = headCache.get(key)
  if (known) return known
  onRead?.(file)
  let fh: import('node:fs/promises').FileHandle | undefined
  try {
    fh = await fs.open(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    const cwd = cwdFromTranscriptHead(buf.toString('utf8', 0, bytesRead))
    if (cwd) {
      if (headCache.size >= HEAD_CACHE_MAX) headCache.clear()
      headCache.set(key, cwd)
    }
    return cwd
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

export function fsOrphanProbe(
  root = path.join(homedir(), '.claude', 'projects'),
  /** Test seam: called whenever a transcript head is actually read from disk. */
  opts: { onHeadRead?: (file: string) => void } = {}
): OrphanProbe {
  return {
    listSlugs: async () =>
      (await fs.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    readSlug: async (slug) => {
      const dir = path.join(root, slug)
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return { slug, files: [], extraBytes: 0, hasMemory: false, unlistable: true }
      }
      const files: SlugFacts['files'] = []
      let extraBytes = 0
      let hasMemory = false
      const budget = { left: MAX_ENTRIES }
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          const st = await fs.stat(p).catch(() => null)
          if (!st) return { slug, files: [], extraBytes: 0, hasMemory: false, unlistable: true }
          files.push({
            name: e.name,
            sessionId: e.name.slice(0, -'.jsonl'.length),
            bytes: st.size,
            mtimeMs: st.mtimeMs,
            cwd: await cwdOfFile(p, st, opts.onHeadRead)
          })
        } else if (e.isDirectory()) {
          const size = await treeBytes(p, budget)
          extraBytes += size
          if (e.name === 'memory') {
            hasMemory = (await fs.readdir(p).catch(() => [])).length > 0
          }
        } else if (e.isFile()) {
          extraBytes += (await fs.lstat(p).catch(() => null))?.size ?? 0
        }
      }
      return { slug, files, extraBytes, hasMemory }
    }
  }
}

/**
 * Moves one project folder of the transcripts root to the trash. The slug must be a plain folder
 * name that is a real directory directly inside the root: never a path, never a link, so nothing
 * outside the root can be reached through it.
 */
export async function trashTranscriptSlug(
  root: string,
  slug: string,
  trash: (p: string) => Promise<void>
): Promise<void> {
  if (
    slug === '' ||
    slug === '.' ||
    slug === '..' ||
    slug !== path.basename(slug) ||
    slug.includes('/') ||
    slug.includes('\\')
  ) {
    throw new Error('bad-slug')
  }
  const target = path.join(root, slug)
  const st = await fs.lstat(target)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('not-a-project-folder')
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)])
  if (path.dirname(realTarget) !== realRoot) throw new Error('not-inside-the-root')
  await trash(target)
}
