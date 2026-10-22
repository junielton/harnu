/**
 * Wire types shared by the browser pane's main side and its renderer (T564 U1). Pure types: the preload
 * re-exports them so the renderer never imports main code at runtime.
 */

// Deliberately import-free: the preload re-exports these to the renderer project, which lists main files
// explicitly. The unions below mirror `origin-class.ts`, `guest-prefs.ts` and `access.ts`; the pure cores'
// tests pin the values, and `view-host.ts` (which assigns them) is type-checked against them.

export type BrowserOriginClass = 'page' | 'local' | 'external' | 'blank'
export type BrowserPartitionName = 'operator' | 'agent'
export type BrowserOpenedByWho = 'agent' | 'operator'

/** One-line notice the pane header shows under the address bar (design.md "Notice strip"). */
export type BrowserNotice =
  | { kind: 'blocked'; scheme: string }
  | { kind: 'certificate'; host: string }
  | { kind: 'dialog'; dialog: string }
  | { kind: 'crashed' }
  /** A download was saved (design.md "Download prompt"); clears itself after a few seconds. */
  | { kind: 'downloaded'; name: string }
  | { kind: 'download-cancelled' }
  | { kind: 'download-failed' }
  /** An offline page pane tried to leave (a link, a redirect, a popup): refused (T569 F2). */
  | { kind: 'offline' }

/** A device the pane emulates; mirrors `DeviceSpec` in `src/shared/browser-emulation.ts` (a test pins the two). */
export interface BrowserDeviceState {
  preset:
    'phone-s' | 'phone-m' | 'phone-l' | 'tablet' | 'tablet-landscape' | 'laptop' | 'desktop' | null
  width: number
  height: number
  dpr: number
  mobile: boolean
  rotated: boolean
}

/** The pane's emulation record as the chrome sees it; mirrors `EmulationRecord` in `src/shared/browser-emulation.ts`. */
export interface BrowserEmulationState {
  device?: BrowserDeviceState
  touch?: boolean
  userAgent?: string
  colorScheme?: 'light' | 'dark'
  reducedMotion?: boolean
}

/** What the operator's device picker sends (the shape of `EmulateArgs` without `zoom`), judged again in main. */
export interface BrowserEmulatePatch {
  device?: string
  width?: number
  height?: number
  dpr?: number
  mobile?: boolean
  touch?: boolean
  userAgent?: string
  colorScheme?: 'light' | 'dark'
  reducedMotion?: boolean
  reset?: boolean
  rotate?: boolean
}

/** Everything the pane chrome needs to draw, pushed from main as `browser:state`. */
export interface BrowserPaneState {
  paneId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  origin: BrowserOriginClass
  openedBy: BrowserOpenedByWho
  partition: BrowserPartitionName
  /** The "opened by agent · host" flag, or `null`. */
  flagged: { host: string } | null
  /** Epoch ms the operator's pause ends, or `null`. */
  pausedUntil: number | null
  /** The operator disconnected the agent from this pane (permanent). */
  disconnected: boolean
  ownerSessionId: string | null
  notice: BrowserNotice | null
  /** Agents may read this pane: it is agent-opened, or its folder opted in (T571, spec §7.1). */
  agentReads: boolean
  /** The operator's lease on this pane is active (T571): an agent can drive it without asking. */
  leaseActive: boolean
  /** Epoch ms the agent's network capture stops itself, or `null` when none is running (the red counter). */
  networkUntil: number | null
  /** The zoom factor in effect (1 in device mode, where zoom is off). */
  zoom: number
  /** The emulation record: empty when no device or media override is on. */
  emulation: BrowserEmulationState
  /** The operator's download is waiting for "Save to .harnu/out/downloads/?" (spec §3.2, Q16). */
  downloadPrompt: { name: string } | null
  /** The folder-relative page file, or `null` (T569 U2). */
  pagePath: string | null
  /** The operator's per-pane "Allow network" switch (spec §4.3); off by default, no verb sets it. */
  allowNetwork: boolean
  /** The served page file was deleted: the pane shows the "file removed" placeholder. */
  pageFileRemoved: boolean
  /**
   * Set while the pane's page is discarded (T574, spec §10.1): "Paused to save memory — click to reload" is shown
   * and the view is gone. `reason` is why (`idle`: paused by the timer; `restored`: reopened after a restart) and
   * `hiddenMs` how long it had been hidden.
   */
  discarded: { reason: 'idle' | 'restored'; hiddenMs: number } | null
}

/** A rectangle in CSS px, as the renderer measures it. */
export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

/** An overlay layer the renderer reports: its rectangle, or the whole window. */
export type BrowserOverlayRect = BrowserRect | 'fullscreen'

/** The live word on the chip while a verb runs (spec §7.4). */
export type BrowserActivityWord = 'reading' | 'driving' | null

export interface BrowserOpenResult {
  ok: true
  paneId: string
}
