/**
 * Missions v4 · S-15 · AC-37 — the operator doors.
 *
 * The doors are the operator's: mark a criterion, clear a blocker, approve a staged Done when, close as
 * delivered or discarded, allow or deny an attach request. None of them refuses the operator: open
 * matters at close are warnings returned to the caller. Each writes through S-11's one write path with
 * the operator as the actor and leaves one entry in the mission's Log; none modifies a v3 file.
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
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildMissionRecordContent,
  type AttachRequest,
  type MissionV4
} from '../src/main/missions/model'
import {
  approveDoneWhen,
  clearBlocker,
  closeMission,
  closeWarningsOf,
  decideAttachRequest,
  markCriterion,
  runDoor
} from '../src/main/missions/doors'
import { writeMission } from '../src/main/missions/write'
import { readMissionRecord } from '../src/main/missions/record-store'

const FIXTURES = path.join(__dirname, 'fixtures', 'missions-v4-compat')

const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const ASKER = 'a5a5a5a5-0000-4000-8000-0000000000a5'
const ID = 'mnt-d0000001'
const AT = '2026-11-14T12:00:00.000Z'
const NOW = '2026-11-14T10:00:00Z'

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

const pending = (id: string, sessionId = ASKER): AttachRequest => ({
  id,
  missionId: ID,
  sessionId,
  at: NOW,
  decision: null
})

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
        title: 'Check the layout with the designer',
        acs: [
          { id: 'ac-1', text: 'The layout is confirmed', by: 'operator' },
          { id: 'ac-2', text: 'The designer signed off', by: 'person', person: 'the designer' },
          { id: 'ac-3', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }
        ],
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
      },
      {
        id: 'stp-2',
        title: 'Load the test files',
        acs: [{ id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }],
        links: [],
        blockers: []
      }
    ],
    sessions: [{ id: LEADER, role: 'leads', from: NOW, to: null }],
    links: [],
    blockers: [
      {
        id: 'blk-2',
        reason: 'The staging key is missing from the vault',
        ask: 'Add the staging key to the vault',
        unblocks: 'The deploy',
        owner: 'operator'
      }
    ],
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

const headings = (log: string): string[] => log.split('\n').filter((l) => l.startsWith('### '))

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-doors-v4-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the operator doors', () => {
  describe('mark a criterion', () => {
    it('an operator criterion is settled in the operator’s name, with one Log entry', async () => {
      seed(missionOf())
      const r = await markCriterion(root, ID, { stepId: 'stp-1', criterionId: 'ac-1', at: AT })
      expect(r.ok).toBe(true)
      const { record, log } = await reread()
      expect(record.steps[0].acs[0].settled).toEqual({ at: AT, by: 'operator' })
      expect(headings(log).filter((h) => h.includes(AT))).toHaveLength(1)
      expect(log).toMatch(/operator marked .*ac-1/)
    })

    it('a criterion for another person records who approved, still in the operator’s name', async () => {
      seed(missionOf())
      await markCriterion(root, ID, { stepId: 'stp-1', criterionId: 'ac-2', at: AT })
      const { record } = await reread()
      expect(record.steps[0].acs[1].settled).toEqual({
        at: AT,
        by: 'operator',
        person: 'the designer'
      })
    })

    it('carries the evidence the operator gave', async () => {
      seed(missionOf())
      await markCriterion(root, ID, {
        stepId: 'stp-1',
        criterionId: 'ac-1',
        evidence: 'checked on staging',
        at: AT
      })
      const { record } = await reread()
      expect(record.steps[0].acs[0].settled?.evidence).toBe('checked on staging')
    })

    it('marking twice keeps the first stamp and writes nothing the second time', async () => {
      seed(missionOf())
      await markCriterion(root, ID, { stepId: 'stp-1', criterionId: 'ac-1', at: AT })
      const before = readFileSync(path.join(v4Dir(), v4Files()[0]), 'utf8')
      const again = await markCriterion(root, ID, {
        stepId: 'stp-1',
        criterionId: 'ac-1',
        at: '2026-11-14T13:00:00.000Z'
      })
      expect(again.ok).toBe(true)
      if (again.ok) expect(again.changed).toBe(false)
      expect(readFileSync(path.join(v4Dir(), v4Files()[0]), 'utf8')).toBe(before)
    })

    it('a criterion a fact settles is never ticked by hand, and says so', async () => {
      seed(missionOf())
      const before = readFileSync(path.join(v4Dir(), v4Files()[0]), 'utf8')
      const r = await markCriterion(root, ID, { stepId: 'stp-1', criterionId: 'ac-3', at: AT })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('SETTLES_ITSELF')
      expect(readFileSync(path.join(v4Dir(), v4Files()[0]), 'utf8')).toBe(before)
    })

    it('an unknown step or criterion is NOT_FOUND and writes nothing', async () => {
      seed(missionOf())
      const before = readFileSync(path.join(v4Dir(), v4Files()[0]), 'utf8')
      for (const [stepId, criterionId] of [
        ['stp-9', 'ac-1'],
        ['stp-1', 'ac-9']
      ]) {
        const r = await markCriterion(root, ID, { stepId, criterionId, at: AT })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.code).toBe('NOT_FOUND')
      }
      expect(readFileSync(path.join(v4Dir(), v4Files()[0]), 'utf8')).toBe(before)
    })

    it('an old step id from a converted record finds its new step and names it', async () => {
      seed(missionOf({ legacyV3: { stepIds: { 'stp-7': 'stp-1', 'stp-8': 'stp-77' } } }))
      const r = await markCriterion(root, ID, { stepId: 'stp-7', criterionId: 'ac-1', at: AT })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.stepId).toBe('stp-1')
      expect((await reread()).record.steps[0].acs[0].settled?.by).toBe('operator')
      // The old id points at a step the record no longer has: not found, not a guess.
      const gone = await markCriterion(root, ID, { stepId: 'stp-8', criterionId: 'ac-1', at: AT })
      expect(gone.ok).toBe(false)
      if (!gone.ok) expect(gone.code).toBe('NOT_FOUND')
    })
  })

  describe('clear a blocker', () => {
    it('clears a step blocker and a mission blocker, each with one Log entry', async () => {
      seed(missionOf())
      const step = await clearBlocker(root, ID, { blockerId: 'blk-1', stepId: 'stp-1', at: AT })
      expect(step.ok).toBe(true)
      const mission = await clearBlocker(root, ID, { blockerId: 'blk-2', at: AT })
      expect(mission.ok).toBe(true)
      const { record, log } = await reread()
      expect(record.steps[0].blockers).toEqual([])
      expect(record.blockers).toEqual([])
      expect(headings(log).filter((h) => h.includes('cleared blocker'))).toHaveLength(2)
    })

    it('finds the blocker without the step when only one place holds it', async () => {
      seed(missionOf())
      const r = await clearBlocker(root, ID, { blockerId: 'blk-1', at: AT })
      expect(r.ok).toBe(true)
      expect((await reread()).record.steps[0].blockers).toEqual([])
    })

    it('a blocker that is already gone is a no-op, an unknown one is NOT_FOUND', async () => {
      seed(missionOf())
      await clearBlocker(root, ID, { blockerId: 'blk-2', at: AT })
      const again = await clearBlocker(root, ID, { blockerId: 'blk-2', at: AT })
      expect(again.ok).toBe(false)
      if (!again.ok) expect(again.code).toBe('NOT_FOUND')
    })
  })

  describe('approve a staged Done when', () => {
    const staged = { text: 'Every candidate sees a score report and can download it', at: NOW }

    it('replaces Done when, clears the staging and the old verification, with one Log entry', async () => {
      seed(
        missionOf({
          doneWhenVerified: { by: 'operator', at: NOW },
          ...({ pendingDoneWhen: staged } as object)
        })
      )
      const r = await approveDoneWhen(root, ID, { at: AT })
      expect(r.ok).toBe(true)
      const { record, log } = await reread()
      expect(record.doneWhen).toBe(staged.text)
      expect(record.doneWhenVerified).toBeUndefined()
      expect('pendingDoneWhen' in record).toBe(false)
      expect(headings(log).filter((h) => h.includes('approved a new Done when'))).toHaveLength(1)
    })

    it('with nothing staged it changes nothing and says so', async () => {
      seed(missionOf())
      const before = readFileSync(path.join(v4Dir(), v4Files()[0]), 'utf8')
      const r = await approveDoneWhen(root, ID, { at: AT })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.changed).toBe(false)
      expect(readFileSync(path.join(v4Dir(), v4Files()[0]), 'utf8')).toBe(before)
    })
  })

  describe('close as delivered or discarded', () => {
    it('closes as delivered with the reason, and the Log says who and how', async () => {
      seed(missionOf())
      const r = await closeMission(root, ID, { closedAs: 'delivered', reason: 'shipped', at: AT })
      expect(r.ok).toBe(true)
      const { record, log } = await reread()
      expect(record.status).toBe('closed')
      expect(record.closedAs).toBe('delivered')
      expect(record.closeReason).toBe('shipped')
      expect(
        headings(log).filter((h) => h.includes('closed the mission as delivered'))
      ).toHaveLength(1)
    })

    it('closes as discarded', async () => {
      seed(missionOf())
      await closeMission(root, ID, { closedAs: 'discarded', at: AT })
      const { record, log } = await reread()
      expect(record.closedAs).toBe('discarded')
      expect(record.closeReason).toBeUndefined()
      expect(log).toContain('as discarded')
    })

    it('open matters come back as warnings, never as a refusal', async () => {
      seed(
        missionOf({
          attachRequests: [pending('atr-1')],
          ...({ pendingDoneWhen: { text: 'x', at: NOW } } as object)
        })
      )
      const r = await closeMission(root, ID, { closedAs: 'delivered', at: AT })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const kinds = r.warnings.map((w) => w.kind).sort()
      expect(kinds).toEqual(
        ['attach-requests', 'open-blockers', 'staged-done-when', 'unfinished-steps'].sort()
      )
      expect((await reread()).record.status).toBe('closed')
    })

    it('a warning counts what is open and carries its own words', () => {
      const w = closeWarningsOf(missionOf())
      const unfinished = w.find((x) => x.kind === 'unfinished-steps')
      expect(unfinished?.count).toBe(2)
      expect(unfinished?.text).toBe('2 steps are not done')
      expect(w.find((x) => x.kind === 'open-blockers')?.count).toBe(2)
      expect(closeWarningsOf(missionOf({ steps: [], blockers: [] }))).toEqual([])
    })

    it('an optional step that is not done is not a warning', () => {
      const m = missionOf({ blockers: [] })
      m.steps = m.steps.map((s) => ({ ...s, optional: true, blockers: [] }))
      expect(closeWarningsOf(m)).toEqual([])
    })

    it('closing a closed mission changes nothing', async () => {
      seed(missionOf({ status: 'closed', closedAs: 'delivered' }))
      const before = readFileSync(path.join(v4Dir(), v4Files()[0]), 'utf8')
      const r = await closeMission(root, ID, { closedAs: 'discarded', at: AT })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.changed).toBe(false)
      expect(readFileSync(path.join(v4Dir(), v4Files()[0]), 'utf8')).toBe(before)
    })
  })

  describe('allow or deny an attach request', () => {
    it('allow attaches the asker as a worker and records the decision', async () => {
      seed(missionOf({ attachRequests: [pending('atr-1')] }))
      const r = await decideAttachRequest(root, ID, {
        requestId: 'atr-1',
        decision: 'allowed',
        at: AT
      })
      expect(r.ok).toBe(true)
      const { record, log } = await reread()
      expect(record.attachRequests?.[0]).toMatchObject({ decision: 'allowed', decidedAt: AT })
      expect(record.sessions.at(-1)).toMatchObject({
        id: ASKER,
        role: 'worked',
        from: AT,
        to: null
      })
      expect(headings(log).filter((h) => h.includes('allowed'))).toHaveLength(1)
    })

    it('deny records the decision and attaches nothing', async () => {
      seed(missionOf({ attachRequests: [pending('atr-1')] }))
      await decideAttachRequest(root, ID, { requestId: 'atr-1', decision: 'denied', at: AT })
      const { record, log } = await reread()
      expect(record.attachRequests?.[0]).toMatchObject({ decision: 'denied', decidedAt: AT })
      expect(record.sessions.map((s) => s.id)).toEqual([LEADER])
      expect(log).toContain('denied')
    })

    it('a request already decided keeps its first decision', async () => {
      seed(missionOf({ attachRequests: [pending('atr-1')] }))
      await decideAttachRequest(root, ID, { requestId: 'atr-1', decision: 'denied', at: AT })
      const again = await decideAttachRequest(root, ID, {
        requestId: 'atr-1',
        decision: 'allowed',
        at: '2026-11-14T13:00:00.000Z'
      })
      expect(again.ok).toBe(true)
      if (again.ok) expect(again.changed).toBe(false)
      const { record } = await reread()
      expect(record.attachRequests?.[0].decision).toBe('denied')
      expect(record.sessions.map((s) => s.id)).toEqual([LEADER])
    })

    it('an unknown request is NOT_FOUND', async () => {
      seed(missionOf())
      const r = await decideAttachRequest(root, ID, {
        requestId: 'atr-9',
        decision: 'allowed',
        at: AT
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('NOT_FOUND')
    })
  })

  describe('the IPC entry', () => {
    it('routes a door by name and refuses an unknown one as BAD_ARGS', async () => {
      seed(missionOf())
      const ok = await runDoor({
        door: 'mark',
        folder: root,
        missionId: ID,
        stepId: 'stp-1',
        criterionId: 'ac-1'
      })
      expect(ok.ok).toBe(true)
      for (const bad of [
        null,
        'mark',
        { door: 'explode', folder: root, missionId: ID },
        { door: 'mark' }
      ]) {
        const r = await runDoor(bad)
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.code).toBe('BAD_ARGS')
      }
    })
  })
})

/**
 * The "never" clause: a door never refuses the operator. Each door is driven where a session would be
 * refused (a closed mission, no session attached, the leader released, open matters everywhere); a
 * refusal added to any door turns this red.
 */
