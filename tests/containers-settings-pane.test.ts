// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ContainersSettingsPane from '../src/renderer/src/components/ContainersSettingsPane.vue'
import { i18n } from '@renderer/i18n'
import { cloneGuardedApi } from './helpers/containers-api'
import type { ContainersPrefs } from '../src/preload'

/**
 * T332 — Settings → Containers. Mounted over a stubbed preload: every control
 * must read U1's prefs and write the whole object back through
 * `containersSetPrefs`, and show what main answered.
 */

const REPO = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

const DEFAULTS: ContainersPrefs = {
  version: 1,
  autoScan: true,
  intervalMs: 3_600_000,
  zombieAfterDays: 2,
  notifyOnNewZombies: true
}

let setPrefs: ReturnType<typeof vi.fn>

async function mountPane(initial: ContainersPrefs = DEFAULTS): Promise<VueWrapper> {
  // Main clamps like `normalizePrefs`: at least one day.
  setPrefs = vi.fn(async (p: ContainersPrefs) => ({
    ...p,
    zombieAfterDays: Math.max(1, p.zombieAfterDays)
  }))
  ;(window as unknown as { api: unknown }).api = cloneGuardedApi({
    containersPrefs: vi.fn(async () => initial),
    containersSetPrefs: setPrefs
  })
  const wrapper = mount(ContainersSettingsPane, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

const sw = (w: VueWrapper, label: string) => w.get(`[role="switch"][aria-label="${label}"]`)
const radio = (w: VueWrapper, text: string) =>
  w.findAll('[role="radio"]').find((b) => b.text() === text)!
const zombieInput = (w: VueWrapper) => w.get('input[aria-label="Zombie after"]')

describe('ContainersSettingsPane', () => {
  it('shows the four controls with the current prefs', async () => {
    const w = await mountPane()
    for (const label of [
      'Scan in the background',
      'Scan every',
      'Zombie after',
      'Notify me about new zombies'
    ]) {
      expect(w.text()).toContain(label)
    }
    expect(sw(w, 'Scan in the background').attributes('aria-checked')).toBe('true')
    expect(radio(w, '1h').attributes('aria-checked')).toBe('true')
    expect((zombieInput(w).element as HTMLInputElement).value).toBe('2')
    expect(sw(w, 'Notify me about new zombies').attributes('aria-checked')).toBe('true')
  })

  it('each toggle and the interval write the whole prefs object through the preload', async () => {
    const w = await mountPane()
    await sw(w, 'Scan in the background').trigger('click')
    await flushPromises()
    expect(setPrefs).toHaveBeenLastCalledWith({ ...DEFAULTS, autoScan: false })
    // The interval only matters while the scan is on.
    expect(radio(w, '6h').attributes('disabled')).toBeDefined()

    await sw(w, 'Scan in the background').trigger('click')
    await flushPromises()
    await radio(w, '6h').trigger('click')
    await flushPromises()
    expect(setPrefs).toHaveBeenLastCalledWith({ ...DEFAULTS, intervalMs: 21_600_000 })

    await sw(w, 'Notify me about new zombies').trigger('click')
    await flushPromises()
    expect(setPrefs).toHaveBeenLastCalledWith({
      ...DEFAULTS,
      intervalMs: 21_600_000,
      notifyOnNewZombies: false
    })
  })

  it('Zombie after writes once the typing settles, and shows what main kept', async () => {
    const w = await mountPane()
    await zombieInput(w).setValue('4')
    expect(setPrefs).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(setPrefs).toHaveBeenCalledWith({ ...DEFAULTS, zombieAfterDays: 4 })
    )

    await zombieInput(w).setValue('0')
    await vi.waitFor(() =>
      expect(setPrefs).toHaveBeenLastCalledWith({ ...DEFAULTS, zombieAfterDays: 1 })
    )
    await flushPromises()
    expect((zombieInput(w).element as HTMLInputElement).value).toBe('1')
  })

  it('says worktree stacks are cleaned by Cleanup and links to its settings', async () => {
    const w = await mountPane()
    expect(w.find('[data-testid="containers-gc-note"]').exists()).toBe(true)
    await w.get('[data-testid="containers-open-cleanup-settings"]').trigger('click')
    // The Settings dialog owns the tab switch; the pane only asks for it.
    expect(w.emitted('navigate')).toEqual([['cleanup']])
    // The note replaced the old "so the footer pill stays current" intro: that pill is gone.
    expect(read('src/renderer/src/components/ContainersSettingsPane.vue')).not.toContain(
      "'containers.settings.intro'"
    )
  })

  it('is a Settings tab of its own, labelled in both locales', () => {
    const dialog = read('src/renderer/src/components/SettingsDialog.vue')
    expect(dialog).toContain("id: 'containers'")
    expect(dialog).toMatch(
      /<ContainersSettingsPane\s+v-else-if="activeTab === 'containers'"\s+@navigate="goToTab"\s*\/>/
    )
    expect(read('src/renderer/src/stores/ui.ts')).toMatch(/\| 'containers'\n {2}\| 'prStack'/)
    for (const locale of ['en', 'pt-BR']) {
      const msgs = JSON.parse(read(`src/renderer/src/i18n/${locale}.json`))
      expect(msgs.settings.tabs.containers).toBe('Containers')
    }
  })
})
