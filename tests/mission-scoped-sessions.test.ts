/**
 * Missions v4 · S-25 · AC-64, AC-65 — scoped verbs for the sessions Harnu spawns (BUG-253).
 *
 * Graded through the REAL MCP transport, the way the steward's lifecycle is (lesson
 * `docs/lessons/testing/006-…`): a v4 mission is made over HTTP with the main bearer, the sessions
 * Harnu spawned for it connect with their OWN scoped credential, and every claim is read back from
 * the mission's files on disk, not from an ACK. Only `electron` and the live sources are stubbed.
 *
 *  - AC-64 "spawned sessions hold scoped verbs": a worker reads its mission and links, logs and sets a
 *    blocker on its own step and nothing else; a verifier also settles a criterion of a session that
 *    did not build the step; the observer bound to a folder reads that folder's missions; none can
 *    lead, attach itself or touch another mission (or, for a worker, another step).
 *  - AC-65 "spawned identity is not self-declared": the session id comes from the credential, so a
 *    verifier that built the step is a builder whatever `sessionId` the call says, and a credential
 *    that was forged, tampered with or borrowed reaches nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const h = vi.hoisted(() => ({ userDataDir: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.userDataDir,
    commandLine: { getSwitchValue: (): string => '' }
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

import { registerMcpServer, closeMcpServer, writeScopedMcpConfig } from '../src/main/mcp/server'
import { createConfirmCore } from '../src/main/mcp/confirm-core'
import { _setStepInputsForTest, WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { MCP_TOOLS, toolByName } from '../src/main/mcp/tool-catalog'
import { OBSERVE_MCP_ALLOW } from '../src/main/scheduler-core'
import { browserRegistry } from '../src/main/browser/browser-service'
import {
  mintScopedBearer,
  dropPendingSpawn,
  scopeCallRefusal,
  SCOPED_VERBS,
  takePendingSpawn,
  verifyScopedBearer,
  type Scope
} from '../src/main/mcp/scope'
import { readMissionRecord } from '../src/main/missions/record-store'
import { writeMission } from '../src/main/missions/write'
import { appendWorked, attachDispatchedWorker } from '../src/main/missions/sessions'
import type { MissionV4 } from '../src/main/missions/model'
import { v3MissionObject, writeV3Mission } from './helpers/v3-mission-file'

const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const WORKER = '5b7d9f11-2a4c-4e6a-8b0d-1c3e5a7c9e21'
const VERIFIER = '8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d'
const STRANGER = 'e0e0e0e0-0000-4000-8000-000000000001'

let serverUrl = ''
let serverToken = ''
let repo = ''
let otherRepo = ''
let mainClient: Client
const open: Client[] = []

interface Reply {
  isError: boolean
  text: string
  body: Record<string, unknown>
}

async function connectAs(bearer: string): Promise<Client> {
  const c = new Client({ name: 'scoped-test', version: '0.0.0' })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(serverUrl), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } }
    })
  )
  open.push(c)
  return c
}

/** A call the way a model makes it: a refusal (or an unknown tool) is a reply, never a throw. */
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
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-scoped-repo-'))
  const root = path.join(base, 'main')
  await fs.mkdir(path.join(root, '.git'), { recursive: true })
  return root
}

const readRecord = async (root: string, id: string): Promise<MissionV4> => {
  const read = await readMissionRecord(root, id)
  if (!read.ok) throw new Error(read.error)
  return read.record
}

/** Two steps, one criterion each that a session settles. The leader (self-declared) leads it. */
async function newMission(root: string): Promise<string> {
  const r = await okOn(mainClient, 'mission_create', {
    folder: root,
    title: `Export the report ${Math.random().toString(36).slice(2, 8)}`,
    doneWhen: 'The CSV export is merged and a spreadsheet opens it',
    sessionId: LEADER,
    steps: [
      { title: 'Add the CSV exporter', criteria: [{ text: 'The exporter writes valid CSV' }] },
      { title: 'Document the exporter', criteria: [{ text: 'The README says how to run it' }] }
    ]
  })
  return r.body.id as string
}

/** Attach `sessionId` as a worker of the mission with NO session link on a step (a second session). */
async function attachWithoutLink(
  root: string,
  missionId: string,
  sessionId: string
): Promise<void> {
  const at = new Date().toISOString()
  const done = await writeMission(
    root,
    missionId,
    { kind: 'harnu' },
    'operator',
    (record, log) => ({
      record: { ...record, sessions: appendWorked(record.sessions, sessionId, at) },
      log
    })
  )
  if (!done.ok) throw new Error(done.error)
}

/** Attach `sessionId` as the worker of a step: attached AND linked, so it BUILT the step. */
async function attachAsBuilder(
  root: string,
  missionId: string,
  sessionId: string,
  stepId: string
): Promise<void> {
  const done = await attachDispatchedWorker(root, missionId, {
    sessionId,
    stepId,
    actor: { kind: 'harnu' }
  })
  if (!done.ok) throw new Error(done.error)
}

