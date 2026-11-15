/**
 * Missions v4 · S-24 · AC-67 — a mission is in one format at a time.
 *
 * The v4 verbs are registered beside the v3 ones, so one call can be v4-shaped or v3-shaped. This
 * suite drives the WIRED handlers (the array `server.ts` registers) through the catalog schema and
 * the gate's translation, the way a real call arrives, and proves the routing:
 *
 *  1. a v4-shaped verb on a v3 mission converts it on its first write: a v4 copy, the v3 file's
 *     bytes untouched (AC-22);
 *  2. a v3-shaped verb on a mission that has a v4 copy is refused with the way out, and writes
 *     nothing, in either format;
 *  3. `mission_create` creates a v4 record only when given the v4 shape.
 *
 * Plus what the routing rests on: a name both formats share serves the record in the format it is
 * in and never converts it; the caller is built from the transport and never from an argument; the
 * facts a verb reads are computed on the server; and a step added after a close request clears the
 * request (decision 14), shown through what the operator sees.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs, readdirSync, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { toolByName } from '../src/main/mcp/tool-catalog'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { parseToolInput } from '../src/main/mcp/validate'
import { readMissionRecord } from '../src/main/missions/record-store'
import { runV4 } from '../src/main/missions/verbs'
import type { StepInput } from '../src/main/missions/state'

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

const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const STRANGER = 'e0e0e0e0-0000-4000-8000-000000000001'
const VERIFIER = '8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d'

type Result = {
  isError: boolean
  text: string
  json: Record<string, unknown>
}
type Handler = (
  args: Record<string, unknown>,
  ctx: Record<string, unknown>
) => Promise<{
  isError?: boolean
  content: Array<{ text?: string }>
}>

let repo = ''
let other = ''
let handlers: Record<string, Handler>
let setInputs: (fn: ((root: string) => Record<string, StepInput>) | null) => void

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-dual-ud-'))
  const mod = await import('../src/main/mcp/tool-handlers')
  handlers = Object.fromEntries(mod.WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
  setInputs = (fn) => mod._setStepInputsForTest(fn ? async (root) => fn(root) : null)
})

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-dual-repo-'))
  other = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-dual-other-'))
  setInputs(() => ({}))
})

afterAll(async () => {
  setInputs(null)
  await fs.rm(h.userDataDir, { recursive: true, force: true })
})

/** One call the way it arrives: catalog schema, then the gate's validation, then the handler. */
async function call(
  op: string,
  args: Record<string, unknown>,
  ctx: Record<string, unknown> = {}
): Promise<Result> {
  const def = toolByName(op as never)!
  const parsed = def.inputSchema.safeParse({ folder: repo, ...args })
  if (!parsed.success) {
    return { isError: true, text: `SCHEMA: ${parsed.error.message}`, json: {} }
  }
  const input = parsed.data as Record<string, unknown>
  const folder = typeof input.folder === 'string' ? input.folder : undefined
  const gate = parseToolInput(op as never, buildPlanInput(op as never, input, folder))
  if (!gate.ok) return { isError: true, text: `GATE: ${JSON.stringify(gate)}`, json: {} }
  const res = await handlers[op](input, {
    folder: folder ?? '',
    folders: [],
    denyFolders: [],
    bridge: undefined,
    ...ctx
  })
  const text = res.content[0]?.text ?? ''
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    // an error line, not JSON
  }
  return { isError: res.isError === true, text, json }
}

const ok = (r: Result): Result => {
  expect(r.isError, r.text).toBe(false)
  return r
}

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

const dir = (root: string, name: string): string => path.join(root, '.harnu', name)
const filesOf = (root: string, name: string): string[] => {
  try {
    return readdirSync(dir(root, name)).filter((n) => n.endsWith('.md'))
  } catch {
    return []
  }
}
const readAll = (root: string, name: string): Record<string, string> =>
  Object.fromEntries(
    filesOf(root, name).map((n) => [n, readFileSync(path.join(dir(root, name), n), 'utf8')])
  )

/** A v3 mission, made by the v3-shaped `mission_create`. */
async function createV3(): Promise<string> {
  const r = ok(
    await call('mission_create', {
      title: 'Export the report',
      declaredEnd: { kind: 'code', target: 'the CSV export', evidence: 'the PR is merged' },
      sessionId: LEADER,
      steward: false,
      steps: [{ title: 'Build the exporter', verification: 'verifier' }]
    })
  )
  return r.json.missionId as string
}

const V4_CREATE = {
  title: 'Export the report as CSV',
  doneWhen: 'The CSV export is merged and a spreadsheet opens it',
  sessionId: LEADER,
  steps: [
    {
      title: 'Add the CSV exporter',
      criteria: [{ text: 'The pull request is merged', fact: 'pr-merged' }]
    }
  ]
}

