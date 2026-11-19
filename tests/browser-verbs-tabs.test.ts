/**
 * browser-tabs S-6 (AC-28, AC-29): the agent verbs understand tabs. `browser_open({ paneId, url })` opens a tab in an
 * agent pane; every tab verb takes `tabId?` (default: the active tab); `browser_list` lists the tabs. The verbs run
 * over a fake host that keeps real tab records (the pure `tabs.ts` model), so what is proved is the verbs' own
 * handling: which tab a host call names, when a tab is activated or revived, and what the ACK says.
 */
import { describe, it, expect, vi } from 'vitest'
import { createBrowserAccess, gateBrowserOpDetailed } from '../src/main/browser/access'
import { createBrowserRegistry, type BrowserPaneRecord } from '../src/main/browser/registry'
import { createPaneReaders, type PaneReaders } from '../src/main/browser/pane-readers'
import { BrowserLeases } from '../src/main/browser/lease'
import { activateTab, addTab, removeTab, findTab } from '../src/main/browser/tabs'
import {
  clickVerb,
  evalVerb,
  type BrowserActDeps,
  type BrowserActHost
} from '../src/main/browser/act-verbs'
import type { ElementProbe } from '../src/main/browser/act-plan'
import {
  consoleVerb,
  screenshotVerb,
  snapshotVerb,
  waitForVerb
} from '../src/main/browser/read-verbs'
import {
  closeVerb,
  listVerb,
  navigateVerb,
  openVerb,
  runWithRevival,
  withRevivedFlag,
  type LivePaneInfo
} from '../src/main/browser/verbs-core'
import { MAX_TABS_PER_PANE } from '../src/shared/browser-tabs'

const FOLDER = '/work/app'
const A = 'tab-aaaaaaaa'
const B = 'tab-bbbbbbbb'
const C = 'tab-cccccccc'
const LOCAL = 'http://localhost:5173/'

const okProbe: ElementProbe = {
  rect: { x: 10, y: 20, width: 100, height: 40 },
  disabled: false,
  hit: 'self',
  editable: false,
  isSelect: false,
  tag: 'button'
}

interface TabSpec {
  id: string
  url: string
  title?: string
  discarded?: boolean
}

