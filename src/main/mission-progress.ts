/**
 * Mission v3 §3.1 — the ONE progress computation. Pure; every surface (the pill,
 * the sidebar chip, `mission_get`, `mission_list`, the skills) renders its output
 * and never recounts (spec G3).
 *
 * Progress is POSITION, not proof: N is where the work is now, and a step's proof
 * is a detail beside it. A legacy fixed start ("Scope confirmed") is not a step
 * any more — scope is an attachment (§3.3) — so it is excluded here.
 */
import type { Mission, MissionStep } from './mission-core'
import type { MissionChildState } from './mcp/fleet-snapshot'

export type StepState = 'verified' | 'done' | 'running' | 'waiting' | 'blocked' | 'todo'

/** What {@link computeProgress} needs from the live derive, per step. */
export interface StepSignalsLite {
  stepId: string
  children: Pick<MissionChildState, 'sessionId' | 'taskState'>[]
  /** An existence-level step proven by its links right now. */
  existenceProven: boolean
}

export interface MissionProgress {
  /** Steps, excluding a legacy fixed start. */
  total: number
  /** 1-based; `from === to` unless several steps run in parallel; `null` = all done. */
  current: { from: number; to: number } | null
  allDone: boolean
  /** verified + done. */
  done: number
  verified: number
  states: Record<string, StepState>
  /** `todo` steps before the last done one (step ids). */
  leftBehind: string[]
  /** Reached or current existence steps with no link that can resolve (§3.9). */
  unprovable: string[]
  computedAt: string
}

/** §3.1 step state, first match wins. */
function stepState(step: MissionStep, sig: StepSignalsLite | undefined, owner: string): StepState {
  const by = step.verifiedBy
  // A `needs-human` verdict: the machine part is met and the human part became a
  // check (§3.6), so the step is done — even when the verifier's label says
  // `verified`. A later `met` verdict replaces it.
  if (by?.verdict === 'needs-human') return 'done'
  // A human step the operator ticked is `proof: 'verified'` with the operator as
  // verifier (`applyOperatorVerifyStep`), so the first clause covers it.
  if (
    step.proof === 'verified' ||
    (step.verification === 'existence' && sig?.existenceProven === true)
  )
    return 'verified'
  if (step.proof === 'claimed' || (step.proof === 'self-verified' && by?.verdict === 'met'))
    return 'done'
  // The owner is never a builder: its own link on a step does not make it run.
  const builders = (sig?.children ?? []).filter((c) => c.sessionId !== owner)
  if (builders.some((c) => c.taskState === 'working')) return 'running'
  if (step.blockers.length > 0) return 'blocked'
  if (builders.length > 0) return 'waiting'
  return 'todo'
}

const isDone = (s: StepState): boolean => s === 'verified' || s === 'done'

/** The steps progress counts: every step but a legacy fixed start (§3.3). */
export function progressSteps(mission: Pick<Mission, 'steps'>): MissionStep[] {
  return mission.steps.filter((s) => s.kind !== 'fixed-start')
}

export function computeProgress(
  mission: Pick<Mission, 'steps' | 'owner'>,
  signals: readonly StepSignalsLite[],
  now: number
): MissionProgress {
  const sig = new Map(signals.map((s) => [s.stepId, s]))
  const steps = progressSteps(mission)
  const st = steps.map((s) => stepState(s, sig.get(s.id), mission.owner.sessionId))
  const lastDone = st.map(isDone).lastIndexOf(true)
  const lastDoneAt = lastDone >= 0 ? Date.parse(steps[lastDone].verifiedBy?.at ?? '') : NaN
  const running = st.flatMap((s, i) => (s === 'running' ? [i] : []))
  const allDone = steps.length > 0 && st.every(isDone)
  let current: MissionProgress['current'] = null
  // No steps to count (an empty plan, or only a legacy fixed start): there is no
  // "current" step — never "Step 0 of 0".
  if (!allDone && steps.length > 0) {
    if (running.length > 0) {
      current = { from: running[0] + 1, to: running[running.length - 1] + 1 }
    } else {
      // The first open step after the last done one; when every step after it is
      // done but an earlier one is open, the last step (no ✓). A blocked step
      // later on never pulls the marker forward.
      let i = st.findIndex((s, k) => k > lastDone && !isDone(s))
      if (i === -1) i = steps.length - 1
      current = { from: i + 1, to: i + 1 }
    }
  }
  const leftBehind = steps
    .filter((s, i) => {
      if (i >= lastDone || st[i] !== 'todo') return false
      // A step added after the later step was reached is new work, not abandoned.
      const added = Date.parse(s.addedAt ?? '')
      return !(Number.isFinite(added) && Number.isFinite(lastDoneAt) && added > lastDoneAt)
    })
    .map((s) => s.id)
  const reachedOrCurrent = (i: number): boolean => i <= Math.max(lastDone, (current?.to ?? 0) - 1)
  const unprovable = steps
    .filter(
      (s, i) =>
        s.verification === 'existence' &&
        st[i] !== 'verified' &&
        reachedOrCurrent(i) &&
        !s.links.some((l) => l.kind !== 'session')
    )
    .map((s) => s.id)
  return {
    total: steps.length,
    current,
    allDone,
    done: st.filter(isDone).length,
    verified: st.filter((s) => s === 'verified').length,
    states: Object.fromEntries(steps.map((s, i) => [s.id, st[i]])),
    leftBehind,
    unprovable,
    computedAt: new Date(now).toISOString()
  }
}

/** The headline every surface prints: "Step N of M", "Steps a–b of M", "Step M of M ✓", or nothing (`empty`). */
export function progressHeadline(p: MissionProgress): {
  kind: 'single' | 'range' | 'done' | 'empty'
  n: number
  to: number
  m: number
} {
  // `empty`: nothing to count (total 0) — surfaces must not print "Step 0 of 0".
  if (p.total === 0) return { kind: 'empty', n: 0, to: 0, m: 0 }
  if (p.allDone || !p.current) return { kind: 'done', n: p.total, to: p.total, m: p.total }
  return {
    kind: p.current.from === p.current.to ? 'single' : 'range',
    n: p.current.from,
    to: p.current.to,
    m: p.total
  }
}
