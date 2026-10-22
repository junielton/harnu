/**
 * T574 (browser pane U7, AC-4, AC-5) — a discarded pane over fakes: a verb that needs a live page revives it before
 * it runs (`revived: true`, once), a verb that does not never does, a refused call never pays for a page load, and a
 * pane can be closed while discarded without anything but the view going away.
 */
import { describe, expect, it, vi } from 'vitest'
import { createBrowserAccess } from '../src/main/browser/access'
import { createBrowserRegistry } from '../src/main/browser/registry'
import {
  beginPaneVerb,
  closeVerb,
  listVerb,
  navigateVerb,
  withRevivedFlag,
  type BrowserHost,
  type BrowserVerbDeps,
  type LivePaneInfo
} from '../src/main/browser/verbs-core'
import { buildDiscardState } from '../src/main/browser/lifecycle'

const FOLDER = '/work/acme-store'

function rig() {
  let clock = 1_000
  const live = new Map<string, LivePaneInfo>()
  const registry = createBrowserRegistry(() => clock)
  const access = createBrowserAccess(() => clock)
  const host: BrowserHost = {
    create: vi.fn(({ paneId, url }) => {
      live.set(paneId, {
        url,
        title: 'Cart',
        loading: false,
        canGoBack: false,
        canGoForward: false
      })
    }),
    info: (id) => {
      const l = live.get(id)
      if (l) return l
      const d = registry.get(id)?.discarded
      return d
        ? { url: d.url, title: d.title, loading: false, canGoBack: false, canGoForward: false }
        : undefined
    },
    navigate: vi.fn(async (id, target) => {
      const prev = live.get(id)!
      live.set(id, { ...prev, url: 'url' in target ? target.url : prev.url })
      return { title: 'Cart', status: 200, navigationId: 'n', reason: 'load' as const }
    }),
    destroy: vi.fn((id) => void live.delete(id)),
    publishFlag: vi.fn(),
    isDiscarded: (id) => !live.has(id) && registry.get(id)?.discarded != null,
    revive: vi.fn(async (id) => {
      const rec = registry.get(id)
      if (!rec?.discarded) return false
      live.set(id, {
        url: rec.discarded.url,
        title: rec.discarded.title,
        loading: false,
        canGoBack: false,
        canGoForward: false
      })
      rec.discarded = null
      return true
    })
  }
  const deps: BrowserVerbDeps = {
    now: () => clock,
    newPaneId: () => 'bp-new',
    registry,
    access,
    host,
    writesEnabled: async () => true,
    trustedHosts: () => [],
    harnuPorts: () => [41999],
    sessionKnown: () => true,
    showPane: vi.fn(async () => true),
    hidePane: vi.fn(async () => true),
    scrub: (t) => t,
    alias: (f) => f.split('/').pop() ?? f,
    folderBlocked: () => false,
    pages: undefined as never
  }
  registry.add({
    paneId: 'bp-1',
    folder: FOLDER,
    name: 'cart',
    openedBy: 'agent',
    partition: 'agent',
    ownerSessionId: null,
    createdAt: 1,
    lastActiveAt: 1,
    seenHosts: new Set(),
    flagged: null
  })
  // the pane was live, then discarded
  live.set('bp-1', {
    url: 'http://localhost:3000/cart',
    title: 'Cart',
    loading: false,
    canGoBack: false,
    canGoForward: false
  })
  const discard = (): void => {
    live.delete('bp-1')
    registry.get('bp-1')!.discarded = buildDiscardState({
      reason: 'idle',
      url: 'http://localhost:3000/cart',
      title: 'Cart',
      scroll: { x: 0, y: 400 },
      zoom: 1,
      now: clock,
      hiddenSince: 0
    })
  }
  return { deps, host, registry, access, live, discard, tick: (ms: number) => (clock += ms) }
}