const scopeOf = (
  role: 'worker' | 'verifier',
  sessionId: string,
  missionId: string,
  stepId = 'stp-1',
  folder = repo
): Scope => ({ role, sessionId, folder, missionId, stepId })

const bearerFor = (scope: Scope): string => mintScopedBearer(serverToken, scope)

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-scoped-ud-'))
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
  otherRepo = await fakeRepo()
})

describe('spawned sessions hold scoped verbs', () => {
  it('a worker holds the four step verbs and mission_settle_ac, and no other verb', async () => {
    const id = await newMission(repo)
    await attachAsBuilder(repo, id, WORKER, 'stp-1')
    const worker = await connectAs(bearerFor(scopeOf('worker', WORKER, id)))

    const listed = (await worker.listTools()).tools.map((t) => t.name).sort()
    expect(listed).toEqual(
      [
        'mission_get',
        'mission_link',
        'mission_log',
        'mission_set_blocker',
        'mission_settle_ac'
      ].sort()
    )
    expect([...SCOPED_VERBS.worker].sort()).toEqual(listed)

    // Verbs outside the list are not callable even when named: it cannot lead, attach itself or plan.
    for (const [verb, args] of [
      ['mission_attach', { folder: repo, missionId: id }],
      ['mission_request_close', { folder: repo, missionId: id }],
      ['mission_add_step', { folder: repo, missionId: id, title: 'Sneak a step in' }],
      ['mission_list', { folder: repo }],
      ['create_session', { folder: repo }],
      ['get_fleet', {}]
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await callOn(worker, verb, args)
      expect(r.isError, verb).toBe(true)
    }
  })

  it('a worker reads its mission and links, logs and blocks on its own step', async () => {
    const id = await newMission(repo)
    await attachAsBuilder(repo, id, WORKER, 'stp-1')
    const worker = await connectAs(bearerFor(scopeOf('worker', WORKER, id)))

    const got = await okOn(worker, 'mission_get', { folder: repo, missionId: id })
    expect(got.body.id).toBe(id)
    expect(got.body.standing).toBe('worked')

    await okOn(worker, 'mission_link', {
      folder: repo,
      missionId: id,
      stepId: 'stp-1',
      link: { kind: 'pr', ref: '412' }
    })
    await okOn(worker, 'mission_log', {
      folder: repo,
      missionId: id,
      stepId: 'stp-1',
      kind: 'note',
      note: 'The exporter handles quoted commas.'
    })
    await okOn(worker, 'mission_set_blocker', {
      folder: repo,
      missionId: id,
      stepId: 'stp-1',
      reason: 'The `sample.csv` file is missing from the repo',
      owner: 'operator',
      ask: 'Add the sample CSV to the repo',
      unblocks: 'The exporter test can run'
    })

    const record = await readRecord(repo, id)
    const step = record.steps.find((s) => s.id === 'stp-1')!
    expect(step.links.some((l) => l.kind === 'pr' && l.ref === '412')).toBe(true)
    expect(JSON.stringify(step.blockers)).toContain(
      'The `sample.csv` file is missing from the repo'
    )
    const log = await fs.readFile(
      path.join(
        repo,
        '.harnu',
        'missions-v4',
        (await fs.readdir(path.join(repo, '.harnu', 'missions-v4')))[0]
      ),
      'utf8'
    )
    expect(log).toContain('The exporter handles quoted commas.')
  })

  it('a worker writes only its own step: another step is refused and nothing changes', async () => {
    const id = await newMission(repo)
    await attachAsBuilder(repo, id, WORKER, 'stp-1')
    const worker = await connectAs(bearerFor(scopeOf('worker', WORKER, id)))
    const before = JSON.stringify(await readRecord(repo, id))

    for (const [verb, args] of [
      ['mission_link', { stepId: 'stp-2', link: { kind: 'pr', ref: '413' } }],
      [
        'mission_log',
        { stepId: 'stp-2', kind: 'note', note: 'Writing on a step that is not mine' }
      ],
      [
        'mission_set_blocker',
        { stepId: 'stp-2', reason: 'Not my step', owner: 'agent', unblocks: 'nothing' }
      ],
      ['mission_settle_ac', { stepId: 'stp-2', criterionId: 'ac-1', evidence: 'I read it' }]
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await callOn(worker, verb, { folder: repo, missionId: id, ...args })
      expect(r.isError, verb).toBe(true)
      expect(r.text, verb).toMatch(/SCOPE_STEP/)
      expect(r.text, verb).toMatch(/stp-1/) // says which step it may write
    }
    expect(JSON.stringify(await readRecord(repo, id))).toBe(before)

    // Left out, the step is its own: a link without a stepId lands on stp-1, never on the mission.
    await okOn(worker, 'mission_link', {
      folder: repo,
      missionId: id,
      link: { kind: 'pr', ref: '414' }
    })
    const record = await readRecord(repo, id)
    expect(record.steps.find((s) => s.id === 'stp-1')!.links.some((l) => l.ref === '414')).toBe(
      true
    )
    expect(
      (record as { links?: Array<{ ref: string }> }).links?.some((l) => l.ref === '414') ?? false
    ).toBe(false)
  })

  it('a worker touches no other mission, even one it is attached to', async () => {
    const id = await newMission(repo)
    const second = await newMission(repo)
    await attachAsBuilder(repo, id, WORKER, 'stp-1')
    await attachAsBuilder(repo, second, WORKER, 'stp-1') // the guard alone would let it write there
    const worker = await connectAs(bearerFor(scopeOf('worker', WORKER, id)))
    const before = JSON.stringify(await readRecord(repo, second))

    for (const verb of ['mission_get', 'mission_link', 'mission_log', 'mission_set_blocker']) {
      const args: Record<string, unknown> =
        verb === 'mission_get'
          ? {}
          : verb === 'mission_link'
            ? { stepId: 'stp-1', link: { kind: 'pr', ref: '500' } }
            : verb === 'mission_log'
              ? { stepId: 'stp-1', kind: 'note', note: 'Not this mission' }
              : { stepId: 'stp-1', reason: 'Not this mission', owner: 'agent', unblocks: 'x' }
      const r = await callOn(worker, verb, { folder: repo, missionId: second, ...args })
      expect(r.isError, verb).toBe(true)
      expect(r.text, verb).toMatch(/SCOPE_MISSION/)
      expect(r.text, verb).toContain(id) // says which mission it may touch
    }
    expect(JSON.stringify(await readRecord(repo, second))).toBe(before)
  })

  it('a worker is bound to the folder it was spawned in', async () => {
    const id = await newMission(repo)
    await attachAsBuilder(repo, id, WORKER, 'stp-1')
    const worker = await connectAs(bearerFor(scopeOf('worker', WORKER, id)))
    const r = await callOn(worker, 'mission_get', { folder: otherRepo, missionId: id })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/SCOPE_FOLDER/)
  })

  // Both ways a worker can stand on its step: linked by the dispatch, or attached with the link missing
  // (a bind that half failed). It built the step either way, so its credential only ever claims.
  it.each([
    ['linked to its step', true],
    ['attached with no step link', false]
  ])(
    'a worker %s claims its operator and session criteria and never settles',
    async (_n, linked) => {
      const id = await newMission(repo)
      await okOn(mainClient, 'mission_add_ac', {
        folder: repo,
        missionId: id,
        stepId: 'stp-1',
        text: 'The export button reads well',
        by: 'operator',
        sessionId: LEADER
      })
      if (linked) await attachAsBuilder(repo, id, WORKER, 'stp-1')
      else await attachWithoutLink(repo, id, WORKER)
      const worker = await connectAs(bearerFor(scopeOf('worker', WORKER, id)))

      const criteria = (await readRecord(repo, id)).steps[0].acs
      expect(criteria.map((c) => c.by)).toEqual(['session', 'operator'])
      for (const c of criteria) {
        const r = await okOn(worker, 'mission_settle_ac', {
          folder: repo,
          missionId: id,
          stepId: 'stp-1',
          criterionId: c.id,
          evidence: 'Ran the exporter on the sample file'
        })
        expect(r.body.outcome, c.by).toBe('claimed')
      }
      for (const c of (await readRecord(repo, id)).steps[0].acs) {
        expect(c.settled, c.by).toBeUndefined()
        expect(c.selfCheck?.by, c.by).toBe(WORKER)
      }

      const other = await callOn(worker, 'mission_settle_ac', {
        folder: repo,
        missionId: id,
        stepId: 'stp-2',
        criterionId: 'ac-1',
        evidence: 'I read the README'
      })
      expect(other.isError).toBe(true)
      expect(other.text).toMatch(/SCOPE_STEP/)
      expect((await readRecord(repo, id)).steps[1].acs[0].selfCheck).toBeUndefined()
    }
  )

  it('a verifier also settles a criterion of a step it did not build', async () => {
    const id = await newMission(repo)
    await attachAsBuilder(repo, id, WORKER, 'stp-1')
    await attachWithoutLink(repo, id, VERIFIER) // attached, but no session link: a second session
    const verifier = await connectAs(bearerFor(scopeOf('verifier', VERIFIER, id)))

    const listed = (await verifier.listTools()).tools.map((t) => t.name).sort()
    expect(listed).toEqual(
      [
        'mission_get',
        'mission_link',
        'mission_log',
        'mission_set_blocker',
        'mission_settle_ac'
      ].sort()
    )

    const ac = (await readRecord(repo, id)).steps[0].acs[0].id
    // Its own step only: the other step's criterion is out of scope.
    const out = await callOn(verifier, 'mission_settle_ac', {
      folder: repo,
      missionId: id,
      stepId: 'stp-2',
      criterionId: (await readRecord(repo, id)).steps[1].acs[0].id,
      evidence: 'I read the README'
    })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/SCOPE_STEP/)

    const settled = await okOn(verifier, 'mission_settle_ac', {
      folder: repo,
      missionId: id,
      stepId: 'stp-1',
      criterionId: ac,
      evidence: 'Ran the exporter on the sample file; the output parses as CSV'
    })
    expect(settled.body.outcome).toBe('settled')
    const stamp = (await readRecord(repo, id)).steps[0].acs[0].settled
    expect(stamp?.by).toBe(VERIFIER)
  })

  it("the observer bound to a folder reads that folder's missions and nothing else", async () => {
    const id = await newMission(repo)
    const foreign = await newMission(otherRepo)
    const observer = await connectAs(bearerFor({ role: 'observer', folder: repo }))

    // Owner's delta 1: the observer holds the observe allowlist's verbs (see the describe below), which
    // include these two; what this test is about is that they read the folder's missions.
    const listed = (await observer.listTools()).tools.map((t) => t.name)
    expect(listed).toEqual(expect.arrayContaining(['mission_get', 'mission_list']))

    const rows = await okOn(observer, 'mission_list', { folder: repo })
    expect((rows.body.missions as Array<{ id: string }>).map((m) => m.id)).toEqual([id])

    // It is attached to nothing and still reads the detail: a Harnu worker bound to the folder.
    const got = await okOn(observer, 'mission_get', { folder: repo, missionId: id })
    expect(got.body.id).toBe(id)
    expect(got.body.standing).toBe('worker')

    // Another folder's missions are out of reach, by folder and by id.
    for (const [verb, args] of [
      ['mission_list', { folder: otherRepo }],
      ['mission_get', { folder: otherRepo, missionId: foreign }],
      ['mission_get', { folder: repo, missionId: foreign }]
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await callOn(observer, verb, args)
      expect(r.isError, `${verb} ${JSON.stringify(args)}`).toBe(true)
    }
    // And it writes, attaches or leads nothing.
    for (const verb of ['mission_log', 'mission_attach', 'mission_link', 'mission_create']) {
      const r = await callOn(observer, verb, { folder: repo, missionId: id })
      expect(r.isError, verb).toBe(true)
    }
  })

  it('the refusal of a verb outside the role says what to do next', () => {
    const scope = scopeOf('worker', WORKER, 'mnt-aaaaaaaa')
    const refused = scopeCallRefusal({
      op: 'mission_attach',
      args: { folder: repo },
      scope,
      lookups: {}
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error).toMatch(/^SCOPE_VERB_NOT_ALLOWED/)
      expect(refused.error).toMatch(/mission_log|mission_set_blocker/) // names what it may do
    }
  })
})

describe('spawned identity is not self-declared', () => {
  it('a verifier that built the step is a builder whatever session id the call declares', async () => {
    const id = await newMission(repo)
    await attachAsBuilder(repo, id, VERIFIER, 'stp-1') // attached and linked: it built the step
    await attachWithoutLink(repo, id, STRANGER) // a real second session, attached
    const verifier = await connectAs(bearerFor(scopeOf('verifier', VERIFIER, id)))
    const ac = (await readRecord(repo, id)).steps[0].acs[0].id

    // The call says it is the stranger (who did not build it). The credential wins: a claim.
    const r = await okOn(verifier, 'mission_settle_ac', {
      folder: repo,
      missionId: id,
      stepId: 'stp-1',
      criterionId: ac,
      evidence: 'I looked at my own work',
      sessionId: STRANGER
    })
    expect(r.body.outcome).toBe('claimed')
    const criterion = (await readRecord(repo, id)).steps[0].acs[0]
    expect(criterion.settled).toBeUndefined()
    expect(criterion.selfCheck?.by).toBe(VERIFIER)
  })

  it('the standing a spawned session reads is its own, not the one it declares', async () => {
    const id = await newMission(repo)
    await attachAsBuilder(repo, id, WORKER, 'stp-1')
    const worker = await connectAs(bearerFor(scopeOf('worker', WORKER, id)))

    // It declares the LEADER's id and reads as a worker, not as the leader.
    const as = await okOn(worker, 'mission_get', { folder: repo, missionId: id, sessionId: LEADER })
    expect(as.body.standing).toBe('worked')
    // A session id that is not a session UUID is not a way to be the operator either.
    const ops = await callOn(worker, 'mission_get', {
      folder: repo,
      missionId: id,
      sessionId: 'operator'
    })
    if (!ops.isError) expect(ops.body.standing).toBe('worked')
  })

  it('an ordinary session still declares its own id (an operator-started session has no credential)', async () => {
    const id = await newMission(repo)
    const r = await okOn(mainClient, 'mission_get', {
      folder: repo,
      missionId: id,
      sessionId: LEADER
    })
    expect(r.body.standing).toBe('leads')
    const stranger = await callOn(mainClient, 'mission_get', {
      folder: repo,
      missionId: id,
      sessionId: STRANGER
    })
    expect(stranger.isError).toBe(true)
    expect(stranger.text).toMatch(/NOT_ATTACHED/)
  })

  it('a credential round-trips and every part of it is checked', () => {
    const scope = scopeOf('verifier', VERIFIER, 'mnt-aaaaaaaa', 'stp-3')
    const bearer = mintScopedBearer('server-secret', scope)
    expect(verifyScopedBearer('server-secret', bearer)).toEqual(scope)
    expect(verifyScopedBearer('another-secret', bearer)).toBeNull()
    expect(verifyScopedBearer('server-secret', serverToken)).toBeNull()
    expect(verifyScopedBearer('server-secret', '')).toBeNull()

    // Tamper with the payload (a different session id) and keep the old mac.
    const [head, mac] = bearer.split('.')
    const payload = JSON.parse(Buffer.from(head.slice('scp_'.length), 'base64url').toString('utf8'))
    payload.sessionId = STRANGER
    const forged = `scp_${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`
    expect(verifyScopedBearer('server-secret', forged)).toBeNull()
  })

  it('a forged, tampered or borrowed credential reaches nothing', async () => {
    const id = await newMission(repo)
    await attachAsBuilder(repo, id, WORKER, 'stp-1')
    const good = bearerFor(scopeOf('worker', WORKER, id))

    // Minted with a secret that is not the server's: refused at the door.
    const forged = mintScopedBearer('not-the-server-secret', scopeOf('worker', WORKER, id))
    await expect(connectAs(forged)).rejects.toBeTruthy()
    // Payload swapped to another session, mac kept: refused.
    const [head, mac] = good.split('.')
    const payload = JSON.parse(Buffer.from(head.slice(4), 'base64url').toString('utf8'))
    payload.sessionId = LEADER
    await expect(
      connectAs(`scp_${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`)
    ).rejects.toBeTruthy()

    // Borrowed: another caller's MCP session id with a different bearer inherits nothing.
    const worker = await connectAs(good)
    const transport = (worker as unknown as { transport?: { sessionId?: string } }).transport
    const sessionId = transport?.sessionId
    expect(sessionId).toBeTruthy()
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${serverToken}`,
        'mcp-session-id': sessionId as string
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    })
    expect(res.status).toBe(403)
  })
})

describe('a create_session for a step asks for the credential of its role', () => {
  const create = WIRED_TOOLS.find((t) => t.op === 'create_session')!.handler as unknown as (
    args: Record<string, unknown>,
    ctx: Record<string, unknown>
  ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>

  let dispatched = 0
  const bridgeFor = (over: Record<string, unknown> = {}): unknown => ({
    dispatch: async () => {
      dispatched++
      return { syntheticId: `synthetic-${dispatched}` }
    },
    awaitMaterialization: async (syntheticId: string) => ({
      syntheticId,
      sessionId: WORKER,
      folder: repo
    }),
    ...over
  })
  const start = async (
    args: Record<string, unknown>,
    bridge: unknown = bridgeFor()
  ): Promise<{ isError: boolean; text: string }> => {
    const r = await create(
      { folder: repo, ...args },
      { folder: repo, folders: [], denyFolders: [], bridge }
    )
    return { isError: r.isError === true, text: r.content[0]?.text ?? '' }
  }

  beforeEach(() => {
    dispatched = 0
    dropPendingSpawn(repo)
  })

  it('a worker is the default for a step: the spawn is noted for the folder, once', async () => {
    const id = await newMission(repo)
    const r = await start({ missionId: id, stepId: 'stp-1' })
    expect(r.isError, r.text).toBe(false)
    expect(takePendingSpawn(repo)).toEqual({ role: 'worker', missionId: id, stepId: 'stp-1' })
    expect(takePendingSpawn(repo)).toBeUndefined()
  })

  it("a verifier is asked for with role: 'verifier'", async () => {
    const id = await newMission(repo)
    await start({ missionId: id, stepId: 'stp-2', role: 'verifier' })
    expect(takePendingSpawn(repo)).toEqual({ role: 'verifier', missionId: id, stepId: 'stp-2' })
  })

  it('a mission or a step that does not exist is refused before anything is started', async () => {
    const id = await newMission(repo)
    const noMission = await start({ missionId: 'mnt-00000000', stepId: 'stp-1' })
    expect(noMission.isError).toBe(true)
    expect(noMission.text).toMatch(/MISSION_NOT_FOUND/)
    const noStep = await start({ missionId: id, stepId: 'stp-9' })
    expect(noStep.isError).toBe(true)
    expect(noStep.text).toMatch(/STEP_NOT_FOUND/)
    expect(noStep.text).toMatch(/stp-1/) // names the steps it has
    expect(dispatched).toBe(0)
    expect(takePendingSpawn(repo)).toBeUndefined()
  })

  it('a v3 mission is refused: a worker on it would convert it', async () => {
    // No verb makes a v3 mission any more (S-40): an old repo holds one as a file, which the store reads.
    const v3 = writeV3Mission(
      repo,
      v3MissionObject(repo, {
        id: 'mnt-0a1b2c3d',
        slug: 'older-mission',
        owner: { sessionId: LEADER, folder: repo }
      })
    )
    const before = await fs.readFile(v3)
    const r = await start({ missionId: 'mnt-0a1b2c3d', stepId: 'stp-1' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/MISSION_NOT_V4/)
    expect(dispatched).toBe(0)
    // Refused before anything changed: the file is untouched and no v4 record was made from it.
    expect((await fs.readFile(v3)).equals(before)).toBe(true)
    await expect(fs.stat(path.join(repo, '.harnu', 'missions-v4'))).rejects.toThrow()
  })

  it('a spawn that fails leaves no credential waiting', async () => {
    const id = await newMission(repo)
    const bridge = bridgeFor({ dispatch: async () => ({ error: 'RENDERER_GONE' }) })
    await start({ missionId: id, stepId: 'stp-1' }, bridge)
    expect(takePendingSpawn(repo)).toBeUndefined()
  })

  it('without a mission and step it is the plain session it always was (role alone is a label)', async () => {
    await start({ role: 'verifier' })
    expect(takePendingSpawn(repo)).toBeUndefined()
  })

  it('the catalog takes a mission with its step, and a worker needs both', () => {
    const schema = toolByName('create_session' as never)!.inputSchema
    expect(
      schema.safeParse({ folder: repo, missionId: 'mnt-aaaaaaaa', stepId: 'stp-1' }).success
    ).toBe(true)
    expect(schema.safeParse({ folder: repo, role: 'verifier' }).success).toBe(true)
    expect(schema.safeParse({ folder: repo, missionId: 'mnt-aaaaaaaa' }).success).toBe(false)
    expect(schema.safeParse({ folder: repo, stepId: 'stp-1' }).success).toBe(false)
    expect(schema.safeParse({ folder: repo, role: 'worker' }).success).toBe(false)
  })
})

describe('the leader that did a step itself checks it, it does not settle it (carried finding)', () => {
  it('a leader settling a step nobody else is linked to is a builder: its check reads as a claim', async () => {
    const id = await newMission(repo)
    const ac = (await readRecord(repo, id)).steps[1].acs[0].id // stp-2: no session link on it
    const r = await okOn(mainClient, 'mission_settle_ac', {
      folder: repo,
      missionId: id,
      stepId: 'stp-2',
      criterionId: ac,
      evidence: 'I wrote the README myself and read it again',
      sessionId: LEADER
    })
    expect(r.body.outcome).toBe('claimed')
    const criterion = (await readRecord(repo, id)).steps[1].acs[0]
    expect(criterion.settled).toBeUndefined()
    expect(criterion.selfCheck?.by).toBe(LEADER)
  })

  it('a leader settling a step a worker built is a second session, as before', async () => {
    const id = await newMission(repo)
    await attachAsBuilder(repo, id, WORKER, 'stp-1')
    const ac = (await readRecord(repo, id)).steps[0].acs[0].id
    const r = await okOn(mainClient, 'mission_settle_ac', {
      folder: repo,
      missionId: id,
      stepId: 'stp-1',
      criterionId: ac,
      evidence: 'Ran the exporter on the sample file',
      sessionId: LEADER
    })
    expect(r.body.outcome).toBe('settled')
    expect((await readRecord(repo, id)).steps[0].acs[0].settled?.by).toBe(LEADER)
  })
})

describe('the config a spawned session reads holds its credential and not ours', () => {
  it('is a 0600 file with a bearer that proves exactly that scope, never the server secret', async () => {
    const id = await newMission(repo)
    const scope = scopeOf('worker', WORKER, id)
    const file = await writeScopedMcpConfig(scope)
    expect(file).toBeTruthy()
    expect((await fs.stat(file as string)).mode & 0o777).toBe(0o600)
    expect(path.dirname(file as string)).toBe(path.join(h.userDataDir, 'scoped-mcp'))

    const doc = JSON.parse(await fs.readFile(file as string, 'utf8')) as {
      mcpServers: { harnu: { url: string; headers: { Authorization: string } } }
    }
    const bearer = doc.mcpServers.harnu.headers.Authorization.replace(/^Bearer /, '')
    expect(bearer).not.toBe(serverToken)
    expect(verifyScopedBearer(serverToken, bearer)).toEqual(scope)
    expect(doc.mcpServers.harnu.url).toBe(serverUrl)

    // The same file's bearer really opens a session that holds the role's verbs.
    await attachAsBuilder(repo, id, WORKER, 'stp-1')
    const worker = await connectAs(bearer)
    const got = await okOn(worker, 'mission_get', { folder: repo, missionId: id })
    expect(got.body.id).toBe(id)
  })
})

describe("the observe worker's tick holds the observe allowlist's read verbs, bound to its folder (delta 1)", () => {
  // The one source: what an observe tick may call today. Built from the allowlist the tick uses, so a
  // verb added to it is expected here without touching this test.
  const allowed = OBSERVE_MCP_ALLOW.filter((n) => n.startsWith('mcp__harnu__')).map((n) =>
    n.slice('mcp__harnu__'.length)
  )
  const writes = MCP_TOOLS.map((t) => t.name).filter((n) => !allowed.includes(n))

  it('is offered the observe allowlist and nothing else, from the same list the tick uses', async () => {
    const observer = await connectAs(bearerFor({ role: 'observer', folder: repo }))
    const listed = (await observer.listTools()).tools.map((t) => t.name).sort()
    expect(listed).toEqual([...allowed].sort())
    expect([...SCOPED_VERBS.observer].sort()).toEqual([...allowed].sort())
    // The allowlist's own members are still there: nothing an existing observe worker used is lost.
    for (const verb of [
      'get_fleet',
      'get_session',
      'list_worktrees',
      'memory_read',
      'github_budget'
    ]) {
      expect(listed, verb).toContain(verb)
    }
  })

  it('is refused every verb outside the allowlist, the mission and campaign writers included', async () => {
    const observer = await connectAs(bearerFor({ role: 'observer', folder: repo }))
    const id = await newMission(repo)
    expect(writes).toEqual(
      expect.arrayContaining(['mission_link', 'mission_log', 'create_session'])
    )
    const before = JSON.stringify(await readRecord(repo, id))
    const ac = (await readRecord(repo, id)).steps[0].acs[0].id
    // VALID arguments for each mission writer: a verb that were offered would run (or be refused by the
    // guard for another reason), so only "this tool is not there" passes, never an argument error.
    const valid: Record<string, Record<string, unknown>> = {
      mission_log: {
        missionId: id,
        stepId: 'stp-1',
        kind: 'note',
        note: 'A note from an observer'
      },
      mission_link: { missionId: id, stepId: 'stp-1', link: { kind: 'pr', ref: '9' } },
      mission_set_blocker: {
        missionId: id,
        stepId: 'stp-1',
        reason: 'The `sample.csv` file is missing from the repo',
        owner: 'agent',
        unblocks: 'the exporter test'
      },
      mission_clear_blocker: { missionId: id, blockerId: 'blk-1' },
      mission_settle_ac: {
        missionId: id,
        stepId: 'stp-1',
        criterionId: ac,
        evidence: 'I read it as an observer'
      },
      mission_attach: { missionId: id },
      mission_request_close: { missionId: id },
      mission_add_step: {
        missionId: id,
        title: 'A step an observer adds',
        criteria: [{ text: 'It is added' }],
        reason: 'Because'
      },
      mission_add_milestone: { missionId: id, title: 'A milestone' },
      mission_add_ac: { missionId: id, stepId: 'stp-1', text: 'Another criterion' },
      mission_set_done_when: { missionId: id, doneWhen: 'Something else', reason: 'Because' }
    }
    for (const verb of writes) {
      const r = await callOn(observer, verb, {
        folder: repo,
        ...(valid[verb] ?? { missionId: id })
      })
      expect(r.isError, verb).toBe(true)
      expect(r.text, `${verb}: ${r.text}`).toMatch(/not found/i)
    }
    expect(Object.keys(valid).every((v) => writes.includes(v))).toBe(true)
    expect(JSON.stringify(await readRecord(repo, id))).toBe(before)
  })

  it('calls the read verbs it could call before', async () => {
    const observer = await connectAs(bearerFor({ role: 'observer', folder: repo }))
    for (const [verb, args] of [
      ['get_fleet', {}],
      ['list_worktrees', { folder: repo }],
      ['github_budget', {}],
      ['list_terminals', {}],
      ['mission_list', { folder: repo }]
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await callOn(observer, verb, args)
      expect(r.isError, `${verb}: ${r.text}`).toBe(false)
    }
  })

  it("reads another folder's missions nowhere, a folder it leaves out being its own", async () => {
    const mine = await newMission(repo)
    const foreign = await newMission(otherRepo)
    const observer = await connectAs(bearerFor({ role: 'observer', folder: repo }))

    // A folder argument that is not its own is refused, for a mission verb and for any other.
    for (const [verb, args] of [
      ['mission_list', { folder: otherRepo }],
      ['mission_get', { folder: otherRepo, missionId: foreign }],
      ['list_worktrees', { folder: otherRepo }],
      ['memory_read', { folder: otherRepo }]
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await callOn(observer, verb, args)
      expect(r.isError, verb).toBe(true)
      expect(r.text, verb).toMatch(/SCOPE_FOLDER/)
    }
    // Left out, the folder is its own: the list is this repo's, never every repo's.
    const rows = await okOn(observer, 'mission_list', {})
    const ids = JSON.stringify(rows.body)
    expect(ids).toContain(mine)
    expect(ids).not.toContain(foreign)
    // And a foreign mission id is not found in its own folder.
    const got = await callOn(observer, 'mission_get', { missionId: foreign })
    expect(got.isError).toBe(true)
  })
})

describe('the observer reaches the panes and terminals of its own folder only (delta 2)', () => {
  const paneRecord = (paneId: string, folder: string): never =>
    ({
      paneId,
      folder,
      name: paneId,
      openedBy: 'agent',
      partition: 'agent',
      ownerSessionId: null,
      createdAt: 1,
      lastActiveAt: 1,
      seenHosts: new Set<string>(),
      flagged: null
    }) as never
  const paneVerbs = OBSERVE_MCP_ALLOW.filter((n) => n.startsWith('mcp__harnu__'))
    .map((n) => n.slice('mcp__harnu__'.length))
    .filter((v) => {
      let schema = toolByName(v as never)!.inputSchema as unknown as {
        _def?: { schema?: unknown }
        shape?: Record<string, unknown>
      }
      while (schema._def?.schema) schema = schema._def.schema as typeof schema
      return 'paneId' in (schema.shape ?? {})
    })
  const argsFor = (verb: string, paneId: string): Record<string, unknown> => ({
    paneId,
    ...(verb === 'browser_set_data' ? { data: { a: 1 } } : {}),
    ...(verb === 'browser_patch' ? { selector: 'body', mode: 'append', html: '<i></i>' } : {}),
    ...(verb === 'browser_wait_for' ? { text: 'x', timeoutMs: 100 } : {})
  })

  beforeEach(() => {
    browserRegistry.add(paneRecord('pane-other', otherRepo))
    browserRegistry.add(paneRecord('pane-own', repo))
  })
  afterAll(() => {
    browserRegistry.remove('pane-other')
    browserRegistry.remove('pane-own')
  })

  it('knows which verbs address a pane: every pane verb of the observe allowlist, readers too', () => {
    expect(paneVerbs).toEqual(
      expect.arrayContaining([
        'browser_snapshot',
        'browser_screenshot',
        'browser_console',
        'browser_wait_for',
        'browser_set_data',
        'browser_patch'
      ])
    )
  })

  it('every pane verb on a pane of another folder is SCOPE_FOLDER, and a pane of its own folder is not', async () => {
    const observer = await connectAs(bearerFor({ role: 'observer', folder: repo }))
    for (const verb of paneVerbs) {
      const other = await callOn(observer, verb, argsFor(verb, 'pane-other'))
      expect(other.isError, verb).toBe(true)
      expect(other.text, verb).toMatch(/SCOPE_FOLDER/)
      const own = await callOn(observer, verb, argsFor(verb, 'pane-own'))
      expect(own.text, `${verb}: ${own.text}`).not.toMatch(/SCOPE_FOLDER/)
    }
  })

  it('an unknown pane stays PANE_NOT_FOUND, not a folder refusal', async () => {
    const observer = await connectAs(bearerFor({ role: 'observer', folder: repo }))
    const r = await callOn(observer, 'browser_snapshot', { paneId: 'pane-nowhere' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/PANE_NOT_FOUND/)
    expect(r.text).not.toMatch(/SCOPE_FOLDER/)
  })

  it('browser_list with no folder lists its own folder only, and another folder is refused', async () => {
    const observer = await connectAs(bearerFor({ role: 'observer', folder: repo }))
    const listed = await okOn(observer, 'browser_list', {})
    expect(listed.text).toContain('pane-own')
    expect(listed.text).not.toContain('pane-other')
    const other = await callOn(observer, 'browser_list', { folder: otherRepo })
    expect(other.isError).toBe(true)
    expect(other.text).toMatch(/SCOPE_FOLDER/)
  })

  const lookups = {
    paneFolder: (id: string): string | undefined =>
      ({ 'pane-a': '/work/a', 'pane-b': '/work/b' })[id],
    terminalFolder: (id: string): string | undefined =>
      ({ 'term-a': '/work/a', 'term-b': '/work/b' })[id]
  }
  const scope: Scope = { role: 'observer', folder: '/work/a' }

  it('a terminal of another folder is SCOPE_FOLDER too', () => {
    const own = scopeCallRefusal({
      op: 'read_terminal',
      args: { terminalId: 'term-a' },
      scope,
      lookups
    })
    expect(own.ok).toBe(true)
    const other = scopeCallRefusal({
      op: 'read_terminal',
      args: { terminalId: 'term-b' },
      scope,
      lookups
    })
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.error).toMatch(/^SCOPE_FOLDER/)
    const unknown = scopeCallRefusal({
      op: 'read_terminal',
      args: { terminalId: 'term-z' },
      scope,
      lookups
    })
    expect(unknown.ok).toBe(true) // the verb answers TERMINAL_NOT_FOUND itself
  })

  it("the list verbs that take an optional folder default it to the credential's, and refuse another", () => {
    for (const op of [
      'browser_list',
      'list_terminals',
      'list_worktrees',
      'list_containers',
      'list_cleanup'
    ]) {
      const left = scopeCallRefusal({ op, args: {}, scope, lookups })
      expect(left.ok && left.args.folder, op).toBe('/work/a')
      const other = scopeCallRefusal({ op, args: { folder: '/work/b' }, scope, lookups })
      expect(other.ok, op).toBe(false)
    }
  })
})
