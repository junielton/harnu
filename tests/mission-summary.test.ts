/**
 * Missions v4 · S-8 · AC-19 — the mission summary: five parts, plus the open criteria and the links, built
 * from the record alone, at most 8,000 characters.
 *
 * `buildMissionSummary` (src/main/missions/summary.ts) is pure. It replaces the post-compaction Mission
 * Brief and is what a fresh session starts from, so the test reads it the way a cold-start session would:
 * by looking for the goal, the position, what was decided, where each session stopped and the next step.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachRequest, MissionV4, StepV4 } from '../src/main/missions/model'
import { deriveProgress } from '../src/main/missions/progress'
import type { StepInput } from '../src/main/missions/state'
import {
  MISSION_SUMMARY_MAX,
  buildMissionSummary,
  missionListRow
} from '../src/main/missions/summary'
import { WAITING_EMPTY_LINE, deriveStepResults, waitingListV4 } from '../src/main/missions/waiting'

/** Counts every `deriveStepState` call, delegating to the real one (state.ts is what progress.ts calls). */
const derive = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../src/main/missions/state', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/missions/state')>()
  return {
    ...real,
    deriveStepState: (...args: Parameters<typeof real.deriveStepState>) => {
      derive.calls++
      return real.deriveStepState(...args)
    }
  }
})

const AT = '2026-11-14T10:00:00Z'
const MID = 'mnt-1a2b3c4d'

type CriterionIn = StepV4['acs'][number]
const crit = (
  id: string,
  by: CriterionIn['by'],
  extra: Record<string, unknown> = {}
): CriterionIn => ({ id, text: `Criterion ${id} holds`, by, ...extra }) as CriterionIn

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
    title: 'Measure harnu:spec, then fix what the numbers show',
    doneWhen: 'A test set we trust scores harnu:spec, and two fixes are each proven by the score.',
    status: 'open',
    milestones: [],
    steps: [],
    sessions: [],
    links: [],
    blockers: [],
    ...extra
  } as MissionV4
}

/** The log the verbs write: `### <time> · <kind> · <step>` headings, a plain note carries no kind. */
function logEntry(at: string, kind: string | null, text: string, stepId?: string): string {
  const tag = kind === null ? '' : ` · ${kind}${stepId ? ` · ${stepId}` : ''}`
  return `\n### ${at}${tag}\n\n${text}\n`
}

/** A 10-milestone, 21-step mission: 4 done, 2 running, 9 waiting for review (1 blocked), 6 to do. */
function bigMission(): { mission: MissionV4; inputs: Record<string, StepInput>; log: string } {
  const milestones = Array.from({ length: 10 }, (_, i) => ({
    id: `mls-${i + 1}`,
    title: `Milestone number ${i + 1} is true`,
    optional: false,
    waitsFor: null
  })) as MissionV4['milestones']
  const steps: StepV4[] = []
  const inputs: Record<string, StepInput> = {}
  for (let n = 1; n <= 21; n++) {
    const id = `stp-${n}`
    const milestone = `mls-${Math.ceil(n / 2.1)}`
    if (n <= 4) {
      steps.push(doneStep(id, { milestone }))
    } else if (n <= 6) {
      steps.push(
        mkStep(id, {
          milestone,
          startedAt: AT, // running: started, no pull request
          acs: [crit('ac-1', 'session', { text: `The work of ${id} runs end to end` })]
        })
      )
    } else if (n <= 15) {
      steps.push(
        mkStep(id, {
          milestone,
          title: `Open step ${n}`,
          acs: [
            crit('ac-1', 'fact', {
              text: `The pull request for ${id} is merged`,
              fact: 'pr-merged'
            }),
            crit('ac-2', 'operator', { text: `You read the page for ${id}` })
          ],
          links: [{ kind: 'pr', ref: String(300 + n) }],
          blockers:
            n === 7
              ? [
                  {
                    id: 'blk-1',
                    reason:
                      'This machine does not know where the test files are. Set HARNU_CORPUS_DIR.',
                    ask: 'Set HARNU_CORPUS_DIR to the folder with the test files',
                    unblocks: 'The scoring run starts',
                    owner: 'operator'
                  }
                ]
              : []
        })
      )
      inputs[id] = { pr: 'open' }
    } else {
      steps.push(mkStep(id, { milestone }))
    }
  }
  const mission = mkMission({
    milestones,
    steps,
    links: [{ kind: 'doc', ref: 'docs/specs/example/spec.md' }],
    sessions: [
      {
        id: 'lead0001-aaaa-4bbb-8ccc-dddddddddddd',
        role: 'leads',
        from: AT,
        to: null,
        stoppedAt: null
      },
      {
        id: 'work0002-aaaa-4bbb-8ccc-dddddddddddd',
        role: 'worked',
        from: AT,
        to: '2026-11-14T11:00:00Z',
        stoppedAt: { step: 'stp-5', waitingFor: 'the private test files' }
      }
    ]
  })
  let log = '\n## Log\n'
  for (let i = 1; i <= 7; i++) {
    log += logEntry(
      `2026-11-14T10:0${i}:00Z`,
      'decision',
      `Decision number ${i}: we chose option ${i}.`,
      'stp-1'
    )
    log += logEntry(`2026-11-14T10:3${i}:00Z`, 'note', `A passing note ${i}.`)
  }
  log += logEntry('2026-11-14T10:50:00Z', null, 'A note with no kind at all.')
  return { mission, inputs, log }
}

