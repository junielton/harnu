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

/** The identity of a shelved row: the branch survives the folder; a detached worktree shows its folder name. */
export function shelvedLabel(e: Pick<ShelvedSource, 'branch' | 'worktreePath'>): string {
  return e.branch ?? (basename(e.worktreePath) || e.worktreePath)
}

/** True when `path` is the shelved worktree or lies inside it (a session started in `WT/api`). */
function isInside(path: string, root: string): boolean {
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
export function partitionShelved<S extends { sessionId: string }, F extends PartitionFolder<S>>(
  folders: readonly F[],
  entries: readonly ShelvedSource[],
  nowMs: number
): ShelvedPartition<F, S> {
  const byRepo = new Map<string, ShelvedMember<S>[]>()
  if (entries.length === 0) return { live: [...folders], byRepo }

  const live = folders.filter((f) => !entries.some((e) => isInside(f.path, e.worktreePath)))

  const repoIdOf = (e: ShelvedSource): string | undefined => {
    const repo = normalizePath(e.repoPath)
    for (const f of folders) {
      if (f.repoId && dirname(f.repoId) === repo) return f.repoId
    }
    for (const f of folders) {
      if (f.isMainWorktree === true && f.repoId && normalizePath(f.path) === repo) return f.repoId
    }
    return undefined
  }

  const ranked = new Map<string, Array<{ at: number; member: ShelvedMember<S> }>>()
  for (const e of entries) {
    const repoId = repoIdOf(e)
    if (!repoId) continue
    const sessions: S[] = []
    const seen = new Set<string>()
    for (const f of folders) {
      if (!isInside(f.path, e.worktreePath)) continue
      for (const s of f.sessions) {
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
