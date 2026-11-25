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
 * Sidebar redesign S-3 — the group rail (design.md §6 "Group rail", spec AC-13
 * and AC-15). jsdom has no box model and paints no pseudo-element, so this file
 * pins the DOM contract each checkout group carries (`data-group-rail`) and the
 * rules main.css pairs with it; the painted result is measured in the running
 * app. The priority between states is AC-14 in tests/sidebar-tree.test.ts.
 * Neutral vocabulary only.
 */

const APP = '/w/org-a/api-gateway'
const WT_FEAT = '/w/org-a/wt/PROJ-231-rate-limit'
const WT_POOL = '/w/org-a/wt/PROJ-232-redis-pool'
const WT_IDLE = '/w/org-a/wt/PROJ-198-health-checks'
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
    status: 'idle'
  }
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
  const repo = (path: string, branch: string, sessions: Session[]): FolderEntry =>
    entry(path, sessions, {
      repoId: REPO_ID,
      gitBranch: branch,
      isMainWorktree: path === APP
    })
  return [
    repo(APP, 'main', [session('main-1', APP)]),
    repo(WT_FEAT, 'PROJ-231-rate-limit', [session('feat-1', WT_FEAT), session('feat-2', WT_FEAT)]),
    repo(WT_POOL, 'PROJ-232-redis-pool', [session('pool-1', WT_POOL)]),
    repo(WT_IDLE, 'PROJ-198-health-checks', []),
    entry(PLAIN, [session('plain-1', PLAIN)])
  ]
}

function installWindow(): void {
  const folders = disk()
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

let wrappers: VueWrapper[] = []

async function boot(): Promise<{ w: VueWrapper; store: ReturnType<typeof useSessionsStore> }> {
  installWindow()
  const store = useSessionsStore()
  await store.reloadModel()
  for (const f of store.folders) f.expanded = true
  const w = mount(Sidebar, { global: { plugins: [i18n] }, attachTo: document.body })
  wrappers.push(w)
  await flushPromises()
  return { w, store }
}

// ---- main.css as (selectors, declarations) pairs ----

interface Rule {
  selectors: string[]
  declarations: Record<string, string>
}

const css = readFileSync('src/renderer/src/styles/main.css', 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

function parse(source: string): Rule[] {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector.split(',').map((s) => s.replace(/\s+/g, ' ').trim()),
    declarations: Object.fromEntries(
      body
        .split(';')
        .map((d) => d.split(/:(.*)/s).map((p) => p.replace(/\s+/g, ' ').trim()))
        .filter(([property]) => property)
    )
  }))
}

const rules = parse(css)

/** The first rule naming `selector`; the later ones are the media-query fallbacks. */
function ruleFor(selector: string): Rule {
  const found = rules.find((r) => r.selectors.includes(selector))
  expect(found, `main.css needs a rule for ${selector}`).toBeDefined()
  return found!
}

const RAIL = '[data-checkout-group]::before'
const LIT = '[data-checkout-group][data-group-rail]::before'

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

