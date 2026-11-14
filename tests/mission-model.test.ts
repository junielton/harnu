/**
 * Missions v4 · S-6 · AC-9 — the v4 record: Mission, optional Milestone, Step, acceptance
 * criterion, session entry, blocker with an id, and the attach request.
 *
 * The record is one Markdown file with YAML frontmatter and an append-only Log (spec "The v4
 * record"). `src/main/missions/model.ts` is the schema every later slice imports, so these tests pin
 * the shape the spec's example gives, field for field.
 */
import { describe, expect, it } from 'vitest'
import {
  AttachRequestSchema,
  CriterionSchema,
  MilestoneSchema,
  MissionRecordSchema,
  SessionEntrySchema,
  StepSchema,
  BlockerSchema,
  FACTS,
  LINK_KINDS,
  LinkSchema,
  MILESTONE_STATES,
  MISSION_STATES,
  STEP_STATES,
  SettledSchema,
  StoppedAtSchema,
  type StepV4,
  type WithUnknownKeys,
  buildMissionRecordContent,
  parseMissionRecordFile,
  readMissionRecordLog
} from '../src/main/missions/model'

const AT = '2026-11-14T10:00:00Z'

/** The spec's example record (Design · The model), every field it shows. */
function fullRecord(): Record<string, unknown> {
  return {
    schemaVersion: 4,
    id: 'mnt-1a2b3c4d',
    title: 'Measure harnu:spec, then fix what the numbers show',
    doneWhen: 'A test set we trust scores harnu:spec, and two fixes are each proven by the score.',
    status: 'open',
    closeRequested: { at: AT },
    milestones: [
      { id: 'mls-1', title: 'A test set we can trust', optional: false, waitsFor: null }
    ],
    steps: [
      {
        id: 'stp-1',
        milestone: 'mls-1',
        title: 'Load the test files',
        card: 'T685-load-test-files',
        startedAt: '2026-11-13T09:30:00Z',
        acs: [
          { id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' },
          { id: 'ac-2', text: 'Every reviewer question has an answer', by: 'session' },
          {
            id: 'ac-3',
            text: 'The designer signed off',
            by: 'person',
            person: 'the designer',
            settled: { at: AT, by: 'operator', person: 'the designer' }
          }
        ],
        links: [
          { kind: 'pr', ref: '256' },
          { kind: 'url', ref: 'http://localhost:5173/score-report' }
        ],
        blockers: [
          {
            id: 'blk-1',
            reason:
              'This machine does not know where the private test files are. Set HARNU_CORPUS_DIR.',
            ask: 'Set HARNU_CORPUS_DIR to the private test folder',
            unblocks: 'The run starts',
            owner: 'operator',
            clearsWhen: 'pr-merged'
          }
        ],
        waitsFor: null
      }
    ],
    sessions: [
      {
        id: '11111111-2222-4333-8444-555555555555',
        role: 'leads',
        from: '2026-11-13T09:00:00Z',
        to: null,
        stoppedAt: null
      }
    ],
    links: [{ kind: 'doc', ref: 'docs/specs/example/spec.md' }],
    blockers: []
  }
}

/** The smallest valid mission: no milestones, one step with one criterion. */
function smallRecord(): Record<string, unknown> {
  return {
    schemaVersion: 4,
    id: 'mnt-0a0b0c0d',
    title: 'Fix the flaky sidebar test',
    doneWhen: 'The sidebar test passes ten runs in a row.',
    status: 'open',
    steps: [
      {
        id: 'stp-1',
        title: 'Find why the test flakes',
        acs: [{ id: 'ac-1', text: 'The cause is written in the Log', by: 'operator' }],
        links: [],
        blockers: []
      }
    ]
  }
}

describe('the v4 record', () => {
  it('a mission with no milestones is valid', () => {
    const parsed = MissionRecordSchema.safeParse(smallRecord())
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    // The small-task shape: nothing was invented for what the file left out.
    expect(parsed.data.milestones).toEqual([])
    expect(parsed.data.steps[0].milestone).toBeUndefined()
    expect(parsed.data.sessions).toEqual([])
    expect(parsed.data.links).toEqual([])
    expect(parsed.data.blockers).toEqual([])
  })

  it('a step may name no milestone and a milestone may have no steps (a later milestone is planned when it starts)', () => {
    const m = smallRecord()
    m.milestones = [
      { id: 'mls-1', title: 'A test set we can trust', optional: false, waitsFor: null }
    ]
    expect(MissionRecordSchema.safeParse(m).success).toBe(true)
  })

  it('the spec example parses with every field it shows', () => {
    const parsed = MissionRecordSchema.safeParse(fullRecord())
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toEqual(fullRecord())
  })

  it('refuses a record that is not schema 4', () => {
    expect(MissionRecordSchema.safeParse({ ...smallRecord(), schemaVersion: 3 }).success).toBe(
      false
    )
    const { schemaVersion: _drop, ...none } = smallRecord()
    expect(MissionRecordSchema.safeParse(none).success).toBe(false)
  })

  it('a milestone carries no criteria of its own: the schema refuses them', () => {
    const base = { id: 'mls-1', title: 'A test set we can trust', optional: false, waitsFor: null }
    expect(MilestoneSchema.safeParse(base).success).toBe(true)
    const withAcs = {
      ...base,
      acs: [{ id: 'ac-1', text: 'Every reviewer question has an answer', by: 'session' }]
    }
    expect(MilestoneSchema.safeParse(withAcs).success).toBe(false)
    expect(MilestoneSchema.safeParse({ ...base, criteria: [] }).success).toBe(false)
    // And it is refused when the milestone sits inside a mission.
    const m = smallRecord()
    m.milestones = [withAcs]
    expect(MissionRecordSchema.safeParse(m).success).toBe(false)
  })

  it('a milestone may wait for another and be optional', () => {
    const ok = MilestoneSchema.safeParse({
      id: 'mls-3',
      title: 'Fixes proven by the score',
      optional: true,
      waitsFor: 'mls-2'
    })
    expect(ok.success).toBe(true)
  })

  it('every id keeps its shape: mnt-, mls-, stp-, ac-, blk-', () => {
    expect(MissionRecordSchema.safeParse({ ...smallRecord(), id: 'mission-1' }).success).toBe(false)
    expect(MissionRecordSchema.safeParse({ ...smallRecord(), id: 'mnt-XYZ' }).success).toBe(false)
    expect(
      MilestoneSchema.safeParse({ id: 'ms-1', title: 'x y z', optional: false, waitsFor: null })
        .success
    ).toBe(false)
    const step = (fullRecord().steps as Record<string, unknown>[])[0]
    expect(StepSchema.safeParse({ ...step, id: 'step-1' }).success).toBe(false)
    expect(
      CriterionSchema.safeParse({
        id: 'c1',
        text: 'Every reviewer question has an answer',
        by: 'session'
      }).success
    ).toBe(false)
    const blocker = (step.blockers as Record<string, unknown>[])[0]
    expect(BlockerSchema.safeParse({ ...blocker, id: 'b1' }).success).toBe(false)
  })

  it('a criterion is settled one of four ways and no other', () => {
    const text = 'Every reviewer question has an answer'
    for (const by of ['session', 'operator'])
      expect(CriterionSchema.safeParse({ id: 'ac-1', text, by }).success).toBe(true)
    expect(
      CriterionSchema.safeParse({ id: 'ac-1', text, by: 'person', person: 'the designer' }).success
    ).toBe(true)
    for (const fact of ['pr-opened', 'ci-green', 'pr-merged', 'main-green', 'link-exists'])
      expect(CriterionSchema.safeParse({ id: 'ac-1', text, by: 'fact', fact }).success).toBe(true)
    // An unknown way, an unknown fact, and a fact criterion with no fact are all refused.
    expect(CriterionSchema.safeParse({ id: 'ac-1', text, by: 'verifier' }).success).toBe(false)
    expect(
      CriterionSchema.safeParse({ id: 'ac-1', text, by: 'fact', fact: 'pr-reviewed' }).success
    ).toBe(false)
    expect(CriterionSchema.safeParse({ id: 'ac-1', text, by: 'fact' }).success).toBe(false)
  })

  it('a settled stamp is { at, by, evidence } and keeps the person when another person approved', () => {
    const text = 'A second session checked it'
    const settled = {
      at: AT,
      by: '11111111-2222-4333-8444-555555555555',
      evidence: 'Ran the suite: 41 passed'
    }
    const parsed = CriterionSchema.safeParse({ id: 'ac-1', text, by: 'session', settled })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.settled).toEqual(settled)
    expect(
      CriterionSchema.safeParse({ id: 'ac-1', text, by: 'session', settled: { by: 'x' } }).success
    ).toBe(false)
  })

  it('a blocker has an id, an owner and may declare the fact it waits for', () => {
    const blocker = {
      id: 'blk-2',
      reason: 'The staging key is missing from STAGING_KEY',
      ask: 'Paste the staging key',
      unblocks: 'The deploy check',
      owner: 'agent'
    }
    expect(BlockerSchema.safeParse(blocker).success).toBe(true)
    for (const clearsWhen of ['pr-merged', 'ci-green', 'main-green'])
      expect(BlockerSchema.safeParse({ ...blocker, clearsWhen }).success).toBe(true)
    expect(BlockerSchema.safeParse({ ...blocker, clearsWhen: 'someday' }).success).toBe(false)
    expect(BlockerSchema.safeParse({ ...blocker, owner: 'nobody' }).success).toBe(false)
    const { id: _drop, ...noId } = blocker
    expect(BlockerSchema.safeParse(noId).success).toBe(false)
  })

  it('a session entry keeps role, from, to and where it stopped', () => {
    const lead = {
      id: '11111111-2222-4333-8444-555555555555',
      role: 'leads',
      from: AT,
      to: null,
      stoppedAt: null
    }
    expect(SessionEntrySchema.safeParse(lead).success).toBe(true)
    const stopped = {
      ...lead,
      id: '99999999-2222-4333-8444-555555555555',
      role: 'worked',
      to: '2026-11-14T11:00:00Z',
      stoppedAt: { step: 'stp-2', waitingFor: 'a review of pull request 256' }
    }
    const parsed = SessionEntrySchema.safeParse(stopped)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toEqual(stopped)
    expect(SessionEntrySchema.safeParse({ ...lead, role: 'driver' }).success).toBe(false)
  })

  it('every schema is passthrough: a key the schema does not name survives', () => {
    const m = fullRecord()
    m.legacyV3 = { stewardPause: { at: AT, reason: 'away' } }
    m.ledger = [{ at: AT, kind: 'pr-opened', ref: '256' }]
    ;(m.steps as Record<string, unknown>[])[0].futureField = 7
    const parsed = MissionRecordSchema.safeParse(m)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toEqual(m)
  })

  it('caps are never applied on read: a 200-character title still parses', () => {
    const long = 'x'.repeat(200)
    const m = smallRecord()
    m.title = long
    ;(m.steps as Record<string, unknown>[])[0].title = long
    expect(MissionRecordSchema.safeParse(m).success).toBe(true)
  })

  it('a mission may be closed, and records how', () => {
    const closed = {
      ...smallRecord(),
      status: 'closed',
      closedAs: 'discarded',
      closeReason: 'The test was deleted'
    }
    expect(MissionRecordSchema.safeParse(closed).success).toBe(true)
    expect(MissionRecordSchema.safeParse({ ...smallRecord(), status: 'delivered' }).success).toBe(
      false
    )
    expect(MissionRecordSchema.safeParse({ ...closed, closedAs: 'lost' }).success).toBe(false)
  })
})

