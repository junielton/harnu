/**
 * T358 S3 — Review Focus #5: the `mission_*` verb family must not open a path
 * into the two spawn shapes that WITHHOLD Harnu's MCP server, and must not be
 * over-withheld from the one that keeps it.
 *
 * Withholding is argv-level (`pty.ts`, `pty:create`): an `agentControlled`
 * spawn (an agent's own `create_session`) and a `readOnly` spawn (a T245 review
 * companion) are built WITHOUT Harnu's app-managed `--mcp-config`, so they get no
 * Harnu MCP server — and so no `mission_*` verb — at all. A manifest/board
 * dispatch (`spawnedBy: 'agent'`, not `agentControlled`) keeps the config, and
 * the server behind it registers every entry of `WIRED_TOOLS`.
 *
 * No other test drives `pty:create`'s argv (the other `pty-*` suites pin pure
 * helpers), so this one does, end to end: electron's `ipcMain` and `node-pty`'s
 * `spawn` are mocked to capture the handler and the exact argv it spawns;
 * everything between them — the kind branches, the `--mcp-config` ordering,
 * the permission downgrades — is the real code.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  spawns: [] as Array<{ command: string; args: string[] }>,
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
  spawn: (command: string, args: string[]): unknown => {
    h.spawns.push({ command, args: [...args] })
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

// The environment probes around the argv build — stubbed so the test never
// depends on a real `claude` binary, the operator's boot config, or a login shell.
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

const MCP_CONFIG = '/tmp/harnu-test/mcp-config.json'
let cwd: string

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-pty-ud-'))
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-pty-cwd-'))
  const pty = await import('../src/main/pty')
  // The MCP server is ON: every non-withheld claude spawn gets this config.
  pty.setMcpArgsProvider(() => ['--mcp-config', MCP_CONFIG])
  pty.registerPtyHandlers(() => null)
})

/** Drive the real `pty:create` handler and return the argv it spawned. */
async function spawnArgv(opts: Record<string, unknown>): Promise<string[]> {
  const create = h.handlers.get('pty:create')
  if (!create) throw new Error('pty:create was not registered')
  const before = h.spawns.length
  await create({}, { cwd, cols: 80, rows: 24, kind: 'claude-new', ...opts })
  expect(h.spawns.length).toBe(before + 1)
  const spawned = h.spawns[h.spawns.length - 1]
  expect(spawned.command).toBe('/usr/bin/claude')
  return spawned.args
}

describe('pty:create — Harnu MCP withholding once mission_* exists (Review Focus #5)', () => {
  it('precondition: the catalog the server registers really carries the mission_* verbs', async () => {
    const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
    const missionOps = WIRED_TOOLS.filter((t) => t.op.startsWith('mission_'))
    expect(missionOps.map((t) => t.op).sort()).toEqual([
      'mission_add_ac',
      'mission_add_milestone',
      'mission_add_step',
      'mission_attach',
      'mission_clear_blocker',
      'mission_create',
      'mission_get',
      'mission_link',
      'mission_list',
      'mission_log',
      'mission_request_close',
      'mission_set_blocker',
      'mission_set_done_when',
      'mission_settle_ac',
      'mission_update_step'
    ])
    for (const t of missionOps) expect(typeof t.handler, t.op).toBe('function')
  })

  it('an agentControlled spawn (create_session) gets NO Harnu MCP server', async () => {
    const argv = await spawnArgv({ agentControlled: true, spawnedBy: 'agent' })
    expect(argv).not.toContain('--mcp-config')
    expect(argv).not.toContain(MCP_CONFIG)
  })

  it('a readOnly spawn (review companion) gets NO Harnu MCP server', async () => {
    const argv = await spawnArgv({ readOnly: true })
    expect(argv).not.toContain('--mcp-config')
    expect(argv).not.toContain(MCP_CONFIG)
  })

  it("a manifest-dispatched spawn (spawnedBy: 'agent') keeps the server — and with it every mission_* verb", async () => {
    const argv = await spawnArgv({ spawnedBy: 'agent' })
    const at = argv.indexOf('--mcp-config')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(argv[at + 1]).toBe(MCP_CONFIG)
  })

  it('an operator spawn keeps the server too (the withholding is scoped to the two shapes)', async () => {
    const argv = await spawnArgv({ spawnedBy: 'operator' })
    expect(argv).toContain('--mcp-config')
  })
})

// ---- Missions v4 S-25 (BUG-253): the credential of a session Harnu spawns for a step -------------

