/**
 * T475 (agent terminals B0) — golden spawn argv for the four `pty:create` kinds.
 *
 * Pins what the `pty:create` handler hands to `node-pty`'s `spawn` (command, argv and
 * spawn options) for `shell`, `claude-new`, `claude-resume` and `claude-fork`. It runs
 * against the real handler with only the environment probes stubbed, so it passes
 * identically before and after `createPty` is extracted from the handler closure —
 * that equivalence is the whole point of the unit (spec §9 B0, AC-B0-1).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  spawns: [] as Array<{ command: string; args: string[]; opts: Record<string, unknown> }>,
  userDataDir: ''
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
    on: (): void => {}
  }
}))

vi.mock('node-pty', () => ({
  spawn: (command: string, args: string[], opts: Record<string, unknown>): unknown => {
    h.spawns.push({ command, args: [...args], opts })
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

vi.mock('../src/main/claude-cli', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveClaudePath: async (): Promise<string> => '/usr/bin/claude'
}))
vi.mock('../src/main/claude-config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveClaudeBootArgs: async (
    _cwd: string | undefined,
    base: string[]
  ): Promise<{ args: string[]; env: Record<string, string> }> => ({ args: [...base], env: {} }),
  getResolvedConfig: async (): Promise<Record<string, unknown>> => ({})
}))
vi.mock('../src/main/user-projects', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserProjectAutoOrganize: async (): Promise<boolean> => false,
  getUserProjectOrchestratorDefault: async (): Promise<boolean> => false
}))
vi.mock('../src/main/orchestrator-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isArmed: async (): Promise<boolean> => false,
  arm: async (): Promise<void> => {},
  shouldArmAtSpawn: (): boolean => false
}))
vi.mock('../src/main/extensions/extensions-loader', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveModeContract: async (): Promise<string> => ''
}))
vi.mock('../src/main/appimage-env', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loginPathOnce: async (): Promise<null> => null
}))

const SESSION_ID = '0b9d2f64-6c1e-4a52-9d0e-3f6a8c1b7e21'
const MINTED_ID = '7c1a9e35-2b44-4d8f-a6e0-5d3b9f2c4a18'
let cwd: string

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-pty-golden-ud-'))
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-pty-golden-cwd-'))
  const pty = await import('../src/main/pty')
  pty.registerPtyHandlers(() => null)
})

/** Drive the real `pty:create` handler; return the single spawn it made. */
async function create(opts: Record<string, unknown>): Promise<{
  id: unknown
  command: string
  args: string[]
  opts: Record<string, unknown>
}> {
  const handler = h.handlers.get('pty:create')
  if (!handler) throw new Error('pty:create was not registered')
  const before = h.spawns.length
  const id = await handler({}, { cwd, cols: 100, rows: 30, ...opts })
  expect(h.spawns.length).toBe(before + 1)
  return { id, ...h.spawns[h.spawns.length - 1] }
}

describe('pty:create — golden spawn argv per kind', () => {
  it('shell: the explicit cmd + args pass through untouched', async () => {
    const s = await create({ kind: 'shell', cmd: '/bin/sh', args: ['-c', 'true'] })
    expect(typeof s.id).toBe('string')
    expect(s.command).toBe('/bin/sh')
    expect(s.args).toEqual(['-c', 'true'])
    expect(s.opts).toMatchObject({ name: 'xterm-256color', cwd, cols: 100, rows: 30 })
  })

  it('shell: no kind defaults to shell, and no args means an empty argv', async () => {
    const s = await create({ cmd: '/bin/sh' })
    expect(s.command).toBe('/bin/sh')
    expect(s.args).toEqual([])
  })

  it('claude-new: a bare claude with no session id', async () => {
    const s = await create({ kind: 'claude-new' })
    expect(s.command).toBe('/usr/bin/claude')
    expect(s.args).toEqual([])
    expect(s.opts).toMatchObject({ name: 'xterm-256color', cwd, cols: 100, rows: 30 })
  })

  it('claude-new: a caller-minted uuid becomes --session-id', async () => {
    const s = await create({ kind: 'claude-new', claudeSessionId: MINTED_ID })
    expect(s.command).toBe('/usr/bin/claude')
    expect(s.args).toEqual(['--session-id', MINTED_ID])
  })

  it('claude-resume: --resume <uuid>', async () => {
    const s = await create({ kind: 'claude-resume', claudeSessionId: SESSION_ID })
    expect(s.command).toBe('/usr/bin/claude')
    expect(s.args).toEqual(['--resume', SESSION_ID])
  })

  it('claude-fork: --resume <uuid> --fork-session', async () => {
    const s = await create({ kind: 'claude-fork', claudeSessionId: SESSION_ID })
    expect(s.command).toBe('/usr/bin/claude')
    expect(s.args).toEqual(['--resume', SESSION_ID, '--fork-session'])
  })

  it('claude-resume / claude-fork without a uuid, and a malformed uuid, are rejected', async () => {
    const handler = h.handlers.get('pty:create') as (...a: unknown[]) => Promise<unknown>
    const base = { cwd, cols: 80, rows: 24 }
    await expect(handler({}, { ...base, kind: 'claude-resume' })).rejects.toThrow(
      'claudeSessionId is required when kind === "claude-resume"'
    )
    await expect(handler({}, { ...base, kind: 'claude-fork' })).rejects.toThrow(
      'claudeSessionId is required when kind === "claude-fork"'
    )
    await expect(
      handler({}, { ...base, kind: 'claude-resume', claudeSessionId: 'not-a-uuid' })
    ).rejects.toThrow('Invalid claudeSessionId (expected a session uuid)')
    await expect(
      handler({}, { ...base, kind: 'claude-new', claudeSessionId: 'not-a-uuid' })
    ).rejects.toThrow('Invalid claudeSessionId (expected a session uuid)')
  })

  it('a second create for a live sessionKey is deduped to the same ptyId, with no second spawn', async () => {
    const first = await create({
      kind: 'claude-resume',
      claudeSessionId: SESSION_ID,
      sessionKey: 'golden-dedup-key'
    })
    const handler = h.handlers.get('pty:create') as (...a: unknown[]) => Promise<unknown>
    const before = h.spawns.length
    const again = await handler(
      {},
      {
        cwd,
        cols: 100,
        rows: 30,
        kind: 'claude-resume',
        claudeSessionId: SESSION_ID,
        sessionKey: 'golden-dedup-key'
      }
    )
    expect(again).toBe(first.id)
    expect(h.spawns.length).toBe(before)
  })
})
