// Shared fixtures for the Workspace GC slice 3 tests. A hand-built bundle carries the three
// fields the S2 reprobe refuses without: `localTip`, `graceDays` and `lastSignOfLifeAt`.

import type { BundleFacts, Bucket, ReviewReason, WorktreeBundle } from '../src/main/gc/bundle-core'
import type { ReapItem } from '../src/main/reaper/reaper-core'

export const DAY = 86_400_000
export const NOW = Date.parse('2026-10-07T12:00:00Z')
export const REPO = '/ws/org/proj/www'

export function reapItem(path: string, over: Partial<ReapItem> = {}): ReapItem {
  return {
    id: `${REPO}::worktree::${path}`,
    repoPath: REPO,
    kind: 'worktree',
    branch: `feat/${path.split('/').pop()}`,
    path,
    hidden: false,
    ageDays: 12,
    diskBytes: 1_000_000,
    checkpoints: [],
    verdict: 'harvestable',
    blockers: [],
    needsRemoteDelete: false,
    untracked: [],
    justifiedBy: 'ancestor',
    hydration: null,
    ...over
  }
}

export function bundle(
  path: string,
  bucket: Bucket,
  over: Partial<BundleFacts> & { reason?: ReviewReason | null } = {}
): WorktreeBundle {
  const { reason, ...facts } = over
  return {
    item: reapItem(path),
    fate: { fate: 'merged', signal: 'ancestor', strong: true },
    session: 'none',
    lastSignOfLifeAt: NOW - 10 * DAY,
    stackIds: [],
    sharedStackIds: [],
    ownedVolumes: [],
    depsBytes: null,
    keep: false,
    neverClean: false,
    isMainCheckout: false,
    localTip: 'a'.repeat(40),
    graceDays: 2,
    pathsResolved: true,
    nestedWorktrees: [],
    ...facts,
    bucket,
    reason: reason ?? (bucket === 'review' ? { code: 'dirty', detail: 'x' } : null)
  }
}
