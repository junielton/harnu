/**
 * Mission v3 S3 — turn an S1 progress fixture (`tests/fixtures/mission-v3/*.json`,
 * `{ name, mission, signals, expect }`) into the `MissionView` the renderer reads.
 * The server no longer derives a v3 view (S-40), so this helper carries its own frozen,
 * test-local port of the v3 arithmetic the fixtures were written against (progress, the
 * five gates, the end warnings): a renderer test that matches `view.progress` proves the
 * renderer shows the numbers it is handed rather than recounting them. Nothing in `src/`
 * computes these any more, and nothing here imports a retired module.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { CloseWarning, MissionView } from '../../src/main/mission-ipc'
import {
  GATE_NAMES,
  type GateName,
  type GateState,
  type Mission,
  type MissionProgress,
  type MissionStep,
  type StepGates,
  type StepLink,
  type StepState
} from '../../src/main/missions/derive'
import type { MissionChildState } from '../../src/main/mcp/fleet-snapshot'
import type { MissionStepSignals } from '../../src/main/missions/derive'

/** What the progress port needs from the live derive, per step. */
export interface StepSignalsLite {
  stepId: string
  children: Pick<MissionChildState, 'sessionId' | 'taskState'>[]
  existenceProven: boolean
  gates?: StepGates
}

// ---- Frozen port of the v3 gates ------------------------------------------------------------

const evidenceBundleDir = (missionId: string, stepId: string): string =>
  `.harnu/evidence/${missionId}/${stepId}`

function hasEvidenceBundle(
  links: readonly StepLink[] | undefined,
  missionId: string,
  stepId: string
): boolean {
  const dir = evidenceBundleDir(missionId, stepId)
  return (links ?? []).some((l) => {
    if (l.kind !== 'worktree') return false
    const ref = l.ref.replace(/\/+$/, '')
    return ref === dir || ref.endsWith(`/${dir}`)
  })
}

type GateStep = Pick<MissionStep, 'verification' | 'proof' | 'verifiedBy' | 'checks'> &
  Partial<Pick<MissionStep, 'id' | 'links'>>

function verifierGate(step: GateStep, missionId: string | undefined): GateState {
  if (step.verification === 'existence') return 'na'
  const verdict = step.verifiedBy?.verdict
  if (verdict === 'unmet' || verdict === 'blocked') return 'red'
  if (step.proof === 'verified') {
    if (step.verification !== 'verifier' || !step.verifiedBy?.evidenceRequired) return 'green'
    return missionId !== undefined &&
      step.id !== undefined &&
      hasEvidenceBundle(step.links, missionId, step.id)
      ? 'green'
      : 'running'
  }
  if (step.verification === 'human') return 'off'
  if (step.proof === 'unproven' && verdict !== 'needs-human') return 'off'
  return 'running'
}

function computeStepGates(step: GateStep, missionId?: string): StepGates {
  const checks = step.checks ?? []
  return {
    pr: 'off',
    ci: 'off',
    main: 'off',
    verifier: verifierGate(step, missionId),
    checks: checks.length === 0 ? 'na' : checks.every((c) => c.ticked) ? 'green' : 'running'
  }
}

// ---- Frozen port of the v3 progress ---------------------------------------------------------

function gatesAllowVerified(step: MissionStep, gates: StepGates | undefined): boolean {
  if (!gates) return true
  return GATE_NAMES.every((name: GateName) => {
    if (name === 'checks' && (step.checks?.length ?? 0) === 0) return true
    return gates[name] !== 'red' && gates[name] !== 'running'
  })
}

function stepState(step: MissionStep, sig: StepSignalsLite | undefined, owner: string): StepState {
  const by = step.verifiedBy
  if (step.decision?.chosen !== undefined) return 'done'
  if (by?.verdict === 'needs-human') return 'done'
  if (step.proof === 'verified') return gatesAllowVerified(step, sig?.gates) ? 'verified' : 'done'
  if (step.verification === 'existence' && sig?.existenceProven === true) return 'verified'
  if (step.proof === 'claimed' || (step.proof === 'self-verified' && by?.verdict === 'met'))
    return 'done'
  const builders = (sig?.children ?? []).filter((c) => c.sessionId !== owner)
  if (builders.some((c) => c.taskState === 'working')) return 'running'
  if (step.blockers.length > 0) return 'blocked'
  if (builders.length > 0) return 'waiting'
  return 'todo'
}

const isDone = (s: StepState): boolean => s === 'verified' || s === 'done'
const isRequired = (s: MissionStep): boolean => s.required !== false

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

