/**
 * T571 (browser pane U4, AC-2…AC-6, AC-10) — the five acting verbs over a fake CDP host: eval, click, type, fill,
 * press. ACK shapes, the actionability refusals, the fit scale, `agentInput` stamping, the lease re-check, the
 * write queue, scrubbing and the untrusted-content note.
 */
import { describe, it, expect, vi } from 'vitest'
import { createBrowserAccess } from '../src/main/browser/access'
import { createBrowserRegistry } from '../src/main/browser/registry'
import { createPaneReaders } from '../src/main/browser/pane-readers'
import { BrowserLeases } from '../src/main/browser/lease'
import { BrowserWriteQueue } from '../src/main/browser/write-queue'
import {
  clickVerb,
  evalVerb,
  fillVerb,
  pressVerb,
  typeVerb,
  type BrowserActDeps,
  type BrowserActHost
} from '../src/main/browser/act-verbs'
import type { ElementProbe } from '../src/main/browser/act-plan'
import { BROWSER_NOTE, type LivePaneInfo } from '../src/main/browser/verbs-core'

const FOLDER = '/work/app'
const BTN = 20
const INPUT = 21
const SELECT = 22

const okProbe = (over: Partial<ElementProbe> = {}): ElementProbe => ({
  rect: { x: 10, y: 20, width: 100, height: 40 },
  disabled: false,
  hit: 'self',
  editable: false,
  isSelect: false,
  tag: 'button',
  ...over
})

