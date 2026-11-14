/**
 * Missions v4 · S-17 — what the Mission pane and the Topbar pill read out of the view channel
 * (design.md §6 "Mission pane"). Pure: no store, no `window.api`.
 *
 * The channel answers `{ state: 'mission' | 'none' | 'refused' }` (`mission:v4View`). This module
 * decides what a reply MEANS for one session — a v4 mission to draw, no mission, a refusal, or a v3
 * record the popover still serves — and words the numbers the server already counted. It never recounts:
 * the pill's "4/21 · 3 for you" is `progress.done`, `progress.total` and the length of the waiting list,
 * and the state is the identifier translated through i18n, never the English words in the reply.
 */
import type { MissionV4ViewReply } from '../../../main/mission-ipc'

type Translate = (key: string, values?: Record<string, unknown>, plural?: number) => string

/** The `state: 'mission'` branch of the view's reply. */
export type MissionV4Reply = Extract<MissionV4ViewReply, { state: 'mission' }>

/** What the pane draws: a state of its own, not a gap. */
export type PaneKind = 'loading' | 'mission' | 'none' | 'refused' | 'v3'

/**
 * What a reply means for `sessionId`.
 *
 * - `null` (no answer yet) is `loading`.
 * - A mission the session is not an OPEN row of is `none`: a named read of a record the session left
 *   (a hand-off closed its row) must never show another session's mission here.
 * - A mission the operator closed is `none` too: it leaves the pane and the session shows the
 *   no-mission state.
 * - A v3 record (`source` other than `v4`) is `v3`: the v3 stack serves it, the pane does not draw it.
 */
export function classifyReply(reply: MissionV4ViewReply | null, sessionId: string): PaneKind {
  if (reply === null) return 'loading'
  if (reply.state === 'refused') return 'refused'
  if (reply.state === 'none') return 'none'
  if (!reply.sessions.some((row) => row.id === sessionId && row.open)) return 'none'
  if (reply.detail.status === 'closed') return 'none'
  return reply.source === 'v4' ? 'mission' : 'v3'
}

/** The v4 mission this reply holds for `sessionId`, or `null` (anything else the pane or pill shows). */
export function v4MissionOf(
  reply: MissionV4ViewReply | null,
  sessionId: string
): MissionV4Reply | null {
  return classifyReply(reply, sessionId) === 'mission' ? (reply as MissionV4Reply) : null
}

/** Whether a NAMED read should be dropped and asked again by session: it is neither a v4 nor a v3 mission of it. */
export function isStaleNamedRead(reply: MissionV4ViewReply | null, sessionId: string): boolean {
  const kind = classifyReply(reply, sessionId)
  return kind === 'none' || kind === 'refused'
}

/** The numbers the pill and the pane read, all from the server. */
export interface MissionNumbers {
  done: number
  total: number
  unit: 'milestones' | 'steps'
  /** How many things wait on the operator (the waiting list's length). */
  forYou: number
  readyToClose: boolean
}

export function missionNumbers(detail: MissionV4Reply['detail']): MissionNumbers {
  return {
    done: detail.progress.done,
    total: detail.progress.total,
    unit: detail.progress.unit,
    forYou: detail.waiting.items.length,
    readyToClose: detail.state === 'ready-to-close'
  }
}

/**
 * The pill's label: "4/21 · 3 for you", "4/21" when nothing waits, "21/21 · ready to close" when every
 * step is done. Milestones when the mission has them (`progress.unit` says so; the shape is the same).
 */
export function missionPillText(t: Translate, detail: MissionV4Reply['detail']): string {
  const n = missionNumbers(detail)
  const count = t('missionPane.pill.count', { done: n.done, total: n.total })
  const tail = n.readyToClose
    ? t('missionPane.pill.readyToClose')
    : n.forYou > 0
      ? t('missionPane.pill.forYou', { n: n.forYou })
      : ''
  return tail ? t('missionPane.pill.joined', { count, tail }) : count
}

/** The pill's tone: success when ready to close, warning while something waits on the operator, else accent. */
export type V4PillTone = 'accent' | 'warning' | 'success'

export function missionPillTone(detail: MissionV4Reply['detail']): V4PillTone {
  const n = missionNumbers(detail)
  if (n.readyToClose) return 'success'
  return n.forYou > 0 ? 'warning' : 'accent'
}

/**
 * The pill's classes per tone (design.md §6 "Mission pane" → Topbar pill — v4): the mockup's tinted
 * look — the tone's `-line` border, its `-soft` background and its text — and the `ring-2` of a pressed
 * pill (the pane is open).
 */
export const V4_PILL_TONE_CLASS: Record<V4PillTone, string> = {
  accent: 'border-accent-line bg-accent-soft text-accent',
  warning: 'border-warning-line bg-warning-soft text-warning',
  success: 'border-green-line bg-green-soft text-green'
}

