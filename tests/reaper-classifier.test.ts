import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  classify,
  classifyDetachedWorktree,
  itemId,
  CONTAINMENT_UNPROVEN_DETAIL,
  DETACHED_HEAD_BLOCKER,
  PR_SET_TRUNCATED_DETAIL,
  type BranchFacts,
  type DetachedWorktreeFacts,
  type PrFacts
} from '../src/main/reaper/reaper-core'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

function facts(over: Partial<BranchFacts> = {}): BranchFacts {
  return {
    kind: 'worktree',
    repoPath: '/repo',
    branch: 'feat/x',
    path: '/repo/.claude/worktrees/feat-x',
    hidden: false,
    sessionLive: false,
    trackedDirty: false,
    untracked: [],
    unpushed: false,
    remoteExists: false,
    ancestorOfDefault: null,
    patchIdContained: null,
    lastCommitAt: NOW - 12 * DAY,
    pr: mergedPr(),
    ghAvailable: true,
    prSetComplete: true,
    prProvenance: 'own-name',
    ...over
  }
}
function mergedPr(over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 92,
    state: 'MERGED',
    reviewDecision: 'APPROVED',
    ci: 'passing',
    mergedAt: '2026-07-01T00:00:00Z',
    headRefOid: 'tipsha',
    ...over
  }
}
function cp(item: ReturnType<typeof classify>, id: string) {
  return item.checkpoints.find((c) => c.id === id)!
}

