/**
 * Browser tabs, the tab strip (browser-tabs spec S-4): the pure layout and its `+N` list (AC-19), the tab menu's six
 * actions (AC-18), the callers that create a `start` tab (AC-38), the Topbar button's target (AC-23), the last-used
 * stamp (AC-39) and the tab chords. The renderer half mounts the real components over a stubbed `window.api`; the main
 * half runs the real `BrowserViewHost` over a fake Electron.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./helpers/fake-browser-electron')).electronMock)

import { createBrowserAccess } from '../src/main/browser/access'
import { createBrowserRegistry } from '../src/main/browser/registry'
import { BrowserViewHost } from '../src/main/browser/view-host'
import { KEYBINDINGS, defaultKeysFor } from '../src/main/keybindings-core'
import { decideForward } from '../src/main/browser/chord'
import { actionForChord, boundChordsFrom } from '../src/renderer/src/lib/browser-chords'
import {
  chooseBrowserTarget,
  lastUsedOperatorPane,
  layoutTabStrip,
  runTabMenuAction,
  tabMenuState,
  type TabPaneCandidate
} from '../src/renderer/src/lib/browser-tabs-view'
import { MAX_TABS_PER_PANE, type BrowserTabState } from '../src/shared/browser-tabs'
import { views, win, sent, type FakeWebContents } from './helpers/fake-browser-electron'

const FOLDER = '/work/acme-store'
const ids = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `tab-${(i + 1).toString(16).padStart(8, '0')}`)

const tab = (tabId: string, over: Partial<BrowserTabState> = {}): BrowserTabState => ({
  tabId,
  url: `https://${tabId}.test/`,
  title: `Title ${tabId.slice(-2)}`,
  favicon: null,
  loading: false,
  hostView: 'page',
  waitingForUp: false,
  discarded: false,
  active: false,
  agentActive: false,
  ...over
})

/* ---- layout (AC-19) --------------------------------------------------------------------------------- */

