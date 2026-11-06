import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * T661 — `hide_folder` driven through the REAL wired handler, the REAL gate and the REAL
 * `projects.json` store over a throwaway userData directory.
 *
 * Only the three live-state sources are stubbed (hook task states, live PTYs, parked
 * approvals); the catalog, validator, plan-input seam, audit ring and the user-projects file
 * (with its write lock) are the production ones.
 */

const live = vi.hoisted(() => ({
  userData: '',
  taskStates: new Map<string, string>(),
  liveKeys: new Set<string>(),
  approvals: [] as Array<{ sessionId: string }>
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => live.userData,
    getAppPath: (): string => process.cwd()
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
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
import {
  addUserProject,
  hideUserProject,
  unhideUserProject,
  onHiddenPathsChanged,
  readUserProjects,
  userProjectsPath
} from '../src/main/user-projects'
import type { FolderEntry } from '../src/main/folder-model'

const tool = WIRED_TOOLS.find((t) => t.op === 'hide_folder')
const handler = tool?.handler as NonNullable<typeof tool>['handler']

let base: string
let P: Record<'alpha' | 'beta' | 'blocked' | 'busy' | 'approval' | 'pinned' | 'unknown', string>
let folders: FolderEntry[]

function entry(p: string, ids: string[]): FolderEntry {
  return {
    path: p,
    alias: path.basename(p),
    sessions: ids.map((sessionId) => ({ sessionId, projectPath: p }))
  } as unknown as FolderEntry
}

function ctx(denyFolders: string[] = [P.blocked]) {
  return { folder: '', folders, denyFolders, bridge: undefined }
}

function payload(res: CallToolResult): Record<string, unknown> {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  return JSON.parse(first.text) as Record<string, unknown>
}

type Row = { path: string; outcome: string; reason?: string }
function rowsOf(res: CallToolResult): Row[] {
  return payload(res).results as Row[]
}

function errorText(res: CallToolResult): string {
  const first = res.content[0]
  return first && first.type === 'text' ? first.text : ''
}

async function hidden(): Promise<string[]> {
  return (await readUserProjects()).hiddenPaths ?? []
}

/** Every entry under a directory, relative and sorted: a deep listing to prove nothing moved. */
function tree(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, name.name)
      out.push(path.relative(dir, full) + (name.isDirectory() ? '/' : ''))
      if (name.isDirectory()) walk(full)
    }
  }
  walk(dir)
  return out.sort()
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'harnu-hide-folder-')))
  live.userData = path.join(base, 'userData')
  mkdirSync(live.userData)
  const repos = path.join(base, 'repos')
  P = {
    alpha: path.join(repos, 'alpha'),
    beta: path.join(repos, 'beta'),
    blocked: path.join(repos, 'blocked'),
    busy: path.join(repos, 'busy'),
    approval: path.join(repos, 'approval'),
    pinned: path.join(repos, 'pinned'),
    unknown: path.join(repos, 'unknown')
  }
  for (const p of Object.values(P)) mkdirSync(p, { recursive: true })
  // Things on disk the verb must never touch: a transcript-like file and a git dir.
  writeFileSync(path.join(P.alpha, 'transcript.jsonl'), '{"type":"user"}\n')
  mkdirSync(path.join(P.alpha, '.git'))
  writeFileSync(path.join(P.alpha, '.git', 'HEAD'), 'ref: refs/heads/main\n')

  folders = [
    entry(P.alpha, ['s-1']),
    entry(P.beta, ['s-2']),
    entry(P.blocked, ['s-blocked']),
    entry(P.busy, ['s-working']),
    entry(P.approval, ['s-approval'])
  ]
  await addUserProject({
    path: P.pinned,
    alias: 'pinned',
    addedAt: '2026-11-01T00:00:00.000Z',
    worktrees: []
  })
  live.taskStates.clear()
  live.liveKeys.clear()
  live.approvals = []
  clearAuditLog()
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('hide_folder handler', () => {
  it('is in the catalog as a free, mutating verb', () => {
    const def = MCP_TOOLS.find((t) => t.op === 'hide_folder')
    expect(def?.mutates).toBe(true)
    expect(def?.silentAllowInAgentFolder).toBe(true)
    expect(def?.grantable).toBeUndefined()
    expect(handler).toBeTypeOf('function')
  })

  it('idempotent: hide, hide again, show, show again', async () => {
    const first = await handler({ folders: [P.alpha, P.beta] }, ctx())
    expect(rowsOf(first)).toEqual([
      { path: P.alpha, outcome: 'hidden' },
      { path: P.beta, outcome: 'hidden' }
    ])
    expect(payload(first).ok).toBe(true)
    expect(payload(first).op).toBe('hide_folder')
    expect(payload(first).unhide).toBe(false)
    expect(payload(first).counts).toEqual({ hidden: 2 })
    expect(await hidden()).toEqual([P.alpha, P.beta])

    const again = await handler({ folders: [P.alpha, P.beta] }, ctx())
    expect(rowsOf(again).map((r) => r.outcome)).toEqual(['alreadyHidden', 'alreadyHidden'])

    const shown = await handler({ folders: [P.alpha], unhide: true }, ctx())
    expect(rowsOf(shown)).toEqual([{ path: P.alpha, outcome: 'shown' }])
    expect(await hidden()).toEqual([P.beta])

    const shownAgain = await handler({ folders: [P.alpha], unhide: true }, ctx())
    expect(rowsOf(shownAgain).map((r) => r.outcome)).toEqual(['alreadyVisible'])
    expect(await hidden()).toEqual([P.beta])
  })

  it('hides a pinned folder that has no sessions, and leaves it pinned', async () => {
    const res = await handler({ folders: [P.pinned] }, ctx())
    expect(rowsOf(res)).toEqual([{ path: P.pinned, outcome: 'hidden' }])
    const file = await readUserProjects()
    expect(file.hiddenPaths).toEqual([P.pinned])
    expect(file.projects.map((p) => p.path)).toEqual([P.pinned])
  })

  it('refuses a blocked folder, a working session and a parked approval, and hides the rest', async () => {
    live.liveKeys.add('s-working')
    live.taskStates.set('s-working', 'working')
    live.approvals = [{ sessionId: 's-approval' }]

    const res = await handler(
      { folders: [P.blocked, P.busy, P.approval, P.alpha, P.unknown] },
      ctx()
    )
    expect(rowsOf(res)).toEqual([
      { path: P.blocked, outcome: 'refused', reason: 'FOLDER_NOT_ALLOWED' },
      { path: P.busy, outcome: 'refused', reason: 'SESSION_WORKING' },
      { path: P.approval, outcome: 'refused', reason: 'PENDING_APPROVAL' },
      { path: P.alpha, outcome: 'hidden' },
      { path: P.unknown, outcome: 'notFound' }
    ])
    // A partial failure is never reported as a clean success.
    expect(payload(res).ok).toBe(false)
    expect(await hidden()).toEqual([P.alpha])
  })

  it('a stale working state of a session with no live terminal does not block hiding', async () => {
    live.taskStates.set('s-working', 'working') // not in liveKeys: the PTY is gone
    const res = await handler({ folders: [P.busy] }, ctx())
    expect(rowsOf(res).map((r) => r.outcome)).toEqual(['hidden'])
  })

  it('a folder spelled through a trailing slash or a dot segment is the same folder', async () => {
    const res = await handler({ folders: [P.alpha + '/', path.join(P.alpha, '.', '')] }, ctx())
    expect(rowsOf(res)).toEqual([{ path: P.alpha, outcome: 'hidden' }])
    expect(await hidden()).toEqual([P.alpha])
  })

  it('only hiddenPaths: nothing on disk moves and the file equals the sidebar action’s', async () => {
    const before = tree(base).filter((p) => !p.startsWith('userData'))
    await handler({ folders: [P.alpha, P.beta] }, ctx())
    await handler({ folders: [P.beta], unhide: true }, ctx())
    await handler({ folders: [P.alpha, P.unknown] }, ctx())
    const after = tree(base).filter((p) => !p.startsWith('userData'))
    expect(after).toEqual(before)
    expect(readFileSync(path.join(P.alpha, 'transcript.jsonl'), 'utf8')).toBe('{"type":"user"}\n')
    // Its own directory holds the store file and nothing else (the tmp file was renamed away).
    expect(readdirSync(live.userData)).toEqual(['projects.json'])
    const viaVerb = readFileSync(userProjectsPath(), 'utf8')

    // The sidebar action, on a second throwaway userData, ends in the byte-identical file.
    live.userData = path.join(base, 'userData-sidebar')
    mkdirSync(live.userData)
    await addUserProject({
      path: P.pinned,
      alias: 'pinned',
      addedAt: '2026-11-01T00:00:00.000Z',
      worktrees: []
    })
    await hideUserProject(P.alpha)
    await hideUserProject(P.beta)
    await unhideUserProject(P.beta)
    expect(readFileSync(userProjectsPath(), 'utf8')).toBe(viaVerb)
  })

  it('concurrent: calls on one path read as one serial order and the ACKs match the file', async () => {
    const [a, b, c] = await Promise.all([
      handler({ folders: [P.alpha] }, ctx()),
      handler({ folders: [P.alpha] }, ctx()),
      handler({ folders: [P.alpha] }, ctx())
    ])
    expect([a, b, c].map((r) => rowsOf(r)[0]?.outcome)).toEqual([
      'hidden',
      'alreadyHidden',
      'alreadyHidden'
    ])
    expect(await hidden()).toEqual([P.alpha])

    const [u1, u2, h1] = await Promise.all([
      handler({ folders: [P.alpha], unhide: true }, ctx()),
      handler({ folders: [P.alpha], unhide: true }, ctx()),
      handler({ folders: [P.alpha] }, ctx())
    ])
    expect([u1, u2, h1].map((r) => rowsOf(r)[0]?.outcome)).toEqual([
      'shown',
      'alreadyVisible',
      'hidden'
    ])
    expect(await hidden()).toEqual([P.alpha])
  })

  it('concurrent: a sidebar hide / unhide in between is seen by the verb, never overwritten', async () => {
    await hideUserProject(P.alpha)
    const [verb1, , verb2] = await Promise.all([
      handler({ folders: [P.alpha] }, ctx()), // already hidden -> alreadyHidden
      unhideUserProject(P.alpha), // the menu action shows it
      handler({ folders: [P.alpha] }, ctx()) // so this one really hides
    ])
    expect(rowsOf(verb1)[0]?.outcome).toBe('alreadyHidden')
    expect(rowsOf(verb2)[0]?.outcome).toBe('hidden')
    expect(await hidden()).toEqual([P.alpha])
  })

  it('fails the whole call, with nothing changed, when the file cannot be written', async () => {
    const seen: string[][] = []
    const off = onHiddenPathsChanged((p) => seen.push(p.hiddenPaths))
    // userData is a regular file, so the store directory can never be created.
    const blockedDir = path.join(base, 'not-a-dir')
    writeFileSync(blockedDir, 'x')
    live.userData = path.join(blockedDir, 'sub')
    const res = await handler({ folders: [P.alpha] }, ctx())
    off()
    expect(res.isError).toBe(true)
    expect(errorText(res)).toMatch(/^HIDE_WRITE_FAILED/)
    expect(seen).toEqual([])
  })

  it('tells listeners the full list after a write that changed it, and only then', async () => {
    const seen: string[][] = []
    const off = onHiddenPathsChanged((p) => seen.push(p.hiddenPaths))
    await handler({ folders: [P.alpha, P.beta] }, ctx())
    await handler({ folders: [P.alpha] }, ctx()) // alreadyHidden: no write, no event
    await handler({ folders: [P.unknown] }, ctx()) // notFound: no write, no event
    await handler({ folders: [P.alpha], unhide: true }, ctx())
    await hideUserProject(P.pinned) // the menu action's own function: it does not emit
    off()
    expect(seen).toEqual([[P.alpha, P.beta], [P.beta]])
  })
})

