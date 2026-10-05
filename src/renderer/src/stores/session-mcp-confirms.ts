import { ref, computed, type Ref, type ComputedRef } from 'vue'
import type { McpConfirmPending } from '../../../preload'
import { i18n } from '../i18n'
import { playNotificationSound } from '../lib/notification-sound'

/**
 * Parked MCP-confirm queue (T44 S4c) — the async sibling of the Approval Inbox
 * hook queue (`session-approvals.ts`). Owns the reactive `Map` of PARKED agent
 * confirms — the ones that arrived while the window was NOT focused, so the
 * `McpConfirmOverlay` focused-modal fast path was skipped (the modal ones stay
 * with the overlay). The parked rows surface in the Approval Inbox "Needs you"
 * tab (expand-to-review), and the queue folds its count into the fleet
 * `attentionCount` + the inbox badge.
 *
 * Mirrors `useApprovalQueue`: a factory holding a `Map`, reassigned on every
 * mutation for reactivity (`docs/lessons/reactivity/002` — the project
 * convention), wired via DI in `sessions.ts` and torn down through the store's
 * `cleanupFns`. Cross-cutting leaves it imports directly (like the approval
 * queue): `i18n`, `playNotificationSound`, `window.api` — never a store back.
 *
 * BUG-25: a renderer reload used to drop every parked row silently — `main`
 * fires `mcp:confirm:pending` exactly once, at park time, so a listener that
 * wasn't attached yet (a reload, a fresh window) never saw the confirm again
 * until the 30-minute operator-away TTL denied it unseen. `sessions.ts` now
 * calls `window.api.mcpConfirmsList()` once at boot (mirrors `approvalsList()`
 * for the sibling hook queue) and feeds every still-live wire through
 * {@link addParkedConfirm} — see the call site for why it forces `mode: 'parked'`.
 *
 * BUG-32: `confirm-core.ts` now PROMOTES a still-pending parked confirm to
 * `mode: 'modal'` on window focus regain and re-sends it over the same
 * `mcp:confirm:pending` channel (`confirm-resolver.ts`). `addParkedConfirm`
 * arriving with `mode: 'modal'` for an id already in `parkedConfirms` is that
 * promotion: `McpConfirmOverlay.vue`'s own listener picks up the same event
 * and shows the modal, so this store's only job is to drop the row — WITHOUT
 * replaying the chime, which already fired at the original park time (D1/AC5).
 * Dismissing the promoted modal (D3) re-arrives here as `mode: 'parked'`;
 * `seenParkedIds` (per-queue, never pruned) is what tells that re-arrival
 * apart from a genuinely new confirm so it doesn't chime a second time either.
 */
export interface McpConfirmQueue {
  parkedConfirms: Ref<Map<string, McpConfirmPending>>
  parkedConfirmList: ComputedRef<McpConfirmPending[]>
  parkedConfirmCount: ComputedRef<number>
  addParkedConfirm: (p: McpConfirmPending) => void
  removeParkedConfirm: (id: string) => void
  resolveParkedConfirm: (
    id: string,
    verdict: 'allow' | 'deny',
    data?: {
      alwaysAllow?: boolean
      manifestSelectedSlugs?: string[]
      manifestSubstrateOverrides?: Record<string, string>
    }
  ) => Promise<void>
}

/** Build the parked MCP-confirm queue (no store readers needed — parked confirms
 *  carry no owning session/folder to enrich; their `prompt` is the summary). */
