/**
 * Session evidence reaches the mission, S-3: dispatched sessions are born attached (AC-11, AC-13,
 * AC-14; BUG-296).
 *
 * Every path is driven end to end through the code that runs in production: the real manifest drain,
 * the real board IPC, the real `create_session` handler, the real `pty:create` and `pty:rekey`
 * handlers, and the scoped credential the spawn was really given (read from the 0600 file its argv
 * names, then used over the real MCP transport). Only what Harnu does not run in main is faked:
 * `node-pty`, the CLI probes around the argv, and the renderer, which is reproduced as it behaves. It
 * spawns with the synthetic id as the session key, re-keys the PTY once the transcript lands, and
 * reports a materialization only for an agent-controlled (`create_session`) row.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const h = vi.hoisted(() => ({
  userDataDir: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  spawns: [] as Array<{ args: string[]; cwd: string }>
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
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown): void => {
      h.handlers.set(channel, fn)
    },
    on: (channel: string, fn: (...args: unknown[]) => unknown): void => {
      h.listeners.set(channel, fn)
    }
  }
}))
vi.mock('node-pty', () => ({
  spawn: (_command: string, args: string[], opts: { cwd: string }): unknown => {
    h.spawns.push({ args: [...args], cwd: opts.cwd })
    return {
      pid: 4242,
      onData: (): void => {},
      onExit: (): void => {},
      write: (): void => {},
      resize: (): void => {},
      kill: (): void => {},
      pause: (): void => {},
      resume: (): void => {}
    }
  }
}))
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanFolders: async (): Promise<unknown[]> => []
}))
// The fleet scan waits for the app's own boot; the drain only reads it to tell a stale card.
vi.mock('../src/main/fleet-model', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFleetFolders: async (): Promise<unknown[]> => []
}))
vi.mock('../src/main/claude-cli', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveClaudePath: async (): Promise<string> => '/usr/bin/claude'
}))
vi.mock('../src/main/claude-config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveClaudeBootArgs: async (
    _cwd: string | undefined,
    base: string[]
  ): Promise<{ args: string[]; env: Record<string, string> }> => ({ args: [...base], env: {} }),
  getResolvedConfig: async (): Promise<Record<string, unknown>> => ({})
}))
vi.mock('../src/main/orchestrator-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isArmed: async (): Promise<boolean> => false,
  arm: async (): Promise<void> => {},
  shouldArmAtSpawn: (): boolean => false
}))
vi.mock('../src/main/extensions/extensions-loader', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveModeContract: async (): Promise<string> => ''
}))
vi.mock('../src/main/appimage-env', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loginPathOnce: async (): Promise<null> => null
}))

import { registerMcpServer, closeMcpServer } from '../src/main/mcp/server'
import { createConfirmCore } from '../src/main/mcp/confirm-core'
import { _setStepInputsForTest, realFactsDeps, WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { gatherStepInputs } from '../src/main/missions/facts'
import { registerPtyHandlers } from '../src/main/pty'
import { registerManifestDrain } from '../src/main/manifest-drain-shell'
import { pokeManifestDrain, setDrainPoke } from '../src/main/manifest-drain'
import { registerRoadmapHandlers, resolveRoadmap } from '../src/main/roadmap-ipc'
import { readMissionRecord } from '../src/main/missions/record-store'
import { parseCard, type BootPromptLabels, type RoadmapCard } from '../src/main/roadmap-core'
import type { MissionV4 } from '../src/main/missions/model'

vi.setConfig({ testTimeout: 40_000 })

const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'

const LABELS: BootPromptLabels = {
  heading: 'Card',
  framing: 'Work on this card.',
  specLabel: 'Spec',
  specFileHint: 'Read the spec file.',
  closure: 'Report when done.'
}

// ---- The renderer, as it behaves ------------------------------------------------------------------

/** One session the fake renderer started. */
interface Started {
  syntheticId: string
  folder: string
  agentControlled: boolean
  prompt: string
  argv: string[]
}

let started: Started[] = []
/** Boots waiting for the serial queue, when a test holds them back. */
let held: Array<() => Promise<void>> = []
let holdBoots = false
/** The transcript lands before the dispatch binds the card: the boot is known first. */
let rekeyAtBoot = false
let notices: Array<Record<string, unknown>> = []
let synthetic = 0

async function ptyCreate(opts: Record<string, unknown>): Promise<void> {
  const create = h.handlers.get('pty:create')
  if (!create) throw new Error('pty:create was not registered')
  await create({}, { cols: 80, rows: 24, kind: 'claude-new', ...opts })
}

