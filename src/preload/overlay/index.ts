/**
 * The guest half of point-and-comment (T564 U6, spec §8.1, §8.2, §8.6), booted by `browser-guest.ts` in every
 * origin class. It runs in the isolated world, so the page cannot reach any of it, and it:
 *
 *  - listens in the CAPTURE phase on `window`, registered at preload time so it runs before any page listener;
 *  - while picking, consumes the operator's TRUSTED pointer events (`isTrusted`; an event a page dispatches is
 *    ignored) so the page receives no picking click, and turns a click into a pick;
 *  - draws the outline, the hint pill and the numbered pins (`layers.ts`);
 *  - talks to main only over the private channels in `OVERLAY_CHANNEL`. Nothing the operator types ever
 *    reaches this code: the composer is app chrome.
 *
 * Environment-injected (`OverlayEnv`) so the whole controller is testable under jsdom.
 */
import {
  OVERLAY_CHANNEL,
  isSafeColor,
  type GuestPin,
  type OverlayGuestState,
  type OverlayRect,
  type PickedPayload
} from '../../shared/browser-comment'
import { computedStyles, discoverComponent, outerHtmlShallow, type MainWorld } from './capture'
import { createLayers, type PinPlacement } from './layers'
import { buildSelector, describeNode } from './selector'

export interface OverlayIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
}

export interface OverlayEnv {
  win: Window
  doc: Document
  ipc: OverlayIpc
  world: MainWorld
  /** Whether an event came from the user agent. Injected so tests can stand in for the OS. */
  isTrusted?: (e: Event) => boolean
  /** Resolves once the page has repainted without the overlay (two frames, with a timer fallback). */
  nextPaint?: () => Promise<void>
}

export interface OverlayHandle {
  destroy(): void
  /** Test hook. */
  snapshot(): { active: boolean; pins: number; hiddenForCapture: boolean }
}

/** Pointer events consumed while picking (and on our own pin layer at any time). */
const CONSUMED_POINTER = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'dragstart',
  'selectstart'
]
const CONSUMED_HOVER = [
  'pointermove',
  'mousemove',
  'pointerover',
  'pointerout',
  'mouseover',
  'mouseout'
]

/** The layers come back by themselves if main never answers a pick. */
const CAPTURE_HIDE_SAFETY_MS = 1500
const RECT_REPORT_DEBOUNCE_MS = 500
const RELAYOUT_DEBOUNCE_MS = 200

function sameRect(a: OverlayRect, b: OverlayRect): boolean {
  return (
    Math.abs(a.x - b.x) < 1 &&
    Math.abs(a.y - b.y) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1
  )
}

function defaultNextPaint(win: Window): () => Promise<void> {
  return () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 150)
      win.requestAnimationFrame(() =>
        win.requestAnimationFrame(() => {
          clearTimeout(timer)
          resolve()
        })
      )
    })
}

