/**
 * Browser tabs, the main-process model (browser-tabs spec S-2, AC-2 to AC-8, AC-35, AC-36): one view per tab, the
 * host seam, discard per tab, capture per pane, move to a new pane. The REAL `BrowserViewHost`, registry, access
 * and lease table run over a fake Electron (views, web contents, a window), so what is proved is the model itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  type Fn = (...a: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
  let nextWcId = 100
  const views: any[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any
  const sends: Array<{ channel: string; payload: any }> = [] // eslint-disable-line @typescript-eslint/no-explicit-any
  const partitions: string[] = []

  class FakeWebContents {
    id = nextWcId++
    url = ''
    title = ''
    loading = false
    destroyed = false
    zoom = 1
    attached = false
    listeners = new Map<string, Fn[]>()
    dbgListeners: Fn[] = []
    cmds: Array<{ method: string; params: any }> = [] // eslint-disable-line @typescript-eslint/no-explicit-any
    loads: string[] = []
    navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => undefined,
      goForward: () => undefined
    }
    debugger = {
      isAttached: () => this.attached,
      attach: () => {
        this.attached = true
      },
      detach: () => {
        this.attached = false
      },
      on: (_ev: string, fn: Fn) => {
        this.dbgListeners.push(fn)
      },
      sendCommand: async (method: string, params: unknown) => {
        this.cmds.push({ method, params })
        return {}
      }
    }
    getUserAgent = () => 'FakeUA/1.0'
    isDestroyed = () => this.destroyed
    getURL = () => this.url
    getTitle = () => this.title
    isLoading = () => this.loading
    getZoomFactor = () => this.zoom
    setZoomFactor = vi.fn((f: number) => {
      this.zoom = f
    })
    setWindowOpenHandler = vi.fn()
    executeJavaScript = vi.fn(async () => ({ x: 0, y: 0 }))
    reload = vi.fn()
    reloadIgnoringCache = vi.fn()
    stop = vi.fn()
    downloadURL = vi.fn()
    openDevTools = vi.fn()
    close = () => {
      this.destroyed = true
    }
    loadURL = vi.fn(async (url: string) => {
      this.loads.push(url)
      this.url = url === 'about:blank' ? '' : url
      queueMicrotask(() => this.emit('did-finish-load'))
    })
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
    emit(ev: string, ...a: unknown[]): void {
      for (const fn of this.listeners.get(ev) ?? []) fn(...a)
    }
    cdpEvent(method: string, params: unknown): void {
      for (const fn of this.dbgListeners) fn({}, method, params)
    }
  }

  class FakeView {
    webContents = new FakeWebContents()
    webPreferences: { partition: string }
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    visible = true
    constructor(opts: { webPreferences: { partition: string } }) {
      this.webPreferences = opts.webPreferences
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
    children: [] as unknown[],
    contentView: {
      addChildView(v: unknown): void {
        if (!win.children.includes(v)) win.children.push(v)
      },
      removeChildView(v: unknown): void {
        win.children = win.children.filter((c) => c !== v)
      }
    },
    getContentSize: () => [1200, 800],
    isDestroyed: () => false,
    on: () => undefined,
    webContents: {
      getZoomFactor: () => 1,
      focus: () => undefined,
      send: (channel: string, payload: unknown) => void sends.push({ channel, payload })
    }
  }

  const session = {
    fromPartition: (name: string) => {
      partitions.push(name)
      return {
        setPermissionRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined,
        on: () => undefined,
        webRequest: { onBeforeRequest: () => undefined, onHeadersReceived: () => undefined }
      }
    }
  }

  return { views, sends, partitions, win, session, FakeView }
})

vi.mock('electron', () => ({
  app: { commandLine: { getSwitchValue: () => '' } },
  BrowserWindow: class {},
  WebContentsView: h.FakeView,
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  session: h.session
}))

import { createBrowserAccess } from '../src/main/browser/access'
import { BrowserLeases } from '../src/main/browser/lease'
import { createBrowserRegistry, MAX_AGENT_PANES_PER_FOLDER } from '../src/main/browser/registry'
import { MAX_TABS_PER_PANE, moveTabToNewPane } from '../src/main/browser/tabs'
import { BrowserViewHost } from '../src/main/browser/view-host'
import { persistedTabsOf } from '../src/shared/browser-tabs'

const FOLDER = '/work/acme-store'
const RECT = { x: 0, y: 0, width: 800, height: 600 }
const TEN_MIN = 10 * 60 * 1000

type OpenedBy = 'operator' | 'agent'

function rig(opts: { zoomFor?: (url: string) => number } = {}) {
  let clock = 5_000_000
  const registry = createBrowserRegistry(() => clock)
  const access = createBrowserAccess(() => clock)
  const leases = new BrowserLeases(() => clock)
  registry.setDisconnectedProbe((id) => access.isDisconnected(id))
  const host = new BrowserViewHost({
    getWindow: () => h.win as never,
    guestPreloadPath: '/x/browser-guest.js',
    registry,
    access,
    now: () => clock,
    harnuPorts: () => [],
    trustedHosts: () => [],
    readOptIn: () => false,
    leaseActive: (id, token) => leases.isActive(id, token),
    scrub: (t) => t,
    openPopupPane: vi.fn(),
    prefs: { zoomFor: opts.zoomFor ?? (() => 1), setZoom: vi.fn() }
  })
  const popups: unknown[] = []
  const addPane = (paneId: string, openedBy: OpenedBy = 'operator', url = 'https://a.test/') => {
    registry.add({
      paneId,
      folder: FOLDER,
      name: 'browser',
      openedBy,
      partition: openedBy === 'agent' ? 'agent' : 'operator',
      ownerSessionId: openedBy === 'agent' ? '8eb88caa-c60a-4791-abff-b0165260a260' : null,
      createdAt: clock,
      lastActiveAt: clock,
      seenHosts: new Set<string>(),
      flagged: null
    } as never)
    host.create({
      paneId,
      folder: FOLDER,
      partition: openedBy === 'agent' ? 'agent' : 'operator',
      url
    })
    return registry.get(paneId)!.activeTabId
  }
  const move = (paneId: string, tabId: string, newPaneId = 'bp-moved') =>
    moveTabToNewPane(
      {
        registry,
        access,
        leases,
        host,
        now: () => clock,
        newPaneId: () => newPaneId,
        notifyPopup: (p) => popups.push(p)
      },
      paneId,
      tabId
    )
  const wcOf = (paneId: string, tabId?: string) => host.webContentsOf(paneId, tabId) as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const tabIds = (paneId: string) => registry.get(paneId)!.tabs.map((t) => t.tabId)
  const tab = (paneId: string, tabId: string) =>
    registry.get(paneId)!.tabs.find((t) => t.tabId === tabId)!
  /** Hide a tab long enough, then discard it the way the sweep would (`discard` judges the same rule again). */
  const discardNow = async (paneId: string, tabId: string): Promise<boolean> => {
    clock += TEN_MIN + 1000
    return host.discard(paneId, 'idle', tabId)
  }
  return {
    registry,
    access,
    leases,
    host,
    popups,
    discardNow,
    addPane,
    move,
    wcOf,
    tabIds,
    tab,
    tick: (ms: number) => (clock += ms),
    now: () => clock
  }
}

