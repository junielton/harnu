// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { ChevronsDownUp, ChevronsUpDown, Columns2, Columns3, ListTree } from 'lucide-vue-next'
import { i18n } from '@renderer/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import type { FolderEntry } from '../src/preload'

function installWindow(disk: FolderEntry[]): void {
  // Assign onto the real jsdom `window` rather than replacing it outright —
  // replacing `globalThis.window` with a plain object strips the DOM globals
  // (`Event`, etc.) that `@vue/test-utils`' `.trigger()` needs, breaking the
  // click assertion below. `sidebar-drill-view.test.ts` and
  // `markdown-pane-edit.test.ts` use the same merge-onto-window pattern for
  // the same reason.
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
    // `drillModeEnabled` is a persistedRef backed by localStorage, which
    // jsdom keeps alive across tests in this file (unlike Pinia state) —
    // without this, toggling drill mode on in one test leaks into the next.
    localStorage.clear()
  })
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('cycles the drill button 0 → 1 → 2 → 0, swapping the icon and switching to SidebarDrillView', async () => {
    installWindow([{ path: '/repos/alpha', alias: 'alpha', gitBranch: '', sessions: [] }])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()

    const w = mount(Sidebar, { global: { plugins: [i18n] } })
    expect(w.find('[data-drill-toggle]').exists()).toBe(true)
    expect(w.findComponent({ name: 'SidebarDrillView' }).exists()).toBe(false)
    // lucide-vue-next icons are anonymous functional components (no `name`
    // option), so `findComponent({ name: '...' })` never matches them —
    // match by the imported component reference instead.
    expect(w.get('[data-drill-toggle]').findComponent(ListTree).exists()).toBe(true)

    await w.get('[data-drill-toggle]').trigger('click')
    expect(sessionsStore.drillDepth).toBe(1)
    expect(w.findComponent({ name: 'SidebarDrillView' }).exists()).toBe(true)
    expect(w.get('[data-drill-toggle]').findComponent(Columns2).exists()).toBe(true)

    await w.get('[data-drill-toggle]').trigger('click')
    expect(sessionsStore.drillDepth).toBe(2)
    expect(w.get('[data-drill-toggle]').findComponent(Columns3).exists()).toBe(true)

    await w.get('[data-drill-toggle]').trigger('click')
    expect(sessionsStore.drillDepth).toBe(0)
    expect(w.findComponent({ name: 'SidebarDrillView' }).exists()).toBe(false)
  })

  it('keeps Collapse all available at depth 1 (inline folders exist) and hides it at depth 2', async () => {
    installWindow([{ path: '/repos/alpha', alias: 'alpha', gitBranch: '', sessions: [] }])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()

    const w = mount(Sidebar, { global: { plugins: [i18n] } })
    const collapseAll = (): boolean =>
      w.get('[role="toolbar"]').findComponent(ChevronsUpDown).exists() ||
      w.get('[role="toolbar"]').findComponent(ChevronsDownUp).exists()

    expect(collapseAll()).toBe(true)

    sessionsStore.drillDepth = 1
    await w.vm.$nextTick()
    expect(collapseAll()).toBe(true)

    sessionsStore.drillDepth = 2
    await w.vm.$nextTick()
    expect(collapseAll()).toBe(false)
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

  it('the Collapse-all icon changes glyph with the expand/collapse state, not just the tooltip', async () => {
    installWindow([
      { path: '/repos/alpha', alias: 'alpha', gitBranch: '', pinned: true, sessions: [] } as never
    ])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    const folder = sessionsStore.folders.find((f) => f.path === '/repos/alpha')!
    folder.expanded = false

    const w = mount(Sidebar, { global: { plugins: [i18n] } })
    const collapseAllButton = () => w.get(`[title="${w.vm.$t('sidebar.menu.expandAll')}"]`)
    const collapsedIconHtml = collapseAllButton().find('svg').html()

    folder.expanded = true
    await w.vm.$nextTick()
    const expandedIconHtml = w
      .get(`[title="${w.vm.$t('sidebar.menu.collapseAll')}"]`)
      .find('svg')
      .html()

    // Same button (tooltip flips too, asserted implicitly by re-querying it
    // by the new title above), but the rendered icon markup must differ —
    // a static icon with only the tooltip changing would fail this.
    expect(expandedIconHtml).not.toBe(collapsedIconHtml)
  })

  // Superseded by the three-level depth model: Collapse-all now hides only
  // at depth 2 (nothing left for it to act on), not at depth 1 (folders
  // still render inline — see the 'keeps Collapse all available…' test
  // above). Updated to drive the toggle to depth 2 instead of asserting
  // hidden after a single click.
  it('hides the Collapse-all button once drill-in reaches depth 2, since it has nothing to act on', async () => {
    installWindow([{ path: '/repos/alpha', alias: 'alpha', gitBranch: '', sessions: [] }])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()

    const w = mount(Sidebar, { global: { plugins: [i18n] } })
    expect(
      w.find(`[title="${w.vm.$t('sidebar.menu.expandAll')}"]`).exists() ||
        w.find(`[title="${w.vm.$t('sidebar.menu.collapseAll')}"]`).exists()
    ).toBe(true)

    await w.get('[data-drill-toggle]').trigger('click')
    await w.get('[data-drill-toggle]').trigger('click')

    expect(w.find(`[title="${w.vm.$t('sidebar.menu.expandAll')}"]`).exists()).toBe(false)
    expect(w.find(`[title="${w.vm.$t('sidebar.menu.collapseAll')}"]`).exists()).toBe(false)
  })
})
