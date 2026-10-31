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
import type { MissionLinkSignal } from '../../../main/mcp/tool-handlers'
import type { Blocker, Check, MissionStep } from '../../../main/mission-core'
import type { GateState, StepGates } from '../../../main/mission-gates'
import { owedKeys } from './mission-cue'

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

/**
 * T547 — activity older than this reads as quiet ("no activity for …"). The
 * mission-level Stale callout keeps its own, longer, server-side hour.
 */
export const PULSE_QUIET_AFTER_MS = 15 * 60_000

/** The sign of movement inside a current step (design.md §6 "Step pulse"). */
export interface StepPulseModel {
  /** `moving`: fresh activity or a working child. `quiet`: neither — the step reads stalled. */
  kind: 'moving' | 'quiet'
  /** Commits landed on the step's linked worktrees; `null` when none could be counted. */
  commits: number | null
  /** ms since the newest sign of life as of the view's refresh; `null` when none was ever seen. */
  ageMs: number | null
}

/** One PR a step shows (open or merged), with the CI state `gh` reported. */
export interface StepPrModel {
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  draft: boolean
  ci: 'passing' | 'failing' | 'pending' | 'unknown'
  url: string
}

export interface StepModel {
  step: MissionStep
  /** 1-based position among the counted steps (a legacy fixed start is not one). */
  position: number
  /** The server's state for this step. */
  state: StepState
  visual: StepVisual
  /** The step carries the current marker (`progress.current.from`…`to`). */
  current: boolean
  /** Rail letter (A, B, C… by position); `null` for the end step and past Z. Side origins name it. */
  letter: string | null
  /** Campaign spec §3.2 — the decision node this step is, or `null`. */
  decision: DecisionModel | null
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
  /** T547 — movement inside the step; only the current steps, `null` when there is nothing to watch. */
  pulse: StepPulseModel | null
  /** T547 — the open and merged PRs this step reaches, newest first (at most {@link MAX_STEP_PRS}). */
  prs: StepPrModel[]
  /** Campaign spec §3.2 — the four gate dots, in the order the rail draws them. */
  gates: GateDot[]
  /** The gates are last-known values (GitHub was unreachable), not a live read. */
  gatesStale: boolean
}

/** A decision node as the rail draws it (Campaign spec §3.2, mockup state `decision`). */
export interface DecisionModel {
  title: string
  options: string[]
  /** Index into `options` once the operator chose; `null` until then. */
  chosen: number | null
  /** The rail letters of the steps it locks (a step without a letter is named by its title). */
  blocks: string[]
  /** The operator may still choose: nothing was chosen yet. */
  canChoose: boolean
}

/** One row of the Side bucket (Campaign spec §3.2, mockup state `side`). */
export interface SideStepModel {
  step: MissionStep
  state: StepState
  /** What it was discovered from: a rail letter, or a side step's title; `null` when it names none. */
  origin: string | null
}

export interface SideBucketModel {
  count: number
  /** Not yet done or verified. */
  open: number
  done: number
  steps: SideStepModel[]
}

/** The gate dots a step shows, left to right; the `checks` gate has no dot (it is the checkboxes). */
export const GATE_DOT_NAMES = ['pr', 'ci', 'main', 'verifier'] as const
export type GateDotName = (typeof GATE_DOT_NAMES)[number]

export interface GateDot {
  name: GateDotName
  state: GateState
}

/** The server's gates as dots. A derive that predates gates reads as four off dots. */
function gateDots(gates: Partial<StepGates> | undefined): GateDot[] {
  return GATE_DOT_NAMES.map((name) => ({ name, state: gates?.[name] ?? 'off' }))
}

const MAX_STEP_PRS = 3

const CI_STATES: ReadonlySet<string> = new Set(['passing', 'failing', 'pending'])

/** The PRs a step's links reach, deduped by number, open/merged only. */
function stepPrs(links: readonly MissionLinkSignal[]): StepPrModel[] {
  const out = new Map<number, StepPrModel>()
  const add = (m: StepPrModel): void => {
    if (m.state === 'CLOSED') return
    const prev = out.get(m.number)
    // The same PR through a worktree/card carries CI; a bare `pr` link does not.
    if (!prev || (prev.ci === 'unknown' && m.ci !== 'unknown')) out.set(m.number, m)
  }
  for (const l of links) {
    if (l.kind === 'pr') {
      if (l.number !== null && l.exists && l.state)
        add({ number: l.number, state: l.state, draft: false, ci: 'unknown', url: l.url ?? '' })
      continue
    }
    for (const p of l.prs)
      add({
        number: p.number,
        state: p.state,
        draft: p.isDraft,
        ci: CI_STATES.has(p.ci) ? (p.ci as StepPrModel['ci']) : 'unknown',
        url: p.url
      })
  }
  return [...out.values()].sort((a, b) => b.number - a.number).slice(0, MAX_STEP_PRS)
}

