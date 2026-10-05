/**
 * Pure decision + rollup + plan-fit core for the usage-history / BI feature
 * (issue #19). Zero electron/fs deps — unit-tested in the `node` vitest env
 * (`tests/usage-history-core.test.ts`). The imperative shell that owns the
 * daily-rotated JSONL storage, the capture hook, and the IPC lives in
 * `usage-history.ts`; the published tier weights live in `plan-tiers.ts`.
 *
 * Layers:
 *  1. Capture — {@link decideHistoryWrites} downsamples the per-turn telemetry
 *     into at-most-one-sample-per-5min (+ a forced sample on window rollover or
 *     a ≥2pp delta), and emits a {@link WindowRecord} when a rate-limit window
 *     rolls over (the BI gold: the peak % the window hit).
 *  2. Boot reconcile — {@link reconcileWindowsOnBoot} closes any window that
 *     rolled over while the app was shut, and flags windows we joined mid-flight
 *     as `partial` so they never bias the calculator.
 *  3. Rollups — {@link buildRollups} folds samples into per-day aggregates.
 *  4. Plan-fit — {@link projectPlanFit} is a deterministic projection of the
 *     observed peak distribution onto another tier (no LLM).
 */

import { quotaRatio, type PlanTier } from './plan-tiers'

// ---- Tunables (exported so tests can reference, not redefine) --------------

/** Minimum spacing between persisted samples (downsample floor). */
export const SAMPLE_MIN_INTERVAL_MS = 5 * 60_000
/** A percentage-point delta this large forces an off-cadence sample. */
export const SAMPLE_DELTA_PP = 2
/** Known rate-limit window durations, used for partial-window detection. */
export const WINDOW_DURATION_MS = {
  fiveHour: 5 * 3600_000,
  sevenDay: 7 * 24 * 3600_000
} as const
/**
 * Grace after a window's start within which we still count it as "complete".
 * Joining a window later than this flags it `partial` (we missed its early life,
 * so its recorded peak can't be trusted as the true peak).
 */
export function partialGraceMs(kind: WindowKind): number {
  return Math.max(SAMPLE_MIN_INTERVAL_MS, WINDOW_DURATION_MS[kind] * 0.05)
}
/** Minimum complete windows of a kind before the calculator will project. */
export const MIN_WINDOWS_FOR_FIT = 3

export type WindowKind = 'fiveHour' | 'sevenDay'

// ---- Wire / storage shapes -------------------------------------------------

/** A downsampled point-in-time reading persisted to the samples JSONL. */
export interface UsageSample {
  /** Epoch ms. */
  t: number
  /** Fleet total cost (USD) at sample time — LOCAL-only (this machine's tabs). */
  costUsd: number
  /** Live session count — LOCAL-only. */
  sessionCount: number
  /** Account-wide 5h rate-limit used %, or `null` when unknown. */
  fiveHourPct: number | null
  /** Account-wide 7d rate-limit used %, or `null` when unknown. */
  sevenDayPct: number | null
}

/** A closed rate-limit window: the peak % it reached. The BI gold (~5 rows/day). */
export interface WindowRecord {
  kind: WindowKind
  /** The `resets_at` (epoch ms) that identified this window. */
  resetsAtMs: number
  /** Estimated window start (`resetsAtMs - duration`). */
  startedAtMs: number
  /** Highest `used_percentage` observed during the window. */
  peakPct: number
  /** `true` when we joined the window late / missed its tail (app was closed). */
  partial: boolean
  /** Epoch ms the close was recorded. */
  closedAtMs: number
}

/** In-progress tracking for ONE rate-limit window. */
export interface WindowProgress {
  resetsAtMs: number
  startedAtMs: number
  peakPct: number
  /** `true` when the window's start was observed later than the grace window. */
  partial: boolean
}

/** Persisted capture state (carried across runs for boot reconcile). */
export interface HistoryState {
  lastSampleAtMs: number | null
  lastSampleFiveHourPct: number | null
  lastSampleSevenDayPct: number | null
  fiveHour: WindowProgress | null
  sevenDay: WindowProgress | null
}

export function emptyHistoryState(): HistoryState {
  return {
    lastSampleAtMs: null,
    lastSampleFiveHourPct: null,
    lastSampleSevenDayPct: null,
    fiveHour: null,
    sevenDay: null
  }
}

/** A single live reading folded from the fleet telemetry (capture input). */
export interface LiveReading {
  costUsd: number
  sessionCount: number
  fiveHour: { usedPercent: number; resetsAtMs: number | null } | null
  sevenDay: { usedPercent: number; resetsAtMs: number | null } | null
}