export function bootOverlay(env: OverlayEnv): OverlayHandle {
  const { win, doc, ipc } = env
  const trusted = env.isTrusted ?? ((e: Event) => e.isTrusted)
  const nextPaint = env.nextPaint ?? defaultNextPaint(win)
  const layers = createLayers(doc)

  let active = false
  let pins: GuestPin[] = []
  let picking = false
  let safety: ReturnType<typeof setTimeout> | null = null
  let lastPoint: { x: number; y: number } | null = null
  let hoverQueued = false
  const reported = new Map<string, OverlayRect>()
  let rectTimer: ReturnType<typeof setTimeout> | null = null
  let layoutTimer: ReturnType<typeof setTimeout> | null = null

  /* ---- Picking ---------------------------------------------------------------------------------- */

  function pickAt(x: number, y: number): Element | null {
    const stack = doc.elementsFromPoint?.(x, y) ?? []
    for (const el of stack) {
      if (layers.isHost(el)) continue
      return el
    }
    return null
  }

  function updateHover(): void {
    hoverQueued = false
    if (!active || !lastPoint || picking) return
    const el = pickAt(lastPoint.x, lastPoint.y)
    if (!el) {
      layers.setOutline(null)
      return
    }
    const r = el.getBoundingClientRect()
    layers.setOutline({
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
      label: describeNode(el, r)
    })
  }

  function queueHover(): void {
    if (hoverQueued) return
    hoverQueued = true
    win.requestAnimationFrame(updateHover)
  }

  function unhide(): void {
    if (safety) clearTimeout(safety)
    safety = null
    picking = false
    layers.setHidden(false)
  }

  async function pick(el: Element): Promise<void> {
    if (picking) return
    picking = true
    const rect = el.getBoundingClientRect()
    // The crop is taken by main AFTER this message: hide every layer first, so the outline and the pins do not
    // end up inside it. A state push from main (always sent after a pick) brings them back.
    layers.setOutline(null)
    layers.setHidden(true)
    safety = setTimeout(unhide, CAPTURE_HIDE_SAFETY_MS)
    const nonce = Math.random().toString(36).slice(2, 12)
    const [component] = await Promise.all([discoverComponent(el, env.world, nonce), nextPaint()])
    const payload: PickedPayload = {
      selector: buildSelector(el, doc),
      tag: el.tagName.toLowerCase(),
      outerHTML: outerHtmlShallow(el),
      component,
      styles: computedStyles(el, win),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      viewport: { width: win.innerWidth, height: win.innerHeight }
    }
    ipc.send(OVERLAY_CHANNEL.picked, payload)
  }

  /* ---- Pins ------------------------------------------------------------------------------------- */

  function safeQuery(selector: string): Element | null {
    try {
      return doc.querySelector(selector)
    } catch {
      return null
    }
  }

  function layoutPins(): void {
    if (pins.length === 0) {
      layers.setPins([])
      return
    }
    if (!layers.ensure()) return
    const placements: PinPlacement[] = []
    const now = new Map<string, OverlayRect>()
    for (const pin of pins) {
      const el = safeQuery(pin.selector)
      let rect: OverlayRect = pin.rect
      if (el) {
        const r = el.getBoundingClientRect()
        rect = { x: r.left, y: r.top, width: r.width, height: r.height }
        now.set(pin.id, rect)
      }
      const x = Math.min(Math.max(rect.x - 6, 0), Math.max(0, win.innerWidth - 22))
      const y = Math.min(Math.max(rect.y - 14, 0), Math.max(0, win.innerHeight - 22))
      placements.push({ id: pin.id, n: pin.n, state: pin.state, detached: el === null, x, y })
    }
    layers.setPins(placements)
    scheduleRectReport(now)
  }

  function scheduleRectReport(now: Map<string, OverlayRect>): void {
    const changed: Record<string, OverlayRect> = {}
    for (const [id, r] of now) {
      const before = reported.get(id)
      if (!before || !sameRect(before, r)) changed[id] = r
    }
    if (Object.keys(changed).length === 0) return
    if (rectTimer) clearTimeout(rectTimer)
    rectTimer = setTimeout(() => flushRects(changed), RECT_REPORT_DEBOUNCE_MS)
    pendingRects = { ...pendingRects, ...changed }
  }
  let pendingRects: Record<string, OverlayRect> = {}

  function flushRects(extra?: Record<string, OverlayRect>): void {
    if (rectTimer) clearTimeout(rectTimer)
    rectTimer = null
    const out = { ...pendingRects, ...(extra ?? {}) }
    pendingRects = {}
    if (Object.keys(out).length === 0) return
    for (const [id, r] of Object.entries(out)) reported.set(id, r)
    ipc.send(OVERLAY_CHANNEL.rects, out)
  }

  function queueLayout(): void {
    if (layoutTimer) return
    layoutTimer = setTimeout(() => {
      layoutTimer = null
      layoutPins()
    }, RELAYOUT_DEBOUNCE_MS)
  }

  /* ---- State from main -------------------------------------------------------------------------- */

  function applyState(raw: unknown): void {
    unhide()
    if (typeof raw !== 'object' || raw === null) return
    const st = raw as Partial<OverlayGuestState>
    const wasActive = active
    active = st.active === true
    pins = Array.isArray(st.pins) ? (st.pins as GuestPin[]) : []
    if (!layers.ensure() && (active || pins.length > 0)) {
      // The document element is not there yet; the next event or load retries.
      return
    }
    if (st.theme && isSafeColor(st.theme.accent) && isSafeColor(st.theme.accentInk)) {
      layers.setTheme({ accent: st.theme.accent, accentInk: st.theme.accentInk })
    }
    syncObserver()
    layers.setHint(active, typeof st.hint === 'string' ? st.hint : '')
    if (!active) layers.setOutline(null)
    else if (!wasActive) queueHover()
    layoutPins()
  }

  /* ---- Events ----------------------------------------------------------------------------------- */

  function consume(e: Event): void {
    e.stopImmediatePropagation()
    if (e.cancelable) e.preventDefault()
  }

  function onPointer(e: Event): void {
    if (!trusted(e)) return
    const onHost = layers.isHost(e.target)
    if (!active && !onHost) return
    consume(e)
    if (e.type !== 'click') return
    const m = e as MouseEvent
    if (m.button !== 0) return
    const pinId = layers.pinAt(m.clientX, m.clientY)
    if (pinId) {
      ipc.send(OVERLAY_CHANNEL.pinClicked, { id: pinId })
      return
    }
    if (!active) return
    const el = pickAt(m.clientX, m.clientY)
    if (el) void pick(el)
  }

  function onHover(e: Event): void {
    if (!active || !trusted(e)) return
    consume(e)
    if (e.type === 'mousemove' || e.type === 'pointermove') {
      const m = e as MouseEvent
      lastPoint = { x: m.clientX, y: m.clientY }
      queueHover()
    }
  }

  function onKey(e: Event): void {
    if (!active || !trusted(e)) return
    if ((e as KeyboardEvent).key !== 'Escape') return
    consume(e)
    if (e.type === 'keydown') {
      active = false
      layers.setHint(false, '')
      layers.setOutline(null)
      ipc.send(OVERLAY_CHANNEL.exit)
    }
  }

  const listenerOpts = { capture: true }
  for (const t of CONSUMED_POINTER) win.addEventListener(t, onPointer, listenerOpts)
  for (const t of CONSUMED_HOVER) win.addEventListener(t, onHover, listenerOpts)
  win.addEventListener('keydown', onKey, listenerOpts)
  win.addEventListener('keyup', onKey, listenerOpts)
  const onScrollOrResize = (): void => {
    if (pins.length > 0) win.requestAnimationFrame(layoutPins)
    if (active) queueHover()
  }
  win.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true })
  win.addEventListener('resize', onScrollOrResize, { passive: true })
  const onLoaded = (): void => {
    layoutPins()
  }
  doc.addEventListener('DOMContentLoaded', onLoaded)
  win.addEventListener('load', onLoaded)
  const onHide = (): void => flushRects()
  win.addEventListener('pagehide', onHide)

  // Re-attach pins when the page changes under them (an SPA route, a re-render), and put our host back if the
  // page replaced the document element's children. Observing is only worth its cost while there is something
  // to keep in place, so it follows `pins` / `active`.
  let observer: MutationObserver | null = null
  let observing = false
  function syncObserver(): void {
    const want = pins.length > 0 || active
    if (want === observing) return
    observing = want
    if (!want) {
      observer?.disconnect()
      return
    }
    try {
      observer ??= new (win as unknown as typeof globalThis).MutationObserver(() => {
        layers.ensure()
        queueLayout()
      })
      observer.observe(doc, { childList: true, subtree: true, attributes: true })
    } catch {
      observing = false
    }
  }

  ipc.on(OVERLAY_CHANNEL.state, (_event, raw) => applyState(raw))
  ipc.invoke(OVERLAY_CHANNEL.hello).then(applyState, () => undefined)

  return {
    destroy() {
      for (const t of CONSUMED_POINTER) win.removeEventListener(t, onPointer, listenerOpts)
      for (const t of CONSUMED_HOVER) win.removeEventListener(t, onHover, listenerOpts)
      win.removeEventListener('keydown', onKey, listenerOpts)
      win.removeEventListener('keyup', onKey, listenerOpts)
      win.removeEventListener('scroll', onScrollOrResize, { capture: true })
      win.removeEventListener('resize', onScrollOrResize)
      doc.removeEventListener('DOMContentLoaded', onLoaded)
      win.removeEventListener('load', onLoaded)
      win.removeEventListener('pagehide', onHide)
      observer?.disconnect()
      if (rectTimer) clearTimeout(rectTimer)
      if (layoutTimer) clearTimeout(layoutTimer)
      if (safety) clearTimeout(safety)
      layers.destroy()
    },
    snapshot: () => ({ active, pins: pins.length, hiddenForCapture: picking })
  }
}
