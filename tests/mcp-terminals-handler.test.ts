/**
 * T478 (agent terminals B1) — `spawn_terminal`, `list_terminals` and `get_session.terminals`
 * driven through the real wired handlers.
 *
 * `electron` and `node-pty` are the only things stubbed: the PTY layer, the registry and the
 * handlers are the shipped code. The command bridge is a fake the test controls.
 *
 * AC-B1-1 … AC-B1-6. (AC-B1-7…10 live in `pty-terminal-registry.test.ts`; AC-B1-11 is a review.)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const h = vi.hoisted(() => ({
  userDataDir: '',
  procs: [] as Array<{ kill: ReturnType<typeof vi.fn>; emitExit: (c: number) => void }>
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
  spawn: (): unknown => {
    const exitCbs: Array<(e: { exitCode: number }) => void> = []
    const proc = {
      pid: 4242,
      onData: (): void => {},
      onExit: (cb: (e: { exitCode: number }) => void): void => {
        exitCbs.push(cb)
      },
      write: (): void => {},
      resize: (): void => {},
      kill: vi.fn(),
      pause: (): void => {},
      resume: (): void => {},
      emitExit: (code: number): void => exitCbs.forEach((cb) => cb({ exitCode: code }))
    }
    h.procs.push(proc)
    return proc
  }
}))

import { CommandBridgeError } from '../src/main/command-bridge'
import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import {
  callIdFor,
  beginCall,
  completeCall,
  _resetIdempotencyRegistry
} from '../src/main/mcp/idempotency-registry'
import {
  _resetInflightRegistry,
  registerInflightSession
} from '../src/main/mcp/inflight-session-registry'
import { terminalRegistry } from '../src/main/terminal-registry'
import type { FolderEntry } from '../src/main/folder-model'

const tool = (op: string): NonNullable<(typeof WIRED_TOOLS)[number]['handler']> =>
  WIRED_TOOLS.find((t) => t.op === op)!.handler!
const spawn = tool('spawn_terminal')
const list = tool('list_terminals')
const getSession = tool('get_session')

let folderA = ''
let folderB = ''

type Ctx = Parameters<typeof spawn>[1]

interface FakeBridge {
  dispatch: ReturnType<typeof vi.fn>
}

/** A bridge that behaves like a B2 renderer: it echoes the pane id it was handed. */
function echoBridge(): FakeBridge {
  return {
    dispatch: vi.fn(async (_cmd: string, payload: unknown) => ({
      paneId: (payload as { paneId: string }).paneId
    }))
  }
}

function folderEntry(p: string, sessionIds: string[] = []): FolderEntry {
  return {
    path: p,
    alias: path.basename(p),
    sessions: sessionIds.map((sessionId) => ({
      sessionId,
      fullPath: '',
      fileMtime: 0,
      firstPrompt: '',
      summary: '',
      messageCount: 0,
      created: '',
      modified: '',
      gitBranch: '',
      projectPath: p,
      isSidechain: false,
      status: 'active',
      agents: [],
      resumable: true
    }))
  } as unknown as FolderEntry
}

function ctx(over: Record<string, unknown> = {}): Ctx {
  return {
    folder: folderA,
    folders: [folderEntry(folderA, ['sess-1']), folderEntry(folderB)],
    denyFolders: [],
    bridge: echoBridge(),
    ...over
  } as unknown as Ctx
}

function body(res: CallToolResult): Record<string, unknown> {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  return JSON.parse(first.text)
}

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mcp-term-ud-'))
  folderA = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mcp-term-a-'))
  folderB = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mcp-term-b-'))
  const pty = await import('../src/main/pty')
  pty.registerPtyHandlers(() => null)
})

beforeEach(() => {
  h.procs.length = 0
  _resetIdempotencyRegistry()
  _resetInflightRegistry()
})

afterEach(() => {
  for (const r of terminalRegistry.list()) terminalRegistry.forget(r.terminalId)
})

