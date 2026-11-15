/**
 * Missions v4 S-27 / S-40 (AC-5a.2, AC-70) — the `rebase_stack` VERB, through the real MCP transport and
 * real git repositories: which step's worktree it picks, what it refuses, that a conflict writes
 * nothing, and that it never pushes. (The git mechanics are pinned in `rebase-stack-git.test.ts`, the
 * leader and ownership rules in `rebase-stack-leader.test.ts`; this file proves the wiring on the wire.)
 *
 * Every mission here is a v4 record: the verb is v4-only now and needs the leader's `sessionId`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { promises as fs, realpathSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
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
import { runDoor } from '../src/main/missions/doors'
import {
  buildMissionRecordContent,
  parseMissionRecordFile,
  readMissionRecordLog
} from '../src/main/missions/model'

const LEADER = '11111111-2222-4333-8444-555555555555'
const OTHER_LEADER = '22222222-3333-4444-8555-666666666666'
const STRANGER = '99999999-9999-4999-8999-999999999999'

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

/** A v4 mission led by LEADER with `steps` steps; `link` (a worktree path) is linked on stp-1. */
async function mission(r: Repo, link?: string, steps = 1, folder = r.main): Promise<string> {
  const ack = await ok('mission_create', {
    folder,
    title: 'Land the stack',
    doneWhen: 'The stack is merged and main is green',
    sessionId: LEADER,
    steps: Array.from({ length: steps }, (_, i) => ({
      title: `Step ${i + 1}`,
      criteria: [{ text: 'The pull request is merged', fact: 'pr-merged' }]
    }))
  })
  const id = ack.id as string
  if (link) await linkWorktree(folder, id, 'stp-1', link)
  return id
}

async function linkWorktree(
  folder: string,
  missionId: string,
  stepId: string,
  ref: string
): Promise<void> {
  await ok('mission_link', {
    folder,
    missionId,
    stepId,
    link: { kind: 'worktree', ref },
    sessionId: LEADER
  })
}

const rebase = (
  folder: string,
  missionId: string,
  extra: Record<string, unknown> = {}
): Promise<Reply> =>
  call('rebase_stack', { folder, missionId, onto: 'main', sessionId: LEADER, ...extra })

