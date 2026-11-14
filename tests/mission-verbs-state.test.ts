/**
 * Missions v4 · S-14 · AC-35, AC-36 — the state verbs: blocker, Done when, settle, close request and
 * ask to attach.
 *
 * Every verb goes through S-11's one guard and one write path (`write.ts`), so this file proves what a
 * verb adds on top: the ids it hands out, what it refuses, what it stages instead of writing, and that
 * none of it ever moves a byte of a v3 file. The handlers are called through their module API: nothing
 * on main registers them until S-24.
 *
 * AC-36's second clause ("the operator's close is never refused") is the operator's door (S-15); the
 * test below proves this slice's half and shows that the write path the door will use accepts a close.
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
  buildMissionRecordContent,
  parseMissionRecordFile,
  readMissionRecordLog,
  STATE_LABELS,
  type MissionV4
} from '../src/main/missions/model'
import { leaderOf, listMissionRows, readMissionAs, type Actor } from '../src/main/missions/guard'
import { writeMission } from '../src/main/missions/write'
import { readMissionRecord } from '../src/main/missions/record-store'
import { criterionSettlement, deriveStepState } from '../src/main/missions/state'
import {
  askToAttach,
  clearBlocker,
  requestClose,
  setBlocker,
  settleCriterion,
  stageDoneWhen
} from '../src/main/missions/verbs-state'

const FIXTURES = path.join(__dirname, 'fixtures', 'missions-v4-compat')

const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const BUILDER = '8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d'
const VERIFIER = 'c4e6a8b0-5d7f-4c9a-a1b3-6e8a0c2e4f60'
const OUTSIDER = 'e0e0e0e0-0000-4000-8000-000000000001'
const RELEASED = 'e0e0e0e0-0000-4000-8000-000000000002'

const ID = 'mnt-aa000001'
const NOW = '2026-11-14T10:00:00Z'

const session = (sessionId: string): Actor => ({ kind: 'session', sessionId })
const operator: Actor = { kind: 'operator' }

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

const REASON = 'The staging database needs the `DATABASE_URL` secret from the operator'
const ASK = 'Add DATABASE_URL to the staging settings'
const WHY = 'The import step can then run'

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
        acs: [
          { id: 'ac-1', text: 'A reviewer reads every changed file', by: 'session' },
          { id: 'ac-2', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' },
          { id: 'ac-3', text: 'The operator likes the layout', by: 'operator' },
          { id: 'ac-4', text: 'The designer signed off', by: 'person', person: 'the designer' }
        ],
        links: [{ kind: 'session', ref: BUILDER }],
        blockers: []
      },
      {
        id: 'stp-2',
        title: 'Render the report',
        acs: [{ id: 'ac-1', text: 'A reviewer reads the report', by: 'session' }],
        links: [],
        blockers: []
      }
    ],
    sessions: [
      { id: LEADER, role: 'leads', from: NOW, to: null },
      { id: BUILDER, role: 'worked', from: NOW, to: null },
      { id: VERIFIER, role: 'worked', from: NOW, to: null },
      { id: RELEASED, role: 'worked', from: NOW, to: '2026-11-14T11:00:00Z' }
    ],
    links: [],
    blockers: [],
    ...over
  }
}

let root = ''
const v4Dir = (): string => path.join(root, '.harnu', 'missions-v4')
const v4Files = (): string[] =>
  existsSync(v4Dir())
    ? readdirSync(v4Dir())
        .filter((n) => n.endsWith('.md'))
        .sort()
    : []
const fileOf = (): string => path.join(v4Dir(), v4Files()[0])

function seed(record: MissionV4 = missionOf(), log = ''): void {
  mkdirSync(v4Dir(), { recursive: true })
  writeFileSync(
    path.join(v4Dir(), `${record.id}-score-report.md`),
    buildMissionRecordContent(record, log)
  )
}

const stored = (): MissionV4 => {
  const parsed = parseMissionRecordFile(readFileSync(fileOf(), 'utf8'))
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed
}
const storedLog = (): string => readMissionRecordLog(readFileSync(fileOf(), 'utf8'))
const snapshotV4 = (): Record<string, string> =>
  Object.fromEntries(v4Files().map((n) => [n, readFileSync(path.join(v4Dir(), n), 'utf8')]))

/** Narrow a result to its success side, or fail with the refusal. */
function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`)
  return r as Extract<T, { ok: true }>
}
/** A result's refusal code, or `ok`. */
const codeOf = (r: { ok: boolean; code?: string }): string => (r.ok ? 'ok' : (r.code as string))

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-verbs-state-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// AC-35

describe('state verbs need an attachment and an unattached session may ask to attach', () => {
  const blockerArgs = { missionId: ID, stepId: 'stp-1', reason: REASON, owner: 'agent' as const }
  const calls: Array<[string, (actor: Actor) => Promise<{ ok: boolean; code?: string }>]> = [
    ['mission_set_blocker', (a) => setBlocker(root, a, blockerArgs)],
    ['mission_clear_blocker', (a) => clearBlocker(root, a, { missionId: ID, blockerId: 'blk-1' })],
    [
      'mission_set_done_when',
      (a) => stageDoneWhen(root, a, { missionId: ID, doneWhen: 'A new end', reason: 'It changed' })
    ],
    [
      'mission_settle_ac',
      (a) =>
        settleCriterion(root, a, {
          missionId: ID,
          stepId: 'stp-2',
          criterionId: 'ac-1',
          evidence: 'Read the report in the browser'
        })
    ],
    ['mission_request_close', (a) => requestClose(root, a, { missionId: ID })]
  ]

  it('each of them refuses a session that is not attached, names the way out and stores nothing', async () => {
    seed()
    const before = snapshotV4()
    for (const who of [OUTSIDER, RELEASED]) {
      for (const [verb, call] of calls) {
        const r = await call(session(who))
        expect(r.ok, `${verb} as ${who}`).toBe(false)
        expect(r.code, `${verb} as ${who}`).toBe('NOT_ATTACHED')
        expect((r as { error: string }).error, verb).toMatch(/mission_attach/)
        expect((r as { error: string }).error, verb).toMatch(/mission_list/)
      }
    }
    expect(snapshotV4()).toEqual(before)
  })

  it('an attached session is not refused for that reason', async () => {
    seed()
    const r = await setBlocker(root, session(BUILDER), blockerArgs)
    expect(r.ok).toBe(true)
  })

  it("an unattached session may list the folder's missions, and may not read the detail", async () => {
    seed()
    const rows = await listMissionRows(root, session(OUTSIDER))
    expect(rows.map((r) => r.id)).toEqual([ID])
    expect(Object.keys(rows[0]).sort()).toEqual(['headline', 'id', 'leads', 'title'])
    const detail = await readMissionAs(root, ID, session(OUTSIDER))
    expect(detail.ok).toBe(false)
    expect(!detail.ok && 'code' in detail && detail.code).toBe('NOT_ATTACHED')
  })

  it('an unattached session may ask to attach: one request, no role, and nothing else in the record moves', async () => {
    seed(missionOf(), '\nan earlier note\n')
    const before = stored()
    const r = must(await askToAttach(root, session(OUTSIDER), { missionId: ID }))
    expect(r.requestId).toBe('atr-1')
    expect(r.deduped).toBe(false)

    const after = stored()
    expect(after.attachRequests).toHaveLength(1)
    const request = after.attachRequests?.[0] as unknown as Record<string, unknown>
    expect(request).toMatchObject({
      id: 'atr-1',
      missionId: ID,
      sessionId: OUTSIDER,
      decision: null
    })
    expect(request).not.toHaveProperty('role')
    expect(typeof request.at).toBe('string')
    // Nothing but the request: not a field, not a session entry, not a Log line.
    const strip = ({ attachRequests: _a, ...rest }: MissionV4): unknown => rest
    expect(strip(after)).toEqual(strip(before))
    expect(storedLog()).toBe('\nan earlier note\n')
  })

  it('a request never says "lead": a role handed in is not stored', async () => {
    seed()
    const args = { missionId: ID, role: 'leads' } as unknown as { missionId: string }
    must(await askToAttach(root, session(OUTSIDER), args))
    const request = stored().attachRequests?.[0] as unknown as Record<string, unknown>
    expect(request).not.toHaveProperty('role')
    expect(stored().sessions.filter((s) => s.role === 'leads' && s.to === null)).toHaveLength(1)
    expect(leaderOf(stored())).toBe(LEADER)
  })

  it('asking twice while undecided stores one request and returns the same id', async () => {
    seed()
    const first = must(await askToAttach(root, session(OUTSIDER), { missionId: ID }))
    const second = must(await askToAttach(root, session(OUTSIDER), { missionId: ID }))
    expect(second.requestId).toBe(first.requestId)
    expect(second.deduped).toBe(true)
    expect(stored().attachRequests).toHaveLength(1)
    // Another session's request is its own.
    const other = must(await askToAttach(root, session(RELEASED), { missionId: ID }))
    expect(other.requestId).toBe('atr-2')
    expect(stored().attachRequests).toHaveLength(2)
  })

  it('a request the operator decided does not block a new one', async () => {
    seed(
      missionOf({
        attachRequests: [
          {
            id: 'atr-1',
            missionId: ID,
            sessionId: OUTSIDER,
            at: NOW,
            decision: 'denied',
            decidedAt: NOW
          }
        ]
      })
    )
    const r = must(await askToAttach(root, session(OUTSIDER), { missionId: ID }))
    expect(r.requestId).toBe('atr-2')
    expect(r.deduped).toBe(false)
    // The earlier, decided request is untouched.
    expect(stored().attachRequests?.[0]).toMatchObject({ id: 'atr-1', decision: 'denied' })
  })

  it('an attached session has nothing to ask for, and a closed mission takes no request', async () => {
    seed()
    const attached = await askToAttach(root, session(BUILDER), { missionId: ID })
    expect(codeOf(attached)).toBe('ALREADY_ATTACHED')
    expect(stored().attachRequests ?? []).toEqual([])

    rmSync(v4Dir(), { recursive: true })
    seed(missionOf({ status: 'closed', closedAs: 'delivered' }))
    const closed = await askToAttach(root, session(OUTSIDER), { missionId: ID })
    expect(codeOf(closed)).toBe('MISSION_CLOSED')
  })

  it('a mission that does not exist is said so', async () => {
    const r = await askToAttach(root, session(OUTSIDER), { missionId: 'mnt-00000000' })
    expect(codeOf(r)).toBe('MISSION_NOT_FOUND')
  })

  it('only a session asks: the operator decides at the door and a worker never writes', async () => {
    seed()
    expect(codeOf(await askToAttach(root, operator, { missionId: ID }))).toBe('SESSION_ONLY')
    expect(
      codeOf(await askToAttach(root, { kind: 'worker', missionId: ID }, { missionId: ID }))
    ).toBe('SESSION_ONLY')
    expect(stored().attachRequests ?? []).toEqual([])
  })
})

describe('mission_set_blocker', () => {
  it('gives a step blocker an id, the owner, the time and the next-step wording', async () => {
    seed()
    const r = must(
      await setBlocker(root, session(LEADER), {
        missionId: ID,
        stepId: 'stp-1',
        reason: REASON,
        ask: ASK,
        unblocks: WHY,
        owner: 'operator',
        clearsWhen: 'pr-merged'
      })
    )
    expect(r.blockerId).toBe('blk-1')
    expect(r.deduped).toBe(false)
    const blocker = stored().steps[0].blockers[0]
    expect(blocker).toMatchObject({
      id: 'blk-1',
      reason: REASON,
      ask: ASK,
      unblocks: WHY,
      owner: 'operator',
      clearsWhen: 'pr-merged'
    })
    expect(typeof blocker.raisedAt).toBe('string')
    expect(storedLog()).toMatch(/blk-1/)
  })

  it('numbers ids across the whole mission, step and mission level alike, and never reuses one', async () => {
    seed()
    const a = must(
      await setBlocker(root, session(LEADER), { missionId: ID, reason: REASON, owner: 'agent' })
    )
    const b = must(
      await setBlocker(root, session(BUILDER), {
        missionId: ID,
        stepId: 'stp-2',
        reason: 'The reviewer account is missing from `reviewers.yml` in the repo',
        owner: 'agent'
      })
    )
    expect([a.blockerId, b.blockerId]).toEqual(['blk-1', 'blk-2'])
    // Clear the last one; the next blocker is blk-3, not blk-2 again.
    must(await clearBlocker(root, session(LEADER), { missionId: ID, blockerId: 'blk-2' }))
    const c = must(
      await setBlocker(root, session(LEADER), {
        missionId: ID,
        stepId: 'stp-2',
        reason: 'The score formula in `docs/score.md` has no weight for essays',
        owner: 'agent'
      })
    )
    expect(c.blockerId).toBe('blk-3')
  })

  it('setting the same blocker twice stores it once', async () => {
    seed()
    const args = { missionId: ID, stepId: 'stp-1', reason: REASON, owner: 'agent' as const }
    const first = must(await setBlocker(root, session(LEADER), args))
    const second = must(await setBlocker(root, session(BUILDER), args))
    expect(second.blockerId).toBe(first.blockerId)
    expect(second.deduped).toBe(true)
    expect(stored().steps[0].blockers).toHaveLength(1)
    // The same words on another step are another blocker.
    const other = must(await setBlocker(root, session(LEADER), { ...args, stepId: 'stp-2' }))
    expect(other.deduped).toBe(false)
    expect(other.blockerId).toBe('blk-2')
  })

  it('an operator-owned blocker needs the ask and what it unblocks', async () => {
    seed()
    const base = { missionId: ID, stepId: 'stp-1', reason: REASON, owner: 'operator' as const }
    const noAsk = await setBlocker(root, session(LEADER), { ...base, unblocks: WHY })
    const noWhy = await setBlocker(root, session(LEADER), { ...base, ask: ASK })
    expect(codeOf(noAsk)).toBe('BAD_ARGS')
    expect((noAsk as { error: string }).error).toMatch(/ask/)
    expect(codeOf(noWhy)).toBe('BAD_ARGS')
    expect((noWhy as { error: string }).error).toMatch(/unblocks/)
    expect(stored().steps[0].blockers).toEqual([])
    // An agent-owned one does not.
    expect((await setBlocker(root, session(LEADER), { ...base, owner: 'agent' })).ok).toBe(true)
  })

  it("clearsWhen belongs to a step's blocker and names a fact Harnu reads", async () => {
    seed()
    const onMission = await setBlocker(root, session(LEADER), {
      missionId: ID,
      reason: REASON,
      owner: 'agent',
      clearsWhen: 'ci-green'
    })
    expect(codeOf(onMission)).toBe('MISSION_BLOCKER_FACT')
    const notAFact = await setBlocker(root, session(LEADER), {
      missionId: ID,
      stepId: 'stp-1',
      reason: REASON,
      owner: 'agent',
      clearsWhen: 'never' as 'ci-green'
    })
    expect(codeOf(notAFact)).toBe('BAD_ARGS')
    expect(stored().blockers).toEqual([])
    expect(stored().steps[0].blockers).toEqual([])
  })

  it('the writing contract refuses a vague reason and an over-long ask, and stores nothing', async () => {
    seed()
    const before = snapshotV4()
    const vague = await setBlocker(root, session(LEADER), {
      missionId: ID,
      stepId: 'stp-1',
      reason: 'Blocked on env',
      owner: 'agent'
    })
    expect(codeOf(vague)).toBe('BLOCKER_REASON_VAGUE')
    const long = await setBlocker(root, session(LEADER), {
      missionId: ID,
      stepId: 'stp-1',
      reason: REASON,
      ask: 'x'.repeat(91),
      unblocks: WHY,
      owner: 'operator'
    })
    expect(codeOf(long)).toBe('OVER_CAP')
    expect(snapshotV4()).toEqual(before)
  })

  it('a step the record does not have is refused, and an old id finds its new one', async () => {
    seed(
      missionOf({
        legacyV3: {
          stepIds: [
            { mission: 'mnt-ca000001', step: 'stp-7', id: 'stp-2' },
            { mission: 'mnt-ca000001', step: 'stp-8', id: 'stp-1' },
            { mission: 'mnt-ca000002', step: 'stp-8', id: 'stp-2' }
          ]
        }
      })
    )
    const missing = await setBlocker(root, session(LEADER), {
      missionId: ID,
      stepId: 'stp-99',
      reason: REASON,
      owner: 'agent'
    })
    expect(codeOf(missing)).toBe('STEP_NOT_FOUND')

    // stp-7 is a v3 id: the record renumbered it to stp-2, and the result says so.
    const old = must(
      await setBlocker(root, session(LEADER), {
        missionId: ID,
        stepId: 'stp-7',
        reason: REASON,
        owner: 'agent'
      })
    )
    expect(old.stepId).toBe('stp-2')
    expect(stored().steps[1].blockers).toHaveLength(1)

    // stp-8 was two different steps in two chapters: it names both, and picks neither.
    const twice = await setBlocker(root, session(LEADER), {
      missionId: ID,
      stepId: 'stp-8',
      reason: REASON,
      owner: 'agent'
    })
    expect(codeOf(twice)).toBe('STEP_NOT_FOUND')
    expect((twice as { error: string }).error).toMatch(/stp-1/)
    expect((twice as { error: string }).error).toMatch(/stp-2/)
  })

  it('a closed mission takes no blocker', async () => {
    seed(missionOf({ status: 'closed', closedAs: 'delivered' }))
    const r = await setBlocker(root, session(LEADER), {
      missionId: ID,
      reason: REASON,
      owner: 'agent'
    })
    expect(codeOf(r)).toBe('MISSION_CLOSED')
  })
})

describe('mission_clear_blocker', () => {
  const seedBlockers = (): void =>
    seed(
      missionOf({
        blockers: [{ id: 'blk-1', reason: REASON, owner: 'agent', raisedAt: NOW }],
        steps: [
          {
            ...missionOf().steps[0],
            blockers: [
              {
                id: 'blk-2',
                reason: REASON,
                ask: ASK,
                unblocks: WHY,
                owner: 'operator',
                raisedAt: NOW
              },
              { id: 'blk-3', reason: REASON, owner: 'agent', raisedAt: NOW }
            ]
          },
          missionOf().steps[1]
        ]
      })
    )

  it('clears an agent-owned blocker by id, on the mission or on a step', async () => {
    seedBlockers()
    const a = must(await clearBlocker(root, session(LEADER), { missionId: ID, blockerId: 'blk-1' }))
    expect(a.stepId).toBeUndefined()
    const b = must(
      await clearBlocker(root, session(BUILDER), { missionId: ID, blockerId: 'blk-3' })
    )
    expect(b.stepId).toBe('stp-1')
    expect(stored().blockers).toEqual([])
    expect(stored().steps[0].blockers.map((x) => x.id)).toEqual(['blk-2'])
    expect(storedLog()).toMatch(/blk-3/)
  })

  it('refuses an id that is not there', async () => {
    seedBlockers()
    const r = await clearBlocker(root, session(LEADER), { missionId: ID, blockerId: 'blk-9' })
    expect(codeOf(r)).toBe('BLOCKER_NOT_FOUND')
  })

  it('leaves an operator-owned blocker to the operator: a session never clears it', async () => {
    seedBlockers()
    const before = snapshotV4()
    const r = await clearBlocker(root, session(LEADER), { missionId: ID, blockerId: 'blk-2' })
    expect(codeOf(r)).toBe('OPERATOR_ONLY')
    expect(snapshotV4()).toEqual(before)
    // The operator's own call, through the same path, clears it.
    must(await clearBlocker(root, operator, { missionId: ID, blockerId: 'blk-2' }))
    expect(stored().steps[0].blockers.map((x) => x.id)).toEqual(['blk-3'])
  })
})

describe('mission_set_done_when', () => {
  it('stages the new Done when for the operator and never rewrites the one the mission has', async () => {
    seed()
    const before = stored()
    const r = must(
      await stageDoneWhen(root, session(LEADER), {
        missionId: ID,
        doneWhen: 'Every candidate sees a score report and an export',
        reason: 'The customer also asked for the export'
      })
    )
    expect(r.deduped).toBe(false)
    const after = stored()
    expect(after.doneWhen).toBe(before.doneWhen)
    expect(after.doneWhen).toBe('Every candidate sees a score report')
    expect(r.staged).toMatchObject({
      text: 'Every candidate sees a score report and an export',
      reason: 'The customer also asked for the export',
      by: LEADER
    })
    expect((after as unknown as { pendingDoneWhen: unknown }).pendingDoneWhen).toEqual(r.staged)
    expect(storedLog()).toMatch(/Done when/)
  })

  it('keeps one change staged: the same text once, a new text replaces it', async () => {
    seed()
    const args = { missionId: ID, doneWhen: 'Candidates see a score report', reason: 'Shorter' }
    const first = must(await stageDoneWhen(root, session(LEADER), args))
    const again = must(await stageDoneWhen(root, session(LEADER), args))
    expect(again.deduped).toBe(true)
    expect(again.staged).toEqual(first.staged)
    const next = must(
      await stageDoneWhen(root, session(LEADER), { ...args, doneWhen: 'Every report is shared' })
    )
    expect(next.deduped).toBe(false)
    expect(
      (stored() as unknown as { pendingDoneWhen: { text: string } }).pendingDoneWhen.text
    ).toBe('Every report is shared')
  })

  it('asks for a reason, for a text that differs, and for the leader', async () => {
    seed()
    const base = { missionId: ID, doneWhen: 'A different end', reason: 'It changed' }
    expect(codeOf(await stageDoneWhen(root, session(LEADER), { ...base, reason: ' ' }))).toBe(
      'BAD_ARGS'
    )
    expect(codeOf(await stageDoneWhen(root, session(LEADER), { ...base, doneWhen: '' }))).toBe(
      'BAD_ARGS'
    )
    expect(
      codeOf(
        await stageDoneWhen(root, session(LEADER), {
          ...base,
          doneWhen: 'Every candidate sees a score report'
        })
      )
    ).toBe('BAD_ARGS')
    expect(codeOf(await stageDoneWhen(root, session(BUILDER), base))).toBe('NOT_LEADER')
    expect(stored()).not.toHaveProperty('pendingDoneWhen')
  })
})

describe('mission_settle_ac', () => {
  const args = {
    missionId: ID,
    stepId: 'stp-1',
    criterionId: 'ac-1',
    evidence: 'Read every changed file and ran the suite'
  }

  it('a second session settles a criterion of a step it did not build, with evidence', async () => {
    seed()
    const r = must(await settleCriterion(root, session(VERIFIER), args))
    expect(r.outcome).toBe('settled')
    const ac = stored().steps[0].acs[0]
    expect(ac.settled).toMatchObject({ by: VERIFIER, evidence: args.evidence })
    expect(typeof ac.settled?.at).toBe('string')
    expect(ac).not.toHaveProperty('selfCheck')
    expect(criterionSettlement(ac, stored().steps[0], {})).toEqual({
      settled: true,
      via: 'session'
    })
    expect(storedLog()).toMatch(/ac-1/)
  })

  it('a session that built the step only self-checks it, and a self-check never settles', async () => {
    seed()
    const r = must(await settleCriterion(root, session(BUILDER), args))
    expect(r.outcome).toBe('self-check')
    const ac = stored().steps[0].acs[0]
    expect(ac.selfCheck).toMatchObject({ by: BUILDER, evidence: args.evidence })
    expect(ac).not.toHaveProperty('settled')
    expect(criterionSettlement(ac, stored().steps[0], {}).settled).toBe(false)
    expect(deriveStepState(stored().steps[0], {}).open.map((c) => c.id)).toContain('ac-1')
  })

  it('a session the caller names as a builder of the step self-checks too (the leader, for a step it did)', async () => {
    seed()
    const r = must(
      await settleCriterion(root, session(LEADER), { ...args, extraBuilders: [LEADER] })
    )
    expect(r.outcome).toBe('self-check')
    expect(stored().steps[0].acs[0]).not.toHaveProperty('settled')
  })

  it('never settles by hand a criterion a fact, the operator or another person settles', async () => {
    seed()
    const before = snapshotV4()
    for (const criterionId of ['ac-2', 'ac-3', 'ac-4']) {
      for (const who of [BUILDER, VERIFIER, LEADER]) {
        const r = await settleCriterion(root, session(who), { ...args, criterionId })
        expect(r.ok, `${criterionId} by ${who}`).toBe(false)
        expect(r.code, `${criterionId} by ${who}`).toBe('SETTLE_NOT_ALLOWED')
      }
    }
    expect(snapshotV4()).toEqual(before)
  })

  it('asks for the evidence, and for a step and a criterion the record has', async () => {
    seed()
    expect(
      codeOf(await settleCriterion(root, session(VERIFIER), { ...args, evidence: '  ' }))
    ).toBe('BAD_ARGS')
    expect(
      codeOf(await settleCriterion(root, session(VERIFIER), { ...args, stepId: 'stp-9' }))
    ).toBe('STEP_NOT_FOUND')
    expect(
      codeOf(await settleCriterion(root, session(VERIFIER), { ...args, criterionId: 'ac-9' }))
    ).toBe('CRITERION_NOT_FOUND')
    expect(stored().steps[0].acs[0]).not.toHaveProperty('settled')
  })

  it('keeps the first settlement: a settled criterion is not settled again', async () => {
    seed()
    must(await settleCriterion(root, session(VERIFIER), args))
    const again = await settleCriterion(root, session(VERIFIER), {
      ...args,
      evidence: 'Another look'
    })
    expect(codeOf(again)).toBe('ALREADY_SETTLED')
    expect(stored().steps[0].acs[0].settled?.evidence).toBe(args.evidence)
  })

  it("is a session's verb: the operator marks a criterion at the door", async () => {
    seed()
    expect(codeOf(await settleCriterion(root, operator, args))).toBe('SESSION_ONLY')
    expect(stored().steps[0].acs[0]).not.toHaveProperty('settled')
  })
})

// ---------------------------------------------------------------------------------------------
// AC-36

describe("the agent's close request and the operator's close differ", () => {
  /** stp-1 done (its criteria are all settled by hand), stp-2 open. */
  const settledStep = (): MissionV4['steps'][number] => ({
    id: 'stp-1',
    title: 'Load the test files',
    acs: [
      {
        id: 'ac-1',
        text: 'A reviewer reads every changed file',
        by: 'session',
        settled: { at: NOW, by: VERIFIER, evidence: 'Read it' }
      }
    ],
    links: [{ kind: 'session', ref: BUILDER }],
    blockers: []
  })

  it('is refused STEPS_OPEN while a step is not done, names the steps, and sets nothing', async () => {
    seed(missionOf({ steps: [settledStep(), missionOf().steps[1]] }))
    const before = snapshotV4()
    const r = await requestClose(root, session(LEADER), { missionId: ID })
    expect(codeOf(r)).toBe('STEPS_OPEN')
    const error = (r as { error: string }).error
    expect(error).toMatch(/stp-2/)
    expect(error).toContain(STATE_LABELS.todo)
    expect(error).not.toMatch(/stp-1/)
    expect(snapshotV4()).toEqual(before)
    expect(stored()).not.toHaveProperty('closeRequested')
  })

  it("reads each step's state from the facts the caller has, so a merged pull request counts", async () => {
    const fact = {
      ...settledStep(),
      acs: [
        {
          id: 'ac-1',
          text: 'The pull request is merged',
          by: 'fact' as const,
          fact: 'pr-merged' as const
        }
      ]
    }
    seed(missionOf({ steps: [fact] }))
    expect(codeOf(await requestClose(root, session(LEADER), { missionId: ID }))).toBe('STEPS_OPEN')
    const withFacts = await requestClose(root, session(LEADER), {
      missionId: ID,
      inputs: { 'stp-1': { pr: 'merged' } }
    })
    expect(withFacts.ok).toBe(true)
  })

  it('is not held up by an optional step, and a step that waits for review is still open', async () => {
    seed(
      missionOf({
        steps: [settledStep(), { ...missionOf().steps[1], optional: true }]
      })
    )
    expect((await requestClose(root, session(LEADER), { missionId: ID })).ok).toBe(true)

    rmSync(v4Dir(), { recursive: true })
    seed(missionOf({ steps: [settledStep(), missionOf().steps[1]] }))
    const waiting = await requestClose(root, session(LEADER), {
      missionId: ID,
      inputs: { 'stp-2': { pr: 'open' } }
    })
    expect(codeOf(waiting)).toBe('STEPS_OPEN')
    expect((waiting as { error: string }).error).toContain(STATE_LABELS['waiting-review'])
  })

  it('sets closeRequested once every step is done, and never closes the mission', async () => {
    seed(missionOf({ steps: [settledStep()] }))
    const r = must(await requestClose(root, session(LEADER), { missionId: ID }))
    expect(r.deduped).toBe(false)
    const after = stored()
    expect(after.closeRequested).toEqual({ at: r.closeRequested.at })
    expect(after.status).toBe('open')
    expect(after).not.toHaveProperty('closedAs')
    expect(after).not.toHaveProperty('closeReason')

    // Asking again keeps the first request.
    const again = must(await requestClose(root, session(LEADER), { missionId: ID }))
    expect(again.deduped).toBe(true)
    expect(stored().closeRequested?.at).toBe(r.closeRequested.at)
  })

  it("is the leader's, and a closed mission takes none", async () => {
    seed(missionOf({ steps: [settledStep()] }))
    expect(codeOf(await requestClose(root, session(BUILDER), { missionId: ID }))).toBe('NOT_LEADER')
    expect(stored()).not.toHaveProperty('closeRequested')
    rmSync(v4Dir(), { recursive: true })
    seed(missionOf({ steps: [settledStep()], status: 'closed', closedAs: 'delivered' }))
    expect(codeOf(await requestClose(root, session(LEADER), { missionId: ID }))).toBe(
      'MISSION_CLOSED'
    )
  })

  it("never closes: a session that tries through the write path is refused, the operator's close is not (the door is S-15's)", async () => {
    seed(missionOf({ steps: [settledStep(), missionOf().steps[1]] }))
    const close = (record: MissionV4, log: string) => ({
      record: { ...record, status: 'closed' as const, closedAs: 'delivered' as const },
      log
    })
    const bySession = await writeMission(root, ID, session(LEADER), 'lead', close)
    expect(codeOf(bySession)).toBe('OPERATOR_ONLY')
    expect(stored().status).toBe('open')
    // Open steps are no reason to refuse the operator: the guarded path the door uses takes it.
    const byOperator = await writeMission(root, ID, operator, 'operator', close)
    expect(byOperator.ok).toBe(true)
    expect(stored().status).toBe('closed')
  })
})

// ---------------------------------------------------------------------------------------------
// AC-22 (each write path of this slice)

describe('no state verb touches a v3 file', () => {
  const walk = (dir: string, sub = ''): Record<string, string> => {
    const out: Record<string, string> = {}
    if (!existsSync(path.join(dir, sub))) return out
    for (const e of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, e.name)
      if (e.isDirectory()) Object.assign(out, walk(dir, rel))
      else {
        const abs = path.join(dir, rel)
        out[rel] = `${sha(readFileSync(abs))}@${statSync(abs).mtimeMs}`
      }
    }
    return out
  }
  const v3Snapshot = (): unknown => ({
    missions: walk(path.join(root, '.harnu', 'missions')),
    campaigns: walk(path.join(root, '.harnu', 'campaigns'))
  })

  it('leaves the bytes, the hash and the mtime of every v3 mission and campaign as they were', async () => {
    cpSync(path.join(FIXTURES, 'missions'), path.join(root, '.harnu', 'missions'), {
      recursive: true
    })
    cpSync(path.join(FIXTURES, 'campaigns'), path.join(root, '.harnu', 'campaigns'), {
      recursive: true
    })
    const before = v3Snapshot()
    const ids = [
      ...readdirSync(path.join(root, '.harnu', 'missions')).map((n) => n.slice(0, 12)),
      ...readdirSync(path.join(root, '.harnu', 'campaigns')).map((n) => n.slice(0, 12))
    ]
    let wrote = 0
    for (const id of ids) {
      // A session the mission does not know: refused, and it may ask to attach.
      expect(
        (
          await setBlocker(root, session(OUTSIDER), {
            missionId: id,
            reason: REASON,
            owner: 'agent'
          })
        ).ok
      ).toBe(false)
      const read = await readMissionRecord(root, id)
      if (!read.ok) throw new Error(read.error)
      // An open mission takes the request; a closed one refuses it, and writes nothing either way.
      const asked = await askToAttach(root, session(OUTSIDER), { missionId: id })
      expect(asked.ok, id).toBe(read.record.status === 'open')
      const leader = leaderOf(read.record)
      if (leader === null || read.record.status !== 'open') continue
      const as = session(leader)
      const first = read.record.steps[0]
      const set = await setBlocker(root, as, { missionId: id, reason: REASON, owner: 'agent' })
      expect(set.ok, `blocker on ${id}`).toBe(true)
      if (set.ok) {
        expect((await clearBlocker(root, as, { missionId: id, blockerId: set.blockerId })).ok).toBe(
          true
        )
      }
      expect(
        (
          await stageDoneWhen(root, as, {
            missionId: id,
            doneWhen: 'A different end for this mission',
            reason: 'It changed'
          })
        ).ok,
        `done when on ${id}`
      ).toBe(true)
      if (first?.acs[0]) {
        await settleCriterion(root, as, {
          missionId: id,
          stepId: first.id,
          criterionId: first.acs[0].id,
          evidence: 'Looked at it'
        })
      }
      await requestClose(root, as, { missionId: id })
      wrote++
    }
    expect(wrote).toBeGreaterThan(0)
    expect(v3Snapshot()).toEqual(before)
  })
})
