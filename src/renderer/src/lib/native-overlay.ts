/**
 * Native-overlay registration (T564 U1, spec §2.4, design.md "Frozen frame"). A browser pane is a native
 * `WebContentsView` drawn above every DOM layer, so any menu, dialog, popover, palette or toast that overlaps
 * it would render underneath. Main freezes the view while a registered layer intersects it; this module tells
 * main which layers exist.
 *
 * Two feeds, one list:
 *  1. **Body layers, automatically.** Every app layer that can overlap a pane is teleported to `<body>` (the 42
 *     `<Teleport to="body">` sites), so a watcher over `<body>`'s children covers all of them by construction,
 *     including ones added later. A forgotten registration would otherwise mean a menu hidden under the page.
 *  2. **In-app layers, explicitly.** A dropdown that lives inside `#app` (the Split menu, the pane's own ⋯
 *     menu) registers its element through {@link registerOverlayElement} / `useNativeOverlay`.
 *
 * The pure part ({@link collectOverlays}) is unit-tested; the DOM watcher is a thin adapter around it.
 */
import type { BrowserOverlayRect } from '../../../preload'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** A top-level body child as the collector sees it: its box, and its children's boxes for a zero-size wrapper. */
export interface OverlayCandidate {
  box: Box
  children: Box[]
}

/** A layer covering this share of the window (either axis pair) counts as fullscreen. */
const FULLSCREEN_RATIO = 0.95

function isEmpty(b: Box): boolean {
  return b.width < 1 || b.height < 1
}

function isFullscreen(b: Box, viewport: { width: number; height: number }): boolean {
  return (
    b.width >= viewport.width * FULLSCREEN_RATIO && b.height >= viewport.height * FULLSCREEN_RATIO
  )
}

function asOverlay(b: Box, viewport: { width: number; height: number }): BrowserOverlayRect {
  return isFullscreen(b, viewport)
    ? 'fullscreen'
    : { x: b.x, y: b.y, width: b.width, height: b.height }
}

/**
 * The overlay rectangles for a set of body-level candidates. A candidate with a real box is one layer; a
 * zero-size wrapper (a `fixed` container whose children are the real layers) contributes its children. Empty
 * boxes are dropped. A `fullscreen` layer makes the rest redundant, so it is returned alone.
 */
export function collectOverlays(
  candidates: readonly OverlayCandidate[],
  viewport: { width: number; height: number }
): BrowserOverlayRect[] {
  const out: BrowserOverlayRect[] = []
  for (const c of candidates) {
    const boxes = isEmpty(c.box) ? c.children : [c.box]
    for (const b of boxes) {
      if (!isEmpty(b)) out.push(asOverlay(b, viewport))
    }
  }
  return out.includes('fullscreen') ? ['fullscreen'] : out
}

/** Stable text of a list, to skip re-sending an unchanged one. */
export function overlaySignature(list: readonly BrowserOverlayRect[]): string {
  return JSON.stringify(list)
}

/* ---------------------------------------------------------------------------------------------- */
/* DOM adapter                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

const explicit = new Map<string, HTMLElement>()
let started = false
let lastSignature = ''
let frame = 0
let send: (overlays: BrowserOverlayRect[]) => void = () => undefined

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

function readCandidates(): OverlayCandidate[] {
  const out: OverlayCandidate[] = []
  for (const el of Array.from(document.body.children)) {
    if (el.id === 'app' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    out.push({ box: boxOf(el), children: Array.from(el.children).map(boxOf) })
  }
  for (const el of explicit.values()) {
    if (el.isConnected) out.push({ box: boxOf(el), children: [] })
  }
  return out
}

function flush(): void {
  frame = 0
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  const list = collectOverlays(readCandidates(), viewport)
  const sig = overlaySignature(list)
  if (sig === lastSignature) return
  lastSignature = sig
  send(list)
}

/** Recompute on the next animation frame (every mutation and resize funnels here). */
export function scheduleOverlayUpdate(): void {
  if (!started || frame !== 0) return
  frame = requestAnimationFrame(flush)
}

/**
 * Start watching `<body>`'s layers and sending the list through `emit`. Idempotent. Returns a stopper.
 */
export function startNativeOverlayWatcher(
  emit: (overlays: BrowserOverlayRect[]) => void
): () => void {
  if (started) return () => undefined
  started = true
  send = emit
  const observed = new WeakSet<Element>()
  const layerObserver = new MutationObserver(scheduleOverlayUpdate)
  const watchLayer = (el: Element): void => {
    if (observed.has(el) || el.id === 'app') return
    observed.add(el)
    layerObserver.observe(el, { childList: true, subtree: true, attributes: true })
  }
  const bodyObserver = new MutationObserver(() => {
    for (const el of Array.from(document.body.children)) watchLayer(el)
    scheduleOverlayUpdate()
  })
  bodyObserver.observe(document.body, { childList: true })
  for (const el of Array.from(document.body.children)) watchLayer(el)
  window.addEventListener('resize', scheduleOverlayUpdate)
  scheduleOverlayUpdate()
  return () => {
    started = false
    bodyObserver.disconnect()
    layerObserver.disconnect()
    window.removeEventListener('resize', scheduleOverlayUpdate)
    if (frame !== 0) cancelAnimationFrame(frame)
    frame = 0
    lastSignature = ''
    send = () => undefined
  }
}

/** Register an in-app layer (one that lives inside `#app`). Returns its unregister function. */
export function registerOverlayElement(id: string, el: HTMLElement): () => void {
  explicit.set(id, el)
  scheduleOverlayUpdate()
  return () => {
    explicit.delete(id)
    scheduleOverlayUpdate()
  }
}
