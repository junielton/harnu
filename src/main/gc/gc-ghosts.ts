// What a clean job leaves behind in the Reaper snapshot. The workspace GC builds its bundles
// from the Reaper's last scan, and that scan does not know a job just removed an item: without
// this the cleaned worktrees came back as hatched "Needs review" ghosts until a manual Scan now.
// Pure; the shell (scanner-shell.ts) owns the cached snapshot and calls these.

import type { ReaperSnapshot } from '../reaper/scan-core'
import type { GcItemResult } from './pipeline-core'

/** The ids of the items a job cleaned all the way. A halted item is still on disk and stays. */
export function cleanedIds(results: readonly GcItemResult[]): Set<string> {
  return new Set(results.filter((r) => r.ok).map((r) => r.id))
}

/**
 * The snapshot without the named items. A repo whose items all went stays in the list, so the
 * gather still reads it as scanned. Returns the same object when nothing matched.
 */
export function withoutItems(snap: ReaperSnapshot, ids: ReadonlySet<string>): ReaperSnapshot {
  if (ids.size === 0) return snap
  const hit = snap.repos.some((r) => r.items.some((i) => ids.has(i.id)))
  if (!hit) return snap
  return {
    ...snap,
    repos: snap.repos.map((r) => ({ ...r, items: r.items.filter((i) => !ids.has(i.id)) }))
  }
}