function newTab(
  r: ReturnType<typeof rig>,
  paneId: string,
  o: Record<string, unknown> = {}
): string {
  const res = r.host.newTab(paneId, { url: 'https://b.test/', ...o })
  if (!res.ok) throw new Error(`newTab refused: ${res.error}`)
  return res.tabId
}

beforeEach(() => {
  h.views.length = 0
  h.sends.length = 0
  h.partitions.length = 0
  h.win.children = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('one view per tab', () => {
  it('a pane holds an ordered list of tabs, each with its own tab id and its own view', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1')
    const t3 = newTab(r, 'bp-1', { afterTabId: t1 })
    expect(t1).toMatch(/^tab-[0-9a-f]{8}$/)
    expect(r.tabIds('bp-1')).toEqual([t1, t3, t2])
    expect(h.views).toHaveLength(3)
    expect(new Set(h.views.map((v) => v.webContents.id)).size).toBe(3)
    expect(r.wcOf('bp-1', t1)).not.toBe(r.wcOf('bp-1', t2))
  })

  it('only the active tab view is attached to the window', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    expect(h.win.children).toHaveLength(1)
    const v1 = h.win.children[0]
    const t2 = newTab(r, 'bp-1')
    expect(r.registry.get('bp-1')!.activeTabId).toBe(t2)
    expect(h.win.children).toHaveLength(1)
    expect(h.win.children[0]).not.toBe(v1)
    expect(r.host.activateTab('bp-1', t1)).toBe(true)
    expect(h.win.children).toEqual([v1])
  })

  it('a background tab is created without taking the active place or the window', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    expect(r.registry.get('bp-1')!.activeTabId).toBe(t1)
    expect(h.win.children).toHaveLength(1)
    expect(r.host.state('bp-1')!.tabs.map((t) => [t.tabId, t.active])).toEqual([
      [t1, true],
      [t2, false]
    ])
  })

  it('a ninth tab is refused TAB_LIMIT and no view is made for it', () => {
    const r = rig()
    r.addPane('bp-1')
    for (let i = 1; i < MAX_TABS_PER_PANE; i++) newTab(r, 'bp-1')
    expect(r.registry.get('bp-1')!.tabs).toHaveLength(8)
    const viewsBefore = h.views.length
    expect(r.host.newTab('bp-1', { url: 'https://nine.test/' })).toEqual({
      ok: false,
      error: 'TAB_LIMIT'
    })
    expect(h.views).toHaveLength(viewsBefore)
  })

  it('an unknown tab is TAB_NOT_FOUND on activate and close', () => {
    const r = rig()
    r.addPane('bp-1')
    expect(r.host.activateTab('bp-1', 'tab-00000000')).toBe(false)
    expect(r.host.closeTab('bp-1', 'tab-00000000')).toEqual({ ok: false, error: 'TAB_NOT_FOUND' })
  })

  it('closing a tab releases only its view, and the neighbour takes over when it was active', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1')
    const wc2 = r.wcOf('bp-1', t2)
    expect(r.host.closeTab('bp-1', t2)).toEqual({ ok: true, paneClosed: false })
    expect(wc2.destroyed).toBe(true)
    expect(r.registry.get('bp-1')!.activeTabId).toBe(t1)
    expect(r.wcOf('bp-1', t1).destroyed).toBe(false)
    expect(h.win.children).toHaveLength(1)
  })
})

