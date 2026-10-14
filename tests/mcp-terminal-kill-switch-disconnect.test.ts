/**
 * T487 (agent terminals B7) — the global write kill-switch and Disconnect (main side), driven
 * through the REAL `handleToolCall` pipeline with the real confirm core, registry, lease table,
 * write queue, screen model and PTY layer. Only `electron` and `node-pty` are stubbed.
 *
 * AC-B7-1 (the pref persists), AC-B7-2 (kill-switch refuses at plan level, both modes, both
 * origins), AC-B7-4 (Disconnect refuses every read and send, PTY keeps running), AC-B7-5 (a wait
 * in flight ends at once, output cut, between-segment re-check), plus the B6 carry-in
 * (`list_terminals.writable` reports `free` under a lease).
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
    killed: boolean
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
      killed: false,
      kill: (): void => {
        proc.killed = true
      },
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

import { handleToolCall, registerMcpServer } from '../src/main/mcp/server'
import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { createConfirmCore, type ConfirmCore, type ConfirmWire } from '../src/main/mcp/confirm-core'
import { terminalRegistry } from '../src/main/terminal-registry'
import { terminalLeases } from '../src/main/terminal-lease'
import { resolveTerminalGate, disconnectTerminal } from '../src/main/terminal-gate'
import { dropScreenModel } from '../src/main/terminal-screen'
import { terminalWriteQueue, settleAfterSend } from '../src/main/terminal-write-queue'
import {
  writeMcpAsk,
  readAgentTerminalWrites,
  writeAgentTerminalWrites
} from '../src/main/mcp/prefs'
import { getAuditLog, clearAuditLog } from '../src/main/mcp/audit-log'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { _resetIdempotencyRegistry } from '../src/main/mcp/idempotency-registry'
import { _resetInflightRegistry } from '../src/main/mcp/inflight-session-registry'

const def = (op: string): (typeof WIRED_TOOLS)[number] => WIRED_TOOLS.find((t) => t.op === op)!
const sendDef = def('send_terminal')
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

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-b7-ud-'))
  h.open = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-b7-open-'))
  blocked = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-b7-blocked-'))
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
  await writeAgentTerminalWrites(true)
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

const listDef = def('list_terminals')
const readDef = def('read_terminal')

const rowOf = async (id: string): Promise<Record<string, unknown>> => {
  const out = body(await handleToolCall(listDef, {}))
  return (out.terminals as Array<Record<string, unknown>>).find((t) => t.terminalId === id)!
}

const setKillSwitch = (enabled: boolean): unknown =>
  h.ipc.get('mcp:agentTerminalWrites:set')!({}, enabled)

/**
 * Resolve the moment the first byte reaches the PTY. `vi.waitFor` polls every 50 ms by default,
 * which is the length of the Esc gap itself — far too coarse to land inside it.
 */
const firstWrite = (proc: Proc): Promise<void> =>
  vi.waitFor(() => expect(proc.writes.length).toBe(1), { interval: 1, timeout: 2000 })

const PTY = (id: string): string => terminalRegistry.get(id)?.ptyId ?? ''

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('AC-B7-1 — the kill-switch pref is persisted in main, default on', () => {
  it('defaults to ON when nothing was ever written', async () => {
    await fs.rm(path.join(h.userDataDir, 'mcp-prefs.json'), { force: true })
    vi.resetModules()
    expect(await (await import('../src/main/mcp/prefs')).readAgentTerminalWrites()).toBe(true)
  })

  it('an explicit OFF is written to the prefs file, preserves the other prefs, and survives a restart', async () => {
    await writeMcpAsk(true)
    await writeAgentTerminalWrites(false)
    const onDisk = JSON.parse(await fs.readFile(path.join(h.userDataDir, 'mcp-prefs.json'), 'utf8'))
    expect(onDisk).toMatchObject({ ask: true, agentTerminalWrites: false })
    // A restart is a fresh module graph reading the same file.
    vi.resetModules()
    const fresh = await import('../src/main/mcp/prefs')
    expect(await fresh.readAgentTerminalWrites()).toBe(false)
    await fresh.writeAgentTerminalWrites(true)
    expect(await fresh.readAgentTerminalWrites()).toBe(true)
  })

  it('a corrupt prefs file reads ON: a torn pref must not silently switch typing off', async () => {
    await fs.writeFile(path.join(h.userDataDir, 'mcp-prefs.json'), '{not json', 'utf8')
    vi.resetModules()
    expect(await (await import('../src/main/mcp/prefs')).readAgentTerminalWrites()).toBe(true)
  })

  it('the Settings IPC reads and writes the pref', async () => {
    expect(await h.ipc.get('mcp:agentTerminalWrites:get')!({})).toBe(true)
    expect(await setKillSwitch(false)).toBe(false)
    expect(await h.ipc.get('mcp:agentTerminalWrites:get')!({})).toBe(false)
    expect(await readAgentTerminalWrites()).toBe(false)
    expect(await setKillSwitch(true)).toBe(true)
  })
})

