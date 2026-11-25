// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'
import { i18n } from '@renderer/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import FolderMenu from '../src/renderer/src/components/FolderMenu.vue'
import { useSidebarActions } from '../src/renderer/src/composables/useSidebarActions'
import { useSessionsStore, type Session } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useGcStore } from '../src/renderer/src/stores/gc'
import { useMissionsStore, type ChipModel } from '../src/renderer/src/stores/missions'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { GcSnapshot } from '../src/main/gc/gc-wire'
import type { FolderEntry, UserProject } from '../src/preload'

/**
 * Sidebar redesign S-1 — the flat checkout tree (design.md §6 "Sidebar tree",
 * docs/specs/2026-11-25-sidebar-redesign/spec.md AC-1, 2, 5-9). Neutral
 * vocabulary only.
 */

const APP = '/w/org-a/api-gateway'
const WT_FEAT = '/w/org-a/wt/PROJ-231-rate-limit'
const WT_IDLE_A = '/w/org-a/wt/PROJ-232-redis-pool'
const WT_IDLE_B = '/w/org-a/wt/PROJ-198-health-checks'
const NOTES = '/w/org-b/notes'
const PLAIN = '/w/org-b/example-web'
const REPO_ID = `${APP}/.git`

const DAY = 86_400_000

function session(id: string, path: string, over: Record<string, unknown> = {}): Session {
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
    gitBranch: 'feat/branch-on-session',
    projectPath: path,
    isSidechain: false,
    status: 'idle',
    resumable: true,
    bridged: false,
    agents: [],
    ...over
  } as unknown as Session
}

function entry(path: string, sessions: Session[], over: Partial<FolderEntry> = {}): FolderEntry {
  return {
    path,
    alias: path.split('/').pop() ?? path,
    gitBranch: '',
    sessions: sessions as unknown as FolderEntry['sessions'],
    ...over
  } as FolderEntry
}

const repoEntry = (
  path: string,
  branch: string,
  sessions: Session[],
  over: Partial<FolderEntry> = {}
): FolderEntry =>
  entry(path, sessions, {
    repoId: REPO_ID,
    gitBranch: branch,
    isMainWorktree: path === APP,
    ...over
  })

/** One repo (main + 3 worktrees, one born from another) and two sibling non-git folders. */
function defaultDisk(): FolderEntry[] {
  const old = new Date(Date.now() - 10 * DAY).toISOString()
  return [
    // The worktree is listed first on disk: the tree still draws main first.
    repoEntry(WT_FEAT, 'PROJ-231-rate-limit', [session('feat-1', WT_FEAT)], {
      bornFrom: APP
    } as Partial<FolderEntry>),
    repoEntry(APP, 'main', [
      session('main-1', APP),
      // Outside the 48h age window: hidden, reachable through "Show older".
      session('main-old', APP, { modified: old, created: old }),
      session('main-archived', APP)
    ]),
    repoEntry(WT_IDLE_A, 'PROJ-232-redis-pool', []),
    repoEntry(WT_IDLE_B, 'PROJ-198-health-checks', []),
    entry(NOTES, [session('notes-1', NOTES)]),
    entry(PLAIN, [session('plain-1', PLAIN)])
  ]
}

interface Setup {
  disk?: FolderEntry[]
  flags?: Record<string, Partial<UserProject>>
}

function installWindow({ disk = defaultDisk(), flags = {} }: Setup): void {
  const projects = disk.map((d) => ({
    path: d.path,
    alias: d.alias,
    addedAt: new Date().toISOString(),
    worktrees: [],
    ...flags[d.path]
  }))
  ;(window as unknown as { api: unknown }).api = {
    foldersLoad: vi.fn(async () => disk),
    userProjectsList: vi.fn(async () => ({ projects, hiddenPaths: [] })),
    orchestratorListArmed: vi.fn(async () => []),
    probeGit: vi.fn(async () => []),
    getPathForFile: vi.fn(() => null),
    worktreeMdProbe: vi.fn(async () => ({ manifestPath: '', exists: false, repoRoot: APP })),
    userProjectsListBornFromCandidates: vi.fn(async () => [])
  }
}

let wrappers: VueWrapper[] = []

