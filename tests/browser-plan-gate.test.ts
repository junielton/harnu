/**
 * T568 (browser pane U1, AC-7, AC-9) — the browser access rules at PLAN level: a refused call is a plain deny
 * that never confirms and never dispatches, in `ask` mode too (spec §6.3), in the documented order; a free call
 * on an agent pane runs; the steering hints name the way forward.
 */
import { describe, it, expect } from 'vitest'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { shapeDenial } from '../src/main/mcp/deny-hint'
import { BROWSER_DENIAL_CODES } from '../src/main/browser/browser-hints'
import type { BrowserGateInput, BrowserPaneAccess } from '../src/main/browser/access'

const pane = (over: Partial<BrowserPaneAccess> = {}): BrowserPaneAccess => ({
  openedBy: 'agent',
  originClass: 'local',
  disconnected: false,
  paused: false,
  ...over
})
const gate = (over: Partial<BrowserGateInput> = {}): BrowserGateInput => ({
  pane: pane(),
  writesEnabled: true,
  ...over
})
const policy = (ask: boolean): Parameters<typeof planToolCall>[0]['policy'] => ({
  serverEnabled: true,
  ask,
  denyFolders: [],
  knownRoots: ['/work']
})
const navigate = (browser?: BrowserGateInput, ask = false): ReturnType<typeof planToolCall> =>
  planToolCall({
    tool: 'browser_navigate',
    input: buildPlanInput(
      'browser_navigate',
      { paneId: 'bp-1', url: 'http://localhost:3000' },
      '/work/app'
    ),
    policy: policy(ask),
    now: 1,
    ...(browser ? { browser } : {})
  })

describe('browser plan gate', () => {
  it('lets a navigate on a free agent pane through (free mode) and confirms it in ask mode', () => {
    expect(navigate(gate())).toMatchObject({ verdict: 'allow', shouldDispatch: true })
    expect(navigate(gate(), true)).toMatchObject({ verdict: 'confirm', shouldConfirm: true })
  })

  it.each([
    ['PANE_NOT_FOUND', gate({ pane: undefined })],
    ['BROWSER_DISCONNECTED', gate({ pane: pane({ disconnected: true }) })],
    ['BROWSER_WRITES_DISABLED', gate({ writesEnabled: false })],
    ['BROWSER_PAUSED', gate({ pane: pane({ paused: true }) })],
    ['BROWSER_READ_NOT_ENABLED', gate({ pane: pane({ openedBy: 'operator' }) })]
  ])(
    '%s is a deny that never confirms and never dispatches, free and ask mode alike',
    (code, state) => {
      for (const ask of [false, true]) {
        const plan = navigate(state, ask)
        expect(plan).toMatchObject({ verdict: 'deny', shouldConfirm: false, shouldDispatch: false })
        expect(plan.auditRecord.result).toBe(code)
        expect(plan.auditRecord.disclosedPayloadSummary).toBe('none')
      }
    }
  )

  it('fails closed when the shell did not resolve the pane', () => {
    expect(navigate(undefined).auditRecord.result).toBe('PANE_NOT_FOUND')
  })

  it('walks the documented order: pane, Disconnect, kill-switch, Pause, tier', () => {
    const run = (state: BrowserGateInput): string => navigate(state).auditRecord.result
    expect(run(gate({ pane: undefined, writesEnabled: false }))).toBe('PANE_NOT_FOUND')
    expect(
      run(gate({ pane: pane({ disconnected: true, paused: true }), writesEnabled: false }))
    ).toBe('BROWSER_DISCONNECTED')
    expect(
      run(
        gate({
          pane: pane({ paused: true, openedBy: 'operator', readOptIn: true }),
          writesEnabled: false
        })
      )
    ).toBe('BROWSER_WRITES_DISABLED')
    expect(run(gate({ pane: pane({ paused: true, openedBy: 'operator', readOptIn: true }) }))).toBe(
      'BROWSER_PAUSED'
    )
  })

  it('keeps browser_list and browser_close working with the kill-switch off', () => {
    const list = planToolCall({
      tool: 'browser_list',
      input: buildPlanInput('browser_list', {}, undefined),
      policy: policy(false),
      now: 1,
      browser: gate({ pane: undefined, writesEnabled: false })
    })
    expect(list.verdict).toBe('allow')
    const close = planToolCall({
      tool: 'browser_close',
      input: buildPlanInput('browser_close', { paneId: 'bp-1' }, '/work/app'),
      policy: policy(false),
      now: 1,
      browser: gate({ writesEnabled: false })
    })
    expect(close.verdict).toBe('allow')
  })

  it('refuses browser_open under the kill-switch before any confirm', () => {
    const plan = planToolCall({
      tool: 'browser_open',
      input: buildPlanInput(
        'browser_open',
        { folder: '/work/app', url: 'http://localhost:3000' },
        '/work/app'
      ),
      policy: policy(true),
      now: 1,
      browser: gate({ pane: undefined, writesEnabled: false })
    })
    expect(plan).toMatchObject({ verdict: 'deny', shouldConfirm: false })
    expect(plan.auditRecord.result).toBe('BROWSER_WRITES_DISABLED')
  })

  it('the operator block and the server kill-switch still outrank the browser gate', () => {
    const blocked = planToolCall({
      tool: 'browser_navigate',
      input: buildPlanInput(
        'browser_navigate',
        { paneId: 'bp-1', url: 'http://x.test' },
        '/work/app'
      ),
      policy: { ...policy(false), denyFolders: ['/work/app'] },
      now: 1,
      browser: gate({ pane: undefined })
    })
    expect(blocked.auditRecord.result).toBe('FOLDER_NOT_ALLOWED')
    const off = planToolCall({
      tool: 'browser_navigate',
      input: buildPlanInput(
        'browser_navigate',
        { paneId: 'bp-1', url: 'http://x.test' },
        '/work/app'
      ),
      policy: { ...policy(false), serverEnabled: false },
      now: 1,
      browser: gate({ pane: undefined })
    })
    expect(off.auditRecord.result).toBe('SERVER_DISABLED')
  })
})

