import type { GcStep } from '../../../main/gc/pipeline-core'
import type { WorktreeBundle } from '../../../main/gc/bundle-core'
import type { ReasonCode } from '../lib/gc-model'
import type { RefusalCode } from '../lib/gc-jobs'
import type { RemovalRefusal } from '../lib/gc-removability'

/**
 * Copy keys shared by the Cleanup map, panel, list and Needs-you list (design.md "Workspace GC —
 * unified Cleanup"). The engine's `reason.detail` is one English sentence with a concrete fact; the
 * headline the operator reads is translated here by `code`, and the detail stays a secondary line.
 */

// Keyed by string, not `ReasonCode`: a code S3 adds (here `locked`) renders by label before this branch has
// merged the main-side type that names it.
const REASON_SUFFIX: Record<string, string> = {
  locked: 'locked',
  dirty: 'dirty',
  unpushed: 'unpushed',
  'open-idle-session': 'openIdleSession',
  'closed-unmerged': 'closedUnmerged',
  'remote-gone': 'remoteGone',
  detached: 'detached',
  'unknown-fate': 'unknownFate',
  'weak-merge-signal': 'weakMergeSignal',
  'shared-stack': 'sharedStack',
  'cleanup-failed': 'cleanupFailed',
  'path-unresolved': 'pathUnresolved',
  'nested-worktree': 'nestedWorktree',
  'check-failed': 'checkFailed',
  'no-known-worktree': 'noKnownWorktree'
}

/** `cleanup.gc.reason.*` key for a bucket + reason code; a ready item has no reason code. */
export function reasonKey(code: ReasonCode | null, ready = false): string {
  if (ready || code === null) return 'cleanup.gc.reason.ready'
  return `cleanup.gc.reason.${REASON_SUFFIX[code as string] ?? 'unknownFate'}`
}

/**
 * Why an In use block is In use, read off the bundle's own facts in the order `bucketOf` applies them
 * (main/gc/bundle-core.ts): first match wins. An In use bundle carries no reason code, so without this the
 * tooltip fell back to the Ready sentence. `lastSignOfLifeAt` is set only for `withinGrace`.
 */
export function inUseReason(
  b: Pick<
    WorktreeBundle,
    'isMainCheckout' | 'neverClean' | 'session' | 'fate' | 'lastSignOfLifeAt' | 'keep' | 'graceDays'
  >,
  now: number
): { key: string; lastSignOfLifeAt: number | null } {
  const key = (
    suffix: string,
    at: number | null = null
  ): { key: string; lastSignOfLifeAt: number | null } => ({
    key: `cleanup.gc.reason.inUse.${suffix}`,
    lastSignOfLifeAt: at
  })
  if (b.isMainCheckout) return key('mainCheckout')
  if (b.neverClean) return key('neverClean')
  if (b.session === 'working' || b.session === 'needs-input') return key('sessionWorking')
  if (b.fate.fate === 'open') return key('openPr')
  const last = b.lastSignOfLifeAt
  if (typeof last !== 'number' || !Number.isFinite(last) || last < 0) return key('unknownAge')
  const grace = b.graceDays
  const inGrace = typeof grace === 'number' ? now - last < grace * 86_400_000 : !b.keep
  if (inGrace) return key('withinGrace', last)
  return b.keep ? key('kept') : key('withinGrace', last)
}

const STEP_SUFFIX: Partial<Record<GcStep, string>> = {
  reprobe: 'reprobe',
  'stop-stack': 'stopStack',
  'rm-containers': 'rmContainers',
  'rm-volumes': 'rmVolumes',
  detach: 'detach',
  archive: 'archive',
  'drop-deps': 'dropDeps',
  trash: 'trash',
  prune: 'prune',
  'branch-delete': 'branchDelete'
}

export function stepKey(step: GcStep): string {
  return `cleanup.gc.step.${STEP_SUFFIX[step] ?? 'unknown'}`
}

/**
 * A ticket-shaped fragment of a worktree name or branch (`PROJ-0412`), for the map's label ladder:
 * `short` is `PROJ-0412`, `tiny` is `#0412`. Null when the name carries no ticket number.
 */
export function ticketParts(
  name: string,
  branch: string | null
): { short: string; tiny: string } | null {
  for (const s of [name, branch ?? '']) {
    const m = /([A-Za-z]{2,})-?(\d{2,})/.exec(s)
    if (m) return { short: `${m[1].toUpperCase()}-${m[2]}`, tiny: `#${m[2]}` }
  }
  return null
}

/** `cleanup.gc.refusal.*` key: one human sentence per refusal code. */
export function refusalKey(code: RefusalCode): string {
  return `cleanup.gc.refusal.${code.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`
}

/** `cleanup.gc.removal.reason.*` key: why a Remove cannot go ahead, in one sentence. */
export function removalKey(reason: RemovalRefusal): string {
  return `cleanup.gc.removal.reason.${reason.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`
}
