/**
 * The Node-only I/O the digest engine is given (memory U1 S-2, spec
 * `docs/specs/2026-11-04-memory-u1-capture/spec.md`, "The reader and git"): the incremental
 * whole-transcript reader, the transcript-truth recap and the git probe. No Electron, so the
 * engine and its replay run under plain vitest.
 */

import { execFile } from 'node:child_process'
import { createReadStream, promises as fs } from 'node:fs'
import { promisify } from 'node:util'
import { deriveTranscriptTruth, isNoiseEntry, type TranscriptEntry } from '../transcript-truth'
import {
  commitsAfter,
  commitsSince,
  GIT_LOG_FORMAT,
  parseGitLog,
  parseNumstat,
  type DigestFileStat,
  type GitEvidence
} from './digest-core'
import { emptyFacts, scanTranscriptLines, type TranscriptFacts } from './digest-transcript'

const runFile = promisify(execFile)

/** A transcript line longer than this many UTF-8 bytes (newline excluded) is dropped unread. */
export const LINE_MAX_BYTES = 1_048_576

const GIT_TIMEOUT_MS = 2_000
const GIT_MAX_BUFFER = 4 << 20 // 4 MiB — a long log/numstat still fits
/** How many recent commits to read from `git log` before filtering to the session. */
const GIT_LOG_LIMIT = 80
/** Tail bytes of the JSONL to read for the transcript-truth recap. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024

const NEWLINE = 0x0a

/**
 * Folds a transcript into {@link TranscriptFacts}, from `from.offset` (default 0) to the last
 * complete line. Lines are split on `\n` here; a line over {@link LINE_MAX_BYTES} is skipped
 * without its bytes being kept; a trailing line with no newline yet is left for the next read
 * (the returned offset stops before it). Never throws: an unreadable file returns the input.
 */
export function readTranscriptFacts(
  path: string,
  from?: { offset: number; facts: TranscriptFacts }
): Promise<{ facts: TranscriptFacts; offset: number }> {
  const start = from?.offset ?? 0
  const input = { facts: from?.facts ?? emptyFacts(), offset: start }
  return new Promise((resolve) => {
    let facts = input.facts
    /** File offset of the first byte of the line being accumulated. */
    let lineStart = start
    /** File offset of the current chunk's first byte. */
    let chunkStart = start
    let pending: Buffer[] = []
    let pendingBytes = 0
    /** The current line is over the limit: its bytes are skipped until its newline. */
    let dropping = false
    let failed = false

    const stream = createReadStream(path, { start })
    stream.on('data', (data: Buffer | string) => {
      const chunk = typeof data === 'string' ? Buffer.from(data) : data
      const complete: string[] = []
      let pos = 0
      while (pos < chunk.length) {
        const nl = chunk.indexOf(NEWLINE, pos)
        const end = nl === -1 ? chunk.length : nl
        const len = end - pos
        if (!dropping) {
          if (pendingBytes + len > LINE_MAX_BYTES) {
            dropping = true
            pending = []
            pendingBytes = 0
          } else if (nl !== -1) {
            const piece = chunk.subarray(pos, end)
            const line = pending.length ? Buffer.concat([...pending, piece]) : piece
            complete.push(line.toString('utf8'))
          } else {
            pending.push(chunk.subarray(pos, end))
            pendingBytes += len
          }
        }
        if (nl === -1) break
        dropping = false
        pending = []
        pendingBytes = 0
        lineStart = chunkStart + nl + 1
        pos = nl + 1
      }
      chunkStart += chunk.length
      if (complete.length) facts = scanTranscriptLines(complete, facts)
    })
    stream.on('error', () => {
      failed = true
      stream.destroy()
      resolve(input)
    })
    stream.on('end', () => {
      if (!failed) resolve({ facts, offset: lineStart })
    })
  })
}

/**
 * Read the transcript-truth recap from a JSONL's tail (T91). Reads the last
 * {@link TRANSCRIPT_TAIL_BYTES}, parses the noise-filtered entries, and derives
 * `away_summary` / `task-summary` / `last-prompt` / titles. Never throws — a
 * missing/corrupt file yields the empty derivation.
 */
