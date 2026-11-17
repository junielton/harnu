/**
 * Missions v4 S-4 (R-25, D-20, AC-5, AC-6) — the one ledger store.
 *
 * What Harnu OBSERVES while reading a mission (a pull request opened or merged, CI, a builder
 * ending) is kept beside the mission, in the repo, append-only — not in a machine-local userData
 * cache. The observer pass writes it (a read never does, AC-4); the close-out consolidator reads
 * it from there, and rows the old cache already holds are copied in by the pass while the cache
 * itself is left alone.
 *
 * Missions v4 S-40: the v3 observer, which recorded pull-request and CI sightings of a v3 file, is gone,
 * and so is the v3 close-out that read the stored rows back. What still writes the store is a write-time
 * event (`recordLedgerEvent`: a dispatch, a worktree cut) and the pass that copies a closed mission's
 * cached rows; what still reads it is `readObservedLedger` and `missionLedgerCount`. Every case here runs
 * on those, with a v4 record (or, for the copy, a closed v3 file) as the mission.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { LedgerRow } from '../src/main/mission-ledger'
import { buildMissionRecordContent, type MissionV4 } from '../src/main/missions/model'
import { buildV3MissionFile, v3MissionObject, v3MissionPath } from './helpers/v3-mission-file'

const h = vi.hoisted(() => ({ userDataDir: '' }))

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

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

const OWNER = '11111111-2222-4333-8444-555555555555'
const MISSION_ID = 'mnt-0000000a'
const MERGED_AT = '2026-11-11T12:30:00.000Z'

let root = ''
let handlers: Record<string, Handler>

function payloadOf(res: ToolResult): Record<string, unknown> {
  expect(res.isError, res.content[0]?.text).not.toBe(true)
  return JSON.parse(res.content[0].text!) as Record<string, unknown>
}

const v4Dir = (): string => path.join(root, '.harnu', 'missions-v4')

/** An open v4 record with one step, which names the board card `T1` it was dispatched for. */
function record(id = MISSION_ID, over: Partial<MissionV4> = {}): MissionV4 {
  return {
    schemaVersion: 4,
    id,
    title: 'Ledger',
    doneWhen: 'The pull request is merged',
    status: 'open',
    milestones: [],
    steps: [
      {
        id: 'stp-1',
        title: 'Ship it',
        card: 'T1',
        acs: [{ id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }],
        links: [{ kind: 'pr', ref: '7' }],
        blockers: []
      }
    ],
    sessions: [{ id: OWNER, role: 'leads', from: '2026-11-01T09:00:00Z', to: null }],
    links: [],
    blockers: [],
    ...over
  } as MissionV4
}

/** Write a v4 record and return its file. */
async function seed(rec: MissionV4 = record()): Promise<string> {
  await fs.mkdir(v4Dir(), { recursive: true })
  const file = path.join(v4Dir(), `${rec.id}-ledger.md`)
  await fs.writeFile(file, buildMissionRecordContent(rec, '# Log\n'))
  return file
}

/** Write a closed v3 mission file: the one shape whose cached rows the observer pass still copies. */
async function seedClosedV3(id: string): Promise<void> {
  const file = v3MissionPath(root, id, 'ledger')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    buildV3MissionFile(v3MissionObject(root, { id, status: 'closed', closedAs: 'delivered' }))
  )
}

function ctx(): Record<string, unknown> {
  return {
    folder: root,
    folders: [{ path: root, sessions: [] }],
    denyFolders: [],
    bridge: { dispatch: async () => ({}), awaitMaterialization: async () => null }
  }
}

/** A fresh process: every module reloaded, the way a restart of Harnu sees the disk. */
async function boot(): Promise<void> {
  vi.resetModules()
  const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
  handlers = Object.fromEntries(WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
}

const ledgerFileOf = (id: string): string =>
  path.join(root, '.harnu', 'missions', `${id}.ledger.jsonl`)
const ledgerFile = (): string => ledgerFileOf(MISSION_ID)
const kinds = (rows: readonly LedgerRow[]): string[] => rows.map((r) => `${r.kind}:${r.ref}`)

async function rowsIn(file: string): Promise<LedgerRow[]> {
  const text = await fs.readFile(file, 'utf8')
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as LedgerRow)
}
const storedRows = (): Promise<LedgerRow[]> => rowsIn(ledgerFile())

