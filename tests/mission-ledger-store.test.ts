/**
 * Missions v4 S-4 (R-25, D-20, AC-5, AC-6) — the one ledger store.
 *
 * What Harnu OBSERVES while reading a mission (a pull request opened or merged, CI, a builder
 * ending) is kept beside the mission, in the repo, append-only — not in a machine-local userData
 * cache. The observer pass writes it (a read never does, AC-4); the close-out consolidator reads
 * it from there, and rows the old cache already holds are copied in by the pass while the cache
 * itself is left alone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildMissionFileContent,
  missionFilePath,
  missionsDir,
  parseMissionFile,
  type LedgerRow,
  type Mission,
  type MissionStep
} from '../src/main/mission-core'
import type { MissionPrJoin } from '../src/main/pr-stack'

const h = vi.hoisted(() => ({
  userDataDir: '',
  pr: { state: 'MERGED', ci: 'passing' } as {
    state: string
    ci: string
    createdAt?: string
    mergedAt?: string
  }
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
  findPrsForWorktrees: async (): Promise<MissionPrJoin> =>
    ({
      ghAvailable: true,
      worktrees: {},
      branches: {},
      numbers: {
        7: {
          number: 7,
          title: 'PR 7',
          branch: 'feat/7',
          base: 'main',
          state: h.pr.state,
          isDraft: false,
          mergeable: null,
          reviewDecision: null,
          ci: h.pr.ci,
          checks: [],
          url: 'https://example.test/pull/7',
          author: 'dev',
          updatedAt: null,
          createdAt: h.pr.createdAt ?? null,
          mergedAt: h.pr.mergedAt ?? null,
          headOid: null,
          nodeId: null
        }
      }
    }) as unknown as MissionPrJoin,
  findMainCi: async () => ({ ghAvailable: true, byNumber: {} })
}))
vi.mock('../src/main/scheduler-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/scheduler-shell')>()),
  wakeStewardForMission: async (): Promise<void> => {}
}))

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

const OWNER = '11111111-2222-4333-8444-555555555555'
const BUILDER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const VERIFIER = 'cccccccc-dddd-4eee-8fff-000000000000'
const MISSION_ID = 'mnt-0000000a'
const MERGED_AT = '2026-11-11T12:30:00.000Z'

let root = ''
let handlers: Record<string, Handler>

function payloadOf(res: ToolResult): Record<string, unknown> {
  expect(res.isError, res.content[0]?.text).not.toBe(true)
  return JSON.parse(res.content[0].text!) as Record<string, unknown>
}

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

/** A mission whose end is verified, so the agent may ask to close it, with one PR on step 1. */
async function seed(over: { id?: string; status?: Mission['status'] } = {}): Promise<string> {
  const at = '2026-11-01T09:00:00.000Z'
  const id = over.id ?? MISSION_ID
  const mission: Mission = {
    id,
    slug: 'ledger',
    folder: root,
    owner: { sessionId: OWNER, folder: root },
    status: over.status ?? 'active',
    ...(over.status === 'closed' ? { closedAs: 'delivered' as const } : {}),
    declaredEnd: { kind: 'code', target: 'ship it', evidence: 'the PR merged' },
    steps: [
      step('stp-1', {
        proof: 'verified',
        verifiedBy: { sessionId: VERIFIER, at, verdict: 'met' },
        links: [
          { kind: 'pr', ref: '#7' },
          { kind: 'session', ref: BUILDER }
        ]
      }),
      step('stp-2', {
        kind: 'fixed-end',
        title: 'Delivered and verified',
        proof: 'verified',
        verifiedBy: { sessionId: VERIFIER, at, verdict: 'met' }
      })
    ],
    blockers: [],
    openQuestions: [],
    createdAt: at,
    updatedAt: at,
    provenance: { author: 'agent', at }
  }
  const file = missionFilePath(root, id, mission.slug)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, buildMissionFileContent(mission, '# Ledger\n\n## Log\n'))
  return file
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

