/**
 * Campaign ch.1 (T593, spec §3.2/§8) — `derived.steps[].gates` on `mission_get`, the
 * `main is red` you-item, the sticky last-known value, and the read-purity of the
 * mission file. The handler is driven for real against a throwaway git repo; only the
 * live sources are faked at their module seams (hook FSM, PTY liveness, hibernation,
 * Approval Inbox, and the `gh`-backed PR / main-CI joins). Missions are seeded on disk.
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
  type MissionStep,
  type StepLink
} from '../src/main/mission-core'
import { GATE_NAMES, type GateCi, type StepGates } from '../src/main/mission-gates'
import type { MissionPrJoin } from '../src/main/pr-stack'

const h = vi.hoisted(() => ({
  userDataDir: '',
  join: null as null | (() => unknown),
  main: null as null | (() => unknown)
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
  findPrsForWorktrees: async () => h.join!(),
  findMainCi: async () => h.main!()
}))

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

const OWNER = '11111111-2222-4333-8444-555555555555'
const VERIFIER = 'cccccccc-dddd-4eee-8fff-000000000000'

let root = ''
let handlers: Record<string, Handler>
let seq = 0

function payloadOf(res: ToolResult): Record<string, unknown> {
  expect(res.isError, res.content[0]?.text).not.toBe(true)
  return JSON.parse(res.content[0].text!) as Record<string, unknown>
}

function pr(number: number, state: 'OPEN' | 'MERGED' | 'CLOSED', ci: GateCi) {
  return {
    number,
    title: `PR ${number}`,
    branch: `feat/${number}`,
    base: 'main',
    state,
    isDraft: false,
    mergeable: null,
    reviewDecision: null,
    ci,
    checks: [],
    url: `https://example.test/pull/${number}`,
    author: 'dev',
    updatedAt: null,
    headOid: null,
    nodeId: null
  }
}

/** The `gh pr list` join: PR numbers → entries. */
function joinOf(prs: ReturnType<typeof pr>[], ghAvailable = true): MissionPrJoin {
  const numbers: Record<number, unknown> = {}
  for (const p of prs) numbers[p.number] = ghAvailable ? p : null
  return { ghAvailable, worktrees: {}, branches: {}, numbers } as unknown as MissionPrJoin
}

function mainOf(byNumber: Record<number, GateCi | null>, ghAvailable = true): unknown {
  return { ghAvailable, byNumber }
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

const prLink = (n: number): StepLink => ({ kind: 'pr', ref: `#${n}` })

/** A verifier-level step with PR #8 linked, verified by a session that built nothing. */
function verifiedStep(): MissionStep {
  return step('stp-1', {
    links: [prLink(8)],
    proof: 'verified',
    verifiedBy: { sessionId: VERIFIER, at: '2026-10-30T09:00:00.000Z', verdict: 'met' }
  })
}

async function seed(steps: MissionStep[], over: Partial<Mission> = {}): Promise<string> {
  seq++
  const id = `mnt-${seq.toString(16).padStart(8, '0')}`
  const at = new Date().toISOString()
  const mission: Mission = {
    id,
    slug: `seeded-${seq}`,
    folder: root,
    owner: { sessionId: OWNER, folder: root },
    status: 'active',
    declaredEnd: { kind: 'code', target: 't', evidence: 'e' },
    steps: [
      ...steps,
      step(`stp-${steps.length + 1}`, { kind: 'fixed-end', title: 'Delivered and verified' })
    ],
    blockers: [],
    openQuestions: [],
    createdAt: at,
    updatedAt: at,
    provenance: { author: 'agent', at },
    ...over
  }
  await fs.mkdir(path.dirname(missionFilePath(root, id, mission.slug)), { recursive: true })
  await fs.writeFile(
    missionFilePath(root, id, mission.slug),
    buildMissionFileContent(mission, '# Seeded\n\n## Log\n')
  )
  return id
}

async function rawOf(id: string): Promise<string> {
  const dir = path.join(root, '.harnu', 'missions')
  const name = (await fs.readdir(dir)).find((n) => n.startsWith(`${id}-`))!
  return fs.readFile(path.join(dir, name), 'utf8')
}

interface GetAck {
  you: string
  youItems: Array<Record<string, unknown>>
  derived: {
    gh: string
    steps: Array<{ stepId: string; gates: StepGates; prNumber: number | null }>
    progress: { states: Record<string, string> }
  }
}

async function get(id: string): Promise<GetAck> {
  const ctx = { folder: root, folders: [], denyFolders: [], bridge: undefined }
  return payloadOf(await handlers.mission_get({ folder: root, missionId: id }, ctx)) as never
}

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-gates-ud-'))
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-gates-repo-')), 'main')
  await fs.mkdir(root)
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  h.join = () => joinOf([pr(8, 'MERGED', 'passing')])
  h.main = () => mainOf({ 8: 'passing' })
  vi.resetModules()
  const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
  handlers = Object.fromEntries(WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
})

