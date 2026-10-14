// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SchedulerView from '../src/renderer/src/components/SchedulerView.vue'
import { useSchedulerStore } from '../src/renderer/src/stores/scheduler'
import { i18n } from '@renderer/i18n'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'
import type { Worker } from '../src/preload'

/**
 * T483 — the Scheduler list's Pinned group, the pin actions (row + detail) and the collapsible
 * Off group, driven through the real `SchedulerView` with a stateful `window.api` stub that plays
 * main's part (`schedulerSetPinned` flips `pinnedAt`, exactly as `scheduler:setPinned` does).
 */

const OFF_KEY = 'om2tab.scheduler.offCollapsed'

function worker(id: string, enabled: boolean, pinnedAt?: number): Worker {
  return {
    id,
    name: `worker-${id}`,
    enabled,
    prompt: 'p',
    folder: '/repo/alpha',
    everyMinutes: 5,
    runOnBoot: false,
    model: 'haiku',
    effort: 'low',
    mode: 'observe',
    timeoutSeconds: 300,
    carryLastResult: false,
    failureStreak: 0,
    ...(pinnedAt === undefined ? {} : { pinnedAt })
  }
}

let state: Worker[]
const setPinned = vi.fn()

function stubApi(): void {
  setPinned.mockImplementation(async (id: string, pinned: boolean) => {
    state = state.map((w) => {
      if (w.id !== id) return w
      const { pinnedAt: _drop, ...rest } = w
      void _drop
      return pinned ? { ...rest, pinnedAt: w.pinnedAt ?? Date.now() } : rest
    })
    return state
  })
  const api = {
    schedulerList: vi.fn(async () => state),
    schedulerSetPinned: setPinned,
    schedulerSave: vi.fn(async () => state),
    schedulerRuns: vi.fn(async () => []),
    bundledSkillsGet: vi.fn(async () => ({})),
    bundledSkillsGetFolder: vi.fn(async () => ({})),
    claudeConfigGetGlobal: vi.fn(async () => ({})),
    claudeConfigListEndpoints: vi.fn(async () => [])
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, k: string) {
      return k in t ? t[k] : () => () => {}
    }
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flushPromises()
}

async function mountView(): Promise<ReturnType<typeof mount>> {
  stubTakeoverShellTargets()
  const wrapper = mount(SchedulerView, { global: { plugins: [i18n] }, attachTo: document.body })
  await settle()
  return wrapper
}

const header = (w: ReturnType<typeof mount>, g: string): ReturnType<typeof w.find> =>
  w.find(`[data-group-header="${g}"]`)
const rowIds = (w: ReturnType<typeof mount>, g: string): string[] =>
  w.findAll(`[data-group="${g}"] [role="option"]`).map((r) => r.text().match(/worker-\w+/)![0])

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  setPinned.mockReset()
  state = [worker('a', true), worker('b', false), worker('c', true), worker('d', false)]
  stubApi()
})

