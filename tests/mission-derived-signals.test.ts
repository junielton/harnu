/**
 * T358 S6 — `mission_get`'s derived live signals and the deterministic stall
 * rule (design `docs/specs/2026-09-26-mission-progress/design.md` §7, §8).
 *
 * The handler is driven for real against a throwaway git repo; only the live
 * sources are faked at their module seams: the hook FSM (`taskState` + its
 * transition edge), the PTY liveness set, the hibernation registry, the
 * Approval Inbox and the `gh`-backed PR join. Missions are SEEDED on disk with
 * `buildMissionFileContent` — no verb moves a mission to `active` (the operator
 * door lands in S9), and the stall rule is about age, which only a seeded
 * `updatedAt` can set.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildMissionFileContent,
  missionFilePath,
  parseMissionFile,
  readMissionLog,
  type Mission,
  type MissionStep,
  type StepLink
} from '../src/main/mission-core'
import type { TaskState } from '../src/main/hook-state'
import type { HookTaskEvent } from '../src/main/hook-bridge'
import type { MissionPrJoin } from '../src/main/pr-stack'

const h = vi.hoisted(() => ({
  userDataDir: '',
  taskStates: new Map<string, TaskState>(),
  live: new Set<string>(),
  parked: new Set<string>(),
  approvals: [] as Array<{ sessionId: string }>,
  observer: null as ((ev: HookTaskEvent) => void) | null,
  join: null as
    | ((refs: {
        worktrees: readonly string[]
        branches: readonly string[]
        numbers: readonly number[]
      }) => MissionPrJoin)
    | null,
  joinCalls: 0
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
  addTaskEventObserver: (cb: (ev: HookTaskEvent) => void) => {
    h.observer = cb
    return () => {}
  }
}))

vi.mock('../src/main/pty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/pty')>()),
  liveSessionKeys: () => h.live
}))

vi.mock('../src/main/hibernation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/hibernation')>()),
  hibernatedKeys: () => h.parked
}))

vi.mock('../src/main/approval-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/approval-resolver')>()),
  listPendingApprovals: () => h.approvals
}))

vi.mock('../src/main/pr-stack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/pr-stack')>()),
  findPrsForWorktrees: async (
    _repo: string,
    refs: { worktrees: readonly string[]; branches: readonly string[]; numbers: readonly number[] }
  ): Promise<MissionPrJoin> => {
    h.joinCalls++
    if (!h.join) throw new Error('test did not set h.join')
    return h.join(refs)
  }
}))

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

const OWNER = '11111111-2222-4333-8444-555555555555'
const CHILD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CHILD2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const GHOST = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const HOUR = 60 * 60 * 1000

function payloadOf(res: ToolResult): Record<string, unknown> {
  expect(res.isError, res.content[0]?.text).not.toBe(true)
  return JSON.parse(res.content[0].text!) as Record<string, unknown>
}

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString()

let root = ''
let handlers: Record<string, Handler>
let seq = 0

function prEntry(number: number, branch: string, state: 'OPEN' | 'MERGED' | 'CLOSED') {
  return {
    number,
    title: `PR ${number}`,
    branch,
    base: 'main',
    state,
    isDraft: false,
    mergeable: null,
    reviewDecision: null,
    ci: 'none',
    checks: [],
    url: `https://example.test/pull/${number}`,
    author: 'dev',
    updatedAt: null,
    headOid: null,
    nodeId: null
  } as unknown as MissionPrJoin['numbers'][number]
}

/** A join that knows one branch (feat/x → PR 7 OPEN) and PR numbers 7/8/9. */
function defaultJoin(refs: {
  worktrees: readonly string[]
  branches: readonly string[]
  numbers: readonly number[]
}): MissionPrJoin {
  const prs = [
    prEntry(7, 'feat/x', 'OPEN'),
    prEntry(8, 'feat/y', 'MERGED'),
    prEntry(9, 'feat/z', 'CLOSED')
  ]
  const worktrees: MissionPrJoin['worktrees'] = {}
  for (const w of refs.worktrees) {
    worktrees[w] = w.includes('missing')
      ? { exists: false, branch: null, head: null, prs: [] }
      : {
          exists: true,
          branch: 'feat/x',
          head: { sha: 'a'.repeat(40), subject: 'child work', at: iso(0) },
          prs: prs.filter((p) => p!.branch === 'feat/x') as never
        }
  }
  const branches: MissionPrJoin['branches'] = {}
  for (const b of refs.branches) branches[b] = prs.filter((p) => p!.branch === b) as never
  const numbers: MissionPrJoin['numbers'] = {}
  for (const n of refs.numbers) numbers[n] = prs.find((p) => p!.number === n) ?? null
  return { ghAvailable: true, worktrees, branches, numbers }
}

