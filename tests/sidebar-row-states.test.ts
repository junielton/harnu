// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import { i18n } from '@renderer/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import { useSessionsStore, type Session } from '../src/renderer/src/stores/sessions'
import type { FolderEntry } from '../src/preload'

/**
 * Sidebar redesign S-2 — row states live on the left bar (design.md §6 "Row
 * states", spec AC-10 and AC-12). jsdom has no box model and paints no
 * pseudo-element, so this file pins the DOM contract each row carries
 * (`data-row-bar`) and the rules main.css pairs with it. The painted result is
 * measured in Chromium by tests/e2e/ci/sidebar-row-states.spec.ts. Neutral
 * vocabulary only.
 */

const APP = '/w/org-a/api-gateway'
const WT_FEAT = '/w/org-a/wt/PROJ-231-rate-limit'
const WT_IDLE = '/w/org-a/wt/PROJ-232-redis-pool'
const PLAIN = '/w/org-b/example-web'
const REPO_ID = `${APP}/.git`

function session(id: string, path: string): Session {
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
    gitBranch: 'main',
    projectPath: path,
    isSidechain: false,
    status: 'idle',
    resumable: true,
    bridged: false,
    agents: []
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

const repoEntry = (path: string, branch: string, sessions: Session[]): FolderEntry =>
  entry(path, sessions, { repoId: REPO_ID, gitBranch: branch, isMainWorktree: path === APP })

function disk(): FolderEntry[] {
  return [
    repoEntry(APP, 'main', [session('main-1', APP), session('main-2', APP)]),
    repoEntry(WT_FEAT, 'PROJ-231-rate-limit', [session('feat-1', WT_FEAT)]),
    repoEntry(WT_IDLE, 'PROJ-232-redis-pool', []),
    entry(PLAIN, [session('plain-1', PLAIN)])
  ]
}

function installWindow(): void {
  const entries = disk()
  const projects = entries.map((d) => ({
    path: d.path,
    alias: d.alias,
    addedAt: new Date().toISOString(),
    worktrees: []
  }))
  ;(window as unknown as { api: unknown }).api = {
    foldersLoad: vi.fn(async () => entries),
    userProjectsList: vi.fn(async () => ({ projects, hiddenPaths: [] })),
    orchestratorListArmed: vi.fn(async () => []),
    probeGit: vi.fn(async () => []),
    getPathForFile: vi.fn(() => null),
    worktreeMdProbe: vi.fn(async () => ({ manifestPath: '', exists: false, repoRoot: APP })),
    userProjectsListBornFromCandidates: vi.fn(async () => [])
  }
}

let wrappers: VueWrapper[] = []

async function boot(): Promise<{ w: VueWrapper; store: ReturnType<typeof useSessionsStore> }> {
  installWindow()
  const store = useSessionsStore()
  await store.reloadModel()
  for (const f of store.folders) f.expanded = true
  const w = mount(Sidebar, { global: { plugins: [i18n] }, attachTo: document.body })
  wrappers.push(w)
  await flushPromises()
  store.createFolderTerminal(APP)
  store.select(null)
  await nextTick()
  await w.get('[data-idle-row]').trigger('click')
  return { w, store }
}

/** Every row the tree draws, with the bar type design.md "Row states" gives it. */
const ROW_TYPES: [selector: string, type: 'header' | 'checkout' | 'session'][] = [
  ['[data-folder-head]', 'header'],
  ['[data-checkout-row]', 'checkout'],
  ['[data-idle-row]', 'checkout'],
  ['[data-idle-worktree]', 'checkout'],
  ['[data-session-row]', 'session'],
  ['[data-terminal-row]', 'session']
]

// ---- main.css as (selectors, declarations) pairs ----

interface Rule {
  selectors: string[]
  declarations: Record<string, string>
}

const css = readFileSync('src/renderer/src/styles/main.css', 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selectors: selector.split(',').map((s) => s.replace(/\s+/g, ' ').trim()),
  declarations: Object.fromEntries(
    body
      .split(';')
      .map((d) => d.split(/:(.*)/s).map((p) => p.trim()))
      .filter(([property]) => property)
  )
}))

