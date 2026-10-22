/**
 * T568 (browser pane U1, AC-3, AC-7) — the open/list/navigate/close verbs over fakes: ACK shapes, refusals
 * of spec §6.1–§6.3, the pane cap, the "opened by agent" flag and the concurrency report.
 */
import { describe, it, expect, vi } from 'vitest'
import { createBrowserAccess } from '../src/main/browser/access'
import { createBrowserRegistry } from '../src/main/browser/registry'
import {
  closeVerb,
  listVerb,
  navigateVerb,
  openVerb,
  type BrowserHost,
  type BrowserVerbDeps,
  type LivePaneInfo
} from '../src/main/browser/verbs-core'

function rig(over: Partial<BrowserVerbDeps> = {}) {
  let clock = 1_000
  const live = new Map<string, LivePaneInfo>()
  let seq = 0
  const host: BrowserHost = {
    create: vi.fn(({ paneId, url }) => {
      live.set(paneId, {
        url,
        title: 'Loading',
        loading: true,
        canGoBack: false,
        canGoForward: false
      })
    }),
    info: (id) => live.get(id),
    navigate: vi.fn(async (id, target) => {
      const prev = live.get(id)!
      const url = 'url' in target ? target.url : prev.url
      live.set(id, { ...prev, url, title: 'Docs', loading: false })
      return { title: 'Docs', status: 200, navigationId: 'nav-1', reason: 'load' as const }
    }),
    destroy: vi.fn((id) => void live.delete(id)),
    publishFlag: vi.fn()
  }
  const registry = createBrowserRegistry(() => clock)
  const access = createBrowserAccess(() => clock)
  const deps: BrowserVerbDeps = {
    now: () => clock,
    newPaneId: () => `bp-${++seq}`,
    registry,
    access,
    host,
    writesEnabled: async () => true,
    trustedHosts: () => [],
    harnuPorts: () => [41999],
    sessionKnown: (id) => id === 'sess-1',
    showPane: vi.fn(async () => true),
    hidePane: vi.fn(async () => true),
    scrub: (t) => t,
    alias: (f) => f.split('/').pop() ?? f,
    folderBlocked: () => false,
    pages: {
      folderFor: async (folder) => ({ folder, realFolder: folder }),
      fs: {
        realpath: async (p) => p,
        stat: async () => ({ isFile: () => true, isDirectory: () => false, size: 10 })
      },
      locate: async () => null,
      state: {
        read: async () => ({ v: 1 as const, path: '', rev: 0, updatedAt: 0, data: null }),
        readSync: () => ({ v: 1 as const, path: '', rev: 0, updatedAt: 0, data: null }),
        set: async () => ({ ok: false as const, code: 'REV_CONFLICT' as const, currentRev: 0 })
      },
      pushData: () => 0,
      runPatch: async () => null,
      writePanel: async (_f, slug) => `.harnu/out/panels/${slug}.html`,
      urlFor: (real, rel) => `harnu-page://f${real.length}/${rel}`
    },
    ...over
  }
  return { deps, host, registry, access, live, tick: (ms: number) => (clock += ms) }
}

const FOLDER = '/work/acme-store'

