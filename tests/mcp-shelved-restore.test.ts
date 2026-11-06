/**
 * U2.3a AC-2 — MCP `create_session` and `spawn_terminal` restore a shelved worktree first, and a
 * failed restore is a steering error the agent can act on, not an `ok:true` with a dead session.
 * Scheduler ticks never restore (C3): pinned structurally at the bottom.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const h = vi.hoisted(() => ({
  userDataDir: '',
  folder: '',
  log: [] as string[],
  spawns: 0,
  ensure: (async () => ({ status: 'not-shelved' })) as (folder: string) => Promise<unknown>
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
    h.spawns++
    return {
      pid: 4242,
      onData: (): void => {},
      onExit: (): void => {},
      write: (): void => {},
      resize: (): void => {},
      kill: (): void => {},
      pause: (): void => {},
      resume: (): void => {}
    }
  }
}))

vi.mock('../src/main/gc/shelve-restore-shell', () => ({
  ensureShelvedRestored: (folder: string): unknown => h.ensure(folder)
}))

import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { terminalRegistry } from '../src/main/terminal-registry'
import { dropScreenModel } from '../src/main/terminal-screen'

const def = (op: string): (typeof WIRED_TOOLS)[number] => WIRED_TOOLS.find((t) => t.op === op)!
const createSession = def('create_session').handler!
const spawnTerminal = def('spawn_terminal').handler!
type Ctx = Parameters<typeof createSession>[1]

const failed = {
  status: 'failed' as const,
  entry: { id: 'e1', worktreePath: '/t/feat-x', branch: 'feat/x' },
  reason: 'repo-busy' as const,
  message: 'another Harnu job is working in this repository'
}

const dispatch = vi.fn()
const ctx = (): Ctx =>
  ({
    folder: h.folder,
    folders: [{ path: h.folder, alias: path.basename(h.folder), sessions: [] }],
    denyFolders: [],
    bridge: { dispatch, awaitMaterialization: vi.fn(async () => ({})) }
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

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mcp-shelved-ud-'))
  h.folder = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mcp-shelved-folder-'))
  const pty = await import('../src/main/pty')
  pty.registerPtyHandlers(() => null)
})

beforeEach(() => {
  h.log.length = 0
  h.spawns = 0
  h.ensure = async () => ({ status: 'not-shelved' })
  dispatch.mockReset()
  dispatch.mockImplementation(async (channel: string) => {
    h.log.push(`dispatch:${channel}`)
    return { error: 'NO_WINDOW' }
  })
  for (const r of terminalRegistry.list()) {
    terminalRegistry.forget(r.terminalId)
    dropScreenModel(r.terminalId)
  }
})

describe('create_session', () => {
  it('restores the shelved folder before it dispatches the session', async () => {
    h.ensure = async (folder) => {
      h.log.push(`restore:${folder}`)
      return { status: 'restored', entry: failed.entry, attached: true, movedAside: null }
    }
    await createSession({}, ctx())
    expect(h.log[0]).toBe(`restore:${h.folder}`)
    expect(h.log).toContain('dispatch:session.create')
  })

  it('answers SHELVED_RESTORE_FAILED with next steps and dispatches nothing', async () => {
    h.ensure = async () => failed
    const res = await createSession({}, ctx())
    expect(res.isError).toBe(true)
    const out = body(res)
    expect(out.error).toBe('SHELVED_RESTORE_FAILED')
    expect(String(out.message)).toContain('another Harnu job is working in this repository')
    expect(JSON.stringify(out.nextActions)).toMatch(/Cleanup/)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not touch a folder that is not shelved', async () => {
    await createSession({}, ctx())
    expect(h.log.some((l) => l.startsWith('restore:'))).toBe(false)
  })
})

describe('spawn_terminal', () => {
  it('restores first, then opens the shell (restore runs inside createTerminalPty)', async () => {
    h.ensure = async (folder) => {
      h.log.push(`restore:${folder}`)
      return { status: 'restored', entry: failed.entry, attached: true, movedAside: null }
    }
    dispatch.mockImplementation(async (_c: string, p: unknown) => ({
      paneId: (p as { paneId: string }).paneId
    }))
    const res = await spawnTerminal({ folder: h.folder }, ctx())
    expect(body(res).ok).toBe(true)
    expect(h.log[0]).toBe(`restore:${h.folder}`)
    expect(h.spawns).toBe(1)
  })

  it('answers SHELVED_RESTORE_FAILED, spawns nothing and gives the terminal slot back', async () => {
    h.ensure = async () => failed
    const res = await spawnTerminal({ folder: h.folder }, ctx())
    expect(res.isError).toBe(true)
    expect(body(res).error).toBe('SHELVED_RESTORE_FAILED')
    expect(h.spawns).toBe(0)
    expect(terminalRegistry.list()).toHaveLength(0)

    // The slot is free again: a later spawn works.
    h.ensure = async () => ({ status: 'not-shelved' })
    dispatch.mockImplementation(async (_c: string, p: unknown) => ({
      paneId: (p as { paneId: string }).paneId
    }))
    expect(body(await spawnTerminal({ folder: h.folder }, ctx())).ok).toBe(true)
  })
})

describe('Scheduler ticks never restore (design C3)', () => {
  it('neither scheduler module reaches the restore service', () => {
    for (const file of ['scheduler-shell.ts', 'scheduler-core.ts', 'scheduler-store.ts']) {
      const text = readFileSync(path.join(__dirname, '..', 'src', 'main', file), 'utf8')
      expect(text, file).not.toMatch(/shelve-restore/)
      expect(text, file).not.toMatch(/from ['"]\.\/pty['"]/)
    }
  })
})
