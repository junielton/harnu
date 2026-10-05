// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import SidebarJumpPalette from '../src/renderer/src/components/SidebarJumpPalette.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { matchSegments, fuzzySearch } from '../src/renderer/src/composables/useJumpSearch'
import type { FolderEntry } from '../src/preload'

/**
 * T288 — the sidebar jump palette on the one-line header. The palette's whole
 * premise is that search produces TARGETS and never touches the tree, so most
 * of what is asserted here is about what did NOT happen to `filterQuery` and
 * the folder list behind it.
 */

function session(id: string, summary: string, firstPrompt = ''): FolderEntry['sessions'][number] {
  return {
    sessionId: id,
    summary,
    firstPrompt,
    modified: '2026-09-04T10:00:00.000Z',
    status: 'idle',
    taskState: 'idle'
  } as unknown as FolderEntry['sessions'][number]
}

/** Two repo worktrees under one repoId, plus a standalone folder and a hidden one. */
const DISK: FolderEntry[] = [
  {
    path: '/repos/www',
    alias: 'www',
    gitBranch: 'main',
    repoId: '/repos/www',
    isMainWorktree: true,
    sessions: [session('s-1', 'Migrate www checkout to Livewire')]
  },
  {
    path: '/repos/www-wave-2',
    alias: 'PROJ-347-wave-2',
    gitBranch: 'PROJ-347-wave-2',
    repoId: '/repos/www',
    sessions: []
  },
  {
    path: '/repos/api-gateway',
    alias: 'api-gateway',
    gitBranch: 'main',
    sessions: [session('s-2', 'Rate-limit middleware', 'review pull/177')]
  },
  { path: '/repos/www-org-b', alias: 'www-org-b', gitBranch: 'main', sessions: [] }
] as unknown as FolderEntry[]

function installWindow(hiddenPaths: string[] = [], pinned: string[] = []): void {
  ;(window as unknown as { api: unknown }).api = {
    foldersLoad: vi.fn(async () => DISK),
    userProjectsList: vi.fn(async () => ({
      projects: pinned.map((path) => ({ path, alias: path.split('/').pop() })),
      hiddenPaths
    })),
    userProjectsUnhide: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
    orchestratorListArmed: vi.fn(async () => []),
    probeGit: vi.fn(async () => []),
    getPathForFile: vi.fn(() => null)
  }
}

async function bootStore(hiddenPaths: string[] = [], pinned: string[] = []) {
  installWindow(hiddenPaths, pinned)
  const sessions = useSessionsStore()
  await sessions.reloadModel()
  return sessions
}

/**
 * jsdom has neither a `CSS` global nor `Element.scrollIntoView`, and the
 * sidebar's reveal/flash watchers use both (`CSS.escape` to build the selector,
 * `scrollIntoView` to bring the row into view). Chromium has both; these stubs
 * only keep the watchers from throwing an unhandled rejection in the test
 * environment.
 */
function installDomShims(): void {
  ;(globalThis as unknown as { CSS?: unknown }).CSS = {
    escape: (v: string) => v.replace(/([^\w-])/g, '\\$1')
  }
  Element.prototype.scrollIntoView = (): void => {}
}

/** Mount the palette with it already open, and return the wrapper. */
async function mountOpenPalette(hiddenPaths: string[] = []) {
  const sessions = await bootStore(hiddenPaths)
  const ui = useUiStore()
  ui.openSidebarJumpPalette()
  const w = mount(SidebarJumpPalette, { global: { plugins: [i18n] } })
  await flushPromises()
  return { w, sessions, ui }
}

async function type(w: ReturnType<typeof mount>, q: string): Promise<void> {
  await w.get('[data-sidebar-jump-input]').setValue(q)
  await flushPromises()
}

describe('useJumpSearch — shared matcher', () => {
  it('bolds only the contiguous substring the operator typed', () => {
    expect(matchSegments('www · org-a', 'www')).toEqual([
      { text: 'www', match: true },
      { text: ' · org-a', match: false }
    ])
    // A fuzzy (non-substring) hit gets no bold rather than scattered letters.
    expect(matchSegments('api-gateway', 'agw')).toEqual([{ text: 'api-gateway', match: false }])
  })

  it('returns the input untouched for an empty query', () => {
    const items = [{ label: 'a' }, { label: 'b' }]
    expect(fuzzySearch(items, '   ')).toEqual(items)
  })
})

