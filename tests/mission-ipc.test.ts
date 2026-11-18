/**
 * T370 (T358 S9) — `src/main/mission-ipc.ts`: the renderer's read of open missions and the operator doors,
 * driven against a real temp repo.
 *
 * Missions v4 S-40: the v3 view is gone. `listMissionViews` answers no view of any mission; what it
 * still carries is the files that could not be read and the copies of an id that lost to a newer one. The
 * v3 operator doors (`mission:operatorDoor`, `mission:choose`) answer a refusal that points at the Mission
 * pane. What an operator does to a mission goes through `mission:v4Door`; what the pane reads comes through
 * `mission:v4View`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildMissionRecordContent, type MissionV4 } from '../src/main/missions/model'
import { v3MissionObject, writeV3Mission } from './helpers/v3-mission-file'

const h = vi.hoisted(() => ({
  userDataDir: '',
  /** What `registerMissionIpc` registered, by channel (S-15). */
  handlers: new Map<string, (e: unknown, arg?: unknown) => unknown>()
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

// The fleet scan reads the real ~/.claude/projects — keep the tests off it.
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => []
}))

const OWNER = '11111111-2222-4333-8444-555555555555'

/** A v3 mission file's object, in the repo `folder` (default `/repo`). */
function mission(
  id: string,
  over: Record<string, unknown> = {},
  folder = '/repo'
): { id: string; slug: string } & Record<string, unknown> {
  return v3MissionObject(folder, {
    id,
    slug: `m-${id.slice(4)}`,
    owner: { sessionId: OWNER, folder },
    status: 'active',
    updatedAt: '2026-09-28T10:00:00.000Z',
    ...over
  })
}

/** An open v4 record. */
function record(id: string): MissionV4 {
  return {
    schemaVersion: 4,
    id,
    title: 'A record',
    doneWhen: 'The record is read',
    status: 'open',
    milestones: [],
    steps: [
      {
        id: 'stp-1',
        title: 'Read it',
        acs: [{ id: 'ac-1', text: 'It is read', by: 'operator' }],
        links: [],
        blockers: []
      }
    ],
    sessions: [{ id: OWNER, role: 'leads', from: '2026-11-14T10:00:00Z', to: null }],
    links: [],
    blockers: []
  } as unknown as MissionV4
}

async function writeRecord(dir: string, rec: MissionV4): Promise<void> {
  const v4 = path.join(dir, '.harnu', 'missions-v4')
  await fs.mkdir(v4, { recursive: true })
  await fs.writeFile(
    path.join(v4, `${rec.id}-record.md`),
    buildMissionRecordContent(rec, '# Log\n')
  )
}

let root: string
let ipc: typeof import('../src/main/mission-ipc')

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-ipc-ud-'))
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-ipc-'))
  vi.resetModules()
  ipc = await import('../src/main/mission-ipc')
})