const read = (): Promise<ToolResult> =>
  handlers.mission_get({ folder: root, missionId: MISSION_ID }, ctx())
const ledgerFileOf = (id: string): string => path.join(missionsDir(root), `${id}.ledger.jsonl`)
const ledgerFile = (): string => ledgerFileOf(MISSION_ID)
const kinds = (rows: LedgerRow[]): string[] => rows.map((r) => `${r.kind}:${r.ref}`)

async function storedRows(): Promise<LedgerRow[]> {
  const text = await fs.readFile(ledgerFile(), 'utf8')
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as LedgerRow)
}

/** One observer pass over the repo: the only thing that records what Harnu saw (AC-4). */
async function observe(): Promise<void> {
  const { observeOpenMissions } = await import('../src/main/mission-ipc')
  await observeOpenMissions([root])
}

async function settle(): Promise<void> {
  const store = await import('../src/main/missions/ledger-store')
  await store.flushLedgerStore()
}

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-ledger-store-ud-'))
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-ledger-store-repo-')), 'main')
  await fs.mkdir(root)
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  h.pr = { state: 'MERGED', ci: 'passing', mergedAt: MERGED_AT }
  await boot()
})

describe('the ledger store (AC-5)', () => {
  it('stores the rows the observer pass saw beside the mission, not in userData', async () => {
    const file = await seed()
    const before = await fs.readFile(file)

    await observe()
    await settle()
    const ack = payloadOf(await read())

    expect(kinds(ack.ledger as LedgerRow[])).toEqual(
      expect.arrayContaining(['pr-merged:#7', 'ci:#7'])
    )
    expect(kinds(await storedRows())).toEqual(expect.arrayContaining(['pr-merged:#7', 'ci:#7']))
    // Beside the mission file, and the mission file itself is untouched by the pass.
    expect(path.dirname(ledgerFile())).toBe(path.dirname(file))
    expect((await fs.readFile(file)).equals(before)).toBe(true)
    // The userData cache no longer receives observed rows.
    const cache = await fs
      .readFile(path.join(h.userDataDir, 'mission-link-cache.json'), 'utf8')
      .catch(() => '{}')
    expect(JSON.parse(cache).ledger).toBeUndefined()
  })

  it('a read stores nothing: no ledger file appears under mission_get or mission_list', async () => {
    await seed()
    payloadOf(await read())
    payloadOf(await handlers.mission_list({ folder: root }, ctx()))
    await settle()
    await expect(fs.stat(ledgerFile())).rejects.toThrow()
    expect(await fs.readdir(path.join(root, '.harnu', 'missions'))).toHaveLength(1)
  })

  it('consolidator sees observed rows', async () => {
    const file = await seed()
    await observe()
    await settle()

    // A restart: nothing is in memory any more, the rows are only in the repo.
    await boot()
    const closed = payloadOf(
      await handlers.mission_request_close(
        { folder: root, missionId: MISSION_ID, sessionId: OWNER },
        ctx()
      )
    )
    expect(closed.ok).toBe(true)

    const parsed = parseMissionFile(await fs.readFile(file, 'utf8'))
    if ('error' in parsed) throw new Error(parsed.error)
    // The consolidator drew the step's merge time from a row only the observer wrote.
    const perStep = parsed.outcome?.perStep.find((s) => s.stepId === 'stp-1')
    expect(perStep?.mergedAt).toBe(MERGED_AT)
  })

  it('a restart records a row once: the same world observed again adds nothing', async () => {
    await seed()
    await observe()
    await settle()
    const first = await storedRows()

    await boot()
    await observe()
    await observe()
    await settle()

    expect(await storedRows()).toEqual(first)
    expect(payloadOf(await read()).ledgerCount).toBe(first.length)
  })

  it('is append-only: a row already stored is never rewritten', async () => {
    await seed()
    await observe()
    await settle()
    const text = await fs.readFile(ledgerFile(), 'utf8')

    h.pr = { state: 'MERGED', ci: 'failing', mergedAt: MERGED_AT }
    await observe()
    await settle()

    const next = await fs.readFile(ledgerFile(), 'utf8')
    expect(next.startsWith(text)).toBe(true)
    expect(next.length).toBeGreaterThan(text.length)
  })

  it('mission_list counts the stored rows too', async () => {
    await seed()
    await observe()
    await settle()
    const stored = (await storedRows()).length

    await boot()
    const list = payloadOf(await handlers.mission_list({ folder: root }, ctx()))
    const row = (list.missions as Array<{ id: string; ledgerCount: number }>).find(
      (m) => m.id === MISSION_ID
    )
    expect(row?.ledgerCount).toBe(stored)
  })
})

