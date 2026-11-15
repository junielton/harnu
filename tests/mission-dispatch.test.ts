/**
 * Missions v4 · S-26 · AC-68 — dispatch binds the step's card and attaches the worker.
 *
 * A step has a board card only when it is dispatched to a session or worktree of its own, and the
 * session that takes it is attached as a worker whose scoped verbs reach only that step. Three paths
 * dispatch a step, and each binds it:
 *
 *  - `create_session` by the leader with a step: the ACK names the card and the worker.
 *  - `submit_manifest` with a step on a card: the card is stamped for the step when the manifest is
 *    stamped, and the session the drain starts is attached when it boots (`bindCardSession`).
 *  - a board dispatch: the same `bindCardSession`, over the card's own stamp.
 *
 * Graded the way S-25 is: the sessions' credentials are the real ones over the real MCP transport, and
 * every claim is read back from the files on disk (the board's cards and the mission's record), not
 * from an ACK. Only `electron` and the live sources are stubbed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const h = vi.hoisted(() => ({
  userDataDir: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>()
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
    on: (): void => {}
  }
}))
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanFolders: async (): Promise<unknown[]> => []
}))

import { registerMcpServer, closeMcpServer } from '../src/main/mcp/server'
import { createConfirmCore } from '../src/main/mcp/confirm-core'
import { _setStepInputsForTest, WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { dropPendingSpawn, mintScopedBearer, takePendingSpawn } from '../src/main/mcp/scope'
import { readMissionRecord } from '../src/main/missions/record-store'
import {
  bindCardSession,
  createDrainBinder,
  dispatchStep,
  noteCardSpawn,
  realBoardIo,
  setBootWaiter,
  stampCardForStep
} from '../src/main/missions/dispatch'
import {
  resolveRoadmap,
  buildManifestDisclosure,
  registerRoadmapHandlers
} from '../src/main/roadmap-ipc'
import {
  approvalHashMatches,
  parseCard,
  type BootPromptLabels,
  type RoadmapCard
} from '../src/main/roadmap-core'
import type { MissionV4 } from '../src/main/missions/model'

const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const WORKER = '5b7d9f11-2a4c-4e6a-8b0d-1c3e5a7c9e21'
const VERIFIER = '8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d'
const DRAINED = 'c1c1c1c1-0000-4000-8000-0000000000c1'

let serverUrl = ''
let serverToken = ''
let repo = ''
let mainClient: Client
const open: Client[] = []

interface Reply {
  isError: boolean
  text: string
  body: Record<string, unknown>
}

async function connectAs(bearer: string): Promise<Client> {
  const c = new Client({ name: 'dispatch-test', version: '0.0.0' })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(serverUrl), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } }
    })
  )
  open.push(c)
  return c
}

async function callOn(c: Client, name: string, args: Record<string, unknown>): Promise<Reply> {
  try {
    const res = (await c.callTool({ name, arguments: args })) as {
      isError?: boolean
      content: Array<{ type: string; text?: string }>
    }
    const text = res.content[0]?.text ?? ''
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(text) as Record<string, unknown>
    } catch {
      /* a refusal is plain text */
    }
    return { isError: res.isError === true, text, body }
  } catch (err) {
    return { isError: true, text: String(err instanceof Error ? err.message : err), body: {} }
  }
}

const okOn = async (c: Client, name: string, args: Record<string, unknown>): Promise<Reply> => {
  const r = await callOn(c, name, args)
  expect(r.isError, r.text).toBe(false)
  return r
}

async function fakeRepo(): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-dispatch-repo-'))
  const root = path.join(base, 'main')
  await fs.mkdir(path.join(root, '.git'), { recursive: true })
  return root
}

const readRecord = async (id: string): Promise<MissionV4> => {
  const read = await readMissionRecord(repo, id)
  if (!read.ok) throw new Error(read.error)
  return read.record
}

/** The mission's Log, as the file holds it. */
async function readLog(id: string): Promise<string> {
  const read = await readMissionRecord(repo, id)
  if (!read.ok) throw new Error(read.error)
  return read.log
}

