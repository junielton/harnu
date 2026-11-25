// @vitest-environment jsdom
/**
 * TooltipLayer (design.md §6 "Tooltip"): hover shows the anchor's text after the open delay, the native
 * `title` is moved aside meanwhile and put back on leave, and an icon-only button shows its aria-label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import TooltipLayer from '../src/renderer/src/components/TooltipLayer.vue'
import { OPEN_DELAY_MS, STASH_ATTR } from '../src/renderer/src/lib/tooltip'

let wrapper: VueWrapper | null = null

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom has no layout; give every element a box so the layer does not treat it as hidden.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 100,
    width: 24,
    height: 24,
    right: 124,
    bottom: 124,
    x: 100,
    y: 100,
    toJSON: () => ({})
  } as DOMRect)
  document.body.innerHTML = '<div id="host"></div>'
  wrapper = mount(TooltipLayer, { attachTo: '#host' })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function over(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
}
function out(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }))
}
const tip = (): Element | null => document.querySelector('[data-testid="app-tooltip"]')

async function settle(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms)
  await nextTick()
  await nextTick()
}

describe('TooltipLayer', () => {
  it('shows the title after the open delay and restores it on leave', async () => {
    const btn = document.createElement('button')
    btn.title = 'Rescan folders'
    document.body.appendChild(btn)

    over(btn)
    expect(btn.hasAttribute('title')).toBe(false)
    expect(btn.getAttribute(STASH_ATTR)).toBe('Rescan folders')
    await settle(OPEN_DELAY_MS - 1)
    expect(tip()).toBeNull()
    await settle(1)
    expect(tip()?.textContent?.trim()).toBe('Rescan folders')

    out(btn)
    await nextTick()
    expect(tip()).toBeNull()
    expect(btn.getAttribute('title')).toBe('Rescan folders')
    expect(btn.hasAttribute(STASH_ATTR)).toBe(false)
  })

  it('opens the next tooltip at once while warm', async () => {
    const a = document.createElement('button')
    a.title = 'A'
    const b = document.createElement('button')
    b.title = 'B'
    document.body.append(a, b)

    over(a)
    await settle(OPEN_DELAY_MS)
    out(a)
    over(b)
    await settle(0)
    expect(tip()?.textContent?.trim()).toBe('B')
  })

  it('shows the aria-label of an icon-only button', async () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<button id="x" aria-label="Close"><svg></svg></button>'
    )
    over(document.getElementById('x')!)
    await settle(OPEN_DELAY_MS)
    expect(tip()?.textContent?.trim()).toBe('Close')
  })

  it('hides on pointer down', async () => {
    const btn = document.createElement('button')
    btn.title = 'Go'
    document.body.appendChild(btn)
    over(btn)
    await settle(OPEN_DELAY_MS)
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await nextTick()
    expect(tip()).toBeNull()
    expect(btn.getAttribute('title')).toBe('Go')
  })
})