describe('hide_folder validation', () => {
  it('takes 1..100 absolute paths: zero, 101, a relative and an empty one are refused', () => {
    const paths = (n: number): string[] => Array.from({ length: n }, (_, i) => `/r/f-${i}`)
    expect(parseToolInput('hide_folder', { folders: paths(0) }).ok).toBe(false)
    expect(parseToolInput('hide_folder', { folders: paths(101) }).ok).toBe(false)
    expect(parseToolInput('hide_folder', { folders: paths(1) }).ok).toBe(true)
    expect(parseToolInput('hide_folder', { folders: paths(100) }).ok).toBe(true)
    expect(parseToolInput('hide_folder', { folders: [''] }).ok).toBe(false)
    expect(parseToolInput('hide_folder', { folders: ['relative/dir'] }).ok).toBe(false)
    expect(parseToolInput('hide_folder', { folders: ['/r/a'], unhide: 'yes' }).ok).toBe(false)
    expect(parseToolInput('hide_folder', { folders: ['/r/a'], unhide: true }).ok).toBe(true)
  })

  it('survives the catalog -> gate translation (no field is dropped)', () => {
    const input = buildPlanInput('hide_folder', { folders: ['/r/a'], unhide: true }, undefined)
    expect(parseToolInput('hide_folder', input).ok).toBe(true)
    expect((input as { unhide?: boolean }).unhide).toBe(true)
  })
})

