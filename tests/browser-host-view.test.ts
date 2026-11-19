/**
 * Browser tabs, the host placeholder (browser-tabs spec S-3, AC-9, AC-37, AC-44): main owns each tab's `hostView`
 * (`page`, `start` or `error`); while the ACTIVE tab is `start` or `error` its native view is hidden and the pane
 * chrome draws the matching component in the host `<div>`. The real `BrowserViewHost`, registry and restore plan run
 * over a fake Electron; the renderer half mounts the real components.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  type Fn = (...a: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
  let nextWcId = 700
  const views: any[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any

  class FakeWebContents {
    id = nextWcId++
    url = ''
    destroyed = false
    zoom = 1
    attached = false
    listeners = new Map<string, Fn[]>()
    loads: string[] = []
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    debugger = {
      isAttached: () => this.attached,
      attach: () => {
        this.attached = true
      },
      detach: () => {
        this.attached = false
      },
      on: () => undefined,
      sendCommand: async () => ({})
    }
    getUserAgent = () => 'FakeUA/1.0'
    isDestroyed = () => this.destroyed
    getURL = () => this.url
    getTitle = () => ''
    isLoading = () => false
    getZoomFactor = () => this.zoom
    setZoomFactor = (f: number) => void (this.zoom = f)
    setWindowOpenHandler = () => undefined
    executeJavaScript = async () => ({ x: 0, y: 0 })
    reload = vi.fn()
    close = () => void (this.destroyed = true)
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
    off(ev: string, fn: Fn): this {
      return this.removeListener(ev, fn)
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
  }
  class FakeView {
    webContents = new FakeWebContents()
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
  return { views, win, FakeView }
})

vi.mock('electron', () => ({
  app: { commandLine: { getSwitchValue: () => '' } },
  BrowserWindow: class {},
  WebContentsView: h.FakeView,
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
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
import { restorePane } from '../src/main/browser/restore-plan'
import { BrowserViewHost } from '../src/main/browser/view-host'
import { hostPlaceholderOf, type BrowserTabState } from '../src/shared/browser-tabs'

const FOLDER = '/work/acme-store'
const RECT = { x: 0, y: 0, width: 800, height: 600 }
const T1 = 'tab-00000001'
const T2 = 'tab-00000002'

function rig() {
  const clock = 5_000_000
  const registry = createBrowserRegistry(() => clock)
  const access = createBrowserAccess(() => clock)
  const host = new BrowserViewHost({
    getWindow: () => h.win as never,
    guestPreloadPath: '/x/browser-guest.js',
    registry,
    access,
    now: () => clock,
    harnuPorts: () => [],
    trustedHosts: () => [],
    readOptIn: () => false,
    leaseActive: () => false,
    scrub: (t) => t,
    openPopupPane: vi.fn(),
    prefs: { zoomFor: () => 1, setZoom: vi.fn() }
  })
  const addPane = (paneId: string, openedBy: 'operator' | 'agent' = 'operator'): string => {
    registry.add({
      paneId,
      folder: FOLDER,
      name: 'browser',
      openedBy,
      partition: openedBy,
      ownerSessionId: openedBy === 'agent' ? '8eb88caa-c60a-4791-abff-b0165260a260' : null,
      createdAt: clock,
      lastActiveAt: clock,
      seenHosts: new Set<string>(),
      flagged: null
    } as never)
    host.create({ paneId, folder: FOLDER, partition: openedBy, url: 'https://a.test/' })
    host.applyBounds(paneId, RECT, true)
    return registry.get(paneId)!.activeTabId
  }
  const newTab = (paneId: string, o: Record<string, unknown> = {}): string => {
    const res = host.newTab(paneId, { url: 'https://b.test/', ...o })
    if (!res.ok) throw new Error(`newTab refused: ${res.error}`)
    host.applyBounds(paneId, RECT, true)
    return res.tabId
  }
  const wcOf = (paneId: string, tabId?: string) => host.webContentsOf(paneId, tabId) as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const viewOf = (paneId: string, tabId?: string) =>
    h.views.find((v) => v.webContents === wcOf(paneId, tabId))
  const tabState = (paneId: string, tabId: string): BrowserTabState =>
    host.state(paneId)!.tabs.find((t) => t.tabId === tabId)!
  return { registry, host, addPane, newTab, wcOf, viewOf, tabState }
}

beforeEach(() => {
  h.views.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('start transitions', () => {
  it('a tab created with hostView start hides its view and shows the start placeholder', () => {
    const r = rig()
    r.addPane('bp-1')
    const t2 = r.newTab('bp-1', { hostView: 'start' })
    expect(r.tabState('bp-1', t2).hostView).toBe('start')
    expect(hostPlaceholderOf(r.tabState('bp-1', t2))).toBe('start')
    expect(r.viewOf('bp-1', t2).getVisible()).toBe(false)
  })

  it('a tab created without it stays page while loading about:blank, and its view shows', () => {
    const r = rig()
    r.addPane('bp-1')
    const t2 = r.newTab('bp-1', { url: 'about:blank' })
    expect(r.tabState('bp-1', t2).hostView).toBe('page')
    expect(hostPlaceholderOf(r.tabState('bp-1', t2))).toBe('none')
    expect(r.viewOf('bp-1', t2).getVisible()).toBe(true)
    // Its own about:blank commit changes nothing.
    r.wcOf('bp-1', t2).emit('did-navigate', {}, 'about:blank')
    expect(r.tabState('bp-1', t2).hostView).toBe('page')
  })

  it('an agent pane never shows start', () => {
    const r = rig()
    r.addPane('bp-9', 'agent')
    const t2 = r.newTab('bp-9', { hostView: 'start' })
    expect(r.tabState('bp-9', t2).hostView).toBe('page')
    expect(r.viewOf('bp-9', t2).getVisible()).toBe(true)
  })

  it('the start tab own about:blank commit keeps it start; the first real commit sets page and shows the view', () => {
    const r = rig()
    r.addPane('bp-1')
    const t2 = r.newTab('bp-1', { hostView: 'start' })
    r.wcOf('bp-1', t2).emit('did-navigate', {}, 'about:blank')
    expect(r.tabState('bp-1', t2).hostView).toBe('start')
    expect(r.viewOf('bp-1', t2).getVisible()).toBe(false)
    r.wcOf('bp-1', t2).emit('did-navigate', {}, 'http://localhost:5173/')
    expect(r.tabState('bp-1', t2).hostView).toBe('page')
    expect(r.viewOf('bp-1', t2).getVisible()).toBe(true)
  })

  it('only the active tab matters: a start tab in the background changes nothing on screen', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const t2 = r.newTab('bp-1', { hostView: 'start', background: true })
    expect(r.registry.get('bp-1')!.activeTabId).toBe(t1)
    expect(hostPlaceholderOf(r.tabState('bp-1', t1))).toBe('none')
    expect(r.tabState('bp-1', t2).hostView).toBe('start')
    // Activating it hides its view and shows the placeholder.
    r.host.activateTab('bp-1', t2)
    r.host.applyBounds('bp-1', RECT, true)
    expect(r.viewOf('bp-1', t2).getVisible()).toBe(false)
    expect(r.viewOf('bp-1', t1).getVisible()).toBe(true)
  })
})

describe('a pane opened with no address (browser-tabs S-5, AC-24)', () => {
  const open = (
    r: ReturnType<typeof rig>,
    paneId: string,
    openedBy: 'operator' | 'agent',
    url: string
  ) => {
    r.registry.add({
      paneId,
      folder: FOLDER,
      name: 'browser',
      openedBy,
      partition: openedBy,
      ownerSessionId: null,
      createdAt: 1,
      lastActiveAt: 1,
      seenHosts: new Set<string>(),
      flagged: null
    } as never)
    r.host.create({ paneId, folder: FOLDER, partition: openedBy, url })
    r.host.applyBounds(paneId, RECT, true)
    return r.registry.get(paneId)!.activeTabId
  }

  it('an operator pane opened with no address starts on the start page', () => {
    const r = rig()
    const t = open(r, 'bp-1', 'operator', 'about:blank')
    expect(r.tabState('bp-1', t).hostView).toBe('start')
    expect(hostPlaceholderOf(r.tabState('bp-1', t))).toBe('start')
    expect(r.viewOf('bp-1', t).getVisible()).toBe(false)
  })

  it('an operator pane opened with an address is a page; an agent pane with none is a page too', () => {
    const r = rig()
    const t1 = open(r, 'bp-1', 'operator', 'https://a.test/')
    expect(r.tabState('bp-1', t1).hostView).toBe('page')
    const t2 = open(r, 'bp-2', 'agent', 'about:blank')
    expect(r.tabState('bp-2', t2).hostView).toBe('page')
    expect(r.viewOf('bp-2', t2).getVisible()).toBe(true)
  })
})

describe('restore placeholders', () => {
  const restored = (tabs: unknown[], activeTabId: string, openedBy = 'operator') => {
    const r = rig()
    const rec = restorePane(
      {
        id: 'bp-1',
        type: 'browser',
        worktreePath: FOLDER,
        payload: { url: 'https://two.test/', openedBy, partition: openedBy, tabs, activeTabId }
      },
      10
    )!
    r.registry.add(rec.rec)
    r.host.restoreDiscarded('bp-1')
    return r
  }

  it('after a restart a start-page tab shows the start page (its view stays hidden)', async () => {
    const r = restored(
      [
        { tabId: T1, url: 'about:blank', title: '', hostView: 'start' },
        { tabId: T2, url: 'https://two.test/', title: 'Two', hostView: 'page' }
      ],
      T1
    )
    expect(r.registry.get('bp-1')!.tabs[0]!.hostView).toBe('start')
    expect(hostPlaceholderOf(r.tabState('bp-1', T1))).toBe('start')
    r.host.applyBounds('bp-1', RECT, true)
    await vi.waitFor(() => expect(h.views).toHaveLength(1))
    expect(r.viewOf('bp-1', T1).getVisible()).toBe(false)
    expect(r.tabState('bp-1', T1).hostView).toBe('start')
  })

  it('after a restart an error tab reloads its address as a page', async () => {
    const r = restored(
      [{ tabId: T1, url: 'http://localhost:3000/', title: 'Oops', hostView: 'error' }],
      T1
    )
    r.host.applyBounds('bp-1', RECT, true)
    await vi.waitFor(() => expect(h.views).toHaveLength(1))
    expect(h.views[0].webContents.loads).toEqual(['http://localhost:3000/'])
    expect(r.tabState('bp-1', T1).hostView).toBe('page')
    expect(r.tabState('bp-1', T1).loadError).toBeUndefined()
    expect(h.views[0].getVisible()).toBe(true)
  })

  it('an agent pane restores a persisted start tab as a page', () => {
    const r = restored(
      [{ tabId: T1, url: 'about:blank', title: '', hostView: 'start' }],
      T1,
      'agent'
    )
    expect(r.registry.get('bp-1')!.tabs[0]!.hostView).toBe('page')
  })
})

describe('renderer placeholders', () => {
  const tab = (over: Partial<BrowserTabState> = {}): BrowserTabState => ({
    tabId: T1,
    url: '',
    title: '',
    favicon: null,
    loading: false,
    hostView: 'page',
    waitingForUp: false,
    discarded: false,
    active: true,
    agentActive: false,
    ...over
  })

  it('hostPlaceholderOf names what the host draws for the active tab', () => {
    expect(hostPlaceholderOf(tab())).toBe('none')
    expect(hostPlaceholderOf(tab({ hostView: 'start' }))).toBe('start')
    expect(
      hostPlaceholderOf(
        tab({
          hostView: 'error',
          loadError: {
            code: 'ERR_CONNECTION_REFUSED',
            url: 'http://localhost:8000/',
            host: 'localhost:8000',
            port: 8000,
            local: true
          }
        })
      )
    ).toBe('error')
    // An error tab with no error record has nothing to draw.
    expect(hostPlaceholderOf(tab({ hostView: 'error' }))).toBe('none')
    expect(hostPlaceholderOf(undefined)).toBe('none')
  })

  it('BrowserLoadError draws the title, hint, code and Reload; the waiting label while waitingForUp', async () => {
    const { mount } = await import('@vue/test-utils')
    const { i18n } = await import('../src/renderer/src/i18n')
    const BrowserLoadError = (await import('../src/renderer/src/components/BrowserLoadError.vue'))
      .default
    const loadError = {
      code: 'ERR_CONNECTION_REFUSED',
      url: 'http://localhost:8000/',
      host: 'localhost:8000',
      port: 8000,
      local: true
    }
    const w = mount(BrowserLoadError, {
      props: { loadError, waitingForUp: false },
      global: { plugins: [i18n] }
    })
    const text = (id: string): string => w.get(`[data-testid="${id}"]`).text()
    expect(text('browser-load-error-title')).toBe('localhost:8000 refused to connect')
    expect(text('browser-load-error-hint')).toBe(
      'Nothing is answering on port 8000. Start the server, then reload.'
    )
    expect(text('browser-load-error-code')).toBe('ERR_CONNECTION_REFUSED')
    expect(text('browser-load-error-reload')).toBe('Reload')
    expect(text('browser-load-error-when-up')).toBe('Reload when it is up')
    await w.setProps({ waitingForUp: true })
    expect(text('browser-load-error-when-up')).toBe('Waiting for localhost:8000…')
    await w.get('[data-testid="browser-load-error-when-up"]').trigger('click')
    expect(w.emitted('reloadWhenUp')?.at(-1)).toEqual([false])
    await w.get('[data-testid="browser-load-error-reload"]').trigger('click')
    expect(w.emitted('reload')).toHaveLength(1)
    w.unmount()
  })

  it('on an external origin there is no Reload when it is up', async () => {
    const { mount } = await import('@vue/test-utils')
    const { i18n } = await import('../src/renderer/src/i18n')
    const BrowserLoadError = (await import('../src/renderer/src/components/BrowserLoadError.vue'))
      .default
    const w = mount(BrowserLoadError, {
      props: {
        loadError: {
          code: 'ERR_NAME_NOT_RESOLVED',
          url: 'https://exmaple.com/',
          host: 'exmaple.com',
          port: 443,
          local: false
        },
        waitingForUp: false
      },
      global: { plugins: [i18n] }
    })
    expect(w.find('[data-testid="browser-load-error-when-up"]').exists()).toBe(false)
    expect(w.get('[data-testid="browser-load-error-title"]').text()).toBe(
      "exmaple.com's address could not be found"
    )
    w.unmount()
  })
})

describe('renderer placeholders: the pane host', () => {
  const T = 'tab-0000000a'
  const baseState = (over: Record<string, unknown>) => ({
    paneId: 'bp-ui',
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    origin: 'blank',
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
    activeTabId: T,
    lastFocusedAt: null,
    ...over
  })
  const tabRow = (over: Record<string, unknown>) => ({
    tabId: T,
    url: '',
    title: '',
    favicon: null,
    loading: false,
    hostView: 'page',
    waitingForUp: false,
    discarded: false,
    active: true,
    agentActive: false,
    ...over
  })

  async function mountPane(state: Record<string, unknown>) {
    const { createPinia, setActivePinia } = await import('pinia')
    const { mount, flushPromises } = await import('@vue/test-utils')
    const { i18n } = await import('../src/renderer/src/i18n')
    const BrowserPane = (await import('../src/renderer/src/components/BrowserPane.vue')).default
    const { useBrowserStore } = await import('../src/renderer/src/stores/browser')
    const calls: unknown[][] = []
    const g = globalThis as unknown as { window: { api: unknown }; ResizeObserver: unknown }
    g.window.api = new Proxy(
      {},
      {
        get:
          (_t, name: string) =>
          (...args: unknown[]) => {
            calls.push([name, ...args])
            if (name === 'browserTabReload' || name === 'browserTabReloadWhenUp')
              return Promise.resolve({ ok: true })
            if (name === 'browserState') return Promise.resolve(null)
            return name.startsWith('on') ? () => undefined : Promise.resolve(null)
          }
      }
    )
    g.ResizeObserver = class {
      observe(): void {
        /* the fake pane never resizes */
      }
      disconnect(): void {
        /* nothing to release */
      }
    }
    const pinia = createPinia()
    setActivePinia(pinia)
    const browser = useBrowserStore()
    browser.states = { 'bp-ui': state as never }
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
    return { w, browser, calls, flushPromises }
  }

  it('a start tab draws the start page on the bg host and the address field has the focus', async () => {
    const { w } = await mountPane(
      baseState({ tabs: [tabRow({ hostView: 'start', url: 'about:blank' })] })
    )
    const host = w.get('[data-testid="browser-start-placeholder"]')
    // S-3 drew an empty host here; S-5 puts the start page in it (tests/browser-start-page.test.ts).
    expect(host.find('[data-testid="browser-start-page"]').exists()).toBe(true)
    expect(host.classes()).toContain('bg-bg')
    expect(w.find('[data-testid="browser-load-error"]').exists()).toBe(false)
    const input = document.activeElement as HTMLElement | null
    expect(input?.tagName).toBe('INPUT')
    w.unmount()
  })

  it('a single start tab titles its header "New tab", not the blank page it holds', async () => {
    const { w } = await mountPane(
      baseState({
        title: 'about:blank',
        tabs: [tabRow({ hostView: 'start', url: 'about:blank', title: 'about:blank' })]
      })
    )
    expect(w.get('[data-testid="browser-title"]').text()).toBe('New tab')
    w.unmount()
  })

  it('a page tab draws neither placeholder', async () => {
    const { w } = await mountPane(baseState({ tabs: [tabRow({ url: 'https://a.test/' })] }))
    expect(w.find('[data-testid="browser-start-placeholder"]').exists()).toBe(false)
    expect(w.find('[data-testid="browser-load-error"]').exists()).toBe(false)
    w.unmount()
  })

  it('an error tab draws the error component from loadError; Reload and Reload when it is up reach main', async () => {
    const loadError = {
      code: 'ERR_CONNECTION_REFUSED',
      url: 'http://localhost:8000/',
      host: 'localhost:8000',
      port: 8000,
      local: true
    }
    const { w, calls, browser, flushPromises } = await mountPane(
      baseState({
        url: 'http://localhost:8000/',
        origin: 'local',
        tabs: [tabRow({ hostView: 'error', url: 'http://localhost:8000/', loadError })]
      })
    )
    expect(w.get('[data-testid="browser-load-error-title"]').text()).toBe(
      'localhost:8000 refused to connect'
    )
    await w.get('[data-testid="browser-load-error-reload"]').trigger('click')
    expect(calls).toContainEqual(['browserTabReload', 'bp-ui', T])
    await w.get('[data-testid="browser-load-error-when-up"]').trigger('click')
    expect(calls).toContainEqual(['browserTabReloadWhenUp', 'bp-ui', T, true])
    // Main reports the poll: the button reads the waiting label, and a second click cancels it.
    browser.states = {
      'bp-ui': baseState({
        url: 'http://localhost:8000/',
        origin: 'local',
        tabs: [
          tabRow({
            hostView: 'error',
            url: 'http://localhost:8000/',
            loadError,
            waitingForUp: true
          })
        ]
      }) as never
    }
    await flushPromises()
    expect(w.get('[data-testid="browser-load-error-when-up"]').text()).toBe(
      'Waiting for localhost:8000…'
    )
    await w.get('[data-testid="browser-load-error-when-up"]').trigger('click')
    expect(calls).toContainEqual(['browserTabReloadWhenUp', 'bp-ui', T, false])
    w.unmount()
  })
})
