/**
 * Per-session commit attribution (memory U1 S-4; spec
 * `docs/specs/2026-11-04-memory-u1-capture/spec.md`, S-4 and D-5). Two sessions on one checkout
 * used to claim each other's commits: the engine took every commit since the session started.
 * A commit is now the session's only when its committer time falls inside one of the session's
 * own git-mutating tool-call windows (its main transcript's and its subagents'); the other
 * commits that landed on the checkout while it ran are only counted, as context.
 *
 * Pure: no I/O, no clock.
 */

import type { DigestCommit, GitEvidence } from './digest-core'
import { gitWindows, type TranscriptFacts } from './digest-transcript'

/** A git-call window, epoch milliseconds, both ends included. */
export interface CommitWindow {
  startMs: number
  endMs: number
}

/** How far before the session's first line a commit still counts as "during the session". */
export const CANDIDATE_BEFORE_MS = 2_000
/** How far after the session's last line a commit still counts as "during the session". */
export const CANDIDATE_AFTER_MS = 5_000

/**
 * Splits `candidates` into the session's own commits (committer time × 1000 inside any window,
 * ends included) and a count of the rest. Order is kept.
 */
export function attributeCommits(
  candidates: DigestCommit[],
  windows: CommitWindow[]
): { mine: DigestCommit[]; others: number } {
  const mine: DigestCommit[] = []
  let others = 0
  for (const c of candidates) {
    const ms = c.committedAt * 1000
    if (windows.some((w) => ms >= w.startMs && ms <= w.endMs)) mine.push(c)
    else others++
  }
  return { mine, others }
}

/**
 * The commits that landed on the checkout during the session: those whose committer time lies
 * in `[firstAt − 2 s, lastAt + 5 s]`. A session with no timestamped line has none.
 */
export function commitCandidates(commits: DigestCommit[], facts: TranscriptFacts): DigestCommit[] {
  const first = facts.firstAt ? Date.parse(facts.firstAt) : NaN
  const last = facts.lastAt ? Date.parse(facts.lastAt) : NaN
  if (!Number.isFinite(first) || !Number.isFinite(last)) return []
  const from = first - CANDIDATE_BEFORE_MS
  const to = last + CANDIDATE_AFTER_MS
  return commits.filter((c) => c.committedAt * 1000 >= from && c.committedAt * 1000 <= to)
}

/**
 * The session's windows: `gitWindows` of its own transcript merged with those of each of its
 * subagent transcripts, sorted by start.
 */
export function sessionWindows(
  own: TranscriptFacts,
  subagents: readonly TranscriptFacts[],
  nowMs: number
): CommitWindow[] {
  return [own, ...subagents]
    .flatMap((f) => gitWindows(f, nowMs))
    .sort((a, b) => a.startMs - b.startMs)
}

/**
 * Narrows `repo` evidence to the session's own commits. `others` counts the candidates that are
 * not the session's; `narrowed` is true when the commit list changed, so the range-wide
 * `fileStats` no longer describe it (they are emptied, for the caller to recompute). Evidence
 * of any other kind is returned unchanged with no other commits.
 */
export function attributeEvidence(
  git: GitEvidence,
  facts: TranscriptFacts,
  windows: CommitWindow[]
): { git: GitEvidence; others: number; narrowed: boolean } {
  if (git.kind !== 'repo') return { git, others: 0, narrowed: false }
  const { mine, others } = attributeCommits(commitCandidates(git.commits, facts), windows)
  const narrowed = mine.length !== git.commits.length || mine.some((c, i) => c !== git.commits[i])
  if (!narrowed) return { git, others, narrowed }
  return { git: { ...git, commits: mine, fileStats: [] }, others, narrowed }
}
