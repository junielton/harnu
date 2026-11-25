/**
 * Session evidence reaches the mission, S-1 (AC-1..AC-6): claims on the record and the Accept door.
 *
 * A claim is a session's evidence for a criterion that is still open. It is stored in the criterion's
 * `selfCheck { at, by, evidence }` (the stamps older builds wrote there are claims too, D-5): it never
 * settles anything. The operator's `acceptClaim` / `acceptClaims` doors settle it in the operator's name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({ writes: 0 }))

// The one write path, counted: "accept all" is one write, not one per criterion.
vi.mock('../src/main/missions/write', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/missions/write')>()
  return {
    ...real,
    writeMission: (...a: Parameters<typeof real.writeMission>) => {
      h.writes++
      return real.writeMission(...a)
    }
  }
})

import {
  buildMissionRecordContent,
  parseMissionRecordFile,
  readMissionRecordLog,
  type MissionV4
} from '../src/main/missions/model'
import type { Actor } from '../src/main/missions/guard'
import { criterionSettlement } from '../src/main/missions/state'
import { settleCriterion } from '../src/main/missions/verbs-state'
import { acceptClaim, acceptClaims, markCriterion, runDoor } from '../src/main/missions/doors'
import { missionGet } from '../src/main/missions/verbs-read'

const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const BUILDER = '8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d'
const VERIFIER = 'c4e6a8b0-5d7f-4c9a-a1b3-6e8a0c2e4f60'
const OUTSIDER = 'e0e0e0e0-0000-4000-8000-000000000001'

const ID = 'mnt-cc000001'
const NOW = '2026-11-14T10:00:00Z'

const session = (sessionId: string): Actor => ({ kind: 'session', sessionId })

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
        acs: [{ id: 'ac-1', text: 'The report opens on a phone', by: 'operator' }],
        links: [],
        blockers: []
      }
    ],
    sessions: [
      { id: LEADER, role: 'leads', from: NOW, to: null },
      { id: BUILDER, role: 'worked', from: NOW, to: null },
      { id: VERIFIER, role: 'worked', from: NOW, to: null }
    ],
    links: [],
    blockers: [],
    ...over
  }
}

let root = ''
const v4Dir = (): string => path.join(root, '.harnu', 'missions-v4')
const fileOf = (): string =>
  path.join(v4Dir(), readdirSync(v4Dir()).filter((n) => n.endsWith('.md'))[0])

function seed(record: MissionV4 = missionOf()): void {
  mkdirSync(v4Dir(), { recursive: true })
  writeFileSync(
    path.join(v4Dir(), `${record.id}-score-report.md`),
    buildMissionRecordContent(record, '# Log\n')
  )
}

const bytes = (): string => readFileSync(fileOf(), 'utf8')
const stored = (): MissionV4 => {
  const parsed = parseMissionRecordFile(bytes())
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed
}
const storedLog = (): string => readMissionRecordLog(bytes())
const criterion = (
  stepId: string,
  criterionId: string
): MissionV4['steps'][number]['acs'][number] =>
  stored()
    .steps.find((s) => s.id === stepId)!
    .acs.find((c) => c.id === criterionId)!

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`)
  return r as Extract<T, { ok: true }>
}

const claim = (
  who: string,
  stepId: string,
  criterionId: string,
  evidence: string
): ReturnType<typeof settleCriterion> =>
  settleCriterion(root, session(who), { missionId: ID, stepId, criterionId, evidence })

const SEEN = 'Opened the page at 390px and read the whole report'

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-claims-'))
  h.writes = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('mission_settle_ac records claims', () => {
  it('operator criterion takes a claim', async () => {
    seed()
    const r = must(await claim(VERIFIER, 'stp-1', 'ac-3', SEEN))
    expect(r.outcome).toBe('claimed')
    expect(r).toMatchObject({ stepId: 'stp-1', criterionId: 'ac-3' })
    const ac = criterion('stp-1', 'ac-3')
    expect(ac.selfCheck).toMatchObject({ by: VERIFIER, evidence: SEEN })
    expect(Number.isNaN(Date.parse(ac.selfCheck!.at))).toBe(false)
    expect(ac).not.toHaveProperty('settled')
    expect(criterionSettlement(ac, stored().steps[0], {}).settled).toBe(false)
    expect(storedLog()).toContain(
      `"Load the test files": a session claims "The operator likes the layout" is done; it stays open. Evidence: ${SEEN}`
    )
    expect(storedLog()).not.toContain(VERIFIER)

    // the builder of the step and the leader claim it the same way: an operator criterion is never theirs to settle
    for (const who of [BUILDER, LEADER]) {
      expect(must(await claim(who, 'stp-1', 'ac-3', SEEN)).outcome).toBe('claimed')
    }
    expect(criterion('stp-1', 'ac-3')).not.toHaveProperty('settled')

    // only an attached session claims
    expect(await claim(OUTSIDER, 'stp-1', 'ac-3', SEEN)).toMatchObject({
      ok: false,
      code: 'NOT_ATTACHED'
    })
  })

  it('a builder claims and does not settle', async () => {
    seed()
    const r = must(await claim(BUILDER, 'stp-1', 'ac-1', 'Ran the suite: 40 green'))
    expect(r.outcome).toBe('claimed')
    const ac = criterion('stp-1', 'ac-1')
    expect(ac.selfCheck).toMatchObject({ by: BUILDER, evidence: 'Ran the suite: 40 green' })
    expect(ac).not.toHaveProperty('settled')
    expect(criterionSettlement(ac, stored().steps[0], {}).settled).toBe(false)

    // a second session still settles it, as before
    expect(must(await claim(VERIFIER, 'stp-1', 'ac-1', 'Read every file')).outcome).toBe('settled')
    expect(criterion('stp-1', 'ac-1').settled).toMatchObject({ by: VERIFIER })
  })

  it('refusals', async () => {
    seed()
    const before = bytes()
    for (const criterionId of ['ac-1', 'ac-3']) {
      expect(await claim(BUILDER, 'stp-1', criterionId, '  ')).toMatchObject({
        ok: false,
        code: 'BAD_ARGS'
      })
    }
    const fact = await claim(VERIFIER, 'stp-1', 'ac-2', SEEN)
    expect(fact).toMatchObject({ ok: false, code: 'SETTLE_NOT_ALLOWED' })
    expect((fact as { error: string }).error).toContain('Harnu reads that fact itself')
    // D-2: another person's approval takes no claim
    expect(await claim(VERIFIER, 'stp-1', 'ac-4', SEEN)).toMatchObject({
      ok: false,
      code: 'SETTLE_NOT_ALLOWED'
    })
    expect(bytes()).toBe(before)

    // nothing is claimed on a criterion that is already settled
    must(await markCriterion(root, ID, { stepId: 'stp-1', criterionId: 'ac-3' }))
    expect(await claim(VERIFIER, 'stp-1', 'ac-3', SEEN)).toMatchObject({
      ok: false,
      code: 'ALREADY_SETTLED'
    })
    expect(criterion('stp-1', 'ac-3')).not.toHaveProperty('selfCheck')
  })

  it('a newer claim replaces', async () => {
    seed()
    must(await claim(BUILDER, 'stp-1', 'ac-3', 'First look: the table overflows'))
    must(await claim(VERIFIER, 'stp-1', 'ac-3', 'Second look: the table fits'))
    expect(criterion('stp-1', 'ac-3').selfCheck).toMatchObject({
      by: VERIFIER,
      evidence: 'Second look: the table fits'
    })
    expect(storedLog()).toContain('First look: the table overflows')
    expect(storedLog()).toContain('Second look: the table fits')
  })
})

describe('the operator accepts a claim', () => {
  it('accept settles as the operator', async () => {
    seed()
    const long = `Saw it work.\n\n${'x'.repeat(600)}`
    must(await claim(VERIFIER, 'stp-1', 'ac-3', long))
    const logBefore = storedLog()

    const r = must(await acceptClaim(root, ID, { stepId: 'stp-1', criterionId: 'ac-3' }))
    expect(r).toMatchObject({ changed: true, stepId: 'stp-1', criterionId: 'ac-3' })
    const ac = criterion('stp-1', 'ac-3')
    const cut = `Saw it work. ${'x'.repeat(600)}`.slice(0, 400)
    expect(ac.settled).toMatchObject({
      by: 'operator',
      evidence: `Accepted ${VERIFIER.slice(0, 8)}'s claim: ${cut}`
    })
    expect(criterionSettlement(ac, stored().steps[0], {})).toEqual({
      settled: true,
      via: 'operator'
    })
    const added = storedLog().slice(logBefore.length)
    expect(added.match(/^### /gm)).toHaveLength(1)
    expect(added).toContain(
      `operator accepted a session's claim: "The operator likes the layout" on "Load the test files"`
    )

    // a double click changes nothing
    const after = bytes()
    expect(
      must(await acceptClaim(root, ID, { stepId: 'stp-1', criterionId: 'ac-3' })).changed
    ).toBe(false)
    expect(bytes()).toBe(after)
  })

  it("accepting a builder's claim on a session criterion settles it", async () => {
    seed()
    must(await claim(BUILDER, 'stp-1', 'ac-1', 'Ran the suite'))
    must(await acceptClaim(root, ID, { stepId: 'stp-1', criterionId: 'ac-1' }))
    expect(criterionSettlement(criterion('stp-1', 'ac-1'), stored().steps[0], {})).toEqual({
      settled: true,
      via: 'operator'
    })
  })

  it('takes a selfCheck stamp an older build wrote as a claim (D-5), but none on a person criterion (D-2)', async () => {
    const stamp = { at: NOW, by: BUILDER, evidence: 'Claimed before the upgrade' }
    const record = missionOf()
    record.steps[0].acs[2] = { ...record.steps[0].acs[2], selfCheck: stamp }
    record.steps[0].acs[3] = { ...record.steps[0].acs[3], selfCheck: stamp }
    seed(record)
    expect(await acceptClaim(root, ID, { stepId: 'stp-1', criterionId: 'ac-4' })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND'
    })
    must(await acceptClaim(root, ID, { stepId: 'stp-1', criterionId: 'ac-3' }))
    expect(criterion('stp-1', 'ac-3').settled?.evidence).toBe(
      `Accepted ${BUILDER.slice(0, 8)}'s claim: Claimed before the upgrade`
    )
    expect(criterion('stp-1', 'ac-4')).not.toHaveProperty('settled')
  })

  it('refuses what has no claim: an unclaimed criterion, a fact, an unknown one', async () => {
    seed()
    const before = bytes()
    expect(await acceptClaim(root, ID, { stepId: 'stp-1', criterionId: 'ac-3' })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND'
    })
    expect(await acceptClaim(root, ID, { stepId: 'stp-1', criterionId: 'ac-2' })).toMatchObject({
      ok: false,
      code: 'SETTLES_ITSELF'
    })
    expect(await acceptClaim(root, ID, { stepId: 'stp-9', criterionId: 'ac-1' })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND'
    })
    expect(await acceptClaims(root, ID, { stepId: 'stp-9' })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND'
    })
    expect(bytes()).toBe(before)
  })

  /** Claims on stp-1 ac-1 and ac-3, and on stp-2 ac-1. */
  async function threeClaims(): Promise<void> {
    seed()
    must(await claim(BUILDER, 'stp-1', 'ac-1', 'Ran the suite'))
    must(await claim(VERIFIER, 'stp-1', 'ac-3', 'The layout fits'))
    must(await claim(VERIFIER, 'stp-2', 'ac-1', 'Opened it on a phone'))
  }

  it('accept all in one write', async () => {
    await threeClaims()
    // settled in between: the operator (or a walk) marked one before the click landed
    must(await markCriterion(root, ID, { stepId: 'stp-1', criterionId: 'ac-3', evidence: 'mine' }))
    const first = criterion('stp-1', 'ac-3').settled
    const logBefore = storedLog()
    h.writes = 0

    const r = must(await acceptClaims(root, ID, {}))
    expect(h.writes).toBe(1)
    expect(r.changed).toBe(true)
    expect(r.accepted).toEqual([
      { stepId: 'stp-1', criterionId: 'ac-1' },
      { stepId: 'stp-2', criterionId: 'ac-1' }
    ])
    expect(criterion('stp-1', 'ac-1').settled?.by).toBe('operator')
    expect(criterion('stp-2', 'ac-1').settled?.by).toBe('operator')
    expect(criterion('stp-1', 'ac-3').settled).toEqual(first)
    expect(criterion('stp-1', 'ac-4')).not.toHaveProperty('settled')
    // one Log line per accepted criterion, each naming its step and criterion
    const added = storedLog().slice(logBefore.length)
    expect(added.match(/^### /gm)).toHaveLength(2)
    expect(added).toContain('"A reviewer reads every changed file" on "Load the test files"')
    expect(added).toContain('"The report opens on a phone" on "Render the report"')

    const after = bytes()
    const again = must(await acceptClaims(root, ID, {}))
    expect(again).toMatchObject({ changed: false, accepted: [] })
    expect(bytes()).toBe(after)
  })

  it('accepts the claims of one step only when the step is named', async () => {
    await threeClaims()
    const r = must(await acceptClaims(root, ID, { stepId: 'stp-2' }))
    expect(r.accepted).toEqual([{ stepId: 'stp-2', criterionId: 'ac-1' }])
    expect(criterion('stp-1', 'ac-1')).not.toHaveProperty('settled')
    expect(criterion('stp-1', 'ac-3')).not.toHaveProperty('settled')
  })

  it('two accept-all clicks at once stamp each criterion once', async () => {
    await threeClaims()
    const [a, b] = await Promise.all([acceptClaims(root, ID, {}), acceptClaims(root, ID, {})])
    expect(must(a).accepted.length + must(b).accepted.length).toBe(3)
    expect(storedLog().match(/operator accepted a session's claim/g)).toHaveLength(3)
  })

  it('is reachable through runDoor, and a bad step id never widens to the whole mission', async () => {
    await threeClaims()
    const base = { folder: root, missionId: ID }
    for (const call of [
      { door: 'acceptClaim', stepId: 'stp-1' },
      { door: 'acceptClaim', criterionId: 'ac-1' },
      { door: 'acceptClaims', stepId: '' },
      { door: 'acceptClaims', stepId: 2 }
    ]) {
      expect(await runDoor({ ...base, ...call }), JSON.stringify(call)).toMatchObject({
        ok: false,
        code: 'BAD_ARGS'
      })
    }
    expect(criterion('stp-1', 'ac-1')).not.toHaveProperty('settled')
    expect(
      await runDoor({ ...base, door: 'acceptClaim', stepId: 'stp-1', criterionId: 'ac-1' })
    ).toMatchObject({ ok: true, changed: true })
    expect(await runDoor({ ...base, door: 'acceptClaims', stepId: 'stp-1' })).toMatchObject({
      ok: true,
      accepted: [{ stepId: 'stp-1', criterionId: 'ac-3' }]
    })
    expect(await runDoor({ ...base, door: 'acceptClaims' })).toMatchObject({
      ok: true,
      accepted: [{ stepId: 'stp-2', criterionId: 'ac-1' }]
    })
  })

  it('the read shows each open claim on its criterion: by, at and evidence', async () => {
    await threeClaims()
    must(await acceptClaim(root, ID, { stepId: 'stp-2', criterionId: 'ac-1' }))
    // missionGet's detail is what `mission:v4View` serves, with the operator as the reader
    const detail = must(await missionGet(root, { kind: 'operator' }, { missionId: ID }))
    const claims = detail.steps.flatMap((s) =>
      s.criteria.flatMap((c) => (c.claim ? [{ step: s.id, id: c.id, ...c.claim }] : []))
    )
    expect(claims).toEqual([
      {
        step: 'stp-1',
        id: 'ac-1',
        by: BUILDER,
        at: criterion('stp-1', 'ac-1').selfCheck!.at,
        evidence: 'Ran the suite'
      },
      {
        step: 'stp-1',
        id: 'ac-3',
        by: VERIFIER,
        at: criterion('stp-1', 'ac-3').selfCheck!.at,
        evidence: 'The layout fits'
      }
    ])
  })
})
