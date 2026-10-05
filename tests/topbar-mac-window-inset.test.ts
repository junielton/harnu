// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

/**
 * When the sidebar is collapsed, the Topbar header becomes the leftmost element
 * and must clear the macOS window controls (traffic lights) painted over the
 * corner by the `hiddenInset` title bar. While the sidebar is open it covers
 * that corner, so no inset is applied. `lib/platform.ts` snapshots
 * `navigator.platform` at module load — stub + dynamic import per case.
 */
async function paddingLeftOf(opts: { platform: string; collapsed: boolean }): Promise<string> {
  vi.resetModules()
  vi.stubGlobal('navigator', { platform: opts.platform })
  localStorage.clear()

  const { mount } = await import('@vue/test-utils')
  const { i18n } = await import('@renderer/i18n')
  const Topbar = (await import('../src/renderer/src/components/Topbar.vue')).default
  const { useLayoutStore } = await import('../src/renderer/src/stores/layout')

  ;(window as unknown as { api: unknown }).api = { openPath: vi.fn(), openInVSCode: vi.fn() }

  const layout = useLayoutStore()
  layout.sidebarCollapsed = opts.collapsed

  const w = mount(Topbar, { global: { plugins: [i18n] } })
  const el = w.get('header').element as HTMLElement
  // The inset is a dynamic `:style` layered over the static `style` that carries
  // the drag region. jsdom's CSS parser silently drops `-webkit-app-region`, so
  // it can't be asserted here — but `height` coming through proves Vue merges
  // the two rather than replacing the static block wholesale.
  expect(el.style.height).toBe('42px')
  return el.style.paddingLeft
}

describe('Topbar header — macOS window-controls inset', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('insets past the traffic lights on macOS when the sidebar is collapsed', async () => {
    expect(await paddingLeftOf({ platform: 'MacIntel', collapsed: true })).toBe('94px')
  })

  it('uses the plain 16px inset on macOS while the sidebar is open', async () => {
    expect(await paddingLeftOf({ platform: 'MacIntel', collapsed: false })).toBe('16px')
  })

  it('never insets on non-macOS, collapsed or not', async () => {
    expect(await paddingLeftOf({ platform: 'Win32', collapsed: true })).toBe('16px')
  })
})
