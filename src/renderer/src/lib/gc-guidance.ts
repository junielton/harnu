// "No dead ends" for Cleanup: for a selection, what Remove can take, what it cannot and why, and the
// guided action that clears each cause. Every refusal here comes from `removability()` and nothing
// else, so a refusal main stops making (a detached worktree once it can archive one) simply stops
// being a group; this file hard-codes no cause of its own.
//
// No DOM, no Vue, no i18n.

import type { ReapItem } from '../../../preload'
import { canDehydrate } from '../components/cleanup-row'
import type { GcModel } from './gc-model'
import { removability, type RemovalRefusal } from './gc-removability'

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
  /** A rule that is the point of the refusal (a main checkout is never removed): the reason is the answer. */
  | 'explain'

export interface RefusalGroup {
  reason: RemovalRefusal
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

const depsOf = (b: { depsBytes: number | null; bundle: { item: ReapItem } | null }): number => {
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
  const groups = new Map<RemovalRefusal, { ids: string[]; hint?: string; deps: number }>()
  const dehydrate = { count: 0, bytes: 0, ids: [] as string[] }
  for (const id of ids) {
    const b = model.byId.get(id)
    if (!b) continue
    const v = removability(b, now)
    if (v.ok) {
      removable.push(id)
      continue
    }
    const g = groups.get(v.reason) ?? { ids: [], deps: 0 }
    g.ids.push(id)
    if (g.hint === undefined && v.hint !== undefined) g.hint = v.hint
    const deps = depsOf(b)
    g.deps += deps
    groups.set(v.reason, g)
    if (deps > 0) {
      dehydrate.count++
      dehydrate.bytes += deps
      dehydrate.ids.push(id)
    }
  }
  const refused: RefusalGroup[] = [...groups]
    .map(([reason, g]) => ({
      reason,
      count: g.ids.length,
      ids: g.ids,
      action: guidedActionFor(reason, { hasDeps: g.deps > 0 }),
      ...(g.hint === undefined ? {} : { hint: g.hint })
    }))
    .sort((a, b) => b.count - a.count)
  return { removable, refused, dehydrate: dehydrate.count > 0 ? dehydrate : null }
}
