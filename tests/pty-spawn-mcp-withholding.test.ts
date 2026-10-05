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
      'mission_add_check',
      'mission_add_step',
      'mission_clear_blocker',
      'mission_create',
      'mission_get',
      'mission_import_legacy',
      'mission_link_child',
      'mission_list',
      'mission_log',
      'mission_request_close',
      'mission_set_blocker',
      'mission_set_end',
      'mission_update_step',
      'mission_verify_step'
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
