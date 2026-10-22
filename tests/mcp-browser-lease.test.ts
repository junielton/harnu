/**
 * T571 (browser pane U4, AC-2, AC-9, AC-10) — the browser lease driven through the REAL `handleToolCall` pipeline
 * with the real confirm core, registry, lease table, write queue and browser service. Only `electron` and the
 * Electron view host are stubbed (a fake page that answers the CDP commands the verbs send).
 *
 * Free mode: a lease row confirms once, an Allow performs nothing (BROWSER_APPROVED_RESEND), then the next call
 * runs under the lease. Ask mode: every write confirms, a lease lets the lease rows through, a free row stays a
 * normal confirm that DOES act. Deny: BROWSER_WRITE_DENIED with no new prompt. Content refusals never confirm.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const h = vi.hoisted(() => ({
  userDataDir: '',
  open: '',
  blocked: '',
  denied: [] as string[],
  optedIn: [] as string[],
  /** paneId → live url */
  pages: new Map<string, string>(),
  cdp: [] as Array<[string, Record<string, unknown>]>,
  tokens: new Map<string, string>()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.userDataDir,
    commandLine: { getSwitchValue: (): string => '' }
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  WebContentsView: class {},
  session: {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanFolders: async (): Promise<unknown[]> => []
}))
vi.mock('../src/main/user-projects', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUserProjects: async (): Promise<unknown> => ({
    projects: [
      ...h.denied.map((p) => ({ path: p, agentDenied: true })),
      { path: h.open, ...(h.optedIn.includes(h.open) ? { agentBrowserRead: true } : {}) }
    ]
  })
}))

vi.mock('../src/main/browser/view-host', async () => {
  const { createPaneReaders } = await import('../src/main/browser/pane-readers')
  const readers = new Map<string, ReturnType<typeof createPaneReaders>>()
  const mk = (): ReturnType<typeof createPaneReaders> => {
    const r = createPaneReaders({
      now: () => Date.now(),
      send: async () => undefined,
      scrub: (t) => t,
      setTimer: () => 0,
      clearTimer: () => undefined,
      onCaptureChange: () => undefined
    })
    r.refs.commit(r.refs.nextSnapshotId(), new Map([[1, 20]]), new Map([[1, 'button|Pay now']]))
    return r
  }
  class FakeHost {
    create(): void {
      /* a fake view host: nothing to do */
    }
    info(paneId: string) {
      const url = h.pages.get(paneId)
      return url === undefined
        ? undefined
        : { url, title: 'Page', loading: false, canGoBack: false, canGoForward: false }
    }
    async navigate(): Promise<never> {
      throw new Error('not used')
    }
    destroy(): void {
      /* a fake view host: nothing to do */
    }
    publishFlag(): void {
      /* a fake view host: nothing to do */
    }
    refresh(): void {
      /* a fake view host: nothing to do */
    }
    readers(paneId: string) {
      if (!h.pages.has(paneId)) return undefined
      if (!readers.has(paneId)) readers.set(paneId, mk())
      return readers.get(paneId)
    }
    viewToken(paneId: string): string | undefined {
      return h.pages.has(paneId) ? (h.tokens.get(paneId) ?? 'view-1') : undefined
    }
    inputScale(): number {
      return 1
    }
    drive(): void {
      /* a fake view host: nothing to do */
    }
    viewMode(): string {
      return 'visible'
    }
    deviceMode(): boolean {
      return false
    }
    captureStatus(): { active: boolean; expiresAt: null } {
      return { active: false, expiresAt: null }
    }
    async cdp(_id: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      h.cdp.push([method, params])
      switch (method) {
        case 'DOM.resolveNode':
          return { object: { objectId: 'obj_20' } }
        case 'Page.getLayoutMetrics':
          return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } }
        case 'Accessibility.getPartialAXTree':
          return { nodes: [{ role: { value: 'button' }, name: { value: 'Pay now' } }] }
        case 'Runtime.callFunctionOn':
          return {
            result: {
              value: {
                rect: { x: 0, y: 0, width: 100, height: 40 },
                disabled: false,
                hit: 'self',
                editable: false,
                isSelect: false,
                tag: 'button'
              }
            }
          }
        case 'Runtime.evaluate':
          return { result: { type: 'number', value: 42 } }
        default:
          return {}
      }
    }
  }
  return { BrowserViewHost: FakeHost, collectHarnuPorts: (): number[] => [] }
})

