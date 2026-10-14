/* eslint-disable no-control-regex -- the assertions match terminal escape replies (ESC [ …) */
/**
 * T480 (agent terminals B3) — the PTY layer's side of the screen model, with the real
 * `registerPtyHandlers` / `createPty` and only electron's `ipcMain`/`app`/`webContents` and
 * `node-pty` stubbed.
 *
 * AC-B3-7 (one answerer across the replay handover), AC-B3-9 (the PTY pauses on a model backlog
 * and resumes), AC-B3-11 (reload / crash reset), and the resolved tombstone snapshot.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Terminal } from '@xterm/headless'

interface FakeProc {
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  emitData: (d: string) => void
  emitExit: (code: number) => void
}

const h = vi.hoisted(() => ({
  userDataDir: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  appListeners: new Map<string, (...args: unknown[]) => void>(),
  procs: [] as unknown[]
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.userDataDir,
    on: (event: string, fn: (...args: unknown[]) => void): void => {
      h.appListeners.set(event, fn)
    }
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  webContents: { getAllWebContents: (): unknown[] => [] },
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
      pause: vi.fn(),
      resume: vi.fn(),
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
let screen: typeof import('../src/main/terminal-screen')
let ipc: typeof import('../src/main/terminal-ipc')
const TOMBSTONE_MS = 10 * 60_000

const deps = (): Parameters<typeof import('../src/main/pty').createPty>[1] => ({
  getWindow: () => ({ webContents: { send: vi.fn() } }) as never,
  flushNow: vi.fn(),
  runPolicy: vi.fn(() => [] as string[])
})
const lastProc = (): FakeProc => h.procs[h.procs.length - 1] as FakeProc
const CPR = /^\x1b\[\d+;\d+R$/

async function spawnTerminal(
  id = 'h-a',
  origin: 'agent' | 'operator' = 'agent'
): Promise<{ ptyId: string; proc: FakeProc }> {
  const ptyId = await pty.createPty(
    {
      kind: 'shell',
      cmd: '/bin/sh',
      cwd,
      cols: 120,
      rows: 30,
      terminal: { terminalId: id, folder: cwd, origin, ownerSessionId: null }
    },
    deps()
  )
  return { ptyId, proc: lastProc() }
}

/** Let the model parse everything fed so far (and so emit its replies). */
const settle = (id = 'h-a'): Promise<boolean> => screen.screenModelFor(id)!.barrier()
const replies = (proc: FakeProc): string[] => proc.write.mock.calls.map((c) => c[0] as string)

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-term-screen-ud-'))
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-term-screen-cwd-'))
  pty = await import('../src/main/pty')
  registry = (await import('../src/main/terminal-registry')).terminalRegistry
  screen = await import('../src/main/terminal-screen')
  ipc = await import('../src/main/terminal-ipc')
  pty.registerPtyHandlers(() => null)
  ipc.registerTerminalIpc({ dispatch: vi.fn(async () => undefined) }, (url) =>
    url.startsWith('file:///app/')
  )
})

beforeEach(() => {
  h.procs.length = 0
})

afterEach(() => {
  for (const r of registry.list()) {
    registry.forget(r.terminalId)
    screen.dropScreenModel(r.terminalId)
  }
})

describe('the model is born with an agent terminal', () => {
  it('exists for an agent terminal, not for an operator one or an ordinary shell', async () => {
    await spawnTerminal('h-a', 'agent')
    await spawnTerminal('h-op', 'operator')
    await pty.createPty({ kind: 'shell', cmd: '/bin/sh', cwd, cols: 80, rows: 24 }, deps())
    expect(screen.screenModelFor('h-a')).toBeDefined()
    expect(screen.screenModelFor('h-op')).toBeUndefined()
  })

  it('follows every byte the PTY produces and every resize', async () => {
    const { ptyId, proc } = await spawnTerminal()
    proc.emitData('hello\r\nworld\r\n')
    h.listeners.get('pty:resize')!({}, ptyId, 100, 40)
    const r = await screen.screenModelFor('h-a')!.read({ mode: 'tail' })
    expect(r).toMatchObject({ ok: true, text: 'hello\nworld', size: { cols: 100, rows: 40 } })
  })
})