function rig() {
  let clock = 1_000
  let seq = 0
  const registry = createBrowserRegistry(() => clock)
  const access = createBrowserAccess(() => clock)
  const leases = new BrowserLeases(() => clock)
  /** `<paneId>/<tabId>` → what that tab's page says about itself. */
  const live = new Map<string, LivePaneInfo>()
  const readerTable = new Map<string, PaneReaders>()
  const key = (paneId: string, tabId?: string): string =>
    `${paneId}/${tabId ?? registry.get(paneId)?.activeTabId ?? ''}`
  const info = (url: string, title = 'Page'): LivePaneInfo => ({
    url,
    title,
    loading: false,
    canGoBack: false,
    canGoForward: false
  })
  const readersOf = (k: string): PaneReaders => {
    let r = readerTable.get(k)
    if (!r) {
      r = createPaneReaders({
        now: () => clock,
        send: async () => undefined,
        scrub: (t) => t,
        setTimer: () => 0,
        clearTimer: () => undefined,
        onCaptureChange: () => undefined
      })
      // A snapshot of this tab made the ref s1e1 → a button.
      r.refs.commit(r.refs.nextSnapshotId(), new Map([[1, 20]]), new Map([[1, 'button|Save']]))
      readerTable.set(k, r)
    }
    return r
  }
  const cdpLog: Array<{ paneId: string; method: string; tabId: string | undefined }> = []

  const host = {
    create: vi.fn(),
    destroy: vi.fn(),
    publishFlag: vi.fn(),
    info: vi.fn((paneId: string, tabId?: string) => live.get(key(paneId, tabId))),
    navigate: vi.fn(async (paneId: string, target: object, _o: object, tabId?: string) => {
      const k = key(paneId, tabId)
      const url = 'url' in target ? (target as { url: string }).url : (live.get(k)?.url ?? '')
      live.set(k, info(url, 'Navigated'))
      return { title: 'Navigated', status: 200, navigationId: 'nav-1', reason: 'load' as const }
    }),
    viewToken: vi.fn((paneId: string, tabId?: string) => {
      const k = key(paneId, tabId)
      let origin = 'x'
      try {
        origin = new URL(live.get(k)?.url ?? '').origin
      } catch {
        /* about:blank */
      }
      return `view-${k}|${origin}`
    }),
    isDiscarded: vi.fn((paneId: string, tabId?: string) => {
      const rec = registry.get(paneId)
      return (rec ? findTab(rec, tabId)?.discarded : null) != null
    }),
    revive: vi.fn(async (paneId: string, opts: { tabId?: string } = {}) => {
      const rec = registry.get(paneId)
      const tab = rec ? findTab(rec, opts.tabId) : undefined
      if (!tab) return false
      tab.discarded = null
      if (rec!.activeTabId === tab.tabId) rec!.discarded = null
      return true
    }),
    readers: vi.fn((paneId: string, tabId?: string) => readersOf(key(paneId, tabId))),
    cdp: vi.fn(
      async (
        paneId: string,
        method: string,
        params: Record<string, unknown> = {},
        tabId?: string
      ) => {
        cdpLog.push({ paneId, method, tabId })
        switch (method) {
          case 'Accessibility.getFullAXTree':
            return { nodes: [] }
          case 'Runtime.evaluate':
            return { result: { type: 'number', value: 42 } }
          case 'Page.getLayoutMetrics':
            return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } }
          case 'DOM.resolveNode':
            return { object: { objectId: 'obj-20' } }
          case 'Accessibility.getPartialAXTree':
            return { nodes: [{ role: { value: 'button' }, name: { value: 'Save' } }] }
          case 'Runtime.callFunctionOn':
            return String(params.functionDeclaration).includes('isSelect')
              ? { result: { value: okProbe } }
              : { result: { value: true } }
          default:
            return {}
        }
      }
    ),
    viewMode: vi.fn(() => 'visible' as const),
    deviceMode: vi.fn(() => false),
    capture: vi.fn(async () => ({
      data: new Uint8Array([1, 2, 3]),
      mime: 'image/png' as const,
      width: 10,
      height: 10,
      clamped: false
    })),
    inputScale: vi.fn(() => 1),
    drive: vi.fn(),
    loadErrorOf: vi.fn(() => undefined),
    newTab: vi.fn((paneId: string, opts: { url?: string; background?: boolean } = {}) => {
      const rec = registry.get(paneId)
      if (!rec) return { ok: false as const, error: 'PANE_NOT_FOUND' as const }
      const added = addTab(rec, {})
      if (!added.ok) return { ok: false as const, error: added.error }
      live.set(key(paneId, added.tab.tabId), info(opts.url ?? 'about:blank', 'Loading'))
      if (opts.background !== true) activateTab(rec, added.tab.tabId)
      return { ok: true as const, tabId: added.tab.tabId }
    }),
    activateTab: vi.fn((paneId: string, tabId: string) => {
      const rec = registry.get(paneId)
      return rec ? activateTab(rec, tabId) : false
    }),
    closeTab: vi.fn((paneId: string, tabId: string) => {
      const rec = registry.get(paneId)
      if (!rec) return { ok: false as const, error: 'PANE_NOT_FOUND' as const }
      const removed = removeTab(rec, tabId)
      if (!removed.ok) return { ok: false as const, error: removed.error }
      live.delete(key(paneId, tabId))
      if (removed.paneEmpty) registry.remove(paneId)
      return { ok: true as const, paneClosed: removed.paneEmpty }
    })
  }

  const deps: BrowserActDeps = {
    now: () => clock,
    newPaneId: () => `bp-${++seq}`,
    registry,
    access,
    host: host as unknown as BrowserActHost,
    writesEnabled: async () => true,
    trustedHosts: () => [],
    harnuPorts: () => [41999],
    sessionKnown: () => true,
    showPane: vi.fn(async () => true),
    hidePane: vi.fn(async () => true),
    scrub: (t) => t,
    alias: (f) => f.split('/').pop() ?? f,
    folderBlocked: () => false,
    leases,
    pages: {} as never,
    sleep: async () => undefined,
    saveShot: async () => '.harnu/out/browser/shots/x.png'
  }

  /** Register a pane with the given tabs (the first is active unless `active` says otherwise). */
  const addPane = (
    paneId: string,
    tabs: TabSpec[],
    over: Partial<BrowserPaneRecord> & { active?: string } = {}
  ): void => {
    const { active, ...rest } = over
    registry.add({
      paneId,
      folder: FOLDER,
      name: 'browser',
      openedBy: 'agent',
      partition: 'agent',
      ownerSessionId: null,
      createdAt: clock,
      lastActiveAt: clock,
      seenHosts: new Set<string>(),
      flagged: null,
      tabs: tabs.map((t) => ({
        tabId: t.id,
        hostView: 'page' as const,
        discarded: t.discarded
          ? {
              reason: 'idle' as const,
              url: t.url,
              title: t.title ?? 'Page',
              scroll: null,
              zoom: 1,
              discardedAt: clock,
              hiddenMs: 0
            }
          : null
      })),
      activeTabId: active ?? tabs[0]!.id,
      ...rest
    } as BrowserPaneRecord)
    for (const t of tabs) live.set(key(paneId, t.id), info(t.url, t.title))
  }

  /** A verb call with its own revival record, the way the MCP handler runs it. */
  const run = async (
    fn: () => Promise<Record<string, unknown>>
  ): Promise<Record<string, unknown>> => runWithRevival(async () => withRevivedFlag(await fn()))

  return {
    deps,
    host,
    registry,
    access,
    leases,
    live,
    cdpLog,
    addPane,
    run,
    tick: (ms: number) => (clock += ms)
  }
}