describe('listMissionViews', () => {
  it('answers no view of any mission, v3 file or v4 record, open or closed', async () => {
    writeV3Mission(root, mission('mnt-00000001', {}, root), '# First mission\n')
    writeV3Mission(root, mission('mnt-00000002', { status: 'closed', closedAs: 'delivered' }, root))
    await writeRecord(root, record('mnt-00000003'))
    expect(await ipc.listMissionViews([root])).toEqual({ views: [], unreadable: [], shadowed: [] })
  })

  it('names a file it could not read, v3 or v4, and still reads nothing else into a view', async () => {
    writeV3Mission(root, mission('mnt-00000001', {}, root))
    await fs.writeFile(
      path.join(root, '.harnu', 'missions', 'mnt-deadbeef-broken.md'),
      '---\nstatus: [\n---\n'
    )
    await writeRecord(root, record('mnt-00000003'))
    await fs.writeFile(
      path.join(root, '.harnu', 'missions-v4', 'mnt-a7230001-bad.md'),
      'not a record'
    )
    const { views, unreadable } = await ipc.listMissionViews([root])
    expect(views).toEqual([])
    expect([...unreadable].sort()).toEqual(['mnt-a7230001-bad.md', 'mnt-deadbeef-broken.md'])
  })

  it('names the files other readers reported too (hibernation, the companion, Your move)', async () => {
    const { reportUnreadableMissionFiles, resetUnreadableMissionFiles } =
      await import('../src/main/missions/store')
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    try {
      reportUnreadableMissionFiles('your-move', ['mnt-0000aaaa-reported.md'])
      expect((await ipc.listMissionViews([root])).unreadable).toEqual(['mnt-0000aaaa-reported.md'])
    } finally {
      resetUnreadableMissionFiles()
    }
    expect((await ipc.listMissionViews([root])).unreadable).toEqual([])
  })

  it('reads nothing off disk but the file names: a v3 file is left byte for byte as it was', async () => {
    const file = writeV3Mission(root, mission('mnt-00000001', {}, root), '# First\n')
    const before = await fs.readFile(file)
    await ipc.listMissionViews([root])
    await ipc.listMissionViews([root])
    expect((await fs.readFile(file)).equals(before)).toBe(true)
  })

  it('returns nothing for no folders or a repo with no missions dir', async () => {
    expect(await ipc.listMissionViews([])).toEqual({ views: [], unreadable: [], shadowed: [] })
    expect(await ipc.listMissionViews([root])).toEqual({ views: [], unreadable: [], shadowed: [] })
  })
})

// BUG-173 S1 (mission cue noise spec §3.1): missions are unique by `mission.id`. The poll no longer carries
// the winning copy's view (S-40); it still names the copies that lost, and the store still decides which won.
describe('listMissionViews — one entry per mission id', () => {
  /** A second repo root: a temp dir with a `.git` directory, like a separate clone. */
  async function cloneRoot(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-ipc-clone-'))
    await fs.mkdir(path.join(dir, '.git'))
    return fs.realpath(dir)
  }

  beforeEach(async () => {
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    root = await fs.realpath(root)
  })

  it('reports a copy when two roots hold the same id', async () => {
    const other = await cloneRoot()
    writeV3Mission(root, mission('mnt-0000d001', {}, root), '# Twin\n')
    writeV3Mission(other, mission('mnt-0000d001', {}, other), '# Twin\n')
    const { views, shadowed } = await ipc.listMissionViews([root, other])
    expect(views).toEqual([])
    // Same updatedAt: the root that sorts first by path wins; the other is reported.
    const loser = [root, other].sort()[1]
    expect(shadowed).toEqual([{ missionId: 'mnt-0000d001', root: loser }])
  })

  it('newest updatedAt wins and a tie breaks on root path', async () => {
    const other = await cloneRoot()
    const [first, second] = [root, other].sort()
    const older = '2026-09-28T10:00:00.000Z'
    const newer = '2026-09-29T10:00:00.000Z'
    // The root that sorts LAST holds the newer copy: recency beats path order.
    writeV3Mission(first, mission('mnt-0000d002', { updatedAt: older }, first))
    writeV3Mission(second, mission('mnt-0000d002', { updatedAt: newer }, second))
    // Folder order must not matter.
    for (const order of [
      [first, second],
      [second, first]
    ]) {
      const { shadowed } = await ipc.listMissionViews(order)
      expect(shadowed).toEqual([{ missionId: 'mnt-0000d002', root: first }])
    }
  })

  it('a closed winner shadows an older copy that is still active', async () => {
    const other = await cloneRoot()
    writeV3Mission(root, mission('mnt-0000d003', { updatedAt: '2026-09-28T10:00:00.000Z' }, root))
    writeV3Mission(
      other,
      mission(
        'mnt-0000d003',
        { status: 'closed', closedAs: 'delivered', updatedAt: '2026-09-29T10:00:00.000Z' },
        other
      )
    )
    const { views, shadowed } = await ipc.listMissionViews([root, other])
    expect(views).toEqual([])
    expect(shadowed).toEqual([{ missionId: 'mnt-0000d003', root }])
  })

  it('two spellings of one directory are one root', async () => {
    writeV3Mission(root, mission('mnt-0000d004', {}, root))
    const alias = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-ipc-ln-')), 'l')
    await fs.symlink(root, alias)
    const { shadowed } = await ipc.listMissionViews([root, alias])
    expect(shadowed).toEqual([])
  })
})

