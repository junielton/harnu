// Pure classifier for the Reaper cleanup engine (design: docs/specs/2026-07-15-reaper-cleanup-design.md).
// Only the pure fate-core import, no I/O — every decision here is unit-tested in tests/reaper-classifier.test.ts.

import { mergedSignal, prMayJustify } from '../gc/fate-core'

export type ReapItemKind =
  'worktree' | 'local-branch' | 'hidden-folder' | 'remote-branch' | 'detached-worktree'
export type CheckpointId =
  'pr' | 'review' | 'ci' | 'pr-merged' | 'in-main' | 'remote-gone' | 'local-clean'
export type CheckpointState = 'green' | 'red' | 'unknown' | 'na'
export type ReapVerdict = 'harvestable' | 'blocked' | 'unknown' | 'active'
export type MergeSignal = 'gh-merged' | 'ancestor' | 'squash-equivalent' | 'remote-gone-after-close'

/**
 * Whether a signal is authoritative *independently of git's own ancestry check*
 * — i.e. whether it may justify a `git branch -D` after `-d` refuses "not fully
 * merged" (`executor-core.ts`).
 *
 * Written as a total record over {@link MergeSignal} on purpose. BUG-46 shipped
 * because the sweep restated this as a two-value `||` chain that the classifier
 * knew nothing about, so a signal added to the union silently fell outside it
 * and every row carrying it threw at the delete step with every classifier test
 * green. A `Record<MergeSignal, …>` makes the next added member a compile error
 * here instead: the decision has to be made, it can no longer be forgotten.
 */
export const MERGE_SIGNAL_OVERRIDES_ANCESTRY: Record<MergeSignal, boolean> = {
  // gh's own PR-merged verdict — external, and true across a squash.
  'gh-merged': true,
  // Patch-id containment — proven precisely for the branches `-d` refuses (BUG-93).
  'squash-equivalent': true,
  // The remote vanished after the PR closed — external evidence of a cleanup.
  'remote-gone-after-close': true,
  // git's own ancestry answer. `-d` runs the same check, so a refusal here means
  // the facts and git disagree: fail loudly rather than force the delete.
  ancestor: false
}

/** Whether `signal` may justify forcing a branch delete past `-d`'s merged-ness check. */
export function overridesAncestryCheck(signal: MergeSignal | null): boolean {
  return signal !== null && MERGE_SIGNAL_OVERRIDES_ANCESTRY[signal]
}

/**
 * How {@link BranchFacts.pr} was resolved for a branch (BUG-93).
 *
 * `prFor()` keys on the local branch name, which misses a branch pushed under a
 * different upstream — but two local branches can share one upstream (branch off
 * an already-pushed branch, never re-push), and then the sibling that does not
 * own the PR would inherit a merge signal it has no claim to. Verified on the
 * measured corpus: the sibling carried 5 commits absent from the default branch
 * and only the dirty gate stopped it being swept.
 *
 * So the *how* travels with the PR: a PR found by the branch's own name needs no
 * corroboration; one found through the shared upstream needs the local tip to
 * match the PR's `headRefOid`, or patch-id containment, before it may justify
 * anything.
 */
export type PrProvenance = 'own-name' | 'upstream-corroborated' | 'upstream-unverified'

export interface Checkpoint {
  id: CheckpointId
  state: CheckpointState
  detail?: string
  /**
   * Set on the four PR-backed checkpoints only, and only when the PR was found
   * through a shared upstream that nothing corroborates for this branch
   * (`prProvenance === 'upstream-unverified'`, BUG-127). The checkpoint then
   * reports *that upstream's* PR — a real relationship, but not a fact about this
   * branch — so `state` is not this branch's own green or red: anything rendering
   * it must qualify it (design.md "Checkpoint timeline"). Absent everywhere else,
   * which is why a PR the branch owns renders exactly as it always did.
   */
  via?: 'upstream'
}