/** What {@link decideHistoryWrites} resolved: rows to append + the next state. */
export interface HistoryWrites {
  sample: UsageSample | null
  windows: WindowRecord[]
  next: HistoryState
}

// ---- 1. Capture ------------------------------------------------------------

function startedAtMsFor(kind: WindowKind, resetsAtMs: number): number {
  return resetsAtMs - WINDOW_DURATION_MS[kind]
}

/**
 * Advance one window's progress against a new reading. Returns the (possibly
 * unchanged) next progress and a closed {@link WindowRecord} when the window
 * rolled over (its `resets_at` changed).
 */
function advanceWindow(
  kind: WindowKind,
  prev: WindowProgress | null,
  reading: { usedPercent: number; resetsAtMs: number | null } | null,
  nowMs: number
): { next: WindowProgress | null; closed: WindowRecord | null; rolled: boolean } {
  if (!reading || reading.resetsAtMs === null) {
    return { next: prev, closed: null, rolled: false }
  }
  const { usedPercent, resetsAtMs } = reading
  const startedAtMs = startedAtMsFor(kind, resetsAtMs)

  if (!prev) {
    const partial = nowMs - startedAtMs > partialGraceMs(kind)
    return {
      next: { resetsAtMs, startedAtMs, peakPct: usedPercent, partial },
      closed: null,
      rolled: false
    }
  }

  if (prev.resetsAtMs === resetsAtMs) {
    return {
      next: { ...prev, peakPct: Math.max(prev.peakPct, usedPercent) },
      closed: null,
      rolled: false
    }
  }

  // Rollover: the previous window closed. Emit its record, start the new one.
  const closed: WindowRecord = {
    kind,
    resetsAtMs: prev.resetsAtMs,
    startedAtMs: prev.startedAtMs,
    peakPct: prev.peakPct,
    partial: prev.partial,
    closedAtMs: nowMs
  }
  const partial = nowMs - startedAtMs > partialGraceMs(kind)
  return {
    next: { resetsAtMs, startedAtMs, peakPct: usedPercent, partial },
    closed,
    rolled: true
  }
}

/**
 * Decide what to persist for one live reading. Pure & total — never throws.
 *
 * A sample is written when (a) it's the first one, (b) ≥ {@link
 * SAMPLE_MIN_INTERVAL_MS} elapsed since the last, (c) a window rolled over, or
 * (d) either rate-limit % moved ≥ {@link SAMPLE_DELTA_PP} since the last sample.
 * This keeps volume to ~KB/day with no per-turn append.
 */
export function decideHistoryWrites(
  prev: HistoryState,
  reading: LiveReading,
  nowMs: number
): HistoryWrites {
  const five = advanceWindow('fiveHour', prev.fiveHour, reading.fiveHour, nowMs)
  const seven = advanceWindow('sevenDay', prev.sevenDay, reading.sevenDay, nowMs)

  const windows: WindowRecord[] = []
  if (five.closed) windows.push(five.closed)
  if (seven.closed) windows.push(seven.closed)
  const rolled = five.rolled || seven.rolled

  const fivePct = reading.fiveHour?.usedPercent ?? null
  const sevenPct = reading.sevenDay?.usedPercent ?? null

  const deltaFive =
    fivePct !== null && prev.lastSampleFiveHourPct !== null
      ? Math.abs(fivePct - prev.lastSampleFiveHourPct)
      : prev.lastSampleFiveHourPct === null && fivePct !== null
        ? Infinity
        : 0
  const deltaSeven =
    sevenPct !== null && prev.lastSampleSevenDayPct !== null
      ? Math.abs(sevenPct - prev.lastSampleSevenDayPct)
      : prev.lastSampleSevenDayPct === null && sevenPct !== null
        ? Infinity
        : 0

  const dueByInterval =
    prev.lastSampleAtMs === null || nowMs - prev.lastSampleAtMs >= SAMPLE_MIN_INTERVAL_MS
  const dueByDelta = deltaFive >= SAMPLE_DELTA_PP || deltaSeven >= SAMPLE_DELTA_PP
  const writeSample = dueByInterval || dueByDelta || rolled

  const sample: UsageSample | null = writeSample
    ? {
        t: nowMs,
        costUsd: reading.costUsd,
        sessionCount: reading.sessionCount,
        fiveHourPct: fivePct,
        sevenDayPct: sevenPct
      }
    : null

  const next: HistoryState = {
    lastSampleAtMs: writeSample ? nowMs : prev.lastSampleAtMs,
    lastSampleFiveHourPct: writeSample ? fivePct : prev.lastSampleFiveHourPct,
    lastSampleSevenDayPct: writeSample ? sevenPct : prev.lastSampleSevenDayPct,
    fiveHour: five.next,
    sevenDay: seven.next
  }

  return { sample, windows, next }
}

