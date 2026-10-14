/**
 * T484 (agent terminals B6) — the operator-terminal write gate, the lease and the parked-confirm
 * rule, driven through the REAL `handleToolCall` pipeline with the real confirm core, registry,
 * lease table, write queue and screen model. Only `electron` and `node-pty` are stubbed.
 *
 * AC-B6-1 (free mode confirm → lease), AC-B6-2 (ask mode lease), AC-B6-3 (Allow never types, fast
 * and parked), AC-B6-4 (what ends a lease), AC-B6-5 (Deny cooldown), AC-B6-6 (plan-level refusals,
 * both modes, no prompt), AC-B6-7 (not grantable), AC-B6-8 (the lease dispatch path),
 * AC-B6-9 (the parked text, the handle, the 30-minute fail-closed).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const h = vi.hoisted(() => ({
  userDataDir: '',
  denied: [] as string[],
  optedIn: [] as string[],
  open: '',
  blockedPath: '',
  ipc: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  procs: [] as Array<{
    writes: Array<{ data: string; at: number }>
    emitData: (d: string) => void
    emitExit: (c: number) => void
    respond: (data: string) => string | null
  }>
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.userDataDir
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown): void => {
      h.ipc.set(ch, fn)
    },
    on: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown): void => {
      h.ipc.set(ch, fn)
    }
  }
}))

vi.mock('node-pty', () => ({
  spawn: (): unknown => {
    const dataCbs: Array<(d: string) => void> = []
    const exitCbs: Array<(e: { exitCode: number }) => void> = []
    const proc = {
      pid: 4343,
      writes: [] as Array<{ data: string; at: number }>,
      respond: (data: string): string | null => data.replace(/\r/g, '\r\n'),
      onData: (cb: (d: string) => void): void => {
        dataCbs.push(cb)
      },
      onExit: (cb: (e: { exitCode: number }) => void): void => {
        exitCbs.push(cb)
      },
      write: (data: string): void => {
        proc.writes.push({ data, at: performance.now() })
        const out = proc.respond(data)
        if (out) setTimeout(() => dataCbs.forEach((cb) => cb(out)), 4)
      },
      resize: (): void => {},
      kill: (): void => {},
      pause: (): void => {},
      resume: (): void => {},
      emitData: (d: string): void => dataCbs.forEach((cb) => cb(d)),
      emitExit: (c: number): void => exitCbs.forEach((cb) => cb({ exitCode: c }))
    }
    h.procs.push(proc)
    return proc
  }
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
      // The blocked folder stays a pinned project when it is not blocked (ask mode contains).
      ...(h.denied.includes(h.blockedPath) ? [] : [{ path: h.blockedPath }]),
      { path: h.open, ...(h.optedIn.includes(h.open) ? { agentTerminalRead: true } : {}) }
    ]
  })
}))

import { handleToolCall, registerMcpServer, closeMcpServer } from '../src/main/mcp/server'
import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import {
  createConfirmCore,
  CONFIRM_WINDOW_MS,
  PARK_TTL_MS,
  type ConfirmCore,
  type ConfirmWire
} from '../src/main/mcp/confirm-core'
import { terminalRegistry } from '../src/main/terminal-registry'
import { terminalLeases, LEASE_IDLE_MS, DENY_COOLDOWN_MS } from '../src/main/terminal-lease'
import { resolveTerminalGate } from '../src/main/terminal-gate'
import { dropScreenModel } from '../src/main/terminal-screen'
import { terminalWriteQueue } from '../src/main/terminal-write-queue'
import { writeMcpAsk } from '../src/main/mcp/prefs'
import { getAuditLog, clearAuditLog } from '../src/main/mcp/audit-log'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { parsePlanMission } from '../src/main/mcp/validate'
import { _resetIdempotencyRegistry } from '../src/main/mcp/idempotency-registry'
import { _resetInflightRegistry } from '../src/main/mcp/inflight-session-registry'
import { OBSERVE_MCP_DENY } from '../src/main/scheduler-core'
import type { MissionGrant } from '../src/main/mcp/grant-core'

const def = (op: string): (typeof WIRED_TOOLS)[number] => WIRED_TOOLS.find((t) => t.op === op)!
const sendDef = def('send_terminal')
const approvalDef = def('get_approval')
const spawnHandler = def('spawn_terminal').handler!

let blocked = ''
let confirm: ConfirmCore
let wires: ConfirmWire[] = []
type Proc = (typeof h.procs)[number]
type Ctx = Parameters<typeof spawnHandler>[1]

const spawnCtx = (): Ctx =>
  ({
    folder: h.open,
    folders: [{ path: h.open, alias: path.basename(h.open), sessions: [] }],
    denyFolders: [],
    bridge: {
      dispatch: vi.fn(async (_c: string, p: unknown) => ({
        paneId: (p as { paneId: string }).paneId
      }))
    }
  }) as unknown as Ctx

function body(res: CallToolResult): Record<string, unknown> {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  try {
    return JSON.parse(first.text)
  } catch {
    return { error: first.text }
  }
}

const send = (args: Record<string, unknown>): Promise<CallToolResult> =>
  handleToolCall(sendDef, args)
const approval = async (id: string): Promise<Record<string, unknown>> =>
  body(await handleToolCall(approvalDef, { approvalId: id }))

async function spawnAgent(): Promise<{ id: string; proc: Proc }> {
  const ack = body(await spawnHandler({ folder: h.open }, spawnCtx()))
  return { id: ack.terminalId as string, proc: h.procs[h.procs.length - 1]! }
}

/** The renderer's `pty:create` for a shell pane the OPERATOR opened. */
async function openOperatorShell(terminalId: string, folder = h.open): Promise<Proc> {
  await h.ipc.get('pty:create')!(
    {},
    { kind: 'shell', cwd: folder, cols: 100, rows: 20, terminal: { terminalId, folder } }
  )
  return h.procs[h.procs.length - 1]!
}

