/**
 * T358 S6 — the live signals around a mission, and `get_fleet` staying what it was (design
 * `docs/specs/2026-09-26-mission-progress/design.md` §7, AC-S6-3).
 *
 * Missions v4 S-40: `mission_get` no longer derives a v3 `derived` block (live child states, existence
 * proofs, sticky link resolutions, the step pulse) nor the deterministic stall rule: the v4 reader gathers
 * its facts in `missions/facts.ts` (`tests/mission-facts.test.ts`) and a mission has no `stale` state. What
 * is left of this suite is the claim that a fleet read keeps its shape while missions exist, and that a
 * mission read leaves the fleet's view of a session as it was.
 *
 * The handler is driven for real against a throwaway git repo; only the live sources are faked at their
 * module seams: the hook FSM, the PTY liveness set, the hibernation registry and the Approval Inbox.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { TaskState } from '../src/main/hook-state'
import type { HookTaskEvent } from '../src/main/hook-bridge'
import { buildV3MissionFile, v3MissionObject, v3MissionPath } from './helpers/v3-mission-file'

const h = vi.hoisted(() => ({
  userDataDir: '',
  taskStates: new Map<string, TaskState>(),
  live: new Set<string>(),
  parked: new Set<string>(),
  approvals: [] as Array<{ sessionId: string }>
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
  getTaskStates: () => h.taskStates,
  addTaskEventObserver: (_cb: (ev: HookTaskEvent) => void) => () => {}
}))

vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => []
}))
vi.mock('../src/main/pty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/pty')>()),
  liveSessionKeys: () => h.live
}))

vi.mock('../src/main/hibernation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/hibernation')>()),
  hibernatedKeys: () => h.parked
}))

vi.mock('../src/main/approval-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/approval-resolver')>()),
  listPendingApprovals: () => h.approvals
}))

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

const OWNER = '11111111-2222-4333-8444-555555555555'
const CHILD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CHILD2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const HOUR = 60 * 60 * 1000

function payloadOf(res: ToolResult): Record<string, unknown> {
  expect(res.isError, res.content[0]?.text).not.toBe(true)
  return JSON.parse(res.content[0].text!) as Record<string, unknown>
}

/** One fixed instant, so two fleet reads can be compared whole. */
const MODIFIED = new Date(Date.now() - 3 * HOUR).toISOString()

let root = ''
let handlers: Record<string, Handler>

/** A scanned folder row carrying the given sessions (what `ctx.folders` holds). */
function folderWith(ids: string[]): Record<string, unknown> {
  return {
    path: root,
    sessions: ids.map((sessionId) => ({
      sessionId,
      projectPath: root,
      status: 'idle',
      isSidechain: false,
      modified: MODIFIED,
      firstPrompt: 'SECRET PROMPT',
      summary: ''
    }))
  }
}

function ctx(ids: string[] = [CHILD, CHILD2]): Record<string, unknown> {
  return { folder: root, folders: [folderWith(ids)], denyFolders: [], bridge: undefined }
}

const FLEET_ROW_KEYS = new Set([
  'sessionId',
  'folderAlias',
  'taskState',
  'failureReason',
  'status',
  'isSidechain',
  'modified',
  'agentControllable',
  'inflight',
  'orchestrator',
  'peer',
  'hibernated'
])

async function fleet(ids: string[]): Promise<{
  folders: unknown[]
  sessions: Array<Record<string, unknown>>
}> {
  return payloadOf(await handlers.get_fleet({}, ctx(ids))) as {
    folders: unknown[]
    sessions: Array<Record<string, unknown>>
  }
}

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-s6-ud-'))
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-s6-repo-')), 'main')
  await fs.mkdir(root)
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  h.taskStates = new Map()
  h.live = new Set()
  h.parked = new Set()
  h.approvals = []
  vi.resetModules()
  const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
  handlers = Object.fromEntries(WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
})

describe('get_fleet — unchanged by the mission projection (AC-S6-3)', () => {
  it('still answers the same { folders, sessions } shape with the same row keys', async () => {
    h.taskStates.set(CHILD, 'working')
    h.live = new Set([CHILD])
    const p = await fleet([CHILD, CHILD2])
    expect(Object.keys(p).sort()).toEqual(['folders', 'sessions'])
    expect(p.folders).toHaveLength(1)
    expect(p.sessions).toHaveLength(2)
    for (const row of p.sessions)
      for (const k of Object.keys(row)) expect(FLEET_ROW_KEYS).toContain(k)
    expect(p.sessions.find((r) => r.sessionId === CHILD)?.taskState).toBe('working')
  })

  it('answers the same rows before and after a mission naming those sessions is read', async () => {
    h.taskStates.set(CHILD, 'working')
    h.live = new Set([CHILD])
    const before = await fleet([CHILD, CHILD2])

    // A v3 mission file whose step links the child session, read through the v4 verbs.
    const file = v3MissionPath(root, 'mnt-0000000a', 'fleet')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      buildV3MissionFile(
        v3MissionObject(root, {
          id: 'mnt-0000000a',
          slug: 'fleet',
          steps: [
            {
              id: 'stp-1',
              ordinal: 1,
              kind: 'custom',
              title: 'Step 1',
              verification: 'verifier',
              proof: 'unproven',
              links: [{ kind: 'session', ref: CHILD }],
              blockers: []
            }
          ]
        })
      )
    )
    payloadOf(
      await handlers.mission_get(
        { folder: root, missionId: 'mnt-0000000a', sessionId: OWNER },
        ctx()
      )
    )
    payloadOf(await handlers.mission_list({ folder: root }, ctx()))

    expect(await fleet([CHILD, CHILD2])).toEqual(before)
  })
})