// ---- 2. Boot reconcile -----------------------------------------------------

/**
 * On boot, close any window that rolled over while the app was shut and reset
 * progress from the first fresh reading. A window whose `resets_at` changed
 * during downtime is emitted with `partial: true` (we missed its tail); the new
 * window inherits `partial` from whether we joined it after its start grace.
 *
 * `firstReading` may be `null` when telemetry hasn't reported yet at boot — then
 * we only carry the persisted progress forward unchanged (nothing to close yet).
 */
export function reconcileWindowsOnBoot(
  persisted: HistoryState | null,
  firstReading: LiveReading | null,
  nowMs: number
): { windows: WindowRecord[]; next: HistoryState } {
  const prev = persisted ?? emptyHistoryState()
  if (!firstReading) return { windows: [], next: prev }

  const windows: WindowRecord[] = []

  function reconcileKind(
    kind: WindowKind,
    progress: WindowProgress | null,
    reading: { usedPercent: number; resetsAtMs: number | null } | null
  ): WindowProgress | null {
    if (!reading || reading.resetsAtMs === null) return progress
    const startedAtMs = startedAtMsFor(kind, reading.resetsAtMs)
    if (progress && progress.resetsAtMs !== reading.resetsAtMs) {
      // Closed during downtime — its real tail is lost, so flag partial.
      windows.push({
        kind,
        resetsAtMs: progress.resetsAtMs,
        startedAtMs: progress.startedAtMs,
        peakPct: progress.peakPct,
        partial: true,
        closedAtMs: nowMs
      })
    }
    if (progress && progress.resetsAtMs === reading.resetsAtMs) {
      // Same window — but we were off for part of it, so it can't be complete.
      return {
        ...progress,
        peakPct: Math.max(progress.peakPct, reading.usedPercent),
        partial: true
      }
    }
    const partial = nowMs - startedAtMs > partialGraceMs(kind)
    return { resetsAtMs: reading.resetsAtMs, startedAtMs, peakPct: reading.usedPercent, partial }
  }

  const next: HistoryState = {
    lastSampleAtMs: null,
    lastSampleFiveHourPct: firstReading.fiveHour?.usedPercent ?? null,
    lastSampleSevenDayPct: firstReading.sevenDay?.usedPercent ?? null,
    fiveHour: reconcileKind('fiveHour', prev.fiveHour, firstReading.fiveHour),
    sevenDay: reconcileKind('sevenDay', prev.sevenDay, firstReading.sevenDay)
  }

  return { windows, next }
}

// ---- 3. Rollups ------------------------------------------------------------

export interface DailyRollup {
  /** Day key `YYYY-MM-DD` (local timezone by default — see {@link buildRollups}). */
  day: string
  /** Samples that contributed to this day. */
  sampleCount: number
  /** Peak account-wide 5h % seen that day, or `null` if never reported. */
  fiveHourPeak: number | null
  /** Peak account-wide 7d % seen that day, or `null` if never reported. */
  sevenDayPeak: number | null
  /** Peak fleet cost (USD) sample that day — LOCAL-only. */
  costPeakUsd: number
  /** Peak live session count that day — LOCAL-only. */
  sessionPeak: number
  /** A weekly (7d) cap reset that happened mid-day, if any. */
  weeklyReset: { atMs: number; prePct: number; postPct: number } | null
}

/**
 * UTC `YYYY-MM-DD` for an epoch-ms timestamp. STORAGE key only (sample-file
 * rotation + retention), where a machine-independent name matters.
 */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Local-timezone `YYYY-MM-DD` for an epoch-ms timestamp. The DISPLAY day key:
 * rollups group by the user's own day, so evening work doesn't spill into
 * "tomorrow" (on UTC−3 everything after 21:00 would shift a day otherwise).
 */