const store = (): Promise<typeof import('../src/main/missions/ledger-store')> =>
  import('../src/main/missions/ledger-store')

/** What a write-time event does: the row goes to the store beside the mission it belongs to. */
async function recordEvent(
  hints: { folder?: string; card?: string },
  row: Omit<LedgerRow, 'at'>
): Promise<void> {
  const { recordLedgerEvent } = await import('../src/main/mcp/tool-handlers')
  await recordLedgerEvent(root, hints, row)
}

/** One observer pass over the repo (what copies a closed mission's cached rows). */
async function observe(): Promise<number> {
  const { observeOpenMissions } = await import('../src/main/mission-ipc')
  return observeOpenMissions([root], Date.now(), { v4Facts: () => noFacts })
}

const noFacts = {
  findPrs: async () => ({ ghAvailable: true, worktrees: {}, branches: {}, numbers: {} }),
  findMainCi: async () => ({ ghAvailable: true, byNumber: {} }),
  lastKnown: () => null,
  pathExists: async () => true,
  taskState: () => undefined
} as never

async function settle(): Promise<void> {
  await (await store()).flushLedgerStore()
}

const ci = (at: string, detail: string, ref = '#3'): LedgerRow => ({
  at,
  kind: 'ci',
  stepId: 'stp-1',
  ref,
  pr: Number(ref.slice(1)),
  detail
})
const details = (rows: readonly LedgerRow[], ref: string): Array<string | undefined> =>
  rows.filter((r) => r.kind === 'ci' && r.ref === ref).map((r) => r.detail)

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-ledger-store-ud-'))
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-ledger-store-repo-')), 'main')
  await fs.mkdir(root)
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  await boot()
})

