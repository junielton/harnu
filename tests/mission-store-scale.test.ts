/**
 * BUG-278 — mission reads must not re-read and re-parse every mission file on every poll.
 *
 * A 30 s profile put js-yaml at 20% of the main thread: the mission-state feed, the `mission:list`
 * IPC and the hibernation sweep each read and parsed every mission file of every repo, closed ones
 * included, with no cache. These cases pin the fix, against real files in a temp repo:
 *
 * - AC-1: an unchanged file (name, mtime, size) is never read or parsed again; the directory is
 *   listed once per read, not once per file.
 * - AC-2: concurrent `listMissionViews` calls for the same roots share one read.
 * - AC-3: hibernation does no synchronous file I/O for missions.
 * - AC-4: scale: 300 files of ~100 KB, a second read with no change is < 10 ms and reads no file.
 * - AC-5: a change to a file shows on the next read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { v3MissionObject, v3MissionsDir, writeV3Mission } from './helpers/v3-mission-file'

const h = vi.hoisted(() => ({ userDataDir: '', syncCalls: [] as string[] }))

// Count the synchronous fs calls the app modules make (the test's own seeding runs outside the window).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const counted = <F extends (...a: never[]) => unknown>(name: string, fn: F): F =>
    ((...a: Parameters<F>) => {
      h.syncCalls.push(name)
      return fn(...a)
    }) as F
  return {
    ...actual,
    default: actual,
    readFileSync: counted('readFileSync', actual.readFileSync as never),
    readdirSync: counted('readdirSync', actual.readdirSync as never),
    statSync: counted('statSync', actual.statSync as never),
    realpathSync: counted('realpathSync', actual.realpathSync as never),
    existsSync: counted('existsSync', actual.existsSync as never)
  }
})

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

vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => []
}))

const LEADER = '8f2c1e4a-1111-4222-8333-944455556666'
const hex8 = (n: number): string => n.toString(16).padStart(8, '0')

let root: string
let spies: Array<{ mockRestore: () => void }> = []

/** `count` mission files of about `logBytes` each; mission `i` is led by `LEADER` when `i === 0`. */
function seed(count: number, logBytes: number): void {
  const log = `# log\n${'x'.repeat(logBytes)}\n`
  for (let i = 0; i < count; i++) {
    const id = `mnt-${hex8(i + 1)}`
    writeV3Mission(
      root,
      v3MissionObject(root, {
        id,
        slug: `m-${i}`,
        owner: {
          sessionId: i === 0 ? LEADER : `00000000-0000-4000-8000-${hex8(i).padStart(12, '0')}`,
          folder: root
        }
      }),
      log
    )
  }
}

beforeEach(async () => {
  vi.resetModules()
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-scale-ud-'))
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-scale-'))
  await fs.mkdir(path.join(root, '.git'), { recursive: true })
})

afterEach(async () => {
  for (const s of spies) s.mockRestore()
  spies = []
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(h.userDataDir, { recursive: true, force: true })
})

const spy = <T extends { mockRestore: () => void }>(s: T): T => {
  spies.push(s)
  return s
}

