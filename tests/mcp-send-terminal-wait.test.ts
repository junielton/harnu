/**
 * T489 (agent terminals B8) — `send_terminal` with `waitFor`, through the REAL `handleToolCall`
 * pipeline, registry, write queue and screen model. Only `electron` and `node-pty` are stubbed;
 * the fake shell echoes what it is written (one chunk per write) and can be told to say more.
 *
 * AC-B8-1 (each reason), AC-B8-2 (no echo match), AC-B8-3 (idle from the send), AC-B8-4 (total
 * bound), AC-B8-5 (output + scrubbing), AC-B8-6 (pattern refusals at plan level), and the carried-in
 * alternate-screen and Disconnect rules. AC-B8-7 is the live check (see the report).
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
  ipc: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  procs: [] as Array<{
    writes: Array<{ data: string; at: number }>
    emitData: (d: string) => void
    emitExit: (c: number) => void
    /** What the fake shell prints for one write; default: echo, CR → CRLF. */
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
      pid: 4242,
      writes: [] as Array<{ data: string; at: number }>,
      killed: false,
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
      { path: h.open, ...(h.optedIn.includes(h.open) ? { agentTerminalRead: true } : {}) }
    ]
  })
}))

import { handleToolCall } from '../src/main/mcp/server'
import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import { terminalRegistry } from '../src/main/terminal-registry'
import { dropScreenModel, screenModelFor } from '../src/main/terminal-screen'
import { terminalWriteQueue } from '../src/main/terminal-write-queue'
import { writeMcpAsk } from '../src/main/mcp/prefs'
import { clearAuditLog } from '../src/main/mcp/audit-log'
import { _resetIdempotencyRegistry } from '../src/main/mcp/idempotency-registry'
import { _resetInflightRegistry } from '../src/main/mcp/inflight-session-registry'

const def = (op: string): (typeof WIRED_TOOLS)[number] => WIRED_TOOLS.find((t) => t.op === op)!
const sendDef = def('send_terminal')
const spawnHandler = def('spawn_terminal').handler!

let blocked = ''
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
  // A plain `BAD_ARGS: …` refusal is a bare string, every steered one is JSON.
  try {
    return JSON.parse(first.text)
  } catch {
    return { error: first.text }
  }
}

const send = (args: Record<string, unknown>): Promise<CallToolResult> =>
  handleToolCall(sendDef, args)

/** An agent terminal, spawned through the real handler. */
async function spawnAgent(): Promise<{ id: string; proc: (typeof h.procs)[number] }> {
  const ack = body(await spawnHandler({ folder: h.open }, spawnCtx()))
  return { id: ack.terminalId as string, proc: h.procs[h.procs.length - 1]! }
}

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-send-ud-'))
  h.open = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-send-open-'))
  blocked = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-send-blocked-'))
  h.denied = [blocked]
  const pty = await import('../src/main/pty')
  pty.registerPtyHandlers(() => null)
})

beforeEach(async () => {
  h.procs.length = 0
  h.optedIn = []
  clearAuditLog()
  _resetIdempotencyRegistry()
  _resetInflightRegistry()
  await writeMcpAsk(false)
})

afterEach(() => {
  vi.useRealTimers()
  for (const r of terminalRegistry.list()) {
    terminalWriteQueue.prune(() => false)
    terminalRegistry.forget(r.terminalId)
    dropScreenModel(r.terminalId)
  }
})

import { disconnectTerminal } from '../src/main/terminal-gate'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const firstWrite = (proc: (typeof h.procs)[number]): Promise<void> =>
  vi.waitFor(() => expect(proc.writes.length).toBe(1), { interval: 1, timeout: 2000 })
const waitObj = (out: Record<string, unknown>): Record<string, unknown> =>
  out.wait as Record<string, unknown>

/** The fake shell answers the typed line with `after`, `delayMs` later (the echo comes at once). */
function answer(proc: (typeof h.procs)[number], after: string, delayMs = 0): void {
  proc.respond = (data) => {
    const echo = data.replace(/\r/g, '\r\n')
    if (delayMs === 0) return echo + after
    setTimeout(() => proc.emitData(after), delayMs)
    return echo
  }
}

