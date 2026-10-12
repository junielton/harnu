// "No dead ends" for Cleanup: for a selection, what Remove can take, what it cannot and why, and the
// guided action that clears each cause. Every refusal here comes from `removability()` and nothing
// else, so a refusal main stops making (a detached worktree once it can archive one) simply stops
// being a group; this file hard-codes no cause of its own.
//
// No DOM, no Vue, no i18n.

import type { ReapItem } from '../../../preload'
import { canDehydrate } from '../components/cleanup-row'
import type { GcModel } from './gc-model'
import { removabilityAll, type RemovalRefusal } from './gc-removability'

/** What the operator can do about a refusal, in the order of how much it does for them. */
export type GuidedAction =
  /** Unlock the worktree in git, then remove it (one confirm). */
  | 'unlock-remove'
  /** Park the idle session open in it, then remove (one confirm). */
  | 'close-session-remove'
  /** A stack other folders use too: stop it, or leave it, then remove. */
  | 'shared-stack'
  /** A folder Harnu cannot read: the path, the owner and the command that fixes it. */
  | 'fix-unreadable'
  /** The scan was blind to something that has changed since: scan again. */
  | 'scan-again'
  /** Drop only the installed dependencies, keep the code. */
  | 'dehydrate'
  /** Nothing in Harnu can do it: the exact command to run by hand. */
  | 'manual'
  | 'unkeep'
  | 'open-settings'
  | 'check-again'
  /** Several stacked causes that a prep can each fix: one confirm, every step listed, all rolled back together. */
  | 'combined'
  /** A rule that is the point of the refusal (a main checkout is never removed): the reason is the answer. */
  | 'explain'

export interface RefusalGroup {
  /** The cause shown first (for a combined group, the first of `causes`). */
  reason: RemovalRefusal
  /** Every cause this group's items share; more than one only for a combined action. */
  causes: RemovalRefusal[]
  count: number
  ids: string[]
  action: GuidedAction
  /** A command that clears the cause by hand, when there is one (the first item's). */
  hint?: string
}

export interface RemovalSummary {
  /** Ids a Remove would take. */
  removable: string[]
  /** Everything it would not, grouped by cause, biggest group first. */
  refused: RefusalGroup[]
  /** The best partial win: what dropping the installed deps of the refused items frees. */
  dehydrate: { count: number; bytes: number; ids: string[] } | null
}

/** The causes a guided prep can fix (each has a reversible step, or the one irreversible step, last). */
export const PREPABLE: ReadonlySet<RemovalRefusal> = new Set([
  'locked',
  'session-open',
  'shared-stack'
])

/** The steps of a combined action, in the order they run (the irreversible one, closing a session, last). */
export type CombinedStep = 'unlock' | 'shared-stack' | 'close-session'
export function combinedSteps(causes: readonly RemovalRefusal[]): CombinedStep[] {
  const out: CombinedStep[] = []
  if (causes.includes('locked')) out.push('unlock')
  if (causes.includes('shared-stack')) out.push('shared-stack')
  if (causes.includes('session-open')) out.push('close-session')
  return out
}

const STEP_RANK: Partial<Record<RemovalRefusal, number>> = {
  locked: 0,
  'shared-stack': 1,
  'session-open': 2
}

/**
 * What to offer for ONE item whose causes are `causes` (the whole list, first first). A cause no prep can
 * fix is shown first, alone: a guided action over the fixable ones would only meet it. When every cause is
 * fixable and there are several, one combined action fixes them together.
 */
export function guideFor(
  causes: readonly RemovalRefusal[],
  ctx: { hasDeps: boolean }
): { reason: RemovalRefusal; causes: RemovalRefusal[]; action: GuidedAction } {
  const blocker = causes.find((c) => !PREPABLE.has(c))
  if (blocker) return { reason: blocker, causes: [blocker], action: guidedActionFor(blocker, ctx) }
  if (causes.length > 1) {
    // Listed in the order the steps run, so the causes read the way the action's label does.
    const ordered = [...causes].sort((a, b) => STEP_RANK[a]! - STEP_RANK[b]!)
    return { reason: ordered[0]!, causes: ordered, action: 'combined' }
  }
  return { reason: causes[0]!, causes: [...causes], action: guidedActionFor(causes[0]!, ctx) }
}

