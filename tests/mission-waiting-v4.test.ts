/**
 * Missions v4 · S-8 · AC-17, AC-18 — the v4 waiting list: one item type in a fixed rank, one next step,
 * and a person's sign-off that is never the operator's move.
 *
 * `waitingListV4` (src/main/missions/waiting.ts) is pure: a v4 record plus plain input facts in, a list
 * out. It sits BESIDE the v3 `waitingList`, which `tests/mission-waiting.test.ts` still pins. Named
 * `-v4` for that reason.
 *
 * The purity test at the bottom instruments `child_process`, `fs`, `fs/promises` and the clock, and
 * proves the instrumentation itself fails when something does read them.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AttachRequest, MissionV4, StepV4 } from '../src/main/missions/model'
import type { StepInput } from '../src/main/missions/state'

/** Counts every call into a wrapped builtin module, delegating to the real one. */
const spy = vi.hoisted(() => {
  const calls: string[] = []
  const wrapFns = (obj: Record<string, unknown>, prefix: string): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(obj).map(([k, v]) =>
        typeof v === 'function' && !/^[A-Z]/.test(k)
          ? [
              k,
              (...a: unknown[]): unknown => {
                calls.push(`${prefix}.${k}`)
                return (v as (...x: unknown[]) => unknown)(...a)
              }
            ]
          : [k, v]
      )
    )
  return { calls, wrapFns }
})

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return { ...spy.wrapFns(real, 'child_process'), default: real }
})
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return {
    ...spy.wrapFns(real, 'fs'),
    promises: spy.wrapFns(real.promises as Record<string, unknown>, 'fs.promises'),
    default: real
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return { ...spy.wrapFns(real, 'fs/promises'), default: real }
})

type Waiting = typeof import('../src/main/missions/waiting')
let waiting: Waiting
let childProcess: typeof import('node:child_process')
let progressMod: typeof import('../src/main/missions/progress')

beforeAll(async () => {
  waiting = await import('../src/main/missions/waiting')
  progressMod = await import('../src/main/missions/progress')
  childProcess = await import('node:child_process')
})

const AT = '2026-11-14T10:00:00Z'
const MID = 'mnt-1a2b3c4d'

// ---- Builders -------------------------------------------------------------------

type CriterionIn = StepV4['acs'][number]

const crit = (
  id: string,
  by: CriterionIn['by'],
  extra: Record<string, unknown> = {}
): CriterionIn => ({ id, text: `Criterion ${id} holds`, by, ...extra }) as CriterionIn

/** A step whose one criterion is a second session's check: open until a stamp is added. */
function mkStep(id: string, extra: Record<string, unknown> = {}): StepV4 {
  return {
    id,
    title: `Step ${id}`,
    acs: [crit('ac-1', 'session')],
    links: [],
    blockers: [],
    ...extra
  } as StepV4
}

const doneStep = (id: string, extra: Record<string, unknown> = {}): StepV4 =>
  mkStep(id, {
    acs: [crit('ac-1', 'session', { settled: { at: AT, by: 'sess-checker', evidence: 'ran it' } })],
    ...extra
  })

function mkMission(extra: Partial<MissionV4> = {}): MissionV4 {
  return {
    schemaVersion: 4,
    id: MID,
    title: 'A mission',
    doneWhen: 'It is done.',
    status: 'open',
    milestones: [],
    steps: [],
    sessions: [],
    links: [],
    blockers: [],
    ...extra
  } as MissionV4
}

const milestone = (
  id: string,
  extra: Record<string, unknown> = {}
): MissionV4['milestones'][number] =>
  ({
    id,
    title: `Milestone ${id}`,
    optional: false,
    waitsFor: null,
    ...extra
  }) as MissionV4['milestones'][number]

const blocker = (id: string, extra: Record<string, unknown> = {}): StepV4['blockers'][number] =>
  ({
    id,
    reason:
      'This machine does not know where the test files are. Set HARNU_CORPUS_DIR to their folder.',
    ask: 'Set HARNU_CORPUS_DIR to the folder with the test files',
    unblocks: 'The scoring run starts',
    owner: 'operator',
    ...extra
  }) as StepV4['blockers'][number]