/** Every card on the board, read off disk the way a reader sees it. */
async function boardCards(): Promise<Array<{ slug: string; content: string; card: RoadmapCard }>> {
  const { roadmapDir } = await resolveRoadmap(repo)
  let names: string[] = []
  try {
    names = (await fs.readdir(roadmapDir)).filter((n) => n.endsWith('.md'))
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    const slug = n.slice(0, -3)
    const content = await fs.readFile(path.join(roadmapDir, n), 'utf8')
    out.push({ slug, content, card: parseCard(content, slug) })
  }
  return out
}

const cardsOfStep = async (missionId: string, stepId: string): ReturnType<typeof boardCards> =>
  (await boardCards()).filter((c) => c.card.mission === missionId && c.card.step === stepId)

/** Two steps, the first with two criteria. The leader (self-declared) leads it. */
async function newMission(): Promise<string> {
  const r = await okOn(mainClient, 'mission_create', {
    folder: repo,
    title: `Export the report ${Math.random().toString(36).slice(2, 8)}`,
    doneWhen: 'The CSV export is merged and a spreadsheet opens it',
    sessionId: LEADER,
    steps: [
      {
        title: 'Add the CSV exporter',
        criteria: [
          { text: 'The exporter writes valid CSV' },
          { text: 'The exporter streams large reports' }
        ]
      },
      { title: 'Document the exporter', criteria: [{ text: 'The README says how to run it' }] }
    ]
  })
  return r.body.id as string
}

type Handler = (
  args: Record<string, unknown>,
  ctx: Record<string, unknown>
) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>
const handlerOf = (op: string): Handler =>
  WIRED_TOOLS.find((t) => t.op === op)!.handler as unknown as Handler

let dispatched = 0
const bridgeFor = (sessionId = WORKER): unknown => ({
  dispatch: async () => {
    dispatched++
    return { syntheticId: `synthetic-${dispatched}` }
  },
  awaitMaterialization: async (syntheticId: string) => ({ syntheticId, sessionId, folder: repo })
})

/** `create_session` as the leader makes it, reading the ACK back. */
async function createSession(
  args: Record<string, unknown>,
  bridge: unknown = bridgeFor()
): Promise<Reply> {
  const r = await handlerOf('create_session')(
    { folder: repo, ...args },
    { folder: repo, folders: [], denyFolders: [], bridge }
  )
  const text = r.content[0]?.text ?? ''
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* a refusal is plain text */
  }
  return { isError: r.isError === true, text, body }
}

const LABELS: BootPromptLabels = {
  heading: 'Card',
  framing: 'Work on this card.',
  specLabel: 'Spec',
  specFileHint: 'Read the spec file.',
  closure: 'Report when done.'
}

/** A card on the board, made the way the leader makes one (`create_card`): no step on it. */
async function newCard(title = 'Add the CSV exporter'): Promise<string> {
  const r = await okOn(mainClient, 'create_card', { folder: repo, title, kind: 'feature' })
  return r.body.slug as string
}

const submitManifest = async (
  cards: Array<Record<string, unknown>>
): Promise<{ isError: boolean; text: string }> => {
  const r = await handlerOf('submit_manifest')(
    { folder: repo, cards },
    { folder: repo, folders: [], denyFolders: [] }
  )
  return { isError: r.isError === true, text: r.content[0]?.text ?? '' }
}

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-dispatch-ud-'))
  _setStepInputsForTest(async () => ({}))
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
    mcpServers: { harnu: { url: string; headers: { Authorization: string } } }
  }
  serverUrl = cfg.mcpServers.harnu.url
  serverToken = cfg.mcpServers.harnu.headers.Authorization.replace(/^Bearer /, '')
  mainClient = await connectAs(serverToken)
})

afterAll(async () => {
  _setStepInputsForTest(null)
  for (const c of open) await c.close().catch(() => {})
  await closeMcpServer()
})

beforeEach(async () => {
  repo = await fakeRepo()
  dispatched = 0
  dropPendingSpawn(repo)
})

// ---- The proof of AC-68 -------------------------------------------------------------------------

