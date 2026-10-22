/**
 * Browser pane IPC (T564 U1): the renderer's door onto the view host. The renderer owns geometry and chrome,
 * never page content (spec §2.1): it reports the pane host's rect and the overlay layers, and asks main to
 * navigate, close, pause or disconnect. Every payload is validated here, because an IPC argument is untrusted
 * input however friendly its sender.
 *
 * Electron-bound glue (ipcMain); the decisions live in `view-host`, `access`, `nav-policy` and `bounds`.
 */
import { app, ipcMain, type BrowserWindow } from 'electron'
import { PAUSE_MS } from './access'
import { checkTopLevelNavigation } from './nav-policy'
import {
  bindBrowserWindow,
  browserAccess,
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

  // The operator opened a pane (Split menu). `folder` is the stack's worktree path.
  ipcMain.handle('browser:open', (_e, payload: unknown) => {
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
  ipcMain.on('browser:bounds', (_e, payload: unknown) => {
    if (!isRecord(payload) || !isPaneId(payload.paneId)) return
    const rect = toRect(payload.rect)
    if (!rect) return
    host().applyBounds(payload.paneId, rect, payload.visible === true)
  })
  ipcMain.on('browser:overlays', (_e, payload: unknown) => {
    if (!Array.isArray(payload)) return
    const overlays = payload.map(toOverlay).filter((o): o is BrowserOverlayRect => o !== null)
    host().setOverlays(overlays)
  })
  ipcMain.on('browser:drag', (_e, active: unknown) => host().setDragActive(active === true))
  ipcMain.on('browser:freezePainted', (_e, paneId: unknown) => {
    if (isPaneId(paneId)) host().freezePainted(paneId)
  })
  ipcMain.on('browser:setChords', (_e, chords: unknown) => {
    if (Array.isArray(chords))
      host().setBoundChords(chords.filter((c): c is string => typeof c === 'string'))
  })

  ipcMain.handle('browser:navigate', (_e, payload: unknown) => {
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

  ipcMain.handle('browser:state', (_e, paneId: unknown) =>
    isPaneId(paneId) ? host().state(paneId) : null
  )
  ipcMain.handle('browser:destroy', (_e, paneId: unknown) => {
    if (isPaneId(paneId)) closePaneFromOperator(paneId)
    return true
  })
  ipcMain.handle('browser:devtools', (_e, paneId: unknown) => {
    if (isPaneId(paneId)) host().openDevTools(paneId)
    return true
  })
  ipcMain.handle('browser:dismissFlag', (_e, paneId: unknown) => {
    if (isPaneId(paneId)) host().dismissFlag(paneId)
    return true
  })
  ipcMain.handle('browser:dismissNotice', (_e, paneId: unknown) => {
    if (isPaneId(paneId)) host().dismissNotice(paneId)
    return true
  })

  // The operator's decisions about the agent (spec §7.4). Disconnect is permanent: no handler reconnects.
  ipcMain.handle('browser:disconnect', (_e, paneId: unknown) => {
    if (!isPaneId(paneId) || !browserRegistry.get(paneId)) return false
    browserAccess.disconnect(paneId)
    host().refresh(paneId)
    return true
  })
  ipcMain.handle('browser:pause', (_e, paneId: unknown) => {
    if (!isPaneId(paneId) || !browserRegistry.get(paneId) || browserAccess.isDisconnected(paneId)) {
      return null
    }
    const until = browserAccess.pause(paneId, PAUSE_MS)
    host().refresh(paneId)
    return until
  })
  ipcMain.handle('browser:resume', (_e, paneId: unknown) => {
    if (!isPaneId(paneId) || !browserRegistry.get(paneId)) return false
    browserAccess.resume(paneId)
    host().refresh(paneId)
    return true
  })

  // Quitting destroys every guest with the window.
  app.on('before-quit', () => host().destroyAll())
}