const writesOf = (proc: Proc): string[] => proc.writes.map((w) => w.data)
const auditResults = (): string[] => getAuditLog().map((r) => r.result)

/** Wait (real timers) until the confirm core has raised `n` confirms in total. */
async function confirmRaised(n: number): Promise<ConfirmWire> {
  await vi.waitFor(() => expect(wires.length).toBeGreaterThanOrEqual(n))
  return wires[n - 1]!
}

/** Same wait under fake timers, without moving the clock by more than a millisecond a step. */
async function confirmRaisedFake(n: number): Promise<ConfirmWire> {
  // The pipeline reads real files before it parks, so yield to the real event loop too.
  for (let i = 0; i < 2_000 && wires.length < n; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(1)
  }
  expect(wires.length).toBeGreaterThanOrEqual(n)
  return wires[n - 1]!
}

/** Raise the first confirm for `args`, answer it, and return what the original call resolved. */
async function confirmAndAnswer(
  args: Record<string, unknown>,
  verdict: 'allow' | 'deny'
): Promise<Record<string, unknown>> {
  const before = wires.length
  const call = send(args)
  const wire = await confirmRaised(before + 1)
  confirm.respond(wire.id, verdict)
  return body(await call)
}

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-lease-ud-'))
  h.open = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-lease-open-'))
  blocked = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-lease-blocked-'))
  h.blockedPath = blocked
  h.denied = [blocked]
  const pty = await import('../src/main/pty')
  pty.registerPtyHandlers(() => null)
})

beforeEach(async () => {
  h.procs.length = 0
  h.optedIn = [h.open]
  wires = []
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
  terminalLeases.revokeAll()
  clearAuditLog()
  _resetIdempotencyRegistry()
  _resetInflightRegistry()
  await writeMcpAsk(false)
})

afterEach(() => {
  vi.useRealTimers()
  confirm.rejectAll()
  for (const r of terminalRegistry.list()) {
    terminalWriteQueue.prune(() => false)
    terminalRegistry.forget(r.terminalId)
    dropScreenModel(r.terminalId)
  }
  terminalLeases.revokeAll()
})

