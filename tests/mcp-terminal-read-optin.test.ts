/**
 * T481 (agent terminals B4) — the folder read opt-in, operator-terminal reads and secret
 * scrubbing, driven through the real wired handlers, the real PTY layer, the real projects file
 * and the real screen model. Only `electron` and `node-pty` are stubbed.
 *
 * AC-B4-1 (opt-in off/on, lazy ring-seeded model, `approximate`, `list_terminals` flags),
 * AC-B4-3 (scrubbing on both terminal kinds), AC-B4-5's main-process half (per exact folder, not
 * inherited by a worktree) and the renderer's `pty:create` door.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const h = vi.hoisted(() => ({
  userDataDir: '',
  ipc: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  procs: [] as Array<{ emitData: (d: string) => void; emitExit: (c: number) => void }>
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
    on: (): void => {}
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
      write: (): void => {},
      resize: (): void => {},
      kill: vi.fn(),
      pause: (): void => {},
      resume: (): void => {},
      emitData: (d: string): void => dataCbs.forEach((cb) => cb(d)),
      emitExit: (c: number): void => exitCbs.forEach((cb) => cb({ exitCode: c }))
    }
    h.procs.push(proc)
    return proc
  }
}))

import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { terminalRegistry } from '../src/main/terminal-registry'
import { dropScreenModel, screenModelFor } from '../src/main/terminal-screen'
import { resolveTerminalGate } from '../src/main/terminal-gate'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { setUserProjectTerminalRead } from '../src/main/user-projects'
import { _resetIdempotencyRegistry } from '../src/main/mcp/idempotency-registry'
import { _resetInflightRegistry } from '../src/main/mcp/inflight-session-registry'

const tool = (op: string): NonNullable<(typeof WIRED_TOOLS)[number]['handler']> =>
  WIRED_TOOLS.find((t) => t.op === op)!.handler!
const spawn = tool('spawn_terminal')
const read = tool('read_terminal')
const list = tool('list_terminals')

let folderA = ''
let worktree = ''
type Ctx = Parameters<typeof spawn>[1]

const ctx = (folder: string = folderA, over: Record<string, unknown> = {}): Ctx =>
  ({
    folder,
    folders: [{ path: folder, alias: path.basename(folder), sessions: [] }],
    denyFolders: [],
    bridge: {
      dispatch: vi.fn(async (_c: string, p: unknown) => ({
        paneId: (p as { paneId: string }).paneId
      }))
    },
    ...over
  }) as unknown as Ctx

function body(res: CallToolResult): Record<string, unknown> {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  return JSON.parse(first.text)
}

/** The renderer's `pty:create`, as `HelperPane.vue` calls it for an operator shell pane. */
async function openOperatorShell(
  terminalId: string,
  folder: string,
  extra: Record<string, unknown> = {}
): Promise<{ emit: (d: string) => void; exit: (c: number) => void }> {
  const create = h.ipc.get('pty:create')!
  await create(
    {},
    { kind: 'shell', cwd: folder, cols: 100, rows: 20, terminal: { terminalId }, ...extra }
  )
  const proc = h.procs[h.procs.length - 1]!
  return { emit: proc.emitData, exit: proc.emitExit }
}

async function spawnAgentTerminal(): Promise<{ id: string; emit: (d: string) => void }> {
  const ack = body(await spawn({ folder: folderA }, ctx()))
  return { id: ack.terminalId as string, emit: h.procs[h.procs.length - 1]!.emitData }
}

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-optin-ud-'))
  folderA = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-optin-a-'))
  // A REAL linked worktree of folderA (not a plain subdirectory): the opt-in must not reach it.
  const git = (...args: string[]): void => {
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        ...args
      ],
      { cwd: folderA, stdio: 'ignore' }
    )
  }
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'init')
  worktree = path.join(folderA, '.claude', 'worktrees', 'wt')
  git('worktree', 'add', '-q', '-b', 'wt', worktree)
  const pty = await import('../src/main/pty')
  pty.registerPtyHandlers(() => null)
})

beforeEach(async () => {
  h.procs.length = 0
  _resetIdempotencyRegistry()
  _resetInflightRegistry()
  await fs.rm(path.join(h.userDataDir, 'projects.json'), { force: true })
})