describe('open a tab', () => {
  it('opens a tab in an agent pane of the folder and returns its tabId', async () => {
    const r = rig()
    r.addPane('bp-1', [{ id: A, url: LOCAL }])
    const res = await openVerb(
      { folder: FOLDER, paneId: 'bp-1', url: 'http://localhost:3000/b' },
      r.deps
    )
    expect(res).toMatchObject({ ok: true, paneId: 'bp-1', openedBy: 'agent' })
    const tabId = res.tabId as string
    expect(tabId).toMatch(/^tab-[0-9a-f]{8}$/)
    expect(r.registry.get('bp-1')!.tabs.map((t) => t.tabId)).toEqual([A, tabId])
    // It is a tab, not a pane: nothing was created, shown in the stack or counted against the pane cap.
    expect(r.host.create).not.toHaveBeenCalled()
    expect(r.deps.showPane).not.toHaveBeenCalled()
    expect(r.host.newTab).toHaveBeenCalledWith(
      'bp-1',
      expect.objectContaining({ url: 'http://localhost:3000/b' })
    )
    // The ACK describes the new tab's own page, not the pane's active one.
    expect(res.url).toBe('http://localhost:3000/b')
    expect(res.origin).toBe('local')
  })

  it('opens the tab in the background so the pane the operator watches does not jump', async () => {
    const r = rig()
    r.addPane('bp-1', [{ id: A, url: LOCAL }])
    await openVerb({ folder: FOLDER, paneId: 'bp-1', url: 'http://localhost:3000/b' }, r.deps)
    expect(r.registry.get('bp-1')!.activeTabId).toBe(A)
    expect(r.host.newTab).toHaveBeenCalledWith(
      'bp-1',
      expect.objectContaining({ background: true })
    )
  })

  it('opens the tab as the active one when the call asks for it with background: false', async () => {
    const r = rig()
    r.addPane('bp-1', [{ id: A, url: LOCAL }])
    const res = await openVerb(
      { folder: FOLDER, paneId: 'bp-1', url: 'http://localhost:3000/b', background: false },
      r.deps
    )
    expect(r.registry.get('bp-1')!.activeTabId).toBe(res.tabId)
  })

  it('flags an external site a verb opened in a tab, like a navigation does', async () => {
    const r = rig()
    r.addPane('bp-1', [{ id: A, url: LOCAL }])
    const res = await openVerb(
      { folder: FOLDER, paneId: 'bp-1', url: 'https://docs.example.com/g' },
      r.deps
    )
    expect(res).toMatchObject({ ok: true, origin: 'external', flagged: true })
    expect(res.tabId).toMatch(/^tab-[0-9a-f]{8}$/)
    expect(r.host.create).not.toHaveBeenCalled()
    expect(r.host.publishFlag).toHaveBeenCalledWith('bp-1', { host: 'docs.example.com' })
    expect(r.registry.get('bp-1')!.flagged).toEqual({ host: 'docs.example.com' })
  })

  it('refuses a pane the operator opened as NOT_AN_AGENT_PANE', async () => {
    const r = rig()
    r.addPane('bp-op', [{ id: A, url: LOCAL }], { openedBy: 'operator', partition: 'operator' })
    const res = await openVerb({ folder: FOLDER, paneId: 'bp-op', url: LOCAL }, r.deps)
    expect(res).toMatchObject({ ok: false, error: 'NOT_AN_AGENT_PANE' })
    expect(r.host.newTab).not.toHaveBeenCalled()
  })

  it('refuses a live panel (a page pane) as NOT_AN_AGENT_PANE', async () => {
    const r = rig()
    r.addPane('bp-page', [{ id: A, url: 'harnu-page://f1/a.html' }], { pagePath: 'a.html' })
    const res = await openVerb({ folder: FOLDER, paneId: 'bp-page', url: LOCAL }, r.deps)
    expect(res).toMatchObject({ ok: false, error: 'NOT_AN_AGENT_PANE' })
    expect(r.host.newTab).not.toHaveBeenCalled()
  })

  it('treats a pane of another folder, or an unknown one, as PANE_NOT_FOUND', async () => {
    const r = rig()
    r.addPane('bp-1', [{ id: A, url: LOCAL }])
    expect(
      await openVerb({ folder: '/work/other', paneId: 'bp-1', url: LOCAL }, r.deps)
    ).toMatchObject({
      ok: false,
      error: 'PANE_NOT_FOUND'
    })
    expect(await openVerb({ folder: FOLDER, paneId: 'bp-9', url: LOCAL }, r.deps)).toMatchObject({
      ok: false,
      error: 'PANE_NOT_FOUND'
    })
  })

  it('refuses a ninth tab as TAB_LIMIT', async () => {
    const r = rig()
    r.addPane(
      'bp-1',
      Array.from({ length: MAX_TABS_PER_PANE }, (_, i) => ({ id: `tab-0000000${i}`, url: LOCAL }))
    )
    const res = await openVerb({ folder: FOLDER, paneId: 'bp-1', url: LOCAL }, r.deps)
    expect(res).toMatchObject({ ok: false, error: 'TAB_LIMIT' })
    expect(r.registry.get('bp-1')!.tabs).toHaveLength(MAX_TABS_PER_PANE)
  })

  it('refuses a pane the operator disconnected, and a paused one', async () => {
    const r = rig()
    r.addPane('bp-1', [{ id: A, url: LOCAL }])
    r.access.pause('bp-1')
    expect(await openVerb({ folder: FOLDER, paneId: 'bp-1', url: LOCAL }, r.deps)).toMatchObject({
      ok: false,
      error: 'BROWSER_PAUSED'
    })
    r.access.resume('bp-1')
    r.access.disconnect('bp-1')
    expect(await openVerb({ folder: FOLDER, paneId: 'bp-1', url: LOCAL }, r.deps)).toMatchObject({
      ok: false,
      error: 'BROWSER_DISCONNECTED'
    })
  })

  it('does not count a tab against the four-pane cap, and still opens a pane without paneId', async () => {
    const r = rig()
    for (const n of [1, 2, 3, 4]) r.addPane(`bp-${n}`, [{ id: `tab-1111111${n}`, url: LOCAL }])
    const res = await openVerb({ folder: FOLDER, paneId: 'bp-1', url: LOCAL }, r.deps)
    expect(res).toMatchObject({ ok: true, paneId: 'bp-1' })
    expect(await openVerb({ folder: FOLDER, url: LOCAL }, r.deps)).toMatchObject({
      ok: false,
      error: 'PANE_LIMIT'
    })
  })

  it('takes paneId with the url form only', async () => {
    const r = rig()
    r.addPane('bp-1', [{ id: A, url: LOCAL }])
    expect(
      await openVerb({ folder: FOLDER, paneId: 'bp-1', path: 'a.html' }, r.deps)
    ).toMatchObject({
      ok: false,
      error: 'BAD_ARGS'
    })
  })
})

