/**
 * Pure presentational helpers for the Usage-history / BI pane (issue #19).
 * Framework-free so they're unit-testable in the `node` vitest env
 * (`tests/usage-history-format.test.ts`); the `.vue` chart components are thin
 * templates over these. No charting library — we emit plain SVG geometry and
 * reuse {@link barClass} for the threshold colors (design contract: no raw
 * colors).
 */

import { barClass } from './usage-format'
import type {
  PlanFitResult,
  PlanFitVerdict,
  PlanFitWindowStat,
  DailyRollup,
  WindowRecord
} from '../../../preload'

export { barClass }

export interface BarRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Lay out a bar chart inside a `width × height` viewbox. Bars are evenly spaced
 * with `gap` between them; heights scale to `max` (0 → zero-height). A `null`
 * value yields a zero-height bar (a visible gap, never a fake 0-that-looks-real).
 * Pure — returns the rects; the component supplies fill classes.
 */
export function barChartRects(
  values: readonly (number | null)[],
  opts: { width: number; height: number; max: number; gap?: number }
): BarRect[] {
  const { width, height, max } = opts
  const gap = opts.gap ?? 2
  const n = values.length
  if (n === 0 || width <= 0 || height <= 0) return []
  const slot = width / n
  const barW = Math.max(1, slot - gap)
  const safeMax = max > 0 ? max : 1
  return values.map((v, i) => {
    const val = v == null ? 0 : Math.max(0, v)
    const h = Math.min(height, (val / safeMax) * height)
    return {
      x: i * slot + (slot - barW) / 2,
      y: height - h,
      width: barW,
      height: h
    }
  })
}

/** A round axis max at or above the data peak (floors at `floor`). */
export function niceMax(values: readonly (number | null)[], floor = 1): number {
  const peak = values.reduce<number>((m, v) => (v != null && v > m ? v : m), 0)
  if (peak <= floor) return floor
  const mag = Math.pow(10, Math.floor(Math.log10(peak)))
  const stepped = Math.ceil(peak / mag) * mag
  return Math.max(floor, stepped)
}

/**
 * Threshold fill class for a usage-% bar — same 80/95 breakpoints as
 * {@link barClass}, but as SVG `fill-*` utilities: the chart bars are `<rect>`s,
 * and `background-color` (`bg-*`) does not paint SVG — the rects silently
 * rendered with the default black fill (T47 P1). `null` → muted track.
 */
export function pctBarClass(v: number | null): string {
  if (v == null) return 'fill-surface-2'
  if (v >= 95) return 'fill-red'
  if (v >= 80) return 'fill-accent'
  return 'fill-green'
}

/** i18n key suffix for a plan-fit verdict (`usageHistory.verdict.<suffix>`). */
export function verdictKey(verdict: PlanFitVerdict): string {
  return verdict
}

/**
 * The window stat that drives the one-sentence verdict: the worst usable one —
 * highest `exceedRate`, tie-broken by projected p95. "Usable" mirrors the
 * calculator's own bar (`MIN_WINDOWS_FOR_FIT = 3` complete windows — pinned by
 * tests); with no usable stat, falls back to the worst of what exists so the
 * sentence never contradicts the verdict computed from the same stats.
 */
export function pickSentenceStat(result: PlanFitResult | null): PlanFitWindowStat | null {
  const all = result?.stats ?? []
  if (all.length === 0) return null
  const usable = all.filter((s) => s.count >= 3)
  const pool = usable.length > 0 ? usable : all
  return [...pool].sort(
    (a, b) => b.exceedRate - a.exceedRate || b.projectedP95Pct - a.projectedP95Pct
  )[0]
}

/** Tone class for a verdict label — green/accent/red signal, never decoration. */
export function verdictTone(verdict: PlanFitVerdict): string {
  switch (verdict) {
    case 'comfortable':
      return 'text-green'
    case 'tight':
      return 'text-accent'
    case 'over':
      return 'text-red'
    default:
      return 'text-text-3'
  }
}

/** `YYYY-MM-DD` → a short `MM/DD` axis label. */
export function shortDay(day: string): string {
  const m = day.match(/^\d{4}-(\d{2})-(\d{2})$/)
  return m ? `${m[1]}/${m[2]}` : day
}

