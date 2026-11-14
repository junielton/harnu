/**
 * Missions v4 · S-16a · V-1, V-3, V-4 — the view channel and the observer's v4 leg.
 *
 * `mission:v4View` serves what the Mission pane reads: the detail S-12's `missionGet` builds, the close
 * warnings (with the facts), the staged Done when and the session history, for the mission a session
 * is attached to or one named by id. It reads and never writes, even for a mission that exists only as
 * a v3 file. The observer's v4 leg attaches the pull requests it finds to the steps of v4 records, and
 * to nothing else: it never makes the first v4 write of a v3 mission.
 *
 * Nothing on main calls the channel until S-17; every case runs through the module API against a real
 * temporary repo, with the facts' sources injected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({
  userDataDir: '',
  handlers: new Map<string, (e: unknown, arg?: unknown) => unknown>(),
  listCalls: 0,
  readCalls: [] as string[]
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
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, arg?: unknown) => unknown): void => {
      h.handlers.set(channel, fn)
    },
    on: (): void => {}
  }
}))

// The fleet scan reads the real ~/.claude/projects: keep the tests off it.
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => []
}))

// The store, counted: how many listings and which single-record reads a call makes.
vi.mock('../src/main/missions/record-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/missions/record-store')>()
  return {
    ...real,
    listMissionRecords: (...a: Parameters<typeof real.listMissionRecords>) => {
      h.listCalls++
      return real.listMissionRecords(...a)
    },
    readMissionRecord: (...a: Parameters<typeof real.readMissionRecord>) => {
      h.readCalls.push(a[1])
      return real.readMissionRecord(...a)
    }
  }
})

import { buildMissionRecordContent, type MissionV4 } from '../src/main/missions/model'
import type { FactsDeps, PrJoin } from '../src/main/missions/facts'

const FIXTURES = path.join(__dirname, 'fixtures', 'missions-v4-compat')
const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const STRANGER = 'e0e0e0e0-0000-4000-8000-0000000000ff'
const WORKER = '8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d'
const ID = 'mnt-d0000001'
const AT = '2026-11-14T10:00:00Z'

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

type PrRow = NonNullable<PrJoin['numbers'][number]>
const pr = (over: Partial<PrRow> = {}): PrRow =>
  ({
    number: 12,
    title: 't',
    branch: 'feat/x',
    base: 'main',
    state: 'OPEN',
    isDraft: false,
    mergeable: true,
    reviewDecision: null,
    ci: 'passing',
    checks: [],
    url: 'https://example.test/pull/12',
    author: 'a',
    updatedAt: null,
    createdAt: null,
    mergedAt: null,
    ...over
  }) as PrRow

/** Facts deps that answer from plain data; `join` is what chapter 2's join would say. */
function factsDeps(join: Partial<PrJoin> = {}): (root: string) => FactsDeps {
  return () => ({
    findPrs: async () => ({
      ghAvailable: true,
      worktrees: {},
      branches: {},
      numbers: {},
      ...join
    }),
    findMainCi: async () => ({ ghAvailable: true, byNumber: {} }),
    lastKnown: () => null,
    pathExists: async () => true,
    taskState: () => undefined
  })
}

function record(over: Partial<MissionV4> = {}): MissionV4 {
  return {
    schemaVersion: 4,
    id: ID,
    title: 'Score report',
    doneWhen: 'Every candidate sees a score report',
    status: 'open',
    milestones: [],
    steps: [
      {
        id: 'stp-1',
        title: 'Load the test files',
        acs: [{ id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }],
        links: [{ kind: 'pr', ref: '12' }],
        blockers: []
      },
      {
        id: 'stp-2',
        title: 'Check the layout',
        acs: [{ id: 'ac-1', text: 'The layout is confirmed', by: 'operator' }],
        links: [],
        blockers: []
      }
    ],
    sessions: [{ id: LEADER, role: 'leads', from: AT, to: null }],
    links: [],
    blockers: [],
    ...over
  } as MissionV4
}

