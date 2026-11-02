/**
 * Campaign ch.5b (T609, spec §4) — Merge batch: the operator confirms "merge #A → #B → #C in
 * order"; Harnu merges ONE, lets the steward run `rebase_stack` and re-check the gates, STOPS on any
 * red and asks again for the rest.
 *
 * This is the pure sequencer (ADR-0001): `gh` (reading a PR, merging it), the steward's turn and the
 * mission's state are injected, so the ordering rules are tested with a fake GitHub and a fake clock.
 * The env-bound half is `merge-batch-ipc.ts`. No MCP verb reaches either: merging is the operator's.
 *
 * What it will not do (Delta 1): merge on stale facts — the PR is re-read right before its own merge
 * and that head sha is the only one merged; merge a PR that does not target the default branch or
 * conflicts; carry on after a steward turn that did not run; or carry on once the mission was closed
 * or its steward paused.
 */

import { checkState, worstCi } from './pr-stack-core'

/** What the sequencer needs to know about one PR, read fresh each time. */
export interface BatchPrFacts {
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  /** CI of the PR head. `unknown` also covers "no checks at all". */
  ci: 'passing' | 'failing' | 'pending' | 'unknown'
  draft: boolean
  /** The branch the PR merges INTO (`baseRefName`). */
  baseRef: string
  /** GitHub's mergeability verdict; `UNKNOWN` while it is still computing. */
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  /** The head commit the gates above were read at (`headRefOid`). */
  headOid: string
}

/** What the steward did between two merges: ran its tick, was skipped (paused / absent / coalesced), or ran out of time. */
export type StewardTurn = 'ran' | 'skipped' | 'timeout'

export type MissionBatchState = 'open' | 'closed' | 'paused'

