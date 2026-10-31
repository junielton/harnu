/**
 * Campaign ch.3a (T595, spec Amendments (a), operator decision 2026-10-31) — gates now
 * GOVERN `verified`: a step whose stored proof is `verified` reads `done` — not `verified` —
 * while any applicable gate is `red` or `running`. Applicable = not `off`, not `na`. The
 * `checks` gate applies only when the step has checks. A step with no PR (pr gate `off`) is
 * unchanged. The `verified` count in `derived.progress` follows. (AC-3a.5)
 *
 * Two layers: the pure `computeProgress` rule, and `mission_get` end to end (the handler is
 * what feeds the gates into progress — a pure rule nothing calls would be a green no-op).
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
import type { GateCi, GateName, GateState, StepGates } from '../src/main/mission-gates'
import { computeProgress, type StepSignalsLite } from '../src/main/mission-progress'
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

const NOW = Date.parse('2026-10-31T12:00:00.000Z')
const OWNER = '11111111-2222-4333-8444-555555555555'
const VERIFIER = 'cccccccc-dddd-4eee-8fff-000000000000'

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

const verified = (id: string, over: Partial<MissionStep> = {}): MissionStep =>
  step(id, {
    proof: 'verified',
    verifiedBy: { sessionId: VERIFIER, at: '2026-10-30T09:00:00.000Z', verdict: 'met' },
    ...over
  })

const GREEN: StepGates = {
  pr: 'green',
  ci: 'green',
  main: 'green',
  verifier: 'green',
  checks: 'na'
}
const gates = (over: Partial<Record<GateName, GateState>> = {}): StepGates => ({
  ...GREEN,
  ...over
})

function signal(stepId: string, g?: StepGates): StepSignalsLite {
  return { stepId, children: [], existenceProven: false, ...(g ? { gates: g } : {}) }
}

const mission = (steps: MissionStep[]): Pick<Mission, 'steps' | 'owner'> => ({
  steps,
  owner: { sessionId: OWNER, folder: '/x' }
})

describe('AC-3a.5 — the rule, pure', () => {
  it('a verified step with every applicable gate green still reads verified', () => {
    const p = computeProgress(mission([verified('stp-1')]), [signal('stp-1', GREEN)], NOW)
    expect(p.states['stp-1']).toBe('verified')
    expect(p.verified).toBe(1)
  })

  it.each<[GateName, GateState]>([
    ['pr', 'running'], // PR still open
    ['pr', 'red'], // PR closed unmerged
    ['ci', 'running'],
    ['ci', 'red'],
    ['main', 'running'],
    ['main', 'red'],
    ['verifier', 'running'],
    ['verifier', 'red']
  ])('a verified step reads done while its %s gate is %s', (gate, state) => {
    const p = computeProgress(
      mission([verified('stp-1')]),
      [signal('stp-1', gates({ [gate]: state }))],
      NOW
    )
    expect(p.states['stp-1']).toBe('done')
  })

  it.each<[GateName, GateState]>([
    ['pr', 'off'],
    ['ci', 'off'],
    ['main', 'off'],
    ['main', 'na'],
    ['verifier', 'na'],
    ['verifier', 'off'],
    ['checks', 'na']
  ])('a %s gate that is %s is not applicable and does not hold verified back', (gate, state) => {
    const p = computeProgress(
      mission([verified('stp-1')]),
      [signal('stp-1', gates({ [gate]: state }))],
      NOW
    )
    expect(p.states['stp-1']).toBe('verified')
  })

  it('a step with no PR (every PR-derived gate off) is unchanged: verified', () => {
    const noPr = gates({ pr: 'off', ci: 'off', main: 'off', checks: 'na' })
    const p = computeProgress(mission([verified('stp-1')]), [signal('stp-1', noPr)], NOW)
    expect(p.states['stp-1']).toBe('verified')
  })

  it('the checks gate applies only when the step HAS checks', () => {
    const open = gates({ checks: 'running' })
    const withoutChecks = computeProgress(
      mission([verified('stp-1')]),
      [signal('stp-1', open)],
      NOW
    )
    expect(withoutChecks.states['stp-1']).toBe('verified')

    const checks = [
      {
        id: 'chk-1',
        label: 'Validated visually',
        source: 'agent' as const,
        createdAt: '2026-10-30T00:00:00.000Z'
      }
    ]
    const withChecks = computeProgress(
      mission([verified('stp-1', { checks })]),
      [signal('stp-1', open)],
      NOW
    )
    expect(withChecks.states['stp-1']).toBe('done')

    const ticked = computeProgress(
      mission([
        verified('stp-1', {
          checks: [{ ...checks[0], ticked: { at: '2026-10-30T01:00:00.000Z' } }]
        })
      ]),
      [signal('stp-1', gates({ checks: 'green' }))],
      NOW
    )
    expect(ticked.states['stp-1']).toBe('verified')
  })

  it('a step with no gates in its signals (none derived yet) is unchanged', () => {
    const p = computeProgress(mission([verified('stp-1')]), [signal('stp-1')], NOW)
    expect(p.states['stp-1']).toBe('verified')
  })

  it('gates never UPGRADE: an unproven step with all-green gates is not verified', () => {
    const p = computeProgress(mission([step('stp-1')]), [signal('stp-1', GREEN)], NOW)
    expect(p.states['stp-1']).toBe('todo')
  })

  it('the verified count and done count follow: gated steps count as done, not verified', () => {
    const p = computeProgress(
      mission([verified('stp-1'), verified('stp-2'), verified('stp-3')]),
      [
        signal('stp-1', GREEN),
        signal('stp-2', gates({ ci: 'running' })),
        signal('stp-3', gates({ main: 'red' }))
      ],
      NOW
    )
    expect(p.states).toEqual({ 'stp-1': 'verified', 'stp-2': 'done', 'stp-3': 'done' })
    expect(p.verified).toBe(1)
    expect(p.done).toBe(3)
    expect(p.allDone).toBe(true)
  })

  it('a side step is gated the same way, and stays out of the headline', () => {
    const side = verified('stp-2', { required: false })
    const p = computeProgress(
      mission([verified('stp-1'), side]),
      [signal('stp-1', GREEN), signal('stp-2', gates({ pr: 'running' }))],
      NOW
    )
    expect(p.states['stp-2']).toBe('done')
    expect(p.verified).toBe(1)
    expect(p.total).toBe(1)
  })
})

// ---- end to end through mission_get ------------------------------------------

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

let root = ''
let handlers: Record<string, Handler>
let seq = 0

function pr(
  number: number,
  state: 'OPEN' | 'MERGED' | 'CLOSED',
  ci: GateCi
): Record<string, unknown> {
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

function joinOf(prs: Array<Record<string, unknown>>): MissionPrJoin {
  const numbers: Record<number, unknown> = {}
  for (const p of prs) numbers[p.number as number] = p
  return { ghAvailable: true, worktrees: {}, branches: {}, numbers } as unknown as MissionPrJoin
}

const mainOf = (byNumber: Record<number, GateCi | null>): unknown => ({
  ghAvailable: true,
  byNumber
})

async function seed(steps: MissionStep[]): Promise<string> {
  seq++
  const id = `mnt-${(0xa0 + seq).toString(16).padStart(8, '0')}`
  const at = new Date().toISOString()
  const m: Mission = {
    id,
    slug: `gov-${seq}`,
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
    provenance: { author: 'agent', at }
  }
  await fs.mkdir(path.dirname(missionFilePath(root, id, m.slug)), { recursive: true })
  await fs.writeFile(
    missionFilePath(root, id, m.slug),
    buildMissionFileContent(m, '# Seeded\n\n## Log\n')
  )
  return id
}

interface GetAck {
  derived: { progress: { states: Record<string, string>; verified: number; done: number } }
}

async function get(id: string): Promise<GetAck> {
  const res = await handlers.mission_get(
    { folder: root, missionId: id },
    { folder: root, folders: [], denyFolders: [], bridge: undefined }
  )
  expect(res.isError, res.content[0]?.text).not.toBe(true)
  return JSON.parse(res.content[0].text!) as GetAck
}

const prStep = (): MissionStep => verified('stp-1', { links: [{ kind: 'pr', ref: '#8' }] })

describe('AC-3a.5 — mission_get feeds the derived gates into progress', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-govern-ud-'))
    root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-govern-repo-')), 'main')
    await fs.mkdir(root)
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    h.join = () => joinOf([pr(8, 'MERGED', 'passing')])
    h.main = () => mainOf({ 8: 'passing' })
    vi.resetModules()
    const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
    handlers = Object.fromEntries(WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
  })

  it('merged PR + CI green + main green + verifier verdict reads verified (the facts are all green)', async () => {
    const p = await get(await seed([prStep()]))
    expect(p.derived.progress.states['stp-1']).toBe('verified')
    expect(p.derived.progress.verified).toBe(1)
  })

  it('a red main after merge: the stored proof stays verified, the step now READS done', async () => {
    h.main = () => mainOf({ 8: 'failing' })
    const p = await get(await seed([prStep()]))
    expect(p.derived.progress.states['stp-1']).toBe('done')
    expect(p.derived.progress.verified).toBe(0)
    expect(p.derived.progress.done).toBe(1)
  })

  it('an open PR with CI running: verified-by-verdict reads done until the facts are green', async () => {
    h.join = () => joinOf([pr(8, 'OPEN', 'pending')])
    const p = await get(await seed([prStep()]))
    expect(p.derived.progress.states['stp-1']).toBe('done')
  })

  it('the merge-commit CI not known yet (main gate off) does not hold a merged, green step back', async () => {
    h.main = () => mainOf({ 8: null })
    const p = await get(await seed([prStep()]))
    expect(p.derived.progress.states['stp-1']).toBe('verified')
  })

  it('a verified step with no PR link is unchanged', async () => {
    const p = await get(await seed([verified('stp-1')]))
    expect(p.derived.progress.states['stp-1']).toBe('verified')
  })

  it('the stored proof is untouched: reading never downgrades the file', async () => {
    h.main = () => mainOf({ 8: 'failing' })
    const id = await seed([prStep()])
    const dir = path.join(root, '.harnu', 'missions')
    const file = path.join(
      dir,
      (await fs.readdir(dir)).find((n) => n.startsWith(`${id}-`))!
    )
    const before = await fs.readFile(file, 'utf8')
    await get(id)
    expect(await fs.readFile(file, 'utf8')).toBe(before)
    expect(before).toContain('proof: verified')
  })
})