export interface PrFacts {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  reviewDecision: string | null
  ci: 'passing' | 'failing' | 'pending' | 'unknown'
  mergedAt: string | null
  /**
   * The PR head commit as GitHub reports it, or null when gh did not supply one
   * (an entry cached before BUG-93, most often). Only ever read to corroborate a
   * PR resolved through a shared upstream — see {@link PrProvenance}.
   */
  headRefOid: string | null
}

export interface BranchFacts {
  kind: ReapItemKind
  repoPath: string
  branch?: string
  path?: string
  hidden: boolean
  sessionLive: boolean
  /**
   * Whether at least one TRACKED path is modified/staged/deleted (BUG-75), or
   * null when the probe failed. Untracked files are deliberately NOT part of
   * this: they live in {@link BranchFacts.untracked} and never force a red
   * `local-clean`. Fed by `probeWorktreeStatus`, never by `isWorktreeDirty`.
   */
  trackedDirty: boolean | null
  /**
   * Untracked paths in the worktree — a disclosure signal, never a blocker.
   * Empty for every item with no folder to probe.
   */
  untracked: string[]
  unpushed: boolean | null
  remoteExists: boolean | null
  /** The remote branch OID at scan time (from `ls-remote`), for lease-guarded remote deletion. */
  remoteSha?: string | null
  ancestorOfDefault: boolean | null
  /**
   * Whether the branch's net diff against the default branch is already present
   * in it, by patch-id equivalence — the squash-merge signal (BUG-93).
   *
   * `merge-base --is-ancestor` was true for 2 of 141 branches on the measured
   * corpus because that repo squash-merges exclusively: the only git-side
   * containment probe is false there by construction, and a truncated, absent,
   * unauthenticated or non-GitHub gh then leaves no fallback at all. This is the
   * fallback.
   *
   * **Positive-only evidence.** `true` proves containment. `false` proves
   * nothing about the branch — a merge that resolved conflicts alters the diff,
   * and the probe's history window is bounded — so it must never derive a red.
   * `null` means the probe did not run or failed. Only `=== true` is ever read.
   *
   * Computed by the scanner and delivered here as a fact; the pure classifier
   * never probes (ADR-0001).
   */
  patchIdContained: boolean | null
  lastCommitAt: number | null
  pr: PrFacts | null
  ghAvailable: boolean
  /**
   * Whether the PR set Harnu consulted is authoritative *for this branch* — i.e.
   * whether `pr === null` may be read as "there never was a PR" (BUG-74).
   *
   * False when the bulk `gh pr list` came back capped at its limit and this
   * branch was not resolved by an individual lookup: gh was not silent, it was
   * truncated, and silence from a partial list is not evidence of absence. It
   * arrives here as a fact, computed by the scanner — the pure classifier never
   * probes for it (ADR-0001).
   *
   * Meaningless when `ghAvailable` is false (nothing was consulted at all) and
   * when `pr` is non-null (the answer is in hand either way).
   */
  prSetComplete: boolean
  /**
   * How {@link BranchFacts.pr} was found. `'own-name'` whenever there is no PR —
   * the field describes a resolution that did not happen, and the safe reading
   * of "no PR" is never a fallback claim.
   */
  prProvenance: PrProvenance
}

/**
 * Why a dehydration candidate path is refused (T250). Every reason is
 * fail-closed: uncertainty skips the path, it never proceeds.
 *
 * - `session-live` — guard 4: a live session in the worktree.
 * - `tracked` — guard 3: `git ls-files` lists files under the path.
 * - `not-ignored` — guard 2: `git check-ignore` does not confirm it.
 * - `symlink` — the path is a link (typically a `seed.link`): removing it frees
 *   nothing, and `setup` does not recreate it, so it is not reversible.
 * - `not-directory` — the path exists but is a file.
 * - `unsafe-path` — the entry escapes the worktree, names `.git`, or is not a
 *   plain relative path.
 * - `probe-failed` — a git probe errored, so a guard could not be proven.
 */
