// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import FolderView from '../src/renderer/src/components/FolderView.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { i18n } from '@renderer/i18n'

/**
 * T212 — the Folder View is what a folder click opens. Its contract (design.md
 * §6 "Folder View"): the folder's identity, its actions and one roadmap line,
 * and never an empty box — a folder with no board shows no roadmap line, a plain
 * directory shows no branch or git summary.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seed(sessionsInFolder: any[] = []): void {
  const store = useSessionsStore()
  store.folders.splice(0, store.folders.length, {
    path: '/repo/alpha',
    alias: 'alpha',
    expanded: true,
    gitBranch: 'main',
    isMainWorktree: true,
    sessions: sessionsInFolder
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  store.selectFolder('/repo/alpha')
}

/**
 * T285 — a repo with a main checkout plus one linked worktree, selecting the
 * worktree. `repoId` is what makes them siblings, so the worktrees block has
 * something to render in both profiles.
 */
function seedWorktree(): void {
  const store = useSessionsStore()
  store.folders.splice(
    0,
    store.folders.length,
    {
      path: '/repo/alpha',
      alias: 'alpha',
      expanded: true,
      gitBranch: 'main',
      repoId: 'repo-alpha',
      isMainWorktree: true,
      sessions: []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    {
      path: '/repo/alpha-wt/card-x',
      alias: 'card-x',
      expanded: true,
      gitBranch: 'card/x',
      repoId: 'repo-alpha',
      isMainWorktree: false,
      sessions: []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  )
  store.selectFolder('/repo/alpha-wt/card-x')
}

/** Seed the main checkout of that same two-worktree repo. */
function seedMainOfRepo(): void {
  seedWorktree()
  useSessionsStore().selectFolder('/repo/alpha')
}

const HOT = { ok: true, data: { hotPreview: '**Now:** landing the scope tags' } }

const EMPTY_PEEK = {
  counts: { backlog: 0, ready: 0, 'in-progress': 0, review: 0, done: 0 },
  active: []
}

function mockApi(over: Record<string, unknown> = {}): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = {
    foldersGitStatus: vi.fn().mockResolvedValue({ dirtyCount: 3, ahead: 1, behind: 0 }),
    roadmapPeek: vi.fn().mockResolvedValue(EMPTY_PEEK),
    memoryRead: vi.fn().mockResolvedValue(null),
    ...over
  }
}

function mountView() {
  return mount(FolderView, { global: { plugins: [i18n] } })
}

describe('FolderView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi()
  })

  it('shows the folder name, path and branch', async () => {
    seed()
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.text()).toContain('alpha')
    expect(wrapper.text()).toContain('/repo/alpha')
    expect(wrapper.text()).toContain('main')
  })

  it('degrades silently when the git probe rejects', async () => {
    mockApi({ foldersGitStatus: vi.fn().mockRejectedValue(new Error('no git')) })
    seed()
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.text()).toContain('alpha')
    expect(wrapper.find('[data-test="folder-view-git"]').exists()).toBe(false)
  })

  it('opens the roadmap board from the action bar', async () => {
    mockApi({ roadmapPeek: vi.fn().mockResolvedValue(BOARD_PEEK) })
    seed()
    const wrapper = mountView()
    await flushPromises()

    await wrapper.get('[data-test="folder-view-open-roadmap"]').trigger('click')

    const { useUiStore } = await import('../src/renderer/src/stores/ui')
    const ui = useUiStore()
    expect(ui.roadmap.open).toBe(true)
    expect(ui.roadmap.folderPath).toBe('/repo/alpha')
  })

  it('shows no roadmap line and no board button without a board', async () => {
    seed()
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="folder-view-roadmap"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="folder-view-open-roadmap"]').exists()).toBe(false)
  })

  it('sizes the roadmap bar from the in-progress and ready shares', async () => {
    mockApi({
      roadmapPeek: vi.fn().mockResolvedValue({
        counts: { backlog: 9, ready: 3, 'in-progress': 1, review: 0, done: 0 },
        active: []
      })
    })
    seed()
    const wrapper = mountView()
    await flushPromises()
    const segments = wrapper.findAll('[data-test="folder-view-roadmap-bar"] i')
    expect(segments.map((s) => s.attributes('style'))).toEqual(['width: 25%;', 'width: 75%;'])
  })

  it('warns on a dirty folder and stays quiet on a clean one', async () => {
    seed()
    let wrapper = mountView()
    await flushPromises()
    expect(wrapper.get('[data-test="folder-view-git"]').classes()).toContain('text-warning')

    mockApi({
      foldersGitStatus: vi.fn().mockResolvedValue({ dirtyCount: 0, ahead: 0, behind: 0 })
    })
    setActivePinia(createPinia())
    seed()
    wrapper = mountView()
    await flushPromises()
    const git = wrapper.get('[data-test="folder-view-git"]')
    // design.md "Folder View" and the approved screen say `clean`.
    expect(git.text()).toBe('clean')
    expect(git.classes()).toContain('text-text-4')
  })

  it('gives a plain directory no branch, no git summary and no PR Stack', async () => {
    const store = useSessionsStore()
    store.folders.splice(0, store.folders.length, {
      path: '/plain/notes',
      alias: 'notes',
      expanded: true,
      sessions: []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    store.selectFolder('/plain/notes')
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.find('[data-test="folder-view-branch"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="folder-view-git"]').exists()).toBe(false)
    await wrapper.get('[data-test="folder-view-more"]').trigger('click')
    expect(wrapper.find('[data-test="folder-view-open-pr-stack"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="folder-view-editor"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="folder-view-open-folder"]').exists()).toBe(true)
  })

  it('drives the More menu from the keyboard', async () => {
    seed()
    const wrapper = mount(FolderView, { global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()
    const trigger = wrapper.get('[data-test="folder-view-more"]')
    const focused = (): string | null =>
      (document.activeElement as HTMLElement).getAttribute('data-test')

    expect(trigger.attributes('title')).toBe('More: PR Stack, Open in VS Code, Open folder')
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect(focused()).toBe('folder-view-open-pr-stack')
    await wrapper.get('[data-test="folder-view-menu"]').trigger('keydown', { key: 'ArrowUp' })
    expect(focused()).toBe('folder-view-open-folder')
    await wrapper.get('[data-test="folder-view-menu"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-test="folder-view-menu"]').exists()).toBe(false)
    expect(focused()).toBe('folder-view-more')
    wrapper.unmount()
  })

  it('closes the More menu when another folder is selected', async () => {
    seedMainOfRepo()
    const wrapper = mountView()
    await flushPromises()
    await wrapper.get('[data-test="folder-view-more"]').trigger('click')
    useSessionsStore().selectFolder('/repo/alpha-wt/card-x')
    await flushPromises()
    expect(wrapper.find('[data-test="folder-view-menu"]').exists()).toBe(false)
  })
})