function step(
  id: string,
  kind: MissionStep['kind'],
  verification: MissionStep['verification'],
  links: StepLink[] = []
): MissionStep {
  const n = Number(id.slice(4))
  return {
    id,
    ordinal: n,
    kind,
    title:
      kind === 'fixed-start'
        ? 'Scope confirmed'
        : kind === 'fixed-end'
          ? 'Delivered and verified'
          : `Step ${n}`,
    verification,
    proof: 'unproven',
    links,
    blockers: []
  }
}

/** Seed one mission file directly (design §9 format) and return its id. */
async function seed(
  over: Partial<Mission> & { steps?: MissionStep[] },
  log = '# Seeded\n\n## Log\n'
): Promise<string> {
  seq++
  const id = `mnt-${seq.toString(16).padStart(8, '0')}`
  const at = over.updatedAt ?? iso(0)
  const mission: Mission = {
    id,
    slug: `seeded-${seq}`,
    folder: root,
    owner: { sessionId: OWNER, folder: root },
    status: 'active',
    declaredEnd: { kind: 'code', target: 't', evidence: 'e' },
    steps: [step('stp-1', 'fixed-start', 'existence'), step('stp-2', 'fixed-end', 'verifier')],
    blockers: [],
    openQuestions: [],
    createdAt: at,
    updatedAt: at,
    provenance: { author: 'agent', at },
    ...over
  }
  await fs.mkdir(path.dirname(missionFilePath(root, id, mission.slug)), { recursive: true })
  await fs.writeFile(missionFilePath(root, id, mission.slug), buildMissionFileContent(mission, log))
  return id
}

async function onDisk(id: string): Promise<{ mission: Mission; raw: string }> {
  const dir = path.join(root, '.harnu', 'missions')
  const name = (await fs.readdir(dir)).find((n) => n.startsWith(`${id}-`))!
  const raw = await fs.readFile(path.join(dir, name), 'utf8')
  return { mission: parseMissionFile(raw) as Mission, raw }
}

/** A scanned folder row carrying the given sessions (what `ctx.folders` holds). */
function folderWith(ids: string[]): Record<string, unknown> {
  return {
    path: root,
    sessions: ids.map((sessionId) => ({
      sessionId,
      projectPath: root,
      status: 'idle',
      isSidechain: false,
      modified: iso(3 * HOUR),
      firstPrompt: 'SECRET PROMPT',
      summary: ''
    }))
  }
}

function ctx(ids: string[] = [CHILD, CHILD2]): Record<string, unknown> {
  return { folder: root, folders: [folderWith(ids)], denyFolders: [], bridge: undefined }
}

/** The slice of `mission_get`'s ACK these tests read. */
interface GetAck {
  mission: Mission
  you: string
  derived: {
    live: boolean
    computedAt: string
    stale: boolean
    stall: { lastEvidenceAt: string; thresholdMs: number; workingSessions: string[] }
    gh: string
    pendingApprovals: number
    steps: Array<{
      stepId: string
      children: Array<{ sessionId: string; pendingApprovals: number } & Record<string, unknown>>
      links: Array<Record<string, unknown>>
      existence: { proven: boolean; reason?: string } | null
    }>
  }
}

async function get(id: string, c = ctx()): Promise<GetAck> {
  return payloadOf(
    await handlers.mission_get({ folder: root, missionId: id }, c)
  ) as unknown as GetAck
}

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-s6-ud-'))
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-s6-repo-')), 'main')
  await fs.mkdir(root)
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  h.taskStates = new Map()
  h.live = new Set()
  h.parked = new Set()
  h.approvals = []
  h.join = defaultJoin
  h.joinCalls = 0
  vi.resetModules()
  const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
  handlers = Object.fromEntries(WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
})

// ---- AC-S6-1: design §7's computed shape -----------------------------------------