async function boot(setup: Setup = {}): Promise<{
  w: VueWrapper
  store: ReturnType<typeof useSessionsStore>
}> {
  installWindow(setup)
  const store = useSessionsStore()
  await store.reloadModel()
  // Standalone folders start closed (as today); the tree specs look inside them.
  for (const f of store.folders) f.expanded = true
  const w = mount(Sidebar, { global: { plugins: [i18n] }, attachTo: document.body })
  wrappers.push(w)
  await flushPromises()
  return { w, store }
}

const block = (w: VueWrapper, path: string): ReturnType<VueWrapper['get']> => {
  const found = w
    .findAll('[data-tree-folder]')
    .find((n) => (n.attributes('data-tree-paths') ?? '').split('|').includes(path))
  if (!found) throw new Error(`no tree folder holds ${path}`)
  return found
}

const checkoutRow = (w: VueWrapper, path: string): ReturnType<VueWrapper['get']> =>
  w.get(`[data-checkout-row][data-checkout-path="${path}"]`)

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  // jsdom has neither; the sidebar's reveal-and-flash watchers call both.
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers = []
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('sidebar flat checkout tree (S-1)', () => {
  it('renders flat checkouts under each folder header', async () => {
    const { w } = await boot()

    // One block, one header per repo or standalone folder.
    const blocks = w.findAll('[data-tree-folder]')
    expect(blocks).toHaveLength(3)
    for (const b of blocks) expect(b.findAll('[data-folder-head]')).toHaveLength(1)

    // No repo-group, parent-directory or lineage row.
    expect(w.find('[data-sidebar-row^="group:path:"]').exists()).toBe(false)
    expect(w.find('[data-sidebar-row="group:path:/w/org-b"]').exists()).toBe(false)
    expect(w.find('.lucide-git-fork').exists()).toBe(false)

    // Main first, then worktrees, each followed by its own sessions.
    const repo = block(w, APP)
    const order = repo
      .findAll('[data-checkout-row], [data-session-row]')
      .map((n) => n.attributes('data-checkout-path') ?? n.attributes('data-session-id'))
    expect(order.slice(0, 2)).toEqual([APP, 'main-1'])
    expect(order.indexOf(WT_FEAT)).toBeGreaterThan(order.indexOf('main-1'))
    expect(order[order.indexOf(WT_FEAT) + 1]).toBe('feat-1')

    // Every checkout row sits at the same indent (the born-from one too).
    const paddings = repo
      .findAll('[data-checkout-row]')
      .map((n) => (n.element as HTMLElement).style.paddingLeft)
    expect(new Set(paddings)).toEqual(new Set(['14px']))

    // A non-git folder has no checkout row: sessions sit directly under its header.
    const plain = block(w, PLAIN)
    expect(plain.find('[data-checkout-row]').exists()).toBe(false)
    expect(plain.find('[data-session-id="plain-1"]').exists()).toBe(true)
  })

  it('folds sessionless worktrees into one row', async () => {
    const { w, store } = await boot()
    const repo = block(w, APP)

    const idle = repo.get('[data-idle-row]')
    expect(idle.text()).toContain('2 idle worktrees')
    expect(idle.attributes('aria-expanded')).toBe('false')
    expect(repo.find(`[data-checkout-path="${WT_IDLE_A}"][data-checkout-row]`).exists()).toBe(false)
    expect(repo.findAll('[data-idle-worktree]')).toHaveLength(0)

    await idle.trigger('click')
    expect(repo.findAll('[data-idle-worktree]')).toHaveLength(2)

    // A worktree that gains a session leaves the group at once.
    store.folders.find((f) => f.path === WT_IDLE_A)!.sessions.push(session('late-1', WT_IDLE_A))
    await nextTick()
    expect(checkoutRow(w, WT_IDLE_A).exists()).toBe(true)
    expect(repo.get('[data-idle-row]').text()).toContain('1 idle worktree')
    expect(repo.findAll('[data-idle-worktree]')).toHaveLength(1)

    // The main checkout is never folded into it, even with no session.
    store.folders.find((f) => f.path === APP)!.sessions.splice(0)
    await nextTick()
    expect(checkoutRow(w, APP).exists()).toBe(true)
    expect(repo.get('[data-idle-row]').text()).toContain('1 idle worktree')
  })

  it('count and chevron share the value slot', async () => {
    const { w } = await boot()
    const repo = block(w, APP)

    for (const row of [repo.get('[data-folder-head]'), checkoutRow(w, APP)]) {
      const slot = row.get('[data-value-slot]')
      // One fixed 24 × 16 box, so the swap can never shift the row.
      expect(slot.classes()).toEqual(expect.arrayContaining(['relative', 'w-6', 'h-4', 'shrink-0']))
      const count = slot.get('[data-value-count]')
      const chevron = slot.get('[data-value-chevron]')
      expect(count.classes()).toContain('group-hover:opacity-0')
      expect(chevron.classes()).toEqual(
        expect.arrayContaining(['absolute', 'opacity-0', 'group-hover:opacity-100'])
      )
      // Keyboard focus swaps them too.
      expect(count.classes().some((c) => c.includes('focus'))).toBe(true)
      expect(chevron.classes().some((c) => c.includes('focus'))).toBe(true)
    }

    // The header counts its checkouts (idle ones included).
    expect(repo.get('[data-folder-head] [data-value-count]').text()).toBe('4')

    // A checkout counts its sessions only while folded.
    const count = (): string => checkoutRow(w, APP).get('[data-value-count]').text()
    expect(count()).toBe('')
    await checkoutRow(w, APP).trigger('click')
    expect(checkoutRow(w, APP).attributes('aria-expanded')).toBe('false')
    // main-1 and main-archived: the old one is outside the age window.
    expect(count()).toBe('2')
  })

  it('session row has no age and a compact mission chip', async () => {
    const chip: ChipModel = {
      text: '2/5 · 1 for you',
      compact: '2/5 · 1 for you',
      tone: 'warning',
      needsYou: true,
      owed: 1
    }
    const missions = useMissionsStore()
    vi.spyOn(missions, 'chipFor').mockImplementation((id) =>
      id === 'main-1' ? chip : id === 'feat-1' ? { ...chip, needsYou: false, owed: 0 } : null
    )
    const { w } = await boot()

    const row = w.get('[data-session-row][data-session-id="main-1"]')
    // No age, context or branch: at rest the row reads title + owed number only.
    const full = row.get('[data-mission-full]')
    expect(row.text().replace(full.text(), '').replace(/\s+/g, ' ').trim()).toBe('Summary main-1 1')
    expect(row.text()).not.toContain('feat/branch-on-session')

    expect(row.get('[data-mission-count]').text()).toBe('1')
    expect(full.text()).toBe('2/5 · 1 for you')
    // Overlaid on the title tail: it takes no width.
    expect(full.classes()).toEqual(
      expect.arrayContaining(['absolute', 'opacity-0', 'group-hover:opacity-100'])
    )
    expect(row.get('[data-icon-slot]').classes()).toEqual(
      expect.arrayContaining(['w-3.5', 'shrink-0'])
    )

    // Nothing owed: no chip at rest, the full text still reachable on hover.
    const quiet = w.get('[data-session-row][data-session-id="feat-1"]')
    expect(quiet.find('[data-mission-count]').exists()).toBe(false)
    expect(quiet.get('[data-mission-full]').classes()).toContain('absolute')
  })

  it('collapse button cycles three levels', async () => {
    const { w } = await boot()
    const button = (): ReturnType<VueWrapper['get']> => w.get('[data-collapse-level]')
    const dots = (): number => button().findAll('[data-level-dot]').length
    const folderOpen = (): string[] =>
      w.findAll('[data-folder-content]').map((n) => n.attributes('data-open') ?? '')
    const checkoutOpen = (): string[] =>
      w.findAll('[data-checkout-row]').map((n) => n.attributes('aria-expanded') ?? '')

    // Level 2: everything open.
    expect(button().attributes('data-collapse-level')).toBe('2')
    expect(button().attributes('aria-label')).toBe('Collapse sessions')
    expect(dots()).toBe(3)

    await button().trigger('click')
    expect(button().attributes('data-collapse-level')).toBe('1')
    expect(button().attributes('aria-label')).toBe('Collapse folders')
    expect(dots()).toBe(2)
    expect(checkoutOpen()).toEqual(['false', 'false'])
    expect(block(w, APP).get('[data-folder-content]').attributes('data-open')).toBe('true')

    await button().trigger('click')
    expect(button().attributes('data-collapse-level')).toBe('0')
    expect(button().attributes('aria-label')).toBe('Expand all')
    // The approved mockup keeps one dot at "folders folded" (the spec's AC-7
    // wording says zero: reported to the operator as a spec finding).
    expect(dots()).toBe(1)
    expect(new Set(folderOpen())).toEqual(new Set(['false']))

    await button().trigger('click')
    expect(button().attributes('data-collapse-level')).toBe('2')
    expect(new Set(folderOpen())).toEqual(new Set(['true']))
    expect(checkoutOpen()).toEqual(['true', 'true'])
  })

  it('keeps folder actions and signals', async () => {
    const helpers = useHelpersStore()
    vi.spyOn(helpers, 'unseenAgentPaneCount').mockImplementation((p) => (p === WT_FEAT ? 2 : 0))
    useGcStore().snapshot = {
      scannedAt: Date.now(),
      bundles: [],
      orphanVolumes: [],
      orphanTranscripts: [],
      stackLeftovers: [],
      docker: { buildCacheReclaimableBytes: null, danglingImages: null, orphanVolumesHidden: null },
      prefs: defaultGcPrefs(),
      lastCycle: null,
      nextCycleAt: null,
      nextClean: null,
      backgroundScan: false,
      archives: { repos: [], retentionDays: 30, total: { count: 0, bytes: 0 } },
      trash: { entries: [], totalBytes: 0 },
      shelved: [
        {
          id: `${APP}::branch::PROJ-347-wave-1`,
          repoPath: APP,
          worktreePath: '/w/org-a/wt/PROJ-347-wave-1',
          branch: 'PROJ-347-wave-1',
          headSha: 'abc123',
          namespace: 'refs/archive/x',
          shelvedAt: Date.now() - 9 * DAY,
          idleDays: 11,
          reason: 'Shelved',
          freedBytes: null
        }
      ]
    } as unknown as GcSnapshot
    const { w, store } = await boot({
      flags: {
        [WT_FEAT]: { agentDenied: true } as Partial<UserProject>,
        [WT_IDLE_A]: { orchestratorDefault: true } as Partial<UserProject>
      }
    })
    store.archiveSession('main-archived')
    await nextTick()

    // Signals of ANY checkout stay visible on the folder header.
    const head = block(w, APP).get('[data-folder-head]')
    expect(head.get('[data-signal="agent-panes"]').text()).toBe('2')
    expect(head.get('[data-signal="agent-blocked"]').attributes('title')).toContain(
      'PROJ-231-rate-limit'
    )
    expect(head.get('[data-signal="orchestrator-default"]').attributes('title')).toContain(
      'PROJ-232-redis-pool'
    )
    // The Shelved section stays the last block of the folder.
    expect(block(w, APP).find('[data-shelved-section]').exists()).toBe(true)

    const ui = useUiStore()
    const menu = mount(FolderMenu, { global: { plugins: [i18n] }, attachTo: document.body })
    wrappers.push(menu)
    const items = (): string[] =>
      [...document.body.querySelectorAll('[role="menu"] [role="menuitem"]')].map(
        (el) => el.querySelector('.flex-1')?.textContent?.trim() ?? ''
      )

    // A checkout row's menu carries what the old folder row offered inline.
    await checkoutRow(w, APP).trigger('contextmenu')
    await flushPromises()
    expect(ui.folderMenu.projectPath).toBe(APP)
    expect(items()).toEqual(
      expect.arrayContaining(['New session', 'Show older (1)', 'Show archived (1)'])
    )
    expect(items()).not.toContain('Rename repo')
    ui.closeFolderMenu()
    await nextTick()

    // The repo header's menu adds what the repo-group row offered.
    store.setGroupAlias(`repo:${REPO_ID}`, 'gateway')
    await nextTick()
    await block(w, APP).get('[data-folder-head]').trigger('contextmenu')
    await flushPromises()
    expect(ui.folderMenu.projectPath).toBe(APP)
    expect(items()).toEqual(
      expect.arrayContaining(['New session', 'Rename repo', 'Reset name', 'Clean up'])
    )
    expect(head.text()).toContain('gateway')
  })

  it('header click selects, chevron collapses', async () => {
    const { w, store } = await boot()
    const repo = block(w, APP)
    const content = (): string | undefined =>
      repo.get('[data-folder-content]').attributes('data-open')

    await repo.get('[data-folder-head]').trigger('click')
    expect(store.selectedFolderPath).toBe(APP)
    expect(content()).toBe('true')
    // A second click never collapses.
    await repo.get('[data-folder-head]').trigger('click')
    expect(content()).toBe('true')

    store.clearSelection()
    await repo.get('[data-folder-chevron]').trigger('click')
    expect(content()).toBe('false')
    expect(store.selectedFolderPath).toBeNull()

    // Clicking a collapsed header opens it again, and selects.
    await repo.get('[data-folder-head]').trigger('click')
    expect(content()).toBe('true')
    expect(store.selectedFolderPath).toBe(APP)
  })

  it('the ring never points at a row that is not there', async () => {
    const old = new Date(Date.now() - 10 * DAY).toISOString()
    const disk = defaultDisk()
    // A dead, unanswered question outside the age window, and an idle shell.
    disk[1].sessions.push(
      session('stale-question', APP, {
        transcriptState: 'needs-input',
        modified: old,
        created: old
      }) as never,
      session('shellterm-1', APP, { isShellTerminal: true, status: 'active' }) as never
    )
    const { w } = await boot({ disk })
    expect(w.find('[data-session-id="stale-question"]').exists()).toBe(false)
    const ring = block(w, APP).get('[data-folder-head] .fleet-ring')
    expect(ring.classes()).toContain('fleet-ring--idle')
  })

  it('a row added or jumped to is never left inside a folded checkout', async () => {
    const { store } = await boot()
    store.setCheckoutFolded(APP, true)
    store.createNewSession(APP)
    expect(store.isCheckoutFolded(APP)).toBe(false)

    store.select('main-1')
    store.setCheckoutFolded(APP, true)
    store.jumpToSession('main-1')
    expect(store.isCheckoutFolded(APP)).toBe(false)

    store.setCheckoutFolded(APP, true)
    store.activateSession('main-1')
    expect(store.isCheckoutFolded(APP)).toBe(false)
  })

  it('losing the last other worktree does not close the folder', async () => {
    const disk = defaultDisk().filter((d) => d.path === APP || d.path === WT_FEAT)
    const { w, store } = await boot({ disk })
    store.folders.find((f) => f.path === APP)!.expanded = false
    await nextTick()
    expect(block(w, APP).get('[data-folder-content]').attributes('data-open')).toBe('true')

    store.folders.splice(
      store.folders.findIndex((f) => f.path === WT_FEAT),
      1
    )
    await nextTick()
    await nextTick()
    expect(block(w, APP).get('[data-folder-content]').attributes('data-open')).toBe('true')
  })

  it('an update that changes nothing drawn keeps the tree as it is', async () => {
    const { store } = await boot()
    // Name order, so a newer `modified` cannot legitimately reorder the folders.
    store.setFolderSort('name')
    await nextTick()
    const before = store.sidebarTree
    store.folders.find((f) => f.path === NOTES)!.sessions[0].modified = new Date().toISOString()
    await nextTick()
    expect(store.sidebarTree).toBe(before)
  })

  it('quiet rows draw nothing extra', async () => {
    const missions = useMissionsStore()
    vi.spyOn(missions, 'chipFor').mockImplementation((id) =>
      id === 'main-1'
        ? { text: '2/5', compact: '2/5', tone: 'accent', needsYou: false, owed: 0 }
        : null
    )
    const { w, store } = await boot()
    // Nothing owed: the chip leaves the flex row, so it takes no gap from the title.
    const chip = w.get('[data-dsqa="sidebar-mission-chip"]')
    expect(chip.classes()).toContain('absolute')
    expect(chip.classes()).not.toContain('relative')

    // A folded checkout holding only a terminal shows no "0".
    const idle = store.folders.find((f) => f.path === WT_IDLE_A)!
    idle.sessions.push(session('shellterm-2', WT_IDLE_A, { isShellTerminal: true }))
    await nextTick()
    store.setCheckoutFolded(WT_IDLE_A, true)
    await nextTick()
    expect(checkoutRow(w, WT_IDLE_A).get('[data-value-count]').text()).toBe('')
  })

  it('the collapse shortcut cycles three levels with and without a text filter', async () => {
    const { w, store } = await boot()
    let actions!: ReturnType<typeof useSidebarActions>
    const host = defineComponent({
      setup() {
        actions = useSidebarActions()
        return () => null
      }
    })
    wrappers.push(mount(host, { global: { plugins: [i18n] } }))

    /** The level before, then after each of three presses of the shortcut. */
    const cycle = async (): Promise<number[]> => {
      const seen = [store.collapseLevel]
      for (let press = 0; press < 3; press++) {
        actions.toggleCollapseAll()
        await nextTick()
        seen.push(store.collapseLevel)
      }
      return seen
    }
    const openFolders = (): string[] =>
      w.findAll('[data-folder-content]').map((n) => n.attributes('data-open') ?? '')

    expect(await cycle()).toEqual([2, 1, 0, 2])

    store.setFilterActive(true)
    store.setFilterQuery('Summary')
    await nextTick()
    expect(await cycle()).toEqual([2, 1, 0, 2])

    // Level 0 really closes the folders, and a closed header can be opened again.
    actions.toggleCollapseAll()
    actions.toggleCollapseAll()
    await nextTick()
    expect(new Set(openFolders())).toEqual(new Set(['false']))
    await block(w, APP).get('[data-folder-chevron]').trigger('click')
    expect(block(w, APP).get('[data-folder-content]').attributes('data-open')).toBe('true')

    // A new query shows its matches again, whatever was folded under the last one.
    actions.toggleCollapseAll()
    await nextTick()
    actions.toggleCollapseAll()
    await nextTick()
    store.setFilterQuery('Summary main')
    await nextTick()
    expect(block(w, APP).get('[data-folder-content]').attributes('data-open')).toBe('true')
  })
})

