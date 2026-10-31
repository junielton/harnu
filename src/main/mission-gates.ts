/**
 * Campaign spec §3.2 — a step's derived `gates`: the facts that prove it done,
 * computed on every read and NEVER stored. Pure; the caller supplies the facts
 * (the linked PR, its head CI, the CI of its merge commit on the default branch).
 *
 * A gate is a fact about the world, not a verdict: `green` and `red` are read from
 * GitHub or the step's proof, `running` is "waiting on something", `off` is "no
 * signal yet" and `na` is "does not apply to this step".
 */
import type { MissionStep } from './mission-core'

export type GateState = 'green' | 'red' | 'running' | 'off' | 'na'

export const GATE_NAMES = ['pr', 'ci', 'main', 'verifier', 'checks'] as const
export type GateName = (typeof GATE_NAMES)[number]

/** The five gates of one step. `stale` marks facts that are last-known, not live. */
export type StepGates = Record<GateName, GateState> & { stale?: true }

/** CI as `pr-stack-core` reports it (`unknown` also covers a PR with no checks at all). */
export type GateCi = 'passing' | 'failing' | 'pending' | 'unknown'

/** The step's PR as the gates read it. */
export interface GatePrFacts {
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  /** CI of the PR head. */
  ci: GateCi
}

export interface GateInput {
  step: Pick<MissionStep, 'verification' | 'proof' | 'verifiedBy' | 'checks'>
  /** `null` = the step has no PR link that resolved. */
  pr: GatePrFacts | null
  /** CI of the merge commit on the default branch; `null` = not known (yet). */
  mainCi: GateCi | null
  /** Any of the facts above came from the sticky last-known cache. */
  stale?: boolean
}

/** One workflow run as `gh run list --json status,conclusion` reports it. */
export interface CiRun {
  status?: string
  conclusion?: string
}

const RUN_FAIL = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'startup_failure',
  'action_required'
])
const RUN_PASS = new Set(['success', 'neutral', 'skipped'])

/**
 * CI of one commit from its workflow runs: any failing run wins, then any run still
 * going, then all-success. No runs at all is `unknown` — a commit nothing ran on is
 * not a green one.
 */
export function ciOfRuns(runs: readonly CiRun[]): GateCi {
  if (runs.length === 0) return 'unknown'
  let pending = false
  for (const r of runs) {
    const status = (r.status ?? '').toLowerCase()
    const conclusion = (r.conclusion ?? '').toLowerCase()
    if (status && status !== 'completed') pending = true
    else if (RUN_FAIL.has(conclusion)) return 'failing'
    else if (!RUN_PASS.has(conclusion)) pending = true
  }
  return pending ? 'pending' : 'passing'
}

function fromCi(ci: GateCi | null | undefined): GateState {
  if (ci === 'passing') return 'green'
  if (ci === 'failing') return 'red'
  if (ci === 'pending') return 'running'
  return 'off'
}

function verifierGate(step: GateInput['step']): GateState {
  if (step.verification === 'existence') return 'na'
  const verdict = step.verifiedBy?.verdict
  if (verdict === 'unmet' || verdict === 'blocked') return 'red'
  if (step.proof === 'verified' && verdict !== 'needs-human') return 'green'
  if (step.verification === 'human') return 'off'
  // A claim, a self-verification or a verdict that left a human part: waiting on a verifier.
  if (step.proof === 'unproven' && verdict !== 'needs-human') return 'off'
  return 'running'
}

function checksGate(step: GateInput['step']): GateState {
  const checks = step.checks ?? []
  if (checks.length === 0) return 'na'
  return checks.every((c) => c.ticked) ? 'green' : 'running'
}

export function computeStepGates({ step, pr, mainCi, stale }: GateInput): StepGates {
  const gates: StepGates = {
    pr:
      pr === null
        ? 'off'
        : pr.state === 'MERGED'
          ? 'green'
          : pr.state === 'OPEN'
            ? 'running'
            : 'red',
    ci: pr === null ? 'off' : fromCi(pr.ci),
    main:
      pr === null
        ? 'off'
        : pr.state === 'MERGED'
          ? fromCi(mainCi)
          : pr.state === 'OPEN'
            ? 'off'
            : 'na',
    verifier: verifierGate(step),
    checks: checksGate(step)
  }
  if (stale) gates.stale = true
  return gates
}