import { handleToolCall, registerMcpServer, closeMcpServer } from '../src/main/mcp/server'
import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import {
  createConfirmCore,
  CONFIRM_WINDOW_MS,
  PARK_TTL_MS,
  type ConfirmCore,
  type ConfirmWire
} from '../src/main/mcp/confirm-core'
import { browserAccess, browserLeases, browserRegistry } from '../src/main/browser/browser-service'
import { browserWriteQueue } from '../src/main/browser/write-queue'
import { writeAgentBrowserWrites, writeMcpAsk } from '../src/main/mcp/prefs'
import { getAuditLog, clearAuditLog } from '../src/main/mcp/audit-log'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { _resetIdempotencyRegistry } from '../src/main/mcp/idempotency-registry'
import { _resetInflightRegistry } from '../src/main/mcp/inflight-session-registry'
import { OBSERVE_MCP_DENY } from '../src/main/scheduler-core'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import type { MissionGrant } from '../src/main/mcp/grant-core'

const def = (op: string): (typeof WIRED_TOOLS)[number] => WIRED_TOOLS.find((t) => t.op === op)!
const approvalDef = def('get_approval')

let confirm: ConfirmCore
let wires: ConfirmWire[] = []

function body(res: CallToolResult): Record<string, unknown> {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  try {
    return JSON.parse(first.text)
  } catch {
    return { error: first.text }
  }
}

const call = (op: string, args: Record<string, unknown>): Promise<CallToolResult> =>
  handleToolCall(def(op), args)
const click = (paneId = 'bp-ext', ref = 's1e1'): Promise<CallToolResult> =>
  call('browser_click', { paneId, ref })
const inputEvents = (): number =>
  h.cdp.filter(([m]) => m === 'Input.dispatchMouseEvent' || m === 'Input.dispatchKeyEvent').length
const auditResults = (): string[] => getAuditLog().map((r) => r.result)

function addPane(
  paneId: string,
  url: string,
  openedBy: 'agent' | 'operator' = 'agent',
  folder = h.open
): void {
  browserRegistry.add({
    paneId,
    folder,
    name: 'pane',
    openedBy,
    partition: openedBy === 'operator' ? 'operator' : 'agent',
    ownerSessionId: null,
    createdAt: 1,
    lastActiveAt: 1,
    seenHosts: new Set(),
    flagged: null
  })
  h.pages.set(paneId, url)
}

async function confirmRaised(n: number): Promise<ConfirmWire> {
  await vi.waitFor(() => expect(wires.length).toBeGreaterThanOrEqual(n))
  return wires[n - 1]!
}

/** Same wait under fake timers (setTimeout only): the pipeline reads real files before it parks. */
async function confirmRaisedFake(n: number): Promise<ConfirmWire> {
  for (let i = 0; i < 2_000 && wires.length < n; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(1)
  }
  expect(wires.length).toBeGreaterThanOrEqual(n)
  return wires[n - 1]!
}

async function confirmAndAnswer(
  run: () => Promise<CallToolResult>,
  verdict: 'allow' | 'deny'
): Promise<Record<string, unknown>> {
  const before = wires.length
  const pending = run()
  const wire = await confirmRaised(before + 1)
  confirm.respond(wire.id, verdict)
  return body(await pending)
}

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-blease-ud-'))
  h.open = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-blease-open-'))
  h.blocked = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-blease-blocked-'))
})