describe('mission_get — derived live signals (design §7)', () => {
  it('computes the derived block for real — no S3 stub left', async () => {
    const id = await seed({})
    const p = await get(id)
    expect(p.derived.live).toBe(true)
    expect(Number.isFinite(Date.parse(p.derived.computedAt))).toBe(true)
    expect(p.derived.stale).toBe(false)
    expect(p.derived.stall).toMatchObject({ thresholdMs: HOUR, workingSessions: [] })
    expect(p.derived.gh).toBe('not-needed')
    expect(p.derived.pendingApprovals).toBe(0)
    expect(p.derived.steps).toEqual([
      {
        stepId: 'stp-1',
        children: [],
        links: [],
        existence: { proven: false, reason: expect.any(String) }
      },
      { stepId: 'stp-2', children: [], links: [], existence: null }
    ])
    expect(h.joinCalls).toBe(0) // nothing to join → gh never asked
  })

  it("reports each session link's live child state from the scoped projection", async () => {
    h.taskStates.set(CHILD, 'working')
    h.live = new Set([CHILD, CHILD2])
    h.parked = new Set([CHILD2])
    const id = await seed({
      steps: [
        step('stp-1', 'fixed-start', 'existence'),
        step('stp-3', 'custom', 'verifier', [
          { kind: 'session', ref: CHILD },
          { kind: 'session', ref: GHOST }
        ]),
        step('stp-2', 'fixed-end', 'verifier', [{ kind: 'session', ref: CHILD2 }])
      ]
    })
    const p = await get(id, ctx([CHILD, CHILD2, 'cccccccc-0000-4000-8000-000000000000']))
    const [, custom, end] = p.derived.steps
    expect(custom.children).toEqual([
      expect.objectContaining({ sessionId: CHILD, known: true, taskState: 'working' }),
      { sessionId: GHOST, known: false, pendingApprovals: 0 }
    ])
    expect(end.children).toEqual([
      expect.objectContaining({ sessionId: CHILD2, known: true, hibernated: true })
    ])
    // scoped: the unlinked third session never appears, nor any transcript text
    const text = JSON.stringify(p.derived)
    expect(text).not.toContain('cccccccc-0000')
    expect(text).not.toContain('SECRET')
  })

  it('surfaces pending approvals of linked children and puts them on the you line', async () => {
    h.approvals = [{ sessionId: CHILD }, { sessionId: CHILD }, { sessionId: GHOST }]
    const id = await seed({
      steps: [
        step('stp-1', 'fixed-start', 'existence'),
        step('stp-2', 'fixed-end', 'verifier', [{ kind: 'session', ref: CHILD }])
      ]
    })
    const p = await get(id)
    expect(p.derived.pendingApprovals).toBe(2)
    expect(p.derived.steps[1].children[0].pendingApprovals).toBe(2)
    expect(p.you).toMatch(/2 pending approval/)
    expect(p.you).toContain(CHILD.slice(0, 8))
  })

  it('a linked child sitting on a permission prompt is owed by the operator too', async () => {
    h.taskStates.set(CHILD, 'needs-input')
    h.live = new Set([CHILD])
    const id = await seed({
      steps: [
        step('stp-1', 'fixed-start', 'existence'),
        step('stp-2', 'fixed-end', 'verifier', [{ kind: 'session', ref: CHILD }])
      ]
    })
    expect((await get(id)).you).toMatch(/waiting on you/)
  })

  it('joins worktree / card / pr links to commits and PRs through ONE pr-stack call', async () => {
    const wt = path.join(root, 'wt-live')
    await fs.mkdir(wt)
    await fs.mkdir(path.join(root, '.harnu', 'memory', 'roadmap'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.harnu', 'memory', 'roadmap', 'T1-card.md'),
      '---\nid: T1\ntitle: Card\nstatus: review\nexecutedIn: feat/y\n---\nbody\n'
    )
    const id = await seed({
      steps: [
        step('stp-1', 'fixed-start', 'existence'),
        step('stp-3', 'custom', 'verifier', [
          { kind: 'worktree', ref: wt },
          { kind: 'card', ref: 'T1-card' },
          { kind: 'pr', ref: 'org/proj#8' }
        ]),
        step('stp-2', 'fixed-end', 'verifier')
      ]
    })
    const p = await get(id)
    expect(h.joinCalls).toBe(1)
    expect(p.derived.gh).toBe('available')
    const links = p.derived.steps[1].links
    expect(links[0]).toMatchObject({
      kind: 'worktree',
      ref: wt,
      exists: true,
      branch: 'feat/x',
      head: { subject: 'child work' },
      prs: [{ number: 7, state: 'OPEN' }]
    })
    expect(links[1]).toMatchObject({
      kind: 'card',
      ref: 'T1-card',
      exists: true,
      status: 'review',
      executedIn: 'feat/y',
      prs: [{ number: 8, state: 'MERGED' }]
    })
    expect(links[2]).toMatchObject({
      kind: 'pr',
      ref: 'org/proj#8',
      number: 8,
      exists: true,
      state: 'MERGED'
    })
  })

  it("carries each PR's base branch on pr links and PR summaries (Mission v2 §3.6, AC-8)", async () => {
    const stacked = { ...prEntry(5, 'feat/x', 'MERGED'), base: 'stack/w2-base' }
    h.join = (refs) => {
      const worktrees: MissionPrJoin['worktrees'] = {}
      for (const w of refs.worktrees) {
        worktrees[w] = {
          exists: true,
          branch: 'feat/x',
          head: { sha: 'a'.repeat(40), subject: 'child work', at: iso(0) },
          prs: [stacked] as never
        }
      }
      const branches: MissionPrJoin['branches'] = {}
      for (const b of refs.branches) branches[b] = [stacked] as never
      const numbers: MissionPrJoin['numbers'] = {}
      for (const n of refs.numbers) numbers[n] = n === 5 ? stacked : null
      return { ghAvailable: true, worktrees, branches, numbers }
    }
    const wt = path.join(root, 'wt-stacked')
    await fs.mkdir(wt)
    await fs.mkdir(path.join(root, '.harnu', 'memory', 'roadmap'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.harnu', 'memory', 'roadmap', 'T2-card.md'),
      '---\nid: T2\ntitle: Card\nstatus: review\nexecutedIn: feat/x\n---\nbody\n'
    )
    const id = await seed({
      steps: [
        step('stp-1', 'fixed-start', 'existence'),
        step('stp-3', 'custom', 'verifier', [
          { kind: 'pr', ref: '#5' },
          { kind: 'worktree', ref: wt },
          { kind: 'card', ref: 'T2-card' }
        ]),
        step('stp-2', 'fixed-end', 'verifier')
      ]
    })
    const links = (await get(id)).derived.steps[1].links
    expect(links[0]).toMatchObject({ kind: 'pr', number: 5, baseRefName: 'stack/w2-base' })
    expect(links[1]).toMatchObject({
      kind: 'worktree',
      prs: [{ number: 5, baseRefName: 'stack/w2-base' }]
    })
    expect(links[2]).toMatchObject({
      kind: 'card',
      prs: [{ number: 5, baseRefName: 'stack/w2-base' }]
    })
  })

  it('an unknown PR carries no baseRefName', async () => {
    const id = await seed({
      steps: [
        step('stp-1', 'fixed-start', 'existence'),
        step('stp-3', 'custom', 'verifier', [{ kind: 'pr', ref: '#404' }]),
        step('stp-2', 'fixed-end', 'verifier')
      ]
    })
    const link = (await get(id)).derived.steps[1].links[0]
    expect(link).toMatchObject({ kind: 'pr', number: 404, exists: false })
    expect(link).not.toHaveProperty('baseRefName')
  })
})

// ---- existence proofs (design §1.3, §7) ------------------------------------------

describe('mission_get — existence proofs computed at read time', () => {
  async function existenceOf(links: StepLink[]): Promise<{ proven: boolean; reason?: string }> {
    const id = await seed({
      steps: [
        step('stp-1', 'fixed-start', 'existence', links),
        step('stp-2', 'fixed-end', 'verifier')
      ]
    })
    const p = await get(id)
    // never stored: the file's proof stays whatever it was
    expect((await onDisk(id)).mission.steps[0].proof).toBe('unproven')
    return p.derived.steps[0].existence
  }

  it('file/worktree link: proven when the path exists, not when it is missing', async () => {
    await fs.writeFile(path.join(root, 'spec.md'), '# spec')
    expect((await existenceOf([{ kind: 'worktree', ref: 'spec.md' }])).proven).toBe(true)
    expect(
      (await existenceOf([{ kind: 'worktree', ref: path.join(root, 'missing') }])).proven
    ).toBe(false)
  })

  it('PR link via gh: proven when OPEN or MERGED, not when CLOSED or unknown', async () => {
    expect((await existenceOf([{ kind: 'pr', ref: '#7' }])).proven).toBe(true)
    expect((await existenceOf([{ kind: 'pr', ref: 'https://example.test/pull/8' }])).proven).toBe(
      true
    )
    expect((await existenceOf([{ kind: 'pr', ref: 'org/proj#9' }])).proven).toBe(false)
    expect((await existenceOf([{ kind: 'pr', ref: 'org/proj#404' }])).proven).toBe(false)
  })

  it('PR link with gh absent: unproven with a reason, never an error', async () => {
    h.join = (refs) => ({
      ...defaultJoin(refs),
      ghAvailable: false,
      numbers: Object.fromEntries(refs.numbers.map((n) => [n, null]))
    })
    const e = await existenceOf([{ kind: 'pr', ref: '#7' }])
    expect(e.proven).toBe(false)
    expect(e.reason).toMatch(/gh/)
  })

  it('card link via board read: proven in review/done, not in backlog or when absent', async () => {
    const board = path.join(root, '.harnu', 'memory', 'roadmap')
    await fs.mkdir(board, { recursive: true })
    await fs.writeFile(path.join(board, 'T2-done.md'), '---\nid: T2\ntitle: D\nstatus: done\n---\n')
    await fs.writeFile(
      path.join(board, 'T3-todo.md'),
      '---\nid: T3\ntitle: B\nstatus: backlog\n---\n'
    )
    expect((await existenceOf([{ kind: 'card', ref: 'T2-done' }])).proven).toBe(true)
    expect((await existenceOf([{ kind: 'card', ref: 'T3-todo' }])).proven).toBe(false)
    expect((await existenceOf([{ kind: 'card', ref: 'T9-nope' }])).proven).toBe(false)
  })

  it('every artifact link must resolve; session links are children, not artifacts', async () => {
    await fs.writeFile(path.join(root, 'spec.md'), '# spec')
    expect(
      (
        await existenceOf([
          { kind: 'worktree', ref: 'spec.md' },
          { kind: 'pr', ref: '#9' }
        ])
      ).proven
    ).toBe(false)
    expect((await existenceOf([{ kind: 'session', ref: CHILD }])).proven).toBe(false)
    expect(
      (
        await existenceOf([
          { kind: 'session', ref: CHILD },
          { kind: 'worktree', ref: 'spec.md' }
        ])
      ).proven
    ).toBe(true)
  })
})

// ---- Mission v3 §3.7: sticky proof (AC-7) ---------------------------------------

describe('mission_get — sticky link resolutions (Mission v3 §3.7)', () => {
  const ghDown = (refs: Parameters<NonNullable<typeof h.join>>[0]): MissionPrJoin => ({
    ghAvailable: false,
    worktrees: Object.fromEntries(
      refs.worktrees.map((w) => [w, { ...defaultJoin(refs).worktrees[w], prs: [] }])
    ),
    branches: Object.fromEntries(refs.branches.map((b) => [b, []])),
    numbers: Object.fromEntries(refs.numbers.map((n) => [n, null]))
  })
  /** gh answers, but the PR is not in the recent list (aged past --limit 100). */
  const notFound = (refs: Parameters<NonNullable<typeof h.join>>[0]): MissionPrJoin => ({
    ...defaultJoin(refs),
    numbers: Object.fromEntries(refs.numbers.map((n) => [n, null]))
  })
  const withPr = (links: StepLink[]): Promise<string> =>
    seed({
      steps: [
        step('stp-1', 'fixed-start', 'existence'),
        step('stp-3', 'custom', 'existence', links),
        step('stp-2', 'fixed-end', 'verifier')
      ]
    })
  const stepOf = async (
    id: string
  ): Promise<{
    existence: { proven: boolean; reason?: string } | null
    link: Record<string, unknown>
  }> => {
    const s = (await get(id)).derived.steps[1]
    return { existence: s.existence, link: s.links[0] }
  }
  const sidecar = (): string => path.join(h.userDataDir, 'mission-link-cache.json')
  const linkCache = (): Promise<typeof import('../src/main/mission-link-cache')> =>
    import('../src/main/mission-link-cache')

  it('(c) a PR link resolved OPEN, then gh unreachable: still proven, stale: true', async () => {
    const id = await withPr([{ kind: 'pr', ref: '#7' }])
    const live = await stepOf(id)
    expect(live.existence?.proven).toBe(true)
    expect(live.link).not.toHaveProperty('stale')
    h.join = ghDown
    const after = await stepOf(id)
    expect(after.existence).toEqual({ proven: true })
    expect(after.link).toMatchObject({
      kind: 'pr',
      number: 7,
      exists: true,
      state: 'OPEN',
      stale: true
    })
    expect(after.link.url).toBe('https://example.test/pull/7')
  })

  it('(c) the last-known state survives a restart through the userData sidecar', async () => {
    const id = await withPr([{ kind: 'pr', ref: '#8' }])
    expect((await stepOf(id)).existence?.proven).toBe(true)
    await (await linkCache()).flushLinkCache()
    expect(await fs.readFile(sidecar(), 'utf8')).toContain('"MERGED"')
    vi.resetModules()
    const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
    handlers = Object.fromEntries(WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
    h.join = ghDown
    const after = await stepOf(id)
    expect(after.existence?.proven).toBe(true)
    expect(after.link).toMatchObject({ state: 'MERGED', stale: true })
  })

  it('(d) a PR not found after it was seen merged stays proven (unknown, never a downgrade)', async () => {
    const id = await withPr([{ kind: 'pr', ref: 'org/proj#8' }])
    expect((await stepOf(id)).existence?.proven).toBe(true)
    h.join = notFound
    const after = await stepOf(id)
    expect(after.existence?.proven).toBe(true)
    expect(after.link).toMatchObject({ exists: true, state: 'MERGED', stale: true })
  })

  it('(e) a cold cache + gh unreachable: unproven + stale, and nothing is written to the sidecar', async () => {
    h.join = ghDown
    const id = await withPr([{ kind: 'pr', ref: '#7' }])
    const cold = await stepOf(id)
    expect(cold.existence?.proven).toBe(false)
    expect(cold.existence?.reason).toMatch(/gh/)
    expect(cold.link).toMatchObject({ kind: 'pr', number: 7, exists: false, stale: true })
    // A not-found PR on a cold cache is unknown too.
    h.join = notFound
    expect((await stepOf(id)).link).toMatchObject({ exists: false, stale: true })
    await (await linkCache()).flushLinkCache()
    await expect(fs.stat(sidecar())).rejects.toThrow()
  })

  it('(f) a PR closed unmerged downgrades — and is forgotten, so a later outage reads unproven', async () => {
    const id = await withPr([{ kind: 'pr', ref: '#7' }])
    expect((await stepOf(id)).existence?.proven).toBe(true)
    h.join = (refs) => {
      const j = defaultJoin(refs)
      return { ...j, numbers: { ...j.numbers, 7: prEntry(7, 'feat/x', 'CLOSED') } }
    }
    const closed = await stepOf(id)
    expect(closed.existence?.proven).toBe(false)
    expect(closed.link).toMatchObject({ state: 'CLOSED', exists: false })
    expect(closed.link).not.toHaveProperty('stale')
    h.join = ghDown
    const later = await stepOf(id)
    expect(later.existence?.proven).toBe(false)
    expect(later.link).toMatchObject({ exists: false, stale: true })
  })

  it('a worktree removed from disk whose branch has a known merged PR stays proven', async () => {
    const wt = path.join(root, 'wt-merged')
    await fs.mkdir(wt)
    h.join = (refs) => ({
      ...defaultJoin(refs),
      worktrees: Object.fromEntries(
        refs.worktrees.map((w) => [
          w,
          {
            exists: true,
            branch: 'feat/y',
            head: null,
            prs: [prEntry(8, 'feat/y', 'MERGED')] as never
          }
        ])
      )
    })
    const id = await withPr([{ kind: 'worktree', ref: wt }])
    expect((await stepOf(id)).existence?.proven).toBe(true)
    await fs.rm(wt, { recursive: true })
    h.join = defaultJoin
    const after = await stepOf(id)
    expect(after.existence?.proven).toBe(true)
    expect(after.link).toMatchObject({
      kind: 'worktree',
      exists: false,
      branch: 'feat/y',
      mergedPr: 8,
      stale: true
    })
  })

  it('a worktree removed from disk with no merged PR known is unproven (a contrary observation)', async () => {
    const wt = path.join(root, 'wt-open')
    await fs.mkdir(wt)
    const id = await withPr([{ kind: 'worktree', ref: wt }]) // default join: feat/x, PR 7 OPEN
    expect((await stepOf(id)).existence?.proven).toBe(true)
    await fs.rm(wt, { recursive: true })
    const after = await stepOf(id)
    expect(after.existence?.proven).toBe(false)
    expect(after.link).toMatchObject({ exists: false })
    expect(after.link).not.toHaveProperty('stale')
  })

  it('(g) 10 consecutive reads leave the mission file byte-identical (updatedAt included)', async () => {
    const wt = path.join(root, 'wt-g')
    await fs.mkdir(wt)
    const id = await withPr([
      { kind: 'pr', ref: '#7' },
      { kind: 'worktree', ref: wt }
    ])
    const before = await onDisk(id)
    for (let i = 0; i < 10; i++) {
      h.join = i % 2 === 0 ? defaultJoin : ghDown
      await get(id)
    }
    const after = await onDisk(id)
    expect(after.raw).toBe(before.raw)
    expect(after.mission.updatedAt).toBe(before.mission.updatedAt)
  })
})

// ---- AC-S6-2: the stall rule (design §8) -----------------------------------------

describe('mission_get — deterministic stall detection (design §8)', () => {
  const linked = (ref = CHILD): MissionStep[] => [
    step('stp-1', 'fixed-start', 'existence'),
    step('stp-2', 'fixed-end', 'verifier', [{ kind: 'session', ref }])
  ]

  it('flags stale when lastEvidenceAt is over 1h old and every linked session is not working', async () => {
    h.taskStates.set(CHILD, 'idle')
    h.live = new Set([CHILD])
    const at = iso(2 * HOUR)
    const id = await seed({ updatedAt: at, steps: linked() })
    const before = (await onDisk(id)).raw
    const p = await get(id)
    expect(p.derived.stale).toBe(true)
    expect(p.derived.stall).toMatchObject({ stale: true, lastEvidenceAt: at, workingSessions: [] })
    // design §3: `active ↔ stale` is derived only — a read never writes it back
    expect(p.mission.status).toBe('active')
    expect((await onDisk(id)).raw).toBe(before)
    expect((await get(id)).derived.stale).toBe(true)
    expect((await onDisk(id)).raw).toBe(before)
  })

  it("a stale-by-rule mission still exempts its owner from hibernation (S2's predicate)", async () => {
    h.taskStates.set(CHILD, 'idle')
    h.live = new Set([CHILD])
    const id = await seed({ updatedAt: iso(2 * HOUR), steps: linked() })
    expect((await get(id)).derived.stale).toBe(true)
    const { missionOwnersWithLiveChildren } = await import('../src/main/hibernation')
    const owners = missionOwnersWithLiveChildren([
      { sessionKey: OWNER, cwd: root },
      { sessionKey: CHILD, cwd: root }
    ])
    expect([...owners]).toEqual([OWNER])
  })

  it('does not mark stale when any linked session is working, regardless of evidence age', async () => {
    h.taskStates.set(CHILD, 'working')
    h.live = new Set([CHILD])
    const id = await seed({ updatedAt: iso(30 * HOUR), steps: linked() })
    const p = await get(id)
    expect(p.derived.stale).toBe(false)
    expect(p.derived.stall.workingSessions).toEqual([CHILD])
    expect(p.mission.status).toBe('active')
    expect((await onDisk(id)).mission.status).toBe('active')
  })

  it('a working session that is NOT linked does not hold the mission active', async () => {
    h.taskStates.set(CHILD2, 'working')
    h.live = new Set([CHILD2])
    const id = await seed({ updatedAt: iso(2 * HOUR), steps: linked() })
    expect((await get(id)).derived.stale).toBe(true)
  })

  it('is not stale at or under the 1h threshold', async () => {
    const id = await seed({ updatedAt: iso(HOUR - 60_000), steps: linked() })
    expect((await get(id)).derived.stale).toBe(false)
  })

  it('applies only to an active mission — delivered never goes stale', async () => {
    const delivered = await seed({ status: 'delivered', updatedAt: iso(5 * HOUR) })
    const p = await get(delivered)
    expect(p.mission.status).toBe('delivered')
    expect(p.derived.stale).toBe(false)
  })

  it('Mission v3 §3.4: a dead legacy draft reads active, and therefore stale', async () => {
    const draft = await seed({ status: 'draft', updatedAt: iso(5 * HOUR) })
    const p = await get(draft)
    expect(p.mission.status).toBe('active')
    expect(p.derived.stale).toBe(true)
  })

  it('counts a mission_log timestamp as evidence', async () => {
    const log = `# Seeded\n\n## Log\n\n### ${iso(10 * 60_000)} · stp-2\n\nchild reported in\n`
    const id = await seed({ updatedAt: iso(3 * HOUR), steps: linked() }, log)
    expect((await get(id)).derived.stale).toBe(false)
  })

  it("counts a linked session's last taskState transition as evidence", async () => {
    const id = await seed({ updatedAt: iso(3 * HOUR), steps: linked() })
    h.observer!({
      sessionId: CHILD,
      taskState: 'working',
      event: 'UserPromptSubmit',
      ts: Date.now() - 20 * 60_000
    })
    h.observer!({
      sessionId: CHILD,
      taskState: 'idle',
      event: 'Stop',
      ts: Date.now() - 10 * 60_000
    })
    h.taskStates.set(CHILD, 'idle')
    const p = await get(id)
    expect(p.derived.stale).toBe(false)
    expect(Date.parse(p.derived.stall.lastEvidenceAt)).toBeGreaterThan(Date.now() - 11 * 60_000)
    // a repeated event with no state change is not a transition
    h.observer!({ sessionId: CHILD, taskState: 'idle', event: 'Notification', ts: Date.now() })
    expect(Date.parse((await get(id)).derived.stall.lastEvidenceAt)).toBeLessThan(
      Date.now() - 9 * 60_000
    )
  })

  it('the flag clears on the next read once a mission_log entry arrives', async () => {
    const id = await seed({ updatedAt: iso(4 * HOUR), steps: linked() })
    expect((await get(id)).derived.stale).toBe(true)
    payloadOf(
      await handlers.mission_log({ folder: root, missionId: id, note: 'back on it' }, ctx())
    )
    const p = await get(id)
    expect(p.derived.stale).toBe(false)
    expect(p.mission.status).toBe('active')
  })

  it('the flag clears on the next read once a linked session starts working', async () => {
    const id = await seed({ updatedAt: iso(4 * HOUR), steps: linked() })
    expect((await get(id)).derived.stale).toBe(true)
    h.taskStates.set(CHILD, 'working')
    h.live = new Set([CHILD])
    expect((await get(id)).derived.stale).toBe(false)
  })

  it('the Log body is never touched by a stale read', async () => {
    const id = await seed(
      { updatedAt: iso(2 * HOUR), steps: linked() },
      '# Seeded\n\n## Log\nkeep me\n'
    )
    await get(id)
    expect(readMissionLog((await onDisk(id)).raw)).toBe('# Seeded\n\n## Log\nkeep me\n')
  })
})

// ---- AC-S6-3: get_fleet is unchanged ---------------------------------------------

describe('get_fleet — unchanged by the mission projection (AC-S6-3)', () => {
  it('still answers the same { folders, sessions } shape with the same row keys', async () => {
    h.taskStates.set(CHILD, 'working')
    h.live = new Set([CHILD])
    const p = payloadOf(await handlers.get_fleet({}, ctx([CHILD, CHILD2]))) as {
      folders: unknown[]
      sessions: Array<Record<string, unknown>>
    }
    expect(Object.keys(p).sort()).toEqual(['folders', 'sessions'])
    expect(p.folders).toHaveLength(1)
    expect(p.sessions).toHaveLength(2)
    const allowed = new Set([
      'sessionId',
      'folderAlias',
      'taskState',
      'failureReason',
      'status',
      'isSidechain',
      'modified',
      'agentControllable',
      'inflight',
      'orchestrator',
      'peer',
      'hibernated'
    ])
    for (const row of p.sessions) for (const k of Object.keys(row)) expect(allowed).toContain(k)
  })
})
