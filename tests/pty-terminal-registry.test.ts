/**
 * T478 (agent terminals B1) — the PTY layer's side of the terminal registry.
 *
 * Runs the real `registerPtyHandlers` / `createPty` with only electron's `ipcMain` and
 * `node-pty` stubbed, and covers AC-B1-7 (terminal PTYs carry no `sessionKey`), AC-B1-8
 * (`closed` vs `natural`, tombstone), AC-B1-9 (`pty:rekey` rewrites the owner) and
 * AC-B1-10 (`pty:write` stamps the operator's keystrokes, not terminal replies).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

interface FakeProc {
  write: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  emitData: (d: string) => void
  emitExit: (code: number) => void
}

const h = vi.hoisted(() => ({
  userDataDir: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  procs: [] as unknown[]
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
    handle: (channel: string, fn: (...args: unknown[]) => unknown): void => {
      h.handlers.set(channel, fn)
    },
    on: (channel: string, fn: (...args: unknown[]) => void): void => {
      h.listeners.set(channel, fn)
    }
  }
}))

vi.mock('node-pty', () => ({
  spawn: (): unknown => {
    const dataCbs: Array<(d: string) => void> = []
    const exitCbs: Array<(e: { exitCode: number }) => void> = []
    const proc = {
      pid: 4242,
      onData: (cb: (d: string) => void): void => {
        dataCbs.push(cb)
      },
      onExit: (cb: (e: { exitCode: number }) => void): void => {
        exitCbs.push(cb)
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pause: (): void => {},
      resume: (): void => {},
      emitData: (d: string): void => dataCbs.forEach((cb) => cb(d)),
      emitExit: (code: number): void => exitCbs.forEach((cb) => cb({ exitCode: code }))
    }
    h.procs.push(proc)
    return proc
  }
}))

let cwd: string
let pty: typeof import('../src/main/pty')
let registry: typeof import('../src/main/terminal-registry').terminalRegistry
const deps = (): Parameters<typeof import('../src/main/pty').createPty>[1] => ({
  getWindow: () => ({ webContents: { send: vi.fn() } }) as never,
  flushNow: vi.fn(),
  runPolicy: vi.fn(() => [] as string[])
})

const lastProc = (): FakeProc => h.procs[h.procs.length - 1] as FakeProc

async function spawnTerminal(over: Record<string, unknown> = {}): Promise<string> {
  return pty.createPty(
    {
      kind: 'shell',
      cmd: '/bin/sh',
      cwd,
      cols: 120,
      rows: 30,
      terminal: { terminalId: 'h-a', folder: cwd, origin: 'agent', ownerSessionId: 'sess-1' },
      ...over
    },
    deps()
  )
}

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-term-reg-ud-'))
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-term-reg-cwd-'))
  pty = await import('../src/main/pty')
  registry = (await import('../src/main/terminal-registry')).terminalRegistry
  pty.registerPtyHandlers(() => null)
})

beforeEach(() => {
  h.procs.length = 0
})

afterEach(() => {
  for (const r of registry.list()) registry.forget(r.terminalId)
})

describe('createPty with a terminal', () => {
  it('registers a running record under the pane id, with the spawn size', async () => {
    const ptyId = await spawnTerminal()
    expect(registry.get('h-a')).toMatchObject({
      terminalId: 'h-a',
      ptyId,
      folder: cwd,
      origin: 'agent',
      ownerSessionId: 'sess-1',
      state: 'running',
      size: { cols: 120, rows: 30 }
    })
  })

  it('registers nothing for an ordinary shell PTY', async () => {
    await pty.createPty({ kind: 'shell', cmd: '/bin/sh', cwd, cols: 80, rows: 24 }, deps())
    expect(registry.list()).toEqual([])
  })

  it('AC-B1-7: carries no sessionKey — absent from pty:list and livePtyDescriptors()', async () => {
    const ptyId = await spawnTerminal()
    const list = (await h.handlers.get('pty:list')!({})) as Array<{ ptyId: string }>
    expect(list.map((r) => r.ptyId)).not.toContain(ptyId)
    expect(pty.livePtyDescriptors().map((d) => d.ptyId)).not.toContain(ptyId)
    expect(pty.liveSessionKeys().size).toBe(0)
  })

  it('tracks output, the program title and resizes', async () => {
    const ptyId = await spawnTerminal()
    lastProc().emitData('\x1b]0;vim notes.md\x07')
    h.listeners.get('pty:resize')!({}, ptyId, 100, 40)
    expect(registry.get('h-a')).toMatchObject({
      title: 'vim notes.md',
      size: { cols: 100, rows: 40 }
    })
  })
})

describe('AC-B1-8: exit reason', () => {
  it('a natural exit tombstones the record as natural', async () => {
    await spawnTerminal()
    lastProc().emitExit(0)
    expect(registry.get('h-a')).toMatchObject({
      state: 'exited',
      exit: { code: 0, reason: 'natural' }
    })
  })

  it('pty:destroy ran first → closed, and the kill happened after the flag was set', async () => {
    const ptyId = await spawnTerminal()
    const proc = lastProc()
    let reasonWhenKilled: string | undefined
    proc.kill.mockImplementation(() => {
      // onExit may fire synchronously from kill(); it must already see the flag.
      proc.emitExit(143)
      reasonWhenKilled = registry.get('h-a')?.exit?.reason
    })
    h.listeners.get('pty:destroy')!({}, ptyId)
    expect(proc.kill).toHaveBeenCalledTimes(1)
    expect(reasonWhenKilled).toBe('closed')
    expect(registry.get('h-a')?.state).toBe('exited')
  })
})

describe('AC-B1-9: pty:rekey', () => {
  it('rewrites the owner of the synthetic session’s terminals', async () => {
    await spawnTerminal({
      terminal: { terminalId: 'h-a', folder: cwd, origin: 'agent', ownerSessionId: 'synthetic-9' }
    })
    await spawnTerminal({
      terminal: { terminalId: 'h-b', folder: cwd, origin: 'agent', ownerSessionId: 'someone-else' }
    })
    h.listeners.get('pty:rekey')!({}, 'synthetic-9', 'real-9')
    expect(registry.get('h-a')?.ownerSessionId).toBe('real-9')
    expect(registry.get('h-b')?.ownerSessionId).toBe('someone-else')
  })
})

describe('AC-B1-10: pty:write', () => {
  it('stamps lastOperatorWriteAt for ordinary input and still writes the bytes', async () => {
    const ptyId = await spawnTerminal()
    h.listeners.get('pty:write')!({}, ptyId, 'ls\r')
    expect(registry.get('h-a')?.lastOperatorWriteAt).toEqual(expect.any(Number))
    expect(lastProc().write).toHaveBeenCalledWith('ls\r')
  })

  it.each([
    ['CPR', '\x1b[3;7R'],
    ['DA1', '\x1b[?1;2c'],
    ['focus', '\x1b[I'],
    ['OSC reply', '\x1b]11;rgb:0000/0000/0000\x07']
  ])('does not stamp for a wholly-reply %s payload, but still writes it', async (_n, data) => {
    const ptyId = await spawnTerminal()
    h.listeners.get('pty:write')!({}, ptyId, data)
    expect(registry.get('h-a')?.lastOperatorWriteAt).toBeNull()
    expect(lastProc().write).toHaveBeenCalledWith(data)
  })

  it('leaves an unregistered PTY exactly as it was', async () => {
    const ptyId = await pty.createPty(
      { kind: 'shell', cmd: '/bin/sh', cwd, cols: 80, rows: 24 },
      deps()
    )
    h.listeners.get('pty:write')!({}, ptyId, 'x')
    expect(lastProc().write).toHaveBeenCalledWith('x')
    expect(registry.list()).toEqual([])
  })
})

describe('discardTerminalPty (AC-B1-4 building block)', () => {
  it('kills the process and leaves no registry record, not even a tombstone', async () => {
    const ptyId = await spawnTerminal()
    const proc = lastProc()
    pty.discardTerminalPty(ptyId)
    expect(proc.kill).toHaveBeenCalledTimes(1)
    expect(registry.get('h-a')).toBeUndefined()
    // The exit that follows the kill must not resurrect it.
    proc.emitExit(143)
    expect(registry.get('h-a')).toBeUndefined()
    expect(registry.list()).toEqual([])
  })

  it('is a no-op for an unknown ptyId', () => {
    expect(() => pty.discardTerminalPty('nope')).not.toThrow()
  })
})

describe('pty:create (IPC) cannot register an AGENT terminal', () => {
  // T481: the renderer MAY name its own shell pane so the registry knows the operator's terminal
  // (see `mcp-terminal-read-optin.test.ts`), but whatever origin it claims, the record is the
  // operator's: only main registers an agent-origin terminal.
  it('forces a renderer-supplied `terminal` to the operator origin', async () => {
    await h.handlers.get('pty:create')!(
      {},
      {
        kind: 'shell',
        cmd: '/bin/sh',
        cwd,
        cols: 80,
        rows: 24,
        terminal: { terminalId: 'h-forged', folder: cwd, origin: 'agent' }
      }
    )
    const rec = registry.get('h-forged')!
    expect(rec.origin).toBe('operator')
    expect(rec.ownerSessionId).toBeNull()
    expect(registry.liveAgentTerminals()).toEqual([])
    expect(registry.liveAgentCount(cwd)).toBe(0)
  })
})
