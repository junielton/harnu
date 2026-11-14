/**
 * Missions v4 · S-16b · AC-40 — the hand-off is always the operator's.
 *
 * Nothing but the hand-off door starts a session or changes who leads. The door starts a normal session
 * with the mission summary as its first prompt, waits for its REAL id, and only then writes once: the old
 * leader becomes `worked` (with `to` and `stoppedAt`), the new session is appended as `leads`, one Log
 * entry. A start that fails or times out changes nothing. High context only produces an offer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  HANDOFF_INSTRUCTION,
  HANDOFF_OFFER_AT,
  HANDOFF_QUIET_POINTS,
  bridgeStarter,
  handOff,
  handoffOffer,
  handoffPrompt,
  runHandOff,
  type HandoffDeps,
  type HandoffStart
} from '../src/main/missions/handoff'
import { leaderOf } from '../src/main/missions/guard'
import { buildMissionRecordContent, type MissionV4 } from '../src/main/missions/model'
import { readMissionRecord } from '../src/main/missions/record-store'
import { buildMissionSummary } from '../src/main/missions/summary'
import { waitingListV4 } from '../src/main/missions/waiting'
import { writeMission } from '../src/main/missions/write'

const FIXTURES = path.join(__dirname, 'fixtures', 'missions-v4-compat')
const MISSIONS_SRC = path.join(__dirname, '..', 'src', 'main', 'missions')

const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const WORKER = 'b6b6b6b6-0000-4000-8000-0000000000b6'
const NEW_ONE = '9d2e7a10-5c3b-4f68-8a14-2b9e6c0d7f31'
const OTHER_NEW = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const ID = 'mnt-d0000016'
const AT = '2026-11-14T12:00:00.000Z'
const NOW = '2026-11-14T10:00:00Z'
/** `AGENT_PREPROMPT_ARGV_MAX_CHARS` in `src/renderer/src/stores/sessions.ts`: the largest first prompt that travels in argv. */
const ARGV_MAX = 24_000

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

function missionOf(over: Partial<MissionV4> = {}): MissionV4 {
  return {
    schemaVersion: 4,
    id: ID,
    title: 'Score report',
    doneWhen: 'Every candidate sees a score report',
    status: 'open',
    milestones: [],
    steps: [
      {
        id: 'stp-1',
        title: 'Load the test files',
        acs: [{ id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }],
        links: [],
        blockers: []
      },
      {
        id: 'stp-2',
        title: 'Check the layout with the designer',
        acs: [{ id: 'ac-1', text: 'The layout is confirmed', by: 'operator' }],
        links: [],
        blockers: [
          {
            id: 'blk-1',
            reason: 'The sample export is not on the shared drive yet',
            ask: 'Put the export on the shared drive',
            unblocks: 'The import test',
            owner: 'operator'
          }
        ]
      }
    ],
    sessions: [
      { id: LEADER, role: 'leads', from: NOW, to: null },
      { id: WORKER, role: 'worked', from: NOW, to: null }
    ],
    links: [],
    blockers: [],
    ...over
  }
}

let root = ''
const v4Dir = (): string => path.join(root, '.harnu', 'missions-v4')

function seed(record: MissionV4, log = '# Log\n'): void {
  mkdirSync(v4Dir(), { recursive: true })
  writeFileSync(
    path.join(v4Dir(), `${record.id}-score-report.md`),
    buildMissionRecordContent(record, log)
  )
}

async function reread(id = ID): Promise<{ record: MissionV4; log: string }> {
  const r = await readMissionRecord(root, id)
  if (!r.ok) throw new Error(r.error)
  return { record: r.record, log: r.log }
}

/** Every file under the root with its hash: a refused or failed hand-off leaves this identical. */
function snapshot(dir = root, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    const rel = path.join(prefix, name)
    if (statSync(full).isDirectory()) {
      out[`${rel}/`] = 'dir'
      Object.assign(out, snapshot(full, rel))
    } else out[rel] = sha(readFileSync(full))
  }
  return out
}

