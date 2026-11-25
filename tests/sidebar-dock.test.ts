// @vitest-environment jsdom
import { existsSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'

/**
 * Sidebar redesign S-4 — the bottom dock and the end of the Fleet rail (design.md §6 "Bottom dock",
 * spec AC-17, AC-18, AC-19). jsdom has no box model: the geometry and the Floating panels islands
 * (AC-20) are measured and captured in the running app. Neutral vocabulary only.
 */

interface CapturedBinding {
  id: string
  handler: () => void
}
vi.mock('../src/renderer/src/composables/useShortcuts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/renderer/src/composables/useShortcuts')>()
  return {
    ...actual,
    useShortcuts: (bindings: CapturedBinding[], ...rest: unknown[]) => {
      ;(globalThis as unknown as { __bindings: CapturedBinding[] }).__bindings = bindings
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.useShortcuts as any)(bindings, ...rest)
    }
  }
})
vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

const bindings = (): CapturedBinding[] =>
  (globalThis as unknown as { __bindings: CapturedBinding[] }).__bindings
const binding = (id: string): CapturedBinding => {
  const found = bindings().find((b) => b.id === id)
  expect(found, `${id} is registered`).toBeDefined()
  return found as CapturedBinding
}

import { i18n } from '@renderer/i18n'
import App from '../src/renderer/src/App.vue'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import { useSessionsStore, type Session } from '../src/renderer/src/stores/sessions'
import { useLayoutStore } from '../src/renderer/src/stores/layout'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useYourMoveStore } from '../src/renderer/src/stores/your-move'
import { PARK_TTL_MS } from '../src/main/mcp/confirm-core'
import { DESCRIPTOR_BY_ID, KEYBINDINGS } from '../src/main/keybindings-core'
import type { CardView } from '../src/main/your-move/core'
import type { McpConfirmPending, PendingApprovalWire } from '../src/preload'

// jsdom has no CSS.escape; the sidebar's reveal-and-scroll watch uses it, a tick after the test.
;(globalThis as unknown as { CSS?: { escape: (value: string) => string } }).CSS ??= {
  escape: (value) => value
}

const FOLDER = '/w/org-a/api-gateway'
const MINUTE = 60_000

let cards: CardView[] = []
let activateInbox: (() => void) | null = null

function stubApi(): void {
  const none = (): (() => void) => () => {}
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      claudeChangelogGet: vi.fn(async () => ({
        releases: [],
        lastReadVersion: '',
        lastFetchedAt: 0
      })),
      claudeConfigGetResolved: vi.fn(async () => ({})),
      approvalsList: vi.fn(async () => []),
      mcpConfirmsList: vi.fn(async () => []),
      foldersLoad: vi.fn(async () => []),
      userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
      yourMoveList: vi.fn(async () => structuredClone(cards)),
      yourMovePrefsGet: vi.fn(async () => ({ mode: 'live' })),
      orchestratorListArmed: vi.fn(async () => []),
      onNotifyActivateInbox: (cb: () => void) => {
        activateInbox = cb
        return () => {}
      }
    } as Record<string, unknown>,
    {
      get: (target, key: string) => {
        if (key in target) return target[key]
        return key.startsWith('on') ? none : vi.fn(async () => null)
      }
    }
  )
}

