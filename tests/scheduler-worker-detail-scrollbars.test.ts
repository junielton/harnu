// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SchedulerWorkerDetail from '../src/renderer/src/components/SchedulerWorkerDetail.vue'
import { i18n } from '@renderer/i18n'
import type { Worker } from '../src/preload'

/**
 * The detail pane's two scroll columns must carry `.scrollable`.
 *
 * `.scrollable` (main.css) is how every scrolling surface in the app gets the
 * 8px, track-less, hover-revealed scrollbar the design system specifies. A
 * column that only has `overflow-y-auto` falls back to the platform scrollbar —
 * wider, opaque, with stepper arrows — which is what shipped here and read as a
 * bar sitting outside the layout.
 *
 * Asserting the class rather than computed geometry is deliberate: jsdom has no
 * layout engine and cannot render a scrollbar at all, so the class IS the
 * observable contract at this level.
 */

const schedulerRuns = vi.fn(async () => [])

beforeEach(() => {
  schedulerRuns.mockClear()
  const api = {
    schedulerRuns,
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

function mountDetail() {
  return mount(SchedulerWorkerDetail, {
    props: { worker: WORKER, running: false, nowMs: Date.now() },
    global: { plugins: [i18n] }
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flushPromises()
}

describe('SchedulerWorkerDetail — scroll columns use the app scrollbar', () => {
  it('the Runs column is .scrollable', async () => {
    const w = mountDetail()
    await settle()
    const runs = w.get('[data-dsqa="worker-detail-runs"]')
    expect(runs.classes()).toContain('scrollable')
    expect(runs.classes()).toContain('overflow-y-auto')
  })

  it('the Settings column is .scrollable', async () => {
    const w = mountDetail()
    await settle()
    const tab = w.findAll('button').find((b) => b.text() === 'Settings')
    expect(tab).toBeDefined()
    await tab!.trigger('click')
    await settle()
    const settings = w.get('[data-dsqa="worker-detail-settings"]')
    expect(settings.classes()).toContain('scrollable')
    expect(settings.classes()).toContain('overflow-y-auto')
  })

  it('every column that scrolls is styled — no bare overflow-y-auto anywhere', async () => {
    const w = mountDetail()
    await settle()
    const tab = w.findAll('button').find((b) => b.text() === 'Settings')
    await tab!.trigger('click')
    await settle()
    const bare = w
      .findAll('[class*="overflow-y-auto"]')
      .filter((el) => !el.classes().includes('scrollable'))
    expect(bare.map((el) => el.attributes('data-dsqa') ?? el.classes().join(' '))).toEqual([])
  })
})