export type DehydrateSkipReason =
  | 'session-live'
  | 'tracked'
  | 'not-ignored'
  | 'symlink'
  | 'not-directory'
  | 'unsafe-path'
  | 'probe-failed'

export interface DehydrateSkip {
  /** Worktree-relative path as listed in `ephemeral:`. */
  path: string
  reason: DehydrateSkipReason
}

/**
 * The hydration axis of a worktree row (design.md "Four axes and a set").
 * `dehydrating` / `rehydrating` are in-flight states the renderer holds for the
 * duration of an operation; a scanned item is only ever at rest.
 */
export interface HydrationInfo {
  state: 'hydrated' | 'dehydrated'
  /** Ephemeral paths present on disk that pass all four guards at scan time. */
  removable: string[]
  /** Ephemeral paths present on disk but refused, with the guard that refused them. */
  skipped: DehydrateSkip[]
  /**
   * Bytes the removable paths occupy, or null when unmeasured — always null on
   * Windows, where `du` does not exist. Never a guess: the dehydrate label drops
   * its size rather than show a wrong one.
   */
  reclaimableBytes: number | null
  /** Whether the manifest declares a `setup` step, i.e. whether Harnu can rehydrate. */
  canRehydrate: boolean
  /**
   * Tracked files the last rehydrate modified that are still modified now — the
   * install rewrote them (a lockfile, usually). Empty when nothing is owed.
   */
  rehydrateChanged: string[]
}

export interface ReapItem {
  id: string
  repoPath: string
  kind: ReapItemKind
  branch?: string
  path?: string
  hidden: boolean
  ageDays: number | null
  diskBytes: number | null
  checkpoints: Checkpoint[]
  verdict: ReapVerdict
  blockers: string[]
  needsRemoteDelete: boolean
  /** Remote branch OID captured at scan time, used to lease-guard remote deletion. */
  remoteSha?: string | null
  /** The checked-out commit sha — `detached-worktree` items only, where there is no branch to name. */
  headSha?: string | null
  /**
   * Untracked paths carried through to the sweep confirm, which must name every
   * one of them before anything is deleted (BUG-75). Never a blocker.
   */
  untracked: string[]
  /**
   * A fingerprint of the uncommitted work (`git status` plus each path's size and mtime) taken at
   * scan time, only for a worktree that has any (null otherwise). The force path compares it with
   * a fresh probe, so a file edited after the operator looked halts the removal (TM-05).
   */
  workStamp?: string | null
  justifiedBy: MergeSignal | null
  /**
   * Dependency-directory state (T250), for `worktree` and `detached-worktree`
   * items only; null for every other kind. The classifier never writes it —
   * dehydration cannot move a verdict — so both classifiers emit null and the
   * scanner fills it in, exactly as it does `diskBytes`.
   */
  hydration: HydrationInfo | null
}

const DAY_MS = 86_400_000

export function itemId(facts: Pick<BranchFacts, 'repoPath' | 'kind' | 'branch' | 'path'>): string {
  return `${facts.repoPath}::${facts.kind}::${facts.branch ?? facts.path ?? ''}`
}

/**
 * Detail carried by the `pr` checkpoint when gh answered but its answer was
 * capped, so this branch's absence from it proves nothing. design.md ("The
 * reason line — no bare `unknown`, ever") requires BUG-74 to name the
 * truncation rather than leave the row reading "no probe reached a verdict".
 */
export const PR_SET_TRUNCATED_DETAIL = 'PR list was capped — no answer for this branch'

