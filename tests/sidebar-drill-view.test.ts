// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import SidebarDrillView from '../src/renderer/src/components/SidebarDrillView.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import type { FolderEntry } from '../src/preload'

function installWindow(disk: FolderEntry[]): void {
  // Assign onto the real jsdom `window` rather than replacing it outright —
  // replacing `globalThis.window` with a plain object strips the DOM globals
  // (`Event`, etc.) that `@vue/test-utils`' `.trigger()` needs, breaking the
  // click assertions below. `markdown-pane-edit.test.ts` uses the same
  // merge-onto-window pattern for the same reason.
  ;(window as unknown as { api: unknown }).api = {
    foldersLoad: vi.fn(async () => disk),
    userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
    orchestratorListArmed: vi.fn(async () => [])
  }
}

function session(id: string): FolderEntry['sessions'][number] {
  const now = new Date().toISOString()
  return {
    sessionId: id,
    fullPath: `/repos/${id}.jsonl`,
    fileMtime: 1,
    firstPrompt: '',
    summary: id,
    messageCount: 1,
    created: now,
    modified: now,
    gitBranch: '',
    projectPath: '/repos/alpha',
    isSidechain: false,
    status: 'idle',
    agents: [],
    resumable: true,
    bridged: false
  } as FolderEntry['sessions'][number]
}