describe('sidebar group rail (S-3)', () => {
  it('rail motion, geometry and label', async () => {
    const { w, store } = await boot()
    const row = (path: string): ReturnType<VueWrapper['get']> =>
      w.get(`[data-checkout-row][data-checkout-path="${path}"]`)
    const state = async (path: string, value: string): Promise<void> => {
      for (const s of store.folders.find((f) => f.path === path)!.sessions) {
        s.taskState = value as never
      }
      await nextTick()
    }

    // The checkout row names its state, and says nothing extra without one.
    expect(row(APP).attributes('aria-label')).toBeUndefined()
    await state(APP, 'working')
    expect(row(APP).attributes('aria-label')).toBe('main, agent working')
    await state(APP, 'failed')
    expect(row(APP).attributes('aria-label')).toBe('main, failed')
    await state(APP, 'needs-input')
    expect(row(APP).attributes('aria-label')).toBe('main, needs you')
    await state(APP, 'completed')
    expect(row(APP).attributes('aria-label')).toBeUndefined()

    // Enter over --dur, leave over --dur-slow: the destination state names the duration.
    expect(ruleFor(RAIL).declarations.transition).toBe(
      'background-color var(--dur-slow) var(--ease)'
    )
    expect(ruleFor(RAIL).declarations['background-color']).toBe('transparent')
    expect(ruleFor(LIT).declarations['transition-duration']).toBe('var(--dur)')
    expect(ruleFor(LIT).declarations['background-color']).toBe('var(--rail-color)')

    // Reduced motion: the universal reset reaches the pseudo-element that paints the rail.
    const reduced = css.slice(css.lastIndexOf('*::before,', css.indexOf('[data-layout-motion]')))
    expect(reduced).toMatch(
      /^\*::before,\s*\*::after \{[^}]*transition-duration: 0\.01ms !important/
    )

    // Geometry: x = 0, 2px wide, inset 2px, ending where the last row's tree guide ends.
    expect(ruleFor(RAIL).declarations).toMatchObject({
      position: 'absolute',
      left: '0',
      width: '2px',
      top: '2px',
      bottom: '2px'
    })
    expect(ruleFor(".sidebar-tree-guide[data-guide-last='true']::before").declarations.bottom).toBe(
      ruleFor(RAIL).declarations.bottom
    )
    for (const path of [APP, WT_FEAT, WT_POOL]) {
      const group = row(path).element.closest('[data-checkout-group]')!
      const guides = [...group.querySelectorAll('.sidebar-tree-guide')]
      expect(guides.length, path).toBeGreaterThan(0)
      expect(
        guides.map((g) => g.getAttribute('data-guide-last') === 'true'),
        `${path}: only the last row ends the guide`
      ).toEqual(guides.map((_, index) => index === guides.length - 1))
      // Nothing trails the last row inside the group, so both ends share one y.
      for (let node: Element = guides.at(-1)!; node !== group; node = node.parentElement!) {
        expect(node.nextElementSibling, `${path}: a box follows the last row`).toBeNull()
      }
    }
    // Rails never join: each group is its own box, a sibling of the next one.
    const groups = w.findAll('[data-checkout-group]')
    expect(groups).toHaveLength(3)
    for (const g of groups) expect(g.element.querySelector('[data-checkout-group]')).toBeNull()

    // No rail on a folder header, the idle row, or a non-git folder's sessions.
    await state(PLAIN, 'working')
    expect(w.findAll('[data-folder-head][data-group-rail]')).toHaveLength(0)
    expect(w.get('[data-idle-row]').element.closest('[data-group-rail]')).toBeNull()
    expect(
      w.get('[data-session-id="plain-1"]').element.closest('[data-group-rail]'),
      'a non-git folder has no checkout row'
    ).toBeNull()

    // Hover on an active group keeps the rail's colour at full strength, 3px wide,
    // and ranks below keyboard focus (same specificity, so source order decides).
    const hover = ruleFor(":where([data-group-rail]) > [data-row-bar='checkout']:hover::before")
    expect(hover.declarations).toEqual({ width: '3px', 'background-color': 'var(--rail-strong)' })
    expect(hover.selectors).toContain(
      ":where([data-group-rail]) > [data-row-bar='checkout'][data-menu-open='true']::before"
    )
    expect(css.indexOf(':where([data-group-rail])')).toBeGreaterThan(
      css.indexOf("[data-row-bar='header']:hover::before")
    )
    expect(css.indexOf(':where([data-group-rail])')).toBeLessThan(
      css.indexOf("[data-row-bar='checkout']:focus-visible::before")
    )
    for (const [name, token] of [
      ['working', 'var(--color-green)'],
      ['failed', 'var(--color-red)'],
      ['needs-input', 'var(--color-warning)']
    ]) {
      expect(
        ruleFor(`[data-checkout-group][data-group-rail='${name}']`).declarations['--rail-strong']
      ).toBe(token)
    }

    // Forced colours paint the rail in the system text colour.
    const forced = parse(css.slice(css.indexOf('@media (forced-colors: active)')))
    expect(forced.find((r) => r.selectors.includes(LIT))?.declarations['background-color']).toBe(
      'CanvasText'
    )
  })
})
