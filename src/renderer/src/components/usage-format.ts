/**
 * Pure presentational helpers for the Plan-usage meter (design.md §6 — Plan
 * usage). Kept framework-free so they're unit-testable in the `node` vitest env
 * (`tests/usage-format.test.ts`); the `.vue` components are thin templates over
 * these.
 */
import type { FleetTelemetry, UsageSnapshot, UsageBucket, RateWindow } from '../../../preload'

/** Clamp a percentage into the 0..100 render range. Non-finite → 0. */
export function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}

/**
 * Bar fill color by usage threshold (design.md §6). Accent stays a *signal*
 * ("near the cap"), never decoration: green < 80%, accent 80–95%, red ≥ 95%.
 */
export function barClass(usedPercent: number): string {
  if (usedPercent >= 95) return 'bg-red'
  if (usedPercent >= 80) return 'bg-accent'
  return 'bg-green'
}

/**
 * Text color for an inline context-usage % (sidebar row chip + footer status
 * bar). Same 80/95 breakpoints as {@link barClass}, but muted below 80 (an
 * inline text chip isn't a signal until it nears the cap, unlike the meter fill
 * which is always colored): `text-text-4` < 80, `text-accent` 80–95, `text-red`
 * ≥ 95.
 */
export function contextTextClass(pct: number): string {
  if (pct >= 95) return 'text-red'
  if (contextIsSignal(pct)) return 'text-accent'
  return 'text-text-4'
}

/**
 * Whether a context % reads as a *signal* (≥ 80 — the same breakpoint where
 * {@link contextTextClass} starts coloring it). Below this the sidebar chip is
 * quiet and hover-only (design.md §6 "Stats sob demanda", T118); at/above it the
 * chip stays permanently visible so the near-/compact warning is never hidden.
 */
export function contextIsSignal(pct: number): boolean {
  return pct >= 80
}

/**
 * Text color for an inline usage % in the footer **HUD** (left context chip +
 * right 5h/7d fleet chips). The footer reads brighter than the sidebar on
 * purpose (design.md §6): the baseline is the readable HUD tone (`text-text-2`,
 * same as the rest of the bar) and `%` only diverges to a *signal* color near
 * the cap, on the same 80/95 breakpoints as {@link barClass}: `text-text-2`
 * < 80, `text-accent` 80–95, `text-red` ≥ 95. Use this — not
 * {@link contextTextClass} (the muted sidebar variant) — anywhere in the footer.
 */
export function footerPctClass(pct: number): string {
  if (pct >= 95) return 'text-red'
  if (pct >= 80) return 'text-accent'
  return 'text-text-2'
}

