// @vitest-environment jsdom
/**
 * Mission dropdown · S-5 · AC-3b and AC-17 — the footer slot holds "Close mission…" (pinned, `border-t`, ghost,
 * compact, `flag` icon) except where the next card already is "Close mission…" and in the empty and chooser
 * views; and a dialog opened from the dropdown makes it `inert` and dimmed, takes initial focus on Cancel and
 * returns focus to its opener on Esc. A door that ends the mission closes the dropdown (design.md §6 "Mission
 * dropdown" → "What it draws" 5 and "Keyboard and focus"; mockup states `ready` and `close-confirm`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionDropdown from '../src/renderer/src/components/MissionDropdown.vue'
import MissionDropdownHead from '../src/renderer/src/components/MissionDropdownHead.vue'
import type { SampleState } from '../src/renderer/src/lib/mission-sample'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useUiStore } from '../src/renderer/src/stores/ui'

let wrapper: VueWrapper | null = null

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

/** The dropdown open over one state of the sample. */
async function openSample(state: SampleState): Promise<void> {
  ;(window as unknown as { api: unknown }).api = {
    requestAttention: vi.fn(),
    missionV4View: vi.fn(async () => null),
    missionPathKinds: vi.fn(async () => ({}))
  }
  useMissionsStore().showSample(state)
  wrapper = mount(MissionDropdown, { global: { plugins: [i18n] }, attachTo: document.body })
  const ui = useUiStore()
  ui.setPopoverAnchor('missionProgress', true)
  ui.openPopover('missionProgress')
  await settle()
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
  setActivePinia(createPinia())
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    { x: 0, y: 0, width: 10, height: 10 }
  ] as unknown as DOMRectList)
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('AC-17 — the footer', () => {
  it('footer shows only when it should', async () => {
    // A mission with something else next: the footer holds "Close mission…", pinned under the body.
    await openSample('default')
    const footer = q('[data-test="mission-dropdown-footer"]') as HTMLElement
    const body = q('[data-test="mission-dropdown-body"]') as HTMLElement
    expect(body.contains(footer), 'pinned: not inside the scrolling body').toBe(false)
    const close = q('[data-test="footer-close"]') as HTMLElement
    expect(footer.contains(close)).toBe(true)
    expect(text(close)).toBe('Close mission…')
    // Ghost, compact (h-5 px-2 11px), with the flag glyph; the footer carries the border-t.
    expect(close.className).toMatch(/\bh-5\b/)
    expect(close.className).toMatch(/\bpx-2\b/)
    expect(close.className).toMatch(/text-\[11px\]/)
    expect(close.className).toMatch(/\btext-text-3\b/)
    expect(close.className).not.toMatch(/\bbg-accent\b/)
    expect(close.querySelector('[data-glyph="flag"]')).not.toBeNull()
    expect((close.closest('[data-dsqa-part="footer"]') as HTMLElement).className).toMatch(
      /\bborder-t\b/
    )
    expect(close.getAttribute('type')).toBe('button')

    // Nothing owed: the next card does not say Close, so the footer still holds it.
    wrapper?.unmount()
    document.body.innerHTML = ''
    useMissionsStore().showSample(null)
    await openSample('clear')
    expect(q('[data-test="footer-close"]')).not.toBeNull()

    // Ready to close: the next card IS "Close mission…", so the footer does not repeat it.
    wrapper?.unmount()
    document.body.innerHTML = ''
    await openSample('done')
    expect(q('[data-test="next-button"]')).not.toBeNull()
    expect(text(q('[data-test="next-button"]'))).toBe('Close mission…')
    expect(q('[data-test="footer-close"]')).toBeNull()

    // The empty view has no footer control.
    wrapper?.unmount()
    document.body.innerHTML = ''
    await openSample('no-mission')
    expect(q('[data-test="mission-none"]')).not.toBeNull()
    expect(q('[data-test="footer-close"]')).toBeNull()

    // The chooser view (the switch opened) has none either, and it comes back when the switch closes.
    wrapper?.unmount()
    document.body.innerHTML = ''
    await openSample('default')
    const head = wrapper!.findComponent(MissionDropdownHead)
    head.vm.$emit('chooser', true)
    await settle()
    expect(q('[data-test="footer-close"]')).toBeNull()
    head.vm.$emit('chooser', false)
    await settle()
    expect(q('[data-test="footer-close"]')).not.toBeNull()
  })

  it('the footer button opens the close dialog', async () => {
    await openSample('default')
    ;(q('[data-test="footer-close"]') as HTMLElement).click()
    await settle()
    expect(q('[data-test="mission-close-confirm"]')).not.toBeNull()
  })
})

