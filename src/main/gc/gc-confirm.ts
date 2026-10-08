// Binding an operator's confirmation to what they were shown (design: workspace-gc §3.3,
// Needs review → Remove; T441 delta 1). A blanket "yes, remove it" is not a confirmation of what is
// there when the job finally runs: a stack that started after the click, or a ready item that
// turned into a review item, was never looked at. The renderer sends the facts it displayed
// (`expected`); the job compares them with a fresh gather and refuses what differs.
//
// Pure: no I/O, so every comparison is unit-tested in tests/gc-confirm.test.ts.

import { canonicalPathKey, type WorktreeBundle } from './bundle-core'
import type { OrphanVolumeItem } from './gc-housekeeping-input'
import type { GcExpected } from './gc-wire'

const sorted = (xs: readonly string[]): string[] => [...xs].sort()

/** The facts a Cleanup row shows for a bundle, in the shape `gc:clean` expects back. */
export function expectedOf(b: WorktreeBundle): GcExpected {
  return {
    bucket: b.bucket,
    reasonCode: b.reason?.code ?? null,
    headSha: b.localTip ?? null,
    stackIds: sorted(b.stackIds),
    ownedVolumes: sorted(b.ownedVolumes),
    bytes: b.item.diskBytes ?? null,
    path: b.item.path ?? null
  }
}

/** The facts a Cleanup row shows for an orphan volume. */
export function orphanExpectedOf(v: OrphanVolumeItem): GcExpected {
  return {
    bucket: 'orphan-volume',
    reasonCode: v.reason.code,
    headSha: null,
    stackIds: [],
    ownedVolumes: [v.name],
    bytes: v.sizeBytes,
    path: null,
    project: v.project
  }
}

export type ChangeKind =
  'path' | 'bucket' | 'reason' | 'head' | 'stack' | 'volume' | 'size' | 'project'

const addedTo = (fresh: readonly string[], seen: readonly string[]): boolean => {
  const known = new Set(seen)
  return fresh.some((x) => !known.has(x))
}

/**
 * What differs between the bundle as it is now and as the operator saw it, or null when
 * nothing at risk does. Fewer stacks or volumes are fine; any new one is not. The size is
 * deliberately not compared: a checkout's disk use drifts without anything having changed.
 */
export function bundleChangedSince(b: WorktreeBundle, seen: GcExpected): ChangeKind | null {
  // The folder first: a worktree moved elsewhere is a different thing under the same id.
  const here = b.item.path ? canonicalPathKey(b.item.path, process.platform) : null
  const there = seen.path ? canonicalPathKey(seen.path, process.platform) : null
  if (here !== there) return 'path'
  if (b.bucket !== seen.bucket) return 'bucket'
  if ((b.reason?.code ?? null) !== seen.reasonCode) return 'reason'
  if ((b.localTip ?? null) !== seen.headSha) return 'head'
  if (addedTo(b.stackIds, seen.stackIds)) return 'stack'
  if (addedTo(b.ownedVolumes, seen.ownedVolumes)) return 'volume'
  return null
}

/** A volume that grew or moved to another project is in use by someone, so it is not what was shown. */
export function volumeChangedSince(v: OrphanVolumeItem, seen: GcExpected): ChangeKind | null {
  if (seen.bucket !== 'orphan-volume') return 'bucket'
  if (v.sizeBytes !== seen.bytes) return 'size'
  if (v.project !== (seen.project ?? null)) return 'project'
  return null
}
