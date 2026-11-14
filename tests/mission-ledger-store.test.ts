/**
 * Missions v4 S-4 (R-25, D-20, AC-5, AC-6) — the one ledger store.
 *
 * What Harnu OBSERVES while reading a mission (a pull request opened or merged, CI, a builder
 * ending) is kept beside the mission, in the repo, append-only — not in a machine-local userData
 * cache. The close-out consolidator reads it from there, and rows the old cache already holds
 * are copied in while the cache itself is left alone.
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
async function seed(): Promise<string> {
  const at = '2026-11-01T09:00:00.000Z'
  const mission: Mission = {
    id: MISSION_ID,
    slug: 'ledger',
    folder: root,
    owner: { sessionId: OWNER, folder: root },
    status: 'active',
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
  const file = missionFilePath(root, MISSION_ID, mission.slug)
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
const ledgerFile = (): string => path.join(missionsDir(root), `${MISSION_ID}.ledger.jsonl`)
const kinds = (rows: LedgerRow[]): string[] => rows.map((r) => `${r.kind}:${r.ref}`)

async function storedRows(): Promise<LedgerRow[]> {
  const text = await fs.readFile(ledgerFile(), 'utf8')
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as LedgerRow)
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
  it('stores the rows a read observed beside the mission, not in userData', async () => {
    const file = await seed()
    const before = await fs.readFile(file)

    const ack = payloadOf(await read())
    await settle()

    expect(kinds(ack.ledger as LedgerRow[])).toEqual(
      expect.arrayContaining(['pr-merged:#7', 'ci:#7'])
    )
    expect(kinds(await storedRows())).toEqual(expect.arrayContaining(['pr-merged:#7', 'ci:#7']))
    // Beside the mission file, and the mission file itself is untouched by the read.
    expect(path.dirname(ledgerFile())).toBe(path.dirname(file))
    expect((await fs.readFile(file)).equals(before)).toBe(true)
    // The userData cache no longer receives observed rows.
    const cache = await fs
      .readFile(path.join(h.userDataDir, 'mission-link-cache.json'), 'utf8')
      .catch(() => '{}')
    expect(JSON.parse(cache).ledger).toBeUndefined()
  })

  it('consolidator sees observed rows', async () => {
    const file = await seed()
    payloadOf(await read())
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

  it('a restart records a row once: the same world read again adds nothing', async () => {
    await seed()
    payloadOf(await read())
    await settle()
    const first = await storedRows()

    await boot()
    payloadOf(await read())
    payloadOf(await read())
    await settle()

    expect(await storedRows()).toEqual(first)
    expect(payloadOf(await read()).ledgerCount).toBe(first.length)
  })

  it('is append-only: a row already stored is never rewritten', async () => {
    await seed()
    payloadOf(await read())
    await settle()
    const text = await fs.readFile(ledgerFile(), 'utf8')

    h.pr = { state: 'MERGED', ci: 'failing', mergedAt: MERGED_AT }
    payloadOf(await read())
    await settle()

    const next = await fs.readFile(ledgerFile(), 'utf8')
    expect(next.startsWith(text)).toBe(true)
    expect(next.length).toBeGreaterThan(text.length)
  })

  it('mission_list counts the stored rows too', async () => {
    await seed()
    payloadOf(await read())
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

    const ack = payloadOf(await read())
    await settle()
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

  it('copying twice, across restarts, stores each cached row once', async () => {
    await seed()
    await writeCache()
    for (let i = 0; i < 2; i++) {
      await boot()
      payloadOf(await read())
      await settle()
    }
    const stored = await storedRows()
    for (const row of cached) {
      expect(stored.filter((r) => r.at === row.at && r.kind === row.kind)).toHaveLength(1)
    }
  })
})