describe('AC-B3-7: exactly one answerer across the replay handover', () => {
  it('with no renderer xterm attached, the model answers a DSR/DA query the shell printed', async () => {
    const { proc } = await spawnTerminal()
    expect(registry.get('h-a')!.rendererAttached).toBe(false)
    proc.emitData('\x1b[6n\x1b[c')
    await settle()
    expect(replies(proc).filter((r) => CPR.test(r))).toHaveLength(1)
    expect(replies(proc).filter((r) => /^\x1b\[\?[\d;]+c$/.test(r))).toHaveLength(1)
  })

  it("the replay marks the renderer attached; queries after it are the renderer's alone", async () => {
    const { ptyId, proc } = await spawnTerminal()
    proc.emitData('before\x1b[6n') // inside the replayed bytes: the model answers it once
    const replay = (await h.handlers.get('pty:replay')!({}, ptyId)) as { data: string }
    expect(registry.get('h-a')!.rendererAttached).toBe(true)
    expect(replay.data).toContain('before')
    proc.emitData('after\x1b[6n') // live bytes the adopting xterm answers
    await settle()
    expect(replies(proc).filter((r) => CPR.test(r))).toHaveLength(1)
  })

  it('a query fed just before the handover is still answered once, even if the parse lags it', async () => {
    const { ptyId, proc } = await spawnTerminal()
    proc.emitData('x\x1b[6n') // fed, NOT yet parsed (no await)
    await h.handlers.get('pty:replay')!({}, ptyId) // the handover happens first
    await settle()
    expect(replies(proc).filter((r) => CPR.test(r))).toHaveLength(1)
  })

  it('terminal:xtermGone hands answering back to the model', async () => {
    const { ptyId, proc } = await spawnTerminal()
    await h.handlers.get('pty:replay')!({}, ptyId)
    proc.emitData('\x1b[6n')
    await settle()
    expect(replies(proc)).toEqual([])
    h.listeners.get('terminal:xtermGone')!({}, 'h-a')
    expect(registry.get('h-a')!.rendererAttached).toBe(false)
    proc.emitData('\x1b[6n')
    await settle()
    expect(replies(proc).filter((r) => CPR.test(r))).toHaveLength(1)
  })

  it('replaying an ordinary shell touches no registry state', async () => {
    const ptyId = await pty.createPty(
      { kind: 'shell', cmd: '/bin/sh', cwd, cols: 80, rows: 24 },
      deps()
    )
    await expect(h.handlers.get('pty:replay')!({}, ptyId)).resolves.toMatchObject({ data: '' })
  })
})

describe('AC-B3-11: rendererAttached is reset on reload and crash', () => {
  function fakeWindow(): {
    emit: (event: string, ...args: unknown[]) => void
  } {
    const on = new Map<string, (...args: unknown[]) => void>()
    const wc = {
      getType: (): string => 'window',
      on: (event: string, fn: (...args: unknown[]) => void): void => {
        on.set(event, fn)
      }
    }
    h.appListeners.get('web-contents-created')!({}, wc)
    return { emit: (event, ...args) => on.get(event)!(...args) }
  }

  it('render-process-gone: every record goes false and the model answers a query again', async () => {
    const a = await spawnTerminal('h-a')
    await spawnTerminal('h-b')
    await h.handlers.get('pty:replay')!({}, a.ptyId)
    registry.setRendererAttached('h-b', true)
    const win = fakeWindow()
    win.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(registry.list().map((r) => r.rendererAttached)).toEqual([false, false])
    a.proc.emitData('\x1b[6n')
    await settle('h-a')
    expect(replies(a.proc).filter((r) => CPR.test(r))).toHaveLength(1)
  })

  it('a main-frame navigation to the renderer (a reload) resets; same-document and sub-frame ones do not', async () => {
    const a = await spawnTerminal('h-a')
    const win = fakeWindow()
    const url = 'file:///app/index.html'
    for (const details of [
      { isMainFrame: true, isSameDocument: true, url },
      { isMainFrame: false, isSameDocument: false, url }
    ]) {
      await h.handlers.get('pty:replay')!({}, a.ptyId)
      win.emit('did-start-navigation', details)
      expect(registry.get('h-a')!.rendererAttached).toBe(true)
    }
    win.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url })
    expect(registry.get('h-a')!.rendererAttached).toBe(false)
  })

  it('a navigation Harnu is about to BLOCK (a dropped file) does not reset: the xterms are still alive', async () => {
    const a = await spawnTerminal('h-a')
    const win = fakeWindow()
    await h.handlers.get('pty:replay')!({}, a.ptyId)
    win.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'file:///home/u/dropped.html'
    })
    expect(registry.get('h-a')!.rendererAttached).toBe(true)
    a.proc.emitData('\x1b[6n') // still only the renderer's xterm answers
    await settle('h-a')
    expect(replies(a.proc)).toEqual([])
  })

  it('once the new pane adopts there is exactly one answerer again', async () => {
    const a = await spawnTerminal('h-a')
    const win = fakeWindow()
    win.emit('render-process-gone', {}, {})
    a.proc.emitData('\x1b[6n') // no pane yet: the model answers
    await h.handlers.get('pty:replay')!({}, a.ptyId) // the reloaded pane adopts
    a.proc.emitData('\x1b[6n') // now only the renderer answers
    await settle('h-a')
    expect(replies(a.proc).filter((r) => CPR.test(r))).toHaveLength(1)
  })

  it('ignores a webContents that is not a window', () => {
    const wc = { getType: (): string => 'webview', on: vi.fn() }
    h.appListeners.get('web-contents-created')!({}, wc)
    expect(wc.on).not.toHaveBeenCalled()
  })
})

