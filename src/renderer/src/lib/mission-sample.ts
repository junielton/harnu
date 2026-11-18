/**
 * Missions v4 · S-22 — the sample mission (design.md §6 "Mission pane" → The sample mission).
 *
 * A view object for the Mission pane that is built from nothing: no file, no IPC, no `window.api`, no
 * store. It exists so every state of the pane can be seen without a live mission, including the ones a real
 * mission is rarely in (a hand-off offered, a blocked step, a request to join). It is shaped exactly like what
 * `mission:v4View` answers, so the pane draws it with the code it draws a real mission with; nothing about the
 * pane knows it is a sample except the strip that says so. The words are the pane's own: a waiting item is
 * worded by `waitingText` from its kind and the steps below, and the strip's hints quote the labels the pane
 * really has, so the sample never writes the pane's copy a second time.
 *
 * Every state of the mockup (`docs/design/missions-v4/`, screen `mission-pane`) has an entry. The data is the
 * mockup's, with made-up names: no real folder, session or person. A state that is only a click on another
 * one (an open step, the Ask box, the hand-off confirmation) reuses that one's data and says which part of
 * the pane to open (`ui`); the three the pane cannot open for you (`waiting`, `all-steps`, `sessions`) say
 * how to reach them (`hint`). Each call returns fresh data: one state can never change another.
 */
import type { MissionV4ViewReply } from '../../../main/mission-ipc'

/** The mockup's states, in its order. */
export const SAMPLE_STATES = [
  'default',
  'waiting',
  'step-open',
  'step-blocked',
  'all-steps',
  'ask',
  'sessions',
  'handoff-suggest',
  'handoff-confirm',
  'clear',
  'done',
  'other-session',
  'simple',
  'simple-signoff',
  'big',
  'big-waiting',
  'no-mission',
  'attach-request',
  'closed'
] as const

export type SampleState = (typeof SAMPLE_STATES)[number]

/** What the pane opens by itself when a state is shown, for the states that are a click on another one. */
export interface SampleUi {
  /** Unfold this step in the tree. */
  openStep?: string
  /** Open the Ask box on this milestone. */
  ask?: string
  /** Open the hand-off confirmation. */
  handoff?: boolean
}

/** A request to join, for the sample's no-mission state: what the pane reads from the store for a real one. */
export interface SampleAsk {
  requestId: string
  missionId: string
  title: string
}

export interface Sample {
  state: SampleState
  /** The session the pane follows while the sample shows: it is never a real session's id. */
  sessionId: string
  /** The mission's title, or `null` for a state with no mission. */
  title: string | null
  reply: MissionV4ViewReply
  asks: SampleAsk[]
  ui: SampleUi
  /** The state is one click away from another one the pane cannot open for you: the chooser says which click. */
  hint: boolean
}

// ---- Builders: small, so each state reads as the thing it draws -----------------------------------------

const SESSION = 'sample-leader'
const WORKER = 'sample-worker'
const SCRATCH = 'sample-scratch'
const FROM = '2026-11-13T10:00:00.000Z'

type StepState = 'todo' | 'running' | 'waiting-review' | 'done'

interface StepSpec {
  id: string
  title: string
  state: StepState
  milestone?: string
  blocker?: { reason: string; ask: string; unblocks: string; owner: 'operator' | 'agent' }
  criteria?: CriterionSpec[]
  pr?: string
  links?: Array<{ kind: string; ref: string; label: string }>
}

interface CriterionSpec {
  text: string
  by: 'fact' | 'session' | 'operator' | 'person'
  person?: string
  settled?: boolean
}

const step = (s: StepSpec): Record<string, unknown> => {
  const criteria = (s.criteria ?? []).map((c, i) => ({
    id: `${s.id}-c${i + 1}`,
    text: c.text,
    by: c.by,
    ...(c.person !== undefined ? { person: c.person } : {}),
    settled: c.settled === true,
    via: c.settled === true ? c.by : null
  }))
  return {
    id: s.id,
    title: s.title,
    milestone: s.milestone ?? null,
    optional: false,
    state: s.state,
    stateLabel: s.state,
    blocked: s.blocker !== undefined && s.state !== 'done',
    card: null,
    startedAt: s.state === 'todo' ? null : '2026-11-14T08:00:00.000Z',
    waitsFor: null,
    criteria,
    open: criteria.filter((c) => !c.settled).map((c) => c.id),
    blockers:
      s.blocker === undefined
        ? []
        : [{ id: `${s.id}-b1`, ...s.blocker, raisedAt: '2026-11-14T07:40:00.000Z' }],
    links: [...(s.pr ? [{ kind: 'pr', ref: s.pr, label: `#${s.pr}` }] : []), ...(s.links ?? [])]
  }
}

