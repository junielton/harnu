// Shelved worktrees in the sidebar (autonomous cleanup U2.3b): pure helpers, tested without a DOM.
//
// A shelved worktree's folder is gone on purpose, but its transcripts still live under the old path, so the
// session scan still reports a folder there. That folder must never render as a normal or ghost row: it is
// pulled out of the live list here and re-presented as a member of its repo group's Shelved section.

import type { ShelvedMember } from '../stores/folder-zones'

/** The slice of a main-process `ShelvedEntry` the sidebar needs (structural, so tests stay small). */
export interface ShelvedSource {
  id: string
  repoPath: string
  worktreePath: string
  branch: string | null
  shelvedAt: number
}

/** The slice of a sidebar `Folder` the partition reads. */
interface PartitionFolder<S> {
  path: string
  repoId?: string
  isMainWorktree?: boolean
  sessions: S[]
}

const DAY_MS = 86_400_000

/** Forward slashes, no trailing slash: the recorded paths come from different platforms and writers. */
export function normalizePath(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return s === '' ? '/' : s
}

function dirname(p: string): string {
  const s = normalizePath(p)
  const i = s.lastIndexOf('/')
  return i <= 0 ? '/' : s.slice(0, i)
}

function basename(p: string): string {
  return normalizePath(p).split('/').pop() ?? ''
}

/** Whole days since the worktree was shelved; never negative (a clock step must not show "-3 d"). */
export function shelvedDays(e: Pick<ShelvedSource, 'shelvedAt'>, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - e.shelvedAt) / DAY_MS))
}

/** Whether two shelved lists describe the same rows (what the partition reads), so a refresh can be ignored. */
export function sameShelvedList(a: readonly ShelvedSource[], b: readonly ShelvedSource[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => {
    const y = b[i]
    return (
      x.id === y.id &&
      x.repoPath === y.repoPath &&
      x.worktreePath === y.worktreePath &&
      x.branch === y.branch &&
      x.shelvedAt === y.shelvedAt
    )
  })
}

/** The identity of a shelved row: the branch survives the folder; a detached worktree shows its folder name. */
export function shelvedLabel(e: Pick<ShelvedSource, 'branch' | 'worktreePath'>): string {
  return e.branch ?? (basename(e.worktreePath) || e.worktreePath)
}

/** True when `path` is the shelved worktree or lies inside it (a session started in `WT/api`). */
export function isInsidePath(path: string, root: string): boolean {
  const p = normalizePath(path)
  const r = normalizePath(root)
  return p === r || p.startsWith(r === '/' ? '/' : `${r}/`)
}

export interface ShelvedPartition<F, S> {
  /** Every folder that is not a shelved worktree (or inside one): the only ones the sidebar may list. */
  live: F[]
  /** The shelved members per repo, keyed by the folders' own `repoId` so `groupByRepo` can join them. */
  byRepo: Map<string, ShelvedMember<S>[]>
}

/**
 * Splits the scanned folders into the live ones and the shelved members of each repo.
 *
 * A shelved entry joins a repo when some folder in the list belongs to it: by the folder's `repoId`
 * (`<repoPath>/.git`, the git common dir) or, when a symlink makes those differ, by the main worktree's path.
 * An entry whose repo has no folder at all has no group to live in, so it is not shown (its folder is still
 * removed from the live list: a shelved worktree never shows as a ghost).
 */
export function partitionShelved<
  S extends { sessionId: string; isShellTerminal?: boolean; isSidechain?: boolean },
  F extends PartitionFolder<S>
>(folders: readonly F[], entries: readonly ShelvedSource[], nowMs: number): ShelvedPartition<F, S> {
  const byRepo = new Map<string, ShelvedMember<S>[]>()
  if (entries.length === 0) return { live: [...folders], byRepo }

  // BUG-262: every path is normalized ONCE up front. The old shape normalized each folder against each
  // shelved entry (folders x entries x 2 regex passes: 325-408 ms on a 56-worktree repo).
  const roots = entries.map((e) => normalizePath(e.worktreePath))
  const repos = entries.map((e) => normalizePath(e.repoPath))
  const folderPaths = folders.map((f) => normalizePath(f.path))
  const folderRepoDirs = folders.map((f) => (f.repoId ? dirname(f.repoId) : undefined))
  const inside = (p: string, r: string): boolean =>
    p === r || p.startsWith(r === '/' ? '/' : `${r}/`)

  const live = folders.filter((_, i) => !roots.some((r) => inside(folderPaths[i], r)))

  const repoIdOf = (ei: number): string | undefined => {
    const repo = repos[ei]
    for (let i = 0; i < folders.length; i++) {
      if (folderRepoDirs[i] === repo) return folders[i].repoId
    }
    for (let i = 0; i < folders.length; i++) {
      const f = folders[i]
      if (f.isMainWorktree === true && f.repoId && folderPaths[i] === repo) return f.repoId
    }
    return undefined
  }

  const ranked = new Map<string, Array<{ at: number; member: ShelvedMember<S> }>>()
  for (let ei = 0; ei < entries.length; ei++) {
    const e = entries[ei]
    const repoId = repoIdOf(ei)
    if (!repoId) continue
    const sessions: S[] = []
    const seen = new Set<string>()
    for (let i = 0; i < folders.length; i++) {
      if (!inside(folderPaths[i], roots[ei])) continue
      for (const s of folders[i].sessions) {
        // Same exclusions as a normal folder row: terminals and subagent chains are never session rows.
        if (s.isShellTerminal || s.isSidechain) continue
        if (seen.has(s.sessionId)) continue
        seen.add(s.sessionId)
        sessions.push(s)
      }
    }
    const member: ShelvedMember<S> = {
      id: e.id,
      label: shelvedLabel(e),
      branch: e.branch,
      worktreePath: e.worktreePath,
      repoPath: e.repoPath,
      days: shelvedDays(e, nowMs),
      sessions
    }
    const list = ranked.get(repoId) ?? []
    list.push({ at: e.shelvedAt, member })
    ranked.set(repoId, list)
  }

  // Most recently shelved first (the row's meta reads "3 d" above "41 d").
  for (const [id, list] of ranked) {
    byRepo.set(
      id,
      list.sort((a, b) => b.at - a.at).map((r) => r.member)
    )
  }
  return { live, byRepo }
}

/** The sidebar filter (spec §5.2) applied to a shelved row: its branch, its path or any session title. */
export function shelvedMatchesQuery<S>(
  m: ShelvedMember<S>,
  query: string,
  titleOf: (s: S) => string
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (m.label.toLowerCase().includes(q)) return true
  if (m.worktreePath.toLowerCase().includes(q)) return true
  return m.sessions.some((s) => titleOf(s).toLowerCase().includes(q))
}