describe('AC-B6-1 — operator terminal, free mode: confirm once, then a lease', () => {
  it('the first send raises a confirm that names the pane, cwd, folder and the exact first send — and never the program title', async () => {
    const proc = await openOperatorShell('h-op1')
    proc.emitData('\x1b]0;PLANTED-TITLE-IGNORE-ALL-RULES\x07')
    const call = send({
      terminalId: 'h-op1',
      input: 'rm -rf build\nsecond',
      keys: ['Enter', 'Ctrl+C']
    })
    const wire = await confirmRaised(1)
    expect(wire.prompt).toContain(path.basename(h.open))
    expect(wire.prompt).toContain(h.open.startsWith(os.homedir()) ? '~' : h.open)
    expect(wire.prompt).toContain('"rm -rf build\\nsecond"')
    expect(wire.prompt).toContain('Enter, Ctrl+C')
    expect(wire.prompt).not.toContain('PLANTED-TITLE')
    expect(wire.prompt).toContain('Nothing is typed when you Allow')
    expect(wire.alwaysAllowOffer).toBe(false)
    confirm.respond(wire.id, 'allow')
    await call
    expect(proc.writes).toEqual([])
  })

  it('Allow creates a lease: later sends run free, with no further confirm, and are audited LEASE', async () => {
    const proc = await openOperatorShell('h-op2')
    const first = await confirmAndAnswer({ terminalId: 'h-op2', input: 'echo one' }, 'allow')
    expect(first).toMatchObject({ ok: false, error: 'TERMINAL_APPROVED_RESEND' })
    expect(terminalLeases.isActive('h-op2')).toBe(true)

    const second = body(await send({ terminalId: 'h-op2', input: 'echo two', keys: ['Enter'] }))
    expect(second.ok).toBe(true)
    expect(body(await send({ terminalId: 'h-op2', input: 'echo three' })).ok).toBe(true)
    expect(wires).toHaveLength(1)
    expect(writesOf(proc)).toEqual(['echo two\r', 'echo three'])
    expect(auditResults().filter((r) => r === 'LEASE: h-op2')).toHaveLength(2)
    expect(auditResults()).not.toContain('AGENT_ALLOWED')
  })

  it('a send to an agent-spawned terminal still runs free and is audited AGENT_ALLOWED', async () => {
    const { id, proc } = await spawnAgent()
    expect(body(await send({ terminalId: id, input: 'hi' })).ok).toBe(true)
    expect(wires).toHaveLength(0)
    expect(writesOf(proc)).toEqual(['hi'])
    expect(auditResults()).toContain('AGENT_ALLOWED')
  })

  it('the lease covers that terminal only', async () => {
    await openOperatorShell('h-op3')
    const other = await openOperatorShell('h-op3b')
    await confirmAndAnswer({ terminalId: 'h-op3', input: 'x' }, 'allow')
    const call = send({ terminalId: 'h-op3b', input: 'y' })
    const wire = await confirmRaised(2)
    expect(wire.prompt).toContain('Terminal:')
    confirm.respond(wire.id, 'deny')
    await call
    expect(other.writes).toEqual([])
  })

  it('last line of defence: the handler refuses an operator terminal with no lease, typing nothing', async () => {
    const proc = await openOperatorShell('h-op4')
    const res = await sendDef.handler!(
      { terminalId: 'h-op4', input: 'x' },
      { ...spawnCtx(), folder: h.open }
    )
    expect(body(res).error).toBe('TERMINAL_LEASE_ENDED')
    expect(proc.writes).toEqual([])
  })
})

