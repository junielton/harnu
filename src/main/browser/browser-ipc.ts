/**
 * Browser pane IPC (T564 U1): the renderer's door onto the view host. The renderer owns geometry and chrome,
 * never page content (spec §2.1): it reports the pane host's rect and the overlay layers, and asks main to
 * navigate, close, pause or disconnect. Every payload is validated here, because an IPC argument is untrusted
 * input however friendly its sender.
 *
 * Electron-bound glue (ipcMain); the decisions live in `view-host`, `access`, `nav-policy` and `bounds`.
 */
import {
  app,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { PAUSE_MS } from './access'
import { checkTopLevelNavigation } from './nav-policy'
import {
  bindBrowserWindow,
  browserAccess,
  browserLeases,
  browserRegistry,
  closePaneFromOperator,
  getBrowserHost,
  openOperatorPane
} from './browser-service'
import type { BrowserOverlayRect, BrowserRect } from './state-types'
import type { NavigateTarget } from './verbs-core'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isPaneId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 80
}

function toRect(v: unknown): BrowserRect | null {
  if (!isRecord(v)) return null
  const { x, y, width, height } = v
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

function toOverlay(v: unknown): BrowserOverlayRect | null {
  return v === 'fullscreen' ? 'fullscreen' : toRect(v)
}

export function registerBrowserIpc(getWindow: () => BrowserWindow | null): void {
  bindBrowserWindow(getWindow)
  const host = (): ReturnType<typeof getBrowserHost> => getBrowserHost()

  // Every app-side `browser:*` channel is accepted ONLY from the app window's own webContents. A guest page
  // runs in a different webContents (and has no preload API anyway), so even a compromised page cannot drive
  // these. The guest's own channels (overlay, page API) arrive in later units and will be accepted only from a
  // webContents the registry holds; this unit's guest preload registers none.
  const fromApp = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const win = getWindow()
    return win !== null && !win.isDestroyed() && e.sender === win.webContents
  }
  const onApp = (channel: string, fn: (...args: unknown[]) => void): void => {
    ipcMain.on(channel, (e, ...args) => {
      if (fromApp(e)) fn(...args)
    })
  }
  const handleApp = <T>(channel: string, fn: (...args: unknown[]) => T): void => {
    ipcMain.handle(channel, (e, ...args) => {
      // A call from anywhere else is refused outright (the caller's promise rejects).
      if (!fromApp(e)) throw new Error(`${channel}: refused, not sent by the app window`)
      return fn(...args)
    })
  }

  // The operator opened a pane (Split menu). `folder` is the stack's worktree path.
  handleApp('browser:open', (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.folder !== 'string' || payload.folder.length === 0) {
      return { ok: false as const, error: 'BAD_ARGS' }
    }
    const url =
      typeof payload.url === 'string' && payload.url.length > 0 ? payload.url : 'about:blank'
    const verdict = checkTopLevelNavigation(url, 'operator')
    if (!verdict.ok) return { ok: false as const, error: verdict.code }
    try {
      return { ok: true as const, ...openOperatorPane({ folder: payload.folder, url }) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Geometry and overlays are fire-and-forget: they ride animation frames.
  onApp('browser:bounds', (payload: unknown) => {
    if (!isRecord(payload) || !isPaneId(payload.paneId)) return
    const rect = toRect(payload.rect)
    if (!rect) return
    host().applyBounds(payload.paneId, rect, payload.visible === true)
  })
  onApp('browser:overlays', (payload: unknown) => {
    if (!Array.isArray(payload)) return
    const overlays = payload.map(toOverlay).filter((o): o is BrowserOverlayRect => o !== null)
    host().setOverlays(overlays)
  })
  onApp('browser:drag', (active: unknown) => host().setDragActive(active === true))
  onApp('browser:freezePainted', (paneId: unknown) => {
    if (isPaneId(paneId)) host().freezePainted(paneId)
  })
  onApp('browser:setChords', (chords: unknown) => {
    if (Array.isArray(chords))
      host().setBoundChords(chords.filter((c): c is string => typeof c === 'string'))
  })

  handleApp('browser:navigate', (payload: unknown) => {
    if (!isRecord(payload) || !isPaneId(payload.paneId)) return { ok: false as const, scheme: '' }
    let target: NavigateTarget
    if (typeof payload.url === 'string') target = { url: payload.url }
    else if (
      payload.action === 'back' ||
      payload.action === 'forward' ||
      payload.action === 'reload' ||
      payload.action === 'stop'
    ) {
      target = { action: payload.action }
    } else return { ok: false as const, scheme: '' }
    return host().operatorNavigate(payload.paneId, target)
  })

  handleApp('browser:state', (paneId: unknown) => (isPaneId(paneId) ? host().state(paneId) : null))
  handleApp('browser:destroy', (paneId: unknown) => {
    if (isPaneId(paneId)) closePaneFromOperator(paneId)
    return true
  })
  // The renderer needs the keyboard (a forwarded chord focused the address bar while the guest had the focus).
  handleApp('browser:focusApp', () => {
    host().focusApp()
    return true
  })
  handleApp('browser:devtools', (paneId: unknown) => {
    if (isPaneId(paneId)) host().openDevTools(paneId)
    return true
  })
  handleApp('browser:dismissFlag', (paneId: unknown) => {
    if (isPaneId(paneId)) host().dismissFlag(paneId)
    return true
  })
  handleApp('browser:dismissNotice', (paneId: unknown) => {
    if (isPaneId(paneId)) host().dismissNotice(paneId)
    return true
  })

  // The operator's decisions about the agent (spec §7.4). Disconnect is permanent: no handler reconnects.
  handleApp('browser:disconnect', (paneId: unknown) => {
    if (!isPaneId(paneId) || !browserRegistry.get(paneId)) return false
    browserAccess.disconnect(paneId)
    // Disconnect ends the agent's lease on the pane for good (spec §7.1).
    browserLeases.revoke(paneId)
    // A disconnected pane records nothing more (spec §6.2): end any network capture the agent had running.
    host().stopCapture(paneId, 'disconnected')
    host().refresh(paneId)
    return true
  })
  handleApp('browser:pause', (paneId: unknown) => {
    if (!isPaneId(paneId) || !browserRegistry.get(paneId) || browserAccess.isDisconnected(paneId)) {
      return null
    }
    const until = browserAccess.pause(paneId, PAUSE_MS)
    host().refresh(paneId)
    return until
  })
  handleApp('browser:resume', (paneId: unknown) => {
    if (!isPaneId(paneId) || !browserRegistry.get(paneId)) return false
    browserAccess.resume(paneId)
    host().refresh(paneId)
    return true
  })

  // Quitting destroys every guest with the window.
  app.on('before-quit', () => host().destroyAll())
}