describe('layout', () => {
  it('W 600, 3 tabs is full: every tab 168px', () => {
    const t = ids(3)
    const l = layoutTabStrip(600, t, t[0]!)
    expect(l.mode).toBe('full')
    expect(l.activeWidth).toBe(168)
    expect(l.inactiveWidth).toBe(168)
    expect(l.overflow).toEqual([])
    expect(l.visible).toEqual(t)
  })

  it('W 700, 5 tabs is short: the active tab 168px, the others 112px with their title', () => {
    const t = ids(5)
    const l = layoutTabStrip(700, t, t[2]!)
    expect(l.mode).toBe('short')
    expect(l.activeWidth).toBe(168)
    expect(l.inactiveWidth).toBe(112)
    expect(l.overflow).toEqual([])
  })

  it('W 600, 5 tabs is shrink: equal widths of 120px', () => {
    const t = ids(5)
    const l = layoutTabStrip(600, t, t[0]!)
    expect(l.mode).toBe('shrink')
    expect(l.activeWidth).toBe(120)
    expect(l.inactiveWidth).toBe(120)
  })

  it('short needs more than 480px: W 480, 3 tabs falls through to shrink', () => {
    const t = ids(3)
    // full: 3 × 168 = 504 > 480. short: W is not > 480. shrink: 3 × 80 ≤ 480.
    expect(layoutTabStrip(480, t, t[0]!).mode).toBe('shrink')
    expect(layoutTabStrip(481, t, t[0]!).mode).toBe('short')
  })

  it('W 300, 5 tabs is icons: the active tab 168px, the others 28px, nothing behind +N', () => {
    const t = ids(5)
    const l = layoutTabStrip(300, t, t[1]!)
    expect(l.mode).toBe('icons')
    expect(l.activeWidth).toBe(168)
    expect(l.inactiveWidth).toBe(28)
    expect(l.overflow).toEqual([])
    expect(l.visible).toEqual(t)
  })

  it('W 250, 9 tabs is icons with k = 1: 7 tabs go behind +N and the active tab stays', () => {
    const t = ids(9)
    const l = layoutTabStrip(250, t, t[0]!)
    expect(l.mode).toBe('icons')
    expect(l.visible).toEqual([t[0], t[1]])
    expect(l.overflow).toEqual(t.slice(2))
    expect(l.overflow).toHaveLength(7)
  })

  it('the active tab is never moved behind +N, and the tabs keep their order', () => {
    const t = ids(9)
    const l = layoutTabStrip(250, t, t[8]!)
    expect(l.visible).toEqual([t[0], t[8]])
    expect(l.overflow).toEqual(t.slice(1, 8))
  })

  it('a strip too narrow for even the active tab keeps k at 0', () => {
    const t = ids(9)
    const l = layoutTabStrip(100, t, t[4]!)
    expect(l.visible).toEqual([t[4]])
    expect(l.overflow).toHaveLength(8)
  })

  describe('+N list', () => {
    async function mountStrip(count: number, width: number, activeIndex = 0) {
      const { mount } = await import('@vue/test-utils')
      const { i18n } = await import('../src/renderer/src/i18n')
      const TabStrip = (await import('../src/renderer/src/components/BrowserTabStrip.vue')).default
      const t = ids(count)
      const w = mount(TabStrip, {
        props: {
          tabs: t.map((id, i) => tab(id, { active: i === activeIndex })),
          activeTabId: t[activeIndex]!,
          canAdd: true,
          stripWidth: width
        },
        global: { plugins: [i18n] },
        attachTo: document.body
      })
      return { w, t }
    }

    it('shows +N for the tabs behind it and lists every tab in order with the active one marked', async () => {
      const { w, t } = await mountStrip(9, 250)
      const more = w.get('[data-testid="browser-tab-more"]')
      expect(more.text()).toContain('+7')
      expect(w.findAll('[data-testid="browser-tab"]')).toHaveLength(2)
      await more.trigger('click')
      const rows = w.findAll('[data-testid="browser-tab-more-item"]')
      expect(rows).toHaveLength(9)
      expect(rows.map((r) => r.attributes('data-tab-id'))).toEqual(t)
      expect(rows[0]!.attributes('aria-current')).toBe('true')
      w.unmount()
    })

    it('picking a tab in the list activates it', async () => {
      const { w, t } = await mountStrip(9, 250)
      await w.get('[data-testid="browser-tab-more"]').trigger('click')
      await w.findAll('[data-testid="browser-tab-more-item"]')[5]!.trigger('click')
      expect(w.emitted('activate')?.at(-1)).toEqual([t[5]])
      w.unmount()
    })
  })
})

/* ---- tab menu (AC-18) ------------------------------------------------------------------------------- */