afterEach(() => {
  for (const r of terminalRegistry.list()) {
    terminalRegistry.forget(r.terminalId)
    dropScreenModel(r.terminalId)
  }
})

describe('AC-B4-1 — an operator-opened terminal and the folder opt-in', () => {
  it('registers the operator shell under its pane id, as an operator terminal', async () => {
    await openOperatorShell('h-op1', folderA)
    const rec = terminalRegistry.get('h-op1')!
    expect(rec.origin).toBe('operator')
    expect(rec.ownerSessionId).toBeNull()
    expect(rec.rendererAttached).toBe(true) // its own xterm already answers terminal queries
    expect(screenModelFor('h-op1')).toBeUndefined() // lazy
  })

  it('opt-in off: TERMINAL_READ_NOT_ENABLED, no model built, and list says why', async () => {
    const op = await openOperatorShell('h-op1', folderA)
    op.emit('secret-free output\r\n')
    const res = await read({ terminalId: 'h-op1' }, ctx())
    expect(res.isError).toBe(true)
    expect(body(res).error).toBe('TERMINAL_READ_NOT_ENABLED')
    expect(screenModelFor('h-op1')).toBeUndefined()

    const [row] = body(await list({}, ctx())).terminals as Array<Record<string, unknown>>
    expect(row).toMatchObject({
      terminalId: 'h-op1',
      origin: 'operator',
      readable: false,
      writable: 'off',
      writableReason: 'read-not-enabled'
    })
  })

  it('opt-in on: readable, the model is built lazily from the ring, exact when the ring never wrapped', async () => {
    const op = await openOperatorShell('h-op1', folderA)
    // Not yet flushed out of the coalesce buffer: the seed must still include it.
    op.emit('\x1b[32mbuilding\x1b[0m 10%\rbuilding 100%\r\nok\r\n')
    await setUserProjectTerminalRead(folderA, true)

    const r = body(await read({ terminalId: 'h-op1' }, ctx()))
    expect(r).toMatchObject({
      ok: true,
      terminalId: 'h-op1',
      state: 'running',
      size: { cols: 100, rows: 20 },
      text: 'building 100%\nok',
      approximate: false
    })
    expect(screenModelFor('h-op1')).toBeDefined()

    const [row] = body(await list({}, ctx())).terminals as Array<Record<string, unknown>>
    expect(row).toMatchObject({ readable: true, writable: 'confirm' })
  })

  it('bytes after the seed arrive once: no loss, no duplication', async () => {
    const op = await openOperatorShell('h-op1', folderA)
    op.emit('one\r\n')
    await setUserProjectTerminalRead(folderA, true)
    expect(body(await read({ terminalId: 'h-op1' }, ctx())).text).toBe('one')
    op.emit('two\r\n')
    op.emit('three\r\n')
    expect(body(await read({ terminalId: 'h-op1' }, ctx())).text).toBe('one\ntwo\nthree')
  })

  it('a ring that had wrapped seeds an APPROXIMATE model', async () => {
    const op = await openOperatorShell('h-op1', folderA)
    const block = 'x'.repeat(300 * 1024) // one chunk past the 256 KiB ring cap, flushed at once
    op.emit(`${block}\r\n`)
    op.emit(`${block}\r\n`) // evicts the first chunk
    op.emit('tail line\r\n')
    await setUserProjectTerminalRead(folderA, true)
    const r = body(await read({ terminalId: 'h-op1' }, ctx()))
    expect(r.ok).toBe(true)
    expect(r.approximate).toBe(true)
    expect(String(r.text)).toContain('tail line')
  })

  it('an exited operator terminal reads from its tombstone, approximate', async () => {
    const op = await openOperatorShell('h-op1', folderA)
    op.emit('last words\r\n')
    await setUserProjectTerminalRead(folderA, true)
    op.exit(0)
    const r = body(await read({ terminalId: 'h-op1' }, ctx()))
    expect(r).toMatchObject({ ok: true, state: 'exited', text: 'last words', approximate: true })
  })

  it('turning the opt-in off again refuses at once', async () => {
    const op = await openOperatorShell('h-op1', folderA)
    op.emit('hello\r\n')
    await setUserProjectTerminalRead(folderA, true)
    expect(body(await read({ terminalId: 'h-op1' }, ctx())).ok).toBe(true)
    await setUserProjectTerminalRead(folderA, false)
    expect(body(await read({ terminalId: 'h-op1' }, ctx())).error).toBe('TERMINAL_READ_NOT_ENABLED')
  })

  it('dropOperatorScreenModels frees the lazy model of an opted-out folder, never an agent one', async () => {
    const pty = await import('../src/main/pty')
    const op = await openOperatorShell('h-op1', folderA)
    op.emit('x\r\n')
    const agent = await spawnAgentTerminal()
    await setUserProjectTerminalRead(folderA, true)
    await read({ terminalId: 'h-op1' }, ctx())
    expect(screenModelFor('h-op1')).toBeDefined()
    await pty.dropOperatorScreenModels(folderA)
    expect(screenModelFor('h-op1')).toBeUndefined()
    expect(screenModelFor(agent.id)).toBeDefined()
  })
})

