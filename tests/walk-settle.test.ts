/**
 * T787 — closing a walk settles the mission criteria its verified checks answered.
 *
 * The operator decided (2026-11-18): when a mission-source run ends, every open `by: operator` criterion a
 * check answered is settled, but ONLY when two independent signals agree: the operator's Done and the agent's
 * own read-only check (`closedHow: 'done-check'` with a `pass` report). Everything else stays a Mark done
 * link in the Mission. Done and every key still settle nothing while the walk runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWalkService, type WalkRuntime } from '../src/main/walk/walk-service'
import { createWalkProbe } from '../src/main/walk/walk-links'
import { buildMissionRecordContent, type MissionV4 } from '../src/main/missions/model'
import { readMissionRecord } from '../src/main/missions/record-store'
import { planSettle } from '../src/shared/walk-settle'
import type { Run, RunCheck } from '../src/shared/walk-machine'

const ID = 'mnt-aaaaaaaa'
const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const T0 = '2026-11-18T09:00:00Z'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'walk-settle-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const runtime: WalkRuntime = {
  deliver: async () => ({ status: 'held' }),
  openPane: async () => false
}

// ---- the mission ----------------------------------------------------------------------------------------

const missionOf = (over: Partial<MissionV4> = {}): MissionV4 => ({
  schemaVersion: 4,
  id: ID,
  title: 'Notes search',
  doneWhen: 'The notes list has a search box',
  status: 'open',
  milestones: [],
  steps: [
    {
      id: 'stp-1',
      title: 'Add the search box',
      acs: [
        { id: 'ac-1', text: 'Typing narrows the list', by: 'operator' },
        { id: 'ac-2', text: 'The designer signed off', by: 'person', person: 'the designer' },
        { id: 'ac-3', text: 'A second session read the code', by: 'session' },
        { id: 'ac-4', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' },
        { id: 'ac-5', text: 'The empty state reads well', by: 'operator' },
        { id: 'ac-6', text: 'The row count is shown', by: 'operator' },
        {
          id: 'ac-7',
          text: 'The clear button works',
          by: 'operator',
          settled: { at: '2026-11-17T08:00:00Z', by: 'operator', evidence: 'ticked yesterday' }
        },
        { id: 'ac-8', text: 'Reloading keeps the query', by: 'operator' },
        { id: 'ac-9', text: 'The list scrolls', by: 'operator' },
        { id: 'ac-10', text: 'Escape clears the box', by: 'operator' }
      ],
      links: [],
      blockers: []
    }
  ],
  sessions: [{ id: LEADER, role: 'leads', from: T0, to: null }],
  links: [],
  blockers: [],
  ...over
})

const missionDir = (): string => join(root, '.harnu', 'missions-v4')
function seed(record: MissionV4): void {
  mkdirSync(missionDir(), { recursive: true })
  writeFileSync(
    join(missionDir(), `${record.id}-notes.md`),
    buildMissionRecordContent(record, '# Log\n')
  )
}
async function acs(): Promise<Record<string, MissionV4['steps'][number]['acs'][number]>> {
  const r = await readMissionRecord(root, ID)
  if (!r.ok) throw new Error(r.error)
  return Object.fromEntries(r.record.steps.flatMap((s) => s.acs).map((a) => [a.id, a]))
}
const sha = (): string =>
  createHash('sha256')
    .update(
      readdirSync(missionDir())
        .sort()
        .map((f) => readFileSync(join(missionDir(), f), 'utf8'))
        .join('\n--\n')
    )
    .digest('hex')

// ---- the walk -------------------------------------------------------------------------------------------

const check = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Check ${id}`,
  why: 'It is the feature.',
  where: { text: 'Notes page' },
  do: [{ text: 'Type `standup`.', see: 'Two rows stay.' }],
  passes: 'Two rows.',
  fails: 'More rows.',
  check: { how: 'count the rows' },
  ...over
})

const probe = () =>
  createWalkProbe({
    folder: root,
    knownFolders: [root],
    cardSlugs: () => [],
    mission: (id) =>
      id === ID
        ? {
            milestones: [],
            steps: [
              {
                id: 'stp-1',
                milestone: null,
                criteria: [
                  'ac-1',
                  'ac-2',
                  'ac-3',
                  'ac-4',
                  'ac-5',
                  'ac-6',
                  'ac-7',
                  'ac-8',
                  'ac-9',
                  'ac-10'
                ]
              }
            ]
          }
        : null
  })

async function openWalk(
  checks: Record<string, unknown>[],
  source: Record<string, unknown> = {
    kind: 'mission',
    missionId: ID,
    scope: 'step',
    id: 'stp-1'
  }
) {
  const svc = createWalkService(root, { runtime: () => runtime, now: () => Date.parse(T0) })
  const opened = await svc.open({
    sessionId: 'sess-owner',
    script: { title: 'Try the search box', purpose: 'check', source, checks },
    probe: probe()
  })
  if (!opened.ok) throw new Error(JSON.stringify(opened))
  const a = { walkId: opened.walkId as string, runId: opened.runId as string }
  const op = (o: Parameters<typeof svc.operate>[0]['op'], x: object = {}) =>
    svc.operate({ ...a, op: o, ...x })
  /** Done, then the agent's check answers `pass` with this evidence: the two signals. */
  const verified = async (checkId: string, evidence = 'counted two rows') => {
    await op('done')
    await svc.report({ ...a, checkId, result: 'pass', evidence })
  }
  return { svc, a, op, verified }
}

