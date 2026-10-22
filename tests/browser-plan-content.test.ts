/**
 * T568 delta 2 (AC-7, spec §6.3) — the CONTENT refusals (BAD_ARGS exactly-one form, URL_SCHEME_BLOCKED,
 * NOT_YET_AVAILABLE) are judged at plan level, in their documented slot: after the pane is known and not
 * disconnected, BEFORE the kill-switch, Pause, the tier and any confirm. In `ask` mode they must never raise a
 * confirm; with the kill-switch off the content refusal still wins over BROWSER_WRITES_DISABLED.
 */
import { describe, it, expect } from 'vitest'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { checkBrowserContent } from '../src/main/browser/content-check'
import type { BrowserGateInput, BrowserPaneAccess } from '../src/main/browser/access'

const pane = (over: Partial<BrowserPaneAccess> = {}): BrowserPaneAccess => ({
  openedBy: 'agent',
  originClass: 'local',
  disconnected: false,
  paused: false,
  ...over
})
const policy = (ask: boolean): Parameters<typeof planToolCall>[0]['policy'] => ({
  serverEnabled: true,
  ask,
  denyFolders: [],
  knownRoots: ['/work']
})
const open = (args: Record<string, unknown>, browser: BrowserGateInput, ask: boolean) =>
  planToolCall({
    tool: 'browser_open',
    input: buildPlanInput('browser_open', { folder: '/work/app', ...args }, '/work/app'),
    policy: policy(ask),
    now: 1,
    browser
  })
const navigate = (args: Record<string, unknown>, browser: BrowserGateInput, ask: boolean) =>
  planToolCall({
    tool: 'browser_navigate',
    input: buildPlanInput('browser_navigate', { paneId: 'bp-1', ...args }, '/work/app'),
    policy: policy(ask),
    now: 1,
    browser
  })

const on: BrowserGateInput = { pane: undefined, writesEnabled: true }
const off: BrowserGateInput = { pane: undefined, writesEnabled: false }
const withPane = (over: Partial<BrowserGateInput> = {}): BrowserGateInput => ({
  pane: pane(),
  writesEnabled: true,
  ...over
})

describe('checkBrowserContent (pure)', () => {
  it('passes a good open and a good navigate', () => {
    expect(
      checkBrowserContent('browser_open', { folder: '/w', url: 'http://localhost:3000' })
    ).toBeNull()
    expect(checkBrowserContent('browser_navigate', { paneId: 'p', action: 'reload' })).toBeNull()
    expect(checkBrowserContent('browser_close', { paneId: 'p' })).toBeNull()
  })

  it('judges exactly-one-form, availability and the scheme in that order', () => {
    expect(checkBrowserContent('browser_open', { folder: '/w' })?.code).toBe('BAD_ARGS')
    expect(
      checkBrowserContent('browser_open', { folder: '/w', url: 'http://a.test', path: 'a.html' })
        ?.code
    ).toBe('BAD_ARGS')
    expect(checkBrowserContent('browser_open', { folder: '/w', path: 'a.html' })?.code).toBe(
      'NOT_YET_AVAILABLE'
    )
    expect(checkBrowserContent('browser_open', { folder: '/w', html: '<p>' })?.code).toBe(
      'NOT_YET_AVAILABLE'
    )
    expect(
      checkBrowserContent('browser_open', { folder: '/w', url: 'http://a.test', device: 'phone-m' })
        ?.code
    ).toBe('NOT_YET_AVAILABLE')
    expect(
      checkBrowserContent('browser_open', { folder: '/w', url: 'javascript:alert(1)' })
    ).toMatchObject({
      code: 'URL_SCHEME_BLOCKED',
      scheme: 'javascript'
    })
    expect(
      checkBrowserContent('browser_open', {
        folder: '/w',
        url: 'harnu-page://f0123456789ab/a.html'
      })?.code
    ).toBe('NOT_YET_AVAILABLE')
  })

  it('judges navigate: exactly one of url/action, and the scheme of a url', () => {
    expect(checkBrowserContent('browser_navigate', { paneId: 'p' })?.code).toBe('BAD_ARGS')
    expect(
      checkBrowserContent('browser_navigate', { paneId: 'p', url: 'http://a.test', action: 'back' })
        ?.code
    ).toBe('BAD_ARGS')
    expect(
      checkBrowserContent('browser_navigate', { paneId: 'p', url: 'file:///etc/passwd' })?.code
    ).toBe('URL_SCHEME_BLOCKED')
  })
})

