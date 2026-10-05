import { describe, it, expect } from 'vitest'
import {
  REVIEW_VERDICTS,
  baseMatchesPr,
  checkSubmittable,
  ghReviewArgs,
  isReviewVerdict,
  type SubmitGuardInput
} from '../src/main/review-submit-core'

/**
 * T244 — the submit guard: **you may only approve what you read.**
 *
 * This is the one path in the review pane that writes to GitHub under the
 * operator's own identity, so the tests below are not about ergonomics. Each
 * one pins a way the pane could otherwise submit an approval of a diff the
 * operator never saw.
 */

/** A submission that should go through, so each test can break exactly one thing. */
function ok(over: Partial<SubmitGuardInput> = {}): SubmitGuardInput {
  return {
    verdict: 'approve',
    body: 'Read the whole diff. The guard is where it should be.',
    prNumber: 244,
    snapshotBase: 'origin/main',
    prBase: 'main',
    pinnedOid: 'a'.repeat(40),
    currentOid: 'a'.repeat(40),
    ...over
  }
}

describe('the argv — the body is never in it', () => {
  it('sends the body over stdin, for every verdict', () => {
    for (const verdict of REVIEW_VERDICTS) {
      const args = ghReviewArgs(12, verdict)
      expect(args.slice(0, 3)).toEqual(['pr', 'review', '12'])
      expect(args.slice(-2)).toEqual(['--body-file', '-'])
      // `/proc/<pid>/cmdline` is world-readable (BUG-84), and a review body is
      // arbitrary operator prose. It must not be reachable from argv at all.
      expect(args.join(' ')).not.toContain('--body ')
    }
  })

  it('maps each verdict onto its own gh flag', () => {
    expect(ghReviewArgs(1, 'approve')).toContain('--approve')
    expect(ghReviewArgs(1, 'request-changes')).toContain('--request-changes')
    expect(ghReviewArgs(1, 'comment')).toContain('--comment')
  })

  it('accepts exactly the three verdicts and nothing else', () => {
    expect([...REVIEW_VERDICTS]).toEqual(['approve', 'request-changes', 'comment'])
    for (const bad of ['dismiss', 'APPROVE', '', 'merge', null, 7]) {
      expect(isReviewVerdict(bad)).toBe(false)
    }
  })
})

describe('the base half — the diff must be the one GitHub shows', () => {
  it('accepts the remote-tracking spelling of the PR’s own base', () => {
    expect(baseMatchesPr('origin/main', 'main')).toBe(true)
    expect(baseMatchesPr('main', 'main')).toBe(true)
    expect(baseMatchesPr('refs/remotes/origin/release/2.1', 'release/2.1')).toBe(true)
  })

  it('refuses any other base, including the repo default standing in', () => {
    // The stacked-PR failure: a PR based on `card/T243` diffed against `main`
    // shows its parent's commits as its own.
    expect(baseMatchesPr('origin/main', 'card/T243')).toBe(false)
    // A base the operator typed.
    expect(baseMatchesPr('HEAD~5', 'main')).toBe(false)
    // Not a prefix match either way.
    expect(baseMatchesPr('origin/main-2', 'main')).toBe(false)
    expect(baseMatchesPr('main', 'main-2')).toBe(false)
  })

  it('refuses when the PR’s base is unknown rather than guessing', () => {
    expect(baseMatchesPr('origin/main', null)).toBe(false)
    expect(baseMatchesPr('origin/main', '   ')).toBe(false)
  })

  it('checkSubmittable refuses a base mismatch and names both sides', () => {
    const res = checkSubmittable(ok({ snapshotBase: 'origin/main', prBase: 'card/T243' }))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.refusal).toBe('base-mismatch')
    expect(res.detail).toContain('card/T243')
  })

  it('“I could not read the PR” is not reported as “it does not match”', () => {
    const res = checkSubmittable(ok({ prBase: null }))
    expect(res.ok).toBe(false)
    if (res.ok) return
    // A tool failure and an accusation about the diff are different sentences.
    expect(res.refusal).toBe('pr-unresolved')
  })
})