export function localDayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Fold samples into per-day aggregates, sorted ascending by day. Peaks use
 * `max` (the meaningful summary for usage %); cost/sessions are local-only.
 * Days are keyed by `dayKey` — {@link localDayKey} by default; tests inject
 * {@link utcDayKey} to stay timezone-deterministic.
 *
 * `windows` (default `[]`, backward-compatible with every existing call site)
 * supplies closed rate-limit windows. For each `sevenDay` window whose
 * `resetsAtMs` falls inside a day (via the same `dayKey`), that day's
 * `weeklyReset` is set: `prePct` is the window's own `peakPct` (a 7d window is
 * monotonic, so its peak at close time IS the value right before the reset —
 * no need to re-scan samples for that side); `postPct` is the max
 * `sevenDayPct` among that day's samples at/after `resetsAtMs` (the new window
 * as it progresses through the rest of the day).
 */
export function buildRollups(
  samples: readonly UsageSample[],
  dayKey: (ms: number) => string = localDayKey,
  windows: readonly WindowRecord[] = []
): DailyRollup[] {
  const byDay = new Map<string, DailyRollup>()
  const samplesByDay = new Map<string, UsageSample[]>()
  for (const s of samples) {
    const day = dayKey(s.t)
    let r = byDay.get(day)
    if (!r) {
      r = {
        day,
        sampleCount: 0,
        fiveHourPeak: null,
        sevenDayPeak: null,
        costPeakUsd: 0,
        sessionPeak: 0,
        weeklyReset: null
      }
      byDay.set(day, r)
    }
    r.sampleCount++
    if (s.fiveHourPct !== null) r.fiveHourPeak = Math.max(r.fiveHourPeak ?? 0, s.fiveHourPct)
    if (s.sevenDayPct !== null) r.sevenDayPeak = Math.max(r.sevenDayPeak ?? 0, s.sevenDayPct)
    r.costPeakUsd = Math.max(r.costPeakUsd, s.costUsd)
    r.sessionPeak = Math.max(r.sessionPeak, s.sessionCount)

    let daySamples = samplesByDay.get(day)
    if (!daySamples) {
      daySamples = []
      samplesByDay.set(day, daySamples)
    }
    daySamples.push(s)
  }

  // The windows log is append-only and noisy: the same 7d window (one
  // `resetsAtMs`) appears in many snapshots with different `peakPct` values,
  // not necessarily in peak order. Collapse to the TRUE peak per reset — the
  // last-appended record is not reliably the max.
  const peakByReset = new Map<number, number>()
  for (const w of windows) {
    if (w.kind !== 'sevenDay') continue
    peakByReset.set(w.resetsAtMs, Math.max(peakByReset.get(w.resetsAtMs) ?? 0, w.peakPct))
  }

  for (const [resetsAtMs, prePct] of peakByReset) {
    const day = dayKey(resetsAtMs)
    const r = byDay.get(day)
    if (!r) continue // no samples that day — nothing to attach the split to
    const postPct = newWindowPeakAfterReset(samplesByDay.get(day) ?? [], resetsAtMs)
    r.weeklyReset = { atMs: resetsAtMs, prePct, postPct }
  }

  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
}

/** A fresh 7d window's first genuine reading is near zero; a post-reset sample
 *  at/below this is treated as the new window settling in (the reset "drop"). */
const NEW_WINDOW_START_MAX_PCT = 25
/** After the reset, real usage only climbs gradually. A jump this far above the
 *  new window's running peak is a stale old-window reading (a straggler), not
 *  real new-window usage — the account API keeps returning the old window's
 *  high value for a while after a mid-day reset. */
const STRAGGLER_JUMP_PCT = 30

/**
 * The NEW weekly window's peak usage on the reset day, ignoring stale
 * old-window readings. After a mid-day reset the account API keeps reporting
 * the OLD window's high `sevenDayPct` for a while — samples at `t >=
 * resetsAtMs` that still read ~the old peak. A naive `max` over post-reset
 * samples captures those and reports the OLD window's peak as the "after
 * reset" value (the tell: the next day's value is then far lower). Instead:
 * find the reset drop (first post-reset sample low enough to be the fresh
 * window), then track the new window's rising peak, rejecting any later sample
 * that jumps implausibly far above it.
 */
export function newWindowPeakAfterReset(
  daySamples: readonly UsageSample[],
  resetsAtMs: number
): number {
  const post = daySamples
    .filter(
      (s): s is UsageSample & { sevenDayPct: number } => s.sevenDayPct !== null && s.t >= resetsAtMs
    )
    .sort((a, b) => a.t - b.t)
  const dropIdx = post.findIndex((s) => s.sevenDayPct <= NEW_WINDOW_START_MAX_PCT)
  if (dropIdx === -1) return 0 // the fresh window never settled in this day's samples
  let peak = 0
  for (let i = dropIdx; i < post.length; i++) {
    const pct = post[i].sevenDayPct
    if (pct >= peak + STRAGGLER_JUMP_PCT) continue // stale old-window straggler
    if (pct > peak) peak = pct
  }
  return peak
}