let root = ''
let ud = ''
let ipc: typeof import('../src/main/mission-ipc')
const v4Dir = (): string => path.join(root, '.harnu', 'missions-v4')

function seed(rec: MissionV4, log = '# Log\n'): void {
  mkdirSync(v4Dir(), { recursive: true })
  writeFileSync(
    path.join(v4Dir(), `${rec.id}-score-report.md`),
    buildMissionRecordContent(rec, log)
  )
}
function seedV3(): void {
  cpSync(path.join(FIXTURES, 'missions'), path.join(root, '.harnu', 'missions'), {
    recursive: true
  })
  cpSync(path.join(FIXTURES, 'campaigns'), path.join(root, '.harnu', 'campaigns'), {
    recursive: true
  })
}

beforeEach(async () => {
  ud = mkdtempSync(path.join(os.tmpdir(), 'harnu-view-ud-'))
  h.userDataDir = ud
  h.listCalls = 0
  h.readCalls = []
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-view-'))
  vi.resetModules()
  ipc = await import('../src/main/mission-ipc')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(ud, { recursive: true, force: true })
})

// V-1 ---------------------------------------------------------------------------------------------

describe('the view writes nothing', () => {
  it('leaves every byte, every mtime and every directory listing unchanged, for a mission that exists only as a v3 file', async () => {
    seedV3()
    const before = { repo: tree(root), userData: tree(ud) }

    // A v3 mission named by id, a v3 campaign named by id, and a session attached to none of them.
    for (const missionId of ['mnt-5c0de001', 'cmp-ca0001aa', 'mnt-5c0de003']) {
      const reply = await ipc.buildMissionV4View(
        { folder: root, sessionId: LEADER, missionId },
        { facts: factsDeps({ numbers: { 412: pr({ number: 412, state: 'MERGED' }) } }) }
      )
      expect(reply.state, missionId).toBe('mission')
      // The id it answers reads the record back, a v3 campaign included.
      if (reply.state === 'mission') {
        const again = await ipc.buildMissionV4View(
          { folder: root, sessionId: LEADER, missionId: reply.missionId },
          { facts: factsDeps() }
        )
        expect(again.state, `${missionId} again`).toBe('mission')
      }
    }
    const none = await ipc.buildMissionV4View(
      { folder: root, sessionId: STRANGER },
      { facts: factsDeps() }
    )
    expect(none.state).toBe('none')

    expect({ repo: tree(root), userData: tree(ud) }).toEqual(before)
    // No v4 record, no sidecar, no ledger row: the v4 directory was never created.
    expect(existsSync(v4Dir())).toBe(false)
  })

  it('leaves a v4 record and the repo untouched too, and remembers no sighting', async () => {
    seed(record())
    const before = { repo: tree(root), userData: tree(ud) }
    const reply = await ipc.buildMissionV4View(
      { folder: root, sessionId: LEADER },
      { facts: factsDeps({ numbers: { 12: pr({ state: 'MERGED' }) } }) }
    )
    expect(reply.state).toBe('mission')
    expect({ repo: tree(root), userData: tree(ud) }).toEqual(before)
    // The sticky cache is the observer's: a view that saw a merged pull request does not remember it.
    const cache = await import('../src/main/mission-link-cache')
    expect(cache.getLastKnown(root, 'pr', '12')).toBeNull()
  })
})

// V-3 ---------------------------------------------------------------------------------------------

