// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import {
  useFolderMenuActions,
  folderActionVisible,
  repoGroupActionVisible,
  type FolderAction
} from '../src/renderer/src/composables/useFolderMenuActions'
import type { FolderEntry } from '../src/preload'

/**
 * T486 U3 — the Folder menu and repo-group menu actions the new keybindings run
 * (`docs/specs/T486-keybindings-coverage-pass.md` §3.4, §3.10, §8.3). The
 * composable is the SAME code the menus call (AC-37), so these tests cover
 * both entry points.
 */

function session(id: string, projectPath: string) {
  return {
    sessionId: id,
    summary: id,
    firstPrompt: '',
    modified: new Date().toISOString(),
    status: 'idle',
    taskState: 'idle',
    fullPath: `/home/u/.claude/projects/x/${id}.jsonl`,
    resumable: true,
    projectPath
  }
}

/** A repo with two worktrees (one repo group) plus a plain folder. */
const DISK = [
  {
    path: '/repos/alpha',
    alias: 'alpha',
    gitBranch: 'main',
    repoId: 'R',
    isMainWorktree: true,
    sessions: [session('s-a', '/repos/alpha')]
  },
  {
    path: '/repos/alpha-wt',
    alias: 'alpha-wt',
    gitBranch: 'feat/x',
    repoId: 'R',
    isMainWorktree: false,
    sessions: [session('s-w', '/repos/alpha-wt')]
  },
  {
    path: '/plain/beta',
    alias: 'beta',
    sessions: [session('s-b', '/plain/beta')]
  }
] as unknown as FolderEntry[]

function installWindow(): void {
  ;(window as unknown as { api: unknown }).api = {
    foldersLoad: vi.fn(async () => DISK),
    userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
    orchestratorListArmed: vi.fn(async () => []),
    probeGit: vi.fn(async () => []),
    getPathForFile: vi.fn(() => null)
  }
}

/** Run a composable inside a real component setup (it calls `useI18n`). */
function withSetup<T>(fn: () => T): T {
  let out!: T
  mount(
    defineComponent({
      setup() {
        out = fn()
        return () => h('div')
      }
    }),
    { global: { plugins: [i18n] } }
  )
  return out
}

const GROUP_KEY = 'repo:R'

beforeEach(async () => {
  setActivePinia(createPinia())
  localStorage.clear()
  installWindow()
  await useSessionsStore().reloadModel()
})

afterEach(() => {
  ;(document.activeElement as HTMLElement | null)?.blur()
  document.body.innerHTML = ''
})

describe('folderActionVisible — the Folder menu rule the bindings share (§3.10)', () => {
  const plain = { gitFolder: false, linkedWorktree: false, olderCount: 0, archivedCount: 0 }
  const main = { ...plain, gitFolder: true }
  const linked = { ...main, linkedWorktree: true }
  const gitOnly: FolderAction[] = ['newWorktree', 'worktreeMd', 'askAgentWorktreeMd']

  it('the git-only items need a git folder', () => {
    for (const a of gitOnly) {
      expect(folderActionVisible(a, plain), a).toBe(false)
      expect(folderActionVisible(a, main), a).toBe(true)
    }
  })

  it('remove worktree is for a linked worktree; auto-organize never is', () => {
    expect(folderActionVisible('removeWorktree', main)).toBe(false)
    expect(folderActionVisible('removeWorktree', linked)).toBe(true)
    expect(folderActionVisible('toggleAutoOrganize', main)).toBe(true)
    expect(folderActionVisible('toggleAutoOrganize', linked)).toBe(false)
  })

  it('the older / archived peeks need something to reveal', () => {
    expect(folderActionVisible('toggleOlder', plain)).toBe(false)
    expect(folderActionVisible('toggleOlder', { ...plain, olderCount: 2 })).toBe(true)
    expect(folderActionVisible('toggleArchived', plain)).toBe(false)
    expect(folderActionVisible('toggleArchived', { ...plain, archivedCount: 1 })).toBe(true)
  })

  it('every other item is always there', () => {
    for (const a of ['rename', 'bootOptions', 'toggleHidden', 'newSubfolder'] as const)
      expect(folderActionVisible(a, plain), a).toBe(true)
  })
})

describe('repoGroupActionVisible — the group menu rule', () => {
  it('reset name needs an alias; cleanup needs a repo group', () => {
    expect(repoGroupActionVisible('rename', { hasAlias: false, source: 'path' })).toBe(true)
    expect(repoGroupActionVisible('resetName', { hasAlias: false, source: 'repo' })).toBe(false)
    expect(repoGroupActionVisible('resetName', { hasAlias: true, source: 'repo' })).toBe(true)
    expect(repoGroupActionVisible('cleanup', { hasAlias: false, source: 'path' })).toBe(false)
    expect(repoGroupActionVisible('cleanup', { hasAlias: false, source: 'repo' })).toBe(true)
  })
})