/** The renderer spawns the PTY of a row, keyed by its synthetic id. */
async function boot(row: {
  syntheticId: string
  folder: string
  agentControlled: boolean
  prompt: string
}): Promise<void> {
  await ptyCreate({
    cwd: row.folder,
    sessionKey: row.syntheticId,
    spawnedBy: 'agent',
    ...(row.agentControlled ? { agentControlled: true } : {}),
    ...(row.prompt ? { bootOverride: { prePrompt: row.prompt.trim() } } : {})
  })
  started.push({ ...row, argv: h.spawns[h.spawns.length - 1].args })
}

function newRow(
  folder: string,
  prompt: string,
  agentControlled: boolean
): {
  syntheticId: string
  folder: string
  agentControlled: boolean
  prompt: string
} {
  synthetic += 1
  const syntheticId = `synthetic-00000000-0000-4000-8000-${String(synthetic).padStart(12, '0')}`
  return { syntheticId, folder, agentControlled, prompt }
}

/** The transcript landed: the renderer re-keys the PTY from the synthetic id to the real one. */
function rekey(row: Started): string {
  const sid = sessionIdOf(row)
  h.listeners.get('pty:rekey')!({}, row.syntheticId, sid)
  return sid
}

/** The id the CLI was told to use, or one the CLI minted itself. */
function sessionIdOf(row: Started): string {
  const at = row.argv.indexOf('--session-id')
  return at >= 0 ? row.argv[at + 1] : `c1c1c1c1-0000-4000-8000-${row.syntheticId.slice(-12)}`
}

const bridge = {
  dispatch: async (command: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (command === 'roadmap.bootLabels') return { labels: LABELS }
    if (command === 'notify.push') {
      notices.push(payload)
      return {}
    }
    if (command === 'session.dispatchCard') {
      // BUG-23: a dispatch answers with the synthetic id at once; the boot is queued.
      const row = newRow(payload.folderPath as string, payload.prompt as string, false)
      if (holdBoots) held.push(() => boot(row))
      else {
        await boot(row)
        if (rekeyAtBoot) rekey(started[started.length - 1])
      }
      return { sessionId: row.syntheticId }
    }
    return {}
  },
  // Only `create_session` rows are ever reported as materialized; the handler's own bridge does it.
  awaitMaterialization: (): Promise<null> => new Promise(() => {})
}

// ---- The server, the repo and the reads -----------------------------------------------------------

let serverUrl = ''
let repo = ''
let mainClient: Client
const open: Client[] = []

interface Reply {
  isError: boolean
  text: string
  body: Record<string, unknown>
}

async function connectAs(bearer: string): Promise<Client> {
  const c = new Client({ name: 'attach-test', version: '0.0.0' })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(serverUrl), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } }
    })
  )
  open.push(c)
  return c
}

function readBody(isError: boolean, text: string): Reply {
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* a refusal is plain text */
  }
  return { isError, text, body }
}

async function callOn(c: Client, name: string, args: Record<string, unknown>): Promise<Reply> {
  const res = (await c.callTool({ name, arguments: args })) as {
    isError?: boolean
    content: Array<{ text?: string }>
  }
  return readBody(res.isError === true, res.content[0]?.text ?? '')
}

const okOn = async (c: Client, name: string, args: Record<string, unknown>): Promise<Reply> => {
  const r = await callOn(c, name, args)
  expect(r.isError, `${name}: ${r.text}`).toBe(false)
  return r
}

/** The client the spawned session itself holds: the config its argv names. */
async function clientOf(row: Started): Promise<Client> {
  const at = row.argv.indexOf('--mcp-config')
  expect(at, 'the spawn was given no MCP config').toBeGreaterThanOrEqual(0)
  const cfg = JSON.parse(await fs.readFile(row.argv[at + 1], 'utf8')) as {
    mcpServers: { harnu: { headers: { Authorization: string } } }
  }
  return connectAs(cfg.mcpServers.harnu.headers.Authorization.replace(/^Bearer /, ''))
}