describe('pty:create — a session Harnu spawns for a step holds the scoped verbs of its role (S-25)', () => {
  const SCOPED_CONFIG = '/tmp/harnu-test/scoped-mcp/session.json'
  const STEP = { role: 'worker', missionId: 'mnt-aaaaaaaa', stepId: 'stp-1' } as const
  const seen: Array<Record<string, unknown>> = []

  beforeAll(async () => {
    const pty = await import('../src/main/pty')
    const { scopedAllowedTools } = await import('../src/main/mcp/scope')
    pty.setScopedMcpArgsProvider(async (scope) => {
      seen.push({ ...scope })
      // What the server does: write the bearer into a 0600 file and hand back its PATH, never the bearer.
      return ['--mcp-config', SCOPED_CONFIG, '--allowedTools', scopedAllowedTools(scope).join(',')]
    })
  })

  const pendingFor = async (spawn: Record<string, unknown>): Promise<void> => {
    const { registerPendingSpawn } = await import('../src/main/mcp/scope')
    registerPendingSpawn(cwd, spawn as never)
  }

  it('a create_session for a step gets the scoped config, a session id Harnu minted, and not the full server', async () => {
    seen.length = 0
    await pendingFor(STEP)
    const argv = await spawnArgv({ agentControlled: true, spawnedBy: 'agent' })

    const at = argv.indexOf('--mcp-config')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(argv[at + 1]).toBe(SCOPED_CONFIG)
    expect(argv).not.toContain(MCP_CONFIG)

    // The id is minted here and passed with --session-id, so the credential can carry it.
    const sid = argv[argv.indexOf('--session-id') + 1]
    expect(sid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ ...STEP, sessionId: sid, folder: cwd })

    // The role's verbs are auto-allowed, and only those.
    const allowed = argv[argv.indexOf('--allowedTools') + 1]
    expect(allowed).toContain('mcp__harnu__mission_log')
    expect(allowed).not.toContain('mcp__harnu__mission_attach')
    // The model is told what it is bound to; the credential itself is nowhere on the command line.
    expect(argv.join('\n')).toContain('mnt-aaaaaaaa')
    expect(argv.join('\n')).not.toContain('scp_')
  })

  it('the credential is for one spawn: the next agent-controlled spawn in the folder gets nothing', async () => {
    await pendingFor(STEP)
    await spawnArgv({ agentControlled: true, spawnedBy: 'agent' })
    const next = await spawnArgv({ agentControlled: true, spawnedBy: 'agent' })
    expect(next).not.toContain('--mcp-config')
  })

  it('an agent-controlled spawn with no step stays withheld, as before', async () => {
    const argv = await spawnArgv({ agentControlled: true, spawnedBy: 'agent' })
    expect(argv).not.toContain('--mcp-config')
  })

  it('a read-only companion never takes a credential, even when one is waiting in its folder', async () => {
    const { dropPendingSpawn, takePendingSpawn } = await import('../src/main/mcp/scope')
    await pendingFor(STEP)
    const argv = await spawnArgv({ readOnly: true })
    expect(argv).not.toContain('--mcp-config')
    // ...and it did not use the credential up: the spawn it was noted for can still take it.
    expect(takePendingSpawn(cwd)).toBeDefined()
    dropPendingSpawn(cwd)
  })

  it('a server that is off hands back no config: the session spawns without one', async () => {
    const pty = await import('../src/main/pty')
    pty.setScopedMcpArgsProvider(async () => [])
    await pendingFor(STEP)
    const argv = await spawnArgv({ agentControlled: true, spawnedBy: 'agent' })
    expect(argv).not.toContain('--mcp-config')
    const { scopedAllowedTools } = await import('../src/main/mcp/scope')
    pty.setScopedMcpArgsProvider(async (scope) => [
      '--mcp-config',
      SCOPED_CONFIG,
      '--allowedTools',
      scopedAllowedTools(scope).join(',')
    ])
  })
})

// ---- Missions v4 S-26 (AC-68): the credential of a session a card's dispatch spawns for a step ----

describe('pty:create — a card the drain or the board dispatches for a step holds the verbs of its step (S-26)', () => {
  const SCOPED_CONFIG = '/tmp/harnu-test/scoped-mcp/card-session.json'
  const STEP = { role: 'worker', missionId: 'mnt-bbbbbbbb', stepId: 'stp-2' } as const
  const seen: Array<Record<string, unknown>> = []

  beforeAll(async () => {
    const pty = await import('../src/main/pty')
    const { scopedAllowedTools } = await import('../src/main/mcp/scope')
    pty.setScopedMcpArgsProvider(async (scope) => {
      seen.push({ ...scope })
      return ['--mcp-config', SCOPED_CONFIG, '--allowedTools', scopedAllowedTools(scope).join(',')]
    })
  })

  const pendingFor = async (): Promise<void> => {
    const { registerPendingSpawn } = await import('../src/main/mcp/scope')
    registerPendingSpawn(cwd, STEP)
  }

  it('a manifest-dispatched spawn for a step gets the scoped config, a minted session id, and not the full server', async () => {
    seen.length = 0
    await pendingFor()
    const argv = await spawnArgv({ spawnedBy: 'agent' })

    const at = argv.indexOf('--mcp-config')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(argv[at + 1]).toBe(SCOPED_CONFIG)
    expect(argv).not.toContain(MCP_CONFIG)
    const sid = argv[argv.indexOf('--session-id') + 1]
    expect(sid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ ...STEP, sessionId: sid, folder: cwd })
    const allowed = argv[argv.indexOf('--allowedTools') + 1]
    expect(allowed).toContain('mcp__harnu__mission_log')
    expect(allowed).not.toContain('mcp__harnu__mission_attach')
  })

  it('it is the operator’s own dispatch, so its permissions are not downgraded as an agent-controlled spawn’s are', async () => {
    await pendingFor()
    const scoped = await spawnArgv({ spawnedBy: 'agent' })
    await pendingFor()
    const withheld = await spawnArgv({ agentControlled: true, spawnedBy: 'agent' })
    // Same note, two spawn shapes: only the agent-controlled one is rebuilt from the downgraded config.
    expect(scoped).toContain('--mcp-config')
    expect(withheld).toContain('--mcp-config')
    expect(scoped.join(' ')).not.toBe(withheld.join(' '))
  })

  it('a card spawn with no step keeps the full server, as before', async () => {
    const argv = await spawnArgv({ spawnedBy: 'agent' })
    expect(argv[argv.indexOf('--mcp-config') + 1]).toBe(MCP_CONFIG)
  })

  it('an operator’s own new session never takes the credential waiting for a card’s spawn', async () => {
    const { takePendingSpawn, dropPendingSpawn } = await import('../src/main/mcp/scope')
    await pendingFor()
    const argv = await spawnArgv({ spawnedBy: 'operator' })
    expect(argv[argv.indexOf('--mcp-config') + 1]).toBe(MCP_CONFIG)
    expect(takePendingSpawn(cwd)).toBeDefined()
    dropPendingSpawn(cwd)
  })
})