const HEADINGS = ['## Goal', '## Where it is', '## Decided', '## Stopped at', '## Next step']

describe('AC-19 · the summary', () => {
  it('the summary has five parts and a cap', () => {
    const { mission, inputs, log } = bigMission()
    const { text, parts } = buildMissionSummary(mission, log, { inputs })

    // Five parts, in this order, then the open criteria and the links.
    const at = [...HEADINGS, '## Open criteria', '## Links'].map((h) => text.indexOf(h))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)

    // Goal
    expect(parts.goal).toContain('Measure harnu:spec, then fix what the numbers show')
    expect(parts.goal).toContain('A test set we trust scores harnu:spec')

    // Where it is: the position among milestones and the four counts
    expect(parts.whereItIs).toContain('Milestone 3 of 10') // milestones 1 and 2 are done
    expect(parts.whereItIs).toContain('2 of 10 milestones done')
    expect(parts.whereItIs).toContain('4 done')
    expect(parts.whereItIs).toMatch(/2 running/)
    expect(parts.whereItIs).toMatch(/9 waiting for review/)
    expect(parts.whereItIs).toMatch(/6 to do/)

    // Decided: the last five decision entries, newest last; notes are not decisions
    expect(parts.decided).toContain('Decision number 7')
    expect(parts.decided).toContain('Decision number 3')
    expect(parts.decided).not.toContain('Decision number 2')
    expect(parts.decided).not.toContain('A passing note')

    // Stopped at: per session
    expect(parts.stoppedAt).toContain('work0002')
    expect(parts.stoppedAt).toContain('stp-5')
    expect(parts.stoppedAt).toContain('the private test files')
    expect(parts.stoppedAt).toContain('lead0001')

    // Next step: the first waiting item, with what it unlocks
    const next = waitingListV4(mission, { inputs }).next
    expect(next?.kind).toBe('unblock')
    expect(parts.nextStep).toContain(next?.ask)
    expect(parts.nextStep).toContain(next?.why)

    // Open criteria of the open steps only; done steps' and to-do steps' are not there
    expect(parts.openCriteria).toContain('You read the page for stp-9')
    expect(parts.openCriteria).toContain('The work of stp-5 runs end to end') // a running step is open
    expect(parts.openCriteria).not.toContain('Criterion ac-1 holds')

    // Links: the mission's and those of the open steps
    expect(parts.links).toContain('docs/specs/example/spec.md')
    expect(parts.links).toContain('#309')

    // The cap
    expect(text.length).toBeLessThanOrEqual(MISSION_SUMMARY_MAX)
    expect(MISSION_SUMMARY_MAX).toBe(8000)
  })

  it('stays under the cap on a record whose texts are all huge, keeping the five parts', () => {
    const { mission, inputs, log } = bigMission()
    const huge = 'a very long sentence that nobody wrote a cap for '.repeat(60)
    mission.title = huge
    mission.doneWhen = huge
    for (const s of mission.steps) {
      for (const c of s.acs) c.text = huge
      s.links.push({ kind: 'url', ref: `http://localhost:5173/${'x'.repeat(300)}` })
    }
    const bigLog =
      log +
      Array.from({ length: 8 }, (_, i) =>
        logEntry(`2026-11-14T12:0${i}:00Z`, 'decision', huge, 'stp-2')
      ).join('')
    const { text } = buildMissionSummary(mission, bigLog, { inputs })
    expect(text.length).toBeLessThanOrEqual(MISSION_SUMMARY_MAX)
    for (const h of HEADINGS) expect(text).toContain(h)
    expect(text).toContain('## Next step')
  })

  it('is built from the record alone: the same record gives the same text, with no inputs at all', () => {
    const { mission, log } = bigMission()
    const a = buildMissionSummary(mission, log)
    const b = buildMissionSummary(structuredClone(mission), log)
    expect(a.text).toBe(b.text)
    for (const h of HEADINGS) expect(a.text).toContain(h)
  })

  it('reads a small mission with no milestone, no log and no session', () => {
    const m = mkMission({ steps: [mkStep('stp-1'), doneStep('stp-2')] })
    const { text, parts } = buildMissionSummary(m, '')
    for (const h of HEADINGS) expect(text).toContain(h)
    expect(parts.whereItIs).toContain('Step 1 of 2')
    expect(parts.decided).toMatch(/nothing/i)
    expect(parts.stoppedAt).toMatch(/no session/i)
    expect(parts.nextStep).toMatch(/nothing/i)
  })

  it('says the mission is ready to close in the next step, and offers the close', () => {
    const m = mkMission({ steps: [doneStep('stp-1')] })
    const { parts } = buildMissionSummary(m, '')
    expect(parts.nextStep).toContain('Close the mission')
  })

  it('lists a pending attach request, read from the record, as the next step when nothing else waits', () => {
    const req = {
      id: 'atr-1',
      missionId: MID,
      sessionId: 'bbbb2222-2222-4333-8444-555555555555',
      at: AT,
      decision: null
    } as AttachRequest
    const m = mkMission({ steps: [mkStep('stp-1', { startedAt: AT })], attachRequests: [req] })
    const { parts } = buildMissionSummary(m, '')
    expect(parts.nextStep).toContain('Let another session join this mission')
    expect(parts.nextStep).not.toContain('bbbb2222') // the id is the door target, not the text
  })

  it('does not read the clock', () => {
    const { mission, log } = bigMission()
    const RealDate = Date
    let reads = 0
    class CountingDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) reads++
        super(...(args as [number]))
      }
      static now(): number {
        reads++
        return RealDate.now()
      }
    }
    vi.stubGlobal('Date', CountingDate)
    buildMissionSummary(mission, log)
    expect(reads).toBe(0)
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('the summary agrees with progress', () => {
  it('uses the milestone position deriveProgress reports', () => {
    const { mission, inputs, log } = bigMission()
    const p = deriveProgress(mission, inputs)
    const { parts } = buildMissionSummary(mission, log, { inputs })
    expect(parts.whereItIs).toContain(`${p.current?.ordinal ?? 0} of ${p.total}`)
  })
})