beforeEach(async () => {
  h.cdp.length = 0
  h.pages.clear()
  h.tokens.clear()
  h.denied = []
  h.optedIn = []
  wires = []
  for (const r of browserRegistry.list()) browserRegistry.remove(r.paneId)
  confirm = createConfirmCore({
    send: (wire) => {
      wires.push(wire)
      return true
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now()
  })
  await registerMcpServer(() => null, {
    bridge: { dispatch: vi.fn(async () => ({})) } as never,
    confirm
  })
  browserLeases.revokeAll()
  clearAuditLog()
  _resetIdempotencyRegistry()
  _resetInflightRegistry()
  await writeMcpAsk(false)
  await writeAgentBrowserWrites(true)
  addPane('bp-ext', 'https://shop.example.com/cart?token=s3cret')
  addPane('bp-loc', 'http://localhost:5173/app')
})

afterEach(() => {
  vi.useRealTimers()
  confirm.rejectAll()
  browserWriteQueue.prune(() => false)
  browserLeases.revokeAll()
  // A Deny cooldown outlives `revokeAll` by design, so forget every pane this file used.
  for (const id of ['bp-ext', 'bp-ext2', 'bp-loc', 'bp-op', 'bp-blk']) {
    browserLeases.forget(id)
    browserAccess.forget(id)
  }
})

describe('free mode: an external page is a lease row', () => {
  it('the first call confirms with the pane, site, first action and the warning; Allow performs NOTHING', async () => {
    const pending = click()
    const wire = await confirmRaised(1)
    expect(wire.prompt).toContain('An agent wants to drive a browser pane.')
    expect(wire.prompt).toContain('Site: shop.example.com (external)')
    expect(wire.prompt).toContain('click button "Pay now" (s1e1)')
    expect(wire.prompt).toContain('What an agent types runs as you on this page.')
    expect(wire.prompt).not.toContain('s3cret')
    expect(wire.alwaysAllowOffer).toBe(false)
    confirm.respond(wire.id, 'allow')
    const res = body(await pending)
    expect(res).toMatchObject({ ok: false, error: 'BROWSER_APPROVED_RESEND' })
    expect(inputEvents()).toBe(0)
    expect(browserLeases.isActive('bp-ext', 'view-1')).toBe(true)
  })

  it('then every writer’s next call runs under the lease with no prompt, audited LEASE', async () => {
    await confirmAndAnswer(() => click(), 'allow')
    const next = body(await click())
    expect(next).toMatchObject({ ok: true, target: { role: 'button', name: 'Pay now' } })
    expect(body(await call('browser_eval', { paneId: 'bp-ext', expression: '6*7' }))).toMatchObject(
      {
        ok: true,
        value: 42
      }
    )
    expect(wires).toHaveLength(1)
    expect(inputEvents()).toBeGreaterThan(0)
    expect(auditResults().filter((r) => r === 'LEASE: bp-ext')).toHaveLength(2)
  })

  it('the lease covers that pane only', async () => {
    await confirmAndAnswer(() => click(), 'allow')
    addPane('bp-ext2', 'https://other.example.org/')
    const pending = click('bp-ext2')
    const wire = await confirmRaised(2)
    confirm.respond(wire.id, 'deny')
    expect(body(await pending).error).toBe('BROWSER_WRITE_DENIED')
  })

  it('a local pane runs free: no confirm, audited AGENT_ALLOWED', async () => {
    const res = body(await click('bp-loc'))
    expect(res).toMatchObject({ ok: true, origin: 'local' })
    expect(wires).toHaveLength(0)
    expect(auditResults()).toContain('AGENT_ALLOWED')
  })

  it('Deny refuses BROWSER_WRITE_DENIED and starts a cooldown: the next call is refused with no new prompt', async () => {
    const first = await confirmAndAnswer(() => click(), 'deny')
    expect(first.error).toBe('BROWSER_WRITE_DENIED')
    const again = body(await call('browser_eval', { paneId: 'bp-ext', expression: '1' }))
    expect(again.error).toBe('BROWSER_WRITE_DENIED')
    expect(wires).toHaveLength(1)
    expect(inputEvents()).toBe(0)
    // a local pane is untouched by it
    expect(body(await click('bp-loc')).ok).toBe(true)
  })

  it('a navigation to another host does not end the lease; the class is re-read at every call', async () => {
    await confirmAndAnswer(() => click(), 'allow')
    h.pages.set('bp-ext', 'http://localhost:3000/')
    // now local: free anyway, no prompt
    expect(body(await click()).ok).toBe(true)
    expect(wires).toHaveLength(1)
  })
})

describe('what ends a lease', () => {
  it('Disconnect, close, the kill-switch and a new view each end it; the next call asks again', async () => {
    await confirmAndAnswer(() => click(), 'allow')
    browserAccess.disconnect('bp-ext')
    browserLeases.revoke('bp-ext')
    expect(body(await click()).error).toBe('BROWSER_DISCONNECTED')
    browserAccess.forget('bp-ext')

    await confirmAndAnswer(() => click(), 'allow')
    h.tokens.set('bp-ext', 'view-2') // the pane id now names a different page
    const pending = click()
    const wire = await confirmRaised(3)
    confirm.respond(wire.id, 'deny')
    await pending
    browserLeases.forget('bp-ext') // end the Deny cooldown so the next phase can ask again

    h.tokens.delete('bp-ext')
    await confirmAndAnswer(() => click(), 'allow')
    await writeAgentBrowserWrites(false)
    expect(body(await click()).error).toBe('BROWSER_WRITES_DISABLED')
    expect(browserLeases.isActive('bp-ext', 'view-1')).toBe(false)
  })

  it('10 idle minutes end it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await confirmAndAnswer(() => click(), 'allow')
    expect(browserLeases.isActive('bp-ext', 'view-1')).toBe(true)
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1)
    expect(browserLeases.isActive('bp-ext', 'view-1')).toBe(false)
  })

  it('an Allow that arrives after the pane was disconnected grants nothing', async () => {
    const pending = click()
    const wire = await confirmRaised(1)
    browserAccess.disconnect('bp-ext')
    confirm.respond(wire.id, 'allow')
    expect(body(await pending).error).toBe('BROWSER_DISCONNECTED')
    expect(browserLeases.isActive('bp-ext', 'view-1')).toBe(false)
  })

  it('an Allow for one view does not lease the page that replaced it', async () => {
    const pending = click()
    const wire = await confirmRaised(1)
    h.tokens.set('bp-ext', 'view-2')
    confirm.respond(wire.id, 'allow')
    expect(body(await pending).error).toBe('PANE_NOT_FOUND')
    expect(browserLeases.isActive('bp-ext', 'view-2')).toBe(false)
  })

  it('a blocked folder refuses before any confirm', async () => {
    addPane('bp-blk', 'https://x.example.com/', 'agent', h.blocked)
    h.denied = [h.blocked]
    const res = body(await click('bp-blk'))
    expect(res.error).toBe('FOLDER_NOT_ALLOWED')
    expect(wires).toHaveLength(0)
  })
})