describe('the attach request', () => {
  const request = {
    id: 'atr-1',
    missionId: 'mnt-1a2b3c4d',
    sessionId: '99999999-2222-4333-8444-555555555555',
    at: AT,
    decision: null
  }

  it('records who asks, for which mission, when, and whether it was allowed or denied', () => {
    expect(AttachRequestSchema.safeParse(request).success).toBe(true)
    for (const decision of ['allowed', 'denied']) {
      const decided = { ...request, decision, decidedAt: '2026-11-14T10:05:00Z' }
      const parsed = AttachRequestSchema.safeParse(decided)
      expect(parsed.success).toBe(true)
      if (parsed.success) expect(parsed.data).toEqual(decided)
    }
  })

  it('is a request to JOIN: nobody asks to lead, so the record names no role', () => {
    // The operator's decision of 2026-11-14 (spec amendment C3-32): a session that creates a mission
    // leads it; every other session asks to join. A request is who, which mission, when, the decision.
    const parsed = AttachRequestSchema.parse(request)
    expect(Object.keys(parsed).sort()).toEqual(['at', 'decision', 'id', 'missionId', 'sessionId'])
    expect('role' in parsed).toBe(false)
  })

  it('refuses an unknown decision, a bad mission id and a missing asker', () => {
    expect(AttachRequestSchema.safeParse({ ...request, decision: 'maybe' }).success).toBe(false)
    expect(AttachRequestSchema.safeParse({ ...request, missionId: 'campaign-1' }).success).toBe(
      false
    )
    const { sessionId: _drop, ...noAsker } = request
    expect(AttachRequestSchema.safeParse(noAsker).success).toBe(false)
  })

  it('survives a JSON round trip unchanged', () => {
    const decided = { ...request, decision: 'allowed', decidedAt: '2026-11-14T10:05:00Z' }
    const parsed = AttachRequestSchema.parse(JSON.parse(JSON.stringify(decided)))
    expect(parsed).toEqual(decided)
  })
})

