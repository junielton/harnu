/**
 * Campaign ch.3a (T595, spec §3.3/§3.5) — the `campaign_*` verbs and `mission_create`'s
 * `campaignId`/`chapterId`, driven through the REAL MCP transport (lesson
 * `docs/lessons/testing/006-eval-harness-grades-state-through-the-real-transport.md`).
 *
 * What "real" means here: `registerMcpServer` starts Harnu's own loopback HTTP server (the
 * one a spawned `claude` is pointed at), and the calls below go through the MCP SDK's
 * streamable-HTTP CLIENT with the bearer token read from the `harnu.mcp.json` the server
 * wrote — so the catalog schema a session really receives, the bearer guard, the policy gate,
 * the audit and the wired handler are all in the path. No handler is called directly. Only
 * `electron` and the live sources (PR join, fleet scan, hook FSM) are stubbed at their seams.
 *
 * State is graded from the files on disk with js-yaml directly — never through
 * `campaign-core.ts` — so a parser drift cannot make the grader agree with the product, and
 * an ACK is evidence, never the verdict (lesson rule 1). The one place the product's own
 * core is used is the operator's end door (`applyOperatorEnd`), which no verb reaches.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import yaml from 'js-yaml'
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
import { MCP_OPS, MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import {
  applyOperatorEnd,
  buildMissionFileContent,
  parseMissionFile,
  readMissionLog,
  type Mission
} from '../src/main/mission-core'

const OWNER = '11111111-2222-4333-8444-555555555555'
const END = { kind: 'code', target: 'every page migrated', evidence: 'the audit is green' }

let client: Client
let main = ''
let worktree = ''
let blockedMain = ''
let blockedWorktree = ''

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

// ---- grading from disk (js-yaml, not the product's parser) -----------------

async function campaignFiles(root: string): Promise<string[]> {
  return (
    await fs.readdir(path.join(root, '.harnu', 'campaigns')).catch(() => [] as string[])
  ).filter((n) => n.endsWith('.md'))
}

interface OnDisk {
  file: string
  raw: string
  front: Record<string, unknown> & {
    status: string
    chapters: Array<Record<string, unknown>>
    pendingClose?: unknown
  }
  log: string
}

async function readCampaign(root: string, id: string): Promise<OnDisk> {
  const name = (await campaignFiles(root)).find((n) => n.startsWith(`${id}-`))
  if (!name) throw new Error(`no file for ${id}`)
  const file = path.join(root, '.harnu', 'campaigns', name)
  const raw = await fs.readFile(file, 'utf8')
  const parts = raw.split(/^---\n/m)
  return {
    file,
    raw,
    front: yaml.load(parts[1], { schema: yaml.CORE_SCHEMA }) as OnDisk['front'],
    log: parts.slice(2).join('---\n')
  }
}

async function missionFile(root: string, id: string): Promise<string> {
  const dir = path.join(root, '.harnu', 'missions')
  return path.join(
    dir,
    (await fs.readdir(dir)).find((n) => n.startsWith(`${id}-`))!
  )
}

/** The operator ends a mission as delivered — a UI door no verb reaches (product core). */
async function operatorClosesMission(root: string, id: string): Promise<void> {
  const file = await missionFile(root, id)
  const raw = await fs.readFile(file, 'utf8')
  const m = parseMissionFile(raw) as Mission
  const ended = applyOperatorEnd(m, { at: new Date().toISOString(), closedAs: 'delivered' })
  await fs.writeFile(file, buildMissionFileContent(ended, readMissionLog(raw)), 'utf8')
}

const chapters = (ack: Record<string, unknown>): Array<Record<string, unknown>> =>
  ack.chapters as Array<Record<string, unknown>>

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-campaign-ud-'))
  ;({ main, worktree } = await fakeRepo())
  ;({ main: blockedMain, worktree: blockedWorktree } = await fakeRepo())
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

