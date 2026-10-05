// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

/**
 * The sidebar filter input used to slide under the macOS traffic lights because
 * the `hiddenInset` title bar lets the renderer paint that corner. The header
 * now reserves `macWindowControlsInset` (78px) of left padding on macOS.
 *
 * `lib/platform.ts` snapshots `navigator.platform` at module load, so this file
 * stubs the global and imports everything dynamically, per case.
 */
async function mountSidebar(platform: string) {
  vi.resetModules()
  vi.stubGlobal('navigator', { platform })
  localStorage.clear()

  const { mount } = await import('@vue/test-utils')
  const { i18n } = await import('@renderer/i18n')
  const Sidebar = (await import('../src/renderer/src/components/Sidebar.vue')).default
  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')

  ;(window as unknown as { api: unknown }).api = {
    foldersLoad: vi.fn(async () => []),
    userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
    orchestratorListArmed: vi.fn(async () => []),
    getPathForFile: vi.fn(() => null)
  }

  const sessions = useSessionsStore()
  await sessions.reloadModel()
  const w = mount(Sidebar, { global: { plugins: [i18n] } })
  return (w.get('header').element as HTMLElement).style.paddingLeft
}

describe('Sidebar header — macOS window-controls inset', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('reserves 78px + 12px of left padding on macOS so the filter clears the traffic lights', async () => {
    expect(await mountSidebar('MacIntel')).toBe('90px')
  })

  it('keeps the plain 12px left padding on non-macOS', async () => {
    expect(await mountSidebar('Linux x86_64')).toBe('12px')
  })
})