describe('AC-B6-2 / AC-B6-8 — ask mode: the lease promotes confirm to allow, and has a dispatch path', () => {
  it('every send confirms until the lease exists, then the lease carries it (any origin)', async () => {
    await writeMcpAsk(true)
    const { id, proc } = await spawnAgent()
    const first = await confirmAndAnswer({ terminalId: id, input: 'a' }, 'allow')
    expect(first.error).toBe('TERMINAL_APPROVED_RESEND')
    expect(proc.writes).toEqual([])

    const res = await send({ terminalId: id, input: 'b', keys: ['Enter'] })
    expect(body(res).ok).toBe(true)
    expect(wires).toHaveLength(1)
    expect(writesOf(proc)).toEqual(['b\r'])
    // Actuated by its own branch, not routed to steerError, and audited LEASE.
    expect(res.isError).toBeFalsy()
    expect(auditResults()).toContain(`LEASE: ${id}`)
  })

  it('an operator terminal in ask mode works the same way', async () => {
    await writeMcpAsk(true)
    const proc = await openOperatorShell('h-ask')
    await confirmAndAnswer({ terminalId: 'h-ask', input: 'a' }, 'allow')
    expect(body(await send({ terminalId: 'h-ask', input: 'b' })).ok).toBe(true)
    expect(writesOf(proc)).toEqual(['b'])
    expect(wires).toHaveLength(1)
  })

  it('an explicit folder block outranks a lease: nothing is typed and no confirm is raised', async () => {
    await writeMcpAsk(true)
    terminalRegistry.register({
      terminalId: 'h-blocked',
      ptyId: 'p-blocked',
      folder: blocked,
      origin: 'agent',
      size: { cols: 80, rows: 24 }
    })
    terminalLeases.grant('h-blocked', blocked)
    const res = await send({ terminalId: 'h-blocked', input: 'x' })
    expect(body(res).error).toBe('FOLDER_NOT_ALLOWED')
    expect(wires).toHaveLength(0)
  })

  describe('at plan level', () => {
    const state = (over: object = {}): Parameters<typeof planToolCall>[0]['terminal'] => ({
      known: true,
      isTerminal: true,
      origin: 'operator',
      disconnected: false,
      state: 'running',
      readable: true,
      ownerSessionId: null,
      leaseActive: true,
      writeDenied: false,
      ...over
    })
    const plan = (
      over: Partial<Parameters<typeof planToolCall>[0]> = {},
      ask = true
    ): ReturnType<typeof planToolCall> =>
      planToolCall({
        tool: 'send_terminal',
        input: buildPlanInput('send_terminal', { terminalId: 'h-1', input: 'x' }, '/work/app'),
        policy: { serverEnabled: true, ask, denyFolders: [], knownRoots: ['/work'] },
        now: 1,
        terminal: state(),
        ...over
      })

    it('promotes confirm to allow and carries leaseAllow for that terminalId only', () => {
      const p = plan()
      expect(p).toMatchObject({
        verdict: 'allow',
        shouldDispatch: true,
        shouldConfirm: false,
        leaseAllow: { terminalId: 'h-1' }
      })
      expect(p.grantAllow).toBeUndefined()
      expect(p.inheritOnceAllow).toBeUndefined()
      expect(p.silentAllowInAgentFolder).toBeUndefined()
      expect(p.auditRecord.result).toBe('LEASE: h-1')
      expect(p.auditRecord.disclosedPayloadSummary).toContain('gate=lease')
    })

    it('without a lease the ask-mode verdict stays confirm and carries no leaseAllow', () => {
      const p = plan({ terminal: state({ leaseActive: false }) })
      expect(p).toMatchObject({ verdict: 'confirm', shouldConfirm: true, shouldDispatch: false })
      expect(p.leaseAllow).toBeUndefined()
      expect(p.auditRecord.disclosedPayloadSummary).toContain('gate=confirm')
    })

    it('an explicit block outranks the lease', () => {
      const p = plan({
        policy: {
          serverEnabled: true,
          ask: true,
          denyFolders: ['/work/app'],
          knownRoots: ['/work']
        }
      })
      expect(p).toMatchObject({ verdict: 'deny', shouldDispatch: false })
      expect(p.leaseAllow).toBeUndefined()
    })

    it('a grant naming send_terminal never arms, so a plan cannot carry both', () => {
      const grant: MissionGrant = {
        id: 'g1',
        goal: 'g',
        folders: ['/work/app'],
        dynamicFolders: [],
        verbs: ['send_terminal'] as never,
        budget: 5,
        spent: 0,
        expiresAt: 10 ** 12,
        createdAt: 0,
        revoked: false
      }
      const p = plan({ grants: [grant] })
      expect(p.grantAllow).toBeUndefined()
      expect(p.leaseAllow).toEqual({ terminalId: 'h-1' })
    })

    it('free mode: a leased operator terminal rides the silent-allow path, audited LEASE', () => {
      const p = plan({}, false)
      expect(p).toMatchObject({ verdict: 'allow', shouldDispatch: true })
      expect(p.silentAllowInAgentFolder).toBe(true)
      expect(p.leaseAllow).toBeUndefined()
      expect(p.auditRecord.result).toBe('LEASE: h-1')
    })

    it('free mode: an operator terminal without a lease is narrowed to confirm', () => {
      const p = plan({ terminal: state({ leaseActive: false }) }, false)
      expect(p).toMatchObject({ verdict: 'confirm', shouldConfirm: true, shouldDispatch: false })
    })

    it('free mode: an agent terminal runs free with no lease', () => {
      const p = plan({ terminal: state({ origin: 'agent', leaseActive: false }) }, false)
      expect(p).toMatchObject({ verdict: 'allow', shouldDispatch: true })
      expect(p.auditRecord.result).toBe('AGENT_ALLOWED')
    })
  })
})

