/**
 * Pure presentational helpers for the Usage Dashboard takeover (design.md
 * "Usage Dashboard (takeover, T47 P6 S2)"). Framework-free so they're
 * unit-testable in the `node` vitest env (`tests/usage-dashboard-format.test.ts`);
 * the `.vue` components are thin templates over these. No charting library —
 * plain SVG geometry, same convention as `usage-history-format.ts`.
 */

import type {
  UsageBiSnapshot,
  UsageBiDay,
  SessionAnatomy,
  ModelCostRollup,
  ProjectCostRollup,
  EnrichedWindow
} from '../../../preload'

// ---- Categorical model palette (design.md, "Model categorical palette") --

/**
 * Fixed color per model family — never derived from theme, always paired with
 * a text label. `opus-4-7` gets its OWN color (coral), distinct from
 * `opus-4-8` (blue) — mirrors the reference mockup's `--m-opus8` /
 * `--m-opus47` split exactly (they are not "the same tier", see design.md's
 * categorical-palette table). Order matters: the more specific `opus-4-7`
 * rule must run before the general `opus` catch-all.
 */
const MODEL_COLOR_RULES: Array<{ test: RegExp; color: string }> = [
  { test: /opus-4-7(?!\d)/, color: '#e66767' }, // opus 4.7 only — coral red
  { test: /opus/, color: '#3987e5' }, // every other opus (4, 4.5, 4.6, 4.8+) — blue
  { test: /fable|mythos/, color: '#199e70' }, // fable/mythos — teal green
  { test: /haiku/, color: '#008300' }, // haiku — green
  { test: /sonnet/, color: '#c98500' } // sonnet — amber
]
/** Neutral fallback for an unrecognized model id. */
export const MODEL_COLOR_UNKNOWN = 'var(--color-text-4)'

/** Deterministic color for a model id, reused everywhere the dashboard shows a model. */
export function modelColor(modelId: string): string {
  const id = modelId.toLowerCase()
  for (const rule of MODEL_COLOR_RULES) {
    if (rule.test.test(id)) return rule.color
  }
  return MODEL_COLOR_UNKNOWN
}

// ---- Number formatting -------------------------------------------------------

/** `$1,234` — no cents, for compact chart totals/axis labels. */
export function fmtMoney0(v: number | null | undefined): string {
  return '$' + Math.round(v ?? 0).toLocaleString('en-US')
}
/** `1,234` integer, thousands-separated. */
export function fmtInt(v: number | null | undefined): string {
  return Math.round(v ?? 0).toLocaleString('en-US')
}
/** `420K` / `3.4M` — compact token counts. */
export function fmtTok(n: number | null | undefined): string {
  const v = n ?? 0
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M'
  if (v >= 1e3) return Math.round(v / 1e3) + 'K'
  return String(Math.round(v))
}

// ---- KPI delta badge ----------------------------------------------------------

export type DeltaTone = 'up-good' | 'up-bad' | 'down-good' | 'down-bad' | 'flat'
export interface DeltaBadge {
  tone: DeltaTone
  pct: number
  arrow: '↑' | '↓' | ''
}

/**
 * Delta badge between a current and previous value. `higherIsBad` flips which
 * direction reads as good/bad (e.g. rate-limit % up is bad, sessions-worked up
 * is neutral-to-good). `prev === 0` (or missing) reads as flat — a % delta off
 * zero is meaningless, not "infinite".
 */
export function deltaBadge(curr: number, prev: number | null, higherIsBad: boolean): DeltaBadge {
  if (prev === null || prev === 0 || Math.abs(curr - prev) < 0.005) {
    return { tone: 'flat', pct: 0, arrow: '' }
  }
  const diff = curr - prev
  const pct = Math.abs((diff / prev) * 100)
  const goingUp = diff > 0
  const bad = higherIsBad ? goingUp : !goingUp
  const tone: DeltaTone = bad
    ? goingUp
      ? 'up-bad'
      : 'down-bad'
    : goingUp
      ? 'up-good'
      : 'down-good'
  return { tone, pct, arrow: goingUp ? '↑' : '↓' }
}