/** Compact human duration for a reset countdown: `57m`, `1h`, `4d`, `<1m`. */
export function humanizeDuration(ms: number): string {
  if (ms <= 0) return '0m'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '<1m'
  if (min < 60) return `${min}m`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * Time remaining in a footer fleet chip's window ("3h", "2d"), or `null` when
 * there's nothing live to show — no `resetsAtMs`, or it's already past (a
 * stale window shouldn't print a stale "0m"/"<1m" as if it were counting down).
 * Callers degrade to the plain id+% chip render when this returns `null`.
 */
export function footerWindowCountdown(resetsAtMs: number | null, nowMs: number): string | null {
  if (resetsAtMs == null) return null
  const delta = resetsAtMs - nowMs
  if (delta <= 0) return null
  return humanizeDuration(delta)
}

/**
 * How a bucket's reset should render: a relative countdown (with the raw
 * absolute string kept for a `title` tooltip — design.md §6) when the reset is
 * parseable and still in the future, else the raw absolute text, else nothing.
 * Pure so `UsagePanel`'s reset logic is testable without i18n.
 */
export type ResetDisplay =
  | { kind: 'relative'; time: string; title: string }
  | { kind: 'absolute'; text: string }
  | { kind: 'none' }

export function resetDisplay(
  resetsAtMs: number | null,
  resetsAtText: string,
  nowMs: number
): ResetDisplay {
  if (resetsAtMs != null) {
    const delta = resetsAtMs - nowMs
    if (delta > 0) return { kind: 'relative', time: humanizeDuration(delta), title: resetsAtText }
  }
  if (resetsAtText) return { kind: 'absolute', text: resetsAtText }
  return { kind: 'none' }
}

// ── Rate-limit source merge (freshest wins) ─────────────────────────────────

/**
 * One rate-limit window with provenance: which source produced it and when.
 * `resetsAtText` is the raw absolute string when the datum came from `/usage`
 * (kept for the tooltip, same as the bucket rows); `''` from the cockpit.
 */
export interface MergedRateWindow {
  usedPercent: number
  resetsAtMs: number | null
  resetsAtText: string
  /** Epoch ms the source datum was produced (blob mtime / `/usage` fetch). */
  updatedAtMs: number
  source: 'statusline' | 'usage'
}

export interface MergedRateLimits {
  fiveHour: MergedRateWindow | null
  sevenDay: MergedRateWindow | null
}

function fromCockpit(
  w: RateWindow | null | undefined,
  atMs: number | null
): MergedRateWindow | null {
  if (!w || atMs == null) return null
  return {
    usedPercent: w.usedPercent,
    resetsAtMs: w.resetsAtMs,
    resetsAtText: '',
    updatedAtMs: atMs,
    source: 'statusline'
  }
}

function fromBucket(
  b: UsageBucket | null | undefined,
  fetchedAtMs: number | null
): MergedRateWindow | null {
  if (!b || fetchedAtMs == null) return null
  return {
    usedPercent: b.usedPercent,
    resetsAtMs: b.resetsAtMs,
    resetsAtText: b.resetsAtText,
    updatedAtMs: fetchedAtMs,
    source: 'usage'
  }
}

/**
 * Pick ONE window from the two candidates: prefer candidates whose reset moment
 * hasn't passed (a window past its reset reads a stale, definitionally-wrong %),
 * then the most recently produced. When every candidate is past its reset, still
 * show the freshest one (honest "last known" beats a blank meter).
 */
function pickFreshest(
  a: MergedRateWindow | null,
  b: MergedRateWindow | null,
  nowMs: number
): MergedRateWindow | null {
  const pool = [a, b].filter((c): c is MergedRateWindow => c !== null)
  if (pool.length === 0) return null
  const alive = pool.filter((c) => c.resetsAtMs == null || c.resetsAtMs > nowMs)
  const pickFrom = alive.length ? alive : pool
  return pickFrom.reduce((x, y) => (y.updatedAtMs > x.updatedAtMs ? y : x))
}

/**
 * Merge the two rate-limit sources per window — the zero-token statusLine
 * cockpit (per-turn, freezes when no session takes a turn) and the `claude -p
 * "/usage"` poll (90s cadence while focused). The old rule "cockpit always
 * wins" is the staleness bug: a frozen cockpit shadowed a fresh poll for hours.
 * The 5h window pairs with the `session` bucket, the 7d window with `week_all`.
 */
export function mergeRateWindows(
  fleet: FleetTelemetry | null,
  snapshot: UsageSnapshot | null,
  nowMs: number
): MergedRateLimits {
  const fetchedAtMs = snapshot && snapshot.available ? snapshot.fetchedAtMs : null
  return {
    fiveHour: pickFreshest(
      fromCockpit(fleet?.fiveHour, fleet?.fiveHourAtMs ?? null),
      fromBucket(snapshot?.session, fetchedAtMs),
      nowMs
    ),
    sevenDay: pickFreshest(
      fromCockpit(fleet?.sevenDay, fleet?.sevenDayAtMs ?? null),
      fromBucket(snapshot?.weekAll, fetchedAtMs),
      nowMs
    )
  }
}

/**
 * Format a USD cost for the per-tab / fleet HUD (statusLine telemetry). Two
 * decimals, dollar-prefixed. `null`/non-finite → `$0.00` so a missing cost never
 * leaks `NaN` into the UI.
 */
export function formatCostUsd(n: number | null): string {
  return `$${(n != null && Number.isFinite(n) ? n : 0).toFixed(2)}`
}

/** Format added/removed line counts as `+156/-23`. `null` counts → `0`. */
export function formatLines(added: number | null, removed: number | null): string {
  return `+${added ?? 0}/-${removed ?? 0}`
}