describe('readAllMissions cache (AC-1, AC-4, AC-5)', () => {
  it('AC-4: a second read of 300 files of ~100 KB, with no change, is < 10 ms (median of 7 warm runs) and reads no file', async () => {
    seed(300, 100_000)
    const { readAllMissions } = await import('../src/main/missions/store')
    const first = await readAllMissions(root)
    expect(first.missions).toHaveLength(300)

    const readFile = spy(vi.spyOn(fs, 'readFile'))
    // The bound stays 10 ms. One run on a loaded box can hit a GC pause or a busy thread pool, so the
    // gate is the median of 7 warm runs; the zero-readFile assertion over all of them is the primary one.
    const runs: number[] = []
    let second = first
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now()
      second = await readAllMissions(root)
      runs.push(performance.now() - t0)
    }
    const median = [...runs].sort((a, b) => a - b)[3]

    expect(second.missions).toHaveLength(300)
    expect(readFile).toHaveBeenCalledTimes(0)
    expect(median).toBeLessThan(10)
  })

  it('AC-1: lists the directory once per read, and re-reads only the file that changed', async () => {
    seed(20, 2_000)
    const { readAllMissions } = await import('../src/main/missions/store')
    await readAllMissions(root)

    const readdir = spy(vi.spyOn(fs, 'readdir'))
    const readFile = spy(vi.spyOn(fs, 'readFile'))
    await readAllMissions(root)
    expect(readdir).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledTimes(0)

    // One file changes (same size, so only the mtime tells): exactly that file is read again.
    const file = path.join(v3MissionsDir(root), `mnt-${hex8(3)}-m-2.md`)
    await new Promise((r) => setTimeout(r, 15))
    const text = await fs.readFile(file, 'utf8')
    readFile.mockClear()
    await fs.writeFile(file, text.replace('stp-1', 'stp-9'))
    await readAllMissions(root)
    const missionReads = readFile.mock.calls.filter((c) =>
      String(c[0]).startsWith(v3MissionsDir(root))
    )
    expect(missionReads).toHaveLength(1) // only the store's re-read of the changed file
  })

  it('AC-5: a change to a file is visible on the next read, even at the same size', async () => {
    seed(3, 500)
    const { readAllMissions } = await import('../src/main/missions/store')
    const before = await readAllMissions(root)
    expect(
      before.missions.find((m) => m.mission.id === `mnt-${hex8(1)}`)?.mission.owner.sessionId
    ).toBe(LEADER)

    const other = '8f2c1e4a-1111-4222-8333-944455556667' // same length as LEADER
    const file = path.join(v3MissionsDir(root), `mnt-${hex8(1)}-m-0.md`)
    await new Promise((r) => setTimeout(r, 15))
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(LEADER, other))

    const after = await readAllMissions(root)
    expect(
      after.missions.find((m) => m.mission.id === `mnt-${hex8(1)}`)?.mission.owner.sessionId
    ).toBe(other)
  })

  it('a deleted file leaves the list, and a file that turns corrupt is reported, not served stale', async () => {
    seed(3, 500)
    const { readAllMissions } = await import('../src/main/missions/store')
    await readAllMissions(root)
    await new Promise((r) => setTimeout(r, 15))
    await fs.rm(path.join(v3MissionsDir(root), `mnt-${hex8(2)}-m-1.md`))
    await fs.writeFile(
      path.join(v3MissionsDir(root), `mnt-${hex8(3)}-m-2.md`),
      '---\nstatus: [\n---\n'
    )
    const after = await readAllMissions(root)
    expect(after.missions.map((m) => m.mission.id)).toEqual([`mnt-${hex8(1)}`])
    expect(after.unreadable).toEqual([`mnt-${hex8(3)}-m-2.md`])
  })
})

describe('listMissionViews single-flight (AC-2)', () => {
  it('three concurrent calls for the same roots share one read of the files', async () => {
    seed(30, 2_000)
    const { listMissionViews } = await import('../src/main/mission-ipc')
    const readFile = spy(vi.spyOn(fs, 'readFile'))

    await Promise.all([
      listMissionViews([root]),
      listMissionViews([root]),
      listMissionViews([root])
    ])

    const missionReads = readFile.mock.calls.filter((c) =>
      String(c[0]).startsWith(v3MissionsDir(root))
    )
    expect(missionReads).toHaveLength(30)
  })
})

describe('hibernation reads no mission file synchronously (AC-3)', () => {
  it('openMissionLeaders does no sync file I/O', async () => {
    seed(10, 500)
    const { openMissionLeaders } = await import('../src/main/hibernation')
    h.syncCalls.length = 0
    openMissionLeaders([root])
    expect(h.syncCalls).toEqual([])
  })
})

// ---- Added once the fix was green: the v4 listing, the writers and the snapshot -----------------------------

const NOW_ISO = '2026-11-14T10:00:00Z'
const HANDOFF_LEADER = '2c9d0f1e-aaaa-4bbb-8ccc-ddddeeeeffff'

function v4Record(
  i: number,
  over: Partial<import('../src/main/missions/model').MissionV4> = {}
): import('../src/main/missions/model').MissionV4 {
  return {
    schemaVersion: 4,
    id: `mnt-${hex8(0xa000 + i)}`,
    title: `Score report ${i}`,
    doneWhen: 'Every candidate sees a score report',
    status: 'open',
    milestones: [],
    steps: [
      {
        id: 'stp-1',
        title: 'Load the test files',
        acs: [{ id: 'ac-1', text: 'The designer looked', by: 'operator' }],
        links: [],
        blockers: []
      }
    ],
    sessions: [
      {
        id: i === 0 ? LEADER : `${hex8(i)}-0000-4000-8000-000000000000`,
        role: 'leads',
        from: NOW_ISO,
        to: null
      }
    ],
    links: [],
    blockers: [],
    ...over
  }
}

async function seedV4(count: number): Promise<void> {
  const { createMissionRecord } = await import('../src/main/missions/record-store')
  for (let i = 0; i < count; i++) {
    const made = await createMissionRecord(
      root,
      v4Record(i),
      `# log ${i}\n${'x'.repeat(2_000)}\n`,
      `score-${i}`
    )
    if (!made.ok) throw new Error(made.error)
  }
}

