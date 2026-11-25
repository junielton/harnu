// @vitest-environment jsdom
/**
 * BUG-276: the Return here head (label, count, oldest clock) wrapped onto two lines in a narrow
 * sidebar ("RETURN" / "HERE"). jsdom does no layout, so this pins the classes that keep it on one
 * line: the row never wraps, the title is the only part that gives way (with an ellipsis), the
 * count and the clock stay whole, and the chevron stays visible at the end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import type { CardView } from '../../src/main/your-move/core'
import SidebarReturnZone from '../../src/renderer/src/components/SidebarReturnZone.vue'

const NOW = 1_700_000_000_000

const card: CardView = {
  id: 'card-1',
  sessionId: 'sess-1',
  folder: '/org/proj/www',
  kind: 'decide',
  ask: 'Pick A or B',
  source: 'judge',
  lane: 'live',
  openedAt: NOW - 3_600_000,
  updatedAt: NOW,
  answerable: false,
  optionDeliverable: []
}

let wrapper: VueWrapper | null = null
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  setActivePinia(createPinia())
  ;(window as unknown as { api: unknown }).api = {
    yourMoveList: vi.fn(async () => [structuredClone(card)]),
    yourMovePrefsGet: vi.fn(async () => ({ mode: 'live' })),
    onYourMoveChanged: vi.fn()
  }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

describe('Return here eyebrow never wraps (BUG-276)', () => {
  async function mountZone(): Promise<VueWrapper> {
    wrapper = mount(SidebarReturnZone, { global: { plugins: [i18n] } })
    await flushPromises()
    return wrapper
  }

  it('keeps the row on one line and lets only the title truncate', async () => {
    const w = await mountZone()
    const line = w.get('[data-testid="your-move-eyebrow"]')
    const row = line.element.parentElement as HTMLElement

    // The row: no wrapping, and allowed to shrink inside its island.
    expect(row.classList.contains('whitespace-nowrap')).toBe(true)
    expect(row.classList.contains('min-w-0')).toBe(true)

    // The title is the one part that truncates; it must be able to shrink below its text.
    const [title, count, clock] = Array.from(line.element.children) as HTMLElement[]
    expect(title.classList.contains('min-w-0')).toBe(true)
    expect(title.classList.contains('truncate')).toBe(true)

    // Count and clock stay whole.
    expect(count.classList.contains('shrink-0')).toBe(true)
    expect(clock.classList.contains('shrink-0')).toBe(true)
  })

  it('keeps the open chevron from shrinking', async () => {
    const w = await mountZone()
    expect(w.get('[data-dock-chevron]').classes()).toContain('shrink-0')
  })
})