describe('observeOpenMissions', () => {
  it('observes nothing for no folders, a repo with no missions, or a repo with only v3 files', async () => {
    expect(await ipc.observeOpenMissions([])).toBe(0)
    expect(await ipc.observeOpenMissions([root])).toBe(0)
    const file = writeV3Mission(root, mission('mnt-00000001', {}, root))
    const before = await fs.readFile(file)
    expect(await ipc.observeOpenMissions([root])).toBe(0)
    // Never the first v4 write of a v3 file, and no v4 directory appears.
    expect((await fs.readFile(file)).equals(before)).toBe(true)
    await expect(fs.stat(path.join(root, '.harnu', 'missions-v4'))).rejects.toThrow()
  })

  it('counts the open v4 records it observed, with its facts injected', async () => {
    await writeRecord(root, record('mnt-00000003'))
    const noFacts = {
      findPrs: async () => ({ ghAvailable: true, worktrees: {}, branches: {}, numbers: {} }),
      findMainCi: async () => ({ ghAvailable: true, byNumber: {} }),
      lastKnown: () => null,
      pathExists: async () => true,
      taskState: () => undefined
    }
    expect(await ipc.observeOpenMissions([root], Date.now(), { v4Facts: () => noFacts })).toBe(1)
  })
})

describe('the v3 operator doors', () => {
  const REFUSAL = /Mission pane/

  it('answer a refusal that names the Mission pane, and touch nothing on disk', async () => {
    const file = writeV3Mission(root, mission('mnt-0000000b', {}, root), '# T\n\n## Log\n')
    const before = await fs.readFile(file)
    h.handlers.clear()
    ipc.registerMissionIpc()
    for (const channel of ['mission:operatorDoor', 'mission:choose']) {
      const reply = (await h.handlers.get(channel)!(
        {},
        { door: 'end', root, missionId: 'mnt-0000000b', closedAs: 'discarded' }
      )) as { ok: boolean; error?: string }
      expect(reply.ok, channel).toBe(false)
      expect(reply.error, channel).toMatch(REFUSAL)
    }
    expect((await fs.readFile(file)).equals(before)).toBe(true)
  })

  it('are no longer exported as a function: the door runner went with the v3 popover', () => {
    expect((ipc as Record<string, unknown>).runOperatorDoor).toBeUndefined()
  })
})

describe('registerMissionIpc — the v4 door channel (S-15)', () => {
  it('adds mission:v4Door beside the existing channels and routes a door to the v4 record', async () => {
    h.handlers.clear()
    ipc.registerMissionIpc()
    expect([...h.handlers.keys()].sort()).toEqual([
      'mission:choose',
      'mission:handOff',
      'mission:list',
      'mission:operatorDoor',
      'mission:pathKinds',
      'mission:v4Door',
      'mission:v4View'
    ])

    const { buildMissionRecordContent } = await import('../src/main/missions/model')
    const id = 'mnt-d0000099'
    const dir = path.join(root, '.harnu', 'missions-v4')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, `${id}-doors.md`),
      buildMissionRecordContent(
        {
          schemaVersion: 4,
          id,
          title: 'Doors',
          doneWhen: 'The doors open',
          status: 'open',
          milestones: [],
          steps: [
            {
              id: 'stp-1',
              title: 'Check the doors',
              acs: [{ id: 'ac-1', text: 'The doors are checked', by: 'operator' }],
              links: [],
              blockers: []
            }
          ],
          sessions: [],
          links: [],
          blockers: []
        },
        '# Log\n'
      )
    )
    const reply = (await h.handlers.get('mission:v4Door')!(
      {},
      {
        door: 'mark',
        folder: root,
        missionId: id,
        stepId: 'stp-1',
        criterionId: 'ac-1'
      }
    )) as Record<string, unknown>
    // The outcome, and never the record or the path of its file.
    expect(reply).toEqual({ ok: true, changed: true, stepId: 'stp-1', criterionId: 'ac-1' })
    const bad = (await h.handlers.get('mission:v4Door')!({}, { door: 'nope' })) as Record<
      string,
      unknown
    >
    expect(bad).toMatchObject({ ok: false, code: 'BAD_ARGS' })
  })
})