describe('AC-35 — folder.rename (F2)', () => {
  it('targets the cursor folder row first', () => {
    const sessions = useSessionsStore()
    const actions = withSetup(() => useFolderMenuActions())
    sessions.selectFolder('/plain/beta')
    sessions.keyboardCursor = { kind: 'folder', id: '/repos/alpha' }
    expect(actions.renameTarget()).toBe('/repos/alpha')
  })

  it('falls back to the active folder with no cursor row', () => {
    const sessions = useSessionsStore()
    const actions = withSetup(() => useFolderMenuActions())
    expect(actions.renameTarget()).toBeNull()
    sessions.selectFolder('/plain/beta')
    expect(actions.renameTarget()).toBe('/plain/beta')
  })

  it('does nothing on a session or group cursor row', () => {
    const sessions = useSessionsStore()
    const actions = withSetup(() => useFolderMenuActions())
    sessions.selectFolder('/plain/beta')
    sessions.keyboardCursor = { kind: 'session', id: 's-a' }
    expect(actions.renameTarget()).toBeNull()
    sessions.keyboardCursor = { kind: 'group', id: GROUP_KEY }
    expect(actions.renameTarget()).toBeNull()
  })

  it('ignores the cursor in drill mode', () => {
    const sessions = useSessionsStore()
    const actions = withSetup(() => useFolderMenuActions())
    sessions.selectFolder('/plain/beta')
    sessions.keyboardCursor = { kind: 'session', id: 's-a' }
    sessions.drillDepth = 1
    expect(actions.renameTarget()).toBe('/plain/beta')
  })

  it('opens the Rename folder dialog through the menu item’s function', () => {
    const ui = useUiStore()
    const actions = withSetup(() => useFolderMenuActions())
    actions.run.rename('/repos/alpha')
    expect(ui.dialog).toBe('renameFolder')
    expect(ui.folderActionPath).toBe('/repos/alpha')
  })

  it('App.vue binds it to the composable, keyed off the table, behind the text-entry guard', () => {
    const src = readFileSync(resolve(__dirname, '../src/renderer/src/App.vue'), 'utf8')
    const start = src.indexOf("id: 'folder.rename'")
    expect(start).toBeGreaterThan(-1)
    const reg = src.slice(start, src.indexOf("id: '", start + 5))
    expect(reg).toContain("keys: kb('folder.rename')")
    expect(reg).toContain('keysGuard: notInTextEntry')
    expect(reg).toContain('folderActions.renameTarget()')
    expect(reg).toContain('folderActions.run.rename(')
  })
})

describe('folder actions target the active folder (§3.10)', () => {
  it('no active folder → no target', () => {
    const actions = withSetup(() => useFolderMenuActions())
    expect(actions.activeFor('bootOptions')).toBeNull()
  })

  it('the active folder, when the menu would show the item for it', () => {
    const sessions = useSessionsStore()
    const actions = withSetup(() => useFolderMenuActions())
    sessions.selectFolder('/plain/beta')
    expect(actions.activeFor('bootOptions')).toBe('/plain/beta')
    expect(actions.activeFor('newWorktree')).toBeNull()
    expect(actions.activeFor('removeWorktree')).toBeNull()
    sessions.selectFolder('/repos/alpha-wt')
    expect(actions.activeFor('newWorktree')).toBe('/repos/alpha-wt')
    expect(actions.activeFor('removeWorktree')).toBe('/repos/alpha-wt')
    expect(actions.activeFor('toggleAutoOrganize')).toBeNull()
  })

  it('the cursor row does not retarget them (only rename follows it)', () => {
    const sessions = useSessionsStore()
    const actions = withSetup(() => useFolderMenuActions())
    sessions.selectFolder('/plain/beta')
    sessions.keyboardCursor = { kind: 'folder', id: '/repos/alpha' }
    expect(actions.activeFor('bootOptions')).toBe('/plain/beta')
  })

  it('toggleHidden hides a visible folder and unhides a hidden one', async () => {
    const sessions = useSessionsStore()
    const actions = withSetup(() => useFolderMenuActions())
    const dismiss = vi.spyOn(sessions, 'dismissFolder').mockResolvedValue(undefined as never)
    const unhide = vi.spyOn(sessions, 'unhideFolder').mockResolvedValue(undefined as never)
    actions.run.toggleHidden('/plain/beta')
    expect(dismiss).toHaveBeenCalledWith('/plain/beta')
    sessions.manuallyHiddenPaths = new Set(['/plain/beta'])
    actions.run.toggleHidden('/plain/beta')
    expect(unhide).toHaveBeenCalledWith('/plain/beta')
  })

  it('toggleOlder expands a collapsed folder before revealing, like the row peek', () => {
    const sessions = useSessionsStore()
    const actions = withSetup(() => useFolderMenuActions())
    const toggleFolder = vi.spyOn(sessions, 'toggleFolder')
    const reveal = vi.spyOn(sessions, 'toggleRevealOlder')
    const folder = sessions.findFolderByPath('/plain/beta')!
    folder.expanded = false
    actions.run.toggleOlder('/plain/beta')
    expect(toggleFolder).toHaveBeenCalledWith('/plain/beta')
    expect(reveal).toHaveBeenCalledWith('/plain/beta')
  })

  it('removeWorktree opens the confirm dialog with the branch', () => {
    const ui = useUiStore()
    const actions = withSetup(() => useFolderMenuActions())
    actions.run.removeWorktree('/repos/alpha-wt')
    expect(ui.dialog).toBe('removeWorktree')
    expect(ui.removeWorktreeTarget).toEqual({ path: '/repos/alpha-wt', branch: 'feat/x' })
  })
})

