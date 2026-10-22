/**
 * The browser pane's native view host (T564 U1, spec §2, §3): owns one `WebContentsView` per pane, keeps it
 * on the pane's host rectangle, freezes it under overlays, hardens the guest and forwards chords.
 *
 * Electron-bound glue. Every decision it makes is a pure function with its own tests: `bounds` (rounding,
 * parking, intersection), `nav-policy` (schemes, popups, permissions, certificates), `chord`, `nav-wait`,
 * `access` and the verb logic in `verbs-core`. This file only wires them to Electron events.
 */
import { randomUUID } from 'node:crypto'
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { release, tmpdir } from 'node:os'
import { rawRm } from '../raw-fs'
import { join as joinPath } from 'node:path'
import {
  BrowserWindow,
  WebContentsView,
  app,
  nativeImage,
  session,
  type Session,
  type WebContents
} from 'electron'
import {
  FREEZE_JPEG_QUALITY,
  PARKED_METRICS,
  freezeCaptureRect,
  parkedBounds,
  placeView,
  type Rect
} from './bounds'
import { decideForward, type GuestInput } from './chord'
import { guestWebPreferences, PARTITION_NAMES, type BrowserPartition } from './guest-prefs'
import {
  DOWNLOAD_PROMPT_TIMEOUT_MS,
  HELD_DIR_PREFIX,
  NEW_HELD_DOWNLOAD,
  createDownloadArms,
  decideDownload,
  downloadResult,
  isStaleHeldDir,
  moveHeldDownload,
  overLimit,
  resolveDownloadTarget,
  sanitizeDownloadName,
  stepHeldDownload,
  type DownloadArm,
  type DownloadArms,
  type DownloadFsIo,
  type HeldAction,
  type HeldDownload,
  type MoveIo
} from './download-plan'
import {
  checkEmulateArgs,
  deviceActive,
  effectiveTouch,
  isEmptyRecord,
  mergeEmulation,
  nextSessionState,
  metricsCommand,
  needsReloadFor,
  type NativeHintsEnv,
  sanitizeEmulatePatch,
  sessionCommands,
  viewScale,
  type EmulateArgs,
  type EmulationRecord
} from '../../shared/browser-emulation'
import { clampZoom, stepZoom } from '../../shared/browser-zoom'
import type { BrowserPrefsStore } from './browser-prefs'
import { waitForNavigation } from './nav-wait'
import { networkEnableParams } from './network-capture'
import { createPaneReaders, type PaneReaders } from './pane-readers'
import { clampSize, elementCropScale, type ViewMode } from './screenshot-plan'
import type { CaptureRequest, CaptureResult } from './read-verbs'
import {
  checkTopLevelNavigation,
  decidePopup,
  isPermissionGranted,
  isSubresourceSchemeAllowed
} from './nav-policy'
import { classifyOrigin, hostOf, originKey } from './origin-class'
import { initialInputReadyState, nextInputReadyState, type InputReadyState } from './input-ready'
import { decidePageRequest } from './page-guard'
import { decidePageNavigation, popupAllowedFrom } from './page-egress'
import { pageCsp } from './page-url'
import {
  FreezeGeneration,
  captureMatchesBounds,
  freezeImagePlan,
  type GestureGate,
  certificateVerdictFor,
  createGestureGate,
  decideFreeze,
  flagAfterOperatorAction,
  liveUrlOf
} from './view-logic'
import type { BrowserAccess } from './access'
import {
  DISCARD_SWEEP_INTERVAL_MS,
  HIDDEN_DISCARD_MS,
  buildDiscardState,
  createHiddenTracker,
  planDiscard,
  reviveOnShow,
  sanitizeScroll,
  type DiscardFacts,
  type DiscardReason
} from './lifecycle'
import type { BrowserRegistry } from './registry'
import type { BrowserNotice, BrowserOverlayRect, BrowserPaneState } from './state-types'
import type { BrowserReadHost } from './read-verbs'
import type { LivePaneInfo, NavigateOutcome, NavigateTarget } from './verbs-core'

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
  /** The folder's browser-read opt-in, from the service's cache (display only; the gate reads the file). */
  readOptIn(folder: string): boolean
  /** The operator's lease on the pane is active for the view `token` (display only). */
  leaseActive(paneId: string, token: string): boolean
  /** The pane committed a main-frame navigation: a lease bound to another origin ends (spec §7.1). */
  onMainFrameCommit?(paneId: string): void
  /** Redact page-derived text recorded by the readers (best-effort, the `read_terminal` scrubber). */
  scrub(text: string): string
  /** The operator's click opened a popup: create an operator-class pane in `folder` (spec §3.2). */
  openPopupPane(opts: { folder: string; partition: BrowserPartition; url: string }): void
  /** `<userData>/browser-prefs.json`: the zoom remembered per origin (T572, spec §9.1). */
  prefs: BrowserPrefsStore
  /** The `harnu-page://` side (T569 U2); absent in a unit that never loads a page. */
  pageHooks?: PageHooks
  /** The pane is closed for good (not discarded): drop what is held for it outside the host (pins, overlay). */
  onPaneClosed?(paneId: string): void
  /** The pane's page was discarded: picking ends, the pins stay (spec §10.1). */
  onViewDiscarded?(paneId: string): void
  /** How long a pane stays hidden before the sweep discards it. Absent = {@link HIDDEN_DISCARD_MS}. */
  discardMs?: number
}

/** What the view host asks of the page service (`page-service.ts`). */
export interface PageHooks {
  /** Registered once per guest partition: the `harnu-page:` protocol handler. */
  registerProtocol(ses: Session, partition: string): void
  /** A main-frame navigation started: the previous document's preload is gone (F3). */
  onNavigationStart(paneId: string): void
  /** A pane committed a navigation (to any URL): start, keep or drop its file watcher. */
  onNavigated(paneId: string, url: string): void
  onDestroyed(paneId: string): void
  /**
   * `onBeforeRequest` ALLOWED a `harnu-page:` request: issue its one-shot ticket (the handler serves nothing
   * else, F1) and, when it came from a known pane, watch its file.
   */
  onRequest(partition: string, paneId: string | undefined, url: string): void
  /** The pane's per-pane "Allow network" switch (spec §4.3), read on every response. */
  allowNetwork(paneId: string): boolean
}

/** What this browser is, so a reset can put its real client hints back (`nativeUserAgentOverride`). */
const NATIVE_HINTS_ENV: NativeHintsEnv = {
  chromeVersion: process.versions.chrome ?? '',
  platform: process.platform,
  arch: process.arch,
  osRelease: release()
}

/** The real filesystem the download target resolution touches. */
const BASE_FS: DownloadFsIo = {
  mkdirp: (dir) => void mkdirSync(dir, { recursive: true }),
  realpath: (p) => realpathSync(p),
  exists: (p) => existsSync(p)
}
/** An agent download: the target name is claimed by creating the file exclusively (`wx`), so it cannot be raced. */
const AGENT_FS: DownloadFsIo = {
  ...BASE_FS,
  reserve: (p) => writeFileSync(p, '', { flag: 'wx' })
}
/** The operator's Save: an exclusive copy out of the temp folder (COPYFILE_EXCL never replaces a file). */
const MOVE_FS: MoveIo = {
  ...BASE_FS,
  copyExclusive: (from, to) => copyFileSync(from, to, fsConstants.COPYFILE_EXCL)
}

/** How long the "Saved" / "cancelled" notice stays up before it clears itself (design.md "Download prompt"). */
const TRANSIENT_NOTICE_MS = 4000

/**
 * The operator's pending "Save to …?" decision on a held download. The bytes arrive in `tempDir`, never in the
 * folder: only the operator's Save moves the finished file (`stepHeldDownload`).
 */
interface PendingDownload {
  item: Electron.DownloadItem
  name: string
  timer: ReturnType<typeof setTimeout>
  tempDir: string
  tempFile: string
  step: HeldDownload
  /** The question was answered (the prompt row is gone) but the file may still be arriving. */
  answered: boolean
  tooLarge: boolean
}

