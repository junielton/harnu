/**
 * T571 — only a write that actually RAN refreshes the lease's idle clock (spec §7.1: "no agent write for 10
 * minutes"). Passing the gate does not, and neither does a refused, failed or timed-out call: such a call must not
 * keep a lease alive. Driven through the real verbs over a fake page.
 */
import { describe, it, expect, vi } from 'vitest'
import { createBrowserAccess } from '../src/main/browser/access'
import { createBrowserRegistry } from '../src/main/browser/registry'
import { createPaneReaders } from '../src/main/browser/pane-readers'
import { BrowserLeases, LEASE_IDLE_MS } from '../src/main/browser/lease'
import {
  clickVerb,
  evalVerb,
  fillVerb,
  pressVerb,
  typeVerb,
  type BrowserActDeps,
  type BrowserActHost
} from '../src/main/browser/act-verbs'
import { networkVerb } from '../src/main/browser/read-verbs'
import { navigateVerb } from '../src/main/browser/verbs-core'
import type { ElementProbe } from '../src/main/browser/act-plan'

const probe = (over: Partial<ElementProbe> = {}): ElementProbe => ({
  rect: { x: 0, y: 0, width: 10, height: 10 },
  disabled: false,
  hit: 'self',
  editable: true,
  isSelect: false,
  tag: 'input',
  ...over
})

function rig(
  opts: {
    probe?: ElementProbe
    inputReady?: boolean
    evalFails?: boolean
    navigateFails?: boolean
  } = {}
) {
  let clock = 1_000
  const registry = createBrowserRegistry(() => clock)
  const leases = new BrowserLeases(() => clock)
  const readers = createPaneReaders({
    now: () => clock,
    send: async () => undefined,
    scrub: (t) => t,
    setTimer: () => 0,
    clearTimer: () => undefined,
    onCaptureChange: () => undefined
  })
  readers.refs.commit(
    readers.refs.nextSnapshotId(),
    new Map([[1, 20]]),
    new Map([[1, 'textbox|x']])
  )
  registry.add({
    paneId: 'bp-1',
    folder: '/work/app',
    name: 'x',
    // an external page: a lease row, so the lease is what lets the call through
    openedBy: 'agent',
    partition: 'agent',
    ownerSessionId: null,
    createdAt: 1,
    lastActiveAt: 1,
    seenHosts: new Set(),
    flagged: null
  })
  const host: BrowserActHost = {
    create: vi.fn(),
    info: () => ({
      url: 'https://shop.example.com/',
      title: 't',
      loading: false,
      canGoBack: false,
      canGoForward: false
    }),
    navigate: vi.fn(async () => {
      if (opts.navigateFails) throw new Error('pane is gone')
      return { title: 't', status: 200, navigationId: 'n', reason: 'load' as const }
    }),
    destroy: vi.fn(),
    publishFlag: vi.fn(),
    readers: () => readers,
    cdp: async (_id, method) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'o' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: opts.probe ?? probe() } }
      if (method === 'Page.getLayoutMetrics')
        return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } }
      if (method === 'Accessibility.getPartialAXTree')
        return { nodes: [{ role: { value: 'textbox' }, name: { value: 'x' } }] }
      if (method === 'Runtime.evaluate') {
        if (opts.evalFails) throw new Error('CDP went away')
        return { result: { type: 'number', value: 2 } }
      }
      return {}
    },
    viewMode: () => 'visible',
    deviceMode: () => false,
    capture: vi.fn(),
    viewToken: () => 'v|https://shop.example.com',
    inputReady: () => opts.inputReady ?? true
  }
  const deps: BrowserActDeps = {
    now: () => clock,
    newPaneId: () => 'x',
    registry,
    access: createBrowserAccess(() => clock),
    host,
    writesEnabled: async () => true,
    trustedHosts: () => [],
    harnuPorts: () => [],
    sessionKnown: () => true,
    showPane: vi.fn(),
    hidePane: vi.fn(),
    scrub: (t) => t,
    alias: (f) => f,
    folderBlocked: () => false,
    sleep: async (ms) => void (clock += ms),
    saveShot: vi.fn(),
    leases,
    readOptIn: async () => false
  }
  leases.grant('bp-1', '/work/app', 'v|https://shop.example.com')
  const started = clock
  return {
    deps,
    leases,
    tick: (ms: number) => (clock += ms),
    started: () => started,
    clock: () => clock
  }
}

/** The lease's idle deadline now, and whether it moved past the grant time. */
const refreshed = (r: ReturnType<typeof rig>): boolean =>
  r.leases.idleEndsAt('bp-1') !== r.started() + LEASE_IDLE_MS