describe('AC-B1-1 — the spawn_terminal ACK', () => {
  it('carries terminalId === result.paneId, ownerSessionId, state and size', async () => {
    const bridge = echoBridge()
    const res = await spawn({ folder: folderA, ownerSessionId: 'sess-1' }, ctx({ bridge }))
    const ack = body(res)
    expect(ack).toMatchObject({
      ok: true,
      op: 'spawn_terminal',
      ownerSessionId: 'sess-1',
      state: 'running',
      size: { cols: 120, rows: 30 }
    })
    expect(ack.terminalId).toMatch(/^h-/)
    expect((ack.result as { paneId: string }).paneId).toBe(ack.terminalId)
  })

  it('hands the renderer the pane id, the PTY id and the owner, keeping the old payload keys', async () => {
    const bridge = echoBridge()
    const ack = body(await spawn({ folder: folderA, ownerSessionId: 'sess-1' }, ctx({ bridge })))
    expect(bridge.dispatch).toHaveBeenCalledWith('pane.split', {
      target: 'split',
      worktreePath: folderA,
      cwd: folderA,
      kind: 'shell',
      paneId: ack.terminalId,
      ptyId: terminalRegistry.get(ack.terminalId as string)!.ptyId,
      ownerSessionId: 'sess-1'
    })
  })

  it('registers a running agent terminal under that id', async () => {
    const ack = body(await spawn({ folder: folderA }, ctx()))
    expect(terminalRegistry.get(ack.terminalId as string)).toMatchObject({
      origin: 'agent',
      state: 'running',
      folder: folderA,
      ownerSessionId: null
    })
    expect(ack.ownerSessionId).toBeNull()
  })

  it('translateSpawnTerminal passes ownerSessionId through to the plan input', () => {
    expect(
      buildPlanInput('spawn_terminal', { folder: folderA, ownerSessionId: 'sess-1' }, folderA)
    ).toMatchObject({ worktreePath: folderA, folder: folderA, ownerSessionId: 'sess-1' })
    expect(buildPlanInput('spawn_terminal', { folder: folderA }, folderA)).not.toHaveProperty(
      'ownerSessionId'
    )
  })
})

describe('AC-B1-2 — ownerSessionId validation', () => {
  it('refuses an id Harnu has never seen with SESSION_NOT_FOUND, and spawns nothing', async () => {
    const res = await spawn({ folder: folderA, ownerSessionId: 'ghost' }, ctx())
    expect(res.isError).toBe(true)
    expect(body(res).error).toBe('SESSION_NOT_FOUND')
    expect(h.procs).toHaveLength(0)
    expect(terminalRegistry.list()).toEqual([])
  })

  it('accepts a session that is on disk (operator-owned or not)', async () => {
    const res = await spawn({ folder: folderA, ownerSessionId: 'sess-1' }, ctx())
    expect(res.isError).toBeUndefined()
  })

  it('accepts the synthetic id of an in-flight session', async () => {
    registerInflightSession({ syntheticId: 'synthetic-77', folderPath: folderA })
    const res = await spawn({ folder: folderA, ownerSessionId: 'synthetic-77' }, ctx())
    expect(res.isError).toBeUndefined()
    expect(body(res).ownerSessionId).toBe('synthetic-77')
  })
})

describe('AC-B1-3 — spawn_terminal is not replayable', () => {
  it('two identical calls create two terminals', async () => {
    const a = body(await spawn({ folder: folderA, ownerSessionId: 'sess-1' }, ctx()))
    const b = body(await spawn({ folder: folderA, ownerSessionId: 'sess-1' }, ctx()))
    expect(a.terminalId).not.toBe(b.terminalId)
    expect(h.procs).toHaveLength(2)
    expect(terminalRegistry.list()).toHaveLength(2)
  })

  it('the idempotency registry is bypassed for it, so a repeat actuates again', () => {
    const def = MCP_TOOLS.find((t) => t.op === 'spawn_terminal')!
    const args = { folder: folderA }
    expect(def.replayable).toBe(false)
    expect(callIdFor(def, folderA, args)).toBeUndefined()
    expect(callIdFor(def, folderA, args)).toBeUndefined()
  })

  it('a different mutating verb still replays its first result', () => {
    const def = MCP_TOOLS.find((t) => t.op === 'create_session')!
    const args = { folder: folderA }
    const id = callIdFor(def, folderA, args)!
    expect(id).toBeTruthy()
    expect(beginCall(id)).toBeUndefined() // first call actuates
    completeCall(id, 'applied', { content: [{ type: 'text', text: '{"ok":true}' }] })
    expect(beginCall(callIdFor(def, folderA, args)!)).toMatchObject({ status: 'applied' })
  })

  it('a read never goes through the registry, and only spawn_terminal opts out', () => {
    expect(
      callIdFor(
        MCP_TOOLS.find((t) => t.op === 'list_terminals')!,
        folderA,
        {}
      )
    ).toBeUndefined()
    expect(MCP_TOOLS.filter((t) => t.replayable === false).map((t) => t.op)).toEqual([
      'spawn_terminal'
    ])
  })
})