describe('tab menu actions', () => {
  const T = ids(3)
  const fakeApi = () => ({
    tabNew: vi.fn(async () => ({ ok: true as const, tabId: 'tab-0000000f' })),
    tabClose: vi.fn(async () => ({ ok: true as const, paneClosed: false })),
    tabDuplicate: vi.fn(async () => ({ ok: true as const, tabId: 'tab-0000000e' })),
    tabMoveToPane: vi.fn(async () => ({ ok: true as const, paneId: 'bp-new' })),
    tabReload: vi.fn(async () => true)
  })
  const ctx = { paneId: 'bp-1', tabId: T[1]!, tabIds: T }

  it('new right: a start tab right of this one, and its address field is to take the focus', async () => {
    const api = fakeApi()
    const res = await runTabMenuAction(api, ctx, 'newRight')
    expect(api.tabNew).toHaveBeenCalledWith('bp-1', { hostView: 'start', afterTabId: T[1] })
    expect(res.focusAddress).toBe(true)
  })

  it('reload: reloads that tab', async () => {
    const api = fakeApi()
    await runTabMenuAction(api, ctx, 'reload')
    expect(api.tabReload).toHaveBeenCalledWith('bp-1', T[1])
  })

  it('duplicate: asks main for a copy right of the tab (main loads the same URL, no history)', async () => {
    const api = fakeApi()
    await runTabMenuAction(api, ctx, 'duplicate')
    expect(api.tabDuplicate).toHaveBeenCalledWith('bp-1', T[1])
    expect(api.tabNew).not.toHaveBeenCalled()
  })

  it('move: moves the tab to a new pane through main', async () => {
    const api = fakeApi()
    await runTabMenuAction(api, ctx, 'move')
    expect(api.tabMoveToPane).toHaveBeenCalledWith('bp-1', T[1])
  })

  it('move: the new pane main announces on browser:popup is placed in the folder stack', async () => {
    const { createPinia, setActivePinia } = await import('pinia')
    const { useBrowserStore } = await import('../src/renderer/src/stores/browser')
    const { useHelpersStore } = await import('../src/renderer/src/stores/helpers')
    let popup: ((p: Record<string, unknown>) => void) | null = null
    ;(window as unknown as { api: unknown }).api = new Proxy(
      {
        onBrowserPopup: (cb: (p: Record<string, unknown>) => void) => {
          popup = cb
          return () => undefined
        },
        browserSetChords: vi.fn(),
        helpersGet: vi.fn(async () => ({ splitVisible: false, splitRatio: 0.65, panes: [] })),
        helpersSet: vi.fn(async () => undefined)
      },
      { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => undefined) }
    )
    setActivePinia(createPinia())
    const browser = useBrowserStore()
    const helpers = useHelpersStore()
    browser.start()
    popup!({
      paneId: 'bp-new',
      worktreePath: FOLDER,
      url: 'https://b.test/',
      partition: 'operator',
      openedBy: 'operator',
      ownerSessionId: null,
      name: ''
    })
    expect(helpers.byWorktree.get(FOLDER)?.panes.map((p) => p.id)).toContain('bp-new')
    browser.stop()
  })

  it('move is disabled on a pane with a lone tab', () => {
    expect(tabMenuState({ tabCount: 1, agentPaneAtCap: false }).move.disabled).toBe(true)
    expect(tabMenuState({ tabCount: 2, agentPaneAtCap: false }).move.disabled).toBe(false)
  })

  it('move is disabled for an agent pane while the folder is at the agent pane cap', () => {
    expect(tabMenuState({ tabCount: 3, agentPaneAtCap: true }).move.disabled).toBe(true)
  })

  it('close others: closes every tab but this one', async () => {
    const api = fakeApi()
    await runTabMenuAction(api, ctx, 'closeOthers')
    expect(api.tabClose.mock.calls.map((c) => c[1]).sort()).toEqual([T[0], T[2]].sort())
  })

  it('close: closes that tab', async () => {
    const api = fakeApi()
    await runTabMenuAction(api, ctx, 'close')
    expect(api.tabClose).toHaveBeenCalledWith('bp-1', T[1])
  })

  it('the menu draws its six actions, move disabled on a lone tab', async () => {
    const { mount } = await import('@vue/test-utils')
    const { i18n } = await import('../src/renderer/src/i18n')
    const TabStrip = (await import('../src/renderer/src/components/BrowserTabStrip.vue')).default
    const t = ids(3)
    const w = mount(TabStrip, {
      props: {
        tabs: t.map((id, i) => tab(id, { active: i === 0 })),
        activeTabId: t[0]!,
        canAdd: true,
        stripWidth: 600,
        agentPaneAtCap: false
      },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await w.findAll('[data-testid="browser-tab"]')[1]!.trigger('contextmenu')
    const labels = ['newRight', 'reload', 'duplicate', 'move', 'closeOthers', 'close']
    for (const a of labels)
      expect(w.find(`[data-testid="browser-tab-menu-${a}"]`).exists()).toBe(true)
    expect(w.get('[data-testid="browser-tab-menu-newRight"]').text()).toBe('New tab to the right')
    expect(w.get('[data-testid="browser-tab-menu-move"]').text()).toBe('Move to a new pane')
    await w.get('[data-testid="browser-tab-menu-duplicate"]').trigger('click')
    expect(w.emitted('menu')?.at(-1)).toEqual(['duplicate', t[1]])
    w.unmount()
  })
})

/* ---- start callers (AC-38) -------------------------------------------------------------------------- */

describe('start callers', () => {
  const calls: unknown[][] = []
  async function pane(tabCount: number, over: Record<string, unknown> = {}) {
    const { createPinia, setActivePinia } = await import('pinia')
    const { mount, flushPromises } = await import('@vue/test-utils')
    const { i18n } = await import('../src/renderer/src/i18n')
    const BrowserPane = (await import('../src/renderer/src/components/BrowserPane.vue')).default
    const { useBrowserStore } = await import('../src/renderer/src/stores/browser')
    calls.length = 0
    const g = globalThis as unknown as { window: { api: unknown }; ResizeObserver: unknown }
    g.window.api = new Proxy(
      {},
      {
        get:
          (_t, name: string) =>
          (...args: unknown[]) => {
            calls.push([name, ...args])
            if (name === 'browserTabNew')
              return Promise.resolve({ ok: true, tabId: 'tab-0000ffff' })
            return name.startsWith('on') ? () => undefined : Promise.resolve(null)
          }
      }
    )
    g.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const pinia = createPinia()
    setActivePinia(pinia)
    const browser = useBrowserStore()
    const t = ids(tabCount)
    browser.states = {
      'bp-ui': {
        paneId: 'bp-ui',
        url: 'https://tab-00000001.test/',
        title: 'Title 01',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        origin: 'external',
        openedBy: 'operator',
        partition: 'operator',
        flagged: null,
        pausedUntil: null,
        disconnected: false,
        ownerSessionId: null,
        notice: null,
        agentReads: false,
        leaseActive: false,
        networkUntil: null,
        zoom: 1,
        emulation: {},
        downloadPrompt: null,
        pagePath: null,
        allowNetwork: false,
        pageFileRemoved: false,
        discarded: null,
        tabs: t.map((id, i) => tab(id, { active: i === 0 })),
        activeTabId: t[0]!,
        lastFocusedAt: null,
        ...over
      } as never
    }
    const w = mount(BrowserPane, {
      props: {
        pane: {
          id: 'bp-ui',
          type: 'browser',
          payload: { name: '', url: '', openedBy: 'operator', partition: 'operator' }
        } as never,
        worktreePath: FOLDER
      },
      global: { plugins: [pinia, i18n] },
      attachTo: document.body
    })
    await flushPromises()
    return { w, browser, flushPromises }
  }

  it('a one-tab pane shows + and no strip; + creates a start tab right of the active one', async () => {
    const { w, flushPromises } = await pane(1)
    expect(w.find('[data-testid="browser-tab-strip"]').exists()).toBe(false)
    expect(w.find('[data-testid="browser-title"]').exists()).toBe(true)
    await w.get('[data-testid="browser-tab-new"]').trigger('click')
    await flushPromises()
    expect(calls).toContainEqual([
      'browserTabNew',
      'bp-ui',
      { hostView: 'start', afterTabId: ids(1)[0] }
    ])
    w.unmount()
  })

  it('with two or more tabs the strip replaces the globe and title in the same header', async () => {
    const { w } = await pane(3)
    expect(w.find('[data-testid="browser-tab-strip"]').exists()).toBe(true)
    expect(w.find('[data-testid="browser-title"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="browser-tab"]')).toHaveLength(3)
    w.unmount()
  })

  it('at the limit + is disabled with the hint "Tab limit reached (8)"', async () => {
    const { w } = await pane(MAX_TABS_PER_PANE)
    const plus = w.get('[data-testid="browser-tab-new"]')
    expect(plus.attributes('disabled')).toBeDefined()
    expect(plus.attributes('title')).toBe('Tab limit reached (8)')
    w.unmount()
  })

  it('a page pane shows no +', async () => {
    const { w } = await pane(1, { origin: 'page', pagePath: 'docs/panel.html' })
    expect(w.find('[data-testid="browser-tab-new"]').exists()).toBe(false)
    w.unmount()
  })

  it('the store creates start tabs: tabNewStart passes hostView start and asks for the address focus', async () => {
    const { createPinia, setActivePinia } = await import('pinia')
    const { useBrowserStore } = await import('../src/renderer/src/stores/browser')
    const tabNew = vi.fn(async () => ({ ok: true as const, tabId: 'tab-0000ffff' }))
    ;(window as unknown as { api: unknown }).api = new Proxy(
      { browserTabNew: tabNew },
      { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => undefined) }
    )
    setActivePinia(createPinia())
    const browser = useBrowserStore()
    const res = await browser.tabNewStart('bp-1', 'tab-00000002')
    expect(res.ok).toBe(true)
    expect(tabNew).toHaveBeenCalledWith('bp-1', { hostView: 'start', afterTabId: 'tab-00000002' })
    expect(browser.focusAddressNonce['bp-1']).toBe(1)
    expect(browser.takeFocusAddressPending('bp-1')).toBe(true)
  })
})

