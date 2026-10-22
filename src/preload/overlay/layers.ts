/**
 * The guest-drawn layers (T564 U6, spec §8.2): hover outline with its tag, the hint pill, and the numbered
 * pins, inside ONE closed shadow root on a host appended to `document.documentElement`. The host is
 * `aria-hidden`, so the accessibility snapshot never lists it (A10), and the shadow root is closed, so the
 * page cannot reach in. The layers carry no text the operator typed: pins show a number only.
 *
 * Styles go in through a constructed stylesheet and CSSOM writes, which a page's `style-src` CSP does not
 * block (an inline `<style>` or a `style=""` attribute would be).
 */
import { DEFAULT_OVERLAY_THEME, type OverlayTheme } from '../../shared/browser-comment'
import { OVERLAY_CSS } from './styles'

export interface PinPlacement {
  id: string
  n: number
  state: 'draft' | 'sent'
  /** The selector no longer matches a node: drawn dashed at the last known rect. */
  detached: boolean
  x: number
  y: number
}

export interface Layers {
  /** Build the host if it is not there (or was removed by the page). Needs `document.documentElement`. */
  ensure(): boolean
  setTheme(theme: OverlayTheme): void
  setHint(active: boolean, text: string): void
  setOutline(
    box: { x: number; y: number; width: number; height: number; label: string } | null
  ): void
  setPins(pins: PinPlacement[]): void
  /** Hide every layer (so a capture of the node does not contain them). */
  setHidden(hidden: boolean): void
  /** The pin id under a viewport point, or `null`. */
  pinAt(x: number, y: number): string | null
  isHost(node: EventTarget | null): boolean
  destroy(): void
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function pointerGlyph(doc: Document): SVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = doc.createElementNS(SVG_NS, 'path')
  path.setAttribute(
    'd',
    'M9 9l5 12 1.8-5.2L21 14 9 9zM16.1 15.9 20 20M7.2 2.2 8 5.1M5.1 8 2.2 7.2M14 4.1 12 6M6 12l-1.9 2'
  )
  svg.appendChild(path)
  return svg
}

export function createLayers(doc: Document): Layers {
  let host: HTMLElement | null = null
  let root: ShadowRoot | null = null
  let outline: HTMLElement | null = null
  let outlineTag: HTMLElement | null = null
  let hint: HTMLElement | null = null
  let hintText: HTMLElement | null = null
  let pinLayer: HTMLElement | null = null
  const pinEls = new Map<string, HTMLElement>()
  let theme: OverlayTheme = DEFAULT_OVERLAY_THEME
  let hidden = false

  function applyTheme(): void {
    host?.style.setProperty('--accent', theme.accent)
    host?.style.setProperty('--accent-ink', theme.accentInk)
  }
  function applyHidden(): void {
    host?.style.setProperty('visibility', hidden ? 'hidden' : 'visible')
  }

  function build(): boolean {
    const parent = doc.documentElement
    if (!parent) return false
    host = doc.createElement('div')
    host.setAttribute('aria-hidden', 'true')
    host.setAttribute('data-harnu-overlay', '')
    for (const [k, v] of [
      ['all', 'initial'],
      ['position', 'fixed'],
      ['inset', '0'],
      ['z-index', '2147483647'],
      ['pointer-events', 'none'],
      ['contain', 'layout style']
    ] as const) {
      host.style.setProperty(k, v)
    }
    root = host.attachShadow({ mode: 'closed' })
    try {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(OVERLAY_CSS)
      root.adoptedStyleSheets = [sheet]
    } catch {
      const style = doc.createElement('style')
      style.textContent = OVERLAY_CSS
      root.appendChild(style)
    }
    const layer = doc.createElement('div')
    layer.className = 'layer'
    outline = doc.createElement('div')
    outline.className = 'hl'
    outlineTag = doc.createElement('span')
    outlineTag.className = 'hl-tag'
    outline.appendChild(outlineTag)
    hint = doc.createElement('div')
    hint.className = 'hint'
    hint.appendChild(pointerGlyph(doc))
    hintText = doc.createElement('span')
    hint.appendChild(hintText)
    const kbd = doc.createElement('span')
    kbd.className = 'kbd'
    kbd.textContent = 'Esc'
    hint.appendChild(kbd)
    pinLayer = doc.createElement('div')
    layer.append(outline, pinLayer, hint)
    root.appendChild(layer)
    parent.appendChild(host)
    pinEls.clear()
    applyTheme()
    applyHidden()
    return true
  }

  return {
    ensure() {
      if (host && host.isConnected) return true
      if (host) {
        // The page dropped our host (it rewrote the document element): put the same one back.
        const parent = doc.documentElement
        if (!parent) return false
        parent.appendChild(host)
        return true
      }
      return build()
    },
    setTheme(next) {
      theme = next
      applyTheme()
    },
    setHint(active, text) {
      if (!hint || !hintText) return
      hint.classList.toggle('on', active)
      hintText.textContent = text
    },
    setOutline(box) {
      if (!outline || !outlineTag) return
      if (!box) {
        outline.style.setProperty('display', 'none')
        return
      }
      outline.style.setProperty('display', 'block')
      outline.style.setProperty('left', `${box.x}px`)
      outline.style.setProperty('top', `${box.y}px`)
      outline.style.setProperty('width', `${box.width}px`)
      outline.style.setProperty('height', `${box.height}px`)
      outlineTag.textContent = box.label
      // No room under the box: the tag flips above it.
      const vh = doc.defaultView?.innerHeight ?? 0
      outline.classList.toggle('flip', vh > 0 && box.y + box.height + 28 > vh)
    },
    setPins(pins) {
      if (!pinLayer) return
      const seen = new Set<string>()
      for (const p of pins) {
        seen.add(p.id)
        let el = pinEls.get(p.id)
        if (!el) {
          el = doc.createElement('button')
          el.setAttribute('type', 'button')
          el.setAttribute('data-pin', p.id)
          pinLayer.appendChild(el)
          pinEls.set(p.id, el)
        }
        el.className = `pin ${p.state}${p.detached ? ' detached' : ''}`
        if (el.textContent !== String(p.n)) el.textContent = String(p.n)
        el.style.setProperty('transform', `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`)
      }
      for (const [id, el] of pinEls) {
        if (!seen.has(id)) {
          el.remove()
          pinEls.delete(id)
        }
      }
    },
    setHidden(next) {
      hidden = next
      applyHidden()
    },
    pinAt(x, y) {
      if (!root) return null
      const el = root.elementFromPoint?.(x, y) ?? null
      const pin = el?.closest?.('[data-pin]')
      return pin?.getAttribute('data-pin') ?? null
    },
    isHost: (node) => host !== null && node === host,
    destroy() {
      host?.remove()
      host = root = outline = outlineTag = hint = hintText = pinLayer = null
      pinEls.clear()
    }
  }
}