interface MilestoneSpec {
  id: string
  title: string
  steps: StepSpec[]
}

/** The milestone's state, from its steps the way the server words it. */
const milestoneState = (steps: StepSpec[]): string => {
  if (steps.every((s) => s.state === 'done')) return 'done'
  if (steps.some((s) => s.state === 'waiting-review') && !steps.some((s) => s.state === 'running'))
    return 'waiting-review'
  return steps.some((s) => s.state !== 'todo') ? 'in-progress' : 'not-started'
}

const count = (steps: StepSpec[], state: StepState): number =>
  steps.filter((s) => s.state === state).length

interface MissionSpec {
  id: string
  title: string
  doneWhen: string
  milestones: MilestoneSpec[]
  /** A mission with no milestones: its steps sit directly on the timeline. */
  loose?: StepSpec[]
  waiting?: Array<Record<string, unknown>>
  /** The sessions: the first is the leader unless `leader` says otherwise. */
  sessions?: Array<{ id: string; role: 'leads' | 'worked'; open: boolean; to?: string }>
  leader?: string | null
  handoffPercent?: number
  pendingDoneWhen?: { text: string } | null
  closeWarnings?: Array<{ kind: string; count: number; text: string }>
}

/** What the close door would count as open on these steps: the ones not done, and the blockers still up. */
function openMatters(steps: StepSpec[]): Array<{ kind: string; count: number; text: string }> {
  const unfinished = steps.filter((s) => s.state !== 'done').length
  const blockers = steps.filter((s) => s.blocker !== undefined && s.state !== 'done').length
  return [
    ...(unfinished > 0
      ? [{ kind: 'unfinished-steps', count: unfinished, text: `${unfinished} not done` }]
      : []),
    ...(blockers > 0
      ? [{ kind: 'open-blockers', count: blockers, text: `${blockers} still open` }]
      : [])
  ]
}

function buildMission(spec: MissionSpec): MissionV4ViewReply {
  const loose = spec.loose ?? []
  const allSteps = [
    ...spec.milestones.flatMap((m) => m.steps.map((s) => ({ ...s, milestone: m.id }))),
    ...loose
  ]
  const ready = allSteps.length > 0 && allSteps.every((s) => s.state === 'done')
  const byMilestone = spec.milestones.length > 0
  const msDone = spec.milestones.filter((m) => m.steps.every((s) => s.state === 'done')).length
  const current = spec.milestones.find((m) => !m.steps.every((s) => s.state === 'done'))
  const items = spec.waiting ?? []
  const leader = spec.leader === undefined ? SESSION : spec.leader
  const sessions = spec.sessions ?? [{ id: SESSION, role: 'leads' as const, open: true }]
  const stepsDone = count(allSteps, 'done')
  return {
    state: 'mission',
    missionId: spec.id,
    source: 'v4',
    detail: {
      ok: true,
      id: spec.id,
      title: spec.title,
      doneWhen: spec.doneWhen,
      status: 'open',
      state: ready ? 'ready-to-close' : 'open',
      stateLabel: ready ? 'ready to close' : 'open',
      standing: 'operator',
      leads: leader,
      source: 'v4',
      progress: {
        unit: byMilestone ? 'milestones' : 'steps',
        total: byMilestone ? spec.milestones.length : allSteps.length,
        done: byMilestone ? msDone : stepsDone,
        headline: '',
        current: current ? { id: current.id, ordinal: spec.milestones.indexOf(current) + 1 } : null,
        allDone: ready,
        counts: {
          todo: count(allSteps, 'todo'),
          running: count(allSteps, 'running'),
          waitingReview: count(allSteps, 'waiting-review'),
          done: stepsDone,
          blocked: allSteps.filter((s) => s.blocker !== undefined && s.state !== 'done').length
        }
      },
      milestones: spec.milestones.map((m) => ({
        id: m.id,
        title: m.title,
        optional: false,
        waitsFor: null,
        state: milestoneState(m.steps),
        stateLabel: milestoneState(m.steps),
        counts: {
          running: count(m.steps, 'running'),
          waitingReview: count(m.steps, 'waiting-review'),
          blocked: m.steps.filter((s) => s.blocker !== undefined && s.state !== 'done').length
        }
      })),
      steps: allSteps.map(step),
      next: items[0] ?? null,
      waiting: {
        items,
        next: items[0] ?? null,
        more: items.slice(1),
        moreLine: null,
        people: [],
        peopleLine: null,
        peopleLines: []
      },
      summary: `# Mission ${spec.id}\n\n## Goal\n${spec.doneWhen}\n\n## Next step\nContinue where the session stopped.`,
      links: [],
      blockers: [],
      sessions: []
    },
    closeWarnings: spec.closeWarnings ?? openMatters(allSteps),
    pendingDoneWhen: spec.pendingDoneWhen ?? null,
    sessions: sessions.map((s) => ({
      id: s.id,
      role: s.role,
      from: FROM,
      to: s.to ?? null,
      stoppedAt: null,
      open: s.open
    })),
    handoff:
      spec.handoffPercent !== undefined
        ? { offer: true, percent: spec.handoffPercent }
        : { offer: false, percent: null }
  } as unknown as MissionV4ViewReply
}