describe('browser refusals steer', () => {
  it.each(BROWSER_DENIAL_CODES)('%s carries a message and at least one next action', (code) => {
    const hint = shapeDenial(code, { folder: '/work/app' })
    expect(hint?.error).toBe(code)
    expect(hint?.message.length).toBeGreaterThan(10)
    expect(hint?.nextActions.length).toBeGreaterThan(0)
  })
})

describe('browser audit line (spec §3.2, §7.5)', () => {
  const summary = (plan: ReturnType<typeof navigate>): string =>
    plan.auditRecord.disclosedPayloadSummary

  it('a navigation is audited with pane id, origin class and host only: no path, query or fragment', () => {
    const plan = navigate(gate(), false)
    expect(summary(plan)).toBe('browser_navigate pane=bp-1 origin=local host=localhost:3000')
    const secret = planToolCall({
      tool: 'browser_navigate',
      input: buildPlanInput(
        'browser_navigate',
        { paneId: 'bp-1', url: 'https://user:pw@docs.example.com/a/b?token=s3cret#frag' },
        '/work/app'
      ),
      policy: policy(false),
      now: 1,
      browser: gate()
    })
    expect(summary(secret)).toBe('browser_navigate pane=bp-1 origin=external host=docs.example.com')
    for (const leak of ['s3cret', '/a/b', 'frag', 'user', 'pw']) {
      expect(summary(secret)).not.toContain(leak)
    }
  })

  it('an open is audited the same way, and an action navigate carries the pane origin', () => {
    const open = planToolCall({
      tool: 'browser_open',
      input: buildPlanInput(
        'browser_open',
        { folder: '/work/app', url: 'http://localhost:5173/checkout?x=1' },
        '/work/app'
      ),
      policy: policy(false),
      now: 1,
      browser: gate({ pane: undefined })
    })
    expect(summary(open)).toBe('browser_open origin=local host=localhost:5173')
    const reload = planToolCall({
      tool: 'browser_navigate',
      input: buildPlanInput('browser_navigate', { paneId: 'bp-1', action: 'reload' }, '/work/app'),
      policy: policy(false),
      now: 1,
      browser: gate({ pane: pane({ originClass: 'external' }) })
    })
    expect(summary(reload)).toBe('browser_navigate pane=bp-1 origin=external')
  })

  it('a hostile pane id cannot pass for another field', () => {
    const plan = planToolCall({
      tool: 'browser_close',
      input: buildPlanInput(
        'browser_close',
        { paneId: 'bp-1 host=evil.com\norigin=local' },
        '/work/app'
      ),
      policy: policy(false),
      now: 1,
      browser: gate()
    })
    expect(summary(plan)).not.toMatch(/\n|host=evil/)
  })

  it('a refusal says nothing about the call', () => {
    expect(summary(navigate(gate({ writesEnabled: false }), false))).toBe('none')
  })
})

