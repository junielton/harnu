/**
 * Sentinel resolver (T31): auto-DENY a small, conservative set of catastrophic
 * shell commands ({@link sentinelVerdict}) BEFORE the Approval Inbox ever parks
 * them for a human. Priority 20 — runs before the parking resolver (50), so a
 * `deny` here short-circuits the dispatch.
 *
 * Deny-only: it abstains (`null`) on everything it doesn't recognize as a
 * disaster, so it can never widen access. It respects the T30 ramp (via
 * `rampActionFor`) — it only ACTS where the interceptor is active:
 *   - `park` (active, on-ramp) → auto-deny + a `by:'sentinel'` shadow entry +
 *     a `sentinel:blocked` nudge to the renderer (a blocked catastrophe is worth
 *     surfacing).
 *   - `preview` (shadow / active off-ramp) → a would-deny shadow entry only.
 *   - `ignore` (off / non-gated) → nothing.
 *
 * env-bound (registry + renderer send) ⇒ e2e-only per ADR-0001; all the risk
 * logic is the pure {@link sentinelVerdict}.
 */

import type { BrowserWindow } from 'electron'
import { rampActionFor, pushShadowEntry, responderRegistry } from './responder-registry'
import { sentinelVerdict } from './sentinel-core'
import type { HookDecision, HookRequest, Resolver } from './responder-dispatch'

/** Tool-gate events the Sentinel inspects (same as the Approval Inbox). */
const GATED = new Set(['PreToolUse', 'PermissionRequest'])

let getWin: (() => BrowserWindow | null) | null = null

/** The resolver registered on the substrate. Priority 20 → before approval-inbox (50). */
export const sentinelResolver: Resolver = {
  id: 'sentinel',
  priority: 20,
  resolve: (req: HookRequest): HookDecision | null => {
    const action = rampActionFor((req.raw as { cwd?: unknown }).cwd, GATED.has(req.event))
    if (action === 'ignore') return null

    const verdict = sentinelVerdict(req.toolName, req.toolInput)
    if (!verdict.dangerous) return null

    const reason = verdict.reason ?? 'catastrophic command'
    // Visible either way — the operator sees what the safety net caught.
    pushShadowEntry({
      sessionId: req.sessionId,
      event: req.event,
      by: 'sentinel',
      summary: `blocked: ${reason}`,
      ts: Date.now()
    })

    // shadow / off-ramp → would-deny preview only (never actually deny).
    if (action !== 'park') return null

    // active on-ramp → auto-deny (fail-safe) + surface it.
    const win = getWin?.()
    if (win && !win.isDestroyed()) {
      win.webContents.send('sentinel:blocked', { reason, sessionId: req.sessionId })
    }
    return {
      permissionDecision: 'deny',
      reason: `Harnu Sentinel blocked ${reason}`,
      by: 'sentinel'
    }
  }
}

/** Register the Sentinel resolver on the shared substrate + wire its renderer nudge. */
export function registerSentinel(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow
  responderRegistry.register(sentinelResolver)
}