describe('browser_open (url form)', () => {
  it('opens an agent pane and acks with the shared fields', async () => {
    const { deps, host } = rig()
    const res = await openVerb(
      { folder: FOLDER, url: 'http://localhost:5173/checkout?x=1', ownerSessionId: 'sess-1' },
      deps
    )
    expect(res).toMatchObject({
      ok: true,
      paneId: 'bp-1',
      url: 'http://localhost:5173/checkout',
      origin: 'local',
      state: 'loading',
      flagged: false,
      reused: false,
      ownerSessionId: 'sess-1',
      openedBy: 'agent'
    })
    expect(host.create).toHaveBeenCalledWith({
      paneId: 'bp-1',
      folder: FOLDER,
      partition: 'agent',
      url: 'http://localhost:5173/checkout?x=1'
    })
    expect(deps.showPane).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: FOLDER,
        paneId: 'bp-1',
        partition: 'agent',
        openedBy: 'agent'
      })
    )
  })

  it('names the requested address in the ACK while the page has not committed yet', async () => {
    const { deps, live } = rig()
    // Before the first commit a real webContents reports an empty URL.
    deps.host.create = vi.fn(({ paneId }) => {
      live.set(paneId, { url: '', title: '', loading: true, canGoBack: false, canGoForward: false })
    })
    const res = await openVerb({ folder: FOLDER, url: 'http://localhost:5173/a?token=s' }, deps)
    expect(res).toMatchObject({
      ok: true,
      url: 'http://localhost:5173/a',
      origin: 'local',
      state: 'loading'
    })
  })

  it('always uses the agent partition and flags an external host the verb opened', async () => {
    const { deps, host } = rig()
    const res = await openVerb({ folder: FOLDER, url: 'https://docs.example.com/guide' }, deps)
    expect(res).toMatchObject({ ok: true, origin: 'external', flagged: true })
    expect(host.publishFlag).toHaveBeenCalledWith('bp-1', { host: 'docs.example.com' })
    expect(host.create).toHaveBeenCalledWith(expect.objectContaining({ partition: 'agent' }))
  })

  it('refuses a device with a clear NOT_YET_AVAILABLE (U5 owns emulation)', async () => {
    const { deps, host } = rig()
    const res = await openVerb(
      { folder: FOLDER, url: 'http://localhost:3000', device: 'phone-m' },
      deps
    )
    expect(res).toMatchObject({ ok: false, error: 'NOT_YET_AVAILABLE' })
    expect((res.nextActions as unknown[]).length).toBeGreaterThan(0)
    expect(host.create).not.toHaveBeenCalled()
  })

  it('refuses a harnu-page address on the url form and points at `path`', async () => {
    const { deps, host } = rig()
    const res = await openVerb({ folder: FOLDER, url: 'harnu-page://f0123456789ab/a.html' }, deps)
    expect(res).toMatchObject({ ok: false, error: 'BAD_ARGS' })
    expect(host.create).not.toHaveBeenCalled()
  })

  it('refuses zero or several forms as BAD_ARGS', async () => {
    const { deps } = rig()
    expect(await openVerb({ folder: FOLDER }, deps)).toMatchObject({ ok: false, error: 'BAD_ARGS' })
    expect(
      await openVerb({ folder: FOLDER, url: 'http://localhost:1', path: 'a.html' }, deps)
    ).toMatchObject({ ok: false, error: 'BAD_ARGS' })
  })

  it('refuses a blocked scheme as URL_SCHEME_BLOCKED before creating anything', async () => {
    const { deps, host } = rig()
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings']) {
      expect(await openVerb({ folder: FOLDER, url }, deps), url).toMatchObject({
        ok: false,
        error: 'URL_SCHEME_BLOCKED'
      })
    }
    expect(host.create).not.toHaveBeenCalled()
  })

  it('refuses an unknown owner session', async () => {
    const { deps } = rig()
    expect(
      await openVerb({ folder: FOLDER, url: 'http://localhost:3000', ownerSessionId: 'nope' }, deps)
    ).toMatchObject({ ok: false, error: 'SESSION_NOT_FOUND' })
  })

  it('caps agent panes at 4 per folder and names the reusable ids; another folder is unaffected', async () => {
    const { deps } = rig()
    for (let i = 0; i < 4; i++) {
      expect((await openVerb({ folder: FOLDER, url: `http://localhost:300${i}` }, deps)).ok).toBe(
        true
      )
    }
    const fifth = await openVerb({ folder: FOLDER, url: 'http://localhost:3009' }, deps)
    expect(fifth).toMatchObject({ ok: false, error: 'PANE_LIMIT' })
    const hint = JSON.stringify(fifth.nextActions)
    for (const id of ['bp-1', 'bp-2', 'bp-3', 'bp-4']) expect(hint).toContain(id)
    expect((await openVerb({ folder: '/work/other', url: 'http://localhost:3009' }, deps)).ok).toBe(
      true
    )
  })

  it('refuses every write with BROWSER_WRITES_DISABLED when the kill-switch is off', async () => {
    const { deps, host } = rig({ writesEnabled: async () => false })
    expect(await openVerb({ folder: FOLDER, url: 'http://localhost:3000' }, deps)).toMatchObject({
      ok: false,
      error: 'BROWSER_WRITES_DISABLED'
    })
    expect(host.create).not.toHaveBeenCalled()
  })

  it('rolls back the view and the record when the renderer cannot show the pane', async () => {
    const { deps, host, registry } = rig({ showPane: vi.fn(async () => false) })
    await expect(openVerb({ folder: FOLDER, url: 'http://localhost:3000' }, deps)).rejects.toThrow()
    expect(host.destroy).toHaveBeenCalledWith('bp-1')
    expect(registry.list()).toHaveLength(0)
  })
})

