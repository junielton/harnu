import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  useApprovalQueue,
  type ApprovalQueueDeps
} from '../src/renderer/src/stores/session-approvals'
import { useUiStore } from '../src/renderer/src/stores/ui'
import type { PendingApprovalWire } from '../src/preload'

/**
 * T25 wave 1 — the Approval Inbox queue extracted from the sessions god-store.
 * Tested in isolation: the composable takes its two cross-cutting readers by
 * injection, so a plain stub proves the DI seam without a full store/Pinia for
 * the pure paths. `resolveApproval` alone needs Pinia (`useUiStore`) + a
 * `window.api.hookRespond` stub — set up per-test.
 */

const wire = (requestId: string, sessionId: string, createdAtMs: number): PendingApprovalWire => ({
  requestId,
  sessionId,
  kind: 'permission_request',
  toolName: 'Bash',
  toolInput: { command: 'ls' },
  summary: 'Bash(ls)',
  createdAtMs,
  deadlineMs: createdAtMs + 3500
})

/** Deps that enrich S1 with a known alias + summary; everything else is empty. */
const deps: ApprovalQueueDeps = {
  folderAliasOf: (id) => (id === 'S1' ? 'my-repo' : ''),
  findSessionById: (id) => (id === 'S1' ? { sessionId: 'S1', summary: 'do the thing' } : null),
  allSessions: () => []
}

describe('useApprovalQueue', () => {
  it('adds, counts, and orders oldest-first, enriched via injected readers', () => {
    const q = useApprovalQueue(deps)
    q.addPendingApproval(wire('r2', 'S1', 2000))
    q.addPendingApproval(wire('r1', 'S1', 1000))
    expect(q.pendingApprovalCount.value).toBe(2)
    expect(q.pendingApprovalList.value.map((a) => a.requestId)).toEqual(['r1', 'r2'])
    expect(q.pendingApprovalList.value[0].folderAlias).toBe('my-repo')
    expect(q.pendingApprovalList.value[0].sessionSummary).toBe('do the thing')
  })

  it('enriches an unknown session gracefully (empty alias + summary)', () => {
    const q = useApprovalQueue(deps)
    q.addPendingApproval(wire('r1', 'ghost', 1000))
    expect(q.pendingApprovalList.value[0].folderAlias).toBe('')
    expect(q.pendingApprovalList.value[0].sessionSummary).toBe('')
  })

  it('dedupes by requestId (re-add overwrites)', () => {
    const q = useApprovalQueue(deps)
    q.addPendingApproval(wire('r1', 'S1', 1000))
    q.addPendingApproval(wire('r1', 'S1', 5000))
    expect(q.pendingApprovalCount.value).toBe(1)
    expect(q.pendingApprovalList.value[0].createdAtMs).toBe(5000)
  })

  it('removePendingApproval drops a present id and no-ops an absent one', () => {
    const q = useApprovalQueue(deps)
    const before = q.pendingApprovals.value
    q.removePendingApproval('nope') // absent → identity unchanged (no reassign)
    expect(q.pendingApprovals.value).toBe(before)
    q.addPendingApproval(wire('r1', 'S1', 1000))
    q.removePendingApproval('r1')
    expect(q.pendingApprovalCount.value).toBe(0)
  })

  it('removeApprovalsForSession drops only that session, and is idempotent', () => {
    const q = useApprovalQueue(deps)
    q.addPendingApproval(wire('r1', 'S1', 1000))
    q.addPendingApproval(wire('r2', 'S2', 2000))
    q.addPendingApproval(wire('r3', 'S1', 3000))
    q.removeApprovalsForSession('S1')
    expect(q.pendingApprovalList.value.map((a) => a.requestId)).toEqual(['r2'])
    const after = q.pendingApprovals.value
    q.removeApprovalsForSession('S1') // nothing left to change → identity stable
    expect(q.pendingApprovals.value).toBe(after)
  })

  it('reassigns the Map identity on mutation so computeds fire', () => {
    const q = useApprovalQueue(deps)
    const before = q.pendingApprovals.value
    q.addPendingApproval(wire('r1', 'S1', 1000))
    expect(q.pendingApprovals.value).not.toBe(before)
  })

  describe('resolveApproval', () => {
    beforeEach(() => setActivePinia(createPinia()))
    afterEach(() => delete (globalThis as unknown as { window?: unknown }).window)

    it('optimistically removes the row and toasts nothing on ok', async () => {
      const hookRespond = vi.fn().mockResolvedValue({ ok: true })
      ;(globalThis as unknown as { window: unknown }).window = { api: { hookRespond } }
      const q = useApprovalQueue(deps)
      q.addPendingApproval(wire('r1', 'S1', 1000))
      await q.resolveApproval('r1', 'allow')
      expect(q.pendingApprovalCount.value).toBe(0)
      expect(hookRespond).toHaveBeenCalledWith('r1', 'allow')
      expect(useUiStore().toasts).toHaveLength(0)
    })

    it('toasts info when the substrate already timed it out ({ ok: false })', async () => {
      const hookRespond = vi.fn().mockResolvedValue({ ok: false })
      ;(globalThis as unknown as { window: unknown }).window = { api: { hookRespond } }
      const q = useApprovalQueue(deps)
      q.addPendingApproval(wire('r1', 'S1', 1000))
      await q.resolveApproval('r1', 'deny')
      expect(q.pendingApprovalCount.value).toBe(0) // still optimistically removed
      expect(useUiStore().toasts).toHaveLength(1)
      expect(useUiStore().toasts[0].kind).toBe('info')
    })

    it('never throws when hookRespond rejects', async () => {
      const hookRespond = vi.fn().mockRejectedValue(new Error('ipc down'))
      ;(globalThis as unknown as { window: unknown }).window = { api: { hookRespond } }
      const q = useApprovalQueue(deps)
      q.addPendingApproval(wire('r1', 'S1', 1000))
      await expect(q.resolveApproval('r1', 'allow')).resolves.toBeUndefined()
      expect(q.pendingApprovalCount.value).toBe(0)
    })
  })
})