describe('what the pass records, as on main (AC-5)', () => {
  it('an open pull request gets a pr-opened row, and the consolidator reads openedAt from it', async () => {
    const OPENED_AT = '2026-11-10T10:00:00.000Z'
    const file = await seed()
    h.pr = { state: 'OPEN', ci: 'pending', createdAt: OPENED_AT }
    await observe()
    h.pr = { state: 'MERGED', ci: 'passing', createdAt: OPENED_AT, mergedAt: MERGED_AT }
    await observe()
    await settle()

    const stored = await storedRows()
    expect(stored).toContainEqual(
      expect.objectContaining({ kind: 'pr-opened', ref: '#7', at: OPENED_AT })
    )
    await boot()
    payloadOf(
      await handlers.mission_request_close(
        { folder: root, missionId: MISSION_ID, sessionId: OWNER },
        ctx()
      )
    )
    const parsed = parseMissionFile(await fs.readFile(file, 'utf8'))
    if ('error' in parsed) throw new Error(parsed.error)
    const perStep = parsed.outcome?.perStep.find((s) => s.stepId === 'stp-1')
    expect(perStep?.openedAt).toBe(OPENED_AT)
    expect(perStep?.mergedAt).toBe(MERGED_AT)
  })

  it('a pull request first seen already merged gets pr-merged and no pr-opened, as on main', async () => {
    await seed()
    await observe()
    await settle()
    expect(kinds(await storedRows())).toContain('pr-merged:#7')
    expect(kinds(await storedRows())).not.toContain('pr-opened:#7')
  })
})

describe('append by row identity (AC-5)', () => {
  const row = (over: Partial<LedgerRow>): LedgerRow => ({
    at: '2026-11-12T10:00:00.000Z',
    kind: 'ci',
    stepId: 'stp-1',
    ref: '#7',
    pr: 7,
    detail: 'passing',
    ...over
  })

  async function appendFromAnotherInstance(rows: LedgerRow[]): Promise<void> {
    await fs.mkdir(path.dirname(ledgerFile()), { recursive: true })
    await fs.writeFile(ledgerFile(), rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
  }

  it('a CI change another instance already stored is not stored again at a later time', async () => {
    await seed()
    await appendFromAnotherInstance([
      row({ at: '2026-11-12T10:00:00.000Z', detail: 'pending' }),
      row({ at: '2026-11-12T10:05:00.000Z', detail: 'passing' })
    ])
    const store = await import('../src/main/missions/ledger-store')
    store.bindMissionRoot(MISSION_ID, root)
    store.recordObserved(MISSION_ID, [row({ at: '2026-11-12T10:05:07.000Z', detail: 'passing' })])
    await store.flushLedgerStore()
    expect((await storedRows()).map((r) => r.detail)).toEqual(['pending', 'passing'])

    // A real change is still a new row, and so is going back to an earlier state.
    store.recordObserved(MISSION_ID, [
      row({ at: '2026-11-12T10:09:00.000Z', detail: 'failing' }),
      row({ at: '2026-11-12T10:12:00.000Z', detail: 'passing' })
    ])
    await store.flushLedgerStore()
    expect((await storedRows()).map((r) => r.detail)).toEqual([
      'pending',
      'passing',
      'failing',
      'passing'
    ])
  })

  it('a pr-merged another instance stored from GitHub is not stored again as an observation', async () => {
    await seed()
    await appendFromAnotherInstance([row({ kind: 'pr-merged', at: MERGED_AT, detail: undefined })])
    const store = await import('../src/main/missions/ledger-store')
    store.bindMissionRoot(MISSION_ID, root)
    store.recordObserved(MISSION_ID, [
      row({ kind: 'pr-merged', at: '2026-11-14T08:00:00.000Z', detail: 'observed' })
    ])
    await store.flushLedgerStore()
    expect(kinds(await storedRows())).toEqual(['pr-merged:#7'])
  })
})

describe('a close request before the cache was read in this process (AC-5)', () => {
  it('sees the rows only the userData cache holds', async () => {
    const file = await seed()
    await fs.writeFile(
      path.join(h.userDataDir, 'mission-link-cache.json'),
      JSON.stringify({
        version: 1,
        entries: {},
        ledger: {
          [MISSION_ID]: [{ at: MERGED_AT, kind: 'pr-merged', stepId: 'stp-1', ref: '#9', pr: 9 }]
        }
      })
    )
    await boot() // a fresh process: nothing has read the cache, no pass has run
    payloadOf(
      await handlers.mission_request_close(
        { folder: root, missionId: MISSION_ID, sessionId: OWNER },
        ctx()
      )
    )
    const parsed = parseMissionFile(await fs.readFile(file, 'utf8'))
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.outcome?.perStep.find((s) => s.stepId === 'stp-1')?.mergedAt).toBe(MERGED_AT)
  })
})

