/**
 * Missions v4 S-3 (R-25, AC-4) — reading a mission writes nothing.
 *
 * A read may look at the files, git, `gh` and the sessions, and it returns what it saw. The mission
 * file's bytes and mtime stay the same, no row is appended to the ledger, no sticky fact is remembered and
 * nothing appears in the user data directory. Only the observer pass (`observeOpenMissions`, started by
 * `startMissionObserver`) records what a read would have.
 *
 * The claim is about every READ, not one function: `mission_get`, `mission_list`, the renderer list poll
 * (`listMissionViews`, which the companion and Your move ride) and the pane's view channel
 * (`buildMissionV4View`) all write nothing, whether the mission lives in a v4 record or still in a v3 file.
 *
 * Missions v4 S-40: the v3 derive (`deriveMission`, its `observation` hand-back and `observeMission`) is
 * gone, so the pass that records is the v4 leg: it attaches what it found to v4 records and remembers the
 * sticky sightings, and it never makes the first v4 write of a v3 file.
 *
 * Run for real against a throwaway git repo; only the live sources are faked at their module seams (the
 * hook FSM, the PTY set, hibernation, the Approval Inbox and the `gh`-backed PR join).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, promises as fs, readdirSync, readFileSync, statSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { MissionPrJoin } from '../src/main/pr-stack'
import type { FactsDeps } from '../src/main/missions/facts'
import { buildMissionRecordContent, type MissionV4 } from '../src/main/missions/model'
import { buildV3MissionFile, v3MissionObject, v3MissionPath } from './helpers/v3-mission-file'

const h = vi.hoisted(() => ({
  userDataDir: '',
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

/** What the join says: #7 is open with green CI, #8 merged. Every call is counted. */
async function joinOf(refs: { numbers: readonly number[] }): Promise<MissionPrJoin> {
  h.joinCalls++
  const numbers: MissionPrJoin['numbers'] = {}
  for (const n of refs.numbers) {
    numbers[n] = (
      n === 7 ? prEntry(7, 'OPEN', 'passing') : prEntry(8, 'MERGED', 'passing')
    ) as MissionPrJoin['numbers'][number]
  }
  return { ghAvailable: true, worktrees: {}, branches: {}, numbers }
}

vi.mock('../src/main/pr-stack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/pr-stack')>()),
  findPrsForWorktrees: async (
    _repo: string,
    refs: { numbers: readonly number[] }
  ): Promise<MissionPrJoin> => joinOf(refs),
  findMainCi: async () => ({ ghAvailable: true, byNumber: {} })
}))

// The first import of the handlers pulls in most of the main process.
vi.setConfig({ testTimeout: 30_000 })

const OWNER = '11111111-2222-4333-8444-555555555555'
const CHILD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const MISSION_ID = 'mnt-0000000a'

let root = ''

/** The facts the view and the observer gather from, with the PR join counted. */
const factsDeps = (): FactsDeps => ({
  findPrs: async (refs) => joinOf({ numbers: refs.numbers ?? [] }),
  findMainCi: async () => ({ ghAvailable: true, byNumber: {} }),
  lastKnown: () => null,
  pathExists: async () => true,
  taskState: () => undefined
})

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

/** Every file (bytes and mtime) and every directory under `dir`, keyed by relative path. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (sub: string): void => {
    for (const e of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, e.name)
      const abs = path.join(dir, rel)
      if (e.isDirectory()) {
        out[`${rel}/`] = 'dir'
        walk(rel)
      } else out[rel] = `${sha(readFileSync(abs))}@${statSync(abs).mtimeMs}`
    }
  }
  if (existsSync(dir)) walk('')
  return out
}

/** An active v3 mission whose steps link an open PR, a merged PR and a child session. */
async function seedV3(): Promise<string> {
  const at = '2026-11-01T09:00:00.000Z'
  const step = (
    id: string,
    kind: string,
    verification: string,
    links: Array<{ kind: string; ref: string }> = []
  ): Record<string, unknown> => ({
    id,
    ordinal: Number(id.slice(4)),
    kind,
    title: kind === 'fixed-end' ? 'Delivered and verified' : `Step ${id.slice(4)}`,
    verification,
    proof: 'unproven',
    links,
    blockers: []
  })
  const file = v3MissionPath(root, MISSION_ID, 'pure-read')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    buildV3MissionFile(
      v3MissionObject(root, {
        id: MISSION_ID,
        slug: 'pure-read',
        owner: { sessionId: OWNER, folder: root },
        declaredEnd: { kind: 'code', target: 't', evidence: 'e' },
        steps: [
          step('stp-1', 'custom', 'existence', [
            { kind: 'pr', ref: '#7' },
            { kind: 'session', ref: CHILD }
          ]),
          step('stp-2', 'custom', 'existence', [{ kind: 'pr', ref: '#8' }]),
          step('stp-3', 'fixed-end', 'verifier')
        ],
        createdAt: at,
        updatedAt: at
      }),
      '# Pure read\n\n## Log\n'
    )
  )
  return file
}