describe('the hand-off and the summary route on the app (S-16b)', () => {
  const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
  const NEW_ONE = '9d2e7a10-5c3b-4f68-8a14-2b9e6c0d7f31'
  const ID = 'mnt-d0000077'

  async function seedV4(): Promise<void> {
    const { buildMissionRecordContent } = await import('../src/main/missions/model')
    const dir = path.join(root, '.harnu', 'missions-v4')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, `${ID}-hand-off.md`),
      buildMissionRecordContent(
        {
          schemaVersion: 4,
          id: ID,
          title: 'Hand off',
          doneWhen: 'The hand-off works',
          status: 'open',
          milestones: [],
          steps: [
            {
              id: 'stp-1',
              title: 'Check the hand-off',
              acs: [{ id: 'ac-1', text: 'The hand-off is checked', by: 'operator' }],
              links: [],
              blockers: []
            }
          ],
          sessions: [{ id: LEADER, role: 'leads', from: '2026-11-14T10:00:00Z', to: null }],
          links: [],
          blockers: []
        },
        '# Log\n'
      )
    )
  }

  it('mission:handOff with no starter wired says so and changes nothing', async () => {
    await seedV4()
    h.handlers.clear()
    ipc.registerMissionIpc()
    ipc.setMissionHandoffStarter(null)
    const reply = await h.handlers.get('mission:handOff')!({}, { folder: root, missionId: ID })
    expect(reply).toMatchObject({ ok: false, code: 'HANDOFF_UNAVAILABLE' })
  })

  it('mission:handOff runs the one hand-off: it starts one session, and replies with the id and no record', async () => {
    await seedV4()
    const calls: Array<{ folder: string; prompt: string }> = []
    h.handlers.clear()
    ipc.registerMissionIpc()
    ipc.setMissionHandoffStarter(async (args) => {
      calls.push(args)
      return { ok: true, sessionId: NEW_ONE }
    })
    const reply = (await h.handlers.get('mission:handOff')!(
      {},
      {
        folder: root,
        missionId: ID,
        sessionId: LEADER,
        actor: { kind: 'session', sessionId: LEADER }
      }
    )) as Record<string, unknown>
    expect(reply).toMatchObject({ ok: true, sessionId: NEW_ONE, previousLeader: LEADER })
    expect(reply).not.toHaveProperty('record')
    expect(reply).not.toHaveProperty('file')
    expect(calls).toHaveLength(1)
    expect(calls[0].folder).toBe(root)
    expect(calls[0].prompt).toContain('Hand off')
    ipc.setMissionHandoffStarter(null)
  })

  it('the view carries the offer from a LIVE reading of the leader’s context, and never starts anything', async () => {
    await seedV4()
    const started: unknown[] = []
    ipc.setMissionHandoffStarter(async (a) => {
      started.push(a)
      return { ok: true, sessionId: NEW_ONE }
    })
    const view = async (
      contexts: Array<{ sessionId: string; contextPercent: number | null }>,
      extra: Record<string, unknown> = {}
    ): Promise<{ handoff?: unknown }> =>
      (await ipc.buildMissionV4View(
        { folder: root, sessionId: 'app', missionId: ID, ...extra },
        { contexts: () => contexts }
      )) as { handoff?: unknown }

    expect((await view([{ sessionId: LEADER, contextPercent: 95 }])).handoff).toEqual({
      offer: true,
      percent: 95
    })
    expect((await view([{ sessionId: LEADER, contextPercent: 40 }])).handoff).toEqual({
      offer: false,
      percent: 40
    })
    // no live reading for the leader (null, or another session's), no offer
    expect((await view([{ sessionId: LEADER, contextPercent: null }])).handoff).toEqual({
      offer: false,
      percent: null
    })
    expect((await view([{ sessionId: 'someone-else', contextPercent: 99 }])).handoff).toEqual({
      offer: false,
      percent: null
    })
    expect((await view([])).handoff).toEqual({ offer: false, percent: null })
    // "Not now" at 82: quiet until 87
    const quiet = await view([{ sessionId: LEADER, contextPercent: 85 }], { dismissedPercent: 82 })
    expect(quiet.handoff).toEqual({ offer: false, percent: 85 })
    expect(started).toHaveLength(0)
    ipc.setMissionHandoffStarter(null)
  })

  it('a last-known (stale) reading never produces an offer: only a live one does', async () => {
    await seedV4()
    vi.resetModules()
    vi.doMock('../src/main/telemetry-store', () => ({
      getTelemetryPayload: () => ({
        perSession: [],
        lastKnown: [{ sessionId: LEADER, contextPercent: 97 }]
      })
    }))
    try {
      const fresh = await import('../src/main/mission-ipc')
      const view = (await fresh.buildMissionV4View({
        folder: root,
        sessionId: 'app',
        missionId: ID
      })) as { handoff?: unknown }
      expect(view.handoff).toEqual({ offer: false, percent: null })
    } finally {
      vi.doUnmock('../src/main/telemetry-store')
    }
  })

  it('answerMissionSummaryHook serves the open leader after a compaction, and prints nothing for anyone else', async () => {
    await seedV4()
    const body = (sessionId: string, source = 'compact'): Record<string, unknown> => ({
      session_id: sessionId,
      cwd: root,
      source
    })
    const text = await ipc.answerMissionSummaryHook(body(LEADER))
    expect(text).toContain('Hand off')
    expect(text.length).toBeLessThan(10_000)
    expect(await ipc.answerMissionSummaryHook(body('b6b6b6b6-0000-4000-8000-0000000000b6'))).toBe(
      ''
    )
    expect(await ipc.answerMissionSummaryHook(body(LEADER, 'startup'))).toBe('')
  })
})

describe('mission:pathKinds — the dropdown’s read-only existence check (S-4)', () => {
  it('says file, dir or missing for each absolute path, and reads nothing else', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-pathkinds-'))
    try {
      const file = path.join(dir, 'report.md')
      await fs.writeFile(file, 'x')
      const gone = path.join(dir, 'gone')
      h.handlers.clear()
      ipc.registerMissionIpc()
      const handler = h.handlers.get('mission:pathKinds')
      expect(handler).toBeTypeOf('function')
      expect(await handler!(null, [dir, file, gone, 'relative/path', 42])).toEqual({
        [dir]: 'dir',
        [file]: 'file',
        [gone]: 'missing',
        'relative/path': 'missing'
      })
      // Anything but a list answers nothing, and a long list is cut.
      expect(await handler!(null, 'nope')).toEqual({})
      const many = Array.from({ length: ipc.PATH_KINDS_MAX + 10 }, (_, i) =>
        path.join(dir, `n${i}`)
      )
      expect(Object.keys((await handler!(null, many)) as object)).toHaveLength(ipc.PATH_KINDS_MAX)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
