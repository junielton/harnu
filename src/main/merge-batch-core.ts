/**
 * Campaign ch.5b (T609, spec §4) — Merge batch: the operator confirms "merge #A → #B → #C in
 * order"; Harnu merges ONE, lets the steward run `rebase_stack` and re-check the gates, STOPS on any
 * red and asks again for the rest.
 *
 * This is the pure sequencer (ADR-0001): `gh` (reading a PR, merging it) and the steward's turn are
 * injected, so the ordering rules are tested with a fake GitHub and a fake clock. The env-bound half
 * is `merge-batch-ipc.ts`. No MCP verb reaches either: merging is the operator's door.
 */

import { checkState, worstCi } from './pr-stack-core'

/** What the sequencer needs to know about one PR, read fresh each time. */
export interface BatchPrFacts {
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  /** CI of the PR head. `unknown` also covers "no checks at all". */
  ci: 'passing' | 'failing' | 'pending' | 'unknown'
  draft: boolean
}

/** What the steward did between two merges: ran its tick, was skipped (paused / absent / coalesced), or ran out of time. */
export type StewardTurn = 'ran' | 'skipped' | 'timeout'

export interface MergeBatchDeps {
  /** The PR's facts now; `null` for a number that is not a PR of this repo. */
  readPr(pr: number): Promise<BatchPrFacts | null>
  merge(pr: number): Promise<{ ok: true } | { ok: false; error: string }>
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

/** One PR's verdict for the batch; `pending` and `not-ready` differ only in whether waiting helps. */
function verdictOf(facts: BatchPrFacts | null): Verdict {
  if (!facts || facts.state !== 'OPEN') return 'closed'
  if (facts.ci === 'failing') return 'red'
  if (facts.draft) return 'not-ready'
  if (facts.ci === 'pending') return 'pending'
  if (facts.ci === 'unknown') return 'not-ready'
  return 'ok'
}

const DETAIL: Record<Exclude<Verdict, 'ok' | 'merge-failed'>, string> = {
  closed: 'is not open any more',
  red: 'has failing checks',
  'not-ready': 'is not ready (a draft, or no passing checks yet)',
  pending: 'still has checks running'
}

/** Worst first: a closed or red PR stops the batch even if another one is merely pending. */
const PRIORITY: Verdict[] = ['closed', 'red', 'not-ready', 'pending']

async function scan(
  prs: readonly number[],
  deps: MergeBatchDeps
): Promise<{ at: number; verdict: Exclude<Verdict, 'ok' | 'merge-failed'> } | null> {
  const verdicts: Array<{ at: number; verdict: Verdict }> = []
  for (const pr of prs) verdicts.push({ at: pr, verdict: verdictOf(await deps.readPr(pr)) })
  for (const p of PRIORITY) {
    const hit = verdicts.find((v) => v.verdict === p)
    if (hit) return { at: hit.at, verdict: p as Exclude<Verdict, 'ok' | 'merge-failed'> }
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

  // Up front, ALL of them: nothing is merged unless the whole batch is ready to go.
  const first = await scan(prs, deps)
  if (first) {
    // Before the first merge, waiting is not on offer: a PR still running its checks is simply not ready.
    const reason = first.verdict === 'pending' ? 'not-ready' : first.verdict
    return stop(first.at, reason, `#${first.at} ${DETAIL[first.verdict]}.`)
  }

  for (let i = 0; i < prs.length; i++) {
    const pr = prs[i]
    const res = await deps.merge(pr)
    if (!res.ok) return stop(pr, 'merge-failed', `#${pr} could not be merged: ${res.error}`)
    merged.push(pr)
    const next = prs.slice(i + 1)
    if (next.length === 0) break

    // The steward's turn: rebase_stack the rest onto the new base and re-check the gates.
    const turn = await deps.afterMerge({ merged: pr, next })
    steward.push(turn.steward)

    // Then every remaining PR must settle green; any red stops here and the rest go back to the operator.
    const deadline = deps.now() + opts.settleTimeoutMs
    for (;;) {
      const seen = await scan(next, deps)
      if (!seen) break
      if (seen.verdict !== 'pending') {
        return stop(
          seen.at,
          seen.verdict,
          `#${seen.at} ${DETAIL[seen.verdict]} after #${pr} merged.`
        )
      }
      if (deps.now() >= deadline) {
        return stop(
          seen.at,
          'pending',
          `#${seen.at} ${DETAIL.pending} — waited after #${pr} merged.`
        )
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
