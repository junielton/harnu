// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SchedulerView from '../src/renderer/src/components/SchedulerView.vue'
import { i18n } from '@renderer/i18n'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'
import type { Worker } from '../src/preload'

/**
 * T483 / T590 — pinning in the folder-grouped Scheduler list: a pinned worker wears an accent pin
 * icon and sorts first inside its folder (there are no Pinned / Enabled / Off groups any more), and
 * the pin actions (row + detail) flip the same state. Driven through the real `SchedulerView` with a
 * stateful `window.api` stub that plays main's part (`schedulerSetPinned` flips `pinnedAt`, exactly
 * as `scheduler:setPinned` does).
 */

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

const rowNames = (w: ReturnType<typeof mount>): string[] =>
  w.findAll('[role="option"] [data-worker-name]').map((n) => n.text())
const pinnedNames = (w: ReturnType<typeof mount>): string[] =>
  w
    .findAll('[role="option"]')
    .filter((r) => r.find('[data-pin-icon]').exists())
    .map((r) => r.get('[data-worker-name]').text())

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  setPinned.mockReset()
  state = [worker('a', true), worker('b', false), worker('c', true), worker('d', false)]
  stubApi()
})

describe('pinned workers inside a folder (T590 AC-6)', () => {
  it('has no Pinned / Enabled / Off group headers at all', async () => {
    state = [worker('a', true, 1), worker('b', false), worker('c', true)]
    const w = await mountView()
    expect(w.find('[data-group-header]').exists()).toBe(false)
    expect(w.findAll('[data-folder-group]')).toHaveLength(1)
    w.unmount()
  })

  it('pinning from the row action puts a pin icon on the worker and sorts it first (AC-6)', async () => {
    const w = await mountView()
    expect(rowNames(w)).toEqual(['worker-a', 'worker-b', 'worker-c', 'worker-d'])
    const rowC = w.findAll('[role="option"]').find((r) => r.text().includes('worker-c'))!
    await rowC.get('[data-action="pin"]').trigger('click')
    await settle()

    expect(setPinned).toHaveBeenCalledWith('c', true)
    expect(pinnedNames(w)).toEqual(['worker-c'])
    expect(rowNames(w)).toEqual(['worker-c', 'worker-a', 'worker-b', 'worker-d'])
    w.unmount()
  })

  it('a pinned OFF worker stays in its folder, still dimmed and still labelled off', async () => {
    state = [worker('a', true, 5), worker('b', false, 10)]
    const w = await mountView()
    // `a` is the default selection; `b` is the unselected pinned-off row.
    const row = w.findAll('[role="option"]')[1]
    expect(row.text()).toContain('worker-b')
    expect(row.classes()).toContain('opacity-[0.55]')
    expect(row.attributes('data-dsqa')).toContain('off')
    expect(row.find('[data-pin-icon]').exists()).toBe(true)
    w.unmount()
  })

  it('orders pinned workers by pinnedAt ascending, ahead of the rest', async () => {
    state = [
      worker('a', true, 300),
      worker('b', false, 100),
      worker('c', true, 200),
      worker('d', true)
    ]
    const w = await mountView()
    expect(rowNames(w)).toEqual(['worker-b', 'worker-c', 'worker-a', 'worker-d'])
    w.unmount()
  })

  it('unpinning from the row drops the icon and returns the worker to storage order', async () => {
    state = [worker('a', true, 1), worker('b', false, 2), worker('c', true)]
    const w = await mountView()
    for (const r of w
      .findAll('[role="option"]')
      .filter((x) => x.find('[data-pin-icon]').exists())) {
      await r.get('[data-action="pin"]').trigger('click')
    }
    await settle()
    expect(pinnedNames(w)).toEqual([])
    expect(rowNames(w)).toEqual(['worker-a', 'worker-b', 'worker-c'])
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
    expect(pinnedNames(w)).toEqual([])
    expect(w.get('[data-action="detail-pin"]').attributes('aria-pressed')).toBe('false')
    w.unmount()
  })
})
