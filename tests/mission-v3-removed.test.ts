/**
 * Missions v4 S-41 (AC-93) — the four v3 core modules are gone and nothing imports them. `v3-read.ts` is the
 * only v3 code left, and a v3 record already on disk still opens.
 *
 * AC-93's own proof is a `git grep` for the import paths of the four modules over `src tests scripts
 * resources`. That grep would find this file if it spelled one of them out, so every forbidden string below is
 * built from parts (the same device as `tests/mission-v3-verbs-removed.test.ts`).
 *
 * The "still opens" half runs through the REAL MCP transport on a throwaway repo under the temp directory that
 * holds a copy of the frozen v3 fixtures (never the operator's `.harnu/`): sha256 and mtime of every file are
 * recorded before and after the read and must be equal.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  promises as fs,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const h = vi.hoisted(() => ({ userDataDir: '' }))

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
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanFolders: async (): Promise<unknown[]> => []
}))
vi.mock('../src/main/user-projects', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUserProjects: async (): Promise<unknown> => ({ projects: [] })
}))
vi.mock('../src/main/hook-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/hook-bridge')>()),
  getTaskStates: () => new Map(),
  addTaskEventObserver: () => () => {}
}))
vi.mock('../src/main/pty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/pty')>()),
  liveSessionKeys: () => new Set()
}))
vi.mock('../src/main/hibernation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/hibernation')>()),
  hibernatedKeys: () => new Set()
}))
vi.mock('../src/main/approval-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/approval-resolver')>()),
  listPendingApprovals: () => []
}))
vi.mock('../src/main/pr-stack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/pr-stack')>()),
  findPrsForWorktrees: async () => ({
    ghAvailable: true,
    worktrees: {},
    branches: {},
    numbers: {}
  }),
  findMainCi: async () => ({ ghAvailable: true, byNumber: {} })
}))

import { registerMcpServer, closeMcpServer } from '../src/main/mcp/server'
import { createConfirmCore } from '../src/main/mcp/confirm-core'
import { listMissionViews } from '../src/main/mission-ipc'

const ROOT = path.resolve(__dirname, '..')
const FIXTURES = path.join(__dirname, 'fixtures', 'missions-v4-compat')

/** The leader and id of the frozen `mnt-5c0de001` fixture. */
const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const MISSION = 'mnt-5c0de001'

/** The four v3 modules, named from parts so AC-93's grep never finds them in this file. */
const NAMES = ['core', 'gates', 'progress', 'migration'].map((p) => ['mission', p].join('-'))
const SEARCHED = ['src', 'tests', 'scripts', 'resources']

/** AC-93's patterns, one per module: a slash before the name, a quote right after it. */
const AC93_PATTERNS = NAMES.map((n) => `/${n}['"]`)

function grep(cwd: string, patterns: string[], pathspecs: string[]): string[] {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-lE', '--untracked', ...patterns.flatMap((p) => ['-e', p]), '--', ...pathspecs],
      { cwd, encoding: 'utf8' }
    )
    return out.split('\n').filter(Boolean)
  } catch (err) {
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
}

describe('AC-93 — the four v3 core modules are gone and nothing imports them', () => {
  it.each(NAMES)('src/main/%s.ts does not exist', (name) => {
    expect(existsSync(path.join(ROOT, 'src', 'main', `${name}.ts`))).toBe(false)
  })

  it('no file under src, tests, scripts or resources has an import path ending in one of them', () => {
    expect(grep(ROOT, AC93_PATTERNS, SEARCHED)).toEqual([])
  })

  it('no import in any spelling (from, import(, .ts or .js suffix) names one of them', () => {
    const re = `(from|import\\()[[:space:]]*['"][^'"]*/(${NAMES.join('|')})(\\.ts|\\.js)?['"]`
    expect(grep(ROOT, [re], SEARCHED)).toEqual([])
  })

  it('v3-read.ts, the only v3 code left, is still there', () => {
    expect(existsSync(path.join(ROOT, 'src', 'main', 'missions', 'v3-read.ts'))).toBe(true)
  })

  it('the guard goes red when an import is planted in a throwaway repo', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harnu-s41-fault-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(path.join(dir, 'a.ts'), `import { x } from '../${NAMES[0]}'\n`)
    writeFileSync(path.join(dir, 'b.ts'), `const m = await import('./${NAMES[3]}.ts')\n`)
    writeFileSync(path.join(dir, 'c.ts'), `// nothing to see here\n`)
    expect(grep(dir, AC93_PATTERNS, ['.']).sort()).toEqual(['a.ts'])
    const loose = `(from|import\\()[[:space:]]*['"][^'"]*/(${NAMES.join('|')})(\\.ts|\\.js)?['"]`
    expect(grep(dir, [loose], ['.']).sort()).toEqual(['a.ts', 'b.ts'])
  })
})