describe('AC-B6-3 / AC-B6-9 — Allow never types the call that asked', () => {
  it('fast path: Allow resolves TERMINAL_APPROVED_RESEND with zero bytes written; the next send runs under the lease', async () => {
    const proc = await openOperatorShell('h-fast')
    const res = await confirmAndAnswer({ terminalId: 'h-fast', input: 'echo ASKED' }, 'allow')
    expect(res).toMatchObject({ ok: false, error: 'TERMINAL_APPROVED_RESEND' })
    expect(JSON.stringify(res)).toContain('Nothing was typed')
    expect(proc.writes).toEqual([])

    expect(body(await send({ terminalId: 'h-fast', input: 'echo AGAIN' })).ok).toBe(true)
    expect(writesOf(proc)).toEqual(['echo AGAIN'])
  })

  describe('parked path (the confirm outlived 30 s)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    })

    it('says nothing will be typed, and the handle resolves allowed + TERMINAL_APPROVED_RESEND; zero bytes ever reach the PTY', async () => {
      const proc = await openOperatorShell('h-parked')
      const call = send({ terminalId: 'h-parked', input: 'y', keys: ['Enter'] })
      const wire = await confirmRaisedFake(1)
      await vi.advanceTimersByTimeAsync(CONFIRM_WINDOW_MS)
      const pending = body(await call)
      expect(pending.status).toBe('pending')
      expect(pending.message).toContain('Nothing will be typed when they Allow')
      expect(pending.message).toContain('TERMINAL_APPROVED_RESEND')
      expect(pending.message).not.toContain('It will actuate')
      const approvalId = pending.approvalId as string
      expect(approvalId).toBe(wire.id)

      // Minutes later, the operator is back and presses Allow.
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      confirm.respond(wire.id, 'allow')
      await vi.advanceTimersByTimeAsync(10)

      expect(await approval(approvalId)).toMatchObject({
        status: 'allowed',
        result: { ok: false, error: 'TERMINAL_APPROVED_RESEND' }
      })
      expect(proc.writes).toEqual([])
      expect(terminalLeases.isActive('h-parked')).toBe(true)
    })

    it('after the parked Allow, the next send_terminal runs under the lease with no new confirm', async () => {
      const proc = await openOperatorShell('h-parked2')
      const call = send({ terminalId: 'h-parked2', input: 'y' })
      const wire = await confirmRaisedFake(1)
      await vi.advanceTimersByTimeAsync(CONFIRM_WINDOW_MS)
      await call
      confirm.respond(wire.id, 'allow')
      await vi.advanceTimersByTimeAsync(10)
      vi.useRealTimers()

      expect(body(await send({ terminalId: 'h-parked2', input: 'z' })).ok).toBe(true)
      expect(wires).toHaveLength(1)
      expect(writesOf(proc)).toEqual(['z'])
    })

    it('ask mode, an agent terminal: the parked Allow does not type either (B5 hazard closed)', async () => {
      vi.useRealTimers()
      await writeMcpAsk(true)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { id, proc } = await spawnAgent()
      const call = send({ terminalId: id, input: 'y', keys: ['Enter'] })
      const wire = await confirmRaisedFake(1)
      await vi.advanceTimersByTimeAsync(CONFIRM_WINDOW_MS)
      const approvalId = body(await call).approvalId as string
      confirm.respond(wire.id, 'allow')
      await vi.advanceTimersByTimeAsync(10)
      expect(await approval(approvalId)).toMatchObject({
        status: 'allowed',
        result: { error: 'TERMINAL_APPROVED_RESEND' }
      })
      expect(proc.writes).toEqual([])
    })

    it('an unanswered confirm fails closed at PARK_TTL_MS (30 minutes): denied, nothing typed, no lease', async () => {
      const proc = await openOperatorShell('h-ttl')
      const call = send({ terminalId: 'h-ttl', input: 'x' })
      await confirmRaisedFake(1)
      await vi.advanceTimersByTimeAsync(CONFIRM_WINDOW_MS)
      const approvalId = body(await call).approvalId as string
      expect(PARK_TTL_MS).toBe(30 * 60_000)

      await vi.advanceTimersByTimeAsync(PARK_TTL_MS - CONFIRM_WINDOW_MS - 1_000)
      expect((await approval(approvalId)).status).toBe('pending')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await approval(approvalId)).toMatchObject({ status: 'denied', reason: 'TTL_EXPIRED' })
      expect(proc.writes).toEqual([])
      expect(terminalLeases.isActive('h-ttl')).toBe(false)
    })

    it('a parked Deny starts the cooldown and the handle says TERMINAL_WRITE_DENIED', async () => {
      const proc = await openOperatorShell('h-pdeny')
      const call = send({ terminalId: 'h-pdeny', input: 'x' })
      const wire = await confirmRaisedFake(1)
      await vi.advanceTimersByTimeAsync(CONFIRM_WINDOW_MS)
      const approvalId = body(await call).approvalId as string
      confirm.respond(wire.id, 'deny')
      await vi.advanceTimersByTimeAsync(10)
      expect(await approval(approvalId)).toMatchObject({
        status: 'denied',
        reason: 'TERMINAL_WRITE_DENIED'
      })
      vi.useRealTimers()
      expect(body(await send({ terminalId: 'h-pdeny', input: 'x' })).error).toBe(
        'TERMINAL_WRITE_DENIED'
      )
      expect(wires).toHaveLength(1)
      expect(proc.writes).toEqual([])
    })
  })

  it('an Allow that arrives after the terminal ended grants nothing and says why', async () => {
    const proc = await openOperatorShell('h-late')
    const call = send({ terminalId: 'h-late', input: 'x' })
    const wire = await confirmRaised(1)
    proc.emitExit(0)
    confirm.respond(wire.id, 'allow')
    expect(body(await call).error).toBe('TERMINAL_EXITED')
    expect(terminalLeases.isActive('h-late')).toBe(false)
  })

  it('an Allow that arrives after the folder was blocked grants nothing', async () => {
    terminalRegistry.register({
      terminalId: 'h-late2',
      ptyId: 'p-late2',
      folder: blocked,
      origin: 'agent',
      size: { cols: 80, rows: 24 }
    })
    // The folder is blocked, so the plan itself would refuse; drive the confirm directly the way
    // a block that landed WHILE the confirm was parked would reach it.
    h.denied = []
    await writeMcpAsk(true)
    const call = send({ terminalId: 'h-late2', input: 'x' })
    const wire = await confirmRaised(1)
    h.denied = [blocked]
    confirm.respond(wire.id, 'allow')
    expect(body(await call).error).toBe('FOLDER_NOT_ALLOWED')
    expect(terminalLeases.isActive('h-late2')).toBe(false)
  })
})

