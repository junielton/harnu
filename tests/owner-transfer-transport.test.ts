/**
 * T654 — `mission_transfer_owner` / `campaign_transfer_owner`, driven through the REAL MCP
 * transport (lesson `docs/lessons/testing/006-eval-harness-grades-state-through-the-real-transport.md`):
 * Harnu's own loopback HTTP server, the MCP SDK client with the bearer from `harnu.mcp.json`, so the
 * catalog schema, the bearer guard, the policy gate and the wired handler are all in the path.
 *
 * State is graded from the files on disk with js-yaml directly, never through the product's parser.
 * An ACK is evidence, not the verdict. Only `electron` and the live sources (PR join, fleet scan,
 * hook FSM) are stubbed at their seams.
 *
 * Covers AC-1 (owner lookup follows), AC-3 (campaign + `includeChapters`), AC-4 (Log entry + ledger
 * row), AC-5 (a steward is refused STEWARD_VERB_NOT_ALLOWED) and the refusal codes the card names.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
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
import {
  registerScheduler,
  stopSchedulerTicker,
  setStewardTickStarter
} from '../src/main/scheduler-shell'
import { runOperatorDoor } from '../src/main/mission-ipc'
import { stewardBearer } from '../src/main/steward-core'

const OLD = '11111111-2222-4333-8444-555555555555'
const NEW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const END = { kind: 'code', target: 'every page migrated', evidence: 'the audit is green' }
const STEPS = [{ title: 'Build the importer', verification: 'verifier' }]
const REASON = 'the owner session died; the successor resumes the delivery'

let client: Client
let serverUrl = ''
let serverToken = ''
let main = ''
let worktree = ''
let blockedMain = ''
let titleSeq = 0

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
  const c = new Client({ name: 'owner-transfer-test', version: '0.0.0' })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(serverUrl), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } }
    })
  )
  return c
}

/** A main checkout (`.git` dir) and a linked worktree OUTSIDE its tree (`.git` file → commondir). */
async function fakeRepo(): Promise<{ main: string; worktree: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-xfer-repo-'))
  const repo = path.join(base, 'main')
  const wtGitDir = path.join(repo, '.git', 'worktrees', 'wt')
  await fs.mkdir(wtGitDir, { recursive: true })
  await fs.writeFile(path.join(wtGitDir, 'commondir'), '../..\n', 'utf8')
  const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-xfer-wt-')), 'wt')
  await fs.mkdir(wt)
  await fs.writeFile(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`, 'utf8')
  return { main: repo, worktree: wt }
}

interface OnDisk {
  file: string
  raw: string
  front: Record<string, unknown>
  log: string
}

async function readRecord(
  root: string,
  kind: 'missions' | 'campaigns',
  id: string
): Promise<OnDisk> {
  const dir = path.join(root, '.harnu', kind)
  const name = (await fs.readdir(dir)).find((n) => n.startsWith(`${id}-`))
  if (!name) throw new Error(`no file for ${id}`)
  const file = path.join(dir, name)
  const raw = await fs.readFile(file, 'utf8')
  const parts = raw.split(/^---\n/m)
  return {
    file,
    raw,
    front: yaml.load(parts[1], { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>,
    log: parts.slice(2).join('---\n')
  }
}
const ownerOf = (d: OnDisk): string => (d.front.owner as { sessionId: string }).sessionId

async function newMission(folder: string, extra: Record<string, unknown> = {}): Promise<string> {
  const ack = await ok('mission_create', {
    folder,
    title: `Ship the migration ${++titleSeq}`,
    declaredEnd: END,
    sessionId: OLD,
    steps: STEPS,
    steward: false,
    ...extra
  })
  return ack.missionId as string
}

async function newCampaign(folder: string): Promise<string> {
  const ack = await ok('campaign_create', {
    folder,
    title: `Content migration ${++titleSeq}`,
    declaredEnd: END,
    sessionId: OLD,
    chapters: [{ title: 'First' }, { title: 'Second' }, { title: 'Unbound' }]
  })
  return ack.campaignId as string
}

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-xfer-ud-'))
  ;({ main, worktree } = await fakeRepo())
  blockedMain = (await fakeRepo()).main
  h.denied = [blockedMain]
  registerScheduler(() => null, { dispatch: async () => ({}) } as never)
  setStewardTickStarter(async () => {})
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

describe('the verbs are on the wire', () => {
  it('lists both transfer verbs with the shapes the card names', async () => {
    const { tools } = await client.listTools()
    const props = (n: string): string[] =>
      Object.keys(
        (tools.find((t) => t.name === n)!.inputSchema as { properties: object }).properties
      )
    expect(props('mission_transfer_owner')).toEqual(
      expect.arrayContaining(['folder', 'missionId', 'toSessionId', 'reason'])
    )
    expect(props('campaign_transfer_owner')).toEqual(
      expect.arrayContaining(['folder', 'campaignId', 'toSessionId', 'reason', 'includeChapters'])
    )
  })
})

describe('AC-1 / AC-4 — mission_transfer_owner', () => {
  it('moves owner.sessionId on disk, and mission_get follows the new owner only', async () => {
    const id = await newMission(worktree)
    const ack = await ok('mission_transfer_owner', {
      folder: worktree,
      missionId: id,
      toSessionId: NEW,
      reason: REASON
    })
    expect(ack).toMatchObject({
      ok: true,
      op: 'mission_transfer_owner',
      missionId: id,
      from: OLD,
      to: NEW
    })
    expect(ownerOf(await readRecord(main, 'missions', id))).toBe(NEW)

    const viaNew = await call('mission_get', { folder: main, ownerSessionId: NEW })
    expect(viaNew.isError, viaNew.text).toBe(false)
    expect((viaNew.body.mission as { id: string }).id).toBe(id)
    const viaOld = await call('mission_get', { folder: main, ownerSessionId: OLD })
    expect(viaOld.isError).toBe(true)
    expect(viaOld.text).toMatch(/owns no open mission/)
  })

  it('writes the Log entry and the ledger row, and mission_get.ledger shows the row', async () => {
    const id = await newMission(main)
    await ok('mission_transfer_owner', {
      folder: main,
      missionId: id,
      toSessionId: NEW,
      reason: REASON
    })
    const disk = await readRecord(main, 'missions', id)
    expect(disk.log).toMatch(
      new RegExp(`### \\S+ · owner transfer: ${OLD} → ${NEW} \\(${REASON}\\)`)
    )
    const rows = disk.front.ledger as Array<Record<string, unknown>>
    expect(rows.filter((r) => r.kind === 'owner-transfer')).toEqual([
      expect.objectContaining({ kind: 'owner-transfer', ref: NEW, sessionId: NEW })
    ])
    const got = await ok('mission_get', { folder: main, missionId: id })
    expect((got.ledger as Array<{ kind: string }>).map((r) => r.kind)).toContain('owner-transfer')
  })

  it('refuses SAME_OWNER, BAD_SESSION_ID (synthetic-…) and an empty reason, writing nothing', async () => {
    const id = await newMission(main)
    const before = (await readRecord(main, 'missions', id)).raw
    const same = await call('mission_transfer_owner', {
      folder: main,
      missionId: id,
      toSessionId: OLD,
      reason: REASON
    })
    expect(same.isError).toBe(true)
    expect(same.text).toMatch(/^SAME_OWNER/)
    const synthetic = await call('mission_transfer_owner', {
      folder: main,
      missionId: id,
      toSessionId: 'synthetic-0b9d1c1e',
      reason: REASON
    })
    expect(synthetic.isError).toBe(true)
    expect(synthetic.text).toMatch(/^BAD_SESSION_ID/)
    const noReason = await call('mission_transfer_owner', {
      folder: main,
      missionId: id,
      toSessionId: NEW,
      reason: '  '
    })
    expect(noReason.isError).toBe(true)
    expect((await readRecord(main, 'missions', id)).raw).toBe(before)
  })

  it('refuses MISSION_CLOSED once the operator ended it', async () => {
    const id = await newMission(main)
    await runOperatorDoor({ door: 'end', root: main, missionId: id, closedAs: 'delivered' })
    const frozen = (await readRecord(main, 'missions', id)).raw
    const r = await call('mission_transfer_owner', {
      folder: main,
      missionId: id,
      toSessionId: NEW,
      reason: REASON
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^MISSION_CLOSED/)
    expect((await readRecord(main, 'missions', id)).raw).toBe(frozen)
  })

  it('refuses FOLDER_NOT_ALLOWED in a blocked repo', async () => {
    const r = await call('mission_transfer_owner', {
      folder: blockedMain,
      missionId: 'mnt-0a0a0a0a',
      toSessionId: NEW,
      reason: REASON
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/FOLDER_NOT_ALLOWED/)
  })
})