describe('the polled list does not read a ledger file per closed mission (hot path)', () => {
  const CLOSED = 'mnt-0000000b'

  async function seedClosedWithFile(): Promise<void> {
    await seed({ id: CLOSED, status: 'closed' })
    await fs.writeFile(
      ledgerFileOf(CLOSED),
      `${JSON.stringify({ at: MERGED_AT, kind: 'pr-merged', stepId: 'stp-1', ref: '#7', pr: 7 })}\n`
    )
  }

  const ledgerReads = (spy: ReturnType<typeof vi.spyOn>): number =>
    spy.mock.calls.filter((c) => String(c[0]).endsWith('.ledger.jsonl')).length

  it('mission_list counts a closed mission once, then answers from memory', async () => {
    await seedClosedWithFile()
    await seed()
    const spy = vi.spyOn(fs, 'readFile')
    const count = async (): Promise<number | undefined> => {
      const list = payloadOf(await handlers.mission_list({ folder: root }, ctx()))
      return (list.missions as Array<{ id: string; ledgerCount: number }>).find(
        (m) => m.id === CLOSED
      )?.ledgerCount
    }
    expect(await count()).toBe(1)
    const afterFirst = ledgerReads(spy)
    expect(await count()).toBe(1)
    expect(await count()).toBe(1)
    // Only the open mission's file is read on the later calls; the closed one is not.
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
  const cached: LedgerRow[] = [
    { at: '2026-10-20T08:00:00.000Z', kind: 'pr-opened', stepId: 'stp-1', ref: '#3', pr: 3 },
    { at: '2026-10-21T08:00:00.000Z', kind: 'pr-merged', stepId: 'stp-1', ref: '#3', pr: 3 }
  ]

  async function writeCache(): Promise<string> {
    const sidecar = path.join(h.userDataDir, 'mission-link-cache.json')
    await fs.writeFile(
      sidecar,
      JSON.stringify({ version: 1, entries: {}, ledger: { [MISSION_ID]: cached } }, null, 1)
    )
    return sidecar
  }

  it('import copies and keeps the cache', async () => {
    await seed()
    const sidecar = await writeCache()
    const before = await fs.readFile(sidecar, 'utf8')
    await boot()

    await observe()
    await settle()
    const ack = payloadOf(await read())
    const { flushLinkCache, rememberResolved } = await import('../src/main/mission-link-cache')
    rememberResolved('/elsewhere', 'pr', '1', { state: 'OPEN', prNumber: 1 })
    await flushLinkCache()

    // Copied: the rows are in the repo store, and the mission reads them.
    const stored = await storedRows()
    expect(stored).toEqual(expect.arrayContaining(cached))
    expect(kinds(ack.ledger as LedgerRow[])).toEqual(
      expect.arrayContaining(['pr-opened:#3', 'pr-merged:#3'])
    )
    // Kept: the cache file still carries every row it carried, even after it was rewritten.
    expect(await fs.readFile(sidecar, 'utf8')).not.toBe('')
    const after = JSON.parse(await fs.readFile(sidecar, 'utf8'))
    expect(after.ledger[MISSION_ID]).toEqual(cached)
    expect(JSON.parse(before).ledger[MISSION_ID]).toEqual(cached)
  })

  it('a read copies nothing: the cache rows show, but no ledger file is written and the cache is untouched', async () => {
    await seed()
    const sidecar = await writeCache()
    const before = await fs.readFile(sidecar)
    await boot()

    const ack = payloadOf(await read())
    payloadOf(await handlers.mission_list({ folder: root }, ctx()))
    await settle()
    const { flushLinkCache } = await import('../src/main/mission-link-cache')
    await flushLinkCache()

    // Read as they are, never imported: nothing was written beside the mission...
    expect(kinds(ack.ledger as LedgerRow[])).toEqual(
      expect.arrayContaining(['pr-opened:#3', 'pr-merged:#3'])
    )
    await expect(fs.stat(ledgerFile())).rejects.toThrow()
    // ...and the cache file is byte-for-byte what it was.
    expect((await fs.readFile(sidecar)).equals(before)).toBe(true)
  })

  it('a closed mission is covered too: the pass copies its cached rows without deriving or observing it', async () => {
    const CLOSED = 'mnt-0000000b'
    await seed({ id: CLOSED, status: 'closed' })
    const sidecar = path.join(h.userDataDir, 'mission-link-cache.json')
    await fs.writeFile(
      sidecar,
      JSON.stringify({ version: 1, entries: {}, ledger: { [CLOSED]: cached } }, null, 1)
    )
    await boot()

    const { observeOpenMissions } = await import('../src/main/mission-ipc')
    // The mission is closed: nothing is derived or observed, so the pass counts none.
    expect(await observeOpenMissions([root])).toBe(0)
    await settle()

    // Copied into the repo store, and only the cached rows (a derive would have added PR #7's).
    const text = await fs.readFile(ledgerFileOf(CLOSED), 'utf8')
    expect(
      text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    ).toEqual(cached)
    // The cache is kept, and the mission reads the same rows once the cache is gone.
    expect(JSON.parse(await fs.readFile(sidecar, 'utf8')).ledger[CLOSED]).toEqual(cached)
    await fs.rm(sidecar)
    await boot()
    const ack = payloadOf(await handlers.mission_get({ folder: root, missionId: CLOSED }, ctx()))
    expect(kinds(ack.ledger as LedgerRow[])).toEqual(['pr-opened:#3', 'pr-merged:#3'])
    expect(ack.ledgerCount).toBe(2)
  })

  it('a closed mission with nothing in the cache costs the pass no ledger read', async () => {
    await seed({ id: 'mnt-0000000b', status: 'closed' })
    const spy = vi.spyOn(fs, 'readFile')
    const { observeOpenMissions } = await import('../src/main/mission-ipc')
    await observeOpenMissions([root])
    await observeOpenMissions([root])
    expect(spy.mock.calls.filter((c) => String(c[0]).endsWith('.ledger.jsonl'))).toHaveLength(0)
    spy.mockRestore()
  })

  it('copying twice, across restarts, stores each cached row once', async () => {
    await seed()
    await writeCache()
    for (let i = 0; i < 2; i++) {
      await boot()
      await observe()
      await settle()
    }
    const stored = await storedRows()
    for (const row of cached) {
      expect(stored.filter((r) => r.at === row.at && r.kind === row.kind)).toHaveLength(1)
    }
  })
})