describe('dispatch creates the card and attaches the worker', () => {
  it('create_session by the leader with a step: the card is created in backlog, the worker is attached, and the ACK says so', async () => {
    const id = await newMission()
    const r = await createSession({ missionId: id, stepId: 'stp-1' })
    expect(r.isError, r.text).toBe(false)

    // The card, read off the board: backlog, stamped for the step, with the marked block.
    const cards = await cardsOfStep(id, 'stp-1')
    expect(cards).toHaveLength(1)
    const { slug, card, content } = cards[0]
    expect(card.status).toBe('backlog')
    expect(card.mission).toBe(id)
    expect(card.step).toBe('stp-1')
    expect(card.title).toBe('Add the CSV exporter')
    expect(content).toContain('<!-- mission:begin stp-1 -->')
    expect(content).toContain('The exporter writes valid CSV')
    expect(content).toContain('The exporter streams large reports')
    expect(content).toContain('<!-- mission:end -->')

    // The mission's record: the step names the card, the session is attached as a worker and linked.
    const record = await readRecord(id)
    const step = record.steps.find((s) => s.id === 'stp-1')!
    expect(step.card).toBe(slug)
    expect(step.links).toContainEqual({ kind: 'session', ref: WORKER })
    const entry = record.sessions.find((s) => s.id === WORKER)
    expect(entry).toMatchObject({ role: 'worked', to: null })
    expect(record.sessions.find((s) => s.role === 'leads')?.id).toBe(LEADER)

    // The ACK carries what the leader reads: the step's card and the attached worker.
    expect(r.body.card).toMatchObject({ slug, action: 'created' })
    expect(r.body.worker).toMatchObject({
      sessionId: WORKER,
      missionId: id,
      stepId: 'stp-1',
      role: 'worker'
    })
  })

  it('the worker it attached holds the verbs of its own step and no other', async () => {
    const id = await newMission()
    await createSession({ missionId: id, stepId: 'stp-1' })

    const worker = await connectAs(
      mintScopedBearer(serverToken, {
        role: 'worker',
        sessionId: WORKER,
        folder: repo,
        missionId: id,
        stepId: 'stp-1'
      })
    )
    // Attached by the dispatch alone: it reads its mission, and is not NOT_ATTACHED.
    const got = await okOn(worker, 'mission_get', { folder: repo, missionId: id })
    expect(got.body.standing).toBe('worked')
    await okOn(worker, 'mission_log', { folder: repo, missionId: id, note: 'Started the exporter' })

    // Its own step is its own; another step is refused and nothing changes on disk.
    const before = await readLog(id)
    const other = await callOn(worker, 'mission_log', {
      folder: repo,
      missionId: id,
      stepId: 'stp-2',
      note: 'Also touching the docs'
    })
    expect(other.isError).toBe(true)
    expect(other.text).toMatch(/SCOPE_STEP/)
    expect(await readLog(id)).toBe(before)
  })

  it('a step the leader does itself gets no card, and nothing in the mission names one', async () => {
    const id = await newMission()
    await createSession({ missionId: id, stepId: 'stp-1' })

    // stp-2 is the leader's own: it links and logs, and is never dispatched.
    await okOn(mainClient, 'mission_log', {
      folder: repo,
      missionId: id,
      stepId: 'stp-2',
      note: 'Writing the README myself',
      sessionId: LEADER
    })
    expect(await cardsOfStep(id, 'stp-2')).toHaveLength(0)
    expect((await boardCards()).filter((c) => c.card.mission === id)).toHaveLength(1)
    const record = await readRecord(id)
    expect(record.steps.find((s) => s.id === 'stp-2')!.card).toBeUndefined()
  })

  it('dispatching the same step twice binds its one card: never a second', async () => {
    const id = await newMission()
    const first = await createSession({ missionId: id, stepId: 'stp-1' })
    dropPendingSpawn(repo)
    const second = await createSession({ missionId: id, stepId: 'stp-1' })
    expect(second.isError, second.text).toBe(false)
    expect(await cardsOfStep(id, 'stp-1')).toHaveLength(1)
    expect((first.body.card as { slug: string }).slug).toBe(
      (second.body.card as { slug: string }).slug
    )
    expect(second.body.card).toMatchObject({ action: 'bound' })
  })

  it('a verifier started for a step is attached but gets no card, and is not a builder of the step', async () => {
    const id = await newMission()
    const r = await createSession(
      { missionId: id, stepId: 'stp-1', role: 'verifier' },
      bridgeFor(VERIFIER)
    )
    expect(r.isError, r.text).toBe(false)
    expect(await boardCards()).toHaveLength(0)
    expect(r.body.card).toBeNull()
    expect(r.body.worker).toMatchObject({ sessionId: VERIFIER, role: 'verifier' })

    const record = await readRecord(id)
    expect(record.sessions.find((s) => s.id === VERIFIER)).toMatchObject({
      role: 'worked',
      to: null
    })
    // Linked to nothing: it did not build the step, so what it settles is not a self-check.
    expect(record.steps.find((s) => s.id === 'stp-1')!.links).not.toContainEqual({
      kind: 'session',
      ref: VERIFIER
    })
    expect(record.steps.find((s) => s.id === 'stp-1')!.card).toBeUndefined()
  })

  it('a session that never materialized is attached to nothing and leaves no card', async () => {
    const id = await newMission()
    const bridge = {
      dispatch: async () => ({ syntheticId: 'synthetic-slow' }),
      awaitMaterialization: async () => null
    }
    const r = await createSession({ missionId: id, stepId: 'stp-1' }, bridge)
    expect(r.isError).toBe(true)
    expect(await boardCards()).toHaveLength(0)
    expect((await readRecord(id)).sessions.map((s) => s.id)).toEqual([LEADER])
  })

  it('a closed mission starts no session for a step', async () => {
    const id = await newMission()
    const { closeMission } = await import('../src/main/missions/doors')
    await closeMission(repo, id, { closedAs: 'discarded' })
    const r = await createSession({ missionId: id, stepId: 'stp-1' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/MISSION_CLOSED/)
    expect(dispatched).toBe(0)
    expect(await boardCards()).toHaveLength(0)
  })
})

describe('submit_manifest with a step binds the card at the stamp and the worker at the boot', () => {
  it('stamps the card for its step without touching what the manifest fingerprints', async () => {
    const id = await newMission()
    const slug = await newCard()
    const r = await submitManifest([{ slug, missionId: id, stepId: 'stp-1' }])
    expect(r.isError, r.text).toBe(false)

    const [{ card }] = await cardsOfStep(id, 'stp-1')
    expect(card.slug).toBe(slug)
    expect(card.step).toBe('stp-1')
    // The approval stamp the drain checks still matches the body: binding the step did not void it.
    expect(card.approved).toBeTruthy()
    expect(approvalHashMatches(card, card.approvedBodyHash as string)).toBe(true)
    // The column is the card's own: submit_manifest never moves it, and Harnu never closes one.
    expect(card.status).toBe('backlog')
  })

  it('a card the operator unchecked at the Allow is not stamped for the step', async () => {
    const id = await newMission()
    const slug = await newCard()
    const built = await buildManifestDisclosure(repo, [{ slug }], LABELS)
    if (!built.ok) throw new Error('disclosure failed')
    const r = await handlerOf('submit_manifest')(
      { folder: repo, cards: [{ slug, missionId: id, stepId: 'stp-1' }] },
      {
        folder: repo,
        folders: [],
        denyFolders: [],
        opts: { manifest: { resolved: built.resolved, selectedSlugs: [], substrateOverrides: {} } }
      }
    )
    expect(r.isError).not.toBe(true)
    expect(await cardsOfStep(id, 'stp-1')).toHaveLength(0)
  })

  it('refuses the whole batch, and stamps nothing, when a card belongs to another step', async () => {
    const id = await newMission()
    const taken = await newCard('Taken card')
    const free = await newCard('Free card')
    expect((await submitManifest([{ slug: taken, missionId: id, stepId: 'stp-2' }])).isError).toBe(
      false
    )

    const r = await submitManifest([
      { slug: free },
      { slug: taken, missionId: id, stepId: 'stp-1' }
    ])
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/CARD_BOUND_ELSEWHERE/)
    expect(await cardsOfStep(id, 'stp-1')).toHaveLength(0)
    const freeCard = (await boardCards()).find((c) => c.slug === free)!
    expect(freeCard.card.approved).toBeFalsy()
  })

  it('a batch with one bad card binds none of its good ones', async () => {
    const id = await newMission()
    const holder = await newCard('Holds the second step')
    const free = await newCard('Free card')
    const intruder = await newCard('Another card for the second step')
    expect((await submitManifest([{ slug: holder, missionId: id, stepId: 'stp-2' }])).isError).toBe(
      false
    )

    const r = await submitManifest([
      { slug: free, missionId: id, stepId: 'stp-1' },
      { slug: intruder, missionId: id, stepId: 'stp-2' }
    ])
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/CARD_BOUND_ELSEWHERE/)
    // The good card was judged with the bad one and stamped with neither: no step, no approval.
    expect(await cardsOfStep(id, 'stp-1')).toHaveLength(0)
    expect((await boardCards()).find((c) => c.slug === free)!.card.approved).toBeFalsy()
  })

  it('two cards for one step are refused: a step has one card', async () => {
    const id = await newMission()
    const a = await newCard('First card')
    const b = await newCard('Second card')
    const r = await submitManifest([
      { slug: a, missionId: id, stepId: 'stp-1' },
      { slug: b, missionId: id, stepId: 'stp-1' }
    ])
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/a step has one card/)
    expect(await cardsOfStep(id, 'stp-1')).toHaveLength(0)
  })

  it('a mission or step that does not exist refuses the batch before anything is stamped', async () => {
    const id = await newMission()
    const slug = await newCard()
    const noStep = await submitManifest([{ slug, missionId: id, stepId: 'stp-9' }])
    expect(noStep.isError).toBe(true)
    expect(noStep.text).toMatch(/STEP_NOT_FOUND/)
    const noMission = await submitManifest([{ slug, missionId: 'mnt-00000000', stepId: 'stp-1' }])
    expect(noMission.isError).toBe(true)
    expect(noMission.text).toMatch(/MISSION_NOT_FOUND/)
    expect((await boardCards()).find((c) => c.slug === slug)!.card.approved).toBeFalsy()
  })

  it('the session the drain starts is attached as a worker when it boots, whatever id it had at the spawn', async () => {
    const id = await newMission()
    const slug = await newCard()
    await submitManifest([{ slug, missionId: id, stepId: 'stp-1' }])

    // The drain binds with the synthetic id it spawned; the real one arrives when the session boots.
    const out = await bindCardSession(repo, slug, 'synthetic-drained', {
      waitForBoot: async (synthetic) => ({
        syntheticId: synthetic,
        sessionId: DRAINED,
        folder: repo
      })
    })
    expect(out.ok, JSON.stringify(out)).toBe(true)

    const record = await readRecord(id)
    const step = record.steps.find((s) => s.id === 'stp-1')!
    expect(step.card).toBe(slug)
    expect(step.links).toContainEqual({ kind: 'session', ref: DRAINED })
    expect(record.sessions.find((s) => s.id === DRAINED)).toMatchObject({
      role: 'worked',
      to: null
    })

    // The card keeps the column the drain gave it, and now carries the marked block.
    const [{ card, content }] = await cardsOfStep(id, 'stp-1')
    expect(card.status).toBe('backlog')
    expect(content).toContain('<!-- mission:begin stp-1 -->')
  })

  it('a card with no step on it binds nothing: a plain card is dispatched as it always was', async () => {
    const id = await newMission()
    const slug = await newCard('A card for no step')
    const out = await bindCardSession(repo, slug, DRAINED)
    expect(out).toMatchObject({ ok: true, bound: false })
    expect((await readRecord(id)).sessions.map((s) => s.id)).toEqual([LEADER])
  })

  it('a card that names a step of a closed or vanished mission does not stop its dispatch', async () => {
    const id = await newMission()
    const slug = await newCard()
    await submitManifest([{ slug, missionId: id, stepId: 'stp-1' }])
    const { closeMission } = await import('../src/main/missions/doors')
    await closeMission(repo, id, { closedAs: 'discarded' })
    const out = await bindCardSession(repo, slug, DRAINED)
    // Nothing throws: the card is already running; the refusal is the answer.
    expect(out.ok).toBe(false)
  })
})

