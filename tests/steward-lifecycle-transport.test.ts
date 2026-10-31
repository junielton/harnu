/**
 * Campaign ch.5a (T597) — the steward's lifecycle, graded through the REAL MCP transport
 * (lesson `docs/lessons/testing/006-…`): a mission is created over HTTP, its steward is a real
 * Scheduler worker in the real store, a second MCP client authenticates with the steward's own
 * bearer, and state is read back from the files on disk (js-yaml / JSON), not from ACKs.
 *
 * Covers AC-5a.1 (the server enforces the allowlist on a steward caller), AC-5a.3 (system worker
 * category, WORKER_IS_STEWARD, deleted at close, kill-switches), AC-5a.4 (event wake-ups with a
 * coalescing gap, every action a `steward` Log entry) and AC-5a.5 (hooks installed at create,
 * removed at close, the user's own hooks untouched). Only `electron`, the live sources (PR join,
 * fleet scan, hook FSM) and the `claude` spawn are stubbed at their seams.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import yaml from 'js-yaml'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

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
vi.mock('../src/main/hook-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/hook-bridge')>()),
  getTaskStates: () => new Map(),
  addTaskEventObserver: () => () => {},
  getStewardHookEndpoint: () => ({ port: 4711, token: 'bridge-token' })
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
import { writeMcpEnabled } from '../src/main/mcp/prefs'
import {
  registerScheduler,
  stopSchedulerTicker,
  setStewardTickStarter,
  setStewardWakeGapMs,
  wakeStewardForMission,
  stewardForWorkerId
} from '../src/main/scheduler-shell'
import { runOperatorDoor } from '../src/main/mission-ipc'
import { recordLedgerEvent } from '../src/main/mcp/tool-handlers'
import { stewardBearer } from '../src/main/steward-core'
import { isStewardHook } from '../src/main/steward-hooks'

const OWNER = '11111111-2222-4333-8444-555555555555'
const CHILD = '99999999-2222-4333-8444-555555555555'
const END = { kind: 'code', target: 'every page migrated', evidence: 'the audit is green' }
const STEPS = [
  { title: 'Build the importer', verification: 'verifier' },
  { title: 'Migrate the pages', verification: 'verifier' }
]

let client: Client
let serverToken = ''
let serverUrl = ''
const started: Array<{ missionId: string; reason: string }> = []

interface Reply {
  isError: boolean
  text: string
  body: Record<string, unknown>
}

async function callOn(c: Client, name: string, args: Record<string, unknown>): Promise<Reply> {
  const res = (await c.callTool({ name, arguments: args })) as {
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
const call = (name: string, args: Record<string, unknown>): Promise<Reply> =>
  callOn(client, name, args)
const ok = async (
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> => {
  const r = await call(name, args)
  expect(r.isError, r.text).toBe(false)
  return r.body
}

async function connectAs(bearer: string): Promise<Client> {
  const c = new Client({ name: 'steward-test', version: '0.0.0' })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(serverUrl), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } }
    })
  )
  return c
}

/** A main checkout (`.git` dir) — enough for missionRoot; no git binary needed. */
async function fakeRepo(): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-steward-repo-'))
  const repo = path.join(base, 'main')
  await fs.mkdir(path.join(repo, '.git'), { recursive: true })
  return repo
}

let missionSeq = 0
/** A unique title per call: two identical mission_create calls are one call to the idempotency registry. */
async function newMission(folder: string, extra: Record<string, unknown> = {}): Promise<string> {
  const ack = await ok('mission_create', {
    folder,
    title: `Ship the migration ${++missionSeq}`,
    declaredEnd: END,
    sessionId: OWNER,
    steps: STEPS,
    ...extra
  })
  return ack.missionId as string
}