/** What a session does in its first turn: read its mission and write every verb of its role. */
async function firstTurn(
  row: Started,
  missionId: string,
  stepId: string,
  role: 'worker' | 'verifier'
): Promise<void> {
  const c = await clientOf(row)
  const folder = row.folder
  await okOn(c, 'mission_get', { folder, missionId })
  await okOn(c, 'mission_log', { folder, missionId, note: `The ${role} started on the step` })
  await okOn(c, 'mission_link', { folder, missionId, link: { kind: 'pr', ref: '12' } })
  await okOn(c, 'mission_set_blocker', {
    folder,
    missionId,
    reason: 'The export needs the `export-sample.csv` file from the operator',
    ask: 'Add the sample file to the repo',
    unblocks: 'The export test',
    owner: 'agent'
  })
  if (role === 'verifier') {
    await okOn(c, 'mission_settle_ac', {
      folder,
      missionId,
      stepId,
      criterionId: 'ac-1',
      evidence: 'Ran the export on the sample file and opened the CSV'
    })
  }
}

async function gitRepo(): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-attach-repo-'))
  const remote = path.join(base, 'remote.git')
  const root = path.join(base, 'main')
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: 'pipe' })
  }
  git(base, 'init', '--bare', '-b', 'main', remote)
  git(base, 'clone', remote, root)
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'test')
  git(root, 'checkout', '-b', 'main')
  await fs.writeFile(path.join(root, '.gitignore'), '.harnu/\n.claude/\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'seed')
  git(root, 'push', '-u', 'origin', 'main')
  return root
}

const readRecord = async (id: string): Promise<MissionV4> => {
  const read = await readMissionRecord(repo, id)
  if (!read.ok) throw new Error(read.error)
  return read.record
}

async function readLog(id: string): Promise<string> {
  const read = await readMissionRecord(repo, id)
  if (!read.ok) throw new Error(read.error)
  return read.log
}

async function cardOf(slug: string): Promise<RoadmapCard> {
  const { roadmapDir } = await resolveRoadmap(repo)
  return parseCard(await fs.readFile(path.join(roadmapDir, `${slug}.md`), 'utf8'), slug)
}

async function newMission(steps = 1): Promise<string> {
  const r = await okOn(mainClient, 'mission_create', {
    folder: repo,
    title: `Export the report ${Math.random().toString(36).slice(2, 8)}`,
    doneWhen: 'The CSV export is merged and a spreadsheet opens it',
    sessionId: LEADER,
    steps: Array.from({ length: steps }, (_, i) => ({
      title: `Add exporter number ${'ABCD'[i]}`,
      criteria: [{ text: 'The exporter writes valid CSV' }]
    }))
  })
  return r.body.id as string
}

async function newCard(title: string): Promise<string> {
  const r = await okOn(mainClient, 'create_card', {
    folder: repo,
    title,
    kind: 'feature',
    body: `${title}.`
  })
  return r.body.slug as string
}

type Handler = (
  args: Record<string, unknown>,
  ctx: Record<string, unknown>
) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>
const handlerOf = (op: string): Handler =>
  WIRED_TOOLS.find((t) => t.op === op)!.handler as unknown as Handler

async function callHandler(
  op: string,
  args: Record<string, unknown>,
  ctx: Record<string, unknown> = {}
): Promise<Reply> {
  const r = await handlerOf(op)(
    { folder: repo, ...args },
    { folder: repo, folders: [], denyFolders: [], ...ctx }
  )
  return readBody(r.isError === true, r.content[0]?.text ?? '')
}

/** Stamp the cards for their steps and let the real drain dispatch them. */
async function drain(cards: Array<Record<string, unknown>>): Promise<void> {
  for (const card of cards) {
    await okOn(mainClient, 'move_card', { folder: repo, slug: card.slug, to: 'ready' })
  }
  const r = await callHandler('submit_manifest', { cards })
  expect(r.isError, r.text).toBe(false)
  const before = started.length + held.length
  pokeManifestDrain(repo)
  await vi.waitFor(() => expect(started.length + held.length).toBe(before + cards.length), {
    timeout: 15_000
  })
}

/**
 * `create_session` with a step, as the leader makes it: the renderer boots an agent-controlled row,
 * `inFirstTurn` runs while the session's first turn is still going, then the materialization is
 * reported.
 */
async function createSession(
  args: Record<string, unknown>,
  inFirstTurn: (row: Started) => Promise<void> = async () => {}
): Promise<{ reply: Reply; row: Started }> {
  let row: Started | undefined
  const reply = await callHandler('create_session', args, {
    bridge: {
      dispatch: async (command: string, payload: Record<string, unknown>) => {
        if (command !== 'session.create') return bridge.dispatch(command, payload)
        const next = newRow(repo, '', true)
        await boot(next)
        row = started[started.length - 1]
        return { syntheticId: next.syntheticId }
      },
      awaitMaterialization: async (syntheticId: string) => {
        await inFirstTurn(row!)
        const sessionId = rekey(row!)
        return { syntheticId, sessionId, folder: repo }
      }
    }
  })
  return { reply, row: row! }
}