describe('AC-B6-4 — what ends a lease', () => {
  const dateOnly = (): void => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
  }

  it('10 minutes after the last write: the next send confirms again', async () => {
    const proc = await openOperatorShell('h-idle')
    await confirmAndAnswer({ terminalId: 'h-idle', input: 'a' }, 'allow')
    dateOnly()
    vi.setSystemTime(Date.now())
    expect(body(await send({ terminalId: 'h-idle', input: 'b' })).ok).toBe(true)

    // 9 minutes of silence: still leased, and that write restarts the clock.
    vi.setSystemTime(Date.now() + LEASE_IDLE_MS - 60_000)
    expect(body(await send({ terminalId: 'h-idle', input: 'c' })).ok).toBe(true)
    vi.setSystemTime(Date.now() + LEASE_IDLE_MS - 60_000)
    expect(body(await send({ terminalId: 'h-idle', input: 'd' })).ok).toBe(true)
    expect(wires).toHaveLength(1)

    vi.setSystemTime(Date.now() + LEASE_IDLE_MS)
    const call = send({ terminalId: 'h-idle', input: 'e' })
    const wire = await confirmRaised(2)
    confirm.respond(wire.id, 'deny')
    await call
    expect(writesOf(proc)).toEqual(['b', 'c', 'd'])
  })

  it('terminal exit: the lease no longer counts, and a send is refused TERMINAL_EXITED', async () => {
    const proc = await openOperatorShell('h-exit')
    await confirmAndAnswer({ terminalId: 'h-exit', input: 'a' }, 'allow')
    expect((await resolveTerminalGate('h-exit')).state.leaseActive).toBe(true)
    proc.emitExit(0)
    expect((await resolveTerminalGate('h-exit')).state.leaseActive).toBe(false)
    expect(body(await send({ terminalId: 'h-exit', input: 'b' })).error).toBe('TERMINAL_EXITED')
    expect(proc.writes).toEqual([])
  })

  it('folder block: a lease granted before it cannot be used, and does not return on unblock', async () => {
    terminalRegistry.register({
      terminalId: 'h-block',
      ptyId: 'p-block',
      folder: blocked,
      origin: 'operator',
      size: { cols: 80, rows: 24 }
    })
    h.denied = []
    terminalLeases.grant('h-block', blocked)
    h.denied = [blocked]
    expect(body(await send({ terminalId: 'h-block', input: 'x' })).error).toBe('FOLDER_NOT_ALLOWED')
    // (the toggle itself revokes: see tests/user-projects-terminal-lease.test.ts)
    terminalLeases.revokeUnder(blocked)
    h.denied = []
    expect((await resolveTerminalGate('h-block')).state.leaseActive).toBe(false)
  })

  it('app quit / control server stopped: every lease is gone and a send confirms again', async () => {
    const proc = await openOperatorShell('h-quit')
    await confirmAndAnswer({ terminalId: 'h-quit', input: 'a' }, 'allow')
    expect(terminalLeases.isActive('h-quit')).toBe(true)
    await closeMcpServer()
    expect(terminalLeases.activeIds()).toEqual([])
    await registerMcpServer(() => null, {
      bridge: { dispatch: vi.fn(async () => ({})) } as never,
      confirm
    })
    const call = send({ terminalId: 'h-quit', input: 'b' })
    const wire = await confirmRaised(2)
    confirm.respond(wire.id, 'deny')
    await call
    expect(proc.writes).toEqual([])
  })
})

