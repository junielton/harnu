/**
 * T571 Delta 1 — a pane's FIRST document does not take CDP mouse or key events (measured live: acknowledged,
 * not delivered, mounted or parked), so the verbs that send them refuse `PANE_INPUT_NOT_READY` loudly, at plan
 * level, before the kill-switch and any confirm, and again in the handler after a write-queue wait. The verbs that
 * insert text or run script (`fill`, a plain `type`, `eval`) are unaffected.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  gateBrowserOp,
  sendsPointerOrKeyEvents,
  type BrowserPaneAccess
} from '../src/main/browser/access'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { shapeDenial } from '../src/main/mcp/deny-hint'
import { resolveGateInput } from '../src/main/browser/gate-resolve'
import { clickVerb, fillVerb, pressVerb, typeVerb, evalVerb } from '../src/main/browser/act-verbs'
import { listVerb } from '../src/main/browser/verbs-core'
import { BrowserLeases } from '../src/main/browser/lease'
import { createBrowserAccess } from '../src/main/browser/access'
import { createBrowserRegistry } from '../src/main/browser/registry'
import { createPaneReaders } from '../src/main/browser/pane-readers'
import type { BrowserActDeps, BrowserActHost } from '../src/main/browser/act-verbs'

const pane = (over: Partial<BrowserPaneAccess> = {}): BrowserPaneAccess => ({
  openedBy: 'agent',
  originClass: 'local',
  disconnected: false,
  paused: false,
  inputReady: false,
  ...over
})
const policy = (ask: boolean): Parameters<typeof planToolCall>[0]['policy'] => ({
  serverEnabled: true,
  ask,
  denyFolders: [],
  knownRoots: ['/work']
})
const plan = (tool: string, args: Record<string, unknown>, p: BrowserPaneAccess, ask: boolean) =>
  planToolCall({
    tool,
    input: buildPlanInput(tool, { paneId: 'bp-1', ...args }, '/work/app'),
    policy: policy(ask),
    now: 1,
    browser: { pane: p, writesEnabled: true }
  })

const MOUSE_KEY: Array<[string, Record<string, unknown>]> = [
  ['browser_click', { ref: 's1e1' }],
  ['browser_press', { keys: ['Enter'] }],
  ['browser_type', { text: 'x', delayMs: 5 }],
  ['browser_type', { text: 'x', submit: true }]
]
const UNAFFECTED: Array<[string, Record<string, unknown>]> = [
  ['browser_type', { text: 'x' }],
  ['browser_fill', { fields: [{ ref: 's1e1', value: 'v' }] }],
  ['browser_eval', { expression: '1' }]
]

describe('which calls send mouse or key events', () => {
  it('click, press and a key-by-key or submitting type do; fill, a plain type and eval do not', () => {
    for (const [op, args] of MOUSE_KEY) expect(sendsPointerOrKeyEvents(op, args), op).toBe(true)
    for (const [op, args] of UNAFFECTED) expect(sendsPointerOrKeyEvents(op, args), op).toBe(false)
    expect(sendsPointerOrKeyEvents('browser_type', { text: 'x', delayMs: 0 })).toBe(false)
    expect(sendsPointerOrKeyEvents('browser_snapshot', {})).toBe(false)
  })
})

describe('at plan level (free mode and ask mode): a loud refusal, never a confirm', () => {
  for (const ask of [false, true]) {
    for (const [op, args] of MOUSE_KEY) {
      it(`${op} ${JSON.stringify(args)} on a first-document pane is PANE_INPUT_NOT_READY (ask=${ask})`, () => {
        const p = plan(op, args, pane(), ask)
        expect(p).toMatchObject({ verdict: 'deny', shouldConfirm: false, shouldDispatch: false })
        expect(p.auditRecord.result).toBe('PANE_INPUT_NOT_READY')
      })
    }
    for (const [op, args] of UNAFFECTED) {
      it(`${op} ${JSON.stringify(args)} is not refused for it (ask=${ask})`, () => {
        const p = plan(op, args, pane(), ask)
        expect(p.auditRecord.result).not.toBe('PANE_INPUT_NOT_READY')
        expect(p.verdict).not.toBe('deny')
      })
    }
  }

  it('is decided before a lease confirm on an external page: the operator is not asked first', () => {
    const p = plan('browser_click', { ref: 's1e1' }, pane({ originClass: 'external' }), true)
    expect(p).toMatchObject({ verdict: 'deny', shouldConfirm: false })
    expect(p.browserLeaseConfirm).toBeUndefined()
  })

  it('outranks the kill-switch, Pause and the Deny cooldown, and follows pane-not-found, Disconnect and content', () => {
    const run = (
      state: BrowserPaneAccess | undefined,
      writes = true,
      args: object = { ref: 's1e1' }
    ) =>
      gateBrowserOp('browser_click', {
        pane: state,
        writesEnabled: writes,
        args: { paneId: 'bp-1', ...args }
      })
    expect(run(pane(), false)).toBe('PANE_INPUT_NOT_READY')
    expect(run(pane({ paused: true, writeDenied: true, originClass: 'external' }))).toBe(
      'PANE_INPUT_NOT_READY'
    )
    expect(run(undefined)).toBe('PANE_NOT_FOUND')
    expect(run(pane({ disconnected: true }))).toBe('BROWSER_DISCONNECTED')
    expect(
      gateBrowserOp('browser_press', {
        pane: pane(),
        writesEnabled: true,
        args: { paneId: 'bp-1', keys: ['Banana'] }
      })
    ).toBe('BROWSER_KEY_UNKNOWN')
  })

  it('a pane that is ready (or whose readiness is unknown) is not affected', () => {
    expect(
      gateBrowserOp('browser_click', { pane: pane({ inputReady: true }), writesEnabled: true })
    ).toBeNull()
    const { inputReady: _unused, ...unknown } = pane()
    void _unused
    expect(gateBrowserOp('browser_click', { pane: unknown, writesEnabled: true })).toBeNull()
  })

  it('the shell resolves it into the gate input, true by default', () => {
    const base = {
      rec: {
        paneId: 'bp-1',
        folder: '/work/app',
        name: 'x',
        openedBy: 'agent' as const,
        partition: 'agent' as const,
        ownerSessionId: null,
        createdAt: 1,
        lastActiveAt: 1,
        seenHosts: new Set<string>(),
        flagged: null
      },
      liveUrl: 'http://localhost:3000/',
      writesEnabled: true,
      disconnected: false,
      paused: false,
      harnuPorts: [],
      trustedHosts: []
    }
    expect(resolveGateInput({ ...base, inputReady: false }).input.pane?.inputReady).toBe(false)
    expect(resolveGateInput(base).input.pane?.inputReady).toBe(true)
  })

  it('on an OPERATOR pane the hint says to ask the operator, never to reload it (plan and handler)', async () => {
    const p = plan(
      'browser_click',
      { ref: 's1e1' },
      pane({ openedBy: 'operator', readOptIn: true }),
      false
    )
    expect(p.auditRecord.result).toBe('PANE_INPUT_NOT_READY: operator-pane')
    const d = shapeDenial(p.auditRecord.result, { folder: '/work/app' })!
    expect(d.error).toBe('PANE_INPUT_NOT_READY')
    expect(d.nextActions[0]!.do).toContain('Ask the operator')
    expect(d.nextActions[0]!.do).toContain('Do not reload it yourself')
    expect(JSON.stringify(d)).not.toContain('action: "reload"')
    // an agent pane still gets the reload advice
    const agent = shapeDenial('PANE_INPUT_NOT_READY', { folder: '/work/app' })!
    expect(agent.nextActions[0]!.do).toContain('action: "reload"')
  })

  it('the refusal tells the agent the way forward: reload, and what still works', () => {
    const d = shapeDenial('PANE_INPUT_NOT_READY', { folder: '/work/app' })!
    expect(d.error).toBe('PANE_INPUT_NOT_READY')
    expect(d.nextActions[0]!.do).toContain('action: "reload"')
    expect(d.nextActions[1]!.do).toContain('browser_fill')
    expect(d.nextActions[1]!.do).toContain('browser_eval')
  })
})

describe('in the handler, re-checked right before dispatch (the pane can change while a call waits in the queue)', () => {
  function rig(ready: () => boolean) {
    const registry = createBrowserRegistry(() => 1)
    const log: string[] = []
    const readers = createPaneReaders({
      now: () => 1,
      send: async () => undefined,
      scrub: (t) => t,
      setTimer: () => 0,
      clearTimer: () => undefined,
      onCaptureChange: () => undefined
    })
    readers.refs.commit(
      readers.refs.nextSnapshotId(),
      new Map([[1, 20]]),
      new Map([[1, 'button|Save']])
    )
    registry.add({
      paneId: 'bp-1',
      folder: '/work/app',
      name: 'x',
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
        url: 'http://localhost:3000/',
        title: 't',
        loading: false,
        canGoBack: false,
        canGoForward: false
      }),
      navigate: vi.fn(),
      destroy: vi.fn(),
      publishFlag: vi.fn(),
      readers: () => readers,
      cdp: async (_id, method) => {
        log.push(method)
        if (method === 'DOM.resolveNode') return { object: { objectId: 'o' } }
        if (method === 'Runtime.callFunctionOn')
          return {
            result: {
              value: {
                rect: { x: 0, y: 0, width: 10, height: 10 },
                disabled: false,
                hit: 'self',
                editable: true,
                isSelect: false,
                tag: 'input'
              }
            }
          }
        if (method === 'Runtime.evaluate') return { result: { type: 'number', value: 2 } }
        if (method === 'Page.getLayoutMetrics')
          return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } }
        if (method === 'Accessibility.getPartialAXTree')
          return { nodes: [{ role: { value: 'button' }, name: { value: 'Save' } }] }
        return {}
      },
      viewMode: () => 'visible',
      deviceMode: () => false,
      capture: vi.fn(),
      viewToken: () => 'v',
      inputReady: ready
    }
    let clock = 1
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
      leases: new BrowserLeases(() => clock),
      readOptIn: async () => false
    }
    return { deps, log }
  }

  it('refuses click, press and key-by-key type and sends no event', async () => {
    const r = rig(() => false)
    for (const res of [
      await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps),
      await pressVerb({ paneId: 'bp-1', keys: ['Tab'] }, r.deps),
      await typeVerb({ paneId: 'bp-1', ref: 's1e1', text: 'x', delayMs: 5 }, r.deps),
      await typeVerb({ paneId: 'bp-1', ref: 's1e1', text: 'x', submit: true }, r.deps)
    ]) {
      expect(res).toMatchObject({ ok: false, error: 'PANE_INPUT_NOT_READY' })
    }
    expect(r.log.filter((m) => m.startsWith('Input.'))).toEqual([])
    expect(r.deps.registry.agentInput('bp-1').at).toBeNull()
  })

  it('still runs fill, a plain type and eval', async () => {
    const r = rig(() => false)
    expect(
      await fillVerb({ paneId: 'bp-1', fields: [{ ref: 's1e1', value: 'v' }] }, r.deps)
    ).toMatchObject({ ok: true })
    expect(await typeVerb({ paneId: 'bp-1', ref: 's1e1', text: 'x' }, r.deps)).toMatchObject({
      ok: true
    })
    expect(await evalVerb({ paneId: 'bp-1', expression: '1+1' }, r.deps)).toMatchObject({
      ok: true,
      value: 2
    })
  })

  it('runs once the pane is ready, and a pane that stops being ready while a call waits is refused before dispatch', async () => {
    let ready = true
    const r = rig(() => ready)
    const first = await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)
    expect(first).toMatchObject({ ok: true })
    // The queue wait sits between the two gate calls of one verb; flip the state exactly there.
    let gates = 0
    const original = r.deps.host.inputReady!
    r.deps.host.inputReady = (id) => (++gates >= 2 ? false : original(id))
    ready = true
    r.log.length = 0
    expect(await pressVerb({ paneId: 'bp-1', keys: ['Tab'] }, r.deps)).toMatchObject({
      ok: false,
      error: 'PANE_INPUT_NOT_READY'
    })
    expect(r.log.filter((m) => m.startsWith('Input.'))).toEqual([])
  })

  it('browser_list reports inputReady per pane', async () => {
    const r = rig(() => false)
    const rows = (await listVerb({}, r.deps)).panes as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({ paneId: 'bp-1', inputReady: false })
  })
})
