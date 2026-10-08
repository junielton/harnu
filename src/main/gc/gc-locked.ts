// Which scanned worktrees git itself lists as locked (T441 delta 6, item 2). A lock is the
// user's "keep this registered", and a locked worktree cannot be unregistered, so it is review
// at scan time instead of being found out halfway through a clean. Pure over the real-path
// resolver; the listing is read by the scanner shell.

import { canonicalPathKey, type CanonicalPath } from './bundle-core'

export function lockedItemIds(
  items: ReadonlyArray<{ id: string; path?: string | null }>,
  lockedPaths: readonly string[],
  canonical: CanonicalPath,
  platform: string
): Set<string> {
  const locked = new Set<string>()
  for (const p of lockedPaths) {
    const real = canonical(p)
    if (real.resolved) locked.add(canonicalPathKey(real.path, platform))
  }
  const out = new Set<string>()
  if (locked.size === 0) return out
  for (const item of items) {
    if (!item.path) continue
    const real = canonical(item.path)
    if (real.resolved && locked.has(canonicalPathKey(real.path, platform))) out.add(item.id)
  }
  return out
}