/**
 * Sidebar redesign S-6 — the slim Folder View (design.md §6 "Folder View"): the
 * folder's identity, its actions and one roadmap line. What the sidebar already
 * shows (counts, worktrees, sessions, memory, activity, the owned card) is gone.
 */
const BOARD_PEEK = {
  counts: { backlog: 4, ready: 3, 'in-progress': 1, review: 4, done: 2 },
  active: [
    {
      slug: 'slim-1',
      id: 'T900',
      title: 'a card the board holds',
      status: 'in-progress',
      blocked: false,
      session: 'sess-slim',
      executedIn: 'card/x'
    }
  ],
  owned: {
    slug: 'slim-1',
    id: 'T900',
    title: 'a card the board holds',
    status: 'in-progress',
    blocked: false,
    session: 'sess-slim',
    executedIn: 'card/x'
  }
}

/** Every block the slim view dropped, by the test id it used to render under. */
const REMOVED_BLOCKS = [
  'folder-view-kpis',
  'folder-view-kpi-needs-you',
  'folder-view-fanout',
  'folder-view-worktrees',
  'folder-view-worktree',
  'folder-view-sessions-section',
  'folder-view-session',
  'folder-view-empty-cta',
  'folder-view-older-toggle',
  'folder-view-archived-toggle',
  'folder-view-memory',
  'folder-view-activity',
  'folder-view-owned-card',
  'folder-view-scope-tag'
]