describe('classify — verdicts', () => {
  it('all-green merged worktree is harvestable, justified by gh-merged', () => {
    const item = classify(facts(), NOW)
    expect(item.verdict).toBe('harvestable')
    expect(item.justifiedBy).toBe('gh-merged')
    expect(item.checkpoints.map((c) => c.state)).toEqual([
      'green',
      'green',
      'green',
      'green',
      'green',
      'green',
      'green'
    ])
    expect(item.blockers).toEqual([])
    expect(item.needsRemoteDelete).toBe(false)
    expect(item.ageDays).toBe(12)
  })

  it('live session wins over everything', () => {
    const item = classify(facts({ sessionLive: true }), NOW)
    expect(item.verdict).toBe('active')
  })

  it('dirty worktree is blocked even when merged', () => {
    const item = classify(facts({ trackedDirty: true }), NOW)
    expect(item.verdict).toBe('blocked')
    expect(item.blockers).toContain('dirty')
    expect(cp(item, 'local-clean').state).toBe('red')
  })

  /**
   * BUG-75 — untracked files stopped being conflated with uncommitted work.
   * Measured on 2026-08-28 this was worth more unblocked rows than the two
   * detection fixes combined: `reaper-core.ts` requires a merge signal AND a
   * non-red `local-clean`, so a merged worktree with one stray file rendered
   * `blocked` with the entire PR chain green.
   */
  it('a merged worktree whose only diff is untracked files is harvestable (AC-1)', () => {
    const item = classify(facts({ trackedDirty: false, untracked: ['notes.md', 'scratch/'] }), NOW)
    expect(item.verdict).toBe('harvestable')
    expect(item.blockers).not.toContain('dirty')
    expect(item.blockers).toEqual([])
    expect(cp(item, 'local-clean').state).toBe('green')
  })

  it('discloses the untracked count on the local-clean checkpoint rather than hiding it', () => {
    expect(cp(classify(facts({ untracked: ['a', 'b'] }), NOW), 'local-clean').detail).toBe(
      '2 untracked paths'
    )
    expect(cp(classify(facts({ untracked: ['a'] }), NOW), 'local-clean').detail).toBe(
      '1 untracked path'
    )
    expect(cp(classify(facts(), NOW), 'local-clean').detail).toBeUndefined()
  })

  it('carries the untracked paths onto the item, for the sweep confirm to name (AC-3)', () => {
    expect(classify(facts({ untracked: ['notes.md'] }), NOW).untracked).toEqual(['notes.md'])
    expect(classify(facts(), NOW).untracked).toEqual([])
  })

  it('tracked modifications still block, with or without untracked files (AC-4)', () => {
    const tracked = classify(facts({ trackedDirty: true }), NOW)
    expect(tracked.verdict).toBe('blocked')
    expect(tracked.blockers).toContain('dirty')
    expect(cp(tracked, 'local-clean').state).toBe('red')

    // Untracked files must not soften a tracked modification either.
    const both = classify(facts({ trackedDirty: true, untracked: ['notes.md'] }), NOW)
    expect(both.verdict).toBe('blocked')
    expect(both.blockers).toContain('dirty')
    expect(cp(both, 'local-clean').detail).toBe('uncommitted changes')
  })

  it('a failed status probe still reads as unknown, never as clean (AC-4)', () => {
    const item = classify(facts({ trackedDirty: null, unpushed: false }), NOW)
    expect(cp(item, 'local-clean').state).toBe('unknown')
    expect(item.blockers).not.toContain('dirty')
  })

  it('merged-into-main neutralizes a deleted upstream (unpushed null must NOT block)', () => {
    const item = classify(facts({ unpushed: null }), NOW)
    expect(item.verdict).toBe('harvestable')
  })

  it('unpushed blocks when NOT merged (fail-closed)', () => {
    const item = classify(
      facts({
        pr: mergedPr({ state: 'OPEN', mergedAt: null }),
        unpushed: null,
        ancestorOfDefault: false
      }),
      NOW
    )
    expect(item.verdict).toBe('blocked')
    expect(item.blockers).toContain('unpushed')
  })

  it('no PR + not ancestor => unknown, never harvestable', () => {
    const item = classify(facts({ pr: null, ancestorOfDefault: false, remoteExists: null }), NOW)
    expect(item.verdict).toBe('unknown')
    expect(cp(item, 'in-main').state).toBe('unknown')
  })

  it('ancestor-of-default merges without gh (merge-commit path)', () => {
    const item = classify(facts({ pr: null, ghAvailable: false, ancestorOfDefault: true }), NOW)
    expect(item.verdict).toBe('harvestable')
    expect(item.justifiedBy).toBe('ancestor')
    expect(cp(item, 'pr').state).toBe('unknown') // gh absent: PR-backed checkpoints are unknown
  })

  it('remote branch still existing flags remote delete but does not block', () => {
    const item = classify(facts({ remoteExists: true }), NOW)
    expect(item.verdict).toBe('harvestable')
    expect(item.needsRemoteDelete).toBe(true)
    expect(cp(item, 'remote-gone').state).toBe('red')
  })

  it('PR closed without merge is red on pr-merged and blocked', () => {
    const item = classify(
      facts({ pr: mergedPr({ state: 'CLOSED', mergedAt: null }), ancestorOfDefault: false }),
      NOW
    )
    expect(item.verdict).toBe('blocked')
    expect(cp(item, 'pr-merged').state).toBe('red')
  })

  it('failing CI on an open PR is a blocker', () => {
    const item = classify(
      facts({
        pr: mergedPr({ state: 'OPEN', mergedAt: null, ci: 'failing' }),
        ancestorOfDefault: false
      }),
      NOW
    )
    expect(item.verdict).toBe('blocked')
    expect(item.blockers).toContain('ci-failing')
  })

  it('local-branch kind: local-clean is n/a; merged orphan branch is harvestable', () => {
    const item = classify(facts({ kind: 'local-branch', path: undefined }), NOW)
    expect(cp(item, 'local-clean').state).toBe('na')
    expect(item.verdict).toBe('harvestable')
  })

  it('remote-branch kind: merged remote orphan is harvestable and needs remote delete', () => {
    const item = classify(
      facts({
        kind: 'remote-branch',
        path: undefined,
        trackedDirty: null,
        unpushed: null,
        remoteExists: true
      }),
      NOW
    )
    expect(item.verdict).toBe('harvestable')
    expect(item.needsRemoteDelete).toBe(true)
    expect(cp(item, 'local-clean').state).toBe('na')
  })

  it('gh available but branch never had a PR: PR-backed checkpoints are n/a', () => {
    const item = classify(facts({ pr: null, ancestorOfDefault: true }), NOW)
    for (const id of ['pr', 'review', 'ci', 'pr-merged'] as const)
      expect(cp(item, id).state).toBe('na')
    expect(item.verdict).toBe('harvestable')
  })
})

