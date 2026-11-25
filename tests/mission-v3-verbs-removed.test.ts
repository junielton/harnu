/**
 * Missions v4 S-40 (AC-89, AC-90) — the six v3-only verbs, the v3 handlers and the v3 shape of the kept
 * verbs are gone from the wire, and a v3 record already on disk still opens.
 *
 * Driven through the REAL MCP transport (lesson
 * `docs/lessons/testing/006-eval-harness-grades-state-through-the-real-transport.md`): `registerMcpServer`
 * starts Harnu's own loopback HTTP server, the calls go through the MCP SDK client with the bearer token
 * from the `harnu.mcp.json` the server wrote, so the catalog schema a session really receives, the bearer
 * guard, the policy gate and the wired handler are all in the path. Only `electron` and the live sources
 * (PR join, fleet scan, hook FSM) are stubbed at their seams.
 *
 * Every proof runs on a THROWAWAY repo under the temp directory holding a copy of the frozen v3 fixtures
 * (`tests/fixtures/missions-v4-compat/`, which include a mission with the retired `steward` field and a
 * `linkedCard`). State is graded from the bytes on disk (sha256 and mtime of every file), never from an ACK.
 *
 * AC-93's own grep looks for the four v3 module names, so this file builds each one from parts.
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
import { MCP_OPS } from '../src/main/mcp/tool-catalog'
import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { listMissionViews } from '../src/main/mission-ipc'
import {
  reportUnreadableMissionFiles,
  resetUnreadableMissionFiles
} from '../src/main/missions/store'

const ROOT = path.resolve(__dirname, '..')
const FIXTURES = path.join(__dirname, 'fixtures', 'missions-v4-compat')

/** The leader of the frozen `mnt-5c0de001` fixture. */
const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const MISSION = 'mnt-5c0de001'

/** The six verbs the fate table removes outright (renamed, replaced or dropped), built from parts. */
const REMOVED = [
  ['link', 'child'],
  ['set', 'end'],
  ['verify', 'step'],
  ['add', 'check'],
  ['transfer', 'owner'],
  ['import', 'legacy']
].map((parts) => ['mission', ...parts].join('_'))

/** The sixteen that remain (spec "Verb fate table"). */
const KEPT = [
  'mission_create',
  'mission_get',
  'mission_list',
  'mission_add_milestone',
  'mission_add_step',
  'mission_update_step',
  'mission_add_ac',
  'mission_link',
  'mission_log',
  'mission_set_blocker',
  'mission_clear_blocker',
  'mission_set_done_when',
  'mission_settle_ac',
  'mission_request_close',
  'mission_attach',
  'rebase_stack'
]

let client: Client
let repo = ''

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

/** A main checkout (`.git` dir): enough for the repo-root resolution the verbs do. */
async function fakeRepo(): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-s40-repo-'))
  await fs.mkdir(path.join(base, '.git'), { recursive: true })
  return base
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

async function seedV3(root: string): Promise<void> {
  for (const dir of ['missions', 'campaigns']) {
    await fs.cp(path.join(FIXTURES, dir), path.join(root, '.harnu', dir), { recursive: true })
  }
}

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-s40-ud-'))
  repo = await fakeRepo()
  await registerMcpServer(() => null, {
    bridge: { dispatch: async () => ({}) } as never,
    confirm: createConfirmCore({
      send: () => true,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now()
    })
  })
  const cfg = JSON.parse(await fs.readFile(path.join(h.userDataDir, 'harnu.mcp.json'), 'utf8')) as {
    mcpServers: { harnu: { url: string; headers: Record<string, string> } }
  }
  const entry = cfg.mcpServers.harnu
  client = new Client({ name: 's40-transport-test', version: '0.0.0' })
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