/* ---- Topbar (AC-23) and last used (AC-39) ----------------------------------------------------------- */

const cand = (paneId: string, over: Partial<TabPaneCandidate> = {}): TabPaneCandidate => ({
  paneId,
  openedBy: 'operator',
  page: false,
  lastFocusedAt: null,
  order: 0,
  tabCount: 1,
  activeTabId: `tab-${paneId.slice(-1).repeat(8)}`,
  ...over
})

describe('focus stamps last used', () => {
  it('the pane with the latest lastFocusedAt is the last used', () => {
    const picked = lastUsedOperatorPane([
      cand('bp-a', { lastFocusedAt: 100 }),
      cand('bp-b', { lastFocusedAt: 300 }),
      cand('bp-c', { lastFocusedAt: 200 })
    ])
    expect(picked?.paneId).toBe('bp-b')
  })

  it('an unstamped pane ranks by creation time, newest first, below every stamped pane', () => {
    const picked = lastUsedOperatorPane([
      cand('bp-a', { order: 0 }),
      cand('bp-b', { order: 1 }),
      cand('bp-c', { order: 2, lastFocusedAt: 5 })
    ])
    expect(picked?.paneId).toBe('bp-c')
    const unstamped = lastUsedOperatorPane([cand('bp-a', { order: 0 }), cand('bp-b', { order: 1 })])
    expect(unstamped?.paneId).toBe('bp-b')
  })

  it('an agent pane or a page pane is never last used', () => {
    expect(
      lastUsedOperatorPane([
        cand('bp-a', { openedBy: 'agent', lastFocusedAt: 999 }),
        cand('bp-b', { page: true, lastFocusedAt: 998 })
      ])
    ).toBeNull()
  })

  it('a focus event on the page stamps and publishes lastFocusedAt', async () => {
    views.length = 0
    sent.length = 0
    const clock = 7_000_000
    const registry = createBrowserRegistry(() => clock)
    const host = new BrowserViewHost({
      getWindow: () => win as never,
      guestPreloadPath: '/x/browser-guest.js',
      registry,
      access: createBrowserAccess(() => clock),
      now: () => clock,
      harnuPorts: () => [],
      trustedHosts: () => [],
      readOptIn: () => false,
      leaseActive: () => false,
      scrub: (t: string) => t,
      prefs: { zoomFor: () => 1, setZoom: vi.fn() }
    } as never)
    registry.add({
      paneId: 'bp-1',
      folder: FOLDER,
      name: 'browser',
      openedBy: 'operator',
      partition: 'operator',
      ownerSessionId: null,
      createdAt: clock,
      lastActiveAt: clock,
      seenHosts: new Set<string>(),
      flagged: null
    } as never)
    host.create({ paneId: 'bp-1', folder: FOLDER, partition: 'operator', url: 'https://a.test/' })
    expect(host.state('bp-1')!.lastFocusedAt).toBeNull()
    ;(host.webContentsOf('bp-1') as unknown as FakeWebContents).emit('focus')
    expect(host.state('bp-1')!.lastFocusedAt).toBe(clock)
    expect(registry.get('bp-1')!.lastFocusedAt).toBe(clock)
    expect(
      sent.some(
        (m) =>
          m.channel === 'browser:state' &&
          (m.payload as { lastFocusedAt: number | null }).lastFocusedAt === clock
      )
    ).toBe(true)
  })

  it('a focus event on the header or address bar reaches main, and the pushed stamp is persisted with the pane', async () => {
    const { createPinia, setActivePinia } = await import('pinia')
    const { useBrowserStore } = await import('../src/renderer/src/stores/browser')
    const { useHelpersStore } = await import('../src/renderer/src/stores/helpers')
    const paneFocused = vi.fn(async () => true)
    let push: ((s: unknown) => void) | null = null
    ;(window as unknown as { api: unknown }).api = new Proxy(
      {
        browserPaneFocused: paneFocused,
        onBrowserState: (cb: (s: unknown) => void) => {
          push = cb
          return () => undefined
        },
        browserSetChords: vi.fn(),
        helpersGet: vi.fn(async () => ({ splitVisible: false, splitRatio: 0.65, panes: [] })),
        helpersSet: vi.fn(async () => undefined),
        browserDestroy: vi.fn(async () => true)
      },
      { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => undefined) }
    )
    setActivePinia(createPinia())
    const browser = useBrowserStore()
    const helpers = useHelpersStore()
    await helpers.ensureLoaded(FOLDER)
    helpers.addBrowserHelper(FOLDER, {
      paneId: 'bp-1',
      name: '',
      url: 'https://a.test/',
      openedBy: 'operator',
      partition: 'operator',
      ownerSessionId: null
    })
    browser.paneFocused('bp-1')
    expect(paneFocused).toHaveBeenCalledWith('bp-1')
    // Main answers the focus with the pane state carrying the stamp; the store keeps it on the pane.
    const t = ids(1)
    browser.start()
    push!({
      paneId: 'bp-1',
      url: 'https://a.test/',
      title: '',
      tabs: [tab(t[0]!, { active: true })],
      activeTabId: t[0]!,
      lastFocusedAt: 4242
    })
    const saved = helpers.byWorktree.get(FOLDER)!.panes.find((p) => p.id === 'bp-1') as {
      payload: { lastFocusedAt?: number | null }
    }
    expect(saved.payload.lastFocusedAt).toBe(4242)
    browser.stop()
  })
})

