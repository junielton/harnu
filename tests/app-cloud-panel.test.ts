// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import App from '../src/renderer/src/App.vue'
import CloudSessionPanel from '../src/renderer/src/components/CloudSessionPanel.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { i18n } from '@renderer/i18n'

/**
 * BUG-198 — `App.vue` swaps `TerminalPane` for `CloudSessionPanel` when the
 * selected session is a cloud stub. A session whose process is alive in this
 * app run must never be swapped out (G1), and a row classified cloud that
 * later gains a turn must re-render the terminal pane (G5).
 */

function on(): () => (cb: (...a: unknown[]) => void) => () => void {
  return () => () => () => {}
}

function mockApi(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = {
    setAttentionBadge: vi.fn(),
    onUpdateDownloaded: on(),
    onUpdateError: on(),
    onUpdateManualAvailable: on(),
    onClaudeChangelogActivate: on(),
    onClaudeChangelogUpdated: on(),
    onClaudeChangelogNewVersion: on(),
    claudeChangelogGet: vi
      .fn()
      .mockResolvedValue({ releases: [], lastReadVersion: '', lastFetchedAt: 0 }),
    claudeChangelogMarkRead: vi.fn(),
    claudeChangelogRefresh: vi.fn(),
    claudeChangelogOpenExternal: vi.fn(),
    shellOpenExternal: vi.fn(),
    updaterInstallAndRestart: vi.fn(),
    onShortcut: on(),
    helpersGet: vi.fn().mockResolvedValue(null)
  }
}

const STUB_ALL = {
  Sidebar: true,
  Topbar: true,
  StatusFooter: true,
  EmptyState: true,
  FolderView: true,
  CloudSessionPanel: true,
  Onboarding: true,
  TakeoverHost: true,
  InboxRail: true,
  HelperStack: true,
  TerminalPane: true,
  SessionPreview: true,
  FolderPreview: true,
  SessionMenu: true,
  FolderMenu: true,
  SidebarHiddenPopover: true,
  AddFolderDialog: true,
  SettingsDialog: true,
  ClaudeBootDialog: true,
  NewSessionDialog: true,
  RemoveWorktreeDialog: true,
  NewWorktreeDialog: true,
  NewFolderDialog: true,
  OpenSubfolderDialog: true,
  RenameFolderDialog: true,
  RenameRepoDialog: true,
  MemoryLocationDialog: true,
  CommandPalette: true,
  McpConfirmOverlay: true,
  ToastStack: true
}

function mountApp() {
  return mount(App, { global: { plugins: [i18n], stubs: STUB_ALL } })
}

function seedZeroTurnSession(store: ReturnType<typeof useSessionsStore>): void {
  store.folders.push({
    path: '/repo/alpha',
    alias: 'alpha',
    expanded: false,
    sessions: [
      {
        sessionId: 's1',
        projectPath: '/repo/alpha',
        summary: '',
        firstPrompt: '',
        modified: new Date().toISOString(),
        resumable: false
      }
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

const panel = (w: ReturnType<typeof mountApp>) => w.find('cloud-session-panel-stub')

describe('BUG-198: App.vue cloud-panel predicate', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi()
  })

  it('a resumable:false session with no live terminal renders the cloud panel', async () => {
    const store = useSessionsStore()
    seedZeroTurnSession(store)
    store.select('s1')
    const wrapper = mountApp()
    await wrapper.vm.$nextTick()
    expect(panel(wrapper).exists()).toBe(true)
  })

  it('AC-1: a resumable:false session WITH a live terminal never renders the cloud panel', async () => {
    const store = useSessionsStore()
    seedZeroTurnSession(store)
    store.registerLiveSession('s1')
    store.select('s1')
    const wrapper = mountApp()
    await wrapper.vm.$nextTick()
    expect(panel(wrapper).exists()).toBe(false)
  })

  it('AC-1: the panel disappears the moment the terminal goes live under it', async () => {
    const store = useSessionsStore()
    seedZeroTurnSession(store)
    store.select('s1')
    const wrapper = mountApp()
    await wrapper.vm.$nextTick()
    expect(panel(wrapper).exists()).toBe(true)

    store.registerLiveSession('s1')
    await wrapper.vm.$nextTick()
    expect(panel(wrapper).exists()).toBe(false)
  })

  it('AC-6: a row classified cloud re-renders the terminal once disk says resumable:true', async () => {
    const store = useSessionsStore()
    seedZeroTurnSession(store)
    store.select('s1')
    const wrapper = mountApp()
    await wrapper.vm.$nextTick()
    expect(panel(wrapper).exists()).toBe(true)

    // What the next reconcile does when the transcript gains its first turn.
    store.folders[0].sessions[0].resumable = true
    await wrapper.vm.$nextTick()
    expect(panel(wrapper).exists()).toBe(false)
  })
})

describe('BUG-198 AC-4: the cloud panel "Resume anyway" action', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi()
  })

  it('shows the action and pressing it lifts the cloud classification for that session', async () => {
    const store = useSessionsStore()
    seedZeroTurnSession(store)
    store.select('s1')
    const wrapper = mount(CloudSessionPanel, {
      props: { session: store.folders[0].sessions[0] },
      global: { plugins: [i18n] }
    })
    const button = wrapper.find('[data-test="cloud-resume-anyway"]')
    expect(button.exists()).toBe(true)
    expect(button.text()).toBe('Resume anyway')

    await button.trigger('click')
    expect(store.folders[0].sessions[0].resumeAnyway).toBe(true)
  })

  it('App.vue yields to the terminal once the operator resumes anyway', async () => {
    const store = useSessionsStore()
    seedZeroTurnSession(store)
    store.select('s1')
    const wrapper = mountApp()
    await wrapper.vm.$nextTick()
    expect(panel(wrapper).exists()).toBe(true)

    store.resumeAnyway('s1')
    await wrapper.vm.$nextTick()
    expect(panel(wrapper).exists()).toBe(false)
  })
})
