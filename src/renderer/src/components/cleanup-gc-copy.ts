import type { GcStep } from '../../../main/gc/pipeline-core'
import type { ReasonCode } from '../lib/gc-model'
import type { RefusalCode } from '../lib/gc-jobs'

/**
 * Copy keys shared by the Cleanup map, panel, list and Needs-you list (design.md "Workspace GC —
 * unified Cleanup"). The engine's `reason.detail` is one English sentence with a concrete fact; the
 * headline the operator reads is translated here by `code`, and the detail stays a secondary line.
 */

const REASON_SUFFIX: Record<ReasonCode, string> = {
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
  'no-known-worktree': 'noKnownWorktree'
}

/** `cleanup.gc.reason.*` key for a bucket + reason code; a corpse has no reason code. */
export function reasonKey(code: ReasonCode | null, corpse = false): string {
  if (corpse || code === null) return 'cleanup.gc.reason.corpse'
  return `cleanup.gc.reason.${REASON_SUFFIX[code] ?? 'unknownFate'}`
}

const STEP_SUFFIX: Partial<Record<GcStep, string>> = {
  'stop-stack': 'stopStack',
  'rm-containers': 'rmContainers',
  'rm-volumes': 'rmVolumes',
  archive: 'archive',
  'drop-deps': 'dropDeps',
  trash: 'trash',
  prune: 'prune',
  'branch-delete': 'branchDelete'
}

export function stepKey(step: GcStep): string {
  return `cleanup.gc.step.${STEP_SUFFIX[step] ?? 'stopStack'}`
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
