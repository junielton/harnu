// Digests the sessions of orphaned transcripts into their owning repo's memory before Cleanup can
// trash them (memory U1 S-5; spec `docs/specs/2026-11-04-memory-u1-capture/spec.md`, S-5). A
// worktree that was removed takes its folder, never its `~/.claude/projects/<slug>/` transcripts;
// those transcripts are the only record of what the sessions did. This file holds the pure
// decisions (the owning repo, which sessions to digest, how many per gather) over injected I/O;
// `gc-orphan-shell.ts` supplies the real ones. Nothing here ever touches the gone folder.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { DIGEST_GATE } from '../mcp/digest-core'
import { readTranscriptFacts } from '../mcp/digest-io'
import type { OrphanTranscriptItem } from './gc-orphan-transcripts'

/** The most sessions one gather digests, across every item. */
export const ORPHAN_DIGEST_PER_GATHER = 20

/** The existence checks `ownerRepoFor` needs. */
export interface OwnerProbe {
  exists(p: string): Promise<boolean>
  /** Whether `p` is a git checkout (`git rev-parse --git-common-dir` succeeds there). */
  isCheckout(p: string): Promise<boolean>
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent}/`)

const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')))

const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/** A probe that never throws: a failed look is "no". */
async function yes(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check()
  } catch {
    return false
  }
}

/**
 * The repo whose memory should hold the digests of a removed folder's sessions: the longest known
 * repo that contains the folder and still exists; else the repo above a `.claude/worktrees`
 * folder, when that is a git checkout; else the sibling a `<repo>-worktrees` (or
 * `<repo>.worktrees`) parent names, when that is a git checkout; else `null`. The gone folder, and
 * any path under it, is never the answer.
 */
export async function ownerRepoFor(
  folder: string,
  repoPaths: readonly string[],
  probe: OwnerProbe
): Promise<string | null> {
  const gone = norm(folder)
  if (gone === '') return null
  const known = repoPaths
    .filter((r) => {
      const n = norm(r)
      return n !== '' && isUnder(gone, n) && !isUnder(n, gone)
    })
    .sort((a, b) => norm(b).length - norm(a).length)
  for (const r of known) {
    if (await yes(() => probe.exists(r))) return r
  }

  const marker = '/.claude/worktrees/'
  const at = gone.indexOf(marker)
  if (at > 0) {
    const parent = gone.slice(0, at)
    if ((await yes(() => probe.exists(parent))) && (await yes(() => probe.isCheckout(parent)))) {
      return parent
    }
  }

  const parentDir = dirOf(gone)
  const suffixed = /^(.+?)[-.]worktrees$/.exec(nameOf(parentDir))
  if (suffixed) {
    const sibling = `${dirOf(parentDir)}/${suffixed[1]}`
    if (
      !isUnder(sibling, gone) &&
      (await yes(() => probe.exists(sibling))) &&
      (await yes(() => probe.isCheckout(sibling)))
    ) {
      return sibling
    }
  }
  return null
}

/** A top-level transcript of an orphaned project. */
export interface OrphanSessionFile {
  sessionId: string
  transcriptPath: string
  mtimeMs: number
}

export interface OrphanDigestDeps {
  /** Known repo checkouts (the orphan gather's `repoPaths`). */
  repoPaths: readonly string[]
  probe: OwnerProbe
  sessionsOf(item: OrphanTranscriptItem): Promise<OrphanSessionFile[]>
  inspect(file: OrphanSessionFile): Promise<{ userTurns: number; gitBranch: string | null }>
  /** Whether the session already has a digest in `home`'s memory. */
  hasDigest(home: string, sessionId: string): Promise<boolean>
  /** Digests one session into `memoryFolder`'s memory. Absent: the gather only counts. */
  digest?(args: {
    sessionId: string
    transcriptPath: string
    memoryFolder: string
    branch: string | null
  }): Promise<void>
  /** Default {@link DIGEST_GATE}'s `minUserTurns`. */
  minUserTurns?: number
  /** Default {@link ORPHAN_DIGEST_PER_GATHER}. */
  maxPerGather?: number
}

interface Pending {
  row: number
  file: OrphanSessionFile
  branch: string | null
  home: string
}

/**
 * The gather step (D-4): for every item, finds its owning repo, counts the sessions that reach
 * `minUserTurns` and those that already have a digest there, then digests the rest, at most
 * `maxPerGather` across all items, oldest transcript first. The returned items carry
 * `digest: { done, total, home }`, counted after the digests landed; an item with no owning repo
 * keeps `done: 0`. A failure on one session never stops the others.
 */
export async function digestOrphans(
  items: readonly OrphanTranscriptItem[],
  deps: OrphanDigestDeps
): Promise<OrphanTranscriptItem[]> {
  const min = deps.minUserTurns ?? DIGEST_GATE.minUserTurns
  const max = deps.maxPerGather ?? ORPHAN_DIGEST_PER_GATHER
  const rows = items.map((item) => ({
    item,
    home: null as string | null,
    total: 0,
    done: 0
  }))
  const pending: Pending[] = []

  for (const [i, row] of rows.entries()) {
    row.home = await ownerRepoFor(row.item.folder, deps.repoPaths, deps.probe).catch(() => null)
    let files: OrphanSessionFile[]
    try {
      files = await deps.sessionsOf(row.item)
    } catch {
      // The sessions could not even be listed: fail closed, as if every one were undigested.
      row.total = row.item.sessionCount
      continue
    }
    for (const file of files) {
      let info: { userTurns: number; gitBranch: string | null }
      try {
        info = await deps.inspect(file)
      } catch {
        continue
      }
      if (info.userTurns < min) continue
      row.total++
      if (!row.home) continue
      if (await yes(() => deps.hasDigest(row.home!, file.sessionId))) row.done++
      else pending.push({ row: i, file, branch: info.gitBranch, home: row.home })
    }
  }

  if (deps.digest) {
    pending.sort(
      (a, b) => a.file.mtimeMs - b.file.mtimeMs || (a.file.sessionId < b.file.sessionId ? -1 : 1)
    )
    for (const p of pending.slice(0, max)) {
      try {
        await deps.digest({
          sessionId: p.file.sessionId,
          transcriptPath: p.file.transcriptPath,
          memoryFolder: p.home,
          branch: p.branch
        })
      } catch (err) {
        console.warn('[gc] orphan digest failed', err instanceof Error ? err.message : err)
      }
      // The engine skips quietly (an unsafe root, a refused write), so the file is the truth.
      if (await yes(() => deps.hasDigest(p.home, p.file.sessionId))) rows[p.row]!.done++
    }
  }

  return rows.map((r) => ({
    ...r.item,
    digest: { done: r.done, total: r.total, home: r.home }
  }))
}

/** The real session lister: the top-level transcripts of `<projectsRoot>/<slug>/`. */
export function fsOrphanSessions(
  projectsRoot: string
): (item: OrphanTranscriptItem) => Promise<OrphanSessionFile[]> {
  return async (item) => {
    // The slug is a plain folder name of the transcripts root, never a path.
    if (item.slug === '' || item.slug !== path.basename(item.slug)) return []
    const dir = path.join(projectsRoot, item.slug)
    const out: OrphanSessionFile[] = []
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
      const transcriptPath = path.join(dir, e.name)
      const st = await fs.stat(transcriptPath).catch(() => null)
      if (!st) continue
      out.push({
        sessionId: e.name.slice(0, -'.jsonl'.length),
        transcriptPath,
        mtimeMs: st.mtimeMs
      })
    }
    return out
  }
}

const HEAD_BYTES = 64 * 1024

/** The first non-empty string `gitBranch` among the lines of a transcript head. */
export function gitBranchFromHead(head: string): string | null {
  for (const line of head.split('\n')) {
    if (!line.includes('"gitBranch"')) continue
    try {
      const branch = (JSON.parse(line) as { gitBranch?: unknown }).gitBranch
      if (typeof branch === 'string' && branch.trim() !== '') return branch.trim()
    } catch {
      // a partial last line of the head
    }
  }
  return null
}

const inspected = new Map<string, { userTurns: number; gitBranch: string | null }>()
const INSPECTED_MAX = 2_000

/**
 * The real inspector: a transcript's user turns (a full read with the digest reader) and its
 * `gitBranch`. A transcript is frozen once its folder is gone, so the answer is kept for as long as
 * the file is the same one (path and modification time): Cleanup gathers often.
 */
export async function inspectOrphanTranscript(
  file: OrphanSessionFile
): Promise<{ userTurns: number; gitBranch: string | null }> {
  const key = `${file.transcriptPath}\0${file.mtimeMs}`
  const known = inspected.get(key)
  if (known) return known
  const { facts } = await readTranscriptFacts(file.transcriptPath)
  let gitBranch: string | null = null
  let fh: import('node:fs/promises').FileHandle | undefined
  try {
    fh = await fs.open(file.transcriptPath, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    gitBranch = gitBranchFromHead(buf.toString('utf8', 0, bytesRead))
  } catch {
    gitBranch = null
  } finally {
    await fh?.close().catch(() => undefined)
  }
  const answer = { userTurns: facts.userTurns, gitBranch }
  if (inspected.size >= INSPECTED_MAX) inspected.clear()
  inspected.set(key, answer)
  return answer
}