describe('AC-B3-9: backpressure pauses and resumes the PTY', () => {
  it('pauses above 4 MiB of unparsed bytes and resumes below 1 MiB', async () => {
    const { proc } = await spawnTerminal()
    const chunk = 'a'.repeat(64 * 1024)
    while (!proc.pause.mock.calls.length) proc.emitData(chunk)
    expect(proc.resume).not.toHaveBeenCalled()
    await settle()
    expect(proc.resume).toHaveBeenCalledTimes(1)
  })

  it('a PTY the renderer paused stays paused when the model catches up (and vice versa)', async () => {
    const { ptyId, proc } = await spawnTerminal()
    h.listeners.get('pty:flow:pause')!({}, ptyId)
    expect(proc.pause).toHaveBeenCalledTimes(1)
    const chunk = 'a'.repeat(64 * 1024)
    for (let i = 0; i < 80; i++) proc.emitData(chunk) // model over its mark too
    await settle()
    expect(proc.resume).not.toHaveBeenCalled() // the renderer's pause still holds
    h.listeners.get('pty:flow:resume')!({}, ptyId)
    expect(proc.resume).toHaveBeenCalledTimes(1)
  })

  it("an ordinary PTY keeps today's pause/resume", async () => {
    const ptyId = await pty.createPty(
      { kind: 'shell', cmd: '/bin/sh', cwd, cols: 80, rows: 24 },
      deps()
    )
    const proc = lastProc()
    h.listeners.get('pty:flow:pause')!({}, ptyId)
    h.listeners.get('pty:flow:resume')!({}, ptyId)
    expect(proc.pause).toHaveBeenCalledTimes(1)
    expect(proc.resume).toHaveBeenCalledTimes(1)
  })
})

describe('the tombstone snapshot is the resolved screen', () => {
  it('terminal:status paints resolved text, not escape codes', async () => {
    const { proc } = await spawnTerminal()
    proc.emitData('\x1b[31mred\x1b[0m\r\nprogress 1%\rprogress 100%\r\n')
    proc.emitExit(1)
    const status = await ipc.terminalStatusResolved(registry, 'h-a')
    // CRLF, because the pane writes it into an xterm with no convertEol (a bare LF would stair-step).
    expect(status).toMatchObject({
      known: true,
      state: 'exited',
      snapshot: 'red\r\nprogress 100%'
    })
  })

  it('painted into an xterm, every line starts at column 0 (no staircase)', async () => {
    const { proc } = await spawnTerminal()
    proc.emitData('red\r\nprogress 100%\r\nthird\r\n')
    proc.emitExit(1)
    const status = await ipc.terminalStatusResolved(registry, 'h-a')
    const pane = new Terminal({ cols: 40, rows: 5, allowProposedApi: true })
    await new Promise<void>((r) => pane.write((status as { snapshot: string }).snapshot, r))
    const rows = [0, 1, 2].map((y) => pane.buffer.active.getLine(y)!.translateToString(true))
    expect(rows).toEqual(['red', 'progress 100%', 'third'])
    pane.dispose()
  })

  it('a running terminal carries no snapshot', async () => {
    await spawnTerminal()
    const status = await ipc.terminalStatusResolved(registry, 'h-a')
    expect(status).toMatchObject({ known: true, state: 'running' })
    expect(status).not.toHaveProperty('snapshot')
  })
})

describe('the model is freed when the tombstone window ends (T480)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a natural exit drops the model at exit + the tombstone window, not before', async () => {
    vi.useFakeTimers()
    const { proc } = await spawnTerminal()
    proc.emitExit(0)
    vi.advanceTimersByTime(TOMBSTONE_MS - 1)
    expect(screen.screenModelFor('h-a')).toBeDefined()
    vi.advanceTimersByTime(2)
    expect(screen.screenModelFor('h-a')).toBeUndefined()
  })

  it('an operator close drops it on the same clock', async () => {
    vi.useFakeTimers()
    await spawnTerminal()
    expect(pty.closeTerminalPty('h-a')).toBe(true)
    expect(screen.screenModelFor('h-a')).toBeDefined() // the tombstone is still readable
    vi.advanceTimersByTime(TOMBSTONE_MS + 1)
    expect(screen.screenModelFor('h-a')).toBeUndefined()
  })

  it('a terminal that has not exited keeps its model', async () => {
    vi.useFakeTimers()
    await spawnTerminal()
    vi.advanceTimersByTime(TOMBSTONE_MS * 3)
    expect(screen.screenModelFor('h-a')).toBeDefined()
  })
})