/** A starter that records its calls and answers with `answer`. */
function spyStart(answer: Awaited<ReturnType<HandoffStart>>): {
  start: HandoffStart
  calls: Array<{ folder: string; prompt: string }>
} {
  const calls: Array<{ folder: string; prompt: string }> = []
  return {
    calls,
    start: async (args) => {
      calls.push(args)
      return answer
    }
  }
}

const ok = (sessionId = NEW_ONE): Awaited<ReturnType<HandoffStart>> => ({ ok: true, sessionId })

/** Steps and waiting facts so the leader's stop is not empty: stp-2 runs, and the operator owes the export. */
const inputs: NonNullable<HandoffDeps['inputs']> = async () => ({
  'stp-2': { workerWorking: true }
})

const headings = (log: string): string[] => log.split('\n').filter((l) => l.startsWith('### '))

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-handoff-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ---- The offer ----------------------------------------------------------------------

/**
 * The proof of "Harnu offers and never switches". `exercise` is the thing under test: it is handed the
 * starter spy, may do anything with it, and the assertions say the starter was never called and nothing
 * on disk moved. The planted fault below is run through the same assertions and must turn them red.
 */
function neverSwitches(exercise: (start: HandoffStart) => void | Promise<void>): Promise<void> {
  return (async () => {
    seed(missionOf())
    const before = snapshot()
    const spy = spyStart(ok())
    await exercise(spy.start)
    expect(spy.calls, 'a session was started').toHaveLength(0)
    expect(snapshot(), 'a file changed').toEqual(before)
    expect(leaderOf((await reread()).record)).toBe(LEADER)
  })()
}

describe('harnu offers and never switches', () => {
  it('at 95 percent it returns an offer, and starts nothing', async () => {
    await neverSwitches((start) => {
      void start // the offer has no way to reach the starter: it is a function of two numbers
      expect(handoffOffer(95, null)).toEqual({ offer: true, percent: 95 })
    })
  })

  it('a variant that starts a session when it offers turns the proof red', async () => {
    const faulty = (reading: number, start: HandoffStart): { offer: boolean } => {
      const offer = handoffOffer(reading, null)
      if (offer.offer) void start({ folder: root, prompt: 'x' })
      return offer
    }
    await expect(neverSwitches((start) => void faulty(95, start))).rejects.toThrow()
  })

  it('offers at 80 percent or more and not below', () => {
    expect(HANDOFF_OFFER_AT).toBe(80)
    expect(handoffOffer(79, null).offer).toBe(false)
    expect(handoffOffer(79.9, null).offer).toBe(false)
    expect(handoffOffer(80, null)).toEqual({ offer: true, percent: 80 })
    expect(handoffOffer(100, null).offer).toBe(true)
  })

  it('with no reading there is no offer: no session, a stale reading, nothing', () => {
    expect(handoffOffer(null, null)).toEqual({ offer: false, percent: null })
    expect(handoffOffer(undefined, null)).toEqual({ offer: false, percent: null })
    expect(handoffOffer(Number.NaN, null).offer).toBe(false)
    // a reading that makes no sense is no reading
    expect(handoffOffer(-3, null).offer).toBe(false)
    expect(handoffOffer(Infinity, null).offer).toBe(false)
  })

  it('"Not now" keeps the offer quiet until the context grows by five points', () => {
    expect(HANDOFF_QUIET_POINTS).toBe(5)
    expect(handoffOffer(82, 82).offer).toBe(false)
    expect(handoffOffer(86, 82).offer).toBe(false)
    expect(handoffOffer(87, 82)).toEqual({ offer: true, percent: 87 })
    // a dismissal never lifts the rule below 80
    expect(handoffOffer(79, 60).offer).toBe(false)
  })

  it('is a function of its two inputs: it is given no way to start or write anything', () => {
    expect(handoffOffer.length).toBeLessThanOrEqual(2)
    expect(handoffOffer(90, null)).toEqual(handoffOffer(90, null))
  })
})