async function missionOnDisk(
  root: string,
  id: string
): Promise<{ front: Record<string, unknown>; log: string }> {
  const dir = path.join(root, '.harnu', 'missions')
  const name = (await fs.readdir(dir)).find((n) => n.startsWith(`${id}-`))!
  const raw = await fs.readFile(path.join(dir, name), 'utf8')
  const parts = raw.split(/^---\n/m)
  return {
    front: yaml.load(parts[1], { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>,
    log: parts.slice(2).join('---\n')
  }
}

const workers = async (): Promise<Array<Record<string, unknown>>> =>
  (await ok('list_workers', {})).workers as Array<Record<string, unknown>>
const stewardRows = async (): Promise<Array<Record<string, unknown>>> =>
  (await workers()).filter((w) => w.category === 'steward')
const settingsPath = (folder: string): string => path.join(folder, '.claude', 'settings.local.json')
const readSettings = async (folder: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(settingsPath(folder), 'utf8')) as Record<string, unknown>
const closeAs = (root: string, missionId: string): Promise<unknown> =>
  runOperatorDoor({ door: 'end', root, missionId, closedAs: 'delivered' })

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-steward-ud-'))
  registerScheduler(() => null, { dispatch: async () => ({}) } as never)
  setStewardTickStarter(async (_worker, reason) => {
    started.push({ missionId: _worker.missionId!, reason })
  })
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
    mcpServers: { harnu: { url: string; headers: { Authorization: string } } }
  }
  serverUrl = cfg.mcpServers.harnu.url
  serverToken = cfg.mcpServers.harnu.headers.Authorization.replace(/^Bearer /, '')
  client = await connectAs(serverToken)
})

afterAll(async () => {
  await client?.close().catch(() => {})
  await closeMcpServer()
  stopSchedulerTicker()
  setStewardTickStarter(null)
})

beforeEach(() => {
  started.length = 0
  h.denied = []
  setStewardWakeGapMs(60_000)
})

describe('AC-5a.3 — a mission carries a system-worker steward', () => {
  it('mission_create creates one steward by default: category steward, not agent-controllable, 20-minute beat', async () => {
    const repo = await fakeRepo()
    const missionId = await newMission(repo)
    const rows = (await stewardRows()).filter((w) => w.missionId === missionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      mode: 'steward',
      category: 'steward',
      agentControllable: false,
      everyMinutes: 20,
      enabled: true,
      missionId
    })
  })

  it('the ACK says so, and `steward: false` creates none', async () => {
    const repo = await fakeRepo()
    const ack = await ok('mission_create', {
      folder: repo,
      title: 'No steward',
      declaredEnd: END,
      sessionId: OWNER,
      steps: STEPS
    })
    expect(ack.steward).toMatchObject({ created: true })
    const before = (await stewardRows()).length
    const off = await ok('mission_create', {
      folder: repo,
      title: 'Opted out',
      declaredEnd: END,
      sessionId: OWNER,
      steps: STEPS,
      steward: false
    })
    expect(off.steward).toMatchObject({ created: false })
    expect((await stewardRows()).length).toBe(before)
  })

  it('update_worker and delete_worker refuse WORKER_IS_STEWARD and change nothing', async () => {
    const repo = await fakeRepo()
    const missionId = await newMission(repo)
    const row = (await stewardRows()).find((w) => w.missionId === missionId)!
    const upd = await call('update_worker', { id: row.id, set: { enabled: false } })
    expect(upd.isError).toBe(true)
    expect(upd.text).toMatch(/WORKER_IS_STEWARD/)
    const upd2 = await call('update_worker', { id: row.id, set: { prompt: 'do something else' } })
    expect(upd2.text).toMatch(/WORKER_IS_STEWARD/)
    const del = await call('delete_worker', { id: row.id })
    expect(del.isError).toBe(true)
    expect(del.text).toMatch(/WORKER_IS_STEWARD/)
    const after = (await stewardRows()).find((w) => w.missionId === missionId)!
    expect(after).toMatchObject({ enabled: true, everyMinutes: 20 })
  })

  it('create_worker cannot mint a steward', async () => {
    const repo = await fakeRepo()
    const r = await call('create_worker', {
      folder: repo,
      name: 'fake steward',
      prompt: 'x',
      everyMinutes: 30,
      mode: 'steward'
    })
    expect(r.isError).toBe(true)
  })

  it('is deleted when the operator closes the mission (delivered or discarded)', async () => {
    const repo = await fakeRepo()
    const a = await newMission(repo)
    const b = await newMission(repo)
    expect(
      (await stewardRows()).filter((w) => [a, b].includes(w.missionId as string))
    ).toHaveLength(2)
    await closeAs(repo, a)
    await runOperatorDoor({ door: 'end', root: repo, missionId: b, closedAs: 'discarded' })
    expect(
      (await stewardRows()).filter((w) => [a, b].includes(w.missionId as string))
    ).toHaveLength(0)
  })

  it('a mission that is delivered but not yet closed keeps its steward (the operator has not closed it)', async () => {
    const repo = await fakeRepo()
    const id = await newMission(repo)
    // pendingClose is a signal, not a close
    await call('mission_request_close', { folder: repo, missionId: id })
    expect((await stewardRows()).some((w) => w.missionId === id)).toBe(true)
    await closeAs(repo, id)
  })
})