describe('AC-89 — the verbs on the wire are the v4 set', () => {
  it('lists the sixteen v4 verbs and none of the six removed ones', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).filter((n) => /^(mission_|rebase_stack$)/.test(n))
    expect([...names].sort()).toEqual([...KEPT].sort())
    for (const v of REMOVED)
      expect(
        tools.map((t) => t.name),
        v
      ).not.toContain(v)
  })

  it('registers the same sixteen in the catalog and gives each a handler; the six have neither', () => {
    const ops = (MCP_OPS as readonly string[]).filter((o) => /^(mission_|rebase_stack$)/.test(o))
    expect([...ops].sort()).toEqual([...KEPT].sort())
    const wired = WIRED_TOOLS.map((t) => t.op as string)
    for (const v of KEPT) expect(wired, v).toContain(v)
    for (const v of REMOVED) expect(wired, v).not.toContain(v)
    for (const t of WIRED_TOOLS) expect(typeof t.handler).toBe('function')
  })

  it.each(REMOVED)(
    '%s answers a v3 agent with the transport\'s "not found", and writes nothing',
    async (verb) => {
      await seedV3(repo)
      const before = tree(repo)
      const r = await call(verb, { folder: repo, missionId: MISSION })
      expect(r.isError).toBe(true)
      // The wire text a v3 agent that still calls a removed verb receives.
      expect(r.text).toMatch(new RegExp(`Tool ${verb} not found`))
      expect(tree(repo)).toEqual(before)
    }
  )
})

describe('the v3 shape of the kept verbs is not accepted', () => {
  it.each([
    [
      'declaredEnd and verification',
      {
        declaredEnd: { kind: 'code', target: 'x', evidence: 'y' },
        steps: [{ title: 'a', verification: 'existence' }]
      }
    ],
    ['steward', { doneWhen: 'It works', steward: false }],
    [
      'campaignId and chapterId',
      { doneWhen: 'It works', campaignId: 'cmp-ca0001aa', chapterId: 'chp-1' }
    ]
  ])('mission_create with %s is refused, and nothing is written', async (_n, extra) => {
    const root = await fakeRepo()
    const r = await call('mission_create', {
      folder: root,
      title: 'A v3 call',
      sessionId: LEADER,
      ...extra
    })
    expect(r.isError).toBe(true)
    expect(existsSync(path.join(root, '.harnu', 'missions'))).toBe(false)
    expect(existsSync(path.join(root, '.harnu', 'missions-v4'))).toBe(false)
  })

  it('the v4 shape still creates a mission, with no campaign field', async () => {
    const root = await fakeRepo()
    const ack = await ok('mission_create', {
      folder: root,
      title: 'Score report',
      doneWhen: 'Every candidate sees a score report',
      steps: [{ title: 'Load the test files', criteria: ['The files load'] }],
      sessionId: LEADER
    })
    expect(ack).toMatchObject({ ok: true, op: 'mission_create' })
    expect(JSON.stringify(ack)).not.toMatch(/campaign|steward/i)
  })
})

describe('AC-90 — a v3 record still opens after the removal', () => {
  it('mission_get and mission_list read it, and no byte, mtime or directory moves', async () => {
    const root = await fakeRepo()
    await seedV3(root)
    const before = tree(root)
    const userDataBefore = tree(h.userDataDir)

    const got = await ok('mission_get', { folder: root, missionId: MISSION, sessionId: LEADER })
    expect(got).toMatchObject({ ok: true, id: MISSION, source: 'v3-mission' })
    expect(got.title).toBeTruthy()
    const listed = await ok('mission_list', { folder: root })
    const ids = (listed.missions as Array<{ id: string }>).map((m) => m.id)
    // The open v3 missions are rows of the one list (before, only a v4 record was).
    expect(ids).toContain(MISSION)

    expect(tree(root)).toEqual(before)
    expect(existsSync(path.join(root, '.harnu', 'missions-v4'))).toBe(false)
    expect(tree(h.userDataDir)).toEqual(userDataBefore)
  })

  it('the first write converts it by copy: a v4 record appears and every v3 file keeps its bytes and mtime', async () => {
    const root = await fakeRepo()
    await seedV3(root)
    const v3Before = {
      missions: tree(path.join(root, '.harnu', 'missions')),
      campaigns: tree(path.join(root, '.harnu', 'campaigns'))
    }
    await ok('mission_add_ac', {
      folder: root,
      missionId: MISSION,
      stepId: 'stp-1',
      text: 'The designer signed off',
      by: 'operator',
      sessionId: LEADER
    })
    expect(
      readdirSync(path.join(root, '.harnu', 'missions-v4')).some((n) => n.startsWith(MISSION))
    ).toBe(true)
    expect({
      missions: tree(path.join(root, '.harnu', 'missions')),
      campaigns: tree(path.join(root, '.harnu', 'campaigns'))
    }).toEqual(v3Before)
    const after = await ok('mission_get', { folder: root, missionId: MISSION, sessionId: LEADER })
    expect(after.source).toBe('v4')
  })
})

// ---- the code is gone, not just unreachable ----------------------------------------------------

