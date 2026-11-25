/**
 * Browser tabs, a page's new window opens as a tab (browser-tabs spec S-4, AC-16, decision D-2). The real
 * `BrowserViewHost` and registry run over a fake Electron; the test drives the page side the way Chromium does: a real
 * click (the gesture), then `window.open` / `target=_blank` through the view's window-open handler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./helpers/fake-browser-electron')).electronMock)

import { createBrowserAccess } from '../src/main/browser/access'
import { createBrowserRegistry } from '../src/main/browser/registry'
import { BrowserViewHost } from '../src/main/browser/view-host'
import { MAX_TABS_PER_PANE } from '../src/shared/browser-tabs'
import { views, win, sent, type FakeWebContents } from './helpers/fake-browser-electron'

const FOLDER = '/work/acme-store'
const RECT = { x: 0, y: 0, width: 800, height: 600 }
const OPERATOR_PARTITION = 'persist:harnu-browser'
const AGENT_PARTITION = 'persist:harnu-browser-agent'

function rig() {
  let clock = 5_000_000
  const registry = createBrowserRegistry(() => clock)
  const access = createBrowserAccess(() => clock)
  const openPopupPane = vi.fn()
  const host = new BrowserViewHost({
    getWindow: () => win as never,
    guestPreloadPath: '/x/browser-guest.js',
    registry,
    access,
    now: () => clock,
    harnuPorts: () => [],
    trustedHosts: () => [],
    readOptIn: () => false,
    leaseActive: () => false,
    scrub: (t) => t,
    openPopupPane,
    prefs: { zoomFor: () => 1, setZoom: vi.fn() }
  } as never)
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
  const wcOf = (paneId: string, tabId?: string) =>
    host.webContentsOf(paneId, tabId) as unknown as FakeWebContents
  /** A real click on the page, then the page opens a window with `disposition`. */
  const popup = (
    paneId: string,
    tabId: string,
    url: string,
    disposition = 'foreground-tab',
    click = true
  ): unknown => {
    const wc = wcOf(paneId, tabId)
    if (click)
      wc.emit('before-mouse-event', { preventDefault: () => undefined }, { type: 'mouseDown' })
    return wc.windowOpenHandler!({ url, disposition })
  }
  const tabs = (paneId: string) => registry.get(paneId)!.tabs.map((t) => t.tabId)
  return {
    registry,
    host,
    addPane,
    wcOf,
    popup,
    tabs,
    openPopupPane,
    tick: (ms: number) => (clock += ms)
  }
}

beforeEach(() => {
  views.length = 0
  sent.length = 0
})

describe('popup as tab', () => {
  it('opens as the active tab right of its opener, in the pane partition, and denies the native popup', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    const res = r.popup('bp-1', t1, 'https://b.test/page')
    expect(res).toEqual({ action: 'deny' })
    const ids = r.tabs('bp-1')
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(t1)
    expect(r.registry.get('bp-1')!.activeTabId).toBe(ids[1])
    expect(r.wcOf('bp-1', ids[1]).loads).toEqual(['https://b.test/page'])
    // Same cookie partition as the opener: every tab of an operator pane shares the operator login.
    expect(views.at(-1)!.opts?.webPreferences?.partition).toBe(OPERATOR_PARTITION)
    // A popup is a tab now, never a second pane.
    expect(r.openPopupPane).not.toHaveBeenCalled()
  })

  it('lands right of its opener, not at the end', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    r.host.newTab('bp-1', { url: 'https://c.test/', background: true })
    r.popup('bp-1', t1, 'https://b.test/')
    const ids = r.tabs('bp-1')
    expect(ids).toHaveLength(3)
    expect(r.wcOf('bp-1', ids[1]).loads).toEqual(['https://b.test/'])
    expect(r.wcOf('bp-1', ids[2]).loads).toEqual(['https://c.test/'])
  })

  it('a Ctrl+click (Cmd+click on macOS) opens a background tab and keeps the opener active', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    r.popup('bp-1', t1, 'https://b.test/', 'background-tab')
    expect(r.tabs('bp-1')).toHaveLength(2)
    expect(r.registry.get('bp-1')!.activeTabId).toBe(t1)
  })

  it('opens one tab per user activation', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    r.popup('bp-1', t1, 'https://b.test/one')
    // The second `window.open` inside the same click is refused: no new tab.
    r.popup('bp-1', t1, 'https://b.test/two', 'foreground-tab', false)
    expect(r.tabs('bp-1')).toHaveLength(2)
    // A fresh click buys another one.
    r.popup('bp-1', t1, 'https://b.test/three')
    expect(r.tabs('bp-1')).toHaveLength(3)
  })

  it('without a user activation nothing opens', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    r.tick(10_000)
    const res = r.popup('bp-1', t1, 'https://b.test/', 'foreground-tab', false)
    expect(res).toEqual({ action: 'deny' })
    expect(r.tabs('bp-1')).toHaveLength(1)
  })

  it('at the limit the window is refused and the pane notice says so', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    for (let i = 1; i < MAX_TABS_PER_PANE; i++)
      r.host.newTab('bp-1', { url: `https://t${i}.test/`, background: true })
    expect(r.tabs('bp-1')).toHaveLength(MAX_TABS_PER_PANE)
    r.popup('bp-1', t1, 'https://ninth.test/')
    expect(r.tabs('bp-1')).toHaveLength(MAX_TABS_PER_PANE)
    expect(r.host.state('bp-1')!.notice).toEqual({ kind: 'tab-limit' })
  })

  it('in an agent pane it is an agent tab, in the agent partition', () => {
    const r = rig()
    const t1 = r.addPane('bp-9', 'agent')
    r.popup('bp-9', t1, 'https://b.test/')
    expect(r.tabs('bp-9')).toHaveLength(2)
    expect(r.registry.get('bp-9')!.openedBy).toBe('agent')
    expect(views.at(-1)!.opts?.webPreferences?.partition).toBe(AGENT_PARTITION)
    expect(r.openPopupPane).not.toHaveBeenCalled()
  })

  it('a popup tab stays page while it loads about:blank', () => {
    const r = rig()
    const t1 = r.addPane('bp-1')
    r.popup('bp-1', t1, 'about:blank')
    const ids = r.tabs('bp-1')
    expect(r.registry.get('bp-1')!.tabs[1]!.hostView).toBe('page')
    expect(ids).toHaveLength(2)
  })
})