describe('a session the drain or the board spawns for a step is noted for its credential', () => {
  it('a stamped card leaves a note for its spawn folder, once', async () => {
    const id = await newMission()
    const slug = await newCard()
    await submitManifest([{ slug, missionId: id, stepId: 'stp-1' }])
    const noted = await noteCardSpawn(repo, repo, slug)
    expect(noted).toBe(true)
    expect(takePendingSpawn(repo)).toEqual({ role: 'worker', missionId: id, stepId: 'stp-1' })
    expect(takePendingSpawn(repo)).toBeUndefined()
  })

  it('a card with no step leaves no note, and the spawn is unscoped as it always was', async () => {
    const slug = await newCard('A card for no step')
    expect(await noteCardSpawn(repo, repo, slug)).toBe(false)
    expect(takePendingSpawn(repo)).toBeUndefined()
  })

  it('a card in a worktree is noted for the worktree it spawns in', async () => {
    const id = await newMission()
    const slug = await newCard()
    await submitManifest([{ slug, missionId: id, stepId: 'stp-1' }])
    const worktree = path.join(path.dirname(repo), 'wt')
    expect(await noteCardSpawn(worktree, repo, slug)).toBe(true)
    expect(takePendingSpawn(worktree)).toMatchObject({ missionId: id, stepId: 'stp-1' })
    expect(takePendingSpawn(repo)).toBeUndefined()
  })
})