// ---- The data of the states ----------------------------------------------------------------------------------

/** Fourteen steps of the middle milestone: five run, nine wait for the operator's review. */
const SCORING_TITLES = [
  'Write the plan for the scoring tool',
  'Read the spec the way a session reads it',
  'Score the headings of a spec',
  'Score the acceptance criteria of a spec',
  'Score the open decisions of a spec',
  'Score the slices and their order',
  'Score the proofs each criterion names',
  'Report one number per spec',
  'Report what pulled the number down',
  'Compare two versions of a spec',
  'Keep the scores of every run',
  'Show the scores as a table',
  'Show the scores as a trend',
  'Document how to run the tool'
]

/** An open step in review: three criteria settled, two open (one the operator's own). */
const reviewCriteria = (): CriterionSpec[] => [
  { text: 'Every proof names its test', by: 'session', settled: true },
  { text: 'The proofs are listed in the report', by: 'fact', settled: true },
  { text: 'The report opens on a phone', by: 'session', settled: true },
  { text: 'Check the scores of the first twelve specs by hand', by: 'operator' },
  { text: 'The whole test set runs end to end', by: 'session' }
]
const reviewLinks = (): NonNullable<StepSpec['links']> => [
  { kind: 'worktree', ref: '/sample/.claude/worktrees/card-score-proofs', label: '' },
  { kind: 'doc', ref: '/sample/.harnu/out/score-proofs', label: '' },
  { kind: 'url', ref: 'http://localhost:5173/score-report', label: '' }
]

function scoringSteps(): StepSpec[] {
  return SCORING_TITLES.map((title, i): StepSpec => {
    const n = i + 1
    return {
      id: `stp-${4 + n}`,
      title,
      state: n <= 5 ? 'running' : 'waiting-review',
      ...(n > 5 ? { pr: String(20 + n) } : {}),
      // Two of the steps are opened by the sample (`step-open`, `step-blocked`): they carry what an open step
      // draws, so the sample shows it fully (criteria with who settles them, and every kind of link).
      ...(n === 7 ? { criteria: reviewCriteria(), links: reviewLinks() } : {}),
      ...(n === 6
        ? {
            criteria: [{ text: 'The score of one spec is the same twice', by: 'session' as const }],
            links: [
              { kind: 'worktree', ref: '/sample/.claude/worktrees/card-score-slices', label: '' },
              { kind: 'doc', ref: '/sample/.harnu/out/score-slices', label: '' }
            ]
          }
        : {}),
      ...(n === 6
        ? {
            blocker: {
              reason: 'The scoring service needs an API key the session does not have.',
              ask: 'Add the key to the environment the session runs in.',
              unblocks: 'the key is set',
              owner: 'operator' as const
            }
          }
        : {})
    }
  })
}

const stepIdOfBlocked = 'stp-10'

const REVIEW = {
  kind: 'review',
  id: 'review',
  stepIds: ['stp-11'],
  prs: [{ number: 21 }],
  ask: 'Review and merge #21, sign-in and users',
  why: '3 other pull requests stack on it'
}
const UNBLOCK = {
  kind: 'unblock',
  id: 'unblock',
  stepId: stepIdOfBlocked,
  ask: 'Unblock: add the scoring service key',
  why: 'The step waits for it'
}
const SETTLE = {
  kind: 'settle',
  id: 'settle',
  stepId: 'stp-1',
  ask: 'Check the first test set by hand',
  why: 'Only you can say it is trustworthy'
}
const CLOSE = {
  kind: 'close',
  id: 'close',
  requested: false,
  ask: 'Everything is done. Look it over and close the mission.',
  why: 'The mission is finished once you close it'
}

const TITLE = 'Measure the spec skill, then fix what the numbers show'
const DONE_WHEN = 'The spec skill is scored, and both fixes are proven by the score.'