describe('AC-B1-4 — rollback after the PTY exists', () => {
  it.each([
    ['NO_WINDOW', new CommandBridgeError('NO_WINDOW')],
    ['TIMEOUT', new CommandBridgeError('TIMEOUT')]
  ])('a bridge %s kills the PTY and leaves no record', async (_n, err) => {
    const bridge = { dispatch: vi.fn(async () => Promise.reject(err)) }
    await expect(spawn({ folder: folderA }, ctx({ bridge }))).rejects.toBe(err)
    expect(h.procs).toHaveLength(1)
    expect(h.procs[0].kill).toHaveBeenCalledTimes(1)
    expect(terminalRegistry.list()).toEqual([])
  })

  it('a renderer that answers with an error kills the PTY too, and returns the old shape', async () => {
    const bridge = { dispatch: vi.fn(async () => ({ error: 'BAD_ARGS' })) }
    const res = await spawn({ folder: folderA }, ctx({ bridge }))
    expect(body(res)).toEqual({ ok: true, op: 'spawn_terminal', result: { error: 'BAD_ARGS' } })
    expect(h.procs[0].kill).toHaveBeenCalledTimes(1)
    expect(terminalRegistry.list()).toEqual([])
  })

  it('without a bridge nothing is spawned at all', async () => {
    const res = await spawn({ folder: folderA }, ctx({ bridge: undefined }))
    expect(res.isError).toBe(true)
    expect(h.procs).toHaveLength(0)
  })
})

describe('AC-B1-5 — TERMINAL_LIMIT', () => {
  it('refuses the 5th live agent terminal in a folder, not in another', async () => {
    for (let i = 0; i < 4; i++) {
      expect((await spawn({ folder: folderA }, ctx())).isError).toBeUndefined()
    }
    const fifth = await spawn({ folder: folderA }, ctx())
    expect(fifth.isError).toBe(true)
    expect(body(fifth).error).toBe('TERMINAL_LIMIT')
    expect(body(fifth).nextActions).toBeTruthy()
    expect(h.procs).toHaveLength(4)
    expect(
      (await spawn({ folder: folderB, ownerSessionId: undefined }, ctx({ folder: folderB })))
        .isError
    ).toBeUndefined()
  })

  it('6 parallel calls in one folder make exactly 4 terminals, 2 refusals and no leaked PTY', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => spawn({ folder: folderA }, ctx()))
    )
    const refused = results.filter((r) => r.isError)
    expect(results.length - refused.length).toBe(4)
    expect(refused).toHaveLength(2)
    for (const r of refused) expect(body(r).error).toBe('TERMINAL_LIMIT')
    expect(h.procs).toHaveLength(4)
    for (const p of h.procs) expect(p.kill).not.toHaveBeenCalled()
    expect(terminalRegistry.liveAgentCount(folderA)).toBe(4)
    // The reservations were all given back: once one terminal exits, a new spawn fits.
    h.procs[0].emitExit(0)
    expect((await spawn({ folder: folderA }, ctx())).isError).toBeUndefined()
  })

  it('a failed spawn gives its reserved slot back', async () => {
    const failing = {
      dispatch: vi.fn(async () => Promise.reject(new CommandBridgeError('TIMEOUT')))
    }
    await Promise.all(
      Array.from({ length: 4 }, () =>
        spawn({ folder: folderA }, ctx({ bridge: failing })).catch(() => {})
      )
    )
    expect(terminalRegistry.list()).toEqual([])
    for (let i = 0; i < 4; i++) {
      expect((await spawn({ folder: folderA }, ctx())).isError).toBeUndefined()
    }
  })

  it('an exited terminal frees its slot', async () => {
    for (let i = 0; i < 4; i++) await spawn({ folder: folderA }, ctx())
    h.procs[0].emitExit(0)
    expect((await spawn({ folder: folderA }, ctx())).isError).toBeUndefined()
  })
})