describe('the drain’s side: the card being spawned, its note and its session', () => {
  const waitFor = async (
    syntheticId: string
  ): Promise<{ syntheticId: string; sessionId: string; folder: string }> => ({
    syntheticId,
    sessionId: DRAINED,
    folder: repo
  })

  it('in the order the drain calls it: a stamped card is noted where it spawns, then its session is attached', async () => {
    const id = await newMission()
    const slug = await newCard()
    await submitManifest([{ slug, missionId: id, stepId: 'stp-1' }])
    const binder = createDrainBinder()

    binder.planned(repo, slug)
    const undo = await binder.beforeSpawn(repo)
    expect(takePendingSpawn(repo)).toEqual({ role: 'worker', missionId: id, stepId: 'stp-1' })
    undo()

    await bindCardSession(repo, slug, 'synthetic-drained', { waitForBoot: waitFor })
    const record = await readRecord(id)
    expect(record.sessions.find((s) => s.id === DRAINED)).toMatchObject({
      role: 'worked',
      to: null
    })
    expect(record.steps.find((s) => s.id === 'stp-1')!.card).toBe(slug)
  })

  it('a spawn that fails takes its note back, so the next spawn in the folder is not scoped to it', async () => {
    const id = await newMission()
    const slug = await newCard()
    await submitManifest([{ slug, missionId: id, stepId: 'stp-1' }])
    const binder = createDrainBinder()
    binder.planned(repo, slug)
    const undo = await binder.beforeSpawn(repo)
    undo()
    expect(takePendingSpawn(repo)).toBeUndefined()
  })

  it('a worktree card is noted for the worktree it was cut into, and its session attached all the same', async () => {
    const id = await newMission()
    const slug = await newCard()
    await submitManifest([{ slug, missionId: id, stepId: 'stp-1' }])
    const worktree = path.join(path.dirname(repo), 'wt-card')
    const binder = createDrainBinder()
    binder.planned(repo, slug)
    binder.cut(worktree, repo, slug)
    await binder.beforeSpawn(worktree)
    expect(takePendingSpawn(worktree)).toMatchObject({ missionId: id, stepId: 'stp-1' })
    expect(takePendingSpawn(repo)).toBeUndefined()
  })

  it('a card with no step is neither noted nor attached', async () => {
    const id = await newMission()
    const slug = await newCard('A card for no step')
    const binder = createDrainBinder()
    binder.planned(repo, slug)
    await binder.beforeSpawn(repo)
    expect(takePendingSpawn(repo)).toBeUndefined()
    expect(
      await bindCardSession(repo, slug, 'synthetic-plain', { waitForBoot: waitFor })
    ).toMatchObject({ ok: true, bound: false })
    expect((await readRecord(id)).sessions.map((s) => s.id)).toEqual([LEADER])
  })

  it('a session that never boots is refused with a way out, not thrown: the bind goes on', async () => {
    const id = await newMission()
    const slug = await newCard()
    await submitManifest([{ slug, missionId: id, stepId: 'stp-1' }])
    const out = await bindCardSession(repo, slug, 'synthetic-never', {
      waitForBoot: async () => null
    })
    expect(out).toMatchObject({ ok: false, code: 'SESSION_NOT_BOOTED' })
    expect((await readRecord(id)).sessions.map((s) => s.id)).toEqual([LEADER])
  })

  it('the drain’s shell calls the binder at each point of a dispatch', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'manifest-drain-shell.ts'),
      'utf8'
    )
    for (const call of [
      'binder.planned(',
      'binder.cut(',
      'binder.beforeSpawn(',
      'setBootWaiter('
    ]) {
      expect(src, call).toContain(call)
    }
    expect(src).toContain('undoNote()')
  })
})