describe('AC-3a.2 — the verbs exist on the wire, with the shapes of spec §3.3', () => {
  it('lists exactly the five campaign verbs, and mission_create carries campaignId + chapterId', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    for (const op of [
      'campaign_create',
      'campaign_add_chapter',
      'campaign_get',
      'campaign_list',
      'campaign_request_close'
    ]) {
      expect(names).toContain(op)
    }
    expect(names.filter((n) => n.startsWith('campaign_')).sort()).toEqual([
      'campaign_add_chapter',
      'campaign_create',
      'campaign_get',
      'campaign_list',
      'campaign_request_close'
    ])
    const mc = tools.find((t) => t.name === 'mission_create')!
    expect(Object.keys((mc.inputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['campaignId', 'chapterId'])
    )
    const cc = tools.find((t) => t.name === 'campaign_create')!
    const props = (
      cc.inputSchema as { properties: Record<string, { items?: { properties?: object } }> }
    ).properties
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['folder', 'title', 'declaredEnd', 'sessionId', 'chapters', 'scope'])
    )
    expect(Object.keys(props.chapters.items!.properties!)).toEqual(
      expect.arrayContaining(['title', 'required', 'consumes', 'produces', 'radiant'])
    )
  })

  it('has no verb that merges, chooses a decision, ticks a check or closes (spec §3.3 / §4)', () => {
    const campaignOps = MCP_OPS.filter((o) => o.startsWith('campaign_'))
    expect([...campaignOps].sort()).toEqual([
      'campaign_add_chapter',
      'campaign_create',
      'campaign_get',
      'campaign_list',
      'campaign_request_close'
    ])
    const FORBIDDEN_FIELDS = [
      'closedAs',
      'closeReason',
      'status',
      'chosen',
      'ticked',
      'merge',
      'missionId'
    ]
    for (const tool of MCP_TOOLS.filter((t) => t.op.startsWith('campaign_'))) {
      const shape = (tool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {}
      for (const f of FORBIDDEN_FIELDS)
        expect(Object.keys(shape), `${tool.op}.${f}`).not.toContain(f)
    }
    expect(MCP_OPS.filter((o) => /merge|choose|tick|end_campaign|close_campaign/.test(o))).toEqual(
      []
    )
  })
})

describe('AC-3a.1/3a.2 — campaign_create writes the record in the MAIN checkout', () => {
  it('called from a linked worktree, it lands in <main>/.harnu/campaigns/<id>-<slug>.md', async () => {
    const ack = await ok('campaign_create', {
      folder: worktree,
      title: 'Content migration',
      declaredEnd: END,
      sessionId: OWNER,
      scope: ['docs/spec.md'],
      chapters: [
        { title: 'Images on the CDN', produces: ['images-on-cdn'] },
        {
          title: 'Migrate pages',
          consumes: ['images-on-cdn'],
          radiant: { template: 'migrate page {slug}', total: 88 }
        },
        { title: 'Spare detour', required: false }
      ]
    })
    expect(ack).toMatchObject({ ok: true, op: 'campaign_create', slug: 'content-migration' })
    expect(ack.campaignId).toMatch(/^cmp-[0-9a-f]{8}$/)
    expect(chapters(ack).map((c) => [c.id, c.ordinal, c.title, c.required])).toEqual([
      ['chp-1', 1, 'Images on the CDN', true],
      ['chp-2', 2, 'Migrate pages', true],
      ['chp-3', 3, 'Spare detour', false]
    ])

    // Graded from disk, not from the ACK.
    expect(await campaignFiles(worktree)).toEqual([]) // nothing under the worktree
    const disk = await readCampaign(main, ack.campaignId as string)
    expect(disk.file).toBe(
      path.join(main, '.harnu', 'campaigns', `${ack.campaignId as string}-content-migration.md`)
    )
    expect(disk.front).toMatchObject({
      id: ack.campaignId,
      slug: 'content-migration',
      folder: main,
      title: 'Content migration',
      status: 'active',
      declaredEnd: END,
      owner: { sessionId: OWNER },
      scope: [{ kind: 'worktree', ref: 'docs/spec.md' }]
    })
    expect(disk.front.chapters).toMatchObject([
      { id: 'chp-1', ordinal: 1, required: true, produces: ['images-on-cdn'] },
      {
        id: 'chp-2',
        ordinal: 2,
        required: true,
        consumes: ['images-on-cdn'],
        radiant: { total: 88 }
      },
      { id: 'chp-3', ordinal: 3, required: false }
    ])
    expect(disk.front.chapters[0]).not.toHaveProperty('missionId')
    expect(disk.log).toContain('# Content migration')
  })

  it('a second campaign with the same title gets a unique slug', async () => {
    const ack = await ok('campaign_create', {
      folder: main,
      title: 'Content migration',
      declaredEnd: END,
      sessionId: OWNER,
      chapters: [{ title: 'Only chapter' }]
    })
    expect(ack.slug).toBe('content-migration-2')
  })

  it('refuses an incomplete declared end (the wire schema names the blank field) and a non-UUID owner (BAD_SESSION_ID), writing nothing', async () => {
    const before = await campaignFiles(main)
    const noEvidence = await call('campaign_create', {
      folder: main,
      title: 'X',
      declaredEnd: { kind: 'code', target: 't', evidence: '  ' },
      sessionId: OWNER,
      chapters: [{ title: 'c' }]
    })
    // On the wire the catalog schema (trim + min 1) refuses a blank evidence before the
    // handler runs — the same as mission_create. DECLARED_END_INCOMPLETE is the handler's
    // second line of defence for a caller that bypasses the schema.
    expect(noEvidence.isError).toBe(true)
    expect(noEvidence.text).toMatch(/evidence/)
    const badOwner = await call('campaign_create', {
      folder: main,
      title: 'X',
      declaredEnd: END,
      sessionId: 'synthetic-123',
      chapters: [{ title: 'c' }]
    })
    expect(badOwner.text).toMatch(/^BAD_SESSION_ID/)
    expect(await campaignFiles(main)).toEqual(before)
  })
})

