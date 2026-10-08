/**
 * Shared fixtures for the cleanup verbs' tests (T445). Not a test file itself —
 * `vitest.config.mts` only collects `*.test.ts`. Paths use the neutral vocabulary
 * from CLAUDE.md (`org/proj/www`, `PROJ-231`).
 */
import type { WorktreeBundle } from '../src/main/gc/bundle-core'
import { defaultGcPrefs, type GcPrefs } from '../src/main/gc/gc-prefs'
import type { GcSnapshot } from '../src/main/gc/gc-wire'
import type { ReapItem } from '../src/main/reaper/reaper-core'

export const DAY = 86_400_000
export const NOW = Date.parse('2026-10-07T12:00:00Z')

export const MAIN = '/srv/ws/org/proj/www'
export const WT_READY = `${MAIN}/.claude/worktrees/PROJ-231-wave-1`
export const WT_DIRTY = `${MAIN}/.claude/worktrees/PROJ-231-wave-2`
export const WT_OPEN = `${MAIN}/.claude/worktrees/PROJ-347-wave-3`
export const WT_WEAK = `${MAIN}/.claude/worktrees/PROJ-347-wave-4`
/** A worktree of MAIN that lives outside the repo tree and is not in Harnu's folder list. */
export const WT_OUT_OF_TREE = '/srv/ws/trees/PROJ-231-oot'
export const OTHER_MAIN = '/srv/ws/org/api-gateway'
export const OTHER_WT = `${OTHER_MAIN}/.claude/worktrees/PROJ-500-hotfix`

/**
 * Every absolute path (two or more segments) in a payload. The fixtures sit under `/srv/ws`,
 * outside any home directory, so the home-prefix redaction cannot hide a leak: a path that
 * reaches the output is a real leak. A branch like `feat/x` is not matched (its slash follows
 * a word character).
 */
export function absolutePathsIn(text: string): string[] {
  return text.match(/(?<![\w.~-])\/(?:[\w.-]+\/)+[\w.-]+/g) ?? []
}

export function reapItem(path: string, over: Partial<ReapItem> = {}): ReapItem {
  const repoPath = over.repoPath ?? MAIN
  return {
    id: `${repoPath}::worktree::${path}`,
    repoPath,
    kind: 'worktree',
    branch: `feat/${path.split('/').pop()}`,
    path,
    hidden: false,
    ageDays: 12,
    diskBytes: 1_000_000,
    checkpoints: [
      { id: 'pr-merged', state: 'green', detail: new Date(NOW - 10 * DAY).toISOString() },
      { id: 'local-clean', state: 'green' }
    ],
    verdict: 'harvestable',
    blockers: [],
    needsRemoteDelete: false,
    untracked: [],
    justifiedBy: 'ancestor',
    hydration: null,
    ...over
  }
}

export interface BundleOver extends Partial<Omit<WorktreeBundle, 'item'>> {
  item?: Partial<ReapItem>
}

/** A bundle that is ready to clean; each test changes the respect it is about. */
export function bundle(path: string, over: BundleOver = {}): WorktreeBundle {
  const { item: itemOver, ...rest } = over
  return {
    item: reapItem(path, itemOver),
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
    pathsResolved: true,
    localTip: 'a'.repeat(40),
    graceDays: 2,
    bucket: 'ready',
    reason: null,
    ...rest
  }
}

export function snapshot(
  bundles: WorktreeBundle[],
  over: Partial<Omit<GcSnapshot, 'prefs'>> & { prefs?: Partial<GcPrefs> } = {}
): GcSnapshot {
  const { prefs, ...rest } = over
  return {
    scannedAt: NOW,
    bundles,
    orphanVolumes: [],
    prefs: { ...defaultGcPrefs(), ...prefs },
    lastCycle: null,
    nextCycleAt: NOW + 3_600_000,
    ...rest
  }
}