describe('the v4 file: frontmatter and an append-only Log', () => {
  const LOG = '### 2026-11-14T10:00:00Z · note\n\nStarted the scoring tool.\n'

  it('serializes and parses back without loss', () => {
    const record = MissionRecordSchema.parse(fullRecord())
    const content = buildMissionRecordContent(record, LOG)
    const back = parseMissionRecordFile(content)
    expect('error' in back).toBe(false)
    if ('error' in back) return
    expect(back).toEqual(record)
    expect(readMissionRecordLog(content)).toBe(LOG)
  })

  it('writes the same bytes when a parsed record is written again', () => {
    const record = MissionRecordSchema.parse(fullRecord())
    const once = buildMissionRecordContent(record, LOG)
    const parsed = parseMissionRecordFile(once)
    if ('error' in parsed) throw new Error(parsed.error)
    expect(buildMissionRecordContent(parsed, readMissionRecordLog(once))).toBe(once)
  })

  it('keeps strings that look like other YAML types as strings', () => {
    const m = fullRecord()
    ;(m.steps as Record<string, unknown>[])[0].links = [
      { kind: 'pr', ref: '256' },
      { kind: 'doc', ref: 'true' },
      { kind: 'url', ref: 'null' }
    ]
    m.title = '2026-11-14'
    const record = MissionRecordSchema.parse(m)
    const back = parseMissionRecordFile(buildMissionRecordContent(record))
    expect(back).toEqual(record)
  })

  it('starts with the frontmatter fence and writes schemaVersion first', () => {
    const content = buildMissionRecordContent(MissionRecordSchema.parse(smallRecord()))
    expect(content.startsWith('---\nschemaVersion: 4\nid: mnt-0a0b0c0d\n')).toBe(true)
  })

  it('refuses to write an invalid record instead of landing a file every read would reject', () => {
    const bad = { ...smallRecord(), id: 'nope' } as never
    expect(() => buildMissionRecordContent(bad)).toThrow(/invalid mission/)
  })

  it('never throws on read: a missing fence, bad YAML, a v3 file or a bad shape returns { error }', () => {
    expect(parseMissionRecordFile('no frontmatter here')).toEqual({ error: 'no frontmatter block' })
    const yamlError = parseMissionRecordFile('---\nid: [unclosed\n---\n')
    expect('error' in yamlError && yamlError.error).toMatch(/^invalid YAML/)
    const v3 = parseMissionRecordFile('---\nid: mnt-1a2b3c4d\nslug: x\nstatus: active\n---\n')
    expect('error' in v3 && v3.error).toMatch(/^invalid mission/)
    expect(readMissionRecordLog('no frontmatter here')).toBe('')
  })

  it('reads an unquoted timestamp as a string, never a Date', () => {
    const content = [
      '---',
      'schemaVersion: 4',
      'id: mnt-0a0b0c0d',
      'title: Fix the flaky sidebar test',
      'doneWhen: The sidebar test passes ten runs in a row.',
      'status: open',
      'closeRequested: { at: 2026-11-14T10:00:00Z }',
      'steps: []',
      '---',
      ''
    ].join('\n')
    const parsed = parseMissionRecordFile(content)
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.closeRequested).toEqual({ at: '2026-11-14T10:00:00Z' })
  })
})

