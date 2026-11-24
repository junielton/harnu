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
  it('AC-4: a second read of 300 files of ~100 KB, with no change, is < 10 ms and reads no file', async () => {
    seed(300, 100_000)
    const { readAllMissions } = await import('../src/main/missions/store')
    const first = await readAllMissions(root)
    expect(first.missions).toHaveLength(300)

    const readFile = spy(vi.spyOn(fs, 'readFile'))
    const t0 = performance.now()
    const second = await readAllMissions(root)
    const ms = performance.now() - t0

    expect(second.missions).toHaveLength(300)
    expect(readFile).toHaveBeenCalledTimes(0)
    expect(ms).toBeLessThan(10)
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
    expect(missionReads).toHaveLength(2) // the test's own read above + the store's one re-read
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