/** Round a percentage for display; `null` → `—`. */
export function fmtPct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v)}%`
}

/** Format a chart value by unit for labels / tooltips. `null` → `—`. */
export type ChartUnit = 'pct' | 'usd' | 'count'
export function fmtUnit(v: number | null, unit: ChartUnit): string {
  if (v == null) return '—'
  if (unit === 'pct') return `${Math.round(v)}%`
  if (unit === 'usd') return `$${v.toFixed(2)}`
  return String(Math.round(v))
}

/**
 * Indices of the bars worth a direct value label: the peak (highest value) and
 * the most recent non-null bar. Deduped and sorted — so a chart labels at most
 * two bars (labeling every bar clutters; design §6 T47 P3). Empty when there's
 * no data.
 */
export function labelIndices(values: readonly (number | null)[]): number[] {
  let peak = -1
  let peakV = -Infinity
  let last = -1
  values.forEach((v, i) => {
    if (v == null) return
    last = i
    if (v > peakV) {
      peakV = v
      peak = i
    }
  })
  if (peak < 0) return []
  return peak === last ? [peak] : [peak, last].sort((a, b) => a - b)
}

/**
 * Up to `count` evenly-spaced x-axis tick positions across `n` bars — always the
 * first and last, with interior ticks spread between. Returns the indices; the
 * component maps them to day labels. Fewer bars than ticks → every bar.
 */
export function axisTickIndices(n: number, count = 4): number[] {
  if (n <= 0) return []
  if (n <= count) return Array.from({ length: n }, (_, i) => i)
  const out: number[] = []
  for (let k = 0; k < count; k++) out.push(Math.round((k / (count - 1)) * (n - 1)))
  return [...new Set(out)]
}

/**
 * The trajectory chart's period toggle (T47 P4.5 adds 60d/90d/all alongside the
 * original 24h/7d/30d — see design §6 "Usage trajectory chart").
 */
export type ChartRangeKey = '24h' | '7d' | '30d' | '60d' | '90d' | 'all'

/**
 * Weekly-spaced axis ticks: every 7th index, always including the last (a bar
 * chart's rightmost/most-recent bar). Used for 30d+ ranges where 4 evenly-spread
 * ticks lose the "which week is this" alignment a 7-day cadence gives for free.
 */
export function weeklyAxisTickIndices(n: number): number[] {
  if (n <= 0) return []
  const out: number[] = []
  for (let i = 0; i < n; i += 7) out.push(i)
  const last = n - 1
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/**
 * Range-aware axis-tick policy (design §6 T47 P4.5, "legibilidade bate-o-olho"):
 * `7d` labels every bar (a week is small enough to read at a glance without
 * skipping days), `24h` keeps the original 4-tick spread over the intraday
 * samples, and 30d/60d/90d/all get {@link weeklyAxisTickIndices} — sparse ticks
 * on a 7-day cadence instead of an arbitrary even split.
 */
export function axisTickIndicesForRange(n: number, range: ChartRangeKey): number[] {
  if (range === '7d') return axisTickIndices(n, n)
  if (range === '24h') return axisTickIndices(n, 4)
  return weeklyAxisTickIndices(n)
}

/**
 * Range-aware value-label policy: `7d` labels every non-null bar (7 numbers
 * read fine "at a glance", the whole point of the range); every other range
 * keeps the original peak+latest via {@link labelIndices} — labeling every bar
 * of a 30/60/90-day chart would just be noise.
 */
export function labelIndicesForRange(
  values: readonly (number | null)[],
  range: ChartRangeKey
): number[] {
  if (range === '7d') {
    const out: number[] = []
    values.forEach((v, i) => {
      if (v != null) out.push(i)
    })
    return out
  }
  return labelIndices(values)
}

/** The last non-null value in a series (the "now" / "today" reading). `null` if none. */
export function latestValue(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return values[i]
  return null
}

/** 5h rate-limit window duration (ms) — the "now" strip projection horizon. */
export const FIVE_HOUR_MS = 5 * 3600_000

/**
 * Linear burn-rate projection of where the CURRENT rate-limit window lands at
 * reset, from the live footer reading: `currentPct / elapsedFraction`. Early in a
 * window the fraction is tiny and the extrapolation explodes, so we floor it at
 * 10% (before then we just echo the current %). `null` when the reset time is
 * unknown. The UI frames it as "at your current pace ~X%", never a promise.
 */
export function projectWindowPeak(
  currentPct: number,
  resetsAtMs: number | null,
  nowMs: number,
  durationMs = FIVE_HOUR_MS
): number | null {
  if (resetsAtMs === null) return null
  const elapsed = nowMs - (resetsAtMs - durationMs)
  if (elapsed <= 0) return currentPct
  const frac = Math.min(1, elapsed / durationMs)
  if (frac < 0.1) return currentPct
  return currentPct / frac
}

/** The four headline KPIs, scoped to the last `days`. Pure — see design §6 (T47 P3). */
export interface UsageSummaryTiles {
  /** Complete-or-partial 5h windows that reached ≥95% in scope (the "did I hit the cap" count). */
  nearCapCount: number
  peakFivePct: number | null
  peakSevenPct: number | null
  peakCostUsd: number | null
  peakSessions: number | null
}

/**
 * Fold the rollups + windows into the four headline tiles, scoped to the last
 * `days` in the user's local timezone (matching how rollups are keyed). Peaks
 * are `null` when nothing in scope reported that metric — the tile shows `—`,
 * never a fake 0. `nearCapCount` counts observed ≥95% peaks (partial windows
 * included: a recorded peak is a real observation — partial only means a *higher*
 * peak may have been missed, never a lower one).
 */
export function summarizeUsage(
  rollups: readonly DailyRollup[],
  windows: readonly WindowRecord[],
  nowMs: number,
  days = 30
): UsageSummaryTiles {
  const cutoff = nowMs - days * 24 * 3600_000
  const inScope = rollups.filter((r) => {
    const m = r.day.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!m) return false
    return new Date(+m[1], +m[2] - 1, +m[3]).getTime() >= cutoff - 24 * 3600_000
  })
  const maxOr = (vals: (number | null)[]): number | null => {
    const nums = vals.filter((v): v is number => v != null)
    return nums.length ? Math.max(...nums) : null
  }
  return {
    nearCapCount: windows.filter(
      (w) => w.kind === 'fiveHour' && w.closedAtMs >= cutoff && w.peakPct >= 95
    ).length,
    peakFivePct: maxOr(inScope.map((r) => r.fiveHourPeak)),
    peakSevenPct: maxOr(inScope.map((r) => r.sevenDayPeak)),
    peakCostUsd: maxOr(inScope.map((r) => r.costPeakUsd)),
    peakSessions: maxOr(inScope.map((r) => r.sessionPeak))
  }
}

// ---- Reset markers + per-window mode (T47 P4.5) ----------------------------
//
// `UsageHistorySummary.windows` (WindowRecord[]) already reaches the renderer —
// every closed rate-limit window, with its exact `resetsAtMs`/`startedAtMs`.
// Two features read from it that the day-rollup charts can't show on their own:
// a vertical marker on the 7d chart where a weekly window actually closed, and
// a "by window" mode for the 5h chart (one bar per closed window instead of one
// bar per day, so a 95% window doesn't hide behind the day's peak).

/** A `WindowRecord`'s `kind` field, without importing the main-process module. */
type WindowKind = WindowRecord['kind']

/**
 * Local-timezone `YYYY-MM-DD` for an epoch-ms timestamp — duplicated (not
 * imported) from the main-process rollup builder so this renderer-side pure
 * module stays free of `src/main` imports; must format identically to the
 * `day` keys in `DailyRollup` for {@link dayIndexForMs} to line up.
 */
export function localDayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Index within `days` (ascending `YYYY-MM-DD`, one per bar) whose local day
 * matches `ms` — or `null` when that day isn't in the visible range.
 */
export function dayIndexForMs(days: readonly string[], ms: number): number | null {
  const idx = days.indexOf(localDayKey(ms))
  return idx >= 0 ? idx : null
}

/**
 * Bar indices where a window of `kind` closed (from `resetsAtMs`) — the
 * reset-marker positions for a day-labeled trajectory chart (design §6 T47
 * P4.5, the 7d rate-limit chart). Deduped + sorted; a day with no matching
 * close gets no marker.
 */
export function resetMarkerIndices(
  windows: readonly WindowRecord[],
  kind: WindowKind,
  days: readonly string[]
): number[] {
  const out = new Set<number>()
  for (const w of windows) {
    if (w.kind !== kind) continue
    const idx = dayIndexForMs(days, w.resetsAtMs)
    if (idx != null) out.add(idx)
  }
  return [...out].sort((a, b) => a - b)
}

/** Epoch-ms lower bound for a trajectory range's lookback; `'all'` → no bound. */
export function rangeSinceMs(range: ChartRangeKey, nowMs: number): number {
  if (range === 'all') return -Infinity
  const rangeDays: Record<Exclude<ChartRangeKey, 'all'>, number> = {
    '24h': 1,
    '7d': 7,
    '30d': 30,
    '60d': 60,
    '90d': 90
  }
  return nowMs - rangeDays[range] * 24 * 3600_000
}

/** `MM/DD HH:MM` local label for a window's start — the "by window" x-axis/tooltip label. */
function windowStartLabel(startedAtMs: number): string {
  const d = new Date(startedAtMs)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** One point in the 5h "by window" series — a closed window as a chart bar. */
export interface WindowSeriesPoint {
  value: number
  label: string
  partial: boolean
}

/**
 * CLOSED windows of one `kind`, chronologically ordered, as chart points — the
 * "by window" mode for the 5h chart (design §6 T47 P4.5): one bar per window
 * instead of one bar per day, so a 95% window shows beside its 30–40% same-day
 * siblings instead of being hidden behind the day's peak-of-day. `partial`
 * passes through untouched — a recorded peak is still a real observation, the
 * chart only dims it, this helper never drops or reweights it.
 */
export function windowSeriesFor(
  windows: readonly WindowRecord[],
  kind: WindowKind,
  sinceMs: number,
  nowMs: number
): WindowSeriesPoint[] {
  return windows
    .filter((w) => w.kind === kind && w.closedAtMs >= sinceMs && w.closedAtMs <= nowMs)
    .sort((a, b) => a.startedAtMs - b.startedAtMs)
    .map((w) => ({ value: w.peakPct, label: windowStartLabel(w.startedAtMs), partial: w.partial }))
}