export const V4_PILL_RING_CLASS: Record<V4PillTone, string> = {
  accent: 'ring-2 ring-accent-line',
  warning: 'ring-2 ring-warning-line',
  success: 'ring-2 ring-green-line'
}

/** The count line under the title: "4 of 21 steps done" / "1 of 10 milestones done", from the server's numbers. */
export function missionProgressLine(t: Translate, detail: MissionV4Reply['detail']): string {
  const n = missionNumbers(detail)
  // The unit agrees with the TOTAL ("0 of 1 step done", "4 of 21 steps done"): the plural form follows it.
  return t(
    n.unit === 'milestones' ? 'missionPane.progress.milestones' : 'missionPane.progress.steps',
    { done: n.done, total: n.total },
    n.total
  )
}

/** The state's identifier as the pane shows it: `open` shows nothing, the others are translated by identifier. */
export function missionStateKey(detail: MissionV4Reply['detail']): string | null {
  if (detail.state === 'open') return null
  if (detail.state === 'ready-to-close' || detail.state === 'closed') {
    return `missionPane.state.${detail.state}`
  }
  return null
}

// ---- Missions v4 · S-18 — the glance: the bar, the next step and the tree ---------------------------
//
// Pure like the rest of this module. The tree READS the view: a step's state, a milestone's state, the
// progress and the waiting list are the server's. What it adds is order and fold (which steps show
// first, which fold behind "N more"), not state. It counts steps only by the state the server gave
// them, for the "{done}/{total}" a milestone row carries (the view has no per-milestone total).

type Detail = MissionV4Reply['detail']
type StepView = Detail['steps'][number]
type CriterionView = StepView['criteria'][number]
type WaitingItem = Detail['waiting']['items'][number]

/** The width of the progress bar's fill, as a percentage of the server's `done` over its `total`. */
export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, (done / total) * 100))
}

/** The one step a waiting item names, or `null` when it names none (or several). */
export function waitingStepId(item: WaitingItem): string | null {
  switch (item.kind) {
    case 'main-failing':
    case 'settle':
      return item.stepId
    case 'unblock':
      return item.stepId
    case 'review':
      return item.stepIds.length === 1 ? item.stepIds[0] : null
    default:
      return null
  }
}

/** Every step id the waiting list names: the steps the operator owes something on. */
function owedStepIds(detail: Detail): Set<string> {
  const ids = new Set<string>()
  for (const item of detail.waiting.items) {
    if (item.kind === 'review') item.stepIds.forEach((id) => ids.add(id))
    else if ('stepId' in item && item.stepId) ids.add(item.stepId)
  }
  return ids
}

/** The pull request number of a step's `pr` link ("256", "#256" or a pull request URL), or `null`. */
function prNumberOf(links: StepView['links']): string | null {
  const link = links.find((l) => l.kind === 'pr')
  if (!link) return null
  const m = /(\d+)\s*$/.exec(link.ref.replace(/\/+$/, ''))
  return m ? m[1] : null
}

/** One step row of the tree. */
export interface PaneStepRow {
  id: string
  title: string
  /** The server's identifier: `todo`, `running`, `waiting-review` or `done`. */
  state: string
  blocked: boolean
  /** The waiting list names this step: the operator owes it something. */
  needsYou: boolean
  pr: string | null
  criteria: CriterionView[]
}

/** The steps a milestone (or a mission with no milestones) draws, and the ones folded behind "N more". */
export interface StepGroups {
  shown: PaneStepRow[]
  folded: PaneStepRow[]
}

/**
 * The order inside a milestone: the steps the operator owes first, then the running ones, each in plan
 * order; every other step is folded behind "N more", in plan order. A step is in exactly one place.
 */
export function orderSteps(rows: PaneStepRow[]): StepGroups {
  const owed = rows.filter((r) => r.needsYou)
  const running = rows.filter((r) => !r.needsYou && r.state === 'running')
  const folded = rows.filter((r) => !r.needsYou && r.state !== 'running')
  return { shown: [...owed, ...running], folded }
}

/** One milestone row of the tree. */
export interface PaneMilestoneRow extends StepGroups {
  id: string
  title: string
  optional: boolean
  /** The server's identifier: `not-started`, `in-progress`, `waiting-review` or `done`. */
  state: string
  /** The server's current milestone: the first in plan order that is neither done nor optional. */
  current: boolean
  /** Only the current milestone opens by itself. */
  openByDefault: boolean
  /** Steps the server says are done, over the milestone's counted steps (all of them when none count). */
  done: number
  total: number
  /** The server's counts: running, waiting for review and blocked. To do is never counted. */
  counts: { running: number; waitingReview: number; blocked: number }
  /** The milestone it waits for, only when that is not the previous one and is not done yet. */
  waitsFor: { id: string; title: string } | null
}