describe('a verb that needs a live page', () => {
  it('revives a discarded pane before it runs, and the ACK says revived once', async () => {
    const { deps, host, registry, discard } = rig()
    discard()
    const res = await navigateVerb({ paneId: 'bp-1', action: 'reload' }, deps)
    expect(res).toMatchObject({ ok: true, paneId: 'bp-1', url: 'http://localhost:3000/cart' })
    expect(host.revive).toHaveBeenCalledTimes(1)
    expect(host.navigate).toHaveBeenCalledTimes(1)
    // the handler layer turns the flag into `revived: true` on that one ACK
    expect(withRevivedFlag(registry, res)).toMatchObject({ revived: true })
    expect(withRevivedFlag(registry, res)).not.toHaveProperty('revived')
  })

  it('does nothing to a pane that is live', async () => {
    const { deps, host, registry } = rig()
    const res = await navigateVerb({ paneId: 'bp-1', action: 'reload' }, deps)
    expect(res).toMatchObject({ ok: true })
    expect(host.revive).not.toHaveBeenCalled()
    expect(withRevivedFlag(registry, res)).not.toHaveProperty('revived')
  })

  it('a refused call never revives: a disconnected pane stays discarded', async () => {
    const { deps, host, access, discard } = rig()
    discard()
    access.disconnect('bp-1')
    const res = await navigateVerb({ paneId: 'bp-1', action: 'reload' }, deps)
    expect(res).toMatchObject({ ok: false, error: 'BROWSER_DISCONNECTED' })
    expect(host.revive).not.toHaveBeenCalled()
  })

  it('a paused pane stays discarded too: pause refuses before the page load', async () => {
    const { deps, host, access, discard } = rig()
    discard()
    access.pause('bp-1')
    const res = await navigateVerb({ paneId: 'bp-1', action: 'reload' }, deps)
    expect(res).toMatchObject({ ok: false, error: 'BROWSER_PAUSED' })
    expect(host.revive).not.toHaveBeenCalled()
  })

  it('the gate sees a discarded pane as it was: the recorded address classifies it', async () => {
    const { deps, discard } = rig()
    discard()
    const res = await listVerb({}, deps)
    const row = (res.panes as Array<Record<string, unknown>>)[0]!
    expect(row).toMatchObject({
      paneId: 'bp-1',
      origin: 'local',
      url: 'http://localhost:3000/cart'
    })
  })
})

describe('verbs that need no page', () => {
  it('browser_list reads a discarded pane without reviving it', async () => {
    const { deps, host, discard } = rig()
    discard()
    await listVerb({}, deps)
    expect(host.revive).not.toHaveBeenCalled()
  })

  it('browser_close closes a discarded pane: the view is already gone, the record and access go', async () => {
    const { deps, host, registry, discard } = rig()
    discard()
    const res = await closeVerb({ paneId: 'bp-1' }, deps)
    expect(res).toMatchObject({ ok: true, closed: true })
    expect(host.revive).not.toHaveBeenCalled()
    expect(host.destroy).toHaveBeenCalledWith('bp-1')
    expect(registry.get('bp-1')).toBeUndefined()
    expect(deps.hidePane).toHaveBeenCalledWith(FOLDER, 'bp-1')
  })
})

describe('a verb in flight keeps the pane from being discarded', () => {
  it('counts for the whole run and a leftover revival flag is dropped at the end', () => {
    const { registry } = rig()
    const end = beginPaneVerb(registry, 'bp-1')
    expect(registry.verbsInFlight('bp-1')).toBe(1)
    registry.noteRevived('bp-1') // a verb that failed after the revival never claimed it
    end()
    expect(registry.verbsInFlight('bp-1')).toBe(0)
    expect(registry.takeRevived('bp-1')).toBe(false)
  })

  it('does not add the flag to a refusal or an ACK without a pane', () => {
    const { registry } = rig()
    registry.noteRevived('bp-1')
    expect(withRevivedFlag(registry, { ok: false, error: 'X' })).not.toHaveProperty('revived')
    expect(withRevivedFlag(registry, { ok: true })).not.toHaveProperty('revived')
    expect(registry.takeRevived('bp-1')).toBe(true) // still waiting for a call that names the pane
  })
})

describe('close (spec §10.2)', () => {
  it('ends the lease, forgets the access state and the record, and destroys the view — on a live pane too', async () => {
    const { deps, host, registry } = rig()
    const forgotten: string[] = []
    deps.leases = {
      forget: (id: string) => void forgotten.push(id),
      isActive: () => false,
      isDenied: () => false,
      noteWrite: () => undefined,
      revoke: () => undefined
    } as never
    const res = await closeVerb({ paneId: 'bp-1' }, deps)
    expect(res).toMatchObject({ ok: true, closed: true })
    expect(host.destroy).toHaveBeenCalledWith('bp-1')
    expect(forgotten).toEqual(['bp-1'])
    expect(registry.get('bp-1')).toBeUndefined()
  })

  it('never deletes a file: it touches no filesystem seam at all', async () => {
    const { deps } = rig()
    const touched: string[] = []
    // the page seam is where page files, sidecars and crops would be reached; close must not call into it
    deps.pages = new Proxy(
      {},
      { get: (_t, key) => (touched.push(String(key)), () => undefined) }
    ) as never
    await closeVerb({ paneId: 'bp-1' }, deps)
    expect(touched).toEqual([])
  })
})
