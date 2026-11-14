/**
 * Missions v4 S-3 (R-25, AC-4) — deriving a mission view writes nothing.
 *
 * `deriveMission` (src/main/missions/derive.ts) is a read: it may look at the file, git, `gh`
 * and the sessions, and it returns what it saw. The file bytes and `updatedAt` stay the same, no
 * steward is woken, no row is appended to the sidecar and no sticky fact is remembered. What a
 * read learned is handed back as a `MissionObservation`, and only the observer
 * (src/main/missions/observer.ts) acts on it.
 *
 * Delta 1: the claim is about every READ, not one function. `mission_get`, `campaign_get`, the
 * renderer list poll (`listMissionViews`, which the companion and Your move ride), the campaign
 * list and the steward bridge's derive all write nothing; the observer pass
 * (`observeOpenMissions`, started by `startMissionObserver`) records what they would have.
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

vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => []
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

// The first import of the handlers pulls in most of the main process.
vi.setConfig({ testTimeout: 30_000 })

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

// ---- Delta 1: every read path is pure; the observer pass records ---------------------------------

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

const CAMPAIGN_ID = 'cmp-0000000b'

/** The handler-facing context: a scanned fleet with no sessions in it. */
const handlerCtx = (): Record<string, unknown> => ({
  folder: root,
  folders: [],
  denyFolders: [],
  bridge: undefined
})

