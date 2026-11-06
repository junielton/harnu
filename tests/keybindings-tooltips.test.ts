// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import { useKeybindingsStore } from '../src/renderer/src/stores/keybindings'
import { useLayoutStore } from '../src/renderer/src/stores/layout'
import { useMonitorStore } from '../src/renderer/src/stores/monitor'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import TakeoverShell from '../src/renderer/src/components/TakeoverShell.vue'
import HeapGauge from '../src/renderer/src/components/HeapGauge.vue'
import Topbar from '../src/renderer/src/components/Topbar.vue'
import SessionMenu from '../src/renderer/src/components/SessionMenu.vue'
import FolderMenu from '../src/renderer/src/components/FolderMenu.vue'

/**
 * T486 U6 — chords in tooltips and menu hints
 * (`docs/specs/T486-keybindings-coverage-pass.md` §9.2).
 *
 * AC-43: every §9.2 button's tooltip reads "Label (Chord)" with the resolved
 * chord, updates live on rebind, and is the plain label when unbound. The
 * helper is unit-tested, every listed button is checked to route its title
 * through it with the right id, and a representative set is mounted.
 */

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

const none = (): (() => void) => () => {}
function stubApi(): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      keybindingsSave: vi.fn(async () => undefined),
      githubPullsUrl: vi.fn(async () => null)
    } as Record<string, unknown>,
    {
      get: (target, key: string) => {
        if (key in target) return target[key]
        return key.startsWith('on') ? none : vi.fn(async () => null)
      }
    }
  )
}

let wrapper: VueWrapper | null = null

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
  setActivePinia(createPinia())
  stubApi()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('keybindings.withChord', () => {
  it('appends the resolved chord, rendered for the platform', () => {
    const kb = useKeybindingsStore()
    expect(kb.withChord('Hide sidebar', 'view.toggleSidebar')).toBe('Hide sidebar (Ctrl+B)')
  })

  it('is the plain label for an unbound action', () => {
    const kb = useKeybindingsStore()
    expect(kb.withChord('Fork', 'session.fork')).toBe('Fork')
  })

  it('follows a rebind and an unbind', async () => {
    const kb = useKeybindingsStore()
    await kb.setBinding('view.toggleSidebar', 'Cmd+Shift+Y')
    expect(kb.withChord('Hide sidebar', 'view.toggleSidebar')).toBe('Hide sidebar (Ctrl+Shift+Y)')
    await kb.setBinding('view.toggleSidebar', null)
    expect(kb.withChord('Hide sidebar', 'view.toggleSidebar')).toBe('Hide sidebar')
  })

  it('uses the localized pattern', () => {
    i18n.global.locale.value = 'pt-BR'
    const kb = useKeybindingsStore()
    expect(kb.withChord('X', 'view.toggleSidebar')).toBe(
      i18n.global.t('keybindings.withChord', { label: 'X', chord: 'Ctrl+B' })
    )
  })
})

/** Every §9.2 row: the file and the ids its buttons' titles must carry. */
const TOOLTIP_SITES: Record<string, string[]> = {
  'Topbar.vue': [
    'view.toggleSidebar',
    'session.newInFolder',
    'view.roadmap',
    'view.prStack',
    'view.review',
    'folder.openInFileManager',
    'folder.openInEditor',
    'folder.openGithubPulls',
    'folder.browseFiles',
    'folder.newTerminal',
    'view.toggleHelper'
  ],
  'MissionPill.vue': ['view.missionProgress'],
  'ActivityBell.vue': ['view.activity'],
  'Sidebar.vue': [
    'sidebar.rescan',
    'sidebar.cycleDrillDepth',
    'sidebar.toggleCollapseAll',
    'sidebar.hiddenFolders',
    'sidebar.jump',
    'view.settings'
  ],
  'SidebarFolder.vue': ['session.newInFolder'],
  'StatusFooter.vue': ['view.pastedImages', 'view.claudeStatus', 'view.cleanup', 'view.scheduler'],
  'HeapGauge.vue': ['view.systemMonitor'],
  'InboxRail.vue': ['inbox.open', 'inbox.toggleOrder', 'inbox.toggle'],
  'TakeoverShell.vue': ['view.closeTakeover'],
  'HelperPane.vue': ['pane.toggleMaximize', 'pane.close'],
  'MarkdownPane.vue': ['pane.toggleMaximize', 'pane.close'],
  'MemoryPane.vue': ['pane.toggleMaximize', 'pane.close'],
  'ExplorerPane.vue': ['pane.toggleMaximize', 'pane.close'],
  'DiagramPane.vue': ['pane.toggleMaximize', 'pane.close']
}

/** The argument text of every `withChord(…)` call in `src`, parens balanced. */
function withChordCalls(src: string): string[] {
  const out: string[] = []
  let i = src.indexOf('withChord(')
  while (i >= 0) {
    let depth = 0
    let j = i + 'withChord'.length
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++
      else if (src[j] === ')' && --depth === 0) break
    }
    out.push(src.slice(i, j + 1))
    i = src.indexOf('withChord(', j)
  }
  return out
}