describe('planSettle — the rule, pure', () => {
  const rc = (id: string, over: Partial<RunCheck> = {}): RunCheck => ({
    id,
    hasAgentCheck: true,
    blocks: [],
    countable: true,
    state: 'verified',
    closedHow: 'done-check',
    attempts: 0,
    failures: [],
    correction: null,
    report: { result: 'pass', evidence: 'ok', at: 1 },
    reportLog: [],
    deliveredAt: null,
    ...over
  })
  const run = (checks: RunCheck[]): Run => ({
    n: 1,
    state: 'ended',
    checks,
    cursor: null,
    served: [],
    endedAt: 5
  })
  const crit = (id: string) => ({ id, check: id })

  it('keeps only done-check with an agent pass, never keyed on state alone (AC-8)', () => {
    const plan = planSettle(
      run([
        rc('c1'),
        // verified, but only one signal: nothing from here
        rc('c2', { hasAgentCheck: false, closedHow: 'done-nothing', report: null }),
        rc('c3', { state: 'caveat', closedHow: 'continued', report: null }),
        rc('c4', {
          state: 'disagrees',
          closedHow: null,
          report: { result: 'fail', evidence: 'no', at: 1 }
        }),
        rc('c5', { state: 'failed', closedHow: null, report: null }),
        rc('c6', { state: 'skipped', closedHow: null, report: null }),
        rc('c7', { closedHow: 'pre-closed', report: null })
      ]),
      [
        crit('c1'),
        crit('c2'),
        crit('c3'),
        crit('c4'),
        crit('c5'),
        crit('c6'),
        crit('c7'),
        { id: 'c8', check: 'c8' } // not in the run
      ].map((c) => ({ checkId: c.id, criterionId: `ac-${c.id.slice(1)}` }))
    )
    expect(plan.map((p) => [p.checkId, p.criterionId])).toEqual([['c1', 'ac-1']])
    expect(plan[0].evidence).toBe('ok')
  })

  it('is empty before the run ended', () => {
    const live = { ...run([rc('c1')]), state: 'live' as const }
    expect(planSettle(live, [{ checkId: 'c1', criterionId: 'ac-1' }])).toEqual([])
  })
})