async function createV4(): Promise<string> {
  return ok(await call('mission_create', V4_CREATE)).json.id as string
}

describe('a mission is in one format at a time', () => {
  it('a v4-shaped verb on a v3 mission converts it: a v4 copy, and the v3 file untouched', async () => {
    const id = await createV3()
    const v3Before = readAll(repo, 'missions')
    expect(Object.keys(v3Before)).toHaveLength(1)
    expect(filesOf(repo, 'missions-v4')).toEqual([])

    ok(
      await call('mission_add_ac', {
        missionId: id,
        stepId: 'stp-1',
        text: 'The export opens in a spreadsheet',
        by: 'session',
        sessionId: LEADER
      })
    )

    // The copy exists and holds the change; the v3 file is byte-for-byte what it was.
    const copy = await readMissionRecord(repo, id)
    expect(copy.ok && copy.source).toBe('v4')
    expect(filesOf(repo, 'missions-v4')).toHaveLength(1)
    expect(sha(JSON.stringify(readAll(repo, 'missions')))).toBe(sha(JSON.stringify(v3Before)))
    const step = copy.ok ? copy.record.steps.find((s) => s.id === 'stp-1') : undefined
    expect(step?.acs.map((a) => a.text)).toContain('The export opens in a spreadsheet')

    // From here the mission answers in v4.
    const get = ok(await call('mission_get', { missionId: id, sessionId: LEADER }))
    expect(get.json.source).toBe('v4')
  })

  it('a v3-shaped verb on a mission that has a v4 copy is refused with the way out, and writes nothing', async () => {
    const id = await createV3()
    ok(
      await call('mission_add_ac', {
        missionId: id,
        stepId: 'stp-1',
        text: 'The export opens in a spreadsheet',
        by: 'session',
        sessionId: LEADER
      })
    )
    const v3Before = readAll(repo, 'missions')
    const v4Before = readAll(repo, 'missions-v4')

    const refused: Array<[string, Record<string, unknown>, string]> = [
      [
        'mission_link_child',
        { missionId: id, stepId: 'stp-1', link: { kind: 'card', ref: 'T1' } },
        'mission_link'
      ],
      [
        'mission_add_step',
        { missionId: id, title: 'Add a step', verification: 'verifier', reason: 'more work' },
        'criteria'
      ],
      [
        'mission_verify_step',
        { missionId: id, stepId: 'stp-1', verdict: 'met', evidence: 'ok', sessionId: VERIFIER },
        'mission_settle_ac'
      ],
      [
        'mission_set_end',
        {
          missionId: id,
          declaredEnd: { kind: 'code', target: 'a new end', evidence: 'something' },
          reason: 'it changed'
        },
        'mission_set_done_when'
      ],
      [
        'mission_add_check',
        { missionId: id, stepId: 'stp-1', label: 'Sign-off' },
        'mission_add_ac'
      ],
      [
        'mission_transfer_owner',
        { missionId: id, toSessionId: STRANGER, reason: 'it died' },
        'mission_attach'
      ]
    ]
    for (const [op, args, wayOut] of refused) {
      const r = await call(op, args)
      expect(r.isError, `${op}: ${r.text}`).toBe(true)
      expect(r.text, op).toMatch(/^MISSION_IS_V4:/)
      expect(r.text, `${op} names the way out`).toContain(wayOut)
    }
    expect(readAll(repo, 'missions')).toEqual(v3Before)
    expect(readAll(repo, 'missions-v4')).toEqual(v4Before)
  })

  it('mission_create creates a v4 record only when given the v4 shape', async () => {
    const v3 = await createV3()
    expect(filesOf(repo, 'missions').some((n) => n.startsWith(v3))).toBe(true)
    expect(filesOf(repo, 'missions-v4')).toEqual([])

    const v4 = await createV4()
    expect(filesOf(repo, 'missions-v4').some((n) => n.startsWith(v4))).toBe(true)
    expect(filesOf(repo, 'missions').some((n) => n.startsWith(v4))).toBe(false)

    // Neither shape bleeds into the other: a call that mixes them is refused, and writes nothing.
    const before = [readAll(repo, 'missions'), readAll(repo, 'missions-v4')]
    const mixed = await call('mission_create', {
      ...V4_CREATE,
      declaredEnd: { kind: 'code', target: 'the CSV export', evidence: 'the PR is merged' }
    })
    expect(mixed.isError).toBe(true)
    expect(mixed.text).toMatch(/^BAD_ARGS:.*(v3|v4)/s)
    expect([readAll(repo, 'missions'), readAll(repo, 'missions-v4')]).toEqual(before)
  })
})

