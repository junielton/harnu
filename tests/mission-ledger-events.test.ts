/**
 * Campaign ch.1 (T593, spec §3.2/§8 AC-3) — the Harnu-written ledger. Each write-time event (a dispatch,
 * a worktree cut, a manifest drain) records exactly one row `{ at, kind, stepId?, ref }` on the mission
 * it belongs to; no verb takes a row as input.
 *
 * Missions v4 S-40: the rows go to the ledger STORE beside the mission (`readObservedLedger`), never into
 * a mission file, so a v3 file stays exactly as a v3 build left it and a v4 record is never rewritten by an
 * event. The v3 verdict row and compaction row, the v3 observer's PR / CI / session-death rows and the
 * `mission_get` tail are gone with the v3 stack; every case here runs on a v3 file and on a v4 record.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { LEDGER_KINDS, type LedgerRow } from '../src/main/mission-ledger'
import { buildMissionRecordContent, type MissionV4 } from '../src/main/missions/model'
import { buildV3MissionFile, v3MissionObject, v3MissionPath } from './helpers/v3-mission-file'

const h = vi.hoisted(() => ({ userDataDir: '', scan: [] as unknown[] }))

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
  scanFolders: async (): Promise<unknown[]> => h.scan
}))
vi.mock('../src/main/mcp/create-session-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/mcp/create-session-core')>()),
  runCreateSession: async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          op: 'create_session',
          result: { sessionId: 'dddddddd-eeee-4fff-8000-111111111111' }
        })
      }
    ]
  })
}))
vi.mock('../src/main/worktree-ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/worktree-ipc')>()),
  createWorktree: async () => ({
    path: '/repo/.claude/worktrees/card-T1',
    base: 'main',
    branch: 'card/T1',
    warnings: []
  })
}))
vi.mock('../src/main/roadmap-ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/roadmap-ipc')>()),
  buildManifestDisclosure: async () => ({
    ok: true,
    resolved: [{ slug: 'T1', title: 'T1', kind: 'feature', complexity: 'standard', gaps: [] }]
  }),
  stampManifestApprovals: async () => ({ stamped: ['T1'], failed: [] })
}))

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

const OWNER = '11111111-2222-4333-8444-555555555555'
const BUILDER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const MISSION_ID = 'mnt-0000000a'
const AT = '2026-11-01T09:00:00.000Z'

let root = ''
let handlers: Record<string, Handler>

/** A v3 file: step 1 links the card `T1`, a PR and the builder session. */
async function seedV3(): Promise<string> {
  const file = v3MissionPath(root, MISSION_ID, 'ledger')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    buildV3MissionFile(
      v3MissionObject(root, {
        steps: [
          {
            id: 'stp-1',
            ordinal: 1,
            kind: 'custom',
            title: 'Step 1',
            verification: 'verifier',
            proof: 'unproven',
            links: [
              { kind: 'card', ref: 'T1' },
              { kind: 'pr', ref: '#7' },
              { kind: 'session', ref: BUILDER }
            ],
            blockers: []
          },
          {
            id: 'stp-2',
            ordinal: 2,
            kind: 'fixed-end',
            title: 'Delivered and verified',
            verification: 'verifier',
            proof: 'unproven',
            links: [],
            blockers: []
          }
        ]
      }),
      '# Ledger\n\n## Log\n'
    )
  )
  return file
}

/** A v4 record: step 1 was dispatched for the card `T1` and links a PR. */
async function seedV4(): Promise<string> {
  const dir = path.join(root, '.harnu', 'missions-v4')
  await fs.mkdir(dir, { recursive: true })
  const rec = {
    schemaVersion: 4,
    id: MISSION_ID,
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
    sessions: [{ id: OWNER, role: 'leads', from: AT, to: null }],
    links: [],
    blockers: []
  } as unknown as MissionV4
  const file = path.join(dir, `${MISSION_ID}-ledger.md`)
  await fs.writeFile(file, buildMissionRecordContent(rec, '# Log\n'))
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

/** The rows the ledger store holds for the mission, after the pending write lands. */
async function ledgerOf(): Promise<LedgerRow[]> {
  const store = await import('../src/main/missions/ledger-store')
  await store.flushLedgerStore()
  return store.readObservedLedger(root, MISSION_ID)
}

const ofKind = (rows: LedgerRow[], kind: string): LedgerRow[] => rows.filter((r) => r.kind === kind)

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-ledger-ud-'))
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-ledger-repo-')), 'main')
  await fs.mkdir(root)
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  h.scan = []
  vi.resetModules()
  const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
  handlers = Object.fromEntries(WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
})

