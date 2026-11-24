// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import YourMovePane from '../../src/renderer/src/components/YourMovePane.vue'
import { useSessionsStore } from '../../src/renderer/src/stores/sessions'

let wrapper: VueWrapper | null = null
let setPrefs: ReturnType<typeof vi.fn>
let inspectNow: ReturnType<typeof vi.fn>
let prefsNow: Record<string, unknown>
let pageCall: ReturnType<typeof vi.fn>
let listCall: ReturnType<typeof vi.fn>

const card = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  sessionId: 's1',
  folder: '/org/proj/www',
  kind: 'decide',
  ask: 'Pick A or B',
  source: 'judge',
  lane: 'observe',
  openedAt: 1_000,
  updatedAt: 1_000,
  answerable: false,
  optionDeliverable: [],
  ...over
})

async function mountPane(cards: unknown[] = []): Promise<VueWrapper> {
  prefsNow = { mode: 'off', disabledFolders: [], firstRunNoticeSeen: false, midTurnLive: false }
  setPrefs = vi.fn(async (patch: Record<string, unknown>) => {
    prefsNow = { ...prefsNow, ...patch }
    return prefsNow
  })
  inspectNow = vi.fn(async () => ({ outcome: 'judged' }))
  // Main answers a page at a time; the pane must never ask for the whole list.
  pageCall = vi.fn(async ({ offset }: { offset: number }) => ({
    total: cards.length,
    cards: cards.slice(offset, offset + 25)
  }))
  listCall = vi.fn(async () => cards)
  ;(window as unknown as { api: unknown }).api = {
    yourMovePrefsGet: vi.fn(async () => prefsNow),
    yourMoveSetPrefs: setPrefs,
    yourMoveList: listCall,
    yourMovePage: pageCall,
    yourMoveInspectNow: inspectNow,
    onYourMoveChanged: vi.fn(() => () => undefined)
  }
  wrapper = mount(YourMovePane, { attachTo: document.body, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('YourMovePane', () => {
  it('renders Off, Observe and Live and calls yourMoveSetPrefs on change', async () => {
    const w = await mountPane()
    const radios = w.findAll('[role="radio"]')
    expect(radios.map((r) => r.text())).toEqual(['Off', 'Observe', 'Live'])
    // U1 ships with the default Off
    expect(radios.map((r) => r.attributes('aria-checked'))).toEqual(['true', 'false', 'false'])
    await radios[1].trigger('click')
    await flushPromises()
    expect(setPrefs).toHaveBeenCalledWith({ mode: 'observe' })
    expect(w.findAll('[role="radio"]')[1].attributes('aria-checked')).toBe('true')
  })

  it('lists stored cards as text; markup in ask is shown literally', async () => {
    const ask = '<img src=x onerror="boom()"> Merge **now**'
    const w = await mountPane([
      card({ ask }),
      card({ id: 'c2', ask: 'Closed one', closedAt: 5, closedBy: 'not-for-me' })
    ])
    expect(w.text()).toContain(ask)
    expect(w.find('img').exists()).toBe(false)
    expect(w.text()).toContain('Closed one')
    expect(w.findAll('[data-testid="your-move-card"]')).toHaveLength(2)
  })

  it('BUG-277 AC-6: renders one page of 25 out of 7,000 cards and never asks for the whole list', async () => {
    const many = Array.from({ length: 7_000 }, (_, i) =>
      card({ id: `c${i}`, ask: `Card ${i}`, openedAt: 10_000 - i })
    )
    const w = await mountPane(many)
    expect(w.findAll('[data-testid="your-move-card"]')).toHaveLength(25)
    expect(w.get('[data-testid="your-move-range"]').text()).toBe('1–25 of 7000')
    expect(w.text()).toContain('Stored cards · 7000')
    expect(listCall).not.toHaveBeenCalled()
    expect(pageCall).toHaveBeenCalledWith({ offset: 0 })
  })

  it('BUG-277 AC-6: Next and Previous move one page at a time, loaded on demand', async () => {
    const many = Array.from({ length: 60 }, (_, i) => card({ id: `c${i}`, ask: `Card ${i}` }))
    const w = await mountPane(many)
    expect(w.get('[data-testid="your-move-prev"]').attributes('disabled')).toBeDefined()
    await w.get('[data-testid="your-move-next"]').trigger('click')
    await flushPromises()
    expect(pageCall).toHaveBeenLastCalledWith({ offset: 25 })
    expect(w.findAll('[data-testid="your-move-card"]')[0].text()).toContain('Card 25')
    expect(w.get('[data-testid="your-move-range"]').text()).toBe('26–50 of 60')
    await w.get('[data-testid="your-move-next"]').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-testid="your-move-card"]')).toHaveLength(10)
    expect(w.get('[data-testid="your-move-next"]').attributes('disabled')).toBeDefined()
    await w.get('[data-testid="your-move-prev"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="your-move-range"]').text()).toBe('26–50 of 60')
  })

  it('a single page shows no pager', async () => {
    const w = await mountPane([card()])
    expect(w.find('[data-testid="your-move-pager"]').exists()).toBe(false)
  })

  it('shows an empty state when nothing is stored', async () => {
    const w = await mountPane([])
    expect(w.find('[data-testid="your-move-empty"]').exists()).toBe(true)
  })

  it('Inspect now calls yourMoveInspectNow with the selected session', async () => {
    const w = await mountPane()
    const sessions = useSessionsStore()
    sessions.folders = [
      {
        path: '/org/proj/www',
        alias: 'www',
        sessions: [{ sessionId: 's1', projectPath: '/org/proj/www' }]
      }
    ] as unknown as typeof sessions.folders
    sessions.selectedId = 's1'
    await flushPromises()
    await w.get('[data-testid="your-move-inspect"]').trigger('click')
    await flushPromises()
    expect(inspectNow).toHaveBeenCalledWith({ sessionId: 's1', folder: '/org/proj/www' })
  })

  it('Inspect now is disabled with no session selected', async () => {
    const w = await mountPane()
    expect(w.get('[data-testid="your-move-inspect"]').attributes('disabled')).toBeDefined()
  })
})