describe('tab uses pane partition', () => {
  it('every tab of an operator pane is created in the operator partition', () => {
    const r = rig()
    r.addPane('bp-1', 'operator')
    newTab(r, 'bp-1')
    newTab(r, 'bp-1', { background: true })
    expect(h.views.map((v) => v.webPreferences.partition)).toEqual([
      'persist:harnu-browser',
      'persist:harnu-browser',
      'persist:harnu-browser'
    ])
  })

  it('every tab of an agent pane is created in the agent partition', () => {
    const r = rig()
    r.addPane('bp-9', 'agent')
    newTab(r, 'bp-9')
    expect(h.views.map((v) => v.webPreferences.partition)).toEqual([
      'persist:harnu-browser-agent',
      'persist:harnu-browser-agent'
    ])
  })

  it('a revived tab comes back in its pane partition too', async () => {
    const r = rig()
    r.addPane('bp-9', 'agent')
    const t2 = newTab(r, 'bp-9', { background: true })
    await r.discardNow('bp-9', t2)
    h.views.length = 0
    await r.host.revive('bp-9', { tabId: t2 })
    expect(h.views.map((v) => v.webPreferences.partition)).toEqual(['persist:harnu-browser-agent'])
  })
})

describe('host seam', () => {
  it('a call keyed by paneId acts on the active tab, with tabId on the named one', () => {
    const r = rig()
    const t1 = r.addPane('bp-1', 'operator', 'https://one.test/')
    const t2 = newTab(r, 'bp-1', { url: 'https://two.test/', background: true })
    expect(r.host.info('bp-1')?.url).toBe('https://one.test/')
    expect(r.host.info('bp-1', t2)?.url).toBe('https://two.test/')
    expect(r.host.readers('bp-1')).toBe(r.host.readers('bp-1', t1))
    expect(r.host.readers('bp-1', t2)).not.toBe(r.host.readers('bp-1'))
    expect(r.host.viewToken('bp-1')).toBe(`${r.wcOf('bp-1', t1).id}|https://one.test`)
    expect(r.host.viewToken('bp-1', t2)).toBe(`${r.wcOf('bp-1', t2).id}|https://two.test`)
  })

  it('cdp goes to the named tab, and to the active tab without one', async () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    await r.host.cdp('bp-1', 'Runtime.evaluate', { expression: '1' })
    await r.host.cdp('bp-1', 'Runtime.evaluate', { expression: '2' }, t2)
    const seen = (tab: string) =>
      r
        .wcOf('bp-1', tab)
        .cmds.filter((c: { method: string }) => c.method === 'Runtime.evaluate')
        .map((c: { params: { expression: string } }) => c.params.expression)
    expect(seen(t1)).toEqual(['1'])
    expect(seen(t2)).toEqual(['2'])
  })

  it('navigate loads in the named tab and leaves the active one alone', async () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    const loadsOf1 = r.wcOf('bp-1', t1).loads.length
    const p = r.host.navigate(
      'bp-1',
      { url: 'https://next.test/' },
      { waitUntil: 'commit', timeoutMs: 1000, hard: false },
      t2
    )
    r.wcOf('bp-1', t2).emit('did-navigate', {}, 'https://next.test/')
    await p
    expect(r.wcOf('bp-1', t2).loads.at(-1)).toBe('https://next.test/')
    expect(r.wcOf('bp-1', t1).loads).toHaveLength(loadsOf1)
  })

  it('drive sets the activity word of the tab it names, and says which tab in the event', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    r.host.drive('bp-1', true, t2)
    const tabs = r.host.state('bp-1')!.tabs
    expect(tabs.find((t) => t.tabId === t2)!.agentActive).toBe(true)
    expect(tabs.find((t) => t.tabId === t1)!.agentActive).toBe(false)
    const ev = h.sends.filter((s) => s.channel === 'browser:activity').at(-1)!
    expect(ev.payload).toMatchObject({ paneId: 'bp-1', tabId: t2, word: 'driving' })
    r.host.drive('bp-1', false, t2)
    expect(r.host.state('bp-1')!.tabs.every((t) => !t.agentActive)).toBe(true)
  })

  it('drive without a tab names the active tab', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    newTab(r, 'bp-1', { background: true })
    r.host.drive('bp-1', true)
    expect(r.host.state('bp-1')!.tabs.find((t) => t.tabId === t1)!.agentActive).toBe(true)
  })

  it('the pane state keeps the pane-level url and title of the active tab and lists every tab', () => {
    const r = rig()
    const t1 = r.addPane('bp-1', 'operator', 'https://one.test/')
    r.wcOf('bp-1', t1).title = 'One'
    const t2 = newTab(r, 'bp-1', { url: 'https://two.test/' })
    r.wcOf('bp-1', t2).title = 'Two'
    const s = r.host.state('bp-1')!
    expect(s).toMatchObject({ url: 'https://two.test/', title: 'Two', activeTabId: t2 })
    expect(s.tabs.map((t) => [t.tabId, t.url, t.title, t.active, t.discarded])).toEqual([
      [t1, 'https://one.test/', 'One', false, false],
      [t2, 'https://two.test/', 'Two', true, false]
    ])
  })
})

