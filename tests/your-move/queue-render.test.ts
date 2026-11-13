// @vitest-environment jsdom
/**
 * BUG-271: the Return here zone's cost must not grow with the number of open cards. With 2,000
 * open cards it renders one page, offers "more" for the rest, and a clock tick rewrites at most a
 * page of text nodes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { i18n } from '@renderer/i18n'
import type { CardView } from '../../src/main/your-move/core'
import SidebarReturnZone from '../../src/renderer/src/components/SidebarReturnZone.vue'
import { QUEUE_PAGE } from '../../src/renderer/src/lib/your-move-view'
import { useYourMoveStore } from '../../src/renderer/src/stores/your-move'

const OPEN = 2_000
const START = 1_700_000_000_000

const card = (i: number): CardView => ({
  id: `card-${i}`,
  sessionId: `sess-${i}`,
  folder: '/org/proj/www',
  kind: 'decide',
  ask: `Pick A or B (${i})`,
  source: 'judge',
  lane: 'live',
  // Filed hours ago, so every clock is past its first minute and none crosses a minute boundary
  // within a few seconds (ages 10h 00m 20-40 s); card 0 is the oldest.
  openedAt: START - 10 * 3_600_000 - 40_000 + i * 10,
  updatedAt: START,
  answerable: false,
  optionDeliverable: []
})

let wrapper: VueWrapper | null = null
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
  setActivePinia(createPinia())
  const cards = Array.from({ length: OPEN }, (_, i) => card(i))
  ;(window as unknown as { api: unknown }).api = {
    yourMoveList: vi.fn(async () => structuredClone(cards)),
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

async function mountZone(): Promise<VueWrapper> {
  wrapper = mount(SidebarReturnZone, { global: { plugins: [i18n] } })
  await flushPromises()
  await nextTick()
  return wrapper
}

/** Counts DOM text writes (a changed text node or a replaced child) while `act` runs. */
async function countWrites(w: VueWrapper, act: () => Promise<void>): Promise<number> {
  let writes = 0
  const count = (records: MutationRecord[]): void => {
    for (const r of records) writes += r.type === 'characterData' ? 1 : r.addedNodes.length
  }
  const observer = new MutationObserver(count)
  observer.observe(w.element, { childList: true, characterData: true, subtree: true })
  await act()
  count(observer.takeRecords())
  observer.disconnect()
  return writes
}

const tick = async (): Promise<void> => {
  vi.advanceTimersByTime(1_000)
  await nextTick()
  await nextTick()
}

const cardsIn = (w: VueWrapper): number => w.findAll('[data-testid="your-move-card"]').length

describe('Return here zone with a huge queue (BUG-271)', () => {
  it('renders one page of cards and still counts every open card (AC-1)', async () => {
    const w = await mountZone()
    expect(cardsIn(w)).toBe(QUEUE_PAGE)
    expect(w.get('[data-testid="your-move-eyebrow"]').text()).toContain(String(OPEN))
    // Order is the queue's: oldest first.
    expect(w.findAll('[data-testid="your-move-ask"]')[0].text()).toContain('(0)')
  })

  it('offers one "more" affordance that reveals the next page, never all at once (AC-1)', async () => {
    const w = await mountZone()
    const more = w.findAll('[data-testid="your-move-more"]')
    expect(more).toHaveLength(1)
    expect(more[0].text()).toContain(String(QUEUE_PAGE))
    expect(more[0].text()).toContain((OPEN - QUEUE_PAGE).toLocaleString('en-US'))
    await more[0].trigger('click')
    expect(cardsIn(w)).toBe(2 * QUEUE_PAGE)
    expect(w.findAll('[data-testid="your-move-more"]')).toHaveLength(1)
  })

  it('shows no "more" affordance when the queue fits one page (AC-1)', async () => {
    const small = Array.from({ length: 3 }, (_, i) => card(i))
    ;(window as unknown as { api: { yourMoveList: unknown } }).api.yourMoveList = vi.fn(async () =>
      structuredClone(small)
    )
    const w = await mountZone()
    expect(cardsIn(w)).toBe(3)
    expect(w.findAll('[data-testid="your-move-more"]')).toHaveLength(0)
  })

  it('one 1 s tick writes at most a page of text nodes with 2,000 open cards (AC-2)', async () => {
    const w = await mountZone()
    const writes = await countWrites(w, tick)
    expect(useYourMoveStore().now).toBeGreaterThan(START)
    expect(writes).toBeLessThanOrEqual(QUEUE_PAGE)
    // Every clock here is hours old and none crosses a minute boundary: the tick writes nothing.
    expect(writes).toBe(0)
  })

  it('with 2,000 cards filed seconds ago, a tick still writes at most a page (AC-2)', async () => {
    const fresh = Array.from({ length: OPEN }, (_, i) => ({
      ...card(i),
      openedAt: START - 10_000 + i // 10 s old: seconds are shown and change on every tick
    }))
    ;(window as unknown as { api: { yourMoveList: unknown } }).api.yourMoveList = vi.fn(async () =>
      structuredClone(fresh)
    )
    const w = await mountZone()
    const writes = await countWrites(w, tick)
    // The counter sees real writes (the page's clocks changed)...
    expect(writes).toBeGreaterThan(0)
    // ...and only the rendered page pays for them.
    expect(writes).toBeLessThanOrEqual(QUEUE_PAGE + 1)
  })

  it('a clock past its first minute does not change inside that minute (AC-2)', async () => {
    const w = await mountZone()
    const clocks = (): string[] => w.findAll('[data-testid="your-move-clock"]').map((c) => c.text())
    const before = clocks()
    vi.advanceTimersByTime(5_000)
    await nextTick()
    expect(clocks()).toEqual(before)
  })
})