function seedFolder(): void {
  useSessionsStore().folders.push({
    path: FOLDER,
    alias: 'api-gateway',
    expanded: true,
    sessions: [
      {
        sessionId: 's1',
        projectPath: FOLDER,
        summary: 'Rate limiter',
        firstPrompt: '',
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        status: 'idle',
        resumable: true
      } as Session
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

const confirm = (): McpConfirmPending =>
  ({
    id: 'c1',
    prompt: 'create_worktree · api-gateway',
    permissionMode: 'default',
    nonDefaultFlags: [],
    commands: ['npm ci'],
    mode: 'parked',
    deadline: Date.now() + PARK_TTL_MS - 11 * MINUTE
  }) as McpConfirmPending

const approval = (): PendingApprovalWire =>
  ({
    requestId: 'r1',
    sessionId: 's1',
    summary: 'Bash(npm run migrate)',
    createdAtMs: Date.now() - 2 * MINUTE
  }) as PendingApprovalWire

const moveCard = (id: string, minutes: number): CardView => ({
  id,
  sessionId: 's1',
  folder: FOLDER,
  kind: 'decide',
  ask: `Pick the cache backend ${id}`,
  source: 'judge',
  lane: 'live',
  openedAt: Date.now() - minutes * MINUTE,
  updatedAt: Date.now(),
  answerable: false,
  optionDeliverable: []
})

const STUBS = Object.fromEntries(
  [
    'Topbar',
    'StatusFooter',
    'EmptyState',
    'FolderView',
    'CloudSessionPanel',
    'Onboarding',
    'TakeoverHost',
    'HelperStack',
    'TerminalPane',
    'SessionPreview',
    'FolderPreview',
    'SessionMenu',
    'FolderMenu',
    'SidebarHiddenPopover',
    'AddFolderDialog',
    'SettingsDialog',
    'ClaudeBootDialog',
    'NewSessionDialog',
    'RemoveWorktreeDialog',
    'NewWorktreeDialog',
    'NewFolderDialog',
    'OpenSubfolderDialog',
    'RenameFolderDialog',
    'RenameRepoDialog',
    'MemoryLocationDialog',
    'CommandPalette',
    'McpConfirmOverlay',
    'ToastStack'
  ].map((n) => [n, true])
)

let wrapper: VueWrapper | null = null

async function mountSidebar(): Promise<VueWrapper> {
  seedFolder()
  wrapper = mount(Sidebar, { global: { plugins: [i18n] }, attachTo: document.body })
  await useYourMoveStore().init()
  await flushPromises()
  return wrapper
}

async function mountApp(): Promise<VueWrapper> {
  seedFolder()
  wrapper = mount(App, { global: { plugins: [i18n], stubs: STUBS }, attachTo: document.body })
  await useYourMoveStore().init()
  await flushPromises()
  return wrapper
}

const section = (w: VueWrapper, id: 'needs-you' | 'return-here') => w.find(`[data-dock="${id}"]`)
const head = (w: VueWrapper, id: 'needs-you' | 'return-here') =>
  w.get(`[data-dock="${id}"] [data-dock-head]`)
const isOpen = (w: VueWrapper, id: 'needs-you' | 'return-here'): boolean =>
  head(w, id).attributes('aria-expanded') === 'true'

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
  setActivePinia(createPinia())
  cards = []
  activateInbox = null
  stubApi()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('the bottom dock', () => {
  it('needs you and return here sit in the dock', async () => {
    cards = [moveCard('m1', 25), moveCard('m2', 5)]
    const w = await mountSidebar()
    const store = useSessionsStore()
    store.parkedConfirms = new Map([[confirm().id, confirm()]])
    store.addPendingApproval(approval())
    await nextTick()

    // Above Add folder, below the list: Needs you, Return here, Add folder.
    const column = [...w.element.children] as HTMLElement[]
    const index = (selector: string): number => column.findIndex((c) => c.matches(selector))
    const list = index('[data-island="sidebar-list"]')
    expect(index('[data-dock="needs-you"]')).toBeGreaterThan(list)
    expect(index('[data-dock="return-here"]')).toBeGreaterThan(index('[data-dock="needs-you"]'))
    expect(index('[data-island="sidebar-dock"]')).toBeGreaterThan(
      index('[data-dock="return-here"]')
    )

    // Folded by default, with label, count and the oldest item's age.
    for (const id of ['needs-you', 'return-here'] as const) {
      expect(isOpen(w, id)).toBe(false)
      expect(w.get(`[data-dock="${id}"] [data-dock-body]`).attributes('style')).toContain(
        'display: none'
      )
    }
    expect(head(w, 'needs-you').text().replace(/\s+/g, ' ')).toBe('Needs you 2 11m')
    expect(head(w, 'return-here').text().replace(/\s+/g, ' ')).toBe('Return here 2 25m')

    // The open bodies hold the same confirm row, approval row and cards as the rail and zone did.
    await head(w, 'needs-you').trigger('click')
    expect(isOpen(w, 'needs-you')).toBe(true)
    const needs = w.get('[data-dock="needs-you"] [data-dock-body]')
    expect(needs.text()).toContain('create_worktree · api-gateway')
    expect(needs.text()).toContain('Bash(npm run migrate)')
    expect(needs.text()).toContain('Allow')
    expect(needs.text()).toContain('Deny')
    // The parked confirm leads the queue and still hides its buttons until expanded.
    expect(needs.text().indexOf('create_worktree')).toBeLessThan(
      needs.text().indexOf('Bash(npm run migrate)')
    )
    expect(needs.text()).not.toContain('npm ci')

    await head(w, 'return-here').trigger('click')
    const returns = w.get('[data-dock="return-here"] [data-dock-body]')
    expect(returns.text()).toContain('Pick the cache backend m1')
    expect(returns.text()).toContain('Pick the cache backend m2')
  })

  // At 200px the buttons used to squeeze the command to nothing; the row wraps them instead.
  it('keeps the command readable beside Allow and Deny in a narrow sidebar', async () => {
    const w = await mountSidebar()
    useSessionsStore().addPendingApproval(approval())
    await nextTick()
    const row = w.get('[data-dock="needs-you"] [data-dock-body] .flex-wrap')
    const [, text, buttons] = [...row.element.children] as HTMLElement[]
    expect(text.style.flex).toBe('1 1 60px')
    expect(buttons.classList.contains('ml-auto')).toBe(true)
  })

  it('renders nothing for an empty section and never reopens it by itself', async () => {
    const w = await mountSidebar()
    const store = useSessionsStore()
    expect(section(w, 'needs-you').exists()).toBe(false)
    expect(section(w, 'return-here').exists()).toBe(false)

    store.addPendingApproval(approval())
    await nextTick()
    // An arriving approval never opens the section.
    expect(isOpen(w, 'needs-you')).toBe(false)
    await head(w, 'needs-you').trigger('click')
    store.removePendingApproval('r1')
    await nextTick()
    expect(section(w, 'needs-you').exists()).toBe(false)

    store.addPendingApproval(approval())
    await nextTick()
    expect(isOpen(w, 'needs-you')).toBe(false)
  })
})

describe('the Fleet rail is gone', () => {
  it('the fleet rail does not render', async () => {
    const w = await mountApp()
    const store = useSessionsStore()
    store.addPendingApproval(approval())
    await flushPromises()

    const html = w.html()
    expect(w.find('[data-rail-column]').exists()).toBe(false)
    expect(w.find('[data-column="rail"]').exists()).toBe(false)
    expect(w.find('[data-dsqa^="fleet-rail"]').exists()).toBe(false)
    expect(w.find('[data-island^="rail-"]').exists()).toBe(false)
    for (const text of ['Would-have', 'Active missions', 'Fleet rail']) {
      expect(html).not.toContain(text)
    }
    // No fourth column: the sidebar, its divider and the main column are all the shell has.
    const columns = w.get('[data-columns]').element
    expect([...columns.children].map((c) => c.tagName)).toEqual(['ASIDE', 'DIV', 'MAIN'])

    for (const file of ['InboxRail.vue', 'FleetBoardCard.vue']) {
      expect(existsSync(`src/renderer/src/components/${file}`), file).toBe(false)
    }
  })
})

describe('reaching Needs you', () => {
  async function ready(): Promise<VueWrapper> {
    const w = await mountApp()
    await useSessionsStore().init()
    await flushPromises()
    seedFolder()
    useSessionsStore().addPendingApproval(approval())
    await flushPromises()
    return w
  }

  it('deep link and shortcut open needs you', async () => {
    const w = await ready()
    const layout = useLayoutStore()
    const fold = async (): Promise<void> => {
      if (isOpen(w, 'needs-you')) await head(w, 'needs-you').trigger('click')
      layout.setSidebarCollapsed(true)
      await flushPromises()
    }
    // Nothing opened it on its own.
    expect(isOpen(w, 'needs-you')).toBe(false)

    const gestures: [string, () => void][] = [
      ['OS notification', () => activateInbox!()],
      ['⌘⇧A', () => binding('inbox.toggle').handler()],
      ['palette "Open approvals"', () => binding('inbox.open').handler()]
    ]
    for (const [name, gesture] of gestures) {
      await fold()
      gesture()
      await flushPromises()
      expect(layout.sidebarCollapsed, name).toBe(false)
      expect(isOpen(w, 'needs-you'), name).toBe(true)
    }

    // Pressed again, the shortcut folds it.
    binding('inbox.toggle').handler()
    await flushPromises()
    expect(isOpen(w, 'needs-you')).toBe(false)
    // The deep link and the palette action only ever open.
    activateInbox!()
    activateInbox!()
    binding('inbox.open').handler()
    await flushPromises()
    expect(isOpen(w, 'needs-you')).toBe(true)

    // Commands that only drove the rail are gone.
    for (const id of ['view.fleetRail', 'inbox.toggleOrder', 'inbox.filter', 'inbox.showAll']) {
      expect(
        bindings().some((b) => b.id === id),
        id
      ).toBe(false)
      expect(
        KEYBINDINGS.some((k) => k.id === id),
        id
      ).toBe(false)
    }
    expect(DESCRIPTOR_BY_ID['inbox.toggle'].defaultKeys).toBe('Cmd+Shift+A')
  })

  it('the shortcut leaves a pane expanded to the window instead of folding what it hides', async () => {
    const w = await ready()
    const helpers = useHelpersStore()
    // jsdom has no scrollIntoView; selecting a session reveals its row with it.
    HTMLElement.prototype.scrollIntoView = vi.fn()
    useSessionsStore().select('s1')
    const pane = helpers.addShellHelper(FOLDER, FOLDER)
    await head(w, 'needs-you').trigger('click')
    helpers.toggleExpandPane(FOLDER, pane)
    await flushPromises()
    expect(helpers.expandedPaneIdForCurrentWorktree).toBe(pane)

    binding('inbox.toggle').handler()
    await flushPromises()
    expect(helpers.expandedPaneIdForCurrentWorktree).toBeNull()
    expect(isOpen(w, 'needs-you')).toBe(true)
  })
})
