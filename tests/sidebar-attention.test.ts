// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import { i18n } from '@renderer/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import { useSessionsStore, type Session } from '../src/renderer/src/stores/sessions'
import type { FolderEntry } from '../src/preload'

/**
 * Sidebar redesign S-4 — "Needs attention" (design.md §6 "Needs attention", spec AC-16): the strip
 * pinned between the toolbar and the list. jsdom has no box model, so this file pins what is listed,
 * in what order, where it sits in the column and what a click does; the geometry is measured in the
 * running app. Neutral vocabulary only.
 */

// jsdom has no CSS.escape; the sidebar's reveal-and-scroll watch uses it, a tick after the click.
;(globalThis as unknown as { CSS?: { escape: (value: string) => string } }).CSS ??= {
  escape: (value) => value
}
// jsdom does not implement scrolling either.
Element.prototype.scrollIntoView ??= () => {}

const APP = '/w/org-a/api-gateway'
const WT_FEAT = '/w/org-a/wt/PROJ-231-rate-limit'
const PLAIN = '/w/org-b/example-web'
const REPO_ID = `${APP}/.git`

const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()

function session(id: string, path: string, over: Partial<Session> = {}): Session {
  return {
    sessionId: id,
    fullPath: `${path}/${id}.jsonl`,
    fileMtime: 1,
    firstPrompt: '',
    summary: `Summary ${id}`,
    messageCount: 1,
    created: at(60),
    modified: at(1),
    gitBranch: 'main',
    projectPath: path,
    isSidechain: false,
    status: 'idle',
    ...over
  } as Session
}

function entry(path: string, sessions: Session[], over: Partial<FolderEntry> = {}): FolderEntry {
  return {
    path,
    alias: path.split('/').pop()!,
    worktrees: [],
    sessions,
    ...over
  } as FolderEntry
}

function disk(): FolderEntry[] {
  return [
    entry(
      APP,
      [
        session('working', APP, { taskState: 'working', status: 'active' }),
        session('failed-old', APP, { taskState: 'failed', created: at(50) }),
        session('needs-old', APP, { taskState: 'needs-input', created: at(40) }),
        session('done', APP, { taskState: 'completed' })
      ],
      { repoId: REPO_ID, gitBranch: 'main', isMainWorktree: true }
    ),
    entry(
      WT_FEAT,
      [
        session('needs-new', WT_FEAT, { taskState: 'needs-input', created: at(5) }),
        session('idle', WT_FEAT),
        session('needs-side', WT_FEAT, { taskState: 'needs-input', isSidechain: true })
      ],
      { repoId: REPO_ID, gitBranch: 'PROJ-231-rate-limit', isMainWorktree: false }
    ),
    entry(PLAIN, [session('failed-new', PLAIN, { taskState: 'failed', created: at(2) })])
  ]
}

function installWindow(folders: FolderEntry[]): void {
  ;(window as unknown as { api: unknown }).api = {
    foldersLoad: vi.fn(async () => folders),
    userProjectsList: vi.fn(async () => ({
      projects: folders.map((d) => ({
        path: d.path,
        alias: d.alias,
        addedAt: new Date().toISOString(),
        worktrees: []
      })),
      hiddenPaths: []
    })),
    orchestratorListArmed: vi.fn(async () => []),
    probeGit: vi.fn(async () => []),
    getPathForFile: vi.fn(() => null),
    worktreeMdProbe: vi.fn(async () => ({ manifestPath: '', exists: false, repoRoot: APP })),
    userProjectsListBornFromCandidates: vi.fn(async () => [])
  }
}

let wrapper: VueWrapper | null = null

