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
  ;(window as unknown as { api: unknown }).api = {
    yourMovePrefsGet: vi.fn(async () => prefsNow),
    yourMoveSetPrefs: setPrefs,
    yourMoveList: vi.fn(async () => cards),
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
    const w = await mountPane([card({ ask }), card({ id: 'c2', ask: 'Closed one', closedAt: 5, closedBy: 'not-for-me' })])
    expect(w.text()).toContain(ask)
    expect(w.find('img').exists()).toBe(false)
    expect(w.text()).toContain('Closed one')
    expect(w.findAll('[data-testid="your-move-card"]')).toHaveLength(2)
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
