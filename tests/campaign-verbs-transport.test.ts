/**
 * Missions v4 S-39 — the campaign verbs are gone from the wire, and the campaign files already on disk stay
 * records that nothing rewrites. Driven through the REAL MCP transport (lesson
 * `docs/lessons/testing/006-eval-harness-grades-state-through-the-real-transport.md`).
 *
 * What "real" means here: `registerMcpServer` starts Harnu's own loopback HTTP server (the one a spawned
 * `claude` is pointed at), and the calls below go through the MCP SDK's streamable-HTTP CLIENT with the
 * bearer token read from the `harnu.mcp.json` the server wrote, so the catalog schema a session really
 * receives, the bearer guard, the policy gate and the wired handler are all in the path. Only `electron`
 * and the live sources (PR join, fleet scan, hook FSM) are stubbed at their seams.
 *
 * Every proof runs on a THROWAWAY repo under the temp directory, holding a copy of the frozen v3 fixtures
 * (a campaign and its two chapter missions). State is graded from the bytes on disk (sha256 and mtime of
 * every file), never from an ACK.
 *
 * This file replaces the one that tested the six `campaign_*` verbs and `mission_create`'s chapter binding
 * (Campaign ch.3a); those verbs no longer exist.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
import { buildMissionV4View } from '../src/main/mission-ipc'

const OWNER = '11111111-2222-4333-8444-555555555555'
/** The owner of the frozen chapter missions and the campaign: the session that may read them. */
const FIXTURE_LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
/** A v4 mission body: the only shape `mission_create` takes now. */
const V4_BODY = {
  title: 'No campaign here',
  doneWhen: 'Every page is migrated and the audit is green',
  steps: [{ title: 'Migrate the pages', criteria: [{ text: 'The audit is green' }] }],
  sessionId: OWNER
}
const FIXTURES = path.join(__dirname, 'fixtures', 'missions-v4-compat')

let client: Client
let main = ''
let worktree = ''
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
  ;({ main, worktree } = await fakeRepo())
  blockedMain = (await fakeRepo()).main
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

/** A copy of the frozen v3 fixtures (a campaign and its chapter missions) under `<root>/.harnu/`. */
async function seedV3(root: string): Promise<void> {
  for (const dir of ['missions', 'campaigns']) {
    await fs.cp(path.join(FIXTURES, dir), path.join(root, '.harnu', dir), { recursive: true })
  }
}

const CAMPAIGN_ID = 'cmp-ca0001aa'
/** A chapter mission of that campaign: it names `campaignId` and `chapterId` in its own file. */
const CHAPTER_MISSION = 'mnt-ca000002'

/** The six verbs, named from parts so no catalog-entry text sits in this file. */
const REMOVED = ['create', 'add_chapter', 'get', 'list', 'request_close', 'transfer_owner'].map(
  (tail) => ['campaign', tail].join('_')
)

describe('the six campaign verbs are not on the wire', () => {
  it('lists none of them, and mission_create no longer carries the chapter binding or any v3 argument', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    for (const v of REMOVED) expect(names, v).not.toContain(v)
    expect(names.filter((n) => n.startsWith(['campaign', ''].join('_')))).toEqual([])
    const create = tools.find((t) => t.name === 'mission_create')!
    const schema = create.inputSchema as {
      properties: Record<string, unknown>
      required?: string[]
      additionalProperties?: unknown
    }
    for (const retired of [
      'campaignId',
      'chapterId',
      'declaredEnd',
      'steward',
      'scope',
      'linkedCard'
    ]) {
      expect(schema.properties, retired).not.toHaveProperty(retired)
    }
    // The schema is strict: an argument it does not name is refused, not dropped.
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required ?? []).toContain('doneWhen')
  })

  it.each(REMOVED)('%s answers a v3 agent with a refusal, and writes nothing', async (verb) => {
    await seedV3(main)
    const before = tree(main)
    const r = await call(verb, { folder: main, campaignId: CAMPAIGN_ID })
    // What the agent receives: an error result naming the tool it asked for. Nothing is created or changed.
    expect(r.isError).toBe(true)
    expect(r.text).toContain(verb)
    expect(tree(main)).toEqual(before)
  })
})