describe('hide_folder audit', () => {
  const policy = {
    serverEnabled: true,
    denyFolders: [],
    allowFolders: ['/r/a'],
    knownRoots: ['/r/a']
  }

  it('audited: the gate records an allowed call as AGENT_ALLOWED, like every free mutating verb', () => {
    const plan = planToolCall({
      tool: 'hide_folder',
      input: buildPlanInput('hide_folder', { folders: ['/r/a'] }, undefined),
      policy,
      now: 1_700_000_000_000
    })
    expect(plan.verdict).toBe('allow')
    expect(plan.shouldDispatch).toBe(true)
    expect(plan.auditRecord.tool).toBe('hide_folder')
    expect(plan.auditRecord.result).toBe('AGENT_ALLOWED')
  })

  it('audited: a disabled control server refuses it, and the refusal is still audited', () => {
    const plan = planToolCall({
      tool: 'hide_folder',
      input: buildPlanInput('hide_folder', { folders: ['/r/a'] }, undefined),
      policy: { ...policy, serverEnabled: false },
      now: 1_700_000_000_000
    })
    expect(plan.verdict).toBe('deny')
    expect(plan.auditRecord.tool).toBe('hide_folder')
    expect(plan.auditRecord.result).toBe('SERVER_DISABLED')
  })

  it('audited: the handler adds a row naming what it did (counts, no paths)', async () => {
    await handler({ folders: [P.alpha, P.beta, P.unknown] }, ctx())
    const rows = getAuditLog().filter((r) => r.tool === 'hide_folder')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.verdict).toBe('allow')
    expect(rows[0]?.disclosedPayloadSummary).toMatch(/hide 2 hidden/)
    expect(rows[0]?.disclosedPayloadSummary).toMatch(/1 notFound/)
    expect(rows[0]?.disclosedPayloadSummary).not.toContain(base)
  })
})
