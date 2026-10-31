/**
 * Campaign ch.1 (T593, spec §3.2/§8 AC-3) — the Harnu-written ledger. Each of the
 * eight events appends exactly one row `{ at, kind, stepId?, ref }`; `mission_get`
 * returns the tail and `mission_list` the count; no verb takes a row as input.
 *
 * Write-time events (dispatch, worktree cut, manifest drain, verifier verdict,
 * compaction) land in the mission file under its lock. Read-time events (PR opened /
 * merged, CI change, linked session death) are OBSERVATIONS: they are kept in the
 * link-cache sidecar so a read never rewrites the mission file (Mission v3 §3.7).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildMissionFileContent,
  LEDGER_KINDS,
  missionFilePath,
  parseMissionFile,
  type LedgerRow,
  type Mission,
  type MissionStep
} from '../src/main/mission-core'
import type { TaskState } from '../src/main/hook-state'
import type { MissionPrJoin } from '../src/main/pr-stack'

const h = vi.hoisted(() => ({
  userDataDir: '',
  taskStates: new Map<string, string>(),
  live: new Set<string>(),
  pr: { state: 'OPEN', ci: 'pending' } as {
    state: string
    ci: string
    createdAt?: string
    mergedAt?: string
  }
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
vi.mock('../src/main/hook-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/hook-bridge')>()),
  getTaskStates: () => h.taskStates,
  addTaskEventObserver: () => () => {}
}))
vi.mock('../src/main/pty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/pty')>()),
  liveSessionKeys: () => h.live
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
  findPrsForWorktrees: async (): Promise<MissionPrJoin> =>
    ({
      ghAvailable: true,
      worktrees: {},
      branches: {},
      numbers: {
        7: {
          number: 7,
          title: 'PR 7',
          branch: 'feat/7',
          base: 'main',
          state: h.pr.state,
          isDraft: false,
          mergeable: null,
          reviewDecision: null,
          ci: h.pr.ci,
          checks: [],
          url: 'https://example.test/pull/7',
          author: 'dev',
          updatedAt: null,
          createdAt: h.pr.createdAt ?? null,
          mergedAt: h.pr.mergedAt ?? null,
          headOid: null,
          nodeId: null
        }
      }
    }) as unknown as MissionPrJoin,
  findMainCi: async () => ({ ghAvailable: true, byNumber: {} })
}))
vi.mock('../src/main/mcp/create-session-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/mcp/create-session-core')>()),
  runCreateSession: async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          op: 'create_session',
          result: { sessionId: 'dddddddd-eeee-4fff-8000-111111111111' }
        })
      }
    ]
  })
}))
vi.mock('../src/main/worktree-ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/worktree-ipc')>()),
  createWorktree: async () => ({
    path: '/repo/.claude/worktrees/card-T1',
    base: 'main',
    branch: 'card/T1',
    warnings: []
  })
}))
vi.mock('../src/main/roadmap-ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/roadmap-ipc')>()),
  buildManifestDisclosure: async () => ({
    ok: true,
    resolved: [{ slug: 'T1', title: 'T1', kind: 'feature', complexity: 'standard', gaps: [] }]
  }),
  stampManifestApprovals: async () => ({ stamped: ['T1'], failed: [] })
}))

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

const OWNER = '11111111-2222-4333-8444-555555555555'
const BUILDER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const VERIFIER = 'cccccccc-dddd-4eee-8fff-000000000000'

let root = ''
let handlers: Record<string, Handler>
let missionId = ''

function payloadOf(res: ToolResult): Record<string, unknown> {
  expect(res.isError, res.content[0]?.text).not.toBe(true)
  return JSON.parse(res.content[0].text!) as Record<string, unknown>
}

function step(id: string, over: Partial<MissionStep> = {}): MissionStep {
  const n = Number(id.slice(4))
  return {
    id,
    ordinal: n,
    kind: 'custom',
    title: `Step ${n}`,
    verification: 'verifier',
    proof: 'unproven',
    links: [],
    blockers: [],
    ...over
  }
}

async function seed(): Promise<string> {
  const id = 'mnt-0000000a'
  const at = new Date().toISOString()
  const mission: Mission = {
    id,
    slug: 'ledger',
    folder: root,
    owner: { sessionId: OWNER, folder: root },
    status: 'active',
    declaredEnd: { kind: 'code', target: 't', evidence: 'e' },
    steps: [
      step('stp-1', {
        links: [
          { kind: 'card', ref: 'T1' },
          { kind: 'pr', ref: '#7' },
          { kind: 'session', ref: BUILDER }
        ]
      }),
      step('stp-2', { kind: 'fixed-end', title: 'Delivered and verified' })
    ],
    blockers: [],
    openQuestions: [],
    createdAt: at,
    updatedAt: at,
    provenance: { author: 'agent', at }
  }
  await fs.mkdir(path.dirname(missionFilePath(root, id, mission.slug)), { recursive: true })
  await fs.writeFile(
    missionFilePath(root, id, mission.slug),
    buildMissionFileContent(mission, '# Ledger\n\n## Log\n')
  )
  return id
}

function ctx(): Record<string, unknown> {
  return {
    folder: root,
    folders: [
      {
        path: root,
        sessions: [
          {
            sessionId: BUILDER,
            projectPath: root,
            status: 'idle',
            isSidechain: false,
            modified: new Date().toISOString(),
            firstPrompt: '',
            summary: ''
          }
        ]
      }
    ],
    denyFolders: [],
    bridge: { dispatch: async () => ({}), awaitMaterialization: async () => null }
  }
}

async function ledgerOf(): Promise<LedgerRow[]> {
  const ack = payloadOf(await handlers.mission_get({ folder: root, missionId }, ctx()))
  return ack.ledger as LedgerRow[]
}

const ofKind = (rows: LedgerRow[], kind: string): LedgerRow[] => rows.filter((r) => r.kind === kind)

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-ledger-ud-'))
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-ledger-repo-')), 'main')
  await fs.mkdir(root)
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  h.taskStates = new Map()
  h.live = new Set()
  h.pr = { state: 'OPEN', ci: 'pending' }
  vi.resetModules()
  const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
  handlers = Object.fromEntries(WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
  missionId = await seed()
})

describe('write-time events — appended to the mission file', () => {
  it('create_session appends one dispatched row naming the new session', async () => {
    await handlers.create_session({ folder: root }, ctx())
    const rows = ofKind(await ledgerOf(), 'dispatched')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'dispatched',
      ref: 'dddddddd-eeee-4fff-8000-111111111111'
    })
    expect(Number.isFinite(Date.parse(rows[0].at))).toBe(true)
  })

  it('create_worktree appends one worktree row naming the new path and branch', async () => {
    await handlers.create_worktree({ folder: root, branch: 'card/T1' }, ctx())
    const rows = ofKind(await ledgerOf(), 'worktree')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      ref: '/repo/.claude/worktrees/card-T1',
      branch: 'card/T1'
    })
  })

  it('submit_manifest appends one dispatched row per stamped card, on the step that links it', async () => {
    await handlers.submit_manifest({ folder: root, cards: [{ slug: 'T1' }] }, ctx())
    const rows = ofKind(await ledgerOf(), 'dispatched')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ref: 'T1', stepId: 'stp-1', detail: 'manifest' })
  })

  it('mission_verify_step appends one verified row with the verdict', async () => {
    await handlers.mission_verify_step(
      {
        folder: root,
        missionId,
        stepId: 'stp-1',
        verdict: 'met',
        evidence: 'checked the PR head',
        sessionId: VERIFIER
      },
      ctx()
    )
    const rows = ofKind(await ledgerOf(), 'verified')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ stepId: 'stp-1', ref: VERIFIER, detail: 'met' })
  })

  it('a compaction of the owner session appends one compaction row', async () => {
    const { recordMissionCompaction } = await import('../src/main/mcp/tool-handlers')
    await recordMissionCompaction(root, OWNER)
    const rows = ofKind(await ledgerOf(), 'compaction')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ref: OWNER, sessionId: OWNER })
  })

  it('lands in the file, append-only, and leaves the ledger valid on re-parse', async () => {
    await handlers.create_session({ folder: root }, ctx())
    await handlers.create_worktree({ folder: root, branch: 'card/T1' }, ctx())
    const dir = path.join(root, '.harnu', 'missions')
    const raw = await fs.readFile(path.join(dir, (await fs.readdir(dir))[0]), 'utf8')
    const parsed = parseMissionFile(raw) as Mission
    expect(parsed.ledger?.map((r) => r.kind)).toEqual(['dispatched', 'worktree'])
  })
})

describe('read-time events — observed once, kept out of the mission file', () => {
  it('records pr-opened once, and a ci row per CI change, across repeated reads', async () => {
    await ledgerOf()
    await ledgerOf()
    let rows = await ledgerOf()
    expect(ofKind(rows, 'pr-opened')).toEqual([
      expect.objectContaining({ stepId: 'stp-1', ref: '#7', pr: 7 })
    ])
    expect(ofKind(rows, 'ci')).toEqual([expect.objectContaining({ ref: '#7', detail: 'pending' })])
    h.pr = { state: 'OPEN', ci: 'passing' }
    rows = await ledgerOf()
    expect(ofKind(rows, 'ci').map((r) => r.detail)).toEqual(['pending', 'passing'])
  })

  it('records pr-merged once when the PR merges', async () => {
    await ledgerOf()
    h.pr = { state: 'MERGED', ci: 'passing' }
    await ledgerOf()
    const rows = await ledgerOf()
    expect(ofKind(rows, 'pr-merged')).toEqual([
      expect.objectContaining({ stepId: 'stp-1', ref: '#7', pr: 7 })
    ])
  })

  it('BUG-235 AC-1: pr-opened and pr-merged carry the PR event time, not the observation time', async () => {
    h.pr = { state: 'OPEN', ci: 'pending', createdAt: '2026-10-31T08:00:00Z' }
    let rows = await ledgerOf()
    const opened = ofKind(rows, 'pr-opened')[0]
    expect(opened.at).toBe('2026-10-31T08:00:00.000Z')
    expect(opened.detail).toBeUndefined()
    h.pr = {
      state: 'MERGED',
      ci: 'passing',
      createdAt: '2026-10-31T08:00:00Z',
      mergedAt: '2026-10-31T08:53:20Z'
    }
    rows = await ledgerOf()
    const merged = ofKind(rows, 'pr-merged')[0]
    expect(merged.at).toBe('2026-10-31T08:53:20.000Z')
    expect(merged.detail).toBeUndefined()
    // ci keeps the observation time, and the ledger stays in time order
    expect(Date.parse(ofKind(rows, 'ci')[0].at)).toBeGreaterThan(Date.parse(merged.at))
    expect(rows.map((r) => Date.parse(r.at))).toEqual(
      [...rows.map((r) => Date.parse(r.at))].sort((a, b) => a - b)
    )
  })

  it('BUG-235 AC-1: without a GitHub time the row falls back to the observation time and says so', async () => {
    const before = Date.now()
    await ledgerOf()
    h.pr = { state: 'MERGED', ci: 'passing' }
    const rows = await ledgerOf()
    for (const row of [ofKind(rows, 'pr-opened')[0], ofKind(rows, 'pr-merged')[0]]) {
      expect(row.detail).toBe('observed')
      expect(Date.parse(row.at)).toBeGreaterThanOrEqual(before)
    }
  })

  it('records session-died once when a linked builder ends', async () => {
    h.live = new Set([BUILDER])
    h.taskStates.set(BUILDER, 'working' satisfies TaskState)
    await ledgerOf()
    expect(ofKind(await ledgerOf(), 'session-died')).toHaveLength(0)
    h.taskStates.set(BUILDER, 'failed' satisfies TaskState)
    await ledgerOf()
    const rows = ofKind(await ledgerOf(), 'session-died')
    expect(rows).toEqual([
      expect.objectContaining({ stepId: 'stp-1', ref: BUILDER, detail: 'failed' })
    ])
  })

  it('records session-died when a builder seen alive loses its process', async () => {
    h.live = new Set([BUILDER])
    h.taskStates.set(BUILDER, 'working' satisfies TaskState)
    await ledgerOf()
    h.live = new Set() // the PTY is gone: the hook state is no longer disclosed
    await ledgerOf()
    const rows = ofKind(await ledgerOf(), 'session-died')
    expect(rows).toEqual([expect.objectContaining({ ref: BUILDER, detail: 'exited' })])
  })

  it('a builder that was never seen alive is not reported dead', async () => {
    await ledgerOf()
    expect(ofKind(await ledgerOf(), 'session-died')).toHaveLength(0)
  })

  it('never rewrites the mission file on a read, whatever it observes', async () => {
    const dir = path.join(root, '.harnu', 'missions')
    const file = path.join(dir, (await fs.readdir(dir))[0])
    const before = await fs.readFile(file, 'utf8')
    h.taskStates.set(BUILDER, 'failed' satisfies TaskState)
    h.pr = { state: 'MERGED', ci: 'passing' }
    for (let i = 0; i < 4; i++) await ledgerOf()
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })
})

describe('reading the ledger', () => {
  it('mission_get returns the last 20 rows, oldest first, and the count', async () => {
    for (let i = 0; i < 23; i++) await handlers.create_session({ folder: root }, ctx())
    const ack = payloadOf(await handlers.mission_get({ folder: root, missionId }, ctx()))
    expect((ack.ledger as LedgerRow[]).length).toBe(20)
    expect(ack.ledgerCount).toBeGreaterThanOrEqual(23)
    // The projection of the mission itself leaves the full ledger out — the tail is the read.
    expect((ack.mission as Mission).ledger).toBeUndefined()
  })

  it('mission_list rows carry ledgerCount', async () => {
    await handlers.create_session({ folder: root }, ctx())
    await handlers.create_worktree({ folder: root, branch: 'card/T1' }, ctx())
    const ack = payloadOf(await handlers.mission_list({ folder: root }, ctx()))
    const row = (ack.missions as Array<{ id: string; ledgerCount: number }>).find(
      (m) => m.id === missionId
    )
    expect(row?.ledgerCount).toBe(2)
  })

  it('no mission verb accepts a ledger row: the argument is ignored, never written', async () => {
    await handlers.mission_log(
      {
        folder: root,
        missionId,
        note: 'hello',
        ledger: [{ kind: 'pr-merged', ref: '#99' }]
      },
      ctx()
    )
    await handlers.mission_add_step(
      {
        folder: root,
        missionId,
        title: 'x',
        verification: 'human',
        reason: 'r',
        ledger: [{ kind: 'pr-merged', ref: '#99' }]
      },
      ctx()
    )
    expect(ofKind(await ledgerOf(), 'pr-merged').filter((r) => r.ref === '#99')).toEqual([])
  })

  it('uses only the eight kinds', () => {
    expect(LEDGER_KINDS).toHaveLength(8)
  })
})