const boardIpc = async (channel: string, args: unknown): Promise<Record<string, unknown>> =>
  (await h.handlers.get(channel)!({}, args)) as Record<string, unknown>

/** The board's Dispatch button: plan, create the worktree if any, spawn, bind. */
async function boardDispatch(slug: string, spawnFolder = repo): Promise<Started> {
  const plan = await boardIpc('roadmap:planDispatch', { folder: repo, slug, labels: LABELS })
  expect(plan.ok, JSON.stringify(plan)).toBe(true)
  const row = newRow(spawnFolder, plan.prompt as string, false)
  await boot(row)
  const out = await boardIpc('roadmap:bindSession', {
    folder: repo,
    slug,
    sessionId: row.syntheticId
  })
  expect(out.ok, JSON.stringify(out)).toBe(true)
  return started[started.length - 1]
}

async function expectRunningWorker(
  missionId: string,
  stepId: string,
  sessionId: string
): Promise<void> {
  await vi.waitFor(
    async () => {
      const step = (await readRecord(missionId)).steps.find((s) => s.id === stepId)!
      expect(step.links).toContainEqual({ kind: 'session', ref: sessionId })
      expect(step.card).toBeTruthy()
    },
    { timeout: 10_000 }
  )
  expect((await readRecord(missionId)).sessions.find((s) => s.id === sessionId)).toMatchObject({
    role: 'worked',
    to: null
  })
  const view = await okOn(mainClient, 'mission_get', {
    folder: repo,
    missionId,
    sessionId: LEADER
  })
  const step = (view.body.steps as Array<{ id: string; state: string }>).find(
    (s) => s.id === stepId
  )
  expect(step?.state).toBe('running')
}

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-attach-ud-'))
  // The real facts (the board's columns, the record's links), with every session's process working:
  // what the hooks would report of a session in its first turn.
  _setStepInputsForTest(async (root, record) =>
    gatherStepInputs(root, record, {
      ...(await realFactsDeps(root, 200)),
      taskState: () => 'working'
    })
  )
  await registerMcpServer(() => null, {
    bridge: bridge as never,
    confirm: createConfirmCore({
      send: () => true,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now()
    })
  })
  const cfg = JSON.parse(await fs.readFile(path.join(h.userDataDir, 'harnu.mcp.json'), 'utf8')) as {
    mcpServers: { harnu: { url: string; headers: { Authorization: string } } }
  }
  serverUrl = cfg.mcpServers.harnu.url
  mainClient = await connectAs(cfg.mcpServers.harnu.headers.Authorization.replace(/^Bearer /, ''))
  registerPtyHandlers(() => null)
  registerRoadmapHandlers(() => null)
  registerManifestDrain(bridge as never, () => null)
})

afterAll(async () => {
  _setStepInputsForTest(null)
  setDrainPoke(null)
  for (const c of open) await c.close().catch(() => {})
  await closeMcpServer()
})

beforeEach(async () => {
  repo = await gitRepo()
  started = []
  held = []
  holdBoots = false
  rekeyAtBoot = false
  notices = []
})

afterEach(async () => {
  held = []
  vi.restoreAllMocks()
})

// ---- BUG-296: the reproduction ---------------------------------------------------------------------

describe('submit_manifest with a step binds the drained session (BUG-296)', () => {
  it('a worktree card: after the drain starts its session, the step has its card and its worker', async () => {
    const id = await newMission()
    const slug = await newCard('Add the CSV exporter')
    await drain([{ slug, missionId: id, stepId: 'stp-1', substrate: 'worktree' }])
    const [row] = started
    expect(row.folder).not.toBe(repo)
    const sessionId = rekey(row)

    await expectRunningWorker(id, 'stp-1', sessionId)
    expect((await readRecord(id)).steps[0].card).toBe(slug)
  })
})

// ---- AC-11 -----------------------------------------------------------------------------------------

