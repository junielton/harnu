/**
 * Campaign ch.5a (T597) Delta 1 — the wake wiring that had no direct test. Driven through the real
 * mission handlers and the real hook-bridge server; only `wakeStewardForMission` is a spy (the wake
 * DECISION and its coalescing are pinned in `steward-core` / the lifecycle transport suite).
 *
 *  - what `observeLedger` sees on a read maps to a wake reason: a CI row → `ci`, a builder ending →
 *    `child-idle`, any other new fact → `ledger`, and an unchanged world wakes nobody;
 *  - end to end: a PreCompact hook POST → the route → `recordMissionCompaction` → a `compaction` row
 *    on disk (the writer Amendment (b) was waiting for a caller for).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import yaml from 'js-yaml'
import {
  buildMissionFileContent,
  missionFilePath,
  type Mission,
  type MissionStep
} from '../src/main/mission-core'
import type { TaskState } from '../src/main/hook-state'
import type { MissionPrJoin } from '../src/main/pr-stack'

const h = vi.hoisted(() => ({
  userDataDir: '',
  taskStates: new Map<string, string>(),
  live: new Set<string>(),
  pr: { state: 'OPEN', ci: 'pending' } as { state: string; ci: string },
  wakes: [] as Array<[string, string]>
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
vi.mock('../src/main/scheduler-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/scheduler-shell')>()),
  wakeStewardForMission: async (missionId: string, reason: string) => {
    h.wakes.push([missionId, reason])
    return { woke: false, reason: 'spy' }
  },
  listStewards: () => []
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
          createdAt: null,
          mergedAt: null,
          headOid: null,
          nodeId: null
        }
      }
    }) as unknown as MissionPrJoin,
  findMainCi: async () => ({ ghAvailable: true, byNumber: {} })
}))

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

const OWNER = '11111111-2222-4333-8444-555555555555'
const BUILDER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const MISSION = 'mnt-0000000a'

let root = ''
let handlers: Record<string, Handler>

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

async function seed(): Promise<void> {
  const at = new Date().toISOString()
  const mission: Mission = {
    id: MISSION,
    slug: 'wake',
    folder: root,
    owner: { sessionId: OWNER, folder: root },
    status: 'active',
    declaredEnd: { kind: 'code', target: 't', evidence: 'e' },
    steps: [
      step('stp-1', {
        links: [
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
  await fs.mkdir(path.dirname(missionFilePath(root, MISSION, mission.slug)), { recursive: true })
  await fs.writeFile(
    missionFilePath(root, MISSION, mission.slug),
    buildMissionFileContent(mission, '# Wake\n\n## Log\n')
  )
}

const ctx = (): Record<string, unknown> => ({
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
})

const read = async (): Promise<void> => {
  const res = await handlers.mission_get({ folder: root, missionId: MISSION }, ctx())
  expect(res.isError, res.content[0]?.text).not.toBe(true)
}

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-wake-ud-'))
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-wake-repo-')), 'main')
  await fs.mkdir(root)
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  h.taskStates = new Map()
  h.live = new Set()
  h.pr = { state: 'OPEN', ci: 'pending' }
  h.wakes = []
  vi.resetModules()
  const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
  handlers = Object.fromEntries(WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
  await seed()
})

describe('observeLedger → wake reason', () => {
  it('a new CI row wakes the steward as `ci`; an unchanged world wakes nobody', async () => {
    await read() // observes pr-opened AND ci(pending) in one read: CI is the more specific fact
    expect(h.wakes).toEqual([[MISSION, 'ci']])
    h.wakes = []
    await read()
    await read()
    expect(h.wakes).toEqual([])
    h.pr = { state: 'OPEN', ci: 'passing' }
    await read()
    expect(h.wakes).toEqual([[MISSION, 'ci']])
  })

  it('a PR merging with CI unchanged wakes it as `ledger`', async () => {
    await read()
    h.wakes = []
    h.pr = { state: 'MERGED', ci: 'pending' }
    await read()
    expect(h.wakes).toEqual([[MISSION, 'ledger']])
  })

  it('a linked builder ending wakes it as `child-idle`', async () => {
    h.live = new Set([BUILDER])
    h.taskStates.set(BUILDER, 'working' satisfies TaskState)
    await read()
    h.wakes = []
    h.taskStates.set(BUILDER, 'failed' satisfies TaskState)
    await read()
    expect(h.wakes).toEqual([[MISSION, 'child-idle']])
  })
})

describe('end to end: PreCompact hook → route → compaction row on disk', () => {
  async function ledgerOnDisk(): Promise<Array<Record<string, unknown>>> {
    const dir = path.join(root, '.harnu', 'missions')
    const raw = await fs.readFile(path.join(dir, (await fs.readdir(dir))[0]), 'utf8')
    const front = yaml.load(raw.split(/^---\n/m)[1], { schema: yaml.CORE_SCHEMA }) as {
      ledger?: Array<Record<string, unknown>>
    }
    return front.ledger ?? []
  }

  it('POST /steward/<token>/precompact for the owner appends one `compaction` row (and wakes the steward)', async () => {
    const { startHookServer } = await import('../src/main/hook-bridge')
    const { handleStewardRoute } = await import('../src/main/steward-routes')
    const { stewardRouteDeps } = await import('../src/main/steward-bridge')
    const deps = stewardRouteDeps()
    const server = await startHookServer(() => {}, 'tok-e2e', {
      steward: (route, body) => handleStewardRoute(route, body, deps)
    })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/steward/tok-e2e/precompact`, {
        method: 'POST',
        body: JSON.stringify({ session_id: OWNER, cwd: root, hook_event_name: 'PreCompact' })
      })
      expect(res.status).toBe(200)
      const rows = (await ledgerOnDisk()).filter((r) => r.kind === 'compaction')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ ref: OWNER, sessionId: OWNER })
      expect(h.wakes).toContainEqual([MISSION, 'ledger'])

      // A session that owns nothing leaves no row.
      await fetch(`http://127.0.0.1:${server.port}/steward/tok-e2e/precompact`, {
        method: 'POST',
        body: JSON.stringify({ session_id: BUILDER, cwd: root })
      })
      expect((await ledgerOnDisk()).filter((r) => r.kind === 'compaction')).toHaveLength(1)
    } finally {
      await server.close()
    }
  })
})
