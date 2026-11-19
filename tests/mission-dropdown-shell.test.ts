// @vitest-environment jsdom
/**
 * Mission dropdown · S-1 · AC-1, AC-2, AC-3 — the shell: a teleported, non-modal `role="dialog"` layer
 * anchored under the Topbar pill, with one scroller and a pinned footer slot, opened by the existing
 * `ui.popovers.missionProgress` flag (design.md §6 "Mission dropdown" → "Anchoring, size, scroll" and
 * "Keyboard and focus").
 *
 * jsdom has no layout engine, so the contract is read off the element: the Tailwind classes that carry
 * the width and the height (jsdom drops `min()` from inline style), the inline `top` / `left` the pure
 * placement function returns, the `.scrollable` class and where the footer sits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionDropdown from '../src/renderer/src/components/MissionDropdown.vue'
import {
  DROPDOWN_EDGE,
  DROPDOWN_GAP,
  DROPDOWN_MAX_WIDTH,
  DROPDOWN_SHORT_WINDOW,
  DROPDOWN_TOP,
  TOPBAR_HEIGHT,
  placeMissionDropdown
} from '../src/renderer/src/lib/mission-dropdown-position'
import { useUiStore } from '../src/renderer/src/stores/ui'

let wrapper: VueWrapper | null = null
let extra: HTMLElement[] = []

/** What the slots hold in these tests: two buttons in the body and one in the footer. */
const bodySlot = (): ReturnType<typeof h> =>
  h('div', [
    h('button', { 'data-test': 'body-first' }, 'first'),
    h('button', { 'data-test': 'body-last' }, 'last')
  ])
const footerSlot = (): ReturnType<typeof h> =>
  h('button', { 'data-test': 'footer-button' }, 'Close mission…')

function mountDropdown(props: Record<string, unknown> = {}): VueWrapper {
  wrapper = mount(MissionDropdown, {
    props,
    slots: { default: bodySlot, footer: footerSlot },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  return wrapper
}

const dialog = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-test="mission-dropdown"]')
const body = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-test="mission-dropdown-body"]')
const footer = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-test="mission-dropdown-footer"]')

/** A pill-like anchor in the page, so the dropdown has something to hang off and return focus to. */
function addPill(): HTMLButtonElement {
  const pill = document.createElement('button')
  pill.setAttribute('data-dsqa', 'topbar-pill--accent')
  document.body.appendChild(pill)
  extra.push(pill)
  return pill
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  window.dispatchEvent(new Event('resize'))
}

async function open(ui = useUiStore()): Promise<void> {
  ui.setPopoverAnchor('missionProgress', true)
  ui.openPopover('missionProgress')
  await nextTick()
  await nextTick()
}

beforeEach(() => {
  setActivePinia(createPinia())
  setViewport(1280, 800)
  // jsdom reports no client rects, which the focus trap reads as "hidden".
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    { x: 0, y: 0, width: 10, height: 10 }
  ] as unknown as DOMRectList)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  for (const el of extra) el.remove()
  extra = []
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('placeMissionDropdown (the pure placement)', () => {
  it('sits 6px under the Topbar: top 48 under the 42px bar', () => {
    expect(TOPBAR_HEIGHT).toBe(42)
    expect(DROPDOWN_GAP).toBe(6)
    expect(DROPDOWN_TOP).toBe(48)
    expect(
      placeMissionDropdown({
        anchor: { left: 300, right: 380 },
        viewport: { width: 1280, height: 800 }
      }).top
    ).toBe(48)
  })

  it('puts its left edge on the pill’s left edge', () => {
    const p = placeMissionDropdown({
      anchor: { left: 300, right: 380 },
      viewport: { width: 1280, height: 800 }
    })
    expect(p.left).toBe(300)
    expect(p.width).toBe(DROPDOWN_MAX_WIDTH)
  })

  it('flips to the pill’s right edge when the pill is near the right of the window', () => {
    const p = placeMissionDropdown({
      anchor: { left: 1100, right: 1180 },
      viewport: { width: 1280, height: 800 }
    })
    expect(p.left + p.width).toBe(1180)
  })

  it('clamps 8px from each viewport edge', () => {
    expect(DROPDOWN_EDGE).toBe(8)
    const left = placeMissionDropdown({
      anchor: { left: -40, right: 20 },
      viewport: { width: 1280, height: 800 }
    })
    expect(left.left).toBe(8)
    const right = placeMissionDropdown({
      anchor: { left: 1270, right: 1280 },
      viewport: { width: 1280, height: 800 }
    })
    expect(right.left + right.width).toBeLessThanOrEqual(1280 - 8)
  })

  it('is min(420, viewport - 16) wide, with no minimum, and its height is min(640, viewport - 56)', () => {
    const narrow = placeMissionDropdown({
      anchor: { left: 40, right: 100 },
      viewport: { width: 360, height: 640 }
    })
    expect(narrow.width).toBe(344)
    expect(narrow.left).toBe(8)
    const tiny = placeMissionDropdown({
      anchor: { left: 0, right: 10 },
      viewport: { width: 200, height: 300 }
    })
    expect(tiny.width).toBe(184)
    expect(
      placeMissionDropdown({ anchor: null, viewport: { width: 1280, height: 800 } }).maxHeight
    ).toBe(640)
    expect(
      placeMissionDropdown({ anchor: null, viewport: { width: 1280, height: 500 } }).maxHeight
    ).toBe(444)
  })

  it('falls back to the left margin when there is no anchor', () => {
    expect(
      placeMissionDropdown({ anchor: null, viewport: { width: 1280, height: 800 } }).left
    ).toBe(8)
  })
})

