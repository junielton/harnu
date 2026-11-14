/**
 * T611 U2 — what the GitHub budget pill, its popover and Settings → GitHub API show, as pure
 * functions of U1's `BudgetSnapshot` (`window.api.githubBudgetSnapshot`). No Vue, no i18n, no clock
 * of its own (callers pass `now`), so every number the mockups print is unit-tested here.
 *
 * The tighter bucket (D-2) drives the pill, the attribution and the pace; both meters always show.
 */

import { HISTORY_BUCKET_MS } from '../../../main/github-budget-core'
import type {
  BudgetBucket,
  BudgetSnapshot,
  GhConsumer,
  GhResource,
  HistoryBucket,
  ResourceView,
  ThrottleState
} from '../../../main/github-budget-core'

export type { BudgetSnapshot, GhConsumer, GhResource, ThrottleState }

const BUCKET_MINUTES = HISTORY_BUCKET_MS / 60_000

/**
 * Display order of the consumers, as the mockup lists them.
 * `budget` (U1's own `gh api user` lookup, 0–1 calls) never has a row, it only counts in the total.
 */
export const CONSUMER_ORDER: readonly GhConsumer[] = [
  'missions',
  'pr-stack',
  'review',
  'cleanup',
  'steward'
]

/** i18n leaf of a consumer: `pr-stack` → `prStack` (vue-i18n key paths stay camelCase). */
export function consumerKey(c: GhConsumer): string {
  return c.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
}

/** A usable snapshot: the poller has answered at least once and `gh` works. */
export interface ReadyBudget {
  snapshot: BudgetSnapshot
  rest: ResourceView
  graphql: ResourceView
  tighter: GhResource
  tighterView: ResourceView
}

/** `null` while the budget is `unavailable` or before the first poll — the pill hides then. */
export function readyBudget(snapshot: BudgetSnapshot | null): ReadyBudget | null {
  if (!snapshot || snapshot.status !== 'ok') return null
  const { rest, graphql, tighter } = snapshot
  if (!rest || !graphql || !tighter) return null
  return { snapshot, rest, graphql, tighter, tighterView: tighter === 'rest' ? rest : graphql }
}

/** Percent of a bucket already spent, `0..100`. */
export function usedPercent(b: BudgetBucket): number {
  if (b.limit <= 0) return 0
  return Math.min(100, Math.max(0, ((b.limit - b.remaining) / b.limit) * 100))
}

/** Plan-usage ramp (design.md "Plan usage"): green < 80, accent 80–95, red ≥ 95 — bar fill. */
export function meterFillClass(pct: number): string {
  if (pct >= 95) return 'bg-red'
  if (pct >= 80) return 'bg-accent'
  return 'bg-green'
}

/** Same breakpoints for the "N left" figure: quiet until 80, then accent, then red. */
export function meterValueClass(pct: number): string {
  if (pct >= 95) return 'text-red'
  if (pct >= 80) return 'text-accent'
  return 'text-text-2'
}

/** Pill colour per throttle state (the mockup keeps it unchanged while the popover is open). */
export function pillToneClass(state: ThrottleState): string {
  if (state === 'exhausted') return 'text-red hover:bg-surface-2'
  if (state === 'low') return 'text-warning hover:bg-surface-2'
  return 'text-text-2 hover:bg-surface-2 hover:text-text'
}

/** Whole minutes until `resetMs` (rounded up, never below 1 while it is still ahead). */
export function minutesUntil(resetMs: number, now: number): number {
  const delta = resetMs - now
  return delta <= 0 ? 0 : Math.max(1, Math.ceil(delta / 60_000))
}

/**
 * The gh user the budget belongs to, for the `@login` in the popover header and the pane intro.
 * `null` when U1's snapshot carries none (older main, or `gh api user` unanswered): both places
 * then drop the handle instead of printing a blank.
 */
export function loginOf(snapshot: BudgetSnapshot | null): string | null {
  const login = snapshot?.login
  return typeof login === 'string' && login.trim() !== '' ? login.trim() : null
}

