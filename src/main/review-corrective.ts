/**
 * T247 (T245 U2) — the orientation a review companion is given, so it knows it
 * is blind.
 *
 * ## What this is, and what it deliberately is not
 *
 * U1 shipped the companion DELIBERATELY blind: the interlocutor is a stranger,
 * and a stranger who has to ask *"what am I looking at?"* forces the operator to
 * articulate the question — the most valuable act in a review. That decision is
 * not reversed here.
 *
 * What broke it was T246. Reviewing a PR no longer costs a working tree, so the
 * folder's `HEAD` and the diff on screen became unrelated — and the session's
 * cheapest instinct (`git status`) started returning a confident, correct,
 * IRRELEVANT answer. A session with no information asks. A session with
 * wrong-looking information guesses. Blindness only works while the session
 * *knows* it is blind.
 *
 * So this module composes a **corrective, not a briefing**: a negative fact plus
 * a pointer. Two facts and one identifier, and nothing else:
 *
 *  1. the cwd's own `HEAD` is unrelated to the diff;
 *  2. what is on screen is exactly `git diff <baseSha>...<headSha>`;
 *  3. this session is read-only;
 *  plus the PR number when there is one — an identifier, not a judgement.
 *
 * **The exclusions are NORMATIVE** (spec §4.1): no CI state, no PR/review state,
 * no commit counts, no file counts, no changed-file list in any order, no `±`
 * counts, no diff body, no card intent, nothing derived from `evidence`. That
 * content is triage substrate, and Claude-authored triage of "which files
 * matter" is an unresolved product decision (card T248) that must not be decided
 * by accident as the side effect of a context fix. {@link ReviewCorrective} is
 * the enforcement: it is five scalars wide, so none of that can physically fit
 * through the door, in main or over IPC.
 *
 * ## Identity is SHAs, never a ref name (spec §4.2)
 *
 * `refs/harnu/pr/<n>` is MUTABLE — refresh force-overwrites the same ref name
 * (`review-head.ts#fetchPrHead`). A corrective naming that ref keeps *succeeding*
 * against different content after any refresh, and a stale command that WORKS
 * makes a session guess, which is the defect one layer up. Commit SHAs are
 * immutable, so the command is self-verifying.
 *
 * ## The rule for every unreadable state: say the state, name no ref
 *
 * `not-fetched` is the DEFAULT on open (the pane fetches only on the refresh
 * gesture), and `isRepo: false` reports `state: 'ready'` with an empty ref — a
 * guard on `state !== 'ready'` walks straight past it and would emit a
 * well-formed `git diff main...` with an empty head. Naming an unresolvable ref
 * sends the session back to guessing, so every unreadable branch below names the
 * STATE and tells the session to ask instead.
 *
 * ## Channel: `--append-system-prompt`, never a positional pre-prompt
 *
 * A positional is a first USER turn: the companion would generate an unrequested
 * opening response (the auto-summary PRD §2 forbids), that reply would anchor
 * every later answer, and Harnu would be ventriloquizing the operator — the model
 * cannot tell Harnu's words from theirs. `--append-system-prompt` delivers no turn
 * at all, which is also why the transcript is never labelled with this text.
 *
 * ## Accumulation is a HAZARD here, not a feature (AC-25)
 *
 * `appendSystemPrompt` is in `ACCUMULATE_TEXT_KEYS`, and the operator's
 * global/folder text lands FIRST. A folder prompt ("always run the tests and fix
 * what fails") must not read as a read-only stranger's opening instruction, so
 * {@link composeCompanionAppend} fences the two authors apart, puts the
 * corrective LAST, and makes the precedence explicit in the prose. The operator's
 * own POSITIONAL pre-prompt is a different problem with a different answer: it is
 * dropped outright by `claude-args.ts#forceReadOnlyPermission`, because there is
 * no delimiter that makes a user turn stop being a user turn.
 *
 * ## Argv exposure (spec §4.6)
 *
 * `--append-system-prompt` is argv, and `/proc/<pid>/cmdline` is world-readable
 * to every local process (BUG-84, open). The bound of that exposure here is
 * exactly: two commit SHAs, a PR number, and this file's fixed prose. No diff
 * content, no path, no branch name. The payload is fixed-size BY CONSTRUCTION,
 * which is also what keeps it nowhere near `ARG_MAX` — the helper-pane spawn path
 * has no paste fallback, so over the threshold there is no graceful degrade.
 * **Do not let this payload grow without revisiting that.**
 *
 * Pure — no `electron`, no `child_process`, no fs. The renderer imports
 * {@link composeReviewCorrective} to render the header disclosure (AC-26), which
 * is what makes "what the session was told" the SAME string main composed rather
 * than a re-description of it.
 */

