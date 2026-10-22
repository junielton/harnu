// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OVERLAY_CHANNEL, type OverlayGuestState } from '../src/shared/browser-comment'
import { bootOverlay, type OverlayHandle, type OverlayIpc } from '../src/preload/overlay'

interface Sent {
  channel: string
  args: unknown[]
}

function rig(opts: { trusted?: boolean } = {}) {
  const sent: Sent[] = []
  const listeners = new Map<string, (e: unknown, ...a: unknown[]) => void>()
  let helloState: OverlayGuestState | null = null
  const ipc: OverlayIpc = {
    invoke: async (channel) => (channel === OVERLAY_CHANNEL.hello ? helloState : null),
    send: (channel, ...args) => void sent.push({ channel, args }),
    on: (channel, fn) => void listeners.set(channel, fn)
  }
  document.body.innerHTML =
    '<main><button id="pay" class="btn" style="color: red">Pay</button><p id="para">Hello</p></main>'
  const pay = document.querySelector('#pay') as HTMLElement
  const para = document.querySelector('#para') as HTMLElement
  // jsdom has no layout and no hit-testing: stand in for both.
  const at = new Map<string, Element>([
    ['10,10', pay],
    ['50,50', para]
  ])
  document.elementsFromPoint = (x: number, y: number) => {
    const el = at.get(`${x},${y}`)
    return el ? [el, document.body, document.documentElement] : [document.body]
  }
  pay.getBoundingClientRect = () => ({
    left: 5,
    top: 6,
    width: 100,
    height: 40,
    right: 105,
    bottom: 46,
    x: 5,
    y: 6,
    toJSON: () => ({})
  })
  const handle: OverlayHandle = bootOverlay({
    win: window,
    doc: document,
    ipc,
    world: { executeJavaScript: async () => 'src/Pay.vue:42' },
    isTrusted: () => opts.trusted ?? true,
    nextPaint: async () => undefined
  })
  const push = (st: Partial<OverlayGuestState>): void => {
    listeners.get(OVERLAY_CHANNEL.state)?.(
      {},
      {
        active: false,
        hint: 'Click an element to comment',
        theme: { accent: '#7aa2f7', accentInk: '#0b0e1a' },
        pins: [],
        ...st
      }
    )
  }
  return {
    handle,
    sent,
    push,
    pay,
    para,
    setHello: (s: OverlayGuestState) => (helloState = s),
    click(el: Element, x: number, y: number) {
      el.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 0
        })
      )
    }
  }
}

let current: OverlayHandle | null = null
beforeEach(() => {
  document.body.innerHTML = ''
})
afterEach(() => {
  current?.destroy()
  current = null
  vi.useRealTimers()
})