describe('AC-B8-1 — every wait.reason, through the pipeline', () => {
  it('pattern: returns the summary line in one call, with the matched text', async () => {
    const { id, proc } = await spawnAgent()
    proc.emitData('$ ')
    answer(proc, '3 passed, 0 failed\r\n$ ', 200)
    const out = body(
      await send({
        terminalId: id,
        input: 'npm test',
        keys: ['Enter'],
        waitFor: { pattern: '\\d+ passed' }
      })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'pattern', match: '3 passed' })
    expect(out.output).toContain('3 passed, 0 failed')
    expect(out.output).not.toContain('$ $')
  })

  it('idle: the program went quiet', async () => {
    const { id, proc } = await spawnAgent()
    answer(proc, 'compiled\r\n')
    const out = body(
      await send({ terminalId: id, input: 'make', keys: ['Enter'], waitFor: { idleMs: 200 } })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'idle' })
    expect(waitObj(out).waitedMs as number).toBeGreaterThanOrEqual(200)
    expect(out.output).toContain('compiled')
  })

  it('timeout: not an error, output is what exists so far', async () => {
    const { id, proc } = await spawnAgent()
    answer(proc, 'still going\r\n')
    const res = await send({
      terminalId: id,
      input: 'sleep 60',
      keys: ['Enter'],
      waitFor: { pattern: 'done', timeoutMs: 400 }
    })
    expect(res.isError).toBeFalsy()
    const out = body(res)
    expect(waitObj(out)).toMatchObject({ reason: 'timeout' })
    expect(waitObj(out).waitedMs as number).toBeGreaterThanOrEqual(390)
    expect(out.state).toBe('running')
    expect(out.output).toContain('still going')
  })

  it('exited: the program ended while waiting; the final lines are in output', async () => {
    const { id, proc } = await spawnAgent()
    proc.respond = () => null
    const p = send({
      terminalId: id,
      keys: ['Ctrl+D'],
      waitFor: { pattern: 'never', timeoutMs: 5000 }
    })
    await firstWrite(proc)
    await sleep(60)
    proc.emitData('logout\r\n')
    proc.emitExit(0)
    const out = body(await p)
    expect(waitObj(out)).toMatchObject({ reason: 'exited' })
    expect(waitObj(out).waitedMs as number).toBeLessThan(1500)
    expect(out.state).toBe('exited')
    expect(out.exit).toMatchObject({ code: 0 })
    expect(out.output).toContain('logout')
  })

  it('disconnected: ends at once, output cut at that instant (B7 carried into waitFor)', async () => {
    const { id, proc } = await spawnAgent()
    proc.respond = () => null
    const p = send({
      terminalId: id,
      input: 'run',
      keys: ['Enter'],
      waitFor: { pattern: 'never', idleMs: 30_000, timeoutMs: 60_000 }
    })
    await firstWrite(proc)
    const chatter = setInterval(() => proc.emitData('tick\r\n'), 15)
    proc.emitData('BEFORE-DISCONNECT\r\n')
    await sleep(120)
    const started = Date.now()
    disconnectTerminal(id)
    proc.emitData('AFTER-DISCONNECT\r\n')
    const out = body(await p)
    clearInterval(chatter)
    expect(Date.now() - started).toBeLessThan(300)
    expect(waitObj(out)).toMatchObject({ reason: 'disconnected' })
    expect(out.output).toContain('BEFORE-DISCONNECT')
    expect(out.output).not.toContain('AFTER-DISCONNECT')
  })

  it('no waitFor: still reason "none"', async () => {
    const { id } = await spawnAgent()
    expect(waitObj(body(await send({ terminalId: id, input: 'a' })))).toMatchObject({
      reason: 'none'
    })
  })
})

