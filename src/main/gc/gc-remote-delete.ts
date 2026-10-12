// "Also delete the branch on the remote" (unit D, AC-D5): the one rule that says when it may be
// offered and when main will honour it. Pure. The renderer mirrors it (lib/gc-remote-delete.ts,
// pinned by tests/gc-orphans-remote-delete.test.ts) so the checkbox only appears when it can work.
//
// A remote branch is shared state, so every doubt refuses: only a branch proven merged by a strong
// signal (never an inferred one), that still exists on the remote, that no protection covers.

import type { WorktreeBundle } from './bundle-core'

export interface RemotePolicy {
  /** The Reaper's kill switch (Settings → Cleanup): nothing may delete a remote branch. */
  neverDeleteRemote: boolean
  /** Branch names no cleanup deletes on the remote. */
  protectedBranches: readonly string[]
}

export type RemoteDeleteRefusal =
  | 'kill-switch'
  | 'no-branch'
  | 'not-merged'
  | 'weak-proof'
  | 'no-remote-branch'
  | 'protected-branch'

/** The outcome of one remote delete, reported on the item; never a reason to fail the local clean. */
export interface RemoteDeleteOutcome {
  branch: string
  ok: boolean
  error?: string
}

/** Why a remote delete may not run for this bundle, or null when it may. */
export function remoteDeleteRefusal(
  b: Pick<WorktreeBundle, 'fate' | 'item'>,
  policy: RemotePolicy
): RemoteDeleteRefusal | null {
  if (policy.neverDeleteRemote) return 'kill-switch'
  const branch = b.item.branch
  if (!branch) return 'no-branch'
  if (b.fate.fate !== 'merged') return 'not-merged'
  if (!b.fate.strong) return 'weak-proof'
  if (!b.item.needsRemoteDelete) return 'no-remote-branch'
  if (policy.protectedBranches.includes(branch)) return 'protected-branch'
  return null
}
