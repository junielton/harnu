// Whether the remove confirm may offer "Also delete the branch on the remote" for a block (AC-D5,
// hardened in delta-1). The renderer never imports main code, so the rule is restated here from the
// same facts as `remoteDeleteRefusal` in src/main/gc/gc-remote-delete.ts, and
// tests/cleanup-remote-delete-dialog.test.ts pins the two against each other. Main decides again,
// from a fresh probe, when the clean runs; this only keeps the checkbox from promising what main would
// refuse. A bundle whose remote facts were not probed is never offered.
//
// No DOM, no Vue, no i18n.

import type { GcBlock } from './gc-model'

export interface RemotePolicy {
  neverDeleteRemote: boolean
  protectedBranches: readonly string[]
}

/** True when the block's branch may be deleted on the remote. An unknown policy offers nothing. */
export function remoteDeleteOffered(b: GcBlock, policy: RemotePolicy | null): boolean {
  if (!policy || policy.neverDeleteRemote) return false
  const bundle = b.bundle
  if (b.kind !== 'worktree' || !bundle) return false
  const branch = bundle.item.branch
  if (!branch) return false
  if (bundle.fate.fate !== 'merged' || !bundle.fate.strong) return false
  if (policy.protectedBranches.includes(branch)) return false
  if (bundle.fate.signal !== 'gh-merged') return false
  const f = bundle.remoteFacts
  if (!f) return false
  return (
    f.remote !== null &&
    f.remoteSha !== null &&
    f.openPr === false &&
    f.ghProtected === false &&
    f.remoteMatchesLocal === true
  )
}