async function seedCampaign(missionId: string): Promise<void> {
  const { buildCampaignFileContent } = await import('../src/main/campaign-core')
  const at = '2026-11-01T09:00:00.000Z'
  const dir = path.join(root, '.harnu', 'campaigns')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${CAMPAIGN_ID}-pure.md`),
    buildCampaignFileContent(
      {
        id: CAMPAIGN_ID,
        slug: 'pure',
        folder: root,
        owner: { sessionId: OWNER, folder: root },
        title: 'Pure',
        declaredEnd: { kind: 'code', target: 't', evidence: 'e' },
        chapters: [{ id: 'chp-1', ordinal: 1, title: 'One', missionId, required: true }],
        status: 'active',
        createdAt: at,
        updatedAt: at,
        provenance: { author: 'agent', at }
      },
      '# Pure\n\n## Log\n'
    )
  )
}

interface ReadPath {
  name: string
  run: (mission: Mission, log: string) => Promise<void>
}

async function readPaths(): Promise<ReadPath[]> {
  const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
  const handlers = Object.fromEntries(
    WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler])
  )
  const ok = (res: ToolResult): void => expect(res.isError, res.content[0]?.text).not.toBe(true)
  const { deriveMissionSignals } = await import('../src/main/mcp/tool-handlers')
  const ipc = await import('../src/main/mission-ipc')
  const campaigns = await import('../src/main/campaign-ipc')
  return [
    {
      name: 'mission_get',
      run: async () =>
        ok(await handlers.mission_get({ folder: root, missionId: MISSION_ID }, handlerCtx()))
    },
    {
      name: 'campaign_get',
      run: async () =>
        ok(await handlers.campaign_get({ folder: root, campaignId: CAMPAIGN_ID }, handlerCtx()))
    },
    {
      // What the steward bridge's `gatesFor` calls.
      name: 'deriveMissionSignals',
      run: async (mission, log) => {
        await deriveMissionSignals(root, mission, log, handlerCtx() as never, Date.now())
      }
    },
    {
      // The 20-second `mission:list` poll, the companion poll and Your move's source.
      name: 'listMissionViews',
      run: async () => {
        const r = await ipc.listMissionViews([root])
        expect(r.views).toHaveLength(1)
      }
    },
    {
      name: 'listCampaignViews',
      run: async () => {
        const r = await campaigns.listCampaignViews([root])
        expect(r.views).toHaveLength(1)
      }
    }
  ]
}

const READ_PATHS = [
  'mission_get',
  'campaign_get',
  'deriveMissionSignals',
  'listMissionViews',
  'listCampaignViews'
]

describe('every read path is a read with no side effects (AC-4, delta 1)', () => {
  it.each(READ_PATHS)('a read has no side effects through %s', async (name) => {
    const { mission, log, file } = await seed()
    await seedCampaign(mission.id)
    const before = await fs.readFile(file)
    const beforeStat = await fs.stat(file)
    const cache = await import('../src/main/mission-link-cache')
    await cache.ensureLinkCacheLoaded()
    const path_ = (await readPaths()).find((p) => p.name === name)!

    await path_.run(mission, log)
    await path_.run(mission, log)

    expect(h.joinCalls).toBeGreaterThan(0)
    expect((await fs.readFile(file)).equals(before)).toBe(true)
    expect((await fs.stat(file)).mtimeMs).toBe(beforeStat.mtimeMs)
    expect(h.wakes).toEqual([])
    expect(cache.getObservedLedger(MISSION_ID)).toEqual([])
    expect(cache.getLastKnown(root, 'pr', '8')).toBeNull()
    expect(cache.getLastKnown(root, 'pr', '7')).toBeNull()
    await new Promise((r) => setTimeout(r, cache.LINK_CACHE_WRITE_DEBOUNCE_MS + 200))
    expect(await fs.readdir(h.userDataDir)).toEqual([])
  })

  it('the read modules do not import the observer', async () => {
    const read = async (f: string): Promise<string> =>
      fs.readFile(path.join(__dirname, '..', 'src', 'main', f), 'utf8')
    expect(await read('missions/derive.ts')).not.toMatch(/from '\.\/observer'/)
    // `mission_list` and the wake wiring are the observer's readers; no read verb derives through it.
    const th = await read('mcp/tool-handlers.ts')
    expect(th).not.toContain('deriveAndObserve')
    expect(th).not.toMatch(/observeMission\(/)
  })
})

describe('the observer pass records what a read would have (delta 1)', () => {
  it('records the rows, the sticky facts and the progress, and wakes once', async () => {
    const { mission, file } = await seed()
    const before = await fs.readFile(file)
    const ipc = await import('../src/main/mission-ipc')
    const cache = await import('../src/main/mission-link-cache')
    const { lastKnownProgress } = await import('../src/main/missions/observer')

    const seen = await ipc.observeOpenMissions([root])

    expect(seen).toBe(1)
    const kinds = cache.getObservedLedger(MISSION_ID).map((r) => `${r.kind}:${r.ref}`)
    expect(kinds).toEqual(expect.arrayContaining(['pr-opened:#7', 'pr-merged:#8', 'ci:#7']))
    expect(cache.getLastKnown(root, 'pr', '8')?.state).toBe('MERGED')
    expect(lastKnownProgress(mission.id)?.total).toBe(2)
    expect(h.wakes).toEqual([[MISSION_ID, 'ci']])
    expect((await fs.readFile(file)).equals(before)).toBe(true)
    // The same world again records nothing and wakes nobody.
    await ipc.observeOpenMissions([root])
    expect(h.wakes).toHaveLength(1)
  })

  it('mission_list reports no progress until a pass has run, then the observed one', async () => {
    await seed()
    const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
    const list = WIRED_TOOLS.find((t) => t.op === 'mission_list')!.handler as unknown as Handler
    const progressOf = async (): Promise<unknown> => {
      const res = await list({ folder: root }, handlerCtx())
      return (JSON.parse(res.content[0].text!).missions as Array<{ progress: unknown }>)[0].progress
    }
    expect(await progressOf()).toBeNull()
    const ipc = await import('../src/main/mission-ipc')
    await ipc.observeOpenMissions([root])
    expect(await progressOf()).not.toBeNull()
  })

  it('an observer pass costs one derive per open mission, like one read', async () => {
    await seed()
    const ipc = await import('../src/main/mission-ipc')
    h.joinCalls = 0
    await ipc.listMissionViews([root])
    const oneRead = h.joinCalls
    h.joinCalls = 0
    await ipc.observeOpenMissions([root])
    expect(h.joinCalls).toBe(oneRead)
  })

  it('does nothing when no mission is open: no fleet scan, no derive', async () => {
    const ipc = await import('../src/main/mission-ipc')
    h.joinCalls = 0
    expect(await ipc.observeOpenMissions([root])).toBe(0)
    expect(h.joinCalls).toBe(0)
  })
})

describe('what triggers the observer (delta 1)', () => {
  type Ev = { sessionId: string; taskState: string }
  async function make(over: { open?: boolean } = {}): Promise<{
    obs: ReturnType<typeof import('../src/main/missions/observer').createMissionObserver>
    passes: Array<ReadonlySet<string> | undefined>
    emit: (ev: Ev) => void
  }> {
    const { createMissionObserver } = await import('../src/main/missions/observer')
    const passes: Array<ReadonlySet<string> | undefined> = []
    let cb: ((ev: Ev) => void) | null = null
    const obs = createMissionObserver({
      folders: async () => (over.open === false ? [] : [root]),
      pass: async (_folders, opts) => {
        passes.push(opts.onlySessions)
        return 1
      },
      onTaskEvent: (fn) => {
        cb = fn
        return () => {
          cb = null
        }
      },
      intervalMs: 60_000,
      firstPassMs: 5_000,
      eventDebounceMs: 3_000
    })
    return { obs, passes, emit: (ev) => cb?.(ev) }
  }

  it('runs a first pass soon after start, then one every interval, and none after stop', async () => {
    vi.useFakeTimers()
    try {
      const { obs, passes } = await make()
      obs.start()
      await vi.advanceTimersByTimeAsync(4_999)
      expect(passes).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(2)
      expect(passes).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(passes).toHaveLength(2)
      obs.stop()
      await vi.advanceTimersByTimeAsync(180_000)
      expect(passes).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs nothing when no folder is known', async () => {
    vi.useFakeTimers()
    try {
      const { obs, passes } = await make({ open: false })
      obs.start()
      await vi.advanceTimersByTimeAsync(130_000)
      expect(passes).toHaveLength(0)
      obs.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a session ending starts one pass for its missions, coalescing a burst; other states do not', async () => {
    vi.useFakeTimers()
    try {
      const { obs, passes, emit } = await make()
      obs.start()
      await vi.advanceTimersByTimeAsync(5_001) // the first pass
      passes.length = 0
      emit({ sessionId: CHILD, taskState: 'working' })
      emit({ sessionId: CHILD, taskState: 'idle' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(passes).toHaveLength(0)
      emit({ sessionId: CHILD, taskState: 'failed' })
      emit({ sessionId: OWNER, taskState: 'completed' })
      await vi.advanceTimersByTimeAsync(2_999)
      expect(passes).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(2)
      expect(passes).toHaveLength(1)
      expect([...(passes[0] ?? [])].sort()).toEqual([CHILD, OWNER].sort())
      obs.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never runs two passes at once', async () => {
    vi.useFakeTimers()
    try {
      const { createMissionObserver } = await import('../src/main/missions/observer')
      let running = 0
      let peak = 0
      let release: () => void = () => {}
      const obs = createMissionObserver({
        folders: async () => [root],
        pass: () =>
          new Promise<number>((resolve) => {
            running++
            peak = Math.max(peak, running)
            release = () => {
              running--
              resolve(1)
            }
          }),
        onTaskEvent: () => () => {},
        intervalMs: 1_000,
        firstPassMs: 100,
        eventDebounceMs: 100
      })
      obs.start()
      await vi.advanceTimersByTimeAsync(5_000) // many ticks while the first pass is still open
      expect(peak).toBe(1)
      release()
      obs.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