const request = (id: string, extra: Record<string, unknown> = {}): AttachRequest =>
  ({
    id,
    missionId: MID,
    sessionId: 'aaaa1111-2222-4333-8444-555555555555',
    role: 'worked',
    at: AT,
    decision: null,
    ...extra
  }) as AttachRequest

// ---- AC-17 ----------------------------------------------------------------------

describe('AC-17 · another person is not the operator', () => {
  const signOff = mkStep('stp-1', {
    title: 'Get the design signed off',
    acs: [crit('ac-1', 'person', { text: 'The designer signed off', person: 'the designer' })]
  })

  it("a person's sign-off is not the operator's next step", () => {
    const list = waiting.waitingListV4(mkMission({ steps: [signOff] }))
    expect(list.items).toEqual([])
    expect(list.next).toBeNull()
    expect(list.more).toEqual([])
    // It shows as waiting for that person, and says so in the one line the pane and the pill read.
    expect(list.people).toEqual([
      {
        person: 'the designer',
        stepId: 'stp-1',
        criterionId: 'ac-1',
        text: 'The designer signed off'
      }
    ])
    expect(list.peopleLine).toBe('Waiting for the designer')
  })

  it('stays out of the way of the operator’s own move: the next step is the operator criterion', () => {
    const m = mkMission({
      steps: [
        signOff,
        mkStep('stp-2', {
          title: 'Read the plan',
          acs: [crit('ac-1', 'operator', { text: 'The plan reads right to me' })]
        })
      ]
    })
    const list = waiting.waitingListV4(m)
    expect(list.items.map((i) => i.kind)).toEqual(['settle'])
    expect(list.next).toMatchObject({ kind: 'settle', stepId: 'stp-2', criterionId: 'ac-1' })
    expect(list.people).toHaveLength(1)
  })

  it('names other people when more than one person is waited on, and drops the line once marked', () => {
    const two = mkMission({
      steps: [
        signOff,
        mkStep('stp-2', {
          acs: [crit('ac-1', 'person', { text: 'Legal approved the copy', person: 'legal' })]
        })
      ]
    })
    expect(waiting.waitingListV4(two).peopleLine).toBe('Waiting for other people')

    // The operator marks it when the person approves: it settles, and the wait is over.
    const marked = mkMission({
      steps: [
        mkStep('stp-1', {
          acs: [
            crit('ac-1', 'person', {
              text: 'The designer signed off',
              person: 'the designer',
              settled: { at: AT, by: 'operator', person: 'the designer' }
            })
          ]
        })
      ]
    })
    const list = waiting.waitingListV4(marked)
    expect(list.people).toEqual([])
    expect(list.peopleLine).toBeNull()
  })
})

// ---- AC-18 ----------------------------------------------------------------------

/** 10 milestones, nothing running, five things waiting on the operator (one per kind but close). */
function bigWaiting(): { mission: MissionV4; inputs: Record<string, StepInput> } {
  const milestones = Array.from({ length: 10 }, (_, i) => milestone(`mls-${i + 1}`))
  const steps: StepV4[] = [
    // main failing: merged, and `main` is red after the merge
    mkStep('stp-1', {
      milestone: 'mls-1',
      title: 'Load the test files',
      acs: [
        crit('ac-1', 'fact', { fact: 'pr-merged' }),
        crit('ac-2', 'fact', { fact: 'main-green' })
      ],
      links: [{ kind: 'pr', ref: '256' }]
    }),
    // unblock: an operator-owned blocker
    mkStep('stp-2', {
      milestone: 'mls-1',
      title: 'Run the scoring tool',
      blockers: [blocker('blk-1')]
    }),
    // settle: an operator criterion, the only thing left, so the step reads waiting for review
    mkStep('stp-3', {
      milestone: 'mls-2',
      title: 'Read the plan',
      acs: [crit('ac-1', 'operator', { text: 'The plan reads right to me' })]
    }),
    // review: two open pull requests, grouped into one item
    mkStep('stp-4', {
      milestone: 'mls-2',
      title: 'Score one spec',
      acs: [crit('ac-1', 'fact', { fact: 'pr-merged' })],
      links: [{ kind: 'pr', ref: '257' }]
    }),
    mkStep('stp-5', {
      milestone: 'mls-3',
      title: 'Score a second spec',
      acs: [crit('ac-1', 'fact', { fact: 'pr-merged' })],
      links: [{ kind: 'pr', ref: '258' }]
    })
  ]
  for (let n = 6; n <= 21; n++) {
    steps.push(mkStep(`stp-${n}`, { milestone: `mls-${3 + Math.ceil((n - 5) / 2)}` }))
  }
  return {
    mission: mkMission({ milestones, steps }),
    inputs: {
      'stp-1': { pr: 'merged', facts: { 'main-green': false } },
      'stp-4': { pr: 'open' },
      'stp-5': { pr: 'open' }
    }
  }
}