// ---- Only the operator hands off ---------------------------------------------------------

describe('a hand-off is the operator’s alone', () => {
  const deps = (start: HandoffStart): HandoffDeps => ({ start })

  for (const [name, caller] of [
    ['the leader', { kind: 'session', sessionId: LEADER }],
    ['a worker', { kind: 'session', sessionId: WORKER }],
    ['a session that is not attached', { kind: 'session', sessionId: OTHER_NEW }],
    ['a Harnu system worker', { kind: 'worker' }]
  ] as const) {
    it(`${name} is refused and nothing starts`, async () => {
      seed(missionOf())
      const before = snapshot()
      const spy = spyStart(ok())
      const r = await handOff(root, ID, caller, deps(spy.start), { at: AT })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(['OPERATOR_ONLY', 'READ_ONLY']).toContain(r.code)
      expect(spy.calls).toHaveLength(0)
      expect(snapshot()).toEqual(before)
    })
  }

  it('a session is refused OPERATOR_ONLY, in the guard’s words', async () => {
    seed(missionOf())
    const spy = spyStart(ok())
    const r = await handOff(root, ID, { kind: 'session', sessionId: LEADER }, deps(spy.start))
    expect(r).toMatchObject({ ok: false, code: 'OPERATOR_ONLY' })
  })

  it('the channel’s door takes a folder and a mission and nothing that names a caller', async () => {
    seed(missionOf())
    const spy = spyStart(ok())
    // Whatever else the arguments carry, the actor is the operator's: a session id or actor in the
    // arguments neither widens nor narrows it. One session starts, written as one hand-off.
    const reply = await runHandOff(
      {
        folder: root,
        missionId: ID,
        actor: { kind: 'session', sessionId: WORKER },
        sessionId: WORKER,
        at: '1999-01-01T00:00:00.000Z'
      },
      deps(spy.start)
    )
    expect(reply).toMatchObject({ ok: true })
    expect(spy.calls).toHaveLength(1)
    const { record } = await reread()
    expect(leaderOf(record)).toBe(NEW_ONE)
    // the time is the app's own: a caller never sets it
    expect(record.sessions.find((s) => s.id === NEW_ONE)?.from).not.toBe('1999-01-01T00:00:00.000Z')
  })

  it('bad arguments are refused BAD_ARGS and start nothing', async () => {
    const spy = spyStart(ok())
    for (const raw of [
      null,
      'x',
      {},
      { folder: root },
      { missionId: ID },
      { folder: 3, missionId: ID }
    ]) {
      expect(await runHandOff(raw, deps(spy.start))).toMatchObject({ ok: false, code: 'BAD_ARGS' })
    }
    expect(spy.calls).toHaveLength(0)
  })

  it('with no starter wired the door says so and changes nothing', async () => {
    seed(missionOf())
    const before = snapshot()
    expect(await runHandOff({ folder: root, missionId: ID }, null)).toMatchObject({
      ok: false,
      code: 'HANDOFF_UNAVAILABLE'
    })
    expect(snapshot()).toEqual(before)
  })
})

// ---- What the door does ---------------------------------------------------------------------

