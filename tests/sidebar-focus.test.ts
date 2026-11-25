// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import { i18n } from '@renderer/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import FolderMenu from '../src/renderer/src/components/FolderMenu.vue'
import { useSessionsStore, type Session } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import type { FolderEntry, UserProject } from '../src/preload'

/**
 * Sidebar redesign S-5 — Focus on one folder (design.md §6 "Sidebar tree → Focus",
 * spec AC-21 and AC-23). jsdom has no box model: the list width with and without a
 * scrollbar (AC-24) is measured and captured in the running app. Neutral
 * vocabulary only.
 */

// …and no scrollIntoView.
Element.prototype.scrollIntoView ??= () => {}

const APP = '/w/org-a/api-gateway'
const WT = '/w/org-a/wt/PROJ-231-rate-limit'
const WEB = '/w/org-b/example-web'
const PORTAL = '/w/org-b/portal'
const NOTES = '/w/org-b/notes'
const REPO_ID = `${APP}/.git`
const FOCUS_KEY = 'om2tab.sidebarFocus'

// jsdom has no CSS.escape; the sidebar's reveal-and-scroll watches use it.
;(globalThis as unknown as { CSS?: { escape: (value: string) => string } }).CSS ??= {
  escape: (value) => value
}

function session(id: string, path: string): FolderEntry['sessions'][number] {
  const now = new Date().toISOString()
  return {
    sessionId: id,
    fullPath: `${path}/${id}.jsonl`,
    fileMtime: 1,
    firstPrompt: '',
    summary: `Summary ${id}`,
    messageCount: 1,
    created: now,
    modified: now,
    gitBranch: '',
    projectPath: path,
    isSidechain: false,
    status: 'idle',
    agents: [],
    resumable: true,
    bridged: false
  } as unknown as FolderEntry['sessions'][number]
}

function entry(path: string, ids: string[], over: Partial<FolderEntry> = {}): FolderEntry {
  return {
    path,
    alias: path.split('/').pop() ?? path,
    gitBranch: '',
    sessions: ids.map((id) => session(id, path)),
    ...over
  } as FolderEntry
}

const repo = (path: string, branch: string, ids: string[]): FolderEntry =>
  entry(path, ids, { repoId: REPO_ID, gitBranch: branch, isMainWorktree: path === APP })

/** One repo (main + worktree) and three standalone folders. */
function defaultDisk(): FolderEntry[] {
  return [
    repo(APP, 'main', ['app-1']),
    repo(WT, 'PROJ-231-rate-limit', ['wt-1']),
    entry(WEB, ['web-1']),
    entry(PORTAL, ['portal-1']),
    entry(NOTES, ['notes-1'])
  ]
}