describe('Pinned group (AC-1, AC-4, AC-5)', () => {
  it('renders no Pinned header when nothing is pinned (AC-5)', async () => {
    const w = await mountView()
    expect(header(w, 'pinned').exists()).toBe(false)
    expect(header(w, 'enabled').text()).toContain('Enabled · 2')
    expect(header(w, 'off').text()).toContain('Off · 2')
    w.unmount()
  })

  it('pinning from the row action moves the worker into Pinned and out of Off (AC-1)', async () => {
    const w = await mountView()
    const rowB = w.findAll('[role="option"]').find((r) => r.text().includes('worker-b'))!
    await rowB.get('[data-action="pin"]').trigger('click')
    await settle()

    expect(setPinned).toHaveBeenCalledWith('b', true)
    expect(header(w, 'pinned').text()).toContain('Pinned · 1')
    expect(rowIds(w, 'pinned')).toEqual(['worker-b'])
    expect(rowIds(w, 'off')).toEqual(['worker-d'])
    expect(header(w, 'off').text()).toContain('Off · 1')
    w.unmount()
  })

  it('a pinned OFF worker stays in Pinned, still dimmed and still labelled off (AC-4)', async () => {
    state = [worker('a', true, 5), worker('b', false, 10)]
    const w = await mountView()
    // `a` is the default selection; `b` is the unselected pinned-off row.
    const row = w.findAll('[data-group="pinned"] [role="option"]')[1]
    expect(row.text()).toContain('worker-b')
    expect(row.classes()).toContain('opacity-[0.55]')
    expect(row.attributes('data-dsqa')).toContain('off')
    w.unmount()
  })

  it('lists Pinned by pinnedAt ascending (AC-4)', async () => {
    state = [worker('a', true, 300), worker('b', false, 100), worker('c', true, 200)]
    const w = await mountView()
    expect(rowIds(w, 'pinned')).toEqual(['worker-b', 'worker-c', 'worker-a'])
    w.unmount()
  })

  it('unpinning from the row returns the worker to Enabled or Off by `enabled` (AC-3)', async () => {
    state = [worker('a', true, 1), worker('b', false, 2)]
    const w = await mountView()
    for (const r of w.findAll('[data-group="pinned"] [role="option"]')) {
      await r.get('[data-action="pin"]').trigger('click')
    }
    await settle()
    expect(header(w, 'pinned').exists()).toBe(false)
    expect(rowIds(w, 'enabled')).toEqual(['worker-a'])
    expect(rowIds(w, 'off')).toEqual(['worker-b'])
    w.unmount()
  })
})

describe('detail pin toggle (AC-6)', () => {
  it('reflects the pin state and changes the same state as the row', async () => {
    state = [worker('a', true), worker('b', true, 5)]
    const w = await mountView()
    // default selection = first visible row = the pinned worker
    const toggle = w.get('[data-action="detail-pin"]')
    expect(toggle.attributes('aria-pressed')).toBe('true')

    await toggle.trigger('click')
    await settle()
    expect(setPinned).toHaveBeenCalledWith('b', false)
    expect(header(w, 'pinned').exists()).toBe(false)
    expect(w.get('[data-action="detail-pin"]').attributes('aria-pressed')).toBe('false')
    w.unmount()
  })
})

describe('collapsible Off group (AC-7)', () => {
  it('collapses from its header, persists, and never clears the selection', async () => {
    const w = await mountView()
    const store = useSchedulerStore()
    const offRow = w.findAll('[role="option"]').find((r) => r.text().includes('worker-d'))!
    await offRow.trigger('click')
    expect(store.selectedId).toBe('d')

    await header(w, 'off').trigger('click')
    await settle()
    expect(rowIds(w, 'off')).toEqual([])
    expect(header(w, 'off').text()).toContain('Off · 2')
    expect(header(w, 'off').attributes('aria-expanded')).toBe('false')
    expect(store.selectedId).toBe('d')
    expect(w.text()).toContain('worker-d') // detail title still shows the selected worker
    expect(localStorage.getItem(OFF_KEY)).toBe('1')

    await header(w, 'off').trigger('click')
    await settle()
    expect(rowIds(w, 'off')).toEqual(['worker-b', 'worker-d'])
    expect(localStorage.getItem(OFF_KEY)).toBe('0')
    w.unmount()
  })

  it('reopens collapsed when the stored preference says so, and defaults to expanded', async () => {
    localStorage.setItem(OFF_KEY, '1')
    const w = await mountView()
    expect(rowIds(w, 'off')).toEqual([])
    w.unmount()

    localStorage.clear()
    const again = await mountView()
    expect(rowIds(again, 'off')).toEqual(['worker-b', 'worker-d'])
    again.unmount()
  })
})

describe('default selection (AC-8)', () => {
  it('selects the first pinned worker when any is pinned', async () => {
    state = [worker('a', true), worker('b', false, 5)]
    const w = await mountView()
    expect(useSchedulerStore().selectedId).toBe('b')
    w.unmount()
  })

  it('selects the first Enabled worker when nothing is pinned', async () => {
    state = [worker('a', false), worker('b', true)]
    const w = await mountView()
    expect(useSchedulerStore().selectedId).toBe('b')
    w.unmount()
  })
})
