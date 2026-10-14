/**
 * Whether the host may KEEP a transcript path the mod reported (T455 spec §5.3, §6.1 step 3,
 * §10.2): `session.snapshot.start.transcriptPath` and `session.rebound.transcriptPath`.
 *
 * The mod only checks the type and the length (≤ 4,096), so every other check is here, and the
 * value is attacker-chosen: any process that holds the socket token can send one. Two phases:
 *
 *  1. Lexical, no I/O at all: a string, at most 4,096 chars, no NUL, absolute, no `.`, `..` or
 *     empty segment, under the projects root, exactly `<root>/<slug>/<sid>.jsonl`. A path that
 *     fails here is never stat'ed, opened or resolved.
 *  2. Only for a path that passed: `realpath` of the root, of the slug dir and of the file when
 *     they exist, each still under the root's realpath and the file still named `<sid>.jsonl`.
 *     A symlink that escapes the root, or points at another session's file, is dropped.
 *
 * A path whose slug dir or file does not exist yet passes (a new session writes its transcript at
 * the first prompt): nothing exists to escape through. A kept path is a CLAIM, never a proof; the
 * watcher's `add` (and W4's `stat`, which must run this check again) is what proves the file.
 */

import { lstatSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, sep } from 'node:path'

/** `TRANSCRIPT_PATH_MAX` of the contract; repeated so this module has no dependency. */
const PATH_MAX = 4_096

/** A session id as a file name: what the CLI writes, and nothing a path could abuse. */
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/

export type TranscriptPathRefusal =
  | 'bad-sid'
  | 'type'
  | 'length'
  | 'nul'
  | 'relative'
  | 'traversal'
  | 'outside-root'
  | 'depth'
  | 'basename'
  | 'symlink-escape'

export type TranscriptPathCheck =
  { ok: true; path: string } | { ok: false; why: TranscriptPathRefusal }

/** The two file-system calls phase 2 makes; injected so a test can see every path touched.
 * `exists` must report a dangling symlink as existing. */
export interface PathFs {
  realpath(p: string): string
  exists(p: string): boolean
}

const nodeFs: PathFs = {
  realpath: (p) => realpathSync.native(p),
  // lstat, not stat: a dangling symlink EXISTS, and its realpath then fails, so it is dropped
  exists: (p) => {
    try {
      lstatSync(p)
      return true
    } catch {
      return false
    }
  }
}

const under = (p: string, root: string): boolean => p.startsWith(root + sep)

export function checkTranscriptPath(
  raw: unknown,
  sid: string,
  root: string,
  fs: PathFs = nodeFs
): TranscriptPathCheck {
  const no = (why: TranscriptPathRefusal): TranscriptPathCheck => ({ ok: false, why })
  if (!SID_RE.test(sid)) return no('bad-sid')
  if (typeof raw !== 'string') return no('type')
  if (raw.length === 0 || raw.length > PATH_MAX) return no('length')
  if (raw.includes('\u0000')) return no('nul')
  if (!isAbsolute(raw)) return no('relative')
  const segments = raw.split(sep).slice(1)
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return no('traversal')
  const r = root.length > 1 && root.endsWith(sep) ? root.slice(0, -1) : root
  if (!isAbsolute(r) || !under(raw, r)) return no('outside-root')
  const rel = raw.slice(r.length + 1).split(sep)
  if (rel.length !== 2) return no('depth')
  if (rel[1] !== `${sid}.jsonl`) return no('basename')

  // Phase 2: every path below is the root or under it, lexically.
  let realRoot: string
  try {
    realRoot = fs.realpath(r)
  } catch {
    return { ok: true, path: raw } // no projects dir yet: nothing to escape through
  }
  const slugDir = `${r}${sep}${rel[0]}`
  if (!fs.exists(slugDir)) return { ok: true, path: raw }
  try {
    if (!under(fs.realpath(slugDir), realRoot)) return no('symlink-escape')
    if (!fs.exists(raw)) return { ok: true, path: raw }
    const real = fs.realpath(raw)
    if (!under(real, realRoot) || basename(real) !== `${sid}.jsonl`) return no('symlink-escape')
  } catch {
    return no('symlink-escape') // a dangling or unreadable link is not kept
  }
  return { ok: true, path: raw }
}