describe('three paths attach', () => {
  it('three paths attach: create_session with a step, a worker', async () => {
    const id = await newMission()
    const { reply, row } = await createSession({ missionId: id, stepId: 'stp-1' }, (r) =>
      firstTurn(r, id, 'stp-1', 'worker')
    )
    expect(reply.isError, reply.text).toBe(false)
    expect(reply.body.bindError).toBeUndefined()
    await expectRunningWorker(id, 'stp-1', sessionIdOf(row))
  })

  it('three paths attach: create_session with a step, a verifier', async () => {
    const id = await newMission()
    const { reply, row } = await createSession(
      { missionId: id, stepId: 'stp-1', role: 'verifier' },
      (r) => firstTurn(r, id, 'stp-1', 'verifier')
    )
    expect(reply.isError, reply.text).toBe(false)
    const record = await readRecord(id)
    expect(record.sessions.find((s) => s.id === sessionIdOf(row))).toMatchObject({ to: null })
    // It checks the step, it did not build it: not linked, so what it settled is a verdict.
    expect(record.steps[0].links.some((l) => l.ref === sessionIdOf(row))).toBe(false)
    expect(record.steps[0].acs[0]).toMatchObject({ id: 'ac-1' })
    const view = await okOn(mainClient, 'mission_get', {
      folder: repo,
      missionId: id,
      sessionId: LEADER
    })
    const steps = view.body.steps as Array<{ criteria: Array<{ settled: boolean }> }>
    expect(steps[0].criteria[0].settled).toBe(true)
  })

  it('three paths attach: submit_manifest with a step, in the first turn and before the transcript lands', async () => {
    const id = await newMission()
    const slug = await newCard('Add the CSV exporter')
    await drain([{ slug, missionId: id, stepId: 'stp-1' }])
    const [row] = started
    await firstTurn(row, id, 'stp-1', 'worker')
    await expectRunningWorker(id, 'stp-1', sessionIdOf(row))
    rekey(row)
    await expectRunningWorker(id, 'stp-1', sessionIdOf(row))
  })

  it('three paths attach: two cards drained into one folder each get the verbs of their own step', async () => {
    const id = await newMission(2)
    const first = await newCard('Add the first exporter')
    const second = await newCard('Add the second exporter')
    // The renderer boots serially, so both notes are waiting before either session spawns.
    holdBoots = true
    await drain([
      { slug: first, missionId: id, stepId: 'stp-1' },
      { slug: second, missionId: id, stepId: 'stp-2' }
    ])
    for (const start of held.splice(0)) await start()
    expect(started).toHaveLength(2)
    await firstTurn(started[0], id, 'stp-1', 'worker')
    await firstTurn(started[1], id, 'stp-2', 'worker')
    await expectRunningWorker(id, 'stp-1', sessionIdOf(started[0]))
    await expectRunningWorker(id, 'stp-2', sessionIdOf(started[1]))
  })

  it('three paths attach: the board’s Dispatch on a step card', async () => {
    const id = await newMission()
    const slug = await newCard('Add the CSV exporter')
    const { stampCardForStep } = await import('../src/main/missions/dispatch')
    expect(await stampCardForStep(repo, { slug, missionId: id, stepId: 'stp-1' })).toMatchObject({
      ok: true
    })
    const row = await boardDispatch(slug)
    await firstTurn(row, id, 'stp-1', 'worker')
    const sessionId = rekey(row)
    await expectRunningWorker(id, 'stp-1', sessionId)
  })

  it('three paths attach: the board’s Dispatch on a step card cut into a worktree', async () => {
    const id = await newMission()
    const slug = await newCard('Add the CSV exporter')
    const { stampCardForStep } = await import('../src/main/missions/dispatch')
    await stampCardForStep(repo, { slug, missionId: id, stepId: 'stp-1', to: 'worktree' })
    const worktree = path.join(path.dirname(repo), 'board-wt')
    execFileSync('git', ['worktree', 'add', worktree, '-b', 'card/board'], {
      cwd: repo,
      stdio: 'pipe'
    })
    const row = await boardDispatch(slug, worktree)
    await firstTurn(row, id, 'stp-1', 'worker')
    await expectRunningWorker(id, 'stp-1', rekey(row))
  })

  it('a session the operator released is not attached again by its next call', async () => {
    const id = await newMission()
    const slug = await newCard('Add the CSV exporter')
    await drain([{ slug, missionId: id, stepId: 'stp-1' }])
    const [row] = started
    const sessionId = rekey(row)
    await expectRunningWorker(id, 'stp-1', sessionId)
    const { endSession } = await import('../src/main/missions/sessions')
    await endSession(repo, id, { sessionId, how: 'released' })
    const c = await clientOf(row)
    const r = await callOn(c, 'mission_get', { folder: repo, missionId: id })
    expect(r.text).toMatch(/NOT_ATTACHED/)
  })
})