describe('tabId', () => {
  it('reads a background tab without switching: snapshot, console, eval and wait_for name that tab', async () => {
    const r = rig()
    r.addPane('bp-1', [
      { id: A, url: LOCAL },
      { id: B, url: 'http://localhost:3000/b', title: 'Second' }
    ])
    const snap = await r.run(() => snapshotVerb({ paneId: 'bp-1', tabId: B }, r.deps))
    expect(snap).toMatchObject({ ok: true, tabId: B, url: 'http://localhost:3000/b' })
    const con = await r.run(() => consoleVerb({ paneId: 'bp-1', tabId: B }, r.deps))
    expect(con).toMatchObject({ ok: true, tabId: B })
    const ev = await r.run(() => evalVerb({ paneId: 'bp-1', tabId: B, expression: '6*7' }, r.deps))
    expect(ev).toMatchObject({ ok: true, tabId: B, value: 42 })
    const wait = await r.run(() =>
      waitForVerb({ paneId: 'bp-1', tabId: B, url: 'localhost:3000', timeoutMs: 100 }, r.deps)
    )
    expect(wait).toMatchObject({ ok: true, tabId: B })
    // Every CDP command ran against tab B, and the pane never switched or reported an activation.
    const methods = r.cdpLog.filter((c) => c.paneId === 'bp-1')
    expect(methods.length).toBeGreaterThan(0)
    expect(methods.every((c) => c.tabId === B)).toBe(true)
    expect(r.host.readers).toHaveBeenCalledWith('bp-1', B)
    expect(r.host.activateTab).not.toHaveBeenCalled()
    expect(r.registry.get('bp-1')!.activeTabId).toBe(A)
    for (const res of [snap, con, ev, wait]) expect(res).not.toHaveProperty('activated')
  })

  it('without tabId a verb acts on the active tab and names it', async () => {
    const r = rig()
    r.addPane(
      'bp-1',
      [
        { id: A, url: LOCAL },
        { id: B, url: 'http://localhost:3000/b' }
      ],
      { active: B }
    )
    const res = await r.run(() => evalVerb({ paneId: 'bp-1', expression: '1' }, r.deps))
    expect(res).toMatchObject({ ok: true, tabId: B, url: 'http://localhost:3000/b' })
  })

  it('reports activated: true when a screenshot or an input verb had to bring its tab forward', async () => {
    const r = rig()
    r.addPane('bp-1', [
      { id: A, url: LOCAL },
      { id: B, url: 'http://localhost:3000/b' },
      { id: C, url: 'http://localhost:3000/c' }
    ])
    const shot = await r.run(() => screenshotVerb({ paneId: 'bp-1', tabId: B }, r.deps))
    expect(shot).toMatchObject({ ok: true, tabId: B, activated: true })
    expect(r.registry.get('bp-1')!.activeTabId).toBe(B)
    const click = await r.run(() => clickVerb({ paneId: 'bp-1', tabId: C, ref: 's1e1' }, r.deps))
    expect(click).toMatchObject({ ok: true, tabId: C, activated: true })
    expect(r.registry.get('bp-1')!.activeTabId).toBe(C)
    // The tab that is already active needs nothing.
    const again = await r.run(() => clickVerb({ paneId: 'bp-1', tabId: C, ref: 's1e1' }, r.deps))
    expect(again).not.toHaveProperty('activated')
    // Input and `drive` name the tab the verb acts on.
    expect(r.host.drive).toHaveBeenCalledWith('bp-1', true, C)
  })

  it('reports revived: true when the named tab was discarded, and reads it afterwards', async () => {
    const r = rig()
    r.addPane('bp-1', [
      { id: A, url: LOCAL },
      { id: B, url: 'http://localhost:3000/b', discarded: true }
    ])
    const res = await r.run(() => evalVerb({ paneId: 'bp-1', tabId: B, expression: '1' }, r.deps))
    expect(res).toMatchObject({ ok: true, tabId: B, revived: true })
    expect(r.host.revive).toHaveBeenCalledWith('bp-1', expect.objectContaining({ tabId: B }))
    // The active tab was live: no revival.
    const live = await r.run(() => evalVerb({ paneId: 'bp-1', expression: '1' }, r.deps))
    expect(live).not.toHaveProperty('revived')
  })

  it('refuses an unknown tabId as TAB_NOT_FOUND, before it reads, writes or revives anything', async () => {
    const r = rig()
    r.addPane('bp-1', [{ id: A, url: LOCAL }])
    for (const call of [
      () => snapshotVerb({ paneId: 'bp-1', tabId: 'tab-deadbeef' }, r.deps),
      () => screenshotVerb({ paneId: 'bp-1', tabId: 'tab-deadbeef' }, r.deps),
      () => evalVerb({ paneId: 'bp-1', tabId: 'tab-deadbeef', expression: '1' }, r.deps),
      () => clickVerb({ paneId: 'bp-1', tabId: 'tab-deadbeef', ref: 's1e1' }, r.deps),
      () => navigateVerb({ paneId: 'bp-1', tabId: 'tab-deadbeef', url: LOCAL }, r.deps),
      () => closeVerb({ paneId: 'bp-1', tabId: 'tab-deadbeef' }, r.deps)
    ]) {
      expect(await r.run(call)).toMatchObject({ ok: false, error: 'TAB_NOT_FOUND' })
    }
    expect(r.cdpLog).toHaveLength(0)
    expect(r.host.navigate).not.toHaveBeenCalled()
    expect(r.host.closeTab).not.toHaveBeenCalled()
  })

  it('judges a lease per tab: one granted for tab A does not cover an external page in tab B', async () => {
    const r = rig()
    r.addPane('bp-1', [
      { id: A, url: 'https://a.example.com/' },
      { id: B, url: 'https://b.example.com/' }
    ])
    // The agent holds a lease for the page tab A shows (granted for that view and origin).
    r.leases.grant('bp-1', FOLDER, r.host.viewToken('bp-1', A)!)
    expect(await r.run(() => evalVerb({ paneId: 'bp-1', expression: '1' }, r.deps))).toMatchObject({
      ok: true
    })
    // The same lease does not cover tab B: its view and origin are another page.
    r.leases.grant('bp-1', FOLDER, r.host.viewToken('bp-1', A)!)
    expect(
      await r.run(() => evalVerb({ paneId: 'bp-1', tabId: B, expression: '1' }, r.deps))
    ).toMatchObject({ ok: false, error: 'BROWSER_LEASE_ENDED' })
  })

  it('navigates the named tab and closes only it', async () => {
    const r = rig()
    r.addPane('bp-1', [
      { id: A, url: LOCAL },
      { id: B, url: 'http://localhost:3000/b' }
    ])
    const nav = await r.run(() =>
      navigateVerb({ paneId: 'bp-1', tabId: B, url: 'http://localhost:3000/next' }, r.deps)
    )
    expect(nav).toMatchObject({ ok: true, tabId: B, url: 'http://localhost:3000/next' })
    expect(r.host.navigate).toHaveBeenCalledWith(
      'bp-1',
      { url: 'http://localhost:3000/next' },
      expect.any(Object),
      B
    )
    const closed = await r.run(() => closeVerb({ paneId: 'bp-1', tabId: B }, r.deps))
    expect(closed).toMatchObject({ ok: true, closed: true, tabId: B, paneClosed: false })
    expect(r.registry.get('bp-1')!.tabs.map((t) => t.tabId)).toEqual([A])
    expect(r.host.destroy).not.toHaveBeenCalled()
  })

  it('says paneClosed: true when the last tab closes, and the pane is gone after', async () => {
    const r = rig()
    r.addPane('bp-1', [{ id: A, url: LOCAL }])
    const closed = await r.run(() => closeVerb({ paneId: 'bp-1', tabId: A }, r.deps))
    expect(closed).toMatchObject({ ok: true, closed: true, tabId: A, paneClosed: true })
    expect(r.registry.get('bp-1')).toBeUndefined()
    expect(r.deps.hidePane).toHaveBeenCalledWith(FOLDER, 'bp-1')
    expect(await r.run(() => evalVerb({ paneId: 'bp-1', expression: '1' }, r.deps))).toMatchObject({
      ok: false,
      error: 'PANE_NOT_FOUND'
    })
  })

  it('closes the whole pane without a tabId, as before', async () => {
    const r = rig()
    r.addPane('bp-1', [
      { id: A, url: LOCAL },
      { id: B, url: 'http://localhost:3000/b' }
    ])
    const closed = await r.run(() => closeVerb({ paneId: 'bp-1' }, r.deps))
    expect(closed).toMatchObject({ ok: true, closed: true })
    expect(r.host.destroy).toHaveBeenCalledWith('bp-1')
    expect(r.registry.get('bp-1')).toBeUndefined()
  })

  it('accepts the one tabId of a page pane', async () => {
    const r = rig()
    r.addPane('bp-page', [{ id: A, url: 'harnu-page://f1/a.html' }], { pagePath: 'a.html' })
    const res = await r.run(() =>
      evalVerb({ paneId: 'bp-page', tabId: A, expression: '1' }, r.deps)
    )
    expect(res).toMatchObject({ ok: true, tabId: A })
  })

  it('lists the tabs of each pane with their state', async () => {
    const r = rig()
    r.addPane(
      'bp-1',
      [
        { id: A, url: LOCAL, title: 'First' },
        { id: B, url: 'http://localhost:3000/b?token=s', title: 'Second', discarded: true }
      ],
      { active: A }
    )
    r.addPane('bp-op', [{ id: C, url: 'http://localhost:9/' }], {
      openedBy: 'operator',
      partition: 'operator'
    })
    const res = await listVerb({ folder: FOLDER }, r.deps)
    const panes = res.panes as Array<{ paneId: string; tabs: Array<Record<string, unknown>> }>
    const agent = panes.find((p) => p.paneId === 'bp-1')!
    expect(agent.tabs).toEqual([
      { tabId: A, url: LOCAL, title: 'First', active: true, state: 'live' },
      {
        tabId: B,
        url: 'http://localhost:3000/b',
        title: 'Second',
        active: false,
        state: 'discarded'
      }
    ])
    // A pane the agent may not read keeps the page's own words to itself, as the pane row does.
    const operator = panes.find((p) => p.paneId === 'bp-op')!
    expect(operator.tabs).toEqual([
      { tabId: C, url: null, title: null, active: true, state: 'live' }
    ])
  })
})