describe('the ledger store (AC-5)', () => {
  it('stores a write-time event beside the mission, not in userData, and never touches the record', async () => {
    const file = await seed()
    const before = await fs.readFile(file)

    await recordEvent({ folder: root }, { kind: 'dispatched', ref: 'sess-1', sessionId: 'sess-1' })
    await settle()

    expect(kinds(await storedRows())).toEqual(['dispatched:sess-1'])
    expect((await (await store()).readObservedLedger(root, MISSION_ID)).map((r) => r.ref)).toEqual([
      'sess-1'
    ])
    // Beside the mission, under the repo's own data directory; the record file is byte for byte as it was.
    expect(ledgerFile()).toBe(path.join(root, '.harnu', 'missions', `${MISSION_ID}.ledger.jsonl`))
    expect((await fs.readFile(file)).equals(before)).toBe(true)
    // The userData cache receives no rows.
    const cache = await fs
      .readFile(path.join(h.userDataDir, 'mission-link-cache.json'), 'utf8')
      .catch(() => '{}')
    expect(JSON.parse(cache).ledger).toBeUndefined()
  })

  it('a read stores nothing: no ledger file appears under mission_list, a ledger read or the count', async () => {
    await seed()
    payloadOf(await handlers.mission_list({ folder: root }, ctx()))
    const { readObservedLedger, missionLedgerCount } = await store()
    expect(await readObservedLedger(root, MISSION_ID)).toEqual([])
    expect(await missionLedgerCount(root, { id: MISSION_ID, status: 'open' })).toBe(0)
    await settle()
    await expect(fs.stat(ledgerFile())).rejects.toThrow()
    await expect(fs.stat(path.join(root, '.harnu', 'missions'))).rejects.toThrow()
  })

  it('a restart records a row once: the same row recorded again adds nothing', async () => {
    await seed()
    const row = ci('2026-11-12T10:00:00.000Z', 'failing', '#7')
    let s = await store()
    s.bindMissionRoot(MISSION_ID, root)
    s.recordObserved(MISSION_ID, [row])
    await s.flushLedgerStore()
    const first = await storedRows()

    await boot()
    s = await store()
    s.bindMissionRoot(MISSION_ID, root)
    s.recordObserved(MISSION_ID, [row])
    s.recordObserved(MISSION_ID, [row])
    await s.flushLedgerStore()

    expect(await storedRows()).toEqual(first)
    expect(first).toHaveLength(1)
    expect(await s.readObservedLedger(root, MISSION_ID)).toEqual(first)
  })

  it('is append-only: a row already stored is never rewritten', async () => {
    await seed()
    await recordEvent({ folder: root }, { kind: 'dispatched', ref: 'sess-1' })
    await settle()
    const text = await fs.readFile(ledgerFile(), 'utf8')

    await recordEvent({ folder: root }, { kind: 'worktree', ref: '/repo/wt', branch: 'card/T1' })
    await settle()

    const next = await fs.readFile(ledgerFile(), 'utf8')
    expect(next.startsWith(text)).toBe(true)
    expect(next.length).toBeGreaterThan(text.length)
    expect(kinds(await storedRows())).toEqual(['dispatched:sess-1', 'worktree:/repo/wt'])
  })

  it('the count is the stored rows', async () => {
    await seed()
    await recordEvent({ folder: root }, { kind: 'dispatched', ref: 'a' })
    await recordEvent({ folder: root }, { kind: 'dispatched', ref: 'b' })
    await settle()
    await boot()
    const { missionLedgerCount } = await store()
    expect(await missionLedgerCount(root, { id: MISSION_ID, status: 'open' })).toBe(2)
  })

  it('a row goes to the mission whose step names the card, never to a closed one', async () => {
    await seed(record('mnt-0000000a'))
    await seed(record('mnt-0000000b', { status: 'closed', closedAs: 'delivered' } as never))
    await seed(
      record('mnt-0000000c', {
        steps: [{ ...record().steps[0], id: 'stp-1', card: 'T2' }] as never
      })
    )
    await recordEvent({ card: 'T2' }, { kind: 'dispatched', ref: 'sess-2', detail: 'manifest' })
    await settle()
    expect(kinds(await rowsIn(ledgerFileOf('mnt-0000000c')))).toEqual(['dispatched:sess-2'])
    expect((await rowsIn(ledgerFileOf('mnt-0000000c')))[0].stepId).toBe('stp-1')
    await expect(fs.stat(ledgerFileOf('mnt-0000000a'))).rejects.toThrow()
    await expect(fs.stat(ledgerFileOf('mnt-0000000b'))).rejects.toThrow()
  })
})

