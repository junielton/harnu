/**
 * Mission dropdown · S-3 — the rules of the tree that are not drawing (design.md §6 "Mission dropdown" →
 * "What it draws" 3 and "Keyboard and focus").
 *
 * Pure like `mission-pane-view.ts`, which still builds the tree (`buildPaneTree`): the dropdown READS the
 * server's states, counts and current milestone and computes none of them. What this module adds is two
 * rules of its own: how many running steps an open milestone shows before "{n} more steps", and what each
 * key does on the tree's rows.
 *
 * It also reads the TIMELINE (T810): the segments of the head's progress bar and the time line under each
 * title. Times are the record's own stamps (a step's `startedAt`, a blocker's `raisedAt`, a criterion's
 * settle); where the record holds none there is no line. Nothing records when a step entered review, so a
 * step in review has no line.
 */
import {
  milestoneGlyph,
  stepGlyph,
  type GlyphKind,
  type MissionV4Reply,
  type PaneMilestoneRow,
  type PaneStepRow,
  type PaneTree
} from './mission-pane-view'

// ---- the state glyphs --------------------------------------------------------------------------------

/** The three levels of the tree a glyph can mark. */
export type DotKind = 'milestone' | 'step' | 'criterion'

/** What a glyph draws: the pane's five, plus the criterion's two (an empty box, a settled one). */
export type DotGlyph = GlyphKind | 'box' | 'settled'

/** The glyph for a level's state. A blocked step draws the flag in place of its own glyph. */
export function glyphOf(kind: DotKind, state: string, blocked = false): DotGlyph {
  if (kind === 'milestone') return milestoneGlyph(state)
  if (kind === 'step') return stepGlyph(state, blocked)
  return state === 'settled' ? 'settled' : 'box'
}

/**
 * The key of the label (`missionDropdown.state.<kind>.<key>`). A state this build does not know reads as the
 * level's first one (Not started, To do, Not settled yet) rather than as a raw key.
 */
export function stateKeyOf(kind: DotKind, state: string, blocked = false): string {
  if (kind === 'criterion') return state === 'settled' ? 'settled' : 'open'
  if (kind === 'step') {
    if (blocked) return 'blocked'
    return ['running', 'waiting-review', 'done'].includes(state) ? state : 'todo'
  }
  return ['in-progress', 'waiting-review', 'done'].includes(state) ? state : 'not-started'
}

/** At most this many running steps show in an open milestone; the rest fold behind "{n} more steps". */
export const RUNNING_SHOWN = 3

/**
 * Re-group one milestone for the dropdown: the steps the operator owes first (never cut: an owed item is
 * never hidden behind a fold with no count), then at most {@link RUNNING_SHOWN} running steps, and every
 * other step behind the fold, in plan order. A step is in exactly one place.
 */
function capMilestone<T extends { shown: PaneStepRow[]; folded: PaneStepRow[] }>(
  m: T,
  position: ReadonlyMap<string, number>
): T {
  const all = [...m.shown, ...m.folded]
  const owed = all.filter((s) => s.needsYou)
  const running = all.filter((s) => !s.needsYou && s.state === 'running')
  const rest = all.filter((s) => !s.needsYou && s.state !== 'running')
  const folded = [...running.slice(RUNNING_SHOWN), ...rest].sort(
    (a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0)
  )
  return { ...m, shown: [...owed, ...running.slice(0, RUNNING_SHOWN)], folded }
}

/**
 * The pane's tree with the dropdown's cap on running steps inside each milestone. `planOrder` is the step ids
 * in plan order (`detail.steps`), so the steps behind the fold read in the order of the plan.
 *
 * A mission with no milestones draws its steps as one list, unchanged (the pane's rule: a small task IS its
 * timeline), and optional milestones keep their one collapsed line.
 */
export function capRunning(tree: PaneTree, planOrder: readonly string[]): PaneTree {
  const position = new Map(planOrder.map((id, i) => [id, i]))
  const cap = (m: PaneMilestoneRow): PaneMilestoneRow => capMilestone(m, position)
  return {
    milestones: tree.milestones.map(cap),
    optional: tree.optional.map(cap),
    loose: tree.loose
  }
}

/** One visible row of the tree, in the order it is drawn: what a key needs to know about it. */
export interface TreeRow {
  id: string
  /** The row it sits under (a step's milestone), or `null` for a top-level row. */
  parentId: string | null
  /** Whether it is open (its children are drawn). */
  open: boolean
}

/** What a key does: move focus to a row, or open or close one. `null` when the key does nothing here. */
export type TreeAction = { focus: string } | { toggle: string } | null

/**
 * The WAI-ARIA tree keys on the visible rows (design.md §6 "Keyboard and focus"): Up and Down move between
 * them; Right opens a closed row and, on an open one, moves into its first child; Left closes an open row
 * and, on a closed one, moves out to its parent; Home and End jump to the first and the last; Enter and Space
 * toggle. Every row of this tree can open (a milestone shows its steps, a step its criteria).
 */
export function treeKeyAction(rows: readonly TreeRow[], from: string, key: string): TreeAction {
  const at = rows.findIndex((r) => r.id === from)
  if (at < 0) return null
  const row = rows[at]
  switch (key) {
    case 'ArrowDown':
      return at < rows.length - 1 ? { focus: rows[at + 1].id } : null
    case 'ArrowUp':
      return at > 0 ? { focus: rows[at - 1].id } : null
    case 'Home':
      return { focus: rows[0].id }
    case 'End':
      return { focus: rows[rows.length - 1].id }
    case 'ArrowRight': {
      if (!row.open) return { toggle: row.id }
      const next = rows[at + 1]
      return next && next.parentId === row.id ? { focus: next.id } : null
    }
    case 'ArrowLeft':
      if (row.open) return { toggle: row.id }
      return row.parentId !== null ? { focus: row.parentId } : null
    case 'Enter':
    case ' ':
      return { toggle: row.id }
    default:
      return null
  }
}

