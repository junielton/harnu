// The last GC snapshot's bucket per worktree path, held in memory for the Containers scan
// (design: workspace-gc §3.2). A stack in a worktree inherits its worktree's bucket, so the
// Containers view marks a stack a zombie as soon as the branch behind it is gone, instead of
// waiting for the idle clock. No electron and no I/O: the GC service writes it after every
// gather, and `containers-shell` reads it per stack.

import { normalizePath } from '../containers/containers-core'
import type { Bucket, CanonicalPath } from './bundle-core'

let buckets: ReadonlyMap<string, Bucket> = new Map()

/** Replaces the whole feed; paths are normalized on the way in. */
export function setInheritedBuckets(next: ReadonlyMap<string, Bucket>): void {
  const platform = process.platform
  buckets = new Map([...next].map(([p, b]) => [normalizePath(p, platform), b]))
}

export function clearInheritedBuckets(): void {
  buckets = new Map()
}

/**
 * The bucket recorded for a worktree path, or undefined when the GC has not judged it. A
 * stack usually runs from a subfolder of its worktree (`<worktree>/api`), so the lookup walks
 * up to the deepest recorded ancestor; a sibling that only shares a name prefix never matches.
 */
export function inheritedBucketFor(path: string): Bucket | undefined {
  let p = normalizePath(path, process.platform)
  for (;;) {
    const hit = buckets.get(p)
    if (hit !== undefined) return hit
    const cut = p.lastIndexOf('/')
    if (cut <= 0) return undefined
    p = p.slice(0, cut)
  }
}

/** The feed for one gather: each bundle's bucket by worktree path. */
export function bucketFeed(
  bundles: ReadonlyArray<{ item: { path?: string }; bucket: Bucket }>,
  canonical?: CanonicalPath
): Map<string, Bucket> {
  const out = new Map<string, Bucket>()
  // Keyed on the real location when a resolver is given, so a stack whose folder is spelled
  // through a symlink still finds its worktree.
  for (const b of bundles) {
    if (b.item.path) out.set(canonical ? canonical(b.item.path).path : b.item.path, b.bucket)
  }
  return out
}

/**
 * The lookup the Containers scan uses: `realOf` maps the folder a stack is attributed to onto
 * its real path (read when the scan stats it); a folder not in the map is looked up as written.
 */
export function bucketLookup(
  realOf: ReadonlyMap<string, string>
): (path: string) => Bucket | undefined {
  return (path) => inheritedBucketFor(realOf.get(path) ?? path)
}