/** Tailwind classes for a {@link DeltaTone}. */
export function deltaToneClass(tone: DeltaTone): string {
  switch (tone) {
    case 'up-bad':
    case 'down-bad':
      return 'text-red bg-red-soft'
    case 'up-good':
    case 'down-good':
      return 'text-green bg-green-soft'
    default:
      return 'text-text-3 bg-surface-2'
  }
}

// ---- Sparkline (KPI strip) ---------------------------------------------------

/** SVG `<polyline>` points for a small sparkline, normalized into a `w×h` box. */
export function sparklinePoints(
  values: readonly number[],
  w = 100,
  h = 26,
  pad = 2
): { points: string; lastX: number; lastY: number } {
  if (values.length === 0) return { points: '', lastX: 0, lastY: h / 2 }
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = Math.max(1e-9, max - min)
  const pts = values.map((v, i) => {
    const x = values.length === 1 ? w / 2 : pad + (i / (values.length - 1)) * (w - pad * 2)
    const y = h - pad - ((v - min) / span) * (h - pad * 2)
    return { x, y }
  })
  return {
    points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
    lastX: pts[pts.length - 1].x,
    lastY: pts[pts.length - 1].y
  }
}

// ---- Stacked bar chart --------------------------------------------------------

export type ChartMetric = 'cost' | 'rate' | 'sessions'

export interface StackSegment {
  model: string
  value: number
  color: string
}
export interface StackedBarRow {
  day: string
  isToday: boolean
  total: number
  segments: StackSegment[]
  /** Rate-limit-metric rows carry the threshold fill instead of a per-model split. */
  isRateMetric: boolean
  /**
   * Set when this rate-metric day had a mid-day weekly (7d) cap reset —
   * rendered as two independent bars (pre-reset anchored at 0%, post-reset
   * floating above with a gap) instead of the single threshold-colored fill.
   * `segments` stays empty for these rows; the two values live here instead.
   */
  weeklyReset?: { atMs: number; prePct: number; postPct: number } | null
}

/**
 * Fold days into stacked-bar rows for {@link ChartMetric}. `visibleModels`
 * filters which models contribute (the filter-bar chip toggles). `cost` is the
 * only metric with a real per-model breakdown in the snapshot (`costByModel`);
 * `rate` (account-wide %) and `sessions` (the engine only tracks
 * `sessionsWorked` as a day total, not per-model) render as a SINGLE segment
 * per day — still gets the model chips' filter applied via the day's own
 * `dominantModel` for `sessions` (so toggling models off still narrows what's
 * shown, even without a true per-model split). `todayDay` is the local
 * `YYYY-MM-DD` used to flag the "today" bar.
 */
export function buildStackedRows(
  days: readonly UsageBiDay[],
  metric: ChartMetric,
  visibleModels: ReadonlySet<string>,
  todayDay: string
): StackedBarRow[] {
  return days.map((d) => {
    if (metric === 'rate') {
      const reset = d.weeklyReset
      if (reset) {
        return {
          day: d.day,
          isToday: d.day === todayDay,
          // Scale reference only (used where a single number is needed, e.g.
          // sorting) — never rendered as a label. The two bars are drawn from
          // `weeklyReset` directly, each independently scaled 0-100%.
          total: Math.max(reset.prePct, reset.postPct),
          isRateMetric: true,
          weeklyReset: reset,
          segments: []
        }
      }
      const total = d.peak7dPct ?? 0
      return {
        day: d.day,
        isToday: d.day === todayDay,
        total,
        isRateMetric: true,
        segments: [{ model: 'rate', value: total, color: pctThresholdColor(total) }]
      }
    }
    if (metric === 'sessions') {
      const included = !d.dominantModel || visibleModels.has(d.dominantModel)
      const total = included ? d.sessionsWorked : 0
      return {
        day: d.day,
        isToday: d.day === todayDay,
        total,
        isRateMetric: false,
        segments:
          total > 0
            ? [{ model: d.dominantModel ?? '', value: total, color: 'var(--color-accent)' }]
            : []
      }
    }
    const segments: StackSegment[] = Object.entries(d.costByModel)
      .filter(([model]) => visibleModels.has(model))
      .map(([model, value]) => ({ model, value, color: modelColor(model) }))
    const total = segments.reduce((s, x) => s + x.value, 0)
    return { day: d.day, isToday: d.day === todayDay, total, isRateMetric: false, segments }
  })
}