describe('a board dispatch binds the step like the drain does (S-26 delta 1)', () => {
  beforeAll(() => {
    registerRoadmapHandlers(() => null)
  })
  const ipc = async (channel: string, args: unknown): Promise<any> => {
    const fn = h.handlers.get(channel)
    if (!fn) throw new Error(`${channel} was not registered`)
    return fn({}, args)
  }
  const stamped = async (): Promise<{ id: string; slug: string }> => {
    const id = await newMission()
    const slug = await newCard()
    await submitManifest([{ slug, missionId: id, stepId: 'stp-1' }])
    return { id, slug }
  }
  afterEach(() => setBootWaiter(null))

  it('planning the dispatch of a stamped card leaves the note its session takes as its credential', async () => {
    const { id, slug } = await stamped()
    const plan = await ipc('roadmap:planDispatch', { folder: repo, slug, labels: LABELS })
    expect(plan.ok, JSON.stringify(plan)).toBe(true)
    expect(takePendingSpawn(repo)).toEqual({ role: 'worker', missionId: id, stepId: 'stp-1' })
  })

  it('binding the session to a stamped card attaches it as the step’s worker, linked, once it has booted', async () => {
    const { id, slug } = await stamped()
    setBootWaiter(async (syntheticId) => ({ syntheticId, sessionId: DRAINED, folder: repo }))
    const out = await ipc('roadmap:bindSession', {
      folder: repo,
      slug,
      sessionId: 'synthetic-board'
    })
    expect(out.ok).toBe(true)
    await vi.waitFor(async () => {
      const record = await readRecord(id)
      expect(record.sessions.find((s) => s.id === DRAINED)).toMatchObject({
        role: 'worked',
        to: null
      })
    })
    const record = await readRecord(id)
    const step = record.steps.find((s) => s.id === 'stp-1')!
    expect(step.links).toContainEqual({ kind: 'session', ref: DRAINED })
    expect(step.card).toBe(slug)
    // The card is bound as before: in progress, with the session the board gave it.
    const [{ card, content }] = await cardsOfStep(id, 'stp-1')
    expect(card.status).toBe('in-progress')
    expect(content).toContain('<!-- mission:begin stp-1 -->')
  })

  it('a card with no step is bound as before and attaches nothing, and plans no note', async () => {
    const id = await newMission()
    const slug = await newCard('A card for no step')
    setBootWaiter(async (syntheticId) => ({ syntheticId, sessionId: DRAINED, folder: repo }))
    const plan = await ipc('roadmap:planDispatch', { folder: repo, slug, labels: LABELS })
    expect(plan.ok).toBe(true)
    expect(takePendingSpawn(repo)).toBeUndefined()
    const out = await ipc('roadmap:bindSession', {
      folder: repo,
      slug,
      sessionId: 'synthetic-plain'
    })
    expect(out.ok).toBe(true)
    expect((await boardCards()).find((c) => c.slug === slug)!.card.status).toBe('in-progress')
    await new Promise((r) => setTimeout(r, 150))
    expect((await readRecord(id)).sessions.map((s) => s.id)).toEqual([LEADER])
  })

  it('a card cut into a worktree plans no note: where it spawns is not known until the worktree exists', async () => {
    const id = await newMission()
    const slug = await newCard('A worktree card')
    await submitManifest([{ slug, missionId: id, stepId: 'stp-1', substrate: 'worktree' }])
    const plan = await ipc('roadmap:planDispatch', { folder: repo, slug, labels: LABELS })
    expect(plan.ok).toBe(true)
    expect(takePendingSpawn(repo)).toBeUndefined()
  })
})