describe('AC-B6-5 — Deny: TERMINAL_WRITE_DENIED, and a 5-minute cooldown with no new prompt', () => {
  it('refuses, then refuses again without raising a confirm, until the cooldown ends', async () => {
    const proc = await openOperatorShell('h-deny')
    const first = await confirmAndAnswer({ terminalId: 'h-deny', input: 'a' }, 'deny')
    expect(first.error).toBe('TERMINAL_WRITE_DENIED')

    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    vi.setSystemTime(Date.now())
    for (let i = 0; i < 3; i++) {
      expect(body(await send({ terminalId: 'h-deny', input: 'b' })).error).toBe(
        'TERMINAL_WRITE_DENIED'
      )
    }
    vi.setSystemTime(Date.now() + DENY_COOLDOWN_MS - 1_000)
    expect(body(await send({ terminalId: 'h-deny', input: 'b' })).error).toBe(
      'TERMINAL_WRITE_DENIED'
    )
    expect(wires).toHaveLength(1)

    vi.setSystemTime(Date.now() + 3_000)
    const call = send({ terminalId: 'h-deny', input: 'c' })
    const wire = await confirmRaised(2)
    confirm.respond(wire.id, 'deny')
    await call
    expect(proc.writes).toEqual([])
  })

  it('a confirm that merely times out or is cancelled is not a Deny: no cooldown', async () => {
    await openOperatorShell('h-cancel')
    const call = send({ terminalId: 'h-cancel', input: 'a' })
    const wire = await confirmRaised(1)
    confirm.cancel(wire.id)
    expect(body(await call).error).not.toBe('TERMINAL_WRITE_DENIED')
    expect(terminalLeases.isDenied('h-cancel')).toBe(false)
  })
})