describe('the hand-off door', () => {
  it('writes once: the old leader is worked with where it stopped, the new session leads', async () => {
    seed(missionOf())
    const spy = spyStart(ok())
    const r = await handOff(
      root,
      ID,
      { kind: 'operator' },
      { start: spy.start, inputs },
      { at: AT }
    )
    expect(r.ok).toBe(true)
    const { record, log } = await reread()

    const old = record.sessions.find((s) => s.id === LEADER)
    const expected = waitingListV4(missionOf(), {
      inputs: { 'stp-2': { workerWorking: true } }
    }).next
    expect(old).toMatchObject({
      role: 'worked',
      from: NOW,
      to: expect.any(String),
      stoppedAt: { step: 'stp-2', ...(expected ? { waitingFor: expected.ask } : {}) }
    })
    expect(old?.to).not.toBeNull()
    expect(expected, 'the fixture waits on the operator').not.toBeNull()
    expect(old?.stoppedAt?.waitingFor).toBe('Put the export on the shared drive')

    const fresh = record.sessions.find((s) => s.id === NEW_ONE)
    expect(fresh).toMatchObject({ role: 'leads', to: null, stoppedAt: null })
    expect(fresh?.from).toBe(old?.to)

    // exactly one open leader, the worker untouched, nothing removed
    expect(record.sessions.filter((s) => s.role === 'leads' && s.to === null)).toHaveLength(1)
    expect(leaderOf(record)).toBe(NEW_ONE)
    expect(record.sessions.find((s) => s.id === WORKER)).toEqual(missionOf().sessions[1])
    expect(record.sessions).toHaveLength(3)

    // one Log entry, on one line, after what was there
    expect(headings(log)).toHaveLength(1)
    expect(log.startsWith('# Log\n')).toBe(true)
    expect(log).toContain(NEW_ONE)
    expect(log).toContain(LEADER)
  })

  it('names a step only when one is open: with every step still to do it names none', async () => {
    const todo = missionOf().steps.map((s) => ({
      ...s,
      blockers: [],
      acs: [
        {
          id: 'ac-1',
          text: 'The pull request is merged',
          by: 'fact' as const,
          fact: 'pr-merged' as const
        }
      ]
    }))
    seed(missionOf({ steps: todo }))
    const spy = spyStart(ok())
    await handOff(root, ID, { kind: 'operator' }, { start: spy.start }, { at: AT })
    const old = (await reread()).record.sessions.find((s) => s.id === LEADER)
    expect(old?.stoppedAt?.step).toBeUndefined()
    expect(old?.role).toBe('worked')
  })

  it('a step that waits for review is where the leader stopped, even with no facts read', async () => {
    seed(missionOf())
    const spy = spyStart(ok())
    await handOff(root, ID, { kind: 'operator' }, { start: spy.start }, { at: AT })
    const old = (await reread()).record.sessions.find((s) => s.id === LEADER)
    // a sign-off step reads "waiting for review" from the record alone
    expect(old?.stoppedAt?.step).toBe('stp-2')
  })

  it('replies with the outcome and the new session id, never the record or a path', async () => {
    seed(missionOf())
    const spy = spyStart(ok())
    const reply = await runHandOff({ folder: root, missionId: ID }, { start: spy.start })
    expect(reply).toMatchObject({
      ok: true,
      changed: true,
      sessionId: NEW_ONE,
      previousLeader: LEADER
    })
    expect(reply).not.toHaveProperty('record')
    expect(reply).not.toHaveProperty('file')
    expect(JSON.stringify(reply)).not.toContain(root)
  })

  it('starts the session first, in the folder it was asked from, and writes only after the id is known', async () => {
    seed(missionOf())
    const at: string[] = []
    const start: HandoffStart = async (args) => {
      // while the session is starting the record still says the old leader leads
      at.push(leaderOf((await reread()).record) ?? 'none')
      expect(args.folder).toBe(root)
      return ok()
    }
    const r = await handOff(root, ID, { kind: 'operator' }, { start }, { at: AT })
    expect(r.ok).toBe(true)
    expect(at).toEqual([LEADER])
    expect(leaderOf((await reread()).record)).toBe(NEW_ONE)
  })

  it('a start that fails changes nothing: the old leader still leads, byte for byte', async () => {
    seed(missionOf())
    const before = snapshot()
    const spy = spyStart({ ok: false, reason: 'FOLDER_NOT_FOUND' })
    const r = await handOff(root, ID, { kind: 'operator' }, { start: spy.start })
    expect(r).toMatchObject({ ok: false, code: 'HANDOFF_START_FAILED' })
    expect(snapshot()).toEqual(before)
    expect(leaderOf((await reread()).record)).toBe(LEADER)
  })

  it('a start that times out changes nothing', async () => {
    seed(missionOf())
    const before = snapshot()
    const spy = spyStart({ ok: false, reason: 'timeout' })
    const r = await handOff(root, ID, { kind: 'operator' }, { start: spy.start })
    expect(r).toMatchObject({ ok: false, code: 'HANDOFF_START_FAILED' })
    expect(snapshot()).toEqual(before)
  })

  it('a starter that throws is a refusal, not a crash, and changes nothing', async () => {
    seed(missionOf())
    const before = snapshot()
    const r = await handOff(
      root,
      ID,
      { kind: 'operator' },
      {
        start: async () => {
          throw new Error('boom')
        }
      }
    )
    expect(r).toMatchObject({ ok: false, code: 'HANDOFF_START_FAILED' })
    expect(snapshot()).toEqual(before)
  })

  it('a session id that is not a real one (still synthetic, or not an id at all) is never written', async () => {
    for (const bad of ['synthetic-1b2c3d4e', '', 'x\n### 2026 · forged', '../etc/passwd']) {
      seed(missionOf())
      const before = snapshot()
      const spy = spyStart({ ok: true, sessionId: bad })
      const r = await handOff(root, ID, { kind: 'operator' }, { start: spy.start })
      expect(r.ok, bad).toBe(false)
      expect(snapshot(), bad).toEqual(before)
    }
  })

  it('a closed mission is not handed off, and nothing starts', async () => {
    seed(missionOf({ status: 'closed', closedAs: 'delivered' } as Partial<MissionV4>))
    const before = snapshot()
    const spy = spyStart(ok())
    const r = await handOff(root, ID, { kind: 'operator' }, { start: spy.start })
    expect(r).toMatchObject({ ok: false, code: 'MISSION_CLOSED' })
    expect(spy.calls).toHaveLength(0)
    expect(snapshot()).toEqual(before)
  })

  it('a mission that does not exist is refused and nothing starts', async () => {
    const spy = spyStart(ok())
    const r = await handOff(root, 'mnt-00000000', { kind: 'operator' }, { start: spy.start })
    expect(r).toMatchObject({ ok: false, code: 'MISSION_NOT_FOUND' })
    expect(spy.calls).toHaveLength(0)
  })

  it('a mission with no open leader gets the new session as its leader', async () => {
    seed(missionOf({ sessions: [{ id: LEADER, role: 'leads', from: NOW, to: AT, stoppedAt: {} }] }))
    const spy = spyStart(ok())
    const reply = await runHandOff({ folder: root, missionId: ID }, { start: spy.start })
    expect(reply).toMatchObject({ ok: true, previousLeader: null })
    const { record } = await reread()
    expect(leaderOf(record)).toBe(NEW_ONE)
    // the earlier, closed entry is exactly as it was
    expect(record.sessions[0]).toEqual({
      id: LEADER,
      role: 'leads',
      from: NOW,
      to: AT,
      stoppedAt: {}
    })
  })

  it('the old session is not killed, closed or messaged: the only call out is the one start', async () => {
    seed(missionOf())
    const ops: Array<{ op: string; payload: unknown }> = []
    const waits: string[] = []
    const bridge = {
      dispatch: async (op: string, payload: unknown): Promise<unknown> => {
        ops.push({ op, payload })
        return { sessionId: 'synthetic-aaa' }
      },
      awaitMaterialization: async (synthetic: string) => {
        waits.push(synthetic)
        return { syntheticId: synthetic, sessionId: NEW_ONE, folder: root }
      }
    }
    const reply = await runHandOff(
      { folder: root, missionId: ID },
      { start: bridgeStarter(bridge, { timeoutMs: 1000 }) }
    )
    expect(reply).toMatchObject({ ok: true, sessionId: NEW_ONE })
    // one dispatch, a normal session (never the agent-controlled `session.create`), nothing else
    expect(ops.map((o) => o.op)).toEqual(['session.dispatchCard'])
    expect(waits).toEqual(['synthetic-aaa'])
    const old = (await reread()).record.sessions.find((s) => s.id === LEADER)
    expect(old?.to).not.toBeNull()
  })

  it('the written time is the app’s clock, one ISO instant for the release and the start', async () => {
    seed(missionOf())
    const spy = spyStart(ok())
    await handOff(root, ID, { kind: 'operator' }, { start: spy.start })
    const { record } = await reread()
    const old = record.sessions.find((s) => s.id === LEADER)
    const fresh = record.sessions.find((s) => s.id === NEW_ONE)
    expect(Number.isNaN(Date.parse(old?.to ?? ''))).toBe(false)
    expect(fresh?.from).toBe(old?.to)
  })
})