describe('browser_navigate', () => {
  async function opened(over: Partial<BrowserVerbDeps> = {}) {
    const r = rig(over)
    await openVerb({ folder: FOLDER, url: 'http://localhost:5173/' }, r.deps)
    return r
  }

  it('navigates to a url and acks with title, status, navigationId and reason', async () => {
    const { deps } = await opened()
    const res = await navigateVerb({ paneId: 'bp-1', url: 'http://localhost:5173/cart?a=1' }, deps)
    expect(res).toMatchObject({
      ok: true,
      paneId: 'bp-1',
      url: 'http://localhost:5173/cart',
      origin: 'local',
      title: 'Docs',
      status: 200,
      navigationId: 'nav-1',
      reason: 'load',
      othersWrote: false,
      operatorInteracted: false
    })
    expect(typeof res.note).toBe('string')
  })

  it('supports back, forward, reload and stop as `action`', async () => {
    const { deps, host } = await opened()
    for (const action of ['back', 'forward', 'reload', 'stop'] as const) {
      expect((await navigateVerb({ paneId: 'bp-1', action }, deps)).ok, action).toBe(true)
    }
    expect(host.navigate).toHaveBeenLastCalledWith('bp-1', { action: 'stop' }, expect.any(Object))
  })

  it('defaults to waitUntil load and caps the timeout', async () => {
    const { deps, host } = await opened()
    await navigateVerb({ paneId: 'bp-1', url: 'http://localhost:5173/a', timeoutMs: 999_999 }, deps)
    expect(host.navigate).toHaveBeenCalledWith(
      'bp-1',
      { url: 'http://localhost:5173/a' },
      { waitUntil: 'load', timeoutMs: 90_000, hard: false }
    )
  })

  it('refuses a blocked scheme and a missing or doubled target', async () => {
    const { deps, host } = await opened()
    expect(await navigateVerb({ paneId: 'bp-1', url: 'file:///etc/hosts' }, deps)).toMatchObject({
      ok: false,
      error: 'URL_SCHEME_BLOCKED'
    })
    expect(await navigateVerb({ paneId: 'bp-1' }, deps)).toMatchObject({ error: 'BAD_ARGS' })
    expect(
      await navigateVerb({ paneId: 'bp-1', url: 'http://localhost:1', action: 'reload' }, deps)
    ).toMatchObject({ error: 'BAD_ARGS' })
    expect(host.navigate).not.toHaveBeenCalled()
  })

  it('flags a new external host even though the view host records it as seen while the page loads', async () => {
    const r = await opened()
    ;(r.host.navigate as ReturnType<typeof vi.fn>).mockImplementationOnce(async (id, target) => {
      // The real view host adds the committed host to `seenHosts` on `did-navigate`, DURING the call.
      r.live.set(id, { ...r.live.get(id)!, url: (target as { url: string }).url, loading: false })
      r.registry.get(id)!.seenHosts.add('docs.example.com')
      return { title: 'Docs', status: 200, navigationId: 'n', reason: 'load' as const }
    })
    const first = await navigateVerb({ paneId: 'bp-1', url: 'https://docs.example.com/a' }, r.deps)
    expect(first).toMatchObject({ ok: true, origin: 'external', flagged: true })
    // A second navigation to the same host is no longer new.
    r.registry.get('bp-1')!.flagged = null
    const second = await navigateVerb({ paneId: 'bp-1', url: 'https://docs.example.com/b' }, r.deps)
    expect(second).toMatchObject({ ok: true, flagged: false })
  })

  it('flags a verb navigation to a new external host, and not to one already seen', async () => {
    const { deps, host } = await opened()
    const a = await navigateVerb({ paneId: 'bp-1', url: 'https://docs.example.com/a' }, deps)
    expect(a).toMatchObject({ ok: true, origin: 'external', flagged: true })
    expect(host.publishFlag).toHaveBeenCalledWith('bp-1', { host: 'docs.example.com' })
    expect(deps.registry.get('bp-1')?.seenHosts.has('docs.example.com')).toBe(true)
  })

  it('returns ok:true with a netError when the load fails, so the agent can read the error', async () => {
    const { deps, host } = await opened()
    ;(host.navigate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      title: '',
      status: null,
      navigationId: 'nav-9',
      netError: 'ERR_NAME_NOT_RESOLVED',
      reason: 'load'
    })
    expect(
      await navigateVerb({ paneId: 'bp-1', url: 'https://nope.invalid/' }, deps)
    ).toMatchObject({ ok: true, netError: 'ERR_NAME_NOT_RESOLVED' })
  })

  it('refuses an unknown pane, a disconnected pane and a paused pane in that order', async () => {
    const { deps, access } = await opened()
    expect(await navigateVerb({ paneId: 'nope', url: 'http://localhost:1' }, deps)).toMatchObject({
      error: 'PANE_NOT_FOUND'
    })
    access.pause('bp-1')
    expect(await navigateVerb({ paneId: 'bp-1', url: 'http://localhost:1' }, deps)).toMatchObject({
      error: 'BROWSER_PAUSED'
    })
    access.disconnect('bp-1')
    expect(await navigateVerb({ paneId: 'bp-1', url: 'http://localhost:1' }, deps)).toMatchObject({
      error: 'BROWSER_DISCONNECTED'
    })
  })

  it('never lets an agent write to a pane the operator opened (the lease is a later unit)', async () => {
    const { deps, registry, host } = await opened()
    registry.add({
      paneId: 'op-1',
      folder: FOLDER,
      name: 'mine',
      openedBy: 'operator',
      partition: 'operator',
      ownerSessionId: null,
      createdAt: 1,
      lastActiveAt: 1,
      seenHosts: new Set(),
      flagged: null
    })
    expect(await navigateVerb({ paneId: 'op-1', url: 'http://localhost:1' }, deps)).toMatchObject({
      ok: false,
      error: 'NOT_YET_AVAILABLE'
    })
    expect(host.navigate).not.toHaveBeenCalled()
  })

  it('reports othersWrote and operatorInteracted from the registry during the call', async () => {
    const r = await opened()
    let release!: () => void
    const gateP = new Promise<void>((res) => (release = res))
    ;(r.host.navigate as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await gateP
      return { title: 'T', status: 200, navigationId: 'n', reason: 'load' as const }
    })
    const first = navigateVerb({ paneId: 'bp-1', url: 'http://localhost:5173/a' }, r.deps)
    await Promise.resolve()
    await Promise.resolve()
    const second = navigateVerb({ paneId: 'bp-1', url: 'http://localhost:5173/b' }, r.deps)
    r.tick(5)
    r.registry.noteOperatorInteraction('bp-1')
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toMatchObject({ othersWrote: true, operatorInteracted: true })
    expect(b).toMatchObject({ othersWrote: true })
  })
})