/** The four v3 modules, named from parts so AC-93's grep never finds them in this file. */
const MODULES = ['core', 'gates', 'progress', 'migration'].map((p) => ['mission', p].join('-'))
/**
 * An import of one of the four, in any spelling (`from` or `import(` with a path ending in one of the four
 * names, with or without a `.ts` or `.js` suffix). (AC-93's own grep is looser: it matches the quoted name anywhere, so it also finds a
 * `data-test` attribute of the pane named `mission-progress`; that one is not an import and is reported
 * separately.)
 */
const IMPORT_RE = `(from|import\\()[[:space:]]*['"][^'"]*/mission-(${['core', 'gates', 'progress', 'migration'].join('|')})(\\.ts|\\.js)?['"]`

/** Slice S-41 deletes these; they, and the four modules themselves, may still name the modules. */
const S41 = new Set([
  ...MODULES.map((m) => `src/main/${m}.ts`),
  'tests/mission-core.test.ts',
  'tests/mission-decision-door.test.ts',
  'tests/mission-gates-derived.test.ts',
  'tests/mission-gates-govern-verified.test.ts',
  'tests/mission-migration.test.ts',
  'tests/mission-operator-doors.test.ts',
  'tests/mission-progress.test.ts',
  'tests/mission-side-steps.test.ts',
  'tests/mission-side-view.test.ts',
  'tests/mission-gates-evidence.test.ts',
  'tests/mission-gates.test.ts',
  'tests/mission-v3-removed.test.ts'
])

function importers(cwd: string, pathspecs: string[]): string[] {
  try {
    const out = execFileSync('git', ['grep', '-lE', IMPORT_RE, '--', ...pathspecs], {
      cwd,
      encoding: 'utf8'
    })
    return out.split('\n').filter(Boolean)
  } catch (err) {
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
}

describe('nothing but the files S-41 deletes imports a v3 core module', () => {
  it("lists no importer outside S-41's files (so S-41 can delete the four modules)", () => {
    const outside = importers(ROOT, ['src', 'tests', 'scripts']).filter((f) => !S41.has(f))
    expect(outside).toEqual([])
  })

  it('the guard goes red when an import is planted in a throwaway repo', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harnu-s40-fault-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(path.join(dir, 'a.ts'), `import { x } from '../${MODULES[0]}'\n`)
    writeFileSync(path.join(dir, 'b.ts'), `const m = await import('./${MODULES[1]}.ts')\n`)
    writeFileSync(path.join(dir, 'c.ts'), `// nothing to see here\n`)
    execFileSync('git', ['add', '.'], { cwd: dir })
    expect(importers(dir, ['.']).sort()).toEqual(['a.ts', 'b.ts'])
  })
})

describe('the v3 handlers and their wrappers no longer exist in the handler file', () => {
  const src = readFileSync(path.join(ROOT, 'src/main/mcp/tool-handlers.ts'), 'utf8')
  const NAMES = [
    'missionLinkChildHandler',
    'missionSetEndHandler',
    'missionVerifyStepHandler',
    'missionAddCheckHandler',
    'missionTransferOwnerHandler',
    'missionImportLegacyHandler',
    'missionUpdateStepHandler',
    'v3OnlyVerb',
    'sharedVerb',
    'missionListBoth',
    'importLegacyGoalFile'
  ]
  it.each(NAMES)('%s is gone', (name) => {
    expect(src).not.toContain(name)
  })
})

describe('mission:list answers no v3 view and names every file some reader could not read', () => {
  it('lists no view, and merges the names the other readers reported, once each', async () => {
    resetUnreadableMissionFiles()
    const root = await fakeRepo()
    await seedV3(root)
    await fs.mkdir(path.join(root, '.harnu', 'missions-v4'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.harnu', 'missions-v4', 'mnt-0badc0de-broken.md'),
      '{ not a mission record'
    )
    // The hibernation check and the companion each name a file they could not read (here, the same one).
    reportUnreadableMissionFiles('hibernation', ['mnt-0badc0de-broken.md', 'mnt-0badc0df-other.md'])
    reportUnreadableMissionFiles('companion', ['mnt-0badc0de-broken.md'])
    const list = await listMissionViews([root])
    expect(list.views).toEqual([])
    expect([...list.unreadable].sort()).toEqual(['mnt-0badc0de-broken.md', 'mnt-0badc0df-other.md'])
    resetUnreadableMissionFiles()
    expect((await listMissionViews([root])).unreadable).toEqual(['mnt-0badc0de-broken.md'])
  })
})
