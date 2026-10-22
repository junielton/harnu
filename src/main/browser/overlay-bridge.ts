/**
 * The point-and-comment bridge (T564 U6, spec §8): the guest's private overlay channels, the crop, and the
 * app-window channels the docked composer uses. Electron-bound glue; every decision it makes lives in a pure
 * module next to it (`comment-plan`, `comment-payload`, `comment-pins`, `comment-format`, `comment-delivery`).
 *
 * Who may speak:
 *  - the GUEST channels (`OVERLAY_CHANNEL`) are accepted only from a registered guest `webContents`, from its
 *    top frame (`event.senderFrame === event.sender.mainFrame`);
 *  - the APP channels (`browser:overlaySet`, `browser:comment*`) only from the app window's own `webContents`
 *    (`onApp` / `handleApp` from `browser-ipc.ts`). A guest has no preload path to them, and no MCP verb
 *    reaches either set: an agent can neither type into the composer nor press Send (spec §8.6).
 *
 * The comment text only ever travels renderer → main. It is never sent to the guest.
 */
import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { clipboard, ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import { appendAudit } from '../mcp/audit-log'
import { waitForSessionReady } from '../pty'
import {
  COMMENT_MAX_CHARS,
  DEFAULT_OVERLAY_THEME,
  MAX_PINS_PER_PANE,
  OVERLAY_CHANNEL,
  isSafeColor,
  scrubUrl,
  type CommentPaneState,
  type CommentSubmitResult,
  type OverlayGuestState,
  type OverlayRect,
  type OverlayTheme
} from '../../shared/browser-comment'
import { createCommentDelivery, type CommentDelivery } from './comment-delivery'
import { cropRect, cropRelPath, scaledCropSize, toRect, validatePicked } from './comment-payload'
import { createPinStore, paneStateOf, type PinStore } from './comment-pins'
import { evaluatePickGate } from './comment-plan'
import type { BrowserAccess } from './access'
import type { BrowserRegistry } from './registry'
import type { BrowserViewHost } from './view-host'

export interface OverlayBridgeDeps {
  registry: BrowserRegistry
  access: BrowserAccess
  getHost(): BrowserViewHost
  getWindow(): BrowserWindow | null
  now(): number
  /** The renderer command bridge; `undefined` until `registerMcpServer` hands it over. */
  getBridge(): { dispatch(command: string, payload: unknown): Promise<unknown> } | undefined
}

export interface AppChannels {
  onApp(channel: string, fn: (...args: unknown[]) => void): void
  handleApp<T>(channel: string, fn: (...args: unknown[]) => T): void
}

export interface OverlayBridge {
  registerIpc(app: AppChannels): void
  /** The operator disconnected the agent from a pane: picking ends there (comments are off on it). */
  onDisconnected(paneId: string): void
  /** A pane closed: forget its pins and overlay state. */
  forget(paneId: string): void
  /** Test and live-proof hook. */
  pins(): PinStore
}

interface PaneRuntime {
  active: boolean
  hint: string
  exitHint: string
  theme: OverlayTheme
  openPinId: string | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isPaneId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 80
}

export function createOverlayBridge(deps: OverlayBridgeDeps): OverlayBridge {
  const pins = createPinStore({ now: deps.now, newId: () => randomBytes(4).toString('hex') })
  const runtime = new Map<string, PaneRuntime>()

  const rt = (paneId: string): PaneRuntime => {
    let r = runtime.get(paneId)
    if (!r) {
      r = { active: false, hint: '', exitHint: '', theme: DEFAULT_OVERLAY_THEME, openPinId: null }
      runtime.set(paneId, r)
    }
    return r
  }

  const delivery: CommentDelivery = createCommentDelivery({
    now: deps.now,
    pins,
    pane(paneId) {
      const rec = deps.registry.get(paneId)
      if (!rec) return undefined
      return {
        folder: rec.folder,
        name: rec.name,
        ownerSessionId: rec.ownerSessionId,
        disconnected: deps.access.isDisconnected(paneId)
      }
    },
    delivery: {
      dispatch: (command, payload) => {
        const bridge = deps.getBridge()
        if (!bridge) return Promise.reject(new Error('no renderer bridge'))
        return bridge.dispatch(command, payload)
      },
      waitForSessionReady
    },
    copyToClipboard: (text) => clipboard.writeText(text),
    audit: ({ folder, verdict, result, paneId }) =>
      appendAudit({
        ts: deps.now(),
        tool: 'browser_comment',
        folder,
        verdict,
        disclosedPayloadSummary: 'none',
        result: `${result}: pane ${paneId}`
      })
  })

  /* ---- Pushes ------------------------------------------------------------------------------------ */

  function guestState(paneId: string, url: string): OverlayGuestState {
    const r = rt(paneId)
    return {
      active: r.active,
      hint: r.hint,
      exitHint: r.exitHint,
      theme: r.theme,
      pins: pins.guestPins(paneId, url)
    }
  }

  function pushGuest(paneId: string): void {
    const wc = deps.getHost().webContentsOf(paneId)
    if (!wc || wc.isDestroyed()) return
    wc.send(OVERLAY_CHANNEL.state, guestState(paneId, wc.getURL()))
  }

  function paneState(paneId: string): CommentPaneState {
    const r = rt(paneId)
    return paneStateOf(paneId, pins.views(paneId), r.active, r.openPinId)
  }

  function pushApp(paneId: string): void {
    const win = deps.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('browser:commentState', paneState(paneId))
  }

  function pushBoth(paneId: string): void {
    pushGuest(paneId)
    pushApp(paneId)
  }

  /* ---- The guest side ---------------------------------------------------------------------------- */

  /** The registered guest pane behind an event, from its TOP frame, or `null`. */
  function senderPane(event: IpcMainEvent): { paneId: string; url: string } | null {
    const paneId = deps.getHost().paneIdOfWebContents(event.sender.id)
    if (!paneId || !deps.registry.get(paneId)) return null
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame) return null
    return { paneId, url: frame.url }
  }

  async function writeCrop(
    paneId: string,
    pinId: string,
    node: OverlayRect,
    viewport: { width: number; height: number }
  ): Promise<void> {
    const wc = deps.getHost().webContentsOf(paneId)
    const rec = deps.registry.get(paneId)
    const pin = pins.get(paneId, pinId)
    const rect = cropRect(node, viewport)
    if (!wc || !rec || !pin || !rect) return
    try {
      let image = await wc.capturePage(rect)
      if (image.isEmpty()) return
      const size = image.getSize()
      const target = scaledCropSize(size.width, size.height)
      if (target.width !== size.width || target.height !== size.height) {
        image = image.resize({ width: target.width, height: target.height, quality: 'good' })
      }
      const rel = cropRelPath(pin.batchId, pin.n)
      const file = path.join(rec.folder, ...rel.split('/'))
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, image.toPNG(), { mode: 0o644 })
      pins.setCrop(paneId, pinId, rel)
    } catch {
      // No crop is a degraded pin, not a failed one: the HTML and styles still ride in the message.
    }
  }

  async function onPicked(event: IpcMainEvent, raw: unknown): Promise<void> {
    const who = senderPane(event)
    if (!who) return
    const r = rt(who.paneId)
    const input = deps.registry.agentInput(who.paneId)
    const gate = evaluatePickGate({
      now: deps.now(),
      overlayActive: r.active,
      disconnected: deps.access.isDisconnected(who.paneId),
      agentInputInFlight: input.inFlight,
      agentInputAt: input.at,
      agentInputIntervals: input.intervals,
      activationAt: isRecord(raw) && typeof raw.activationAt === 'number' ? raw.activationAt : null
    })
    const folder = deps.registry.get(who.paneId)?.folder ?? ''
    if (!gate.ok) {
      appendAudit({
        ts: deps.now(),
        tool: 'browser_comment',
        folder,
        verdict: 'deny',
        disclosedPayloadSummary: 'none',
        result: `COMMENT_PICK_REFUSED: ${gate.reason}: pane ${who.paneId}`
      })
      pushGuest(who.paneId) // brings the guest's layers back
      return
    }
    const picked = validatePicked(raw)
    if (!picked) {
      pushGuest(who.paneId)
      return
    }
    const added = pins.add(who.paneId, picked, who.url, scrubUrl(who.url))
    if (!added.ok) {
      pushGuest(who.paneId)
      return
    }
    await writeCrop(who.paneId, added.pin.id, picked.rect, picked.viewport)
    r.openPinId = added.pin.id
    pushBoth(who.paneId)
  }

  function registerGuestChannels(): void {
    ipcMain.handle(OVERLAY_CHANNEL.hello, (event) => {
      const who = senderPane(event as unknown as IpcMainEvent)
      return who ? guestState(who.paneId, who.url) : null
    })
    ipcMain.on(OVERLAY_CHANNEL.picked, (event, raw: unknown) => {
      void onPicked(event, raw).catch(() => undefined)
    })
    ipcMain.on(OVERLAY_CHANNEL.pinClicked, (event, raw: unknown) => {
      const who = senderPane(event)
      if (!who || !isRecord(raw) || typeof raw.id !== 'string') return
      if (!pins.get(who.paneId, raw.id)) return
      rt(who.paneId).openPinId = raw.id
      pushApp(who.paneId)
    })
    ipcMain.on(OVERLAY_CHANNEL.exit, (event) => {
      const who = senderPane(event)
      if (!who) return
      rt(who.paneId).active = false
      pushBoth(who.paneId)
    })
    ipcMain.on(OVERLAY_CHANNEL.rects, (event, raw: unknown) => {
      const who = senderPane(event)
      if (!who || !isRecord(raw)) return
      const rects: Record<string, OverlayRect> = {}
      for (const [id, v] of Object.entries(raw).slice(0, MAX_PINS_PER_PANE)) {
        const rect = toRect(v)
        if (rect) rects[id] = rect
      }
      pins.updateRects(who.paneId, rects)
    })
  }

  /* ---- The app side ----------------------------------------------------------------------------- */

  function registerAppChannels({ handleApp }: AppChannels): void {
    handleApp('browser:overlaySet', (payload: unknown) => {
      if (!isRecord(payload) || !isPaneId(payload.paneId) || !deps.registry.get(payload.paneId)) {
        return false
      }
      const r = rt(payload.paneId)
      // A disconnected pane takes no comments: it cannot be switched on (the app disables the button up front).
      if (payload.active === true && deps.access.isDisconnected(payload.paneId)) return false
      r.active = payload.active === true
      if (typeof payload.hint === 'string') r.hint = payload.hint.slice(0, 120)
      if (typeof payload.exitHint === 'string') r.exitHint = payload.exitHint.slice(0, 40)
      if (
        isRecord(payload.theme) &&
        isSafeColor(payload.theme.accent) &&
        isSafeColor(payload.theme.accentInk)
      ) {
        r.theme = { accent: payload.theme.accent, accentInk: payload.theme.accentInk }
      }
      // Picking from the keyboard needs the page to have it: the Esc that ends picking lands in the guest.
      if (r.active) deps.getHost().webContentsOf(payload.paneId)?.focus()
      pushBoth(payload.paneId)
      return true
    })
    handleApp('browser:commentState', (paneId: unknown) =>
      isPaneId(paneId) && deps.registry.get(paneId) ? paneState(paneId) : null
    )
    handleApp('browser:commentOpen', (payload: unknown) => {
      if (!isRecord(payload) || !isPaneId(payload.paneId) || !deps.registry.get(payload.paneId)) {
        return false
      }
      const id = typeof payload.pinId === 'string' ? payload.pinId : null
      if (id !== null && !pins.get(payload.paneId, id)) return false
      rt(payload.paneId).openPinId = id
      pushApp(payload.paneId)
      return true
    })
    handleApp('browser:commentSave', (payload: unknown) => {
      if (
        !isRecord(payload) ||
        !isPaneId(payload.paneId) ||
        typeof payload.pinId !== 'string' ||
        typeof payload.text !== 'string' ||
        payload.text.length > COMMENT_MAX_CHARS
      ) {
        return false
      }
      const ok = pins.saveDraft(payload.paneId, payload.pinId, payload.text)
      if (ok) pushApp(payload.paneId)
      return ok
    })
    handleApp('browser:commentDiscard', (payload: unknown) => {
      if (!isRecord(payload) || !isPaneId(payload.paneId) || typeof payload.pinId !== 'string') {
        return false
      }
      const pin = pins.get(payload.paneId, payload.pinId)
      if (!pin || pin.state !== 'draft') return false
      const ok = pins.remove(payload.paneId, payload.pinId)
      const r = rt(payload.paneId)
      if (r.openPinId === payload.pinId) r.openPinId = null
      pushBoth(payload.paneId)
      return ok
    })
    handleApp('browser:commentSubmit', async (payload: unknown): Promise<CommentSubmitResult> => {
      if (!isRecord(payload) || !isPaneId(payload.paneId)) return { ok: false, error: 'BAD_ARGS' }
      const which =
        payload.which === 'drafts'
          ? 'drafts'
          : Array.isArray(payload.which) &&
              payload.which.length > 0 &&
              payload.which.length <= MAX_PINS_PER_PANE &&
              payload.which.every((x) => typeof x === 'string')
            ? (payload.which as string[])
            : null
      const sessionId =
        typeof payload.sessionId === 'string' && payload.sessionId.length <= 120
          ? payload.sessionId
          : null
      if (which === null) return { ok: false, error: 'BAD_ARGS' }
      const result = await delivery.submit({ paneId: payload.paneId, which, sessionId })
      if (result.ok) {
        const r = rt(payload.paneId)
        if (r.openPinId !== null && pins.get(payload.paneId, r.openPinId)?.state === 'sent') {
          r.openPinId = null
        }
      }
      pushBoth(payload.paneId)
      return result
    })
  }

  let registered = false
  return {
    registerIpc(app) {
      if (registered) return
      registered = true
      registerGuestChannels()
      registerAppChannels(app)
    },
    onDisconnected(paneId) {
      const r = runtime.get(paneId)
      if (!r || !r.active) return
      r.active = false
      pushBoth(paneId)
    },
    forget(paneId) {
      pins.forget(paneId)
      runtime.delete(paneId)
    },
    pins: () => pins
  }
}
