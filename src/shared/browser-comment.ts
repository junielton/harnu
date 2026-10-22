/**
 * Vocabulary shared by the browser pane's point-and-comment overlay (T564 U6, spec §8): the caps of a pin's
 * payload, the computed-style allowlist, the private guest channels and the plain data shapes that cross them.
 *
 * Dependency-free on purpose (no `node:` and no `electron` imports): the SANDBOXED guest preload bundles it,
 * main validates against it, and the renderer shows it. Nothing here decides anything; the decisions live in
 * `src/main/browser/comment-*.ts` (pure, tested).
 */

/* ---- Caps (spec §8.3) ----------------------------------------------------------------------------- */

export const COMMENT_MAX_CHARS = 4000
export const SELECTOR_MAX_CHARS = 512
/** "~2 KB" of outerHTML, children elided past depth 2. */
export const HTML_MAX_CHARS = 2048
export const URL_MAX_CHARS = 512
/** A `file:line` component source. */
export const COMPONENT_MAX_CHARS = 200
export const TAG_MAX_CHARS = 40
export const STYLE_VALUE_MAX_CHARS = 120
export const MAX_STYLES = 40
/** The crop's longest side after scaling, and the padding around the node's rect (CSS px). */
export const CROP_MAX_SIDE = 800
export const CROP_PADDING = 8
/** Pins kept per pane; a runaway page cannot grow the store without bound. */
export const MAX_PINS_PER_PANE = 50

/**
 * The computed properties a pin carries (spec §8.3: box model, colour, font, border, radius, shadow, display,
 * position, gap), at most {@link MAX_STYLES}. A fixed list: the guest never reads a property a page names.
 */
export const COMPUTED_STYLE_ALLOWLIST: readonly string[] = [
  'display',
  'position',
  'box-sizing',
  'width',
  'height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'border-top-width',
  'border-top-style',
  'border-top-color',
  'border-radius',
  'box-shadow',
  'opacity',
  'gap',
  'flex-direction',
  'justify-content',
  'align-items',
  'overflow',
  'z-index'
]

/* ---- The wire --------------------------------------------------------------------------------------- */

/**
 * The PRIVATE channels between the guest overlay and main (spec §3.3, §8.2). Never listed in the app preload,
 * and main accepts them only from a registered guest `webContents` (top frame). The text the operator types
 * never rides on any of them.
 */
export const OVERLAY_CHANNEL = {
  /** guest → main (invoke): the guest booted; answers with the current {@link OverlayGuestState}. */
  hello: 'harnu:overlay:hello',
  /** main → guest: the mode or the pins changed. */
  state: 'harnu:overlay:state',
  /** guest → main: the operator picked a node. */
  picked: 'harnu:overlay:picked',
  /** guest → main: the operator clicked a pin. */
  pinClicked: 'harnu:overlay:pinClicked',
  /** guest → main: the operator pressed Esc while picking. */
  exit: 'harnu:overlay:exit',
  /** guest → main: where the pins sit now (so a pin whose node vanished can be drawn at its last rect). */
  rects: 'harnu:overlay:rects'
} as const

export interface OverlayRect {
  x: number
  y: number
  width: number
  height: number
}

/** What the guest reads off the node the operator clicked. Everything in it is PAGE-AUTHORED. */
export interface PickedPayload {
  selector: string
  tag: string
  outerHTML: string
  component: string | null
  styles: Record<string, string>
  /** The node's rect in viewport CSS px at the moment of the click. */
  rect: OverlayRect
  /** The viewport size, so main can clamp the crop. */
  viewport: { width: number; height: number }
}

/** A pin as the GUEST draws it: no comment text, nothing the operator typed. */
export interface GuestPin {
  id: string
  n: number
  state: 'draft' | 'sent'
  selector: string
  /** Viewport CSS px at pick time, or as last reported by the guest. */
  rect: OverlayRect
}

/** The app theme's overlay colours, so the page layers match it. Validated by main before they are forwarded. */
export interface OverlayTheme {
  accent: string
  accentInk: string
}

export const DEFAULT_OVERLAY_THEME: OverlayTheme = { accent: '#7aa2f7', accentInk: '#0b0e1a' }

export interface OverlayGuestState {
  active: boolean
  /** The hint pill text, already localised by the app: "Click an element to comment". */
  hint: string
  /** The words after the Esc key cap in the pill, localised: "to exit". */
  exitHint: string
  theme: OverlayTheme
  pins: GuestPin[]
}

/* ---- The renderer's view ------------------------------------------------------------------------- */

/** One pin as the app's chrome shows it (the composer's context line, the batch bar). */
export interface CommentPinView {
  id: string
  n: number
  state: 'draft' | 'sent'
  selector: string
  component: string | null
  styleCount: number
  hasCrop: boolean
  hasHtml: boolean
  /** The saved comment text (a draft that was kept), or `''`. */
  comment: string
}

export interface CommentPaneState {
  paneId: string
  overlayActive: boolean
  pins: CommentPinView[]
  /** The pin the docked composer is open on, or `null`. */
  openPinId: string | null
}

export type CommentSubmitError =
  'BAD_ARGS' | 'PANE_NOT_FOUND' | 'BROWSER_DISCONNECTED' | 'NOTHING_TO_SEND' | 'DELIVERY_FAILED'

export type CommentSubmitResult =
  | { ok: true; delivered: true; count: number; sessionId: string; woke: boolean }
  | { ok: true; delivered: false; held: true; count: number; copied: boolean }
  | { ok: false; error: CommentSubmitError; detail?: string }

/** A CSS colour the app's theme can hold: `#rgb[a]`, `#rrggbb[aa]`, or `rgb[a](…)` of plain numbers. */
export function isSafeColor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 40 &&
    (/^#[0-9a-fA-F]{3,8}$/.test(value) || /^rgba?\(\s*[\d.\s,%/]+\)$/.test(value))
  )
}

/* ---- URL scrub (spec §8.3) ---------------------------------------------------------------------- */

/**
 * The page URL a pin carries: scheme, host and path only. The query string, the fragment and any userinfo are
 * dropped (they hold tokens as often as they hold state), and the result is capped.
 */
export function scrubUrl(raw: string): string {
  let out: string
  try {
    const u = new URL(raw)
    if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') {
      out = u.protocol === 'about:' ? raw.split(/[?#]/)[0]! : `${u.protocol}…`
    } else {
      out = `${u.protocol}//${u.host}${u.pathname}`
    }
  } catch {
    out = raw.split(/[?#]/)[0] ?? ''
  }
  return out.length > URL_MAX_CHARS ? `${out.slice(0, URL_MAX_CHARS)}…` : out
}

/** The origin a pin is tied to (spec §8.4: re-attached "within the origin"); `''` for an opaque one. */
export function originOf(raw: string): string {
  try {
    const u = new URL(raw)
    return u.origin === 'null' ? `${u.protocol}//${u.host}` : u.origin
  } catch {
    return ''
  }
}
