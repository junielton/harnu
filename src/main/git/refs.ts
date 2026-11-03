/**
 * BUG-240 — read HEAD and refs straight from a repo's git directory, with no `git`
 * spawn. Forking the Electron main process costs milliseconds per spawn, and the
 * mission derive used to fork `git` hundreds of times per poll to learn things that
 * are one small file read away.
 *
 * The contract is "exact or say you cannot tell". Every function returns the
 * {@link UNSURE} sentinel on a layout or content it does not fully understand
 * (reftable, a file of unexpected shape, a symbolic ref more than one level deep,
 * any read error other than "not there"), and the caller then uses its `git` spawn
 * path. It never guesses.
 *
 * Reads use `fs/promises` only: no `*Sync` call may land on the main thread.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/** "Can't tell": the caller must fall back to spawning `git`. */
export const UNSURE = 'unsure' as const
export type Unsure = typeof UNSURE

/** The git directory of one working tree and the one that holds the shared refs. */
export interface GitDirs {
  /** Per-working-tree state (`HEAD`). For a main checkout this is the common dir. */
  gitDir: string
  /** Shared state: `refs/`, `packed-refs`, `config`. */
  commonDir: string
}

/** `HEAD` of a working tree. */
export type HeadState =
  { kind: 'branch'; ref: string; branch: string } | { kind: 'detached'; sha: string }

const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/
const HEADS = 'refs/heads/'

/** `true` when an fs error means "this path is not there" rather than "I cannot read it". */
function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if (isAbsent(err)) return null
    throw err
  }
}

/**
 * Locates the git directories of the working tree at `worktreePath`.
 *
 * - `null`: the path is not a working tree (a file, a missing path, a directory with
 *   no `.git` entry). It never walks up the parents.
 * - {@link UNSURE}: it is one, but of a kind this module does not read.
 */
export async function resolveGitDirs(worktreePath: string): Promise<GitDirs | null | Unsure> {
  try {
    const dotGit = path.join(worktreePath, '.git')
    let stat
    try {
      stat = await fs.stat(dotGit)
    } catch (err) {
      if (isAbsent(err)) return null
      return UNSURE
    }

    let gitDir: string
    let commonDir: string
    if (stat.isDirectory()) {
      gitDir = await fs.realpath(dotGit)
      commonDir = gitDir
    } else if (stat.isFile()) {
      const text = (await fs.readFile(dotGit, 'utf8')).trim()
      const m = /^gitdir:\s*(.+)$/.exec(text)
      if (!m) return UNSURE
      gitDir = await fs.realpath(path.resolve(worktreePath, m[1].trim()))
      const common = await readText(path.join(gitDir, 'commondir'))
      commonDir = common === null ? gitDir : await fs.realpath(path.resolve(gitDir, common.trim()))
    } else {
      return UNSURE
    }

    // A reftable repo keeps its refs in binary tables: not readable here.
    try {
      await fs.stat(path.join(commonDir, 'reftable'))
      return UNSURE
    } catch (err) {
      if (!isAbsent(err)) return UNSURE
    }
    const config = await readText(path.join(commonDir, 'config'))
    if (config !== null && /^\s*refstorage\s*=/im.test(config)) return UNSURE

    return { gitDir, commonDir }
  } catch {
    return UNSURE
  }
}

/** Reads `<gitDir>/HEAD`: a branch (`ref: refs/heads/<name>`) or a detached sha. */
export async function readHead(dirs: GitDirs): Promise<HeadState | Unsure> {
  try {
    const text = await readText(path.join(dirs.gitDir, 'HEAD'))
    if (text === null) return UNSURE
    const head = text.trim()
    if (SHA.test(head)) return { kind: 'detached', sha: head }
    const m = /^ref:\s*(\S+)$/.exec(head)
    if (!m || !m[1].startsWith(HEADS)) return UNSURE
    const branch = m[1].slice(HEADS.length)
    return branch ? { kind: 'branch', ref: m[1], branch } : UNSURE
  } catch {
    return UNSURE
  }
}

/** The shape `packed-refs` is parsed into, cached by file identity. */
type Packed = { byRef: Map<string, string>; malformed: boolean }
const PACKED_CACHE_MAX = 64
const packedCache = new Map<string, { key: string; packed: Packed }>()

function parsePacked(text: string): Packed {
  const byRef = new Map<string, string>()
  let malformed = false
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/.exec(line.trimEnd())
    if (!m) {
      malformed = true
      continue
    }
    byRef.set(m[2], m[1])
  }
  return { byRef, malformed }
}

/**
 * `packed-refs`, parsed once per version of the file. git replaces it by rename, so
 * `(inode, size, mtime)` changes with every rewrite and a stale parse is never served.
 * `null` when the file does not exist.
 */
async function readPacked(commonDir: string): Promise<Packed | null> {
  const file = path.join(commonDir, 'packed-refs')
  let stat
  try {
    stat = await fs.stat(file)
  } catch (err) {
    if (isAbsent(err)) return null
    throw err
  }
  const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`
  const hit = packedCache.get(file)
  if (hit && hit.key === key) return hit.packed
  const text = await readText(file)
  if (text === null) return null
  const packed = parsePacked(text)
  if (packedCache.size >= PACKED_CACHE_MAX) {
    const oldest = packedCache.keys().next().value
    if (oldest !== undefined) packedCache.delete(oldest)
  }
  packedCache.set(file, { key, packed })
  return packed
}

function validRef(ref: string): boolean {
  return ref.startsWith('refs/') && !ref.includes('..') && !ref.includes('\0')
}

/**
 * The sha `ref` points to: the loose file first, then `packed-refs`. `null` when the
 * ref does not exist. A symbolic ref (`ref: …`) or any content of another shape is
 * {@link UNSURE}: this reads direct refs only.
 */
export async function readRef(dirs: GitDirs, ref: string): Promise<string | null | Unsure> {
  if (!validRef(ref)) return UNSURE
  try {
    let loose: string | null = null
    try {
      loose = await readText(path.join(dirs.commonDir, ref))
    } catch (err) {
      // A directory where a file was expected (`refs/heads/a` when `a/b` exists) is
      // "not a ref", the same as absent.
      if ((err as NodeJS.ErrnoException).code !== 'EISDIR') throw err
    }
    if (loose !== null) {
      const sha = loose.trim()
      return SHA.test(sha) ? sha : UNSURE
    }
    const packed = await readPacked(dirs.commonDir)
    if (packed === null) return null
    if (packed.malformed) return UNSURE
    return packed.byRef.get(ref) ?? null
  } catch {
    return UNSURE
  }
}

/**
 * The target of the symbolic ref `ref` (e.g. `refs/remotes/origin/HEAD` →
 * `refs/remotes/origin/main`), one level. `null` when the file does not exist.
 */
export async function readSymbolicRef(dirs: GitDirs, ref: string): Promise<string | null | Unsure> {
  if (!validRef(ref)) return UNSURE
  try {
    const text = await readText(path.join(dirs.commonDir, ref))
    if (text === null) return null
    const m = /^ref:\s*(refs\/\S+)$/.exec(text.trim())
    return m ? m[1] : UNSURE
  } catch {
    return UNSURE
  }
}
