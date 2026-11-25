// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import App from '../src/renderer/src/App.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { FolderEntry } from '../src/preload'

/**
 * BUG-257 — a cold boot reads as "loading", not "empty".
 *
 * The sidebar must never stand over a blank list: the loading, "nothing yet" and
 * "no matches" states show where the operator is looking — the full list, or the
 * focused folder under its back row (design.md §6 "Sidebar tree → Focus"; the
 * persisted position was the drill stack before Focus replaced drill-in). The
 * main pane must not show the "Welcome to Harnu" onboarding while folders load.
 */

const FOCUS_KEY = 'om2tab.sidebarFocus'

function session(id: string, projectPath: string): FolderEntry['sessions'][number] {
  const now = new Date().toISOString()
  return {
    sessionId: id,
    fullPath: `${projectPath}/${id}.jsonl`,
    fileMtime: 1,
    firstPrompt: '',
    summary: id,
    messageCount: 1,
    created: now,
    modified: now,
    gitBranch: '',
    projectPath,
    isSidechain: false,
    status: 'idle',
    agents: [],
    resumable: true,
    bridged: false
  } as FolderEntry['sessions'][number]
}

const REPO: FolderEntry[] = [
  {
    path: '/repos/alpha/main',
    alias: 'main',
    gitBranch: 'main',
    repoId: 'repo-x',
    isMainWorktree: true,
    sessions: [session('s1', '/repos/alpha/main')]
  },
  {
    path: '/repos/alpha/wt-b',
    alias: 'wt-b',
    gitBranch: 'wt-b',
    repoId: 'repo-x',
    sessions: [session('s2', '/repos/alpha/wt-b')]
  }
] as FolderEntry[]

const none = (): (() => void) => () => {}

/** `foldersLoad` resolves only when the test calls `release()` — a controllable cold boot. */
function installGatedWindow(disk: FolderEntry[]): { release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const base: Record<string, unknown> = {
    foldersLoad: vi.fn(async () => {
      await gate
      return disk
    }),
    userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
    orchestratorListArmed: vi.fn(async () => []),
    getPathForFile: vi.fn(() => null),
    claudeChangelogGet: vi.fn(async () => ({
      releases: [],
      lastReadVersion: '',
      lastFetchedAt: 0
    })),
    helpersGet: vi.fn(async () => null)
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(base, {
    get: (target, key: string) => {
      if (key in target) return target[key]
      return key.startsWith('on') ? none : vi.fn(async () => null)
    }
  })
  return { release }
}

function seedFocus(path = '/repos/alpha/main'): void {
  localStorage.setItem(FOCUS_KEY, JSON.stringify(path))
}

let wrapper: VueWrapper | null = null

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
  setActivePinia(createPinia())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
  localStorage.clear()
})

