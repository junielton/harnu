// What the gather tells the bundle builder about sessions (design: workspace-gc §3.4). Pure:
// the shell reads the Reaper's two folder sets and the real paths, this decides the entries.

import type { CanonicalPath, SessionPresence } from './bundle-core'
import { presenceFromSets } from './gc-shell'

export interface SessionEntry {
  presence: SessionPresence
  lastActivityAt: number | null
}

/**
 * One entry per folder that has, or may have, a session: the folders given, and every folder
 * the Reaper's `live` and `inUse` sets name. Presence is read through real paths, so a session
 * started through a symlink (`/real/wt`) is a session of the worktree reached by another
 * spelling (`/link/wt`); the bundle builder then finds it by containment on real paths.
 * `lastActivityAt` is filled by the caller where it knows it.
 */
export function sessionsFromFolders(
  folders: Iterable<string>,
  sets: { live: Set<string>; inUse: Set<string> },
  canonical: CanonicalPath
): Map<string, SessionEntry> {
  const out = new Map<string, SessionEntry>()
  for (const p of new Set([...folders, ...sets.live, ...sets.inUse])) {
    if (!p) continue
    out.set(p, { presence: presenceFromSets(p, sets, canonical), lastActivityAt: null })
  }
  return out
}

/** The time of a transcript: the later of its file mtime and its recorded modified stamp. */
export function sessionActivityAt(s: { fileMtime?: number; modified?: string }): number | null {
  const times = [s.fileMtime ?? 0, Date.parse(s.modified ?? '') || 0].filter((t) => t > 0)
  return times.length > 0 ? Math.max(...times) : null
}

/**
 * The same, from the transcript index the sidebar reads (`~/.claude/projects`, through the
 * fleet): every folder that ever had a Claude session, whoever started it. A `claude` run in
 * a terminal outside Harnu, a session parked an hour ago, a transcript in `WT/api`: each is an
 * entry with its latest activity, and the bundle builder takes the newest of every entry that
 * lies in the worktree or under it, on real paths, as the last sign of life that grace counts
 * from. A folder with no transcript still gets its presence from the Reaper's sets.
 */
export function sessionsFromFleet(
  fleet: ReadonlyArray<{
    path: string
    sessions: ReadonlyArray<{ fileMtime?: number; modified?: string }>
  }>,
  sets: { live: Set<string>; inUse: Set<string> },
  canonical: CanonicalPath
): Map<string, SessionEntry> {
  const out = sessionsFromFolders(
    fleet.map((f) => f.path),
    sets,
    canonical
  )
  for (const f of fleet) {
    let latest: number | null = null
    for (const s of f.sessions) {
      const at = sessionActivityAt(s)
      if (at !== null && (latest === null || at > latest)) latest = at
    }
    const entry = out.get(f.path)
    if (entry) entry.lastActivityAt = latest
  }
  return out
}