describe('browser_list', () => {
  it('lists agent panes as readable and free, with page fields scrubbed of the query string', async () => {
    const { deps, live } = rig()
    await openVerb(
      { folder: FOLDER, url: 'http://localhost:5173/a?token=s', ownerSessionId: 'sess-1' },
      deps
    )
    live.set('bp-1', { ...live.get('bp-1')!, title: 'Checkout', loading: false })
    const res = await listVerb({}, deps)
    expect(res.ok).toBe(true)
    const [row] = res.panes as Record<string, unknown>[]
    expect(row).toMatchObject({
      paneId: 'bp-1',
      origin: 'local',
      url: 'http://localhost:5173/a',
      title: 'Checkout',
      state: 'live',
      openedBy: 'agent',
      ownerSessionId: 'sess-1',
      readable: true,
      writable: 'free',
      flagged: false,
      network: { active: false, expiresAt: null },
      pendingPins: 0,
      folderAlias: 'acme-store'
    })
    expect(JSON.stringify(res)).not.toContain(FOLDER)
  })

  it('shows an operator-opened pane as unreadable with null page fields', async () => {
    const { deps, registry, live } = rig()
    registry.add({
      paneId: 'op-1',
      folder: FOLDER,
      name: 'mine',
      openedBy: 'operator',
      partition: 'operator',
      ownerSessionId: null,
      createdAt: 1,
      lastActiveAt: 1,
      seenHosts: new Set(),
      flagged: null
    })
    live.set('op-1', {
      url: 'https://mail.example.com/inbox',
      title: 'Inbox',
      loading: false,
      canGoBack: false,
      canGoForward: false
    })
    const [row] = (await listVerb({}, deps)).panes as Record<string, unknown>[]
    expect(row).toMatchObject({
      readable: false,
      writable: 'off',
      writableReason: 'read-not-enabled',
      url: null,
      title: null
    })
  })

  it('reports kill-switch, pause and disconnect as the writable state', async () => {
    const r = rig()
    await openVerb({ folder: FOLDER, url: 'http://localhost:3000' }, r.deps)
    r.access.pause('bp-1')
    const paused = (await listVerb({}, r.deps)).panes as Record<string, unknown>[]
    expect(paused[0]).toMatchObject({ writable: 'paused', writableReason: 'paused' })
    expect(paused[0].pausedUntil).not.toBeNull()
    r.access.disconnect('bp-1')
    expect(((await listVerb({}, r.deps)).panes as Record<string, unknown>[])[0]).toMatchObject({
      writable: 'revoked',
      writableReason: 'disconnected',
      readable: false,
      url: null
    })
    const off = rig({ writesEnabled: async () => false })
    await openVerb(
      { folder: FOLDER, url: 'http://localhost:3000' },
      { ...off.deps, writesEnabled: async () => true }
    )
    expect(((await listVerb({}, off.deps)).panes as Record<string, unknown>[])[0]).toMatchObject({
      writable: 'off',
      writableReason: 'kill-switch'
    })
  })

  it('works with the kill-switch off, hides blocked folders and honours the filters', async () => {
    const r = rig({ folderBlocked: (f) => f === '/work/blocked' })
    await openVerb(
      { folder: FOLDER, url: 'http://localhost:3000', ownerSessionId: 'sess-1' },
      r.deps
    )
    await openVerb({ folder: '/work/blocked', url: 'http://localhost:3001' }, r.deps)
    await openVerb({ folder: '/work/third', url: 'http://localhost:3002' }, r.deps)
    const all = (await listVerb({}, r.deps)).panes as Record<string, unknown>[]
    expect(all.map((p) => p.paneId)).toEqual(['bp-1', 'bp-3'])
    expect(((await listVerb({ folder: '/work/third' }, r.deps)).panes as unknown[]).length).toBe(1)
    expect(((await listVerb({ ownerSessionId: 'sess-1' }, r.deps)).panes as unknown[]).length).toBe(
      1
    )
    const off = { ...r.deps, writesEnabled: async () => false }
    expect((await listVerb({}, off)).ok).toBe(true)
  })
})