export interface PaneTree {
  /** The required milestones, in plan order. */
  milestones: PaneMilestoneRow[]
  /** The optional ones, in plan order: they sit under one collapsed line. */
  optional: PaneMilestoneRow[]
  /** A mission with no milestones draws its steps directly; `null` when it has milestones. */
  loose: StepGroups | null
}

export function buildPaneTree(detail: Detail): PaneTree {
  const owed = owedStepIds(detail)
  const rowOf = (s: StepView): PaneStepRow => ({
    id: s.id,
    title: s.title,
    state: s.state,
    blocked: s.blocked,
    needsYou: owed.has(s.id),
    pr: prNumberOf(s.links),
    criteria: s.criteria
  })

  if (detail.milestones.length === 0) {
    return { milestones: [], optional: [], loose: orderSteps(detail.steps.map(rowOf)) }
  }

  const byMilestone = detail.progress.unit === 'milestones'
  const rows = detail.milestones.map((m, i): PaneMilestoneRow => {
    const own = detail.steps.filter((s) => s.milestone === m.id)
    // The server's rule: the required steps decide; a milestone of optional steps reads from all of them.
    const required = own.filter((s) => !s.optional)
    const counted = required.length > 0 ? required : own
    const target = m.waitsFor ? detail.milestones.find((x) => x.id === m.waitsFor) : undefined
    const previous = i > 0 ? detail.milestones[i - 1] : undefined
    const waitsFor =
      target && target.id !== previous?.id && target.state !== 'done'
        ? { id: target.id, title: target.title }
        : null
    const current = byMilestone && detail.progress.current?.id === m.id
    return {
      id: m.id,
      title: m.title,
      optional: m.optional,
      state: m.state,
      current,
      openByDefault: current,
      done: counted.filter((s) => s.state === 'done').length,
      total: counted.length,
      counts: m.counts,
      waitsFor,
      ...orderSteps(own.map(rowOf))
    }
  })
  return {
    milestones: rows.filter((r) => !r.optional),
    optional: rows.filter((r) => r.optional),
    loose: null
  }
}

/** The milestone (or `null` for the loose list) that holds a step, so "Open step" can unfold it. */
export function milestoneOfStep(tree: PaneTree, stepId: string): string | null {
  for (const m of [...tree.milestones, ...tree.optional]) {
    if (m.shown.some((s) => s.id === stepId) || m.folded.some((s) => s.id === stepId)) return m.id
  }
  return null
}

/** One part of a milestone's summary line; the renderer translates each by its kind. */
export interface SummaryPart {
  kind: 'running' | 'waitingReview' | 'blocked' | 'nothingRunning' | 'allDone'
  n: number
}

/**
 * A milestone's summary line, as parts: how many steps run, wait for review and are blocked (a zero is
 * left out; to do is never counted). With nothing running it opens with "Nothing running"; with all three
 * at zero it reads "Nothing running", or "Every step is done" for a done milestone.
 */
export function milestoneSummary(m: Pick<PaneMilestoneRow, 'counts' | 'state'>): SummaryPart[] {
  const parts: SummaryPart[] = []
  if (m.counts.running > 0) parts.push({ kind: 'running', n: m.counts.running })
  if (m.counts.waitingReview > 0) parts.push({ kind: 'waitingReview', n: m.counts.waitingReview })
  if (m.counts.blocked > 0) parts.push({ kind: 'blocked', n: m.counts.blocked })
  if (parts.length === 0) {
    return [{ kind: m.state === 'done' ? 'allDone' : 'nothingRunning', n: 0 }]
  }
  if (m.counts.running === 0) parts.unshift({ kind: 'nothingRunning', n: 0 })
  return parts
}

/** The glyph a step or a milestone draws: its state, with the blocked mark in place of the state's glyph. */
export type GlyphKind = 'done' | 'running' | 'review' | 'todo' | 'blocked'

export function stepGlyph(state: string, blocked: boolean): GlyphKind {
  if (blocked) return 'blocked'
  if (state === 'done') return 'done'
  if (state === 'running') return 'running'
  if (state === 'waiting-review') return 'review'
  return 'todo'
}

export function milestoneGlyph(state: string): GlyphKind {
  if (state === 'done') return 'done'
  if (state === 'in-progress') return 'running'
  if (state === 'waiting-review') return 'review'
  return 'todo'
}

/** The next-step box's look: the operator owes something, owes the close, or nothing waits. */
export type NextLook = 'you' | 'ok' | 'calm'

export function nextLook(detail: Detail): NextLook {
  const next = detail.waiting.next
  if (next === null) return 'calm'
  return next.kind === 'close' ? 'ok' : 'you'
}
