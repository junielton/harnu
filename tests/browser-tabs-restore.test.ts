/**
 * Browser tabs, restart restore (browser-tabs spec S-2, AC-6, D-6): the tabs a pane kept in `helpers.json` come back
 * in order with their address, title and `hostView`, only the persisted active tab loads, a file written before tabs
 * existed restores as one tab, and the last-used stamp comes back.
 */
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const views: any[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any
  type Fn = (...a: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
  let nextId = 500
  class WC {
    id = nextId++
    url = ''
    loads: string[] = []
    attached = false
    listeners = new Map<string, Fn[]>()
    zoom = 1
    destroyed = false
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    debugger = {
      isAttached: () => this.attached,
      attach: () => {
        this.attached = true
      },
      detach: () => undefined,
      on: () => undefined,
      sendCommand: async () => ({})
    }
    getUserAgent = () => 'UA'
    isDestroyed = () => this.destroyed
    getURL = () => this.url
    getTitle = () => ''
    isLoading = () => false
    getZoomFactor = () => this.zoom
    setZoomFactor = (f: number) => void (this.zoom = f)
    setWindowOpenHandler = () => undefined
    executeJavaScript = async () => ({ x: 0, y: 0 })
    close = () => void (this.destroyed = true)
    loadURL = async (u: string) => {
      this.loads.push(u)
      this.url = u
      queueMicrotask(() => this.emit('did-finish-load'))
    }
    on(ev: string, fn: Fn): this {
      this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), fn])
      return this
    }
    once(ev: string, fn: Fn): this {
      const wrap: Fn = (...a) => {
        this.removeListener(ev, wrap)
        return fn(...a)
      }
      return this.on(ev, wrap)
    }
    removeListener(ev: string, fn: Fn): this {
      this.listeners.set(
        ev,
        (this.listeners.get(ev) ?? []).filter((f) => f !== fn)
      )
      return this
    }
    emit(ev: string): void {
      for (const fn of this.listeners.get(ev) ?? []) fn()
    }
  }
  class View {
    webContents = new WC()
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    visible = true
    constructor() {
      views.push(this)
    }
    setBounds(b: typeof this.bounds): void {
      this.bounds = b
    }
    getBounds(): typeof this.bounds {
      return this.bounds
    }
    setVisible(v: boolean): void {
      this.visible = v
    }
    getVisible(): boolean {
      return this.visible
    }
  }
  const win = {
    contentView: { addChildView: () => undefined, removeChildView: () => undefined },
    getContentSize: () => [1200, 800],
    isDestroyed: () => false,
    on: () => undefined,
    webContents: { getZoomFactor: () => 1, focus: () => undefined, send: () => undefined }
  }
  return { views, win, View }
})

vi.mock('electron', () => ({
  app: { commandLine: { getSwitchValue: () => '' } },
  BrowserWindow: class {},
  WebContentsView: h.View,
  nativeImage: {},
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      on: () => undefined,
      webRequest: { onBeforeRequest: () => undefined, onHeadersReceived: () => undefined }
    })
  }
}))

import { createBrowserAccess } from '../src/main/browser/access'
import { createBrowserRegistry } from '../src/main/browser/registry'
import { planRestore, restorePane } from '../src/main/browser/restore-plan'
import { BrowserViewHost } from '../src/main/browser/view-host'
import {
  persistedTabsOf,
  tabsPatchFromState,
  type BrowserTabState
} from '../src/shared/browser-tabs'

const FOLDER = '/work/acme-store'
const T1 = 'tab-00000001'
const T2 = 'tab-00000002'
const T3 = 'tab-00000003'

function pane(payload: Record<string, unknown>, id = 'bp-1') {
  return { id, type: 'browser', worktreePath: FOLDER, payload }
}

