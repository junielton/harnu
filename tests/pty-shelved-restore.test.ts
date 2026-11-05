/**
 * U2.3a AC-1 / AC-2 — a PTY about to start in a shelved worktree restores it first, and a failed
 * restore never starts the session in another folder (the BUG-144 shape).
 *
 * `createPty` is the one door every spawn goes through (resume, new session, terminal from the
 * renderer's `pty:create`, and `spawn_terminal` via `createTerminalPty`). The restore service is
 * mocked here (its rules are pinned in gc-shelve-restore-*.test.ts); everything between it and
 * `node-pty`'s `spawn` is the real code.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({
  userDataDir: '',
  log: [] as string[],
  spawns: [] as Array<{ command: string; args: string[]; opts: Record<string, unknown> }>,
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
  spawn: (command: string, args: string[], opts: Record<string, unknown>): unknown => {
    h.log.push('spawn')
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

vi.mock('../src/main/gc/shelve-restore-shell', () => ({
  ensureShelvedRestored: (folder: string): unknown => h.ensure(folder)
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

const SESSION = '3f1c9d0e-5b7a-4c2e-9a41-0d6f8e2b7c11'
let cwd: string
let pty: typeof import('../src/main/pty')

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-pty-shelved-ud-'))
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-pty-shelved-cwd-'))
  pty = await import('../src/main/pty')
  pty.registerPtyHandlers(() => null)
})

beforeEach(() => {
  h.log.length = 0
  h.spawns.length = 0
  h.ensure = vi.fn(async () => ({ status: 'not-shelved' }))
})

const fakeDeps = (): Parameters<typeof pty.createPty>[1] => ({
  getWindow: () => ({ webContents: { send: () => {} } }) as never,
  flushNow: () => {},
  runPolicy: () => []
})

const entry = {
  id: 'e1',
  repoPath: '/r',
  worktreePath: '/t/feat-x',
  branch: 'feat/x'
}
const failed = (message = 'ref-missing: the archive is gone') => ({
  status: 'failed' as const,
  entry,
  reason: 'archive-unverified' as const,
  message
})

describe('createPty restores a shelved worktree before it spawns', () => {
  it('awaits the restore before node-pty spawns, for a resume', async () => {
    h.ensure = vi.fn(async (folder: string) => {
      h.log.push(`restore:${folder}`)
      return { status: 'restored', entry, attached: true, movedAside: null }
    })
    await pty.createPty(
      { kind: 'claude-resume', claudeSessionId: SESSION, cwd, cols: 80, rows: 24 },
      fakeDeps()
    )
    expect(h.log).toEqual([`restore:${cwd}`, 'spawn'])
    expect(h.spawns[0].command).toBe('/usr/bin/claude')
    expect(h.spawns[0].opts.cwd).toBe(cwd)
    expect(h.spawns[0].args).toContain('--resume')
  })

  it('restores for a new session and for a plain terminal too', async () => {
    await pty.createPty({ kind: 'claude-new', cwd, cols: 80, rows: 24 }, fakeDeps())
    await pty.createPty({ kind: 'shell', cmd: '/bin/sh', cwd, cols: 80, rows: 24 }, fakeDeps())
    expect(h.ensure).toHaveBeenCalledTimes(2)
    expect(h.ensure).toHaveBeenNthCalledWith(1, cwd)
    expect(h.ensure).toHaveBeenNthCalledWith(2, cwd)
  })

  it('restores for an agent terminal (spawn_terminal goes through createTerminalPty)', async () => {
    await pty.createTerminalPty({ terminalId: 'h-restore-1', folder: cwd, ownerSessionId: null })
    expect(h.ensure).toHaveBeenCalledWith(cwd)
    expect(h.spawns).toHaveLength(1)
  })

  it('does not ask when there is no cwd', async () => {
    await pty.createPty({ kind: 'shell', cmd: '/bin/sh', cols: 80, rows: 24 }, fakeDeps())
    expect(h.ensure).not.toHaveBeenCalled()
  })
})

describe('a failed restore never starts the session somewhere else', () => {
  for (const kind of ['claude-resume', 'claude-new', 'claude-fork'] as const) {
    it(`${kind}: shows the restore-failed notice and builds no claude argv`, async () => {
      h.ensure = vi.fn(async () => failed())
      await pty.createPty(
        {
          kind,
          claudeSessionId: SESSION,
          forkFromSessionId: SESSION,
          cwd,
          cols: 80,
          rows: 24
        } as never,
        fakeDeps()
      )
      expect(h.spawns).toHaveLength(1)
      const spawned = h.spawns[0]
      expect(spawned.command).toBe('/bin/sh')
      // args = ['-c', script, 'sh' ($0), cwd ($1), message ($2)]
      expect(spawned.args[2]).toBe('sh')
      expect(spawned.args[3]).toBe(cwd)
      expect(spawned.args[4]).toContain('ref-missing: the archive is gone')
      expect(spawned.args).not.toContain('--resume')
      // The notice runs in home, never in the folder the session wanted (or an ancestor of it).
      expect(spawned.opts.cwd).toBe(os.homedir())
    })
  }

  it('a plain terminal rejects with the reason instead of falling back to an ancestor', async () => {
    h.ensure = vi.fn(async () => failed('the repository is busy'))
    const missing = path.join(cwd, 'gone', 'feat-x')
    const run = pty.createPty(
      { kind: 'shell', cmd: '/bin/sh', cwd: missing, cols: 80, rows: 24 },
      fakeDeps()
    )
    await expect(run).rejects.toBeInstanceOf(pty.ShelvedRestoreError)
    await expect(run).rejects.toMatchObject({ reason: 'archive-unverified', folder: missing })
    expect(h.spawns).toHaveLength(0)
  })

  it('a folder that is not shelved keeps the old fallback to the nearest ancestor', async () => {
    const missing = path.join(cwd, 'not-shelved', 'deep')
    await pty.createPty(
      { kind: 'shell', cmd: '/bin/sh', cwd: missing, cols: 80, rows: 24 },
      fakeDeps()
    )
    expect(h.spawns[0].opts.cwd).toBe(cwd)
  })
})

describe('buildPosixRestoreFailedNotice — injection guard', () => {
  const MALICIOUS = ['$(touch /tmp/PWNED)', '`touch /tmp/PWNED`', "'; touch /tmp/PWNED; '", '$(id)']

  it('hands the cwd and the message to the shell only as positional arguments', () => {
    for (const evil of MALICIOUS) {
      const { command, args } = pty.buildPosixRestoreFailedNotice(evil, evil)
      expect(command).toBe('/bin/sh')
      expect(args.slice(2)).toEqual(['sh', evil, evil])
      expect(args[1]).not.toContain(evil)
    }
  })

  it('prints both values verbatim and runs nothing', () => {
    const evil = '$(echo PWNED)'
    const { command, args } = pty.buildPosixRestoreFailedNotice(evil, '`id`')
    const out = execFileSync(command, args, { encoding: 'utf8' })
    expect(out).toContain(evil)
    expect(out).toContain('`id`')
    expect(out).not.toMatch(/\bPWNED\n/)
  })
})