describe("the audit classifies with the gate's own inputs (delta 3)", () => {
  const nav = (url: string, classify?: BrowserGateInput['classify']): string =>
    planToolCall({
      tool: 'browser_navigate',
      input: buildPlanInput('browser_navigate', { paneId: 'bp-1', url }, '/work/app'),
      policy: policy(false),
      now: 1,
      browser: { ...gate(), ...(classify ? { classify } : {}) }
    }).auditRecord.disclosedPayloadSummary

  it("a URL on one of Harnu's own ports is audited external, exactly as the gate classifies it", () => {
    expect(nav('http://localhost:9222/json', { harnuPorts: [9222] })).toBe(
      'browser_navigate pane=bp-1 origin=external host=localhost:9222'
    )
    expect(nav('http://localhost:9222/json')).toBe(
      'browser_navigate pane=bp-1 origin=local host=localhost:9222'
    )
  })

  it('and a folder trusted host is audited local', () => {
    expect(nav('http://shop.test/', { extraTrustedHosts: ['*.test'] })).toBe(
      'browser_navigate pane=bp-1 origin=local host=shop.test'
    )
    expect(nav('http://shop.test/')).toBe(
      'browser_navigate pane=bp-1 origin=external host=shop.test'
    )
  })
})

/* ---- T570 (U3): the reading verbs at plan level -------------------------------------------------- */

const plan = (
  tool: string,
  args: Record<string, unknown>,
  state: BrowserGateInput | undefined,
  ask = false
): ReturnType<typeof planToolCall> =>
  planToolCall({
    tool,
    input: buildPlanInput(tool as never, { paneId: 'bp-1', ...args }, '/work/app'),
    policy: policy(ask),
    now: 1,
    ...(state ? { browser: state } : {})
  })

const READS: Array<[string, Record<string, unknown>]> = [
  ['browser_snapshot', {}],
  ['browser_screenshot', {}],
  ['browser_console', {}],
  ['browser_wait_for', { text: 'x' }]
]