/** `38m`, `1h 5m`, `2h` — a reset countdown a pill can hold. */
export function formatCountdown(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/** `14:00` — a local wall-clock time, 24-hour, as the mockups print it. */
export function formatClock(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(ms))
}

export function formatCount(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(Math.round(n))
}

/** "updated 20s ago" input: seconds under a minute, else whole minutes. */
export function ageParts(sampledAt: number | null, now: number): { unit: 's' | 'm'; n: number } {
  const s = Math.max(0, Math.round((now - (sampledAt ?? now)) / 1000))
  return s < 60 ? { unit: 's', n: s } : { unit: 'm', n: Math.floor(s / 60) }
}

// ── Attribution ───────────────────────────────────────────────────────────────

export interface ConsumerRow {
  consumer: GhConsumer
  calls: number
  /** Bar width, `0..100`, relative to the busiest Harnu consumer. */
  barPct: number
}

/** Harnu's consumers for the window, in display order; zero rows are kept. */
export function consumerRows(view: ResourceView): ConsumerRow[] {
  const rows = CONSUMER_ORDER.map((consumer) => ({ consumer, calls: view.byConsumer[consumer] }))
  const max = Math.max(1, ...rows.map((r) => r.calls))
  return rows.map((r) => ({ ...r, barPct: Math.round((r.calls / max) * 100) }))
}

export interface SplitBar {
  harnu: number
  outside: number
  /** Widths as a percentage of the bucket's limit. */
  harnuPct: number
  outsidePct: number
  /** Total calls the bucket has seen this window. */
  total: number
}

export function splitBar(view: ResourceView): SplitBar {
  const limit = Math.max(1, view.bucket.limit)
  const harnuPct = Math.min(100, (view.harnu / limit) * 100)
  const outsidePct = Math.min(100 - harnuPct, (view.outside / limit) * 100)
  return {
    harnu: view.harnu,
    outside: view.outside,
    harnuPct,
    outsidePct,
    total: view.harnu + view.outside
  }
}

/** `outside` bar width: relative to the busiest Harnu consumer, clamped at 100. */
export function outsideBarPct(view: ResourceView, rows: readonly ConsumerRow[]): number {
  const max = Math.max(1, ...rows.map((r) => r.calls))
  return Math.min(100, Math.round((view.outside / max) * 100))
}

/** A row's share of everything spent this window, whole percent. */
export function sharePercent(calls: number, total: number): number {
  return total <= 0 ? 0 : Math.round((calls / total) * 100)
}

// ── Pace ──────────────────────────────────────────────────────────────────────

export interface PaceView {
  /** GitHub's own spend rate over the last 10 minutes; `null` before two polls. */
  callsPerMin: number | null
  harnuPerMin: number
  outsidePerMin: number | null
  /** Harnu's rate before it slowed down, when the history knows one that was higher. */
  harnuWasPerMin: number | null
  /** Minutes until the bucket is empty at this pace, only when that happens before the reset. */
  emptyInMinutes: number | null
}

export function paceView(view: ResourceView, state: ThrottleState, now: number): PaceView {
  const { pace } = view
  const resetMs = view.bucket.reset * 1000
  const untilReset = Math.max(0, (resetMs - now) / 60_000)
  const emptyIn =
    pace.minutesToEmpty !== null && pace.minutesToEmpty < untilReset
      ? Math.max(1, Math.ceil(pace.minutesToEmpty))
      : null
  const peak = Math.max(0, ...view.history.map((b) => b.harnu / BUCKET_MINUTES))
  return {
    callsPerMin: pace.callsPerMin,
    harnuPerMin: pace.harnuCallsPerMin,
    outsidePerMin:
      pace.callsPerMin === null ? null : Math.max(0, pace.callsPerMin - pace.harnuCallsPerMin),
    harnuWasPerMin: state !== 'normal' && peak > pace.harnuCallsPerMin ? peak : null,
    emptyInMinutes: emptyIn
  }
}

// ── Last hour chart ───────────────────────────────────────────────────────────