describe('AC-3 / AC-4 — campaign_transfer_owner', () => {
  it('moves the campaign only, by default; the chapter missions keep their owner', async () => {
    const cid = await newCampaign(main)
    const mid = await newMission(main, { campaignId: cid, chapterId: 'chp-1' })
    const ack = await ok('campaign_transfer_owner', {
      folder: worktree,
      campaignId: cid,
      toSessionId: NEW,
      reason: REASON
    })
    expect(ack).toMatchObject({
      ok: true,
      op: 'campaign_transfer_owner',
      campaignId: cid,
      from: OLD,
      to: NEW,
      moved: { campaign: true, missions: [] }
    })
    const disk = await readRecord(main, 'campaigns', cid)
    expect(ownerOf(disk)).toBe(NEW)
    expect(disk.log).toMatch(
      new RegExp(`### \\S+ · owner transfer: ${OLD} → ${NEW} \\(${REASON}\\)`)
    )
    expect(ownerOf(await readRecord(main, 'missions', mid))).toBe(OLD)
    const viaNew = await ok('campaign_get', { folder: main, ownerSessionId: NEW })
    expect((viaNew.campaign as { id: string }).id).toBe(cid)
  })

  it('with includeChapters, every non-closed chapter mission moves too, each with Log + ledger', async () => {
    const cid = await newCampaign(main)
    const open = await newMission(main, { campaignId: cid, chapterId: 'chp-1' })
    const closed = await newMission(main, { campaignId: cid, chapterId: 'chp-2' })
    await runOperatorDoor({ door: 'end', root: main, missionId: closed, closedAs: 'delivered' })
    const ack = await ok('campaign_transfer_owner', {
      folder: main,
      campaignId: cid,
      toSessionId: NEW,
      reason: REASON,
      includeChapters: true
    })
    expect(ack.moved).toEqual({ campaign: true, missions: [open] })
    expect(ownerOf(await readRecord(main, 'campaigns', cid))).toBe(NEW)
    const moved = await readRecord(main, 'missions', open)
    expect(ownerOf(moved)).toBe(NEW)
    expect(moved.log).toMatch(new RegExp(`owner transfer: ${OLD} → ${NEW}`))
    expect(
      (moved.front.ledger as Array<{ kind: string }>).filter((r) => r.kind === 'owner-transfer')
    ).toHaveLength(1)
    expect(ownerOf(await readRecord(main, 'missions', closed))).toBe(OLD)
  })

  it('refuses SAME_OWNER, BAD_SESSION_ID and CAMPAIGN_CLOSED, writing nothing', async () => {
    const cid = await newCampaign(main)
    const before = (await readRecord(main, 'campaigns', cid)).raw
    const same = await call('campaign_transfer_owner', {
      folder: main,
      campaignId: cid,
      toSessionId: OLD,
      reason: REASON
    })
    expect(same.text).toMatch(/^SAME_OWNER/)
    const synthetic = await call('campaign_transfer_owner', {
      folder: main,
      campaignId: cid,
      toSessionId: 'synthetic-0b9d1c1e',
      reason: REASON
    })
    expect(synthetic.text).toMatch(/^BAD_SESSION_ID/)
    expect((await readRecord(main, 'campaigns', cid)).raw).toBe(before)

    const disk = await readRecord(main, 'campaigns', cid)
    await fs.writeFile(
      disk.file,
      disk.raw.replace(/status: \w+/, 'status: closed\nclosedAs: delivered'),
      'utf8'
    )
    const frozen = (await readRecord(main, 'campaigns', cid)).raw
    const closed = await call('campaign_transfer_owner', {
      folder: main,
      campaignId: cid,
      toSessionId: NEW,
      reason: REASON
    })
    expect(closed.isError).toBe(true)
    expect(closed.text).toMatch(/^CAMPAIGN_CLOSED/)
    expect((await readRecord(main, 'campaigns', cid)).raw).toBe(frozen)
  })

  it('refuses FOLDER_NOT_ALLOWED in a blocked repo', async () => {
    const r = await call('campaign_transfer_owner', {
      folder: blockedMain,
      campaignId: 'cmp-0a0a0a0a',
      toSessionId: NEW,
      reason: REASON
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/FOLDER_NOT_ALLOWED/)
  })
})

describe('AC-5 — a steward is refused both verbs by name', () => {
  it('STEWARD_VERB_NOT_ALLOWED, and the owner on disk does not move', async () => {
    const created = await ok('mission_create', {
      folder: main,
      title: `Stewarded ${++titleSeq}`,
      declaredEnd: END,
      sessionId: OLD,
      steps: STEPS
    })
    const missionId = created.missionId as string
    const workers = (await ok('list_workers', {})).workers as Array<Record<string, unknown>>
    const row = workers.find((w) => w.category === 'steward' && w.missionId === missionId)!
    const steward = await connectAs(stewardBearer(serverToken, row.id as string))
    try {
      const m = await callOn(steward, 'mission_transfer_owner', {
        folder: main,
        missionId,
        toSessionId: NEW,
        reason: REASON
      })
      expect(m.isError).toBe(true)
      expect(m.text).toMatch(/STEWARD_VERB_NOT_ALLOWED/)
      const c = await callOn(steward, 'campaign_transfer_owner', {
        folder: main,
        campaignId: 'cmp-0a0a0a0a',
        toSessionId: NEW,
        reason: REASON
      })
      expect(c.isError).toBe(true)
      expect(c.text).toMatch(/STEWARD_VERB_NOT_ALLOWED/)
      expect(ownerOf(await readRecord(main, 'missions', missionId))).toBe(OLD)
    } finally {
      await steward.close().catch(() => {})
    }
  })
})