describe('AC-B4-5 — per exact folder, never inherited by a worktree', () => {
  it('an operator terminal in a worktree stays unreadable when only its parent repo opted in', async () => {
    await setUserProjectTerminalRead(folderA, true)
    await openOperatorShell('h-wt', worktree)
    const res = await read({ terminalId: 'h-wt' }, ctx(worktree))
    expect(body(res).error).toBe('TERMINAL_READ_NOT_ENABLED')
    // …and the worktree's own opt-in works independently.
    await setUserProjectTerminalRead(worktree, true)
    expect(body(await read({ terminalId: 'h-wt' }, ctx(worktree))).ok).toBe(true)
  })
})

describe('the plan sees the same state the handler does (AC-B4-2, resolved by the shell)', () => {
  // Guarded ("Ask before agent actions") mode, with the terminal's folder a known root.
  const policy = (): {
    serverEnabled: true
    ask: true
    denyFolders: string[]
    knownRoots: string[]
  } => ({
    serverEnabled: true,
    ask: true,
    denyFolders: [],
    knownRoots: [folderA]
  })

  it('refuses before any confirm while the opt-in is off, allows once it is on — ask mode', async () => {
    await openOperatorShell('h-op1', folderA)
    const plan = async (): Promise<ReturnType<typeof planToolCall>> => {
      const { rec, state } = await resolveTerminalGate('h-op1')
      return planToolCall({
        tool: 'read_terminal',
        input: buildPlanInput('read_terminal', { terminalId: 'h-op1' }, rec?.folder),
        policy: policy(),
        now: 1,
        terminal: state
      })
    }
    const refused = await plan()
    expect(refused.verdict).toBe('deny')
    expect(refused.shouldConfirm).toBe(false)
    expect(refused.auditRecord.result).toBe('TERMINAL_READ_NOT_ENABLED')

    await setUserProjectTerminalRead(folderA, true)
    const open = await plan()
    expect(open.verdict).toBe('allow')
    expect(open.shouldDispatch).toBe(true)
  })

  it('an id the registry does not know is TERMINAL_NOT_FOUND', async () => {
    const { state } = await resolveTerminalGate('h-nope')
    const p = planToolCall({
      tool: 'read_terminal',
      input: buildPlanInput('read_terminal', { terminalId: 'h-nope' }, undefined),
      policy: policy(),
      now: 1,
      terminal: state
    })
    expect(p.auditRecord.result).toBe('TERMINAL_NOT_FOUND')
  })
})

