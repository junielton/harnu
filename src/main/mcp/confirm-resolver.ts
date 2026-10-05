/**
 * Imperative shell (T22) wiring the pure fail-closed confirm gate
 * ({@link createConfirmCore} in `confirm-core.ts`) to the renderer over IPC.
 *
 * When a gated MCP mutation needs human sign-off, the server parks a confirm in
 * the core and the core hands the {@link ConfirmWire} to this shell's `send`,
 * which surfaces it to the operator via `webContents.send('mcp:confirm:pending',
 * …)`. The operator answers on `mcp:confirm:respond`. No live window ⇒ `send`
 * returns `false` and the core fails CLOSED (`NO_WINDOW` ⇒ deny).
 *
 * BUG-25: `send` fires exactly ONCE, at park time. `mcp:confirm:list` is the
 * re-hydration counterpart — the renderer calls it once at boot to fetch every
 * still-live confirm's wire, so a confirm that parked before a listener was
 * attached (a reload mid-park, a fresh window) is not lost until its TTL.
 *
 * BUG-32: a `parked` confirm used to stay parked forever, even once the
 * operator came back — `send` only ever fires once, at park time, and nothing
 * re-routed it to the modal. On `app`-level `browser-window-focus` (mirrors
 * `usage.ts`'s focus-gated polling: registered before `createWindow`, so it
 * must hang off the app, not a specific window instance) this re-sends every
 * confirm {@link ConfirmCore.promotePending} promotes to `modal` over the SAME
 * `mcp:confirm:pending` channel — the overlay picks it up exactly like a fresh
 * arrival, the parked-queue store recognizes the mode flip and drops its row
 * (no re-chime, T44 S4c's sound already fired at park time). `browser-window-blur`
 * advances the focus epoch ({@link ConfirmCore.advanceFocusEpoch}) so a
 * dismissed confirm (D4) doesn't immediately re-promote on the very next focus.
 *
 * SECURITY — these channels are PHYSICALLY DISTINCT from the `hook:*` /
 * `claude:hook` / Approval Inbox channels: the MCP confirm gate is a separate
 * surface from the hook responder, and must never share a channel where a hook
 * payload could be mistaken for (or coerce) a confirm verdict. On teardown
 * {@link closeMcpConfirm} denies every parked confirm (`rejectAll`).
 *
 * env-bound (electron IPC) ⇒ e2e-only per ADR-0001.
 */

import { app, ipcMain, type BrowserWindow } from 'electron'
import {
  createConfirmCore,
  type ConfirmCore,
  type ConfirmResponseData,
  type ConfirmWire,
  type Verdict
} from './confirm-core'

/** What {@link registerMcpConfirm} hands back to the integrator. */
export interface McpConfirmRegistration {
  /** The live confirm gate the MCP mutation path parks promises in. */
  confirm: ConfirmCore
}

/** Module-level handle so {@link closeMcpConfirm} can deny parked confirms. */
let activeConfirm: ConfirmCore | null = null
/** BUG-32: detachable app-level focus/blur listeners, torn down in {@link closeMcpConfirm}. */
let onWindowFocus: (() => void) | null = null
let onWindowBlur: (() => void) | null = null

/**
 * Construct the {@link ConfirmCore} over the renderer surface and wire its IPC.
 *
 * @param getWindow - resolves the current main window (or `null` if none).
 * @returns the constructed confirm gate.
 */
export function registerMcpConfirm(getWindow: () => BrowserWindow | null): McpConfirmRegistration {
  const confirm = createConfirmCore({
    send: (wire: ConfirmWire): boolean => {
      const win = getWindow()
      if (!win || win.isDestroyed()) return false
      win.webContents.send('mcp:confirm:pending', wire)
      return true
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
    now: Date.now,
    // T44 S4: focused → the fast modal; not focused → parked in the Inbox +
    // chime/OS-attention. A render hint only; never changes the fail-closed lifecycle.
    isFocused: () => {
      const win = getWindow()
      return !!win && !win.isDestroyed() && win.isFocused()
    },
    // T44 S4: prune a parked Inbox row on ANY settle (respond/TTL/cancel/rejectAll).
    onSettled: (id, outcome) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('mcp:confirm:resolved', { id, reason: outcome.reason })
      }
    }
  })
  activeConfirm = confirm

  // The operator's verdict for a parked confirm id. `respond` is a no-op when
  // the id is unknown / already settled / timed out (returns false). `data`
  // carries T61's create_worktree inherit-checkbox choice (optional).
  ipcMain.handle(
    'mcp:confirm:respond',
    (_e, { id, verdict, data }: { id: string; verdict: Verdict; data?: ConfirmResponseData }) =>
      confirm.respond(id, verdict, data)
  )

  // BUG-25: snapshot of every still-live confirm — the renderer calls this once
  // at boot (mirrors `hook:approvals:list` in `approval-resolver.ts`) to
  // re-hydrate any confirm that parked before it was listening. Without this,
  // `send`'s one-shot `mcp:confirm:pending` fire is the ONLY delivery: a
  // renderer reload (dev HMR, a preload/main restart, a crash recovery) after
  // that fire drops the confirm from every UI surface — modal AND parked —
  // until the operator-away TTL denies it 30 minutes later with nobody ever
  // having seen it.
  ipcMain.handle('mcp:confirm:list', () => confirm.list())

  // BUG-32 D3: the operator's "not now" on a modal confirm — never a verdict,
  // never settles. Re-sends the reverted (mode: 'parked') wire over the same
  // channel `park`/promotion use so the overlay drops it and the parked-queue
  // store re-adds the row, symmetric with the promotion path above.
  ipcMain.handle('mcp:confirm:dismiss', (_e, id: string) => {
    const wire = confirm.dismiss(id)
    if (wire) {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('mcp:confirm:pending', wire)
    }
    return { ok: wire !== false }
  })

  // BUG-32 D1: promote every still-parked confirm to modal the moment the
  // operator returns, over whatever screen is active. Hangs off `app` (not a
  // specific BrowserWindow) because this registers before `createWindow` runs
  // (mirrors `usage.ts`'s focus-gated polling) and must keep working across a
  // window recreation (macOS `activate` with zero windows).
  onWindowFocus = (): void => {
    const promoted = confirm.promotePending()
    if (promoted.length === 0) return
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    for (const wire of promoted) win.webContents.send('mcp:confirm:pending', wire)
  }
  // D4: a blur ends the current focus session — a dismissal recorded in it no
  // longer excludes its confirm from the NEXT focus-regain promotion.
  onWindowBlur = (): void => confirm.advanceFocusEpoch()
  app.on('browser-window-focus', onWindowFocus)
  app.on('browser-window-blur', onWindowBlur)

  return { confirm }
}

/** Deny + clear every parked confirm on server/window teardown (fail closed). */
export function closeMcpConfirm(): void {
  activeConfirm?.rejectAll()
  activeConfirm = null
  if (onWindowFocus) {
    app.removeListener('browser-window-focus', onWindowFocus)
    onWindowFocus = null
  }
  if (onWindowBlur) {
    app.removeListener('browser-window-blur', onWindowBlur)
    onWindowBlur = null
  }
}
