/**
 * Browser tabs, the load error page (browser-tabs spec S-3, AC-10, AC-11): a failed main-frame load sets the tab's
 * `hostView` to `error` and hides its view; the title and hint come from one table keyed by the code; the next commit
 * clears it; reads on an error tab answer `loadError`; "Reload when it is up" polls a local origin every 2 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  type Fn = (...a: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
  let nextWcId = 900
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
import {
  RELOAD_WHEN_UP_MAX_MS,
  RELOAD_WHEN_UP_POLL_MS,
  buildLoadError,
  createReloadWhenUp
} from '../src/main/browser/load-error'
import { createPaneReaders } from '../src/main/browser/pane-readers'
import { createBrowserRegistry } from '../src/main/browser/registry'
import {
  consoleVerb,
  screenshotVerb,
  snapshotVerb,
  waitForVerb,
  type BrowserReadDeps,
  type BrowserReadHost
} from '../src/main/browser/read-verbs'
import { BrowserViewHost } from '../src/main/browser/view-host'
import { loadErrorKind, loadErrorTarget } from '../src/shared/browser-tabs'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

const FOLDER = '/work/acme-store'
const RECT = { x: 0, y: 0, width: 800, height: 600 }
const REFUSED = -102
const ABORTED = -3

function rig(probe: (host: string, port: number) => Promise<boolean> = async () => false) {
  const clock = 5_000_000
  const registry = createBrowserRegistry(() => clock)
  const access = createBrowserAccess(() => clock)
  const host = new BrowserViewHost({
    getWindow: () => h.win as never,
    guestPreloadPath: '/x/browser-guest.js',
    registry,
    access,
    now: () => Date.now(),
    harnuPorts: () => [],
    trustedHosts: () => [],
    readOptIn: () => false,
    leaseActive: () => false,
    scrub: (t) => t,
    openPopupPane: vi.fn(),
    prefs: { zoomFor: () => 1, setZoom: vi.fn() },
    tcpProbe: probe
  })
  const addPane = (paneId: string, url = 'http://localhost:8000/'): string => {
    registry.add({
      paneId,
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
    host.create({ paneId, folder: FOLDER, partition: 'operator', url })
    host.applyBounds(paneId, RECT, true)
    return registry.get(paneId)!.activeTabId
  }
  const wc = (paneId: string, tabId?: string) => host.webContentsOf(paneId, tabId) as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const view = (paneId: string, tabId?: string) =>
    h.views.find((v) => v.webContents === wc(paneId, tabId))
  const fail = (
    paneId: string,
    code: number,
    desc: string,
    url: string,
    mainFrame = true,
    tabId?: string
  ): void => wc(paneId, tabId).emit('did-fail-load', {}, code, desc, url, mainFrame)
  const tab = (paneId: string, tabId: string) =>
    host.state(paneId)!.tabs.find((t) => t.tabId === tabId)!
  return { registry, host, addPane, wc, view, fail, tab }
}

beforeEach(() => {
  h.views.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('shows and clears', () => {
  it('a main-frame failure sets error, hides the view and carries the code, address, host and port', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    expect(r.view('bp-1').getVisible()).toBe(true)
    r.fail('bp-1', REFUSED, 'ERR_CONNECTION_REFUSED', 'http://localhost:8000/')
    expect(r.registry.get('bp-1')!.tabs[0]!.hostView).toBe('error')
    expect(r.tab('bp-1', t1)).toMatchObject({
      hostView: 'error',
      waitingForUp: false,
      loadError: {
        code: 'ERR_CONNECTION_REFUSED',
        url: 'http://localhost:8000/',
        host: 'localhost:8000',
        port: 8000,
        local: true
      }
    })
    expect(r.view('bp-1').getVisible()).toBe(false)
  })

  it('an external origin is not local, and its port is the scheme default', () => {
    const r = rig()
    const t1 = r.addPane('bp-1', 'https://example.test/')
    r.fail('bp-1', -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.test/')
    expect(r.tab('bp-1', t1).loadError).toMatchObject({
      code: 'ERR_NAME_NOT_RESOLVED',
      host: 'example.test',
      port: 443,
      local: false
    })
  })

  it('ERR_ABORTED and a subframe failure do not set it', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    r.fail('bp-1', ABORTED, 'ERR_ABORTED', 'http://localhost:8000/')
    r.fail('bp-1', REFUSED, 'ERR_CONNECTION_REFUSED', 'http://localhost:9999/x.js', false)
    expect(r.tab('bp-1', t1).hostView).toBe('page')
    expect(r.tab('bp-1', t1).loadError).toBeUndefined()
    expect(r.view('bp-1').getVisible()).toBe(true)
  })

  it('the next commit clears it and shows the view again', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    r.fail('bp-1', REFUSED, 'ERR_CONNECTION_REFUSED', 'http://localhost:8000/')
    r.wc('bp-1').emit('did-navigate', {}, 'http://localhost:3000/')
    expect(r.tab('bp-1', t1)).toMatchObject({ hostView: 'page' })
    expect(r.tab('bp-1', t1).loadError).toBeUndefined()
    expect(r.view('bp-1').getVisible()).toBe(true)
  })

  it('the error page commit itself does not clear it', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    r.fail('bp-1', REFUSED, 'ERR_CONNECTION_REFUSED', 'http://localhost:8000/')
    r.wc('bp-1').emit('did-navigate', {}, 'chrome-error://chromewebdata/')
    expect(r.tab('bp-1', t1).hostView).toBe('error')
    expect(r.view('bp-1').getVisible()).toBe(false)
  })

  it('the address stays the one that failed while the error shows', () => {
    const r = rig()
    r.addPane('bp-1')
    r.wc('bp-1').url = 'chrome-error://chromewebdata/'
    r.fail('bp-1', REFUSED, 'ERR_CONNECTION_REFUSED', 'http://localhost:8000/')
    expect(r.host.state('bp-1')!.url).toBe('http://localhost:8000/')
  })

  it('only the active tab hides its view: a failure in a background tab keeps the page on screen', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const added = r.host.newTab('bp-1', { url: 'http://localhost:7000/', background: true })
    if (!added.ok) throw new Error('newTab refused')
    r.fail('bp-1', REFUSED, 'ERR_CONNECTION_REFUSED', 'http://localhost:7000/', true, added.tabId)
    expect(r.tab('bp-1', added.tabId).hostView).toBe('error')
    expect(r.tab('bp-1', t1).hostView).toBe('page')
    expect(r.view('bp-1', t1).getVisible()).toBe(true)
  })
})

describe('shows and clears: reads on an error tab', () => {
  function readRig(loadError: { code: string; url: string } | undefined) {
    const clock = 1_000
    const registry = createBrowserRegistry(() => clock)
    const access = createBrowserAccess(() => clock)
    const readers = createPaneReaders({
      now: () => clock,
      send: async () => undefined,
      scrub: (t) => t,
      setTimer: () => 0,
      clearTimer: () => undefined,
      onCaptureChange: () => undefined
    })
    const cdp = vi.fn(async () => ({ nodes: [] }))
    const capture = vi.fn(async () => ({
      data: new Uint8Array([1]),
      mime: 'image/png' as const,
      width: 1,
      height: 1,
      clamped: false
    }))
    const host: BrowserReadHost = {
      create: vi.fn(),
      info: () => ({
        url: 'http://localhost:8000/',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false
      }),
      navigate: vi.fn(),
      destroy: vi.fn(),
      publishFlag: vi.fn(),
      readers: () => readers,
      cdp,
      viewMode: () => 'visible',
      deviceMode: () => false,
      capture,
      loadErrorOf: () => loadError
    }
    const deps: BrowserReadDeps = {
      now: () => clock,
      newPaneId: () => 'bp-x',
      registry,
      access,
      host,
      writesEnabled: async () => true,
      trustedHosts: () => [],
      harnuPorts: () => [],
      sessionKnown: () => true,
      showPane: vi.fn(async () => true),
      hidePane: vi.fn(async () => true),
      scrub: (t) => t,
      alias: (f) => f,
      folderBlocked: () => false,
      sleep: async () => undefined,
      saveShot: vi.fn(async () => '.harnu/out/browser/shots/s.png')
    }
    registry.add({
      paneId: 'bp-1',
      folder: FOLDER,
      name: 'app',
      openedBy: 'agent',
      partition: 'agent',
      ownerSessionId: null,
      createdAt: 1,
      lastActiveAt: 1,
      seenHosts: new Set(),
      flagged: null
    } as never)
    return { deps, cdp, capture }
  }
  const err = { code: 'ERR_CONNECTION_REFUSED', url: 'http://localhost:8000/' }

  it('snapshot, console and wait_for return ok with loadError and an empty page', async () => {
    const { deps, cdp } = readRig(err)
    const snap = await snapshotVerb({ paneId: 'bp-1' }, deps)
    expect(snap).toMatchObject({ ok: true, loadError: err, text: '', nodes: 0 })
    const con = await consoleVerb({ paneId: 'bp-1' }, deps)
    expect(con).toMatchObject({ ok: true, loadError: err })
    const wait = await waitForVerb({ paneId: 'bp-1', text: 'hello' }, deps)
    expect(wait).toMatchObject({ ok: true, loadError: err })
    // Nothing reached the hidden error page.
    expect(cdp).not.toHaveBeenCalled()
  })

  it('screenshot returns loadError and no image', async () => {
    const { deps, capture } = readRig(err)
    const shot = await screenshotVerb({ paneId: 'bp-1' }, deps)
    expect(shot).toMatchObject({ ok: true, loadError: err })
    expect(shot).not.toHaveProperty('image')
    expect(shot).not.toHaveProperty('path')
    expect(capture).not.toHaveBeenCalled()
  })

  it('a tab with no error reads as before', async () => {
    const { deps } = readRig(undefined)
    const snap = await snapshotVerb({ paneId: 'bp-1' }, deps)
    expect(snap).not.toHaveProperty('loadError')
  })

  it('the view host answers loadErrorOf for an error tab only', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    expect(r.host.loadErrorOf('bp-1')).toBeUndefined()
    r.fail('bp-1', REFUSED, 'ERR_CONNECTION_REFUSED', 'http://localhost:8000/')
    expect(r.host.loadErrorOf('bp-1')).toEqual({
      code: 'ERR_CONNECTION_REFUSED',
      url: 'http://localhost:8000/'
    })
    expect(r.host.loadErrorOf('bp-1', t1)).toBeDefined()
  })
})

describe('the title and hint table', () => {
  const T = en.browserPane.loadError as Record<string, Record<string, string> | string>
  const text = (code: string, local: boolean, host = 'localhost:8000', port = 8000): string[] => {
    const kind = loadErrorKind(code, local)
    const row = T[kind] as Record<string, string>
    return [
      row.title!.replace('{host}', host).replace('{port}', String(port)),
      row.hint!.replace('{host}', host).replace('{port}', String(port))
    ]
  }

  it('picks the row by code and origin, as the spec table says', () => {
    expect(loadErrorKind('ERR_CONNECTION_REFUSED', true)).toBe('refusedLocal')
    expect(loadErrorKind('ERR_CONNECTION_REFUSED', false)).toBe('refused')
    expect(loadErrorKind('ERR_CONNECTION_RESET', true)).toBe('refused')
    expect(loadErrorKind('ERR_CONNECTION_RESET', false)).toBe('refused')
    expect(loadErrorKind('ERR_NAME_NOT_RESOLVED', false)).toBe('notFound')
    expect(loadErrorKind('ERR_CONNECTION_TIMED_OUT', false)).toBe('timeout')
    expect(loadErrorKind('ERR_TIMED_OUT', true)).toBe('timeout')
    expect(loadErrorKind('ERR_INTERNET_DISCONNECTED', false)).toBe('offline')
    expect(loadErrorKind('ERR_CERT_AUTHORITY_INVALID', false)).toBe('cert')
    expect(loadErrorKind('ERR_CERT_DATE_INVALID', true)).toBe('cert')
    expect(loadErrorKind('ERR_SOMETHING_ELSE', false)).toBe('other')
  })

  it('says what the spec table says for each row', () => {
    expect(text('ERR_CONNECTION_REFUSED', true)).toEqual([
      'localhost:8000 refused to connect',
      'Nothing is answering on port 8000. Start the server, then reload.'
    ])
    expect(text('ERR_CONNECTION_RESET', false, 'example.test', 443)).toEqual([
      'example.test refused to connect',
      'The site may be down. Try again in a moment.'
    ])
    expect(text('ERR_NAME_NOT_RESOLVED', false, 'exmaple.com', 443)).toEqual([
      "exmaple.com's address could not be found",
      'Check the address for a typo.'
    ])
    expect(text('ERR_TIMED_OUT', false, 'slow.test', 443)).toEqual([
      'slow.test took too long to respond',
      'The site may be slow or unreachable from this network.'
    ])
    expect(text('ERR_INTERNET_DISCONNECTED', false, 'x.test', 443)).toEqual([
      'No internet connection',
      'Check your connection, then reload.'
    ])
    expect(text('ERR_CERT_COMMON_NAME_INVALID', false, 'x.test', 443)).toEqual([
      'The connection to x.test is not secure',
      'Its certificate was not accepted, so the page was not loaded.'
    ])
    expect(text('ERR_WEIRD', false, 'x.test', 443)).toEqual([
      'x.test could not be loaded',
      'The page failed to load.'
    ])
  })

  it('pt-BR has every key en has (the schema parity the build checks)', () => {
    const keys = (o: object): string[] => Object.keys(o).sort()
    expect(keys(ptBR.browserPane.loadError)).toEqual(keys(en.browserPane.loadError))
    for (const kind of [
      'refusedLocal',
      'refused',
      'notFound',
      'timeout',
      'offline',
      'cert',
      'other'
    ]) {
      const row = (ptBR.browserPane.loadError as Record<string, Record<string, string>>)[kind]!
      expect(row.title && row.hint).toBeTruthy()
    }
  })

  it('buildLoadError reads host and port from the address; the port defaults by scheme', () => {
    expect(buildLoadError('ERR_CONNECTION_REFUSED', 'http://localhost:8000/x?y=1', true)).toEqual({
      code: 'ERR_CONNECTION_REFUSED',
      url: 'http://localhost:8000/x',
      host: 'localhost:8000',
      port: 8000,
      local: true
    })
    expect(buildLoadError('ERR_X', 'http://dev.test/', true).port).toBe(80)
    expect(buildLoadError('ERR_X', 'https://dev.test/', false).port).toBe(443)
    expect(buildLoadError('ERR_X', 'not a url', false)).toMatchObject({ host: '', port: null })
  })

  it('the waiting label names host and port', () => {
    expect(
      loadErrorTarget({
        code: 'E',
        url: 'http://localhost:8000/',
        host: 'localhost:8000',
        port: 8000,
        local: true
      })
    ).toBe('localhost:8000')
    expect(
      loadErrorTarget({
        code: 'E',
        url: 'http://dev.test/',
        host: 'dev.test',
        port: 80,
        local: true
      })
    ).toBe('dev.test:80')
  })
})

describe('reload when it is up', () => {
  function poller(results: boolean[]) {
    let t = 0
    const timers: Array<{ at: number; fn: () => void; id: number }> = []
    let id = 0
    const probe = vi.fn(async () => results.shift() ?? false)
    const up = vi.fn()
    const stopped = vi.fn()
    const w = createReloadWhenUp({
      probe,
      setTimer: (fn, ms) => {
        timers.push({ at: t + ms, fn, id: ++id })
        return id
      },
      clearTimer: (handle) => {
        const i = timers.findIndex((x) => x.id === handle)
        if (i >= 0) timers.splice(i, 1)
      },
      now: () => t
    })
    const advance = async (ms: number): Promise<void> => {
      const end = t + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift()
        t = next.at
        next.fn()
        await Promise.resolve()
        await Promise.resolve()
      }
      t = end
    }
    return { w, probe, up, stopped, advance }
  }
  const target = { host: 'localhost', port: 8000 }

  it('the spec numbers: a poll every 2 s, given up after 10 min', () => {
    expect(RELOAD_WHEN_UP_POLL_MS).toBe(2000)
    expect(RELOAD_WHEN_UP_MAX_MS).toBe(600_000)
  })

  it('polls every 2 s and reloads on the first success, once', async () => {
    const p = poller([false, false, true, true])
    expect(p.w.start('t1', target, { onUp: p.up, onStop: p.stopped })).toBe(true)
    expect(p.w.isWaiting('t1')).toBe(true)
    await p.advance(RELOAD_WHEN_UP_POLL_MS - 1)
    expect(p.probe).not.toHaveBeenCalled()
    await p.advance(1)
    expect(p.probe).toHaveBeenCalledTimes(1)
    await p.advance(RELOAD_WHEN_UP_POLL_MS * 2)
    expect(p.probe).toHaveBeenCalledTimes(3)
    expect(p.probe).toHaveBeenCalledWith('localhost', 8000)
    expect(p.up).toHaveBeenCalledTimes(1)
    expect(p.w.isWaiting('t1')).toBe(false)
    await p.advance(RELOAD_WHEN_UP_POLL_MS * 5)
    expect(p.probe).toHaveBeenCalledTimes(3)
  })

  it('stops after 10 minutes without reloading', async () => {
    const p = poller([])
    p.w.start('t1', target, { onUp: p.up, onStop: p.stopped })
    await p.advance(RELOAD_WHEN_UP_MAX_MS - 1)
    expect(p.w.isWaiting('t1')).toBe(true)
    await p.advance(RELOAD_WHEN_UP_POLL_MS + 1)
    expect(p.w.isWaiting('t1')).toBe(false)
    expect(p.up).not.toHaveBeenCalled()
    expect(p.stopped).toHaveBeenCalledTimes(1)
    const polled = p.probe.mock.calls.length
    await p.advance(RELOAD_WHEN_UP_POLL_MS * 10)
    expect(p.probe).toHaveBeenCalledTimes(polled)
  })

  it('stops on cancel (navigation, close or a second click) and says so once', async () => {
    const p = poller([false, true])
    p.w.start('t1', target, { onUp: p.up, onStop: p.stopped })
    await p.advance(RELOAD_WHEN_UP_POLL_MS)
    p.w.cancel('t1')
    expect(p.w.isWaiting('t1')).toBe(false)
    expect(p.stopped).toHaveBeenCalledTimes(1)
    p.w.cancel('t1')
    expect(p.stopped).toHaveBeenCalledTimes(1)
    await p.advance(RELOAD_WHEN_UP_POLL_MS * 5)
    expect(p.up).not.toHaveBeenCalled()
  })

  it('a second start on the same tab is a second click: it cancels', () => {
    const p = poller([])
    expect(p.w.start('t1', target, { onUp: p.up, onStop: p.stopped })).toBe(true)
    expect(p.w.start('t1', target, { onUp: p.up, onStop: p.stopped })).toBe(false)
    expect(p.w.isWaiting('t1')).toBe(false)
  })

  it('on a local error tab the host polls, reports waitingForUp, reloads on success and stops', async () => {
    vi.useFakeTimers()
    const probe = vi.fn(async () => probe.mock.calls.length >= 2)
    const r = rig(probe)
    const t1 = r.addPane('bp-1')
    r.fail('bp-1', REFUSED, 'ERR_CONNECTION_REFUSED', 'http://localhost:8000/')
    expect(r.host.reloadWhenUp('bp-1', t1, true)).toBe(true)
    expect(r.tab('bp-1', t1).waitingForUp).toBe(true)
    await vi.advanceTimersByTimeAsync(RELOAD_WHEN_UP_POLL_MS)
    expect(r.tab('bp-1', t1).waitingForUp).toBe(true)
    await vi.advanceTimersByTimeAsync(RELOAD_WHEN_UP_POLL_MS)
    expect(probe).toHaveBeenCalledWith('localhost', 8000)
    expect(r.wc('bp-1').loadURL).toHaveBeenLastCalledWith('http://localhost:8000/')
    expect(r.tab('bp-1', t1).waitingForUp).toBe(false)
  })

  it('on an external origin it refuses and nothing polls', () => {
    const probe = vi.fn(async () => false)
    const r = rig(probe)
    const t1 = r.addPane('bp-1', 'https://example.test/')
    r.fail('bp-1', -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.test/')
    expect(r.host.reloadWhenUp('bp-1', t1, true)).toBe(false)
    expect(r.tab('bp-1', t1).waitingForUp).toBe(false)
  })

  it('a navigation of the tab and closing the tab both stop the wait; "off" cancels', async () => {
    vi.useFakeTimers()
    const probe = vi.fn(async () => false)
    const r = rig(probe)
    const t1 = r.addPane('bp-1')
    const added = r.host.newTab('bp-1', { url: 'http://localhost:8001/' })
    if (!added.ok) throw new Error('newTab refused')
    r.host.applyBounds('bp-1', RECT, true)
    const t2 = added.tabId
    r.fail('bp-1', REFUSED, 'ERR_CONNECTION_REFUSED', 'http://localhost:8001/', true, t2)
    expect(r.host.reloadWhenUp('bp-1', t2, true)).toBe(true)
    // Any main-frame navigation of the tab ends it.
    r.wc('bp-1', t2).emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(r.tab('bp-1', t2).waitingForUp).toBe(false)

    r.fail('bp-1', REFUSED, 'ERR_CONNECTION_REFUSED', 'http://localhost:8001/', true, t2)
    expect(r.host.reloadWhenUp('bp-1', t2, true)).toBe(true)
    expect(r.host.reloadWhenUp('bp-1', t2, false)).toBe(true)
    expect(r.tab('bp-1', t2).waitingForUp).toBe(false)

    r.fail('bp-1', REFUSED, 'ERR_CONNECTION_REFUSED', 'http://localhost:8001/', true, t2)
    r.host.reloadWhenUp('bp-1', t2, true)
    // Left running, the poll reaches the port every 2 s.
    await vi.advanceTimersByTimeAsync(RELOAD_WHEN_UP_POLL_MS * 2)
    const polledWhileOpen = probe.mock.calls.length
    expect(polledWhileOpen).toBeGreaterThan(0)
    r.host.closeTab('bp-1', t2)
    expect(r.registry.get('bp-1')!.tabs.map((t) => t.tabId)).toEqual([t1])
    expect(r.host.reloadWhenUp('bp-1', t2, true)).toBe(false)
    // Closing the tab stops the poll: several intervals later the port was not probed again.
    await vi.advanceTimersByTimeAsync(RELOAD_WHEN_UP_POLL_MS * 5)
    expect(probe).toHaveBeenCalledTimes(polledWhileOpen)
  })
})
