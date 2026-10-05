/**
 * Published Claude subscription tier quotas, used by the plan-fit calculator
 * (`usage-history-core.ts` → `projectPlanFit`). Kept as a pure, dependency-free
 * module so it's unit-testable in the `node` vitest env and importable from both
 * the main process and (type-only) the renderer.
 *
 * ⚠️ The `quota` ratios below are RELATIVE weights, not absolute token budgets,
 * and are **placeholders to confirm** (issue #19 risk #1). We observe a window's
 * `used_percentage` *relative to the current plan*; projecting "17% on Max 20×"
 * onto another tier only works if quota scales linearly with these weights. The
 * UI surfaces {@link PLAN_QUOTA_AS_OF} + a manual ratio override + a disclaimer,
 * and the calculator returns `insufficient_data` rather than guessing when it
 * lacks complete windows.
 */

/** Date the published quota ratios below were last confirmed (UI disclaimer). */
export const PLAN_QUOTA_AS_OF = '2026-06-01'

export interface PlanTier {
  /** Stable id used in prefs + IPC. */
  id: string
  /** i18n-independent display label (the UI may still localize around it). */
  label: string
  /**
   * Relative quota weight. The plan-fit projection uses the RATIO between two
   * tiers' weights, never the absolute number — see {@link quotaRatio}.
   */
  quota: number
  /** `true` while the weight is an unverified placeholder (drives the UI caveat). */
  toConfirm: boolean
}

/** Known tiers, smallest → largest quota. Placeholders marked `toConfirm`. */
export const PLAN_TIERS: readonly PlanTier[] = [
  { id: 'pro', label: 'Pro', quota: 1, toConfirm: true },
  { id: 'max5', label: 'Max 5×', quota: 5, toConfirm: true },
  { id: 'max20', label: 'Max 20×', quota: 20, toConfirm: true }
] as const

export function tierById(id: string): PlanTier | null {
  return PLAN_TIERS.find((t) => t.id === id) ?? null
}

/**
 * Projection factor for taking a `used_percentage` observed on `fromId` and
 * expressing it on `toId`: `fromQuota / toQuota`. Projecting from a larger plan
 * onto a smaller one yields a factor > 1 (the same usage eats a bigger share).
 * Returns `null` when either tier is unknown or has a non-positive quota.
 */
export function quotaRatio(fromId: string, toId: string): number | null {
  const from = tierById(fromId)
  const to = tierById(toId)
  if (!from || !to || from.quota <= 0 || to.quota <= 0) return null
  return from.quota / to.quota
}
