/**
 * T480 (agent terminals B3) — `read_terminal` through the REAL `handleToolCall` pipeline.
 *
 * The verb carries only a `terminalId`, so `server.ts` resolves the gate folder from the
 * terminal registry before planning. The gate FAILS OPEN for a read with no folder
 * (`permission-core.ts`), so that resolution is the only thing standing between an agent and a
 * terminal in a folder the operator blocked. This test pins it end to end: remove the
 * `read_terminal` branch in `server.ts` and the denied-folder test fails.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const h = vi.hoisted(() => ({ userDataDir: '', denied: [] as string[] }))

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

// The scan reads ~/.claude and starts a watcher; the policy needs the operator's block list.
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanFolders: async (): Promise<unknown[]> => []
}))
vi.mock('../src/main/user-projects', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUserProjects: async (): Promise<unknown> => ({
    projects: h.denied.map((p) => ({ path: p, agentDenied: true }))
  })
}))

import { handleToolCall } from '../src/main/mcp/server'
import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { terminalRegistry } from '../src/main/terminal-registry'
import { ScreenModel, dropScreenModel, setScreenModel } from '../src/main/terminal-screen'

const readDef = WIRED_TOOLS.find((t) => t.op === 'read_terminal')!

let blocked = ''
let open = ''

function body(res: CallToolResult): Record<string, unknown> {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  return JSON.parse(first.text)
}

/** An agent terminal with a model holding `text`, so an UNGATED read would succeed. */
function seedTerminal(terminalId: string, folder: string, text: string): void {
  terminalRegistry.register({
    terminalId,
    ptyId: `p-${terminalId}`,
    folder,
    origin: 'agent',
    size: { cols: 80, rows: 24 }
  })
  const model = new ScreenModel({ cols: 80, rows: 24, onReply: () => {}, onBacklog: () => {} })
  model.write(`${text}\r\n`, false)
  setScreenModel(terminalId, model)
}

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-read-gate-ud-'))
  blocked = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-read-gate-blocked-'))
  open = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-read-gate-open-'))
  h.denied = [blocked]
})

afterEach(() => {
  for (const r of terminalRegistry.list()) {
    terminalRegistry.forget(r.terminalId)
    dropScreenModel(r.terminalId)
  }
})

describe('read_terminal gate folder, resolved from the registry', () => {
  it('a terminal in a folder the operator blocked is refused FOLDER_NOT_ALLOWED', async () => {
    seedTerminal('h-blocked', blocked, 'secret output')
    const res = await handleToolCall(readDef, { terminalId: 'h-blocked' })
    expect(res.isError).toBe(true)
    expect(body(res).error).toBe('FOLDER_NOT_ALLOWED')
    expect(JSON.stringify(res)).not.toContain('secret output')
  })

  it('a terminal in a subfolder of a blocked folder is refused too (the block covers the subtree)', async () => {
    const sub = path.join(blocked, 'worktree')
    await fs.mkdir(sub, { recursive: true })
    seedTerminal('h-sub', sub, 'secret output')
    const res = await handleToolCall(readDef, { terminalId: 'h-sub' })
    expect(body(res).error).toBe('FOLDER_NOT_ALLOWED')
  })

  it('a terminal in an unblocked folder reads', async () => {
    seedTerminal('h-open', open, 'hello from open')
    const res = await handleToolCall(readDef, { terminalId: 'h-open' })
    expect(res.isError).toBeFalsy()
    expect(body(res)).toMatchObject({ ok: true, text: 'hello from open' })
  })

  it('an unknown id still answers TERMINAL_NOT_FOUND through the gate', async () => {
    const res = await handleToolCall(readDef, { terminalId: 'h-nope' })
    expect(body(res).error).toBe('TERMINAL_NOT_FOUND')
  })

  it('stamps lastAgentReadAt on a successful read only', async () => {
    seedTerminal('h-stamp', open, 'x')
    expect(terminalRegistry.get('h-stamp')!.lastAgentReadAt).toBeNull()
    await handleToolCall(readDef, { terminalId: 'h-stamp', mode: 'since', since: 'm404' })
    expect(terminalRegistry.get('h-stamp')!.lastAgentReadAt).toBeNull()
    const before = Date.now()
    await handleToolCall(readDef, { terminalId: 'h-stamp' })
    expect(terminalRegistry.get('h-stamp')!.lastAgentReadAt).toBeGreaterThanOrEqual(before)
  })

  it('a refused read (blocked folder) does not stamp', async () => {
    seedTerminal('h-b2', blocked, 'x')
    await handleToolCall(readDef, { terminalId: 'h-b2' })
    expect(terminalRegistry.get('h-b2')!.lastAgentReadAt).toBeNull()
  })
})