function installWindow(disk: FolderEntry[], hidden: string[] = []): void {
  const projects = disk.map((d) => ({
    path: d.path,
    alias: d.alias,
    addedAt: new Date().toISOString(),
    worktrees: []
  })) as UserProject[]
  let hiddenPaths = [...hidden]
  const base: Record<string, unknown> = {
    foldersLoad: vi.fn(async () => disk),
    userProjectsList: vi.fn(async () => ({ projects, hiddenPaths })),
    userProjectsHide: vi.fn(async (path: string) => {
      hiddenPaths = [...hiddenPaths, path]
      return { projects, hiddenPaths }
    }),
    userProjectsUnhide: vi.fn(async (path: string) => {
      hiddenPaths = hiddenPaths.filter((p) => p !== path)
      return { projects, hiddenPaths }
    }),
    orchestratorListArmed: vi.fn(async () => []),
    // What opening the folder menu probes.
    userProjectsListBornFromCandidates: vi.fn(async () => []),
    worktreeMdProbe: vi.fn(async () => ({ manifestPath: '', exists: false, repoRoot: APP })),
    modesList: vi.fn(async () => []),
    probeGit: vi.fn(async () => []),
    getPathForFile: vi.fn(() => null)
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(base, {
    get: (target, key: string) => {
      if (key in target) return target[key]
      return key.startsWith('on') ? () => () => {} : vi.fn(async () => null)
    }
  })
}

let wrapper: VueWrapper | null = null
type Store = ReturnType<typeof useSessionsStore>

/** A cold start of the renderer: new stores over whatever `localStorage` holds. */
async function boot(disk = defaultDisk(), hidden: string[] = []): Promise<Store> {
  wrapper?.unmount()
  setActivePinia(createPinia())
  installWindow(disk, hidden)
  const store = useSessionsStore()
  wrapper = mount(Sidebar, { global: { plugins: [i18n] }, attachTo: document.body })
  await store.init()
  for (const f of store.folders) f.expanded = true
  await flushPromises()
  return store
}

const find = (selector: string): HTMLElement | null =>
  wrapper!.element.querySelector<HTMLElement>(selector)
const trees = (): string[] =>
  [...wrapper!.element.querySelectorAll('[data-tree-folder]')].map((el) =>
    (el.getAttribute('data-tree-paths') ?? '').split('|').join(' + ')
  )
const back = (): HTMLElement | null => find('[data-focus-back]')
const header = (path: string): HTMLElement =>
  wrapper!.element.querySelector<HTMLElement>(
    `[data-tree-paths^="${path}"] [data-folder-head]`
  ) as HTMLElement

async function focusFolder(path: string): Promise<void> {
  const button = header(path).querySelector<HTMLElement>('[data-focus-button]')
  expect(button, `Focus button on ${path}`).not.toBeNull()
  button!.click()
  await flushPromises()
}

function setState(store: Store, id: string, taskState: Session['taskState']): void {
  const s = store.findSessionById(id)!
  s.taskState = taskState
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
  localStorage.clear()
})