describe('only a write that ran refreshes the lease idle clock', () => {
  it('a successful click, type, fill, press, eval, navigate and network call each restart the 10 minutes', async () => {
    const calls: Array<[string, (r: ReturnType<typeof rig>) => Promise<unknown>]> = [
      ['click', (r) => clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)],
      ['type', (r) => typeVerb({ paneId: 'bp-1', ref: 's1e1', text: 'x' }, r.deps)],
      ['fill', (r) => fillVerb({ paneId: 'bp-1', fields: [{ ref: 's1e1', value: 'v' }] }, r.deps)],
      ['press', (r) => pressVerb({ paneId: 'bp-1', keys: ['Tab'] }, r.deps)],
      ['eval', (r) => evalVerb({ paneId: 'bp-1', expression: '1+1' }, r.deps)],
      [
        'navigate',
        (r) => navigateVerb({ paneId: 'bp-1', url: 'https://shop.example.com/cart' }, r.deps)
      ]
    ]
    for (const [name, run] of calls) {
      const r = rig()
      r.tick(60_000)
      const res = (await run(r)) as { ok?: boolean }
      expect(res.ok, name).toBe(true)
      expect(refreshed(r), name).toBe(true)
      expect(r.leases.idleEndsAt('bp-1'), name).toBe(r.clock() + LEASE_IDLE_MS)
    }
  })

  it('a refused call does not: not found, disabled, not visible, stale ref, bad ref, unknown key, input not ready', async () => {
    const refusals: Array<
      [string, ReturnType<typeof rig>, (r: ReturnType<typeof rig>) => Promise<unknown>]
    > = [
      [
        'disabled element',
        rig({ probe: probe({ disabled: true }) }),
        (r) => clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)
      ],
      [
        'not visible',
        rig({ probe: probe({ rect: null }) }),
        (r) => fillVerb({ paneId: 'bp-1', fields: [{ ref: 's1e1', value: 'v' }] }, r.deps)
      ],
      ['unknown ref', rig(), (r) => clickVerb({ paneId: 'bp-1', ref: 'nope' }, r.deps)],
      ['stale ref', rig(), (r) => clickVerb({ paneId: 'bp-1', ref: 's9e1' }, r.deps)],
      ['unknown key', rig(), (r) => pressVerb({ paneId: 'bp-1', keys: ['Banana'] }, r.deps)],
      [
        'not editable',
        rig({ probe: probe({ editable: false }) }),
        (r) => typeVerb({ paneId: 'bp-1', ref: 's1e1', text: 'x' }, r.deps)
      ],
      [
        'input not ready',
        rig({ inputReady: false }),
        (r) => clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)
      ],
      [
        'network read with an expired cursor',
        rig(),
        (r) => networkVerb({ paneId: 'bp-1', action: 'read', since: 'bogus' }, r.deps)
      ]
    ]
    for (const [name, r, run] of refusals) {
      r.tick(60_000)
      const res = (await run(r)) as { ok?: boolean }
      expect(res.ok, name).toBe(false)
      expect(refreshed(r), name).toBe(false)
      expect(r.leases.idleEndsAt('bp-1'), name).toBe(r.started() + LEASE_IDLE_MS)
    }
  })

  it('a call that throws (the page went away) does not', async () => {
    const e = rig({ evalFails: true })
    e.tick(60_000)
    expect(await evalVerb({ paneId: 'bp-1', expression: '1' }, e.deps)).toMatchObject({ ok: false })
    expect(refreshed(e)).toBe(false)
    const n = rig({ navigateFails: true })
    n.tick(60_000)
    await expect(
      navigateVerb({ paneId: 'bp-1', url: 'https://shop.example.com/x' }, n.deps)
    ).rejects.toThrow('pane is gone')
    expect(refreshed(n)).toBe(false)
  })

  it('a refused call cannot keep a lease alive past its 10 minutes', async () => {
    const r = rig({ probe: probe({ disabled: true }) })
    for (let i = 0; i < 12; i++) {
      r.tick(60_000)
      await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)
    }
    // 12 minutes of refused clicks: the lease idled out at 10, so the gate itself now says it ended
    expect(await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)).toMatchObject({
      error: 'BROWSER_LEASE_ENDED'
    })
  })

  it('a successful write 9 minutes in does keep it alive past the original 10', async () => {
    const r = rig()
    r.tick(9 * 60_000)
    expect(await evalVerb({ paneId: 'bp-1', expression: '1+1' }, r.deps)).toMatchObject({
      ok: true
    })
    r.tick(9 * 60_000)
    expect(await evalVerb({ paneId: 'bp-1', expression: '1+1' }, r.deps)).toMatchObject({
      ok: true
    })
  })
})
