// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import Topbar from '../src/renderer/src/components/Topbar.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { i18n } from '@renderer/i18n'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

/**
 * T630 (floating layout S-4) — Browser has its own Topbar button next to the Terminal one. The old
 * "Split" chevron dropdown only listed Terminal (the button's own one-click action) and Browser, so
 * with Browser out it is gone and Terminal stays a plain button.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const folder: any = {
  path: '/repo/alpha',
  alias: 'alpha',
  expanded: true,
  gitBranch: 'main',
  sessions: []
}

function mountTopbar() {
  return mount(Topbar, { attachTo: document.body, global: { plugins: [i18n] } })
}

describe('topbar browser button', () => {
  const browserOpen = vi.fn()

  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    const store = useSessionsStore()
    store.folders.splice(0, store.folders.length, folder)
    store.selectFolder('/repo/alpha')
    browserOpen.mockReset().mockResolvedValue({ ok: true, paneId: 'pane-1' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      openPath: vi.fn(),
      openInEditor: vi.fn(),
      githubPullsUrl: vi.fn().mockResolvedValue(null),
      shellOpenExternal: vi.fn(),
      browserOpen
    }
  })

  it('opens a browser pane', async () => {
    const helpers = useHelpersStore()
    const wrapper = mountTopbar()

    const button = wrapper.get('[data-test="topbar-browser"]')
    expect(button.attributes('aria-label')).toBe(en.topbar.browser)
    expect(button.attributes('title')).toContain(en.topbar.browser)
    await button.trigger('click')
    await flushPromises()

    // One click, the same call and the same operator-class pane the dropdown item made.
    expect(browserOpen).toHaveBeenCalledTimes(1)
    expect(browserOpen).toHaveBeenCalledWith({ folder: '/repo/alpha' })
    const panes = helpers.stateForCurrentWorktree?.panes ?? []
    expect(panes).toHaveLength(1)
    expect(JSON.stringify(panes[0])).toContain('pane-1')
  })

  it('sits right next to the terminal button', () => {
    const wrapper = mountTopbar()
    const terminal = wrapper.get('[data-test="topbar-split"]').element
    expect(terminal.nextElementSibling).toBe(wrapper.get('[data-test="topbar-browser"]').element)
  })

  it('dropdown without browser', async () => {
    const sessions = useSessionsStore()
    const createFolderTerminal = vi.spyOn(sessions, 'createFolderTerminal')
    const wrapper = mountTopbar()

    // Terminal was the dropdown's only other item, so the dropdown is gone: no chevron, no menu, no
    // Browser item anywhere.
    expect(wrapper.find('[data-test="topbar-split-menu"]').exists()).toBe(false)
    expect(document.querySelector('[data-test="split-menu"]')).toBeNull()
    expect(document.querySelector('[data-test="split-menu-browser"]')).toBeNull()

    // The Terminal button still opens a terminal in one click, and does not open a browser.
    await wrapper.get('[data-test="topbar-split"]').trigger('click')
    expect(createFolderTerminal).toHaveBeenCalledWith('/repo/alpha')
    expect(browserOpen).not.toHaveBeenCalled()
  })

  it('has the label in both locales', () => {
    expect(en.topbar.browser).toBeTruthy()
    expect(ptBR.topbar.browser).toBeTruthy()
    expect(ptBR.topbar.browser).not.toBe('')
  })
})