describe('ask mode', () => {
  it('a FREE row (a local pane) is a normal confirm and an Allow DOES act', async () => {
    await writeMcpAsk(true)
    const res = await confirmAndAnswer(() => click('bp-loc'), 'allow')
    expect(res).toMatchObject({ ok: true })
    expect(inputEvents()).toBeGreaterThan(0)
  })

  it('a LEASE row confirms, an Allow grants the lease and performs nothing, then the lease carries it', async () => {
    await writeMcpAsk(true)
    const first = await confirmAndAnswer(() => click(), 'allow')
    expect(first.error).toBe('BROWSER_APPROVED_RESEND')
    expect(inputEvents()).toBe(0)
    const res = await click()
    expect(body(res).ok).toBe(true)
    expect(res.isError).toBeFalsy()
    expect(wires).toHaveLength(1)
    expect(auditResults()).toContain('LEASE: bp-ext')
  })

  it('a free row in ask mode is NOT carried by a lease on the same pane: it is still a normal confirm', async () => {
    await writeMcpAsk(true)
    await confirmAndAnswer(() => click(), 'allow') // lease
    h.pages.set('bp-ext', 'http://localhost:3000/') // now a free row
    const pending = click()
    const wire = await confirmRaised(2)
    expect(wire.prompt).not.toContain('An agent wants to drive a browser pane.')
    confirm.respond(wire.id, 'allow')
    expect(body(await pending).ok).toBe(true)
  })
})

