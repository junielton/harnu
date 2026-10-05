import type { ReapItem, DehydrateSkipReason } from '../../../preload'

/**
 * Row legality and row text for the Cleanup takeover (design.md "Cleanup row —
 * states, verdict chip and action cluster"). Every consumer of an item's
 * hydration reads it through here — the row cluster, the repo-group pill, the
 * confirm dialog — so the conditions that decide a button cannot drift between
 * the place that shows it and the place that acts on it.
 */

/** In-flight hydration states the renderer holds while an operation runs. */
export type HydrationOp = 'dehydrating' | 'rehydrating'

type Translate = (key: string, params?: Record<string, unknown>) => string

function hasCheckout(item: ReapItem): boolean {
  return item.kind === 'worktree' || item.kind === 'detached-worktree'
}

/**
 * Rank 6 — Dehydrate: worktree kind, hydration `hydrated`, and at least one path
 * that passed all four guards at scan time. `active` is refused here too, even
 * though the store never renders an active row: the legality must not depend on
 * a filter elsewhere happening to hold.
 */
export function canDehydrate(item: ReapItem): boolean {
  const h = item.hydration
  return (
    hasCheckout(item) &&
    item.verdict !== 'active' &&
    !!h &&
    h.state === 'hydrated' &&
    h.removable.length > 0
  )
}

/** Rank 5 — Rehydrate: worktree kind, hydration `dehydrated`, and a manifest `setup` step. */
export function canRehydrate(item: ReapItem): boolean {
  const h = item.hydration
  return (
    hasCheckout(item) &&
    item.verdict !== 'active' &&
    !!h &&
    h.state === 'dehydrated' &&
    h.canRehydrate
  )
}

/**
 * "Idle" for the repo-group "Dehydrate N idle" pill: dehydratable, and its last
 * commit at least `idleDays` old. An unknown age is not idle — the pill claims
 * idleness, so it only counts rows where that claim is established.
 */
export function isIdleDehydratable(item: ReapItem, idleDays: number): boolean {
  return canDehydrate(item) && item.ageDays !== null && item.ageDays >= idleDays
}

export interface HydrationMarker {
  text: string
  /** Every changed file, for the meta line's tooltip; empty otherwise. */
  files: string[]
  tone: 'muted' | 'warning'
}

function basename(p: string): string {
  const cut = p.lastIndexOf('/')
  return cut === -1 ? p : p.slice(cut + 1)
}

/**
 * The meta line's hydration fragment (design.md "The meta line", slot 3). In
 * flight wins; then the at-rest `dehydrated` marker; then — on a hydrated row —
 * the files a rehydrate rewrote, which is the row naming them (AC-2). Nothing
 * for a plain hydrated row: that is the default and mints no marker.
 */
export function hydrationMarker(
  item: ReapItem,
  op: HydrationOp | undefined,
  t: Translate
): HydrationMarker | null {
  if (op) return { text: t(`cleanup.state.${op}`), files: [], tone: 'muted' }
  const h = item.hydration
  if (!h) return null
  if (h.state === 'dehydrated') {
    return {
      text: t(h.canRehydrate ? 'cleanup.state.dehydrated' : 'cleanup.state.dehydratedNoRehydrate'),
      files: [],
      tone: 'muted'
    }
  }
  if (h.rehydrateChanged.length > 0) {
    const [first, ...rest] = h.rehydrateChanged
    return {
      text:
        rest.length === 0
          ? t('cleanup.state.rehydrateChanged', { file: basename(first) })
          : t('cleanup.state.rehydrateChangedMore', { file: basename(first), count: rest.length }),
      files: h.rehydrateChanged,
      tone: 'warning'
    }
  }
  return null
}

/** Blocker id → `cleanup.blocker.*` key suffix. */
export const BLOCKER_LABEL_KEYS: Record<string, string> = {
  dirty: 'dirty',
  unpushed: 'unpushed',
  'ci-failing': 'ciFailing',
  'pr-open': 'prOpen',
  'pr-closed-unmerged': 'prClosedUnmerged',
  'changes-requested': 'changesRequested',
  'detached-head': 'detachedHead'
}

/**
 * The reason line under the verdict chip (design.md "The reason line — no bare
 * `unknown`, ever"): `text` is what renders, `title` the untruncated string.
 */
export function reasonLine(item: ReapItem, t: Translate): { text: string; title: string } | null {
  if (item.verdict === 'blocked') {
    if (item.blockers.length === 0) return null
    const labels = item.blockers.map((b) => t(`cleanup.blocker.${BLOCKER_LABEL_KEYS[b] ?? b}`))
    const text =
      labels.length > 1
        ? `${labels[0]} ${t('cleanup.reason.more', { count: labels.length - 1 })}`
        : labels[0]
    return { text, title: labels.join('; ') }
  }
  if (item.verdict === 'unknown') {
    const detail = item.checkpoints.find((c) => c.state === 'unknown' && c.detail)?.detail
    const text = detail ?? t('cleanup.reason.noProbe')
    return { text, title: text }
  }
  return null
}

/** Skip reason → `cleanup.dehydrateConfirm.skip.*` key suffix. */
export const SKIP_REASON_KEYS: Record<DehydrateSkipReason, string> = {
  'session-live': 'sessionLive',
  tracked: 'tracked',
  'not-ignored': 'notIgnored',
  symlink: 'symlink',
  'not-directory': 'notDirectory',
  'unsafe-path': 'unsafePath',
  'probe-failed': 'probeFailed'
}