// ---- Delta 1 · AC-19's cap clause must be able to fail -----------------------------------

describe('the cap clause: a record that does not fit loses whole lines, never the five parts', () => {
  /** 60 open steps, five criteria and three links each: far more than 8,000 characters unfitted. */
  function crowded(): { mission: MissionV4; inputs: Record<string, StepInput> } {
    const steps: StepV4[] = []
    const inputs: Record<string, StepInput> = {}
    for (let n = 1; n <= 60; n++) {
      const id = `stp-${n}`
      steps.push(
        mkStep(id, {
          title: `Build the part number ${n} of the reporting pipeline`,
          acs: [1, 2, 3, 4, 5].map((k) =>
            crit(`ac-${k}`, 'session', {
              text: `Check ${k} of part ${n} passes on the full data set`
            })
          ),
          links: [
            { kind: 'pr', ref: String(500 + n) },
            { kind: 'url', ref: `http://localhost:5173/report/part-${n}` },
            { kind: 'worktree', ref: `.claude/worktrees/part-${n}` }
          ]
        })
      )
      inputs[id] = { pr: 'open' }
    }
    return { mission: mkMission({ steps }), inputs }
  }

  it('stays at most 8,000 characters, keeps the five headings in order and says what it left out', () => {
    const { mission, inputs } = crowded()
    // What it would take unfitted: every open step, criterion and link, one line each.
    const unfitted = mission.steps.reduce(
      (n, s) =>
        n +
        s.title.length +
        s.acs.reduce((k, c) => k + c.text.length + 6, 0) +
        s.links.reduce((k, l) => k + l.ref.length + 20, 0),
      0
    )
    expect(unfitted).toBeGreaterThan(MISSION_SUMMARY_MAX)

    const { text, parts } = buildMissionSummary(mission, '', { inputs })
    expect(text.length).toBeLessThanOrEqual(MISSION_SUMMARY_MAX)
    const at = [...HEADINGS, '## Open criteria', '## Links'].map((h) => text.indexOf(h))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(parts.openCriteria).toMatch(/…and \d+ more lines? not shown/)
    expect(parts.links).toMatch(/…and \d+ more links? not shown/)
    // What is shown is whole: every criterion line ends with who settles it.
    for (const line of parts.openCriteria.split('\n').filter((l) => l.startsWith('  - '))) {
      expect(line).toMatch(/\(a second session\)$/)
    }
  })
})