describe('AC-B8-2 — the typed echo never matches', () => {
  it('grep failed log on a log with no match: does NOT return `pattern` at once', async () => {
    const { id, proc } = await spawnAgent()
    proc.emitData('$ ')
    answer(proc, '$ ') // grep finds nothing, the prompt comes back
    const t0 = Date.now()
    const out = body(
      await send({
        terminalId: id,
        input: 'grep failed log',
        keys: ['Enter'],
        waitFor: { pattern: 'failed', timeoutMs: 700 }
      })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'timeout' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(690)
    // The echo is still IN the output, only the matcher skipped it.
    expect(out.output).toContain('grep failed log')
  })

  it('with idleMs instead, the same call ends on idle, never on the echo', async () => {
    const { id, proc } = await spawnAgent()
    proc.emitData('$ ')
    answer(proc, '$ ')
    const out = body(
      await send({
        terminalId: id,
        input: 'grep failed log',
        keys: ['Enter'],
        waitFor: { pattern: 'failed', idleMs: 250 }
      })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'idle' })
  })

  it('a log that does contain the word matches the program line, not the echo', async () => {
    const { id, proc } = await spawnAgent()
    proc.emitData('$ ')
    answer(proc, 'build failed: 2\r\n$ ', 350) // the program speaks 350 ms after the echo
    const out = body(
      await send({
        terminalId: id,
        input: 'grep failed log',
        keys: ['Enter'],
        waitFor: { pattern: 'failed: (\\d+)' }
      })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'pattern', match: 'failed: 2' })
    // It waited for the program (the echo was there 340 ms earlier).
    expect(waitObj(out).waitedMs as number).toBeGreaterThanOrEqual(300)
  })

  it('a prompt that already shows the word is not the program either', async () => {
    const { id, proc } = await spawnAgent()
    proc.emitData('failed-job $ ')
    answer(proc, '$ ')
    const out = body(
      await send({
        terminalId: id,
        input: 'true',
        keys: ['Enter'],
        waitFor: { pattern: 'failed', idleMs: 200 }
      })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'idle' })
  })
})

describe('AC-B8-3 — idleMs counts from the last byte of the send', () => {
  it('a long wait in the queue does not eat the quiet period', async () => {
    const { id, proc } = await spawnAgent()
    proc.respond = () => null
    const holder = terminalWriteQueue.admit(id)
    if (!holder.ok) throw new Error('admit')
    await terminalWriteQueue.acquire(id, holder.scope)
    const t0 = Date.now()
    const p = send({ terminalId: id, input: 'x', waitFor: { idleMs: 400 } })
    while (terminalWriteQueue.waiting(id) < 1) await new Promise((r) => setImmediate(r))
    await sleep(500) // the call has been alive for half a second when its turn comes
    terminalWriteQueue.release(id, holder.scope)
    terminalWriteQueue.finish(id, holder.scope)
    const out = body(await p)
    expect(waitObj(out)).toMatchObject({ reason: 'idle' })
    // Quiet is measured from the write, not from the call start: ≥ 400 ms AFTER the 500 ms queue.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    expect(waitObj(out).waitedMs as number).toBeLessThan(700)
  })

  it('the mark-at-send runs after the barrier: output printed before the send is not "since"', async () => {
    const { id, proc } = await spawnAgent()
    proc.emitData('BEFORE\r\n$ ')
    answer(proc, 'AFTER\r\n')
    const out = body(
      await send({ terminalId: id, input: 'go', keys: ['Enter'], waitFor: { pattern: 'AFTER' } })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'pattern' })
    expect(out.output).not.toContain('BEFORE')
  })
})