describe('AC-43 — every §9.2 button routes its title through withChord', () => {
  for (const [file, ids] of Object.entries(TOOLTIP_SITES)) {
    it(`${file}: ${ids.join(', ')}`, () => {
      const src = readFileSync(resolve(__dirname, '../src/renderer/src/components', file), 'utf8')
      const calls = withChordCalls(src)
      for (const id of ids) {
        expect(
          calls.some((c) => new RegExp(`'${id.replace(/\./g, '\\.')}'\\s*\\)$`).test(c)),
          `${file} has no withChord(…, '${id}')`
        ).toBe(true)
      }
      // Every withChord call sits on a title binding, never an aria-label.
      expect(src).not.toMatch(/:aria-label="[^"]*withChord\(/)
    })
  }
})

describe('AC-43 — mounted tooltips', () => {
  it('TakeoverShell close X: "Label (Esc)", live on rebind, plain when unbound', async () => {
    wrapper = mount(TakeoverShell, {
      props: { titleKey: 'roadmap.title' },
      global: { plugins: [i18n] }
    })
    const btn = wrapper.get('button')
    const plain = i18n.global.t('roadmap.close')
    expect(btn.attributes('title')).toBe(`${plain} (Esc)`)
    expect(btn.attributes('aria-label')).toBe(plain)
    await useKeybindingsStore().setBinding('view.closeTakeover', 'Cmd+Shift+W')
    await flushPromises()
    expect(btn.attributes('title')).toBe(`${plain} (Ctrl+Shift+W)`)
    await useKeybindingsStore().setBinding('view.closeTakeover', null)
    await flushPromises()
    expect(btn.attributes('title')).toBe(plain)
  })

  it('HeapGauge: plain while unbound, chord once bound', async () => {
    useMonitorStore().lastHeap = {
      usedBytes: 50,
      limitBytes: 100,
      status: 'ok'
    } as never
    wrapper = mount(HeapGauge, { global: { plugins: [i18n] } })
    await flushPromises()
    const btn = wrapper.get('button')
    const plain = btn.attributes('aria-label')!
    expect(btn.attributes('title')).toBe(plain)
    await useKeybindingsStore().setBinding('view.systemMonitor', 'Cmd+Alt+M')
    await flushPromises()
    expect(btn.attributes('title')).toBe(`${plain} (Ctrl+Alt+M)`)
  })

  it('Topbar sidebar toggle: "Hide sidebar (Ctrl+B)"', async () => {
    useLayoutStore()
    wrapper = mount(Topbar, { global: { plugins: [i18n] } })
    await flushPromises()
    const plain = i18n.global.t('sidebar.hide')
    const btn = wrapper.get(`button[aria-label="${plain}"]`)
    expect(btn.attributes('title')).toBe(`${plain} (Ctrl+B)`)
    await useKeybindingsStore().setBinding('view.toggleSidebar', 'Cmd+Alt+J')
    await flushPromises()
    expect(btn.attributes('title')).toBe(`${plain} (Ctrl+Alt+J)`)
  })
})

describe('§9.2 — menu-item chord hints', () => {
  function seedSession(): void {
    const sessions = useSessionsStore()
    sessions.folders.push({
      path: '/repo/alpha',
      alias: 'alpha',
      expanded: true,
      sessions: [
        {
          sessionId: 's1',
          projectPath: '/repo/alpha',
          summary: 'one',
          firstPrompt: '',
          modified: '2026-10-01T00:00:00Z',
          resumable: true
        }
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  }
  const hintFor = (labelText: string): string | null => {
    const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((b) =>
      b.textContent?.includes(labelText)
    )
    if (!item) throw new Error(`no menu item "${labelText}"`)
    return item.querySelector('[data-menu-shortcut]')?.textContent?.trim() ?? null
  }

  it('Session menu: Fork shows no hint while unbound and its chord once bound', async () => {
    seedSession()
    wrapper = mount(SessionMenu, { attachTo: document.body, global: { plugins: [i18n] } })
    useUiStore().openMenu({ sessionId: 's1', x: 10, y: 10 })
    await flushPromises()
    const fork = i18n.global.t('actions.fork')
    expect(hintFor(fork)).toBeNull()
    expect(hintFor(i18n.global.t('actions.rename'))).toBe('Ctrl+R')
    await useKeybindingsStore().setBinding('session.fork', 'Cmd+Shift+K')
    await flushPromises()
    expect(hintFor(fork)).toBe('Ctrl+Shift+K')
    expect(hintFor(i18n.global.t('actions.openInNewTab'))).toBe('Ctrl+Enter')
  })

  it('Folder menu: Rename folder shows F2, live on rebind', async () => {
    seedSession()
    wrapper = mount(FolderMenu, { attachTo: document.body, global: { plugins: [i18n] } })
    useUiStore().openFolderMenu({ projectPath: '/repo/alpha', x: 10, y: 10 })
    await flushPromises()
    const rename = i18n.global.t('folderMenu.rename')
    expect(hintFor(rename)).toBe('F2')
    expect(hintFor(i18n.global.t('folderMenu.bootOptions'))).toBeNull()
    await useKeybindingsStore().setBinding('folder.bootOptions', 'Cmd+Alt+O')
    await flushPromises()
    expect(hintFor(i18n.global.t('folderMenu.bootOptions'))).toBe('Ctrl+Alt+O')
  })
})