describe('FolderView slim (sidebar redesign S-6)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders identity and actions only', async () => {
    for (const seedIt of [seedMainOfRepo, seedWorktree]) {
      setActivePinia(createPinia())
      const memoryRead = vi.fn().mockResolvedValue(HOT)
      const prStackLoad = vi.fn().mockResolvedValue(null)
      mockApi({ roadmapPeek: vi.fn().mockResolvedValue(BOARD_PEEK), memoryRead, prStackLoad })
      seedIt()
      const store = useSessionsStore()
      // A session in each checkout, so a sessions list or a fan-out would have rows to draw.
      for (const f of store.folders) {
        f.sessions.push({
          sessionId: `sess-${f.alias}`,
          projectPath: f.path,
          summary: `session of ${f.alias}`,
          firstPrompt: `session of ${f.alias}`,
          status: 'idle',
          messageCount: 4,
          created: new Date().toISOString(),
          modified: new Date().toISOString()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
      }
      const wrapper = mountView()
      await flushPromises()

      for (const id of REMOVED_BLOCKS) {
        expect(wrapper.find(`[data-test="${id}"]`).exists(), id).toBe(false)
      }
      const text = wrapper.text()
      expect(text).not.toContain('session of')
      expect(text).not.toContain('landing the scope tags')
      expect(text).not.toContain('a card the board holds')
      // The view makes no read for a part it no longer draws.
      expect(memoryRead).not.toHaveBeenCalled()
      expect(prStackLoad).not.toHaveBeenCalled()

      // What stays: identity, git, actions and the one roadmap line.
      const folder = store.findFolderByPath(store.selectedFolderPath!)!
      expect(wrapper.get('h1').text()).toBe(folder.alias)
      expect(wrapper.get('[data-test="folder-view-branch"]').text()).toBe(folder.gitBranch)
      expect(wrapper.get('[data-test="folder-view-git"]').text()).toBe('3 changes · ↑1')
      expect(wrapper.get('[data-test="folder-view-path"]').text()).toBe(folder.path)
      expect(wrapper.find('[data-test="folder-view-actions"]').exists()).toBe(true)
      expect(wrapper.findAll('[data-test="folder-view-roadmap"]')).toHaveLength(1)
      expect(wrapper.get('[data-test="folder-view-roadmap"]').text()).toBe(
        'Roadmap1 in progress · 3 ready · 4 in review'
      )
    }
  })
})

/**
 * AC-27 — no action of the old bar is lost: four up front, three behind More, in
 * the order design.md §6 "Folder View" fixes.
 */
describe('FolderView slim actions (sidebar redesign S-6)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  const FRONT = [
    'folder-view-new-session',
    'folder-view-terminal',
    'folder-view-browse-files',
    'folder-view-open-roadmap',
    'folder-view-more'
  ]

  it('keeps every action', async () => {
    const openPath = vi.fn().mockResolvedValue(undefined)
    const openInEditor = vi.fn().mockResolvedValue({ ok: true, mode: 'external' })
    mockApi({ roadmapPeek: vi.fn().mockResolvedValue(BOARD_PEEK), openPath, openInEditor })
    seed()
    const store = useSessionsStore()
    const { useUiStore } = await import('../src/renderer/src/stores/ui')
    const { useHelpersStore } = await import('../src/renderer/src/stores/helpers')
    const ui = useUiStore()
    const helpers = useHelpersStore()
    const newSession = vi.spyOn(ui, 'openNewSession')
    const roadmap = vi.spyOn(ui, 'openRoadmap')
    const prStack = vi.spyOn(ui, 'openPrStack')
    const terminal = vi.spyOn(store, 'createFolderTerminal').mockImplementation(() => '')
    const explorer = vi.spyOn(helpers, 'addExplorerHelper').mockImplementation(() => undefined)

    const wrapper = mount(FolderView, { global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()

    // Up front, in order, and one click each.
    const bar = wrapper.get('[data-test="folder-view-actions"]')
    expect(bar.findAll('button').map((b) => b.attributes('data-test'))).toEqual(FRONT)
    for (const id of FRONT.slice(0, 4)) await wrapper.get(`[data-test="${id}"]`).trigger('click')
    expect(newSession).toHaveBeenCalledWith('/repo/alpha')
    expect(terminal).toHaveBeenCalledWith('/repo/alpha')
    expect(explorer).toHaveBeenCalledWith('/repo/alpha', '/repo/alpha')
    expect(roadmap).toHaveBeenCalledWith('/repo/alpha', 'alpha')

    // Behind More: PR Stack, the editor, Open folder — two clicks each.
    expect(wrapper.find('[data-test="folder-view-menu"]').exists()).toBe(false)
    const pick = async (id: string): Promise<void> => {
      await wrapper.get('[data-test="folder-view-more"]').trigger('click')
      await wrapper.get(`[data-test="${id}"]`).trigger('click')
      expect(wrapper.find('[data-test="folder-view-menu"]').exists()).toBe(false)
    }
    await pick('folder-view-open-pr-stack')
    expect(prStack).toHaveBeenCalledWith('/repo/alpha', 'alpha')
    await pick('folder-view-editor')
    expect(openInEditor).toHaveBeenCalledWith('/repo/alpha')
    await pick('folder-view-open-folder')
    expect(openPath).toHaveBeenCalledWith('/repo/alpha')
    wrapper.unmount()
  })
})
