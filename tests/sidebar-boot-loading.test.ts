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
 * With drill-in on and a persisted drill stack (T289), the sidebar used to mount
 * the drill view (a Back row over an empty list) while the folder model was still
 * loading, hiding the "Loading folders…" spinner; the main pane meanwhile showed
 * the "Welcome to Harnu" onboarding as if the user had no folders.
 */

const DRILL_STACK_KEY = 'om2tab.sidebarDrillStack'
const DRILL_DEPTH_KEY = 'om2tab.sidebarDrillDepth'

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

function seedPersistedDrillStack(): void {
  localStorage.setItem(DRILL_DEPTH_KEY, '2')
  localStorage.setItem(
    DRILL_STACK_KEY,
    JSON.stringify([
      { kind: 'group', key: 'repo:repo-x' },
      { kind: 'folder', path: '/repos/alpha/wt-b' }
    ])
  )
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

describe('Sidebar cold boot with a restored drill stack (BUG-257)', () => {
  it('AC-1: shows the loading state, not the drill view, while the folder model loads', async () => {
    seedPersistedDrillStack()
    const { release } = installGatedWindow(REPO)
    const store = useSessionsStore()
    expect(store.drillStack).toHaveLength(2)

    wrapper = mount(Sidebar, { global: { plugins: [i18n] }, attachTo: document.body })
    const boot = store.init()
    await flushPromises()

    expect(store.foldersLoading).toBe(true)
    expect(store.folders).toHaveLength(0)
    expect(wrapper.find('[data-sidebar-loading]').exists()).toBe(true)
    expect(wrapper.find('[data-drill-back]').exists()).toBe(false)

    release()
    await boot
  })

  it('AC-2: once loaded, the restored drill screen renders (T289 restore kept)', async () => {
    seedPersistedDrillStack()
    const { release } = installGatedWindow(REPO)
    const store = useSessionsStore()

    wrapper = mount(Sidebar, { global: { plugins: [i18n] }, attachTo: document.body })
    const boot = store.init()
    await flushPromises()
    release()
    await boot
    await flushPromises()

    expect(store.foldersLoading).toBe(false)
    expect(store.drillStack).toEqual([
      { kind: 'group', key: 'repo:repo-x' },
      { kind: 'folder', path: '/repos/alpha/wt-b' }
    ])
    expect(wrapper.find('[data-sidebar-loading]').exists()).toBe(false)
    expect(wrapper.find('[data-drill-back]').exists()).toBe(true)
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
      'InboxRail',
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

  it('AC-3a: renders no onboarding while foldersLoading is true', async () => {
    installGatedWindow([])
    const store = useSessionsStore()
    expect(store.foldersLoading).toBe(true)
    expect(store.folders).toHaveLength(0)

    wrapper = mount(App, { attachTo: document.body, global: { plugins: [i18n], stubs: STUBS } })
    await flushPromises()

    expect(wrapper.find('onboarding-stub').exists()).toBe(false)
  })

  it('AC-3b: still renders onboarding once loading finished with zero folders', async () => {
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
