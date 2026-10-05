import { ref, computed, type Ref, type ComputedRef } from 'vue'
import type { PendingApprovalWire } from '../../../preload'
import { useUiStore } from './ui'
import { i18n } from '../i18n'
import { sessionTitle, type SessionLike } from '../lib/session-label'

/**
 * Approval Inbox queue (T25 wave 1) — extracted from the `sessions.ts` god-store
 * as an injectable composable. Owns the parked-approval map + its display
 * computeds + the mutators + `resolveApproval`. The store instantiates it once
 * (single owner) and spreads the pieces back into its return object, so the
 * public store contract is unchanged.
 *
 * Cross-cutting reads are injected as functions (DI) rather than importing the
 * store back (which would cycle — plan risk #4): `folderAliasOf` + a structural
 * `findSessionById` / `allSessions` pair, read only to name the session through
 * `sessionTitle()` (BUG-78). Everything else — `useUiStore`,
 * `i18n`, `window.api.hookRespond` — is a leaf the store already imports too.
 */

/** The cross-cutting store readers the queue needs (injected, never imported back). */
export interface ApprovalQueueDeps {
  /** Alias of the folder that owns `sessionId` (for display enrichment). */
  folderAliasOf: (sessionId: string) => string
  /** The session by id, or null — structural (`SessionLike`) to avoid a cycle. */
  findSessionById: (sessionId: string) => SessionLike | null
  /** Every session — `sessionTitle` reads it to name a fork after its source. */
  allSessions: () => readonly SessionLike[]
}

/** A pending approval wire enriched with the display fields the inbox row needs. */
export type EnrichedApproval = PendingApprovalWire & {
  folderAlias: string
  sessionSummary: string
}

/** The Approval Inbox queue surface {@link useApprovalQueue} returns. */
export interface ApprovalQueue {
  pendingApprovals: Ref<Map<string, PendingApprovalWire>>
  pendingApprovalList: ComputedRef<EnrichedApproval[]>
  pendingApprovalCount: ComputedRef<number>
  addPendingApproval: (wire: PendingApprovalWire) => void
  removePendingApproval: (requestId: string) => void
  removeApprovalsForSession: (sessionId: string) => void
  resolveApproval: (requestId: string, decision: 'allow' | 'deny') => Promise<void>
}

/** Build the Approval Inbox queue over injected store readers. */
export function useApprovalQueue(deps: ApprovalQueueDeps): ApprovalQueue {
  // Map<requestId, wire>. Reassigned on every mutation so the zone computeds pick
  // up the change. The folder alias + session summary are resolved on the fly by
  // the getter, never duplicated here.
  const pendingApprovals = ref<Map<string, PendingApprovalWire>>(new Map())

  function addPendingApproval(wire: PendingApprovalWire): void {
    const next = new Map(pendingApprovals.value)
    next.set(wire.requestId, wire)
    pendingApprovals.value = next
  }

  function removePendingApproval(requestId: string): void {
    if (!pendingApprovals.value.has(requestId)) return
    const next = new Map(pendingApprovals.value)
    next.delete(requestId)
    pendingApprovals.value = next
  }

  /** Drop every parked approval for a session — used when it leaves `needs-input`
   *  by another path (answered in the terminal, Stop, …). Idempotent. */
  function removeApprovalsForSession(sessionId: string): void {
    let changed = false
    const next = new Map(pendingApprovals.value)
    for (const [id, w] of next)
      if (w.sessionId === sessionId) {
        next.delete(id)
        changed = true
      }
    if (changed) pendingApprovals.value = next
  }

  /** The approval's session as every surface names it, or '' (BUG-78). */
  function sessionNameOf(sessionId: string): string {
    const s = deps.findSessionById(sessionId)
    return s ? sessionTitle(s, deps.allSessions(), i18n.global.t) : ''
  }

  /** Pending approvals oldest-first (longest wait = most urgent — §3.4), enriched
   *  with the owning folder alias + the session summary for display. */
  const pendingApprovalList = computed(() =>
    [...pendingApprovals.value.values()]
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((w) => ({
        ...w,
        folderAlias: deps.folderAliasOf(w.sessionId),
        sessionSummary: sessionNameOf(w.sessionId)
      }))
  )

  const pendingApprovalCount = computed(() => pendingApprovals.value.size)

  /**
   * Resolve an approval with the operator's decision. Optimistic: the row leaves
   * at once. A `{ ok: false }` means the substrate already timed it out — the
   * session handled it in the terminal — so it's an info toast, not an error.
   */
  async function resolveApproval(requestId: string, decision: 'allow' | 'deny'): Promise<void> {
    removePendingApproval(requestId) // optimistic
    try {
      const res = await window.api.hookRespond(requestId, decision)
      if (!res.ok)
        useUiStore().pushToast({ title: i18n.global.t('approvalInbox.expired'), kind: 'info' })
    } catch {
      /* never-throw, like the rest of the store */
    }
  }

  return {
    pendingApprovals,
    pendingApprovalList,
    pendingApprovalCount,
    addPendingApproval,
    removePendingApproval,
    removeApprovalsForSession,
    resolveApproval
  }
}
