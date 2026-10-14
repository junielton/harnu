/**
 * T479 (agent terminals B2) — main owns an agent terminal's teardown.
 *
 * Same harness as `pty-terminal-registry.test.ts`: the real `registerPtyHandlers` / `createPty`
 * with only electron's `ipcMain` and `node-pty` stubbed. Covers the main half of AC-B2-5
 * (`terminal:close` kills the PTY of a pane that never mounted and frees its `TERMINAL_LIMIT`
 * slot at once) and the tombstone snapshot a pane that mounts after the exit paints (AC-B2-3).
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

describe('closeTerminalPty', () => {
  it('AC-B2-5: kills the PTY of a terminal nobody ever mounted and frees its limit slot at once', async () => {
    await spawnTerminal()
    expect(registry.liveAgentCount(cwd)).toBe(1)

    expect(pty.closeTerminalPty('h-a')).toBe(true)

    expect(lastProc().kill).toHaveBeenCalledTimes(1)
    // Freed before the kernel reports the exit: the very next spawn_terminal must not hit
    // TERMINAL_LIMIT because of a terminal that was already closed.
    expect(registry.liveAgentCount(cwd)).toBe(0)
    expect(registry.get('h-a')).toMatchObject({ state: 'exited', exit: { reason: 'closed' } })
  })

  it('keeps the tail of the output as the tombstone snapshot', async () => {
    await spawnTerminal()
    lastProc().emitData('building\r\ndone\r\n')
    pty.closeTerminalPty('h-a')
    expect(registry.get('h-a')?.finalSnapshot).toBe('building\r\ndone\r\n')
  })

  it('the exit event that follows does not overwrite the closed tombstone', async () => {
    await spawnTerminal()
    const proc = lastProc()
    pty.closeTerminalPty('h-a')
    proc.emitExit(0)
    expect(registry.get('h-a')?.exit?.reason).toBe('closed')
  })

  it('is false for an unknown terminal, an exited one, and a second close', async () => {
    expect(pty.closeTerminalPty('h-ghost')).toBe(false)
    await spawnTerminal()
    expect(pty.closeTerminalPty('h-a')).toBe(true)
    expect(pty.closeTerminalPty('h-a')).toBe(false)
    expect(lastProc().kill).toHaveBeenCalledTimes(1)
  })
})

describe('a natural exit', () => {
  it('AC-B2-3: leaves the last output on the tombstone for a pane that mounts afterwards', async () => {
    // main's own door, so the real flush runs (the injected `deps()` stub never fills the ring)
    await pty.createTerminalPty({ terminalId: 'h-a', folder: cwd, ownerSessionId: null })
    lastProc().emitData('first\r\nlast words\r\n')
    lastProc().emitExit(2)
    expect(registry.get('h-a')).toMatchObject({
      state: 'exited',
      exit: { code: 2, reason: 'natural' },
      finalSnapshot: 'first\r\nlast words\r\n'
    })
  })
})