// ---- the timeline: progress segments and the time under each title ------------------------------------------

type Detail = MissionV4Reply['detail']
type Step = Detail['steps'][number]

/** When each settled criterion was settled, by step id then criterion id (the view's `settledAt`). */
export type SettleTimes = Readonly<Record<string, Readonly<Record<string, string>>>>

/** What a time line says; the renderer words it. `at` is the record's stamp, as written. */
export type TimeLine =
  | { kind: 'done' | 'openSince' | 'lastVerified'; at: string }
  | { kind: 'started' | 'blocked'; at: string; ageMs: number }
  | { kind: 'running'; ageMs: number }
  | { kind: 'notStarted' }

/** The stamps that parse, oldest first. */
function stamps(values: ReadonlyArray<string | null | undefined>): string[] {
  return values
    .filter((v): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
}

const since = (at: string, now: number): number => Math.max(0, now - Date.parse(at))

/** The latest settle among a step's settled criteria. */
const settlesOf = (step: Step, settledAt: SettleTimes): Array<string | undefined> =>
  step.criteria.filter((c) => c.settled).map((c) => settledAt[step.id]?.[c.id])

/**
 * A milestone's line: "Done" with the last settle of its steps, "Started" from the first step that started,
 * or "Not started".
 */
export function milestoneTime(
  detail: Detail,
  milestoneId: string,
  settledAt: SettleTimes,
  now: number
): TimeLine | null {
  const state = detail.milestones.find((m) => m.id === milestoneId)?.state
  if (state === 'not-started') return { kind: 'notStarted' }
  const own = detail.steps.filter((s) => s.milestone === milestoneId)
  if (state === 'done') {
    const at = stamps(own.flatMap((s) => settlesOf(s, settledAt))).pop()
    return at === undefined ? null : { kind: 'done', at }
  }
  const at = stamps(own.map((s) => s.startedAt))[0]
  return at === undefined ? null : { kind: 'started', at, ageMs: since(at, now) }
}

/**
 * A step's line: how long it has been blocked (from its oldest blocker), else how long it has run. A step in
 * review, to do or done has none.
 */
export function stepTime(step: Step, now: number): TimeLine | null {
  if (step.state === 'done') return null
  if (step.blocked) {
    const at = stamps(step.blockers.map((b) => b.raisedAt))[0]
    return at === undefined ? null : { kind: 'blocked', at, ageMs: since(at, now) }
  }
  if (step.state !== 'running') return null
  const at = stamps([step.startedAt])[0]
  return at === undefined ? null : { kind: 'running', ageMs: since(at, now) }
}

/** The lines of an open step's criteria: one for the open ones, one for the folded verified line. */
export function criterionTimes(
  step: Step,
  settledAt: SettleTimes
): { openSince: TimeLine | null; lastVerified: TimeLine | null } {
  const started = stamps([step.startedAt])[0]
  const latest = stamps(settlesOf(step, settledAt)).pop()
  return {
    openSince: started === undefined ? null : { kind: 'openSince', at: started },
    lastVerified: latest === undefined ? null : { kind: 'lastVerified', at: latest }
  }
}

/** One segment of the progress bar. */
export interface Segment {
  id: string
  state: 'done' | 'current' | 'todo'
}

/** One segment per required milestone, in plan order; none for a mission with no milestones. */
export function milestoneSegments(detail: Detail): Segment[] {
  const current = detail.progress.current?.id
  return detail.milestones
    .filter((m) => !m.optional)
    .map((m) => ({
      id: m.id,
      state: m.state === 'done' ? 'done' : m.id === current ? 'current' : 'todo'
    }))
}

type Translate = (key: string, values?: Record<string, unknown>, plural?: number) => string

/** "<1 min", "25 min", "1 h 10 min", "6 days". */
export function formatAge(t: Translate, ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 1) return t('missionDropdown.time.age.underMinute')
  if (minutes < 60) return t('missionDropdown.time.age.minutes', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0
      ? t('missionDropdown.time.age.hours', { h: hours })
      : t('missionDropdown.time.age.hoursMinutes', { h: hours, m: rest })
  }
  const days = Math.floor(hours / 24)
  return t('missionDropdown.time.age.days', { n: days }, days)
}

/** "12 Nov, 16:40" in the reader's locale, or `null` for a stamp that does not parse. */
export function formatStamp(iso: string, locale: string): string | null {
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return null
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(at)
}

/** The sentence of a time line, or `null` when there is nothing to say. */
export function timeText(t: Translate, locale: string, line: TimeLine | null): string | null {
  if (line === null) return null
  if (line.kind === 'notStarted') return t('missionDropdown.time.notStarted')
  if (line.kind === 'running') {
    return t('missionDropdown.time.running', { age: formatAge(t, line.ageMs) })
  }
  const date = formatStamp(line.at, locale)
  if (date === null) return null
  if (line.kind === 'started' || line.kind === 'blocked') {
    return t(`missionDropdown.time.${line.kind}`, { date, age: formatAge(t, line.ageMs) })
  }
  return t(`missionDropdown.time.${line.kind}`, { date })
}