function rig(
  opts: {
    openedBy?: 'agent' | 'operator'
    url?: string
    probe?: (backend: number) => ElementProbe
    leaseActive?: boolean
    readOptIn?: boolean
    writes?: boolean
    scale?: number
    evalReply?: (p: Record<string, unknown>) => unknown
    onCdp?: (method: string) => void
  } = {}
) {
  let clock = 1_000
  const live = new Map<string, LivePaneInfo>()
  const registry = createBrowserRegistry(() => clock)
  const access = createBrowserAccess(() => clock)
  const leases = new BrowserLeases(() => clock)
  const log: Array<[string, Record<string, unknown>]> = []
  const objects = new Map<string, number>()
  const readers = createPaneReaders({
    now: () => clock,
    send: async () => undefined,
    scrub: (t) => t,
    setTimer: () => 0,
    clearTimer: () => undefined,
    onCaptureChange: () => undefined
  })
  // A snapshot made the refs: s1e1 → button, s1e2 → input, s1e3 → select.
  readers.refs.commit(
    readers.refs.nextSnapshotId(),
    new Map([
      [1, BTN],
      [2, INPUT],
      [3, SELECT]
    ]),
    new Map([
      [1, 'button|Save'],
      [2, 'textbox|Email'],
      [3, 'combobox|Plan']
    ])
  )
  const axName: Record<number, [string, string]> = {
    [BTN]: ['button', 'Save'],
    [INPUT]: ['textbox', 'Email'],
    [SELECT]: ['combobox', 'Plan']
  }
  const gone = new Set<number>()
  const cdp = vi.fn(async (_id: string, method: string, params: Record<string, unknown> = {}) => {
    log.push([method, params])
    opts.onCdp?.(method)
    switch (method) {
      case 'DOM.resolveNode': {
        const b = params.backendNodeId as number
        if (gone.has(b)) throw new Error('Could not find node with given id')
        objects.set(`obj-${b}`, b)
        return { object: { objectId: `obj-${b}` } }
      }
      case 'DOM.scrollIntoViewIfNeeded':
      case 'DOM.focus':
      case 'Input.dispatchMouseEvent':
      case 'Input.dispatchKeyEvent':
      case 'Input.insertText':
      case 'Runtime.releaseObjectGroup':
      case 'Runtime.terminateExecution':
        return {}
      case 'Page.getLayoutMetrics':
        return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } }
      case 'Accessibility.getPartialAXTree': {
        const [role, name] = axName[params.backendNodeId as number] ?? ['generic', '']
        return { nodes: [{ role: { value: role }, name: { value: name } }] }
      }
      case 'Runtime.callFunctionOn': {
        const backend = objects.get(params.objectId as string)
        const fn = String(params.functionDeclaration)
        if (fn.includes('isSelect')) {
          return {
            result: {
              value:
                opts.probe?.(backend ?? 0) ??
                okProbe(
                  backend === INPUT
                    ? { editable: true, tag: 'input' }
                    : backend === SELECT
                      ? { isSelect: true, tag: 'select' }
                      : {}
                )
            }
          }
        }
        if (fn.includes('JSON.stringify')) return { result: { value: '{"a":[1,2]}' } }
        if (fn.includes('this.options'))
          return { result: { value: params.arguments ? true : false } }
        return { result: { value: true } }
      }
      case 'Runtime.evaluate':
        return (opts.evalReply ?? (() => ({ result: { type: 'number', value: 42 } })))(params)
      case 'Page.getFrameTree':
        return {
          frameTree: {
            frame: { id: 'F1', url: 'http://localhost/' },
            childFrames: [{ frame: { id: 'F2', name: 'pay', url: 'https://pay.example.com/x' } }]
          }
        }
      default:
        throw new Error(`no fake for ${method}`)
    }
  })
  const host: BrowserActHost = {
    create: vi.fn(),
    info: (id) => live.get(id),
    navigate: vi.fn(),
    destroy: vi.fn(),
    publishFlag: vi.fn(),
    readers: (id) => (live.has(id) ? readers : undefined),
    cdp: (id, method, params) => cdp(id, method, (params ?? {}) as Record<string, unknown>),
    viewMode: () => 'visible',
    deviceMode: () => false,
    capture: vi.fn(),
    viewToken: () => 'view-1',
    inputScale: () => opts.scale ?? 1,
    drive: vi.fn()
  }
  const deps: BrowserActDeps = {
    now: () => clock,
    newPaneId: () => 'bp-x',
    registry,
    access,
    host,
    writesEnabled: async () => opts.writes ?? true,
    trustedHosts: () => [],
    harnuPorts: () => [41999],
    sessionKnown: () => true,
    showPane: vi.fn(async () => true),
    hidePane: vi.fn(async () => true),
    scrub: (t) => t.replace(/\/home\/u/g, '~'),
    alias: (f) => f.split('/').pop() ?? f,
    folderBlocked: () => false,
    sleep: async (ms) => void (clock += ms),
    saveShot: vi.fn(),
    leases,
    readOptIn: async () => opts.readOptIn ?? false,
    queue: new BrowserWriteQueue()
  }
  registry.add({
    paneId: 'bp-1',
    folder: FOLDER,
    name: 'app',
    openedBy: opts.openedBy ?? 'agent',
    partition: opts.openedBy === 'operator' ? 'operator' : 'agent',
    ownerSessionId: null,
    createdAt: 1,
    lastActiveAt: 1,
    seenHosts: new Set(),
    flagged: null
  })
  live.set('bp-1', {
    url: opts.url ?? 'http://localhost:5173/app?token=abc',
    title: 'App',
    loading: false,
    canGoBack: false,
    canGoForward: false
  })
  if (opts.leaseActive) leases.grant('bp-1', FOLDER, 'view-1')
  return {
    deps,
    registry,
    access,
    leases,
    host,
    cdp,
    log,
    gone,
    readers,
    live,
    tick: (ms: number) => (clock += ms)
  }
}

const calls = (log: Array<[string, Record<string, unknown>]>, method: string) =>
  log.filter(([m]) => m === method).map(([, p]) => p)

