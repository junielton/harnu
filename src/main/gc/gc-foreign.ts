// The foreign-checkout walk, run for every worktree the gather lists (S2 delta 7). A worktree
// of another repo or a plain clone inside a worktree carries its own `.git`, and trashing the
// worktree would take that checkout's uncommitted work with it. S2's bundle builder needs one
// answer per worktree: a worktree without an answer is never ready. This module gets those
// answers, and keeps the cause when a walk fails so the shell can log it (a root-owned folder,
// say) instead of the failure being silent; the review reason itself is worded by S2's
// `bucketOf` ("check-failed", with the path, never the raw error). Pure over an injected walk.

import type { CanonicalPath } from './bundle-core'
import type { ReapItem } from '../reaper/reaper-core'

const WALKED_KINDS = new Set(['worktree', 'detached-worktree'])
const DEFAULT_CONCURRENCY = 4

export interface ForeignWalks {
  /** Item id → the `.git` entries found inside (empty: walked, nothing there). */
  found: Map<string, string[]>
  /** Item id → why the walk failed. Such an item has no entry in `found`. */
  failed: Map<string, string>
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Walks each worktree item on its real path (its given path when it did not resolve), a few at
 * a time. A walk that rejects leaves the item out of `found` and records the cause in `failed`.
 */
export async function collectForeignCheckouts(
  items: readonly ReapItem[],
  canonical: CanonicalPath,
  walk: (path: string) => Promise<string[]>,
  concurrency = DEFAULT_CONCURRENCY
): Promise<ForeignWalks> {
  const todo = items.filter((i) => WALKED_KINDS.has(i.kind) && i.path)
  const out: ForeignWalks = { found: new Map(), failed: new Map() }
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < todo.length; i = next++) {
      const item = todo[i]!
      const real = canonical(item.path as string)
      try {
        out.found.set(item.id, await walk(real.resolved ? real.path : (item.path as string)))
      } catch (err) {
        out.failed.set(item.id, messageOf(err))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker))
  return out
}