async function boot(folders: FolderEntry[] = disk()): Promise<{
  w: VueWrapper
  store: ReturnType<typeof useSessionsStore>
}> {
  installWindow(folders)
  const store = useSessionsStore()
  await store.reloadModel()
  wrapper = mount(Sidebar, { global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  return { w: wrapper, store }
}

const rows = (w: VueWrapper): string[] =>
  w.findAll('[data-attention-session]').map((r) => r.attributes('data-attention-session')!)

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
  setActivePinia(createPinia())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('Needs attention', () => {
  it('lists only needs-input and failed', async () => {
    const { w } = await boot()

    // needs-input first, then failed; newest created first inside a tier; every folder.
    expect(rows(w)).toEqual(['needs-new', 'needs-old', 'failed-new', 'failed-old'])

    const section = w.get('[data-attention]')
    for (const row of section.findAll('[data-attention-session]')) {
      expect((row.element as HTMLElement).style.height).toBe('28px')
      expect(row.element.tagName).toBe('BUTTON')
    }
    expect(section.get('[data-attention-head]').text()).toContain('Needs attention')
    expect(section.get('[data-attention-head]').text()).toContain('4')

    // Pinned between the toolbar and the list: it never scrolls away with the tree.
    const list = w.get('[data-island="sidebar-list"]')
    const column = [...list.element.children]
    const index = (selector: string): number => column.findIndex((c) => c.matches(selector))
    expect(index('[data-attention]')).toBeGreaterThan(index('header'))
    expect(index('[data-attention]')).toBeLessThan(index('[data-dsqa-part="tree"]'))
  })

  it('is absent when nothing needs the operator, and appears when something does', async () => {
    const { w, store } = await boot([entry(PLAIN, [session('quiet', PLAIN)])])
    expect(w.find('[data-attention]').exists()).toBe(false)

    store.findSessionById('quiet')!.taskState = 'failed'
    await nextTick()
    expect(rows(w)).toEqual(['quiet'])

    store.findSessionById('quiet')!.taskState = 'working'
    await nextTick()
    expect(w.find('[data-attention]').exists()).toBe(false)
  })

  it('leaves archived sessions out and ignores the inline filter', async () => {
    const { w, store } = await boot()
    store.archiveSession('failed-new')
    store.setFilterQuery('no such folder')
    await nextTick()
    expect(rows(w)).toEqual(['needs-new', 'needs-old', 'failed-old'])
  })

  // jsdom has no box model: what the list island reserves is pinned, the pixels are measured live.
  it('reserves its full height in the list island, so an open dock body scrolls first', async () => {
    const { w, store } = await boot()
    const reserved = (): string => w.get('[data-island="sidebar-list"]').attributes('style') ?? ''
    // 37px head plus four 28px rows on top of the folder list's own minimum, capped so that both
    // dock heads and Add folder (111px) stay on screen.
    expect(reserved()).toContain('calc(min(160px, 40vh) + 149px)')
    expect(reserved()).toContain('calc(100% - 111px)')

    await w.get('[data-attention-head]').trigger('click')
    expect(reserved()).toContain('calc(min(160px, 40vh) + 37px)')

    for (const f of store.folders) for (const s of f.sessions) s.taskState = 'working'
    await nextTick()
    expect(reserved()).not.toContain('calc(')
  })

  it('names the folder of the tree, not the worktree, also when the filter hides it', async () => {
    const { w, store } = await boot()
    const folderOf = (id: string): string =>
      w.get(`[data-attention-session="${id}"] [data-attention-folder]`).text()

    // needs-new works in a worktree of api-gateway: the header's name is what places it.
    expect(folderOf('needs-new')).toBe('api-gateway')
    expect(folderOf('failed-new')).toBe('example-web')

    store.setFilterQuery('no such folder')
    await nextTick()
    expect(folderOf('needs-new')).toBe('api-gateway')
  })

  it('orders by creation, never by activity, with an unreadable date last (T459)', async () => {
    const { w, store } = await boot([
      entry(PLAIN, [
        session('older', PLAIN, { taskState: 'needs-input', created: at(30) }),
        session('newer', PLAIN, { taskState: 'needs-input', created: at(10) }),
        session('undated', PLAIN, { taskState: 'needs-input', created: '' })
      ])
    ])
    expect(rows(w)).toEqual(['newer', 'older', 'undated'])

    store.findSessionById('older')!.modified = new Date().toISOString()
    await nextTick()
    expect(rows(w)).toEqual(['newer', 'older', 'undated'])
  })

  it('a click lands on the session, opening its folder and checkout', async () => {
    const { w, store } = await boot()
    const folder = store.folders.find((f) => f.path === WT_FEAT)!
    folder.expanded = false
    store.toggleCheckoutFold(WT_FEAT)
    await nextTick()

    await w.get('[data-attention-session="needs-new"]').trigger('click')
    await flushPromises()

    expect(store.selectedId).toBe('needs-new')
    expect(folder.expanded).toBe(true)
    expect(store.isCheckoutFolded(WT_FEAT)).toBe(false)
  })

  it('is open by default and the head folds it, remembering that', async () => {
    const { w } = await boot()
    const head = w.get('[data-attention-head]')
    expect(head.attributes('aria-expanded')).toBe('true')

    await head.trigger('click')
    expect(head.attributes('aria-expanded')).toBe('false')
    expect(w.get('[data-attention-body]').attributes('style')).toContain('display: none')
    expect(localStorage.getItem('om2tab.attentionOpen')).toBe('false')
  })

  it('says why a row is there: its folder, and the pending command as the tooltip', async () => {
    const { w, store } = await boot()
    store.addPendingApproval({
      requestId: 'r1',
      sessionId: 'needs-old',
      summary: 'Bash(npm run migrate)',
      createdAtMs: Date.now()
    } as Parameters<typeof store.addPendingApproval>[0])
    await nextTick()

    const row = w.get('[data-attention-session="needs-old"]')
    expect(row.text()).toContain('Summary needs-old')
    expect(row.text()).toContain('api-gateway')
    expect(row.attributes('title')).toBe('Bash(npm run migrate)')
    expect(row.find('.fleet-ring--needs-input').exists()).toBe(true)
    expect(
      w.get('[data-attention-session="failed-old"]').find('.fleet-ring--errored').exists()
    ).toBe(true)
  })
})
