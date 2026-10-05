/**
 * Mission progress view model (T370; Mission v3 S3 — design.md §6 "Mission
 * progress"). One pure derivation from a `mission:list` view to everything the
 * three surfaces render — the Topbar pill, the popover's step rail, the
 * sidebar chip — so they can never disagree.
 *
 * It RENDERS the server's `progress` (Mission v3 §3.1, computed once in
 * `src/main/mission-progress.ts`) and never recounts: which step is done, which
 * one is current and which are left behind all come from `view.progress`. The
 * headline is the server's own `progressHeadline`. What is left here is
 * presentation — the tone, the step visuals, where a child session's row sits.
 */
import type { MissionView } from '../../../main/mission-ipc'
import { progressHeadline, type StepState } from '../../../main/mission-progress'
import type { MissionChildState } from '../../../main/mcp/fleet-snapshot'
import type { Blocker, Check, MissionStep } from '../../../main/mission-core'

/**
 * `verifiedBy.sessionId` on a step the operator ticked from the UI — mirrors
 * `OPERATOR_VERIFIER` in `mission-core.ts` (tests/mission-view.test.ts pins the
 * two equal).
 */
export const OPERATOR_VERIFIER_ID = 'operator'

/** The popover's in-mission states. `no-mission` is "no view"; there is no draft (Mission v3 §3.4). */
export type MissionState =
  'active' | 'blocked' | 'needs-you' | 'stale' | 'total-changed' | 'rescope-pending' | 'delivered'

/** The pill's looks; `neutral` stays in the anatomy but no state maps to it since draft went away. */
export type PillTone = 'neutral' | 'accent' | 'warning' | 'success'

/** The seven step visuals (Mission v3 §3.2): the server's six step states plus left behind. */
export type StepVisual = StepState | 'left-behind'

export type YouLook = 'clear' | 'warning' | 'success'

/** How the operator ends a mission from the end dialog (Mission v3 §3.5). */
export type EndChoice = 'delivered' | 'discarded'

/** The headline every surface prints — the server's `progressHeadline`. */
export type MissionHeadline = ReturnType<typeof progressHeadline>

export interface StepModel {
  step: MissionStep
  /** 1-based position among the counted steps (a legacy fixed start is not one). */
  position: number
  /** The server's state for this step. */
  state: StepState
  visual: StepVisual
  /** The step carries the current marker (`progress.current.from`…`to`). */
  current: boolean
  /** The first current step — where mission-level callouts render. */
  firstCurrent: boolean
  /** The declared end step (`kind: 'fixed-end'`, never found by position). */
  isEnd: boolean
  last: boolean
  /** Blockers rendered under this step — its own, plus the mission's on the first current step. */
  blockers: Blocker[]
  /** The child sessions whose ONE row sits on this step (Mission v3 §3.2). */
  children: MissionChildState[]
  /** Sessions this step links whose row sits on another step — "+N session(s)". */
  elsewhere: number
  /** Proof badge: `claimed` covers `self-verified` too — never "proven". */
  proofBadge: 'claimed' | 'proven' | null
  /** Show the verification-level badge (the current steps). */
  showVerification: boolean
  added: boolean
  rescopePending: boolean
  /** The operator may tick this step (a `human` step). */
  canTick: boolean
  /** The step's human checks (Mission v3 §3.6). */
  checks: Check[]
  /** The step is reached, so its unticked checks are due. */
  checksDue: boolean
}

export interface MissionModel {
  state: MissionState
  tone: PillTone
  headline: MissionHeadline
  /** `progress.total` / `done` / `verified`, verbatim. */
  total: number
  done: number
  verified: number
  /** `progress.leftBehind.length`. */
  leftBehind: number
  steps: StepModel[]
  /** Steps added after creation (they carry `addedReason`). */
  addedCount: number
  youLook: YouLook
  /** The `you` list is non-empty: the operator owes this mission something (pins the sidebar chip). */
  needsYou: boolean
  stale: boolean
  /** ms since the last evidence (null when none parsed) — the stale callout's duration. */
  staleForMs: number | null
}

const TONE: Record<MissionState, PillTone> = {
  active: 'accent',
  'total-changed': 'accent',
  blocked: 'warning',
  'needs-you': 'warning',
  stale: 'warning',
  'rescope-pending': 'warning',
  delivered: 'success'
}

/** Pill tone per state (design.md §6 "Mission progress"). */
export function pillTone(state: MissionState): PillTone {
  return TONE[state]
}