describe('AC-1 — a step is proven by facts', () => {
  it('PR merged + CI green + main green + verifier verdict reads verified, all gates green, no verb', async () => {
    const id = await seed([verifiedStep()])
    const p = await get(id)
    expect(p.derived.steps[0].gates).toEqual({
      pr: 'green',
      ci: 'green',
      main: 'green',
      verifier: 'green',
      checks: 'na'
    })
    expect(p.derived.steps[0].prNumber).toBe(8)
    expect(p.derived.progress.states['stp-1']).toBe('verified')
    expect(p.youItems.some((i) => i.kind === 'main-red')).toBe(false)
  })

  it('a red main after merge downgrades nothing stored but lands a you item', async () => {
    h.main = () => mainOf({ 8: 'failing' })
    const id = await seed([verifiedStep()])
    const before = await rawOf(id)
    const p = await get(id)
    expect(p.derived.steps[0].gates.main).toBe('red')
    // Nothing is downgraded: the step still reads verified, and the file is untouched.
    expect(p.derived.progress.states['stp-1']).toBe('verified')
    expect(await rawOf(id)).toBe(before)
    expect(p.youItems).toContainEqual({ kind: 'main-red', stepId: 'stp-1', pr: 8 })
    expect(p.you).toContain('main is red after #8')
  })

  it('a main-red item needs a done step: an open PR never raises one', async () => {
    h.join = () => joinOf([pr(8, 'OPEN', 'failing')])
    h.main = () => mainOf({ 8: 'failing' })
    const id = await seed([step('stp-1', { links: [prLink(8)] })])
    const p = await get(id)
    expect(p.derived.steps[0].gates).toMatchObject({ pr: 'running', ci: 'red', main: 'off' })
    expect(p.youItems.some((i) => i.kind === 'main-red')).toBe(false)
  })
})

describe('AC-1b — gates exist on every read, and stay last-known when GitHub is unreachable', () => {
  it('every step carries the five keys, even with no links', async () => {
    const id = await seed([step('stp-1')])
    const p = await get(id)
    for (const s of p.derived.steps) {
      expect(Object.keys(s.gates).sort()).toEqual([...GATE_NAMES].sort())
      for (const name of GATE_NAMES) {
        expect(['green', 'red', 'running', 'off', 'na']).toContain(s.gates[name])
      }
    }
  })

  it('keeps the last known gates with stale: true while gh is unreachable', async () => {
    const id = await seed([verifiedStep()])
    const live = await get(id)
    expect(live.derived.steps[0].gates.stale).toBeUndefined()
    h.join = () => joinOf([pr(8, 'MERGED', 'passing')], false)
    h.main = () => mainOf({}, false)
    const down = await get(id)
    expect(down.derived.steps[0].gates).toEqual({
      pr: 'green',
      ci: 'green',
      main: 'green',
      verifier: 'green',
      checks: 'na',
      stale: true
    })
  })

  it('a contrary live observation replaces the last-known value', async () => {
    const id = await seed([verifiedStep()])
    await get(id)
    h.main = () => mainOf({ 8: 'failing' })
    const p = await get(id)
    expect(p.derived.steps[0].gates.main).toBe('red')
    expect(p.derived.steps[0].gates.stale).toBeUndefined()
  })
})

describe('AC-R — reads never write the mission file', () => {
  it('N consecutive mission_get reads leave the file byte-identical (updatedAt unchanged)', async () => {
    const id = await seed([verifiedStep()])
    const before = await rawOf(id)
    for (let i = 0; i < 5; i++) await get(id)
    expect(await rawOf(id)).toBe(before)
  })
})