describe('every observed fact is stored, none is dropped for looking like another (AC-5)', () => {
  it('a CI state that returns is three rows, and the newest is the real one', async () => {
    await seed()
    let s = await store()
    s.bindMissionRoot(MISSION_ID, root)
    const states = ['failing', 'passing', 'failing']
    states.forEach((state, i) =>
      s.recordObserved(MISSION_ID, [ci(`2026-11-12T10:0${i}:00.000Z`, state, '#7')])
    )
    await s.flushLedgerStore()
    expect(details(await storedRows(), '#7')).toEqual(states)

    // Another process reads the same repo: it stores nothing more, and the newest is still `failing`.
    await boot()
    s = await store()
    const rows = (await s.readObservedLedger(root, MISSION_ID)).filter((r) => r.kind === 'ci')
    expect(rows.map((r) => r.detail)).toEqual(states)
    expect(rows[rows.length - 1].detail).toBe('failing')
    expect(details(await storedRows(), '#7')).toEqual(states)
  })

  it('a returning CI state across instances: the real newest row is stored and is the newest read', async () => {
    await seed()
    // Another instance already stored its sightings.
    await fs.mkdir(path.dirname(ledgerFile()), { recursive: true })
    await fs.writeFile(
      ledgerFile(),
      [
        ci('2026-11-12T10:00:00.000Z', 'failing', '#7'),
        ci('2026-11-12T10:10:00.000Z', 'passing', '#7')
      ]
        .map((r) => `${JSON.stringify(r)}\n`)
        .join('')
    )
    // This instance saw the same world a little later, and then CI went red again.
    const s = await store()
    s.bindMissionRoot(MISSION_ID, root)
    s.recordObserved(MISSION_ID, [
      ci('2026-11-12T10:00:20.000Z', 'failing', '#7'),
      ci('2026-11-12T10:10:00.000Z', 'passing', '#7'),
      ci('2026-11-12T10:20:00.000Z', 'failing', '#7')
    ])
    await s.flushLedgerStore()

    const stored = (await storedRows()).filter((r) => r.kind === 'ci' && r.ref === '#7')
    expect(stored).toContainEqual(
      expect.objectContaining({ at: '2026-11-12T10:20:00.000Z', detail: 'failing' })
    )
    const newest = [...stored].sort((a, b) => a.at.localeCompare(b.at)).at(-1)
    expect(newest).toMatchObject({ at: '2026-11-12T10:20:00.000Z', detail: 'failing' })

    // And a read shows the real state: the newest CI row is the failing one.
    const rows = (await s.readObservedLedger(root, MISSION_ID)).filter(
      (r) => r.kind === 'ci' && r.ref === '#7'
    )
    expect(rows.at(-1)).toMatchObject({ at: '2026-11-12T10:20:00.000Z', detail: 'failing' })
  })

  it('a row stored by another instance does not hide a real change of this one', async () => {
    await seed()
    await fs.mkdir(path.dirname(ledgerFile()), { recursive: true })
    await fs.writeFile(
      ledgerFile(),
      [
        ci('2026-11-12T10:00:00.000Z', 'failing', '#7'),
        ci('2026-11-12T10:05:00.000Z', 'passing', '#7')
      ]
        .map((r) => `${JSON.stringify(r)}\n`)
        .join('')
    )
    const s = await store()
    s.bindMissionRoot(MISSION_ID, root)
    s.recordObserved(MISSION_ID, [ci('2026-11-12T10:09:00.000Z', 'failing', '#7')])
    await s.flushLedgerStore()
    expect(details(await storedRows(), '#7')).toEqual(['failing', 'passing', 'failing'])
  })
})

describe('the polled list does not read a ledger file per closed mission (hot path)', () => {
  const CLOSED = 'mnt-0000000b'

  async function seedClosedWithFile(): Promise<void> {
    await seedClosedV3(CLOSED)
    await fs.writeFile(
      ledgerFileOf(CLOSED),
      `${JSON.stringify({ at: MERGED_AT, kind: 'pr-merged', stepId: 'stp-1', ref: '#7', pr: 7 })}\n`
    )
  }

  const ledgerReads = (spy: ReturnType<typeof vi.spyOn>): number =>
    spy.mock.calls.filter((c) => String(c[0]).endsWith('.ledger.jsonl')).length

  it('the count of a closed mission is read once, then answered from memory', async () => {
    await seedClosedWithFile()
    await seed()
    const { missionLedgerCount } = await store()
    const spy = vi.spyOn(fs, 'readFile')
    const closed = { id: CLOSED, status: 'closed' }
    const open = { id: MISSION_ID, status: 'open' }
    expect(await missionLedgerCount(root, closed)).toBe(1)
    const afterFirst = ledgerReads(spy)
    expect(afterFirst).toBeGreaterThan(0)
    expect(await missionLedgerCount(root, closed)).toBe(1)
    expect(await missionLedgerCount(root, closed)).toBe(1)
    expect(ledgerReads(spy)).toBe(afterFirst)
    // An open mission is counted from the store each time.
    await missionLedgerCount(root, open)
    await missionLedgerCount(root, open)
    expect(ledgerReads(spy) - afterFirst).toBe(2)
    spy.mockRestore()
  })

  it('the renderer poll (mission:list) reads no ledger file at all', async () => {
    await seedClosedWithFile()
    await seed()
    const spy = vi.spyOn(fs, 'readFile')
    const ipc = await import('../src/main/mission-ipc')
    await ipc.listMissionViews([root])
    await ipc.listMissionViews([root])
    expect(ledgerReads(spy)).toBe(0)
    spy.mockRestore()
  })
})