describe('AC-5a.3 — the global kill-switches stop a steward too', () => {
  it('a blocked folder: a wake starts nothing', async () => {
    const repo = await fakeRepo()
    const missionId = await newMission(repo)
    h.denied = [repo]
    const out = await wakeStewardForMission(missionId, 'ledger')
    expect(out).toMatchObject({ woke: false })
    expect(String((out as { reason: string }).reason)).toMatch(/FOLDER_NOT_ALLOWED/)
    expect(started).toHaveLength(0)
  })

  it('agent control off (SERVER_DISABLED): a wake starts nothing', async () => {
    const repo = await fakeRepo()
    const missionId = await newMission(repo)
    await writeMcpEnabled(false)
    try {
      const out = await wakeStewardForMission(missionId, 'ledger')
      expect(out).toMatchObject({ woke: false })
      expect(String((out as { reason: string }).reason)).toMatch(/SERVER_DISABLED/)
      expect(started).toHaveLength(0)
    } finally {
      await writeMcpEnabled(true)
    }
  })
})

describe('AC-5a.1 — the server enforces the allowlist on a steward caller', () => {
  let missionId: string
  let repo: string
  let steward: Client

  beforeAll(async () => {
    repo = await fakeRepo()
    missionId = await newMission(repo)
    const row = (await stewardRows()).find((w) => w.missionId === missionId)!
    steward = await connectAs(stewardBearer(serverToken, row.id as string))
  })
  afterAll(async () => {
    await steward?.close().catch(() => {})
  })

  it('a verb outside the list is refused STEWARD_VERB_NOT_ALLOWED', async () => {
    const r = await callOn(steward, 'create_worker', {
      folder: repo,
      name: 'x',
      prompt: 'x',
      everyMinutes: 30,
      mode: 'observe'
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/STEWARD_VERB_NOT_ALLOWED/)
    expect((await workers()).some((w) => w.name === 'x')).toBe(false)
  })

  it("create_session needs role: 'verifier'", async () => {
    const no = await callOn(steward, 'create_session', { folder: repo, prePrompt: 'go' })
    expect(no.text).toMatch(/STEWARD_ROLE_REQUIRED/)
    const wrong = await callOn(steward, 'create_session', { folder: repo, role: 'executor' })
    expect(wrong.isError).toBe(true)
    const yes = await callOn(steward, 'create_session', {
      folder: repo,
      prePrompt: 'verify',
      role: 'verifier'
    })
    expect(yes.text).not.toMatch(/STEWARD_/)
  })

  it('a steward works on its own mission only', async () => {
    const other = await newMission(repo)
    const r = await callOn(steward, 'mission_get', { folder: repo, missionId: other })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/STEWARD_SCOPE/)
    const mine = await callOn(steward, 'mission_get', { folder: repo, missionId })
    expect(mine.isError, mine.text).toBe(false)
    const mint = await callOn(steward, 'mission_create', {
      folder: repo,
      title: 'spawn',
      declaredEnd: END,
      sessionId: OWNER
    })
    expect(mint.text).toMatch(/STEWARD_SCOPE/)
  })

  it('the main token is unaffected: it can still call every verb', async () => {
    const r = await call('create_worker', {
      folder: repo,
      name: 'user worker',
      prompt: 'x',
      everyMinutes: 30,
      mode: 'observe'
    })
    expect(r.isError, r.text).toBe(false)
  })

  it('a forged bearer, or one whose steward was deleted, is refused at the door', async () => {
    await expect(connectAs(stewardBearer('not-the-secret', 'whatever'))).rejects.toThrow()
    const repo2 = await fakeRepo()
    const gone = await newMission(repo2)
    const row = (await stewardRows()).find((w) => w.missionId === gone)!
    const bearer = stewardBearer(serverToken, row.id as string)
    await closeAs(repo2, gone)
    await expect(connectAs(bearer)).rejects.toThrow()
  })

  it("a steward cannot ride the main token's session id, nor the other way round", async () => {
    // The session id is bound to the caller that opened it: a steward bearer presented with the
    // main client's session id (or vice versa) is refused rather than inheriting its powers.
    const sid = (client as unknown as { transport: { sessionId?: string } }).transport?.sessionId
    expect(typeof sid).toBe('string')
    const realRow = (await stewardRows()).find((w) => w.missionId === missionId)!
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${stewardBearer(serverToken, realRow.id as string)}`,
        'mcp-session-id': sid!
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(res.status).toBe(403)
  })
})

describe('AC-5a.4 — every steward action is a `steward` Log entry', () => {
  it('a successful write by the steward is logged; a read and a refused call are not', async () => {
    const repo = await fakeRepo()
    const missionId = await newMission(repo)
    const row = (await stewardRows()).find((w) => w.missionId === missionId)!
    const steward = await connectAs(stewardBearer(serverToken, row.id as string))
    try {
      const before = (await missionOnDisk(repo, missionId)).log
      await callOn(steward, 'mission_get', { folder: repo, missionId })
      await callOn(steward, 'create_worker', {
        folder: repo,
        name: 'n',
        prompt: 'p',
        everyMinutes: 30,
        mode: 'observe'
      })
      expect((await missionOnDisk(repo, missionId)).log).toBe(before)

      const r = await callOn(steward, 'mission_set_blocker', {
        folder: repo,
        missionId,
        stepId: 'stp-1',
        reason: 'CI is red on the importer',
        unblocks: 'a green run',
        owner: 'agent'
      })
      expect(r.isError, r.text).toBe(false)
      const { log } = await missionOnDisk(repo, missionId)
      const entries = log.split(/^### /m).filter((e) => /^\S+ · steward\b/.test(e))
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatch(/mission_set_blocker/)
      expect(entries[0]).toMatch(/CI is red on the importer/)
    } finally {
      await steward.close().catch(() => {})
    }
  })

  it('mission_log takes a kind, and a `steward` note is tagged the same way', async () => {
    const repo = await fakeRepo()
    const missionId = await newMission(repo)
    await ok('mission_log', { folder: repo, missionId, note: 'plain', kind: 'surprise' })
    await ok('mission_log', { folder: repo, missionId, note: 'by hand', kind: 'steward' })
    const { log } = await missionOnDisk(repo, missionId)
    expect(log).toMatch(/### \S+ · surprise\n\nplain/)
    expect(log).toMatch(/### \S+ · steward\n\nby hand/)
  })
})

describe('AC-5a.4 — event wake-ups with a coalescing gap and a 20-minute fallback', () => {
  it('a ledger row appended to the mission wakes its steward', async () => {
    const repo = await fakeRepo()
    const missionId = await newMission(repo)
    started.length = 0
    await recordLedgerEvent(repo, {}, { kind: 'dispatched', ref: CHILD, sessionId: CHILD })
    expect(started.filter((s) => s.missionId === missionId).map((s) => s.reason)).toEqual([
      'ledger'
    ])
  })

  it('clearing a blocker wakes it', async () => {
    const repo = await fakeRepo()
    const missionId = await newMission(repo)
    await ok('mission_set_blocker', {
      folder: repo,
      missionId,
      reason: 'waiting on CI',
      unblocks: 'green',
      owner: 'agent'
    })
    started.length = 0
    await ok('mission_clear_blocker', { folder: repo, missionId, reason: 'waiting on CI' })
    expect(started.map((s) => s.reason)).toContain('blocker-cleared')
  })

  it('a burst coalesces: one start now, ONE trailing start after the gap', async () => {
    const repo = await fakeRepo()
    const missionId = await newMission(repo)
    started.length = 0
    setStewardWakeGapMs(40)
    expect(await wakeStewardForMission(missionId, 'ledger')).toMatchObject({ woke: true })
    const second = await wakeStewardForMission(missionId, 'ci')
    const third = await wakeStewardForMission(missionId, 'child-idle')
    expect(second).toMatchObject({ woke: false, deferred: true })
    expect(third).toMatchObject({ woke: false, deferred: true })
    expect(started).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 150))
    expect(started).toHaveLength(2)
  })

  it('a mission with no steward has nothing to wake', async () => {
    const repo = await fakeRepo()
    const id = await newMission(repo, { steward: false })
    expect(await wakeStewardForMission(id, 'ledger')).toMatchObject({ woke: false })
    expect(started).toHaveLength(0)
  })

  it('the steward is findable by worker id for the server (and gone once deleted)', async () => {
    const repo = await fakeRepo()
    const missionId = await newMission(repo)
    const row = (await stewardRows()).find((w) => w.missionId === missionId)!
    expect(stewardForWorkerId(row.id as string)).toMatchObject({ missionId })
    await closeAs(repo, missionId)
    expect(stewardForWorkerId(row.id as string)).toBeUndefined()
  })
})

describe("AC-5a.5 — hooks go into the folder's settings.local.json and leave at close", () => {
  it("installs SessionStart(compact), PreCompact, Stop and SubagentStop, keeping the user's own settings", async () => {
    const repo = await fakeRepo()
    const userHook = { type: 'command', command: 'echo mine' }
    const seed = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { PreCompact: [{ hooks: [userHook] }] }
    }
    await fs.mkdir(path.dirname(settingsPath(repo)), { recursive: true })
    await fs.writeFile(settingsPath(repo), JSON.stringify(seed, null, 2), 'utf8')
    const missionId = await newMission(repo)

    const s = (await readSettings(repo)) as {
      permissions: unknown
      hooks: Record<string, Array<{ matcher?: string; hooks: unknown[] }>>
    }
    expect(s.permissions).toEqual(seed.permissions)
    expect(Object.keys(s.hooks).sort()).toEqual([
      'PreCompact',
      'SessionStart',
      'Stop',
      'SubagentStop'
    ])
    expect(s.hooks.PreCompact[0].hooks).toEqual([userHook])
    expect(s.hooks.SessionStart.find((e) => e.matcher === 'compact')).toBeTruthy()
    const ours = Object.values(s.hooks).flatMap((es) =>
      es.flatMap((e) => e.hooks.filter(isStewardHook))
    )
    expect(ours).toHaveLength(4)
    expect(JSON.stringify(ours)).toContain('/steward/bridge-token/')

    await closeAs(repo, missionId)
    expect(await readSettings(repo)).toEqual(seed)
  })

  it("creates the file when there is none, and removes the hooks (not the user's later edits) at close", async () => {
    const repo = await fakeRepo()
    const missionId = await newMission(repo)
    const created = await readSettings(repo)
    expect(Object.keys(created.hooks as object)).toHaveLength(4)
    // The user adds a setting while the mission runs.
    await fs.writeFile(
      settingsPath(repo),
      JSON.stringify({ ...created, env: { LATER: '1' } }, null, 2),
      'utf8'
    )
    await closeAs(repo, missionId)
    expect(await readSettings(repo)).toEqual({ env: { LATER: '1' } })
  })

  it('two stewarded missions in one folder: the hooks stay until the LAST one closes', async () => {
    const repo = await fakeRepo()
    const a = await newMission(repo)
    const b = await newMission(repo)
    await closeAs(repo, a)
    expect(Object.keys((await readSettings(repo)).hooks as object)).toHaveLength(4)
    await closeAs(repo, b)
    expect((await readSettings(repo)).hooks).toBeUndefined()
  })

  it('a settings file that is not valid JSON is left alone, and the ACK says the hooks were skipped', async () => {
    const repo = await fakeRepo()
    await fs.mkdir(path.dirname(settingsPath(repo)), { recursive: true })
    await fs.writeFile(settingsPath(repo), '{ not json', 'utf8')
    const ack = await ok('mission_create', {
      folder: repo,
      title: 'Messy settings',
      declaredEnd: END,
      sessionId: OWNER,
      steps: STEPS
    })
    expect(await fs.readFile(settingsPath(repo), 'utf8')).toBe('{ not json')
    expect(ack.steward).toMatchObject({ created: true, hooks: 'skipped' })
  })

  it('no steward → no hooks', async () => {
    const repo = await fakeRepo()
    await newMission(repo, { steward: false })
    await expect(fs.stat(settingsPath(repo))).rejects.toThrow()
  })
})