describe('Sidebar status states, full list and focused folder (BUG-257)', () => {
  async function bootLoaded(): Promise<ReturnType<typeof useSessionsStore>> {
    const { release } = installGatedWindow(REPO)
    const store = useSessionsStore()
    wrapper = mount(Sidebar, { global: { plugins: [i18n] }, attachTo: document.body })
    const boot = store.init()
    release()
    await boot
    await flushPromises()
    return store
  }

  it('AC-1: shows the loading state UNDER the back row of a restored focus while folders load', async () => {
    seedFocus()
    const { release } = installGatedWindow(REPO)
    const store = useSessionsStore()

    wrapper = mount(Sidebar, { global: { plugins: [i18n] }, attachTo: document.body })
    const boot = store.init()
    await flushPromises()

    expect(store.foldersLoading).toBe(true)
    expect(store.folders).toHaveLength(0)
    // The operator keeps their place: the back row stays, the loader under it.
    const back = wrapper.find('[data-focus-back]')
    const loading = wrapper.find('[data-sidebar-loading]')
    expect(back.exists()).toBe(true)
    expect(loading.exists()).toBe(true)
    expect(
      back.element.compareDocumentPosition(loading.element) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(loading.text()).toContain('Loading folders')
    // Nothing is counted yet, and nothing reads as an empty list.
    expect(wrapper.find('[data-focus-back-meta]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain(i18n.global.t('sidebar.emptyShort'))

    release()
    await boot
  })

  it('AC-1: the full list shows the loading state with no focus', async () => {
    const { release } = installGatedWindow(REPO)
    const store = useSessionsStore()

    wrapper = mount(Sidebar, { global: { plugins: [i18n] }, attachTo: document.body })
    const boot = store.init()
    await flushPromises()

    expect(wrapper.find('[data-sidebar-loading]').exists()).toBe(true)
    expect(wrapper.find('[data-focus-back]').exists()).toBe(false)

    release()
    await boot
  })

  it('AC-2: a filter that matches nothing says so under the back row, not a blank body', async () => {
    seedFocus()
    const store = await bootLoaded()
    expect(wrapper!.find('[data-focus-back]').exists()).toBe(true)

    store.filterQuery = 'zzz-no-folder-matches-this'
    await flushPromises()

    expect(wrapper!.find('[data-focus-back]').exists()).toBe(true)
    expect(wrapper!.text()).toContain(i18n.global.t('sidebar.filter.empty'))
    expect(wrapper!.findAll('[data-tree-folder]')).toHaveLength(0)
  })

  it('AC-2: an emptied folder list shows the "nothing yet" message, not a blank body', async () => {
    seedFocus()
    const store = await bootLoaded()

    // The folders vanish while one is focused (e.g. every worktree removed).
    store.folders = []
    await flushPromises()

    expect(wrapper!.text()).toContain(i18n.global.t('sidebar.emptyShort'))
    expect(wrapper!.find('[data-sidebar-loading]').exists()).toBe(false)
  })

  it('AC-4: once loaded, the restored focus resolves to its folder', async () => {
    seedFocus()
    const store = await bootLoaded()

    expect(store.foldersLoading).toBe(false)
    expect(wrapper!.find('[data-sidebar-loading]').exists()).toBe(false)
    expect(wrapper!.find('[data-focus-back]').exists()).toBe(true)
    expect(wrapper!.findAll('[data-tree-folder]')).toHaveLength(1)
  })

  it('AC-4: a restored focus that no longer resolves is dropped once loaded', async () => {
    seedFocus('/repos/gone')
    await bootLoaded()

    expect(wrapper!.find('[data-focus-back]').exists()).toBe(false)
    expect(wrapper!.find('[data-sidebar-loading]').exists()).toBe(false)
    expect(wrapper!.findAll('[data-tree-folder]')).toHaveLength(1)
  })
})

describe('App onboarding while folders load (BUG-257)', () => {
  const STUBS = Object.fromEntries(
    [
      'Sidebar',
      'Topbar',
      'StatusFooter',
      'EmptyState',
      'FolderView',
      'CloudSessionPanel',
      'Onboarding',
      'TakeoverHost',
      'HelperStack',
      'TerminalPane',
      'SessionPreview',
      'FolderPreview',
      'SessionMenu',
      'FolderMenu',
      'SidebarHiddenPopover',
      'AddFolderDialog',
      'SettingsDialog',
      'ClaudeBootDialog',
      'NewSessionDialog',
      'RemoveWorktreeDialog',
      'NewWorktreeDialog',
      'NewFolderDialog',
      'OpenSubfolderDialog',
      'RenameFolderDialog',
      'RenameRepoDialog',
      'MemoryLocationDialog',
      'CommandPalette',
      'McpConfirmOverlay',
      'ToastStack'
    ].map((n) => [n, true])
  )

  it('onboarding-a: renders no onboarding while foldersLoading is true', async () => {
    installGatedWindow([])
    const store = useSessionsStore()
    expect(store.foldersLoading).toBe(true)
    expect(store.folders).toHaveLength(0)

    wrapper = mount(App, { attachTo: document.body, global: { plugins: [i18n], stubs: STUBS } })
    await flushPromises()

    expect(wrapper.find('onboarding-stub').exists()).toBe(false)
  })

  it('onboarding-b: still renders onboarding once loading finished with zero folders', async () => {
    const { release } = installGatedWindow([])
    const store = useSessionsStore()

    wrapper = mount(App, { attachTo: document.body, global: { plugins: [i18n], stubs: STUBS } })
    const boot = store.init()
    release()
    await boot
    await flushPromises()

    expect(store.foldersLoading).toBe(false)
    expect(wrapper.find('onboarding-stub').exists()).toBe(true)
  })
})