// ---- a v3 record on disk still opens with the modules gone -------------------------------------

let client: Client

interface Reply {
  isError: boolean
  text: string
  body: Record<string, unknown>
}

async function call(name: string, args: Record<string, unknown>): Promise<Reply> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean
    content: Array<{ type: string; text?: string }>
  }
  const text = res.content[0]?.text ?? ''
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* a refusal is plain text */
  }
  return { isError: res.isError === true, text, body }
}

async function ok(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await call(name, args)
  expect(r.isError, r.text).toBe(false)
  return r.body
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

/** Every file (bytes and mtime) and every directory under `dir`, keyed by relative path. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (sub: string): void => {
    for (const e of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, e.name)
      const abs = path.join(dir, rel)
      if (e.isDirectory()) {
        out[`${rel}/`] = 'dir'
        walk(rel)
      } else out[rel] = `${sha(readFileSync(abs))}@${statSync(abs).mtimeMs}`
    }
  }
  if (existsSync(dir)) walk('')
  return out
}

async function fakeRepo(): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-s41-repo-'))
  await fs.mkdir(path.join(base, '.git'), { recursive: true })
  return base
}

async function seedV3(root: string): Promise<void> {
  for (const dir of ['missions', 'campaigns']) {
    await fs.cp(path.join(FIXTURES, dir), path.join(root, '.harnu', dir), { recursive: true })
  }
}

describe('AC-90 still holds with the modules gone — reading a v3 record writes nothing', () => {
  beforeAll(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-s41-ud-'))
    await registerMcpServer(() => null, {
      bridge: { dispatch: async () => ({}) } as never,
      confirm: createConfirmCore({
        send: () => true,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        now: () => Date.now()
      })
    })
    const cfg = JSON.parse(
      await fs.readFile(path.join(h.userDataDir, 'harnu.mcp.json'), 'utf8')
    ) as { mcpServers: { harnu: { url: string; headers: Record<string, string> } } }
    const entry = cfg.mcpServers.harnu
    client = new Client({ name: 's41-transport-test', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(entry.url), {
        requestInit: { headers: entry.headers }
      })
    )
  })

  afterAll(async () => {
    await client?.close().catch(() => {})
    await closeMcpServer()
  })

  it('mission_get and mission_list read the frozen v3 mission; sha256 and mtime of every file are equal after', async () => {
    const root = await fakeRepo()
    await seedV3(root)
    const before = tree(root)
    expect(Object.keys(before).length).toBeGreaterThan(2)

    const got = await ok('mission_get', { folder: root, missionId: MISSION, sessionId: LEADER })
    expect(got).toMatchObject({ ok: true, id: MISSION, source: 'v3-mission' })
    const listed = await ok('mission_list', { folder: root })
    expect((listed.missions as Array<{ id: string }>).map((m) => m.id)).toContain(MISSION)

    expect(tree(root)).toEqual(before)
    expect(existsSync(path.join(root, '.harnu', 'missions-v4'))).toBe(false)
  })

  it('the Mission pane list (mission:list) names the v3 files and writes nothing', async () => {
    const root = await fakeRepo()
    await seedV3(root)
    const before = tree(root)
    const list = await listMissionViews([root])
    expect(list.views).toEqual([])
    expect(tree(root)).toEqual(before)
  })
})