function measureMission(over: Partial<MissionSpec> = {}, allDone = false): MissionSpec {
  const done = (s: StepSpec): StepSpec => ({ ...s, state: 'done' })
  const m1: StepSpec[] = [
    'Pick twelve real specs',
    'Write what a good spec looks like',
    'Score each by hand',
    'Check the hand scores against each other'
  ].map((title, i) => ({
    id: `stp-${i + 1}`,
    title,
    state: 'done' as const
  }))
  const m2 = scoringSteps()
  const m3: StepSpec[] = [
    'Fix the weakest heading rule',
    'Fix the missing-proof rule',
    'Score again and keep the better version'
  ].map((title, i) => ({ id: `stp-${19 + i}`, title, state: 'todo' as const }))
  const milestones: MilestoneSpec[] = [
    { id: 'mls-1', title: 'A test set we can trust', steps: m1 },
    { id: 'mls-2', title: 'A tool that scores a spec', steps: allDone ? m2.map(done) : m2 },
    {
      id: 'mls-3',
      title: 'Two fixes, each proven by the score',
      steps: allDone ? m3.map(done) : m3
    }
  ]
  return {
    id: 'mnt-sample01',
    title: TITLE,
    doneWhen: DONE_WHEN,
    milestones,
    ...over
  }
}

const TABLE_TITLE = 'Build the data table section'
const SIGNOFFS = [
  'The QA analyst signed off',
  'The designer signed off',
  'The project manager was told it is done'
]

const taskCriteria = (): CriterionSpec[] =>
  [
    'Desktop matches the Figma frame, in light and dark',
    'Desktop adapts to every screen width',
    'Mobile matches the Figma frame, in light and dark',
    'Mobile adapts to every screen width',
    'Everything the design calls out works'
  ].map((text) => ({ text, by: 'session' as const }))

/** A small task: no milestones, the steps on the timeline, the criteria pulled from the task. */
function tableMission(signoff: boolean): MissionSpec {
  const build: StepSpec = {
    id: 'stp-1',
    title: 'Build the table, desktop and mobile',
    state: signoff ? 'done' : 'todo',
    ...(signoff ? { pr: '412' } : {}),
    criteria: taskCriteria().map((c) => ({ ...c, settled: signoff })),
    links: [
      { kind: 'page', ref: 'https://figma.example/design/data-table', label: 'Figma frame' },
      { kind: 'page', ref: 'https://tracker.example/task/412', label: 'Task in the tracker' }
    ]
  }
  const signoffs: StepSpec = {
    id: 'stp-2',
    title: 'Get the sign-offs',
    state: signoff ? 'running' : 'todo',
    criteria: [
      { text: SIGNOFFS[0], by: 'person', person: 'the QA analyst', settled: signoff },
      { text: SIGNOFFS[1], by: 'person', person: 'the designer' },
      { text: SIGNOFFS[2], by: 'operator' }
    ]
  }
  return {
    id: 'mnt-sample02',
    title: TABLE_TITLE,
    doneWhen:
      'The table matches the design on desktop and mobile, and the people who must approve have.',
    milestones: [],
    loose: [build, signoffs],
    sessions: [{ id: SESSION, role: 'leads', open: true }],
    waiting: signoff
      ? []
      : [
          {
            kind: 'unblock',
            id: 'unblock',
            stepId: 'stp-1',
            ask: 'Confirm the plan: one pull request, desktop and mobile',
            why: 'The build starts when you confirm.'
          }
        ]
  }
}

const TEN_TITLES = [
  'Pick the partners to collect from',
  'A collector that runs on a schedule',
  'Store the listings it finds',
  'Tell the partners apart',
  'Sign-in and users',
  'Show the listings to people',
  'Alert when a collector fails',
  'Back up what was collected',
  'Move it to production',
  'Watch it for a week'
]

