import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * T655 — `archive_session` driven through the REAL wired handler and the REAL gate.
 *
 * Only the three live-state sources are stubbed (hook task states, live PTYs, parked
 * approvals); the archive store is the real one over a temp file, and the catalog,
 * validator, plan-input seam and audit ring are the production ones.
 */

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => '/tmp',
    getAppPath: (): string => process.cwd()
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

const live = vi.hoisted(() => ({
  taskStates: new Map<string, string>(),
  liveKeys: new Set<string>(),
  approvals: [] as Array<{ sessionId: string }>
}))

vi.mock('../src/main/hook-bridge', async (orig) => ({
  ...(await orig<typeof import('../src/main/hook-bridge')>()),
  getTaskStates: () => live.taskStates
}))
vi.mock('../src/main/pty', async (orig) => ({
  ...(await orig<typeof import('../src/main/pty')>()),
  liveSessionKeys: () => live.liveKeys
}))
vi.mock('../src/main/approval-resolver', async (orig) => ({
  ...(await orig<typeof import('../src/main/approval-resolver')>()),
  listPendingApprovals: () => live.approvals
}))

import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { parseToolInput } from '../src/main/mcp/validate'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { clearAuditLog, getAuditLog } from '../src/main/mcp/audit-log'
import { openSessionArchive, setSessionArchive } from '../src/main/session-archive-core'
import type { FolderEntry } from '../src/main/folder-model'

const tool = WIRED_TOOLS.find((t) => t.op === 'archive_session')
const handler = tool?.handler as NonNullable<typeof tool>['handler']

const ALPHA = '/repos/alpha'
const BLOCKED = '/repos/blocked'

function folderEntry(p: string, ids: string[]): FolderEntry {
  return {
    path: p,
    alias: path.basename(p),
    sessions: ids.map((sessionId) => ({ sessionId, projectPath: p }))
  } as unknown as FolderEntry
}

const FOLDERS = [
  folderEntry(ALPHA, ['s-1', 's-2', 's-working', 's-approval']),
  folderEntry(BLOCKED, ['s-blocked'])
]

function ctx(denyFolders: string[] = [BLOCKED]) {
  return { folder: '', folders: FOLDERS, denyFolders, bridge: undefined }
}

function payload(res: CallToolResult): Record<string, unknown> {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  return JSON.parse(first.text) as Record<string, unknown>
}

function rowsOf(
  res: CallToolResult
): Array<{ sessionId: string; outcome: string; reason?: string }> {
  return payload(res).results as Array<{ sessionId: string; outcome: string; reason?: string }>
}

let dir: string

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'harnu-archive-handler-'))
  setSessionArchive(await openSessionArchive(path.join(dir, 'archived-sessions.json')))
  live.taskStates.clear()
  live.liveKeys.clear()
  live.approvals = []
  clearAuditLog()
})