describe('closing a mission-source walk settles what two signals verified', () => {
  it('AC-1/AC-2: settles the done-check operator criteria; every other row stays as it was', async () => {
    seed(missionOf())
    const { svc, op, verified, a } = await openWalk([
      check('c1', { criterion: 'ac-1' }), // Done + agent pass: settled
      check('c2', { criterion: 'ac-2' }), // person: stays open
      check('c3', { criterion: 'ac-3' }), // session: stays open
      check('c4', { criterion: 'ac-4' }), // fact: stays open
      check('c5', { criterion: 'ac-5' }), // caveat: stays open
      check('c6', { check: undefined, nothingFromHere: 'Only eyes can tell.', criterion: 'ac-6' }), // one signal
      check('c7', { criterion: 'ac-7' }), // already settled: untouched
      check('c8', { criterion: 'ac-8' }), // failed
      check('c9', { criterion: 'ac-9' }), // skipped
      check('c10') // no criterion
    ])
    await op('start')
    await verified('c1', 'the list narrowed to two rows')
    await verified('c2')
    await verified('c3')
    await verified('c4')
    await op('done') // c5: Done, then the agent never answers: continue without it
    await op('continue-without', { waitMs: 0 })
    await op('done') // c6: nothing to check from here, so Done alone verifies it
    await verified('c7')
    await op('fail', { line: 'The query is lost on reload.' }) // c8
    await op('skip') // the failed check stays on screen until it is skipped or retried
    await op('skip') // c9
    await op('done') // c10
    await svc.report({ ...a, checkId: 'c10', result: 'pass', evidence: 'fine' })

    // nothing settled while the run was live: the run is not over yet (c8 was skipped back to the list)
    const mid = await acs()
    expect(mid['ac-1'].settled).toBeUndefined()

    const ended = await op('end')
    expect(ended.ok).toBe(true)

    const after = await acs()
    expect(after['ac-1'].settled).toMatchObject({ by: 'operator' })
    expect(after['ac-1'].settled?.evidence).toContain(a.walkId)
    expect(after['ac-1'].settled?.evidence).toContain(a.runId)
    expect(after['ac-1'].settled?.evidence).toContain('c1')
    expect(after['ac-1'].settled?.evidence).toContain('the list narrowed to two rows')
    for (const id of ['ac-2', 'ac-3', 'ac-4', 'ac-5', 'ac-6', 'ac-8', 'ac-9', 'ac-10'])
      expect(after[id].settled, id).toBeUndefined()
    // an already-settled criterion keeps its first stamp
    expect(after['ac-7'].settled).toEqual({
      at: '2026-11-17T08:00:00Z',
      by: 'operator',
      evidence: 'ticked yesterday'
    })
  })

  it('AC-3: ending the walk early settles only what was verified so far', async () => {
    seed(missionOf())
    const { op, verified } = await openWalk([
      check('c1', { criterion: 'ac-1' }),
      check('c2', { criterion: 'ac-5' }),
      check('c3', { criterion: 'ac-6' })
    ])
    await op('start')
    await verified('c1')
    await op('done') // c2 awaits the agent...
    const ended = await op('end') // ...and the operator ends before it answers
    expect(ended.ok).toBe(true)
    const after = await acs()
    expect(after['ac-1'].settled).toBeDefined()
    expect(after['ac-5'].settled).toBeUndefined()
    expect(after['ac-6'].settled).toBeUndefined()
  })

  it('AC-8: a done-nothing check carrying a criterion leaves it open', async () => {
    seed(missionOf())
    const { op } = await openWalk([
      check('c1', { check: undefined, nothingFromHere: 'Only eyes can tell.', criterion: 'ac-1' })
    ])
    await op('start')
    await op('done')
    const after = await acs()
    expect(after['ac-1'].settled).toBeUndefined()
  })

  it('settles when the agent report is what closes the last check', async () => {
    seed(missionOf())
    const { op, verified, svc, a } = await openWalk([check('c1', { criterion: 'ac-1' })])
    await op('start')
    await verified('c1')
    await svc.idle()
    expect((await acs())['ac-1'].settled).toBeDefined()
    expect(a.runId).toBeTruthy()
  })

  it('AC-4: a closed mission settles nothing and the run still ends', async () => {
    seed(missionOf({ status: 'closed' }))
    const before = sha()
    const { op, verified } = await openWalk([check('c1', { criterion: 'ac-1' })])
    await op('start')
    await verified('c1')
    expect(sha()).toBe(before)
  })

  it('AC-4: a removed mission settles nothing and the run still ends', async () => {
    const { op, verified, svc, a } = await openWalk([check('c1', { criterion: 'ac-1' })])
    await op('start')
    await verified('c1')
    const rec = await svc.store.readRun(a.walkId, a.runId)
    expect(rec?.run.state).toBe('ended')
  })

  it('W-19: a walk with any other source leaves every mission file byte-identical', async () => {
    seed(missionOf())
    const before = sha()
    const { op, verified } = await openWalk([check('c1')], {
      kind: 'feature',
      text: 'A search box.'
    })
    await op('start')
    await verified('c1')
    expect(sha()).toBe(before)
  })

  it('Done alone settles nothing while the walk runs (W-11)', async () => {
    seed(missionOf())
    const before = sha()
    const { op, svc, a } = await openWalk([
      check('c1', { criterion: 'ac-1' }),
      check('c2', { criterion: 'ac-5' })
    ])
    await op('start')
    await op('done')
    await svc.report({ ...a, checkId: 'c1', result: 'pass', evidence: 'ok' })
    // c1 is verified, c2 is the current check: the run is live
    expect(sha()).toBe(before)
  })
})
