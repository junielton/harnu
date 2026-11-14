/**
 * Missions v4 S-3 (R-25, AC-4) — deriving a mission view writes nothing.
 *
 * `deriveMission` (src/main/missions/derive.ts) is a read: it may look at the file, git, `gh`
 * and the sessions, and it returns what it saw. The file bytes and `updatedAt` stay the same, no
 * steward is woken, no row is appended to the sidecar and no sticky fact is remembered. What a
 * read learned is handed back as a `MissionObservation`, and only the observer
 * (src/main/missions/observer.ts) acts on it.
 *
 * Run for real against a throwaway git repo; only the live sources are faked at their module
 * seams (the hook FSM, the PTY set, hibernation, the Approval Inbox, the `gh`-backed PR join and
 * the steward wake).
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
import type { MissionPrJoin } from '../src/main/pr-stack'

const h = vi.hoisted(() => ({
  userDataDir: '',
  wakes: [] as Array<[string, string]>,
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

vi.mock('../src/main/scheduler-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/scheduler-shell')>()),
  wakeStewardForMission: async (missionId: string, reason: string) => {
    h.wakes.push([missionId, reason])
    return { woke: true }
  }
}))

function prEntry(number: number, state: 'OPEN' | 'MERGED', ci: string): unknown {
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
    nodeId: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    ...(state === 'MERGED' ? { mergedAt: '2026-11-02T10:00:00.000Z' } : {})
  }
}

vi.mock('../src/main/pr-stack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/pr-stack')>()),
  findPrsForWorktrees: async (
    _repo: string,
    refs: { numbers: readonly number[] }
  ): Promise<MissionPrJoin> => {
    h.joinCalls++
    const numbers: MissionPrJoin['numbers'] = {}
    for (const n of refs.numbers) {
      numbers[n] = (
        n === 7 ? prEntry(7, 'OPEN', 'passing') : prEntry(8, 'MERGED', 'passing')
      ) as MissionPrJoin['numbers'][number]
    }
    return { ghAvailable: true, worktrees: {}, branches: {}, numbers }
  }
}))

const OWNER = '11111111-2222-4333-8444-555555555555'
const CHILD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const MISSION_ID = 'mnt-0000000a'

let root = ''

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
    title: kind === 'fixed-end' ? 'Delivered and verified' : `Step ${n}`,
    verification,
    proof: 'unproven',
    links,
    blockers: []
  }
}

/** An active mission whose steps link an open PR, a merged PR and a child session. */
async function seed(): Promise<{ mission: Mission; log: string; file: string }> {
  const at = '2026-11-01T09:00:00.000Z'
  const mission: Mission = {
    id: MISSION_ID,
    slug: 'pure-read',
    folder: root,
    owner: { sessionId: OWNER, folder: root },
    status: 'active',
    declaredEnd: { kind: 'code', target: 't', evidence: 'e' },
    steps: [
      step('stp-1', 'custom', 'existence', [
        { kind: 'pr', ref: '#7' },
        { kind: 'session', ref: CHILD }
      ]),
      step('stp-2', 'custom', 'existence', [{ kind: 'pr', ref: '#8' }]),
      step('stp-3', 'fixed-end', 'verifier')
    ],
    blockers: [],
    openQuestions: [],
    createdAt: at,
    updatedAt: at,
    provenance: { author: 'agent', at }
  }
  const log = '# Pure read\n\n## Log\n'
  const file = missionFilePath(root, mission.id, mission.slug)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, buildMissionFileContent(mission, log))
  return { mission, log, file }
}

/** The scoped session projection is the MCP layer's; a read only needs something that answers it. */
const deps = { children: async (): Promise<never[]> => [] }

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-s3-ud-'))
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-s3-repo-')), 'main')
  await fs.mkdir(root)
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  h.wakes = []
  h.joinCalls = 0
  vi.resetModules()
})