describe('browser_click', () => {
  it('scrolls, waits for the element, then moves, presses and releases at its centre', async () => {
    const r = rig()
    const res = await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)
    expect(res).toMatchObject({
      ok: true,
      paneId: 'bp-1',
      origin: 'local',
      target: { role: 'button', name: 'Save' },
      snapshotStale: false,
      othersWrote: false,
      operatorInteracted: false,
      note: BROWSER_NOTE
    })
    expect(calls(r.log, 'DOM.scrollIntoViewIfNeeded').length).toBeGreaterThan(0)
    const mouse = calls(r.log, 'Input.dispatchMouseEvent')
    expect(mouse.map((m) => m.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(mouse[1]).toMatchObject({ x: 60, y: 40, button: 'left', clickCount: 1 })
  })

  it('multiplies by the fit scale while a device is active (A5)', async () => {
    const r = rig({ scale: 0.5 })
    await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)
    expect(calls(r.log, 'Input.dispatchMouseEvent')[1]).toMatchObject({ x: 30, y: 20 })
  })

  it('aims at an offset inside the box, and refuses one outside it before clicking', async () => {
    const r = rig()
    await clickVerb({ paneId: 'bp-1', ref: 's1e1', offset: { x: 5, y: 5 } }, r.deps)
    expect(calls(r.log, 'Input.dispatchMouseEvent')[1]).toMatchObject({ x: 15, y: 25 })
    const bad = rig()
    expect(
      await clickVerb({ paneId: 'bp-1', ref: 's1e1', offset: { x: 500, y: 5 } }, bad.deps)
    ).toMatchObject({
      ok: false,
      error: 'OFFSET_OUTSIDE_BOX'
    })
    expect(calls(bad.log, 'Input.dispatchMouseEvent')).toEqual([])
  })

  it.each([
    ['ELEMENT_NOT_VISIBLE', okProbe({ rect: null })],
    ['ELEMENT_OBSCURED', okProbe({ hit: 'other' })],
    ['ELEMENT_DISABLED', okProbe({ disabled: true })]
  ])('refuses %s after waiting 5 s, and clicks nothing', async (code, probe) => {
    const r = rig({ probe: () => probe })
    expect(await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)).toMatchObject({
      ok: false,
      error: code
    })
    expect(calls(r.log, 'Input.dispatchMouseEvent')).toEqual([])
  })

  it('waits for an overlay to go away instead of refusing at once', async () => {
    let n = 0
    const r = rig({ probe: () => (n++ < 3 ? okProbe({ hit: 'other' }) : okProbe()) })
    expect(await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)).toMatchObject({ ok: true })
  })

  it('REF_NOT_FOUND for an unknown ref, REF_STALE for a dead or vanished one', async () => {
    const r = rig()
    expect(await clickVerb({ paneId: 'bp-1', ref: 'nope' }, r.deps)).toMatchObject({
      error: 'REF_NOT_FOUND'
    })
    expect(await clickVerb({ paneId: 'bp-1', ref: 's9e1' }, r.deps)).toMatchObject({
      error: 'REF_NOT_FOUND'
    })
    r.gone.add(BTN)
    expect(await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)).toMatchObject({
      error: 'REF_STALE'
    })
    r.readers.refs.invalidate()
    expect(await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)).toMatchObject({
      error: 'REF_STALE'
    })
  })

  it('says snapshotStale when the element no longer looks like it did in the snapshot', async () => {
    const r = rig()
    r.readers.refs.commit(
      r.readers.refs.nextSnapshotId(),
      new Map([[1, BTN]]),
      new Map([[1, 'button|Cancel']])
    )
    expect(await clickVerb({ paneId: 'bp-1', ref: 's2e1' }, r.deps)).toMatchObject({
      ok: true,
      snapshotStale: true
    })
  })

  it('stamps agentInput for the whole run and ends it afterwards (the seam the emit gate reads)', async () => {
    const r = rig()
    let during: ReturnType<typeof r.registry.agentInput> | null = null
    r.cdp.mockImplementationOnce(async () => {
      during = r.registry.agentInput('bp-1')
      return {}
    })
    await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)
    expect(during).toMatchObject({ inFlight: true })
    expect(r.registry.agentInput('bp-1')).toMatchObject({ inFlight: false })
    expect(r.registry.lastAgentInputAt('bp-1')).not.toBeNull()
    // …and also when the click is refused halfway.
    const bad = rig({ probe: () => okProbe({ disabled: true }) })
    await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, bad.deps)
    expect(bad.registry.agentInput('bp-1').inFlight).toBe(false)
    expect(bad.registry.agentInput('bp-1').at).not.toBeNull()
  })

  it('reports that the operator used the pane during the call', async () => {
    const hook: { fn: (m: string) => void } = { fn: () => undefined }
    const r = rig({ onCdp: (m) => hook.fn(m) })
    hook.fn = (m) => {
      if (m === 'Input.dispatchMouseEvent') r.registry.noteOperatorInteraction('bp-1')
    }
    expect(await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)).toMatchObject({
      ok: true,
      operatorInteracted: true
    })
  })
})