// BUG-74. `na` says "there never was a PR" — a claim only an exhaustive list can
// support. When the list was capped, gh was not silent, it was truncated.
describe('classify — a capped PR set never reads as "no PR" (BUG-74)', () => {
  it('resolves the PR checkpoints to unknown, not na, for a branch absent from a capped set', () => {
    const item = classify(facts({ pr: null, prSetComplete: false }), NOW)
    for (const id of ['pr', 'review', 'ci', 'pr-merged'] as const)
      expect(cp(item, id).state).toBe('unknown')
  })

  it('names the truncation on the pr checkpoint, so the reason line is not "no probe"', () => {
    const item = classify(facts({ pr: null, prSetComplete: false }), NOW)
    expect(cp(item, 'pr').detail).toBe(PR_SET_TRUNCATED_DETAIL)
    // design.md picks the first unknown checkpoint carrying a detail, in emit order.
    const firstExplained = item.checkpoints.find((c) => c.state === 'unknown' && c.detail)
    expect(firstExplained?.id).toBe('pr')
  })

  it('never invents a merge signal from a capped set: no PR, no ancestry ⇒ unknown verdict', () => {
    const item = classify(facts({ pr: null, prSetComplete: false, ancestorOfDefault: null }), NOW)
    expect(item.justifiedBy).toBeNull()
    expect(item.verdict).toBe('unknown')
  })

  it('is irrelevant once the PR itself is in hand — a found PR still classifies normally', () => {
    const item = classify(facts({ prSetComplete: false }), NOW)
    expect(cp(item, 'pr-merged').state).toBe('green')
    expect(item.verdict).toBe('harvestable')
  })

  it('keeps gh-absent rows unknown with no truncation claim attached', () => {
    const item = classify(facts({ pr: null, ghAvailable: false, prSetComplete: false }), NOW)
    expect(cp(item, 'pr').state).toBe('unknown')
    expect(cp(item, 'pr').detail).toBeUndefined()
  })
})

describe('itemId', () => {
  it('is stable and keyed by branch when present, path otherwise', () => {
    expect(itemId({ repoPath: '/r', kind: 'worktree', branch: 'b', path: '/p' })).toBe(
      '/r::worktree::b'
    )
    expect(itemId({ repoPath: '/r', kind: 'hidden-folder', path: '/p' })).toBe(
      '/r::hidden-folder::/p'
    )
  })
})

// --- detached worktrees (BUG-95) ---------------------------------------------

function detached(over: Partial<DetachedWorktreeFacts> = {}): DetachedWorktreeFacts {
  return {
    repoPath: '/repo',
    path: '/repo/wt-detached',
    head: 'deadbeefcafe',
    hidden: false,
    sessionLive: false,
    lastCommitAt: NOW - 40 * DAY,
    diskBytes: 7_340_032,
    ...over
  }
}

describe('classifyDetachedWorktree', () => {
  it('carries the path, HEAD sha, age and disk figure', () => {
    const item = classifyDetachedWorktree(detached(), NOW)
    expect(item.kind).toBe('detached-worktree')
    expect(item.path).toBe('/repo/wt-detached')
    expect(item.headSha).toBe('deadbeefcafe')
    expect(item.ageDays).toBe(40)
    expect(item.diskBytes).toBe(7_340_032)
    expect(item.id).toBe('/repo::detached-worktree::/repo/wt-detached')
  })

  it('is never harvestable and never justified by a merge signal', () => {
    for (const over of [
      {},
      { sessionLive: true },
      { hidden: true },
      { lastCommitAt: null, diskBytes: null },
      { lastCommitAt: NOW }
    ]) {
      const item = classifyDetachedWorktree(detached(over), NOW)
      expect(item.verdict).not.toBe('harvestable')
      expect(item.justifiedBy).toBeNull()
      expect(item.needsRemoteDelete).toBe(false)
      expect(item.remoteSha).toBeNull()
    }
  })

  it('names the reason instead of a bare unexplained unknown verdict', () => {
    const item = classifyDetachedWorktree(detached(), NOW)
    expect(item.verdict).toBe('blocked')
    expect(item.verdict).not.toBe('unknown')
    expect(item.blockers).toEqual([DETACHED_HEAD_BLOCKER])
    expect(cp(item, 'pr').detail).toMatch(/detached HEAD/)
  })

  it('carries no branch and no branch-derived checkpoint state', () => {
    const item = classifyDetachedWorktree(detached(), NOW)
    expect(item.branch).toBeUndefined()
    // Branch questions are n/a (there is no branch to ask them of); the commit
    // and the folder are unknown (answerable in principle, not probed).
    for (const id of ['pr', 'review', 'ci', 'pr-merged', 'remote-gone'] as const)
      expect(cp(item, id).state).toBe('na')
    for (const id of ['in-main', 'local-clean'] as const) expect(cp(item, id).state).toBe('unknown')
    expect(item.checkpoints.some((c) => c.state === 'green')).toBe(false)
  })

  it('reports active — still not harvestable — when a session is live in the folder', () => {
    expect(classifyDetachedWorktree(detached({ sessionLive: true }), NOW).verdict).toBe('active')
  })

  it('reports a null age when the commit date was not probed', () => {
    expect(classifyDetachedWorktree(detached({ lastCommitAt: null }), NOW).ageDays).toBeNull()
  })
})