/** Threshold color for a raw 0-100 rate-limit %, same breakpoints as `barClass`. */
export function pctThresholdColor(pct: number): string {
  if (pct >= 95) return 'var(--color-red)'
  if (pct >= 80) return 'var(--color-accent)'
  return 'var(--color-green)'
}

/** `HH:MM` local time for an epoch-ms timestamp — the weekly-reset tooltip's reset clock. */
export function fmtResetTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

// ---- Session anatomy scatter ---------------------------------------------------

export interface ScatterPoint {
  session: SessionAnatomy
  cx: number
  cy: number
  r: number
  color: string
}

export interface ScatterScale {
  xScale: (durationH: number) => number
  yScale: (costUsd: number) => number
  rScale: (tokensTotal: number) => number
  costMax: number
  durMax: number
}

/** Total tokens for one session (sum of the 4 buckets) — the bubble-area input. */
export function sessionTokensTotal(s: SessionAnatomy): number {
  return (
    s.tokens.inputTokens +
    s.tokens.outputTokens +
    s.tokens.cacheReadTokens +
    s.tokens.cacheWriteTokens
  )
}

/** Dominant model for a session — the cost-by-model entry with the highest spend. */
export function sessionDominantModel(s: SessionAnatomy): string | null {
  let best: string | null = null
  let bestCost = -1
  for (const [model, cost] of Object.entries(s.costByModel)) {
    if (cost > bestCost) {
      best = model
      bestCost = cost
    }
  }
  return best
}

/**
 * Build the x/y/r scale functions for the scatter plot. `costMax`/`durMax` are
 * derived from the visible session set (never a fixed constant — a filtered
 * view should always fill the plot). Radius uses a SQRT scale on tokens (never
 * linear — a linear area would let one outlier dominate the whole chart
 * visually), floor 8px / ceiling 40px.
 */
export function buildScatterScale(
  sessions: readonly SessionAnatomy[],
  plotW: number,
  plotH: number
): ScatterScale {
  const durations = sessions.map((s) => (s.durationMs ?? 0) / 3_600_000)
  const costs = sessions.map((s) => s.costUsd)
  const tokens = sessions.map(sessionTokensTotal)
  const durMax = Math.max(1, ...durations)
  const costMax = Math.max(1, ...costs)
  const tokMin = Math.min(...tokens, 0)
  const tokMax = Math.max(1, ...tokens)
  const sqrtMin = Math.sqrt(Math.max(0, tokMin))
  const sqrtMax = Math.sqrt(tokMax)
  return {
    costMax,
    durMax,
    xScale: (h) => Math.min(1, h / durMax) * plotW,
    yScale: (c) => plotH - Math.min(1, c / costMax) * plotH,
    rScale: (t) => {
      const f =
        sqrtMax > sqrtMin ? (Math.sqrt(Math.max(0, t)) - sqrtMin) / (sqrtMax - sqrtMin) : 0.5
      return 8 + f * (40 - 8)
    }
  }
}

export function buildScatterPoints(
  sessions: readonly SessionAnatomy[],
  scale: ScatterScale
): ScatterPoint[] {
  return sessions.map((s) => {
    const durH = (s.durationMs ?? 0) / 3_600_000
    const dom = sessionDominantModel(s)
    return {
      session: s,
      cx: scale.xScale(durH),
      cy: scale.yScale(s.costUsd),
      r: scale.rScale(sessionTokensTotal(s)),
      color: dom ? modelColor(dom) : MODEL_COLOR_UNKNOWN
    }
  })
}

// ---- Insight line (session anatomy) --------------------------------------------

/**
 * Deterministic burn-rate comparison between the two highest-cost dominant
 * models in the visible session set — "modelA sessions average $X/h vs $Y/h on
 * modelB — Rx the burn rate". Never LLM-generated; pure arithmetic over the
 * already-loaded snapshot. Returns `null` when fewer than 2 distinct dominant
 * models are represented (nothing to compare).
 */