describe('the Log names the mission or the step by its quoted title, never a raw session id', () => {
  it('a dispatch by Harnu says which step, in quotes', async () => {
    const id = await newMission()
    await createSession({ missionId: id, stepId: 'stp-1' })
    const log = await readLog(id)
    expect(log).toContain('Harnu attached a worker to step "Add the CSV exporter"')
    expect(log).not.toContain(WORKER)
  })

  it('the picker and the operator’s allow and deny say which mission, in quotes', async () => {
    const id = await newMission()
    const record = await readRecord(id)
    const { attachFromPicker } = await import('../src/main/missions/sessions')
    const { decideAttachRequest } = await import('../src/main/missions/doors')
    const { writeMission } = await import('../src/main/missions/write')
    await attachFromPicker(repo, id, { sessionId: VERIFIER })
    await writeMission(repo, id, { kind: 'operator' }, 'operator', (rec, log) => ({
      record: {
        ...rec,
        attachRequests: [
          {
            id: 'atr-1',
            missionId: id,
            sessionId: WORKER,
            at: '2026-11-15T10:00:00Z',
            decision: null
          },
          {
            id: 'atr-2',
            missionId: id,
            sessionId: DRAINED,
            at: '2026-11-15T10:00:00Z',
            decision: null
          }
        ]
      },
      log
    }))
    await decideAttachRequest(repo, id, { requestId: 'atr-1', decision: 'allowed' })
    await decideAttachRequest(repo, id, { requestId: 'atr-2', decision: 'denied' })
    const log = await readLog(id)
    expect(log).toContain(`operator attached a session to "${record.title}" as a worker`)
    expect(log).toContain(`operator allowed a session to join "${record.title}" as a worker`)
    expect(log).toContain(`operator denied a session the request to join "${record.title}"`)
    for (const sid of [VERIFIER, WORKER, DRAINED]) expect(log).not.toContain(sid)
  })
})