/** The same mission as an open v4 record. */
async function seedV4(): Promise<string> {
  const dir = path.join(root, '.harnu', 'missions-v4')
  await fs.mkdir(dir, { recursive: true })
  const rec = {
    schemaVersion: 4,
    id: MISSION_ID,
    title: 'Pure read',
    doneWhen: 'The pull requests are merged',
    status: 'open',
    milestones: [],
    steps: [
      {
        id: 'stp-1',
        title: 'Step 1',
        acs: [{ id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }],
        links: [
          { kind: 'pr', ref: '7' },
          { kind: 'session', ref: CHILD }
        ],
        blockers: []
      },
      {
        id: 'stp-2',
        title: 'Step 2',
        acs: [{ id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }],
        links: [{ kind: 'pr', ref: '8' }],
        blockers: []
      }
    ],
    sessions: [{ id: OWNER, role: 'leads', from: '2026-11-01T09:00:00Z', to: null }],
    links: [],
    blockers: []
  } as unknown as MissionV4
  const file = path.join(dir, `${MISSION_ID}-pure-read.md`)
  await fs.writeFile(file, buildMissionRecordContent(rec, '# Log\n'))
  return file
}

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-s3-ud-'))
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-s3-repo-')), 'main')
  await fs.mkdir(root)
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  h.joinCalls = 0
  vi.resetModules()
})

// ---- Every read path is pure; the observer pass records ------------------------------------------

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

/** The handler-facing context: a scanned fleet with no sessions in it. */
const handlerCtx = (): Record<string, unknown> => ({
  folder: root,
  folders: [],
  denyFolders: [],
  bridge: undefined
})

interface ReadPath {
  name: string
  run: () => Promise<void>
}

async function readPaths(): Promise<ReadPath[]> {
  const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
  const handlers = Object.fromEntries(
    WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler])
  )
  const ok = (res: ToolResult): void => expect(res.isError, res.content[0]?.text).not.toBe(true)
  const ipc = await import('../src/main/mission-ipc')
  return [
    {
      name: 'mission_get',
      run: async () =>
        ok(
          await handlers.mission_get(
            { folder: root, missionId: MISSION_ID, sessionId: OWNER },
            handlerCtx()
          )
        )
    },
    {
      name: 'mission_list',
      run: async () => ok(await handlers.mission_list({ folder: root }, handlerCtx()))
    },
    {
      // The 20-second `mission:list` poll, the companion poll and Your move's source.
      name: 'listMissionViews',
      run: async () => {
        const r = await ipc.listMissionViews([root])
        expect(r.views).toEqual([])
        expect(r.unreadable).toEqual([])
      }
    },
    {
      // The Mission pane's view channel: it gathers the facts, and still writes nothing.
      name: 'buildMissionV4View',
      run: async () => {
        const r = await ipc.buildMissionV4View(
          { folder: root, sessionId: OWNER, missionId: MISSION_ID },
          { facts: factsDeps }
        )
        expect(r.state).toBe('mission')
      }
    }
  ]
}

const READ_PATHS = ['mission_get', 'mission_list', 'listMissionViews', 'buildMissionV4View']

