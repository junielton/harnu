// @vitest-environment jsdom
/**
 * T568 delta 3 — a registered in-app layer is observed: a popover that grows after it opens re-reports its
 * rect, and the rect is read again when its entry animation ends (the first read is mid `anim-fade-in-scale`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let resizeCallbacks: Array<() => void> = []
class FakeResizeObserver {
  constructor(cb: () => void) {
    resizeCallbacks.push(cb)
  }
  observe(): void {
    /* the test drives the callbacks itself */
  }
  disconnect(): void {
    /* nothing to release */
  }
}

beforeEach(() => {
  resizeCallbacks = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.useFakeTimers()
  // A frame arrives asynchronously, like the real one (a synchronous stub would run before the id is stored).
  vi.stubGlobal(
    'requestAnimationFrame',
    (cb: () => void) => setTimeout(cb, 16) as unknown as number
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
  document.body.innerHTML = ''
})

describe('registerOverlayElement', () => {
  it('re-reads the rect on animationend, on transitionend and when the element is resized', async () => {
    const { registerOverlayElement, startNativeOverlayWatcher } =
      await import('../src/renderer/src/lib/native-overlay')
    const sent: unknown[][] = []
    const stop = startNativeOverlayWatcher((o) => sent.push(o as unknown[]))
    const el = document.createElement('div')
    document.body.append(el)
    let width = 100 // the first read is mid-animation: ~3% small
    el.getBoundingClientRect = () => ({
      x: 10,
      y: 10,
      width,
      height: 50,
      top: 10,
      left: 10,
      right: 10 + width,
      bottom: 60,
      toJSON: () => ({})
    })
    const unregister = registerOverlayElement('pop', el)
    vi.runAllTimers()
    const widths = (): number[] =>
      sent.flatMap((l) =>
        l.filter((o) => typeof o === 'object').map((o) => (o as { width: number }).width)
      )
    expect(widths().at(-1)).toBe(100)

    width = 103 // the animation ended: the settled size
    el.dispatchEvent(new Event('animationend'))
    vi.runAllTimers()
    expect(widths().at(-1)).toBe(103)

    width = 140 // the popover grew (rows loaded)
    resizeCallbacks.forEach((cb) => cb())
    vi.runAllTimers()
    expect(widths().at(-1)).toBe(140)

    width = 150
    el.dispatchEvent(new Event('transitionend'))
    vi.runAllTimers()
    expect(widths().at(-1)).toBe(150)

    unregister()
    stop()
  })

  it('stops observing once unregistered', async () => {
    const { registerOverlayElement, startNativeOverlayWatcher } =
      await import('../src/renderer/src/lib/native-overlay')
    const sent: unknown[][] = []
    const stop = startNativeOverlayWatcher((o) => sent.push(o as unknown[]))
    const el = document.createElement('div')
    document.body.append(el)
    el.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 80,
      height: 40,
      top: 0,
      left: 0,
      right: 80,
      bottom: 40,
      toJSON: () => ({})
    })
    const unregister = registerOverlayElement('pop', el)
    unregister()
    vi.runAllTimers()
    sent.length = 0
    el.dispatchEvent(new Event('animationend'))
    vi.runAllTimers()
    expect(sent).toEqual([])
    stop()
  })
})