describe('AC-B1-6 — list_terminals and get_session.terminals', () => {
  it('redacts paths, marks the title as program-set, and reports readable/writable', async () => {
    const ack = body(await spawn({ folder: folderA, ownerSessionId: 'sess-1' }, ctx()))
    terminalRegistry.get(ack.terminalId as string)!.title = `vim ${os.homedir()}/notes.md`
    const res = await list({}, ctx())
    const text = (res.content[0] as { text: string }).text
    expect(text).not.toContain(folderA)
    expect(text).not.toContain(os.homedir())
    const [row] = body(res).terminals as Array<Record<string, unknown>>
    expect(row).toMatchObject({
      terminalId: ack.terminalId,
      label: path.basename(folderA),
      folderAlias: path.basename(folderA),
      origin: 'agent',
      ownerSessionId: 'sess-1',
      disconnected: false,
      state: 'running',
      size: { cols: 120, rows: 30 },
      title: 'vim ~/notes.md',
      titleSource: 'program',
      readable: true,
      writable: 'free'
    })
    expect(row).not.toHaveProperty('writableReason')
  })

  it('reports an operator-opened terminal as not readable (the folder opt-in is off)', async () => {
    terminalRegistry.register({
      terminalId: 'h-op',
      ptyId: 'p-op',
      folder: folderA,
      origin: 'operator',
      size: { cols: 80, rows: 24 }
    })
    const rows = body(await list({}, ctx())).terminals as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      origin: 'operator',
      readable: false,
      writable: 'off',
      writableReason: 'read-not-enabled'
    })
  })

  it('reports a disconnected terminal as revoked and not readable', async () => {
    const ack = body(await spawn({ folder: folderA }, ctx()))
    terminalRegistry.get(ack.terminalId as string)!.disconnected = true
    const [row] = body(await list({}, ctx())).terminals as Array<Record<string, unknown>>
    expect(row).toMatchObject({ disconnected: true, readable: false, writable: 'revoked' })
    expect(row).not.toHaveProperty('writableReason')
  })

  it('omits terminals in a folder the operator blocked', async () => {
    await spawn({ folder: folderA }, ctx())
    await spawn({ folder: folderB }, ctx({ folder: folderB }))
    const rows = body(await list({}, ctx({ denyFolders: [folderB] }))).terminals as Array<
      Record<string, unknown>
    >
    expect(rows.map((r) => r.folderAlias)).toEqual([path.basename(folderA)])
  })

  it('narrows by folder and by ownerSessionId', async () => {
    await spawn({ folder: folderA, ownerSessionId: 'sess-1' }, ctx())
    await spawn({ folder: folderA }, ctx())
    await spawn({ folder: folderB }, ctx({ folder: folderB }))
    const byFolder = body(await list({ folder: folderB }, ctx({ folder: folderB }))).terminals
    expect(byFolder).toHaveLength(1)
    const byOwner = body(await list({ ownerSessionId: 'sess-1' }, ctx())).terminals
    expect(byOwner).toHaveLength(1)
  })

  it('lists an exited terminal as a tombstone with its exit reason', async () => {
    await spawn({ folder: folderA }, ctx())
    h.procs[0].emitExit(7)
    const [row] = body(await list({}, ctx())).terminals as Array<Record<string, unknown>>
    expect(row).toMatchObject({
      state: 'exited',
      exit: { code: 7, reason: 'natural' },
      writable: 'off',
      writableReason: 'exited'
    })
  })

  it('get_session.terminals lists exactly the connected terminals that session owns', async () => {
    const mine1 = body(await spawn({ folder: folderA, ownerSessionId: 'sess-1' }, ctx()))
    const mine2 = body(await spawn({ folder: folderA, ownerSessionId: 'sess-1' }, ctx()))
    await spawn({ folder: folderA }, ctx()) // unowned
    terminalRegistry.get(mine2.terminalId as string)!.disconnected = true
    const res = await getSession({ sessionId: 'sess-1' }, ctx())
    const session = body(res).session as { terminals: Array<{ terminalId: string; state: string }> }
    expect(session.terminals).toEqual([{ terminalId: mine1.terminalId, state: 'running' }])
  })

  it('get_session.terminals leaves out a terminal in a folder the operator blocked', async () => {
    await spawn({ folder: folderA, ownerSessionId: 'sess-1' }, ctx())
    const res = await getSession({ sessionId: 'sess-1' }, ctx({ denyFolders: [folderA] }))
    const session = body(res).session as { terminals: unknown[] }
    expect(session.terminals).toEqual([])
  })

  it('get_session.terminals follows a synthetic owner while the session is still spawning', async () => {
    registerInflightSession({ syntheticId: 'synthetic-5', folderPath: folderA })
    const ack = body(await spawn({ folder: folderA, ownerSessionId: 'synthetic-5' }, ctx()))
    const res = await getSession({ sessionId: 'synthetic-5' }, ctx())
    const session = body(res).session as { terminals: unknown[] }
    expect(session.terminals).toEqual([{ terminalId: ack.terminalId, state: 'running' }])
  })
})
