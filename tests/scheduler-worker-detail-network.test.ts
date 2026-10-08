// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import SchedulerWorkerDetail from '../src/renderer/src/components/SchedulerWorkerDetail.vue'
import { i18n } from '@renderer/i18n'
import type { Worker } from '../src/preload'

/**
 * BUG-166: the Settings tab has a Network access switch for `observe` workers only. Off by
 * default, no warning while it is off, the danger callout while it is on, and flipping it saves
 * `allowNetwork` through the same debounced store write as every other field.
 */

const schedulerSave = vi.fn(async (draft: Partial<Worker>) => [draft as Worker])

beforeEach(() => {
  schedulerSave.mockClear()
  const api = {
    bundledSkillsGet: vi.fn(async () => ({ catalog: [], enabled: {}, userLevelInstall: {} })),
    bundledSkillsGetFolder: vi.fn(async () => ({})),
    schedulerRuns: vi.fn(async () => []),
    schedulerSave,
    claudeConfigGetGlobal: vi.fn(async () => ({})),
    claudeConfigListEndpoints: vi.fn(async () => [])
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, k: string) {
      return k in t ? t[k] : () => () => {}
    }
  })
  setActivePinia(createPinia())
})

const WORKER: Worker = {
  id: 'w1',
  name: 'PR watcher',
  enabled: true,
  prompt: 'Check for new PRs.',
  folder: '/repo/alpha',
  everyMinutes: 5,
  runOnBoot: false,
  model: 'haiku',
  effort: 'low',
  mode: 'observe',
  timeoutSeconds: 300,
  carryLastResult: false,
  failureStreak: 0
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises()
    await nextTick()
  }
}

async function mountSettings(worker: Worker) {
  const wrapper = mount(SchedulerWorkerDetail, {
    props: { worker, running: false, nowMs: Date.now() },
    global: { plugins: [i18n] }
  })
  ;(wrapper.vm as unknown as { openSettingsAndFocusName: () => void }).openSettingsAndFocusName()
  await settle()
  return wrapper
}

const LEAD = 'Lets this worker send data from files it reads to the internet.'

describe('SchedulerWorkerDetail — Network access switch (BUG-166)', () => {
  it('shows the switch for an observe worker, off, with no warning', async () => {
    const wrapper = await mountSettings(WORKER)
    expect(wrapper.text()).toContain('Network access')
    expect(wrapper.text()).toContain('Off by default.')
    expect(wrapper.text()).not.toContain(LEAD)
  })

  it('shows the warning callout when the worker has network on', async () => {
    const wrapper = await mountSettings({ ...WORKER, allowNetwork: true })
    expect(wrapper.text()).toContain(LEAD)
  })

  it('does not show the switch for an act worker', async () => {
    const wrapper = await mountSettings({ ...WORKER, mode: 'act' })
    expect(wrapper.text()).not.toContain('Network access')
  })

  it('flipping the switch saves allowNetwork: true', async () => {
    const wrapper = await mountSettings(WORKER)
    const toggle = wrapper.find('[aria-label="Network access"]')
    expect(toggle.exists()).toBe(true)
    await toggle.trigger('click')
    // The store debounces writes by 300ms.
    await new Promise((r) => setTimeout(r, 400))
    await settle()
    expect(schedulerSave).toHaveBeenCalled()
    expect(schedulerSave.mock.calls.at(-1)?.[0]).toMatchObject({ id: 'w1', allowNetwork: true })
  })
})
