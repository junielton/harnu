/**
 * Imperative shell (T21) wiring the pure {@link CommandBridge} (`command-bridge.ts`)
 * to the renderer over IPC. The MCP server actuates renderer-owned operations
 * (`create_session`, `spawn_terminal`) by dispatching a correlated message and
 * awaiting the renderer's ack on the matching `requestId`.
 *
 * The bridge core is framework-free; this shell injects the four side-effecting
 * collaborators: `send` over `webContents.send('renderer:command', …)` (returns
 * `false` when there is no live window, so the dispatch rejects `NO_WINDOW`
 * instead of parking forever), `now` = `Date.now`, and the `setTimeout`/
 * `clearTimeout` pair.
 *
 * DISPATCH GATE — a dispatch is REFUSED (no window ⇒ immediate `NO_WINDOW`
 * reject, nothing parks) until the renderer announces it is mounted via
 * `renderer:ready`. The handler is `ipcMain.on` (not `once`), so it re-arms
 * across renderer reloads; a second `renderer:ready` (a reload) first rejects
 * the now-orphaned in-flight dispatches the fresh renderer will never ack.
 *
 * env-bound (electron IPC) ⇒ e2e-only per ADR-0001.
 */

import { ipcMain, type BrowserWindow } from 'electron'
import { CommandBridge, type CommandMessage } from './command-bridge'
import { evictInflightSessionById } from './mcp/inflight-session-registry'
import { releaseResolvedInflightReservations } from './mcp/tool-handlers'

/** What {@link registerCommandBridge} hands back to the integrator. */
export interface CommandBridgeRegistration {
  /** The live bridge the MCP server dispatches through. */
  bridge: CommandBridge
  /** Open the dispatch gate explicitly (e.g. when the window is known up). */
  markReady(): void
}

/** Module-level handle so {@link closeCommandBridge} can settle in-flight work. */
let activeBridge: CommandBridge | null = null

/**
 * Construct the {@link CommandBridge}, wire its IPC, and gate dispatch behind the
 * renderer-ready handshake. Returns the bridge plus a `markReady()` escape hatch.
 *
 * @param getWindow - resolves the current main window (or `null` if none).
 * @returns the constructed bridge + a `markReady` opener.
 */
export function registerCommandBridge(
  getWindow: () => BrowserWindow | null
): CommandBridgeRegistration {
  let ready = false

  const bridge = new CommandBridge({
    send: (message: CommandMessage): boolean => {
      // Gate: refuse to dispatch until the renderer has announced readiness.
      if (!ready) return false
      const win = getWindow()
      if (!win || win.isDestroyed()) return false
      win.webContents.send('renderer:command', message)
      return true
    },
    now: Date.now,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle)
  })
  activeBridge = bridge

  // The renderer echoes the correlation id + its result; settle the dispatch.
  ipcMain.handle(
    'renderer:command:ack',
    (_e, { requestId, result }: { requestId: string; result: unknown }) =>
      bridge.ack(requestId, result)
  )

  // This card (ADR-0003): the renderer's out-of-band report that a synthetic
  // session migrated to a real, on-disk one — the materialization signal
  // `create_session`'s ACK awaits before ever claiming `ok:true`. Not a
  // correlated dispatch (no requestId to settle); `notifyMaterialized` finds
  // the matching wait, if any, by `syntheticId`.
  ipcMain.on(
    'renderer:session-materialized',
    (_e, info: { syntheticId: string; sessionId: string; folder: string }) => {
      const hadWaiter = bridge.notifyMaterialized(info)
      // BUG-89: this report is the earliest, authoritative signal that
      // `info.syntheticId` resolved — evict its in-flight registry entry right
      // now (so get_fleet/get_session stop showing it), instead of waiting for
      // the next read or the 60-min TTL backstop. Unconditional: a `false`
      // `hadWaiter` (late notify — the create_session ACK already timed out
      // with SPAWN_NOT_MATERIALIZED) must still clear the registry entry (AC-2).
      const evicted = evictInflightSessionById(info.syntheticId)
      if (!evicted) return
      // The per-folder RESERVATION release (agent-inflight-registry.ts) is
      // single-owner by design (create-session-core.ts's own comment:
      // "ownership of the release transfers to whichever resolves the
      // in-flight registration first"). `hadWaiter: true` means the ORIGINAL
      // create_session call is still parked on `awaitMaterialization` and its
      // own `finally` — via `deps.release`, unconditional, not identity-guarded
      // — is about to run and release the reservation itself; releasing it a
      // second time here would race that unconditional release against
      // whatever folder claim lands in the gap. Only take over the release
      // when there was NO waiter to resolve (AC-2's late-notify case) — that
      // is exactly when `runCreateSession` already gave up ownership
      // (`heldOnTimeout`) without releasing.
      if (!hadWaiter) releaseResolvedInflightReservations([evicted])
    }
  )

  // Ready handshake — re-arms on every renderer load. A second fire means the
  // renderer reloaded: reject in-flight dispatches it will never ack, then open.
  ipcMain.on('renderer:ready', () => {
    if (ready) bridge.rejectAll('renderer-reload')
    ready = true
  })

  return {
    bridge,
    markReady(): void {
      ready = true
    }
  }
}

/** Reject every pending dispatch with `shutdown` on server/window teardown. */
export function closeCommandBridge(): void {
  activeBridge?.rejectAll('shutdown')
  activeBridge = null
}
