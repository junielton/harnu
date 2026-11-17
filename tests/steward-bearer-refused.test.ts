/**
 * Missions v4 S-38 / S-40 — a bearer shaped like the retired steward's is refused at the door.
 * (This file was `owner-transfer-transport.test.ts`; `mission_transfer_owner` left with S-40, and this
 * is the one proof of that file that is about something that still exists.)
 *
 * Driven through the REAL MCP transport (lesson
 * `docs/lessons/testing/006-eval-harness-grades-state-through-the-real-transport.md`): Harnu's own
 * loopback HTTP server and the MCP SDK client with the bearer from `harnu.mcp.json`. State is graded
 * from the file on disk, never from an ACK. Only `electron` and the live sources (PR join, fleet scan,
 * hook FSM) are stubbed at their seams.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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
  getHookBridgeEndpoint: () => ({ port: 4711, token: 'bridge-token' })
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
import { registerScheduler, stopSchedulerTicker } from '../src/main/scheduler-shell'

const LEADER = '11111111-2222-4333-8444-555555555555'

let client: Client
let serverUrl = ''
let serverToken = ''
let main = ''

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

async function connectAs(bearer: string): Promise<Client> {
  const c = new Client({ name: 'steward-bearer-test', version: '0.0.0' })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(serverUrl), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } }
    })
  )
  return c
}

/** A main checkout: a `.git` directory is all the folder gate looks for. */
async function fakeRepo(): Promise<string> {
  const repo = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-stw-repo-')), 'main')
  await fs.mkdir(path.join(repo, '.git'), { recursive: true })
  return repo
}

/** The `.harnu/missions-v4` record file of a mission, as raw text. */
async function readRecordText(root: string, id: string): Promise<string> {
  const dir = path.join(root, '.harnu', 'missions-v4')
  const name = (await fs.readdir(dir)).find((n) => n.startsWith(`${id}-`))
  if (!name) throw new Error(`no file for ${id}`)
  return fs.readFile(path.join(dir, name), 'utf8')
}

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-stw-ud-'))
  main = await fakeRepo()
  h.denied = []
  registerScheduler(() => null, { dispatch: async () => ({}) } as never)
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
})

describe("a bearer shaped like the retired steward's is refused at the door", () => {
  it('the control server no longer recognises it, and the mission on disk does not move', async () => {
    const created = await call('mission_create', {
      folder: main,
      title: 'Migrate every page',
      doneWhen: 'Every page is migrated and the audit is green',
      sessionId: LEADER,
      steps: [
        {
          title: 'Build the importer',
          criteria: [{ text: 'Another session checked the importer' }]
        }
      ]
    })
    expect(created.isError, created.text).toBe(false)
    const missionId = created.body.id as string
    const before = await readRecordText(main, missionId)

    // Missions v4 S-38: a steward's bearer (`stw_<workerId>_<mac>`) is no longer minted or checked.
    // One shaped like it is just a wrong credential: the server turns it away before any verb runs.
    const retiredShape = `${['stw', 'w-1'].join('_')}_${'0'.repeat(64)}`
    await expect(connectAs(retiredShape)).rejects.toThrow()

    // The control: the real bearer is let in and reads the mission, so the refusal above is the
    // bearer's doing, not a dead server.
    const read = await call('mission_get', { folder: main, missionId, sessionId: LEADER })
    expect(read.isError, read.text).toBe(false)
    expect(await readRecordText(main, missionId)).toBe(before)
  })
})