describe('browser reading verbs at plan level', () => {
  it.each(READS)(
    '%s runs on a free agent pane, and with the kill-switch off or while paused',
    (tool, args) => {
      expect(plan(tool, args, gate())).toMatchObject({ verdict: 'allow', shouldDispatch: true })
      expect(plan(tool, args, gate({ writesEnabled: false })).verdict).toBe('allow')
      expect(plan(tool, args, gate({ pane: pane({ paused: true }) })).verdict).toBe('allow')
    }
  )

  it.each(READS)(
    '%s on a pane the operator opened is BROWSER_READ_NOT_ENABLED, never a confirm',
    (tool, args) => {
      for (const ask of [false, true]) {
        const p = plan(tool, args, gate({ pane: pane({ openedBy: 'operator' }) }), ask)
        expect(p).toMatchObject({ verdict: 'deny', shouldConfirm: false, shouldDispatch: false })
        expect(p.auditRecord.result).toBe('BROWSER_READ_NOT_ENABLED')
      }
    }
  )

  it.each(READS)(
    '%s on a disconnected or unknown pane is refused in the documented order',
    (tool, args) => {
      expect(plan(tool, args, gate({ pane: undefined })).auditRecord.result).toBe('PANE_NOT_FOUND')
      expect(
        plan(tool, args, gate({ pane: pane({ disconnected: true, openedBy: 'operator' }) }))
          .auditRecord.result
      ).toBe('BROWSER_DISCONNECTED')
    }
  )

  it.each([
    ['browser_snapshot', { maxNodes: 5000 }],
    ['browser_screenshot', { maxDim: 4000 }],
    ['browser_screenshot', { ref: 'a', selector: 'b' }],
    ['browser_console', { lines: 900 }],
    ['browser_console', { mode: 'since' }],
    ['browser_network', { action: 'start', maxMinutes: 31 }],
    ['browser_network', { action: 'read', limit: 501 }],
    ['browser_wait_for', { text: 'x', timeoutMs: 999999 }],
    ['browser_wait_for', { url: '(' }],
    ['browser_wait_for', { url: '(a+)+$' }],
    ['browser_wait_for', { url: '(a|aa)+$' }],
    ['browser_wait_for', {}]
  ])(
    '%s %j is BAD_ARGS before the kill-switch and before any confirm, in ask mode too',
    (tool, args) => {
      for (const ask of [false, true]) {
        const p = plan(tool, args, gate({ writesEnabled: false }), ask)
        expect(p).toMatchObject({ verdict: 'deny', shouldConfirm: false, shouldDispatch: false })
        expect(p.auditRecord.result).toMatch(/^BAD_ARGS/)
      }
    }
  )

  it('browser_network is a write: it refuses under the kill-switch for every action, before any confirm', () => {
    for (const action of ['start', 'read', 'stop']) {
      for (const ask of [false, true]) {
        const off = plan('browser_network', { action }, gate({ writesEnabled: false }), ask)
        expect(off).toMatchObject({ verdict: 'deny', shouldConfirm: false })
        expect(off.auditRecord.result).toBe('BROWSER_WRITES_DISABLED')
      }
    }
  })

  it('while paused, browser_network start is refused, but read and stop still work (they only reduce what is observed)', () => {
    for (const ask of [false, true]) {
      const paused = gate({ pane: pane({ paused: true }) })
      const start = plan('browser_network', { action: 'start' }, paused, ask)
      expect(start).toMatchObject({ verdict: 'deny', shouldConfirm: false, shouldDispatch: false })
      expect(start.auditRecord.result).toBe('BROWSER_PAUSED')
      for (const action of ['read', 'stop']) {
        const p = plan('browser_network', { action }, paused, ask)
        expect(p.auditRecord.result, action).not.toBe('BROWSER_PAUSED')
        expect(p.shouldDispatch || p.shouldConfirm, action).toBe(true)
      }
    }
  })

  it('a paused operator-opened pane is still BROWSER_READ_NOT_ENABLED for network read', () => {
    const p = plan(
      'browser_network',
      { action: 'read' },
      gate({ pane: pane({ paused: true, openedBy: 'operator' }) })
    )
    expect(p.auditRecord.result).toBe('BROWSER_READ_NOT_ENABLED')
  })

  it('browser_network runs free on an agent pane and is a normal confirm in ask mode', () => {
    expect(plan('browser_network', { action: 'start' }, gate())).toMatchObject({
      verdict: 'allow',
      shouldDispatch: true
    })
    expect(plan('browser_network', { action: 'start' }, gate(), true)).toMatchObject({
      verdict: 'confirm',
      shouldConfirm: true
    })
  })

  it('browser_network on an operator pane is BROWSER_READ_NOT_ENABLED, ahead of the lease placeholder', () => {
    const p = plan(
      'browser_network',
      { action: 'read' },
      gate({ pane: pane({ openedBy: 'operator' }) }),
      true
    )
    expect(p.auditRecord.result).toBe('BROWSER_READ_NOT_ENABLED')
    expect(p.shouldConfirm).toBe(false)
  })
})