// ---- AC-13 -----------------------------------------------------------------------------------------

describe('a failed bind is loud', () => {
  const surpriseOf = (log: string): string => log.slice(log.indexOf('· surprise'))

  it('a failed bind is loud: create_session answers bindError, notifies and logs a surprise', async () => {
    const id = await newMission()
    const slug = await newCard('Add the CSV exporter')
    const { stampCardForStep } = await import('../src/main/missions/dispatch')
    await stampCardForStep(repo, { slug, missionId: id, stepId: 'stp-1' })
    // The step's card is closed, so no session can be bound to it.
    const { roadmapDir } = await resolveRoadmap(repo)
    const file = path.join(roadmapDir, `${slug}.md`)
    await fs.writeFile(
      file,
      (await fs.readFile(file, 'utf8')).replace(/^status: .*$/m, 'status: done')
    )

    const { reply } = await createSession({ missionId: id, stepId: 'stp-1' })
    expect(reply.body.bindError).toMatch(/CARD_CLOSED/)
    await vi.waitFor(() => expect(notices.length).toBeGreaterThan(0))
    expect(`${notices[0].title} ${notices[0].description}`).toContain(slug)
    expect(await readLog(id)).toContain('· surprise')
    expect(surpriseOf(await readLog(id))).toContain(slug)
  })

  it('a failed bind is loud: a drained session names its card in a notice and a surprise', async () => {
    const id = await newMission()
    const slug = await newCard('Add the CSV exporter')
    holdBoots = true
    await drain([{ slug, missionId: id, stepId: 'stp-1' }])
    // The card is closed between the dispatch and the session's boot.
    const { roadmapDir } = await resolveRoadmap(repo)
    const file = path.join(roadmapDir, `${slug}.md`)
    await vi.waitFor(async () => expect((await cardOf(slug)).session).toBeTruthy())
    await fs.writeFile(
      file,
      (await fs.readFile(file, 'utf8')).replace(/^status: .*$/m, 'status: done')
    )
    for (const start of held.splice(0)) await start()
    rekey(started[0])

    await vi.waitFor(() => expect(notices.some((n) => String(n.title).includes(slug))).toBe(true), {
      timeout: 10_000
    })
    const log = await readLog(id)
    expect(surpriseOf(log)).toContain(slug)
    expect(surpriseOf(log)).toContain('CARD_CLOSED')
    // The Log never names a session by its id.
    expect(surpriseOf(log)).not.toContain(sessionIdOf(started[0]))
  })
})

describe('a failed bind is loud: a session that missed the deadline', () => {
  it('create_session asks for the late bind when the spawn did not materialize in time', async () => {
    const { runCreateSession } = await import('../src/main/mcp/create-session-core')
    const late: string[] = []
    const res = await runCreateSession(
      repo,
      { folder: repo },
      {},
      {
        dispatchCreate: async () => ({ syntheticId: 'synthetic-late' }),
        awaitMaterialization: async () => null,
        tryReserve: () => true,
        attachSyntheticId: () => {},
        release: () => {},
        onNotMaterialized: (syntheticId) => void late.push(syntheticId)
      },
      1
    )
    expect(res.isError).toBe(true)
    expect(late).toEqual(['synthetic-late'])
  })

  it('a boot reported later reaches whoever waits, with the id Harnu minted over the renderer’s pick', async () => {
    const boots = await import('../src/main/mcp/session-boot')
    const waiting = boots.awaitSessionBoot('synthetic-minted', 5_000)
    boots.noteSpawnedSessionId('synthetic-minted', 'aaaaaaaa-0000-4000-8000-000000000001')
    boots.noteSessionRekey('synthetic-minted', 'bbbbbbbb-0000-4000-8000-000000000002', repo)
    expect((await waiting)?.sessionId).toBe('aaaaaaaa-0000-4000-8000-000000000001')
    expect(await boots.awaitSessionBoot('synthetic-never-booted', 1)).toBeNull()
  })
})

// ---- AC-14 -----------------------------------------------------------------------------------------