describe('importing the userData cache (AC-6)', () => {
  const CLOSED = 'mnt-0000000b'
  const cached: LedgerRow[] = [
    { at: '2026-10-20T08:00:00.000Z', kind: 'pr-opened', stepId: 'stp-1', ref: '#3', pr: 3 },
    { at: '2026-10-21T08:00:00.000Z', kind: 'pr-merged', stepId: 'stp-1', ref: '#3', pr: 3 }
  ]

  async function writeCache(missionId: string): Promise<string> {
    const sidecar = path.join(h.userDataDir, 'mission-link-cache.json')
    await fs.writeFile(
      sidecar,
      JSON.stringify({ version: 1, entries: {}, ledger: { [missionId]: cached } }, null, 1)
    )
    return sidecar
  }

  it('a read copies nothing: the cache rows show, but no ledger file is written and the cache is untouched', async () => {
    await seed()
    const sidecar = await writeCache(MISSION_ID)
    const before = await fs.readFile(sidecar)
    await boot()

    const { ensureLinkCacheLoaded, flushLinkCache } = await import('../src/main/mission-link-cache')
    await ensureLinkCacheLoaded()
    const rows = await (await store()).readObservedLedger(root, MISSION_ID)
    payloadOf(await handlers.mission_list({ folder: root }, ctx()))
    await settle()
    await flushLinkCache()

    // Read as they are, never imported: nothing was written beside the mission...
    expect(rows).toEqual(cached)
    await expect(fs.stat(ledgerFile())).rejects.toThrow()
    // ...and the cache file is byte for byte what it was.
    expect((await fs.readFile(sidecar)).equals(before)).toBe(true)
  })

  it('a closed mission is covered: the pass copies its cached rows into the repo store and keeps the cache', async () => {
    await seedClosedV3(CLOSED)
    const sidecar = await writeCache(CLOSED)
    const before = await fs.readFile(sidecar, 'utf8')
    await boot()

    // The mission is closed: nothing is derived or observed, so the pass counts none.
    expect(await observe()).toBe(0)
    await settle()

    // Copied into the repo store: exactly the cached rows, each once.
    expect(await rowsIn(ledgerFileOf(CLOSED))).toEqual(cached)
    // The cache is kept, and the mission reads the same rows once the cache is gone.
    expect(await fs.readFile(sidecar, 'utf8')).toBe(before)
    await fs.rm(sidecar)
    await boot()
    const s = await store()
    expect(kinds(await s.readObservedLedger(root, CLOSED))).toEqual([
      'pr-opened:#3',
      'pr-merged:#3'
    ])
    expect(await s.missionLedgerCount(root, { id: CLOSED, status: 'closed' })).toBe(2)
  })

  it('the cache holding the same CI state twice in a row: both rows are copied and counted', async () => {
    await seedClosedV3(CLOSED)
    await fs.writeFile(
      path.join(h.userDataDir, 'mission-link-cache.json'),
      JSON.stringify({
        version: 1,
        entries: {},
        ledger: {
          [CLOSED]: [
            ci('2026-10-20T08:00:00.000Z', 'passing'),
            ci('2026-10-20T09:00:00.000Z', 'passing')
          ]
        }
      })
    )
    await boot()
    await observe()
    await settle()

    const stored = await rowsIn(ledgerFileOf(CLOSED))
    expect(details(stored, '#3')).toEqual(['passing', 'passing'])
    expect(await (await store()).missionLedgerCount(root, { id: CLOSED, status: 'closed' })).toBe(2)
  })

  it('a closed mission with nothing in the cache costs the pass no ledger read', async () => {
    await seedClosedV3(CLOSED)
    const spy = vi.spyOn(fs, 'readFile')
    await observe()
    await observe()
    expect(spy.mock.calls.filter((c) => String(c[0]).endsWith('.ledger.jsonl'))).toHaveLength(0)
    spy.mockRestore()
  })

  it('copying twice, across restarts, stores each cached row once', async () => {
    await seedClosedV3(CLOSED)
    await writeCache(CLOSED)
    for (let i = 0; i < 2; i++) {
      await boot()
      await observe()
      await settle()
    }
    const stored = await rowsIn(ledgerFileOf(CLOSED))
    for (const row of cached) {
      expect(stored.filter((r) => r.at === row.at && r.kind === row.kind)).toHaveLength(1)
    }
  })
})
