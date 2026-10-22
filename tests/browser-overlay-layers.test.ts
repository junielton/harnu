// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OVERLAY_CHANNEL, type OverlayGuestState } from '../src/shared/browser-comment'
import { createLayers } from '../src/preload/overlay/layers'
import { bootOverlay, type OverlayHandle } from '../src/preload/overlay'

/** The overlay's shadow root is closed on purpose; a test opens it by wrapping `attachShadow`. */
function openRoots(): { roots: ShadowRoot[]; restore: () => void } {
  const roots: ShadowRoot[] = []
  const original = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (init: ShadowRootInit): ShadowRoot {
    const root = original.call(this, { ...init, mode: 'open' })
    roots.push(root)
    return root
  }
  return { roots, restore: () => (Element.prototype.attachShadow = original) }
}

let restore: (() => void) | null = null
let handle: OverlayHandle | null = null
beforeEach(() => {
  document.body.innerHTML = ''
})
afterEach(() => {
  handle?.destroy()
  handle = null
  restore?.()
  restore = null
  vi.useRealTimers()
})

describe('overlay layers: hardening against page CSS', () => {
  it('pins every host style inline with !important so page CSS cannot hide or move the overlay', () => {
    const layers = createLayers(document)
    expect(layers.ensure()).toBe(true)
    const host = document.querySelector('[data-harnu-overlay]') as HTMLElement
    for (const prop of [
      'display',
      'position',
      'transform',
      'visibility',
      'opacity',
      'z-index',
      'pointer-events'
    ]) {
      expect(host.style.getPropertyValue(prop), prop).not.toBe('')
      expect(host.style.getPropertyPriority(prop), prop).toBe('important')
    }
    expect(host.style.getPropertyValue('display')).toBe('block')
    expect(host.style.getPropertyValue('pointer-events')).toBe('none')
    layers.setHidden(true)
    expect(host.style.getPropertyValue('visibility')).toBe('hidden')
    expect(host.style.getPropertyPriority('visibility')).toBe('important')
    layers.destroy()
  })

  it('pins are not focusable (tabindex -1) and the hint carries the Esc key cap and the exit words', () => {
    const o = openRoots()
    restore = o.restore
    const layers = createLayers(document)
    layers.ensure()
    layers.setHint(true, 'Click an element to comment', 'to exit')
    layers.setPins([{ id: 'a', n: 1, state: 'draft', detached: false, x: 5, y: 6 }])
    const root = o.roots[0]!
    expect(root.querySelector('.pin')?.getAttribute('tabindex')).toBe('-1')
    const hint = root.querySelector('.hint') as HTMLElement
    expect(hint.textContent).toBe('Click an element to commentEscto exit')
    expect(hint.querySelector('.kbd')?.textContent).toBe('Esc')
    layers.destroy()
  })
})

describe('overlay controller: touch and pin placement', () => {
  function boot(trusted = true) {
    const o = openRoots()
    restore = o.restore
    const listeners = new Map<string, (e: unknown, ...a: unknown[]) => void>()
    document.body.innerHTML = '<button id="b">x</button>'
    const b = document.querySelector('#b') as HTMLElement
    b.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 80,
        width: 200,
        height: 40,
        right: 300,
        bottom: 120,
        x: 100,
        y: 80,
        toJSON: () => ({})
      }) as DOMRect
    handle = bootOverlay({
      win: window,
      doc: document,
      ipc: {
        invoke: async () => null,
        send: () => undefined,
        on: (c, f) => void listeners.set(c, f)
      },
      world: { executeJavaScript: async () => null },
      isTrusted: () => trusted,
      nextPaint: async () => undefined
    })
    const push = (st: Partial<OverlayGuestState>): void =>
      listeners.get(OVERLAY_CHANNEL.state)?.(
        {},
        {
          active: false,
          hint: 'h',
          exitHint: 'to exit',
          theme: { accent: '#7aa2f7', accentInk: '#0b0e1a' },
          pins: [],
          ...st
        }
      )
    return { o, push, b }
  }

  it('places a pin at the node top-right corner: 4 px in from the right edge, 14 px above the top', () => {
    const { o, push } = boot()
    push({
      pins: [
        { id: 'a', n: 1, state: 'draft', selector: '#b', rect: { x: 0, y: 0, width: 1, height: 1 } }
      ]
    })
    const pin = o.roots[0]!.querySelector('.pin') as HTMLElement
    expect(pin.style.transform).toBe('translate(296px, 66px)')
  })

  it('consumes trusted touch events while picking, but not when off or untrusted', () => {
    const { push, b } = boot()
    const seen = vi.fn()
    document.addEventListener('touchstart', seen)
    const touch = (): void =>
      void b.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }))
    touch()
    expect(seen).toHaveBeenCalledTimes(1) // off: the page keeps its touches
    push({ active: true })
    touch()
    expect(seen).toHaveBeenCalledTimes(1) // picking: consumed
    handle?.destroy()
    handle = null
    restore?.()
    const forged = boot(false)
    forged.push({ active: true })
    const seen2 = vi.fn()
    document.addEventListener('touchend', seen2)
    forged.b.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }))
    expect(seen2).toHaveBeenCalledTimes(1) // untrusted: ignored by the overlay
  })
})