/** The step's pulse — `null` when it links neither a session nor a worktree (nothing to watch). */
function stepPulse(
  view: MissionView,
  stepId: string,
  linked: readonly MissionChildState[],
  now: number
): StepPulseModel | null {
  const d = view.derived.steps.find((x) => x.stepId === stepId)
  if (!d || (linked.length === 0 && !d.links.some((l) => l.kind === 'worktree'))) return null
  const at = d.pulse.lastActivityAt ? Date.parse(d.pulse.lastActivityAt) : NaN
  const ageMs = Number.isFinite(at) ? Math.max(0, now - at) : null
  const working = linked.some((c) => c.taskState === 'working')
  return {
    kind: working || (ageMs !== null && ageMs <= PULSE_QUIET_AFTER_MS) ? 'moving' : 'quiet',
    commits: d.pulse.commits,
    ageMs
  }
}

/** A piece of the pulse line; the component maps `key` to `mission.pulse.<key>`. */
export type PulsePart =
  | { key: 'commits'; n: number }
  | { key: 'active' | 'quiet'; age: string }
  | { key: 'activeNow' | 'quietNever' }

type PluralTranslate = (key: string, named: Record<string, unknown>, plural?: number) => string

/** The pulse line as one string — "21 commits · active 2m ago" — for the rail and the pill tooltip. */
export function pulseText(t: PluralTranslate, p: StepPulseModel): string {
  return pulseParts(p)
    .map((part) =>
      part.key === 'commits'
        ? t('mission.pulse.commits', { n: part.n }, part.n)
        : t(`mission.pulse.${part.key}`, 'age' in part ? { age: part.age } : {})
    )
    .join(' · ')
}