/** The guided action for one refusal; `hasDeps` says whether Dehydrate would free something. */
export function guidedActionFor(reason: RemovalRefusal, ctx: { hasDeps: boolean }): GuidedAction {
  switch (reason) {
    case 'locked':
      return 'unlock-remove'
    case 'session-open':
      return 'close-session-remove'
    case 'shared-stack':
      return 'shared-stack'
    case 'check-failed':
      return 'fix-unreadable'
    case 'scan-blind':
    case 'tip-unknown':
    case 'path-unresolved':
      return 'scan-again'
    case 'unsupported-kind':
      return ctx.hasDeps ? 'dehydrate' : 'manual'
    case 'folder-gone':
    case 'cannot-unregister':
    case 'operation-in-progress': // ended by hand: the refusal's hint is the abort command
      return 'manual'
    case 'kept':
      return 'unkeep'
    case 'never-clean':
      return 'open-settings'
    case 'stack-present':
    case 'nested-worktree':
      return 'check-again'
    case 'main-checkout':
    case 'in-use':
    case 'grace-not-elapsed':
    case 'protected-now':
      return 'explain'
  }
}

/** Whether the action is a button of its own (Dehydrate has one; a manual command and a plain reason do not need one). */
export const hasGuideButton = (action: GuidedAction): boolean =>
  action !== 'explain' && action !== 'manual' && action !== 'dehydrate'

/**
 * The label of a guided action's button. A combined action names its steps ("Unlock, stop stack and
 * remove…"); the others have one fixed label.
 */
export function guideLabel(
  t: (key: string, params?: Record<string, unknown>) => string,
  action: GuidedAction,
  reason: RemovalRefusal,
  causes: readonly RemovalRefusal[] = [reason]
): string {
  if (action !== 'combined') return t(guideLabelKey(action, reason))
  const words = combinedSteps(causes).map((s) =>
    t(
      `cleanup.gc.guide.combined.${s === 'unlock' ? 'unlock' : s === 'shared-stack' ? 'stack' : 'session'}`
    )
  )
  const steps = words.map((w, i) =>
    i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.charAt(0).toLowerCase() + w.slice(1)
  )
  return t('cleanup.gc.guide.combined.label', { steps: steps.join(', ') })
}

/** `cleanup.gc.guide.action.*` key: the label of a guided action (scan-blind has its own wording). */
export function guideLabelKey(action: GuidedAction, reason: RemovalRefusal): string {
  return `cleanup.gc.guide.action.${action === 'scan-again' && reason === 'scan-blind' ? 'dockerDown' : action}`
}

/** The bytes Dehydrate would free on one block (0 when it cannot be dehydrated). */
export const depsOf = (b: {
  depsBytes: number | null
  bundle: { item: ReapItem } | null
}): number => {
  const item = b.bundle?.item
  if (!item || !canDehydrate(item)) return 0
  return b.depsBytes ?? item.hydration?.reclaimableBytes ?? 0
}

/** Splits `ids` into what Remove takes and what it refuses (grouped by cause), and the best partial win. */
export function removalSummary(
  model: GcModel,
  ids: readonly string[],
  now: number = Date.now()
): RemovalSummary {
  const removable: string[] = []
  const groups = new Map<
    string,
    { reason: RemovalRefusal; causes: RemovalRefusal[]; ids: string[]; hint?: string; deps: number }
  >()
  const dehydrate = { count: 0, bytes: 0, ids: [] as string[] }
  for (const id of ids) {
    const b = model.byId.get(id)
    if (!b) continue
    const all = removabilityAll(b, now)
    if (all.length === 0) {
      removable.push(id)
      continue
    }
    const deps = depsOf(b)
    const g = guideFor(
      all.map((r) => r.reason),
      { hasDeps: deps > 0 }
    )
    const key = `${g.action}:${g.causes.join('+')}`
    const grp = groups.get(key) ?? { reason: g.reason, causes: g.causes, ids: [], deps: 0 }
    grp.ids.push(id)
    const hint = all.find((r) => r.reason === g.reason)?.hint
    if (grp.hint === undefined && hint !== undefined) grp.hint = hint
    grp.deps += deps
    groups.set(key, grp)
    if (deps > 0) {
      dehydrate.count++
      dehydrate.bytes += deps
      dehydrate.ids.push(id)
    }
  }
  const refused: RefusalGroup[] = [...groups.values()]
    .map((g) => ({
      reason: g.reason,
      causes: g.causes,
      count: g.ids.length,
      ids: g.ids,
      action: guideFor(g.causes, { hasDeps: g.deps > 0 }).action,
      ...(g.hint === undefined ? {} : { hint: g.hint })
    }))
    .sort((a, b) => b.count - a.count)
  return { removable, refused, dehydrate: dehydrate.count > 0 ? dehydrate : null }
}