describe('MissionDropdown shell', () => {
  it('draws nothing while the flag is closed', async () => {
    mountDropdown()
    await nextTick()
    expect(dialog()).toBeNull()
  })

  it('anchors, sizes and scrolls', async () => {
    const pill = addPill()
    pill.getBoundingClientRect = (): DOMRect =>
      ({ left: 300, right: 380, top: 12, bottom: 30, width: 80, height: 18 }) as DOMRect
    const w = mountDropdown()
    await open()

    // A role="dialog" layer teleported to <body>: not inside the mounted wrapper (the Topbar's drag region).
    const el = dialog()
    expect(el).not.toBeNull()
    expect(el!.getAttribute('role')).toBe('dialog')
    expect(el!.getAttribute('aria-modal')).not.toBe('true')
    expect(w.element.contains(el)).toBe(false)
    expect(el!.parentElement).toBe(document.body)
    expect(el!.className).toContain('[-webkit-app-region:no-drag]')

    // position: fixed on --z-dialog, 6px under the 42px Topbar, left edge on the pill's.
    expect(el!.className).toMatch(/\bfixed\b/)
    expect(el!.className).toContain('z-(--z-dialog)')
    expect(el!.style.top).toBe('48px')
    expect(el!.style.left).toBe('300px')

    // The width and the height are the spec's two min() expressions.
    expect(el!.className).toContain('w-[min(420px,calc(100vw-16px))]')
    expect(el!.className).toContain('max-h-[min(640px,calc(100vh-56px))]')
    expect(el!.className).toMatch(/\bflex-col\b/)

    // The body is the one scroller, with the app's scrollbar; the footer is pinned under it.
    const b = body()!
    expect(b.className).toMatch(/\boverflow-y-auto\b/)
    expect(b.className).toMatch(/\bscrollable\b/)
    expect(b.className.split(' ')).toContain('@container')
    const f = footer()!
    expect(f).not.toBeNull()
    expect(b.contains(f)).toBe(false)
    expect(el!.contains(f)).toBe(true)
    expect(f.className).toMatch(/\bshrink-0\b/)
    // Nothing but the body scrolls.
    expect(el!.querySelectorAll('[class*="overflow-y-auto"]').length).toBe(1)
  })

  it('flips to the pill’s right edge near the right of the window, and clamps in a narrow one', async () => {
    const pill = addPill()
    pill.getBoundingClientRect = (): DOMRect =>
      ({ left: 1100, right: 1180, top: 12, bottom: 30, width: 80, height: 18 }) as DOMRect
    mountDropdown()
    await open()
    expect(dialog()!.style.left).toBe(`${1180 - 420}px`)

    wrapper!.unmount()
    wrapper = null
    useUiStore().closePopover('missionProgress')
    setViewport(360, 640)
    pill.getBoundingClientRect = (): DOMRect =>
      ({ left: 200, right: 300, top: 12, bottom: 30, width: 100, height: 18 }) as DOMRect
    mountDropdown()
    await open()
    expect(dialog()!.style.left).toBe('8px')
  })

  it('takes an anchor from its prop over the pill in the page', async () => {
    mountDropdown({ anchorRect: { left: 64, right: 120 } })
    await open()
    expect(dialog()!.style.left).toBe('64px')
  })

  it('under 420px of window height the footer scrolls with the body', async () => {
    mountDropdown({ anchorRect: { left: 64, right: 120 } })
    await open()
    expect(DROPDOWN_SHORT_WINDOW).toBe(420)
    expect(body()!.contains(footer())).toBe(false)

    setViewport(1280, 419)
    await nextTick()
    expect(body()!.contains(footer())).toBe(true)

    setViewport(1280, 420)
    await nextTick()
    expect(body()!.contains(footer())).toBe(false)
  })

  it('opens from the popover flag and closes three ways', async () => {
    const ui = useUiStore()
    const pill = addPill()
    mountDropdown()

    // 1 · Esc, and Esc returns focus to the pill.
    pill.focus()
    await open(ui)
    expect(dialog()).not.toBeNull()
    expect(ui.popovers.missionProgress).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(ui.popovers.missionProgress).toBe(false)
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(pill)

    // 2 · A click outside it.
    await open(ui)
    expect(dialog()).not.toBeNull()
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    extra.push(outside)
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(ui.popovers.missionProgress).toBe(false)
    expect(dialog()).toBeNull()

    // A click inside it does not close it, and neither does one that lands on a dialog (a confirm on top).
    await open(ui)
    dialog()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(ui.popovers.missionProgress).toBe(true)
    const other = document.createElement('div')
    other.setAttribute('role', 'dialog')
    const inner = document.createElement('button')
    other.appendChild(inner)
    document.body.appendChild(other)
    extra.push(other)
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(ui.popovers.missionProgress).toBe(true)
    expect(dialog()).not.toBeNull()

    // 3 · The pill again: the pill and the chord flip the same flag, and the layer follows it.
    ui.togglePopover('missionProgress')
    await nextTick()
    expect(ui.popovers.missionProgress).toBe(false)
    expect(dialog()).toBeNull()

    // The App's Esc binding and `anyPopoverOpen` see it like every other popover.
    await open(ui)
    expect(ui.anyPopoverOpen).toBe(true)

    // A door that ends the mission calls the `close` the component exposes.
    ;(wrapper!.vm as unknown as { close: () => void }).close()
    await nextTick()
    expect(ui.popovers.missionProgress).toBe(false)
    expect(ui.anyPopoverOpen).toBe(false)
  })

  it('a click on the pill itself is left to the pill (it toggles the flag), so it never closes and reopens', async () => {
    const ui = useUiStore()
    const pill = addPill()
    mountDropdown()
    await open(ui)
    pill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(ui.popovers.missionProgress).toBe(true)
  })

  it('Esc puts focus on the pill even when the chord opened it from somewhere else', async () => {
    const ui = useUiStore()
    const pill = addPill()
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    extra.push(elsewhere)
    mountDropdown()
    elsewhere.focus()
    await open(ui)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(pill)
  })

  it('focus is trapped and returned', async () => {
    const ui = useUiStore()
    const pill = addPill()
    mountDropdown()
    pill.focus()
    await open(ui)
    await nextTick()

    // Non-modal: the page behind stays visible and is not dimmed.
    const el = dialog()!
    expect(el.getAttribute('aria-modal')).not.toBe('true')
    expect(document.body.querySelector('[data-test="mission-dropdown-scrim"]')).toBeNull()

    // Initial focus is on the dropdown itself when nothing is owed.
    expect(el.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(el)

    const first = document.body.querySelector<HTMLElement>('[data-test="body-first"]')!
    const footerButton = document.body.querySelector<HTMLElement>('[data-test="footer-button"]')!
    const tab = (shift: boolean): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: shift,
        bubbles: true,
        cancelable: true
      })
      document.activeElement!.dispatchEvent(e)
      return e
    }

    // Tab from the last control wraps to the first; Shift+Tab from the first wraps to the last.
    footerButton.focus()
    expect(tab(false).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    expect(tab(true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(footerButton)

    // Esc closes it and focus goes back to the pill.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(pill)
  })
})