describe('browser_close', () => {
  it('destroys the view, removes the record and tells the renderer', async () => {
    const { deps, host, registry } = rig()
    await openVerb({ folder: FOLDER, url: 'http://localhost:3000' }, deps)
    const res = await closeVerb({ paneId: 'bp-1' }, deps)
    expect(res).toMatchObject({ ok: true, paneId: 'bp-1', closed: true, othersWrote: false })
    expect(host.destroy).toHaveBeenCalledWith('bp-1')
    expect(deps.hidePane).toHaveBeenCalledWith(FOLDER, 'bp-1')
    expect(registry.get('bp-1')).toBeUndefined()
    expect(await closeVerb({ paneId: 'bp-1' }, deps)).toMatchObject({ error: 'PANE_NOT_FOUND' })
  })

  it('reports an operator interaction that happened during the close', async () => {
    const { deps, host, registry } = rig()
    await openVerb({ folder: FOLDER, url: 'http://localhost:3000' }, deps)
    host.destroy.mockImplementation(() => registry.noteOperatorInteraction('bp-1'))
    const res = await closeVerb({ paneId: 'bp-1' }, deps)
    expect(res).toMatchObject({ closed: true, operatorInteracted: true })
  })

  it('still works with the kill-switch off (Q6) but not when paused or disconnected', async () => {
    const r = rig()
    await openVerb({ folder: FOLDER, url: 'http://localhost:3000' }, r.deps)
    await openVerb({ folder: FOLDER, url: 'http://localhost:3001' }, r.deps)
    await openVerb({ folder: FOLDER, url: 'http://localhost:3002' }, r.deps)
    const off = { ...r.deps, writesEnabled: async () => false }
    expect((await closeVerb({ paneId: 'bp-1' }, off)).ok).toBe(true)
    r.access.pause('bp-2')
    expect(await closeVerb({ paneId: 'bp-2' }, r.deps)).toMatchObject({ error: 'BROWSER_PAUSED' })
    r.access.disconnect('bp-3')
    expect(await closeVerb({ paneId: 'bp-3' }, r.deps)).toMatchObject({
      error: 'BROWSER_DISCONNECTED'
    })
  })
})