describe('AC-B4-3 — scrubbing, on both terminal kinds', () => {
  const AWS = 'AKIAABCDEFGHIJKLMNOP'
  const planted = (): string =>
    `key ${AWS}\r\nAuthorization header sent\r\ncurl -H "Bearer abcDEF123456.tok"\r\ncd ${os.homedir()}/proj\r\n`

  function expectScrubbed(text: string): void {
    expect(text).not.toContain(AWS)
    expect(text).not.toContain('abcDEF123456')
    expect(text).not.toContain(os.homedir())
    expect(text).toContain('<redacted>')
    expect(text).toContain('Bearer <redacted>')
    expect(text).toContain('~/proj')
  }

  it('read_terminal.text on an agent-spawned terminal', async () => {
    const t = await spawnAgentTerminal()
    t.emit(planted())
    expectScrubbed(String(body(await read({ terminalId: t.id }, ctx())).text))
  })

  it('read_terminal.text on an operator-opened terminal', async () => {
    const op = await openOperatorShell('h-op1', folderA)
    op.emit(planted())
    await setUserProjectTerminalRead(folderA, true)
    expectScrubbed(String(body(await read({ terminalId: 'h-op1' }, ctx())).text))
  })

  it('a secret that straddles the maxChars cut is scrubbed before the cut, not half-leaked', async () => {
    const t = await spawnAgentTerminal()
    t.emit(`${'a'.repeat(40)} ${AWS}\r\n`)
    // The key is 20 chars. A 19-char tail of the UNSCRUBBED line is "KIAABCDEFGHIJKLMNOP": no
    // `AKIA` prefix is left for the scrubber to recognise, so scrubbing AFTER the cut would
    // return that fragment of the secret. Scrubbed first, the tail is padding plus the marker.
    const r = body(await read({ terminalId: t.id, maxChars: 19 }, ctx()))
    expect(String(r.text)).not.toMatch(/[A-Z]{6}/)
    expect(String(r.text)).toContain('<redacted>')
  })

  it('list_terminals.title on both kinds (the operator one once its folder opted in)', async () => {
    const t = await spawnAgentTerminal()
    await openOperatorShell('h-op1', folderA)
    await setUserProjectTerminalRead(folderA, true)
    terminalRegistry.get(t.id)!.title = `deploy ${AWS} ${os.homedir()}/x`
    terminalRegistry.get('h-op1')!.title = `curl Bearer abcDEF123456.tok ${os.homedir()}/y`
    const rows = body(await list({}, ctx())).terminals as Array<{
      terminalId: string
      title: string
    }>
    const titles = new Map(rows.map((r) => [r.terminalId, r.title]))
    expect(titles.get(t.id)).toBe('deploy <redacted> ~/x')
    expect(titles.get('h-op1')).toBe('curl Bearer <redacted> ~/y')
  })
})

describe('F1 — a terminal that is not readable shows no content through list_terminals', () => {
  const CONN = 'psql postgres://admin:S3cret@db.internal/prod'

  async function rowFor(id: string): Promise<Record<string, unknown>> {
    const rows = body(await list({}, ctx())).terminals as Array<Record<string, unknown>>
    return rows.find((r) => r.terminalId === id)!
  }

  it('opt-in OFF: title, lastOutputAt and exit.code are null, state and size stay', async () => {
    const op = await openOperatorShell('h-op1', folderA)
    terminalRegistry.get('h-op1')!.title = CONN
    op.emit('output\r\n')
    op.exit(7)
    const row = await rowFor('h-op1')
    expect(row).toMatchObject({
      readable: false,
      title: null,
      lastOutputAt: null,
      state: 'exited',
      exit: { code: null, reason: 'natural' },
      size: { cols: 100, rows: 20 },
      titleSource: 'program'
    })
    expect(JSON.stringify(row)).not.toContain('S3cret')
  })

  it('opt-in ON: the title is shown, with the connection-string password scrubbed', async () => {
    await openOperatorShell('h-op1', folderA)
    await setUserProjectTerminalRead(folderA, true)
    terminalRegistry.get('h-op1')!.title = CONN
    const row = await rowFor('h-op1')
    expect(row.title).toBe('psql postgres://admin:<redacted>@db.internal/prod')
    expect(typeof row.lastOutputAt).toBe('number')
  })

  it('a disconnected terminal is not readable either: nothing it printed is shown', async () => {
    const t = await spawnAgentTerminal()
    terminalRegistry.get(t.id)!.title = CONN
    terminalRegistry.get(t.id)!.disconnected = true
    const row = await rowFor(t.id)
    expect(row).toMatchObject({ readable: false, title: null, lastOutputAt: null })
  })

  it('an agent terminal keeps its scrubbed title and output time', async () => {
    const t = await spawnAgentTerminal()
    terminalRegistry.get(t.id)!.title = CONN
    const row = await rowFor(t.id)
    expect(row.title).toBe('psql postgres://admin:<redacted>@db.internal/prod')
    expect(typeof row.lastOutputAt).toBe('number')
  })
})

