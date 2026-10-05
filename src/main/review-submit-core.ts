/**
 * T244 — Submitting a PR review from the review pane: the pure half.
 *
 * Every other path in this pane is read-only. This one WRITES to GitHub under
 * the operator's own identity, which puts it in a different risk class from the
 * rest of T164 and is why the decision half lives here, alone and unit-tested,
 * instead of inside the `execFile` shell.
 *
 * Two things are decided in this file and nowhere else:
 *
 *  1. **`ghReviewArgs` — the argv.** The body never appears in it. `--body-file
 *     -` sends arbitrary operator prose over stdin, because argv makes quoting
 *     a correctness problem and leaks the text into process listings, where
 *     `/proc/<pid>/cmdline` is world-readable (BUG-84).
 *  2. **`checkSubmittable` — you may only approve what you read.** The diff on
 *     screen has to be `<base>...<head>` against the PR's OWN base, and the head
 *     it was computed from has to still be the head. Both are checked at SUBMIT
 *     time, against values re-read then, not against whatever the snapshot said
 *     when it was rendered.
 *
 * The second one is the whole card. A snapshot carries `base` and `branch` as
 * NAMES, and name equality is not a statement about content: a branch amended,
 * pushed to or rebased while the pane sat open still answers to the same name,
 * and this repo's own worktrees share an index and a HEAD between concurrent
 * sessions. A guard built on names alone passes happily while the operator
 * approves code they never saw — the one failure this feature can produce that
 * is worse than not existing. So the head is pinned as a SHA at fetch time and
 * compared as a sha here.
 *
 * **Refusals are named, never booleans.** The renderer owns the sentence and
 * this core owns the fact, the same split the evidence header already uses. A
 * refusal the operator cannot read is indistinguishable from a bug.
 *
 * Pure: no `child_process`, no Electron, no `fs`. Everything below is a
 * function of its arguments (ADR-0001).
 */

/** The three review events GitHub takes, and the only three this pane offers. */
export type ReviewVerdict = 'approve' | 'request-changes' | 'comment'

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = [
  'approve',
  'request-changes',
  'comment'
] as const

export function isReviewVerdict(v: unknown): v is ReviewVerdict {
  return typeof v === 'string' && (REVIEW_VERDICTS as readonly string[]).includes(v)
}

/**
 * Why a submission was refused before anything was spawned.
 *
 * `head-moved` and `base-mismatch` are the two the card exists for; the rest
 * are ordinary preconditions that would otherwise surface as a confusing `gh`
 * error about a PR that was never the problem.
 */
export type SubmitRefusal =
  | 'no-pr'
  | 'unknown-verdict'
  | 'empty-body'
  | 'pr-unresolved'
  | 'base-mismatch'
  | 'head-unreadable'
  | 'head-moved'

export interface SubmitGuardInput {
  verdict: string
  /** The operator's prose. Whitespace-only counts as empty. */
  body: string
  /** From the snapshot's evidence. `null` when the pane knows of no PR. */
  prNumber: number | null
  /** The base the rendered diff was computed against (may be `origin/main`). */
  snapshotBase: string
  /**
   * The PR's own `baseRefName`, re-read at submit time. `null`/blank means the
   * PR could not be re-read AT ALL — `gh` gone, auth expired, the PR deleted —
   * which is its own refusal rather than a base mismatch. "I cannot check" must
   * not be reported as "it does not match": the first is about the tool, the
   * second is an accusation about the diff.
   */
  prBase: string | null
  /** The head sha pinned into the snapshot when the diff was built. */
  pinnedOid: string | null
  /** What the reviewed ref resolves to NOW, re-read at submit time. */
  currentOid: string | null
}

export type SubmitDecision =
  { ok: true; args: string[] } | { ok: false; refusal: SubmitRefusal; detail?: string }

/**
 * Does the rendered diff's base name the PR's own base?
 *
 * `origin/main` and `main` are the same base wearing two hats: `resolvePrBase`
 * prefers the remote-tracking ref precisely because the PR is proposed against
 * the REMOTE's base, so the snapshot legitimately carries the prefixed form
 * while `gh` reports the bare one. Anything else — a base the operator typed, a
 * repo default that stood in for a base the PR never named — is a different
 * diff from the one GitHub shows, and approving it would be an approval of
 * something nobody else can see.
 */
export function baseMatchesPr(snapshotBase: string, prBase: string | null): boolean {
  const wanted = (prBase ?? '').trim()
  if (!wanted) return false
  const got = (snapshotBase ?? '').trim()
  if (!got) return false
  return got === wanted || got === `origin/${wanted}` || got === `refs/remotes/origin/${wanted}`
}

/** `gh pr review <n> …`, with the body deliberately absent from argv. */
export function ghReviewArgs(prNumber: number, verdict: ReviewVerdict): string[] {
  const flag =
    verdict === 'approve'
      ? '--approve'
      : verdict === 'request-changes'
        ? '--request-changes'
        : '--comment'
  return ['pr', 'review', String(prNumber), flag, '--body-file', '-']
}

/**
 * The whole gate, in the order the operator would want to hear about it: what
 * they are missing first, what has changed underneath them last.
 *
 * A body is required for ALL THREE verdicts, and that is a decision rather than
 * an oversight. GitHub requires one for `REQUEST_CHANGES` and `COMMENT` but not
 * for `APPROVE`, which would make approving the cheapest of the three by
 * exactly the number of keystrokes it takes to say why — the asymmetry that
 * teaches people to approve. Requiring prose from all three is what keeps the
 * click cost equal (PRD §1.3).
 */
export function checkSubmittable(input: SubmitGuardInput): SubmitDecision {
  if (!isReviewVerdict(input.verdict)) return { ok: false, refusal: 'unknown-verdict' }
  if (input.prNumber === null || !Number.isInteger(input.prNumber) || input.prNumber <= 0) {
    return { ok: false, refusal: 'no-pr' }
  }
  if ((input.body ?? '').trim().length === 0) return { ok: false, refusal: 'empty-body' }

  if ((input.prBase ?? '').trim().length === 0) return { ok: false, refusal: 'pr-unresolved' }
  if (!baseMatchesPr(input.snapshotBase, input.prBase)) {
    return {
      ok: false,
      refusal: 'base-mismatch',
      detail: `${input.snapshotBase || '?'} vs ${input.prBase || '?'}`
    }
  }

  // No pinned sha and no current sha are the SAME answer here — "the head this
  // was read from cannot be established" — and both refuse. Treating an absent
  // pin as "probably fine" is exactly how a guard becomes decorative.
  if (!input.pinnedOid || !input.currentOid) {
    return { ok: false, refusal: 'head-unreadable' }
  }
  if (input.pinnedOid !== input.currentOid) {
    return {
      ok: false,
      refusal: 'head-moved',
      detail: `${input.pinnedOid.slice(0, 7)} → ${input.currentOid.slice(0, 7)}`
    }
  }

  return { ok: true, args: ghReviewArgs(input.prNumber, input.verdict) }
}