// ---- BUG-93: the squash-equivalence signal -----------------------------------

describe('classify — squash-equivalent containment (BUG-93)', () => {
  it('AC-1: a squash-merged branch with no gh access at all is harvestable', () => {
    // The degraded case the card exists for: gh absent (or truncated, or
    // unauthenticated, or a non-GitHub remote), so there is no PR verdict — and
    // ancestry is legitimately false, because the merge was a squash.
    const item = classify(
      facts({
        pr: null,
        ghAvailable: false,
        prSetComplete: false,
        ancestorOfDefault: false,
        patchIdContained: true
      }),
      NOW
    )
    expect(item.verdict).toBe('harvestable')
    expect(item.justifiedBy).toBe('squash-equivalent')
    expect(cp(item, 'in-main').state).toBe('green')
    expect(cp(item, 'in-main').detail).toBe('squash-equivalent')
  })

  it('outranks the CLOSED-and-remote-gone clause instead of being blocked by it', () => {
    // That clause is guarded by `ancestorOfDefault !== false`, and a squash-merged
    // branch has `false` legitimately — so the probe must be read BEFORE it, not
    // bolted onto it.
    const item = classify(
      facts({
        pr: mergedPr({ state: 'CLOSED', mergedAt: null }),
        remoteExists: false,
        ancestorOfDefault: false,
        patchIdContained: true
      }),
      NOW
    )
    expect(item.justifiedBy).toBe('squash-equivalent')
    expect(item.blockers).not.toContain('pr-closed-unmerged')
  })

  it('ranks below the cheap ancestor check', () => {
    const item = classify(facts({ pr: null, ancestorOfDefault: true, patchIdContained: true }), NOW)
    expect(item.justifiedBy).toBe('ancestor')
  })

  it('ranks below a merged PR resolved by the branch own name', () => {
    const item = classify(facts({ ancestorOfDefault: false, patchIdContained: true }), NOW)
    expect(item.justifiedBy).toBe('gh-merged')
  })

  it('never derives a red from a negative probe — it is positive-only evidence', () => {
    const item = classify(
      facts({ pr: null, ghAvailable: false, ancestorOfDefault: false, patchIdContained: false }),
      NOW
    )
    expect(item.verdict).toBe('unknown')
    expect(cp(item, 'in-main').state).toBe('unknown')
    expect(item.checkpoints.every((c) => c.state !== 'red')).toBe(true)
  })

  it('explains an unproven containment on in-main rather than leaving a bare unknown', () => {
    const item = classify(
      facts({ pr: null, ghAvailable: false, ancestorOfDefault: false, patchIdContained: false }),
      NOW
    )
    expect(cp(item, 'in-main').detail).toBe(CONTAINMENT_UNPROVEN_DETAIL)
  })

  it('writes no containment detail when the probe never ran', () => {
    const item = classify(
      facts({ pr: null, ghAvailable: false, ancestorOfDefault: false, patchIdContained: null }),
      NOW
    )
    expect(cp(item, 'in-main').detail).toBeUndefined()
  })

  it('ranks below a truncated PR set in emit order, by design', () => {
    // Emit order is [pr, review, ci, pr-merged, in-main, …], and `pr` leading is
    // deliberate: a reason line built as "first unknown checkpoint with a detail"
    // would pick "PR list was capped" — the recoverable cause — over this card's
    // derived symptom. This pins that ORDER.
    //
    // It deliberately does NOT claim any renderer honours it: none does. No
    // `cleanup.reason.*` key exists, `CleanupTimeline` shows each detail on its
    // own step, and `lockTitle` reads `in-main` directly — so the one-line
    // summary today is in fact CONTAINMENT_UNPROVEN_DETAIL. Asserting the
    // renderer behaviour here would re-promise the reason line that the commit
    // below this one on the stack just removed from the user docs.
    const item = classify(
      facts({
        pr: null,
        ghAvailable: true,
        prSetComplete: false,
        ancestorOfDefault: false,
        patchIdContained: false
      }),
      NOW
    )
    const first = item.checkpoints.find((c) => c.state === 'unknown' && c.detail)
    expect(first?.id).toBe('pr')
    expect(first?.detail).toBe(PR_SET_TRUNCATED_DETAIL)
    // Both details are on the row; each surfaces on its own checkpoint's title.
    expect(cp(item, 'in-main').detail).toBe(CONTAINMENT_UNPROVEN_DETAIL)
  })
})

