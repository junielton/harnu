/**
 * The browser pane's native view host (T564 U1, spec §2, §3): owns one `WebContentsView` per pane, keeps it
 * on the pane's host rectangle, freezes it under overlays, hardens the guest and forwards chords.
 *
 * Electron-bound glue. Every decision it makes is a pure function with its own tests: `bounds` (rounding,
 * parking, intersection), `nav-policy` (schemes, popups, permissions, certificates), `chord`, `nav-wait`,
 * `access` and the verb logic in `verbs-core`. This file only wires them to Electron events.
 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow, WebContentsView, app, session, type WebContents } from 'electron'
import {
  FREEZE_JPEG_QUALITY,
  PARKED_METRICS,
  freezeCaptureRect,
  needsFreeze,
  parkedBounds,
  placeView,
  type Rect
} from './bounds'
import { decideForward, type GuestInput } from './chord'
import { guestWebPreferences, PARTITION_NAMES, type BrowserPartition } from './guest-prefs'
import { waitForNavigation } from './nav-wait'
import {
  certificateDecision,
  checkTopLevelNavigation,
  decidePopup,
  isPermissionGranted,
  isSubresourceSchemeAllowed
} from './nav-policy'
import { classifyOrigin, hostOf, isLoopbackHost } from './origin-class'
import type { BrowserAccess } from './access'
import type { BrowserRegistry } from './registry'
import type { BrowserNotice, BrowserOverlayRect, BrowserPaneState } from './state-types'
import type { BrowserHost, LivePaneInfo, NavigateOutcome, NavigateTarget } from './verbs-core'

/** How long a real click or key counts as the user activation a popup needs (spec §3.2). */
const GESTURE_WINDOW_MS = 1500
/** Give the renderer this long to paint the frozen image before the view is hidden anyway. */
const FREEZE_PAINT_TIMEOUT_MS = 150

export interface ViewHostDeps {
  getWindow(): BrowserWindow | null
  guestPreloadPath: string
  registry: BrowserRegistry
  access: BrowserAccess
  now(): number
  harnuPorts(): number[]
  trustedHosts(folder: string): readonly string[]
  /** The operator's click opened a popup: create an operator-class pane in `folder` (spec §3.2). */
  openPopupPane(opts: { folder: string; partition: BrowserPartition; url: string }): void
}

interface ViewEntry {
  paneId: string
  folder: string
  partition: BrowserPartition
  view: WebContentsView
  wc: WebContents
  /** Last rect the renderer reported, in CSS px; `null` until the pane mounts. */
  rectCss: Rect | null
  visibleReported: boolean
  /** Parked: attached, visible, 1×1 with a metrics override (spec §2.3). Counts as hidden for discard (U7). */
  parked: boolean
  /** The 1280×800 parking override is on the page (sent once the page can take CDP, see `applyParkedMetrics`). */
  parkedMetricsApplied: boolean
  /** Frozen (hidden under an overlay or a drag). */
  frozen: boolean
  freezeGen: number
  paintedWaiter: (() => void) | null
  lastGestureAt: number
  loading: boolean
  notice: BrowserNotice | null
  activity: 'driving' | null
}

export class BrowserViewHost implements BrowserHost {
  private readonly entries = new Map<string, ViewEntry>()
  private readonly byWebContentsId = new Map<number, string>()
  private overlays: BrowserOverlayRect[] = []
  private dragActive = false
  private boundChords: ReadonlySet<string> = new Set()
  private readonly hardenedPartitions = new Set<string>()
  private windowHooked: BrowserWindow | null = null

  constructor(private readonly deps: ViewHostDeps) {}

  /* ---------------------------------------------------------------------------------------- */
  /* BrowserHost (the verb seam)                                                               */
  /* ---------------------------------------------------------------------------------------- */

