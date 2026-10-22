/**
 * T572 (browser pane U5, AC-4, AC-7, AC-8, AC-9) — the plan-level refusals of emulate, upload and download: judged
 * in their §6.3 slot (after the pane is known and not disconnected, BEFORE the kill-switch, Pause, the tier and any
 * confirm), so in `ask` mode and on a lease row they never raise a confirm.
 */
import { describe, it, expect } from 'vitest'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { checkBrowserContent } from '../src/main/browser/content-check'
import { resolveGateInput } from '../src/main/browser/gate-resolve'
import { shapeDenial } from '../src/main/mcp/deny-hint'
import type { BrowserGateInput, BrowserPaneAccess } from '../src/main/browser/access'
import type { BrowserPaneRecord } from '../src/main/browser/registry'
import { deviceFromPreset } from '../src/shared/browser-emulation'

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
const plan = (
  tool: 'browser_emulate' | 'browser_upload' | 'browser_download',
  args: Record<string, unknown>,
  browser: BrowserGateInput,
  ask = false
) =>
  planToolCall({
    tool,
    input: buildPlanInput(tool, { paneId: 'bp-1', ...args }, '/work/app'),
    policy: policy(ask),
    now: 1,
    browser
  })
const gate = (over: Partial<BrowserPaneAccess> = {}, writesEnabled = true): BrowserGateInput => ({
  pane: pane(over),
  writesEnabled
})
const never = { verdict: 'deny', shouldConfirm: false, shouldDispatch: false } as const

describe.each([false, true])('browser_emulate refusals at plan level, ask=%s', (ask) => {
  it('zoom while a device is active is ZOOM_IN_DEVICE_MODE and never confirms (AC-4)', () => {
    const p = plan('browser_emulate', { zoom: 1.5 }, gate({ deviceActive: true }), ask)
    expect(p).toMatchObject(never)
    expect(p.auditRecord.result).toMatch(/^ZOOM_IN_DEVICE_MODE: /)
  })

  it('…also on an operator pane where the tier is a lease', () => {
    const p = plan(
      'browser_emulate',
      { zoom: 1.5 },
      gate({ deviceActive: true, openedBy: 'operator', readOptIn: true }),
      ask
    )
    expect(p).toMatchObject(never)
    expect(p.auditRecord.result).toMatch(/^ZOOM_IN_DEVICE_MODE/)
  })

  it('device with explicit size args is BAD_ARGS and never confirms (AC-4)', () => {
    const p = plan('browser_emulate', { device: 'phone-m', width: 500 }, gate(), ask)
    expect(p).toMatchObject(never)
    expect(p.auditRecord.result).toMatch(/^BAD_ARGS: /)
  })

  it('the content refusal still wins over the kill-switch', () => {
    const p = plan('browser_emulate', { zoom: 2 }, gate({ deviceActive: true }, false), ask)
    expect(p.auditRecord.result).toMatch(/^ZOOM_IN_DEVICE_MODE/)
  })

  it('a good call with the kill-switch off is BROWSER_WRITES_DISABLED', () => {
    const p = plan('browser_emulate', { device: 'phone-m' }, gate({}, false), ask)
    expect(p.auditRecord.result).toBe('BROWSER_WRITES_DISABLED')
  })

  it('a good emulate on an agent pane is not refused', () => {
    const p = plan('browser_emulate', { device: 'phone-m' }, gate(), ask)
    expect(p.verdict).not.toBe('deny')
  })
})

describe('browser_upload and browser_download at plan level', () => {
  it('a forbidden upload path is UPLOAD_PATH_DENIED before any confirm (AC-7)', () => {
    for (const ask of [false, true]) {
      const p = plan('browser_upload', { ref: 's1e1', paths: ['.env'] }, gate(), ask)
      expect(p).toMatchObject(never)
      expect(p.auditRecord.result).toMatch(/^UPLOAD_PATH_DENIED: /)
    }
  })

  it('a path outside the pane folder is UPLOAD_PATH_DENIED at plan level, never a confirm (delta 1)', () => {
    for (const ask of [false, true]) {
      for (const paths of [['../etc/hostname'], ['/etc/hostname'], ['a/../../x']]) {
        const p = plan('browser_upload', { ref: 's1e1', paths }, gate({ folder: '/work/app' }), ask)
        expect(p, paths[0]).toMatchObject(never)
        expect(p.auditRecord.result).toMatch(/^UPLOAD_PATH_DENIED: .*outside/)
      }
    }
  })

  it('a path inside the folder is not refused at plan level', () => {
    const p = plan(
      'browser_upload',
      { ref: 's1e1', paths: ['fixtures/a.png'] },
      gate({ folder: '/work/app' })
    )
    expect(p.verdict).not.toBe('deny')
  })

  it('a right or middle click while touch is emulated is BAD_ARGS at plan level, never a confirm (delta 1)', () => {
    const click = (button: string, browser: BrowserGateInput, ask: boolean) =>
      planToolCall({
        tool: 'browser_click',
        input: buildPlanInput(
          'browser_click',
          { paneId: 'bp-1', ref: 's1e1', button },
          '/work/app'
        ),
        policy: policy(ask),
        now: 1,
        browser
      })
    for (const ask of [false, true]) {
      for (const button of ['right', 'middle']) {
        const p = click(button, gate({ touchActive: true }), ask)
        expect(p, button).toMatchObject(never)
        expect(p.auditRecord.result).toMatch(/^BAD_ARGS: Right and middle clicks do not exist/)
      }
    }
    expect(click('left', gate({ touchActive: true }), false).verdict).not.toBe('deny')
    expect(click('right', gate(), false).verdict).not.toBe('deny')
  })

  it('too many paths is BAD_ARGS', () => {
    const paths = Array.from({ length: 11 }, (_, i) => `f${i}.txt`)
    const p = plan('browser_upload', { ref: 's1e1', paths }, gate())
    expect(p.auditRecord.result).toMatch(/^BAD_ARGS/)
  })

  it('a download needs exactly one of url or ref, and a url must be http(s) (AC-8)', () => {
    expect(plan('browser_download', {}, gate()).auditRecord.result).toMatch(/^BAD_ARGS/)
    expect(
      plan('browser_download', { url: 'https://a.test/f', ref: 's1e1' }, gate()).auditRecord.result
    ).toMatch(/^BAD_ARGS/)
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/plain,hi',
      'ftp://a/f'
    ]) {
      const p = plan('browser_download', { url }, gate())
      expect(p).toMatchObject(never)
      expect(p.auditRecord.result).toBe('URL_SCHEME_BLOCKED')
    }
    expect(plan('browser_download', { url: 'https://a.test/f.zip' }, gate()).verdict).not.toBe(
      'deny'
    )
    expect(plan('browser_download', { ref: 's1e1' }, gate()).verdict).not.toBe('deny')
  })
})