export interface MergeBatchDeps {
  /** The PR's facts now; `null` for a number that is not a PR of this repo. */
  readPr(pr: number): Promise<BatchPrFacts | null>
  /** The repo's default branch — the only base a batch merges into. */
  defaultBranch(): Promise<string>
  /** The mission's state NOW: a batch stops once it is closed or its steward paused. */
  missionState(): Promise<MissionBatchState>
  /** Merge `pr`, pinned to `headOid` (`--match-head-commit`): a head that moved since the gates were read is refused. */
  merge(pr: number, headOid: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** After `merged` landed: wake the steward (it rebases the rest and re-checks the gates) and wait for its turn. */
  afterMerge(info: { merged: number; next: number[] }): Promise<{ steward: StewardTurn }>
  sleep(ms: number): Promise<void>
  now(): number
}

export type StopReason =
  /** A PR in the list is not (or no longer) open. */
  | 'closed'
  /** A PR's CI is red. */
  | 'red'
  /** Not ready up front: still running, no checks, or a draft. Nothing was merged. */
  | 'not-ready'
  /** The gates had not settled when the wait ran out. */
  | 'pending'
  /** GitHub refused the merge. */
  | 'merge-failed'
  /** The PR does not merge into the default branch (a stacked PR the steward has not retargeted). */
  | 'wrong-base'
  /** GitHub reports the PR conflicts with its base. */
  | 'conflict'
  /** The steward's turn between merges did not run, so the rest were not rebased or re-checked. */
  | 'steward-skipped'
  | 'steward-timeout'
  /** The mission was closed under the batch. */
  | 'mission-closed'
  /** The operator paused the steward under the batch. */
  | 'paused'

export interface MergeBatchOutcome {
  merged: number[]
  /** The PRs still to merge, in order — what the operator is asked about again. */
  remaining: number[]
  stop: { at: number; reason: StopReason; detail: string } | null
  /** One entry per steward turn (between merges). */
  steward: StewardTurn[]
}

export interface MergeBatchOpts {
  /** How long to wait for the remaining PRs' gates to settle after each merge. */
  settleTimeoutMs: number
  pollMs: number
}

type Verdict = 'ok' | StopReason
type Bad = Exclude<Verdict, 'ok' | 'merge-failed'>

/** Where the facts are read: up front, right before a merge, or while waiting after a merge. */
type Phase = 'preflight' | 'merge' | 'wait'

/**
 * One PR's verdict. `checkBase` is whether this PR must already target the default branch: the first PR
 * up front and every PR right before its own merge — a stacked PR may wait on its parent's branch until
 * the steward has retargeted it. After a merge CI `unknown` is "not reported yet" (pending), up front it is
 * "no checks" (not ready).
 */
function verdictOf(
  facts: BatchPrFacts | null,
  base: string,
  phase: Phase,
  checkBase: boolean
): 'ok' | Bad {
  if (!facts || facts.state !== 'OPEN') return 'closed'
  if (facts.ci === 'failing') return 'red'
  if (facts.mergeable === 'CONFLICTING') return 'conflict'
  if (checkBase && facts.baseRef !== base) return 'wrong-base'
  if (facts.draft) return 'not-ready'
  if (facts.ci === 'pending' || (facts.ci === 'unknown' && phase === 'wait')) return 'pending'
  if (facts.ci === 'unknown') return 'not-ready'
  return 'ok'
}

const DETAIL: Record<Bad, string> = {
  closed: 'is not open any more',
  red: 'has failing checks',
  conflict: 'conflicts with its base',
  'wrong-base': 'does not merge into the default branch',
  'not-ready': 'is not ready (a draft, or no passing checks yet)',
  pending: 'still has checks running',
  'steward-skipped': 'was not rebased: the steward did not run',
  'steward-timeout': 'was not rebased: the steward did not finish in time',
  'mission-closed': 'cannot be merged: the mission was closed',
  paused: 'cannot be merged: the steward was paused'
}

/** Worst first: a closed or red PR stops the batch even if another one is merely pending. */
const PRIORITY: Bad[] = ['closed', 'red', 'conflict', 'wrong-base', 'not-ready', 'pending']

async function scan(
  prs: readonly number[],
  deps: MergeBatchDeps,
  base: string,
  phase: Phase,
  /** Which of `prs` must already target the default branch. */
  baseChecked: ReadonlySet<number>
): Promise<{ at: number; verdict: Bad } | null> {
  const verdicts: Array<{ at: number; verdict: 'ok' | Bad }> = []
  for (const pr of prs) {
    verdicts.push({
      at: pr,
      verdict: verdictOf(await deps.readPr(pr), base, phase, baseChecked.has(pr))
    })
  }
  for (const p of PRIORITY) {
    const hit = verdicts.find((v) => v.verdict === p)
    if (hit) return { at: hit.at, verdict: p }
  }
  return null
}

/**
 * Run the batch. Throws BAD_ARGS for a malformed list (empty, a duplicate, not a positive integer);
 * every other outcome — including a stop — is a returned {@link MergeBatchOutcome}.
 */
export async function runMergeBatch(
  prs: readonly number[],
  deps: MergeBatchDeps,
  opts: MergeBatchOpts
): Promise<MergeBatchOutcome> {
  if (prs.length === 0) throw new Error('BAD_ARGS: a merge batch needs at least one PR.')
  if (!prs.every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error('BAD_ARGS: every PR number must be a positive integer.')
  }
  if (new Set(prs).size !== prs.length)
    throw new Error('BAD_ARGS: a PR appears twice in the batch.')

  const merged: number[] = []
  const steward: StewardTurn[] = []
  const stop = (at: number, reason: StopReason, detail: string): MergeBatchOutcome => ({
    merged,
    remaining: prs.filter((n) => !merged.includes(n)),
    stop: { at, reason, detail },
    steward
  })
  const stopBad = (at: number, reason: Bad, extra = ''): MergeBatchOutcome =>
    stop(at, reason, `#${at} ${DETAIL[reason]}${extra}.`)

  const base = await deps.defaultBranch()

  // Up front, ALL of them: nothing is merged unless the whole batch is ready to go. Only the first PR
  // must already target the default branch — a stacked one is retargeted by the steward after its parent.
  const mission = await deps.missionState()
  if (mission !== 'open') {
    return stopBad(prs[0], mission === 'closed' ? 'mission-closed' : 'paused')
  }
  const first = await scan(prs, deps, base, 'preflight', new Set([prs[0]]))
  if (first) {
    // Before the first merge, waiting is not on offer: a PR still running its checks is simply not ready.
    return stopBad(first.at, first.verdict === 'pending' ? 'not-ready' : first.verdict)
  }

  for (let i = 0; i < prs.length; i++) {
    const pr = prs[i]

    // Right before the merge: the mission is still open and unpaused, and the PR is read AGAIN — the
    // facts from the scan above (or from the settle wait) may be minutes old. This read's head sha is
    // the only commit this merge is allowed to land.
    const state = await deps.missionState()
    if (state !== 'open') return stopBad(pr, state === 'closed' ? 'mission-closed' : 'paused')
    const facts = await deps.readPr(pr)
    const verdict = verdictOf(facts, base, 'merge', true)
    if (verdict !== 'ok') return stopBad(pr, verdict, i > 0 ? ` after #${prs[i - 1]} merged` : '')

    const res = await deps.merge(pr, (facts as BatchPrFacts).headOid)
    if (!res.ok) return stop(pr, 'merge-failed', `#${pr} could not be merged: ${res.error}`)
    merged.push(pr)
    const next = prs.slice(i + 1)
    if (next.length === 0) break

    // The steward's turn: rebase_stack the rest onto the new base and re-check the gates. A turn that
    // did not run means the rest were neither rebased nor re-checked: stop and ask.
    const turn = await deps.afterMerge({ merged: pr, next })
    steward.push(turn.steward)
    if (turn.steward !== 'ran') {
      return stopBad(next[0], turn.steward === 'skipped' ? 'steward-skipped' : 'steward-timeout')
    }

    // Then every remaining PR must settle green; any red stops here and the rest go back to the operator.
    const deadline = deps.now() + opts.settleTimeoutMs
    for (;;) {
      const seen = await scan(next, deps, base, 'wait', new Set())
      if (!seen) break
      if (seen.verdict !== 'pending') return stopBad(seen.at, seen.verdict, ` after #${pr} merged`)
      if (deps.now() >= deadline) {
        return stopBad(seen.at, 'pending', ` — waited after #${pr} merged`)
      }
      await deps.sleep(opts.pollMs)
    }
  }
  return { merged, remaining: [], stop: null, steward }
}

/** `gh pr view --json statusCheckRollup` entries → one CI state, by the same rule the PR canvas uses. */
export function ciOfRollup(entries: ReadonlyArray<Record<string, unknown>>): BatchPrFacts['ci'] {
  return worstCi(entries.map((e) => ({ name: '', detail: '', state: checkState(e) })))
}

export interface RepoMergeFlags {
  squashMergeAllowed?: boolean
  mergeCommitAllowed?: boolean
  rebaseMergeAllowed?: boolean
}

/** The `gh pr merge` method flag the repo allows: squash, then merge commit, then rebase. */
export function pickMergeMethod(flags: RepoMergeFlags | null): '--squash' | '--merge' | '--rebase' {
  if (!flags || flags.squashMergeAllowed !== false) return '--squash'
  if (flags.mergeCommitAllowed !== false) return '--merge'
  if (flags.rebaseMergeAllowed !== false) return '--rebase'
  return '--squash'
}