describe('discard per tab', () => {
  const shown = (r: ReturnType<typeof rig>, paneId: string) =>
    r.host.applyBounds(paneId, RECT, true)

  it('hidden discard: a tab that is not the active tab of a shown pane is discarded after 10 minutes', async () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    shown(r, 'bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    r.tick(TEN_MIN - 1000)
    await r.host.sweep()
    expect(r.tab('bp-1', t2).discarded).toBeNull()
    r.tick(2000)
    const wc2 = r.wcOf('bp-1', t2)
    await r.host.sweep()
    expect(r.tab('bp-1', t2).discarded).toMatchObject({ reason: 'idle', url: 'https://b.test/' })
    expect(wc2.destroyed).toBe(true)
    expect(r.tab('bp-1', t1).discarded).toBeNull()
    expect(r.host.isDiscarded('bp-1', t2)).toBe(true)
    expect(r.host.isDiscarded('bp-1', t1)).toBe(false)
  })

  it('hidden discard: the hidden clock of a tab starts when it stops being shown', async () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    shown(r, 'bp-1')
    r.tick(TEN_MIN * 3)
    newTab(r, 'bp-1')
    r.tick(TEN_MIN - 1000)
    await r.host.sweep()
    expect(r.tab('bp-1', t1).discarded).toBeNull()
    r.tick(2000)
    await r.host.sweep()
    expect(r.tab('bp-1', t1).discarded).not.toBeNull()
  })

  it('revive: activating a discarded tab brings its address back in a new view', async () => {
    const r = rig()
    r.addPane('bp-1')
    shown(r, 'bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    r.tick(TEN_MIN + 1000)
    await r.host.sweep()
    expect(await r.host.revive('bp-1', { tabId: t2 })).toBe(true)
    expect(r.tab('bp-1', t2).discarded).toBeNull()
    expect(r.wcOf('bp-1', t2).loads).toEqual(['https://b.test/'])
    expect(r.host.isDiscarded('bp-1', t2)).toBe(false)
  })

  it('revive: activateTab on a discarded tab revives it and attaches only its view', async () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    shown(r, 'bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    await r.discardNow('bp-1', t2)
    expect(r.host.activateTab('bp-1', t2)).toBe(true)
    await vi.waitFor(() => expect(r.tab('bp-1', t2).discarded).toBeNull())
    expect(r.registry.get('bp-1')!.activeTabId).toBe(t2)
    expect(h.win.children).toHaveLength(1)
    expect(r.wcOf('bp-1', t1).destroyed).toBe(false)
  })

  it('verb blocks tab: a verb in flight keeps its own tab, and only that one, from being discarded', async () => {
    const r = rig()
    r.addPane('bp-1')
    shown(r, 'bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    const t3 = newTab(r, 'bp-1', { background: true })
    const end = r.registry.beginVerb('bp-1', t2)
    r.tick(TEN_MIN + 1000)
    await r.host.sweep()
    expect(r.tab('bp-1', t2).discarded).toBeNull()
    expect(r.tab('bp-1', t3).discarded).not.toBeNull()
    end()
    await r.host.sweep()
    expect(r.tab('bp-1', t2).discarded).not.toBeNull()
  })

  it('capture blocks pane: a running network capture keeps every tab of its pane', async () => {
    const r = rig()
    r.addPane('bp-1')
    shown(r, 'bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    r.host.readers('bp-1')!.startCapture({ maxMinutes: 30 })
    r.tick(TEN_MIN + 1000)
    await r.host.sweep()
    expect(r.tab('bp-1', t2).discarded).toBeNull()
    r.host.readers('bp-1')!.stopCapture('stopped')
    await r.host.sweep()
    expect(r.tab('bp-1', t2).discarded).not.toBeNull()
  })

  it('last tab closes pane: closing the only tab removes the pane for good', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const wc = r.wcOf('bp-1', t1)
    expect(r.host.closeTab('bp-1', t1)).toEqual({ ok: true, paneClosed: true })
    expect(wc.destroyed).toBe(true)
    expect(r.registry.get('bp-1')).toBeUndefined()
    expect(r.host.has('bp-1')).toBe(false)
    expect(r.host.info('bp-1')).toBeUndefined()
    expect(h.win.children).toHaveLength(0)
  })
})

describe('capture per pane', () => {
  const request = (wc: { cdpEvent(m: string, p: unknown): void }, id: string, url: string) =>
    wc.cdpEvent('Network.requestWillBeSent', {
      requestId: id,
      wallTime: 1,
      request: { url, method: 'GET' }
    })
  const read = (r: ReturnType<typeof rig>, paneId: string) => {
    const res = r.host.readers(paneId)!.capture.read({ limit: 50 })
    if (!res.ok) throw new Error('cursor expired')
    return res.entries
  }

  it('all tabs: start covers every live tab of the pane', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    r.host.readers('bp-1')!.startCapture({ maxMinutes: 5 })
    request(r.wcOf('bp-1', t1), '1', 'https://a.test/x')
    request(r.wcOf('bp-1', t2), '1', 'https://b.test/y')
    expect(read(r, 'bp-1').map((e) => e.url)).toEqual(['https://a.test/x', 'https://b.test/y'])
  })

  it('joins: a tab created while capture runs joins it', () => {
    const r = rig()
    r.addPane('bp-1')
    r.host.readers('bp-1')!.startCapture({ maxMinutes: 5 })
    const t2 = newTab(r, 'bp-1', { background: true })
    request(r.wcOf('bp-1', t2), '7', 'https://new.test/')
    expect(read(r, 'bp-1').map((e) => e.url)).toEqual(['https://new.test/'])
  })

  it('joins: a tab revived while capture runs joins it', async () => {
    const r = rig()
    r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    await r.discardNow('bp-1', t2)
    r.host.readers('bp-1')!.startCapture({ maxMinutes: 5 })
    await r.host.revive('bp-1', { tabId: t2 })
    request(r.wcOf('bp-1', t2), '8', 'https://again.test/')
    expect(read(r, 'bp-1').map((e) => e.url)).toEqual(['https://again.test/'])
  })

  it('discarded kept: what a tab recorded stays in the buffer after the tab is discarded', async () => {
    const r = rig()
    r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    r.host.readers('bp-1')!.startCapture({ maxMinutes: 30 })
    request(r.wcOf('bp-1', t2), '3', 'https://kept.test/')
    r.host.readers('bp-1')!.stopCapture('stopped')
    await r.discardNow('bp-1', t2)
    expect(r.host.isDiscarded('bp-1', t2)).toBe(true)
    expect(read(r, 'bp-1').map((e) => e.url)).toEqual(['https://kept.test/'])
  })

  it('discarded kept: a tab closed while capture runs leaves its entries behind', () => {
    const r = rig()
    r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    r.host.readers('bp-1')!.startCapture({ maxMinutes: 30 })
    request(r.wcOf('bp-1', t2), '4', 'https://closed.test/')
    r.host.closeTab('bp-1', t2)
    expect(r.host.captureStatus('bp-1').active).toBe(true)
    expect(read(r, 'bp-1').map((e) => e.url)).toEqual(['https://closed.test/'])
  })

  it('moved stays: a moved tab earlier entries stay with the old pane and the new pane starts clean', () => {
    const r = rig()
    r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1')
    r.host.readers('bp-1')!.startCapture({ maxMinutes: 5 })
    request(r.wcOf('bp-1', t2), '5', 'https://before-move.test/')
    expect(r.move('bp-1', t2)).toEqual({ ok: true, paneId: 'bp-moved' })
    expect(read(r, 'bp-1').map((e) => e.url)).toEqual(['https://before-move.test/'])
    expect(r.host.captureStatus('bp-moved').active).toBe(false)
    request(r.wcOf('bp-moved'), '6', 'https://after-move.test/')
    expect(read(r, 'bp-moved')).toEqual([])
    expect(read(r, 'bp-1').map((e) => e.url)).toEqual(['https://before-move.test/'])
  })

  it('one stop: a stop from any tab ends capture for the whole pane', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    r.host.readers('bp-1', t1)!.startCapture({ maxMinutes: 5 })
    expect(r.host.captureStatus('bp-1').active).toBe(true)
    r.host.readers('bp-1', t2)!.stopCapture('stopped')
    expect(r.host.captureStatus('bp-1').active).toBe(false)
    request(r.wcOf('bp-1', t1), '9', 'https://late.test/')
    expect(read(r, 'bp-1')).toEqual([])
  })

  it('one stop: a single expiry ends capture for every tab', () => {
    vi.useFakeTimers()
    const r = rig()
    const t1 = r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    r.host.readers('bp-1')!.startCapture({ maxMinutes: 1 })
    r.tick(60_000)
    vi.advanceTimersByTime(60_000)
    expect(r.host.captureStatus('bp-1').active).toBe(false)
    request(r.wcOf('bp-1', t1), '1', 'https://x.test/')
    request(r.wcOf('bp-1', t2), '1', 'https://y.test/')
    expect(read(r, 'bp-1')).toEqual([])
  })

  it('tabId on entries: every entry says which tab made the request', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    r.host.readers('bp-1')!.startCapture({ maxMinutes: 5 })
    request(r.wcOf('bp-1', t1), '1', 'https://a.test/')
    request(r.wcOf('bp-1', t2), '1', 'https://b.test/')
    expect(read(r, 'bp-1').map((e) => [e.url, e.tabId])).toEqual([
      ['https://a.test/', t1],
      ['https://b.test/', t2]
    ])
  })
})