describe('AC-18 · one next step, the rest in a fixed order', () => {
  it('five waiting items give one next step', () => {
    const { mission, inputs } = bigWaiting()
    expect(progressMod.deriveProgress(mission, inputs).counts.running).toBe(0) // nothing runs
    const list = waiting.waitingListV4(mission, { inputs, attachRequests: [request('atr-1')] })
    expect(list.items.map((i) => i.kind)).toEqual([
      'main-failing',
      'unblock',
      'settle',
      'review',
      'attach'
    ])
    expect(list.next).toBe(list.items[0])
    expect(list.next?.kind).toBe('main-failing')
    expect(list.more).toEqual(list.items.slice(1))
    expect(list.more).toHaveLength(4)
    expect(list.moreLine).toBe('4 more waiting on you')
  })

  it('has no next step and no "more" line when nothing waits', () => {
    const list = waiting.waitingListV4(mkMission({ steps: [mkStep('stp-1')] }))
    expect(list).toMatchObject({ items: [], next: null, more: [], moreLine: null })
  })

  it('says "1 more" for a single follower', () => {
    const m = mkMission({ steps: [mkStep('stp-1', { blockers: [blocker('blk-1')] })] })
    const list = waiting.waitingListV4(m, { attachRequests: [request('atr-1')] })
    expect(list.moreLine).toBe('1 more waiting on you')
  })

  it('groups the pull requests that wait for the operator into one "Look over" item', () => {
    const { mission, inputs } = bigWaiting()
    const review = waiting.waitingListV4(mission, { inputs }).items.find((i) => i.kind === 'review')
    expect(review).toMatchObject({
      kind: 'review',
      stepIds: ['stp-4', 'stp-5'],
      prs: ['257', '258']
    })
    expect(review?.ask).toBe('Look over 2 pull requests')
  })

  it('names the step when a single pull request waits', () => {
    const m = mkMission({
      steps: [mkStep('stp-1', { title: 'Score one spec', links: [{ kind: 'pr', ref: '257' }] })]
    })
    const review = waiting.waitingListV4(m, { inputs: { 'stp-1': { pr: 'open' } } }).items[0]
    expect(review.kind).toBe('review')
    expect(review.ask).toBe('Look over the pull request for Score one spec')
  })

  it('puts close after review and before attach, and unblock before close', () => {
    // Every step is done: the mission is ready to close; a mission blocker and an attach request wait too.
    const m = mkMission({
      steps: [doneStep('stp-1'), doneStep('stp-2')],
      blockers: [blocker('blk-1', { ask: 'Pick the folder for the output files' })]
    })
    const list = waiting.waitingListV4(m, { attachRequests: [request('atr-1')] })
    expect(list.items.map((i) => i.kind)).toEqual(['unblock', 'close', 'attach'])
  })

  it('offers no close item until every required step is done, and carries the close request', () => {
    const open = mkMission({ steps: [doneStep('stp-1'), mkStep('stp-2')] })
    expect(waiting.waitingListV4(open).items.some((i) => i.kind === 'close')).toBe(false)

    const requested = mkMission({
      steps: [doneStep('stp-1')],
      closeRequested: { at: AT }
    })
    const close = waiting.waitingListV4(requested).items[0]
    expect(close).toMatchObject({ kind: 'close', requested: true })
    expect(waiting.waitingListV4(mkMission({ steps: [doneStep('stp-1')] })).items[0]).toMatchObject(
      {
        kind: 'close',
        requested: false
      }
    )
  })

  it('keeps plan order inside a rank: the mission first, then the steps as the record lists them', () => {
    const m = mkMission({
      blockers: [blocker('blk-9', { ask: 'Pick the folder for the output files' })],
      steps: [
        // The record lists stp-3 before stp-1: plan order is the order of the array, never of the ids.
        mkStep('stp-3', {
          blockers: [blocker('blk-1', { ask: 'Answer the question on step three' })]
        }),
        mkStep('stp-1', {
          blockers: [blocker('blk-1', { ask: 'Answer the question on step one' })]
        })
      ]
    })
    const asks = waiting.waitingListV4(m).items.map((i) => i.ask)
    expect(asks).toEqual([
      'Pick the folder for the output files',
      'Answer the question on step three',
      'Answer the question on step one'
    ])
  })

  it('gives every item a key that is unique within the list', () => {
    const { mission, inputs } = bigWaiting()
    const ids = waiting
      .waitingListV4(mission, { inputs, attachRequests: [request('atr-1'), request('atr-2')] })
      .items.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('exports the rank once, in the order the spec fixes', () => {
    expect(waiting.WAITING_RANK).toEqual([
      'main-failing',
      'unblock',
      'settle',
      'review',
      'close',
      'attach'
    ])
  })

  it('lists nothing for a closed mission', () => {
    const m = mkMission({
      status: 'closed',
      steps: [mkStep('stp-1', { blockers: [blocker('blk-1')] })]
    })
    expect(waiting.waitingListV4(m).items).toEqual([])
  })
})

describe('what each kind needs before it shows', () => {
  it('main-failing needs a merged step and a red main: an unread main is not a failing one', () => {
    const m = mkMission({
      steps: [mkStep('stp-1', { acs: [crit('ac-1', 'fact', { fact: 'main-green' })] })]
    })
    const kinds = (inputs: Record<string, StepInput>): string[] =>
      waiting.waitingListV4(m, { inputs }).items.map((i) => i.kind)
    expect(kinds({ 'stp-1': { pr: 'merged', facts: { 'main-green': false } } })).toEqual([
      'main-failing'
    ])
    expect(kinds({ 'stp-1': { pr: 'merged' } })).toEqual([]) // never read
    expect(kinds({ 'stp-1': { pr: 'merged', facts: { 'main-green': true } } })).toEqual([])
    expect(kinds({ 'stp-1': { pr: 'open', facts: { 'main-green': false } } })).toEqual([]) // not merged
  })

  it('main-failing names the pull request when the step links one', () => {
    const { mission, inputs } = bigWaiting()
    const item = waiting.waitingListV4(mission, { inputs }).items[0]
    expect(item).toMatchObject({ kind: 'main-failing', stepId: 'stp-1', pr: '256' })
    expect(item.ask).toBe('Fix main: Load the test files fails CI after #256 merged')
  })

  it('unblock shows an operator blocker and hides one whose fact holds (clearsWhen)', () => {
    const m = mkMission({
      steps: [mkStep('stp-1', { blockers: [blocker('blk-1', { clearsWhen: 'pr-merged' })] })]
    })
    expect(waiting.waitingListV4(m).items.map((i) => i.kind)).toEqual(['unblock'])
    expect(waiting.waitingListV4(m, { inputs: { 'stp-1': { pr: 'merged' } } }).items).toEqual([])
  })

  it('unblock skips an agent-owned blocker: it is not the operator’s move', () => {
    const m = mkMission({
      steps: [mkStep('stp-1', { blockers: [blocker('blk-1', { owner: 'agent' })] })]
    })
    expect(waiting.waitingListV4(m).items).toEqual([])
  })

  it('unblock uses the blocker’s own ask and unblocks, and falls back when a v3 blocker has none', () => {
    const own = mkMission({ steps: [mkStep('stp-1', { blockers: [blocker('blk-1')] })] })
    expect(waiting.waitingListV4(own).items[0]).toMatchObject({
      kind: 'unblock',
      ask: 'Set HARNU_CORPUS_DIR to the folder with the test files',
      why: 'The scoring run starts'
    })
    const converted = mkMission({
      steps: [
        mkStep('stp-1', {
          blockers: [{ id: 'blk-1', reason: 'Waiting for the key from ops', owner: 'operator' }]
        })
      ]
    })
    const item = waiting.waitingListV4(converted).items[0]
    expect(item.ask).toBe('Unblock: Waiting for the key from ops')
    expect(item.why.length).toBeGreaterThan(0)
  })

  it('settle needs a started step: an operator criterion on a step that has not begun is not due', () => {
    const m = mkMission({
      steps: [
        mkStep('stp-1', {
          acs: [crit('ac-1', 'fact', { fact: 'pr-merged' }), crit('ac-2', 'operator')]
        })
      ]
    })
    expect(waiting.waitingListV4(m).items).toEqual([]) // to do: the pull request is not even open
    const open = waiting
      .waitingListV4(m, { inputs: { 'stp-1': { pr: 'open' } } })
      .items.map((i) => i.kind)
    expect(open).toEqual(['settle', 'review'])
  })

  it('settle makes one item per operator criterion, each with the step and the criterion it targets', () => {
    const m = mkMission({
      steps: [
        mkStep('stp-1', {
          acs: [
            crit('ac-1', 'operator', { text: 'The copy reads well' }),
            crit('ac-2', 'operator', { text: 'The layout is right on a phone' })
          ]
        })
      ]
    })
    const items = waiting.waitingListV4(m).items
    expect(items.map((i) => [i.kind, i.ask])).toEqual([
      ['settle', 'Mark done: The copy reads well'],
      ['settle', 'Mark done: The layout is right on a phone']
    ])
    expect(items[1]).toMatchObject({ stepId: 'stp-1', criterionId: 'ac-2' })
  })

  it('a done step owes nothing, whatever its leftovers', () => {
    const m = mkMission({
      steps: [mkStep('stp-1', { blockers: [blocker('blk-1')], acs: [crit('ac-1', 'operator')] })]
    })
    expect(waiting.waitingListV4(m, { inputs: { 'stp-1': { card: 'done' } } }).items).toEqual([])
  })

  it('attach lists only a pending request for this mission', () => {
    const list = waiting.waitingListV4(mkMission({ steps: [mkStep('stp-1')] }), {
      attachRequests: [
        request('atr-1'),
        request('atr-2', { decision: 'allowed', decidedAt: AT }),
        request('atr-3', { decision: 'denied', decidedAt: AT }),
        request('atr-4', { missionId: 'mnt-ffffffff' })
      ]
    })
    expect(list.items.map((i) => [i.kind, i.id])).toEqual([['attach', 'attach:atr-1']])
  })

  it('nobody asks to lead: the attach item says join, whatever role the request names', () => {
    const list = waiting.waitingListV4(mkMission({ steps: [mkStep('stp-1')] }), {
      attachRequests: [
        request('atr-1', { role: 'leads', sessionId: 'bbbb2222-2222-4333-8444-555555555555' })
      ]
    })
    const item = list.items[0]
    expect(item).toMatchObject({ kind: 'attach', requestId: 'atr-1' })
    expect(item.ask).toBe('Let session bbbb2222 join the mission')
    expect(`${item.ask} ${item.why}`).not.toMatch(/lead/i)
  })

  it('the module no longer says a session asks to lead', () => {
    const src = readFileSync('src/main/missions/waiting.ts', 'utf8')
    expect(src).not.toMatch(/asks? to lead/i)
  })
})

describe('the wording', () => {
  it('stays inside ask 90 and why 60 when the record texts are inside their write caps', () => {
    const crit70 = 'The finished page shows the scores for every spec in the folder, sorted'.slice(
      0,
      70
    )
    const title50 = 'Run the scoring tool on the whole test set of specs'.slice(0, 50)
    expect(crit70).toHaveLength(70)
    expect(title50).toHaveLength(50)
    const ask90 =
      'Set HARNU_CORPUS_DIR to the folder that holds the private test files for the scoring run'
        .padEnd(90, '.')
        .slice(0, 90)
    const why60 = 'The scoring run starts and nine finished steps can be checked'.slice(0, 60)
    const m = mkMission({
      steps: [
        mkStep('stp-1', {
          title: title50,
          acs: [
            crit('ac-1', 'fact', { fact: 'pr-merged' }),
            crit('ac-2', 'fact', { fact: 'main-green' })
          ],
          links: [{ kind: 'pr', ref: '1234' }]
        }),
        mkStep('stp-2', { blockers: [blocker('blk-1', { ask: ask90, unblocks: why60 })] }),
        mkStep('stp-3', { title: title50, acs: [crit('ac-1', 'operator', { text: crit70 })] }),
        mkStep('stp-4', { title: title50, links: [{ kind: 'pr', ref: '1235' }] })
      ]
    })
    const list = waiting.waitingListV4(m, {
      inputs: {
        'stp-1': { pr: 'merged', facts: { 'main-green': false } },
        'stp-4': { pr: 'open' }
      },
      attachRequests: [request('atr-1')]
    })
    expect(list.items.map((i) => i.kind)).toEqual([
      'main-failing',
      'unblock',
      'settle',
      'review',
      'attach'
    ])
    for (const i of list.items) {
      expect(i.ask.length).toBeLessThanOrEqual(waiting.WAITING_ASK_MAX)
      expect(i.why.length).toBeLessThanOrEqual(waiting.WAITING_WHY_MAX)
    }
  })

  it('never cuts a text: an old record’s long ask, why and criterion pass through whole', () => {
    const longAsk = `Set HARNU_CORPUS_DIR ${'to the folder that holds the private test files '.repeat(4)}now`
    const longWhy = `The scoring run starts ${'and many finished steps can be checked '.repeat(3)}`
    const longCrit = `The finished page ${'shows the scores for every spec in the folder '.repeat(4)}`
    const m = mkMission({
      steps: [
        mkStep('stp-1', { blockers: [blocker('blk-1', { ask: longAsk, unblocks: longWhy })] }),
        mkStep('stp-2', { acs: [crit('ac-1', 'operator', { text: longCrit })] })
      ]
    })
    const [unblock, settle] = waiting.waitingListV4(m).items
    expect(unblock.ask).toBe(longAsk)
    expect(unblock.why).toBe(longWhy)
    expect(settle.ask).toBe(`Mark done: ${longCrit}`)
    expect(longAsk.length).toBeGreaterThan(waiting.WAITING_ASK_MAX)
    for (const i of [unblock, settle]) expect(i.ask).not.toContain('…')
  })

  it('keeps the v3 list’s own cap for the v3 list only', () => {
    const long = 'x'.repeat(200)
    const text = waiting.describeWaiting({ kind: 'blocker', reason: long, unblocks: 'it works' })
    expect(text.ask.length).toBeLessThanOrEqual(waiting.WAITING_ASK_MAX)
    expect(text.ask.endsWith('…')).toBe(true)
  })
})

// ---- AC-20 (the pure half): no spawn, no read, no clock --------------------------

describe('AC-20 · the v4 waiting list reads nothing', () => {
  const RealDate = Date
  let clockReads = 0
  const stubClock = (): void => {
    class CountingDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) clockReads++
        super(...(args as [number]))
      }
      static now(): number {
        clockReads++
        return RealDate.now()
      }
    }
    vi.stubGlobal('Date', CountingDate)
  }
  afterEach(() => {
    vi.unstubAllGlobals()
    clockReads = 0
  })

  it('makes no process spawn, no file read and no clock read, on a large mission', () => {
    const { mission, inputs } = bigWaiting()
    stubClock()
    spy.calls.length = 0
    const list = waiting.waitingListV4(mission, { inputs, attachRequests: [request('atr-1')] })
    expect(list.items).toHaveLength(5)
    expect(spy.calls).toEqual([])
    expect(clockReads).toBe(0)
  })

  it('the instrumentation fails when something does spawn, read a file or read the clock', () => {
    stubClock()
    spy.calls.length = 0
    childProcess.execFileSync('true') // a spawn
    readFileSync('package.json', 'utf8') // a read
    Date.now() // the clock
    new Date() // the clock again
    expect(spy.calls.some((c) => c.startsWith('child_process.'))).toBe(true)
    expect(spy.calls.some((c) => c.startsWith('fs.'))).toBe(true)
    expect(clockReads).toBe(2)
  })
})
