// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import type { FolderEntry } from '../src/preload'

function installWindow(disk: FolderEntry[]): void {
  // Assign onto the real jsdom `window` rather than replacing it outright —
  // replacing `globalThis.window` with a plain object strips the DOM globals
  // (`Event`, etc.) that `@vue/test-utils`' `.trigger()` needs.
  ;(window as unknown as { api: unknown }).api = {
    foldersLoad: vi.fn(async () => disk),
    userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
    orchestratorListArmed: vi.fn(async () => []),
    getPathForFile: vi.fn(() => null)
  }
}

describe('Sidebar toolbar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // jsdom keeps `localStorage` (the persisted sidebar state) alive across tests.
    localStorage.clear()
  })
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  // Rescan (BUG-55 AC6) moved out of the deleted `⋯` menu and into the
  // toolbar as its own button; these two cover the action and its failure
  // path, which the old menu item never had UI coverage for.
  it('runs a folder rescan when the toolbar Rescan button is clicked', async () => {
    installWindow([{ path: '/repos/alpha', alias: 'alpha', gitBranch: '', sessions: [] }])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    const rescan = vi.spyOn(sessionsStore, 'rescan').mockResolvedValue(undefined)

    const w = mount(Sidebar, { global: { plugins: [i18n] } })
    await w.get('[data-sidebar-rescan]').trigger('click')

    expect(rescan).toHaveBeenCalledTimes(1)
  })

  it('raises a danger toast when the rescan fails', async () => {
    installWindow([{ path: '/repos/alpha', alias: 'alpha', gitBranch: '', sessions: [] }])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    vi.spyOn(sessionsStore, 'rescan').mockRejectedValue(new Error('disk gone'))
    const ui = useUiStore()
    const pushToast = vi.spyOn(ui, 'pushToast').mockImplementation(() => '')

    const w = mount(Sidebar, { global: { plugins: [i18n] } })
    await w.get('[data-sidebar-rescan]').trigger('click')
    await flushPromises()

    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'danger', description: 'disk gone' })
    )
  })

  it('spins the Rescan icon only while the scan is in flight', async () => {
    installWindow([{ path: '/repos/alpha', alias: 'alpha', gitBranch: '', sessions: [] }])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    let resolveRescan: () => void = () => {}
    vi.spyOn(sessionsStore, 'rescan').mockReturnValue(
      new Promise((resolve) => {
        resolveRescan = resolve
      })
    )

    const w = mount(Sidebar, { global: { plugins: [i18n] } })
    const icon = () => w.get('[data-sidebar-rescan] svg')
    expect(icon().classes()).not.toContain('anim-spin')

    await w.get('[data-sidebar-rescan]').trigger('click')
    expect(icon().classes()).toContain('anim-spin')

    resolveRescan()
    await flushPromises()
    expect(icon().classes()).not.toContain('anim-spin')
  })

  it('the collapse-cycle icon changes glyph with the derived level', async () => {
    installWindow([
      { path: '/repos/alpha', alias: 'alpha', gitBranch: '', pinned: true, sessions: [] } as never
    ])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    const folder = sessionsStore.folders.find((f) => f.path === '/repos/alpha')!
    folder.pinned = true
    folder.expanded = false

    const w = mount(Sidebar, { global: { plugins: [i18n] } })
    const collapseAllButton = () => w.get(`[title="${w.vm.$t('sidebar.menu.expandAll')}"]`)
    const collapsedIconHtml = collapseAllButton().find('svg').html()

    folder.expanded = true
    await w.vm.$nextTick()
    const expandedIconHtml = w
      .get(`[title="${w.vm.$t('sidebar.menu.collapseFolders')}"]`)
      .find('svg')
      .html()

    // Same button (tooltip flips too, asserted implicitly by re-querying it
    // by the new title above), but the rendered icon markup must differ —
    // a static icon with only the tooltip changing would fail this.
    expect(expandedIconHtml).not.toBe(collapsedIconHtml)
  })
})
