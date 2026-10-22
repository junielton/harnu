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
    ['NOT_YET_AVAILABLE', gate({ pane: pane({ openedBy: 'operator' }) })]
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
      run(gate({ pane: pane({ paused: true, openedBy: 'operator' }), writesEnabled: false }))
    ).toBe('BROWSER_WRITES_DISABLED')
    expect(run(gate({ pane: pane({ paused: true, openedBy: 'operator' }) }))).toBe('BROWSER_PAUSED')
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