describe('move to a new pane', () => {
  const setup = (openedBy: OpenedBy = 'operator') => {
    const r = rig()
    r.addPane('bp-1', openedBy)
    const tabId = newTab(r, 'bp-1', { url: 'https://moved.test/' })
    return { r, tabId }
  }

  it('new pane settings: the new pane copies partition, openedBy, owner, Disconnect, emulation and zoom', () => {
    const { r, tabId } = setup('agent')
    const old = r.registry.get('bp-1')!
    old.emulation = { touch: true }
    r.access.disconnect('bp-1')
    r.wcOf('bp-1', tabId).zoom = 1.5
    expect(r.move('bp-1', tabId)).toEqual({ ok: true, paneId: 'bp-moved' })
    const fresh = r.registry.get('bp-moved')!
    expect(fresh).toMatchObject({
      paneId: 'bp-moved',
      folder: FOLDER,
      partition: 'agent',
      openedBy: 'agent',
      ownerSessionId: old.ownerSessionId,
      emulation: { touch: true }
    })
    expect(r.access.isDisconnected('bp-moved')).toBe(true)
    expect(r.host.state('bp-moved')!.zoom).toBe(1.5)
    expect(r.popups).toEqual([
      expect.objectContaining({ paneId: 'bp-moved', worktreePath: FOLDER, partition: 'agent' })
    ])
  })

  it('same tab: the tab keeps its id, page and history, and leaves the old pane', () => {
    const { r, tabId } = setup()
    const wc = r.wcOf('bp-1', tabId)
    r.move('bp-1', tabId)
    expect(r.registry.get('bp-moved')!.tabs.map((t) => t.tabId)).toEqual([tabId])
    expect(r.registry.get('bp-moved')!.activeTabId).toBe(tabId)
    expect(r.wcOf('bp-moved')).toBe(wc)
    expect(wc.destroyed).toBe(false)
    expect(r.host.info('bp-moved')?.url).toBe('https://moved.test/')
    expect(r.tabIds('bp-1')).not.toContain(tabId)
    expect(r.host.info('bp-1')?.url).toBe('https://a.test/')
    expect(h.win.children).toHaveLength(2)
  })

  it('lease re-keyed: an active lease follows the tab to the new pane with the same view token', () => {
    const { r, tabId } = setup('operator')
    const token = r.host.viewToken('bp-1', tabId)!
    r.leases.grant('bp-1', FOLDER, token)
    r.move('bp-1', tabId)
    expect(r.host.viewToken('bp-moved')).toBe(token)
    expect(r.leases.isActive('bp-moved', token)).toBe(true)
    expect(r.leases.isActive('bp-1', token)).toBe(false)
  })

  it('lease re-keyed: a lease on another tab stays with the old pane', () => {
    const { r, tabId } = setup('operator')
    const other = r.host.viewToken('bp-1', r.tabIds('bp-1')[0])!
    r.leases.grant('bp-1', FOLDER, other)
    r.move('bp-1', tabId)
    expect(r.leases.isActive('bp-1', other)).toBe(true)
    expect(r.leases.isActive('bp-moved', r.host.viewToken('bp-moved')!)).toBe(false)
  })

  it('not carried: pause and network capture stay behind', () => {
    const { r, tabId } = setup()
    r.access.pause('bp-1', 60_000)
    r.host.readers('bp-1')!.startCapture({ maxMinutes: 5 })
    r.move('bp-1', tabId)
    expect(r.access.isPaused('bp-moved')).toBe(false)
    expect(r.host.captureStatus('bp-moved').active).toBe(false)
    expect(r.access.isPaused('bp-1')).toBe(true)
    expect(r.host.captureStatus('bp-1').active).toBe(true)
  })

  it('cap: an agent pane at the four-pane cap is refused PANE_LIMIT and nothing moves', () => {
    const { r, tabId } = setup('agent')
    for (let i = 2; i <= MAX_AGENT_PANES_PER_FOLDER; i++) r.addPane(`bp-${i}`, 'agent')
    expect(r.registry.agentPanesIn(FOLDER)).toHaveLength(MAX_AGENT_PANES_PER_FOLDER)
    expect(r.move('bp-1', tabId)).toEqual({ ok: false, error: 'PANE_LIMIT' })
    expect(r.registry.get('bp-moved')).toBeUndefined()
    expect(r.tabIds('bp-1')).toContain(tabId)
  })

  it('cap: an operator pane is never capped', () => {
    const { r, tabId } = setup('operator')
    for (let i = 2; i <= 6; i++) r.addPane(`bp-${i}`, 'operator')
    expect(r.move('bp-1', tabId).ok).toBe(true)
  })

  it('a lone tab does not move, and an unknown tab is TAB_NOT_FOUND', () => {
    const r = rig()
    const only = r.addPane('bp-1')
    expect(r.move('bp-1', only)).toEqual({ ok: false, error: 'BAD_ARGS' })
    newTab(r, 'bp-1')
    expect(r.move('bp-1', 'tab-00000000')).toEqual({ ok: false, error: 'TAB_NOT_FOUND' })
    expect(r.move('bp-nope', only)).toEqual({ ok: false, error: 'PANE_NOT_FOUND' })
  })
})