describe('AC-3b — a dialog opened from the dropdown', () => {
  it('a dialog makes the dropdown inert and returns focus', async () => {
    await openSample('default')
    const dropdown = q('[data-test="mission-dropdown"]') as HTMLElement
    const opener = q('[data-test="footer-close"]') as HTMLElement
    opener.focus()
    expect(document.activeElement).toBe(opener)
    expect(dropdown.hasAttribute('inert')).toBe(false)

    opener.click()
    await settle()

    // The dropdown is inert and dimmed; the dialog is teleported AFTER it, at the same `--z-dialog` layer (60).
    const backdrop = q('[data-mission-close-confirm]') as HTMLElement
    expect(backdrop).not.toBeNull()
    expect(dropdown.hasAttribute('inert')).toBe(true)
    expect(dropdown.className).toMatch(/saturate-/)
    expect(dropdown.contains(backdrop)).toBe(false)
    expect(
      dropdown.compareDocumentPosition(backdrop) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the dialog sits after the dropdown'
    ).toBeTruthy()
    expect(backdrop.style.zIndex).toBe('60')
    expect(dropdown.className).toMatch(/z-\(--z-dialog\)/)

    // Initial focus is Cancel.
    expect(document.activeElement).toBe(q('[data-test="mission-close-cancel"]'))

    // Esc closes the dialog first, the dropdown stays, and focus returns to the button that opened it.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(q('[data-mission-close-confirm]')).toBeNull()
    expect(useUiStore().popovers.missionProgress).toBe(true)
    expect(dropdown.hasAttribute('inert')).toBe(false)
    expect(dropdown.className).not.toMatch(/saturate-/)
    expect(document.activeElement).toBe(opener)
  })

  it('a door that ends the mission closes the dropdown', async () => {
    await openSample('default')
    ;(q('[data-test="footer-close"]') as HTMLElement).click()
    await settle()
    ;(q('[data-test="mission-close-confirm-go"]') as HTMLElement).click()
    await settle()
    expect(q('[data-mission-close-confirm]')).toBeNull()
    expect(useUiStore().popovers.missionProgress).toBe(false)
    expect(q('[data-test="mission-dropdown"]')).toBeNull()
  })

  it('Cancel on the dialog leaves the dropdown open and not inert', async () => {
    await openSample('default')
    ;(q('[data-test="footer-close"]') as HTMLElement).click()
    await settle()
    ;(q('[data-test="mission-close-cancel"]') as HTMLElement).click()
    await settle()
    expect(q('[data-mission-close-confirm]')).toBeNull()
    expect(useUiStore().popovers.missionProgress).toBe(true)
    expect((q('[data-test="mission-dropdown"]') as HTMLElement).hasAttribute('inert')).toBe(false)
  })
})

describe('T810 — the head and the next card stay put; only the tree scrolls', () => {
  const body = (): HTMLElement => q('[data-test="mission-dropdown-body"]') as HTMLElement
  const tree = (): HTMLElement => q('[data-test="tree"]') as HTMLElement
  const has = (el: HTMLElement, name: string): boolean => el.className.split(' ').includes(name)

  it('makes the tree the scroller, with the head and the next card fixed above it', async () => {
    await openSample('default')
    expect(has(body(), 'flex-col')).toBe(true)
    expect(has(tree(), 'overflow-y-auto')).toBe(true)
    expect(has(tree(), 'scrollable')).toBe(true)
    for (const sel of ['[data-test="mission-head"]', '[data-test="next-card"]']) {
      expect(has(q(sel) as HTMLElement, 'shrink-0'), sel).toBe(true)
    }
  })

  it('pins nothing in a window under 420px of height', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 })
    await openSample('default')
    expect(has(body(), 'flex-col')).toBe(false)
    expect(has(tree(), 'overflow-y-auto')).toBe(false)
  })
})