describe('sidebar group rail priority (S-3)', () => {
  it('rail takes the hottest session', async () => {
    const { w, store } = await boot({
      disk: [
        repoEntry(APP, 'main', [session('a', APP), session('b', APP), session('c', APP)]),
        repoEntry(WT_FEAT, 'PROJ-231-rate-limit', [session('feat-1', WT_FEAT)])
      ]
    })
    const rail = (path: string): string | undefined =>
      checkoutRow(w, path)
        .element.closest('[data-checkout-group]')
        ?.getAttribute('data-group-rail') ?? undefined
    const states = async (...values: (string | undefined)[]): Promise<void> => {
      const app = store.folders.find((f) => f.path === APP)!
      values.forEach((value, index) => {
        app.sessions.find((s) => s.sessionId === 'abc'[index])!.taskState = value as never
      })
      await nextTick()
    }

    await states('idle', 'idle', 'completed')
    expect(rail(APP), 'idle and done draw nothing').toBeUndefined()

    await states('working', 'idle', 'idle')
    expect(rail(APP)).toBe('working')
    await states('working', 'failed', 'idle')
    expect(rail(APP), 'failed overrides working').toBe('failed')
    await states('working', 'failed', 'needs-input')
    expect(rail(APP), 'needs input beats failed').toBe('needs-input')
    await states('working', 'idle', 'needs-input')
    expect(rail(APP)).toBe('needs-input')
    expect(rail(WT_FEAT), 'a neighbour keeps its own state').toBeUndefined()

    // A working session gone quiet is stuck: it still counts as working.
    await states('idle', 'idle', 'idle')
    const quiet = store.folders.find((f) => f.path === APP)!.sessions[0]
    quiet.modified = new Date(Date.now() - 3_600_000).toISOString()
    await states('working', 'idle', 'idle')
    expect(w.get('[data-session-id="a"] [aria-label="Stuck"]').exists()).toBe(true)
    expect(rail(APP)).toBe('working')

    // The colours: the dim working green, then warning and red at full strength.
    const css = readFileSync('src/renderer/src/styles/main.css', 'utf8')
    const colour = (state: string): string | undefined =>
      new RegExp(
        `\\[data-checkout-group\\]\\[data-group-rail='${state}'\\]\\s*\\{[^}]*--rail-color:\\s*([^;]+);`
      ).exec(css)?.[1]
    expect(colour('working')).toBe('color-mix(in oklab, var(--color-green) 40%, transparent)')
    expect(colour('needs-input')).toBe('var(--color-warning)')
    expect(colour('failed')).toBe('var(--color-red)')
  })
})