describe("the renderer's pty:create door", () => {
  it('can never register an agent-origin terminal, whatever it claims', async () => {
    const create = h.ipc.get('pty:create')!
    await create(
      {},
      {
        kind: 'shell',
        cwd: folderA,
        cols: 80,
        rows: 24,
        terminal: { terminalId: 'h-evil', folder: folderA, origin: 'agent', ownerSessionId: 's' }
      }
    )
    const rec = terminalRegistry.get('h-evil')!
    expect(rec.origin).toBe('operator')
    expect(rec.ownerSessionId).toBeNull()
    expect(screenModelFor('h-evil')).toBeUndefined()
  })

  it('F3: the folder is where the PTY runs (cwd), never a renderer-supplied claim', async () => {
    const create = h.ipc.get('pty:create')!
    // The pane claims the opted-in folder while running somewhere else.
    await setUserProjectTerminalRead(folderA, true)
    await create(
      {},
      {
        kind: 'shell',
        cwd: worktree,
        cols: 80,
        rows: 24,
        terminal: { terminalId: 'h-claim', folder: folderA }
      }
    )
    expect(terminalRegistry.get('h-claim')!.folder).toBe(await fs.realpath(worktree))
    expect(body(await read({ terminalId: 'h-claim' }, ctx(worktree))).error).toBe(
      'TERMINAL_READ_NOT_ENABLED'
    )
  })

  it('F3: a shell with no cwd registers nothing', async () => {
    const create = h.ipc.get('pty:create')!
    await create({}, { kind: 'shell', cols: 80, rows: 24, terminal: { terminalId: 'h-nocwd' } })
    expect(terminalRegistry.get('h-nocwd')).toBeUndefined()
  })

  it('cannot take over an id the registry already holds', async () => {
    const t = await spawnAgentTerminal()
    await openOperatorShell(t.id, folderA)
    expect(terminalRegistry.get(t.id)!.origin).toBe('agent')
  })

  it('cannot take over a RUNNING operator terminal either', async () => {
    await openOperatorShell('h-op1', folderA)
    const first = terminalRegistry.get('h-op1')!.ptyId
    await openOperatorShell('h-op1', folderA)
    expect(terminalRegistry.get('h-op1')!.ptyId).toBe(first)
  })

  it('registers nothing for a non-shell kind, even when it names a terminal', async () => {
    const create = h.ipc.get('pty:create')!
    await create(
      {},
      {
        kind: 'claude-new',
        cwd: folderA,
        cols: 80,
        rows: 24,
        terminal: { terminalId: 'h-notshell' }
      }
    )
    expect(h.procs.length).toBeGreaterThan(0) // the PTY itself was created…
    expect(terminalRegistry.get('h-notshell')).toBeUndefined() // …but is no terminal
    expect(terminalRegistry.list()).toHaveLength(0)
  })

  it('registers nothing for a PTY that names no terminal', async () => {
    const create = h.ipc.get('pty:create')!
    await create({}, { kind: 'shell', cwd: folderA, cols: 80, rows: 24 })
    expect(terminalRegistry.list()).toHaveLength(0)
  })
})

describe('F2 — a pane restored after a window reload registers again', () => {
  it('beforeunload destroys the PTY, helpers.json restores the same id: it is re-registered', async () => {
    await openOperatorShell('h-reload', folderA)
    const before = terminalRegistry.get('h-reload')!
    // The renderer's `beforeunload` → `ptyDestroy` (main marks it closing, then kills it).
    const pty = await import('../src/main/pty')
    expect(pty.closeTerminalPty('h-reload')).toBe(true)
    expect(terminalRegistry.get('h-reload')!.state).toBe('exited')

    await openOperatorShell('h-reload', folderA) // the restored pane's ptyCreate
    const after = terminalRegistry.get('h-reload')!
    expect(after.state).toBe('running')
    expect(after.ptyId).not.toBe(before.ptyId)
    expect(after.origin).toBe('operator')
    // …and it is a live terminal an opted-in agent can read again.
    await setUserProjectTerminalRead(folderA, true)
    h.procs[h.procs.length - 1]!.emitData('back\r\n')
    expect(body(await read({ terminalId: 'h-reload' }, ctx())).text).toBe('back')
  })

  it('an exited AGENT record under the same id is never replaced', async () => {
    const t = await spawnAgentTerminal()
    h.procs[h.procs.length - 1]!.emitExit(0)
    expect(terminalRegistry.get(t.id)!.state).toBe('exited')
    await openOperatorShell(t.id, folderA)
    expect(terminalRegistry.get(t.id)!.origin).toBe('agent')
  })
})