describe("the view carries the pane's data", () => {
  it('answers the detail, the close warnings, the staged Done when and the session history, with the facts applied', async () => {
    seed(
      record({
        pendingDoneWhen: { text: 'Every candidate sees a score report in their language' },
        sessions: [
          { id: LEADER, role: 'leads', from: AT, to: null },
          { id: WORKER, role: 'worked', from: AT, to: '2026-11-14T11:00:00Z' }
        ]
      } as Partial<MissionV4>)
    )
    const reply = await ipc.buildMissionV4View(
      { folder: root, sessionId: LEADER },
      { facts: factsDeps({ numbers: { 12: pr({ state: 'MERGED' }) } }) }
    )
    if (reply.state !== 'mission') throw new Error(JSON.stringify(reply))

    expect(reply.missionId).toBe(ID)
    expect(reply.source).toBe('v4')
    // The detail is S-12's: the merged pull request settled stp-1, so one of two steps is done.
    expect(reply.detail.id).toBe(ID)
    expect(reply.detail.progress.headline).toBe('1 of 2 steps done')
    expect(reply.detail.steps.map((s) => [s.id, s.state])).toEqual([
      ['stp-1', 'done'],
      ['stp-2', 'waiting-review']
    ])
    expect(reply.detail.steps[0].criteria[0]).toMatchObject({ settled: true, via: 'fact' })
    expect(reply.detail.next).not.toBeNull()
    expect(reply.detail.summary).toContain('Score report')
    // The close warnings count what is open, with the facts: stp-1 is done, stp-2 is not.
    expect(reply.closeWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unfinished-steps', count: 1 }),
        expect.objectContaining({ kind: 'staged-done-when', count: 1 })
      ])
    )
    expect(reply.pendingDoneWhen).toEqual({
      text: 'Every candidate sees a score report in their language'
    })
    expect(reply.sessions).toEqual([
      expect.objectContaining({ id: LEADER, role: 'leads', open: true }),
      expect.objectContaining({ id: WORKER, role: 'worked', open: false })
    ])
  })

  it('has no unfinished-steps warning for a mission whose only step a merged pull request settled', async () => {
    seed(record({ steps: [record().steps[0]] }))
    const reply = await ipc.buildMissionV4View(
      { folder: root, sessionId: LEADER },
      { facts: factsDeps({ numbers: { 12: pr({ state: 'MERGED' }) } }) }
    )
    if (reply.state !== 'mission') throw new Error(JSON.stringify(reply))
    expect(reply.closeWarnings.map((w) => w.kind)).not.toContain('unfinished-steps')
    // And without the facts the same step reads not done: the warning is the facts' doing.
    const blind = await ipc.buildMissionV4View(
      { folder: root, sessionId: LEADER },
      { facts: factsDeps({ ghAvailable: false }) }
    )
    if (blind.state !== 'mission') throw new Error(JSON.stringify(blind))
    expect(blind.closeWarnings.map((w) => w.kind)).toContain('unfinished-steps')
  })

  it('returns the mission id, and a later call that names it reads one record and lists none', async () => {
    seed(record())
    seed(record({ id: 'mnt-d0000002', title: 'Other' }))
    const first = await ipc.buildMissionV4View(
      { folder: root, sessionId: LEADER, missionId: undefined },
      { facts: factsDeps() }
    )
    // The session leads both missions: it must name one.
    expect(first).toMatchObject({ state: 'refused', code: 'AMBIGUOUS_MISSION' })

    const one = mkdtempSync(path.join(os.tmpdir(), 'harnu-view-one-'))
    try {
      mkdirSync(path.join(one, '.harnu', 'missions-v4'), { recursive: true })
      writeFileSync(
        path.join(one, '.harnu', 'missions-v4', `${ID}-score-report.md`),
        buildMissionRecordContent(record(), '# Log\n')
      )
      h.listCalls = 0
      const unnamed = await ipc.buildMissionV4View(
        { folder: one, sessionId: LEADER },
        { facts: factsDeps() }
      )
      if (unnamed.state !== 'mission') throw new Error(JSON.stringify(unnamed))
      expect(h.listCalls).toBe(1)

      h.listCalls = 0
      h.readCalls = []
      const named = await ipc.buildMissionV4View(
        { folder: one, sessionId: LEADER, missionId: unnamed.missionId },
        { facts: factsDeps() }
      )
      expect(named).toMatchObject({ state: 'mission', missionId: ID })
      expect(h.listCalls).toBe(0)
      expect(new Set(h.readCalls)).toEqual(new Set([ID]))
    } finally {
      rmSync(one, { recursive: true, force: true })
    }
  })

  it("reads everything for the app's interface: a session that is not attached still gets the mission it names", async () => {
    seed(record())
    const reply = await ipc.buildMissionV4View(
      { folder: root, sessionId: STRANGER, missionId: ID },
      { facts: factsDeps() }
    )
    expect(reply).toMatchObject({ state: 'mission', missionId: ID })
  })

  it('answers the missions to pick from when the session is attached to none, and refuses with a typed code', async () => {
    seed(record())
    const none = await ipc.buildMissionV4View(
      { folder: root, sessionId: STRANGER },
      { facts: factsDeps() }
    )
    expect(none).toMatchObject({
      state: 'none',
      missions: [expect.objectContaining({ id: ID, title: 'Score report' })]
    })
    for (const bad of [null, {}, { folder: root }, { folder: root, sessionId: '' }]) {
      expect(await ipc.buildMissionV4View(bad, { facts: factsDeps() })).toMatchObject({
        state: 'refused',
        code: 'BAD_ARGS'
      })
    }
    expect(
      await ipc.buildMissionV4View(
        { folder: root, sessionId: LEADER, missionId: 'mnt-0000dead' },
        { facts: factsDeps() }
      )
    ).toMatchObject({ state: 'refused', code: 'MISSION_NOT_FOUND' })
  })

  it('serves a v3 mission through the same channel, marked with where it came from', async () => {
    seedV3()
    const reply = await ipc.buildMissionV4View(
      { folder: root, sessionId: STRANGER, missionId: 'mnt-5c0de001' },
      { facts: factsDeps() }
    )
    expect(reply).toMatchObject({ state: 'mission', source: 'v3-mission' })
  })
})

