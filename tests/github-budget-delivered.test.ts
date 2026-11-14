/**
 * T611 U1 AC-7 — a `delivered` mission is skipped like a closed one in the GitHub derive and keeps
 * its last known gates; with `checkDelivered: true` it is derived again.
 *
 * Driven through `mission_get` (the real handler, real seeded mission files). Only the GitHub seams
 * are faked: `findPrsForWorktrees` and `findMainCi` record what they were asked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildMissionFileContent,
  missionFilePath,
  type Mission,
  type MissionStep
} from '../src/main/mission-core'
import type { MissionPrJoin } from '../src/main/pr-stack'

const h = vi.hoisted(() => ({
  userDataDir: '',
  joinCalls: [] as Array<{ numbers: readonly number[]; skipGh?: boolean }>,
  mainCiCalls: [] as number[][],
  /** What GitHub would say about PR 8 while it is asked. */
  prState: 'MERGED' as 'MERGED' | 'OPEN'
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
  getTaskStates: () => new Map(),
  addTaskEventObserver: () => () => {}
}))
vi.mock('../src/main/pty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/pty')>()),
  liveSessionKeys: () => new Set<string>()
}))
vi.mock('../src/main/hibernation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/hibernation')>()),
  hibernatedKeys: () => new Set<string>()
}))
vi.mock('../src/main/approval-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/approval-resolver')>()),
  listPendingApprovals: () => []
}))
vi.mock('../src/main/pr-stack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/pr-stack')>()),
  findPrsForWorktrees: async (
    _repo: string,
    refs: { numbers: readonly number[] },
    opts: { skipGh?: boolean } = {}
  ): Promise<MissionPrJoin> => {
    h.joinCalls.push({ numbers: refs.numbers, skipGh: opts.skipGh })
    if (opts.skipGh) return { ghAvailable: null, worktrees: {}, branches: {}, numbers: {} }
    const numbers: MissionPrJoin['numbers'] = {}
    for (const n of refs.numbers) {
      numbers[n] = {
        number: n,
        title: `PR ${n}`,
        branch: 'feat/x',
        base: 'main',
        state: h.prState,
        isDraft: false,
        mergeable: null,
        reviewDecision: null,
        ci: 'passing',
        checks: [],
        url: `https://example.test/pull/${n}`,
        author: 'dev',
        updatedAt: null,
        headOid: null,
        nodeId: null,
        ...(h.prState === 'MERGED' ? { mergedAt: new Date().toISOString() } : {})
      } as unknown as MissionPrJoin['numbers'][number]
    }
    return { ghAvailable: true, worktrees: {}, branches: {}, numbers }
  },
  findMainCi: async (_repo: string, numbers: readonly number[]) => {
    h.mainCiCalls.push([...numbers])
    return {
      ghAvailable: true,
      byNumber: Object.fromEntries(numbers.map((n) => [n, 'passing'] as const))
    }
  }
}))

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

const OWNER = '11111111-2222-4333-8444-555555555555'
let root = ''
let handlers: Record<string, Handler>
let tracker: typeof import('../src/main/github-budget-tracker')
let seq = 0

const iso = (): string => new Date().toISOString()

function step(
  id: string,
  kind: MissionStep['kind'],
  links: MissionStep['links'] = []
): MissionStep {
  const n = Number(id.slice(4))
  return {
    id,
    ordinal: n,
    kind,
    title: kind === 'fixed-end' ? 'Delivered and verified' : `Step ${n}`,
    verification: kind === 'fixed-end' ? 'verifier' : 'existence',
    proof: 'unproven',
    links,
    blockers: []
  }
}