  create(opts: { paneId: string; folder: string; partition: BrowserPartition; url: string }): void {
    const win = this.deps.getWindow()
    if (!win) throw new Error('no app window to attach the browser view to')
    this.hookWindow(win)
    this.hardenPartition(opts.partition)

    const view = new WebContentsView({
      webPreferences: guestWebPreferences(opts.partition, this.deps.guestPreloadPath)
    })
    const wc = view.webContents
    const entry: ViewEntry = {
      paneId: opts.paneId,
      folder: opts.folder,
      partition: opts.partition,
      view,
      wc,
      rectCss: null,
      visibleReported: false,
      parked: false,
      parkedMetricsApplied: false,
      frozen: false,
      freezeGen: 0,
      paintedWaiter: null,
      lastGestureAt: 0,
      loading: false,
      notice: null,
      activity: null
    }
    this.entries.set(opts.paneId, entry)
    this.byWebContentsId.set(wc.id, opts.paneId)

    win.contentView.addChildView(view)
    void this.attachDebugger(entry)
    this.park(entry)
    this.attachGuestHandlers(entry)
    wc.loadURL(opts.url).catch(() => undefined)
    this.publish(entry)
  }

  info(paneId: string): LivePaneInfo | undefined {
    const e = this.entries.get(paneId)
    if (!e || e.wc.isDestroyed()) return undefined
    return {
      url: e.wc.getURL(),
      title: e.wc.getTitle(),
      loading: e.wc.isLoading(),
      canGoBack: e.wc.navigationHistory.canGoBack(),
      canGoForward: e.wc.navigationHistory.canGoForward()
    }
  }

