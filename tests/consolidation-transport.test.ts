/**
 * Campaign ch.6 (T598, spec §3.6) — close-out consolidation (AC-6.1) and recall at create (AC-6.3),
 * driven through the REAL MCP transport (lesson
 * `docs/lessons/testing/006-eval-harness-grades-state-through-the-real-transport.md`). The harness
 * is the one `campaign-verbs-transport.test.ts` uses; state is graded from the files on disk.
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

const STEP = (title: string) => ({ title, verification: 'existence' })

/** Make a freshly created mission closable: every custom step and the fixed end verified, plus a Log and ledger. */
async function arm(
  root: string,
  id: string,
  opts: { log?: string; ledger?: Array<Record<string, unknown>>; selfVerifyStep2?: boolean } = {}
): Promise<void> {
  const file = await missionFile(root, id)
  const raw = await fs.readFile(file, 'utf8')
  const m = parseMissionFile(raw) as Mission
  for (const s of m.steps) {
    s.proof = s.id === 'stp-2' && opts.selfVerifyStep2 ? 'self-verified' : 'verified'
    if (s.kind === 'fixed-end') {
      s.verifiedBy = {
        sessionId: 'aaaaaaaa-2222-4333-8444-555555555555',
        at: '2026-11-01T12:00:00.000Z',
        verdict: 'met'
      }
    }
  }
  m.ledger = (opts.ledger ?? []) as Mission['ledger']
  await fs.writeFile(
    file,
    buildMissionFileContent(m, readMissionLog(raw) + (opts.log ?? '')),
    'utf8'
  )
}

type Front = Record<string, unknown> & {
  status: string
  outcome: Record<string, unknown>
  memoryDrafts?: Array<{ kind: string; cites: Array<{ kind: string; ref: string }> }>
}
interface MissionDisk {
  front: Front
  log: string
}
async function readMission(root: string, id: string): Promise<MissionDisk> {
  const raw = await fs.readFile(await missionFile(root, id), 'utf8')
  const parts = raw.split(/^---\n/m)
  return {
    front: yaml.load(parts[1], { schema: yaml.CORE_SCHEMA }) as Front,
    log: parts.slice(2).join('---\n')
  }
}

