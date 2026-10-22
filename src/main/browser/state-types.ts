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
  /** An offline page pane tried to leave (a link, a redirect, a popup): refused (T569 F2). */
  | { kind: 'offline' }

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
  /** The folder-relative page file, or `null` (T569 U2). */
  pagePath: string | null
  /** The operator's per-pane "Allow network" switch (spec §4.3); off by default, no verb sets it. */
  allowNetwork: boolean
  /** The served page file was deleted: the pane shows the "file removed" placeholder. */
  pageFileRemoved: boolean
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