// ---- 4. Plan-fit calculator ------------------------------------------------

export type PlanFitVerdict = 'comfortable' | 'tight' | 'over' | 'insufficient_data'

export interface PlanFitWindowStat {
  kind: WindowKind
  /** Complete (non-partial) windows of this kind used for the stats. */
  count: number
  medianPct: number
  p95Pct: number
  maxPct: number
  projectedMedianPct: number
  projectedP95Pct: number
  projectedMaxPct: number
  /** Fraction of windows whose projection would exceed 100%. */
  exceedRate: number
}

export interface PlanFitResult {
  fromTier: string
  toTier: string
  /** The applied projection factor (`fromQuota / toQuota`, or the override). */
  ratio: number | null
  verdict: PlanFitVerdict
  stats: PlanFitWindowStat[]
}

/** Linear-interpolated percentile of a numeric sample (0..100 input p). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

export interface PlanFitOptions {
  /** Override the published projection factor (manual ratio). */
  ratioOverride?: number
  /**
   * Only consider windows closed at/after this epoch-ms (recency scope). Without
   * it the whole history weighs in and months-old behavior biases the verdict.
   */
  sinceMs?: number
}

/**
 * Deterministic plan-fit projection. Uses ONLY complete (non-partial) windows,
 * projects their peak distribution onto `toTier` via the quota ratio, and
 * reports how often the projection would exceed 100%. Returns a per-kind stat
 * list and an overall verdict. `insufficient_data` when no kind has ≥
 * {@link MIN_WINDOWS_FOR_FIT} complete windows, or the ratio is unknown.
 */
export function projectPlanFit(
  windows: readonly WindowRecord[],
  fromTier: string,
  toTier: string,
  opts: PlanFitOptions = {}
): PlanFitResult {
  const ratio = opts.ratioOverride ?? quotaRatio(fromTier, toTier)
  const since = opts.sinceMs ?? -Infinity
  const complete = windows.filter((w) => !w.partial && w.closedAtMs >= since)

  const stats: PlanFitWindowStat[] = []
  for (const kind of ['fiveHour', 'sevenDay'] as const) {
    const peaks = complete.filter((w) => w.kind === kind).map((w) => w.peakPct)
    if (peaks.length === 0) continue
    const factor = ratio ?? 1
    const projected = peaks.map((p) => p * factor)
    stats.push({
      kind,
      count: peaks.length,
      medianPct: percentile(peaks, 50),
      p95Pct: percentile(peaks, 95),
      maxPct: Math.max(...peaks),
      projectedMedianPct: percentile(projected, 50),
      projectedP95Pct: percentile(projected, 95),
      projectedMaxPct: Math.max(...projected),
      exceedRate: projected.filter((p) => p > 100).length / projected.length
    })
  }

  const enough = stats.some((s) => s.count >= MIN_WINDOWS_FOR_FIT)
  let verdict: PlanFitVerdict
  if (ratio === null || !enough) {
    verdict = 'insufficient_data'
  } else {
    const usable = stats.filter((s) => s.count >= MIN_WINDOWS_FOR_FIT)
    const worstExceed = Math.max(...usable.map((s) => s.exceedRate))
    const worstP95 = Math.max(...usable.map((s) => s.projectedP95Pct))
    if (worstExceed > 0.1) verdict = 'over'
    else if (worstP95 >= 80) verdict = 'tight'
    else verdict = 'comfortable'
  }

  return { fromTier, toTier, ratio, verdict, stats }
}

/** The smallest tier the observed peaks fit into (see {@link recommendTier}). */
export interface TierRecommendation {
  tierId: string
  /** `comfortable` when it truly fits; `tight` when only a tight fit exists. */
  verdict: PlanFitVerdict
}

/**
 * Recommend the smallest plan that fits the observed peak distribution: scan
 * `tiers` ascending by quota, projecting from `fromTier` onto each, and return
 * the first with a `comfortable` verdict — falling back to the smallest `tight`
 * one. `null` when the data is insufficient (never guesses). Deterministic:
 * same math as {@link projectPlanFit}, no override (a manual ratio is pairwise
 * and doesn't generalize across the scan).
 */