describe('the lease (spec §7.1) as the handler re-checks it', () => {
  it('an external page without a lease is BROWSER_LEASE_ENDED for every acting verb, and nothing is sent', async () => {
    const r = rig({ url: 'https://example.com/' })
    for (const res of [
      await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps),
      await typeVerb({ paneId: 'bp-1', text: 'x' }, r.deps),
      await fillVerb({ paneId: 'bp-1', fields: [{ ref: 's1e2', value: 'x' }] }, r.deps),
      await pressVerb({ paneId: 'bp-1', keys: ['Enter'] }, r.deps),
      await evalVerb({ paneId: 'bp-1', expression: '1' }, r.deps)
    ]) {
      expect(res).toMatchObject({ ok: false, error: 'BROWSER_LEASE_ENDED' })
    }
    expect(r.log.filter(([m]) => m.startsWith('Input.') || m === 'Runtime.evaluate')).toEqual([])
    expect(r.registry.agentInput('bp-1').at).toBeNull()
  })

  it('with the lease active the same call runs, and it refreshes the lease clock', async () => {
    const r = rig({ url: 'https://example.com/', leaseActive: true })
    r.tick(9 * 60_000)
    expect(await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)).toMatchObject({
      ok: true,
      origin: 'external'
    })
    r.tick(9 * 60_000)
    expect(r.leases.isActive('bp-1', 'view-1')).toBe(true)
  })

  it('a pane the operator opened needs the folder opt-in first, then the lease', async () => {
    const closed = rig({ openedBy: 'operator' })
    expect(await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, closed.deps)).toMatchObject({
      error: 'BROWSER_READ_NOT_ENABLED'
    })
    const noLease = rig({ openedBy: 'operator', readOptIn: true })
    expect(await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, noLease.deps)).toMatchObject({
      error: 'BROWSER_LEASE_ENDED'
    })
    const leased = rig({ openedBy: 'operator', readOptIn: true, leaseActive: true })
    expect(await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, leased.deps)).toMatchObject({
      ok: true
    })
  })

  it('turning the read opt-in off ends the lease behind it', async () => {
    const r = rig({ openedBy: 'operator', readOptIn: false, leaseActive: true })
    await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps)
    expect(r.leases.isActive('bp-1', 'view-1')).toBe(false)
  })

  it('a Deny cooldown refuses BROWSER_WRITE_DENIED on a lease row only', async () => {
    const r = rig({ url: 'https://example.com/' })
    r.leases.deny('bp-1')
    expect(await evalVerb({ paneId: 'bp-1', expression: '1' }, r.deps)).toMatchObject({
      error: 'BROWSER_WRITE_DENIED'
    })
    const local = rig()
    local.leases.deny('bp-1')
    expect(await evalVerb({ paneId: 'bp-1', expression: '1' }, local.deps)).toMatchObject({
      ok: true
    })
  })

  it('Disconnect, Pause and the kill-switch refuse before anything is sent', async () => {
    const d = rig()
    d.access.disconnect('bp-1')
    expect(await clickVerb({ paneId: 'bp-1', ref: 's1e1' }, d.deps)).toMatchObject({
      error: 'BROWSER_DISCONNECTED'
    })
    const p = rig()
    p.access.pause('bp-1')
    expect(await evalVerb({ paneId: 'bp-1', expression: '1' }, p.deps)).toMatchObject({
      error: 'BROWSER_PAUSED'
    })
    const k = rig({ writes: false })
    expect(await pressVerb({ paneId: 'bp-1', keys: ['Enter'] }, k.deps)).toMatchObject({
      error: 'BROWSER_WRITES_DISABLED'
    })
    expect(await clickVerb({ paneId: 'nope', ref: 's1e1' }, k.deps)).toMatchObject({
      error: 'PANE_NOT_FOUND'
    })
  })
})

describe('browser_type', () => {
  it('focuses the element then inserts the text in one go', async () => {
    const r = rig()
    const res = await typeVerb({ paneId: 'bp-1', ref: 's1e2', text: 'a@b.c' }, r.deps)
    expect(res).toMatchObject({
      ok: true,
      typedChars: 5,
      target: { role: 'textbox', name: 'Email' }
    })
    expect(calls(r.log, 'DOM.focus')).toEqual([{ backendNodeId: INPUT }])
    expect(calls(r.log, 'Input.insertText')).toEqual([{ text: 'a@b.c' }])
  })

  it('types into whatever has focus when no ref is given, and presses Enter for submit', async () => {
    const r = rig()
    await typeVerb({ paneId: 'bp-1', text: 'hi', submit: true }, r.deps)
    expect(calls(r.log, 'DOM.focus')).toEqual([])
    expect(calls(r.log, 'Input.dispatchKeyEvent').map((e) => e.type)).toEqual(['keyDown', 'keyUp'])
  })

  it('types one character at a time with delayMs', async () => {
    const r = rig()
    await typeVerb({ paneId: 'bp-1', text: 'ab', delayMs: 10 }, r.deps)
    expect(calls(r.log, 'Input.insertText')).toEqual([])
    expect(calls(r.log, 'Input.dispatchKeyEvent').map((e) => `${e.type}:${e.key}`)).toEqual([
      'keyDown:a',
      'keyUp:a',
      'keyDown:b',
      'keyUp:b'
    ])
  })

  it('refuses a button as ELEMENT_NOT_EDITABLE', async () => {
    const r = rig()
    expect(await typeVerb({ paneId: 'bp-1', ref: 's1e1', text: 'x' }, r.deps)).toMatchObject({
      error: 'ELEMENT_NOT_EDITABLE'
    })
    expect(calls(r.log, 'Input.insertText')).toEqual([])
  })
})

