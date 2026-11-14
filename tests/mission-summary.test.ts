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
import { MISSION_SUMMARY_MAX, buildMissionSummary } from '../src/main/missions/summary'
import { waitingListV4 } from '../src/main/missions/waiting'

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

  it('lists a pending attach request as the next step when nothing else waits', () => {
    const m = mkMission({ steps: [mkStep('stp-1', { startedAt: AT })] })
    const req = {
      id: 'atr-1',
      missionId: MID,
      sessionId: 'bbbb2222-2222-4333-8444-555555555555',
      role: 'worked',
      at: AT,
      decision: null
    } as AttachRequest
    const { parts } = buildMissionSummary(m, '', { attachRequests: [req] })
    expect(parts.nextStep).toContain('Let session bbbb2222 join the mission')
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