export function recommendTier(
  windows: readonly WindowRecord[],
  fromTier: string,
  tiers: readonly PlanTier[],
  opts: Pick<PlanFitOptions, 'sinceMs'> = {}
): TierRecommendation | null {
  const ranked = [...tiers].sort((a, b) => a.quota - b.quota)
  let tight: TierRecommendation | null = null
  for (const t of ranked) {
    const fit = projectPlanFit(windows, fromTier, t.id, opts)
    if (fit.verdict === 'insufficient_data') return null
    if (fit.verdict === 'comfortable') return { tierId: t.id, verdict: 'comfortable' }
    if (fit.verdict === 'tight' && !tight) tight = { tierId: t.id, verdict: 'tight' }
  }
  return tight
}

// ---- 5. Hour × weekday heatmap ("when do I use it?") -----------------------

/** One heatmap cell: mean 5h% for a (local weekday, hour-bucket) over the scope. */
export interface HeatCell {
  /** Local weekday, 0 = Sunday … 6 = Saturday. */
  dow: number
  /** Hour bucket index `[0, buckets)`; each spans `24/buckets` hours. */
  bucket: number
  /** Mean observed 5h `used_percentage` in the cell, or `null` when never seen. */
  avgPct: number | null
  /** Samples that fell in the cell. */
  n: number
}

export interface UsageHeatmap {
  /** Hour buckets per day (12 → 2h each). */
  buckets: number
  /** Dense grid, length `7 * buckets`, row-major by `dow` then `bucket`. */
  cells: HeatCell[]
  /** Max `avgPct` across all cells — the color-ramp ceiling. `null` when empty. */
  maxAvgPct: number | null
  /** The single heaviest cell (highest mean 5h%), for the "busiest time" tile. */
  heaviest: { dow: number; hourStart: number; hourEnd: number; avgPct: number } | null
}

/**
 * Fold samples into a local weekday × hour-bucket grid of the mean 5h usage —
 * the "when do I actually use it?" view. Local time (weekday/hour from the
 * runtime TZ, matching {@link localDayKey}); only samples with a non-null
 * `fiveHourPct` in the last `days` count. Dense grid so the renderer can map it
 * directly. Pure & total.
 */
export function buildHeatmap(
  samples: readonly UsageSample[],
  nowMs: number,
  days = 28,
  buckets = 12
): UsageHeatmap {
  const cutoff = nowMs - days * 24 * 3600_000
  const span = 24 / buckets
  const sum = new Array(7 * buckets).fill(0)
  const cnt = new Array(7 * buckets).fill(0)
  for (const s of samples) {
    if (s.fiveHourPct === null || s.t < cutoff) continue
    const d = new Date(s.t)
    const idx = d.getDay() * buckets + Math.min(buckets - 1, Math.floor(d.getHours() / span))
    sum[idx] += s.fiveHourPct
    cnt[idx]++
  }
  const cells: HeatCell[] = []
  let maxAvgPct: number | null = null
  let heaviest: UsageHeatmap['heaviest'] = null
  for (let dow = 0; dow < 7; dow++) {
    for (let bucket = 0; bucket < buckets; bucket++) {
      const i = dow * buckets + bucket
      const n = cnt[i]
      const avgPct = n > 0 ? sum[i] / n : null
      cells.push({ dow, bucket, avgPct, n })
      if (avgPct !== null) {
        if (maxAvgPct === null || avgPct > maxAvgPct) maxAvgPct = avgPct
        if (!heaviest || avgPct > heaviest.avgPct) {
          heaviest = { dow, hourStart: bucket * span, hourEnd: (bucket + 1) * span, avgPct }
        }
      }
    }
  }
  return { buckets, cells, maxAvgPct, heaviest }
}

/**
 * The 7d percentage at the moment a given local day began (daily-budget spec).
 *
 * A 7d window only ever grows within its own period, so the PREVIOUS day's peak
 * is exactly the value at midnight. When the window reset earlier today the
 * baseline is 0 instead: the new window started empty, and everything spent
 * before the reset was charged to the previous week.
 *
 * @param rollups Ascending by day, as {@link buildRollups} returns.
 * @param dayKey The local day to compute the baseline for.
 */
export function pickBaseline(rollups: readonly DailyRollup[], dayKey: string): number | null {
  const today = rollups.find((r) => r.day === dayKey)
  if (today?.weeklyReset) return 0
  let prior: DailyRollup | null = null
  for (const r of rollups) {
    if (r.day < dayKey) prior = r
  }
  return prior?.sevenDayPeak ?? null
}