/** The text class of a tone — the pill AND the sidebar chip wear it, so they never disagree. */
export const TONE_TEXT_CLASS: Record<PillTone, string> = {
  neutral: 'text-text-3',
  accent: 'text-accent',
  warning: 'text-warning',
  success: 'text-green'
}

/** The pill's border + text classes per tone (design.md §6 "Topbar pill"). */
export const PILL_TONE_CLASS: Record<PillTone, string> = {
  neutral: `border-border-2 ${TONE_TEXT_CLASS.neutral}`,
  accent: `border-accent ${TONE_TEXT_CLASS.accent}`,
  warning: `border-warning ${TONE_TEXT_CLASS.warning}`,
  success: `border-green ${TONE_TEXT_CLASS.success}`
}

type Translate = (key: string, values: Record<string, unknown>) => string

/**
 * The headline in words: "Step 8 of 9" / "Steps 4–7 of 9" / "Step 9 of 9 ✓", or
 * `''` for an empty mission (never "Step 0 of 0"). `compact` is the sidebar
 * chip's "8/9" form.
 */
export function headlineText(t: Translate, h: MissionHeadline, compact = false): string {
  if (h.kind === 'empty') return ''
  return t(`mission.${compact ? 'chip' : 'headline'}.${h.kind}`, { n: h.n, to: h.to, m: h.m })
}

function openBlockers(view: MissionView): number {
  const m = view.mission
  return m.blockers.length + m.steps.reduce((n, s) => n + s.blockers.length, 0)
}

/**
 * First match wins (design.md §6 "Primary state"). `needs-you` is any owed item
 * but the re-scope (its own state) and the requested close (the delivered
 * state's own item). A legacy `draft` status is read like `active` — the
 * server already normalizes it (Mission v3 §3.4).
 */
export function missionState(view: MissionView): MissionState {
  const m = view.mission
  if (m.pendingRescope) return 'rescope-pending'
  if (view.you.some((y) => y.kind !== 'rescope' && y.kind !== 'close')) return 'needs-you'
  if (openBlockers(view) > 0) return 'blocked'
  if (view.derived.stale) return 'stale'
  if (m.status === 'delivered') return 'delivered'
  if (m.steps.some((s) => s.addedReason)) return 'total-changed'
  return 'active'
}

/**
 * The `you` block's look. A requested close reads **success** only while the
 * server has nothing to warn about; otherwise the operator sees a warning.
 */
export function youLook(view: MissionView): YouLook {
  const first = view.you[0]
  if (!first) return 'clear'
  if (first.kind === 'close' && view.closeWarnings.length === 0) return 'success'
  return 'warning'
}

/** A step is reached — its unticked checks are due (Mission v3 §3.6). */
const REACHED: ReadonlySet<StepState> = new Set(['done', 'verified', 'running', 'waiting'])

/**
 * Where each linked session's ONE row sits (Mission v3 §3.2): the first step it
 * is running on, else the last step that links it.
 */
function childHomes(
  ids: readonly string[],
  childrenOf: (stepId: string) => MissionChildState[]
): Map<string, string> {
  const home = new Map<string, string>()
  const running = new Map<string, string>()
  for (const id of ids) {
    for (const c of childrenOf(id)) {
      home.set(c.sessionId, id) // later steps overwrite: the last linked step
      if (c.taskState === 'working' && !running.has(c.sessionId)) running.set(c.sessionId, id)
    }
  }
  for (const [session, id] of running) home.set(session, id)
  return home
}