/**
 * Detail carried by the `in-main` checkpoint when the patch-id probe ran and
 * found no match, which design.md ("The reason line") requires BUG-93 to name
 * rather than leave the row reading "no probe reached a verdict".
 *
 * Deliberately phrased as *not proven*, never as *not contained*: the probe is
 * positive-only evidence (see {@link BranchFacts.patchIdContained}).
 *
 * **Emit order ranks this BELOW {@link PR_SET_TRUNCATED_DETAIL}, on purpose** — but
 * be precise about what that does and does not buy today.
 *
 * The *intent*: on a row that is both truncated and unproven (the common case —
 * both are symptoms of the same old branch), the one-line summary should read
 * "PR list was capped". That is the better line of the two: it names a
 * recoverable cause with a user action behind it (Scan now re-asks), while this
 * one names a derived symptom nobody can act on. `pr` precedes `in-main` in emit
 * order so a first-unknown-with-detail reason line would pick it. Keep that order.
 *
 * The *reality*: *no renderer composes that reason line.* design.md specs one and
 * no `cleanup.reason.*` key exists — the commit immediately below this one on the
 * stack (BUG-74) walked the user docs back for exactly this reason. What actually
 * ships is two surfaces, and on neither does the tie above resolve as intended:
 * `CleanupTimeline.vue` shows every checkpoint's detail as that step's own title
 * (both are visible, nothing competes), and `CleanupView.vue`'s `lockTitle` reads
 * the `in-main` checkpoint *directly* — so the one-line summary on an `unknown`
 * row today is THIS constant, not the truncation one.
 *
 * So: do not invert the emit order — the ranking is the right one and costs
 * nothing. Do not read it as a description of what the user currently sees, and
 * do not add a test claiming the renderer honours it until a renderer does.
 * Making `lockTitle` prefer the first unknown detail is the follow-up that would
 * make intent and behaviour agree; it belongs to whoever builds the reason line.
 */
export const CONTAINMENT_UNPROVEN_DETAIL = 'containment not proven — no patch-id match'

function prCheckpoints(f: BranchFacts): Checkpoint[] {
  if (!f.pr) {
    // Three ways to have no PR facts, and only one of them means "no PR":
    //   gh absent          → we cannot know;
    //   gh capped (BUG-74) → we cannot know either — it was truncated, not silent;
    //   gh exhaustive      → there genuinely never was a PR.
    if (f.ghAvailable && f.prSetComplete) {
      return (['pr', 'review', 'ci', 'pr-merged'] as const).map((id) => ({
        id,
        state: 'na' as CheckpointState
      }))
    }
    const detail = f.ghAvailable ? PR_SET_TRUNCATED_DETAIL : undefined
    return [
      { id: 'pr', state: 'unknown', detail },
      { id: 'review', state: 'unknown' },
      { id: 'ci', state: 'unknown' },
      { id: 'pr-merged', state: 'unknown' }
    ]
  }
  const pr = f.pr
  const merged = pr.state === 'MERGED'
  const review: Checkpoint = merged
    ? { id: 'review', state: 'green' }
    : pr.reviewDecision === 'APPROVED'
      ? { id: 'review', state: 'green' }
      : pr.reviewDecision === 'CHANGES_REQUESTED'
        ? { id: 'review', state: 'red', detail: 'changes requested' }
        : { id: 'review', state: 'unknown' }
  const ci: Checkpoint = merged
    ? { id: 'ci', state: 'green' }
    : pr.ci === 'passing'
      ? { id: 'ci', state: 'green' }
      : pr.ci === 'failing'
        ? { id: 'ci', state: 'red', detail: 'CI failing' }
        : { id: 'ci', state: 'unknown' }
  const prMerged: Checkpoint = merged
    ? { id: 'pr-merged', state: 'green', detail: pr.mergedAt ?? undefined }
    : pr.state === 'CLOSED'
      ? { id: 'pr-merged', state: 'red', detail: 'PR closed without merge' }
      : { id: 'pr-merged', state: 'red', detail: 'PR still open' }
  const checkpoints: Checkpoint[] = [
    { id: 'pr', state: 'green', detail: `#${pr.number}` },
    review,
    ci,
    prMerged
  ]
  // BUG-127: `prMayJustify` keeps an uncorroborated upstream PR out of the
  // verdict, but these four checkpoints read the same PR — unmarked, a sibling
  // of a merged branch read "PR merged" on its own row. Keep the checkpoints (the
  // sibling really does sit on that upstream, and an open PR there is worth
  // seeing) and mark whose PR they describe.
  return f.prProvenance === 'upstream-unverified'
    ? checkpoints.map((c) => ({ ...c, via: 'upstream' as const }))
    : checkpoints
}