// Registration -------------------------------------------------------------------------------------

describe('registerMissionIpc', () => {
  it('registers mission:v4View, which answers like the module function and never throws across IPC', async () => {
    h.handlers.clear()
    ipc.registerMissionIpc()
    expect(h.handlers.has('mission:v4View')).toBe(true)
    seed(record())
    const reply = await h.handlers.get('mission:v4View')!({}, { folder: root, sessionId: LEADER })
    expect(reply).toMatchObject({ state: 'mission', missionId: ID })
    expect(await h.handlers.get('mission:v4View')!({}, 'not an object')).toMatchObject({
      state: 'refused',
      code: 'BAD_ARGS'
    })
  })
})

// V-4 ---------------------------------------------------------------------------------------------

describe('the observer never converts a v3 mission', () => {
  /** A worktree-linked step whose branch has a pull request the mission does not carry yet. */
  const WORKTREE = '/home/user/Workspace/org/www/.claude/worktrees/card-T701-write-rows'
  const found = factsDeps({
    worktrees: {
      [WORKTREE]: { exists: true, branch: 'feat/rows', head: null, prs: [pr({ number: 413 })] }
    }
  })

  it('attaches a found pull request to a v3 mission nowhere: no file under missions-v4 and the v3 bytes unchanged', async () => {
    seedV3()
    // A v4 record exists, so the repo passes the directory gate and the pass does look at it.
    seed(record({ id: 'mnt-d0000009', steps: [{ ...record().steps[1] }] }))
    const v3Before = {
      missions: tree(path.join(root, '.harnu', 'missions')),
      campaigns: tree(path.join(root, '.harnu', 'campaigns'))
    }
    const files = readdirSync(v4Dir()).sort()

    await ipc.observeOpenMissions([root], Date.now(), { v4Facts: found })

    expect(readdirSync(v4Dir()).sort()).toEqual(files)
    expect({
      missions: tree(path.join(root, '.harnu', 'missions')),
      campaigns: tree(path.join(root, '.harnu', 'campaigns'))
    }).toEqual(v3Before)
  })

  it('never looks at a repo with no missions-v4 directory: no listing, no v3 read, nothing created', async () => {
    seedV3()
    const before = tree(root)
    h.listCalls = 0
    h.readCalls = []
    await ipc.observeOpenMissions([root], Date.now(), { v4Facts: found })
    expect(h.listCalls).toBe(0)
    expect(h.readCalls).toEqual([])
    expect(tree(root)).toEqual(before)
    expect(existsSync(v4Dir())).toBe(false)
  })

  it('attaches the pull requests it finds to a v4 record, once, and remembers what it saw', async () => {
    seed(
      record({
        steps: [
          {
            id: 'stp-1',
            title: 'Load the rows',
            acs: [
              { id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }
            ],
            links: [{ kind: 'worktree', ref: WORKTREE }],
            blockers: []
          }
        ]
      })
    )
    const setInterval = vi.spyOn(globalThis, 'setInterval')

    await ipc.observeOpenMissions([root], Date.now(), { v4Facts: found })
    const linked = (): unknown =>
      readFileSync(path.join(v4Dir(), `${ID}-score-report.md`), 'utf8').match(/ref: '?413'?/g)
    expect(linked()).toHaveLength(1)
    // The sticky sighting is the observer's to make.
    const cache = await import('../src/main/mission-link-cache')
    expect(cache.getLastKnown(root, 'pr', '413')).toMatchObject({ state: 'OPEN', prNumber: 413 })

    // Idempotent: a second pass over the same pull request adds none.
    const bytes = readFileSync(path.join(v4Dir(), `${ID}-score-report.md`), 'utf8')
    await ipc.observeOpenMissions([root], Date.now(), { v4Facts: found })
    expect(readFileSync(path.join(v4Dir(), `${ID}-score-report.md`), 'utf8')).toBe(bytes)

    // No timer of its own.
    expect(setInterval).not.toHaveBeenCalled()
    setInterval.mockRestore()
  })

  it('leaves a closed v4 record alone', async () => {
    seed(
      record({
        status: 'closed',
        steps: [
          {
            id: 'stp-1',
            title: 'Load the rows',
            acs: [
              { id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }
            ],
            links: [{ kind: 'worktree', ref: WORKTREE }],
            blockers: []
          }
        ]
      } as Partial<MissionV4>)
    )
    const before = tree(root)
    await ipc.observeOpenMissions([root], Date.now(), { v4Facts: found })
    expect(tree(root)).toEqual(before)
  })
})

