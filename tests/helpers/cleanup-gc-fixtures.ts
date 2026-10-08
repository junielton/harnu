// Builders for the Cleanup (workspace-GC) component tests: a snapshot of hand-made bundles run
// through the real view-model, so the components are tested against the shapes they really get.

import { bundle, NOW, reapItem } from '../gc-fixtures'
import { defaultGcPrefs } from '../../src/main/gc/gc-prefs'
import type { Bucket, BundleFacts, ReviewReason } from '../../src/main/gc/bundle-core'
import type { GcSnapshot, OrphanVolumeItem } from '../../src/main/gc/gc-wire'
import type { ReapItem } from '../../src/main/reaper/reaper-core'
import { buildGcModel, type GcBlock, type GcModel } from '../../src/renderer/src/lib/gc-model'

export const MIB = 1024 ** 2
export const GIB = 1024 ** 3

type Opts = Partial<BundleFacts> & { reason?: ReviewReason | null }

/** One worktree bundle. `item` overrides land on the `ReapItem` (repo, hydration, age…). */
export function wt(
  name: string,
  bucket: Bucket,
  bytes: number | null,
  item: Partial<ReapItem> = {},
  opts: Opts = {}
): ReturnType<typeof bundle> {
  const path = `/w/repo/.claude/worktrees/${name}`
  const b = bundle(path, bucket, opts)
  b.item = reapItem(path, { repoPath: '/w/repo', diskBytes: bytes, ageDays: 34, ...item })
  b.item.id = item.id ?? `/w/repo::worktree::${name}`
  return b
}

export function volume(
  name: string,
  project: string | null,
  sizeBytes: number | null
): OrphanVolumeItem {
  return {
    id: `volume:${name}`,
    name,
    sizeBytes,
    project,
    reason: { code: 'no-known-worktree', detail: 'No known worktree uses this volume.' }
  }
}

export function snapshotOf(
  bundles: ReturnType<typeof bundle>[],
  orphanVolumes: OrphanVolumeItem[] = []
): GcSnapshot {
  return {
    scannedAt: NOW,
    bundles,
    orphanVolumes,
    docker: { buildCacheReclaimableBytes: null, danglingImages: null },
    prefs: defaultGcPrefs(),
    lastCycle: null,
    nextCycleAt: null
  }
}

export function modelOf(
  bundles: ReturnType<typeof bundle>[],
  orphanVolumes: OrphanVolumeItem[] = []
): GcModel {
  return buildGcModel(snapshotOf(bundles, orphanVolumes))
}

/** The only block of a one-bundle model. */
export function blockOf(b: ReturnType<typeof bundle>): GcBlock {
  return modelOf([b]).blocks[0]
}

export const reviewReason = (code: ReviewReason['code'], detail = 'detail'): ReviewReason => ({
  code,
  detail
})