export function buildMissionModel(view: MissionView, now: number = Date.now()): MissionModel {
  const m = view.mission
  const p = view.progress
  const state = missionState(view)
  // The rail is exactly the steps the server counted. A legacy fixed start is
  // scope (Mission v3 §3.3), so it is absent from `progress.states`.
  const counted = m.steps.filter((s) => p.states[s.id] !== undefined)
  const derivedOf = (id: string): MissionChildState[] =>
    view.derived.steps.find((d) => d.stepId === id)?.children ?? []
  const homes = childHomes(
    counted.map((s) => s.id),
    derivedOf
  )
  const firstCurrentPos = p.current?.from ?? null
  // With no current step (all done), mission-level blockers sit on the last step.
  const blockerPos = firstCurrentPos ?? counted.length

  const steps = counted.map((step, i): StepModel => {
    const position = i + 1
    const st = p.states[step.id]
    const current = p.current !== null && position >= p.current.from && position <= p.current.to
    const linked = derivedOf(step.id)
    const children = linked.filter((c) => homes.get(c.sessionId) === step.id)
    const isEnd = step.kind === 'fixed-end'
    let proofBadge: StepModel['proofBadge'] = null
    if (step.proof === 'verified' && step.verification !== 'existence') proofBadge = 'proven'
    else if (step.proof === 'claimed' || step.proof === 'self-verified') proofBadge = 'claimed'
    return {
      step,
      position,
      state: st,
      visual: p.leftBehind.includes(step.id) ? 'left-behind' : st,
      current,
      firstCurrent: position === firstCurrentPos,
      isEnd,
      last: i === counted.length - 1,
      blockers: position === blockerPos ? [...m.blockers, ...step.blockers] : step.blockers,
      children,
      elsewhere: new Set(linked.map((c) => c.sessionId)).size - children.length,
      // The badges sit on the current steps and the end step.
      proofBadge: current || isEnd ? proofBadge : null,
      showVerification: current,
      added: !!step.addedReason,
      rescopePending: isEnd && !!m.pendingRescope,
      canTick: step.verification === 'human',
      checks: step.checks ?? [],
      checksDue: REACHED.has(st)
    }
  })

  const lastEvidence = view.derived.stall.lastEvidenceAt
  const staleForMs = lastEvidence ? Math.max(0, now - Date.parse(lastEvidence)) : null
  return {
    state,
    tone: pillTone(state),
    headline: progressHeadline(p),
    total: p.total,
    done: p.done,
    verified: p.verified,
    leftBehind: p.leftBehind.length,
    steps,
    addedCount: m.steps.filter((s) => s.addedReason).length,
    youLook: youLook(view),
    needsYou: view.you.length > 0,
    stale: view.derived.stale,
    staleForMs
  }
}

/**
 * The mission a session owns — the newest non-closed one whose owner is that
 * session, the same rule `mission_get`'s `ownerSessionId` form applies.
 * `views` arrive newest-first and closed missions are already left out.
 */
export function missionForSession(
  views: readonly MissionView[],
  sessionId: string | null | undefined
): MissionView | null {
  if (!sessionId) return null
  return views.find((v) => v.mission.owner.sessionId === sessionId) ?? null
}

/** `2h 15m` / `45m` / `3d 4h` — the stale callout's duration. */
export function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ${min % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** One line under an end-dialog warning: a step TITLE, plus a label (check text / blocker reason). */
export interface EndWarningItem {
  step: string
  label?: string
}

/**
 * What the end dialog prints for one of the server's `closeWarnings`. The server
 * decides WHICH warnings apply (`kind`); the lines come from the view's own
 * structured data so the operator reads step titles — never the step ids and
 * "(s)" plurals baked into the server's `detail` prose.
 */
export interface EndWarning {
  kind: MissionView['closeWarnings'][number]['kind']
  /** How many matters the warning covers — drives the i18n plural. */
  count: number
  items: EndWarningItem[]
}

export function endWarnings(view: MissionView): EndWarning[] {
  const m = view.mission
  const titleOf = (id: string): string => m.steps.find((s) => s.id === id)?.title || id
  return view.closeWarnings.map((w): EndWarning => {
    switch (w.kind) {
      case 'end-unverified': {
        const end = m.steps.find((s) => s.kind === 'fixed-end')
        return { kind: w.kind, count: 1, items: end ? [{ step: titleOf(end.id) }] : [] }
      }
      case 'left-behind': {
        const items = view.progress.leftBehind.map((id) => ({ step: titleOf(id) }))
        return { kind: w.kind, count: items.length, items }
      }
      case 'checks-open': {
        const items = m.steps.flatMap((s) =>
          (s.checks ?? [])
            .filter((c) => !c.ticked)
            .map((c) => ({ step: titleOf(s.id), label: c.label }))
        )
        return { kind: w.kind, count: items.length, items }
      }
      case 'blockers-open': {
        const items: EndWarningItem[] = [
          ...m.blockers.map((b) => ({ step: view.title, label: b.reason })),
          ...m.steps.flatMap((s) =>
            s.blockers.map((b) => ({ step: titleOf(s.id), label: b.reason }))
          )
        ]
        return { kind: w.kind, count: items.length, items }
      }
      case 'rescope-staged':
        return {
          kind: w.kind,
          count: 1,
          items: m.pendingRescope ? [{ step: m.pendingRescope.target }] : []
        }
    }
  })
}
