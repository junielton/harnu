import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  parseApprovalBody,
  type PendingApprovalWire,
  type ApprovalResolvedReason
} from './approval-parse'
import { responderRegistry, rampActionFor, pushShadowEntry } from './responder-registry'
import type { HookDecision, HookRequest, Resolver } from './responder-dispatch'

/**
 * Approval Inbox — the parking resolver (approval-inbox spec §4, adapted to the
 * resolver-chain substrate). Registers a resolver on `responderRegistry` that, in
 * `active` mode, HOLDS a gated tool call (`PreToolUse`/`PermissionRequest`),
 * surfaces it to the renderer as a `hook:approval:pending`, and resolves it with
 * the operator's Allow/Deny — or abstains (fail-open) when the substrate's
 * deadline aborts. Validated by the protocol-gate spike (lesson framework/004):
 * Claude Code obeys a decision returned even ~3s late.
 *
 * In `shadow`/`off` it abstains IMMEDIATELY (no parking), so preview/observer
 * modes add zero latency. The deadline is owned by the dispatch branch
 * (RESPONDER_DEADLINE_MS); `APPROVAL_WINDOW_MS` mirrors it only for the UI
 * countdown (`deadlineMs`), never to gate the actual abort.
 */
const APPROVAL_WINDOW_MS = 3500 // mirrors RESPONDER_DEADLINE_MS in hook-bridge.ts (UI countdown only)

/** Tool-gate events the inbox holds. PreToolUse fires before every tool and
 *  obeys decisions (lesson 004); PermissionRequest is the explicit ask. */
const GATED = new Set(['PreToolUse', 'PermissionRequest'])

interface Parked {
  wire: PendingApprovalWire
  settle: (decision: HookDecision | null, reason: ApprovalResolvedReason) => void
}

const pending = new Map<string, Parked>()
let getWin: (() => BrowserWindow | null) | null = null

function send(channel: string, payload: unknown): void {
  const win = getWin?.()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** The resolver registered on the substrate. Priority 50 — runs before the noop
 *  (1000); future auto-approve/Sentinel resolvers take lower numbers to pre-empt. */
export const approvalResolver: Resolver = {
  id: 'approval-inbox',
  priority: 50,
  resolve: (req: HookRequest, signal: AbortSignal): null | Promise<HookDecision | null> => {
    // T30 per-folder trust ramp: decide park / preview / ignore from the global
    // mode + the folder's ramp membership (resolved from the hook cwd). Abstaining
    // synchronously here is what keeps shadow / off-ramp / off zero-latency.
    const action = rampActionFor((req.raw as { cwd?: unknown }).cwd, GATED.has(req.event))
    if (action === 'ignore') return null

    const now = Date.now()

    if (action === 'preview') {
      // Log a "would-gate" entry (by:'approval-inbox') so the operator can preview
      // the inbox ITSELF — what active would have held in this folder — before
      // flipping its ramp on. Abstain (fail-open 200 {}); nothing parked.
      const preview = parseApprovalBody(req.raw, {
        requestId: '',
        kind: 'permission_request',
        createdAtMs: now,
        deadlineMs: 0
      })
      pushShadowEntry({
        sessionId: req.sessionId,
        event: req.event,
        by: 'approval-inbox',
        summary: preview.summary,
        ts: now
      })
      return null
    }

    // action === 'park' — hold the tool call for a human (unchanged fail-open park).
    const requestId = randomUUID()
    const wire = parseApprovalBody(req.raw, {
      requestId,
      kind: 'permission_request',
      createdAtMs: now,
      deadlineMs: now + APPROVAL_WINDOW_MS
    })

    return new Promise<HookDecision | null>((resolvePromise) => {
      const settle = (decision: HookDecision | null, reason: ApprovalResolvedReason): void => {
        if (!pending.has(requestId)) return // already settled (race between click + deadline)
        pending.delete(requestId)
        signal.removeEventListener('abort', onAbort)
        send('hook:approval:resolved', { requestId, reason })
        resolvePromise(decision)
      }
      const onAbort = (): void => settle(null, 'timeout')
      signal.addEventListener('abort', onAbort, { once: true })
      pending.set(requestId, { wire, settle })
      send('hook:approval:pending', wire)
    })
  }
}

/** Resolve a parked approval with the operator's decision. Returns false if the
 *  request already settled (deadline won, or a double-click) — drives the
 *  renderer's "expired" toast. */
export function respondApproval(requestId: string, decision: 'allow' | 'deny'): boolean {
  const p = pending.get(requestId)
  if (!p) return false
  p.settle({ permissionDecision: decision, by: 'approval-inbox' }, 'decided')
  return true
}

/** Snapshot of the live parked approvals (re-hydrates the renderer queue on reload). */
export function listPendingApprovals(): PendingApprovalWire[] {
  return [...pending.values()].map((p) => p.wire)
}

/**
 * Wire the resolver + its IPC. Registers the resolver on the substrate and the
 * request/response channels. Input is validated (lesson security/001): a bad
 * requestId/decision is rejected before touching the parked map.
 */
export function registerApprovalResolver(opts: { getWindow: () => BrowserWindow | null }): void {
  getWin = opts.getWindow
  responderRegistry.register(approvalResolver)

  ipcMain.handle('hook:respond', (_e, payload: { requestId?: unknown; decision?: unknown }) => {
    const requestId = payload?.requestId
    const decision = payload?.decision
    if (typeof requestId !== 'string' || requestId.length === 0) return { ok: false }
    if (decision !== 'allow' && decision !== 'deny') return { ok: false }
    return { ok: respondApproval(requestId, decision) }
  })
  ipcMain.handle('hook:approvals:list', () => listPendingApprovals())
}

/** Teardown: settle every parked approval as a timeout (fail-open) so no resolver
 *  promise is left hanging, then unregister. Idempotent. */
export function closeApprovals(): void {
  for (const [, p] of [...pending]) p.settle(null, 'timeout')
  pending.clear()
  responderRegistry.unregister('approval-inbox')
}

/** Test-only reset. */
export function _resetApprovals(): void {
  pending.clear()
  getWin = null
}