export interface ChartColumn {
  start: number
  /** Heights as a percentage of the chart, `0..100`. */
  harnuPct: number
  throttledPct: number
  outsidePct: number
  label: string | null
}

/**
 * Twelve 5-minute columns, newest last. A column stacks Harnu (normal), Harnu while slowed and
 * outside. The scale is the busiest column (with a floor so a quiet hour is not blown up to full
 * height); labels sit on every other column.
 */
export function chartColumns(history: readonly HistoryBucket[], locale?: string): ChartColumn[] {
  const peak = Math.max(60, ...history.map((b) => b.harnu + b.throttled + b.outside))
  const scale = peak * 1.1
  return history.map((b, i) => ({
    start: b.start,
    harnuPct: (b.harnu / scale) * 100,
    throttledPct: (b.throttled / scale) * 100,
    outsidePct: (b.outside / scale) * 100,
    label: i % 2 === 0 ? formatClock(b.start, locale) : null
  }))
}

// ── Cadence (Settings → GitHub API "Checks every") ────────────────────────────

export type CadenceKind =
  | { kind: 'every'; ms: number }
  | { kind: 'onOpen' }
  | { kind: 'onEvent' }
  | { kind: 'notChecked' }
  | { kind: 'paused' }

export interface CadenceCell {
  /** What it runs at when the budget is healthy. */
  base: CadenceKind
  /** What it runs at now, when that differs (`low`, `exhausted`). */
  now: CadenceKind | null
}

export interface CadenceInputs {
  state: ThrottleState
  pausePrStackWhenLow: boolean
  prStackIntervalMs: number
  prStackAutoRefresh: boolean
  cleanupIntervalMs: number
}

const GATE_BASE_MS = 60_000
const GATE_LOW_MS = 5 * 60_000

/** Per consumer: its normal cadence and, while throttled, the cadence it is held to. */
export function cadenceFor(consumer: GhConsumer, i: CadenceInputs): CadenceCell {
  const paused: CadenceKind = { kind: 'paused' }
  const cell = (base: CadenceKind, low: CadenceKind | null): CadenceCell => ({
    base,
    now: i.state === 'exhausted' ? paused : i.state === 'low' ? low : null
  })
  switch (consumer) {
    case 'missions':
      return cell({ kind: 'every', ms: GATE_BASE_MS }, { kind: 'every', ms: GATE_LOW_MS })
    case 'pr-stack': {
      const base: CadenceKind = i.prStackAutoRefresh
        ? { kind: 'every', ms: i.prStackIntervalMs }
        : { kind: 'onOpen' }
      return cell(base, i.pausePrStackWhenLow && i.prStackAutoRefresh ? { kind: 'onOpen' } : null)
    }
    case 'review':
      return cell({ kind: 'onOpen' }, null)
    case 'cleanup':
      return cell({ kind: 'every', ms: i.cleanupIntervalMs }, null)
    case 'steward':
      return cell({ kind: 'onEvent' }, null)
    case 'budget':
      // `budget` (the login lookup) never gets a row; it only counts inside Harnu's total.
      return cell({ kind: 'onEvent' }, null)
  }
}

/** `30 s`, `2 min`, `1 h` — a polling interval in the units a person says it in. */
export function intervalLabelParts(ms: number): { unit: 's' | 'min' | 'h'; n: number } {
  if (ms < 60_000) return { unit: 's', n: Math.max(1, Math.round(ms / 1000)) }
  if (ms < 3_600_000) return { unit: 'min', n: Math.max(1, Math.round(ms / 60_000)) }
  return { unit: 'h', n: Math.max(1, Math.round(ms / 3_600_000)) }
}

/** Is the budget at a state where Harnu has changed how it polls? */
export function isThrottled(state: ThrottleState): boolean {
  return state !== 'normal'
}

/** Which bucket the throttle follows, in words the copy can drop in. */
export function resourceName(resource: GhResource): 'REST' | 'GraphQL' {
  return resource === 'rest' ? 'REST' : 'GraphQL'
}