afterEach(() => {
  setSessionArchive(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('archive_session handler', () => {
  it('is in the catalog as a free, mutating verb', () => {
    const def = MCP_TOOLS.find((t) => t.op === 'archive_session')
    expect(def?.mutates).toBe(true)
    expect(def?.silentAllowInAgentFolder).toBe(true)
    expect(def?.grantable).toBeUndefined()
    expect(handler).toBeTypeOf('function')
  })

  it('idempotent: archive, archive again, restore, restore again', async () => {
    const first = await handler({ sessionIds: ['s-1', 's-2'] }, ctx())
    expect(rowsOf(first).map((r) => r.outcome)).toEqual(['archived', 'archived'])
    expect(payload(first).ok).toBe(true)

    const again = await handler({ sessionIds: ['s-1', 's-2'] }, ctx())
    expect(rowsOf(again).map((r) => r.outcome)).toEqual(['alreadyArchived', 'alreadyArchived'])

    const restored = await handler({ sessionIds: ['s-1'], unarchive: true }, ctx())
    expect(rowsOf(restored).map((r) => r.outcome)).toEqual(['restored'])

    const restoredAgain = await handler({ sessionIds: ['s-1'], unarchive: true }, ctx())
    expect(rowsOf(restoredAgain).map((r) => r.outcome)).toEqual(['alreadyActive'])

    // The store the sidebar reads holds exactly what the ACKs said.
    const archive = await openSessionArchive(path.join(dir, 'archived-sessions.json'))
    expect([...archive.ids()]).toEqual(['s-2'])
  })

  it('refuses a blocked folder, a working session and a parked approval, and archives the rest', async () => {
    live.liveKeys.add('s-working')
    live.taskStates.set('s-working', 'working')
    live.approvals = [{ sessionId: 's-approval' }]

    const res = await handler(
      { sessionIds: ['s-blocked', 's-working', 's-approval', 's-1', 'nope'] },
      ctx()
    )
    expect(rowsOf(res)).toEqual([
      { sessionId: 's-blocked', outcome: 'refused', reason: 'FOLDER_NOT_ALLOWED' },
      { sessionId: 's-working', outcome: 'refused', reason: 'SESSION_WORKING' },
      { sessionId: 's-approval', outcome: 'refused', reason: 'PENDING_APPROVAL' },
      { sessionId: 's-1', outcome: 'archived' },
      { sessionId: 'nope', outcome: 'notFound' }
    ])
    // A partial failure is never reported as a clean success.
    expect(payload(res).ok).toBe(false)
    const archive = await openSessionArchive(path.join(dir, 'archived-sessions.json'))
    expect([...archive.ids()]).toEqual(['s-1'])
  })

  it('a stale working state of a session with no live terminal does not block archiving', async () => {
    live.taskStates.set('s-working', 'working') // not in liveKeys: the PTY is gone
    const res = await handler({ sessionIds: ['s-working'] }, ctx())
    expect(rowsOf(res).map((r) => r.outcome)).toEqual(['archived'])
  })

  it('only its own file: the call writes the archive store and nothing else in its directory', async () => {
    await handler({ sessionIds: ['s-1'] }, ctx())
    await handler({ sessionIds: ['s-1'], unarchive: true }, ctx())
    expect(readdirSync(dir)).toEqual(['archived-sessions.json'])
  })

  it('refuses cleanly when the archive store is not ready', async () => {
    setSessionArchive(null)
    const res = await handler({ sessionIds: ['s-1'] }, ctx())
    expect(res.isError).toBe(true)
    const first = res.content[0]
    expect(first && first.type === 'text' ? first.text : '').toMatch(/^ARCHIVE_NOT_READY/)
  })
})

describe('archive_session validation', () => {
  it('takes 1..100 ids: zero and 101 are refused, 1 and 100 pass', () => {
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `s-${i}`)
    expect(parseToolInput('archive_session', { sessionIds: ids(0) }).ok).toBe(false)
    expect(parseToolInput('archive_session', { sessionIds: ids(101) }).ok).toBe(false)
    expect(parseToolInput('archive_session', { sessionIds: ids(1) }).ok).toBe(true)
    expect(parseToolInput('archive_session', { sessionIds: ids(100) }).ok).toBe(true)
    expect(parseToolInput('archive_session', { sessionIds: [''] }).ok).toBe(false)
    expect(parseToolInput('archive_session', { sessionIds: ['a'], unarchive: 'yes' }).ok).toBe(
      false
    )
    expect(parseToolInput('archive_session', { sessionIds: ['a'], unarchive: true }).ok).toBe(true)
  })

  it('survives the catalog -> gate translation (no field is dropped)', () => {
    const input = buildPlanInput(
      'archive_session',
      { sessionIds: ['a'], unarchive: true },
      undefined
    )
    expect(parseToolInput('archive_session', input).ok).toBe(true)
  })
})

describe('archive_session audit', () => {
  const policy = {
    serverEnabled: true,
    denyFolders: [],
    allowFolders: [ALPHA],
    knownRoots: [ALPHA]
  }

  it('audited: the gate records an allowed call as AGENT_ALLOWED, like every free mutating verb', () => {
    const plan = planToolCall({
      tool: 'archive_session',
      input: buildPlanInput('archive_session', { sessionIds: ['s-1'] }, undefined),
      policy,
      now: 1_700_000_000_000
    })
    expect(plan.verdict).toBe('allow')
    expect(plan.shouldDispatch).toBe(true)
    expect(plan.auditRecord.tool).toBe('archive_session')
    expect(plan.auditRecord.result).toBe('AGENT_ALLOWED')
  })

  it('audited: a disabled control server refuses it, and the refusal is still audited', () => {
    const plan = planToolCall({
      tool: 'archive_session',
      input: buildPlanInput('archive_session', { sessionIds: ['s-1'] }, undefined),
      policy: { ...policy, serverEnabled: false },
      now: 1_700_000_000_000
    })
    expect(plan.verdict).toBe('deny')
    expect(plan.auditRecord.tool).toBe('archive_session')
    expect(plan.auditRecord.result).toBe('SERVER_DISABLED')
  })

  it('audited: the handler adds a row naming what it did (counts, no transcript content)', async () => {
    await handler({ sessionIds: ['s-1', 's-2', 'nope'] }, ctx())
    const rows = getAuditLog().filter((r) => r.tool === 'archive_session')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.verdict).toBe('allow')
    expect(rows[0]?.disclosedPayloadSummary).toMatch(/archive 2 archived/)
    expect(rows[0]?.disclosedPayloadSummary).toMatch(/1 notFound/)
  })
})