describe('content refusals come before the kill-switch and any confirm (spec §6.3)', () => {
  it.each([false, true])(
    'an unknown key on an external pane never prompts (ask=%s)',
    async (ask) => {
      await writeMcpAsk(ask)
      const res = body(await call('browser_press', { paneId: 'bp-ext', keys: ['Enter', 'Banana'] }))
      expect(res.error).toBe('BROWSER_KEY_UNKNOWN')
      expect(String(res.message)).toContain('"Banana"')
      expect(wires).toHaveLength(0)
    }
  )

  it('with the kill-switch off a bad key still says what is wrong, not "writes disabled"', async () => {
    await writeAgentBrowserWrites(false)
    const res = body(await call('browser_press', { paneId: 'bp-ext', keys: ['Banana'] }))
    expect(res.error).toBe('BROWSER_KEY_UNKNOWN')
  })

  it('a malformed call (too many fields) is BAD_ARGS before anything', async () => {
    const fields = Array.from({ length: 21 }, () => ({ ref: 's1e1', value: 'x' }))
    const res = body(await call('browser_fill', { paneId: 'bp-ext', fields }))
    expect(String(res.error)).toMatch(/BAD_ARGS/)
    expect(wires).toHaveLength(0)
  })
})

describe('operator-opened panes (spec §7.1)', () => {
  it('without the folder opt-in every verb is BROWSER_READ_NOT_ENABLED and nothing prompts', async () => {
    addPane('bp-op', 'https://mail.example.com/', 'operator')
    for (const op of ['browser_click', 'browser_eval', 'browser_navigate']) {
      const res = body(
        await call(op, {
          paneId: 'bp-op',
          ref: 's1e1',
          expression: '1',
          url: 'http://localhost:1/'
        })
      )
      expect(res.error, op).toBe('BROWSER_READ_NOT_ENABLED')
    }
    expect(wires).toHaveLength(0)
  })

  it('with the opt-in a write is a lease row for ANY class, including a local page', async () => {
    h.optedIn = [h.open]
    addPane('bp-op', 'http://localhost:9999/', 'operator')
    const first = await confirmAndAnswer(() => click('bp-op'), 'allow')
    expect(first.error).toBe('BROWSER_APPROVED_RESEND')
    expect(wires[0]!.prompt).toContain('Opened by: operator')
    expect(body(await click('bp-op')).ok).toBe(true)
  })

  it('turning the opt-in off ends the lease', async () => {
    h.optedIn = [h.open]
    addPane('bp-op', 'https://mail.example.com/', 'operator')
    await confirmAndAnswer(() => click('bp-op'), 'allow')
    h.optedIn = []
    expect(body(await click('bp-op')).error).toBe('BROWSER_READ_NOT_ENABLED')
    expect(browserLeases.isActive('bp-op', 'view-1')).toBe(false)
  })

  it('browser_list reports readable / writable / writableReason per §7.1', async () => {
    addPane('bp-op', 'https://mail.example.com/', 'operator')
    const rows = (body(await call('browser_list', { folder: h.open })).panes ?? []) as Array<
      Record<string, unknown>
    >
    const row = rows.find((r) => r.paneId === 'bp-op')!
    expect(row).toMatchObject({
      readable: false,
      writable: 'off',
      writableReason: 'read-not-enabled',
      url: null,
      title: null
    })
    h.optedIn = [h.open]
    const rows2 = (body(await call('browser_list', { folder: h.open })).panes ?? []) as Array<
      Record<string, unknown>
    >
    expect(rows2.find((r) => r.paneId === 'bp-op')).toMatchObject({
      readable: true,
      writable: 'confirm'
    })
    expect(rows2.find((r) => r.paneId === 'bp-ext')).toMatchObject({ writable: 'confirm' })
    expect(rows2.find((r) => r.paneId === 'bp-loc')).toMatchObject({ writable: 'free' })
  })
})

describe('AC-9 — network capture on an external page is a lease row, decided at plan time', () => {
  it('in ask mode the operator is NOT asked and then refused: the confirm is the lease confirm, and an Allow starts nothing', async () => {
    await writeMcpAsk(true)
    const first = await confirmAndAnswer(
      () => call('browser_network', { paneId: 'bp-ext', action: 'start' }),
      'allow'
    )
    expect(first.error).toBe('BROWSER_APPROVED_RESEND')
    expect(wires[0]!.prompt).toContain('start network traffic recording')
    const started = body(await call('browser_network', { paneId: 'bp-ext', action: 'start' }))
    expect(started).toMatchObject({ ok: true, active: true })
    expect(String(started.error ?? '')).not.toBe('NOT_YET_AVAILABLE')
  })

  it('stop is free on an external page, with no prompt, even without a lease', async () => {
    const res = body(await call('browser_network', { paneId: 'bp-ext', action: 'stop' }))
    expect(res.ok).toBe(true)
    expect(wires).toHaveLength(0)
  })

  it('a local page needs no lease for start', async () => {
    const res = body(await call('browser_network', { paneId: 'bp-loc', action: 'start' }))
    expect(res.ok).toBe(true)
    expect(wires).toHaveLength(0)
  })
})