// ---- BUG-93: the shared-upstream guard ---------------------------------------

describe('classify — upstream-resolved PRs (BUG-93)', () => {
  it('AC-3: an uncorroborated upstream-resolved merged PR does NOT justify a merge', () => {
    // The verified data-loss shape: two local branches share one upstream, and
    // the sibling that does not own the PR carries commits the default branch has
    // never seen. It must not inherit `gh-merged`.
    const item = classify(
      facts({
        prProvenance: 'upstream-unverified',
        ancestorOfDefault: false,
        patchIdContained: false,
        unpushed: true
      }),
      NOW
    )
    expect(item.justifiedBy).toBeNull()
    expect(item.verdict).not.toBe('harvestable')
  })

  it('admits an upstream-resolved PR when the local tip IS the PR head', () => {
    const item = classify(
      facts({ prProvenance: 'upstream-corroborated', ancestorOfDefault: false }),
      NOW
    )
    expect(item.justifiedBy).toBe('gh-merged')
    expect(item.verdict).toBe('harvestable')
  })

  it('admits an upstream-resolved PR when patch-id proves containment', () => {
    const item = classify(
      facts({
        prProvenance: 'upstream-unverified',
        ancestorOfDefault: false,
        patchIdContained: true
      }),
      NOW
    )
    expect(item.justifiedBy).toBe('gh-merged')
  })

  it('leaves a PR resolved by the branch own name unaffected by the guard', () => {
    const item = classify(facts({ prProvenance: 'own-name', ancestorOfDefault: false }), NOW)
    expect(item.justifiedBy).toBe('gh-merged')
  })

  it('AC-3: an uncorroborated upstream-resolved CLOSED PR does not mint remote-gone-after-close', () => {
    // The same data-loss shape as the MERGED arm above, reached through the
    // CLOSED one. Every fact here is the sibling's own and every one is honest:
    //   - it was never pushed, so `remoteExists` is false because the branch
    //     never HAD a remote head — not because one was deleted post-merge,
    //     which is the entire inference this signal rests on;
    //   - `ancestorOfDefault` is null (the probe returns null on any git exit
    //     code but 1 — an unresolvable `origin/<default>` is 128), and in that
    //     same degraded state the squash probe returns an empty map, so
    //     `patchIdContained` is null too and cannot corroborate anything;
    //   - the PR is the UPSTREAM's, closed unmerged, and belongs to the sibling
    //     that does own it.
    // Unguarded, those mint a merge signal that then neutralizes the `unpushed`
    // gate (`unpushedBlocks` is false once a signal exists), classifies the row
    // `harvestable`, and — because `remote-gone-after-close` overrides the
    // ancestry check — force-deletes it with `git branch -D` at the sweep.
    const item = classify(
      facts({
        prProvenance: 'upstream-unverified',
        pr: mergedPr({ state: 'CLOSED', mergedAt: null }),
        ancestorOfDefault: null,
        patchIdContained: null,
        remoteExists: false,
        unpushed: true
      }),
      NOW
    )
    expect(item.justifiedBy).toBeNull()
    expect(item.verdict).not.toBe('harvestable')
  })

  it('still admits a CLOSED PR resolved by the branch own name', () => {
    // The guard must narrow ONLY the upstream-unverified case; the pre-existing
    // post-merge-cleanup inference on a branch's own PR is untouched.
    const item = classify(
      facts({
        prProvenance: 'own-name',
        pr: mergedPr({ state: 'CLOSED', mergedAt: null }),
        ancestorOfDefault: null,
        remoteExists: false
      }),
      NOW
    )
    expect(item.justifiedBy).toBe('remote-gone-after-close')
  })
})

