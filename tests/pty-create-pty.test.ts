/**
 * T475 (agent terminals B0, AC-B0-2) — `createPty` is callable without an IPC event.
 *
 * Spawns a `shell` PTY straight through the exported `createPty`, with injected
 * `getWindow` / `flushNow` / `runPolicy` fakes and `node-pty` stubbed, and checks the
 * spawn, the returned id, the session registration and the data/exit wiring.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({
  userDataDir: '',
  spawns: [] as Array<{ command: string; args: string[]; opts: Record<string, unknown> }>,
  dataCbs: [] as Array<(d: string) => void>,
  exitCbs: [] as Array<(e: { exitCode: number; signal?: number }) => void>
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
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

vi.mock('node-pty', () => ({
  spawn: (command: string, args: string[], opts: Record<string, unknown>): unknown => {
    h.spawns.push({ command, args: [...args], opts })
    return {
      pid: 4242,
      onData: (cb: (d: string) => void): void => {
        h.dataCbs.push(cb)
      },
      onExit: (cb: (e: { exitCode: number; signal?: number }) => void): void => {
        h.exitCbs.push(cb)
      },
      write: (): void => {},
      resize: (): void => {},
      kill: (): void => {},
      pause: (): void => {},
      resume: (): void => {}
    }
  }
}))

let cwd: string
let createPty: typeof import('../src/main/pty').createPty

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-create-pty-ud-'))
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-create-pty-cwd-'))
  createPty = (await import('../src/main/pty')).createPty
})

beforeEach(() => {
  h.spawns.length = 0
  h.dataCbs.length = 0
  h.exitCbs.length = 0
})

function fakeDeps(): {
  send: ReturnType<typeof vi.fn>
  flushNow: ReturnType<typeof vi.fn>
  runPolicy: ReturnType<typeof vi.fn>
  deps: Parameters<typeof createPty>[1]
} {
  const send = vi.fn()
  const flushNow = vi.fn()
  const runPolicy = vi.fn(() => [] as string[])
  const deps = {
    getWindow: () => ({ webContents: { send } }) as never,
    flushNow,
    runPolicy
  }
  return { send, flushNow, runPolicy, deps }
}

describe('createPty — callable without an IPC event', () => {
  it('spawns a shell PTY and returns its id', async () => {
    const { deps, runPolicy } = fakeDeps()
    const id = await createPty(
      { kind: 'shell', cmd: '/bin/sh', args: ['-c', 'true'], cwd, cols: 90, rows: 28 },
      deps
    )
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    expect(h.spawns).toHaveLength(1)
    expect(h.spawns[0]).toMatchObject({
      command: '/bin/sh',
      args: ['-c', 'true'],
      opts: { name: 'xterm-256color', cwd, cols: 90, rows: 28 }
    })
    // No sessionKey → no capacity policy run (a plain shell is not fleet growth).
    expect(runPolicy).not.toHaveBeenCalled()
  })

  it('drains through the injected flushNow when the process exits, then announces pty:exit', async () => {
    const { deps, flushNow, send } = fakeDeps()
    const id = await createPty({ kind: 'shell', cmd: '/bin/sh', cwd, cols: 80, rows: 24 }, deps)
    expect(h.exitCbs).toHaveLength(1)
    h.exitCbs[0]({ exitCode: 0 })
    expect(flushNow).toHaveBeenCalledWith(id)
    expect(send).toHaveBeenCalledWith('pty:exit', {
      id,
      exitCode: 0,
      signal: undefined,
      reason: 'natural'
    })
  })

  it('schedules a flush on output through the injected flushNow once the watermark is hit', async () => {
    const { deps, flushNow } = fakeDeps()
    const id = await createPty({ kind: 'shell', cmd: '/bin/sh', cwd, cols: 80, rows: 24 }, deps)
    h.dataCbs[0]('x'.repeat(256 * 1024))
    expect(flushNow).toHaveBeenCalledWith(id)
  })

  it('with a sessionKey: runs the cap policy, announces readiness, and dedups a second call', async () => {
    const { deps, runPolicy, send } = fakeDeps()
    const opts = {
      kind: 'shell' as const,
      cmd: '/bin/sh',
      cwd,
      cols: 80,
      rows: 24,
      sessionKey: 'create-pty-test-key'
    }
    const id = await createPty(opts, deps)
    expect(runPolicy).toHaveBeenCalledWith('cap')
    expect(send).toHaveBeenCalledWith('pty:sessionReady', {
      sessionKey: 'create-pty-test-key',
      ptyId: id
    })
    const again = await createPty(opts, deps)
    expect(again).toBe(id)
    expect(h.spawns).toHaveLength(1)
  })
})