describe('browser_fill', () => {
  it('replaces a text field and sets a select, checking every ref first', async () => {
    const r = rig()
    const res = await fillVerb(
      {
        paneId: 'bp-1',
        fields: [
          { ref: 's1e2', value: 'me@x.io' },
          { ref: 's1e3', value: 'pro' }
        ]
      },
      r.deps
    )
    expect(res).toMatchObject({ ok: true })
    expect((res.filled as unknown[]).length).toBe(2)
    expect(calls(r.log, 'Input.insertText')).toEqual([{ text: 'me@x.io' }])
  })

  it('touches nothing when a later ref is dead', async () => {
    const r = rig()
    const res = await fillVerb(
      {
        paneId: 'bp-1',
        fields: [
          { ref: 's1e2', value: 'x' },
          { ref: 's7e1', value: 'y' }
        ]
      },
      r.deps
    )
    expect(res).toMatchObject({ ok: false, error: 'REF_NOT_FOUND' })
    expect(calls(r.log, 'Input.insertText')).toEqual([])
  })

  it('clears a field with an empty value', async () => {
    const r = rig()
    await fillVerb({ paneId: 'bp-1', fields: [{ ref: 's1e2', value: '' }] }, r.deps)
    expect(calls(r.log, 'Input.insertText')).toEqual([])
    expect(calls(r.log, 'Input.dispatchKeyEvent').map((e) => e.key)).toContain('Backspace')
  })
})

describe('browser_press', () => {
  it('dispatches each chord as down + up with its modifiers', async () => {
    const r = rig()
    const res = await pressVerb({ paneId: 'bp-1', keys: ['Tab', 'Ctrl+A'] }, r.deps)
    expect(res).toMatchObject({ ok: true, pressed: ['Tab', 'Ctrl+A'] })
    const ev = calls(r.log, 'Input.dispatchKeyEvent')
    expect(ev).toHaveLength(4)
    expect(ev[2]).toMatchObject({ type: 'rawKeyDown', modifiers: 2, code: 'KeyA' })
  })

  it('refuses an unknown key name before pressing anything', async () => {
    const r = rig()
    const res = await pressVerb({ paneId: 'bp-1', keys: ['Enter', 'Banana'] }, r.deps)
    expect(res).toMatchObject({ ok: false, error: 'BROWSER_KEY_UNKNOWN' })
    expect(calls(r.log, 'Input.dispatchKeyEvent')).toEqual([])
  })
})