describe('SidebarDrillView', () => {
  beforeEach(() => {
    // The drill stack is persisted (T289), so one test's drilling would be
    // restored by the next store instance — clear it between cases.
    localStorage.clear()
    setActivePinia(createPinia())
  })
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
    localStorage.clear()
  })

  it('root screen lists a group row and a standalone folder row', async () => {
    installWindow([
      {
        path: '/repos/alpha/main',
        alias: 'main',
        gitBranch: 'main',
        repoId: 'repo-x',
        isMainWorktree: true,
        sessions: [session('s1')]
      },
      {
        path: '/repos/alpha/wt-b',
        alias: 'wt-b',
        gitBranch: 'wt-b',
        repoId: 'repo-x',
        sessions: [session('s2')]
      },
      { path: '/repos/solo', alias: 'solo', gitBranch: '', sessions: [session('s3')] }
    ])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    sessionsStore.drillDepth = 2

    const w = mount(SidebarDrillView, { global: { plugins: [i18n] } })

    expect(w.text()).toContain('solo')
    // The group row shows a derived label (the main worktree's alias), not the raw repoId.
    expect(w.text()).toContain('main')
  })

  it('clicking into a group shows its member folders; clicking a folder shows its sessions headerless', async () => {
    installWindow([
      {
        path: '/repos/alpha/main',
        alias: 'main',
        gitBranch: 'main',
        repoId: 'repo-x',
        isMainWorktree: true,
        sessions: [session('s1')]
      },
      {
        path: '/repos/alpha/wt-b',
        alias: 'wt-b',
        gitBranch: 'wt-b',
        repoId: 'repo-x',
        sessions: [session('s2')]
      }
    ])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    sessionsStore.drillDepth = 2
    sessionsStore.drillIntoGroup('repo:repo-x')

    const w = mount(SidebarDrillView, { global: { plugins: [i18n] } })
    expect(w.text()).toContain('wt-b')

    await w.get('[data-drill-folder-row="/repos/alpha/wt-b"]').trigger('click')
    expect(sessionsStore.drillStack).toEqual([
      { kind: 'group', key: 'repo:repo-x' },
      { kind: 'folder', path: '/repos/alpha/wt-b' }
    ])
  })

  it('back button pops the drill stack', async () => {
    installWindow([
      { path: '/repos/solo', alias: 'solo', gitBranch: '', sessions: [session('s1')] }
    ])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    sessionsStore.drillDepth = 2
    sessionsStore.drillIntoFolder('/repos/solo')

    const w = mount(SidebarDrillView, { global: { plugins: [i18n] } })
    await w.get('[data-drill-back]').trigger('click')

    expect(sessionsStore.drillStack).toEqual([])
  })

  it('clicking anywhere on the back row (not just the chevron icon) goes back', async () => {
    installWindow([
      { path: '/repos/solo', alias: 'solo', gitBranch: '', sessions: [session('s1')] }
    ])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    sessionsStore.drillDepth = 2
    sessionsStore.drillIntoFolder('/repos/solo')

    const w = mount(SidebarDrillView, { global: { plugins: [i18n] } })
    // The whole row is a single <button> — clicking its title text (not an
    // icon) must still fire the row's own click handler via normal DOM
    // bubbling, proving there's no icon-only click target.
    await w.get('[data-drill-back] span').trigger('click')

    expect(sessionsStore.drillStack).toEqual([])
  })

  it('folder screen shows a New session action on the back row that opens without going back', async () => {
    installWindow([
      { path: '/repos/solo', alias: 'solo', gitBranch: '', sessions: [session('s1')] }
    ])
    const sessionsStore = useSessionsStore()
    const ui = useUiStore()
    await sessionsStore.reloadModel()
    sessionsStore.drillDepth = 2
    sessionsStore.drillIntoFolder('/repos/solo')
    const openSpy = vi.spyOn(ui, 'openNewSession')

    const w = mount(SidebarDrillView, { global: { plugins: [i18n] } })
    await w.get('[data-drill-new-session]').trigger('click')

    expect(openSpy).toHaveBeenCalledWith('/repos/solo')
    expect(sessionsStore.drillStack).toEqual([{ kind: 'folder', path: '/repos/solo' }])
  })

  it('the repo screen has no New session action (only a folder screen hosts sessions)', async () => {
    installWindow([
      {
        path: '/repos/alpha/main',
        alias: 'main',
        gitBranch: 'main',
        repoId: 'repo-x',
        isMainWorktree: true,
        sessions: [session('s1')]
      },
      {
        path: '/repos/alpha/wt-b',
        alias: 'wt-b',
        gitBranch: 'wt-b',
        repoId: 'repo-x',
        sessions: [session('s2')]
      }
    ])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    sessionsStore.drillDepth = 2
    sessionsStore.drillIntoGroup('repo:repo-x')

    const w = mount(SidebarDrillView, { global: { plugins: [i18n] } })

    expect(w.find('[data-drill-new-session]').exists()).toBe(false)
  })

  it('at depth 1 a group screen renders its folders inline instead of as drillable rows', async () => {
    installWindow([
      {
        path: '/repos/alpha/main',
        alias: 'main',
        gitBranch: 'main',
        repoId: 'repo-x',
        isMainWorktree: true,
        sessions: [session('s1')]
      },
      {
        path: '/repos/alpha/wt-b',
        alias: 'wt-b',
        gitBranch: 'wt-b',
        repoId: 'repo-x',
        sessions: [session('s2')]
      },
      // Not a member of repo-x — proves the fallback renders `groupScreen.folders`,
      // not the full `rootNodes`/`visibleFolders` list (which would also include this).
      { path: '/repos/solo', alias: 'solo', gitBranch: '', sessions: [session('s3')] }
    ])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    sessionsStore.drillDepth = 1
    sessionsStore.drillIntoGroup('repo:repo-x')

    const w = mount(SidebarDrillView, { global: { plugins: [i18n] } })

    // No chooser rows — the sibling worktrees are real, expandable folder rows.
    expect(w.find('[data-drill-folder-row="/repos/alpha/wt-b"]').exists()).toBe(false)
    const rendered = w.findAllComponents({ name: 'SidebarFolder' })
    expect(rendered.length).toBe(2)
    expect(rendered.map((c) => c.props('folder').path)).toEqual([
      '/repos/alpha/main',
      '/repos/alpha/wt-b'
    ])
    expect(w.text()).toContain('wt-b')
    expect(w.text()).toContain('main')
  })

  it('at depth 2 the same group screen still renders drillable folder rows', async () => {
    installWindow([
      {
        path: '/repos/alpha/main',
        alias: 'main',
        gitBranch: 'main',
        repoId: 'repo-x',
        isMainWorktree: true,
        sessions: [session('s1')]
      },
      {
        path: '/repos/alpha/wt-b',
        alias: 'wt-b',
        gitBranch: 'wt-b',
        repoId: 'repo-x',
        sessions: [session('s2')]
      }
    ])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    sessionsStore.drillDepth = 2
    sessionsStore.drillIntoGroup('repo:repo-x')

    const w = mount(SidebarDrillView, { global: { plugins: [i18n] } })

    expect(w.find('[data-drill-folder-row="/repos/alpha/wt-b"]').exists()).toBe(true)
    expect(w.findAllComponents({ name: 'SidebarFolder' }).length).toBe(0)
  })

  // ── Row actions (T289 — right-click + trailing ⋯) ────────────────────────

  it('AC-1 — right-clicking the folder screen back row opens FolderMenu for that folder', async () => {
    installWindow([
      { path: '/repos/solo', alias: 'solo', gitBranch: '', sessions: [session('s1')] }
    ])
    const sessionsStore = useSessionsStore()
    const ui = useUiStore()
    await sessionsStore.reloadModel()
    sessionsStore.drillDepth = 2
    sessionsStore.drillIntoFolder('/repos/solo')

    const w = mount(SidebarDrillView, { global: { plugins: [i18n] } })
    await w.get('[data-drill-back]').trigger('contextmenu')

    expect(ui.folderMenu.open).toBe(true)
    expect(ui.folderMenu.projectPath).toBe('/repos/solo')
    // Right-click must not also navigate back.
    expect(sessionsStore.drillStack).toEqual([{ kind: 'folder', path: '/repos/solo' }])
  })

  it('AC-2 — the folder screen back row has a trailing ⋯ that opens the same menu without going back', async () => {
    installWindow([
      { path: '/repos/solo', alias: 'solo', gitBranch: '', sessions: [session('s1')] }
    ])
    const sessionsStore = useSessionsStore()
    const ui = useUiStore()
    await sessionsStore.reloadModel()
    sessionsStore.drillDepth = 2
    sessionsStore.drillIntoFolder('/repos/solo')

    const w = mount(SidebarDrillView, { global: { plugins: [i18n] } })
    const actions = w.get('[data-drill-back-actions]')
    // Placed immediately after the `+` (New session) in the same trailing cluster.
    const cluster = w.get('[data-drill-new-session]').element.parentElement
    const order = [...(cluster?.children ?? [])]
    expect(order.indexOf(w.get('[data-drill-new-session]').element)).toBe(
      order.indexOf(actions.element) - 1
    )

    await actions.trigger('click')
    expect(ui.folderMenu.open).toBe(true)
    expect(ui.folderMenu.projectPath).toBe('/repos/solo')
    expect(sessionsStore.drillStack).toEqual([{ kind: 'folder', path: '/repos/solo' }])
  })

  it('AC-3 — the repo screen back row opens the group menu on right-click and on its ⋯', async () => {
    installWindow([
      {
        path: '/repos/alpha/main',
        alias: 'main',
        gitBranch: 'main',
        repoId: 'repo-x',
        isMainWorktree: true,
        sessions: [session('s1')]
      },
      {
        path: '/repos/alpha/wt-b',
        alias: 'wt-b',
        gitBranch: 'wt-b',
        repoId: 'repo-x',
        sessions: [session('s2')]
      }
    ])
    const sessionsStore = useSessionsStore()
    const ui = useUiStore()
    await sessionsStore.reloadModel()
    sessionsStore.drillDepth = 2
    sessionsStore.drillIntoGroup('repo:repo-x')

    const w = mount(SidebarDrillView, { global: { plugins: [i18n], stubs: { teleport: true } } })

    await w.get('[data-drill-back]').trigger('contextmenu')
    expect(w.find('[data-drill-group-menu]').exists()).toBe(true)
    // The group menu, not the folder one.
    expect(ui.folderMenu.open).toBe(false)
    expect(w.get('[data-drill-group-menu]').text()).toContain(i18n.global.t('repoGroup.rename'))
    // Rename routes to the same ui action `RepoGroupHeader` uses.
    const renameSpy = vi.spyOn(ui, 'openRenameRepo')
    await w.get('[data-drill-group-menu] button').trigger('click')
    expect(renameSpy).toHaveBeenCalledWith('repo:repo-x', expect.any(String))
    expect(w.find('[data-drill-group-menu]').exists()).toBe(false)

    // …and the same menu from the back row's ⋯.
    await w.get('[data-drill-back-actions]').trigger('click')
    expect(w.find('[data-drill-group-menu]').exists()).toBe(true)
    expect(sessionsStore.drillStack).toEqual([{ kind: 'group', key: 'repo:repo-x' }])
  })

  it('AC-4 — root screen chooser rows carry a hover-only ⋯ and the menu matching their kind', async () => {
    installWindow([
      {
        path: '/repos/alpha/main',
        alias: 'main',
        gitBranch: 'main',
        repoId: 'repo-x',
        isMainWorktree: true,
        sessions: [session('s1')]
      },
      {
        path: '/repos/alpha/wt-b',
        alias: 'wt-b',
        gitBranch: 'wt-b',
        repoId: 'repo-x',
        sessions: [session('s2')]
      },
      { path: '/repos/solo', alias: 'solo', gitBranch: '', sessions: [session('s3')] }
    ])
    const sessionsStore = useSessionsStore()
    const ui = useUiStore()
    await sessionsStore.reloadModel()
    sessionsStore.drillDepth = 2

    const w = mount(SidebarDrillView, { global: { plugins: [i18n], stubs: { teleport: true } } })

    // "Stats on demand": invisible at rest, space preserved (a fixed-size box
    // that is always in the DOM), revealed on hover/focus.
    const folderActions = w.get('[data-drill-row-actions="/repos/solo"]')
    expect(folderActions.classes()).toContain('opacity-0')
    expect(folderActions.classes()).toContain('group-hover:opacity-100')
    expect(folderActions.attributes('style')).toContain('width: 20px')

    // A folder row → FolderMenu.
    await folderActions.trigger('click')
    expect(ui.folderMenu.open).toBe(true)
    expect(ui.folderMenu.projectPath).toBe('/repos/solo')
    // …and it did not drill into the row.
    expect(sessionsStore.drillStack).toEqual([])

    // A group row → the group menu.
    await w.get('[data-drill-root-row="repo:repo-x"]').trigger('contextmenu')
    expect(w.find('[data-drill-group-menu]').exists()).toBe(true)
    expect(sessionsStore.drillStack).toEqual([])
  })

  it('closes the group menu — listeners and all — when its group stops rendering', async () => {
    installWindow([
      {
        path: '/repos/alpha/main',
        alias: 'main',
        gitBranch: 'main',
        repoId: 'repo-x',
        isMainWorktree: true,
        sessions: [session('s1')]
      },
      {
        path: '/repos/alpha/wt-b',
        alias: 'wt-b',
        gitBranch: 'wt-b',
        repoId: 'repo-x',
        sessions: [session('s2')]
      }
    ])
    const sessionsStore = useSessionsStore()
    await sessionsStore.reloadModel()
    sessionsStore.drillDepth = 2

    const w = mount(SidebarDrillView, { global: { plugins: [i18n], stubs: { teleport: true } } })

    await w.get('[data-drill-root-row="repo:repo-x"]').trigger('contextmenu')
    expect(w.find('[data-drill-group-menu]').exists()).toBe(true)

    // Control: while the menu is genuinely open it DOES swallow Escape.
    const swallowed = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
      bubbles: true
    })
    window.dispatchEvent(swallowed)
    expect(swallowed.defaultPrevented).toBe(true)

    // Reopen, then make the group stop rendering underneath it.
    await w.get('[data-drill-root-row="repo:repo-x"]').trigger('contextmenu')
    expect(w.find('[data-drill-group-menu]').exists()).toBe(true)
    sessionsStore.folders = []
    await nextTick()

    expect(w.find('[data-drill-group-menu]').exists()).toBe(false)
    // Hiding is not closing: the window listeners must be gone too, or an
    // invisible menu keeps eating the operator's next Escape.
    const free = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    window.dispatchEvent(free)
    expect(free.defaultPrevented).toBe(false)
  })

  it('AC-4 — repo screen chooser rows carry the same hover-only ⋯ and FolderMenu', async () => {
    installWindow([
      {
        path: '/repos/alpha/main',
        alias: 'main',
        gitBranch: 'main',
        repoId: 'repo-x',
        isMainWorktree: true,
        sessions: [session('s1')]
      },
      {
        path: '/repos/alpha/wt-b',
        alias: 'wt-b',
        gitBranch: 'wt-b',
        repoId: 'repo-x',
        sessions: [session('s2')]
      }
    ])
    const sessionsStore = useSessionsStore()
    const ui = useUiStore()
    await sessionsStore.reloadModel()
    sessionsStore.drillDepth = 2
    sessionsStore.drillIntoGroup('repo:repo-x')

    const w = mount(SidebarDrillView, { global: { plugins: [i18n] } })
    const actions = w.get('[data-drill-row-actions="/repos/alpha/wt-b"]')
    expect(actions.classes()).toContain('opacity-0')

    await actions.trigger('click')
    expect(ui.folderMenu.open).toBe(true)
    expect(ui.folderMenu.projectPath).toBe('/repos/alpha/wt-b')
    // Clicking the ⋯ must not drill into the row.
    expect(sessionsStore.drillStack).toEqual([{ kind: 'group', key: 'repo:repo-x' }])

    // Right-clicking anywhere on the row opens the same menu.
    ui.closeFolderMenu()
    await w.get('[data-drill-folder-row="/repos/alpha/wt-b"]').trigger('contextmenu')
    expect(ui.folderMenu.open).toBe(true)
    expect(ui.folderMenu.projectPath).toBe('/repos/alpha/wt-b')
  })
})