describe('mission derive — a read with no side effects (AC-4)', () => {
  it('a read has no side effects', async () => {
    const { mission, log, file } = await seed()
    const before = await fs.readFile(file)
    const beforeStat = await fs.stat(file)
    const { derive } = await loadDerive()
    const cache = await import('../src/main/mission-link-cache')
    await cache.ensureLinkCacheLoaded()

    const reading = await derive(root, mission, log, deps, Date.now())

    // The read really looked: the PRs were joined and the gates computed from them.
    expect(h.joinCalls).toBeGreaterThan(0)
    expect(reading.derived.steps.map((s) => s.prNumber)).toEqual([7, 8, null])
    expect(reading.derived.steps[1].gates.pr).toBe('green')
    // The mission file: same bytes, same `updatedAt`, same mtime.
    expect((await fs.readFile(file)).equals(before)).toBe(true)
    expect((await fs.stat(file)).mtimeMs).toBe(beforeStat.mtimeMs)
    expect(mission.updatedAt).toBe('2026-11-01T09:00:00.000Z')
    // No steward woken.
    expect(h.wakes).toEqual([])
    // No row in the sidecar, and no sticky fact remembered either.
    expect(cache.getObservedLedger(MISSION_ID)).toEqual([])
    expect(cache.getLastKnown(root, 'pr', '8')).toBeNull()
    expect(cache.getLastKnown(root, 'pr', '7')).toBeNull()
    // Nothing else appeared in the repo's data dir or the user data dir.
    expect(await fs.readdir(path.join(root, '.harnu', 'missions'))).toHaveLength(1)
    await new Promise((r) => setTimeout(r, cache.LINK_CACHE_WRITE_DEBOUNCE_MS + 200))
    expect(await fs.readdir(h.userDataDir)).toEqual([])
  })

  it('hands back what it saw instead of recording it', async () => {
    const { mission, log } = await seed()
    const { derive } = await loadDerive()
    const reading = await derive(root, mission, log, deps, Date.now())
    // The sticky sightings and the PR facts the observer needs travel in the reading.
    const sticky = reading.observation.sticky
    expect(sticky).toContainEqual(
      expect.objectContaining({
        op: 'remember',
        kind: 'pr',
        ref: '8',
        seen: expect.objectContaining({ state: 'MERGED' })
      })
    )
    expect(sticky).toContainEqual(
      expect.objectContaining({
        op: 'remember',
        kind: 'pr',
        ref: '7',
        seen: expect.objectContaining({ state: 'OPEN' })
      })
    )
    expect(reading.observation.prByStep.map((p) => p?.facts.number ?? null)).toEqual([7, 8, null])
  })

  it('deriving twice gives the same answer', async () => {
    const { mission, log } = await seed()
    const { derive } = await loadDerive()
    const now = Date.parse('2026-11-01T09:30:00.000Z')
    const a = await derive(root, mission, log, deps, now)
    const b = await derive(root, mission, log, deps, now)
    expect(b.derived).toEqual(a.derived)
  })
})

describe('mission observer — the only writer', () => {
  it('records what a reading saw: sidecar rows, sticky facts, remembered progress, one wake', async () => {
    const { mission, log, file } = await seed()
    const before = await fs.readFile(file)
    const { derive } = await loadDerive()
    const { observeMission, lastKnownProgress } = await import('../src/main/missions/observer')
    const cache = await import('../src/main/mission-link-cache')
    const now = Date.now()
    const reading = await derive(root, mission, log, deps, now)
    expect(lastKnownProgress(MISSION_ID)).toBeUndefined()

    observeMission(mission, reading, now)

    const kinds = cache.getObservedLedger(MISSION_ID).map((r) => `${r.kind}:${r.ref}`)
    expect(kinds).toEqual(expect.arrayContaining(['pr-opened:#7', 'pr-merged:#8', 'ci:#7']))
    expect(cache.getLastKnown(root, 'pr', '8')?.state).toBe('MERGED')
    expect(lastKnownProgress(MISSION_ID)).toEqual(reading.derived.progress)
    // One wake per observation, named for the most specific thing seen.
    expect(h.wakes).toEqual([[MISSION_ID, 'ci']])
    // Even the observer never rewrites the mission file.
    expect((await fs.readFile(file)).equals(before)).toBe(true)
    // The same world observed again records nothing and wakes nobody.
    observeMission(mission, reading, now)
    expect(h.wakes).toHaveLength(1)
  })
})

async function loadDerive(): Promise<
  typeof import('../src/main/missions/derive') & {
    derive: typeof import('../src/main/missions/derive').deriveMission
  }
> {
  const mod = await import('../src/main/missions/derive')
  return { ...mod, derive: mod.deriveMission }
}