/** An agent's download that is arriving: cancelled when its call gives up on it. */
interface AgentDownload {
  item: Electron.DownloadItem
  absPath: string
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
  /** Frozen (hidden under an overlay or a drag). */
  frozen: boolean
  /** The freeze-generation race guard (`view-logic.ts`). */
  gen: FreezeGeneration
  paintedWaiter: (() => void) | null
  /** Real clicks/keys: one popup per activation (`view-logic.ts`). */
  gestures: GestureGate
  /** When `before-input-event` last saw a REAL `keyDown` on the pane (spec §5.4 condition 4). */
  lastRealKeyDownAt: number | null
  /** The address the pane was last asked to load, for a pane that has not committed anything yet (F3). */
  requestedUrl: string
  /** The served page file is gone (T569 U2): the view is hidden and the pane shows the placeholder. */
  fileRemoved: boolean
  loading: boolean
  /** Mouse and key events reach the current document (see `inputReady` and `browser/input-ready.ts`). */
  inputState: InputReadyState
  /** The navigation now in flight was started by Harnu (the verb, the address bar, back/forward, reload). */
  harnuNavigation: boolean
  notice: BrowserNotice | null
  activity: 'driving' | null
  /** The reading verbs' per-pane state (console ring, network capture, refs), fed from the debugger session. */
  readers: PaneReaders
  /** The user agent the page had before any emulation: restored explicitly on reset (spec §9.2 correction 3). */
  originalUserAgent: string
  /** The first `dom-ready` fired: the page can take a metrics override (the U1 SIGSEGV rule). */
  pageReady: boolean
  /** The emulation record last put on the page, to tell when touch turns on. */
  applied: EmulationRecord
  /** A non-empty record was sent: the next empty one must send the clearing set (`SessionState`). */
  sessionDirty: boolean
  /** The factor between page CSS px and view px now in effect (1 without a device). */
  deviceScale: number
  /** The last metrics command sent, so an unchanged one is not sent again. */
  lastMetricsKey: string | null
  /** Resolves a wait for the renderer's next bounds report (device mode relayout). */
  boundsWaiter: (() => void) | null
  /** The operator's download waiting for an answer. */
  prompt: PendingDownload | null
  /** The agent's download that is arriving now. */
  agentDownload: AgentDownload | null
}

export class BrowserViewHost implements BrowserReadHost {
  private readonly entries = new Map<string, ViewEntry>()
  private readonly byWebContentsId = new Map<number, string>()
  private overlays: BrowserOverlayRect[] = []
  private dragActive = false
  private boundChords: ReadonlySet<string> = new Set()
  private readonly hardenedPartitions = new Set<string>()
  private windowHooked: BrowserWindow | null = null
  /** When each pane began to be hidden (not mounted, not visible, or parked): the discard clock (spec §10.1). */
  private readonly hidden = createHiddenTracker()
  /** The last rect the renderer reported for a pane with no view (discarded), applied when the view returns. */
  private readonly lastBounds = new Map<string, { rect: Rect; visible: boolean }>()
  /** A revival already in flight, so two verbs (or a click and a verb) share one load. */
  private readonly reviving = new Map<string, Promise<boolean>>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private readonly arms: DownloadArms = createDownloadArms({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    // The call gave up on its download (a deadline, a timeout): stop it, so nothing keeps arriving in the folder.
    abortClaimed: (paneId) => this.cancelAgentDownload(paneId)
  })

  constructor(private readonly deps: ViewHostDeps) {
    void this.sweepStaleHeldDownloads()
  }

  /**
   * A real click or key counts as the operator's gesture (a popup, the download prompt). While an agent input verb is
   * running the pane's input is the agent's, so it must never open the operator's download prompt (T572 delta 1).
   */
  private noteGesture(e: ViewEntry): void {
    if (this.deps.registry.agentInput(e.paneId).inFlight) return
    e.gestures.note()
  }

  /** Cancel and clean up the agent's arriving download, if any. */
  private cancelAgentDownload(paneId: string): void {
    const e = this.entries.get(paneId)
    const d = e?.agentDownload
    if (!e || !d) return
    e.agentDownload = null
    try {
      d.item.cancel()
    } catch {
      /* already finished */
    }
    try {
      unlinkSync(d.absPath)
    } catch {
      /* the reserved placeholder is already gone */
    }
  }

