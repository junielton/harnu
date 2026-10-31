/**
 * Campaign ch.5a (T597, AC-5a.2) — the `rebase_stack` VERB, through the real MCP transport and real
 * git repositories: which step's worktree it picks, what it refuses, the blocker it sets on a
 * conflict, and that it never pushes. (The git mechanics are pinned in `steward-rebase.test.ts`.)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { promises as fs, realpathSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import yaml from 'js-yaml'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

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
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanFolders: async (): Promise<unknown[]> => []
}))
vi.mock('../src/main/user-projects', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUserProjects: async (): Promise<unknown> => ({ projects: [] })
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
  findPrsForWorktrees: async () => ({
    ghAvailable: true,
    worktrees: {},
    branches: {},
    numbers: {}
  }),
  findMainCi: async () => ({ ghAvailable: true, byNumber: {} })
}))

import { registerMcpServer, closeMcpServer } from '../src/main/mcp/server'
import { createConfirmCore } from '../src/main/mcp/confirm-core'
import { runOperatorDoor } from '../src/main/mission-ipc'

const OWNER = '11111111-2222-4333-8444-555555555555'
const END = { kind: 'code', target: 'stack landed', evidence: 'main is green' }

let client: Client

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}
function commit(cwd: string, file: string, body: string, msg: string): void {
  writeFileSync(path.join(cwd, file), body)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', msg)
}

interface Repo {
  origin: string
  main: string
  wt: string
}
async function repo(): Promise<Repo> {
  const base = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-rbverb-')))
  const origin = path.join(base, 'origin.git')
  const main = path.join(base, 'main')
  const wt = path.join(base, 'wt')
  git(base, 'init', '-q', '--bare', '-b', 'main', origin)
  git(base, 'init', '-q', '-b', 'main', main)
  git(main, 'remote', 'add', 'origin', origin)
  commit(main, 'base.txt', 'base\n', 'base')
  git(main, 'push', '-q', 'origin', 'main')
  git(main, 'worktree', 'add', '-q', '-b', 'step-1', wt)
  commit(wt, 'one.txt', 'one\n', 'step one')
  git(wt, 'push', '-q', 'origin', 'step-1')
  return { origin, main, wt }
}

interface Reply {
  isError: boolean
  text: string
  body: Record<string, unknown>
}
async function call(name: string, args: Record<string, unknown>): Promise<Reply> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean
    content: Array<{ type: string; text?: string }>
  }
  const text = res.content[0]?.text ?? ''
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* plain-text refusal */
  }
  return { isError: res.isError === true, text, body }
}
const ok = async (n: string, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const r = await call(n, a)
  expect(r.isError, r.text).toBe(false)
  return r.body
}

async function mission(r: Repo, link?: string, steps = 1): Promise<string> {
  const ack = await ok('mission_create', {
    folder: r.main,
    title: 'Land the stack',
    declaredEnd: END,
    sessionId: OWNER,
    steward: false,
    steps: Array.from({ length: steps }, (_, i) => ({
      title: `Step ${i + 1}`,
      verification: 'verifier'
    }))
  })
  const id = ack.missionId as string
  if (link) {
    await ok('mission_link_child', {
      folder: r.main,
      missionId: id,
      stepId: 'stp-1',
      link: { kind: 'worktree', ref: link }
    })
  }
  return id
}

async function front(
  root: string,
  id: string
): Promise<{ steps: Array<{ id: string; blockers: Array<Record<string, unknown>> }> }> {
  const dir = path.join(root, '.harnu', 'missions')
  const name = (await fs.readdir(dir)).find((n) => n.startsWith(`${id}-`))!
  const raw = await fs.readFile(path.join(dir, name), 'utf8')
  return yaml.load(raw.split(/^---\n/m)[1], { schema: yaml.CORE_SCHEMA }) as never
}

beforeAll(async () => {
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null'
  })
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-rbverb-ud-'))
  await registerMcpServer(() => null, {
    bridge: { dispatch: async () => ({}) } as never,
    confirm: createConfirmCore({
      send: () => true,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now()
    })
  })
  const cfg = JSON.parse(await fs.readFile(path.join(h.userDataDir, 'harnu.mcp.json'), 'utf8')) as {
    mcpServers: { harnu: { url: string; headers: Record<string, string> } }
  }
  client = new Client({ name: 'rebase-verb-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(cfg.mcpServers.harnu.url), {
      requestInit: { headers: cfg.mcpServers.harnu.headers }
    })
  )
})
afterAll(async () => {
  await client?.close().catch(() => {})
  await closeMcpServer()
})

describe('AC-5a.2 — the verb is on the wire', () => {
  it('rebase_stack takes folder, missionId, onto (and optionally stepId, from)', async () => {
    const { tools } = await client.listTools()
    const t = tools.find((x) => x.name === 'rebase_stack')!
    expect(t).toBeTruthy()
    const schema = t.inputSchema as { properties: object; required?: string[] }
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['folder', 'missionId', 'onto', 'stepId', 'from'])
    )
    expect(schema.required).toEqual(expect.arrayContaining(['folder', 'missionId', 'onto']))
    expect(t.description).toMatch(/never pushes/i)
  })
})