describe('AC-B8-4 — the total time bound', () => {
  /** Drive FAKE time (`maxMs` of it) while real I/O (file reads in the gate) still gets to run. */
  async function drive(p: Promise<unknown>, maxMs: number): Promise<number> {
    let settled = false
    void p.then(
      () => (settled = true),
      () => (settled = true)
    )
    const t0 = Date.now()
    while (!settled && Date.now() - t0 < maxMs) {
      await vi.advanceTimersByTimeAsync(100)
      await new Promise((r) => setImmediate(r))
    }
    return Date.now() - t0
  }

  it('a full 10 s queue wait + a barrier timeout + timeoutMs 90000 returns in under 120 s', async () => {
    const { id, proc } = await spawnAgent()
    proc.respond = () => null
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // Every barrier hangs until its own budget runs out: the model is stalled.
    const model = screenModelFor(id)!
    vi.spyOn(model, 'barrier').mockImplementation(
      (ms = 2000) => new Promise<boolean>((r) => setTimeout(() => r(true), ms))
    )
    const holder = terminalWriteQueue.admit(id)
    if (!holder.ok) throw new Error('admit')
    await terminalWriteQueue.acquire(id, holder.scope)

    const t0 = Date.now() // fake clock
    const p = send({ terminalId: id, input: 'x', waitFor: { pattern: 'never', timeoutMs: 90_000 } })
    while (terminalWriteQueue.waiting(id) < 1) await new Promise((r) => setImmediate(r))
    await vi.advanceTimersByTimeAsync(9_900) // nearly the whole 10 s in the queue
    terminalWriteQueue.release(id, holder.scope)
    terminalWriteQueue.finish(id, holder.scope)
    await drive(p, 130_000)
    const out = body(await p)
    const elapsed = Date.now() - t0
    expect(waitObj(out)).toMatchObject({ reason: 'timeout' })
    expect(out.approximate).toBe(true)
    // 9.9 s in the queue + 2 s barrier + 90 s wait + a final read that keeps ≥ 50 ms of barrier.
    expect(elapsed).toBeGreaterThanOrEqual(101_800)
    expect(elapsed).toBeLessThan(102_300)
    expect(elapsed).toBeLessThan(120_000)
  }, 60_000)

  it('timeoutMs above 90,000 is BAD_ARGS, and so is every other out-of-range waitFor', async () => {
    const { id, proc } = await spawnAgent()
    for (const ask of [false, true]) {
      await writeMcpAsk(ask)
      for (const waitFor of [
        { pattern: 'x', timeoutMs: 90_001 },
        { pattern: 'x', timeoutMs: 99 },
        { idleMs: 49 },
        { idleMs: 30_001 },
        { timeoutMs: 1.5 },
        {},
        { pattern: 'x', bogus: 1 }
      ]) {
        const res = await send({ terminalId: id, input: 'x', waitFor })
        expect(res.isError).toBe(true)
        expect(JSON.stringify(body(res))).toContain('BAD_ARGS')
      }
    }
    expect(proc.writes).toEqual([])
  })

  it('without waitFor the wait stage is at most 1 s, even on a terminal that never goes quiet', async () => {
    const { id, proc } = await spawnAgent()
    const chatter = setInterval(() => proc.emitData('noise\r\n'), 10)
    const t0 = Date.now()
    const out = body(await send({ terminalId: id, input: 'x' }))
    clearInterval(chatter)
    expect(waitObj(out)).toMatchObject({ reason: 'none' })
    // The 1 s cap, plus the few ms of jitter a timer tick can overshoot by under load.
    expect(waitObj(out).waitedMs as number).toBeLessThanOrEqual(1050)
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  it('and not even a stalled model (a barrier that never clears) stretches it past ~1 s', async () => {
    const { id, proc } = await spawnAgent()
    proc.respond = () => null
    // A read waits at the barrier through xterm's own write callback (`atBarrier`), so the stall
    // is simulated there: chunks queue up (pendingBytes > 0) and none is ever reported parsed.
    const term = (screenModelFor(id) as unknown as { term: { write: unknown } }).term
    term.write = (): void => {}
    const chatter = setInterval(() => proc.emitData('noise\r\n'), 10)
    const t0 = Date.now()
    const out = body(await send({ terminalId: id, input: 'x' }))
    clearInterval(chatter)
    expect(out.approximate).toBe(true)
    // 1 s settle cap + the 50 ms floor a read keeps for its barrier.
    expect(Date.now() - t0).toBeLessThan(1300)
  })
})

describe('AC-B8-5 — output is scrubbed, the matcher is not', () => {
  it('the matcher sees the secret, wait.match and output do not', async () => {
    const { id, proc } = await spawnAgent()
    const home = os.homedir()
    answer(proc, `key AKIAIOSFODNN7EXAMPLE at ${home}/notes\r\n`, 150)
    const out = body(
      await send({
        terminalId: id,
        input: 'env',
        keys: ['Enter'],
        waitFor: { pattern: 'AKIA[0-9A-Z]{16}' }
      })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'pattern' })
    expect(JSON.stringify(out)).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(String(waitObj(out).match)).toContain('<redacted>')
    expect(String(out.output)).toContain('~/notes')
  })

  it('the home path matches as printed, and comes back as ~', async () => {
    const { id, proc } = await spawnAgent()
    const home = os.homedir()
    answer(proc, `cwd ${home}/proj\r\n`, 100)
    const out = body(
      await send({
        terminalId: id,
        input: 'pwd',
        keys: ['Enter'],
        waitFor: { pattern: `${home.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/proj` }
      })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'pattern', match: '~/proj' })
  })

  it('caps and truncated work as in read_terminal; a cursor comes back', async () => {
    const { id, proc } = await spawnAgent()
    const wall = Array.from(
      { length: 800 },
      (_, i) => `line-${String(i).padStart(4, '0')}-${'x'.repeat(40)}`
    )
    answer(proc, `${wall.join('\r\n')}\r\nEND-MARK\r\n`, 100)
    const out = body(
      await send({
        terminalId: id,
        input: 'dump',
        keys: ['Enter'],
        waitFor: { pattern: 'END-MARK' }
      })
    )
    expect(waitObj(out).reason).toBe('pattern')
    expect(out.truncated).toBe(true)
    expect(String(out.output).length).toBeLessThanOrEqual(20_000)
    expect(String(out.output)).toContain('END-MARK') // the tail is kept
    expect(out.droppedLines as number).toBeGreaterThan(0)
    expect(typeof out.cursor).toBe('string')
  })
})