describe('AC-21 Focus on one folder', () => {
  it('focus shows one folder under the back row', async () => {
    const store = await boot()
    setState(store, 'web-1', 'failed')
    setState(store, 'portal-1', 'needs-input')
    await flushPromises()

    expect(trees()).toHaveLength(4)
    expect(back()).toBeNull()

    await focusFolder(APP)

    // Exactly one folder, with both of its checkouts and sessions.
    expect(trees()).toEqual([`${APP} + ${WT}`])
    expect(find('[data-session-id="app-1"]')).not.toBeNull()
    expect(find('[data-session-id="wt-1"]')).not.toBeNull()

    // The back row is the whole sticky button, above the folder, inside the list.
    const row = back()!
    expect(row.tagName).toBe('BUTTON')
    expect(row.classList.contains('sticky')).toBe(true)
    expect(row.closest('[data-dsqa-part="tree"]')).not.toBeNull()
    expect(
      row.compareDocumentPosition(find('[data-tree-folder]')!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(row.querySelector('[data-focus-back-label]')!.textContent!.trim()).toBe('All folders')
    expect(row.querySelector('[data-focus-back-meta]')!.textContent!.trim()).toBe(
      '3 others · 1 needs you · 1 failed'
    )

    row.click()
    await flushPromises()
    expect(back()).toBeNull()
    expect(trees()).toHaveLength(4)
  })

  it('counts live, and says nothing about what is zero', async () => {
    const store = await boot()
    await focusFolder(WEB)
    const meta = (): string => back()!.querySelector('[data-focus-back-meta]')!.textContent!.trim()
    // The repo is one folder, whatever its checkouts.
    expect(meta()).toBe('3 others')

    setState(store, 'app-1', 'needs-input')
    setState(store, 'wt-1', 'failed')
    await flushPromises()
    // A folder counts once, at its hottest session.
    expect(meta()).toBe('3 others · 1 needs you')

    setState(store, 'portal-1', 'needs-input')
    await flushPromises()
    expect(meta()).toBe('3 others · 2 need you')
  })

  it('keeps the folder open with no collapse and no focus button', async () => {
    const store = await boot()
    store.toggleTreeFolder(`repo:${REPO_ID}`)
    await flushPromises()
    await focusFolder(APP)

    expect(find('[data-folder-content]')!.getAttribute('data-open')).toBe('true')
    const head = find('[data-folder-head]')!
    expect(head.querySelector('[data-focus-button]')).toBeNull()
    expect(head.querySelector('[data-value-chevron]')).toBeNull()

    // The arrow cursor cannot fold it either.
    store.keyboardCursor = { kind: 'group', id: `repo:${REPO_ID}` }
    store.cursorLeft()
    await nextTick()
    expect(find('[data-folder-content]')!.getAttribute('data-open')).toBe('true')
  })

  it('walks only the focused folder with the arrow cursor', async () => {
    const store = await boot()
    await focusFolder(NOTES)
    const seen: string[] = []
    for (let i = 0; i < 6; i++) {
      store.cursorDown()
      seen.push(store.keyboardCursor!.id)
    }
    expect([...new Set(seen)]).toEqual([NOTES, 'notes-1'])
  })

  it('leaves Focus at level 0 of the collapse button', async () => {
    const store = await boot()
    await focusFolder(APP)
    const collapse = (): HTMLElement => find('[data-collapse-level]')!
    expect(collapse().getAttribute('data-collapse-level')).toBe('2')

    collapse().click()
    await flushPromises()
    expect(collapse().getAttribute('data-collapse-level')).toBe('1')
    expect(back()).not.toBeNull()

    collapse().click()
    await flushPromises()
    expect(back()).toBeNull()
    expect(store.collapseLevel).toBe(0)
  })

  it('goes from a folder with no checkout row straight to level 0', async () => {
    await boot()
    await focusFolder(NOTES)
    expect(find('[data-collapse-level]')!.getAttribute('data-collapse-level')).toBe('1')
    find('[data-collapse-level]')!.click()
    await flushPromises()
    expect(back()).toBeNull()
  })

  it('keeps showing a focused folder that has gone quiet', async () => {
    await boot()
    await focusFolder(NOTES)
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const disk = defaultDisk()
    disk[4].sessions[0].modified = old
    // Unpinned, with no recent session: stale, so the full list would not draw it.
    wrapper?.unmount()
    setActivePinia(createPinia())
    installWindow(disk)
    ;(window.api as unknown as Record<string, unknown>).userProjectsList = vi.fn(async () => ({
      projects: [],
      hiddenPaths: []
    }))
    const store = useSessionsStore()
    wrapper = mount(Sidebar, { global: { plugins: [i18n] }, attachTo: document.body })
    await store.init()
    await flushPromises()

    expect(trees()).toEqual([NOTES])
    back()!.click()
    await flushPromises()
    expect(trees()).not.toContain(NOTES)
  })

  it('keeps Enter and Space on its two buttons away from the global shortcuts', async () => {
    await boot()
    const reached: string[] = []
    const spy = (e: KeyboardEvent): void => void reached.push(e.key)
    window.addEventListener('keydown', spy)
    const press = (el: Element): void => {
      for (const key of ['Enter', ' ']) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      }
    }
    press(header(APP).querySelector('[data-focus-button]')!)
    await focusFolder(APP)
    press(back()!)
    window.removeEventListener('keydown', spy)
    expect(reached).toEqual([])
  })

  it('leaves no folder hover card behind the Focus button', async () => {
    await boot()
    vi.useFakeTimers()
    try {
      const ui = useUiStore()
      const head = header(APP)
      head.dispatchEvent(new MouseEvent('mouseenter'))
      head.querySelector<HTMLElement>('[data-focus-button]')!.click()
      await vi.advanceTimersByTimeAsync(1000)
      expect(ui.preview.open).toBe(false)

      // A card already on screen closes too.
      back()!.click()
      await nextTick()
      header(APP).dispatchEvent(new MouseEvent('mouseenter'))
      await vi.advanceTimersByTimeAsync(500)
      expect(ui.preview.open).toBe(true)
      header(APP).querySelector<HTMLElement>('[data-focus-button]')!.click()
      await vi.advanceTimersByTimeAsync(1000)
      expect(ui.preview.open).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers no drill-depth button in the toolbar', async () => {
    await boot()
    expect(find('[data-drill-toggle]')).toBeNull()
  })
})

describe('AC-21 the folder menu is the other way in', () => {
  const item = (): HTMLElement | undefined =>
    [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === 'Focus this folder'
    )

  async function openMenu(path: string): Promise<void> {
    useUiStore().openFolderMenu({ projectPath: path, x: 10, y: 10 })
    await flushPromises()
  }

  it('offers Focus for another folder and not for the focused one', async () => {
    const store = await boot()
    const menu = mount(FolderMenu, { global: { plugins: [i18n] }, attachTo: document.body })

    await openMenu(WT)
    item()!.click()
    await flushPromises()
    // A checkout's menu focuses its whole folder.
    expect(store.sidebarFocus).toBe(APP)
    expect(trees()).toEqual([`${APP} + ${WT}`])

    await openMenu(WT)
    expect(item()).toBeUndefined()
    useUiStore().closeFolderMenu()
    await openMenu(WEB)
    expect(item()).toBeDefined()
    menu.unmount()
  })
})

describe('AC-23 Focus follows the selection and survives a restart', () => {
  it('ignores a stored value that is not a path', async () => {
    localStorage.setItem(FOCUS_KEY, '{"kind":"folder"}')
    await boot()
    expect(back()).toBeNull()
    expect(trees()).toHaveLength(4)
  })

  it('leaves and restores focus', async () => {
    let store = await boot()
    await focusFolder(APP)

    // A session of the focused folder keeps Focus, in any of its checkouts.
    store.select('wt-1')
    await flushPromises()
    expect(back()).not.toBeNull()

    // A session outside it leaves Focus.
    store.select('web-1')
    await flushPromises()
    expect(back()).toBeNull()
    expect(trees()).toHaveLength(4)

    // Also when that session was already the selected one (Needs attention row).
    await focusFolder(APP)
    expect(store.selectedId).toBe('web-1')
    expect(back()).not.toBeNull()
    store.activateSession('web-1')
    await flushPromises()
    expect(back()).toBeNull()

    // The focused folder survives a restart…
    await focusFolder(PORTAL)
    await nextTick()
    expect(localStorage.getItem(FOCUS_KEY)).toBe(JSON.stringify(PORTAL))
    store = await boot()
    expect(back()).not.toBeNull()
    expect(trees()).toEqual([PORTAL])

    // …and is dropped when it is no longer known…
    store = await boot(defaultDisk().filter((f) => f.path !== PORTAL))
    expect(back()).toBeNull()
    expect(trees()).toHaveLength(3)
    await nextTick()
    expect(localStorage.getItem(FOCUS_KEY)).toBe('null')

    // …or when the operator dismissed it.
    localStorage.setItem(FOCUS_KEY, JSON.stringify(PORTAL))
    store = await boot(defaultDisk(), [PORTAL])
    expect(back()).toBeNull()
    expect(trees()).toHaveLength(3)
  })

  it('drops Focus as soon as the focused folder is hidden', async () => {
    const store = await boot()
    await focusFolder(PORTAL)
    await store.dismissFolder(PORTAL)
    await flushPromises()
    expect(back()).toBeNull()
    await store.unhideFolder(PORTAL)
    await flushPromises()
    expect(back()).toBeNull()
  })

  it('leaves Focus when a jump lands on another folder', async () => {
    const store = await boot()
    await focusFolder(APP)
    store.jumpToFolder(WEB)
    await flushPromises()
    expect(back()).toBeNull()
  })
})