  async navigate(
    paneId: string,
    target: NavigateTarget,
    opts: { waitUntil: 'commit' | 'domcontentloaded' | 'load'; timeoutMs: number; hard: boolean }
  ): Promise<NavigateOutcome> {
    const e = this.entries.get(paneId)
    if (!e || e.wc.isDestroyed()) throw new Error('pane is gone')
    const wc = e.wc
    const navigationId = randomUUID()
    const settledNow = (): NavigateOutcome => ({
      title: wc.getTitle(),
      status: null,
      navigationId,
      reason: 'load'
    })
    this.setActivity(e, 'driving')
    try {
      if ('action' in target) {
        if (target.action === 'stop') {
          wc.stop()
          return settledNow()
        }
        if (target.action === 'back' && !wc.navigationHistory.canGoBack()) return settledNow()
        if (target.action === 'forward' && !wc.navigationHistory.canGoForward()) return settledNow()
      }
      const { settled } = waitForNavigation(wc, {
        waitUntil: opts.waitUntil,
        timeoutMs: opts.timeoutMs,
        navigationId,
        timers: {
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as never)
        },
        title: () => (wc.isDestroyed() ? '' : wc.getTitle())
      })
      if ('url' in target) {
        e.notice = null
        wc.loadURL(target.url).catch(() => undefined)
      } else if (target.action === 'back') wc.navigationHistory.goBack()
      else if (target.action === 'forward') wc.navigationHistory.goForward()
      else if (opts.hard) wc.reloadIgnoringCache()
      else wc.reload()
      return await settled
    } finally {
      this.setActivity(e, null)
      this.publish(e)
    }
  }

  destroy(paneId: string): void {
    const e = this.entries.get(paneId)
    if (!e) return
    e.freezeGen++
    e.paintedWaiter?.()
    this.entries.delete(paneId)
    this.byWebContentsId.delete(e.wc.id)
    const win = this.deps.getWindow()
    try {
      if (e.wc.debugger.isAttached()) e.wc.debugger.detach()
    } catch {
      /* already detached */
    }
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(e.view)
    } catch {
      /* already removed */
    }
    if (!e.wc.isDestroyed()) e.wc.close()
  }

  publishFlag(paneId: string, flagged: { host: string } | null): void {
    const e = this.entries.get(paneId)
    if (e) this.publish(e, { flagged })
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Called from IPC (the renderer's side)                                                     */
  /* ---------------------------------------------------------------------------------------- */

  /** The renderer reports the pane host's rect (spec §2.3). */
  applyBounds(paneId: string, rect: Rect, visible: boolean): void {
    const e = this.entries.get(paneId)
    if (!e || e.wc.isDestroyed()) return
    e.rectCss = rect
    e.visibleReported = visible
    if (!visible) {
      // Hidden: a freeze no longer applies, and a painted view keeps its bounds (`placeView` hides it).
      if (!e.parked) {
        e.freezeGen++
        e.frozen = false
      }
    }
    this.place(e)
    this.reconcileFreeze()
  }

  /** Put the native view where `placeView` says (spec §2.3): parked, unparked, or hidden. */
  private place(e: ViewEntry): void {
    const placement = placeView({
      parked: e.parked,
      rect: e.rectCss,
      visible: e.visibleReported,
      frozen: e.frozen,
      zoomFactor: this.zoomFactor(),
      content: this.contentSize(),
      current: e.view.getBounds()
    })
    if (placement.clearParkedMetrics) this.unpark(e)
    e.parked = placement.parked
    e.view.setBounds(placement.bounds)
    e.view.setVisible(placement.visible)
  }

  setOverlays(overlays: BrowserOverlayRect[]): void {
    this.overlays = overlays
    this.reconcileFreeze()
  }

  setDragActive(active: boolean): void {
    this.dragActive = active
    this.reconcileFreeze()
  }

  /** The renderer painted the frozen image; the view may be hidden now. */
  freezePainted(paneId: string): void {
    this.entries.get(paneId)?.paintedWaiter?.()
  }

  setBoundChords(chords: string[]): void {
    this.boundChords = new Set(chords)
  }

  /** Operator navigation from the address bar and the back/forward/reload buttons. */
  operatorNavigate(
    paneId: string,
    target: NavigateTarget
  ): { ok: true } | { ok: false; scheme: string } {
    const e = this.entries.get(paneId)
    if (!e || e.wc.isDestroyed()) return { ok: false, scheme: '' }
    this.deps.registry.noteOperatorInteraction(paneId)
    if ('url' in target) {
      const verdict = checkTopLevelNavigation(target.url, 'operator')
      if (!verdict.ok) {
        this.publish(e, { notice: { kind: 'blocked', scheme: verdict.scheme } })
        return { ok: false, scheme: verdict.scheme }
      }
      // The operator picked this site: the agent flag no longer applies (spec §3.2).
      const rec = this.deps.registry.get(paneId)
      if (rec) rec.flagged = null
      e.notice = null
      e.wc.loadURL(verdict.url).catch(() => undefined)
    } else if (target.action === 'back') e.wc.navigationHistory.goBack()
    else if (target.action === 'forward') e.wc.navigationHistory.goForward()
    else if (target.action === 'reload') e.wc.reload()
    else e.wc.stop()
    this.publish(e)
    return { ok: true }
  }

  dismissFlag(paneId: string): void {
    const rec = this.deps.registry.get(paneId)
    const e = this.entries.get(paneId)
    if (rec) rec.flagged = null
    if (e) this.publish(e, { flagged: null })
  }

  dismissNotice(paneId: string): void {
    const e = this.entries.get(paneId)
    if (!e) return
    e.notice = null
    this.publish(e)
  }

  openDevTools(paneId: string): void {
    const e = this.entries.get(paneId)
    if (e && !e.wc.isDestroyed()) e.wc.openDevTools({ mode: 'detach' })
  }

  /** Re-publish a pane's state (a pause, a resume, a Disconnect changed). */
  refresh(paneId: string): void {
    const e = this.entries.get(paneId)
    if (e) this.publish(e)
  }

  state(paneId: string): BrowserPaneState | null {
    const e = this.entries.get(paneId)
    return e ? this.snapshot(e) : null
  }

  has(paneId: string): boolean {
    return this.entries.has(paneId)
  }

  destroyAll(): void {
    for (const id of [...this.entries.keys()]) this.destroy(id)
  }

  /** Test and live-proof hook: the number of views the host holds. */
  size(): number {
    return this.entries.size
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Geometry, parking and freezing                                                            */
  /* ---------------------------------------------------------------------------------------- */

  private zoomFactor(): number {
    return this.deps.getWindow()?.webContents.getZoomFactor() ?? 1
  }

  private contentSize(): { width: number; height: number } {
    const win = this.deps.getWindow()
    const [width, height] = win ? win.getContentSize() : [0, 0]
    return { width, height }
  }

  /** The parked corner in CSS px, for the overlay intersection test (a toast there hides it). */
  private parkedCssRect(): Rect {
    const f = this.zoomFactor()
    const c = this.contentSize()
    return { x: c.width / f - 1, y: c.height / f - 1, width: 1, height: 1 }
  }

  /**
   * A view that has never painted cannot be captured (spec §2.3, U0 A3), so a pane with no real rect yet is
   * parked: attached, visible, 1×1 in the bottom-right content corner, with a 1280×800 metrics override. It
   * counts as HIDDEN for the later discard rule (U7).
   */
  private park(e: ViewEntry): void {
    e.parked = true
    e.view.setBounds(parkedBounds(this.contentSize()))
    e.view.setVisible(true)
    // The 1280×800 metrics override is sent when the page first becomes ready (`applyParkedMetrics`), not here:
    // the U1 live run crashed the app (SIGSEGV) when `Emulation.setDeviceMetricsOverride` reached a view that
    // had not yet created its first frame.
    if (!e.wc.isLoading() && e.wc.getURL() !== '') this.applyParkedMetrics(e)
  }

  /** Send the parking override once the page can take CDP; a no-op when the pane was already unparked. */
  private applyParkedMetrics(e: ViewEntry): void {
    if (!e.parked || e.parkedMetricsApplied || e.wc.isDestroyed()) return
    e.parkedMetricsApplied = true
    void this.cdp(e, 'Emulation.setDeviceMetricsOverride', {
      width: PARKED_METRICS.width,
      height: PARKED_METRICS.height,
      deviceScaleFactor: PARKED_METRICS.deviceScaleFactor,
      mobile: false
    })
  }

  private unpark(e: ViewEntry): void {
    e.parked = false
    // Only a override that was actually sent needs clearing. U1 has no emulation record to re-apply (spec §9);
    // U5 re-applies the pane's own record here.
    if (e.parkedMetricsApplied) {
      e.parkedMetricsApplied = false
      void this.cdp(e, 'Emulation.clearDeviceMetricsOverride', {})
    }
  }

  private hookWindow(win: BrowserWindow): void {
    if (this.windowHooked === win) return
    this.windowHooked = win
    const repark = (): void => {
      for (const e of this.entries.values()) {
        if (e.parked) this.place(e)
      }
      this.reconcileFreeze()
    }
    win.on('resize', repark)
    win.on('maximize', repark)
    win.on('unmaximize', repark)
    win.on('enter-full-screen', repark)
    win.on('leave-full-screen', repark)
    win.on('closed', () => {
      this.windowHooked = null
      this.destroyAll()
    })
  }

  /** Freeze every visible view that an overlay (or a drag) would otherwise sit under; thaw the rest. */
  private reconcileFreeze(): void {
    for (const e of this.entries.values()) {
      if (e.wc.isDestroyed()) continue
      const rect = e.parked
        ? this.parkedCssRect()
        : e.visibleReported && e.rectCss
          ? e.rectCss
          : null
      if (!rect) continue
      const want = (this.dragActive && !e.parked) || needsFreeze(rect, this.overlays)
      if (want && !e.frozen) void this.freeze(e)
      else if (!want && e.frozen) this.thaw(e)
    }
  }

  private async freeze(e: ViewEntry): Promise<void> {
    e.frozen = true
    const gen = ++e.freezeGen
    if (e.parked) {
      // Nothing to paint for a 1×1 corner: just get it out from under the overlay.
      e.view.setVisible(false)
      return
    }
    let dataUrl: string | null = null
    try {
      const rect = freezeCaptureRect(e.view.getBounds(), false)
      const image = rect ? await e.wc.capturePage(rect) : await e.wc.capturePage()
      // JPEG, not PNG: PNG at DPR 2 was over the 100 ms budget in U0 (A12).
      if (!image.isEmpty()) {
        dataUrl = `data:image/jpeg;base64,${image.toJPEG(FREEZE_JPEG_QUALITY).toString('base64')}`
      }
    } catch {
      // A failed capture degrades to a blank rect of the pane background, never to a live view under an overlay.
    }
    if (gen !== e.freezeGen || !e.frozen) return
    this.send('browser:freeze', { paneId: e.paneId, dataUrl })
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FREEZE_PAINT_TIMEOUT_MS)
      e.paintedWaiter = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    e.paintedWaiter = null
    if (gen !== e.freezeGen || !e.frozen || e.wc.isDestroyed()) return
    e.view.setVisible(false)
  }

  private thaw(e: ViewEntry): void {
    e.frozen = false
    e.freezeGen++
    e.paintedWaiter?.()
    if (e.parked || e.visibleReported) e.view.setVisible(true)
    if (!e.parked) this.send('browser:unfreeze', { paneId: e.paneId })
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Guest hardening (spec §3.2)                                                               */
  /* ---------------------------------------------------------------------------------------- */

  /** Session-level policy, once per partition: permissions, downloads, subresource schemes. */
  private hardenPartition(partition: BrowserPartition): void {
    const name = PARTITION_NAMES[partition]
    if (this.hardenedPartitions.has(name)) return
    this.hardenedPartitions.add(name)
    const ses = session.fromPartition(name)
    ses.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(isPermissionGranted(permission))
    )
    ses.setPermissionCheckHandler((_wc, permission) => isPermissionGranted(permission))
    // No automatic downloads (spec §3.2). `browser_download` (a later unit) arms a one-shot allowance.
    ses.on('will-download', (event) => event.preventDefault())
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isSubresourceSchemeAllowed(details.url) })
    })
  }

  private attachGuestHandlers(e: ViewEntry): void {
    const wc = e.wc
    const rec = (): ReturnType<BrowserRegistry['get']> => this.deps.registry.get(e.paneId)

    wc.once('dom-ready', () => this.applyParkedMetrics(e))
    wc.on('did-start-loading', () => {
      e.loading = true
      this.publish(e)
    })
    wc.on('did-stop-loading', () => {
      e.loading = false
      this.publish(e)
    })
    wc.on('page-title-updated', () => this.publish(e))
    wc.on('did-navigate', (_ev, url) => {
      const r = rec()
      const host = hostOf(url)
      if (r && host) r.seenHosts.add(host)
      this.publish(e)
    })
    wc.on('did-navigate-in-page', () => this.publish(e))
    wc.on('render-process-gone', () => this.publish(e, { notice: { kind: 'crashed' } }))

    // Layer 1 of the navigation policy: top-level navigations and redirects (spec §3.2). A navigation the
    // page itself started counts as the `page` initiator; the operator and the verbs use `loadURL`, which
    // does not pass through here.
    const guardTopLevel = (event: { preventDefault(): void }, url: string): void => {
      const verdict = checkTopLevelNavigation(url, 'page')
      if (!verdict.ok) {
        event.preventDefault()
        this.publish(e, { notice: { kind: 'blocked', scheme: verdict.scheme } })
      }
    }
    wc.on('will-navigate', (details) => guardTopLevel(details, details.url))
    wc.on('will-redirect', (details) => {
      if (details.isMainFrame) guardTopLevel(details, details.url)
      else if (!isSubresourceSchemeAllowed(details.url)) details.preventDefault()
    })
    wc.on('will-frame-navigate', (details) => {
      if (details.isMainFrame) return
      if (!isSubresourceSchemeAllowed(details.url)) details.preventDefault()
    })

    // Layer 2: popups. Denied as popups; with a real user activation the target opens as a NEW operator-class
    // pane that inherits the opener's partition, with no `opener` link (spec §3.2, Q10).
    wc.setWindowOpenHandler((details) => {
      const gesture = this.deps.now() - e.lastGestureAt <= GESTURE_WINDOW_MS
      const decision = decidePopup(details.url, gesture)
      if (decision.action === 'open-pane') {
        // One activation buys one popup: a page cannot loop `window.open` inside the gesture window.
        e.lastGestureAt = 0
        this.deps.openPopupPane({ folder: e.folder, partition: e.partition, url: decision.url })
      } else if (decision.reason === 'scheme-blocked') {
        this.publish(e, { notice: { kind: 'blocked', scheme: schemeOf(details.url) } })
      }
      return { action: 'deny' }
    })

    // Certificate errors: denied, except loopback (self-signed local dev HTTPS), accepted and flagged.
    wc.on('certificate-error', (event, url, _error, _cert, callback) => {
      event.preventDefault()
      const host = hostOf(url)
      const verdict = certificateDecision(host, isLoopbackHost(host.replace(/:\d+$/, '')))
      if (verdict === 'accept-flagged') this.publish(e, { notice: { kind: 'certificate', host } })
      callback(verdict === 'accept-flagged')
    })
    // HTTP auth prompts are cancelled, never shown (spec §3.2).
    wc.on('login', (event, _details, _authInfo, callback) => {
      event.preventDefault()
      callback()
    })

    // Chords and the operator's own input (spec §2.5). `before-input-event` fires for real keys and not for
    // CDP-dispatched ones (U0 A1), so it is also the signal that the OPERATOR is using the pane.
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown') {
        e.lastGestureAt = this.deps.now()
        this.deps.registry.noteOperatorInteraction(e.paneId)
      }
      const decision = decideForward(
        input as GuestInput,
        this.boundChords,
        process.platform === 'darwin'
      )
      if (!decision.forward || decision.chord === null) return
      event.preventDefault()
      this.send('browser:chord', { paneId: e.paneId, chord: decision.chord })
      this.deps.getWindow()?.webContents.focus()
    })
    wc.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type !== 'mouseDown') return
      e.lastGestureAt = this.deps.now()
      this.deps.registry.noteOperatorInteraction(e.paneId)
    })
  }

  /** CDP session for dialogs (spec §3.1): `alert`/`confirm`/`prompt` raise a banner and are auto-dismissed. */
  private async attachDebugger(e: ViewEntry): Promise<void> {
    try {
      if (!e.wc.debugger.isAttached()) e.wc.debugger.attach('1.3')
      e.wc.debugger.on('message', (_ev, method, params: { type?: string }) => {
        if (method !== 'Page.javascriptDialogOpening') return
        const kind = params.type ?? 'alert'
        void this.cdp(e, 'Page.handleJavaScriptDialog', { accept: kind === 'beforeunload' })
        this.publish(e, { notice: { kind: 'dialog', dialog: kind } })
      })
      await this.cdp(e, 'Page.enable', {})
    } catch {
      // A guest without a debugger still works; only dialog interception is lost.
    }
  }

  private async cdp(e: ViewEntry, method: string, params: object): Promise<unknown> {
    try {
      if (e.wc.isDestroyed() || !e.wc.debugger.isAttached()) return undefined
      return await e.wc.debugger.sendCommand(method, params)
    } catch {
      return undefined
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* State push                                                                                */
  /* ---------------------------------------------------------------------------------------- */

  private setActivity(e: ViewEntry, word: 'driving' | null): void {
    e.activity = word
    this.send('browser:activity', { paneId: e.paneId, word })
  }

  private snapshot(e: ViewEntry): BrowserPaneState {
    const r = this.deps.registry.get(e.paneId)
    const url = e.wc.isDestroyed() ? '' : e.wc.getURL()
    return {
      paneId: e.paneId,
      url,
      title: e.wc.isDestroyed() ? '' : e.wc.getTitle(),
      loading: e.loading,
      canGoBack: e.wc.isDestroyed() ? false : e.wc.navigationHistory.canGoBack(),
      canGoForward: e.wc.isDestroyed() ? false : e.wc.navigationHistory.canGoForward(),
      origin: classifyOrigin(url, {
        extraTrustedHosts: this.deps.trustedHosts(e.folder),
        harnuPorts: this.deps.harnuPorts()
      }),
      openedBy: r?.openedBy ?? 'operator',
      partition: e.partition,
      flagged: r?.flagged ?? null,
      pausedUntil: this.deps.access.pausedUntil(e.paneId),
      disconnected: this.deps.access.isDisconnected(e.paneId),
      ownerSessionId: r?.ownerSessionId ?? null,
      notice: e.notice
    }
  }

  private publish(
    e: ViewEntry,
    patch: { notice?: BrowserNotice | null; flagged?: { host: string } | null } = {}
  ): void {
    if ('notice' in patch) e.notice = patch.notice ?? null
    if ('flagged' in patch) {
      const r = this.deps.registry.get(e.paneId)
      if (r) r.flagged = patch.flagged ?? null
    }
    this.send('browser:state', this.snapshot(e))
  }

  private send(channel: string, payload: unknown): void {
    const win = this.deps.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function schemeOf(url: string): string {
  try {
    return new URL(url).protocol.replace(/:$/, '')
  } catch {
    return ''
  }
}

/** The ports Harnu itself listens on, which always classify as `external` (spec §7.2). */
export function collectHarnuPorts(mcpPort: number): number[] {
  const ports = new Set<number>()
  if (mcpPort > 0) ports.add(mcpPort)
  const cdp = Number(app.commandLine.getSwitchValue('remote-debugging-port'))
  if (Number.isInteger(cdp) && cdp > 0) ports.add(cdp)
  const renderer = process.env['ELECTRON_RENDERER_URL']
  if (renderer) {
    try {
      const p = Number(new URL(renderer).port)
      if (p > 0) ports.add(p)
    } catch {
      /* not a URL */
    }
  }
  return [...ports]
}