describe.each([false, true])('content refusals at plan level, ask=%s', (ask) => {
  const never = { verdict: 'deny', shouldConfirm: false, shouldDispatch: false } as const

  it.each([
    ['file:', 'file:///etc/passwd'],
    ['javascript:', 'javascript:alert(1)'],
    ['chrome:', 'chrome://settings'],
    ['view-source:', 'view-source:https://example.com']
  ])('browser_open %s is URL_SCHEME_BLOCKED and never confirms', (_n, url) => {
    const plan = open({ url }, on, ask)
    expect(plan).toMatchObject(never)
    expect(plan.auditRecord.result).toBe('URL_SCHEME_BLOCKED')
  })

  it('browser_open with no form or two forms is BAD_ARGS and never confirms', () => {
    for (const args of [{}, { url: 'http://localhost:3000', path: 'a.html' }]) {
      const plan = open(args, on, ask)
      expect(plan).toMatchObject(never)
      expect(plan.auditRecord.result).toMatch(/^BAD_ARGS: Pass exactly one/)
    }
  })

  it('browser_open path / html / device is NOT_YET_AVAILABLE and never confirms', () => {
    for (const args of [
      { path: 'docs/a.html' },
      { html: '<p>x</p>', name: 'p' },
      { url: 'http://localhost:3000', device: 'phone-m' }
    ]) {
      const plan = open(args, on, ask)
      expect(plan).toMatchObject(never)
      expect(plan.auditRecord.result).toBe('NOT_YET_AVAILABLE')
    }
  })

  it('browser_navigate: a blocked scheme and a bad target never confirm', () => {
    const blocked = navigate({ url: 'file:///etc/hosts' }, withPane(), ask)
    expect(blocked).toMatchObject(never)
    expect(blocked.auditRecord.result).toBe('URL_SCHEME_BLOCKED')
    const none = navigate({}, withPane(), ask)
    expect(none).toMatchObject(never)
    expect(none.auditRecord.result).toMatch(/^BAD_ARGS/)
    const both = navigate({ url: 'http://localhost:1', action: 'reload' }, withPane(), ask)
    expect(both.auditRecord.result).toMatch(/^BAD_ARGS/)
  })

  it('with the kill-switch OFF the content refusal still wins over BROWSER_WRITES_DISABLED', () => {
    expect(open({ url: 'javascript:alert(1)' }, off, ask).auditRecord.result).toBe(
      'URL_SCHEME_BLOCKED'
    )
    expect(open({ path: 'a.html' }, off, ask).auditRecord.result).toBe('NOT_YET_AVAILABLE')
    expect(open({}, off, ask).auditRecord.result).toMatch(/^BAD_ARGS/)
    expect(
      navigate({ url: 'file:///x' }, withPane({ writesEnabled: false }), ask).auditRecord.result
    ).toBe('URL_SCHEME_BLOCKED')
    // …and a GOOD call under the kill-switch is still BROWSER_WRITES_DISABLED.
    expect(open({ url: 'http://localhost:3000' }, off, ask).auditRecord.result).toBe(
      'BROWSER_WRITES_DISABLED'
    )
  })

  it('keeps the earlier slots: unknown pane and Disconnect outrank the content check', () => {
    expect(
      navigate({ url: 'file:///x' }, { pane: undefined, writesEnabled: true }, ask).auditRecord
        .result
    ).toBe('PANE_NOT_FOUND')
    expect(
      navigate({ url: 'file:///x' }, withPane({ pane: pane({ disconnected: true }) }), ask)
        .auditRecord.result
    ).toBe('BROWSER_DISCONNECTED')
  })

  it('and the content check outranks Pause and the operator-pane tier', () => {
    expect(
      navigate({ url: 'file:///x' }, withPane({ pane: pane({ paused: true }) }), ask).auditRecord
        .result
    ).toBe('URL_SCHEME_BLOCKED')
    expect(
      navigate(
        { url: 'file:///x' },
        withPane({ pane: pane({ openedBy: 'operator', readOptIn: true }) }),
        ask
      ).auditRecord.result
    ).toBe('URL_SCHEME_BLOCKED')
  })
})

describe('a good call is unaffected', () => {
  it('runs free, and asks in ask mode', () => {
    expect(open({ url: 'http://localhost:3000' }, on, false)).toMatchObject({ verdict: 'allow' })
    expect(open({ url: 'http://localhost:3000' }, on, true)).toMatchObject({
      verdict: 'confirm',
      shouldConfirm: true
    })
  })
})