// V-6 ---------------------------------------------------------------------------------------------

describe('the preload entries', () => {
  const preload = readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.ts'), 'utf8')

  it('exposes the view channel and the v4 door channel, typed, and keeps every existing mission entry as it was', () => {
    expect(preload).toMatch(
      /missionV4View: \(args: MissionV4ViewRequest\): Promise<MissionV4ViewReply> =>\s*ipcRenderer\.invoke\('mission:v4View', args\)/
    )
    expect(preload).toMatch(
      /missionV4Door: \(door: MissionV4Door\): Promise<MissionV4DoorReply> =>\s*ipcRenderer\.invoke\('mission:v4Door', door\)/
    )
    // Chapter 2's entries keep their names and channels.
    expect(preload).toMatch(
      /missionList: \(folders: string\[\]\): Promise<MissionListResult> =>\s*ipcRenderer\.invoke\('mission:list', folders\)/
    )
    expect(preload).toMatch(/ipcRenderer\.invoke\('mission:operatorDoor', door\)/)
    expect(preload).toMatch(/ipcRenderer\.invoke\('mission:choose', args\)/)
  })

  it('is called by nothing in the renderer yet: the pane arrives with S-17', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(path.join(dir, e.name))
          : /\.(ts|vue|tsx)$/.test(e.name)
            ? [path.join(dir, e.name)]
            : []
      )
    const callers = walk(path.join(__dirname, '..', 'src', 'renderer')).filter((f) =>
      /missionV4(View|Door)/.test(readFileSync(f, 'utf8'))
    )
    expect(callers).toEqual([])
  })
})