function computeProgress(
  mission: Pick<Mission, 'steps' | 'owner'>,
  signals: readonly StepSignalsLite[],
  now: number
): MissionProgress {
  const sig = new Map(signals.map((s) => [s.stepId, s]))
  const all = mission.steps.filter((s) => s.kind !== 'fixed-start')
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
  if (!allDone && steps.length > 0) {
    if (running.length > 0) {
      current = { from: running[0] + 1, to: running[running.length - 1] + 1 }
    } else {
      const open = (s: StepState): boolean => !isDone(s) && s !== 'locked'
      let i = st.findIndex((s, k) => k > lastDone && open(s))
      if (i === -1) i = st.some(open) ? steps.length - 1 : Math.max(lastDone, 0)
      current = { from: i + 1, to: i + 1 }
    }
  }
  const leftBehind = steps
    .filter((s, i) => {
      if (i >= lastDone || st[i] !== 'todo') return false
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

function closeWarnings(mission: Mission, progress: MissionProgress): CloseWarning[] {
  const out: CloseWarning[] = []
  const end = mission.steps.find((s) => s.kind === 'fixed-end')
  if (end?.proof !== 'verified') {
    out.push({
      kind: 'end-unverified',
      detail: `the end (${end?.id ?? 'missing'}) is ${end?.proof ?? 'missing'}, not verified`
    })
  }
  if (progress.leftBehind.length > 0) {
    out.push({
      kind: 'left-behind',
      detail: `${progress.leftBehind.length} step(s) left behind: ${progress.leftBehind.join(', ')}`
    })
  }
  const open = mission.steps.flatMap((s) =>
    (s.checks ?? []).filter((c) => !c.ticked).map((c) => `${s.id}: ${c.label}`)
  )
  if (open.length > 0) {
    out.push({
      kind: 'checks-open',
      detail: `${open.length} unticked check(s) — ${open.join('; ')}`
    })
  }
  const blockers =
    mission.blockers.length + mission.steps.reduce((n, s) => n + s.blockers.length, 0)
  if (blockers > 0) out.push({ kind: 'blockers-open', detail: `${blockers} open blocker(s)` })
  if (mission.pendingRescope) {
    out.push({
      kind: 'rescope-staged',
      detail: `a re-scope is staged: ${mission.pendingRescope.kind} · ${mission.pendingRescope.target}`
    })
  }
  return out
}

export const FIXTURE_NOW = Date.parse('2026-10-01T12:00:00Z')

export const FIXTURE_NAMES = [
  'added-mid-flight',
  'blocked-future',
  'blocked-like',
  'delivered',
  'faq-like',
  'hero-like',
  'needs-human',
  'nothing',
  'owner-only-working',
  'parallel',
  'proven-start',
  'self-verified-all',
  'tools-listing-like'
] as const

export type FixtureName = (typeof FIXTURE_NAMES)[number]

interface Fixture {
  name: string
  mission: Pick<Mission, 'owner' | 'steps'> & Partial<Mission>
  signals: StepSignalsLite[]
}

function loadFixture(name: string): Fixture {
  const file = path.join(__dirname, '..', 'fixtures', 'mission-v3', `${name}.json`)
  return JSON.parse(readFileSync(file, 'utf8')) as Fixture
}

function child(c: StepSignalsLite['children'][number]): MissionChildState {
  return {
    sessionId: c.sessionId,
    known: true,
    folderAlias: 'repo',
    taskState: c.taskState,
    pendingApprovals: 0
  }
}

/**
 * The view `mission:list` would return for a fixture. `over.mission` patches the
 * stored mission BEFORE progress is computed (so the server's numbers follow);
 * `over.view` patches the finished view (e.g. a `you` list).
 */
export function fixtureView(
  name: FixtureName,
  over: {
    mission?: Partial<Mission>
    view?: Partial<MissionView>
    /** T547: patch one step's derived signals (its `pulse`, `links`, `children`). */
    derivedStep?: Record<string, Partial<MissionStepSignals>>
  } = {}
): MissionView {
  const f = loadFixture(name)
  const steps: MissionStep[] = f.mission.steps.map((s, i) => ({
    ...s,
    ordinal: s.ordinal ?? i + 1,
    title: s.title ?? `Build ${s.id}`
  }))
  const mission = {
    id: `mnt-${(name.length * 0x1f1f1f).toString(16).padStart(8, '0').slice(0, 8)}`,
    slug: name,
    folder: '/repo',
    status: 'active',
    declaredEnd: { kind: 'code', target: `${name} shipped`, evidence: 'merged PRs' },
    blockers: [],
    openQuestions: [],
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-10-01T11:50:00.000Z',
    provenance: { author: 'agent', at: '2026-09-30T00:00:00.000Z' },
    ...f.mission,
    ...over.mission,
    steps: over.mission?.steps ?? steps
  } as Mission
  const progress = computeProgress(mission, f.signals, FIXTURE_NOW)
  return {
    root: '/repo',
    mission,
    title: `Mission ${name}`,
    derived: {
      live: true,
      computedAt: progress.computedAt,
      stale: false,
      stall: {
        stale: false,
        lastEvidenceAt: mission.updatedAt,
        thresholdMs: 3_600_000,
        workingSessions: []
      },
      gh: 'not-needed',
      pendingApprovals: 0,
      scope: { links: [], resolved: { proven: false } },
      steps: mission.steps.map((s) => {
        const sig = f.signals.find((x) => x.stepId === s.id)
        return {
          stepId: s.id,
          children: (sig?.children ?? []).map(child),
          links: [],
          existence: s.verification === 'existence' ? { proven: !!sig?.existenceProven } : null,
          pulse: { commits: null, lastCommitAt: null, lastActivityAt: null },
          gates: computeStepGates(s),
          prNumber: null,
          ...over.derivedStep?.[s.id]
        }
      }),
      progress
    },
    you: [],
    progress,
    closeWarnings: closeWarnings(mission, progress),
    ...over.view
  }
}
