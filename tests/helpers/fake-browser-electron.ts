/**
 * A fake Electron for the browser view host (browser-tabs S-4 tests): `WebContentsView`, `webContents` and the window,
 * enough for the real `BrowserViewHost` to create, show, hide and close tab views. A test mocks `electron` with
 * {@link electronMock}, builds a host over {@link win}, and drives the page side through the `FakeWebContents`
 * (`emit`, `windowOpenHandler`, `sent`).
 */
import { vi } from 'vitest'

type Fn = (...a: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any

let nextWcId = 900

export class FakeWebContents {
  id = nextWcId++
  url = ''
  destroyed = false
  zoom = 1
  attached = false
  listeners = new Map<string, Fn[]>()
  loads: string[] = []
  windowOpenHandler: ((details: { url: string; disposition?: string }) => unknown) | null = null
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
  setWindowOpenHandler = (fn: (details: { url: string; disposition?: string }) => unknown) => {
    this.windowOpenHandler = fn
  }
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

/** Every view the host built, in creation order. A test clears it in `beforeEach`. */
export const views: FakeView[] = []

export class FakeView {
  webContents = new FakeWebContents()
  bounds = { x: 0, y: 0, width: 0, height: 0 }
  visible = true
  /** The constructor options the host passed (`webPreferences.partition` ...). */
  opts: { webPreferences?: { partition?: string } } | undefined
  constructor(opts?: { webPreferences?: { partition?: string } }) {
    this.opts = opts
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

/** Every `webContents.send(channel, payload)` the window received, in order. */
export const sent: Array<{ channel: string; payload: unknown }> = []

export const win = {
  contentView: { addChildView: () => undefined, removeChildView: () => undefined },
  getContentSize: () => [1200, 800],
  isDestroyed: () => false,
  on: () => undefined,
  webContents: {
    getZoomFactor: () => 1,
    focus: () => undefined,
    send: (channel: string, payload: unknown) => void sent.push({ channel, payload })
  }
}

export const electronMock = {
  app: { commandLine: { getSwitchValue: () => '' } },
  BrowserWindow: class {},
  WebContentsView: FakeView,
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      on: () => undefined,
      webRequest: { onBeforeRequest: () => undefined, onHeadersReceived: () => undefined }
    })
  }
}
