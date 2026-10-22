// Whether the remove confirm may offer "Also delete the branch on the remote" for a block (AC-D5,
// hardened in delta-1). The renderer never imports main code, so the rule is restated here from the
// same facts as `remoteDeleteRefusal` in src/main/gc/gc-remote-delete.ts, and
// tests/cleanup-remote-delete-dialog.test.ts pins the two against each other. Main decides again,
// from a fresh probe, when the clean runs; this only keeps the checkbox from promising what main would
// refuse. A bundle whose remote facts were not probed is never offered.
//
// No DOM, no Vue, no i18n.

import type { RemoteFacts } from '../../../main/gc/gc-remote-delete'
import type { GcBlock } from './gc-model'

export interface RemotePolicy {
  neverDeleteRemote: boolean
  protectedBranches: readonly string[]
}

/**
 * Whether the block's branch could be offered at all: a merged PR's strong proof, a branch not on the
 * protected list, the kill switch off. Cheap, from the snapshot alone: it decides which rows the
 * dialog asks main to probe (nothing is probed for the others).
 */
export function remoteDeleteCandidate(b: GcBlock, policy: RemotePolicy | null): boolean {
  if (!policy || policy.neverDeleteRemote) return false
  const bundle = b.bundle
  if (b.kind !== 'worktree' || !bundle) return false
  const branch = bundle.item.branch
  if (!branch) return false
  if (bundle.fate.fate !== 'merged' || !bundle.fate.strong) return false
  if (policy.protectedBranches.includes(branch)) return false
  return bundle.fate.signal === 'gh-merged'
}

/**
 * True when the block's branch may be deleted on the remote, given what the probe found. A branch
 * nobody probed (no facts) is never offered.
 */
export function remoteDeleteOffered(
  b: GcBlock,
  policy: RemotePolicy | null,
  facts: RemoteFacts | null | undefined
): boolean {
  if (!remoteDeleteCandidate(b, policy) || !facts) return false
  return (
    facts.remote !== null &&
    facts.remoteSha !== null &&
    facts.openPr === false &&
    facts.ghProtected === false &&
    facts.remoteMatchesLocal === true
  )
}