describe.each([
  ['a v3 file', seedV3],
  ['a v4 record', seedV4]
] as const)('write-time events on %s — rows go to the ledger store', (_label, seed) => {
  let file = ''
  let before = ''

  beforeEach(async () => {
    file = await seed()
    before = await fs.readFile(file, 'utf8')
  })

  it('create_session records one dispatched row naming the new session', async () => {
    await handlers.create_session({ folder: root }, ctx())
    const rows = ofKind(await ledgerOf(), 'dispatched')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'dispatched',
      ref: 'dddddddd-eeee-4fff-8000-111111111111',
      sessionId: 'dddddddd-eeee-4fff-8000-111111111111'
    })
    expect(Number.isFinite(Date.parse(rows[0].at))).toBe(true)
  })

  it('create_worktree records one worktree row naming the new path and branch', async () => {
    await handlers.create_worktree({ folder: root, branch: 'card/T1' }, ctx())
    const rows = ofKind(await ledgerOf(), 'worktree')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      ref: '/repo/.claude/worktrees/card-T1',
      branch: 'card/T1'
    })
  })

  it('submit_manifest records one dispatched row per stamped card, on the step that names it', async () => {
    await handlers.submit_manifest({ folder: root, cards: [{ slug: 'T1' }] }, ctx())
    const rows = ofKind(await ledgerOf(), 'dispatched')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ref: 'T1', stepId: 'stp-1', detail: 'manifest' })
  })

  it('lands in the store, append-only, in the order the events happened', async () => {
    await handlers.create_session({ folder: root }, ctx())
    await handlers.create_worktree({ folder: root, branch: 'card/T1' }, ctx())
    const ledgerFile = path.join(root, '.harnu', 'missions', `${MISSION_ID}.ledger.jsonl`)
    await ledgerOf()
    const lines = (await fs.readFile(ledgerFile, 'utf8')).split('\n').filter(Boolean)
    expect(lines.map((l) => (JSON.parse(l) as LedgerRow).kind)).toEqual(['dispatched', 'worktree'])
  })

  it('never rewrites the mission file, whatever the events record', async () => {
    await handlers.create_session({ folder: root }, ctx())
    await handlers.create_worktree({ folder: root, branch: 'card/T1' }, ctx())
    await handlers.submit_manifest({ folder: root, cards: [{ slug: 'T1' }] }, ctx())
    expect(await ledgerOf()).toHaveLength(3)
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })
})

describe('what an event is not', () => {
  it('a closed mission receives no row', async () => {
    const file = v3MissionPath(root, MISSION_ID, 'ledger')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      buildV3MissionFile(v3MissionObject(root, { status: 'closed', closedAs: 'delivered' }))
    )
    await handlers.create_session({ folder: root }, ctx())
    expect(await ledgerOf()).toEqual([])
  })

  it('with no mission in the repo there is nowhere to record, and the verb still succeeds', async () => {
    const res = await handlers.create_session({ folder: root }, ctx())
    expect(res.isError).not.toBe(true)
    expect(await ledgerOf()).toEqual([])
  })

  it('no mission verb accepts a ledger row: the argument is ignored, never written', async () => {
    await seedV4()
    await handlers.mission_log(
      {
        folder: root,
        missionId: MISSION_ID,
        sessionId: OWNER,
        note: 'hello',
        ledger: [{ kind: 'pr-merged', ref: '#99' }]
      },
      ctx()
    )
    expect(ofKind(await ledgerOf(), 'pr-merged').filter((r) => r.ref === '#99')).toEqual([])
    const dir = path.join(root, '.harnu', 'missions-v4')
    // The call did write (its note is in the record's Log), and the row it carried is nowhere.
    const text = await fs.readFile(path.join(dir, (await fs.readdir(dir))[0]), 'utf8')
    expect(text).toContain('hello')
    expect(text).not.toContain('#99')
  })

  it('uses only the nine kinds', () => {
    expect(LEDGER_KINDS).toHaveLength(9)
  })
})