describe('AC-B7-2 — kill-switch off: every send is refused at plan level, before any confirm', () => {
  for (const ask of [false, true]) {
    describe(ask ? 'ask mode' : 'free mode', () => {
      it('an agent-spawned terminal: TERMINAL_WRITES_DISABLED, nothing typed, no confirm raised', async () => {
        await writeMcpAsk(ask)
        const { id, proc } = await spawnAgent()
        await setKillSwitch(false)
        const res = body(await send({ terminalId: id, input: 'rm -rf x', keys: ['Enter'] }))
        expect(res.error).toBe('TERMINAL_WRITES_DISABLED')
        expect(JSON.stringify(res)).toContain('Settings')
        expect(proc.writes).toEqual([])
        expect(wires).toEqual([])
        expect(auditResults()).toContain('TERMINAL_WRITES_DISABLED')
      })

      it('an operator-opened terminal (opt-in on, even under a live lease): the same, and the lease ends', async () => {
        await writeMcpAsk(ask)
        const proc = await openOperatorShell('h-op')
        terminalLeases.grant('h-op', h.open, terminalRegistry.get('h-op')!.ptyId)
        expect(terminalLeases.isActive('h-op', PTY('h-op'))).toBe(true)
        await setKillSwitch(false)
        expect(terminalLeases.isActive('h-op', PTY('h-op'))).toBe(false)
        const res = body(await send({ terminalId: 'h-op', input: 'x' }))
        expect(res.error).toBe('TERMINAL_WRITES_DISABLED')
        expect(proc.writes).toEqual([])
        expect(wires).toEqual([])
      })
    })
  }

  it('is a PLAN-level deny: no confirm, no dispatch, in ask mode too', async () => {
    const { id } = await spawnAgent()
    await setKillSwitch(false)
    const { state } = await resolveTerminalGate(id)
    const rec = terminalRegistry.get(id)!
    for (const ask of [false, true]) {
      const plan = planToolCall({
        tool: 'send_terminal',
        input: buildPlanInput('send_terminal', { terminalId: id, input: 'ls' }, rec.folder),
        policy: {
          serverEnabled: true,
          ask,
          denyFolders: [],
          allowFolders: [rec.folder],
          knownRoots: [rec.folder]
        },
        now: 1,
        terminal: state
      })
      expect(plan).toMatchObject({ verdict: 'deny', shouldConfirm: false, shouldDispatch: false })
      expect(plan.auditRecord.result).toBe('TERMINAL_WRITES_DISABLED')
    }
  })

  it('a stale lease cannot outlive the switch even if the pref was flipped behind our back', async () => {
    await openOperatorShell('h-op2')
    terminalLeases.grant('h-op2', h.open, terminalRegistry.get('h-op2')!.ptyId)
    await writeAgentTerminalWrites(false) // not through the IPC
    const { state } = await resolveTerminalGate('h-op2')
    expect(state.leaseActive).toBe(false)
    expect(terminalLeases.isActive('h-op2', PTY('h-op2'))).toBe(false)
  })

  it('reads, list_terminals and Disconnect are unaffected', async () => {
    const { id } = await spawnAgent()
    await setKillSwitch(false)
    expect(body(await handleToolCall(readDef, { terminalId: id })).ok).toBe(true)
    expect(await rowOf(id)).toMatchObject({
      readable: true,
      writable: 'off',
      writableReason: 'kill-switch'
    })
    expect(disconnectTerminal(id)).toBe(true)
    expect(terminalRegistry.get(id)!.disconnected).toBe(true)
  })

  it('turning it back on restores free agent-terminal sends', async () => {
    const { id, proc } = await spawnAgent()
    await setKillSwitch(false)
    expect(body(await send({ terminalId: id, input: 'a' })).error).toBe('TERMINAL_WRITES_DISABLED')
    await setKillSwitch(true)
    expect(body(await send({ terminalId: id, input: 'a' })).ok).toBe(true)
    expect(writesOf(proc)).toEqual(['a'])
  })

  it('a send already in flight completes', async () => {
    const { id, proc } = await spawnAgent()
    proc.respond = () => null
    const p = send({ terminalId: id, input: 'long job', keys: ['Enter'] })
    await firstWrite(proc)
    await setKillSwitch(false)
    const out = body(await p)
    expect(out).toMatchObject({ ok: true, sent: { keys: ['Enter'] } })
  })

  it('Disconnect outranks the kill-switch in the refusal order', async () => {
    const { id } = await spawnAgent()
    await setKillSwitch(false)
    disconnectTerminal(id)
    expect(body(await send({ terminalId: id, input: 'x' })).error).toBe('TERMINAL_DISCONNECTED')
  })
})

