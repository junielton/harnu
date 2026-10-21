/**
 * Wire types shared by the browser pane's main side and its renderer (T564 U1). Pure types: the preload
 * re-exports them so the renderer never imports main code at runtime.
 */
import type { OriginClass } from './origin-class'
import type { BrowserPartition } from './guest-prefs'
import type { BrowserOpenedBy } from './access'

/** One-line notice the pane header shows under the address bar (design.md "Notice strip"). */
export type BrowserNotice =
  | { kind: 'blocked'; scheme: string }
  | { kind: 'certificate'; host: string }
  | { kind: 'dialog'; dialog: string }
  | { kind: 'crashed' }

/** Everything the pane chrome needs to draw, pushed from main as `browser:state`. */
export interface BrowserPaneState {
  paneId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  origin: OriginClass
  openedBy: BrowserOpenedBy
  partition: BrowserPartition
  /** The "opened by agent · host" flag, or `null`. */
  flagged: { host: string } | null
  /** Epoch ms the operator's pause ends, or `null`. */
  pausedUntil: number | null
  /** The operator disconnected the agent from this pane (permanent). */
  disconnected: boolean
  ownerSessionId: string | null
  notice: BrowserNotice | null
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