describe('AC-B8-6 — a pattern that cannot be used is refused before anything is typed', () => {
  it.each([
    ['over 200 characters', 'a'.repeat(201)],
    ['does not compile', '(unclosed'],
    ['empty', ''],
    ['matches the empty string', 'x*']
  ])('%s → WAIT_PATTERN_INVALID in free and ask mode, nothing written', async (_l, pattern) => {
    const { id, proc } = await spawnAgent()
    for (const ask of [false, true]) {
      await writeMcpAsk(ask)
      const res = await send({ terminalId: id, input: 'x', keys: ['Enter'], waitFor: { pattern } })
      expect(res.isError).toBe(true)
      const out = body(res)
      expect(out.error).toBe('WAIT_PATTERN_INVALID')
      expect(String(out.message).length).toBeGreaterThan(10)
    }
    expect(proc.writes).toEqual([])
    expect(terminalRegistry.get(id)!.lastAgentWriteAt).toBeNull()
  })

  it('exactly 200 characters compiles', async () => {
    const { id } = await spawnAgent()
    const out = body(
      await send({
        terminalId: id,
        input: 'x',
        waitFor: { pattern: 'a'.repeat(200), timeoutMs: 100 }
      })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'timeout' })
  })

  it('a pattern that would freeze the matcher is cut off, switched off, and the call still returns', async () => {
    const { id, proc } = await spawnAgent()
    proc.emitData('$ ')
    answer(proc, `${'a'.repeat(60_000)}\r\n`, 80)
    const t0 = Date.now()
    const out = body(
      await send({
        terminalId: id,
        input: 'go',
        keys: ['Enter'],
        waitFor: { pattern: 'a*a*a*a*a*a*b', idleMs: 300, timeoutMs: 3000 }
      })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'idle', patternDisabled: true })
    expect(Date.now() - t0).toBeLessThan(2500)
  })
})

describe('alternate screen (spec amendment 6)', () => {
  it('a pattern matches the rows the program changed; output is the whole screen, altScreen true', async () => {
    const { id, proc } = await spawnAgent()
    proc.emitData('\x1b[?1049h\x1b[Hmenu: pick one\x1b[2;1Hsel: 1')
    proc.respond = (data) => (data === '\x1b[B' ? '\x1b[2;1H\x1b[Ksel: 2' : null)
    const out = body(
      await send({
        terminalId: id,
        keys: ['Down'],
        waitFor: { pattern: 'sel: 2', timeoutMs: 2000 }
      })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'pattern', match: 'sel: 2' })
    expect(out).toMatchObject({ altScreen: true, cursor: null })
    expect(out.output).toContain('menu: pick one')
  })

  it('text that was already on the alternate screen does not match', async () => {
    const { id, proc } = await spawnAgent()
    proc.emitData('\x1b[?1049h\x1b[Hdone: 3 passed')
    proc.respond = () => null
    const out = body(
      await send({ terminalId: id, keys: ['Down'], waitFor: { pattern: 'passed', idleMs: 200 } })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'idle' })
  })
})

