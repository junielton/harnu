// Pure branch-fate resolver shared by the Reaper and Containers (design: workspace-gc §3.2).
// Type-only imports, no I/O — every decision here is unit-tested in tests/gc-fate-core.test.ts.

import type { BranchFacts, MergeSignal } from '../reaper/reaper-core'

export type BranchFate =
  'merged' | 'closed-unmerged' | 'remote-gone' | 'open' | 'detached' | 'unknown'

export interface FateResult {
  fate: BranchFate
  signal: MergeSignal | null
  /** true only for ancestor, squash-equivalent, or gh-merged whose headRefOid === localTip */
  strong: boolean
}

/**
 * Whether {@link BranchFacts.pr} may justify a merge signal for *this* branch.
 *
 * A PR found by the branch's own name always may. One found through a shared
 * upstream may only when the local tip is independently corroborated — either it
 * *is* the PR's head, or patch-id proves containment. Without that guard the
 * sibling of a merged branch inherits `gh-merged` and becomes sweepable while
 * carrying commits the default branch has never seen (BUG-93).
 */
export function prMayJustify(f: BranchFacts): boolean {
  return f.prProvenance !== 'upstream-unverified' || f.patchIdContained === true
}

/**
 * Signal hierarchy for "merged into the default branch".
 *
 * Order, and why:
 *  1. `gh-merged` — an external verdict, true across a squash, and free (already fetched).
 *  2. `ancestor` — git's own containment answer; the cheap local check comes before the probe.
 *  3. `squash-equivalent` — patch-id containment. Deliberately *above* the CLOSED
 *     clause below, which is guarded by `ancestorOfDefault !== false`: a
 *     squash-merged branch legitimately has `ancestorOfDefault === false`, so
 *     bolting the squash case onto that clause would be refused by the very
 *     guard that exists to read a `false` as "closed unmerged". Proven
 *     containment must override that pessimism rather than be blocked by it.
 *  4. `remote-gone-after-close` — the weakest, and the only inferential one.
 */
export function mergedSignal(f: BranchFacts): MergeSignal | null {
  if (f.pr?.state === 'MERGED' && prMayJustify(f)) return 'gh-merged'
  if (f.ancestorOfDefault === true) return 'ancestor'
  if (f.patchIdContained === true) return 'squash-equivalent'
  // Only when the ancestor check is inconclusive (null) — an explicit `false`
  // is positive evidence the branch was closed unmerged, not cleaned up post-merge.
  //
  // `prMayJustify` guards this arm too, and must: the whole inference is "the
  // remote branch was DELETED after the PR closed, so someone cleaned up". For a
  // sibling resolved through a shared upstream that reading is simply wrong —
  // `remoteExists` is false because the branch was never pushed at all. Left
  // unguarded this is a strictly worse leak than the MERGED arm: the signal it
  // mints also neutralizes the `unpushed` gate below AND overrides the ancestry
  // check in the sweep, so the sibling is force-deleted with `git branch -D`
  // while carrying commits the default branch has never seen.
  if (
    f.pr?.state === 'CLOSED' &&
    prMayJustify(f) &&
    f.remoteExists === false &&
    f.ancestorOfDefault !== false
  )
    return 'remote-gone-after-close'
  return null
}

/**
 * Resolve a branch's fate, first match wins:
 *  1. a merge signal               → `merged` (strong only for git-local proof, or a
 *                                    gh-merged PR whose head IS the local tip)
 *  2. PR CLOSED                    → `closed-unmerged`
 *  3. PR OPEN or remote branch up  → `open`
 *  4. no PR and remote branch gone → `remote-gone`
 *  5. anything else                → `unknown` (gh/ls-remote failed is never "gone")
 *
 * `strong` is the ready gate: a branch reused after its merge carries a
 * `gh-merged` signal for a tip that is no longer the PR head, so it is merged but
 * not strongly. A null on either side never counts as a match.
 */
export function resolveFate(f: BranchFacts, localTip: string | null): FateResult {
  const signal = mergedSignal(f)
  if (signal !== null) {
    const strong =
      signal === 'ancestor' ||
      signal === 'squash-equivalent' ||
      (signal === 'gh-merged' &&
        localTip !== null &&
        f.pr?.headRefOid != null &&
        f.pr.headRefOid === localTip)
    return { fate: 'merged', signal, strong }
  }
  if (f.pr?.state === 'CLOSED') return { fate: 'closed-unmerged', signal: null, strong: false }
  if (f.pr?.state === 'OPEN' || f.remoteExists === true)
    return { fate: 'open', signal: null, strong: false }
  if (!f.pr && f.remoteExists === false) return { fate: 'remote-gone', signal: null, strong: false }
  return { fate: 'unknown', signal: null, strong: false }
}

/** A detached worktree has no branch, hence no fate to resolve. */
export function resolveDetachedFate(): FateResult {
  return { fate: 'detached', signal: null, strong: false }
}
