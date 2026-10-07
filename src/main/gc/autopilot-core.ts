// Pure autopilot decisions (design: workspace-gc §6). What a cycle may clean, and nothing
// else: every I/O step lives in gc-cycle.ts behind injected deps.

import type { WorktreeBundle } from './bundle-core'
import type { GcPrefs } from './gc-prefs'
import { normalizePath } from '../containers/containers-core'

export type CycleMode = 'off' | 'report' | 'clean'

export interface CyclePlan {
  mode: CycleMode
  /** Corpses to clean now, oldest sign of life first, capped. Always empty unless `clean`. */
  toClean: WorktreeBundle[]
  /** Eligible corpses left for a later cycle by the per-cycle cap. */
  deferred: number
  /** Eligible corpses: past `neverClean`, `keep` and main-checkout exclusions. */
  found: number
  /** Disk the eligible corpses occupy, for the report-only notice. */
  reportBytes: number
}

/** True when the bundle's worktree, or the repo it belongs to, is on the neverClean list. */
export function isNeverClean(b: WorktreeBundle, prefs: GcPrefs): boolean {
  if (b.neverClean) return true
  if (prefs.neverClean.length === 0) return false
  const platform = process.platform
  const listed = new Set(prefs.neverClean.map((p) => normalizePath(p, platform)))
  const candidates = [b.item.path, b.item.repoPath].filter((p): p is string => !!p)
  return candidates.some((p) => listed.has(normalizePath(p, platform)))
}

const bySignOfLife = (a: WorktreeBundle, b: WorktreeBundle): number => {
  // No sign of life sorts last: its age is unknown, so it is the least certain to take first.
  if (a.lastSignOfLifeAt === b.lastSignOfLifeAt) return 0
  if (a.lastSignOfLifeAt === null) return 1
  if (b.lastSignOfLifeAt === null) return -1
  return a.lastSignOfLifeAt - b.lastSignOfLifeAt
}

/**
 * `off` when the autopilot or the worktrees category is off. `report` until the operator has
 * acknowledged the first report: it finds and counts, and returns nothing to clean. `clean`
 * otherwise: corpses only, minus neverClean, oldest first, capped at `maxItemsPerCycle`.
 */
export function planCycle(bundles: readonly WorktreeBundle[], prefs: GcPrefs): CyclePlan {
  if (!prefs.autopilot || !prefs.categories.worktrees) {
    return { mode: 'off', toClean: [], deferred: 0, found: 0, reportBytes: 0 }
  }
  const eligible = bundles
    .filter((b) => b.bucket === 'corpse' && !b.keep && !b.isMainCheckout && !isNeverClean(b, prefs))
    .sort(bySignOfLife)
  const reportBytes = eligible.reduce((sum, b) => sum + (b.item.diskBytes ?? 0), 0)
  if (!prefs.firstReportAcknowledged) {
    return { mode: 'report', toClean: [], deferred: 0, found: eligible.length, reportBytes }
  }
  const toClean = eligible.slice(0, prefs.maxItemsPerCycle)
  return {
    mode: 'clean',
    toClean,
    deferred: eligible.length - toClean.length,
    found: eligible.length,
    reportBytes
  }
}

// ---- failures: a corpse that keeps failing is a decision, not a retry loop -----------------

/** A halted cleanup, remembered in memory until it succeeds, the worktree is gone, or a day passes. */
export interface CycleFailure {
  step: string
  error: string
  at: number
}

/** How long a failed cleanup stays a decision before the autopilot may try it again. */
export const FAILURE_TTL_MS = 86_400_000

/** Drops failures for worktrees that no longer exist and those old enough to retry. */
export function pruneFailures(
  failures: Map<string, CycleFailure>,
  bundles: readonly WorktreeBundle[],
  now: number
): void {
  const present = new Set(bundles.map((b) => b.item.id))
  for (const [id, f] of failures) {
    if (!present.has(id) || now - f.at >= FAILURE_TTL_MS) failures.delete(id)
  }
}

/**
 * Spec §4: a halted item reappears in Decide with the step and the error. Only a corpse is
 * rewritten; anything else is already a decision or off limits.
 */
export function applyFailures(
  bundles: readonly WorktreeBundle[],
  failures: ReadonlyMap<string, CycleFailure>
): WorktreeBundle[] {
  return bundles.map((b) => {
    const f = b.bucket === 'corpse' ? failures.get(b.item.id) : undefined
    if (!f) return b
    return {
      ...b,
      bucket: 'decide' as const,
      reason: {
        code: 'cleanup-failed' as const,
        detail: `Cleanup stopped at ${f.step}: ${f.error}`
      }
    }
  })
}
