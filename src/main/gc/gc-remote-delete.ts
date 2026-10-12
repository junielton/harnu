// "Also delete the branch on the remote" (unit D, AC-D5; hardened in delta-1): the one rule that
// says when it may be offered and when main will honour it. Pure. The renderer mirrors it
// (lib/gc-remote-delete.ts, pinned by tests/cleanup-remote-delete-dialog.test.ts) so the checkbox only
// appears when it can work.
//
// A remote branch is shared state, so every doubt refuses. It needs: a strong merge proof recorded by
// a MERGED pull request (an ancestor of main is not enough: `staging` and `release/x` are ancestors
// too), no OPEN pull request using the branch as head or base, no GitHub protection, the branch's own
// upstream remote (never assumed to be `origin`), and a remote tip that is the local tip or one of its
// ancestors. Anything Harnu could not find out reads as `unverified`.

import type { WorktreeBundle } from './bundle-core'

export interface RemotePolicy {
  /** The Reaper's kill switch (Settings → Cleanup): nothing may delete a remote branch. */
  neverDeleteRemote: boolean
  /** Branch names no cleanup deletes on the remote. */
  protectedBranches: readonly string[]
}

/** What was found out about the branch's remote copy. A null answer is "could not tell", never "no". */
export interface RemoteFacts {
  /** The remote the branch tracks (`branch.<b>.remote`), or null when it tracks none. */
  remote: string | null
  /** The branch's live tip on that remote, or null when it is not there or could not be read. */
  remoteSha: string | null
  /** The remote tip is the local tip or an ancestor of it. */
  remoteMatchesLocal: boolean | null
  /** An open pull request has the branch as its head or its base. */
  openPr: boolean | null
  /** GitHub protects the branch (branch protection or an active ruleset). */
  ghProtected: boolean | null
}

export type RemoteDeleteRefusal =
  | 'kill-switch'
  | 'no-branch'
  | 'not-merged'
  | 'weak-proof'
  | 'protected-branch'
  | 'no-merged-pr'
  | 'no-upstream'
  | 'no-remote-branch'
  | 'open-pr'
  | 'github-protected'
  | 'remote-moved'
  | 'unverified'

/** The outcome of one remote delete, reported on the item; never a reason to fail the local clean. */
export interface RemoteDeleteOutcome {
  branch: string
  ok: boolean
  error?: string
}

/** Why a remote delete may not run for this bundle, or null when it may. */
export function remoteDeleteRefusal(
  b: Pick<WorktreeBundle, 'fate' | 'item'>,
  policy: RemotePolicy,
  facts: RemoteFacts | null | undefined
): RemoteDeleteRefusal | null {
  if (policy.neverDeleteRemote) return 'kill-switch'
  const branch = b.item.branch
  if (!branch) return 'no-branch'
  if (b.fate.fate !== 'merged') return 'not-merged'
  if (!b.fate.strong) return 'weak-proof'
  if (policy.protectedBranches.includes(branch)) return 'protected-branch'
  // Only a merged pull request for this very branch (its head is the local tip) counts.
  if (b.fate.signal !== 'gh-merged') return 'no-merged-pr'
  if (!facts) return 'unverified'
  if (facts.remote === null) return 'no-upstream'
  if (facts.remoteSha === null) return 'no-remote-branch'
  if (facts.openPr === true) return 'open-pr'
  if (facts.openPr === null) return 'unverified'
  if (facts.ghProtected === true) return 'github-protected'
  if (facts.ghProtected === null) return 'unverified'
  if (facts.remoteMatchesLocal === false) return 'remote-moved'
  if (facts.remoteMatchesLocal === null) return 'unverified'
  return null
}