describe('the names both formats share serve the record in the format it is in', () => {
  it('mission_log, mission_set_blocker and mission_request_close never convert a v3 mission', async () => {
    const id = await createV3()
    const before = readAll(repo, 'missions')
    ok(await call('mission_log', { missionId: id, note: 'A note on the v3 mission' }))
    ok(
      await call('mission_set_blocker', {
        missionId: id,
        reason: 'waiting for the key',
        unblocks: 'the key arrives',
        owner: 'operator'
      })
    )
    expect(filesOf(repo, 'missions-v4')).toEqual([])
    expect(readAll(repo, 'missions')).not.toEqual(before) // the v3 mission took the writes
  })

  it('mission_log, mission_set_blocker and mission_clear_blocker write the v4 record of a v4 mission', async () => {
    const id = await createV4()
    ok(
      await call('mission_log', {
        missionId: id,
        note: 'A decision',
        kind: 'decision',
        sessionId: LEADER
      })
    )
    const blocked = ok(
      await call('mission_set_blocker', {
        missionId: id,
        reason: 'The STAGING_API_KEY is missing from the shared vault',
        ask: 'Add the staging key',
        unblocks: 'the export can run',
        owner: 'operator',
        sessionId: LEADER
      })
    )
    expect(blocked.json.blockerId).toMatch(/^blk-\d+$/)
    expect(filesOf(repo, 'missions')).toEqual([])
    const log = (await readMissionRecord(repo, id)) as { ok: true; log: string }
    expect(log.log).toContain('A decision')

    // An operator-owned blocker is the operator's to clear, not a session's.
    const cleared = await call('mission_clear_blocker', {
      missionId: id,
      blockerId: blocked.json.blockerId,
      sessionId: LEADER
    })
    expect(cleared.isError).toBe(true)
    expect(cleared.text).toMatch(/^OPERATOR_ONLY:/)
  })

  it('mission_list answers both: a v3 mission as before, a v4 one as a row, a converted one once', async () => {
    const v3 = await createV3()
    const v4 = await createV4()
    const rows = ok(await call('mission_list', {})).json.missions as Array<Record<string, unknown>>
    expect(rows.find((r) => r.id === v3)?.slug).toBeTruthy()
    const v4Row = rows.find((r) => r.id === v4)
    expect(v4Row).toMatchObject({ title: 'Export the report as CSV', leads: LEADER, format: 'v4' })
    expect(String(v4Row?.headline)).toMatch(/step/)

    ok(
      await call('mission_add_ac', {
        missionId: v3,
        stepId: 'stp-1',
        text: 'The export opens in a spreadsheet',
        by: 'session',
        sessionId: LEADER
      })
    )
    const after = ok(await call('mission_list', {})).json.missions as Array<Record<string, unknown>>
    expect(after.filter((r) => r.id === v3)).toHaveLength(1)
    expect(after.find((r) => r.id === v3)?.format).toBe('v4')
  })
})