describe('doors never refuse', () => {
  const scenarios: Record<string, () => MissionV4> = {
    'a closed mission': () =>
      missionOf({ status: 'closed', closedAs: 'delivered', attachRequests: [pending('atr-1')] }),
    'a mission no session is attached to': () =>
      missionOf({ sessions: [], attachRequests: [pending('atr-1')] }),
    'a mission whose leader was released': () =>
      missionOf({
        sessions: [{ id: LEADER, role: 'leads', from: NOW, to: '2026-11-14T11:00:00Z' }],
        attachRequests: [pending('atr-1')]
      }),
    'a mission with open matters everywhere': () =>
      missionOf({
        attachRequests: [pending('atr-1')],
        ...({ pendingDoneWhen: { text: 'Another end', at: NOW } } as object)
      })
  }

  for (const [name, make] of Object.entries(scenarios)) {
    it(`every door answers ok on ${name}`, async () => {
      seed(make())
      const results = [
        await markCriterion(root, ID, { stepId: 'stp-1', criterionId: 'ac-1', at: AT }),
        await markCriterion(root, ID, { stepId: 'stp-1', criterionId: 'ac-2', at: AT }),
        await clearBlocker(root, ID, { blockerId: 'blk-1', stepId: 'stp-1', at: AT }),
        await clearBlocker(root, ID, { blockerId: 'blk-2', at: AT }),
        await approveDoneWhen(root, ID, { at: AT }),
        await decideAttachRequest(root, ID, { requestId: 'atr-1', decision: 'allowed', at: AT }),
        await closeMission(root, ID, { closedAs: 'delivered', at: AT })
      ]
      results.forEach((r, i) => expect(r.ok, `door ${i}: ${r.ok ? '' : r.error}`).toBe(true))
    })
  }

  it('discarding with open matters and a staged Done when is also never refused', async () => {
    seed(
      missionOf({
        attachRequests: [pending('atr-1')],
        ...({ pendingDoneWhen: { text: 'Another end', at: NOW } } as object)
      })
    )
    const r = await closeMission(root, ID, { closedAs: 'discarded', reason: 'not needed', at: AT })
    expect(r.ok).toBe(true)
    expect((await reread()).record.closedAs).toBe('discarded')
  })

  it('a session never holds a door: the same write as a session is OPERATOR_ONLY', async () => {
    seed(missionOf())
    const r = await writeMission(
      root,
      ID,
      { kind: 'session', sessionId: LEADER },
      'operator',
      (rec, log) => ({
        record: rec,
        log
      })
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('OPERATOR_ONLY')
  })
})

describe('the doors leave a v3 file as it was', () => {
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

  async function converted(): Promise<MissionV4> {
    const r = await readMissionRecord(root, V3_ID)
    if (!r.ok) throw new Error(r.error)
    return r.record
  }

  it('mark, clear and decide an attach request each write a v4 record and no v3 byte', async () => {
    const before = v3Hashes()
    const rec = await converted()
    const target = rec.steps
      .flatMap((s) => s.acs.map((a) => ({ s, a })))
      .find(({ a }) => (a.by === 'operator' || a.by === 'person') && !a.settled)
    expect(target, 'the fixture has an unsettled human criterion').toBeDefined()

    const marked = await markCriterion(root, V3_ID, {
      stepId: target!.s.id,
      criterionId: target!.a.id,
      at: AT
    })
    expect(marked.ok).toBe(true)
    expect(v3Hashes()).toEqual(before)
    expect(v4Files().some((n) => n.startsWith(V3_ID))).toBe(true)

    const blocker = rec.blockers[0]
    const cleared = await clearBlocker(root, V3_ID, { blockerId: blocker.id, at: AT })
    expect(cleared.ok).toBe(true)
    expect(v3Hashes()).toEqual(before)

    const asked = await writeMission(root, V3_ID, { kind: 'operator' }, 'operator', (r, log) => ({
      record: { ...r, attachRequests: [{ ...pending('atr-1'), missionId: V3_ID }] },
      log
    }))
    expect(asked.ok).toBe(true)
    const decided = await decideAttachRequest(root, V3_ID, {
      requestId: 'atr-1',
      decision: 'allowed',
      at: AT
    })
    expect(decided.ok).toBe(true)
    expect(v3Hashes()).toEqual(before)
  })

  it('approve a Done when and close write a v4 record and no v3 byte', async () => {
    const before = v3Hashes()
    const staged = await writeMission(root, V3_ID, { kind: 'operator' }, 'operator', (r, log) => ({
      record: {
        ...r,
        ...({ pendingDoneWhen: { text: 'A new end', at: NOW } } as object)
      } as MissionV4,
      log
    }))
    expect(staged.ok).toBe(true)
    expect((await approveDoneWhen(root, V3_ID, { at: AT })).ok).toBe(true)
    expect((await closeMission(root, V3_ID, { closedAs: 'delivered', at: AT })).ok).toBe(true)
    expect(v3Hashes()).toEqual(before)
    const { record, log } = await reread(V3_ID)
    expect(record.doneWhen).toBe('A new end')
    expect(record.status).toBe('closed')
    expect(log).toContain('operator')
  })
})