/** What the pulse line prints, in order: commits, then activity (design.md §6 "Step pulse"). */
export function pulseParts(p: StepPulseModel): PulsePart[] {
  const parts: PulsePart[] = []
  if (p.commits !== null && p.commits > 0) parts.push({ key: 'commits', n: p.commits })
  if (p.ageMs === null) {
    if (p.kind === 'quiet') parts.push({ key: 'quietNever' })
  } else if (p.kind === 'moving') {
    parts.push(
      p.ageMs < 60_000 ? { key: 'activeNow' } : { key: 'active', age: formatDuration(p.ageMs) }
    )
  } else {
    parts.push({ key: 'quiet', age: formatDuration(p.ageMs) })
  }
  return parts
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
  /** Campaign spec §3.2 — the Side bucket under the main rail (`required: false` steps). */
  side: SideBucketModel
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

/** A step the server counts as finished. */
const isFinished = (st: StepState): boolean => st === 'verified' || st === 'done'

export function buildMissionModel(view: MissionView, now: number = Date.now()): MissionModel {
  const m = view.mission
  const p = view.progress
  const state = missionState(view)
  // The rail is exactly the steps the server counted. A legacy fixed start is
  // scope (Mission v3 §3.3), so it is absent from `progress.states`.
  const inProgress = m.steps.filter((s) => p.states[s.id] !== undefined)
  // Campaign spec §3.2: `required: false` steps live in the Side bucket, never on the rail.
  const counted = inProgress.filter((s) => s.required !== false)
  const sideSteps = inProgress.filter((s) => s.required === false)
  const letterOf = new Map(
    counted.map((s, i) => [
      s.id,
      s.kind !== 'fixed-end' && i < 26 ? String.fromCharCode(65 + i) : null
    ])
  )
  const nameOf = (id: string): string =>
    letterOf.get(id) ?? m.steps.find((s) => s.id === id)?.title ?? id
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
    const derivedStep = view.derived.steps.find((x) => x.stepId === step.id)
    const linked = derivedOf(step.id)
    const children = linked.filter((c) => homes.get(c.sessionId) === step.id)
    const isEnd = step.kind === 'fixed-end'
    let proofBadge: StepModel['proofBadge'] = null
    if (step.proof === 'verified' && step.verification !== 'existence') proofBadge = 'proven'
    else if (step.proof === 'claimed' || step.proof === 'self-verified') proofBadge = 'claimed'
    return {
      step,
      position,
      letter: letterOf.get(step.id) ?? null,
      decision: step.decision
        ? {
            title: step.decision.title,
            options: step.decision.options,
            chosen: step.decision.chosen ?? null,
            blocks: step.decision.blocks.map(nameOf),
            canChoose: step.decision.chosen === undefined
          }
        : null,
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
      checksDue: REACHED.has(st),
      pulse: current ? stepPulse(view, step.id, linked, now) : null,
      prs: stepPrs(derivedStep?.links ?? []),
      gates: gateDots(derivedStep?.gates),
      gatesStale: derivedStep?.gates?.stale === true
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
    side: {
      count: sideSteps.length,
      open: sideSteps.filter((x) => !isFinished(p.states[x.id])).length,
      done: sideSteps.filter((x) => isFinished(p.states[x.id])).length,
      steps: sideSteps.map((x) => ({
        step: x,
        state: p.states[x.id],
        origin: x.discoveredFrom ? nameOf(x.discoveredFrom) : null
      }))
    },
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

/** The review dialog's three groups (BUG-173 S5, spec §3.5). */
export interface ReviewGroups {
  /** `delivered` with a requested close: the owner verified the end and asked. */
  ready: MissionView[]
  /** `active` and every step done, close never requested: nobody verified the end. */
  finished: MissionView[]
  /** Everything else the operator owes — opened one by one, never closed in bulk. */
  other: MissionView[]
}

/**
 * Split the open missions into the review's groups, keeping the input order. The
 * close groups come first and need no owed condition: a delivered mission whose
 * close was requested is `ready`, and an active mission with every step done is
 * `finished` whatever it owes (the finished-but-never-closed backlog is what the
 * bulk close exists to clear). Every other mission is listed only if it owes the
 * operator something (the cue's owed set). A repeated id keeps its first view
 * and a closed mission is never listed.
 */
export function groupReviewMissions(views: readonly MissionView[]): ReviewGroups {
  const out: ReviewGroups = { ready: [], finished: [], other: [] }
  const seen = new Set<string>()
  for (const v of views) {
    if (seen.has(v.mission.id)) continue
    seen.add(v.mission.id)
    const { status } = v.mission
    if (status === 'closed') continue
    if (status === 'delivered' && v.mission.pendingClose) out.ready.push(v)
    else if (status === 'active' && v.progress.allDone) out.finished.push(v)
    else if (owedKeys(v).size > 0) out.other.push(v)
  }
  return out
}

/** A bulk close may touch this mission: it is in the ready or the finished group. */
export function isBulkCloseable(view: MissionView): boolean {
  const m = view.mission
  if (m.status === 'delivered') return !!m.pendingClose
  return m.status === 'active' && view.progress.allDone
}

/** The ids the review pre-selects: the ready group, nothing else. */
export function readyIds(groups: ReviewGroups): string[] {
  return groups.ready.map((v) => v.mission.id)
}

/** The reason every bulk door carries, so a mission's Log shows it was a batch decision. */
export function bulkCloseReason(text?: string): string {
  const why = text?.trim()
  return why ? `bulk close: ${why}` : 'bulk close'
}

const END_WARNING_KEY: Record<EndWarning['kind'], string> = {
  'end-unverified': 'endUnverified',
  'left-behind': 'leftBehind',
  'checks-open': 'checksOpen',
  'blockers-open': 'blockersOpen',
  'rescope-staged': 'rescopeStaged'
}

/** Kinds whose heading counts matters — the i18n plural takes `count`. */
const COUNTED_END_WARNINGS: ReadonlySet<EndWarning['kind']> = new Set([
  'left-behind',
  'checks-open',
  'blockers-open'
])

/** The heading of one end warning, in the `mission.end.warnings.*` copy the End dialog uses. */
export function endWarningHeading(
  t: (key: string, plural?: number) => string,
  w: EndWarning
): string {
  const key = `mission.end.warnings.${END_WARNING_KEY[w.kind]}`
  return COUNTED_END_WARNINGS.has(w.kind) ? t(key, w.count) : t(key)
}
