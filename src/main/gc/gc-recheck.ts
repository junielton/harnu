// "Check again" on a demoted item (design.md Cleanup, panel). An item main refused again and again is
// demoted to Needs review and its refusal is remembered for a week. When the cause is fixed outside
// Harnu — a registration repaired, a stack stopped — nothing here would notice for days, so the
// operator can ask: Harnu forgets that item's remembered refusal, gathers afresh and runs the real
// reprobe once. A fixed item is ready again; a still-broken one goes back to demoted with its reason.
// The reprobe only reads: it never touches the item.

import type { WorktreeBundle } from './bundle-core'
import { isRememberedRefusal, restoreDemotedRefusal } from './autopilot-core'
import type { CycleState } from './gc-cycle'

export type { GcRecheckResult } from './gc-wire'
import type { GcRecheckResult } from './gc-wire'

export interface RecheckDeps {
  /** A gather with the remembered refusals laid over it, as every consumer sees it. */
  gather(): Promise<{ bundles: WorktreeBundle[] }>
  /** The real pre-flight of the ordinary (not forced) ops: read-only. */
  reprobe(b: WorktreeBundle): Promise<{ ok: true } | { ok: false; reason: string }>
  state: CycleState
  now(): number
}

export async function recheckItem(deps: RecheckDeps, id: string): Promise<GcRecheckResult> {
  const known = (await deps.gather()).bundles.some((b) => b.item.id === id)
  if (!known) return { id, outcome: 'unknown-item' }

  // Forget what was remembered about THIS item only (a halt after the reprobe is a different matter).
  if (deps.state.failures.get(id)?.step === 'reprobe') deps.state.failures.delete(id)

  const fresh = (await deps.gather()).bundles.find((b) => b.item.id === id)
  if (!fresh) return { id, outcome: 'unknown-item' }
  // The scan calls it something else now: the scan owns that fact, there is nothing left to check.
  if (fresh.bucket !== 'ready') return { id, outcome: 'cleared' }

  let answer: Awaited<ReturnType<RecheckDeps['reprobe']>>
  try {
    answer = await deps.reprobe(fresh)
  } catch {
    return { id, outcome: 'unchecked' }
  }
  if (answer.ok) return { id, outcome: 'cleared' }

  const code = answer.reason.split(':')[0].trim()
  if (!isRememberedRefusal(code)) return { id, outcome: 'unchecked', code }
  restoreDemotedRefusal(deps.state.failures, id, code, deps.now(), fresh.localTip ?? null)
  return { id, outcome: 'still-refused', code }
}