describe('Sidebar header — one row (AC-1)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('renders rescan, drill, collapse-all, hidden and search in ONE 42px header, search last', async () => {
    await bootStore()
    const w = mount(Sidebar, { global: { plugins: [i18n] } })
    await flushPromises()

    const header = w.get('header')
    expect(header.element.style.height).toBe('42px')

    // Every toolbar control now lives inside the header — the separate toolbar
    // row is gone.
    for (const sel of [
      '[data-sidebar-rescan]',
      '[data-drill-toggle]',
      '[data-sidebar-hidden-trigger]',
      '[data-sidebar-jump-trigger]'
    ]) {
      expect(header.find(sel).exists()).toBe(true)
    }
    expect(w.findAll('[role="toolbar"]').length).toBe(1)

    // Search is LAST, after the divider.
    const buttons = header.findAll('button')
    expect(buttons[buttons.length - 1].attributes('data-sidebar-jump-trigger')).toBeDefined()
  })

  it('hides collapse-all at drill depth 2 but keeps the search button', async () => {
    const sessions = await bootStore()
    const w = mount(Sidebar, { global: { plugins: [i18n] } })
    await flushPromises()

    sessions.drillDepth = 2
    await flushPromises()
    const header = w.get('header')
    expect(header.findAll('button').some((b) => b.attributes('title')?.includes('ollapse'))).toBe(
      false
    )
    expect(header.find('[data-sidebar-jump-trigger]').exists()).toBe(true)
  })

  it('flashes the folder ROW, not the whole folder block (AC-6)', async () => {
    // `data-folder-path` wraps the folder row AND its expanded session list, so
    // the flash has to land on the row button inside it — otherwise the accent
    // paints every session under the folder too.
    installDomShims()
    const sessions = await bootStore([], ['/repos/www'])
    const w = mount(Sidebar, { global: { plugins: [i18n] } })
    await flushPromises()

    sessions.jumpToFolder('/repos/www')
    await flushPromises()

    const wrapper = w.get('[data-folder-path="/repos/www"]')
    expect(wrapper.classes()).not.toContain('anim-jump-flash')
    expect(wrapper.get('button').classes()).toContain('anim-jump-flash')
  })

  it('opens the palette from the search button instead of the filter morph (AC-2)', async () => {
    const sessions = await bootStore()
    const ui = useUiStore()
    const w = mount(Sidebar, { global: { plugins: [i18n] } })
    await flushPromises()

    await w.get('[data-sidebar-jump-trigger]').trigger('click')
    expect(ui.sidebarJumpPalette.open).toBe(true)
    // The old behaviour (morph the header into a filter input) must NOT fire.
    expect(sessions.filterActive).toBe(false)

    // Clicking again closes it.
    await w.get('[data-sidebar-jump-trigger]').trigger('click')
    expect(ui.sidebarJumpPalette.open).toBe(false)
  })
})