describe('card gets the real id', () => {
  const fleetWith = (sessionId: string): unknown[] => [
    {
      path: repo,
      slug: 'repo',
      alias: 'repo',
      sessions: [
        {
          sessionId,
          fullPath: '',
          firstPrompt: 'Card',
          summary: '',
          messageCount: 1,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          fileMtime: Date.now(),
          gitBranch: 'main',
          projectPath: repo,
          isSidechain: false
        }
      ]
    }
  ]

  it('card gets the real id: a drained step card, and get_session answers on it', async () => {
    const id = await newMission()
    const slug = await newCard('Add the CSV exporter')
    await drain([{ slug, missionId: id, stepId: 'stp-1' }])
    await vi.waitFor(async () => expect((await cardOf(slug)).session).toBe(started[0].syntheticId))
    const sessionId = rekey(started[0])
    await vi.waitFor(async () => expect((await cardOf(slug)).session).toBe(sessionId), {
      timeout: 10_000
    })
    const r = await callHandler('get_session', { sessionId }, { folders: fleetWith(sessionId) })
    expect(r.isError, r.text).toBe(false)
    expect((r.body.session as { sessionId: string }).sessionId).toBe(sessionId)
  })

  it('card gets the real id: a drained card with no step, too', async () => {
    const slug = await newCard('A card for no step')
    await drain([{ slug }])
    const sessionId = rekey(started[0])
    await vi.waitFor(async () => expect((await cardOf(slug)).session).toBe(sessionId), {
      timeout: 10_000
    })
  })
})

// ---- The boot is known before the bind ----------------------------------------------------------

/** The card file of `slug`. */
async function cardFile(slug: string): Promise<string> {
  const { roadmapDir } = await resolveRoadmap(repo)
  return path.join(roadmapDir, `${slug}.md`)
}

/**
 * Hold the `dispatched-with` append between its read and its write, long enough for everything the
 * bind does to land in between unless the two are kept apart.
 */
async function slowAppend(slug: string, ms = 600): Promise<void> {
  const file = await cardFile(slug)
  const real = fs.writeFile.bind(fs)
  let held = false
  vi.spyOn(fs, 'writeFile').mockImplementation(async (target, data, options) => {
    if (!held && String(target).startsWith(file) && String(data).includes('dispatched-with:')) {
      held = true
      await new Promise((r) => setTimeout(r, ms))
    }
    return real(target, data, options)
  })
}

describe('card gets the real id: the boot is known before the bind', () => {
  it('card gets the real id: the dispatched-with note and the bind never overwrite each other', async () => {
    const id = await newMission()
    const slug = await newCard('Add the CSV exporter')
    await slowAppend(slug)
    rekeyAtBoot = true
    await drain([{ slug, missionId: id, stepId: 'stp-1' }])
    const sessionId = sessionIdOf(started[0])
    // Past the held append, whatever order the two writers ran in.
    await new Promise((r) => setTimeout(r, 1_500))

    const content = await fs.readFile(await cardFile(slug), 'utf8')
    expect(parseCard(content, slug).session).toBe(sessionId)
    expect(content).toContain('dispatched-with:')
    expect(content).toContain('<!-- mission:begin stp-1 -->')
    await expectRunningWorker(id, 'stp-1', sessionId)
    expect(notices).toEqual([])
  })
})

// ---- A failed bind says it once -------------------------------------------------------------------

const surprises = async (id: string): Promise<number> =>
  (await readLog(id)).split('\u00b7 surprise').length - 1

const bindNotices = (): Array<Record<string, unknown>> =>
  notices.filter((n) => String(n.title).includes('not attached'))

