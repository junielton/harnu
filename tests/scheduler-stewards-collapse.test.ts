// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SchedulerView from '../src/renderer/src/components/SchedulerView.vue'
import { useSchedulerStore } from '../src/renderer/src/stores/scheduler'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { i18n } from '@renderer/i18n'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'
import type { Worker } from '../src/preload'

/**
 * T651 — the Scheduler's Stewards block, driven through the real `SchedulerView`: collapsed by default,
 * the toggle persisted per viewer under `om2tab.scheduler.stewardsCollapsed` (guarded like Up next's),
 * and a delivered mission's steward reading "Awaiting close".
 */

const KEY = 'om2tab.scheduler.stewardsCollapsed'

function worker(id: string, over: Partial<Worker> = {}): Worker {
  return {
    id,
    name: `worker-${id}`,
    enabled: true,
    prompt: 'p',
    folder: '/org/alpha',
    everyMinutes: 30,
    runOnBoot: false,
    model: 'haiku',
    effort: 'low',
    mode: 'observe',
    timeoutSeconds: 300,
    carryLastResult: false,
    failureStreak: 0,
    ...over
  } as Worker
}

let state: Worker[]

function stubApi(): void {
  const api = {
    schedulerList: vi.fn(async () => state),
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

async function mountView(delivered: string[] = []): Promise<ReturnType<typeof mount>> {
  stubTakeoverShellTargets()
  const wrapper = mount(SchedulerView, { global: { plugins: [i18n] }, attachTo: document.body })
  await settle()
  useSchedulerStore().runningIds = []
  useMissionsStore().views = state
    .filter((w) => w.missionId)
    .map((w) => ({
      title: `Mission ${w.missionId}`,
      mission: {
        id: w.missionId,
        status: delivered.includes(w.missionId!) ? 'delivered' : 'active'
      }
    })) as never
  await settle()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  state = [
    worker('u1'),
    ...Array.from({ length: 8 }, (_, i) =>
      worker(`s${i}`, {
        category: 'steward',
        mode: 'steward',
        missionId: `mnt-0000000${i}`
      } as Partial<Worker>)
    )
  ]
  stubApi()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Stewards block in the Scheduler list (T651)', () => {
  it('is collapsed by default: header and summary only, no rows', async () => {
    const w = await mountView(['mnt-00000000', 'mnt-00000001'])
    expect(w.get('[data-test="scheduler-stewards-toggle"]').attributes('aria-expanded')).toBe(
      'false'
    )
    expect(w.get('[data-test="scheduler-stewards-summary"]').text()).toBe('8 · 2 awaiting close')
    expect(w.find('[data-test="scheduler-steward-row"]').exists()).toBe(false)
    w.unmount()
  })

  it('opens from the header, persists under om2tab.scheduler.stewardsCollapsed, and survives a remount', async () => {
    const w = await mountView(['mnt-00000000'])
    await w.get('[data-test="scheduler-stewards-toggle"]').trigger('click')
    expect(w.findAll('[data-test="scheduler-steward-row"]')).toHaveLength(8)
    expect(localStorage.getItem(KEY)).toBe('0')
    expect(w.findAll('[data-test="scheduler-steward-state"]').map((n) => n.text())).toEqual([
      'Awaiting close'
    ])
    w.unmount()

    const again = await mountView()
    expect(again.findAll('[data-test="scheduler-steward-row"]')).toHaveLength(8)
    await again.get('[data-test="scheduler-stewards-toggle"]').trigger('click')
    expect(again.find('[data-test="scheduler-steward-row"]').exists()).toBe(false)
    expect(localStorage.getItem(KEY)).toBe('1')
    again.unmount()
  })

  it('still renders collapsed and toggles when localStorage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const w = await mountView()
    expect(w.find('[data-test="scheduler-steward-row"]').exists()).toBe(false)
    await w.get('[data-test="scheduler-stewards-toggle"]').trigger('click')
    expect(w.findAll('[data-test="scheduler-steward-row"]')).toHaveLength(8)
    w.unmount()
  })
})