export async function readTranscriptTruth(
  fullPath: string
): Promise<ReturnType<typeof deriveTranscriptTruth>> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    fh = await fs.open(fullPath, 'r')
    const { size } = await fh.stat()
    if (size === 0) return deriveTranscriptTruth([])
    const windowBytes = Math.min(size, TRANSCRIPT_TAIL_BYTES)
    const start = size - windowBytes
    const buf = Buffer.alloc(windowBytes)
    await fh.read(buf, 0, windowBytes, start)
    let lines = buf.toString('utf8').split('\n')
    if (start > 0 && lines.length > 0) lines = lines.slice(1) // drop partial first line
    const entries: TranscriptEntry[] = []
    for (const raw of lines) {
      if (!raw) continue
      try {
        const obj = JSON.parse(raw) as TranscriptEntry
        if (obj && typeof obj === 'object' && !isNoiseEntry(obj)) entries.push(obj)
      } catch {
        /* skip a partial/corrupt line */
      }
    }
    return deriveTranscriptTruth(entries)
  } catch {
    return deriveTranscriptTruth([])
  } finally {
    if (fh) await fh.close().catch(() => undefined)
  }
}

/** Run a git command in `cwd`; returns stdout, or `null` on ANY failure. */
async function runGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await runFile('git', ['-C', cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: GIT_MAX_BUFFER
    })
    return stdout
  } catch {
    return null
  }
}

/** Count non-empty `git status --porcelain` lines (each = one changed path). */
function countPorcelain(stdout: string): number {
  return stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length
}

/**
 * Probe git for a session's evidence. A folder that is not inside a work tree (a missing one
 * included) is `not-a-repo`, and no other git command runs. Otherwise: the head of `rev`, the
 * commits after the baseline head (else since the given time, no upper bound), their aggregate
 * `--numstat` churn, and the uncommitted count. A `rev` other than `HEAD` (S-5's orphan branch)
 * reports no uncommitted changes: the checkout's working tree is not that branch's (D-10).
 */
export async function gatherGitEvidence(
  folder: string,
  sinceUnixSec: number,
  baselineHead: string | null,
  rev = 'HEAD'
): Promise<GitEvidence> {
  const inside = await runGit(folder, ['rev-parse', '--is-inside-work-tree'])
  if (inside === null || inside.trim() !== 'true') return { kind: 'not-a-repo' }

  const dirty = async (): Promise<number> => {
    if (rev !== 'HEAD') return 0
    const statusRaw = await runGit(folder, ['status', '--porcelain'])
    return statusRaw ? countPorcelain(statusRaw) : 0
  }

  const headRaw = await runGit(folder, ['rev-parse', '--verify', `${rev}^{commit}`])
  const head = headRaw?.trim() || null
  if (!head) {
    return { kind: 'repo', head: null, commits: [], fileStats: [], dirtyCount: await dirty() }
  }

  const logRaw = await runGit(folder, [
    'log',
    '-n',
    String(GIT_LOG_LIMIT),
    `--format=${GIT_LOG_FORMAT}`,
    head
  ])
  const allCommits = logRaw ? parseGitLog(logRaw) : []
  const commits = baselineHead
    ? commitsAfter(allCommits, baselineHead)
    : commitsSince(allCommits, sinceUnixSec)

  let fileStats: DigestFileStat[] = []
  if (commits.length > 0) {
    // Diff from the commit BEFORE the session's oldest commit up to the head. With a known
    // baseline that's the baseline itself; otherwise the oldest commit's parent (`~1`). A root
    // commit has no parent — that call fails and the churn block is omitted.
    const oldest = commits[commits.length - 1]
    const base = baselineHead ?? `${oldest.hash}~1`
    const numstatRaw = await runGit(folder, ['diff', '--numstat', `${base}..${head}`])
    if (numstatRaw) fileStats = parseNumstat(numstatRaw)
  }

  return { kind: 'repo', head, commits, fileStats, dirtyCount: await dirty() }
}
