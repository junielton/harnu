// Pure autopilot decisions (design: workspace-gc §6). What a cycle may clean, and nothing
// else: every I/O step lives in gc-cycle.ts behind injected deps.

import type { WorktreeBundle } from './bundle-core'
import type { GcPrefs } from './gc-prefs'
import { AS_GIVEN, canonicalPathKey, type CanonicalPath } from './bundle-core'
import { isMainCheckoutByPath, type GcItemResult } from './pipeline-core'

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
        // Refused at the reprobe lately: trying again every cycle only spends the cap on it.
        !b.reprobeRefusal &&
        // Scanned while Docker was down: its stacks were never seen, so the reprobe would refuse it.
        !b.dockerBlind &&
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

// ---- failures: a ready item that keeps failing is a decision, not a retry loop -----------------

/**
 * A halted cleanup, or a refusal at the reprobe, remembered in memory until it succeeds, the
 * worktree is gone, or its TTL passes. A halt after the reprobe carries only `step`, `error` and `at`;
 * a reprobe refusal (`step: 'reprobe'`, `error` the refusal code) also counts how many times in a row
 * the same refusal came back.
 */
export interface CycleFailure {
  step: string
  error: string
  at: number
  /** Reprobe refusals only: identical refusals in a row. */
  count?: number
  /** Reprobe refusals only: the tip the item was refused at; another tip is another question. */
  tip?: string | null
}

/** How long a failed cleanup stays a decision before the autopilot may try it again. */
export const FAILURE_TTL_MS = 86_400_000

/**
 * How long a reprobe refusal keeps an item out of the hero and the autopilot. Shorter than a failed
 * cleanup: nothing was changed, so trying once in a while costs nothing, and a fix made outside Harnu
 * (an unlocked worktree) is noticed within hours without anyone pressing a button.
 */
export const REFUSAL_TTL_MS = 6 * 3_600_000

/**
 * How long the COUNT of identical refusals is remembered. It outlives the hide window above on
 * purpose: the item rejoins the hero and the autopilot when the window lapses, and the next refusal
 * must add to the count, not restart it, or an item would be retried forever without a demotion.
 */
export const REFUSAL_COUNT_TTL_MS = 7 * 86_400_000

/** Identical reprobe refusals in a row after which a ready item is demoted to Needs review. */
export const REFUSAL_DEMOTE_AFTER = 2

/**
 * The reprobe refusals that describe the ITEM and stay true until someone acts, so remembering them
 * is honest. The rest are the moment or the click — Docker down, a session that is open right now, a
 * scan that is out of date, a confirm that went stale — and the next scan or click answers them afresh.
 */
const REMEMBERED_REFUSALS: ReadonlySet<string> = new Set([
  'tip-unknown',
  'path-unresolved',
  'not-harvestable',
  'nested-worktree',
  'foreign-checkout',
  'shared-stack',
  'stack-present',
  'cannot-unregister',
  'protected-now'
])

const codeOf = (error: string): string => error.split(':')[0].trim()

/**
 * Remembers a reprobe refusal so the item leaves the hero and the autopilot skips it. Returns whether
 * the result was one worth remembering. `tip` is the bundle's tip, so a new commit forgets the refusal.
 */
export function rememberReprobeRefusal(
  failures: Map<string, CycleFailure>,
  result: Pick<GcItemResult, 'id' | 'ok' | 'haltedAt' | 'error'>,
  now: number,
  tip?: string | null
): boolean {
  if (result.ok || result.haltedAt !== 'reprobe') return false
  const code = codeOf(result.error ?? '')
  if (!REMEMBERED_REFUSALS.has(code)) return false
  const prev = failures.get(result.id)
  const again = prev?.step === 'reprobe' && prev.error === code
  failures.set(result.id, {
    step: 'reprobe',
    error: code,
    at: now,
    count: again ? (prev.count ?? 1) + 1 : 1,
    ...(tip === undefined ? {} : { tip })
  })
  return true
}

const ttlOf = (f: CycleFailure): number =>
  f.step === 'reprobe' ? REFUSAL_COUNT_TTL_MS : FAILURE_TTL_MS

/** Drops failures for worktrees that no longer exist and those old enough to retry. */
export function pruneFailures(
  failures: Map<string, CycleFailure>,
  bundles: readonly WorktreeBundle[],
  now: number
): void {
  const byId = new Map(bundles.map((b) => [b.item.id, b]))
  for (const [id, f] of failures) {
    const b = byId.get(id)
    if (!b || now - f.at >= ttlOf(f)) {
      failures.delete(id)
      continue
    }
    if (f.step !== 'reprobe') continue
    // A refusal is about a ready item at one commit. Once the scan calls it something else, or it
    // moved, the scan owns the fact and the memory only gets in the way. A bundle this file already
    // demoted (applyFailures) still carries the mark, and is ready underneath: keep its memory.
    const readyUnderneath = b.bucket === 'ready' || b.reprobeRefusal !== undefined
    if (!readyUnderneath || (f.tip !== undefined && f.tip !== (b.localTip ?? null))) {
      failures.delete(id)
    }
  }
}

/**
 * Spec §4: a halted item reappears in Needs review with the step and the error. Only a ready item is
 * rewritten; anything else is already a decision or off limits.
 *
 * A reprobe refusal is gentler: the item stays ready on paper but carries `reprobeRefusal`, so the
 * hero and the autopilot leave it out for REFUSAL_TTL_MS and the panel can say why. When the window
 * lapses it rejoins them; after REFUSAL_DEMOTE_AFTER identical refusals (counted across windows) it
 * is demoted to Needs review with that reason, and stays there while the count is remembered.
 */
export function applyFailures(
  bundles: readonly WorktreeBundle[],
  failures: ReadonlyMap<string, CycleFailure>,
  now: number
): WorktreeBundle[] {
  return bundles.map((b) => {
    const f = b.bucket === 'ready' ? failures.get(b.item.id) : undefined
    if (!f) return b
    if (f.step === 'reprobe') {
      const count = f.count ?? 1
      const marked = { ...b, reprobeRefusal: { code: f.error, count } }
      if (count < REFUSAL_DEMOTE_AFTER) {
        // Hidden only for the window; after it the item is tried again, and the count carries on.
        return now - f.at < REFUSAL_TTL_MS ? marked : b
      }
      return {
        ...marked,
        bucket: 'review' as const,
        reason: {
          code: 'cleanup-failed' as const,
          detail: `Cleanup was refused before it started (${f.error}), ${count} times in a row.`
        }
      }
    }
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