describe('repo-group actions (§3.10)', () => {
  it('target the cursor group row, else the group holding the active folder', () => {
    const sessions = useSessionsStore()
    const actions = withSetup(() => useFolderMenuActions())
    expect(sessions.groupInVisible(GROUP_KEY), 'the fixture renders a repo group').not.toBeNull()
    expect(actions.groupFor('rename')).toBeNull()
    sessions.selectFolder('/repos/alpha-wt')
    expect(actions.groupFor('rename')?.key).toBe(GROUP_KEY)
    sessions.selectFolder('/plain/beta')
    expect(actions.groupFor('rename')).toBeNull()
    sessions.keyboardCursor = { kind: 'group', id: GROUP_KEY }
    expect(actions.groupFor('rename')?.key).toBe(GROUP_KEY)
  })

  it('reset name is only available with an alias', () => {
    const sessions = useSessionsStore()
    const actions = withSetup(() => useFolderMenuActions())
    sessions.selectFolder('/repos/alpha')
    expect(actions.groupFor('resetName')).toBeNull()
    expect(actions.groupFor('cleanup')?.key).toBe(GROUP_KEY)
  })

  it('run the menu items’ functions: rename dialog, alias reset, cleanup on the main worktree', () => {
    const sessions = useSessionsStore()
    const ui = useUiStore()
    const actions = withSetup(() => useFolderMenuActions())
    const group = sessions.groupInVisible(GROUP_KEY)!
    actions.group.rename(group)
    expect(ui.dialog).toBe('renameRepo')
    expect(ui.renameRepoTarget).toEqual({ groupKey: GROUP_KEY, derivedLabel: group.derivedLabel })

    const setAlias = vi.spyOn(sessions, 'setGroupAlias')
    actions.group.resetName(group)
    expect(setAlias).toHaveBeenCalledWith(GROUP_KEY, '')

    const cleanup = vi.spyOn(ui, 'openCleanup')
    actions.group.cleanup(group)
    expect(cleanup).toHaveBeenCalledWith('/repos/alpha')
  })
})

describe('AC-37 — the menus and the bindings share one function', () => {
  const read = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')

  it('the three menus call the composable, not the store actions directly', () => {
    for (const p of [
      'src/renderer/src/components/FolderMenu.vue',
      'src/renderer/src/components/RepoGroupHeader.vue',
      'src/renderer/src/components/SidebarDrillView.vue'
    ]) {
      const src = read(p)
      expect(src, p).toContain('useFolderMenuActions')
      expect(src, p).not.toContain('ui.openRenameRepo(')
      expect(src, p).not.toContain("setGroupAlias(group.key, '')")
      expect(src, p).not.toContain("setGroupAlias(props.group.key, '')")
    }
    const menu = read('src/renderer/src/components/FolderMenu.vue')
    for (const call of [
      'ui.openRenameFolder(',
      'ui.openClaudeBoot(',
      'ui.openNewWorktree(',
      'ui.openRemoveWorktree(',
      'sessions.setFolderInterceptActive(',
      'sessions.dismissFolder('
    ])
      expect(menu, call).not.toContain(call)
  })

  it('every §3.4 registration in App.vue runs the composable', () => {
    const src = read('src/renderer/src/App.vue')
    const ids = [...src.matchAll(/id: '((?:folder|repoGroup)\.[A-Za-z]+)'/g)].map((m) => m[1])
    const t1 = new Set([
      'folder.add',
      'folder.browseFiles',
      'folder.newTerminal',
      'folder.openInFileManager',
      'folder.openInVSCode',
      'folder.openGithubPulls'
    ])
    const mine = ids.filter((id) => !t1.has(id))
    expect(mine).toHaveLength(21)
    for (const id of mine) {
      const start = src.indexOf(`id: '${id}'`)
      const reg = src.slice(start, src.indexOf("id: '", start + 5))
      expect(reg, id).toMatch(/folderActions\.|onActiveFolder\(|onGroup\(/)
      expect(reg, id).toContain('keysGuard: notInTextEntry')
    }
  })
})