describe('B6 carry-in — list_terminals reports `free` while a lease is active', () => {
  it('an operator terminal reads confirm, then free under a lease, then confirm again', async () => {
    await openOperatorShell('h-lease')
    expect(await rowOf('h-lease')).toMatchObject({ readable: true, writable: 'confirm' })
    terminalLeases.grant('h-lease', h.open, terminalRegistry.get('h-lease')!.ptyId)
    expect(await rowOf('h-lease')).toMatchObject({ writable: 'free' })
    terminalLeases.revoke('h-lease')
    expect(await rowOf('h-lease')).toMatchObject({ writable: 'confirm' })
  })
})

describe('AC-B7-4 — after Disconnect nothing reads or types, whatever the mode or opt-in', () => {
  for (const ask of [false, true]) {
    describe(ask ? 'ask mode' : 'free mode', () => {
      it('an agent terminal: every read_terminal and send_terminal is TERMINAL_DISCONNECTED, no confirm', async () => {
        await writeMcpAsk(ask)
        const { id, proc } = await spawnAgent()
        expect(disconnectTerminal(id)).toBe(true)
        expect(body(await handleToolCall(readDef, { terminalId: id })).error).toBe(
          'TERMINAL_DISCONNECTED'
        )
        expect(body(await handleToolCall(readDef, { terminalId: id, mode: 'screen' })).error).toBe(
          'TERMINAL_DISCONNECTED'
        )
        expect(body(await send({ terminalId: id, input: 'x' })).error).toBe('TERMINAL_DISCONNECTED')
        expect(proc.writes).toEqual([])
        expect(wires).toEqual([])
      })

      it('an operator terminal with the folder opt-in ON and a lease: the same', async () => {
        await writeMcpAsk(ask)
        h.optedIn = [h.open]
        const proc = await openOperatorShell('h-opd')
        terminalLeases.grant('h-opd', h.open, terminalRegistry.get('h-opd')!.ptyId)
        disconnectTerminal('h-opd')
        expect(terminalLeases.isActive('h-opd', PTY('h-opd'))).toBe(false)
        expect(body(await handleToolCall(readDef, { terminalId: 'h-opd' })).error).toBe(
          'TERMINAL_DISCONNECTED'
        )
        expect(body(await send({ terminalId: 'h-opd', input: 'x' })).error).toBe(
          'TERMINAL_DISCONNECTED'
        )
        expect(proc.writes).toEqual([])
        expect(wires).toEqual([])
      })
    })
  }

  it('the PTY keeps running, and the operator can still type into it', async () => {
    const { id, proc } = await spawnAgent()
    disconnectTerminal(id)
    const rec = terminalRegistry.get(id)!
    expect(rec.state).toBe('running')
    expect(proc.killed).toBe(false)
    h.ipc.get('pty:write')!({}, rec.ptyId, 'ls\r')
    expect(writesOf(proc)).toEqual(['ls\r'])
  })

  it('list_terminals still lists it: disconnected, unreadable, writable revoked', async () => {
    const { id } = await spawnAgent()
    disconnectTerminal(id)
    expect(await rowOf(id)).toMatchObject({
      disconnected: true,
      readable: false,
      writable: 'revoked'
    })
  })

  it('get_session.terminals excludes it', async () => {
    const { terminalsOfSession } = await import('../src/main/mcp/fleet-snapshot')
    terminalRegistry.register({
      terminalId: 'h-own-a',
      ptyId: 'p-a',
      folder: h.open,
      origin: 'agent',
      ownerSessionId: 'sess-1',
      size: { cols: 80, rows: 24 }
    })
    terminalRegistry.register({
      terminalId: 'h-own-b',
      ptyId: 'p-b',
      folder: h.open,
      origin: 'agent',
      ownerSessionId: 'sess-1',
      size: { cols: 80, rows: 24 }
    })
    const opts = { denyFolders: [], home: os.homedir() }
    expect(
      terminalsOfSession(terminalRegistry.list(), 'sess-1', opts).map((t) => t.terminalId)
    ).toEqual(['h-own-a', 'h-own-b'])
    disconnectTerminal('h-own-a')
    expect(
      terminalsOfSession(terminalRegistry.list(), 'sess-1', opts).map((t) => t.terminalId)
    ).toEqual(['h-own-b'])
  })

  it('is permanent: disconnecting again is a no-op and a fresh lease does not revive it', async () => {
    const { id } = await spawnAgent()
    disconnectTerminal(id)
    expect(disconnectTerminal(id)).toBe(true)
    terminalLeases.grant(id, h.open, terminalRegistry.get(id)!.ptyId)
    const { state } = await resolveTerminalGate(id)
    expect(state).toMatchObject({ disconnected: true, leaseActive: false })
    expect(body(await send({ terminalId: id, input: 'x' })).error).toBe('TERMINAL_DISCONNECTED')
  })

  it('an unknown terminal cannot be disconnected', () => {
    expect(disconnectTerminal('h-nope')).toBe(false)
  })
})

