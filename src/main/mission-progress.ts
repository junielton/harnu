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

export type StepState =
  | 'verified'
  | 'done'
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'todo'
  // Campaign spec §3.2 — an open `blocks` edge (or an undecided decision) holds it back.
  | 'locked'

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
  /**
   * Campaign spec §3.2 — the Side bucket: `required: false` steps, outside `total`,
   * `current` and `leftBehind`. Absent when the mission has none, so a mission that
   * uses no side step keeps the exact v3 shape.
   */
  side?: {
    count: number
    steps: { id: string; state: StepState; discoveredFrom: string | null }[]
  }
  computedAt: string
}

/** §3.1 step state, first match wins. */
function stepState(step: MissionStep, sig: StepSignalsLite | undefined, owner: string): StepState {
  const by = step.verifiedBy
  // Campaign spec §3.2: a decision the operator has made is a finished step — the
  // choice is its whole deliverable (only the Choose door writes `chosen`).
  if (step.decision?.chosen !== undefined) return 'done'
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

/** A required step (the default) counts in the headline; `required: false` is a side step. */
const isRequired = (s: MissionStep): boolean => s.required !== false

/**
 * Campaign spec §3.2 — which steps read `locked`: the target of a `blocks` edge whose
 * source is not done, or a member of an undecided decision's `blocks`. Only a step that
 * has not started (`todo`/`waiting`) is locked — a done, running or blocked step keeps
 * what actually happened. `base` is every step's state before locking, so a chain of
 * locks resolves from facts and never from other locks.
 */
function lockedIds(
  steps: readonly MissionStep[],
  base: ReadonlyMap<string, StepState>
): Set<string> {
  const locked = new Set<string>()
  for (const s of steps) {
    const sourceOpen = !isDone(base.get(s.id) ?? 'todo')
    for (const e of s.edges ?? []) if (e.kind === 'blocks' && sourceOpen) locked.add(e.to)
    if (s.decision && s.decision.chosen === undefined)
      for (const to of s.decision.blocks) locked.add(to)
  }
  return new Set(
    [...locked].filter((id) => {
      const state = base.get(id)
      return state === 'todo' || state === 'waiting'
    })
  )
}

export function computeProgress(
  mission: Pick<Mission, 'steps' | 'owner'>,
  signals: readonly StepSignalsLite[],
  now: number
): MissionProgress {
  const sig = new Map(signals.map((s) => [s.stepId, s]))
  const all = progressSteps(mission)
  const base = new Map(
    all.map((s) => [s.id, stepState(s, sig.get(s.id), mission.owner.sessionId)] as const)
  )
  const locked = lockedIds(all, base)
  const stateOf = new Map(
    all.map((s) => [s.id, locked.has(s.id) ? 'locked' : base.get(s.id)!] as const)
  )
  const steps = all.filter(isRequired)
  const sideSteps = all.filter((s) => !isRequired(s))
  const st = steps.map((s) => stateOf.get(s.id)!)
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
      // A locked step never takes the marker (Campaign spec §3.2).
      const open = (s: StepState): boolean => !isDone(s) && s !== 'locked'
      let i = st.findIndex((s, k) => k > lastDone && open(s))
      if (i === -1) i = st.some(open) ? steps.length - 1 : Math.max(lastDone, 0)
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
    // Side steps are listed too: the rail draws their glyph from the same map.
    states: Object.fromEntries(all.map((s) => [s.id, stateOf.get(s.id)!])),
    leftBehind,
    unprovable,
    ...(sideSteps.length > 0
      ? {
          side: {
            count: sideSteps.length,
            steps: sideSteps.map((s) => ({
              id: s.id,
              state: stateOf.get(s.id)!,
              discoveredFrom: s.discoveredFrom ?? null
            }))
          }
        }
      : {}),
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