describe('the v4 listing is cached too, and a write through the verbs shows on the next read (AC-1, AC-5)', () => {
  it('a second listMissionRecords and unreadableRecordFiles read no file', async () => {
    await seedV4(20)
    const { listMissionRecords, unreadableRecordFiles } =
      await import('../src/main/missions/record-store')
    expect((await listMissionRecords(root)).records).toHaveLength(20)
    await unreadableRecordFiles(root)

    const readFile = spy(vi.spyOn(fs, 'readFile'))
    expect((await listMissionRecords(root)).records).toHaveLength(20)
    expect(await unreadableRecordFiles(root)).toEqual([])
    expect(readFile).toHaveBeenCalledTimes(0)
  })

  it('a v3 mission file is converted once, not on every listing', async () => {
    seed(15, 1_000)
    const { listMissionRecords } = await import('../src/main/missions/record-store')
    await listMissionRecords(root)
    const readFile = spy(vi.spyOn(fs, 'readFile'))
    const again = await listMissionRecords(root)
    expect(again.records).toHaveLength(15)
    expect(readFile).toHaveBeenCalledTimes(0)
  })

  it('updateMissionRecord is visible on the next listing, with the file as long as before', async () => {
    await seedV4(3)
    const { listMissionRecords, updateMissionRecord } =
      await import('../src/main/missions/record-store')
    await listMissionRecords(root)
    const id = `mnt-${hex8(0xa000 + 1)}`
    const changed = await updateMissionRecord(root, id, (record, log) => ({
      record: { ...record, title: 'Score report X' }, // same length: only the stamp tells
      log
    }))
    if (!changed.ok) throw new Error(changed.error)
    const after = (await listMissionRecords(root)).records.find((r) => r.record.id === id)
    expect(after?.record.title).toBe('Score report X')
  })

  it('a record handed to a writer is the file as it is, never a frozen cached copy', async () => {
    await seedV4(2)
    const { listMissionRecords, updateMissionRecord } =
      await import('../src/main/missions/record-store')
    await listMissionRecords(root) // fills the cache
    const id = `mnt-${hex8(0xa000)}`
    const done = await updateMissionRecord(root, id, (record, log) => {
      record.title = 'mutated in place' // a writer is allowed to edit what it is given
      return { record, log }
    })
    expect(done.ok).toBe(true)
  })
})

describe('hibernation answers from a snapshot it refreshes in the background (AC-3)', () => {
  it('after a refresh, openMissionLeaders names the leaders (v3 and v4) with no sync file I/O', async () => {
    seed(5, 500)
    await seedV4(2)
    const { openMissionLeaders, refreshOpenMissionLeaders } =
      await import('../src/main/hibernation')
    await refreshOpenMissionLeaders([root])
    h.syncCalls.length = 0
    const leaders = openMissionLeaders([root])
    expect(h.syncCalls).toEqual([])
    expect(leaders.has(LEADER)).toBe(true) // v3 mission 1 and v4 record 0 share it
    expect(leaders.size).toBe(1 + 4 + 1) // the v3 leaders other than the first, plus the v4 one
  })

  it('a mission written through the verbs is in the snapshot without waiting for the next sweep', async () => {
    await seedV4(1)
    const { openMissionLeaders, refreshOpenMissionLeaders } =
      await import('../src/main/hibernation')
    const { updateMissionRecord } = await import('../src/main/missions/record-store')
    await refreshOpenMissionLeaders([root])
    expect(openMissionLeaders([root]).has(LEADER)).toBe(true)

    const id = `mnt-${hex8(0xa000)}`
    const handed = await updateMissionRecord(root, id, (record, log) => ({
      record: {
        ...record,
        sessions: [
          { id: LEADER, role: 'leads', from: NOW_ISO, to: '2026-11-14T11:00:00Z' },
          { id: HANDOFF_LEADER, role: 'leads', from: '2026-11-14T11:00:00Z', to: null }
        ]
      },
      log
    }))
    if (!handed.ok) throw new Error(handed.error)
    await refreshOpenMissionLeaders([root]) // joins the refresh the write started
    const leaders = openMissionLeaders([root])
    expect(leaders.has(HANDOFF_LEADER)).toBe(true)
    expect(leaders.has(LEADER)).toBe(false)
  })
})

describe('a shared read never serves a result older than a write (AC-5)', () => {
  it('a read that starts after a reported write does not join the one already under way', async () => {
    seed(3, 500)
    const { readAllMissions } = await import('../src/main/missions/store')
    const { invalidateMissionFile } = await import('../src/main/missions/file-cache')
    await readAllMissions(root)
    const first = readAllMissions(root)
    invalidateMissionFile(path.join(v3MissionsDir(root), `mnt-${hex8(1)}-m-0.md`))
    const second = readAllMissions(root)
    expect(second).not.toBe(first)
    await Promise.all([first, second])
  })
})