  /**
   * Held downloads live in `harnu-dl-*` temp folders. A process that died (or was killed) mid-question leaves one
   * behind, so a startup sweep removes the ones old enough to be nobody's (a younger one may be another running
   * Harnu's, which shares the OS temp directory).
   */
  private async sweepStaleHeldDownloads(): Promise<void> {
    try {
      const base = tmpdir()
      const now = Date.now()
      for (const name of await readdir(base)) {
        if (!name.startsWith(HELD_DIR_PREFIX)) continue
        const full = joinPath(base, name)
        const st = await stat(full).catch(() => null)
        if (st?.isDirectory() && isStaleHeldDir(name, st.mtimeMs, now)) {
          await rawRm(full, { recursive: true, force: true }).catch(() => undefined)
        }
      }
    } catch {
      // A temp directory that cannot be listed has nothing for us to sweep.
    }
  }

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
      frozen: false,
      gen: new FreezeGeneration(),
      paintedWaiter: null,
      gestures: createGestureGate(() => this.deps.now()),
      lastRealKeyDownAt: null,
      requestedUrl: opts.url,
      fileRemoved: false,
      loading: false,
      inputState: initialInputReadyState(),
      harnuNavigation: false,
      notice: null,
      activity: null,
      readers: null as unknown as PaneReaders,
      originalUserAgent: wc.getUserAgent(),
      pageReady: false,
      applied: this.deps.registry.get(opts.paneId)?.emulation ?? {},
      sessionDirty: false,
      deviceScale: 1,
      lastMetricsKey: null,
      boundsWaiter: null,
      prompt: null,
      agentDownload: null
    }
    entry.readers = createPaneReaders({
      now: this.deps.now,
      send: (method, params) => this.cdpStrict(entry, method, params ?? {}),
      scrub: this.deps.scrub,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onCaptureChange: () => {
        if (this.entries.has(entry.paneId)) this.publish(entry)
      }
    })
    this.entries.set(opts.paneId, entry)
    this.byWebContentsId.set(wc.id, opts.paneId)

    win.contentView.addChildView(view)
    void this.attachDebugger(entry)
    // A pane opened with a device must send its very first request as that device (user agent, client hints, touch):
    // the session commands go out on the debugger channel BEFORE the load starts, not at `did-start-navigation`.
    this.pushSession(entry)
    this.park(entry)
    this.attachGuestHandlers(entry)
    wc.loadURL(opts.url).catch(() => undefined)
    // A parked pane counts as hidden from the moment it was parked (spec §2.3, §10.1).
    this.hidden.markHidden(opts.paneId, this.deps.now())
    this.publish(entry)
    const known = this.lastBounds.get(opts.paneId)
    if (known) this.applyBounds(opts.paneId, known.rect, known.visible)
    this.startSweep()
  }

  info(paneId: string): LivePaneInfo | undefined {
    const e = this.entries.get(paneId)
    if (!e) {
      // A discarded pane answers from what was recorded, so the gate classifies it exactly as it was.
      const d = this.deps.registry.get(paneId)?.discarded
      return d
        ? { url: d.url, title: d.title, loading: false, canGoBack: false, canGoForward: false }
        : undefined
    }
    if (e.wc.isDestroyed()) return undefined
    return {
      url: liveUrlOf(e.wc.getURL(), e.requestedUrl),
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
      e.harnuNavigation = true
      if ('url' in target) {
        e.notice = null
        e.requestedUrl = target.url
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
    // Closing a pane for good: what the host and its neighbours hold for it goes too (a discard keeps it).
    this.hidden.forget(paneId)
    this.lastBounds.delete(paneId)
    this.sentScroll.delete(paneId)
    this.deps.onPaneClosed?.(paneId)
    this.release(paneId)
  }

  /** Tear the view down: webContents, debugger, watchers, readers, held downloads. The pane itself stays known. */
  private release(paneId: string): void {
    const e = this.entries.get(paneId)
    if (!e) return
    e.gen.bump()
    e.paintedWaiter?.()
    e.boundsWaiter?.()
    if (e.prompt) {
      clearTimeout(e.prompt.timer)
      try {
        e.prompt.item.cancel()
      } catch {
        /* already done */
      }
      void rawRm(e.prompt.tempDir, { recursive: true, force: true }).catch(() => undefined)
      e.prompt = null
    }
    // An agent's download that is still arriving stops with the pane, and its reserved name goes with it.
    this.cancelAgentDownload(paneId)
    this.arms.settle(paneId, {
      ok: false,
      code: 'DOWNLOAD_CANCELLED',
      detail: 'The pane was closed.'
    })
    this.entries.delete(paneId)
    this.byWebContentsId.delete(e.wc.id)
    e.readers.dispose()
    this.deps.pageHooks?.onDestroyed(paneId)
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

  /* ---------------------------------------------------------------------------------------- */
  /* BrowserReadHost (the reading verbs' seam, T564 U3)                                        */
  /* ---------------------------------------------------------------------------------------- */

  readers(paneId: string): PaneReaders | undefined {
    const e = this.entries.get(paneId)
    return e && !e.wc.isDestroyed() ? e.readers : undefined
  }

  async cdp(paneId: string, method: string, params: object = {}): Promise<unknown> {
    const e = this.entries.get(paneId)
    if (!e) throw new Error('pane is gone')
    return this.cdpStrict(e, method, params)
  }

  captureStatus(paneId: string): { active: boolean; expiresAt: number | null } {
    const s = this.entries.get(paneId)?.readers.capture.status()
    return { active: s?.active ?? false, expiresAt: s?.expiresAt ?? null }
  }

  /** End a pane's network capture because the operator (or the kill-switch) said so. */
  stopCapture(paneId: string, reason: 'disconnected' | 'kill-switch'): void {
    this.entries.get(paneId)?.readers.stopCapture(reason)
  }

  /** Every pane's capture ends: the kill-switch went off (spec §7.4). */
  stopAllCaptures(reason: 'kill-switch'): void {
    for (const e of this.entries.values()) e.readers.stopCapture(reason)
  }

  /**
   * Names the view AND the origin that shows the pane now (spec §7.1, amended 2026-10-22): a lease is granted for
   * ONE view on ONE origin (scheme + host + port). A pane that moves to another host, or is re-created under the
   * same id, gets a different token, so the lease no longer applies and the next lease-row call asks again.
   * The part before `|` is the view; the part after it is the origin.
   */
  viewToken(paneId: string): string | undefined {
    const e = this.entries.get(paneId)
    return e && !e.wc.isDestroyed() ? `${e.wc.id}|${originKey(e.wc.getURL())}` : undefined
  }

  /** The factor between page CSS px and view coordinates: 1 until a device is emulated (assumption A5). */
  inputScale(paneId: string): number {
    const e = this.entries.get(paneId)
    return e && this.deviceMode(paneId) ? e.deviceScale : 1
  }

  /**
   * Whether mouse and key events sent over CDP reach the pane's current document. Measured in the U4 live runs
   * (`browser/input-ready.ts` has the table): they are acknowledged and NOT delivered after a navigation that
   * commits in a fresh renderer (the first document, about:blank → a site, a cross-site navigation), and after a
   * script's own `location.replace`; they ARE delivered once Harnu itself navigates the pane to the same host again
   * (a reload is enough), shown, hidden or parked. `insertText`, eval and snapshot are never affected. The root
   * cause is not understood (disabling the parking override drops everything; re-asserting it on load changes
   * nothing); this is the observed rule, not a theory.
   */
  inputReady(paneId: string): boolean {
    const e = this.entries.get(paneId)
    return !e || e.inputState.ready
  }

  /** The pane emulates touch: the input verbs tap instead of clicking (T572, `tapEvents`). */
  touchActive(paneId: string): boolean {
    return effectiveTouch(this.deps.registry.get(paneId)?.emulation)
  }

  /** The header's `driving` word while an acting verb runs. */
  drive(paneId: string, on: boolean): void {
    const e = this.entries.get(paneId)
    if (e) this.setActivity(e, on ? 'driving' : null)
  }

  /**
   * How the pane's view is shown right now. `capturePage()` works on all three (spec §2.3, A3): a parked view is
   * attached and visible at 1×1 with a 1280×800 metrics override, and a view that painted and was then hidden
   * (under an overlay, in another tab) keeps its last frame.
   */
  viewMode(paneId: string): ViewMode | undefined {
    const e = this.entries.get(paneId)
    if (!e || e.wc.isDestroyed()) return undefined
    if (e.parked) return e.frozen ? 'hidden' : 'parked'
    return e.view.getVisible() ? 'visible' : 'hidden'
  }

  /** A device is being emulated (spec §9.2): the pane's emulation record names one. */
  deviceMode(paneId: string): boolean {
    return deviceActive(this.deps.registry.get(paneId)?.emulation)
  }

  async capture(paneId: string, req: CaptureRequest): Promise<CaptureResult> {
    const e = this.entries.get(paneId)
    if (!e || e.wc.isDestroyed()) throw new Error('pane is gone')
    const plan = req.plan
    let image: Electron.NativeImage
    let passthrough: Buffer | null = null
    /** CDP was asked for a smaller image than the page's own size (the clip scale), so the shot was clamped. */
    let cdpClamped = false
    if (plan.method === 'cdp') {
      const params: Record<string, unknown> = {
        format: req.format,
        ...(req.format === 'jpeg' ? { quality: req.quality } : {})
      }
      const rect = req.documentRect
      if (rect) {
        // Ask CDP for the final size so a large page is never rendered at full resolution only to be shrunk.
        const k = Math.min(1, req.maxDim / Math.max(rect.width, rect.height))
        cdpClamped = k < 1
        params.clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: k }
        params.captureBeyondViewport = true
      }
      const res = (await this.cdpStrict(e, 'Page.captureScreenshot', params)) as { data?: string }
      if (!res.data) throw new Error('the page returned no image')
      passthrough = Buffer.from(res.data, 'base64')
      image = nativeImage.createFromBuffer(passthrough)
    } else {
      const bounds = e.view.getBounds()
      const crop = plan.cropToBounds
        ? { x: 0, y: 0, width: bounds.width, height: bounds.height }
        : undefined
      image = crop ? await e.wc.capturePage(crop) : await e.wc.capturePage()
      if (plan.cropToElement && req.viewportRect) {
        // The element box is in CSS px of the page; the capture is in device px. A parked view is 1×1 with a
        // 1280-wide metrics override, a device is laid out at its own width whatever the fit scale (AC-6), and
        // otherwise the viewport is the bounds divided by the page zoom.
        const size = image.getSize()
        const device = this.deps.registry.get(paneId)?.emulation?.device
        const k = elementCropScale({
          imageWidth: size.width,
          boundsWidth: bounds.width,
          zoom: e.wc.getZoomFactor(),
          parked: e.parked,
          parkedWidth: PARKED_METRICS.width,
          deviceWidth: device ? device.width : null
        })
        const r = req.viewportRect
        const x = Math.max(0, Math.round(r.x * k))
        const y = Math.max(0, Math.round(r.y * k))
        const w = Math.min(size.width - x, Math.round(r.width * k))
        const h = Math.min(size.height - y, Math.round(r.height * k))
        if (w < 1 || h < 1) throw new Error('the element is outside the visible part of the page')
        image = image.crop({ x, y, width: w, height: h })
      }
    }
    if (image.isEmpty()) throw new Error('the page has not painted yet')
    const size = image.getSize()
    const fit = clampSize(size.width, size.height, req.maxDim)
    if (!fit.clamped && passthrough) {
      return {
        data: passthrough,
        mime: req.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        width: size.width,
        height: size.height,
        clamped: cdpClamped
      }
    }
    const out = fit.clamped
      ? image.resize({ width: fit.width, height: fit.height, quality: 'best' })
      : image
    return {
      data: req.format === 'jpeg' ? out.toJPEG(req.quality) : out.toPNG(),
      mime: req.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      width: out.getSize().width,
      height: out.getSize().height,
      clamped: fit.clamped || cdpClamped
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Zoom, device emulation (T572 U5, spec §9)                                                  */
  /* ---------------------------------------------------------------------------------------- */

  /** The zoom factor in effect: 1 in device mode, where zoom is off (Q15). */
  zoomOf(paneId: string): number {
    const e = this.entries.get(paneId)
    if (!e || e.wc.isDestroyed() || this.deviceMode(paneId)) return 1
    return e.wc.getZoomFactor()
  }

  /**
   * Zoom the page's origin: clamped, remembered in `browser-prefs.json` and applied (spec §9.1). The agent's
   * `browser_emulate({ zoom })` and the operator's buttons both land here. In device mode it changes nothing.
   */
  setZoom(paneId: string, factor: number): number {
    const e = this.entries.get(paneId)
    if (!e || e.wc.isDestroyed() || this.deviceMode(paneId)) return 1
    const f = clampZoom(factor)
    this.deps.prefs.setZoom(e.wc.getURL(), f)
    e.wc.setZoomFactor(f)
    this.publish(e)
    return f
  }

  /** The operator's header buttons and `Ctrl +` / `Ctrl −` / `Ctrl 0`. Resolves the factor in effect, `null` if the pane is gone. */
  operatorZoom(paneId: string, action: 'in' | 'out' | 'reset'): number | null {
    const e = this.entries.get(paneId)
    if (!e || e.wc.isDestroyed()) return null
    this.deps.registry.noteOperatorInteraction(paneId)
    if (this.deviceMode(paneId)) return 1
    return this.setZoom(paneId, action === 'reset' ? 1 : stepZoom(e.wc.getZoomFactor(), action))
  }

  /** The page's zoom for its origin, restored on navigation; 1 in device mode (spec §9.1, Q15). */
  private applyZoom(e: ViewEntry): void {
    if (e.wc.isDestroyed()) return
    const factor = this.deviceMode(e.paneId) ? 1 : this.deps.prefs.zoomFor(e.wc.getURL())
    if (Math.abs(e.wc.getZoomFactor() - factor) > 1e-6) e.wc.setZoomFactor(factor)
  }

  /**
   * Put the pane's emulation record (`rec.emulation`, already updated by the caller) on the page: touch, user agent
   * and media features, then the device metrics at the scale the pane's bounds give them. Publishes the state so
   * the picker and the device frame follow, waits briefly for the renderer's new rect (the frame is laid out by
   * the renderer), and re-applies at the final bounds. Rejects if the page refuses a command.
   */
  async applyEmulation(
    paneId: string,
    opts: { reloadForTouch: boolean }
  ): Promise<{ fitScale: number | null; reloaded: boolean }> {
    const e = this.entries.get(paneId)
    if (!e || e.wc.isDestroyed()) throw new Error('pane is gone')
    const next = this.deps.registry.get(paneId)?.emulation ?? {}
    const prev = e.applied
    this.applyZoom(e)
    if (e.pageReady) {
      for (const c of sessionCommands(
        next,
        e.originalUserAgent,
        { dirty: e.sessionDirty },
        NATIVE_HINTS_ENV
      )) {
        await this.cdpStrict(e, c.method, c.params)
      }
      e.sessionDirty = nextSessionState(next).dirty
      this.syncMetrics(e, true)
    }
    e.applied = next
    this.publish(e)
    await this.waitForBounds(e, 350)
    this.syncMetrics(e)
    let reloaded = false
    const url = e.wc.getURL()
    if (
      opts.reloadForTouch &&
      needsReloadFor(prev, next) &&
      e.pageReady &&
      !e.wc.isLoading() &&
      url !== '' &&
      url !== 'about:blank'
    ) {
      e.wc.reload()
      reloaded = true
    }
    return { fitScale: next.device ? e.deviceScale : null, reloaded }
  }

  /** The device picker (header): the same rules and the same merge as the agent's verb, no gate (the human). */
  async operatorEmulate(
    paneId: string,
    raw: unknown
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const e = this.entries.get(paneId)
    const rec = this.deps.registry.get(paneId)
    if (!e || !rec || e.wc.isDestroyed()) return { ok: false, detail: 'PANE_NOT_FOUND' }
    const patch: EmulateArgs = sanitizeEmulatePatch(raw)
    const refusal = checkEmulateArgs(patch, { deviceActive: deviceActive(rec.emulation) })
    // A rotate that carries nothing else is a valid picker click even though it names no field to set.
    if (refusal && !(patch.rotate === true && Object.keys(patch).length === 1)) {
      return { ok: false, detail: refusal.detail }
    }
    this.deps.registry.noteOperatorInteraction(paneId)
    const prev = rec.emulation ?? {}
    rec.emulation = mergeEmulation(prev, patch)
    try {
      await this.applyEmulation(paneId, { reloadForTouch: true })
    } catch (err) {
      rec.emulation = prev
      await this.applyEmulation(paneId, { reloadForTouch: false }).catch(() => undefined)
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
    return { ok: true }
  }

  private waitForBounds(e: ViewEntry, ms: number): Promise<void> {
    // Nothing is mounted to relayout while the pane is parked or hidden: the rect arrives when it is shown.
    if (e.parked || !e.visibleReported) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        if (e.boundsWaiter === done) e.boundsWaiter = null
        resolve()
      }
      const timer = setTimeout(done, ms)
      e.boundsWaiter = done
    })
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Downloads (T572 U5, spec §3.2, Q16)                                                        */
  /* ---------------------------------------------------------------------------------------- */

  /** Arm the one-shot allowance for the pane: the next download it starts is saved (spec §3.2). */
  armDownload(paneId: string, opts: { name?: string; timeoutMs: number }): DownloadArm {
    return this.arms.arm(paneId, opts)
  }

  /** Start a download of `url` through the pane's session; `will-download` then finds the allowance. */
  downloadUrl(paneId: string, url: string): void {
    const e = this.entries.get(paneId)
    if (!e || e.wc.isDestroyed()) throw new Error('pane is gone')
    e.wc.downloadURL(url)
  }

  /** The operator answered the "Save to .harnu/out/downloads/?" prompt (or it timed out: a No). */
  answerDownload(paneId: string, allow: boolean): void {
    const e = this.entries.get(paneId)
    const pending = e?.prompt
    if (!e || !pending || pending.answered) return
    pending.answered = true
    clearTimeout(pending.timer)
    this.deps.registry.noteOperatorInteraction(paneId)
    this.stepHeld(e, pending, allow ? 'allow' : 'deny')
    // The question is closed either way; a Save whose file is still arriving finishes in the background.
    this.publish(e)
  }

  /**
   * Run one step of a held download (`stepHeldDownload`) and do what it says: nothing, move the finished file into
   * the folder, or throw the temporary file away. The notice reports how it ended.
   */
  private stepHeld(e: ViewEntry, p: PendingDownload, action: HeldAction): void {
    const { state, effect } = stepHeldDownload(p.step, action)
    p.step = state
    if (effect === 'none') return
    const alive = !e.wc.isDestroyed() && this.entries.has(e.paneId)
    const finish = (notice: BrowserNotice): void => {
      clearTimeout(p.timer)
      void rawRm(p.tempDir, { recursive: true, force: true }).catch(() => undefined)
      if (e.prompt === p) e.prompt = null
      if (alive) this.transientNotice(e, notice)
    }
    if (effect === 'discard') {
      try {
        if (!state.completed) p.item.cancel()
      } catch {
        /* already finished */
      }
      finish(state.failed ? { kind: 'download-failed' } : { kind: 'download-cancelled' })
      return
    }
    // effect === 'move': the operator said yes and every byte is here.
    const moved = moveHeldDownload(e.folder, p.tempFile, p.name, MOVE_FS)
    finish(moved.ok ? { kind: 'downloaded', name: moved.name } : { kind: 'download-failed' })
  }

  private onWillDownload(
    event: Electron.Event,
    item: Electron.DownloadItem,
    wc: WebContents | undefined
  ): void {
    const paneId = wc ? this.byWebContentsId.get(wc.id) : undefined
    const e = paneId ? this.entries.get(paneId) : undefined
    // A download from anything that is not one of our panes has no business in this session.
    if (!e) {
      event.preventDefault()
      return
    }
    const armed = this.arms.isArmed(e.paneId)
    const decision = decideDownload({
      armed,
      gesturePending: e.gestures.pending(),
      promptPending: e.prompt !== null,
      totalBytes: item.getTotalBytes()
    })
    if (decision.action === 'cancel') {
      event.preventDefault()
      if (decision.reason === 'too-large') {
        if (armed) {
          this.arms.claim(e.paneId)?.settle({
            ok: false,
            code: 'DOWNLOAD_TOO_LARGE',
            detail: `${item.getTotalBytes()} bytes`
          })
        } else this.transientNotice(e, { kind: 'download-failed' })
      }
      return
    }
    if (decision.action === 'prompt') {
      this.holdOperatorDownload(e, item)
      return
    }
    const claim = this.arms.claim(e.paneId)
    const target = resolveDownloadTarget(e.folder, claim?.name ?? item.getFilename(), AGENT_FS)
    if (!target.ok) {
      event.preventDefault()
      if (claim) {
        claim.settle({
          ok: false,
          code: 'DOWNLOAD_FAILED',
          detail: this.deps.scrub(target.detail)
        })
      } else this.transientNotice(e, { kind: 'download-failed' })
      return
    }
    item.setSavePath(target.absPath)
    e.agentDownload = { item, absPath: target.absPath }
    let tooLarge = false
    item.on('updated', () => {
      // A size the server did not announce is watched as it grows.
      if (!tooLarge && overLimit(item.getReceivedBytes())) {
        tooLarge = true
        item.cancel()
      }
    })
    item.once('done', (_ev, state) => {
      if (e.agentDownload?.item === item) e.agentDownload = null
      // The reserved placeholder must not outlive a download that did not complete.
      if (state !== 'completed') {
        try {
          unlinkSync(target.absPath)
        } catch {
          /* already removed */
        }
      }
      claim?.settle(
        downloadResult({
          state,
          savedAs: target.absPath,
          relPath: target.relPath,
          bytes: item.getReceivedBytes(),
          mime: item.getMimeType(),
          tooLarge
        })
      )
    })
  }

  /**
   * The operator's own click started a download (Q16). It is received into a private temporary directory and the pane
   * asks "Save … to .harnu/out/downloads/?"; nothing reaches the folder before the answer, however small the file
   * (a paused download is not a hold: it can finish before the pause lands).
   */
  private holdOperatorDownload(e: ViewEntry, item: Electron.DownloadItem): void {
    const name = sanitizeDownloadName(item.getFilename())
    let tempDir: string
    try {
      tempDir = mkdtempSync(joinPath(tmpdir(), HELD_DIR_PREFIX))
    } catch {
      item.cancel()
      this.transientNotice(e, { kind: 'download-failed' })
      return
    }
    const tempFile = joinPath(tempDir, name)
    item.setSavePath(tempFile)
    e.gestures.consume()
    const pending: PendingDownload = {
      item,
      name,
      tempDir,
      tempFile,
      step: NEW_HELD_DOWNLOAD,
      answered: false,
      tooLarge: false,
      timer: setTimeout(() => this.answerDownload(e.paneId, false), DOWNLOAD_PROMPT_TIMEOUT_MS)
    }
    e.prompt = pending
    item.on('updated', () => {
      if (!pending.tooLarge && overLimit(item.getReceivedBytes())) {
        pending.tooLarge = true
        item.cancel()
      }
    })
    item.once('done', (_ev, state) =>
      this.stepHeld(
        e,
        pending,
        state === 'completed' && !pending.tooLarge ? 'done-ok' : 'done-fail'
      )
    )
    this.publish(e)
  }

  /** A notice that clears itself after a few seconds (design.md "Download prompt"). */
  private transientNotice(e: ViewEntry, notice: BrowserNotice): void {
    this.publish(e, { notice })
    setTimeout(() => {
      if (this.entries.has(e.paneId) && e.notice === notice) this.publish(e, { notice: null })
    }, TRANSIENT_NOTICE_MS)
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
    if (!e) {
      // A discarded pane has no view to place: keep where the renderer put it for the revival, and let a pane
      // that is shown for real come back when its reason says so (a restored pane loads, an idle discard waits).
      const rec = this.deps.registry.get(paneId)
      if (rec?.discarded) {
        this.lastBounds.set(paneId, { rect, visible })
        if (visible) this.hidden.markShown(paneId)
        else this.hidden.markHidden(paneId, this.deps.now())
        if (visible && reviveOnShow(rec.discarded.reason)) void this.revive(paneId)
      }
      return
    }
    if (e.wc.isDestroyed()) return
    this.lastBounds.set(paneId, { rect, visible })
    if (visible) this.hidden.markShown(paneId)
    else this.hidden.markHidden(paneId, this.deps.now())
    e.rectCss = rect
    e.visibleReported = visible
    if (!visible) {
      // Hidden: a freeze no longer applies, and a painted view keeps its bounds (`placeView` hides it).
      if (!e.parked) {
        e.gen.bump()
        e.frozen = false
      }
    }
    this.place(e)
    this.reconcileFreeze()
    // A device relayout was waiting for this rect (spec §9.2): the page scale follows the bounds just set.
    e.boundsWaiter?.()
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
    e.parked = placement.parked
    e.view.setBounds(placement.bounds)
    // A removed page file hides the view; the pane chrome shows the placeholder (design.md "Page pane").
    e.view.setVisible(placement.visible && !e.fileRemoved)
    // Parked → real rect clears the parking override and applies the pane's own emulation record (spec §2.3);
    // a changed rect in device mode changes the scale the page is shown at (spec §9.2).
    this.syncMetrics(e)
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
    // Every navigation started from the address bar or its buttons is Harnu's, not the page's (`input-ready.ts`).
    e.harnuNavigation = true
    if ('url' in target) {
      const verdict = checkTopLevelNavigation(target.url, 'operator')
      if (!verdict.ok) {
        this.publish(e, { notice: { kind: 'blocked', scheme: verdict.scheme } })
        return { ok: false, scheme: verdict.scheme }
      }
      // The operator picked this site: the agent flag no longer applies (spec §3.2).
      const rec = this.deps.registry.get(paneId)
      if (rec) rec.flagged = flagAfterOperatorAction()
      e.notice = null
      e.requestedUrl = verdict.url
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
    if (rec) rec.flagged = flagAfterOperatorAction()
    if (e) this.publish(e, { flagged: null })
  }

  dismissNotice(paneId: string): void {
    const e = this.entries.get(paneId)
    if (!e) return
    e.notice = null
    this.publish(e)
  }

  /** The renderer needs the keyboard (focus the address field): move the OS focus to the app's webContents. */
  focusApp(): void {
    this.deps.getWindow()?.webContents.focus()
  }

  openDevTools(paneId: string): void {
    const e = this.entries.get(paneId)
    if (e && !e.wc.isDestroyed()) e.wc.openDevTools({ mode: 'detach' })
  }

  /** Re-publish a pane's state (a pause, a resume, a Disconnect changed). */
  refresh(paneId: string): void {
    const e = this.entries.get(paneId)
    if (e) this.publish(e)
    else this.publishDiscarded(paneId)
  }

  state(paneId: string): BrowserPaneState | null {
    const e = this.entries.get(paneId)
    return e ? this.snapshot(e) : this.snapshotDiscarded(paneId)
  }

  has(paneId: string): boolean {
    return this.entries.has(paneId) || this.isDiscarded(paneId)
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Discard and revive (T574, spec §10.1)                                                      */
  /* ---------------------------------------------------------------------------------------- */

  /** The pane's page is gone (paused to save memory, or restored after a restart) and is waiting to come back. */
  isDiscarded(paneId: string): boolean {
    return !this.entries.has(paneId) && this.deps.registry.get(paneId)?.discarded != null
  }

  /**
   * A pane that exists only as a record (a restart restored it): no view until it is shown or driven. The caller has
   * put the {@link DiscardState} on the registry record.
   */
  restoreDiscarded(paneId: string): void {
    this.hidden.markHidden(paneId, this.deps.now())
    this.publishDiscarded(paneId)
    this.startSweep()
  }

  /** Read the page's scroll position; a page that does not answer in time gives `null`. */
  private async readScroll(e: ViewEntry): Promise<unknown> {
    if (e.wc.isDestroyed()) return null
    try {
      return await Promise.race([
        e.wc.executeJavaScript('({ x: window.scrollX, y: window.scrollY })', false),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500))
      ])
    } catch {
      return null
    }
  }

  /**
   * Discard a live pane: record where it was, destroy its webContents and release the view. The registry record,
   * its pins and the operator's Disconnect/Pause all stay. Returns false when there was no live view.
   */
  async discard(paneId: string, reason: DiscardReason = 'idle'): Promise<boolean> {
    const e = this.entries.get(paneId)
    const rec = this.deps.registry.get(paneId)
    if (!e || !rec || e.wc.isDestroyed()) return false
    const scroll = await this.readScroll(e)
    // The pane may have been shown, driven or closed while the scroll was read.
    if (this.entries.get(paneId) !== e || e.wc.isDestroyed()) return false
    rec.discarded = buildDiscardState({
      reason,
      url: liveUrlOf(e.wc.getURL(), e.requestedUrl),
      title: e.wc.getTitle(),
      scroll,
      zoom: e.wc.getZoomFactor(),
      now: this.deps.now(),
      hiddenSince: this.hidden.since(paneId)
    })
    // What the discard recorded is also what a restart should find.
    this.send('browser:persist', { paneId, scroll: rec.discarded.scroll })
    this.sentScroll.set(paneId, JSON.stringify(rec.discarded.scroll))
    this.deps.onViewDiscarded?.(paneId)
    this.release(paneId)
    this.hidden.markHidden(paneId, this.deps.now())
    this.publishDiscarded(paneId)
    return true
  }

  /**
   * Bring a discarded pane back: a new view loads the recorded address, the page zoom and scroll are put back when it
   * has loaded, and the last rect the renderer reported is applied. Resolves true when the pane is live (it also is
   * when it already was), after the first load settled or 10 s, whichever comes first.
   */
  revive(paneId: string, opts: { primeInput?: boolean } = {}): Promise<boolean> {
    const running = this.reviving.get(paneId)
    if (running) return running
    const rec = this.deps.registry.get(paneId)
    if (this.entries.has(paneId)) return Promise.resolve(true)
    if (!rec?.discarded) return Promise.resolve(false)
    const d = rec.discarded
    const job = (async (): Promise<boolean> => {
      try {
        this.create({ paneId, folder: rec.folder, partition: rec.partition, url: d.url })
      } catch {
        return false
      }
      rec.discarded = null
      const e = this.entries.get(paneId)
      if (!e) return false
      this.restoreAfterLoad(e, d.zoom, d.scroll)
      this.publish(e)
      await this.firstLoad(e, 10_000)
      // Mouse and key events are dropped on the first document of a view (input-ready.ts). A verb that is about to
      // send some asks for one Harnu-started reload, which is what makes them arrive, so the revival does not end in
      // PANE_INPUT_NOT_READY.
      if (opts.primeInput && !e.inputState.ready && !e.wc.isDestroyed() && e.wc.getURL() !== '') {
        e.harnuNavigation = true
        e.wc.reload()
        await this.firstLoad(e, 10_000)
      }
      return true
    })().finally(() => this.reviving.delete(paneId))
    this.reviving.set(paneId, job)
    return job
  }

  /** The page zoom and the scroll position come back once the page has loaded (best effort). */
  private restoreAfterLoad(
    e: ViewEntry,
    zoom: number,
    scroll: { x: number; y: number } | null
  ): void {
    const wc = e.wc
    wc.once('did-finish-load', () => {
      if (wc.isDestroyed()) return
      if (zoom !== 1 && !e.applied.device) {
        try {
          wc.setZoomFactor(zoom)
        } catch {
          /* the view went away */
        }
      }
      if (scroll && (scroll.x !== 0 || scroll.y !== 0)) {
        const script = `window.scrollTo(${scroll.x}, ${scroll.y})`
        void wc.executeJavaScript(script, false).catch(() => undefined)
        // A page that lays itself out late: once more after it had a moment.
        setTimeout(() => {
          if (!wc.isDestroyed()) void wc.executeJavaScript(script, false).catch(() => undefined)
        }, 400)
      }
    })
  }

  private firstLoad(e: ViewEntry, timeoutMs: number): Promise<void> {
    const wc = e.wc
    return new Promise((resolve) => {
      if (wc.isDestroyed()) return resolve()
      const done = (): void => {
        clearTimeout(timer)
        wc.removeListener('did-finish-load', done)
        wc.removeListener('did-fail-load', done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      wc.once('did-finish-load', done)
      wc.once('did-fail-load', done)
    })
  }

  /** The facts the sweep judges one live pane by. */
  private discardFacts(e: ViewEntry): DiscardFacts {
    const reg = this.deps.registry
    return {
      paneId: e.paneId,
      discarded: false,
      hiddenSince: this.hidden.since(e.paneId),
      verbInFlight:
        reg.verbsInFlight(e.paneId) > 0 ||
        reg.agentInput(e.paneId).inFlight ||
        e.activity !== null ||
        e.loading,
      captureActive: e.readers.capture.status().expiresAt !== null,
      operatorAt: reg.operatorInteractionAt(e.paneId),
      downloadPending: e.prompt !== null || e.agentDownload != null || this.arms.isArmed(e.paneId)
    }
  }

  /** The last scroll position sent for persistence, per pane, so only a change is sent. */
  private readonly sentScroll = new Map<string, string>()

  /**
   * Remember where a page is scrolled so a restart can put it back (best effort, spec §10.3). Only a settled pane is
   * read, at the sweep's pace, and only a change is sent. A hidden pane is read too: it may be the one a restart finds.
   */
  private sampleScroll(e: ViewEntry): void {
    if (e.wc.isDestroyed() || e.loading) return
    void this.readScroll(e).then((raw) => {
      const scroll = sanitizeScroll(raw)
      const key = JSON.stringify(scroll)
      if (!this.entries.has(e.paneId) || this.sentScroll.get(e.paneId) === key) return
      this.sentScroll.set(e.paneId, key)
      this.send('browser:persist', { paneId: e.paneId, scroll })
    })
  }

  /** One pass of the discard clock: discard every hidden pane that has waited long enough and is idle. */
  sweep(): void {
    for (const e of this.entries.values()) this.sampleScroll(e)
    const facts: DiscardFacts[] = []
    for (const e of this.entries.values()) if (!e.wc.isDestroyed()) facts.push(this.discardFacts(e))
    const now = this.deps.now()
    for (const id of planDiscard(facts, now, this.deps.discardMs ?? HIDDEN_DISCARD_MS)) {
      void this.discard(id)
    }
  }

  private startSweep(): void {
    if (this.sweepTimer) return
    const ms = this.deps.discardMs ?? HIDDEN_DISCARD_MS
    // Check often enough that a shortened test time is honoured within about a second.
    const every = Math.max(250, Math.min(DISCARD_SWEEP_INTERVAL_MS, Math.floor(ms / 2)))
    this.sweepTimer = setInterval(() => this.sweep(), every)
    this.sweepTimer.unref?.()
  }

  private snapshotDiscarded(paneId: string): BrowserPaneState | null {
    const r = this.deps.registry.get(paneId)
    const d = r?.discarded
    if (!r || !d) return null
    return {
      paneId,
      url: d.url,
      title: d.title,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      origin: classifyOrigin(d.url, {
        extraTrustedHosts: this.deps.trustedHosts(r.folder),
        harnuPorts: this.deps.harnuPorts()
      }),
      openedBy: r.openedBy,
      partition: r.partition,
      flagged: r.flagged,
      pausedUntil: this.deps.access.pausedUntil(paneId),
      disconnected: this.deps.access.isDisconnected(paneId),
      ownerSessionId: r.ownerSessionId,
      notice: null,
      agentReads: r.openedBy === 'agent' || this.deps.readOptIn(r.folder),
      leaseActive: false,
      networkUntil: null,
      zoom: d.zoom,
      emulation: r.emulation ?? {},
      downloadPrompt: null,
      pagePath: r.pagePath ?? null,
      allowNetwork: r.allowNetwork === true,
      pageFileRemoved: false,
      discarded: { reason: d.reason, hiddenMs: d.hiddenMs }
    }
  }

  private publishDiscarded(paneId: string): void {
    const state = this.snapshotDiscarded(paneId)
    if (state) this.send('browser:state', state)
  }

  /* ---- The page side (T569 U2) ---------------------------------------------------------------- */

  webContentsOf(paneId: string): WebContents | undefined {
    const e = this.entries.get(paneId)
    return e && !e.wc.isDestroyed() ? e.wc : undefined
  }

  paneIdOfWebContents(webContentsId: number): string | undefined {
    return this.byWebContentsId.get(webContentsId)
  }

  lastRealKeyDownAt(paneId: string): number | null {
    return this.entries.get(paneId)?.lastRealKeyDownAt ?? null
  }

  /** Reload a page pane, keeping its scroll position (spec §4.4). */
  async reloadPage(paneId: string): Promise<void> {
    const e = this.entries.get(paneId)
    if (!e || e.wc.isDestroyed()) return
    let scroll: [number, number] = [0, 0]
    try {
      const got = (await e.wc.executeJavaScript('[window.scrollX, window.scrollY]')) as unknown
      if (Array.isArray(got) && typeof got[0] === 'number' && typeof got[1] === 'number') {
        scroll = [got[0], got[1]]
      }
    } catch {
      /* the page was not ready: reload from the top */
    }
    e.wc.once('did-finish-load', () => {
      if (e.wc.isDestroyed() || (scroll[0] === 0 && scroll[1] === 0)) return
      void e.wc
        .executeJavaScript(`window.scrollTo(${scroll[0]}, ${scroll[1]})`)
        .catch(() => undefined)
    })
    e.wc.reloadIgnoringCache()
  }

  /** The served file was deleted (or came back): hide the view and show the placeholder, or undo that. */
  setFileRemoved(paneId: string, removed: boolean): void {
    const e = this.entries.get(paneId)
    if (!e || e.fileRemoved === removed) return
    e.fileRemoved = removed
    this.place(e)
    this.publish(e)
  }

  /** The operator flipped "Allow network": the policy rides the document response, so reload to apply it. */
  setAllowNetwork(paneId: string, allow: boolean): boolean {
    const rec = this.deps.registry.get(paneId)
    const e = this.entries.get(paneId)
    if (!rec || !e || rec.allowNetwork === allow) return false
    this.deps.registry.noteOperatorInteraction(paneId)
    rec.allowNetwork = allow
    this.publish(e)
    if (!e.wc.isDestroyed()) e.wc.reloadIgnoringCache()
    return true
  }

  /**
   * Evaluate `script` in the pane's top frame and main world once the page has loaded (waits up to `waitMs`).
   * `null` when the page never became ready or the script threw.
   */
  async runInPage<T>(paneId: string, script: string, waitMs = 5000): Promise<T | null> {
    const e = this.entries.get(paneId)
    if (!e || e.wc.isDestroyed()) return null
    if (e.wc.isLoading()) {
      const ready = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), waitMs)
        e.wc.once('did-stop-loading', () => {
          clearTimeout(timer)
          resolve(true)
        })
      })
      if (!ready) return null
    }
    try {
      return (await e.wc.executeJavaScript(script, false)) as T
    } catch {
      return null
    }
  }

  destroyAll(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    for (const id of [...this.entries.keys()]) this.release(id)
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
    // The metrics override is sent when the page first becomes ready (`syncMetrics`), not here: the U1 live run
    // crashed the app (SIGSEGV) when `Emulation.setDeviceMetricsOverride` reached a view that had not yet created
    // its first frame.
    if (!e.wc.isLoading() && e.wc.getURL() !== '') {
      e.pageReady = true
      this.syncMetrics(e)
    }
  }

  /**
   * Make the page's device metrics what the pane's record and parking say (spec §2.3, §9.2): a device at the scale
   * the bounds give it, the 1280×800 parking override while parked, or nothing. Cheap to call: an unchanged command
   * is not sent again, and nothing is sent before the page can take it.
   */
  private syncMetrics(e: ViewEntry, force = false): void {
    if (!e.pageReady || e.wc.isDestroyed()) return
    const device = this.deps.registry.get(e.paneId)?.emulation?.device
    let cmd: ReturnType<typeof metricsCommand>
    if (device) {
      // A parked view is 1×1: its scale is meaningless, the page just renders at device size (spec §2.3).
      e.deviceScale = e.parked ? 1 : viewScale(device.width, e.view.getBounds().width)
      cmd = metricsCommand(device, e.deviceScale)
    } else if (e.parked) {
      e.deviceScale = 1
      cmd = {
        method: 'Emulation.setDeviceMetricsOverride',
        params: {
          width: PARKED_METRICS.width,
          height: PARKED_METRICS.height,
          deviceScaleFactor: PARKED_METRICS.deviceScaleFactor,
          mobile: false
        }
      }
    } else {
      e.deviceScale = 1
      cmd = metricsCommand(undefined, 1)
    }
    const key = JSON.stringify(cmd)
    if (!force && key === e.lastMetricsKey) return
    const wasSent = e.lastMetricsKey !== null
    e.lastMetricsKey = key
    // Clearing an override that was never sent is a no-op.
    if (!wasSent && cmd.method === 'Emulation.clearDeviceMetricsOverride') return
    void this.cdpQuiet(e, cmd.method, cmd.params)
  }

  /** Touch, user agent and media features of the record, fire-and-forget (navigation start, spec §9.2). */
  private pushSession(e: ViewEntry): void {
    const rec = this.deps.registry.get(e.paneId)?.emulation ?? {}
    for (const c of sessionCommands(
      rec,
      e.originalUserAgent,
      { dirty: e.sessionDirty },
      NATIVE_HINTS_ENV
    )) {
      void this.cdpQuiet(e, c.method, c.params)
    }
    if (!isEmptyRecord(rec) || e.sessionDirty) e.sessionDirty = nextSessionState(rec).dirty
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
    const ctx = {
      overlays: this.overlays,
      dragActive: this.dragActive,
      parkedRect: this.parkedCssRect()
    }
    for (const e of this.entries.values()) {
      if (e.wc.isDestroyed()) continue
      const action = decideFreeze(e, ctx)
      if (action === 'freeze') void this.freeze(e)
      else if (action === 'thaw') this.thaw(e)
    }
  }

  private async freeze(e: ViewEntry): Promise<void> {
    e.frozen = true
    const gen = e.gen.next()
    if (e.parked) {
      // Nothing to paint for a 1×1 corner: just get it out from under the overlay.
      e.view.setVisible(false)
      return
    }
    let dataUrl: string | null = null
    const bounds = e.view.getBounds()
    // Never stretch a tiny or stale capture over the host: a view that is not yet at its reported rect (or is
    // still parked) is hidden instead, and the pane paints its own background (delta 3).
    const plan = freezeImagePlan({
      parked: e.parked,
      bounds,
      reported: e.rectCss,
      zoomFactor: this.zoomFactor()
    })
    if (plan === 'capture') {
      try {
        const rect = freezeCaptureRect(bounds, this.deviceMode(e.paneId))
        const image = rect ? await e.wc.capturePage(rect) : await e.wc.capturePage()
        // JPEG, not PNG: PNG at DPR 2 was over the 100 ms budget in U0 (A12).
        if (!image.isEmpty() && captureMatchesBounds(image.getSize(), bounds)) {
          dataUrl = `data:image/jpeg;base64,${image.toJPEG(FREEZE_JPEG_QUALITY).toString('base64')}`
        }
      } catch {
        // A failed capture degrades to a blank rect of the pane background, never to a live view under an overlay.
      }
    }
    if (!e.gen.isCurrent(gen) || !e.frozen) return
    this.send('browser:freeze', { paneId: e.paneId, dataUrl })
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FREEZE_PAINT_TIMEOUT_MS)
      e.paintedWaiter = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    e.paintedWaiter = null
    if (!e.gen.isCurrent(gen) || !e.frozen || e.wc.isDestroyed()) return
    e.view.setVisible(false)
  }

  private thaw(e: ViewEntry): void {
    e.frozen = false
    e.gen.bump()
    e.paintedWaiter?.()
    if ((e.parked || e.visibleReported) && !e.fileRemoved) e.view.setVisible(true)
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
    // No automatic downloads (spec §3.2): `onWillDownload` cancels unless a `browser_download` call armed the pane or
    // the operator's own click started it and they answer the "Save to …?" prompt.
    ses.on('will-download', (event, item, wc) => this.onWillDownload(event, item, wc))
    // The page protocol answers on this session only (spec §4.1); the app's default session never gets it.
    this.deps.pageHooks?.registerProtocol(ses, name)
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (!isSubresourceSchemeAllowed(details.url)) return callback({ cancel: true })
      // `harnu-page:` is reachable only from a page of the same folder host (spec §3.2). This check cannot see a
      // dedicated worker's requests at all, so ALLOWING one issues the one-shot ticket the protocol handler
      // requires (`page-ticket.ts`): a request that skipped this check has no ticket and is refused there.
      const frame = details.frame
      const verdict = decidePageRequest({
        url: details.url,
        resourceType: details.resourceType,
        frame: frame
          ? {
              origin: frame.origin,
              parent: frame.parent ? { origin: frame.parent.origin } : null
            }
          : null
      })
      if (!verdict.allow) return callback({ cancel: true })
      if (details.url.startsWith('harnu-page:')) {
        this.deps.pageHooks?.onRequest(
          name,
          this.byWebContentsId.get(details.webContentsId ?? -1),
          details.url
        )
      }
      callback({})
    })
    // The per-pane "Allow network" switch rides the document response (spec §4.3): the protocol handler serves
    // the offline policy, and a pane the operator switched on gets the relaxed one here.
    ses.webRequest.onHeadersReceived((details, callback) => {
      const paneId = this.byWebContentsId.get(details.webContentsId ?? -1)
      if (
        paneId &&
        details.url.startsWith('harnu-page:') &&
        this.deps.pageHooks?.allowNetwork(paneId)
      ) {
        const headers = { ...(details.responseHeaders ?? {}) }
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === 'content-security-policy') delete headers[k]
        }
        headers['Content-Security-Policy'] = [pageCsp(true)]
        return callback({ responseHeaders: headers })
      }
      callback({})
    })
  }

  /** The F2 rule for this pane: see `page-egress.ts`. */
  private pageMayNavigate(e: ViewEntry, targetUrl: string): boolean {
    return decidePageNavigation({
      currentUrl: e.wc.getURL(),
      targetUrl,
      allowNetwork: this.deps.registry.get(e.paneId)?.allowNetwork === true
    }).allow
  }

  private attachGuestHandlers(e: ViewEntry): void {
    const wc = e.wc
    const rec = (): ReturnType<BrowserRegistry['get']> => this.deps.registry.get(e.paneId)

    wc.once('dom-ready', () => {
      e.pageReady = true
      this.pushSession(e)
      this.applyZoom(e)
      this.syncMetrics(e, true)
    })
    // Touch only counts if it was on when the page started (spec §9.2 correction 4), so the record's touch, user
    // agent and media features go out as the main frame starts navigating, before the new page's scripts run.
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.pushSession(e)
    })
    wc.on('did-start-loading', () => {
      e.loading = true
      this.publish(e)
    })
    wc.on('did-stop-loading', () => {
      e.loading = false
      this.publish(e)
    })
    wc.on('page-title-updated', () => this.publish(e))
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        this.deps.pageHooks?.onNavigationStart(e.paneId)
      }
    })
    wc.on('did-navigate', (_ev, url) => {
      e.inputState = nextInputReadyState(e.inputState, {
        host: hostOf(url),
        initiatedByHarnu: e.harnuNavigation
      })
      e.harnuNavigation = false
      this.deps.onMainFrameCommit?.(e.paneId)
      const r = rec()
      const host = hostOf(url)
      if (r && host) r.seenHosts.add(host)
      this.deps.pageHooks?.onNavigated(e.paneId, url)
      // The new page gets its origin's remembered zoom (1 in device mode) and the record again: a cross-process
      // navigation can drop the emulation (spec §9.1, §9.2, A5).
      this.applyZoom(e)
      this.pushSession(e)
      this.syncMetrics(e, true)
      this.publish(e)
    })
    wc.on('did-navigate-in-page', () => this.publish(e))
    wc.on('render-process-gone', () => this.publish(e, { notice: { kind: 'crashed' } }))

    // Layer 1 of the navigation policy: top-level navigations and redirects (spec §3.2). A navigation the
    // page itself started counts as the `page` initiator; the operator and the verbs use `loadURL`, which
    // does not pass through here.
    const guardTopLevel = (event: { preventDefault(): void }, url: string): void => {
      // An OFFLINE page pane may not navigate away at all (F2): a CSP does not stop `location = 'http://x/?d=…'`.
      if (!this.pageMayNavigate(e, url)) {
        event.preventDefault()
        this.publish(e, { notice: { kind: 'offline' } })
        return
      }
      // A link inside one of OUR pages to another file of the same folder is the page's own navigation, not an
      // external page reaching for our files (spec §3.2).
      const verdict = checkTopLevelNavigation(
        url,
        sameHarnuPageOrigin(wc.getURL(), url) ? 'verb' : 'page'
      )
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
      if (!isSubresourceSchemeAllowed(details.url) || !this.pageMayNavigate(e, details.url)) {
        details.preventDefault()
      }
    })

    // Layer 2: popups. Denied as popups; with a real user activation the target opens as a NEW operator-class
    // pane that inherits the opener's partition, with no `opener` link (spec §3.2, Q10).
    wc.setWindowOpenHandler((details) => {
      // No popup from an offline page pane: its target would be the same exfiltration channel (F2).
      if (
        !popupAllowedFrom({ currentUrl: wc.getURL(), allowNetwork: rec()?.allowNetwork === true })
      ) {
        this.publish(e, { notice: { kind: 'offline' } })
        return { action: 'deny' }
      }
      // One activation buys one popup: a page cannot loop `window.open` inside the gesture window.
      const decision = decidePopup(details.url, e.gestures.pending())
      if (decision.action === 'open-pane') {
        e.gestures.consume()
        this.deps.openPopupPane({ folder: e.folder, partition: e.partition, url: decision.url })
      } else if (decision.reason === 'scheme-blocked') {
        this.publish(e, { notice: { kind: 'blocked', scheme: schemeOf(details.url) } })
      }
      return { action: 'deny' }
    })

    // Certificate errors: denied, except loopback (self-signed local dev HTTPS), accepted and flagged.
    wc.on('certificate-error', (event, url, _error, _cert, callback) => {
      event.preventDefault()
      const { verdict, host } = certificateVerdictFor(url)
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
        this.noteGesture(e)
        e.lastRealKeyDownAt = this.deps.now()
        this.deps.registry.noteOperatorInteraction(e.paneId)
      }
      const decision = decideForward(
        input as GuestInput,
        this.boundChords,
        process.platform === 'darwin'
      )
      if (!decision.forward || decision.chord === null) return
      event.preventDefault()
      // The chord is handed over without moving the keyboard focus: a reload or back keeps the page focused.
      // An action that needs the app (focus the address bar) asks for it through `focusApp`.
      this.send('browser:chord', { paneId: e.paneId, chord: decision.chord })
    })
    wc.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type !== 'mouseDown') return
      this.noteGesture(e)
      this.deps.registry.noteOperatorInteraction(e.paneId)
    })
  }

  /**
   * The pane's CDP session. It serves the dialog interception of spec §3.1 and feeds the reading verbs: console
   * capture starts here, at pane creation, and the `Network` domain is on so `browser_wait_for`'s idle counter
   * always works (it keeps no URL and no header; recording is the separate, opt-in capture). Every enable is sent
   * in one burst before the page loads, so nothing the page logs on start is missed.
   */
  private async attachDebugger(e: ViewEntry): Promise<void> {
    try {
      if (!e.wc.debugger.isAttached()) e.wc.debugger.attach('1.3')
      e.wc.debugger.on('message', (_ev, method, params: { type?: string }) => {
        e.readers.ingest(method, params)
        if (method !== 'Page.javascriptDialogOpening') return
        const kind = params.type ?? 'alert'
        void this.cdpQuiet(e, 'Page.handleJavaScriptDialog', { accept: kind === 'beforeunload' })
        this.publish(e, { notice: { kind: 'dialog', dialog: kind } })
      })
      await Promise.all([
        ...['Page.enable', 'Runtime.enable', 'Log.enable'].map((method) =>
          this.cdpQuiet(e, method, {})
        ),
        // On for the idle counter, with buffers too small to hold a body until a capture asks for them.
        this.cdpQuiet(e, 'Network.enable', networkEnableParams(false))
      ])
    } catch {
      // A guest without a debugger still works; only dialog interception and the reading verbs are lost.
    }
  }

  /** Like {@link cdp} but a failure rejects, so a verb can tell "no answer" from "an empty answer". */
  private async cdpStrict(e: ViewEntry, method: string, params: object): Promise<unknown> {
    if (e.wc.isDestroyed() || !e.wc.debugger.isAttached())
      throw new Error('the pane has no debugger')
    return e.wc.debugger.sendCommand(method, params)
  }

  private async cdpQuiet(e: ViewEntry, method: string, params: object): Promise<unknown> {
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
      notice: e.notice,
      agentReads: (r?.openedBy ?? 'operator') === 'agent' || this.deps.readOptIn(e.folder),
      leaseActive: this.deps.leaseActive(e.paneId, this.viewToken(e.paneId) ?? ''),
      networkUntil: e.readers.capture.status().expiresAt,
      zoom: e.wc.isDestroyed() ? 1 : e.wc.getZoomFactor(),
      emulation: r?.emulation ?? {},
      downloadPrompt: e.prompt && !e.prompt.answered ? { name: e.prompt.name } : null,
      pagePath: r?.pagePath ?? null,
      allowNetwork: r?.allowNetwork === true,
      pageFileRemoved: e.fileRemoved,
      discarded: null
    }
  }

  private publish(
    e: ViewEntry,
    patch: { notice?: BrowserNotice | null; flagged?: { host: string } | null } = {}
  ): void {
    // A view that was released (closed, or discarded) can still fire a late event: it must not push a live state
    // over the discarded one the pane now shows.
    if (this.entries.get(e.paneId) !== e) return
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

/** Both addresses are `harnu-page:` URLs of the same folder host. */
function sameHarnuPageOrigin(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.protocol === 'harnu-page:' && y.protocol === 'harnu-page:' && x.host === y.host
  } catch {
    return false
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