// ---- BUG-127: the timeline must not credit an uncorroborated upstream PR -----

/** Every combination of `axes`, in a fixed order (so a digest over it is stable). */
function product<T extends Record<string, readonly unknown[]>>(
  axes: T
): Array<{ [K in keyof T]: T[K][number] }> {
  return Object.entries(axes).reduce<Record<string, unknown>[]>(
    (rows, [key, values]) => rows.flatMap((row) => values.map((v) => ({ ...row, [key]: v }))),
    [{}]
  ) as Array<{ [K in keyof T]: T[K][number] }>
}

const TRI = [true, false, null] as const

/** 116,640 fact combinations — every axis `classify()` reads a PR, a merge or a gate from. */
function sweepFacts(): BranchFacts[] {
  return product({
    prProvenance: ['own-name', 'upstream-corroborated', 'upstream-unverified'] as const,
    pr: [
      null,
      mergedPr(),
      mergedPr({ state: 'CLOSED', mergedAt: null, reviewDecision: null, ci: 'unknown' }),
      mergedPr({ state: 'OPEN', mergedAt: null }),
      mergedPr({
        state: 'OPEN',
        mergedAt: null,
        reviewDecision: 'CHANGES_REQUESTED',
        ci: 'failing'
      })
    ],
    ancestorOfDefault: TRI,
    patchIdContained: TRI,
    remoteExists: TRI,
    unpushed: TRI,
    trackedDirty: TRI,
    kind: ['worktree', 'local-branch', 'hidden-folder', 'remote-branch'] as const,
    sessionLive: [false, true],
    ghAvailable: [true, false],
    prSetComplete: [true, false]
  }).map((axes) => facts(axes))
}

/**
 * sha256 over the sweep's verdict fields — `[verdict, blockers, justifiedBy,
 * needsRemoteDelete]` per combination — as computed by the classifier on `main`
 * BEFORE BUG-127 (b023df7). BUG-127 changes what the timeline says, never what
 * the row decides, so this must not move. A later card that changes a verdict on
 * purpose re-pins it and says so in its own commit.
 */
const VERDICT_DIGEST_PRE_BUG_127 =
  'fdec87257bb90afe7d0e56eee45599602836b193d8685fc1a9bea58888538755'

/**
 * sha256 over the checkpoints of every combination whose PR is credited to it —
 * own-name and upstream-corroborated — on `main` before BUG-127. Pins AC-3: a PR
 * this branch owns renders exactly as it did.
 */
const CREDITED_CHECKPOINT_DIGEST_PRE_BUG_127 =
  '98e8604551289f68980f1408b75efaac31e0c53f7a2640424b58f203241b42fb'