export function classify(facts: BranchFacts, now: number): ReapItem {
  const signal = mergedSignal(facts)
  // Named once so both `unknown` arms below carry it without restating the rule.
  const unprovenDetail = facts.patchIdContained === false ? CONTAINMENT_UNPROVEN_DETAIL : undefined
  // The red below rests on "gh has a PR for THIS branch and it is not merged".
  // A PR this branch is not credited with (BUG-127) is not that, so it reads as
  // no PR at all — the pre-BUG-93 reading of the same sibling — never as a red.
  const creditedPr = prMayJustify(facts) ? facts.pr : null
  const inMain: Checkpoint =
    signal !== null
      ? { id: 'in-main', state: 'green', detail: signal }
      : facts.ancestorOfDefault === false && (creditedPr || facts.ghAvailable === false)
        ? creditedPr
          ? { id: 'in-main', state: 'red', detail: 'not merged' }
          : { id: 'in-main', state: 'unknown', detail: unprovenDetail }
        : { id: 'in-main', state: 'unknown', detail: unprovenDetail }

  const remoteGone: Checkpoint =
    facts.remoteExists === false
      ? { id: 'remote-gone', state: 'green' }
      : facts.remoteExists === true
        ? { id: 'remote-gone', state: 'red', detail: 'branch still on origin' }
        : { id: 'remote-gone', state: 'unknown' }

  const hasFolder = facts.kind === 'worktree' || facts.kind === 'hidden-folder'
  // A green merged signal neutralizes the fail-closed unpushed probe: the
  // upstream may be deleted, but the commits are provably in the default branch.
  const unpushedBlocks = facts.unpushed !== false && signal === null
  // BUG-75: only TRACKED modifications turn this red. Untracked files are real
  // content and are disclosed (and archived, T254) — but a stray file has never
  // been a reason to refuse a provably-merged worktree, and treating it as one
  // was worth more blocked rows on the measured corpus than every detection gap
  // combined. It surfaces as this checkpoint's `detail`, not as a red.
  const untrackedDetail =
    facts.untracked.length > 0
      ? `${facts.untracked.length} untracked ${facts.untracked.length === 1 ? 'path' : 'paths'}`
      : undefined
  const localClean: Checkpoint = !hasFolder
    ? { id: 'local-clean', state: 'na' }
    : facts.trackedDirty === true
      ? { id: 'local-clean', state: 'red', detail: 'uncommitted changes' }
      : unpushedBlocks
        ? { id: 'local-clean', state: 'red', detail: 'unpushed commits' }
        : facts.trackedDirty === false
          ? { id: 'local-clean', state: 'green', detail: untrackedDetail }
          : { id: 'local-clean', state: 'unknown' }

  const checkpoints: Checkpoint[] = [...prCheckpoints(facts), inMain, remoteGone, localClean]

  const blockers: string[] = []
  if (facts.trackedDirty === true) blockers.push('dirty')
  if (hasFolder && unpushedBlocks) blockers.push('unpushed')
  if (facts.pr && facts.pr.state !== 'MERGED' && facts.pr.ci === 'failing')
    blockers.push('ci-failing')
  if (facts.pr?.state === 'OPEN') blockers.push('pr-open')
  if (facts.pr?.state === 'CLOSED' && signal === null) blockers.push('pr-closed-unmerged')
  if (facts.pr?.reviewDecision === 'CHANGES_REQUESTED' && facts.pr.state === 'OPEN')
    blockers.push('changes-requested')

  let verdict: ReapVerdict
  if (facts.sessionLive) verdict = 'active'
  else if (signal !== null && localClean.state !== 'red') verdict = 'harvestable'
  else if (blockers.length > 0) verdict = 'blocked'
  else verdict = 'unknown'

  const ageDays =
    facts.lastCommitAt === null ? null : Math.floor((now - facts.lastCommitAt) / DAY_MS)

  return {
    id: itemId(facts),
    repoPath: facts.repoPath,
    kind: facts.kind,
    branch: facts.branch,
    path: facts.path,
    hidden: facts.hidden,
    ageDays,
    diskBytes: null,
    checkpoints,
    verdict,
    blockers,
    needsRemoteDelete: verdict === 'harvestable' && facts.remoteExists === true,
    remoteSha: facts.remoteSha ?? null,
    untracked: facts.untracked,
    justifiedBy: signal,
    hydration: null
  }
}