describe('AC-3a.4 — the prerequisite pass (spec §3.5)', () => {
  it('campaign_create refuses PREREQ_MISSING naming the token, and writes nothing', async () => {
    const before = await campaignFiles(main)
    const r = await call('campaign_create', {
      folder: main,
      title: 'Wrong order',
      declaredEnd: END,
      sessionId: OWNER,
      chapters: [
        { title: 'Migrate pages', consumes: ['images-on-cdn'] },
        { title: 'Upload images', produces: ['images-on-cdn'] }
      ]
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^PREREQ_MISSING/)
    expect(r.text).toContain('images-on-cdn')
    expect(r.text).toContain('Migrate pages')
    expect(await campaignFiles(main)).toEqual(before)
  })

  it('force: true accepts it, and logs a surprise naming the token', async () => {
    const ack = await ok('campaign_create', {
      folder: main,
      title: 'Forced order',
      declaredEnd: END,
      sessionId: OWNER,
      force: true,
      chapters: [
        { title: 'Migrate pages', consumes: ['images-on-cdn'] },
        { title: 'Upload images', produces: ['images-on-cdn'] }
      ]
    })
    const disk = await readCampaign(main, ack.campaignId as string)
    expect(disk.front.chapters).toHaveLength(2)
    expect(disk.log).toMatch(/surprise/)
    expect(disk.log).toContain('images-on-cdn')
    expect(disk.log).toContain('Migrate pages')
  })

  describe('campaign_add_chapter', () => {
    let id = ''
    it('appends a chapter whose prerequisites are produced earlier', async () => {
      const created = await ok('campaign_create', {
        folder: main,
        title: 'Add chapters',
        declaredEnd: END,
        sessionId: OWNER,
        chapters: [{ title: 'Producer', produces: ['templates'] }]
      })
      id = created.campaignId as string
      const ack = await ok('campaign_add_chapter', {
        folder: worktree,
        campaignId: id,
        title: 'Consumer',
        consumes: ['templates']
      })
      expect(ack).toMatchObject({
        ok: true,
        op: 'campaign_add_chapter',
        campaignId: id,
        chapterId: 'chp-2',
        totalChapters: 2
      })
      const disk = await readCampaign(main, id)
      expect(disk.front.chapters).toMatchObject([
        { id: 'chp-1', ordinal: 1 },
        { id: 'chp-2', ordinal: 2, title: 'Consumer', required: true, consumes: ['templates'] }
      ])
    })

    it('refuses PREREQ_MISSING naming the token and leaves the file byte-identical', async () => {
      const before = (await readCampaign(main, id)).raw
      const r = await call('campaign_add_chapter', {
        folder: main,
        campaignId: id,
        title: 'Needs aws',
        consumes: ['aws-credentials']
      })
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/^PREREQ_MISSING/)
      expect(r.text).toContain('aws-credentials')
      expect((await readCampaign(main, id)).raw).toBe(before)
    })

    it('force: true adds it and logs a surprise', async () => {
      const ack = await ok('campaign_add_chapter', {
        folder: main,
        campaignId: id,
        title: 'Needs aws',
        consumes: ['aws-credentials'],
        force: true
      })
      expect(ack.chapterId).toBe('chp-3')
      const disk = await readCampaign(main, id)
      expect(disk.front.chapters).toHaveLength(3)
      expect(disk.log).toMatch(/surprise/)
      expect(disk.log).toContain('aws-credentials')
    })

    it('records a side quest with its origin; an unknown origin is CHAPTER_NOT_FOUND', async () => {
      const ack = await ok('campaign_add_chapter', {
        folder: main,
        campaignId: id,
        title: 'Detour',
        required: false,
        discoveredFrom: { chapterId: 'chp-1', stepId: 'stp-2' }
      })
      const disk = await readCampaign(main, id)
      expect(disk.front.chapters[(ack.totalChapters as number) - 1]).toMatchObject({
        required: false,
        discoveredFrom: { chapterId: 'chp-1', stepId: 'stp-2' }
      })
      const bad = await call('campaign_add_chapter', {
        folder: main,
        campaignId: id,
        title: 'Orphan',
        required: false,
        discoveredFrom: { chapterId: 'chp-99' }
      })
      expect(bad.text).toMatch(/^CHAPTER_NOT_FOUND/)
    })

    it('an unknown campaign is CAMPAIGN_NOT_FOUND', async () => {
      const r = await call('campaign_add_chapter', {
        folder: main,
        campaignId: 'cmp-ffffffff',
        title: 'Nowhere'
      })
      expect(r.text).toMatch(/^CAMPAIGN_NOT_FOUND/)
    })
  })
})