// ---- Delta 1 · the summary a fresh session reads --------------------------------------------

describe('the summary never cuts mid-sentence', () => {
  const sentence = (n: number): string =>
    `Sentence ${n} explains the choice we made and why the other option lost.`

  it('ends a long decision at a sentence and says the rest is in the Log', () => {
    const { mission, log } = bigMission()
    const long = [1, 2, 3, 4, 5, 6].map(sentence).join(' ')
    expect(long.length).toBeGreaterThan(260)
    const bigLog = log + logEntry('2026-11-14T12:00:00Z', 'decision', long, 'stp-2')
    const { parts } = buildMissionSummary(mission, bigLog)
    const last = parts.decided.split('\n').at(-1) ?? ''
    expect(last).toMatch(
      /Sentence \d explains the choice we made and why the other option lost\. \(more in the Log\)$/
    )
    expect(last).not.toContain('…')
    // A decision that fits is shown whole, with no marker.
    expect(parts.decided).toContain('Decision number 6: we chose option 6.')
    expect(parts.decided).not.toMatch(/Decision number 6[^\n]*more in the Log/)
  })

  it('never shortens the mission title, and ends Done when at a sentence', () => {
    const { mission, log } = bigMission()
    mission.title = `${'A mission title that a legacy record wrote far too long to fit anywhere '.repeat(6)}end`
    mission.doneWhen = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(sentence).join(' ')
    const { parts } = buildMissionSummary(mission, log)
    expect(parts.goal).toContain(mission.title)
    expect(parts.goal).toMatch(
      /Sentence \d explains the choice we made and why the other option lost\. \(more in the Log\)$/
    )
  })

  it('keeps a criterion indented under its step, and ends a long one at a sentence', () => {
    const { mission, inputs, log } = bigMission()
    const step = mission.steps.find((s) => s.id === 'stp-9') as StepV4
    step.acs[1].text = [1, 2, 3, 4].map(sentence).join(' ')
    const { parts } = buildMissionSummary(mission, log, { inputs })
    const lines = parts.openCriteria.split('\n')
    const at = lines.findIndex((l) => l.startsWith('- stp-9 '))
    expect(at).toBeGreaterThanOrEqual(0)
    // The step starts at the margin, its criteria are indented two spaces, none is trimmed.
    expect(lines[at + 1]).toMatch(/^ {2}- /)
    expect(lines[at + 2]).toMatch(
      /^ {2}- Sentence \d explains .* \(more in the Log\) \(the operator\)$/
    )
  })
})