/** The mission's record file: its path and raw text. */
async function recordFile(root: string, id: string): Promise<{ file: string; raw: string }> {
  const dir = path.join(root, '.harnu', 'missions-v4')
  const name = (await fs.readdir(dir)).find((n) => n.startsWith(`${id}-`))!
  const file = path.join(dir, name)
  return { file, raw: await fs.readFile(file, 'utf8') }
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
  it('rebase_stack takes folder, missionId, onto (and optionally stepId, from, sessionId)', async () => {
    const { tools } = await client.listTools()
    const t = tools.find((x) => x.name === 'rebase_stack')!
    expect(t).toBeTruthy()
    const schema = t.inputSchema as { properties: object; required?: string[] }
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['folder', 'missionId', 'onto', 'stepId', 'from', 'sessionId'])
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
    const ack = await ok('rebase_stack', {
      folder: r.main,
      missionId: id,
      onto: 'main',
      sessionId: LEADER
    })
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

  it('on a conflict: refuses REBASE_CONFLICT, leaves the tree as it was, and writes nothing to the mission', async () => {
    const r = await repo()
    const id = await mission(r, r.wt)
    commit(r.wt, 'clash.txt', 'branch\n', 'branch clash')
    commit(r.main, 'clash.txt', 'main\n', 'main clash')
    const head = git(r.wt, 'rev-parse', 'HEAD')
    const recordBefore = await recordFile(r.main, id)
    const res = await rebase(r.main, id)
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/^REBASE_CONFLICT/)
    expect(res.text).toContain('clash.txt')
    expect(git(r.wt, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(r.wt, 'status', '--porcelain')).toBe('')
    // v3 set a blocker on the step behind the caller's back; v4 leaves that call to the leader, so
    // the record is byte for byte what it was and a retry stacks nothing either.
    expect((await recordFile(r.main, id)).raw).toBe(recordBefore.raw)
    await rebase(r.main, id)
    expect((await recordFile(r.main, id)).raw).toBe(recordBefore.raw)
    expect(parseMissionRecordFile(recordBefore.raw).steps[0].blockers).toEqual([])
  })

  it('NO_STEP_WORKTREE: no step links a worktree', async () => {
    const r = await repo()
    const id = await mission(r)
    const res = await rebase(r.main, id)
    expect(res.text).toMatch(/^NO_STEP_WORKTREE/)
  })

  it('STEP_AMBIGUOUS without a stepId when two steps link a worktree; a stepId picks one', async () => {
    const r = await repo()
    const id = await mission(r, r.wt, 2)
    const wt2 = path.join(path.dirname(r.main), 'wt2')
    git(r.main, 'worktree', 'add', '-q', '-b', 'step-2', wt2)
    await linkWorktree(r.main, id, 'stp-2', wt2)
    const amb = await rebase(r.main, id)
    expect(amb.text).toMatch(/^STEP_AMBIGUOUS/)
    expect(amb.text).toContain('stp-1')
    expect(amb.text).toContain('stp-2')
    const picked = await ok('rebase_stack', {
      folder: r.main,
      missionId: id,
      onto: 'main',
      stepId: 'stp-2',
      sessionId: LEADER
    })
    expect(picked).toMatchObject({ ok: true, stepId: 'stp-2', branch: 'step-2' })
  })

  it('WORKTREE_NOT_IN_REPO: a worktree of some other repository is never rebased', async () => {
    const r = await repo()
    const other = await repo()
    const id = await mission(r, other.wt)
    const head = git(other.wt, 'rev-parse', 'HEAD')
    commit(other.main, 'x.txt', 'x\n', 'other main moved')
    const res = await rebase(r.main, id)
    expect(res.text).toMatch(/^WORKTREE_NOT_IN_REPO/)
    expect(git(other.wt, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('never rebases the main checkout, even if a step links it', async () => {
    const r = await repo()
    const id = await mission(r, r.main)
    const head = git(r.main, 'rev-parse', 'HEAD')
    const res = await rebase(r.main, id)
    expect(res.isError).toBe(true)
    expect(git(r.main, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('BAD_ONTO reaches the caller as a plain refusal and changes nothing', async () => {
    const r = await repo()
    const id = await mission(r, r.wt)
    const head = git(r.wt, 'rev-parse', 'HEAD')
    const res = await rebase(r.main, id, { onto: '--exec=touch /tmp/pwned-by-rebase' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/BAD_ONTO/)
    expect(git(r.wt, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('MISSION_CLOSED: a closed mission is a record, not a work order', async () => {
    const r = await repo()
    const id = await mission(r, r.wt)
    const closed = await runDoor({
      door: 'close',
      folder: r.main,
      missionId: id,
      closedAs: 'discarded'
    })
    expect(closed.ok, JSON.stringify(closed)).toBe(true)
    const head = git(r.wt, 'rev-parse', 'HEAD')
    commit(r.main, 'other.txt', 'other\n', 'main moved')
    const res = await rebase(r.main, id)
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/MISSION_CLOSED/)
    expect(git(r.wt, 'rev-parse', 'HEAD')).toBe(head)
  })
})

/** A roadmap card with a stamped owner branch, as dispatch leaves it (`executedIn`). */
async function card(root: string, slug: string, executedIn?: string): Promise<void> {
  const dir = path.join(root, '.harnu', 'memory', 'roadmap')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${slug}.md`),
    `---\nid: ${slug}\ntitle: ${slug}\nstatus: in-progress\nkind: feature\ncomplexity: standard\n${executedIn ? `executedIn: ${executedIn}\n` : ''}---\n\n# ${slug}\n`
  )
}

/** Dispatch leaves the step's card slug on the record; no verb sets it, so the proof stamps it on disk. */
async function dispatchStep(root: string, id: string, stepId: string, slug: string): Promise<void> {
  const { file, raw } = await recordFile(root, id)
  const record = parseMissionRecordFile(raw)
  record.steps.find((st) => st.id === stepId)!.card = slug
  await fs.writeFile(file, buildMissionRecordContent(record, readMissionRecordLog(raw)), 'utf8')
}

describe("Delta 1 — only the step's OWN worktree is rebased (path trust)", () => {
  it("NOT_STEP_WORKTREE: a same-repo sibling worktree whose branch is not the step's card branch is never rewritten", async () => {
    const r = await repo()
    await card(r.main, 'T900', 'step-1')
    const id = await mission(r, r.wt)
    await dispatchStep(r.main, id, 'stp-1', 'T900')
    // The operator's own worktree, in the same repo, which the step ALSO links.
    const operatorWt = path.join(path.dirname(r.main), 'operators-own')
    git(r.main, 'worktree', 'add', '-q', '-b', 'operators-branch', operatorWt)
    commit(r.main, 'other.txt', 'other\n', 'main moved')
    await linkWorktree(r.main, id, 'stp-1', operatorWt)
    const head = git(operatorWt, 'rev-parse', 'HEAD')
    const res = await rebase(r.main, id)
    // The step's own worktree (r.wt, branch step-1) is the only candidate; the sibling is dropped.
    expect(res.isError, res.text).toBe(false)
    expect(git(operatorWt, 'rev-parse', 'HEAD')).toBe(head)
    // And with ONLY the sibling linked, there is nothing of the step's own to rebase.
    const r2 = await repo()
    await card(r2.main, 'T901', 'step-1')
    const id2 = await mission(r2)
    await dispatchStep(r2.main, id2, 'stp-1', 'T901')
    const sibling = path.join(path.dirname(r2.main), 'sibling')
    git(r2.main, 'worktree', 'add', '-q', '-b', 'not-mine', sibling)
    await linkWorktree(r2.main, id2, 'stp-1', sibling)
    const sibHead = git(sibling, 'rev-parse', 'HEAD')
    commit(r2.main, 'x.txt', 'x\n', 'main moved again')
    const refused = await rebase(r2.main, id2)
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/^NOT_STEP_WORKTREE/)
    expect(git(sibling, 'rev-parse', 'HEAD')).toBe(sibHead)
  })

  it("NOT_STEP_WORKTREE: with no card to say which branch is the step's, a worktree another step or mission also links is refused", async () => {
    const r = await repo()
    const idA = await mission(r, r.wt)
    // A session leads one mission at a time (a second create answers the first), so another leader
    // opens the second mission and links the very same worktree on its own step.
    const idB = await ok('mission_create', {
      folder: r.main,
      title: 'Second mission',
      doneWhen: 'The other stack is merged',
      sessionId: OTHER_LEADER,
      steps: [
        { title: 'Other', criteria: [{ text: 'The pull request is merged', fact: 'pr-merged' }] }
      ]
    }).then((a) => a.id as string)
    expect(idB).not.toBe(idA)
    await ok('mission_link', {
      folder: r.main,
      missionId: idB,
      stepId: 'stp-1',
      link: { kind: 'worktree', ref: r.wt },
      sessionId: OTHER_LEADER
    })
    const head = git(r.wt, 'rev-parse', 'HEAD')
    commit(r.main, 'other.txt', 'other\n', 'main moved')
    for (const [id, leader] of [
      [idA, LEADER],
      [idB, OTHER_LEADER]
    ]) {
      const res = await rebase(r.main, id, { sessionId: leader })
      expect(res.text, id).toMatch(/^NOT_STEP_WORKTREE/)
    }
    expect(git(r.wt, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('a step whose card was dispatched to that very branch is accepted', async () => {
    const r = await repo()
    await card(r.main, 'T902', 'step-1')
    const id = await mission(r, r.wt)
    await dispatchStep(r.main, id, 'stp-1', 'T902')
    commit(r.main, 'other.txt', 'other\n', 'main moved')
    const ack = await ok('rebase_stack', {
      folder: r.main,
      missionId: id,
      onto: 'main',
      sessionId: LEADER
    })
    expect(ack).toMatchObject({ ok: true, branch: 'step-1', rebased: true, pushed: false })
  })

  it("fails CLOSED when the mission's own repository cannot be identified", async () => {
    const r = await repo()
    // A "repo" whose .git is an empty directory: missionRoot finds it, git cannot read it.
    const fake = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-rbverb-fake-')), 'main')
    await fs.mkdir(path.join(fake, '.git'), { recursive: true })
    const id = await mission(r, r.wt, 1, fake)
    const head = git(r.wt, 'rev-parse', 'HEAD')
    commit(r.main, 'other.txt', 'other\n', 'main moved')
    const res = await rebase(fake, id)
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/^WORKTREE_NOT_IN_REPO/)
    expect(git(r.wt, 'rev-parse', 'HEAD')).toBe(head)
  })
})

describe('Missions v4 S-27 (AC-70) — only the leader of the mission may rebase, over the wire', () => {
  it('a session that is not attached is refused and the worktree does not move', async () => {
    const r = await repo()
    const id = await mission(r, r.wt)
    commit(r.main, 'other.txt', 'other\n', 'main moved')
    const head = git(r.wt, 'rev-parse', 'HEAD')
    const res = await rebase(r.main, id, { sessionId: STRANGER })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/NOT_ATTACHED/)
    expect(git(r.wt, 'rev-parse', 'HEAD')).toBe(head)
  })
})
