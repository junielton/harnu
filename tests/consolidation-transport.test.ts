/**
 * Campaign ch.6 (T598, spec §3.6) — recall at create (AC-6.3) and a superseded decision shown with its
 * successor (AC-6.2), driven through the REAL MCP transport (lesson
 * `docs/lessons/testing/006-eval-harness-grades-state-through-the-real-transport.md`).
 *
 * Missions v4 S-40 dropped the close-out half of this file (AC-6.1: `mission_request_close` running the
 * consolidator and storing an outcome and memory drafts on a v3 record): that pass lived in the v3
 * handler, which is gone, and the v4 `mission_request_close` records a request and nothing else. The
 * consolidator itself (`consolidator-core.ts`) is still pinned by `consolidator-core.test.ts`.
 *
 * What "real" means here: `registerMcpServer` starts Harnu's own loopback HTTP server (the one a spawned
 * `claude` is pointed at), and the calls below go through the MCP SDK's streamable-HTTP CLIENT with the
 * bearer token read from the `harnu.mcp.json` the server wrote, so the catalog schema a session really
 * receives, the bearer guard, the policy gate, the audit and the wired handler are all in the path. No
 * handler is called directly. Only `electron` and the live sources (PR join, fleet scan, hook FSM) are
 * stubbed at their seams.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const h = vi.hoisted(() => ({
  userDataDir: '',
  denied: [] as string[]
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
const OWNER = '11111111-2222-4333-8444-555555555555'
// A session leads one mission at a time (a second create answers the first), so each case that
// creates a mission has its own leader.
const OWNER_2 = '22222222-2222-4333-8444-555555555555'
const OWNER_3 = '33333333-2222-4333-8444-555555555555'
const DONE_WHEN = 'Every page is migrated and the audit is green'
/** A step with one criterion: `mission_create` needs at least one. */
const STEP = (title: string): { title: string; criteria: Array<{ text: string }> } => ({
  title,
  criteria: [{ text: 'The audit is green for the page' }]
})

let client: Client
let main = ''
let blockedMain = ''

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

const ok = async (
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> => {
  const r = await call(name, args)
  expect(r.isError, r.text).toBe(false)
  return r.body
}

/** A main checkout (`.git` dir) and a linked worktree OUTSIDE its tree (`.git` file → commondir). */
async function fakeRepo(): Promise<{ main: string; worktree: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-campaign-repo-'))
  const repo = path.join(base, 'main')
  const wtGitDir = path.join(repo, '.git', 'worktrees', 'wt')
  await fs.mkdir(wtGitDir, { recursive: true })
  await fs.writeFile(path.join(wtGitDir, 'commondir'), '../..\n', 'utf8')
  const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-campaign-wt-')), 'wt')
  await fs.mkdir(wt)
  await fs.writeFile(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`, 'utf8')
  return { main: repo, worktree: wt }
}

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-campaign-ud-'))
  ;({ main } = await fakeRepo())
  ;({ main: blockedMain } = await fakeRepo())
  h.denied = [blockedMain]
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
  client = new Client({ name: 'campaign-transport-test', version: '0.0.0' })
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

describe('AC-6.3 — recall at create', () => {
  it('mission_create lists the decisions whose watches overlap its scope — and not the others', async () => {
    await ok('memory_append', {
      folder: main,
      page: 'decisions',
      entry:
        '## Gates govern verified\nA step reads verified only when every applicable gate is green.',
      watches: ['src/main/missions/derive.ts']
    })
    await ok('memory_append', {
      folder: main,
      page: 'decisions',
      entry: '## Unrelated renderer choice',
      watches: ['src/renderer/']
    })
    // (`main`, not the linked worktree: the fake repo has no real git, so memory is folder-local.)
    const ack = await ok('mission_create', {
      folder: main,
      title: 'Touch the gates',
      doneWhen: DONE_WHEN,
      sessionId: OWNER,
      steps: [STEP('Read the gates')],
      // The paths a mission is about are its doc and worktree links.
      links: [{ kind: 'doc', ref: 'src/main/missions/derive.ts' }]
    })
    expect(ack.recall).toEqual([
      { page: 'decisions', line: expect.any(Number), text: 'Gates govern verified' }
    ])
    // the line points at the entry in the real file
    const text = await fs.readFile(path.join(main, '.harnu', 'memory', 'decisions.md'), 'utf8')
    const hit = (ack.recall as Array<{ line: number }>)[0]
    expect(text.split('\n')[hit.line - 1]).toBe('## Gates govern verified')
  })

  it('a mission with no overlapping scope gets an empty recall, not an error', async () => {
    const ack = await ok('mission_create', {
      folder: main,
      title: 'Nothing to recall',
      doneWhen: DONE_WHEN,
      sessionId: OWNER_2,
      steps: [STEP('Write it down')],
      links: [{ kind: 'doc', ref: 'docs/elsewhere.md' }]
    })
    expect(ack.recall).toEqual([])
  })

  it('a superseded decision is not recalled; its successor is', async () => {
    const old = await ok('memory_append', {
      folder: main,
      page: 'decisions',
      entry: '## Poll the steward every minute',
      watches: ['src/main/scheduler-core.ts']
    })
    const next = await ok('memory_append', {
      folder: main,
      page: 'decisions',
      entry: '## Wake the steward on events',
      watches: ['src/main/scheduler-core.ts'],
      supersedes: old.entryId
    })
    expect(next.entryId).toMatch(/^e-[0-9a-f]{8}$/)
    const ack = await ok('mission_create', {
      folder: main,
      title: 'Scheduler work',
      doneWhen: DONE_WHEN,
      sessionId: OWNER_3,
      steps: [STEP('Tune the tick')],
      links: [{ kind: 'doc', ref: 'src/main/scheduler-core.ts' }]
    })
    expect((ack.recall as Array<{ text: string }>).map((r) => r.text)).toEqual([
      'Wake the steward on events'
    ])
  })
})

describe('AC-6.2 — memory_query shows a superseded decision with its successor (on the wire)', () => {
  it('names the successor next to the stale line', async () => {
    const r = await ok('memory_query', { folder: main, query: 'Poll the steward every minute' })
    const matches = r.matches as Array<{ supersededBy?: { text: string } }>
    expect(matches).toHaveLength(1)
    expect(matches[0].supersededBy?.text).toBe('Wake the steward on events')
  })
})