export function useMcpConfirmQueue(): McpConfirmQueue {
  // Map<confirmId, wire>. Reassigned on every mutation so the fold-in computeds
  // (attentionCount / inboxCount) + the inbox list pick up the change.
  const parkedConfirms = ref<Map<string, McpConfirmPending>>(new Map())
  // BUG-32: ids that have ever triggered the parked chime, so a dismissed
  // confirm re-arriving as `parked` (D3) doesn't chime a second time. Plain
  // (non-reactive) Set — never pruned; bounded by MAX_PENDING_CONFIRMS-scale
  // confirm churn over a session's lifetime, not by session length.
  const seenParkedIds = new Set<string>()

  /**
   * Handle an `mcp:confirm:pending` arrival.
   *
   * `mode === 'modal'` for an id already tracked here is a BUG-32 promotion:
   * the confirm was parked, the operator came back, and `confirm-core.ts`
   * flipped it to `modal` and re-sent it — `McpConfirmOverlay` picks up the
   * same event and shows it, so this store's only job is to drop the row (no
   * chime replay, AC5). `mode === 'modal'` for an id NOT tracked here is an
   * ordinary focused-fast-path confirm that never touched this queue — a
   * no-op (removeParkedConfirm is idempotent on an absent id).
   *
   * `mode === 'parked'` already in the map is a no-op (still parked, nothing
   * changed). A genuinely new parked confirm — OR one re-arriving after a D3
   * dismissal — fires the **transversal security-confirm rule** (design.md §6
   * — "Security confirms — sound + attention"): the chime (ALWAYS — Decision 2,
   * a security cue, never gated on the per-state notify prefs) + OS window
   * attention + a click-to-inbox native notification. `seenParkedIds` gates the
   * chime specifically (not the row add) so a dismissal re-arrival still shows
   * the row without re-chiming.
   */
  function addParkedConfirm(p: McpConfirmPending): void {
    if (p.mode === 'modal') {
      removeParkedConfirm(p.id)
      return
    }
    if (parkedConfirms.value.has(p.id)) return
    const next = new Map(parkedConfirms.value)
    next.set(p.id, p)
    parkedConfirms.value = next
    if (seenParkedIds.has(p.id)) return
    seenParkedIds.add(p.id)
    try {
      playNotificationSound()
      window.api.requestAttention()
      window.api.notify({
        title: i18n.global.t('agentConfirm.notifyTitle'),
        body: p.prompt,
        sessionId: '',
        activate: 'inbox'
      })
      // Remote push (remote-push spec): a parked confirm means the operator is
      // NOT looking at the machine — the away-from-keyboard case remote channels
      // exist for. Rides `needs-input`; the remote master/pause still applies
      // (the phone is the operator's own noise budget, unlike the local chime).
      window.api.pushSend({
        kind: 'needs-input',
        title: i18n.global.t('agentConfirm.notifyTitle'),
        body: p.prompt
      })
    } catch {
      /* transient IPC teardown / no audio device — swallow, like the rest of the store */
    }
  }

  function removeParkedConfirm(id: string): void {
    if (!parkedConfirms.value.has(id)) return
    const next = new Map(parkedConfirms.value)
    next.delete(id)
    parkedConfirms.value = next
  }

  /**
   * Resolve a parked confirm with the operator's verdict. Optimistic: the row
   * leaves at once (a `mcp:confirm:resolved` event will also prune it, harmless
   * once already gone). The main-process gate fails closed on its own TTL
   * regardless, so a rejected respond is swallowed. `data` carries T93's "always
   * allow this verb here" checkbox choice from the expand-to-review row.
   */
  async function resolveParkedConfirm(
    id: string,
    verdict: 'allow' | 'deny',
    data?: {
      alwaysAllow?: boolean
      manifestSelectedSlugs?: string[]
      manifestSubstrateOverrides?: Record<string, string>
    }
  ): Promise<void> {
    removeParkedConfirm(id)
    try {
      await window.api.mcpConfirmRespond(id, verdict, data)
    } catch {
      /* never-throw, like the rest of the store */
    }
  }

  /** Parked confirms oldest-first (longest wait = most urgent — mirrors the hook
   *  queue; all parked confirms share the same PARK_TTL so `deadline` order ==
   *  arrival order). */
  const parkedConfirmList = computed(() =>
    [...parkedConfirms.value.values()].sort((a, b) => a.deadline - b.deadline)
  )

  const parkedConfirmCount = computed(() => parkedConfirms.value.size)

  return {
    parkedConfirms,
    parkedConfirmList,
    parkedConfirmCount,
    addParkedConfirm,
    removeParkedConfirm,
    resolveParkedConfirm
  }
}