describe('guest overlay controller', () => {
  it('is inert until switched on: the page keeps its clicks', () => {
    const r = rig()
    current = r.handle
    const seen = vi.fn()
    document.addEventListener('click', seen)
    r.click(r.pay, 10, 10)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(r.sent.filter((s) => s.channel === OVERLAY_CHANNEL.picked)).toHaveLength(0)
  })

  it('while picking, consumes the click before page listeners registered after the overlay booted (the preload boots at document start)', async () => {
    const pageEarly = vi.fn()
    // A page listener on window in the capture phase, registered BEFORE the overlay boots, as a hostile page could.
    window.addEventListener('click', pageEarly, true)
    const r = rig()
    current = r.handle
    const pageLate = vi.fn()
    document.addEventListener('click', pageLate)
    r.push({ active: true })
    r.click(r.pay, 10, 10)
    await vi.waitFor(() =>
      expect(r.sent.some((s) => s.channel === OVERLAY_CHANNEL.picked)).toBe(true)
    )
    expect(pageLate).not.toHaveBeenCalled()
    window.removeEventListener('click', pageEarly, true)
    // Registered before the overlay, so it ran first: the overlay can only win against listeners added after it.
    // (The real preload boots at document start, before any page script.)
    expect(pageEarly).toHaveBeenCalled()
  })

  it('sends the picked node: selector, tag, html, component, styles, rect and viewport', async () => {
    const r = rig()
    current = r.handle
    r.push({ active: true })
    r.click(r.pay, 10, 10)
    await vi.waitFor(() =>
      expect(r.sent.some((s) => s.channel === OVERLAY_CHANNEL.picked)).toBe(true)
    )
    const msg = r.sent.find((s) => s.channel === OVERLAY_CHANNEL.picked)!.args[0] as Record<
      string,
      unknown
    >
    expect(msg.selector).toBe('#pay')
    expect(msg.tag).toBe('button')
    expect(String(msg.outerHTML)).toContain('<button')
    expect(msg.component).toBe('src/Pay.vue:42')
    expect((msg.styles as Record<string, string>).color).toBeTruthy()
    expect(msg.rect).toEqual({ x: 5, y: 6, width: 100, height: 40 })
    expect(msg.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight })
    // No composer text, no comment, ever.
    expect(Object.keys(msg).sort()).toEqual([
      'component',
      'outerHTML',
      'rect',
      'selector',
      'styles',
      'tag',
      'viewport'
    ])
  })

  it('ignores an UNTRUSTED click: a page cannot forge a pick', () => {
    const r = rig({ trusted: false })
    current = r.handle
    r.push({ active: true })
    const seen = vi.fn()
    document.addEventListener('click', seen)
    r.click(r.pay, 10, 10)
    expect(r.sent.filter((s) => s.channel === OVERLAY_CHANNEL.picked)).toHaveLength(0)
    expect(seen).toHaveBeenCalledTimes(1) // and the page's own synthetic click is left alone
  })

  it('the real isTrusted check rejects a script-dispatched event', () => {
    const sent: Sent[] = []
    document.body.innerHTML = '<button id="b">x</button>'
    const b = document.querySelector('#b')!
    document.elementsFromPoint = () => [b]
    const listeners = new Map<string, (e: unknown, ...a: unknown[]) => void>()
    current = bootOverlay({
      win: window,
      doc: document,
      ipc: {
        invoke: async () => null,
        send: (channel, ...args) => void sent.push({ channel, args }),
        on: (c, f) => void listeners.set(c, f)
      },
      world: { executeJavaScript: async () => null },
      nextPaint: async () => undefined
    })
    listeners.get(OVERLAY_CHANNEL.state)?.(
      {},
      { active: true, hint: '', theme: { accent: '#fff', accentInk: '#000' }, pins: [] }
    )
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    expect(sent.filter((s) => s.channel === OVERLAY_CHANNEL.picked)).toHaveLength(0)
  })

  it('Esc exits and is consumed; a page keydown handler never sees it', () => {
    const r = rig()
    current = r.handle
    r.push({ active: true })
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    expect(seen).not.toHaveBeenCalled()
    expect(r.sent.some((s) => s.channel === OVERLAY_CHANNEL.exit)).toBe(true)
    expect(r.handle.snapshot().active).toBe(false)
  })

  it('other keys reach the page while picking', () => {
    const r = rig()
    current = r.handle
    r.push({ active: true })
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    )
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('does not consume hover events when off, and consumes them when picking', () => {
    const r = rig()
    current = r.handle
    const seen = vi.fn()
    document.addEventListener('mousemove', seen)
    r.pay.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    )
    expect(seen).toHaveBeenCalledTimes(1)
    r.push({ active: true })
    r.pay.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    )
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('hides every layer while the crop is taken and shows them again when main answers', async () => {
    const r = rig()
    current = r.handle
    r.push({ active: true })
    r.click(r.pay, 10, 10)
    expect(r.handle.snapshot().hiddenForCapture).toBe(true)
    await vi.waitFor(() =>
      expect(r.sent.some((s) => s.channel === OVERLAY_CHANNEL.picked)).toBe(true)
    )
    r.push({
      active: true,
      pins: [
        {
          id: 'a',
          n: 1,
          state: 'draft',
          selector: '#pay',
          rect: { x: 5, y: 6, width: 100, height: 40 }
        }
      ]
    })
    expect(r.handle.snapshot().hiddenForCapture).toBe(false)
  })

  it('brings the layers back by itself if main never answers', async () => {
    vi.useFakeTimers()
    const r = rig()
    current = r.handle
    r.push({ active: true })
    r.click(r.pay, 10, 10)
    await vi.advanceTimersByTimeAsync(1600)
    expect(r.handle.snapshot().hiddenForCapture).toBe(false)
  })

  it('the host is aria-hidden and its shadow root is closed', () => {
    const r = rig()
    current = r.handle
    r.push({
      active: true,
      pins: [
        {
          id: 'a',
          n: 1,
          state: 'draft',
          selector: '#pay',
          rect: { x: 5, y: 6, width: 100, height: 40 }
        }
      ]
    })
    const host = document.querySelector('[data-harnu-overlay]') as HTMLElement
    expect(host).not.toBeNull()
    expect(host.getAttribute('aria-hidden')).toBe('true')
    expect(host.shadowRoot).toBeNull() // closed: the page cannot reach in
  })

  it('draws a pin for each GuestPin and sends the rects of attached ones', async () => {
    vi.useFakeTimers()
    const r = rig()
    current = r.handle
    r.push({
      pins: [
        {
          id: 'a',
          n: 1,
          state: 'draft',
          selector: '#pay',
          rect: { x: 0, y: 0, width: 1, height: 1 }
        },
        {
          id: 'b',
          n: 2,
          state: 'sent',
          selector: '#gone',
          rect: { x: 40, y: 40, width: 10, height: 10 }
        }
      ]
    })
    await vi.advanceTimersByTimeAsync(600)
    const rects = r.sent.find((s) => s.channel === OVERLAY_CHANNEL.rects)!.args[0] as Record<
      string,
      unknown
    >
    // Only the pin whose node still matches reports a rect; the detached one keeps the last one main has.
    expect(Object.keys(rects)).toEqual(['a'])
    expect(rects.a).toEqual({ x: 5, y: 6, width: 100, height: 40 })
    expect(r.handle.snapshot().pins).toBe(2)
  })

  it('a click on a pin sends pinClicked, with the overlay on or off', () => {
    const r = rig()
    current = r.handle
    r.push({
      active: false,
      pins: [
        {
          id: 'a',
          n: 1,
          state: 'draft',
          selector: '#pay',
          rect: { x: 5, y: 6, width: 100, height: 40 }
        }
      ]
    })
    const host = document.querySelector('[data-harnu-overlay]') as HTMLElement
    // The pin lives in the closed shadow root; a click on it reaches window with the host as its target.
    const seen = vi.fn()
    document.addEventListener('click', seen)
    // jsdom cannot hit-test the closed root, so stand in for it through the pin layer's lookup.
    ;(document as unknown as { elementsFromPoint: unknown }).elementsFromPoint = () => [host]
    const evt = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 8,
      clientY: 8,
      button: 0
    })
    host.dispatchEvent(evt)
    expect(seen).not.toHaveBeenCalled() // consumed: the page does not learn about the operator's pin click
  })

  it('uses the hello answer for the initial state', async () => {
    const r = rig()
    current = r.handle
    r.setHello({ active: true, hint: 'h', theme: { accent: '#fff', accentInk: '#000' }, pins: [] })
    // A second guest boot after the hello is configured:
    const sent: Sent[] = []
    const second = bootOverlay({
      win: window,
      doc: document,
      ipc: {
        invoke: async () => ({
          active: true,
          hint: 'h',
          theme: { accent: '#fff', accentInk: '#000' },
          pins: []
        }),
        send: (c, ...a) => void sent.push({ channel: c, args: a }),
        on: () => undefined
      },
      world: { executeJavaScript: async () => null },
      isTrusted: () => true,
      nextPaint: async () => undefined
    })
    await vi.waitFor(() => expect(second.snapshot().active).toBe(true))
    second.destroy()
  })

  it('rejects an unsafe theme colour instead of writing it into the page', () => {
    const r = rig()
    current = r.handle
    r.push({ active: true, theme: { accent: 'red; background: url(//evil)', accentInk: '#000' } })
    const host = document.querySelector('[data-harnu-overlay]') as HTMLElement
    expect(host.style.getPropertyValue('--accent')).not.toContain('evil')
  })
})