describe('AC-B7-5 — a wait in flight ends at once, and a send is cut between segments', () => {
  it('Disconnect during the settle ends the call with wait.reason "disconnected", output cut at that instant', async () => {
    const { id, proc } = await spawnAgent()
    proc.respond = () => null
    const p = send({ terminalId: id, input: 'run', keys: ['Enter'] })
    await firstWrite(proc)
    // Keep the terminal chatty so the settle would otherwise run its full second.
    const chatter = setInterval(() => proc.emitData('tick\r\n'), 15)
    proc.emitData('BEFORE-DISCONNECT\r\n')
    await sleep(80)
    const started = Date.now()
    disconnectTerminal(id)
    proc.emitData('AFTER-DISCONNECT\r\n')
    const out = body(await p)
    clearInterval(chatter)
    expect(Date.now() - started).toBeLessThan(250)
    expect(out).toMatchObject({ ok: true, wait: { reason: 'disconnected' } })
    expect(out.output).toContain('BEFORE-DISCONNECT')
    expect(out.output).not.toContain('AFTER-DISCONNECT')
    // The write that was handed over completed.
    expect(writesOf(proc)).toEqual(['run\r'])
  })

  it('a send that finishes normally still says wait.reason "none"', async () => {
    const { id } = await spawnAgent()
    expect(body(await send({ terminalId: id, input: 'a' })).wait).toMatchObject({ reason: 'none' })
  })

  it('Disconnect in the gap between an Esc and the rest: the first piece stays written, none follows it', async () => {
    const { id, proc } = await spawnAgent()
    proc.respond = () => null
    const p = send({ terminalId: id, keys: ['Esc', 'Enter'] })
    await firstWrite(proc)
    disconnectTerminal(id)
    const out = body(await p)
    expect(writesOf(proc)).toEqual(['\x1b'])
    // B5's re-check before each write turns the cut into SEND_INCOMPLETE, naming the reason.
    expect(out).toMatchObject({
      ok: false,
      error: 'SEND_INCOMPLETE',
      reason: 'TERMINAL_DISCONNECTED',
      sent: { keys: ['Esc'] }
    })
  })

  it('the kill-switch is judged before every piece too: switching it off in the Esc gap stops the next one', async () => {
    const { id, proc } = await spawnAgent()
    proc.respond = () => null
    const p = send({ terminalId: id, keys: ['Esc', 'Enter'] })
    await firstWrite(proc)
    await setKillSwitch(false)
    const out = body(await p)
    expect(writesOf(proc)).toEqual(['\x1b'])
    expect(out).toMatchObject({
      ok: false,
      error: 'SEND_INCOMPLETE',
      reason: 'TERMINAL_WRITES_DISABLED'
    })
  })

  it('a send queued behind another one that is disconnected before its turn types nothing', async () => {
    const { id, proc } = await spawnAgent()
    proc.respond = () => null
    const first = send({ terminalId: id, keys: ['Esc', 'Enter'] })
    await firstWrite(proc)
    const second = send({ terminalId: id, input: 'second' })
    await sleep(5)
    disconnectTerminal(id)
    await first
    expect(body(await second).error).toBe('TERMINAL_DISCONNECTED')
    expect(writesOf(proc)).toEqual(['\x1b'])
  })
})

describe('write helpers — the pure side of the abort', () => {
  it('settleAfterSend returns as soon as abort fires, mid-sleep', async () => {
    let fire: () => void = () => {}
    const woken = new Promise<void>((r) => (fire = r))
    let aborted = false
    const t0 = Date.now()
    const p = settleAfterSend({
      now: Date.now,
      sleep: sleep,
      lastOutputAt: () => Date.now(), // never quiet
      sentAt: Date.now(),
      abort: { is: () => aborted, wake: () => woken }
    })
    setTimeout(() => {
      aborted = true
      fire()
    }, 20)
    await p
    expect(Date.now() - t0).toBeLessThan(200)
  })
})
