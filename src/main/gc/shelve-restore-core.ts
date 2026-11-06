// Pure rules of the shelve restore service (autonomous cleanup U2.3a, design §4 U2 "Restore", C3).
//
// Which shelved entry does a folder belong to, and where does a folder that is in the way go.
// Everything with an effect lives in shelve-restore-shell.ts.

import { isInside } from '../containers/containers-core'
import { canonicalPathKey } from './bundle-core'
import type { ShelvedEntry, ShelvedFile } from './shelve-store'

/**
 * The entry whose worktree is `folder` or contains it (a session started in `WT/api` belongs to
 * `WT`). When worktrees nest, the deepest one wins. Null for an empty folder or no match.
 */
export function shelvedEntryFor(
  file: ShelvedFile,
  folder: string,
  platform: string = process.platform
): ShelvedEntry | null {
  if (!folder) return null
  const key = canonicalPathKey(folder, platform)
  let best: { entry: ShelvedEntry; depth: number } | null = null
  for (const entry of file.entries) {
    const root = canonicalPathKey(entry.worktreePath, platform)
    if (!isInside(key, root)) continue
    if (best === null || root.length > best.depth) best = { entry, depth: root.length }
  }
  return best?.entry ?? null
}

const two = (n: number): string => String(n).padStart(2, '0')

/**
 * Where a folder that stands in the way of a restore is moved to: the worktree path plus a UTC
 * stamp. Moved, never deleted: whatever is in there stays recoverable by the operator.
 */
export function leftoverPathFor(worktreePath: string, now: number): string {
  const d = new Date(now)
  const stamp =
    `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}` +
    `T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`
  return `${worktreePath}.leftover-${stamp}`
}