describe('browser_eval', () => {
  it('returns a primitive result', async () => {
    const r = rig()
    expect(await evalVerb({ paneId: 'bp-1', expression: '6*7' }, r.deps)).toMatchObject({
      ok: true,
      value: 42,
      type: 'number',
      truncated: false,
      note: BROWSER_NOTE
    })
    expect(calls(r.log, 'Runtime.evaluate')[0]).toMatchObject({
      expression: '6*7',
      awaitPromise: true,
      returnByValue: false
    })
  })

  it('serialises an object in the page and parses it', async () => {
    const r = rig({ evalReply: () => ({ result: { type: 'object', objectId: 'o1' } }) })
    expect(await evalVerb({ paneId: 'bp-1', expression: '({a:[1,2]})' }, r.deps)).toMatchObject({
      value: { a: [1, 2] },
      type: 'object'
    })
  })

  it('a throw is ok:true with thrown', async () => {
    const r = rig({
      evalReply: () => ({
        result: { type: 'object', subtype: 'error' },
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'Error: boom at /home/u/app.js:1\n    at <anonymous>:1:1' }
        }
      })
    })
    const res = await evalVerb({ paneId: 'bp-1', expression: 'throw new Error("boom")' }, r.deps)
    expect(res).toMatchObject({ ok: true, thrown: { message: 'Error: boom at ~/app.js:1' } })
    expect((res.thrown as { stack: string }).stack).toContain('<anonymous>')
  })

  it('caps the value at 64 KiB and says so', async () => {
    const big = 'x'.repeat(70_000)
    const r = rig({ evalReply: () => ({ result: { type: 'string', value: big } }) })
    const res = await evalVerb({ paneId: 'bp-1', expression: 'big' }, r.deps)
    expect(res.truncated).toBe(true)
    expect(Buffer.byteLength(res.value as string)).toBeLessThanOrEqual(64 * 1024)
  })

  it('gives the description of something that cannot be serialised', async () => {
    const r = rig({
      evalReply: () => ({
        result: { type: 'function', objectId: 'f', description: 'function f(){}' }
      })
    })
    r.cdp.mockImplementation(async (_id, method, params = {}) => {
      if (method === 'Runtime.callFunctionOn') return { result: {} }
      if (method === 'Runtime.evaluate')
        return { result: { type: 'function', objectId: 'f', description: 'function f(){}' } }
      return {}
    })
    expect(await evalVerb({ paneId: 'bp-1', expression: 'f' }, r.deps)).toMatchObject({
      serializable: false,
      value: 'function f(){}'
    })
  })

  it('stops a script that never settles with EVAL_TIMEOUT and terminates execution', async () => {
    const r = rig({ evalReply: () => new Promise(() => undefined) })
    const res = await evalVerb(
      { paneId: 'bp-1', expression: 'await new Promise(()=>{})', timeoutMs: 200 },
      r.deps
    )
    expect(res).toMatchObject({ ok: false, error: 'EVAL_TIMEOUT' })
    expect(calls(r.log, 'Runtime.terminateExecution')).toHaveLength(1)
  })

  it('runs in a named child frame, and refuses one that does not exist', async () => {
    const r = rig()
    r.readers.contexts.ingest('Runtime.executionContextCreated', {
      context: { id: 7, auxData: { frameId: 'F2', isDefault: true } }
    })
    await evalVerb({ paneId: 'bp-1', expression: '1', frame: 'pay' }, r.deps)
    expect(calls(r.log, 'Runtime.evaluate')[0]).toMatchObject({ contextId: 7 })
    expect(await evalVerb({ paneId: 'bp-1', expression: '1', frame: 'zzz' }, r.deps)).toMatchObject(
      {
        error: 'FRAME_NOT_FOUND'
      }
    )
  })

  it('counts as agent input for the emit gate', async () => {
    const r = rig()
    await evalVerb({ paneId: 'bp-1', expression: '1' }, r.deps)
    expect(r.registry.agentInput('bp-1').at).not.toBeNull()
  })
})

describe('the write queue (spec §6.4) around the acting verbs', () => {
  it('serialises two clicks on one pane and tells the second that another write ran', async () => {
    const r = rig()
    const order: string[] = []
    r.cdp.mockImplementation(async (_id, method, params = {}) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed')
        order.push('press')
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased')
        order.push('release')
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-20' } }
      if (method === 'Page.getLayoutMetrics')
        return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } }
      if (method === 'Accessibility.getPartialAXTree')
        return { nodes: [{ role: { value: 'button' }, name: { value: 'Save' } }] }
      if (method === 'Runtime.callFunctionOn') return { result: { value: okProbe() } }
      return {}
    })
    const [a, b] = await Promise.all([
      clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps, {}),
      clickVerb({ paneId: 'bp-1', ref: 's1e1' }, r.deps, {})
    ])
    expect(a).toMatchObject({ ok: true })
    expect(b).toMatchObject({ ok: true })
    // never interleaved: press, release, press, release
    expect(order).toEqual(['press', 'release', 'press', 'release'])
  })

  it('refuses the 61st write inside a minute with BROWSER_RATE_LIMIT', async () => {
    const r = rig()
    r.deps.queue = new BrowserWriteQueue(undefined, { ratePerMin: 2 })
    await pressVerb({ paneId: 'bp-1', keys: ['Tab'] }, r.deps)
    await pressVerb({ paneId: 'bp-1', keys: ['Tab'] }, r.deps)
    expect(await pressVerb({ paneId: 'bp-1', keys: ['Tab'] }, r.deps)).toMatchObject({
      ok: false,
      error: 'BROWSER_RATE_LIMIT'
    })
  })
})