describe("AC-5a.2 — rebase_stack runs in the step's linked worktree", () => {
  it("rebases the step's branch locally and reports pushed:false; the remote is untouched", async () => {
    const r = await repo()
    const id = await mission(r, r.wt)
    commit(r.main, 'other.txt', 'other\n', 'main moved')
    const remoteBefore = git(r.origin, 'for-each-ref', '--format=%(refname) %(objectname)')
    const before = git(r.wt, 'rev-parse', 'HEAD')
    const ack = await ok('rebase_stack', { folder: r.main, missionId: id, onto: 'main' })
    expect(ack).toMatchObject({
      ok: true,
      op: 'rebase_stack',
      stepId: 'stp-1',
      branch: 'step-1',
      before,
      rebased: true,
      pushed: false
    })
    expect(git(r.wt, 'rev-parse', 'HEAD')).toBe(ack.after)
    expect(git(r.wt, 'log', '--format=%s', '-2')).toBe('step one\nmain moved')
    expect(git(r.origin, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(remoteBefore)
  })

  it('on a conflict: refuses REBASE_CONFLICT, leaves the tree as it was, sets an agent-owned blocker on the step', async () => {
    const r = await repo()
    const id = await mission(r, r.wt)
    commit(r.wt, 'clash.txt', 'branch\n', 'branch clash')
    commit(r.main, 'clash.txt', 'main\n', 'main clash')
    const head = git(r.wt, 'rev-parse', 'HEAD')
    const res = await call('rebase_stack', { folder: r.main, missionId: id, onto: 'main' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/^REBASE_CONFLICT/)
    expect(res.text).toContain('clash.txt')
    expect(git(r.wt, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(r.wt, 'status', '--porcelain')).toBe('')
    const m = await front(r.main, id)
    const blockers = m.steps.find((s) => s.id === 'stp-1')!.blockers
    expect(blockers).toHaveLength(1)
    expect(blockers[0]).toMatchObject({ owner: 'agent' })
    expect(String(blockers[0].reason)).toMatch(/clash\.txt/)
    // A retry does not stack a second identical blocker.
    await call('rebase_stack', { folder: r.main, missionId: id, onto: 'main' })
    expect((await front(r.main, id)).steps.find((s) => s.id === 'stp-1')!.blockers).toHaveLength(1)
  })

  it('NO_STEP_WORKTREE: no step links a worktree', async () => {
    const r = await repo()
    const id = await mission(r)
    const res = await call('rebase_stack', { folder: r.main, missionId: id, onto: 'main' })
    expect(res.text).toMatch(/^NO_STEP_WORKTREE/)
  })

  it('STEP_AMBIGUOUS without a stepId when two steps link a worktree; a stepId picks one', async () => {
    const r = await repo()
    const id = await mission(r, r.wt, 2)
    const wt2 = path.join(path.dirname(r.main), 'wt2')
    git(r.main, 'worktree', 'add', '-q', '-b', 'step-2', wt2)
    await ok('mission_link_child', {
      folder: r.main,
      missionId: id,
      stepId: 'stp-2',
      link: { kind: 'worktree', ref: wt2 }
    })
    const amb = await call('rebase_stack', { folder: r.main, missionId: id, onto: 'main' })
    expect(amb.text).toMatch(/^STEP_AMBIGUOUS/)
    expect(amb.text).toContain('stp-1')
    expect(amb.text).toContain('stp-2')
    const picked = await ok('rebase_stack', {
      folder: r.main,
      missionId: id,
      onto: 'main',
      stepId: 'stp-2'
    })
    expect(picked).toMatchObject({ ok: true, stepId: 'stp-2', branch: 'step-2' })
  })

  it('WORKTREE_NOT_IN_REPO: a worktree of some other repository is never rebased', async () => {
    const r = await repo()
    const other = await repo()
    const id = await mission(r, other.wt)
    const head = git(other.wt, 'rev-parse', 'HEAD')
    commit(other.main, 'x.txt', 'x\n', 'other main moved')
    const res = await call('rebase_stack', { folder: r.main, missionId: id, onto: 'main' })
    expect(res.text).toMatch(/^WORKTREE_NOT_IN_REPO|^NO_STEP_WORKTREE/)
    expect(git(other.wt, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('never rebases the main checkout, even if a step links it', async () => {
    const r = await repo()
    const id = await mission(r, r.main)
    const head = git(r.main, 'rev-parse', 'HEAD')
    const res = await call('rebase_stack', { folder: r.main, missionId: id, onto: 'main' })
    expect(res.isError).toBe(true)
    expect(git(r.main, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('BAD_ONTO reaches the caller as a plain refusal and changes nothing', async () => {
    const r = await repo()
    const id = await mission(r, r.wt)
    const head = git(r.wt, 'rev-parse', 'HEAD')
    const res = await call('rebase_stack', {
      folder: r.main,
      missionId: id,
      onto: '--exec=touch /tmp/pwned-by-rebase'
    })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/BAD_ONTO/)
    expect(git(r.wt, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('MISSION_CLOSED: a closed mission is a record, not a work order', async () => {
    const r = await repo()
    const id = await mission(r, r.wt)
    await runOperatorDoor({ door: 'end', root: r.main, missionId: id, closedAs: 'discarded' })
    const res = await call('rebase_stack', { folder: r.main, missionId: id, onto: 'main' })
    expect(res.text).toMatch(/MISSION_CLOSED/)
  })
})