async function seed(status: Mission['status']): Promise<string> {
  seq++
  const id = `mnt-${seq.toString(16).padStart(8, '0')}`
  const at = iso()
  const mission: Mission = {
    id,
    slug: `seeded-${seq}`,
    folder: root,
    owner: { sessionId: OWNER, folder: root },
    status,
    declaredEnd: { kind: 'code', target: 't', evidence: 'e' },
    steps: [
      step('stp-1', 'custom', [{ kind: 'pr', ref: 'org/proj#8' }]),
      step('stp-2', 'fixed-end')
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
    buildMissionFileContent(mission, '# Seeded\n\n## Log\n')
  )
  return id
}

interface GetAck {
  derived: {
    gh: string
    steps: Array<{
      stepId: string
      links: Array<{ kind: string; state?: string; stale?: boolean; exists?: boolean }>
      gates: { pr: string; ci: string; main: string }
    }>
  }
}

async function get(id: string): Promise<GetAck> {
  const res = await handlers.mission_get(
    { folder: root, missionId: id },
    { folder: root, folders: [], denyFolders: [], bridge: undefined }
  )
  expect(res.isError, res.content[0]?.text).not.toBe(true)
  return JSON.parse(res.content[0].text!) as GetAck
}

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-deliv-ud-'))
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-deliv-repo-')), 'main')
  await fs.mkdir(root)
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  h.joinCalls.length = 0
  h.mainCiCalls.length = 0
  h.prState = 'MERGED'
  vi.resetModules()
  tracker = await import('../src/main/github-budget-tracker')
  const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
  handlers = Object.fromEntries(WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
})

/**
 * One observer pass over the repo's open missions. A read no longer remembers what it saw (AC-4,
 * Missions v4 S-3): the last-known facts a later read falls back on are the observer's.
 */
async function observe(): Promise<void> {
  const { observeOpenMissions } = await import('../src/main/mission-ipc')
  await observeOpenMissions([root], Date.now(), { scan: async () => [] })
}

describe('delivered missions are not checked on GitHub (AC-7, D-5)', () => {
  it('an active mission asks GitHub for its PR and its main CI', async () => {
    const id = await seed('active')
    const p = await get(id)
    expect(h.joinCalls).toEqual([{ numbers: [8], skipGh: false }])
    expect(h.mainCiCalls).toEqual([[8]])
    expect(p.derived.gh).toBe('available')
    expect(p.derived.steps[0].gates).toMatchObject({ pr: 'green', main: 'green' })
  })

  it('a delivered mission never asks: no PR list, no main-CI lookup', async () => {
    const id = await seed('delivered')
    const p = await get(id)
    expect(h.joinCalls).toEqual([{ numbers: [8], skipGh: true }])
    expect(h.mainCiCalls).toEqual([])
    expect(p.derived.gh).toBe('not-needed')
  })

  it('…and keeps the last known gates, marked stale, from when it was still open', async () => {
    // The mission is polled while active: GitHub says PR 8 is MERGED, main CI passing.
    const id = await seed('active')
    await get(id)
    await observe()
    // It is then delivered (status flips on disk) and polled again — without asking GitHub.
    const file = missionFilePath(root, id, `seeded-${seq}`)
    const raw = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, raw.replace(/status: active/, 'status: delivered'))
    h.joinCalls.length = 0
    h.mainCiCalls.length = 0
    h.prState = 'OPEN' // GitHub's answer changed; a delivered mission must not hear it
    const p = await get(id)
    expect(h.joinCalls).toEqual([{ numbers: [8], skipGh: true }])
    expect(h.mainCiCalls).toEqual([])
    const link = p.derived.steps[0].links[0]
    expect(link).toMatchObject({ kind: 'pr', state: 'MERGED', exists: true, stale: true })
    expect(p.derived.steps[0].gates.pr).toBe('green')
  })

  it('with `checkDelivered: true` a delivered mission is derived again', async () => {
    tracker.githubBudget.setPrefs({ ...tracker.githubBudget.getPrefs(), checkDelivered: true })
    const id = await seed('delivered')
    const p = await get(id)
    expect(h.joinCalls).toEqual([{ numbers: [8], skipGh: false }])
    expect(h.mainCiCalls).toEqual([[8]])
    expect(p.derived.gh).toBe('available')
  })

  it('a stale or active mission is unaffected by the switch', async () => {
    for (const status of ['active', 'stale'] as const) {
      h.joinCalls.length = 0
      await get(await seed(status))
      expect(h.joinCalls[0].skipGh).toBe(false)
    }
  })
})