describe('the head half — a name is not a statement about content', () => {
  /**
   * THE test of this card. Everything else about the branch is unchanged — same
   * name, same base, same PR — and only the commit moved. A guard built on name
   * equality passes this happily, which is exactly how an operator approves an
   * amend, a force-push, or a commit another session made in a shared worktree
   * while the pane sat open.
   */
  it('refuses when the head moved under an otherwise identical branch', () => {
    const res = checkSubmittable(ok({ pinnedOid: 'a'.repeat(40), currentOid: 'b'.repeat(40) }))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.refusal).toBe('head-moved')
    // Both shas, so the operator can see WHICH commit they were reading.
    expect(res.detail).toBe('aaaaaaa → bbbbbbb')
  })

  it('refuses when nothing was pinned — an absent pin is not “probably fine”', () => {
    expect(checkSubmittable(ok({ pinnedOid: null }))).toMatchObject({
      ok: false,
      refusal: 'head-unreadable'
    })
  })

  it('refuses when the ref no longer resolves at all', () => {
    expect(checkSubmittable(ok({ currentOid: null }))).toMatchObject({
      ok: false,
      refusal: 'head-unreadable'
    })
  })

  it('lets an unmoved head through, for every verdict', () => {
    for (const verdict of REVIEW_VERDICTS) {
      const res = checkSubmittable(ok({ verdict }))
      expect(res.ok, `${verdict} was refused`).toBe(true)
      if (!res.ok) continue
      expect(res.args).toEqual(ghReviewArgs(244, verdict))
    }
  })
})

describe('the ordinary preconditions', () => {
  it('refuses with no PR', () => {
    for (const prNumber of [null, 0, -1, 1.5]) {
      expect(checkSubmittable(ok({ prNumber }))).toMatchObject({ ok: false, refusal: 'no-pr' })
    }
  })

  it('refuses a verdict GitHub does not take', () => {
    expect(checkSubmittable(ok({ verdict: 'dismiss' }))).toMatchObject({
      ok: false,
      refusal: 'unknown-verdict'
    })
  })

  /**
   * A body is required from ALL THREE, and that is the point rather than an
   * oversight. GitHub lets an approval skip the prose and demands it from the
   * other two, which makes approving cheaper by exactly the number of
   * keystrokes it takes to say why — the asymmetry that teaches people to
   * approve (PRD §1.3).
   */
  it('requires a body from every verdict, equally', () => {
    for (const verdict of REVIEW_VERDICTS) {
      for (const body of ['', '   ', '\n\t ']) {
        expect(
          checkSubmittable(ok({ verdict, body })),
          `${verdict} accepted an empty body`
        ).toMatchObject({ ok: false, refusal: 'empty-body' })
      }
    }
  })
})

describe('nothing in the guard reads CI, checks or a review decision (AC-5)', () => {
  /**
   * A lexical guard over the pure core, and a cheap one: the moment this module
   * grows a `ci`/`statusCheckRollup`/`reviewDecision` input it has started
   * having an opinion about the verdict, which is the R1 line this card must
   * not cross. Approve is neither disabled by red checks nor encouraged by
   * green ones — the core cannot see them at all.
   */
  it('has no input naming CI, checks or a review decision', () => {
    const keys = Object.keys(ok())
    for (const forbidden of ['ci', 'checks', 'statusCheckRollup', 'reviewDecision', 'mergeable']) {
      expect(keys, `the guard reads ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('produces the same decision regardless of anything but its own inputs', () => {
    const a = checkSubmittable(ok({ verdict: 'approve' }))
    const b = checkSubmittable(ok({ verdict: 'request-changes' }))
    // The two differ ONLY in the flag; neither is gated, defaulted or preferred.
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.args).toHaveLength(b.args.length)
    const differing = a.args.filter((x, i) => x !== b.args[i])
    expect(differing).toEqual(['--approve'])
  })
})