describe('a failed bind is loud: exactly once', () => {
  async function closeCard(slug: string): Promise<void> {
    const file = await cardFile(slug)
    await fs.writeFile(
      file,
      (await fs.readFile(file, 'utf8')).replace(/^status: .*$/m, 'status: done')
    )
  }

  it('a failed bind is loud: a drained session that also calls says it once, naming the card', async () => {
    const id = await newMission()
    const slug = await newCard('Add the CSV exporter')
    holdBoots = true
    await drain([{ slug, missionId: id, stepId: 'stp-1' }])
    await vi.waitFor(async () =>
      expect(await fs.readFile(await cardFile(slug), 'utf8')).toContain('dispatched-with:')
    )
    await closeCard(slug)
    for (const start of held.splice(0)) await start()
    const [row] = started
    const c = await clientOf(row)
    await callOn(c, 'mission_get', { folder: row.folder, missionId: id })
    rekey(row)
    await new Promise((r) => setTimeout(r, 800))

    expect(await surprises(id)).toBe(1)
    expect(bindNotices()).toHaveLength(1)
    expect(String(bindNotices()[0].title)).toContain(slug)
  })

  it('a failed bind is loud: create_session whose session also calls says it once', async () => {
    const id = await newMission()
    const slug = await newCard('Add the CSV exporter')
    const { stampCardForStep } = await import('../src/main/missions/dispatch')
    await stampCardForStep(repo, { slug, missionId: id, stepId: 'stp-1' })
    await closeCard(slug)
    const { reply } = await createSession({ missionId: id, stepId: 'stp-1' }, async (row) => {
      const c = await clientOf(row)
      await callOn(c, 'mission_get', { folder: row.folder, missionId: id })
    })
    await new Promise((r) => setTimeout(r, 300))

    expect(reply.body.bindError).toMatch(/CARD_CLOSED/)
    expect(await surprises(id)).toBe(1)
    expect(bindNotices()).toHaveLength(1)
    expect(String(bindNotices()[0].title)).toContain(slug)
  })

  it('a failed bind is loud: a card that cannot be read once the session booted', async () => {
    const id = await newMission()
    const slug = await newCard('Add the CSV exporter')
    await drain([{ slug, missionId: id, stepId: 'stp-1' }])
    const file = await cardFile(slug)
    await vi.waitFor(async () =>
      expect(await fs.readFile(file, 'utf8')).toContain('dispatched-with:')
    )
    // The read that finds the card empty, as one made in the middle of another write did.
    await fs.writeFile(file, '')
    rekey(started[0])

    await vi.waitFor(() => expect(bindNotices()).toHaveLength(1), { timeout: 5_000 })
    expect(String(bindNotices()[0].title)).toContain(slug)
    await vi.waitFor(async () => expect(await surprises(id)).toBe(1))
    expect(await readLog(id)).toContain('CARD_UNREADABLE')
  })
})

// ---- A verifier starts only through create_session ------------------------------------------------

describe('three paths attach: a verifier starts only through create_session', () => {
  /** A card whose frontmatter asks for a verifier, stamped for the step by hand. */
  async function verifierCard(id: string): Promise<string> {
    const slug = await newCard('Check the CSV exporter')
    const { stampCardForStep } = await import('../src/main/missions/dispatch')
    await stampCardForStep(repo, { slug, missionId: id, stepId: 'stp-1' })
    const file = await cardFile(slug)
    await fs.writeFile(
      file,
      (await fs.readFile(file, 'utf8')).replace(/^---\n/, '---\nrole: verifier\n')
    )
    return slug
  }

  const stampedNothing = async (slug: string): Promise<void> => {
    const content = await fs.readFile(await cardFile(slug), 'utf8')
    expect(content).not.toMatch(/^approved:/m)
  }

  it('three paths attach: a manifest entry asking for a verifier is refused over MCP', async () => {
    const id = await newMission()
    const slug = await newCard('Check the CSV exporter')
    await okOn(mainClient, 'move_card', { folder: repo, slug, to: 'ready' })
    const r = await callOn(mainClient, 'submit_manifest', {
      folder: repo,
      cards: [{ slug, missionId: id, stepId: 'stp-1', role: 'verifier' }]
    }).catch((err: Error) => ({ isError: true, text: err.message }))
    expect(r.isError, r.text).toBe(true)
    expect(r.text).toContain('create_session')
    await stampedNothing(slug)
    expect(started).toHaveLength(0)
  })

  it('three paths attach: the manifest handler refuses it too, from the entry or from the card', async () => {
    const id = await newMission()
    const plain = await newCard('Add the CSV exporter')
    const byEntry = await callHandler('submit_manifest', {
      cards: [{ slug: plain, role: 'verifier' }]
    })
    expect(byEntry.isError).toBe(true)
    expect(byEntry.text).toMatch(/VERIFIER_NOT_DISPATCHABLE.*create_session/s)
    await stampedNothing(plain)

    const slug = await verifierCard(id)
    const byCard = await callHandler('submit_manifest', { cards: [{ slug }] })
    expect(byCard.isError).toBe(true)
    expect(byCard.text).toMatch(/VERIFIER_NOT_DISPATCHABLE.*create_session/s)
    expect(byCard.text).toContain(slug)
    await stampedNothing(slug)
  })

  it('three paths attach: the board refuses a verifier card and says to use create_session', async () => {
    const id = await newMission()
    const slug = await verifierCard(id)
    const plan = await boardIpc('roadmap:planDispatch', { folder: repo, slug, labels: LABELS })
    expect(plan.ok).toBe(false)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(String(notices[0].title)).toContain(slug)
    expect(String(notices[0].description)).toContain('create_session')
    expect(started).toHaveLength(0)
    expect((await readRecord(id)).steps[0].links).toEqual([])
  })
})