describe('AC-3a.2 — mission_create binds the chapter', () => {
  let id = ''
  let mission1 = ''

  it('with campaignId + chapterId, the mission records them and the chapter records the mission', async () => {
    id = (
      await ok('campaign_create', {
        folder: main,
        title: 'Binding',
        declaredEnd: END,
        sessionId: OWNER,
        chapters: [{ title: 'First' }, { title: 'Second' }]
      })
    ).campaignId as string
    const ack = await ok('mission_create', {
      folder: worktree,
      title: 'Chapter one mission',
      declaredEnd: END,
      sessionId: OWNER,
      steps: [{ title: 'Build', verification: 'verifier' }],
      campaignId: id,
      chapterId: 'chp-1'
    })
    mission1 = ack.missionId as string
    expect(ack).toMatchObject({ ok: true, campaignId: id, chapterId: 'chp-1' })

    const disk = await readCampaign(main, id)
    expect(disk.front.chapters[0]).toMatchObject({ id: 'chp-1', missionId: mission1 })
    expect(disk.front.chapters[1]).not.toHaveProperty('missionId')
    const mraw = await fs.readFile(await missionFile(main, mission1), 'utf8')
    const front = yaml.load(mraw.split(/^---\n/m)[1], { schema: yaml.CORE_SCHEMA }) as Record<
      string,
      unknown
    >
    expect(front).toMatchObject({ campaignId: id, chapterId: 'chp-1' })
  })

  it('a chapter takes one mission: a second is CHAPTER_ALREADY_BOUND and no mission file is written', async () => {
    const dir = path.join(main, '.harnu', 'missions')
    const before = (await fs.readdir(dir)).length
    const r = await call('mission_create', {
      folder: main,
      title: 'Another',
      declaredEnd: END,
      sessionId: OWNER,
      campaignId: id,
      chapterId: 'chp-1'
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^CHAPTER_ALREADY_BOUND/)
    expect(r.text).toContain(mission1)
    expect((await fs.readdir(dir)).length).toBe(before)
  })

  it('refuses one of the two ids alone (BAD_ARGS), an unknown campaign or chapter, writing no mission', async () => {
    const dir = path.join(main, '.harnu', 'missions')
    const before = (await fs.readdir(dir)).length
    const base = { folder: main, title: 'X', declaredEnd: END, sessionId: OWNER }
    expect((await call('mission_create', { ...base, campaignId: id })).text).toMatch(/^BAD_ARGS/)
    expect((await call('mission_create', { ...base, chapterId: 'chp-2' })).text).toMatch(
      /^BAD_ARGS/
    )
    expect(
      (await call('mission_create', { ...base, campaignId: 'cmp-ffffffff', chapterId: 'chp-1' }))
        .text
    ).toMatch(/^CAMPAIGN_NOT_FOUND/)
    expect(
      (await call('mission_create', { ...base, campaignId: id, chapterId: 'chp-9' })).text
    ).toMatch(/^CHAPTER_NOT_FOUND/)
    expect((await fs.readdir(dir)).length).toBe(before)
  })

  it('a mission created without them is unchanged: no campaign fields on disk', async () => {
    const ack = await ok('mission_create', {
      folder: main,
      title: 'Plain mission',
      declaredEnd: END,
      sessionId: OWNER
    })
    expect(ack).not.toHaveProperty('campaignId')
    const mraw = await fs.readFile(await missionFile(main, ack.missionId as string), 'utf8')
    expect(mraw).not.toContain('campaignId')
    expect(mraw).not.toContain('chapterId')
  })
})

describe('AC-3a.3 — campaign_get / campaign_list: progress counts chapters, rolled up from the missions', () => {
  let id = ''
  let m1 = ''

  it('a fresh campaign: nothing done, the dependent chapter is locked, the headline is on chapter 1', async () => {
    id = (
      await ok('campaign_create', {
        folder: main,
        title: 'Rollup',
        declaredEnd: END,
        sessionId: OWNER,
        chapters: [
          { title: 'Producer', produces: ['t'] },
          { title: 'Consumer', consumes: ['t'] },
          { title: 'Side', required: false }
        ]
      })
    ).campaignId as string
    const got = await ok('campaign_get', { folder: worktree, campaignId: id })
    expect(got).toMatchObject({ ok: true, op: 'campaign_get', title: 'Rollup' })
    const progress = (got.derived as { progress: Record<string, unknown> }).progress
    expect(progress).toMatchObject({
      total: 2,
      current: { from: 1, to: 1 },
      allDone: false,
      done: 0,
      inReview: 0,
      running: 0,
      locked: 1,
      side: { total: 1, done: 0, open: 1 }
    })
    expect(progress.states).toEqual({ 'chp-1': 'todo', 'chp-2': 'locked', 'chp-3': 'todo' })
    expect((got.campaign as { chapters: unknown[] }).chapters).toHaveLength(3)
    expect(got.closeReadiness).toMatchObject({ code: 'CHAPTERS_OPEN' })
  })

  it('addresses a campaign by ownerSessionId too, and refuses neither/both', async () => {
    const byOwner = await ok('campaign_get', { folder: main, ownerSessionId: OWNER })
    expect((byOwner.campaign as { owner: { sessionId: string } }).owner.sessionId).toBe(OWNER)
    expect((await call('campaign_get', { folder: main })).isError).toBe(true)
    expect(
      (await call('campaign_get', { folder: main, campaignId: id, ownerSessionId: OWNER })).isError
    ).toBe(true)
    expect((await call('campaign_get', { folder: main, campaignId: 'cmp-ffffffff' })).text).toMatch(
      /^CAMPAIGN_NOT_FOUND/
    )
  })

  it('a chapter whose mission the operator closed as delivered reads done — no second door', async () => {
    m1 = (
      await ok('mission_create', {
        folder: main,
        title: 'Producer mission',
        declaredEnd: END,
        sessionId: OWNER,
        steps: [{ title: 'Build', verification: 'verifier' }],
        campaignId: id,
        chapterId: 'chp-1'
      })
    ).missionId as string
    const mid = (await ok('campaign_get', { folder: main, campaignId: id })).derived as {
      progress: { states: Record<string, string>; done: number }
    }
    expect(mid.progress.states['chp-1']).toBe('todo')

    await operatorClosesMission(main, m1)
    const got = await ok('campaign_get', { folder: main, campaignId: id })
    const progress = (got.derived as { progress: Record<string, unknown> }).progress
    expect(progress).toMatchObject({ done: 1, locked: 0, current: { from: 2, to: 2 } })
    expect(progress.states).toEqual({ 'chp-1': 'done', 'chp-2': 'todo', 'chp-3': 'todo' })
    const row = (got.derived as { chapters: Array<Record<string, unknown>> }).chapters[0]
    expect(row).toMatchObject({ chapterId: 'chp-1', state: 'done', missionId: m1 })
  })

  it('campaign_list returns one row per campaign with id, slug, title, status, owner and progress', async () => {
    const list = await ok('campaign_list', { folder: worktree })
    const rows = list.campaigns as Array<Record<string, unknown>>
    const row = rows.find((r) => r.id === id)!
    expect(row).toMatchObject({
      slug: 'rollup',
      title: 'Rollup',
      status: 'active',
      folder: main,
      ownerSessionId: OWNER
    })
    expect(row.progress).toMatchObject({ total: 2 })
    expect(rows.length).toBeGreaterThanOrEqual(5)
    // Without a folder it lists every repo Harnu knows, minus blocked ones — it never errors.
    expect((await call('campaign_list', {})).isError).toBe(false)
  })
})

describe('AC-3a.2 — campaign_request_close signals; it never closes', () => {
  let id = ''

  it('is refused CHAPTERS_OPEN while a required chapter is not done, writing nothing', async () => {
    id = (
      await ok('campaign_create', {
        folder: main,
        title: 'Closing',
        declaredEnd: END,
        sessionId: OWNER,
        chapters: [{ title: 'Only' }, { title: 'Side', required: false }]
      })
    ).campaignId as string
    const before = (await readCampaign(main, id)).raw
    const r = await call('campaign_request_close', { folder: main, campaignId: id })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^CHAPTERS_OPEN/)
    expect(r.text).toContain('chp-1')
    expect((await readCampaign(main, id)).raw).toBe(before)
  })

  it('once every required chapter is done: status → delivered + pendingClose, never closed', async () => {
    const mission = (
      await ok('mission_create', {
        folder: main,
        title: 'Only chapter mission',
        declaredEnd: END,
        sessionId: OWNER,
        campaignId: id,
        chapterId: 'chp-1'
      })
    ).missionId as string
    await operatorClosesMission(main, mission)
    const ack = await ok('campaign_request_close', {
      folder: worktree,
      campaignId: id,
      sessionId: OWNER
    })
    expect(ack).toMatchObject({ ok: true, op: 'campaign_request_close', pendingClose: true })
    const disk = await readCampaign(main, id)
    expect(disk.front.status).toBe('delivered')
    expect(disk.front.pendingClose).toMatchObject({ requestedBy: OWNER })
    expect(disk.front).not.toHaveProperty('closedAs')
    expect(disk.front.status).not.toBe('closed')
  })

  it('a closed campaign (the operator ended it) refuses every write verb CAMPAIGN_CLOSED', async () => {
    const disk = await readCampaign(main, id)
    await fs.writeFile(
      disk.file,
      disk.raw.replace('status: delivered', 'status: closed\nclosedAs: delivered'),
      'utf8'
    )
    const frozen = (await readCampaign(main, id)).raw
    for (const [name, args] of [
      ['campaign_add_chapter', { campaignId: id, title: 'Late' }],
      ['campaign_request_close', { campaignId: id }],
      [
        'mission_create',
        { title: 'Late', declaredEnd: END, sessionId: OWNER, campaignId: id, chapterId: 'chp-2' }
      ]
    ] as const) {
      const r = await call(name, { folder: main, ...args })
      expect(r.isError, name).toBe(true)
      expect(r.text, name).toMatch(/^CAMPAIGN_CLOSED/)
    }
    expect((await readCampaign(main, id)).raw).toBe(frozen)
    // Reads still work on a record.
    expect((await call('campaign_get', { folder: main, campaignId: id })).isError).toBe(false)
  })
})

describe('AC-3a.2 — a blocked repo refuses every campaign verb, from any worktree', () => {
  it.each([
    [
      'campaign_create',
      { title: 'X', declaredEnd: END, sessionId: OWNER, chapters: [{ title: 'c' }] }
    ],
    ['campaign_add_chapter', { campaignId: 'cmp-0a0a0a0a', title: 'c' }],
    ['campaign_get', { campaignId: 'cmp-0a0a0a0a' }],
    ['campaign_list', {}],
    ['campaign_request_close', { campaignId: 'cmp-0a0a0a0a' }],
    [
      'mission_create',
      {
        title: 'X',
        declaredEnd: END,
        sessionId: OWNER,
        campaignId: 'cmp-0a0a0a0a',
        chapterId: 'chp-1'
      }
    ]
  ] as const)('%s: FOLDER_NOT_ALLOWED, nothing written', async (name, args) => {
    const r = await call(name, { folder: blockedWorktree, ...args })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/FOLDER_NOT_ALLOWED/)
    expect(await campaignFiles(blockedMain)).toEqual([])
    expect(await fs.readdir(path.join(blockedMain, '.harnu')).catch(() => [])).not.toContain(
      'campaigns'
    )
  })
})