describe('creation hostView', () => {
  it('a tab is created with hostView page by default', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1')
    expect(r.tab('bp-1', t1).hostView).toBe('page')
    expect(r.tab('bp-1', t2).hostView).toBe('page')
  })

  it('a tab is created with hostView start when asked', () => {
    const r = rig()
    r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { url: 'about:blank', hostView: 'start' })
    expect(r.tab('bp-1', t2).hostView).toBe('start')
    expect(r.host.state('bp-1')!.tabs.find((t) => t.tabId === t2)!.hostView).toBe('start')
  })

  it('the pane persisted state keeps each tab hostView', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { url: 'about:blank', hostView: 'start' })
    const persisted = persistedTabsOf(r.host.state('bp-1')!.tabs)
    expect(persisted.map((t) => [t.tabId, t.hostView])).toEqual([
      [t1, 'page'],
      [t2, 'start']
    ])
  })
})

describe('pane state on tabs', () => {
  it('a new tab gets its pane emulation when it is created', () => {
    const r = rig()
    r.addPane('bp-1')
    r.registry.get('bp-1')!.emulation = { touch: true, userAgent: 'PaneUA/9' }
    const t2 = newTab(r, 'bp-1', { background: true })
    const cmds = r.wcOf('bp-1', t2).cmds as Array<{
      method: string
      params: { userAgent?: string }
    }>
    expect(
      cmds.some(
        (c) => c.method === 'Emulation.setUserAgentOverride' && c.params.userAgent === 'PaneUA/9'
      )
    ).toBe(true)
    expect(cmds.some((c) => c.method === 'Emulation.setTouchEmulationEnabled')).toBe(true)
  })

  it('a revived tab gets its pane emulation again', async () => {
    const r = rig()
    r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    await r.discardNow('bp-1', t2)
    r.registry.get('bp-1')!.emulation = { userAgent: 'Later/1' }
    await r.host.revive('bp-1', { tabId: t2 })
    const cmds = r.wcOf('bp-1', t2).cmds as Array<{
      method: string
      params: { userAgent?: string }
    }>
    expect(
      cmds.some(
        (c) => c.method === 'Emulation.setUserAgentOverride' && c.params.userAgent === 'Later/1'
      )
    ).toBe(true)
  })

  it('a new tab gets the zoom its page origin has, once the page is ready', () => {
    const r = rig({ zoomFor: (url) => (url.startsWith('https://b.test') ? 1.5 : 1) })
    r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { url: 'https://b.test/', background: true })
    const wc = r.wcOf('bp-1', t2)
    wc.emit('dom-ready')
    expect(wc.setZoomFactor).toHaveBeenCalledWith(1.5)
  })

  it('a revived tab gets the zoom it had when it was discarded', async () => {
    const r = rig()
    r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    r.wcOf('bp-1', t2).zoom = 1.25
    await r.discardNow('bp-1', t2)
    await r.host.revive('bp-1', { tabId: t2 })
    await Promise.resolve()
    expect(r.wcOf('bp-1', t2).setZoomFactor).toHaveBeenCalledWith(1.25)
  })

  it('verbs in flight are counted per tab and block only their own tab', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const t2 = newTab(r, 'bp-1', { background: true })
    const endA = r.registry.beginVerb('bp-1', t2)
    const endB = r.registry.beginVerb('bp-1')
    expect(r.registry.verbsInFlight('bp-1', t2)).toBe(1)
    // A call that names no tab is counted on the pane's active tab (t1).
    expect(r.registry.verbsInFlight('bp-1', t1)).toBe(1)
    expect(r.registry.verbsInFlight('bp-1')).toBe(2)
    endA()
    endB()
    expect(r.registry.verbsInFlight('bp-1')).toBe(0)
  })

  it('write and input bookkeeping stays per pane: a verb on any tab counts for its pane', () => {
    const r = rig()
    r.addPane('bp-1')
    newTab(r, 'bp-1', { background: true })
    const a = r.registry.beginWrite('bp-1')
    const b = r.registry.beginWrite('bp-1')
    expect(r.registry.endWrite(a).othersWrote).toBe(true)
    expect(r.registry.endWrite(b).othersWrote).toBe(true)
    r.registry.beginAgentInput('bp-1')
    expect(r.registry.agentInput('bp-1').inFlight).toBe(true)
    r.registry.endAgentInput('bp-1')
    r.registry.noteOperatorInteraction('bp-1')
    expect(r.registry.operatorInteractionAt('bp-1')).toBe(r.now())
  })
})