// ---- detached worktrees (BUG-95) --------------------------------------------

/**
 * Facts for a worktree whose HEAD is detached.
 *
 * Deliberately carries NO branch, PR, ancestry, upstream or remote field. A
 * detached checkout has no branch, so no merge signal is derivable for it — and
 * `harvestable` is only ever justified by a merge signal. Modelling it as its own
 * fact type (rather than a {@link BranchFacts} with an absent branch) is what makes
 * that illegal state unrepresentable instead of merely unreached.
 */
export interface DetachedWorktreeFacts {
  repoPath: string
  /** Absolute path of the checkout. */
  path: string
  /** The detached HEAD commit sha, verbatim from `git worktree list --porcelain`. */
  head: string
  hidden: boolean
  sessionLive: boolean
  /** Commit date of `head` in ms since epoch, or null when it was not probed. */
  lastCommitAt: number | null
  /** Measured size of the checkout in bytes, or null when it was not measured. */
  diskBytes: number | null
}

/** The only two verdicts a detached worktree can carry — `harvestable` is not among them. */
export type DetachedVerdict = Extract<ReapVerdict, 'active' | 'blocked'>

/** The blocker id every detached worktree carries; it is the reason, not a placeholder. */
export const DETACHED_HEAD_BLOCKER = 'detached-head'

/**
 * Classifies a detached worktree into an honest, never-sweepable item.
 *
 * The return type narrows `verdict` to {@link DetachedVerdict} and `justifiedBy` to
 * `null`, so a detached item cannot be `harvestable` even by a future edit here.
 * Checkpoints follow one rule: a question about a *branch* is `na` (there is no
 * branch to ask it of), a question about this *commit* or this *folder* is
 * `unknown` (answerable in principle, deliberately not probed).
 */
export function classifyDetachedWorktree(
  facts: DetachedWorktreeFacts,
  now: number
): ReapItem & { verdict: DetachedVerdict; justifiedBy: null } {
  const checkpoints: Checkpoint[] = [
    { id: 'pr', state: 'na', detail: 'detached HEAD — no branch to resolve' },
    { id: 'review', state: 'na' },
    { id: 'ci', state: 'na' },
    { id: 'pr-merged', state: 'na' },
    { id: 'in-main', state: 'unknown' },
    { id: 'remote-gone', state: 'na' },
    { id: 'local-clean', state: 'unknown' }
  ]

  return {
    id: itemId({ repoPath: facts.repoPath, kind: 'detached-worktree', path: facts.path }),
    repoPath: facts.repoPath,
    kind: 'detached-worktree',
    branch: undefined,
    path: facts.path,
    hidden: facts.hidden,
    ageDays: facts.lastCommitAt === null ? null : Math.floor((now - facts.lastCommitAt) / DAY_MS),
    diskBytes: facts.diskBytes,
    checkpoints,
    verdict: facts.sessionLive ? 'active' : 'blocked',
    blockers: [DETACHED_HEAD_BLOCKER],
    needsRemoteDelete: false,
    remoteSha: null,
    headSha: facts.head,
    // Never probed for a detached worktree — it is `blocked` regardless, so
    // there is nothing a disclosure list could unblock.
    untracked: [],
    justifiedBy: null,
    hydration: null
  }
}