describe('AC-B6-6 — flat refusals at plan level, before any confirm, in both modes', () => {
  for (const ask of [false, true]) {
    describe(ask ? 'ask mode' : 'free mode', () => {
      beforeEach(async () => {
        await writeMcpAsk(ask)
      })

      it('TERMINAL_EXITED: no prompt', async () => {
        const proc = await openOperatorShell('h-r1')
        proc.emitExit(0)
        expect(body(await send({ terminalId: 'h-r1', input: 'x' })).error).toBe('TERMINAL_EXITED')
        expect(wires).toHaveLength(0)
      })

      it('TERMINAL_READ_NOT_ENABLED (opt-in off): no prompt', async () => {
        h.optedIn = []
        const proc = await openOperatorShell('h-r2')
        expect(body(await send({ terminalId: 'h-r2', input: 'x' })).error).toBe(
          'TERMINAL_READ_NOT_ENABLED'
        )
        expect(wires).toHaveLength(0)
        expect(proc.writes).toEqual([])
      })

      it('TERMINAL_WRITE_DENIED (cooldown): no prompt', async () => {
        const proc = await openOperatorShell('h-r3')
        terminalLeases.deny('h-r3')
        expect(body(await send({ terminalId: 'h-r3', input: 'x' })).error).toBe(
          'TERMINAL_WRITE_DENIED'
        )
        expect(wires).toHaveLength(0)
        expect(proc.writes).toEqual([])
      })

      it('the order holds: exited outranks the cooldown, which ranks below the read opt-in', async () => {
        const proc = await openOperatorShell('h-r4')
        terminalLeases.deny('h-r4')
        proc.emitExit(0)
        expect(body(await send({ terminalId: 'h-r4', input: 'x' })).error).toBe('TERMINAL_EXITED')
        h.optedIn = []
        const live = await openOperatorShell('h-r5')
        terminalLeases.deny('h-r5')
        expect(body(await send({ terminalId: 'h-r5', input: 'x' })).error).toBe(
          'TERMINAL_READ_NOT_ENABLED'
        )
        expect(live.writes).toEqual([])
        expect(wires).toHaveLength(0)
      })
    })
  }
})

describe('AC-B6-7 — send_terminal is not grantable and not always-allowable', () => {
  it('the catalog flags hold', () => {
    const t = MCP_TOOLS.find((x) => x.op === 'send_terminal')!
    expect(t.grantable).not.toBe(true)
    expect(t.alwaysAllowable).not.toBe(true)
    expect(t.mutates).toBe(true)
  })

  it('a mission grant naming it is rejected', () => {
    const r = parsePlanMission({
      goal: 'type things',
      folders: [h.open],
      verbs: ['send_terminal'],
      budget: 3,
      ttlMinutes: 30
    })
    expect(r.ok).toBe(false)
  })

  it('an observe tick cannot call it', () => {
    expect(OBSERVE_MCP_DENY).toContain('mcp__harnu__send_terminal')
  })

  it('a confirm for it offers no "always allow" checkbox', async () => {
    await openOperatorShell('h-aa')
    const call = send({ terminalId: 'h-aa', input: 'x' })
    const wire = await confirmRaised(1)
    expect(wire.alwaysAllowOffer).toBe(false)
    confirm.respond(wire.id, 'deny')
    await call
  })
})
