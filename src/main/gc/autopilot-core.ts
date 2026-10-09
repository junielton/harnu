// Pure autopilot decisions (design: workspace-gc §6). What a cycle may clean, and nothing
// else: every I/O step lives in gc-cycle.ts behind injected deps.

import type { WorktreeBundle } from './bundle-core'
import type { GcPrefs } from './gc-prefs'
import { AS_GIVEN, canonicalPathKey, type CanonicalPath } from './bundle-core'
import { isMainCheckoutByPath } from './pipeline-core'

export type CycleMode = 'off' | 'report' | 'clean'

export interface CyclePlan {
  mode: CycleMode
  /** Ready items to clean now, oldest sign of life first, capped. Always empty unless `clean`. */
  toClean: WorktreeBundle[]
  /** Eligible ready items left for a later cycle by the per-cycle cap. */
  deferred: number
  /** Eligible ready items: past `neverClean`, `keep` and main-checkout exclusions. */
  found: number
  /** Disk the eligible ready items occupy, for the report-only notice. */
  reportBytes: number
}

/** The item kinds the cleanup executor can actually remove; a detached worktree is not one. */
export const CLEANABLE_KINDS: readonly string[] = ['worktree', 'hidden-folder']

/** True when the bundle's worktree, or the repo it belongs to, is on the neverClean list. */
export function isNeverClean(
  b: WorktreeBundle,
  prefs: GcPrefs,
  canonical: CanonicalPath = AS_GIVEN
): boolean {
  if (b.neverClean) return true
  if (prefs.neverClean.length === 0) return false
  // On real paths: an entry spelled through a symlink is the same folder as the worktree
  // reached by its real spelling. A path that does not resolve is compared as written.
  const platform = process.platform
  const key = (p: string): string => canonicalPathKey(canonical(p).path, platform)
  const listed = new Set(prefs.neverClean.map(key))
  const candidates = [b.item.path, b.item.repoPath].filter((p): p is string => !!p)
  return candidates.some((p) => listed.has(key(p)))
}

/**
 * The reprobe's question, answered from the CURRENT prefs rather than the scan-time flags: a
 * Keep mark or a neverClean path added after the scan, or a main checkout, protects the
 * bundle from any clean. Any Keep mark counts, whatever fate it was made under: a stale
 * mark is cleared by the next gather, and until then refusing is the safe side.
 */
export function isProtectedNow(
  b: WorktreeBundle,
  prefs: GcPrefs,
  canonical: CanonicalPath = AS_GIVEN
): boolean {
  return (
    b.isMainCheckout ||
    isMainCheckoutByPath(b) ||
    b.keep ||
    prefs.keep[b.item.id] !== undefined ||
    isNeverClean(b, prefs, canonical)
  )
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
 * otherwise: ready items only, minus neverClean, oldest first, capped at `maxItemsPerCycle`.
 */
export function planCycle(bundles: readonly WorktreeBundle[], prefs: GcPrefs): CyclePlan {
  if (!prefs.autopilot || !prefs.categories.worktrees) {
    return { mode: 'off', toClean: [], deferred: 0, found: 0, reportBytes: 0 }
  }
  const eligible = bundles
    .filter(
      (b) =>
        b.bucket === 'ready' &&
        CLEANABLE_KINDS.includes(b.item.kind) &&
        !b.keep &&
        !b.isMainCheckout &&
        !isNeverClean(b, prefs)
    )
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

/**
 * What the next cycle would clean if cleaning were allowed right now: the answer to "if I enable
 * it, what goes?". Same eligibility, order and cap as a `clean` cycle, whatever the autopilot or
 * acknowledgement say today. Null when the worktrees category is off (nothing would ever run).
 */
export function planNextClean(
  bundles: readonly WorktreeBundle[],
  prefs: GcPrefs
): { count: number; bytes: number } | null {
  if (!prefs.categories.worktrees) return null
  const plan = planCycle(bundles, { ...prefs, autopilot: true, firstReportAcknowledged: true })
  return {
    count: plan.toClean.length,
    bytes: plan.toClean.reduce((sum, b) => sum + (b.item.diskBytes ?? 0), 0)
  }
}

// ---- failures: a ready item that keeps failing is a decision, not a retry loop -----------------

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
 * Spec §4: a halted item reappears in Needs review with the step and the error. Only a ready item is
 * rewritten; anything else is already a decision or off limits.
 */
export function applyFailures(
  bundles: readonly WorktreeBundle[],
  failures: ReadonlyMap<string, CycleFailure>
): WorktreeBundle[] {
  return bundles.map((b) => {
    const f = b.bucket === 'ready' ? failures.get(b.item.id) : undefined
    if (!f) return b
    return {
      ...b,
      bucket: 'review' as const,
      reason: {
        code: 'cleanup-failed' as const,
        detail: `Cleanup stopped at ${f.step}: ${f.error}`
      }
    }
  })
}

// ---- manual cleaning: what the operator's click may take -----------------------------------

export type RefusalCode =
  'main-checkout' | 'never-clean' | 'in-use' | 'kept' | 'needs-confirmation' | 'unsupported-kind'

/**
 * Why a manual `gc:clean` must not touch this bundle, or null when it may proceed. Judged
 * against the CURRENT prefs, because `neverClean` can change after the snapshot the operator
 * is looking at. A confirmed review item passes; an in-use item, a main checkout, a neverClean path and
 * a kept bundle never do. The live-session and changed-stack refusals are the reprobe's.
 */
export function refusalFor(
  b: WorktreeBundle,
  prefs: GcPrefs,
  opts: { confirmed: boolean }
): RefusalCode | null {
  if (b.isMainCheckout || isMainCheckoutByPath(b)) return 'main-checkout'
  if (isNeverClean(b, prefs)) return 'never-clean'
  if (b.keep) return 'kept'
  if (b.bucket === 'in-use') return 'in-use'
  // The cleanup executor skips the folder of a detached worktree, so "success" would be a lie.
  if (!CLEANABLE_KINDS.includes(b.item.kind)) return 'unsupported-kind'
  if (b.bucket === 'review' && !opts.confirmed) return 'needs-confirmation'
  return null
}