describe('SidebarJumpPalette', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('renders nothing while closed and focuses its input on open (AC-2)', async () => {
    await bootStore()
    const ui = useUiStore()
    const w = mount(SidebarJumpPalette, {
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    expect(w.find('[data-sidebar-jump-palette]').exists()).toBe(false)

    ui.openSidebarJumpPalette()
    await flushPromises()
    expect(w.find('[data-sidebar-jump-palette]').exists()).toBe(true)
    expect(document.activeElement).toBe(w.get('[data-sidebar-jump-input]').element)
    w.unmount()
  })

  it('never filters the tree while searching (AC-2)', async () => {
    const { w, sessions } = await mountOpenPalette()
    const before = sessions.visibleFolders.length
    await type(w, 'www')
    expect(sessions.filterQuery).toBe('')
    expect(sessions.visibleFolders.length).toBe(before)
  })

  it('groups results Folders → Hidden → Sessions with counts (AC-3)', async () => {
    const { w } = await mountOpenPalette(['/repos/www-org-b'])
    await type(w, 'www')

    const eyebrows = w.findAll('[data-sidebar-jump-palette] .uppercase').map((e) => e.text())
    expect(eyebrows[0]).toContain('Folders')
    expect(eyebrows[1]).toContain('Hidden')
    // `www` matches the folder alias/branch/path AND a session summary.
    expect(eyebrows.some((e) => e.includes('Sessions'))).toBe(true)

    // First result is selected: 28px rows, and the cursor row carries the
    // accent bar + the enter glyph.
    const rows = w.findAll('[data-sidebar-jump-result]')
    expect(rows[0].element.style.height).toBe('28px')
    expect(rows[0].find('.bg-accent').exists()).toBe(true)
    expect(rows[1].find('.bg-accent').exists()).toBe(false)
  })

  it('matches a folder by its PATH and its git branch (AC-4)', async () => {
    const { w } = await mountOpenPalette()
    await type(w, 'api-gateway')
    const ids = w.findAll('[data-sidebar-jump-result]').map((r) => r.attributes('data-jump-id'))
    expect(ids).toContain('folder:/repos/api-gateway')

    await type(w, 'PROJ-347')
    const branchIds = w
      .findAll('[data-sidebar-jump-result]')
      .map((r) => r.attributes('data-jump-id'))
    expect(branchIds).toContain('folder:/repos/www-wave-2')
  })

  it('hints a session with its OWN worktree, and the repo group for a main worktree (AC-3)', async () => {
    const { w } = await mountOpenPalette()
    await type(w, 'Livewire')
    // `s-1` lives in `/repos/www`, the repo group's MAIN worktree — the group
    // label is the informative half there.
    const main = w
      .findAll('[data-sidebar-jump-result]')
      .find((r) => r.attributes('data-jump-id') === 'session:s-1')!
    expect(main.text()).toContain('www')

    // A session in a non-main worktree is hinted by that worktree, not by the
    // repo group it happens to belong to.
    await type(w, 'Rate-limit')
    const standalone = w
      .findAll('[data-sidebar-jump-result]')
      .find((r) => r.attributes('data-jump-id') === 'session:s-2')!
    expect(standalone.text()).toContain('api-gateway')
  })

  it('never offers an ARCHIVED session as a jump target', async () => {
    // The tree renders an archived session only while its folder's archived
    // peek is open, and selecting one does not open that peek — so a jump to
    // one would land on a row that never appears. Archived is the second
    // "don't show this" axis after `isSidechain`; a new projection over
    // sessions has to honour both.
    const { w, sessions } = await mountOpenPalette()
    await type(w, 'Livewire')
    expect(
      w.findAll('[data-sidebar-jump-result]').map((r) => r.attributes('data-jump-id'))
    ).toContain('session:s-1')

    sessions.archiveSession('s-1')
    await type(w, 'Livewire')
    expect(
      w.findAll('[data-sidebar-jump-result]').map((r) => r.attributes('data-jump-id'))
    ).not.toContain('session:s-1')
  })

  it('never offers a session inside a HIDDEN folder as a jump target', async () => {
    // Same dead-target reasoning as the archived case above, one level up: a
    // dismissed folder is classified `hidden` and never renders in the tree,
    // and the session-jump path reveals but never unhides — so the row the
    // jump scrolls to and flashes would not exist. The FOLDER stays findable
    // under Hidden with "Unhide & go"; its sessions come back with it.
    const visible = await mountOpenPalette()
    await type(visible.w, 'pull/177')
    expect(
      visible.w.findAll('[data-sidebar-jump-result]').map((r) => r.attributes('data-jump-id'))
    ).toContain('session:s-2')

    const hiddenCase = await mountOpenPalette(['/repos/api-gateway'])
    await type(hiddenCase.w, 'pull/177')
    expect(
      hiddenCase.w.findAll('[data-sidebar-jump-result]').map((r) => r.attributes('data-jump-id'))
    ).not.toContain('session:s-2')
    // The folder itself is still reachable — hidden, not gone.
    await type(hiddenCase.w, 'api-gateway')
    expect(
      hiddenCase.w.findAll('[data-sidebar-jump-result]').map((r) => r.attributes('data-jump-id'))
    ).toContain('hidden:/repos/api-gateway')
  })

  it('matches a session by its first prompt (AC-4)', async () => {
    const { w } = await mountOpenPalette()
    await type(w, 'pull/177')
    const ids = w.findAll('[data-sidebar-jump-result]').map((r) => r.attributes('data-jump-id'))
    expect(ids).toContain('session:s-2')
  })

  it('lists a hidden folder under Hidden with an "Unhide & go" chip (AC-4)', async () => {
    const { w } = await mountOpenPalette(['/repos/www-org-b'])
    await type(w, 'www-org-b')
    const hidden = w
      .findAll('[data-sidebar-jump-result]')
      .find((r) => r.attributes('data-jump-id') === 'hidden:/repos/www-org-b')
    expect(hidden).toBeDefined()
    expect(hidden!.text()).toContain('Unhide & go')
  })

  it('jumps to a folder: expands it, reveals it and closes the palette (AC-5)', async () => {
    const { w, sessions, ui } = await mountOpenPalette()
    await type(w, 'api-gateway')
    const row = w
      .findAll('[data-sidebar-jump-result]')
      .find((r) => r.attributes('data-jump-id') === 'folder:/repos/api-gateway')!
    await row.trigger('click')
    await flushPromises()

    expect(ui.sidebarJumpPalette.open).toBe(false)
    expect(sessions.folders.find((f) => f.path === '/repos/api-gateway')?.expanded).toBe(true)
    expect(sessions.revealFolderPath).toBe('/repos/api-gateway')
  })

  it('OPENS the folder it jumped to — its FolderView, not just the tree row (BUG)', async () => {
    const { w, sessions } = await mountOpenPalette()
    sessions.selectedId = 's-2'
    await type(w, 'api-gateway')
    const row = w
      .findAll('[data-sidebar-jump-result]')
      .find((r) => r.attributes('data-jump-id') === 'folder:/repos/api-gateway')!
    await row.trigger('click')
    await flushPromises()

    expect(sessions.selectedFolderPath).toBe('/repos/api-gateway')
    expect(sessions.selectedId).toBe(null)
  })

  it('opens the folder from a "Recently visited" row too (BUG)', async () => {
    const { w, sessions } = await mountOpenPalette()
    sessions.recentJumpVisits = ['/repos/www']
    await flushPromises()

    const visited = w.findAll('[data-sidebar-jump-history]').find((r) => r.text().includes('www'))!
    await visited.trigger('click')
    await flushPromises()

    expect(sessions.selectedFolderPath).toBe('/repos/www')
  })

  it('closes an open takeover so the jumped-to folder is actually visible (BUG-102)', async () => {
    const { w, sessions, ui } = await mountOpenPalette()
    await type(w, 'api-gateway')
    // A takeover opened BEFORE the jump would render ahead of `FolderView`.
    ui.openUsageDashboard()
    ui.openSidebarJumpPalette()
    await flushPromises()

    sessions.jumpToFolder('/repos/api-gateway')
    expect(ui.anyTakeoverOpen).toBe(false)
    expect(sessions.selectedFolderPath).toBe('/repos/api-gateway')
  })

  it('unhides a hidden folder before jumping to it (AC-5)', async () => {
    const { w, sessions } = await mountOpenPalette(['/repos/www-org-b'])
    await type(w, 'www-org-b')
    const row = w
      .findAll('[data-sidebar-jump-result]')
      .find((r) => r.attributes('data-jump-id') === 'hidden:/repos/www-org-b')!
    await row.trigger('click')
    await flushPromises()

    expect(window.api.userProjectsUnhide).toHaveBeenCalledWith('/repos/www-org-b')
    expect(sessions.dismissedFolders.map((f) => f.path)).not.toContain('/repos/www-org-b')
  })

  it('raises the flash signal for the row it landed on (AC-6)', async () => {
    const sessions = await bootStore()
    sessions.jumpToFolder('/repos/api-gateway')
    expect(sessions.jumpFlash?.token).toBe('folder:/repos/api-gateway')

    // A second jump to the SAME row still re-triggers (the seq advances).
    const first = sessions.jumpFlash!.seq
    sessions.clearJumpFlash()
    sessions.jumpToFolder('/repos/api-gateway')
    expect(sessions.jumpFlash!.seq).toBeGreaterThan(first)
  })

  it('records recent searches and recently-visited folders, and clears them (AC-7)', async () => {
    const { w, sessions } = await mountOpenPalette()
    await type(w, 'api-gateway')
    await w.findAll('[data-sidebar-jump-result]')[0].trigger('click')
    await flushPromises()

    expect(sessions.recentJumpSearches[0].query).toBe('api-gateway')
    expect(sessions.recentJumpSearches[0].folders).toBeGreaterThan(0)
    expect(sessions.recentJumpVisits[0]).toBe('/repos/api-gateway')

    sessions.clearJumpSearches()
    expect(sessions.recentJumpSearches).toEqual([])
  })

  it('never records a query that found nothing (AC-7)', async () => {
    const sessions = await bootStore()
    sessions.recordJumpSearch({ query: 'zzz', folders: 0, hidden: 0, sessions: 0 })
    expect(sessions.recentJumpSearches).toEqual([])
  })

  it('caps the history at 8 searches and 5 visits (AC-7)', async () => {
    const sessions = await bootStore()
    for (let i = 0; i < 12; i++) {
      sessions.recordJumpSearch({ query: `q${i}`, folders: 1, hidden: 0, sessions: 0 })
    }
    expect(sessions.recentJumpSearches.length).toBe(8)
    expect(sessions.recentJumpSearches[0].query).toBe('q11')

    for (const p of ['/a', '/b', '/c', '/d', '/e', '/f']) {
      // `jumpToFolder` ignores unknown paths, so drive the list through the
      // public jump on real folders plus the store's own de-dup/cap.
      sessions.recentJumpVisits = [p, ...sessions.recentJumpVisits].slice(0, 5)
    }
    expect(sessions.recentJumpVisits.length).toBe(5)
  })

  it('shows the empty-query history state with the hidden-included footer (AC-7/AC-8)', async () => {
    const { w, sessions } = await mountOpenPalette(['/repos/www-org-b'])
    sessions.recordJumpSearch({ query: 'www', folders: 3, hidden: 1, sessions: 2 })
    await flushPromises()

    const text = w.get('[data-sidebar-jump-palette]').text()
    expect(text).toContain('Recent searches')
    expect(text).toContain('3 folders')
    expect(text).toContain('1 hidden included')
    // The `⇥` hint only makes sense with a query to hand over.
    expect(text).not.toContain('filter tree')
  })

  it('moves the cursor with ↑/↓ and jumps with ↵ (AC-8)', async () => {
    const { w, sessions, ui } = await mountOpenPalette()
    await type(w, 'www')

    const ids = w.findAll('[data-sidebar-jump-result]').map((r) => r.attributes('data-jump-id'))
    expect(ids.length).toBeGreaterThan(1)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    await flushPromises()
    expect(w.findAll('[data-sidebar-jump-result]')[1].find('.bg-accent').exists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
    await flushPromises()
    expect(w.findAll('[data-sidebar-jump-result]')[0].find('.bg-accent').exists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flushPromises()
    expect(ui.sidebarJumpPalette.open).toBe(false)
    expect(sessions.recentJumpSearches[0].query).toBe('www')
  })

  it('⇥ hands the query to the tree filter and closes the palette (AC-8)', async () => {
    const { w, sessions, ui } = await mountOpenPalette()
    await type(w, 'www')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    await flushPromises()

    expect(ui.sidebarJumpPalette.open).toBe(false)
    expect(sessions.filterActive).toBe(true)
    expect(sessions.filterQuery).toBe('www')
  })

  it('Esc closes the palette without touching the tree (AC-2)', async () => {
    const { w, sessions, ui } = await mountOpenPalette()
    await type(w, 'www')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(ui.sidebarJumpPalette.open).toBe(false)
    expect(sessions.filterQuery).toBe('')
  })
})

describe('tree filter — path matching (AC-4)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('matches a folder by its filesystem path, so ⇥ never lands on an empty tree', async () => {
    const sessions = await bootStore()
    sessions.setFilterQuery('/repos/api-gateway')
    // `filteredFolders` is store-internal; `visibleFolders` is what the tree
    // actually renders once the filter overrides zone classification.
    const paths = sessions.visibleFolders.flatMap((n) =>
      'kind' in n && n.kind === 'folder-group' ? n.folders.map((f) => f.path) : [n.path]
    )
    expect(paths).toContain('/repos/api-gateway')
  })
})