export interface InsightComparison {
  modelA: string
  modelB: string
  costPerHourA: number
  costPerHourB: number
  ratio: number
}

export function buildInsight(sessions: readonly SessionAnatomy[]): InsightComparison | null {
  const byModel = new Map<string, number[]>()
  for (const s of sessions) {
    const dom = sessionDominantModel(s)
    if (!dom) continue
    const hours = (s.durationMs ?? 0) / 3_600_000
    if (hours <= 0) continue
    const list = byModel.get(dom)
    const rate = s.costUsd / hours
    if (list) list.push(rate)
    else byModel.set(dom, [rate])
  }
  const avg = (arr: number[]): number => arr.reduce((a, b) => a + b, 0) / arr.length
  const entries = [...byModel.entries()]
    .map(([model, rates]) => ({ model, avg: avg(rates) }))
    .sort((a, b) => b.avg - a.avg)
  if (entries.length < 2) return null
  const [a, b] = entries
  return {
    modelA: a.model,
    modelB: b.model,
    costPerHourA: a.avg,
    costPerHourB: b.avg,
    ratio: b.avg > 0 ? a.avg / b.avg : 0
  }
}

// ---- Activity calendar ---------------------------------------------------------

export type CalendarMetric = 'rate' | 'cost' | 'sessions'

export interface CalendarCell {
  /** 1-31, or `null` for a leading/trailing pad cell from an adjacent month. */
  dayOfMonth: number | null
  /** Local `YYYY-MM-DD`, `null` for a pad cell. */
  dayKey: string | null
  isToday: boolean
  data: UsageBiDay | null
}

/**
 * Build a Monday-first calendar grid for the month containing `monthAnchorMs`,
 * padded to full weeks (5 or 6 rows × 7 cols). `dataByDay` supplies the
 * snapshot's per-day data (may be sparse — most days have no data). Pure: pad
 * cells carry `dayKey: null` so the component never has to special-case "is
 * this a real cell".
 */
export function buildCalendarCells(
  monthAnchorMs: number,
  dataByDay: ReadonlyMap<string, UsageBiDay>,
  todayKey: string
): CalendarCell[] {
  const anchor = new Date(monthAnchorMs)
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const firstOfMonth = new Date(year, month, 1)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  // JS getDay(): 0=Sun..6=Sat. Monday-first pad count.
  const leadingPad = (firstOfMonth.getDay() + 6) % 7

  const cells: CalendarCell[] = []
  for (let i = 0; i < leadingPad; i++)
    cells.push({ dayOfMonth: null, dayKey: null, isToday: false, data: null })
  for (let d = 1; d <= daysInMonth; d++) {
    const key = localDayKeyFor(year, month, d)
    cells.push({
      dayOfMonth: d,
      dayKey: key,
      isToday: key === todayKey,
      data: dataByDay.get(key) ?? null
    })
  }
  const trailingPad = (7 - (cells.length % 7)) % 7
  for (let i = 0; i < trailingPad; i++)
    cells.push({ dayOfMonth: null, dayKey: null, isToday: false, data: null })
  return cells
}

function localDayKeyFor(year: number, month: number, day: number): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${year}-${p(month + 1)}-${p(day)}`
}

/** The 0..1 heat position of a day's metric value within the visible month's min/max. */
export function calendarMetricT(
  d: UsageBiDay,
  metric: CalendarMetric,
  min: number,
  max: number
): number {
  const v =
    metric === 'cost' ? d.costUsd : metric === 'sessions' ? d.sessionsWorked : (d.peak7dPct ?? 0)
  if (metric === 'rate') return clamp01(v / 100)
  const span = max - min
  return span > 0 ? clamp01((v - min) / span) : 0.5
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** 3-stop green→amber→red ramp (matches the meter palette), as an `rgb()` string. */
export function heatColor(t: number): string {
  const GREEN: [number, number, number] = [52, 211, 153]
  const WARN: [number, number, number] = [229, 182, 92]
  const RED: [number, number, number] = [239, 111, 91]
  const clamped = clamp01(t)
  const [a, b, lt] =
    clamped <= 0.5 ? [GREEN, WARN, clamped / 0.5] : [WARN, RED, (clamped - 0.5) / 0.5]
  const mix = (i: number): number => Math.round(a[i] + (b[i] - a[i]) * lt)
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`
}