const threeTabs = {
  url: 'https://two.test/b',
  name: 'docs',
  tabs: [
    { tabId: T1, url: 'https://one.test/a', title: 'One', hostView: 'page' },
    { tabId: T2, url: 'https://two.test/b', title: 'Two', hostView: 'page' },
    { tabId: T3, url: 'about:blank', title: '', hostView: 'start' }
  ],
  activeTabId: T2,
  lastFocusedAt: 1_700_000_000_000
}

describe('restore tabs', () => {
  it('tabs return in order with address, title and hostView', () => {
    const r = restorePane(pane(threeTabs), 10)!
    expect(r.rec.tabs.map((t) => t.tabId)).toEqual([T1, T2, T3])
    expect(r.rec.tabs.map((t) => [t.discarded?.url, t.discarded?.title, t.hostView])).toEqual([
      ['https://one.test/a', 'One', 'page'],
      ['https://two.test/b', 'Two', 'page'],
      ['about:blank', '', 'start']
    ])
    expect(r.rec.activeTabId).toBe(T2)
    // A restored tab starts discarded: nothing loads until it is shown or driven.
    expect(r.rec.tabs.every((t) => t.discarded?.reason === 'restored')).toBe(true)
  })

  it('an error tab comes back as a page that reloads its address', () => {
    const r = restorePane(
      pane({
        tabs: [{ tabId: T1, url: 'http://localhost:3000/', title: 'Oops', hostView: 'error' }],
        activeTabId: T1
      }),
      10
    )!
    expect(r.rec.tabs[0]).toMatchObject({ hostView: 'page' })
    expect(r.rec.tabs[0]!.discarded?.url).toBe('http://localhost:3000/')
  })

  it('only the persisted active tab loads: showing the pane revives that tab and no other', async () => {
    const registry = createBrowserRegistry(() => 1)
    const access = createBrowserAccess(() => 1)
    const host = new BrowserViewHost({
      getWindow: () => h.win as never,
      guestPreloadPath: '/x/guest.js',
      registry,
      access,
      now: () => 1,
      harnuPorts: () => [],
      trustedHosts: () => [],
      readOptIn: () => false,
      leaseActive: () => false,
      scrub: (t) => t,
      openPopupPane: vi.fn(),
      prefs: { zoomFor: () => 1, setZoom: vi.fn() }
    })
    const restored = restorePane(pane(threeTabs), 10)!
    registry.add(restored.rec)
    host.restoreDiscarded('bp-1')
    expect(h.views).toHaveLength(0)
    expect(host.state('bp-1')!.tabs.map((t) => [t.tabId, t.discarded, t.active])).toEqual([
      [T1, true, false],
      [T2, true, true],
      [T3, true, false]
    ])
    host.applyBounds('bp-1', { x: 0, y: 0, width: 800, height: 600 }, true)
    await vi.waitFor(() => expect(h.views).toHaveLength(1))
    expect(h.views[0].webContents.loads).toEqual(['https://two.test/b'])
    expect(host.isDiscarded('bp-1', T1)).toBe(true)
    expect(host.isDiscarded('bp-1', T2)).toBe(false)
    expect(host.isDiscarded('bp-1', T3)).toBe(true)
  })

  it('a file without tabs restores as one tab from its url', () => {
    const r = restorePane(pane({ url: 'https://old.test/page', name: 'old' }), 10)!
    expect(r.rec.tabs).toHaveLength(1)
    expect(r.rec.tabs[0]).toMatchObject({ hostView: 'page' })
    expect(r.rec.tabs[0]!.tabId).toMatch(/^tab-[0-9a-f]{8}$/)
    expect(r.rec.tabs[0]!.discarded?.url).toBe('https://old.test/page')
    expect(r.rec.activeTabId).toBe(r.rec.tabs[0]!.tabId)
    expect(r.rec.lastFocusedAt ?? null).toBeNull()
  })

  it('lastFocusedAt is restored, and only as a finite number', () => {
    expect(restorePane(pane(threeTabs), 10)!.rec.lastFocusedAt).toBe(1_700_000_000_000)
    expect(
      restorePane(pane({ ...threeTabs, lastFocusedAt: 'yesterday' }), 10)!.rec.lastFocusedAt ?? null
    ).toBeNull()
  })

  it('a hand-edited file is repaired: more than eight tabs are cut, bad ids and addresses are dropped', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      tabId: `tab-${String(i).padStart(8, '0')}`,
      url: `https://n${i}.test/`,
      title: `n${i}`,
      hostView: 'page'
    }))
    const r = restorePane(
      pane({
        tabs: [
          { tabId: 'nope', url: 'https://bad-id.test/', title: 'x', hostView: 'page' },
          { tabId: T1, url: 'javascript:alert(1)', title: 'x', hostView: 'page' },
          ...many
        ],
        activeTabId: 'tab-ffffffff'
      }),
      10
    )!
    expect(r.rec.tabs).toHaveLength(8)
    // The bad id is minted anew, the unsafe address becomes about:blank, an unknown active id falls back to the first tab.
    expect(r.rec.tabs.every((t) => /^tab-[0-9a-f]{8}$/.test(t.tabId))).toBe(true)
    expect(r.rec.tabs[1]!.discarded?.url).toBe('about:blank')
    expect(r.rec.activeTabId).toBe(r.rec.tabs[0]!.tabId)
    expect(new Set(r.rec.tabs.map((t) => t.tabId)).size).toBe(8)
  })

  it('an agent pane restores its tabs in the agent partition', () => {
    const r = restorePane(pane({ ...threeTabs, openedBy: 'agent', partition: 'operator' }), 10)!
    expect(r.rec.partition).toBe('agent')
    expect(r.rec.tabs).toHaveLength(3)
  })

  it('planRestore keeps tabs per pane', () => {
    const out = planRestore(
      [pane(threeTabs, 'bp-1'), pane({ url: 'https://solo.test/' }, 'bp-2')],
      10
    )
    expect(out.map((o) => o.rec.tabs.length)).toEqual([3, 1])
  })
})