/**
 * Delta 1 · AC-9's proof. The suite above stayed green when a nested schema lost `.passthrough()` or
 * a closed list grew, so every nested entity is pinned here: an unknown key on it survives the parse
 * AND the file round trip, and the closed lists are written out.
 */
describe('the v4 record keeps what it does not name (delta 1)', () => {
  /** Each place an unknown key is planted: where it goes in the record, by path. */
  const PLACES: Array<[string, (m: Record<string, unknown>) => Record<string, unknown>]> = [
    ['a milestone', (m) => (m.milestones as Record<string, unknown>[])[0]],
    ['a step', (m) => (m.steps as Record<string, unknown>[])[0]],
    [
      'a criterion',
      (m) =>
        ((m.steps as Record<string, unknown>[])[0].acs as Record<string, unknown>[])[0] as Record<
          string,
          unknown
        >
    ],
    [
      'a criterion settled stamp',
      (m) =>
        ((m.steps as Record<string, unknown>[])[0].acs as Record<string, unknown>[])[2]
          .settled as Record<string, unknown>
    ],
    [
      'a step link',
      (m) =>
        ((m.steps as Record<string, unknown>[])[0].links as Record<string, unknown>[])[0] as Record<
          string,
          unknown
        >
    ],
    [
      'a step blocker',
      (m) =>
        (
          (m.steps as Record<string, unknown>[])[0].blockers as Record<string, unknown>[]
        )[0] as Record<string, unknown>
    ],
    ['a mission link', (m) => (m.links as Record<string, unknown>[])[0]],
    ['a session entry', (m) => (m.sessions as Record<string, unknown>[])[0]],
    ['closeRequested', (m) => m.closeRequested as Record<string, unknown>]
  ]

  /** A record with `stoppedAt` and `doneWhenVerified` filled, so those nested objects can carry a key. */
  function withNested(): Record<string, unknown> {
    const m = fullRecord()
    ;(m.sessions as Record<string, unknown>[])[0].stoppedAt = {
      step: 'stp-1',
      waitingFor: 'a review of pull request 256'
    }
    m.doneWhenVerified = { by: '99999999-2222-4333-8444-555555555555', at: AT }
    return m
  }

  const ALL_PLACES: Array<[string, (m: Record<string, unknown>) => Record<string, unknown>]> = [
    ...PLACES,
    [
      'a session stoppedAt',
      (m) => (m.sessions as Record<string, unknown>[])[0].stoppedAt as Record<string, unknown>
    ],
    ['doneWhenVerified', (m) => m.doneWhenVerified as Record<string, unknown>]
  ]

  for (const [where, locate] of ALL_PLACES) {
    it(`an unknown key on ${where} survives the parse and the file round trip`, () => {
      const m = withNested()
      locate(m).futureKey = 'kept'
      const parsed = MissionRecordSchema.safeParse(m)
      expect(parsed.success).toBe(true)
      if (!parsed.success) return
      expect(locate(parsed.data as unknown as Record<string, unknown>).futureKey).toBe('kept')
      expect(parsed.data).toEqual(m)
      const content = buildMissionRecordContent(parsed.data)
      const back = parseMissionRecordFile(content)
      if ('error' in back) throw new Error(back.error)
      expect(locate(back as unknown as Record<string, unknown>).futureKey).toBe('kept')
      expect(back).toEqual(m)
    })
  }

  it('an unknown key on an attach request survives its parse and a JSON round trip', () => {
    const request = {
      id: 'atr-1',
      missionId: 'mnt-1a2b3c4d',
      sessionId: '99999999-2222-4333-8444-555555555555',
      at: AT,
      decision: null,
      futureKey: 'kept'
    }
    const parsed = AttachRequestSchema.parse(request)
    expect(parsed).toEqual(request)
    expect(AttachRequestSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(request)
  })

  it('a link is one of five kinds, and a card link is refused', () => {
    expect([...LINK_KINDS]).toEqual(['session', 'pr', 'worktree', 'url', 'doc'])
    const withLink = (kind: string): Record<string, unknown> => {
      const m = smallRecord()
      ;(m.steps as Record<string, unknown>[])[0].links = [{ kind, ref: 'x' }]
      m.links = [{ kind, ref: 'x' }]
      return m
    }
    expect(MissionRecordSchema.safeParse(withLink('card')).success).toBe(false)
    for (const kind of LINK_KINDS)
      expect(MissionRecordSchema.safeParse(withLink(kind)).success).toBe(true)
  })

  it('a fact is one of five', () => {
    expect([...FACTS]).toEqual(['pr-opened', 'ci-green', 'pr-merged', 'main-green', 'link-exists'])
  })

  it('a step may be optional and round-trips; a wrong type is refused', () => {
    const m = smallRecord()
    ;(m.steps as Record<string, unknown>[])[0].optional = true
    const record = MissionRecordSchema.parse(m)
    expect(record.steps[0].optional).toBe(true)
    expect(parseMissionRecordFile(buildMissionRecordContent(record))).toEqual(record)
    ;(m.steps as Record<string, unknown>[])[0].optional = 'yes'
    expect(MissionRecordSchema.safeParse(m).success).toBe(false)
  })

  it('a mission may record who verified its Done when and when; a wrong type is refused', () => {
    const verified = { by: '99999999-2222-4333-8444-555555555555', at: AT }
    const m = { ...smallRecord(), doneWhenVerified: verified }
    const record = MissionRecordSchema.parse(m)
    expect(record.doneWhenVerified).toEqual(verified)
    expect(parseMissionRecordFile(buildMissionRecordContent(record))).toEqual(record)
    expect(MissionRecordSchema.safeParse({ ...m, doneWhenVerified: 'the operator' }).success).toBe(
      false
    )
    expect(MissionRecordSchema.safeParse({ ...m, doneWhenVerified: { by: 'x' } }).success).toBe(
      false
    )
  })
})

/**
 * Delta 1 · the owner's calls on the shape. Ten slices import this module, so what they need is
 * exported once, here: the state names, the nested schemas, a place for a self-check, an attach
 * request that nobody uses to lead, and entity types that do not accept a misspelt field.
 */
describe('what the other slices import (delta 1)', () => {
  it('exports the state vocabulary once: step, milestone and mission', () => {
    expect([...STEP_STATES]).toEqual(['to do', 'running', 'waiting for review', 'done'])
    expect([...MILESTONE_STATES]).toEqual([
      'not started',
      'in progress',
      'waiting for review',
      'done'
    ])
    expect([...MISSION_STATES]).toEqual(['open', 'ready to close', 'closed'])
  })

  it('exports the nested schemas: a link, a settled stamp, a stoppedAt', () => {
    expect(LinkSchema.safeParse({ kind: 'pr', ref: '256' }).success).toBe(true)
    expect(LinkSchema.safeParse({ kind: 'card', ref: 'T685' }).success).toBe(false)
    expect(SettledSchema.safeParse({ at: AT, by: 'operator' }).success).toBe(true)
    expect(SettledSchema.safeParse({ by: 'operator' }).success).toBe(false)
    expect(StoppedAtSchema.safeParse({ step: 'stp-2', waitingFor: 'a review' }).success).toBe(true)
    expect(StoppedAtSchema.safeParse({}).success).toBe(true)
    expect(StoppedAtSchema.safeParse({ step: 7 }).success).toBe(false)
  })

  describe('a self-check has a place and never settles', () => {
    const text = 'Every reviewer question has an answer'
    const selfCheck = {
      at: AT,
      by: '11111111-2222-4333-8444-555555555555',
      evidence: 'Ran the suite: 41 passed'
    }

    it('a criterion may carry selfCheck { at, by, evidence } beside settled', () => {
      const parsed = CriterionSchema.parse({ id: 'ac-1', text, by: 'session', selfCheck })
      expect(parsed.selfCheck).toEqual(selfCheck)
      // It is not a stamp: nothing in it makes the criterion settled.
      expect(parsed.settled).toBeUndefined()
      const both = CriterionSchema.parse({
        id: 'ac-1',
        text,
        by: 'session',
        selfCheck,
        settled: { at: AT, by: '99999999-2222-4333-8444-555555555555', evidence: 'Checked by hand' }
      })
      expect(both.selfCheck).toEqual(selfCheck)
      expect(both.settled?.by).toBe('99999999-2222-4333-8444-555555555555')
    })

    it('needs all three of its fields, and survives the file round trip', () => {
      for (const missing of ['at', 'by', 'evidence']) {
        const partial: Record<string, unknown> = { ...selfCheck }
        delete partial[missing]
        expect(
          CriterionSchema.safeParse({ id: 'ac-1', text, by: 'session', selfCheck: partial }).success
        ).toBe(false)
      }
      const m = smallRecord()
      ;(m.steps as Record<string, unknown>[])[0].acs = [
        { id: 'ac-1', text, by: 'session', selfCheck }
      ]
      const record = MissionRecordSchema.parse(m)
      expect(parseMissionRecordFile(buildMissionRecordContent(record))).toEqual(record)
    })
  })

  describe('the attach request, on the mission', () => {
    const request = {
      id: 'atr-1',
      missionId: 'mnt-0a0b0c0d',
      sessionId: '99999999-2222-4333-8444-555555555555',
      at: AT,
      decision: null
    }

    it('a mission may hold an optional attachRequests list, and a record without one stays without', () => {
      const without = MissionRecordSchema.parse(smallRecord())
      expect('attachRequests' in without).toBe(false)
      const decided = {
        ...request,
        id: 'atr-2',
        decision: 'denied',
        decidedAt: '2026-11-14T10:05:00Z'
      }
      const m = { ...smallRecord(), attachRequests: [request, decided] }
      const record = MissionRecordSchema.parse(m)
      expect(record.attachRequests).toEqual([request, decided])
      expect(parseMissionRecordFile(buildMissionRecordContent(record))).toEqual(record)
    })

    it('every request in the list is an attach request, and an unknown key on one survives', () => {
      const bad = { ...smallRecord(), attachRequests: [{ ...request, decision: 'maybe' }] }
      expect(MissionRecordSchema.safeParse(bad).success).toBe(false)
      const planted = { ...smallRecord(), attachRequests: [{ ...request, futureKey: 'kept' }] }
      const record = MissionRecordSchema.parse(planted)
      expect(record).toEqual(planted)
      expect(parseMissionRecordFile(buildMissionRecordContent(record))).toEqual(planted)
    })
  })

  it('reads an unknown key on purpose through WithUnknownKeys, the one way a caller may', () => {
    const m = smallRecord()
    ;(m.steps as Record<string, unknown>[])[0].futureKey = 'kept'
    const record = MissionRecordSchema.parse(m)
    // The entity types are closed, so `step.futureKey` does not compile; this is how a reader
    // (the compatibility reader, a later build's field) names a key the schema does not.
    const step = record.steps[0] as WithUnknownKeys<StepV4>
    expect(step.futureKey).toBe('kept')
    expect(step.title).toBe('Find why the test flakes')
  })
})