function sha256(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

describe('classify — timeline provenance of an upstream-resolved PR (BUG-127)', () => {
  /** The BUG-93 sibling: shares one upstream with the branch that owns merged PR #59. */
  function sibling(over: Partial<BranchFacts> = {}): BranchFacts {
    return facts({
      prProvenance: 'upstream-unverified',
      pr: mergedPr({ number: 59, headRefOid: 'ownersha' }),
      ancestorOfDefault: false,
      patchIdContained: false,
      remoteExists: false,
      unpushed: true,
      ...over
    })
  }
  const PR_BACKED = ['pr', 'review', 'ci', 'pr-merged'] as const

  it('AC-1: marks every PR-backed checkpoint as the upstream PR, pr-merged included', () => {
    const item = classify(sibling(), NOW)
    expect(item.verdict).toBe('blocked')
    for (const id of PR_BACKED) expect(cp(item, id).via).toBe('upstream')
    expect(cp(item, 'pr')).toEqual({ id: 'pr', state: 'green', detail: '#59', via: 'upstream' })
    expect(cp(item, 'pr-merged')).toEqual({
      id: 'pr-merged',
      state: 'green',
      detail: '2026-07-01T00:00:00Z',
      via: 'upstream'
    })
  })

  it('keeps an OPEN upstream PR on the row — the relationship is real — still marked', () => {
    const item = classify(sibling({ pr: mergedPr({ state: 'OPEN', mergedAt: null }) }), NOW)
    expect(cp(item, 'pr-merged')).toEqual({
      id: 'pr-merged',
      state: 'red',
      detail: 'PR still open',
      via: 'upstream'
    })
    expect(item.blockers).toContain('pr-open')
  })

  it('does not mark the checkpoints that are not about the PR', () => {
    const item = classify(sibling(), NOW)
    for (const id of ['in-main', 'remote-gone', 'local-clean'])
      expect(cp(item, id)).not.toHaveProperty('via')
  })

  it('does not derive a red in-main from a PR the branch is not credited with', () => {
    // The fourth consumer of the upstream PR. `ancestorOfDefault === false` is
    // not evidence on a squash-merging repo; the in-main red rests on "gh has a
    // PR for THIS branch and it is not merged". For the sibling gh has no such
    // PR, so it reads exactly as a branch with no PR at all — as it did before
    // BUG-93 introduced the fallback.
    const item = classify(sibling(), NOW)
    const noPr = classify(sibling({ pr: null, prProvenance: 'own-name' }), NOW)
    expect(cp(item, 'in-main')).toEqual({
      id: 'in-main',
      state: 'unknown',
      detail: CONTAINMENT_UNPROVEN_DETAIL
    })
    expect(cp(item, 'in-main')).toEqual(cp(noPr, 'in-main'))
  })

  it('still marks an upstream PR that patch-id corroborates — the merge is credited in in-main', () => {
    const item = classify(sibling({ patchIdContained: true }), NOW)
    expect(cp(item, 'pr-merged').via).toBe('upstream')
    expect(cp(item, 'in-main')).toEqual({ id: 'in-main', state: 'green', detail: 'gh-merged' })
  })

  it('AC-3: a PR resolved by the branch own name carries no mark and reads as before', () => {
    const item = classify(facts(), NOW)
    expect(item.checkpoints).toEqual([
      { id: 'pr', state: 'green', detail: '#92' },
      { id: 'review', state: 'green' },
      { id: 'ci', state: 'green' },
      { id: 'pr-merged', state: 'green', detail: '2026-07-01T00:00:00Z' },
      { id: 'in-main', state: 'green', detail: 'gh-merged' },
      { id: 'remote-gone', state: 'green' },
      { id: 'local-clean', state: 'green' }
    ])
    for (const c of item.checkpoints) expect(c).not.toHaveProperty('via')
    const open = classify(
      facts({ pr: mergedPr({ state: 'OPEN', mergedAt: null }), ancestorOfDefault: false }),
      NOW
    )
    expect(cp(open, 'in-main')).toEqual({ id: 'in-main', state: 'red', detail: 'not merged' })
  })

  it('AC-3: an upstream PR corroborated by the local tip is this branch own and is not marked', () => {
    const item = classify(facts({ prProvenance: 'upstream-corroborated' }), NOW)
    for (const c of item.checkpoints) expect(c).not.toHaveProperty('via')
  })

  it('AC-3: every credited combination renders checkpoints identical to pre-BUG-127', () => {
    const lines = sweepFacts()
      .filter((f) => f.prProvenance !== 'upstream-unverified')
      .map((f) => JSON.stringify(classify(f, NOW).checkpoints))
    expect(sha256(lines)).toBe(CREDITED_CHECKPOINT_DIGEST_PRE_BUG_127)
  })

  it('AC-4: moves no verdict for any fact combination, and never credits the sibling', () => {
    const all = sweepFacts()
    expect(all).toHaveLength(116_640)
    const lines: string[] = []
    let siblings = 0
    for (const f of all) {
      const item = classify(f, NOW)
      lines.push(
        JSON.stringify([item.verdict, item.blockers, item.justifiedBy, item.needsRemoteDelete])
      )
      if (f.pr && f.prProvenance === 'upstream-unverified' && f.patchIdContained !== true) {
        siblings++
        // No PR-derived signal for a PR the branch is not credited with …
        expect(['gh-merged', 'remote-gone-after-close']).not.toContain(item.justifiedBy)
        // … so only git's own ancestry answer can ever make it harvestable.
        if (f.ancestorOfDefault !== true) expect(item.verdict).not.toBe('harvestable')
      }
    }
    expect(siblings).toBeGreaterThan(0)
    expect(sha256(lines)).toBe(VERDICT_DIGEST_PRE_BUG_127)
  })
})
