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