describe('tabId at plan level', () => {
  const agentPane = {
    openedBy: 'agent' as const,
    originClass: 'external' as const,
    disconnected: false,
    paused: false
  }

  it('refuses an unknown tab as TAB_NOT_FOUND before any confirm, even where the tier would ask for a lease', () => {
    const input = { pane: { ...agentPane, tabKnown: false }, writesEnabled: true }
    for (const op of [
      'browser_eval',
      'browser_click',
      'browser_navigate',
      'browser_snapshot'
    ] as const) {
      expect(gateBrowserOpDetailed(op, input)).toEqual({ reason: 'TAB_NOT_FOUND' })
    }
    // A known tab (or none named) is judged as before: an external page is a lease row for the input verbs.
    expect(
      gateBrowserOpDetailed('browser_eval', {
        pane: agentPane,
        writesEnabled: true,
        enforceLease: true
      })
    ).toEqual({ reason: 'BROWSER_LEASE_ENDED' })
  })

  it('tells an agent nothing about the tabs of a pane it may not read', () => {
    const operatorPane = { ...agentPane, openedBy: 'operator' as const, tabKnown: false }
    expect(
      gateBrowserOpDetailed('browser_snapshot', { pane: operatorPane, writesEnabled: true })
    ).toEqual({
      reason: 'BROWSER_READ_NOT_ENABLED'
    })
    expect(
      gateBrowserOpDetailed('browser_snapshot', {
        pane: { ...operatorPane, disconnected: true },
        writesEnabled: true
      })
    ).toEqual({ reason: 'BROWSER_DISCONNECTED' })
  })

  it('does not count a browser_open that adds a tab as a fifth pane', () => {
    const four = ['bp-1', 'bp-2', 'bp-3', 'bp-4']
    const base = { pane: undefined, writesEnabled: true, agentPaneIds: four, openFolder: FOLDER }
    expect(
      gateBrowserOpDetailed('browser_open', { ...base, args: { folder: FOLDER, url: LOCAL } })
    ).toMatchObject({ reason: 'PANE_LIMIT' })
    expect(
      gateBrowserOpDetailed('browser_open', {
        ...base,
        args: { folder: FOLDER, paneId: 'bp-1', url: LOCAL }
      })
    ).toBeNull()
  })
})