// ---- At most one leader, however it is reached -----------------------------------------------

describe('one leader, however the hand-off is reached', () => {
  it('two hand-offs fired at once end with one leader and one started session', async () => {
    seed(missionOf())
    let started = 0
    const start: HandoffStart = async () => {
      started += 1
      await new Promise((r) => setTimeout(r, 30))
      return ok(started === 1 ? NEW_ONE : OTHER_NEW)
    }
    const [a, b] = await Promise.all([
      handOff(root, ID, { kind: 'operator' }, { start }, { at: AT }),
      handOff(root, ID, { kind: 'operator' }, { start }, { at: AT })
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const refused = [a, b].find((x) => !x.ok)
    expect(refused).toMatchObject({ ok: false, code: 'HANDOFF_IN_PROGRESS' })
    expect(started).toBe(1)
    const { record } = await reread()
    expect(record.sessions.filter((s) => s.role === 'leads' && s.to === null)).toHaveLength(1)
  })

  it('a leader that changed while the session started (another process) refuses and changes nothing more', async () => {
    seed(missionOf())
    const start: HandoffStart = async () => {
      // someone else completes a hand-off while this session is starting
      const swapped = await writeMission(
        root,
        ID,
        { kind: 'operator' },
        'operator',
        (rec, log) => ({
          record: {
            ...rec,
            sessions: [
              ...rec.sessions.map((s) =>
                s.id === LEADER ? { ...s, role: 'worked' as const, to: AT } : s
              ),
              { id: OTHER_NEW, role: 'leads' as const, from: AT, to: null, stoppedAt: null }
            ]
          },
          log
        })
      )
      expect(swapped.ok).toBe(true)
      return ok()
    }
    const r = await handOff(root, ID, { kind: 'operator' }, { start }, { at: AT })
    expect(r).toMatchObject({ ok: false, code: 'LEADER_CHANGED' })
    const { record } = await reread()
    expect(record.sessions.filter((s) => s.role === 'leads' && s.to === null)).toHaveLength(1)
    expect(leaderOf(record)).toBe(OTHER_NEW)
    expect(record.sessions.some((s) => s.id === NEW_ONE)).toBe(false)
  })

  it('hand-offs chain: the new leader can hand off again', async () => {
    seed(missionOf())
    await handOff(root, ID, { kind: 'operator' }, { start: spyStart(ok(NEW_ONE)).start })
    await handOff(root, ID, { kind: 'operator' }, { start: spyStart(ok(OTHER_NEW)).start })
    const { record } = await reread()
    expect(leaderOf(record)).toBe(OTHER_NEW)
    expect(record.sessions.filter((s) => s.role === 'leads' && s.to === null)).toHaveLength(1)
    expect(record.sessions.find((s) => s.id === NEW_ONE)).toMatchObject({ role: 'worked' })
  })

  it('no file under src/main/missions other than handoff.ts builds a `leads` entry to add to a record', () => {
    // `role: 'leads'` as a property is how an entry is built. Two modules build one for a record that
    // does not exist yet (the v3 conversion, and creating a mission as the session that leads it);
    // none may add one to an existing record. A new file here fails this list.
    const builders = readdirSync(MISSIONS_SRC)
      .filter((n) => n.endsWith('.ts'))
      .filter((n) => /role:\s*'leads'/.test(readFileSync(path.join(MISSIONS_SRC, n), 'utf8')))
      .sort()
    expect(builders).toEqual(['compat.ts', 'handoff.ts', 'verbs-read.ts'])
  })

  it('no file under src/main/missions other than handoff.ts starts a session', () => {
    const starters = readdirSync(MISSIONS_SRC)
      .filter((n) => n.endsWith('.ts'))
      .filter((n) =>
        /session\.(dispatchCard|create)|dispatchCreate|awaitMaterialization/.test(
          readFileSync(path.join(MISSIONS_SRC, n), 'utf8')
        )
      )
    expect(starters).toEqual(['handoff.ts'])
  })
})

// ---- The starter ----------------------------------------------------------------------------

describe('bridgeStarter', () => {
  const make = (over: {
    dispatch?: (op: string, payload: unknown) => Promise<unknown>
    wait?: (
      id: string,
      ms: number
    ) => Promise<{ syntheticId: string; sessionId: string; folder: string } | null>
  }): {
    ops: Array<{ op: string; payload: unknown }>
    start: HandoffStart
    waited: Array<[string, number]>
  } => {
    const ops: Array<{ op: string; payload: unknown }> = []
    const waited: Array<[string, number]> = []
    const bridge = {
      dispatch: async (op: string, payload: unknown): Promise<unknown> => {
        ops.push({ op, payload })
        return (await over.dispatch?.(op, payload)) ?? { sessionId: 'synthetic-q' }
      },
      awaitMaterialization: async (id: string, ms: number) => {
        waited.push([id, ms])
        return over.wait ? over.wait(id, ms) : { syntheticId: id, sessionId: NEW_ONE, folder: root }
      }
    }
    return { ops, waited, start: bridgeStarter(bridge, { timeoutMs: 4321 }) }
  }

  it('dispatches a normal session with the folder and the prompt, and nothing else', async () => {
    const t = make({})
    const r = await t.start({ folder: '/work/repo', prompt: 'the first prompt' })
    expect(r).toEqual({ ok: true, sessionId: NEW_ONE })
    expect(t.ops).toEqual([
      {
        op: 'session.dispatchCard',
        payload: { folderPath: '/work/repo', prompt: 'the first prompt' }
      }
    ])
    expect(t.waited).toEqual([['synthetic-q', 4321]])
  })

  it('a dispatch the renderer refuses (no sessionId) fails with its reason and waits for nothing', async () => {
    const t = make({ dispatch: async () => ({ error: 'FOLDER_NOT_FOUND' }) })
    const r = await t.start({ folder: '/nope', prompt: 'p' })
    expect(r).toEqual({ ok: false, reason: 'FOLDER_NOT_FOUND' })
    expect(t.waited).toHaveLength(0)
  })

  it('a dispatch that throws fails with its message', async () => {
    const t = make({
      dispatch: async () => {
        throw new Error('NO_WINDOW')
      }
    })
    expect(await t.start({ folder: '/x', prompt: 'p' })).toEqual({ ok: false, reason: 'NO_WINDOW' })
  })

  it('no materialization before the deadline is a failure named timeout', async () => {
    const t = make({ wait: async () => null })
    expect(await t.start({ folder: '/x', prompt: 'p' })).toEqual({ ok: false, reason: 'timeout' })
  })

  it('a materialization with no real id is a failure', async () => {
    const t = make({ wait: async (id) => ({ syntheticId: id, sessionId: '', folder: '/x' }) })
    expect((await t.start({ folder: '/x', prompt: 'p' })).ok).toBe(false)
  })
})

// ---- The first prompt -------------------------------------------------------------------------

describe('the first prompt of a hand-off session', () => {
  it('is the summary under one instruction line, and the instruction is pinned', async () => {
    seed(missionOf())
    const { record, log } = await reread()
    const prompt = handoffPrompt(record, log)
    expect(HANDOFF_INSTRUCTION).toBe(
      'You are taking over this mission from another session. Harnu attaches you as its leader as this session starts; if a mission tool answers NOT_ATTACHED, wait a moment and try once more. Work from the summary below.'
    )
    expect(HANDOFF_INSTRUCTION).not.toContain('\n')
    expect(prompt).toBe(`${HANDOFF_INSTRUCTION}\n\n${buildMissionSummary(record, log).text}`)
  })

  it('holds no resume prompt for the operator to paste and fits an argv token', async () => {
    seed(missionOf())
    const { record, log } = await reread()
    const prompt = handoffPrompt(record, log)
    expect(prompt.length).toBeLessThanOrEqual(ARGV_MAX)
    expect(prompt.length).toBeLessThanOrEqual(8000 + HANDOFF_INSTRUCTION.length + 2)
    expect(prompt).not.toMatch(/paste/i)
  })

  it('is what the door starts the session with', async () => {
    seed(missionOf())
    const spy = spyStart(ok())
    await handOff(root, ID, { kind: 'operator' }, { start: spy.start, inputs })
    const { record } = await reread()
    // built from the record as it was before the hand-off, so it says who leads and where it stopped
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0].prompt.startsWith(`${HANDOFF_INSTRUCTION}\n\n`)).toBe(true)
    expect(spy.calls[0].prompt).toContain('Score report')
    expect(spy.calls[0].prompt).toContain('Every candidate sees a score report')
    expect(spy.calls[0].prompt.length).toBeLessThanOrEqual(ARGV_MAX)
    void record
  })
})