describe('AC-6.3 — recall at create', () => {
  it('mission_create lists the decisions whose watches overlap its scope — and not the others', async () => {
    await ok('memory_append', {
      folder: main,
      page: 'decisions',
      entry:
        '## Gates govern verified\nA step reads verified only when every applicable gate is green.',
      watches: ['src/main/mission-gates.ts']
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
      declaredEnd: END,
      sessionId: OWNER,
      scope: ['src/main/mission-gates.ts'],
      steward: false
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
      declaredEnd: END,
      sessionId: OWNER,
      scope: ['docs/elsewhere.md'],
      steward: false
    })
    expect(ack.recall).toEqual([])
  })

  it('campaign_create matches watched topics against the chapter titles', async () => {
    await ok('memory_append', {
      folder: main,
      page: 'decisions',
      entry: '## CDN uploads are idempotent',
      watches: ['cdn']
    })
    const ack = await ok('campaign_create', {
      folder: main,
      title: 'Migration',
      declaredEnd: END,
      sessionId: OWNER,
      chapters: [{ title: 'Images on the CDN' }, { title: 'Migrate pages' }]
    })
    expect((ack.recall as Array<{ text: string }>).map((r) => r.text)).toEqual([
      'CDN uploads are idempotent'
    ])
  })

  it('a superseded decision is not recalled; its successor is', async () => {
    const old = await ok('memory_append', {
      folder: main,
      page: 'decisions',
      entry: '## Poll the steward every minute',
      watches: ['src/main/steward-core.ts']
    })
    const next = await ok('memory_append', {
      folder: main,
      page: 'decisions',
      entry: '## Wake the steward on events',
      watches: ['src/main/steward-core.ts'],
      supersedes: old.entryId
    })
    expect(next.entryId).toMatch(/^e-[0-9a-f]{8}$/)
    const ack = await ok('mission_create', {
      folder: main,
      title: 'Steward work',
      declaredEnd: END,
      sessionId: OWNER,
      scope: ['src/main/steward-core.ts'],
      steward: false
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

describe('AC-6.1 — mission_request_close runs the consolidator', () => {
  it('stores the outcome and the drafts on the mission, citing steps and PRs, and writes NO memory', async () => {
    const created = await ok('mission_create', {
      folder: main,
      title: 'Close-out fixture',
      declaredEnd: END,
      sessionId: OWNER,
      scope: ['src/main/close-fixture.ts'],
      steps: [STEP('Entry schema'), STEP('Brief budget')],
      steward: false
    })
    const id = created.missionId as string
    const decisionsBefore = await fs
      .readFile(path.join(main, '.harnu', 'memory', 'decisions.md'), 'utf8')
      .catch(() => '')
    await arm(main, id, {
      selfVerifyStep2: true,
      log:
        '\n### 2026-11-01T09:00:00.000Z · decision · stp-1\n\nWatch paths, not text.\n' +
        '\n### 2026-11-01T10:30:00.000Z · surprise · stp-2\n\nThe Brief cap was already spent.\n',
      ledger: [
        {
          at: '2026-11-01T08:30:00.000Z',
          kind: 'pr-opened',
          stepId: 'stp-1',
          ref: '#176',
          pr: 176
        },
        { at: '2026-11-01T12:00:00.000Z', kind: 'pr-merged', stepId: 'stp-1', ref: '#176', pr: 176 }
      ]
    })

    const ack = await ok('mission_request_close', { folder: main, missionId: id, sessionId: OWNER })
    expect(ack).toMatchObject({ ok: true, op: 'mission_request_close', pendingClose: true })
    expect(ack.consolidation).toMatchObject({ drafts: 3, nothingNotable: false })

    const disk = await readMission(main, id)
    expect(disk.front.status).toBe('delivered')
    expect(disk.front.outcome).toMatchObject({
      declaredEnd: END,
      surprises: ['The Brief cap was already spent.'],
      perStep: expect.arrayContaining([
        expect.objectContaining({ stepId: 'stp-1', mergedAt: '2026-11-01T12:00:00.000Z' })
      ])
    })
    const drafts = disk.front.memoryDrafts as Array<{
      kind: string
      cites: Array<{ kind: string; ref: string }>
    }>
    expect(drafts.map((d) => d.kind).sort()).toEqual(['decision', 'hot', 'lesson'])
    const decision = drafts.find((d) => d.kind === 'decision')!
    expect(decision.cites).toEqual(
      expect.arrayContaining([
        { kind: 'step', ref: 'stp-1' },
        { kind: 'pr', ref: '#176' }
      ])
    )

    // Nothing is written without a tick: memory is byte-identical.
    const decisionsAfter = await fs
      .readFile(path.join(main, '.harnu', 'memory', 'decisions.md'), 'utf8')
      .catch(() => '')
    expect(decisionsAfter).toBe(decisionsBefore)
    expect(decisionsAfter).not.toContain('Watch paths')
  })

  it('a quiet mission says nothingNotable and carries no drafts', async () => {
    const id = (
      await ok('mission_create', {
        folder: main,
        title: 'Quiet one',
        declaredEnd: END,
        sessionId: OWNER,
        steps: [STEP('Only step')],
        steward: false
      })
    ).missionId as string
    await arm(main, id)
    const ack = await ok('mission_request_close', { folder: main, missionId: id })
    expect(ack.consolidation).toMatchObject({ drafts: 0, nothingNotable: true })
    const disk = await readMission(main, id)
    expect(disk.front.outcome.nothingNotable).toBe(true)
    expect(disk.front.memoryDrafts ?? []).toEqual([])
  })

  it('a refused close writes no outcome', async () => {
    const id = (
      await ok('mission_create', {
        folder: main,
        title: 'Not ready',
        declaredEnd: END,
        sessionId: OWNER,
        steward: false
      })
    ).missionId as string
    const r = await call('mission_request_close', { folder: main, missionId: id })
    expect(r.text).toMatch(/^END_NOT_VERIFIED/)
    expect((await readMission(main, id)).front).not.toHaveProperty('outcome')
  })
})

describe('AC-6.1 — campaign_request_close runs the consolidator', () => {
  it('stores the campaign outcome (a forced prerequisite is a surprise) and no memory', async () => {
    const cid = (
      await ok('campaign_create', {
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
    ).campaignId as string
    for (const chapterId of ['chp-1', 'chp-2']) {
      const mid = (
        await ok('mission_create', {
          folder: main,
          title: `Chapter ${chapterId}`,
          declaredEnd: END,
          sessionId: OWNER,
          campaignId: cid,
          chapterId,
          steward: false
        })
      ).missionId as string
      await operatorClosesMission(main, mid)
    }
    const ack = await ok('campaign_request_close', {
      folder: main,
      campaignId: cid,
      sessionId: OWNER
    })
    expect(ack).toMatchObject({ ok: true, op: 'campaign_request_close', pendingClose: true })
    expect(ack.consolidation).toBeDefined()
    const disk = await readCampaign(main, cid)
    expect(disk.front.outcome).toMatchObject({
      declaredEnd: END,
      surprises: [expect.stringContaining('images-on-cdn')]
    })
    expect(Array.isArray(disk.front.memoryDrafts)).toBe(true)
  })
})