describe('what a fresh session reads at a hand-off', () => {
  it('counts what it says it counts: blocked is its own count, never a share of another', () => {
    const { mission, inputs, log } = bigMission()
    const { parts } = buildMissionSummary(mission, log, { inputs })
    expect(parts.whereItIs).toContain(
      'Steps: 4 done · 2 running · 9 waiting for review · 6 to do · 1 blocked'
    )
    expect(parts.whereItIs).not.toMatch(/\(\d+ blocked\)/)
  })

  it('names each blocked step with its blocker’s ask, or its reason when it has none', () => {
    const { mission, inputs, log } = bigMission()
    const withReason = mission.steps.find((s) => s.id === 'stp-8') as StepV4
    withReason.blockers = [
      {
        id: 'blk-1',
        reason: 'Waiting for the key from ops',
        owner: 'agent'
      } as StepV4['blockers'][number]
    ]
    const { parts } = buildMissionSummary(mission, log, { inputs })
    expect(parts.whereItIs).toContain(
      'stp-7 Open step 7: Set HARNU_CORPUS_DIR to the folder with the test files'
    )
    expect(parts.whereItIs).toContain('stp-8 Open step 8: Waiting for the key from ops')
  })

  it('lists by title the steps that wait for review', () => {
    const { mission, inputs, log } = bigMission()
    const { parts } = buildMissionSummary(mission, log, { inputs })
    expect(parts.whereItIs).toContain('Waiting for review:')
    for (const n of [7, 8, 9, 15]) expect(parts.whereItIs).toContain(`Open step ${n}`)
    expect(parts.whereItIs).not.toContain('Open step 16') // a to do step is not waiting for review
  })

  it('keeps the next step the operator’s first waiting item, as the spec says', () => {
    const { mission, inputs, log } = bigMission()
    const { parts } = buildMissionSummary(mission, log, { inputs })
    const next = waitingListV4(mission, { inputs }).next
    expect(parts.nextStep.split('\n')[0]).toBe(`${next?.ask} — ${next?.why}`)
  })

  it('uses the one empty line the waiting list words', () => {
    const { parts } = buildMissionSummary(mkMission({ steps: [mkStep('stp-1')] }), '')
    expect(parts.nextStep).toBe(WAITING_EMPTY_LINE)
  })
})

// ---- Delta 1 · additive exports ------------------------------------------------------------------

describe('a one-line row for mission_list', () => {
  it('is title · progress words · the next ask', () => {
    const { mission, inputs } = bigMission()
    const next = waitingListV4(mission, { inputs }).next
    expect(missionListRow(mission, { inputs })).toBe(
      `${mission.title} · 2 of 10 milestones done · ${next?.ask}`
    )
  })

  it('counts steps when there is no milestone, and says the empty line when nothing waits', () => {
    const m = mkMission({ steps: [mkStep('stp-1'), doneStep('stp-2')] })
    expect(missionListRow(m)).toBe(`${m.title} · 1 of 2 steps done · ${WAITING_EMPTY_LINE}`)
  })

  it('says "1 of 1 milestone done", not "milestones", for a single milestone', () => {
    const m = mkMission({
      milestones: [
        { id: 'mls-1', title: 'Every page is on the new site', optional: false, waitsFor: null }
      ],
      steps: [doneStep('stp-1', { milestone: 'mls-1' })]
    })
    expect(missionListRow(m)).toContain(' · 1 of 1 milestone done · ')
    expect(buildMissionSummary(m, '').parts.whereItIs).toContain('1 of 1 milestone done')
  })

  it('says closed for a closed mission', () => {
    const m = mkMission({ status: 'closed', closedAs: 'delivered', steps: [doneStep('stp-1')] })
    expect(missionListRow(m)).toBe(`${m.title} · closed · ${WAITING_EMPTY_LINE}`)
  })

  it('is one line even when a text has line breaks', () => {
    const m = mkMission({ title: 'A title\nwith a break', steps: [mkStep('stp-1')] })
    expect(missionListRow(m)).not.toContain('\n')
  })
})

describe('one derive of every step, shared', () => {
  it('a view derives each step twice at most: once for progress, once for the criteria', () => {
    const { mission, inputs, log } = bigMission()
    const n = mission.steps.length

    derive.calls = 0
    const progress = deriveProgress(mission, inputs)
    const results = deriveStepResults(mission, inputs)
    expect(derive.calls).toBe(2 * n)

    // Given both, the list and the summary derive nothing again.
    derive.calls = 0
    waitingListV4(mission, { inputs, progress, results })
    buildMissionSummary(mission, log, { inputs, progress, results })
    missionListRow(mission, { inputs, progress, results })
    expect(derive.calls).toBe(0)

    // Given nothing, each of them still derives each step twice, not three or five times.
    derive.calls = 0
    buildMissionSummary(mission, log, { inputs })
    expect(derive.calls).toBe(2 * n)
    derive.calls = 0
    waitingListV4(mission, { inputs })
    expect(derive.calls).toBe(2 * n)
  })
})