describe('the dispatch module on its own', () => {
  it('dispatchStep to a worktree of its own creates the card with that substrate', async () => {
    const id = await newMission()
    const board = await realBoardIo(repo)
    const out = await dispatchStep(
      repo,
      { missionId: id, stepId: 'stp-2', sessionId: WORKER, role: 'worker', to: 'worktree' },
      board
    )
    expect(out.ok, JSON.stringify(out)).toBe(true)
    const [{ card }] = await cardsOfStep(id, 'stp-2')
    expect(card.substrate).toBe('worktree')
    expect(card.status).toBe('backlog')
  })

  it('a card that is already closed is refused, and no second card is made for the step', async () => {
    const id = await newMission()
    const slug = await newCard()
    await submitManifest([{ slug, missionId: id, stepId: 'stp-1' }])
    const { roadmapDir } = await resolveRoadmap(repo)
    const file = path.join(roadmapDir, `${slug}.md`)
    const content = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, content.replace(/^status: .*$/m, 'status: done'), 'utf8')

    const board = await realBoardIo(repo)
    const out = await dispatchStep(
      repo,
      { missionId: id, stepId: 'stp-1', sessionId: WORKER, role: 'worker', to: 'session' },
      board
    )
    expect(out).toMatchObject({ ok: false, code: 'CARD_CLOSED' })
    expect(await boardCards()).toHaveLength(1)
  })

  it('stampCardForStep refuses a card that does not exist', async () => {
    const id = await newMission()
    const out = await stampCardForStep(repo, {
      slug: 'no-such-card',
      missionId: id,
      stepId: 'stp-1'
    })
    expect(out).toMatchObject({ ok: false })
  })
})