describe('topbar opens a tab', () => {
  const stamped = [
    cand('bp-a', { lastFocusedAt: 100, tabCount: 2 }),
    cand('bp-b', { lastFocusedAt: 300, tabCount: 3 })
  ]

  it('targets the operator pane with the latest lastFocusedAt, right of its active tab', () => {
    expect(chooseBrowserTarget(stamped, false)).toEqual({
      kind: 'tab',
      paneId: 'bp-b',
      afterTabId: stamped[1]!.activeTabId
    })
  })

  it('with no operator pane it opens a pane', () => {
    expect(chooseBrowserTarget([], false)).toEqual({ kind: 'pane' })
  })

  it('at the tab limit it opens a pane', () => {
    expect(
      chooseBrowserTarget([cand('bp-a', { lastFocusedAt: 1, tabCount: MAX_TABS_PER_PANE })], false)
    ).toEqual({ kind: 'pane' })
  })

  it('Shift+click always opens a pane', () => {
    expect(chooseBrowserTarget(stamped, true)).toEqual({ kind: 'pane' })
  })

  it('never targets an agent pane', () => {
    expect(
      chooseBrowserTarget([cand('bp-x', { openedBy: 'agent', lastFocusedAt: 999 })], false)
    ).toEqual({ kind: 'pane' })
  })

  describe('the store', () => {
    async function setup(
      panes: Array<{
        id: string
        openedBy: 'operator' | 'agent'
        stamp: number | null
        tabs: number
      }>
    ) {
      const { createPinia, setActivePinia } = await import('pinia')
      const { useBrowserStore } = await import('../src/renderer/src/stores/browser')
      const { useHelpersStore } = await import('../src/renderer/src/stores/helpers')
      const tabNew = vi.fn(async () => ({ ok: true as const, tabId: 'tab-0000ffff' }))
      ;(window as unknown as { api: unknown }).api = new Proxy(
        {
          browserTabNew: tabNew,
          helpersGet: vi.fn(async () => ({ splitVisible: false, splitRatio: 0.65, panes: [] })),
          helpersSet: vi.fn(async () => undefined)
        },
        { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => undefined) }
      )
      setActivePinia(createPinia())
      const browser = useBrowserStore()
      const helpers = useHelpersStore()
      await helpers.ensureLoaded(FOLDER)
      for (const p of panes) {
        helpers.addBrowserHelper(FOLDER, {
          paneId: p.id,
          name: '',
          url: 'https://a.test/',
          openedBy: p.openedBy,
          partition: p.openedBy,
          ownerSessionId: null
        })
        const t = ids(p.tabs)
        browser.states = {
          ...browser.states,
          [p.id]: {
            paneId: p.id,
            openedBy: p.openedBy,
            origin: 'external',
            pagePath: null,
            tabs: t.map((id, i) => tab(id, { active: i === 0 })),
            activeTabId: t[0]!,
            lastFocusedAt: p.stamp
          } as never
        }
      }
      return { browser, tabNew, openPane: vi.fn(async () => undefined) }
    }

    it('adds a start tab to the last-used operator pane and asks for its address focus', async () => {
      const { browser, tabNew, openPane } = await setup([
        { id: 'bp-a', openedBy: 'operator', stamp: 100, tabs: 2 },
        { id: 'bp-b', openedBy: 'operator', stamp: 300, tabs: 1 }
      ])
      await browser.openFromTopbar(FOLDER, { shift: false }, openPane)
      expect(tabNew).toHaveBeenCalledWith('bp-b', { hostView: 'start', afterTabId: ids(1)[0] })
      expect(openPane).not.toHaveBeenCalled()
      expect(browser.takeFocusAddressPending('bp-b')).toBe(true)
    })

    it('opens a pane with no operator pane, at the limit and on Shift+click', async () => {
      for (const [panes, shift] of [
        [[], false],
        [[{ id: 'bp-a', openedBy: 'operator' as const, stamp: 1, tabs: MAX_TABS_PER_PANE }], false],
        [[{ id: 'bp-a', openedBy: 'operator' as const, stamp: 1, tabs: 1 }], true]
      ] as const) {
        const { browser, tabNew, openPane } = await setup([...panes])
        await browser.openFromTopbar(FOLDER, { shift }, openPane)
        expect(tabNew).not.toHaveBeenCalled()
        expect(openPane).toHaveBeenCalledTimes(1)
      }
    })

    it('never targets an agent pane', async () => {
      const { browser, tabNew, openPane } = await setup([
        { id: 'bp-x', openedBy: 'agent', stamp: 999, tabs: 1 }
      ])
      await browser.openFromTopbar(FOLDER, { shift: false }, openPane)
      expect(tabNew).not.toHaveBeenCalled()
      expect(openPane).toHaveBeenCalledTimes(1)
    })
  })
})