describe('the denial the agent reads', () => {
  it('ZOOM_IN_DEVICE_MODE and UPLOAD_PATH_DENIED carry their detail and a next step', () => {
    const zoom = shapeDenial('ZOOM_IN_DEVICE_MODE: Zoom is off while a device is emulated.')
    expect(zoom?.error).toBe('ZOOM_IN_DEVICE_MODE')
    expect(zoom?.message).toContain('Zoom is off')
    expect(zoom?.nextActions[0]?.do).toContain('reset: true')
    const up = shapeDenial('UPLOAD_PATH_DENIED: .env: it is an .env file.')
    expect(up?.error).toBe('UPLOAD_PATH_DENIED')
    expect(up?.message).toContain('.env file')
  })

  it('every new code shapes without a detail too', () => {
    for (const code of [
      'ZOOM_IN_DEVICE_MODE',
      'EMULATION_FAILED',
      'NOT_A_FILE_INPUT',
      'UPLOAD_PATH_DENIED',
      'UPLOAD_TOO_LARGE',
      'NO_DOWNLOAD_STARTED',
      'DOWNLOAD_TOO_LARGE',
      'DOWNLOAD_FAILED',
      'DOWNLOAD_CANCELLED'
    ]) {
      const d = shapeDenial(code)
      expect(d?.error, code).toBe(code)
      expect(d?.nextActions.length, code).toBeGreaterThan(0)
    }
  })
})

describe('content check, pure', () => {
  it('browser_open takes a preset device, refuses anything else', () => {
    expect(
      checkBrowserContent('browser_open', { url: 'http://localhost:1', device: 'tablet' })
    ).toBeNull()
    expect(
      checkBrowserContent('browser_open', { url: 'http://localhost:1', device: 'galaxy' })?.code
    ).toBe('BAD_ARGS')
  })

  it('deviceActive reaches the emulate rule through the context', () => {
    expect(checkBrowserContent('browser_emulate', { zoom: 2 }, { deviceActive: true })?.code).toBe(
      'ZOOM_IN_DEVICE_MODE'
    )
    expect(checkBrowserContent('browser_emulate', { zoom: 2 })).toBeNull()
  })
})

describe('resolveGateInput', () => {
  const rec = (emulation?: BrowserPaneRecord['emulation']): BrowserPaneRecord => ({
    paneId: 'bp-1',
    folder: '/work/app',
    name: 'browser',
    openedBy: 'agent',
    partition: 'agent',
    ownerSessionId: null,
    createdAt: 1,
    lastActiveAt: 1,
    seenHosts: new Set(),
    flagged: null,
    ...(emulation ? { emulation } : {})
  })
  const base = {
    liveUrl: 'http://localhost:5173/',
    writesEnabled: true,
    disconnected: false,
    paused: false,
    harnuPorts: [],
    trustedHosts: []
  }

  it('says whether the pane emulates a device, from the registry record', () => {
    expect(
      resolveGateInput({ ...base, rec: rec({ device: deviceFromPreset('phone-m') }) }).input.pane
        ?.deviceActive
    ).toBe(true)
    expect(
      resolveGateInput({ ...base, rec: rec({ colorScheme: 'dark' }) }).input.pane?.deviceActive
    ).toBe(false)
    expect(resolveGateInput({ ...base, rec: rec() }).input.pane?.deviceActive).toBe(false)
  })

  it('carries the touch state and the pane folder, for the plan-level click and upload rules', () => {
    const touchOn = resolveGateInput({ ...base, rec: rec({ device: deviceFromPreset('phone-m') }) })
      .input.pane
    expect(touchOn).toMatchObject({ touchActive: true, folder: '/work/app' })
    const touchOff = resolveGateInput({ ...base, rec: rec({ device: deviceFromPreset('laptop') }) })
      .input.pane
    expect(touchOff?.touchActive).toBe(false)
    expect(resolveGateInput({ ...base, rec: rec({ touch: true }) }).input.pane?.touchActive).toBe(
      true
    )
  })
})