describe.each([
  ['a v3 file', seedV3],
  ['a v4 record', seedV4]
] as const)('every read path is a read with no side effects (AC-4) — %s', (_label, seed) => {
  it.each(READ_PATHS)('a read has no side effects through %s', async (name) => {
    await seed()
    const cache = await import('../src/main/mission-link-cache')
    await cache.ensureLinkCacheLoaded()
    const path_ = (await readPaths()).find((p) => p.name === name)!
    const before = { repo: tree(root), userData: tree(h.userDataDir) }

    await path_.run()
    await path_.run()

    // The same bytes, the same mtimes, the same directories, in the repo and in userData.
    expect({ repo: tree(root), userData: tree(h.userDataDir) }).toEqual(before)
    // No row in the ledger, and no sticky fact remembered either.
    expect(cache.getObservedLedger(MISSION_ID)).toEqual([])
    expect(cache.getLastKnown(root, 'pr', '8')).toBeNull()
    expect(cache.getLastKnown(root, 'pr', '7')).toBeNull()
    await new Promise((r) => setTimeout(r, cache.LINK_CACHE_WRITE_DEBOUNCE_MS + 200))
    expect(await fs.readdir(h.userDataDir)).toEqual([])
    expect(tree(root)).toEqual(before.repo)
  })

  it('the pane view really looked: it joined the pull requests, and still wrote nothing', async () => {
    await seed()
    const before = tree(root)
    const ipc = await import('../src/main/mission-ipc')
    const view = await ipc.buildMissionV4View(
      { folder: root, sessionId: OWNER, missionId: MISSION_ID },
      { facts: factsDeps }
    )
    expect(view.state).toBe('mission')
    expect(h.joinCalls).toBeGreaterThan(0)
    expect(tree(root)).toEqual(before)
  })

  it('reading twice gives the same answer', async () => {
    await seed()
    const { missionGet } = await import('../src/main/missions/verbs-read')
    const a = await missionGet(root, { kind: 'operator' }, { missionId: MISSION_ID })
    const b = await missionGet(root, { kind: 'operator' }, { missionId: MISSION_ID })
    expect(a.ok).toBe(true)
    expect(b).toEqual(a)
  })
})

describe('the read modules do not import the observer', () => {
  it('no read verb derives through it', async () => {
    const read = async (f: string): Promise<string> =>
      fs.readFile(path.join(__dirname, '..', 'src', 'main', f), 'utf8')
    expect(await read('missions/derive.ts')).not.toMatch(/from '\.\/observer'/)
    expect(await read('missions/verbs-read.ts')).not.toMatch(/from '\.\/observer'/)
    // `mission_list` and the wake wiring are the observer's readers; no read verb derives through it.
    const th = await read('mcp/tool-handlers.ts')
    expect(th).not.toContain('deriveAndObserve')
    expect(th).not.toMatch(/observeMission\(/)
  })
})

describe('the observer pass records what a read would have', () => {
  it('remembers the sticky sightings of a v4 record, writes only what it found, and does it once', async () => {
    const file = await seedV4()
    const before = await fs.readFile(file)
    const ipc = await import('../src/main/mission-ipc')
    const cache = await import('../src/main/mission-link-cache')

    const seen = await ipc.observeOpenMissions([root], Date.now(), { v4Facts: factsDeps })

    expect(seen).toBe(1)
    // What the pass saw is remembered, and only the pass does that.
    expect(cache.getLastKnown(root, 'pr', '8')?.state).toBe('MERGED')
    expect(cache.getLastKnown(root, 'pr', '7')?.state).toBe('OPEN')
    // Both pull requests are already on the steps, so there is nothing to attach: the record is untouched.
    expect((await fs.readFile(file)).equals(before)).toBe(true)
    // The same world again leaves the record as it was.
    await ipc.observeOpenMissions([root], Date.now(), { v4Facts: factsDeps })
    expect((await fs.readFile(file)).equals(before)).toBe(true)
  })

  it('never makes the first v4 write of a v3 file: it observes none and leaves the file alone', async () => {
    const file = await seedV3()
    const before = await fs.readFile(file)
    const ipc = await import('../src/main/mission-ipc')
    expect(await ipc.observeOpenMissions([root], Date.now(), { v4Facts: factsDeps })).toBe(0)
    expect((await fs.readFile(file)).equals(before)).toBe(true)
    expect(existsSync(path.join(root, '.harnu', 'missions-v4'))).toBe(false)
  })

  it('does nothing when no mission is open: no fleet scan, no join', async () => {
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

describe('a cancelled quit leaves the observer running (delta 2)', () => {
  it('stops the observer only after the quit guard let the quit through', async () => {
    const index = await fs.readFile(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    const quit = index.slice(index.indexOf("app.on('before-quit'"))
    const cancelled = quit.indexOf('if (event.defaultPrevented) return')
    const stop = quit.indexOf('stopMissionObserver?.()')
    expect(cancelled).toBeGreaterThan(-1)
    expect(stop).toBeGreaterThan(-1)
    // Cancel keeps everything alive: nothing that stops a service may run above that return.
    expect(stop).toBeGreaterThan(cancelled)
    expect(quit.indexOf('stopHibernationSweep()')).toBeLessThan(stop)
  })
})