/* ---- chords ------------------------------------------------------------------------------------------ */

describe('tab chords', () => {
  const list = (mac: boolean) =>
    KEYBINDINGS.map((d) => ({ id: d.id, keys: defaultKeysFor(d, mac), scope: d.scope }))

  it('Ctrl+T, Ctrl+W, Ctrl+Tab and Ctrl+Shift+Tab are bound in the browser scope off macOS', () => {
    const bound = boundChordsFrom(list(false), false)
    for (const chord of ['Cmd+T', 'Cmd+W', 'Cmd+Tab', 'Cmd+Shift+Tab'])
      expect(bound).toContain(chord)
    expect(actionForChord(list(false), 'Cmd+T', false)?.id).toBe('browser.tab.new')
    expect(actionForChord(list(false), 'Cmd+Tab', false)?.id).toBe('browser.tab.next')
    expect(actionForChord(list(false), 'Cmd+Shift+Tab', false)?.id).toBe('browser.tab.prev')
  })

  it('on macOS it is Cmd+T and Cmd+W, with Ctrl+Tab for next and previous', () => {
    const bound = boundChordsFrom(list(true), true)
    for (const chord of ['Cmd+T', 'Cmd+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab'])
      expect(bound).toContain(chord)
  })

  it('a focused browser pane close-tab wins over the app close-session chord', () => {
    expect(actionForChord(list(false), 'Cmd+W', false)).toEqual({
      id: 'browser.tab.close',
      scope: 'browser'
    })
  })

  it('main swallows the chord from the page before the page sees it', () => {
    const bound = new Set(boundChordsFrom(list(false), false))
    const input = (key: string, over = {}) => ({
      type: 'keyDown',
      key,
      control: true,
      alt: false,
      shift: false,
      meta: false,
      ...over
    })
    expect(decideForward(input('t'), bound, false)).toEqual({ forward: true, chord: 'Cmd+T' })
    expect(decideForward(input('w'), bound, false)).toEqual({ forward: true, chord: 'Cmd+W' })
    expect(decideForward(input('Tab'), bound, false)).toEqual({ forward: true, chord: 'Cmd+Tab' })
    expect(decideForward(input('Tab', { shift: true }), bound, false)).toEqual({
      forward: true,
      chord: 'Cmd+Shift+Tab'
    })
  })
})

beforeEach(() => {
  views.length = 0
  sent.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})