import { ACCUMULATE_SEP, type ClaudeBootConfig } from './claude-args'
import type { HeadState } from './review-head'

/**
 * Everything the companion is ever told, as data. Five scalars — deliberately
 * too narrow for anything on the §4.1 exclusion list to pass through, in main or
 * over IPC. Widening this type is how the rejected briefing comes back.
 */
export interface ReviewCorrective {
  /** The reviewed head's COMMIT SHA. `null` whenever it did not resolve. */
  headSha: string | null
  /** The base's COMMIT SHA. `null` whenever it did not resolve. */
  baseSha: string | null
  /** The head's readability, verbatim from the snapshot. */
  state: HeadState
  /** False when the reviewed folder is not a git work tree at all. */
  isRepo: boolean
  /** The PR under review, when there is one. An identifier, never a judgement. */
  prNumber: number | null
}

/**
 * The snapshot fields {@link correctiveFromSnapshot} reads — structural rather
 * than an import of `ReviewSnapshot`, which lives in the electron-bound
 * `review-ipc.ts`. A `ReviewSnapshot` satisfies this shape.
 */
export interface CorrectiveSource {
  isRepo: boolean
  baseSha: string | null
  head: { state: HeadState; sha: string | null; prNumber: number | null }
}

/** A corrective for a review nothing could be resolved about. Never names a ref. */
export const UNKNOWN_CORRECTIVE: ReviewCorrective = {
  headSha: null,
  baseSha: null,
  state: 'not-fetched',
  isRepo: false,
  prNumber: null
}

const SHA_RE = /^[0-9a-f]{7,40}$/
const HEAD_STATES: readonly HeadState[] = [
  'ready',
  'not-fetched',
  'fetch-failed',
  'base-unresolved'
]

/**
 * Narrow an untrusted (IPC-crossing) value into a {@link ReviewCorrective}.
 *
 * The renderer is our own code, not an attacker — but this is what makes AC-22
 * and AC-23 properties of MAIN rather than promises about a call site. A SHA is
 * a SHA or it is `null`; a state is one of four names or it is `not-fetched`;
 * everything else is dropped on the floor. No caller can smuggle a file list, a
 * branch name or a ref into the prose by putting it in a field.
 */
export function sanitizeCorrective(input: unknown): ReviewCorrective {
  const raw = (input ?? {}) as Partial<Record<keyof ReviewCorrective, unknown>>
  const sha = (v: unknown): string | null =>
    typeof v === 'string' && SHA_RE.test(v.trim()) ? v.trim() : null
  const state = HEAD_STATES.includes(raw.state as HeadState)
    ? (raw.state as HeadState)
    : 'not-fetched'
  const pr =
    typeof raw.prNumber === 'number' && Number.isInteger(raw.prNumber) && raw.prNumber > 0
      ? raw.prNumber
      : null
  return {
    headSha: sha(raw.headSha),
    baseSha: sha(raw.baseSha),
    state,
    isRepo: raw.isRepo === true,
    prNumber: pr
  }
}

/**
 * Project a loaded snapshot down to the five scalars the companion may be told.
 *
 * Reads through `?.` and lets {@link sanitizeCorrective} fill the gaps, which is
 * a correctness requirement rather than defensive habit: this runs inside the
 * click handler that opens the companion, so a snapshot missing a field would
 * THROW and produce no companion at all — strictly worse than a corrective that
 * says the diff cannot be named and tells the session to ask. Degrading is the
 * behaviour every state in the spec's §4.4 table asks for anyway.
 */
export function correctiveFromSnapshot(snapshot: CorrectiveSource): ReviewCorrective {
  const head = snapshot?.head as CorrectiveSource['head'] | undefined
  return sanitizeCorrective({
    headSha: head?.sha,
    baseSha: snapshot?.baseSha,
    state: head?.state,
    isRepo: snapshot?.isRepo,
    prNumber: head?.prNumber
  })
}

/** Fences that name the author of each half of the composed append (AC-25). */
export const CORRECTIVE_OPEN = '<<< HARNU REVIEW ORIENTATION — written by Harnu >>>'
export const CORRECTIVE_CLOSE = '<<< END HARNU REVIEW ORIENTATION >>>'
export const OPERATOR_OPEN =
  "<<< OPERATOR-AUTHORED APPEND — from this folder's Claude Boot settings, not from Harnu >>>"
export const OPERATOR_CLOSE = '<<< END OPERATOR-AUTHORED APPEND >>>'