describe('the catalog advertises waitFor', () => {
  it('send_terminal accepts the documented shape and rejects out-of-range values', () => {
    const schema = MCP_TOOLS.find((t) => t.op === 'send_terminal')!.inputSchema
    const base = { terminalId: 'h-1', input: 'x' }
    expect(
      schema.safeParse({ ...base, waitFor: { pattern: 'a', idleMs: 50, timeoutMs: 90_000 } })
        .success
    ).toBe(true)
    expect(schema.safeParse({ ...base, waitFor: { timeoutMs: 90_001 } }).success).toBe(false)
    expect(schema.safeParse({ ...base, waitFor: { idleMs: 49 } }).success).toBe(false)
  })
})

describe('F1 — right prompts and autosuggestion ghosts are not program output (pipeline)', () => {
  it('zsh RPROMPT on the accepted line: `% cmd      [10:24]` does not match', async () => {
    const { id, proc } = await spawnAgent()
    proc.emitData('% ')
    // The accepted line comes back with the right prompt at the far end.
    proc.respond = (data) => `${data.replace(/\r/g, '')}${' '.repeat(20)}[10:24]\r\n% `
    const out = body(
      await send({
        terminalId: id,
        input: 'grep failed log',
        keys: ['Enter'],
        waitFor: { pattern: 'failed', idleMs: 250 }
      })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'idle' })
    expect(out.output).toContain('grep failed log') // the echo is still in the output
  })

  it('an autosuggestion ghost after the typed text does not match', async () => {
    const { id, proc } = await spawnAgent()
    proc.emitData('% ')
    // Typed `grep failed`; the shell paints its history suggestion ` log` behind it.
    proc.respond = (data) => `${data} log`
    const out = body(
      await send({
        terminalId: id,
        input: 'grep failed',
        waitFor: { pattern: 'failed log', idleMs: 250 }
      })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'idle' })
  })

  it('and the program line after such an echo still matches', async () => {
    const { id, proc } = await spawnAgent()
    proc.emitData('% ')
    proc.respond = (data) => {
      setTimeout(() => proc.emitData('2 tests failed\r\n% '), 250)
      return `${data.replace(/\r/g, '')}${' '.repeat(20)}[10:24]\r\n`
    }
    const out = body(
      await send({
        terminalId: id,
        input: 'grep failed log',
        keys: ['Enter'],
        waitFor: { pattern: 'failed' }
      })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'pattern', match: 'failed' })
    expect(waitObj(out).waitedMs as number).toBeGreaterThanOrEqual(200)
  })
})

describe('F3 — wait.match is scrubbed in its line, not alone (pipeline)', () => {
  it.each([
    [
      'API_TOKEN lookbehind',
      'API_TOKEN=s3cr3tvalue9876543',
      '(?<=API_TOKEN=)\\S+',
      's3cr3tvalue9876543'
    ],
    [
      'Bearer lookbehind',
      'Authorization: Bearer abcdef0123456789abcdef',
      '(?<=Bearer )\\S+',
      'abcdef0123456789abcdef'
    ]
  ])('%s', async (_label, printed, pattern, secret) => {
    const { id, proc } = await spawnAgent()
    answer(proc, `${printed}\r\n`, 120)
    const out = body(
      await send({ terminalId: id, input: 'env', keys: ['Enter'], waitFor: { pattern } })
    )
    expect(waitObj(out)).toMatchObject({ reason: 'pattern' })
    expect(JSON.stringify(out)).not.toContain(secret)
    expect(waitObj(out).match).toBe('<redacted>')
    expect(String(out.output)).toContain('<redacted>')
  })
})