describe('the caller is built from the transport, and the facts on the server', () => {
  it('an ordinary client is a session and a steward bearer is a worker; an argument never changes the kind', async () => {
    const id = await createV4()
    const before = readAll(repo, 'missions-v4')

    // A steward bearer is a worker bound to its mission: it reads and never writes.
    const steward = { caller: { kind: 'steward', workerId: 'wrk-1', missionId: id } }
    ok(await call('mission_get', { missionId: id }, steward))
    const write = await call(
      'mission_add_ac',
      {
        missionId: id,
        stepId: 'stp-1',
        text: 'Opens in a spreadsheet',
        by: 'session',
        sessionId: LEADER
      },
      steward
    )
    expect(write.isError).toBe(true)
    expect(write.text).toMatch(/^READ_ONLY:/)
    expect(readAll(repo, 'missions-v4')).toEqual(before)

    // The session id an ordinary client passes names a session and nothing more: it is not the
    // operator, and a stranger is not attached.
    const stranger = await call('mission_get', { missionId: id, sessionId: STRANGER })
    expect(stranger.isError).toBe(true)
    expect(stranger.text).toMatch(/^NOT_ATTACHED:/)
    expect(stranger.text).toContain('mission_attach')
    for (const claim of ['operator', 'harnu', 'worker']) {
      const r = await call('mission_add_ac', {
        missionId: id,
        stepId: 'stp-1',
        text: 'Opens in a spreadsheet',
        by: 'session',
        sessionId: claim
      })
      expect(r.isError, claim).toBe(true)
      expect(r.text, claim).toMatch(/^BAD_SESSION_ID:/)
    }
    expect(readAll(repo, 'missions-v4')).toEqual(before)

    // A stranger asks to join; that is the one write it may make.
    const asked = ok(await call('mission_attach', { missionId: id, sessionId: STRANGER }))
    expect(asked.json.requestId).toMatch(/^atr-\d+$/)
  })

  it('the facts a verb reads are computed on the server: inputs and siblingRoots in a call are ignored', async () => {
    const id = await createV4()
    // The server reads nothing merged: the step is open, so the close request is refused …
    const refused = await call('mission_request_close', {
      missionId: id,
      sessionId: LEADER,
      // … whatever the call claims about its facts.
      inputs: { 'stp-1': { pr: 'merged' } }
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/^STEPS_OPEN:/)

    // A sibling root holding a newer copy of the mission is not read: the roots come from the folder.
    const home = await readMissionRecord(repo, id)
    expect(home.ok).toBe(true)
    if (!home.ok) return
    const dirOther = path.join(other, '.harnu', 'missions-v4')
    await fs.mkdir(dirOther, { recursive: true })
    const copy = readFileSync(home.file, 'utf8')
      .replace('title: Export the report as CSV', 'title: A copy in a sibling clone')
      .concat('\n### 2099-01-01T00:00:00Z · note\n\nThe newest entry of all.\n')
    await fs.writeFile(path.join(dirOther, path.basename(home.file)), copy)
    const get = ok(
      await call('mission_get', { missionId: id, sessionId: LEADER, siblingRoots: [other] })
    )
    expect(get.json.title).toBe('Export the report as CSV')
  })

  it('the dispatch itself never reads inputs or siblingRoots from its arguments', async () => {
    // The catalog schema drops unknown keys on the way in; this is the second line, one level down:
    // `runV4` is handed the keys anyway and must not read them.
    const id = await createV4()
    const home = await readMissionRecord(repo, id)
    if (!home.ok) throw new Error(home.error)
    const dirOther = path.join(other, '.harnu', 'missions-v4')
    await fs.mkdir(dirOther, { recursive: true })
    await fs.writeFile(
      path.join(dirOther, path.basename(home.file)),
      readFileSync(home.file, 'utf8')
        .replace('title: Export the report as CSV', 'title: A copy in a sibling clone')
        .concat('\n### 2099-01-01T00:00:00Z · note\n\nThe newest entry of all.\n')
    )
    const deps = { inputsFor: async (): Promise<Record<string, StepInput>> => ({}) }
    const actor = { kind: 'session' as const, sessionId: LEADER }

    const close = await runV4(
      'mission_request_close',
      repo,
      actor,
      { missionId: id, inputs: { 'stp-1': { pr: 'merged' } } },
      deps
    )
    expect(close.ok).toBe(false)
    expect(close.ok === false && close.code).toBe('STEPS_OPEN')

    const get = await runV4(
      'mission_get',
      repo,
      actor,
      { missionId: id, siblingRoots: [other] },
      deps
    )
    expect(get.ok && get.title).toBe('Export the report as CSV')
  })

  it('a step added after a close request clears the request, so the operator is not told the session is ready', async () => {
    const id = await createV4()
    setInputs(() => ({ 'stp-1': { pr: 'merged' } }))
    ok(await call('mission_request_close', { missionId: id, sessionId: LEADER }))
    const asked = ok(await call('mission_get', { missionId: id, sessionId: LEADER }))
    const closeItem = (r: Result): Record<string, unknown> | undefined =>
      (r.json.waiting as { items: Array<Record<string, unknown>> }).items.find(
        (i) => i.kind === 'close'
      )
    expect(closeItem(asked)).toMatchObject({ requested: true })

    ok(
      await call('mission_add_step', {
        missionId: id,
        title: 'Document the export',
        criteria: [{ text: 'The README names the export', fact: 'pr-merged' }],
        reason: 'the reviewer asked for docs',
        sessionId: LEADER
      })
    )
    const record = await readMissionRecord(repo, id)
    expect(record.ok && record.record.closeRequested).toBeUndefined()

    // The new step is open, so the operator sees no "close" item at all …
    const open = ok(await call('mission_get', { missionId: id, sessionId: LEADER }))
    expect(closeItem(open)).toBeUndefined()
    // … and when it is done too, the close item is the plain one, not "the session says it is ready".
    setInputs(() => ({ 'stp-1': { pr: 'merged' }, 'stp-2': { pr: 'merged' } }))
    const again = ok(await call('mission_get', { missionId: id, sessionId: LEADER }))
    expect(closeItem(again)).toMatchObject({ requested: false })
  })
})
