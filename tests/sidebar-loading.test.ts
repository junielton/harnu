// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'

function installWindow(): void {
  // No folders on disk in either scenario below — only `foldersLoading`
  // differs between the two states under test (T180).
  ;(window as unknown as { api: unknown }).api = {
    foldersLoad: vi.fn(async () => []),
    userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
    orchestratorListArmed: vi.fn(async () => []),
    getPathForFile: vi.fn(() => null)
  }
}

describe('Sidebar loading spinner (T180 — cold-boot initial folder scan)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installWindow()
  })
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('shows the spinner + loading label while folders.length === 0 && foldersLoading === true', async () => {
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel() // folders stay empty; foldersLoading is untouched (still true)
    expect(sessionsStore.folders.length).toBe(0)
    expect(sessionsStore.foldersLoading).toBe(true)

    const w = mount(Sidebar, { global: { plugins: [i18n] } })

    expect(w.text()).toContain(w.vm.$t('sidebar.loading'))
    expect(w.text()).not.toContain(w.vm.$t('sidebar.emptyShort'))

    expect(w.find('[data-sidebar-loading]').exists()).toBe(true)
    expect(w.get('[data-sidebar-loading] svg').classes()).toContain('anim-spin')
  })

  it('falls back to the static empty text once loading finishes with no folders', async () => {
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    sessionsStore.foldersLoading = false
    expect(sessionsStore.folders.length).toBe(0)

    const w = mount(Sidebar, { global: { plugins: [i18n] } })

    expect(w.text()).toContain(w.vm.$t('sidebar.emptyShort'))
    expect(w.text()).not.toContain(w.vm.$t('sidebar.loading'))
    expect(w.find('[data-sidebar-loading]').exists()).toBe(false)
  })

  it('never shows the spinner once real folders are present, regardless of foldersLoading', async () => {
    ;(window as unknown as { api: unknown }).api = {
      foldersLoad: vi.fn(async () => [
        { path: '/repos/alpha', alias: 'alpha', gitBranch: '', sessions: [] }
      ]),
      userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
      orchestratorListArmed: vi.fn(async () => []),
      getPathForFile: vi.fn(() => null)
    }
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    sessionsStore.foldersLoading = true // scan still "in flight" from the caller's POV
    expect(sessionsStore.folders.length).toBe(1)

    const w = mount(Sidebar, { global: { plugins: [i18n] } })

    expect(w.text()).not.toContain(w.vm.$t('sidebar.loading'))
    expect(w.find('[data-sidebar-loading]').exists()).toBe(false)
  })
})