// ---- Generic table sort --------------------------------------------------------

export type SortDir = 'asc' | 'desc'

export function sortRows<T>(
  rows: readonly T[],
  keyFn: (row: T) => string | number,
  dir: SortDir
): T[] {
  const mul = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = keyFn(a)
    const bv = keyFn(b)
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av).localeCompare(String(bv)) * mul
    }
    return (av - bv) * mul
  })
}

// ---- Explorer table row builders -------------------------------------------------

export interface DayTableRow {
  day: UsageBiDay
  domModel: string | null
  deltaPct: number | null
  windowPeaks: number[]
}

/** Enrich each day with its dominant model, day-over-day cost delta, and this day's window peaks. */
export function buildDayTableRows(
  days: readonly UsageBiDay[],
  windows: readonly EnrichedWindow[]
): DayTableRow[] {
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day))
  return sorted.map((d, i) => {
    const prev = i > 0 ? sorted[i - 1] : null
    const deltaPct =
      prev && prev.costUsd > 0 ? ((d.costUsd - prev.costUsd) / prev.costUsd) * 100 : null
    const windowPeaks = windows
      .filter((w) => w.kind === 'fiveHour' && localDayKeyMs(w.startedAtMs) === d.day)
      .sort((a, b) => a.startedAtMs - b.startedAtMs)
      .map((w) => w.peakPct)
    return { day: d, domModel: d.dominantModel, deltaPct, windowPeaks }
  })
}

function localDayKeyMs(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface ModelTableRow {
  model: ModelCostRollup
  avgPerRequest: number
  shareOfCostPct: number
}
export function buildModelTableRows(models: readonly ModelCostRollup[]): ModelTableRow[] {
  const totalCost = models.reduce((s, m) => s + m.costUsd, 0) || 1
  return models.map((model) => ({
    model,
    avgPerRequest: model.requestCount > 0 ? model.costUsd / model.requestCount : 0,
    shareOfCostPct: (model.costUsd / totalCost) * 100
  }))
}

export interface ProjectTableRow {
  project: ProjectCostRollup
  avgPerSession: number
  shareOfCostPct: number
}
export function buildProjectTableRows(projects: readonly ProjectCostRollup[]): ProjectTableRow[] {
  const totalCost = projects.reduce((s, p) => s + p.costUsd, 0) || 1
  return projects.map((project) => ({
    project,
    avgPerSession: project.sessionCount > 0 ? project.costUsd / project.sessionCount : 0,
    shareOfCostPct: (project.costUsd / totalCost) * 100
  }))
}

// ---- Filter application ----------------------------------------------------------

/** Filter the snapshot's top sessions by the dashboard's local model + project filters. */
export function filterSessions(
  sessions: readonly SessionAnatomy[],
  visibleModels: ReadonlySet<string>,
  projectFilter: string | null
): SessionAnatomy[] {
  return sessions.filter((s) => {
    const dom = sessionDominantModel(s)
    if (dom && !visibleModels.has(dom)) return false
    if (projectFilter && s.projectPath !== projectFilter) return false
    return true
  })
}

/** All distinct model ids present anywhere in the snapshot (days + models + sessions). */
export function distinctModels(snapshot: Pick<UsageBiSnapshot, 'models' | 'days'>): string[] {
  const set = new Set<string>()
  for (const m of snapshot.models) set.add(m.model)
  for (const d of snapshot.days) for (const model of Object.keys(d.costByModel)) set.add(model)
  return [...set].sort()
}

/**
 * Trailing path segment of a project path, for compact display (the "Top
 * projects" rank list) — the explorer table keeps the FULL path (it's a data
 * surface, disambiguation matters there); the rank list is a glance surface
 * where "harnu" reads faster than the whole absolute path. Falls back to the
 * full path for a root-only path (`/`) or an empty string.
 */
export function projectBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  const base = idx >= 0 ? trimmed.slice(idx + 1) : trimmed
  return base || path
}
