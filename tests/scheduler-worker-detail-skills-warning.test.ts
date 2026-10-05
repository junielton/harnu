// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import SchedulerWorkerDetail from '../src/renderer/src/components/SchedulerWorkerDetail.vue'
import { i18n } from '@renderer/i18n'
import type { Worker } from '../src/preload'

/**
 * AC-10: the Settings tab warns when the worker's chosen folder ends up with
 * no bundled skill enabled — `folderHasNoSkillEnabled` merges the folder's own
 * overrides with the global defaults (mirroring main's `stageSkillsForFolder`),
 * so a folder-flags-only check would false-positive on a folder that inherits
 * a globally-enabled skill with no override of its own. That merge is exactly
 * what the negative case here exercises.
 */

const bundledSkillsGet = vi.fn()
const bundledSkillsGetFolder = vi.fn()
const schedulerRuns = vi.fn(async () => [])
const claudeConfigGetGlobal = vi.fn(async () => ({}))
const claudeConfigListEndpoints = vi.fn(async () => [])

beforeEach(() => {
  bundledSkillsGet.mockReset()
  bundledSkillsGetFolder.mockReset()
  schedulerRuns.mockClear()
  const api = {
    bundledSkillsGet,
    bundledSkillsGetFolder,
    schedulerRuns,
    claudeConfigGetGlobal,
    claudeConfigListEndpoints
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
  for (let i = 0; i < 4; i++) {
    await flushPromises()
    await nextTick()
  }
}

async function openSettings(wrapper: ReturnType<typeof mountDetail>): Promise<void> {
  ;(wrapper.vm as unknown as { openSettingsAndFocusName: () => void }).openSettingsAndFocusName()
  await settle()
}

describe('SchedulerWorkerDetail — folder skills warning (AC-10)', () => {
  it('warns when the folder has no bundled skill enabled anywhere', async () => {
    bundledSkillsGet.mockResolvedValue({
      version: '1',
      catalog: [{ name: 'orchestrate-delivery', description: '' }],
      enabled: { 'orchestrate-delivery': false },
      userLevelInstall: {},
      collisions: []
    })
    bundledSkillsGetFolder.mockResolvedValue({})

    const wrapper = mountDetail()
    await settle()
    await openSettings(wrapper)

    expect(wrapper.text()).toContain('This folder has no bundled skill enabled')
  })

  it('does not warn when the folder itself has a skill enabled', async () => {
    bundledSkillsGet.mockResolvedValue({
      version: '1',
      catalog: [{ name: 'orchestrate-delivery', description: '' }],
      enabled: { 'orchestrate-delivery': false },
      userLevelInstall: {},
      collisions: []
    })
    bundledSkillsGetFolder.mockResolvedValue({ 'orchestrate-delivery': true })

    const wrapper = mountDetail()
    await settle()
    await openSettings(wrapper)

    expect(wrapper.text()).not.toContain('This folder has no bundled skill enabled')
  })

  it('does not warn when the folder merely inherits a globally-enabled skill', async () => {
    // The false-positive this merge guards against: a folder-flags-only check
    // would warn here, since folderSkillFlags has no override of its own.
    bundledSkillsGet.mockResolvedValue({
      version: '1',
      catalog: [{ name: 'orchestrate-delivery', description: '' }],
      enabled: { 'orchestrate-delivery': true },
      userLevelInstall: {},
      collisions: []
    })
    bundledSkillsGetFolder.mockResolvedValue({})

    const wrapper = mountDetail()
    await settle()
    await openSettings(wrapper)

    expect(wrapper.text()).not.toContain('This folder has no bundled skill enabled')
  })
})
