import type { FolderGitStatus, RoadmapPeekResult } from '../../../preload'

/**
 * T212 — pure shaping for `FolderView`. Same seam as `pr-stack-format.ts` and
 * `usage-history-format.ts`: the view renders, this module decides, so the rules
 * are testable without jsdom. design.md §6 "Folder View".
 */

/** Is this folder inside a git repo at all? A plain pinned directory is not. */
export function isGitFolder(
  folder: { repoId?: string; gitBranch?: string } | null | undefined
): boolean {
  if (!folder) return false
  return (typeof folder.repoId === 'string' && folder.repoId.length > 0) || !!folder.gitBranch
}

/** One `·`-separated piece of the header's git summary. */
export interface GitSummaryPart {
  key: 'changes' | 'clean' | 'ahead' | 'behind'
  n: number
}

export interface GitSummary {
  parts: GitSummaryPart[]
  /** Dirty or behind: the line reads in `--warning`. */
  attention: boolean
}

/**
 * `{n} changes · ↑a · ↓b`, or `clean`. A count the probe could not read (`null`)
 * is left out rather than printed as zero, and `null` means nothing to print.
 */
export function gitSummary(status: FolderGitStatus | null | undefined): GitSummary | null {
  if (!status) return null
  const dirty = status.dirtyCount ?? null
  const ahead = status.ahead ?? 0
  const behind = status.behind ?? 0
  const parts: GitSummaryPart[] = []
  if (dirty !== null) parts.push({ key: dirty > 0 ? 'changes' : 'clean', n: dirty })
  if (ahead > 0) parts.push({ key: 'ahead', n: ahead })
  if (behind > 0) parts.push({ key: 'behind', n: behind })
  if (parts.length === 0) return null
  return { parts, attention: (dirty ?? 0) > 0 || behind > 0 }
}

/** The one roadmap line: three counts and the two segments of its bar. */
export interface RoadmapLine {
  inProgress: number
  ready: number
  review: number
  /** Width of the in-progress segment, in percent of the three counts. */
  inProgressPct: number
  readyPct: number
}

/**
 * `null` when the repo has no board (no card in any column), which hides both the
 * line and the Roadmap board button.
 */
export function roadmapLine(peek: RoadmapPeekResult | null | undefined): RoadmapLine | null {
  if (!peek || !Object.values(peek.counts).some((n) => n > 0)) return null
  const inProgress = peek.counts['in-progress']
  const ready = peek.counts.ready
  const review = peek.counts.review
  const total = inProgress + ready + review
  const pct = (n: number): number => (total > 0 ? (n / total) * 100 : 0)
  return { inProgress, ready, review, inProgressPct: pct(inProgress), readyPct: pct(ready) }
}