/** A real mission: ten milestones, the first one done. */
function collectorMission(): MissionSpec {
  const milestones: MilestoneSpec[] = TEN_TITLES.map((title, i) => ({
    id: `mls-${i + 1}`,
    title,
    steps:
      i === 0
        ? [{ id: 'stp-1', title: 'Write down the partners', state: 'done' as const }]
        : i === 1
          ? [
              { id: 'stp-2', title: 'Run it once by hand', state: 'running' as const },
              { id: 'stp-3', title: 'Put it on a schedule', state: 'todo' as const }
            ]
          : i === 4
            ? [
                {
                  id: 'stp-4',
                  title: 'Open the sign-in page',
                  state: 'waiting-review' as const,
                  pr: '21'
                }
              ]
            : [{ id: `stp-${5 + i}`, title: `Do “${title.toLowerCase()}”`, state: 'todo' as const }]
  }))
  const items: Array<Record<string, unknown>> = [
    {
      kind: 'main-failing',
      id: 'main-failing',
      stepId: 'stp-2',
      ask: 'main is failing since #16 was merged. Fix it or undo the merge.',
      why: 'Every open pull request stacks on it.'
    },
    {
      kind: 'review',
      id: 'review',
      stepIds: ['stp-4'],
      prs: [{ number: 21 }],
      ask: 'Review and merge #21, sign-in and users',
      why: '3 other pull requests stack on it'
    },
    {
      kind: 'unblock',
      id: 'unblock',
      stepId: 'stp-3',
      ask: 'Unblock: add the production key',
      why: 'The step waits for it'
    },
    {
      kind: 'settle',
      id: 'settle',
      stepId: 'stp-2',
      ask: 'Check the first run by hand',
      why: 'Only you can say the listings are right'
    },
    {
      kind: 'review',
      id: 'review-2',
      stepIds: ['stp-4', 'stp-3'],
      prs: [],
      ask: 'Review #27, #29 and #28',
      why: 'They wait for you'
    }
  ]
  return {
    id: 'mnt-sample03',
    title: 'Collect partner listings every day, live in production',
    doneWhen: 'Every partner is collected every day, in production, for a week without a failure.',
    milestones,
    waiting: items,
    sessions: [{ id: SESSION, role: 'leads', open: true }]
  }
}

const noneRows = [
  {
    id: 'mnt-sample01',
    title: TITLE,
    headline: '4 of 21 steps done',
    leads: SESSION
  },
  {
    id: 'mnt-sample03',
    title: 'Collect partner listings every day, live in production',
    headline: '1 of 10 milestones done',
    leads: null
  }
]

const none = (missions = noneRows): MissionV4ViewReply =>
  ({ state: 'none', missions }) as unknown as MissionV4ViewReply

/** The sample for one state. Fresh data on every call. */
export function sampleOf(state: SampleState): Sample {
  const base = {
    state,
    sessionId: SESSION,
    asks: [] as SampleAsk[],
    ui: {} as SampleUi,
    hint: false
  }
  const mission = (spec: MissionSpec, extra: Partial<Sample> = {}): Sample => ({
    ...base,
    title: spec.title,
    reply: buildMission(spec),
    ...extra
  })
  const measure = (over: Partial<MissionSpec> = {}, allDone = false): MissionSpec =>
    measureMission(
      {
        waiting: [REVIEW, UNBLOCK, SETTLE],
        sessions: [
          { id: SESSION, role: 'leads', open: true },
          { id: WORKER, role: 'worked', open: true }
        ],
        ...over
      },
      allDone
    )

  switch (state) {
    case 'default':
      return mission(measure())
    case 'waiting':
      return mission(measure(), { hint: true })
    case 'step-open':
      return mission(measure(), { ui: { openStep: 'stp-11' } })
    case 'step-blocked':
      return mission(measure(), { ui: { openStep: stepIdOfBlocked } })
    case 'all-steps':
      return mission(measure(), { hint: true })
    case 'ask':
      return mission(measure(), { ui: { ask: 'mls-2' } })
    case 'sessions':
      return mission(measure(), { hint: true })
    case 'handoff-suggest':
      return mission(measure({ handoffPercent: 83 }))
    case 'handoff-confirm':
      return mission(measure({ handoffPercent: 83 }), { ui: { handoff: true } })
    case 'clear':
      return mission(measure({ waiting: [] }))
    case 'done':
      return mission(measure({ waiting: [CLOSE] }, true))
    case 'other-session':
      // The pane follows a worker of the mission: the leader is another session.
      return mission(measure(), { sessionId: WORKER })
    case 'simple':
      return mission(tableMission(false))
    case 'simple-signoff':
      return mission(tableMission(true))
    case 'big':
    case 'big-waiting':
      return mission(collectorMission(), { hint: state === 'big-waiting' })
    case 'no-mission':
      return { ...base, sessionId: SCRATCH, title: null, reply: none() }
    case 'attach-request':
      return {
        ...base,
        sessionId: SCRATCH,
        title: null,
        reply: none(),
        asks: [{ requestId: 'atr-sample', missionId: 'mnt-sample01', title: TITLE }]
      }
    case 'closed':
      // The mission was closed: it left the pane, the view finds none for the session, and none is open.
      return { ...base, title: null, reply: none([]) }
  }
}