describe('mission_create no longer binds a mission to a chapter', () => {
  it.each([
    ['both ids', { campaignId: CAMPAIGN_ID, chapterId: 'chp-1' }],
    ['only the campaign', { campaignId: CAMPAIGN_ID }],
    ['only the chapter', { chapterId: 'chp-1' }],
    [
      'an older end and steward',
      { declaredEnd: { kind: 'code', target: 'x', evidence: 'y' }, steward: false }
    ]
  ])(
    'a call that names %s is refused by the strict schema, and nothing is written',
    async (_n, extra) => {
      await seedV3(main)
      const before = tree(main)
      const r = await call('mission_create', { folder: main, ...V4_BODY, ...extra })
      expect(r.isError).toBe(true)
      // The refusal names the argument it does not know.
      expect(r.text).toMatch(new RegExp(Object.keys(extra)[0]))
      // No mission file of either format, no change to the campaign file that was named.
      expect(tree(main)).toEqual(before)
      expect(existsSync(path.join(main, '.harnu', 'missions-v4'))).toBe(false)
    }
  )

  it('a v4 call still creates a mission, with no campaign field', async () => {
    const ack = await ok('mission_create', { folder: worktree, ...V4_BODY })
    expect(ack).toMatchObject({ ok: true, op: 'mission_create' })
    expect(Object.keys(ack)).not.toEqual(expect.arrayContaining(['campaignId']))
    expect(Object.keys(ack)).not.toEqual(expect.arrayContaining(['chapterId']))
    const dir = path.join(main, '.harnu', 'missions-v4')
    const file = readdirSync(dir).find((n) => n.startsWith(`${ack.id as string}-`))!
    expect(readFileSync(path.join(dir, file), 'utf8')).not.toMatch(/campaignId|chapterId/)
  })
})

describe('a campaign file already on disk stays a record, and still reads (what S-39 leaves behind)', () => {
  const FACTS = (): import('../src/main/missions/facts').FactsDeps => ({
    findPrs: async () => ({ ghAvailable: true, worktrees: {}, branches: {}, numbers: {} }),
    findMainCi: async () => ({ ghAvailable: true, byNumber: {} }),
    lastKnown: () => null,
    pathExists: async () => true,
    taskState: () => undefined
  })

  it('a mission that names a campaignId reads in the pane, in mission_get and in mission_list, and no byte changes', async () => {
    const root = (await fakeRepo()).main
    await seedV3(root)
    const before = tree(root)
    const userDataBefore = tree(h.userDataDir)

    // 1) The Mission pane: the chapter mission by its own id, and the campaign as one mission by its id.
    const chapter = await buildMissionV4View(
      { folder: root, sessionId: OWNER, missionId: CHAPTER_MISSION },
      { facts: FACTS }
    )
    expect(chapter.state).toBe('mission')
    const campaign = await buildMissionV4View(
      { folder: root, sessionId: OWNER, missionId: CAMPAIGN_ID },
      { facts: FACTS }
    )
    expect(campaign.state).toBe('mission')
    // The campaign reads as ONE mission: its chapters, in order, are the milestones (an optional chapter
    // an optional milestone, a chapter that waits on another a milestone that waits for it).
    if (campaign.state !== 'mission') throw new Error('unreachable')
    expect(campaign.detail.milestones.map((m) => [m.title, m.optional])).toEqual([
      ['Import core', false],
      ['Report', false],
      ['Migrate the pages', false],
      ['Fix the parser edge cases', true],
      ['Publish the notes', false]
    ])

    // 2) mission_get: a chapter mission reads as the campaign it belongs to (one mission, the chapters
    // its milestones), the campaign by its own id reads as the same record, and neither is rewritten.
    const got = await ok('mission_get', {
      folder: root,
      missionId: CHAPTER_MISSION,
      sessionId: FIXTURE_LEADER
    })
    expect(got).toMatchObject({ ok: true, source: 'v3-campaign' })
    const gotCampaign = await ok('mission_get', {
      folder: root,
      missionId: CAMPAIGN_ID,
      sessionId: FIXTURE_LEADER
    })
    expect(gotCampaign).toMatchObject({ ok: true, source: 'v3-campaign', id: got.id })

    // 3) mission_list is the one list: the campaign is a row of it, marked as an older record.
    const listed = await ok('mission_list', { folder: root })
    const rows = listed.missions as Array<{ id: string; format: string }>
    expect(rows.find((r) => r.id === got.id)?.format).toBe('v3')

    // Nothing was written: the campaign and the missions are byte-identical, and no v4 record appeared.
    expect(tree(root)).toEqual(before)
    expect(existsSync(path.join(root, '.harnu', 'missions-v4'))).toBe(false)
    expect(tree(h.userDataDir)).toEqual(userDataBefore)
  })

  it('a blocked repo is still refused for the verbs that remain', async () => {
    await seedV3(blockedMain)
    const r = await call('mission_get', {
      folder: blockedMain,
      missionId: CHAPTER_MISSION,
      sessionId: FIXTURE_LEADER
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/FOLDER_NOT_ALLOWED/)
  })
})