describe('the confirm window and the 30-minute fail-closed', () => {
  it('parked: the pending text says nothing will be done; the later Allow grants the lease and the handle reports it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = click()
    await confirmRaisedFake(1)
    await vi.advanceTimersByTimeAsync(CONFIRM_WINDOW_MS + 1)
    const handle = body(await pending)
    expect(handle.status).toBe('pending')
    expect(String(handle.message)).toContain('Nothing will be done when they Allow')
    expect(String(handle.message)).toContain('BROWSER_APPROVED_RESEND')
    confirm.respond(wires[0]!.id, 'allow')
    // The Allow re-judges the pane (real file reads) before it grants, so wait for it.
    await vi.waitFor(() => expect(browserLeases.isActive('bp-ext', 'view-1')).toBe(true))
    const status = body(
      await handleToolCall(approvalDef, { approvalId: String(handle.approvalId) })
    )
    expect(JSON.stringify(status)).toContain('BROWSER_APPROVED_RESEND')
    expect(inputEvents()).toBe(0)
  })

  it('an unanswered confirm is denied after 30 minutes and leaves no lease', async () => {
    expect(PARK_TTL_MS).toBe(30 * 60_000)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = click()
    await confirmRaisedFake(1)
    await vi.advanceTimersByTimeAsync(CONFIRM_WINDOW_MS + 1)
    const handle = body(await pending)
    await vi.advanceTimersByTimeAsync(PARK_TTL_MS + 1)
    const status = body(
      await handleToolCall(approvalDef, { approvalId: String(handle.approvalId) })
    )
    expect(status.status).toBe('denied')
    expect(browserLeases.isActive('bp-ext', 'view-1')).toBe(false)
    expect(inputEvents()).toBe(0)
  })
})

describe('AC-1 — a mission grant or "always allow" never covers a lease row', () => {
  it('no browser verb is grantable or alwaysAllowable, and the observe worker cannot call any acting verb', () => {
    for (const op of [
      'browser_eval',
      'browser_click',
      'browser_type',
      'browser_fill',
      'browser_press'
    ]) {
      const t = MCP_TOOLS.find((x) => x.op === op)!
      expect(t.grantable, op).not.toBe(true)
      expect(t.alwaysAllowable, op).not.toBe(true)
      expect(t.replayable, op).toBe(false)
      expect(OBSERVE_MCP_DENY, op).toContain(`mcp__harnu__${op}`)
    }
  })

  it('even a grant naming the verb leaves a lease-row call a confirm', () => {
    const grant = {
      id: 'g1',
      folders: ['/work/app'],
      verbs: ['browser_click'],
      budget: 5,
      expiresAt: 10 ** 13
    } as unknown as MissionGrant
    const p = planToolCall({
      tool: 'browser_click',
      input: buildPlanInput('browser_click', { paneId: 'bp-1', ref: 's1e1' }, '/work/app'),
      policy: { serverEnabled: true, ask: true, denyFolders: [], knownRoots: ['/work'] },
      now: 1,
      grants: [grant],
      browser: {
        writesEnabled: true,
        pane: {
          openedBy: 'agent',
          originClass: 'external',
          disconnected: false,
          paused: false,
          leaseActive: false
        }
      }
    })
    expect(p).toMatchObject({ verdict: 'confirm', shouldConfirm: true })
    expect(p.grantAllow).toBeUndefined()
    expect(p.browserLeaseConfirm).toEqual({ paneId: 'bp-1' })
  })
})

afterAllClose()
function afterAllClose(): void {
  // closing the server also ends every browser lease (the app is quitting)
  it('closing the control server ends every browser lease', async () => {
    browserLeases.grant('bp-ext', h.open, 'view-1')
    await closeMcpServer()
    expect(browserLeases.activeIds()).toEqual([])
  })
}