describe('persist tabs', () => {
  const tab = (tabId: string, over: Partial<BrowserTabState> = {}): BrowserTabState => ({
    tabId,
    url: 'https://one.test/a?token=secret#frag',
    title: 'One',
    favicon: null,
    loading: false,
    hostView: 'page',
    waitingForUp: false,
    discarded: false,
    active: false,
    agentActive: false,
    ...over
  })
  const state = {
    tabs: [
      tab(T1, { active: true }),
      tab(T2, { hostView: 'start', url: 'about:blank', title: '' })
    ],
    activeTabId: T1,
    lastFocusedAt: 42
  }
  const scrub = (u: string): string => u.split('?')[0]!.split('#')[0]!

  it('keeps each tab in order with its address, title and hostView, and the active tab and focus stamp', () => {
    expect(tabsPatchFromState({}, state, scrub)).toEqual({
      tabs: [
        { tabId: T1, url: 'https://one.test/a', title: 'One', hostView: 'page' },
        { tabId: T2, url: 'about:blank', title: '', hostView: 'start' }
      ],
      activeTabId: T1,
      lastFocusedAt: 42
    })
  })

  it('writes nothing when nothing changed, and nothing for a state without tabs', () => {
    const saved = {
      tabs: persistedTabsOf(state.tabs, scrub),
      activeTabId: T1,
      lastFocusedAt: 42
    }
    expect(tabsPatchFromState(saved, state, scrub)).toBeNull()
    expect(
      tabsPatchFromState(saved, { tabs: [], activeTabId: '', lastFocusedAt: null }, scrub)
    ).toBeNull()
  })

  it('what it writes is what restore reads back', () => {
    const patch = tabsPatchFromState({}, state, scrub)!
    const r = restorePane(pane({ ...patch, url: 'https://one.test/a' }), 10)!
    expect(r.rec.tabs.map((t) => [t.tabId, t.hostView])).toEqual([
      [T1, 'page'],
      [T2, 'start']
    ])
    expect(r.rec.activeTabId).toBe(T1)
    expect(r.rec.lastFocusedAt).toBe(42)
  })
})