/**
 * The one line that either names the diff or names why it cannot be named.
 *
 * `isRepo` is checked BEFORE `state` on purpose: `emptySnapshot` reports
 * `state: 'ready'` with an empty ref, so a `state`-first guard emits a
 * well-formed command with an empty head — the failure spec §4.4 calls out by
 * name. `ready` with a missing SHA is treated the same way for the same reason.
 */
function rangeLine(c: ReviewCorrective): string {
  const ask = 'Ask the operator what they are reviewing rather than guessing from this directory.'
  if (!c.isRepo) {
    return `The diff cannot be named from here: this directory is not a git work tree. ${ask}`
  }
  switch (c.state) {
    case 'not-fetched':
      return `The diff cannot be named from here: the reviewed head has not been fetched into this repository yet, so there is no local commit to point at. ${ask}`
    case 'fetch-failed':
      return `The diff cannot be named from here: fetching the reviewed head failed, so there is no local commit to point at. ${ask}`
    case 'base-unresolved':
      return `The diff cannot be named from here: the base this change is proposed against did not resolve, so there is no commit range to point at. ${ask}`
    case 'ready':
      if (c.baseSha && c.headSha) {
        return `The diff under review is exactly this, and these commits are already present locally:\n\n    git diff ${c.baseSha}...${c.headSha}\n\nThe review pane renders its own view of that diff and may be showing only part of it; the command above is the diff itself.`
      }
      return `The diff cannot be named from here: its commits did not resolve. ${ask}`
  }
}

/**
 * Compose the corrective. Deterministic in its five inputs and in nothing else.
 *
 * **Model-facing prose, NOT UI copy (AC-31).** It never goes through `$t()` and
 * never varies by locale: a translated corrective forks model behaviour by the
 * operator's language setting, which is a bug nobody would ever find. The header
 * disclosure's *label* is UI copy and does go through `$t()`.
 */
export function composeReviewCorrective(input: ReviewCorrective): string {
  const c = sanitizeCorrective(input)
  const lines = [
    CORRECTIVE_OPEN,
    '',
    "You were opened beside a diff that the operator is reading in Harnu's review pane. You cannot see that diff, and you cannot find it from where you are standing: this working directory's own HEAD is unrelated to it, so `git status`, `git branch`, `git log` and a bare `git diff` here all describe something else. Do not infer the review from them.",
    '',
    rangeLine(c)
  ]
  if (c.prNumber !== null) {
    lines.push('', `The review is of pull request #${c.prNumber}.`)
  }
  lines.push(
    '',
    'This session is read-only: the Edit, Write and NotebookEdit tools are denied for the life of this process. Bash is not — you can read files, grep, and run tests, but you cannot change the tree.',
    '',
    'These are facts about where you are standing, not a request. Do not act on them, do not summarise anything, and do not say anything until the operator asks you a question.',
    '',
    'Precedence: this block is authored by Harnu, not by the operator. It is the authority on where this session is standing and on what it may do. Operator-authored text elsewhere in this system prompt is separate from it, does not amend it, and does not grant write access; where the two conflict, this block wins.',
    CORRECTIVE_CLOSE
  )
  return lines.join('\n')
}

/**
 * The companion's effective `--append-system-prompt`: the operator's own append
 * (fenced and attributed, never merged into the corrective) followed by the
 * corrective (LAST, so it is closest to the model's recent context).
 *
 * The operator's value is never discarded — dropping it would be a silent
 * override of a setting they made — but it is also never allowed to read as
 * Harnu's voice, which is what an undelimited concatenation would do.
 */
export function composeCompanionAppend(
  operatorAppend: string | undefined,
  corrective: ReviewCorrective
): string {
  const parts: string[] = []
  const own = operatorAppend?.trim()
  if (own) parts.push(`${OPERATOR_OPEN}\n${own}\n${OPERATOR_CLOSE}`)
  parts.push(composeReviewCorrective(corrective))
  return parts.join(ACCUMULATE_SEP)
}

/**
 * Put the corrective on an already-read-only config, ready for
 * `buildClaudeArgs`. Pure; never mutates its input.
 *
 * Applied AFTER `forceReadOnlyPermission` at the single spawn site in `pty.ts`,
 * so the read-only shape is fixed before the corrective describes it.
 */
export function withReviewCorrective(
  cfg: ClaudeBootConfig,
  corrective: ReviewCorrective
): ClaudeBootConfig {
  return { ...cfg, appendSystemPrompt: composeCompanionAppend(cfg.appendSystemPrompt, corrective) }
}