// ---- A v3 mission -----------------------------------------------------------------------------

describe('a hand-off on a mission born in v3 leaves the v3 file as it was', () => {
  const V3_ID = 'mnt-5c0de001'
  const v3Dir = (): string => path.join(root, '.harnu', 'missions')
  const v3Hashes = (): Record<string, string> =>
    Object.fromEntries(
      readdirSync(v3Dir()).map((n) => [n, sha(readFileSync(path.join(v3Dir(), n)))])
    )

  beforeEach(() => {
    cpSync(path.join(FIXTURES, 'missions'), v3Dir(), { recursive: true })
    cpSync(path.join(FIXTURES, 'campaigns'), path.join(root, '.harnu', 'campaigns'), {
      recursive: true
    })
  })

  it('writes a v4 record by copy and no v3 byte', async () => {
    const before = v3Hashes()
    const read = await readMissionRecord(root, V3_ID)
    if (!read.ok) throw new Error(read.error)
    const old = leaderOf(read.record)
    const spy = spyStart(ok())
    const r = await handOff(root, V3_ID, { kind: 'operator' }, { start: spy.start }, { at: AT })
    expect(r.ok).toBe(true)
    expect(v3Hashes()).toEqual(before)
    expect(existsSync(v4Dir())).toBe(true)
    const after = await readMissionRecord(root, V3_ID)
    if (!after.ok) throw new Error(after.error)
    expect(after.source).toBe('v4')
    expect(leaderOf(after.record)).toBe(NEW_ONE)
    if (old) expect(after.record.sessions.find((s) => s.id === old)?.role).toBe('worked')
  })

  it('a refused or failed hand-off writes no v4 record and no directory', async () => {
    const before = snapshot()
    const failing = spyStart({ ok: false, reason: 'timeout' })
    await handOff(root, V3_ID, { kind: 'operator' }, { start: failing.start })
    const asSession = spyStart(ok())
    await handOff(root, V3_ID, { kind: 'session', sessionId: LEADER }, { start: asSession.start })
    expect(asSession.calls).toHaveLength(0)
    expect(snapshot()).toEqual(before)
    expect(existsSync(v4Dir())).toBe(false)
  })
})