function ruleFor(selector: string): Rule {
  const found = rules.filter((r) => r.selectors.includes(selector))
  expect(found, `main.css needs exactly one rule for ${selector}`).toHaveLength(1)
  return found[0]
}

/**
 * The value slot's keyboard and cursor variants, spelled out: a variant on the
 * wrong element (or only some of the three) must fail here.
 */
const SLOT_VARIANTS = [
  'group-hover',
  'group-focus-visible',
  'group-has-focus-visible',
  'group-data-[focused=true]'
]

const FOCUS_SELECTOR = {
  header: "[data-row-bar='header']:has(button:focus-visible)",
  checkout: "[data-row-bar='checkout']:focus-visible",
  session: "[data-row-bar='session']:focus-visible"
} as const

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
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

describe('sidebar row states (S-2)', () => {
  it('cursor uses the focus bar', async () => {
    const { w, store } = await boot()

    // Every row type takes the arrow cursor and carries its bar type.
    for (const [selector, type] of ROW_TYPES) {
      const target = w.get(selector)
      const [kind, ...id] = target.attributes('data-sidebar-row')!.split(':')
      store.keyboardCursor = { kind, id: id.join(':') } as NonNullable<typeof store.keyboardCursor>
      await nextTick()
      const focused = w.findAll('[data-focused="true"]')
      expect(focused, `${selector} takes the cursor`).toHaveLength(1)
      expect(focused[0].element).toBe(target.element)
      expect(target.attributes('data-row-bar'), selector).toBe(type)

      // That element, and only it, draws the bar: both variants resolve on it.
      const element = target.element as HTMLElement
      expect(element.matches(`[data-row-bar='${type}'][data-focused='true']`), selector).toBe(true)
      expect(element.querySelector('[data-row-bar]'), `${selector} nests no bar`).toBeNull()
      expect(element.parentElement!.closest('[data-row-bar]'), selector).toBeNull()
      // Keyboard focus lands on the row itself; a header takes it on a button inside.
      if (type === 'header') expect(element.querySelector('button'), selector).not.toBeNull()
      else expect(element.tagName, `${selector} is focusable`).toBe('BUTTON')

      // The count / chevron swap names the same two states, on the row's own group.
      const chevron = target.find('[data-value-chevron]')
      if (chevron.exists()) {
        expect(target.classes(), `${selector} is the group`).toContain('group')
        expect(chevron.classes(), selector).toEqual(
          expect.arrayContaining(SLOT_VARIANTS.map((v) => `${v}:opacity-100`))
        )
        expect(target.get('[data-value-count]').classes(), selector).toEqual(
          expect.arrayContaining(SLOT_VARIANTS.map((v) => `${v}:opacity-0`))
        )
      }
    }

    // One rule draws both keyboard focus and the cursor, so they cannot differ.
    for (const type of ['header', 'checkout', 'session'] as const) {
      const rule = ruleFor(`${FOCUS_SELECTOR[type]}::before`)
      expect(rule.selectors).toContain(`[data-row-bar='${type}'][data-focused='true']::before`)
      expect(rule.declarations.width).toBe('3px')
      expect(rule.declarations['background-color']).toBe('var(--color-text)')
    }
    expect(
      ruleFor(`${FOCUS_SELECTOR.session}::before`).declarations.left,
      'the 3px bar starts at 19px'
    ).toBe('19px')

    // On the selected session or the current header, the same pair turns accent.
    const accent = ruleFor("[data-row-bar='session'][data-selected='true']:focus-visible::before")
    expect(accent.selectors).toEqual(
      expect.arrayContaining([
        "[data-row-bar='session'][data-selected='true'][data-focused='true']::before",
        "[data-row-bar='header'][data-current='true']:has(button:focus-visible)::before",
        "[data-row-bar='header'][data-current='true'][data-focused='true']::before"
      ])
    )
    expect(accent.declarations['background-color']).toBe('var(--color-accent)')
  })

  it('a focusable element inside a row draws the row bar, not a box', async () => {
    const { w, store } = await boot()
    const row = store.folders
      .find((f) => f.path === APP)!
      .sessions.find((x) => x.sessionId === 'main-1')!
    row.agents = [{ agentId: 'agent-1', status: 'running', agentType: 'Explore' }] as never
    await nextTick()

    // The subagent chip is a focus stop of its own, inside the session row that draws the bar.
    const chip = w.get('[data-session-id="main-1"] [role="button"][tabindex="0"]')
    expect(chip.element.closest('[data-row-bar]')?.getAttribute('data-row-bar')).toBe('session')

    // Its keyboard focus is drawn by the same rule as the row's own.
    for (const type of ['header', 'checkout', 'session'] as const) {
      const rule = ruleFor(`[data-row-bar='${type}']:has([tabindex]:focus-visible)::before`)
      expect(rule.selectors).toContain(`${FOCUS_SELECTOR[type]}::before`)
      expect(rule.declarations.width).toBe('3px')
    }
    const accent = ruleFor(
      "[data-row-bar='session'][data-selected='true']:has([tabindex]:focus-visible)::before"
    )
    expect(accent.selectors).toContain(
      "[data-row-bar='header'][data-current='true']:has([tabindex]:focus-visible)::before"
    )
    expect(accent.declarations['background-color']).toBe('var(--color-accent)')

    // No box on the element: its text lights up instead. Forced colors keeps an outline.
    const own = rules.find(
      (r) =>
        r.selectors.includes('[data-row-bar] [tabindex]:focus-visible') &&
        r.declarations.outline === 'none'
    )
    expect(own, 'the element draws no outline').toBeDefined()
    expect(own!.declarations.color).toBeUndefined()
    const lit = rules.find(
      (r) =>
        r.selectors.includes('[data-row-bar] [tabindex]:focus-visible') &&
        r.declarations.color === 'var(--color-text)'
    )
    expect(lit, 'the element lights up').toBeDefined()
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'))
    expect(forced).toContain('[data-row-bar]:has([tabindex]:focus-visible)')
  })

  it('the header chevron lights up on its own keyboard focus', async () => {
    const { w } = await boot()

    // The header has two focus stops, its name and its chevron, and both draw the same bar.
    const chevron = w.get('[data-folder-head] [data-folder-chevron]')
    expect(chevron.element.tagName).toBe('BUTTON')

    // So the focused button says which one it is by colour, in forced colors by an outline.
    const button = "[data-row-bar='header'] button:focus-visible"
    expect(
      rules.some(
        (r) => r.selectors.includes(button) && r.declarations.color === 'var(--color-text)'
      ),
      'the focused header button lights up'
    ).toBe(true)
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'))
    expect(forced.slice(0, forced.indexOf('{', forced.indexOf('{') + 1))).toContain(button)
  })

  it('the value slot chevron has no hover fill', async () => {
    const { w } = await boot()
    const chevrons = w.findAll('[data-value-chevron]')
    expect(chevrons.length).toBeGreaterThan(0)
    for (const chevron of chevrons) {
      expect(chevron.classes().filter((c) => /^(?:[a-z-]+:)*bg-/.test(c))).toEqual([])
    }
  })

  it('moving the cursor leaves one bar, not two', async () => {
    const { w, store } = await boot()
    const clicked = w.get(`[data-checkout-path="${WT_FEAT}"]`).element as HTMLElement
    const other = w.get(`[data-checkout-path="${APP}"]`)

    // A clicked row keeps DOM focus, so it would paint the focus bar beside the cursor's.
    clicked.focus()
    store.keyboardCursor = { kind: 'folder', id: APP }
    await flushPromises()
    expect(other.attributes('data-focused')).toBe('true')
    expect(document.activeElement).not.toBe(clicked)

    // The cursor on the focused row itself keeps it, and a text field is never touched.
    clicked.focus()
    store.keyboardCursor = { kind: 'folder', id: WT_FEAT }
    await flushPromises()
    expect(document.activeElement).toBe(clicked)
    const input = document.body.appendChild(document.createElement('input'))
    input.focus()
    store.keyboardCursor = { kind: 'folder', id: APP }
    await flushPromises()
    expect(document.activeElement).toBe(input)
  })

  it('gives the rows a mount cannot reach the same bar', () => {
    const source = (file: string): string =>
      readFileSync(`src/renderer/src/components/${file}`, 'utf8')
    /** The opening tag carrying `marker`; a `>` inside a quoted attribute does not end it. */
    const tag = (file: string, marker: string): string => {
      const text = source(file)
      const at = text.indexOf(marker)
      expect(at, `${file} has ${marker}`).toBeGreaterThan(-1)
      const open = text.slice(text.lastIndexOf('<', at))
      return /^<[\w-]+(?:\s+[^\s=>]+(?:="[^"]*")?)*\s*>/.exec(open)?.[0] ?? ''
    }
    expect(tag('SidebarFolder.vue', 'data-teammate-row')).toContain('data-row-bar="session"')
    expect(tag('SidebarFolder.vue', 'data-dsqa="sidebar-agents-done-fold"')).toContain(
      'data-row-bar="session"'
    )
    // Shelved: the disclosure row and each worktree row are checkout rows, its sessions session rows.
    const shelved = source('SidebarShelvedSection.vue')
    expect(shelved.match(/data-row-bar="checkout"/g)).toHaveLength(2)
    expect(shelved.match(/data-row-bar="session"/g)).toHaveLength(1)
    for (const file of [
      'SidebarFolder.vue',
      'SidebarTreeFolder.vue',
      'SidebarShelvedSection.vue'
    ]) {
      expect(source(file), `${file} paints no row fill`).not.toMatch(/hover:bg-surface(?!-2)/)
      expect(source(file), file).not.toContain('--color-accent-soft')
    }
  })

  it('draws no fill, no weight change and no outline on a row', async () => {
    const { w, store } = await boot()
    store.select('main-1')
    await nextTick()

    // The selected session carries its state for the bar, and no bar element of its own.
    const selected = w.get('[data-session-id="main-1"]')
    expect(selected.attributes('data-selected')).toBe('true')
    expect(selected.find('.bg-accent.absolute').exists()).toBe(false)
    expect((selected.element as HTMLElement).style.fontWeight).not.toBe('500')

    // A folder's view takes the selection, so the header is the current row.
    const header = w.get(`[data-folder-path="${PLAIN}"][data-folder-head]`)
    store.selectFolder(PLAIN)
    await nextTick()
    expect(header.attributes('data-current')).toBe('true')

    for (const [selector] of ROW_TYPES) {
      for (const row of w.findAll(selector)) {
        const element = row.element as HTMLElement
        const fills = row.classes().filter((c) => /^(?:[a-z-]+:)*bg-/.test(c) && c !== 'bg-sidebar')
        expect(fills, `${selector} has no fill class`).toEqual([])
        expect(element.style.background, selector).toBe('')
        expect(['', '400'], `${selector} never changes weight`).toContain(element.style.fontWeight)
      }
    }

    // The old outline and tint rules are gone; the forced-colors outline is the one fallback.
    expect(rules.some((r) => r.selectors.includes(".sidebar-row[data-focused='true']"))).toBe(false)
    expect(css).not.toContain('--sidebar-row-tint')
    expect(css).not.toContain(".sidebar-tree-head[data-current='true']")
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'))
    expect(forced).toContain('outline: 2px solid Highlight')
  })
})
