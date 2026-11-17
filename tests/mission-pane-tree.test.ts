// @vitest-environment jsdom
/**
 * Missions v4 · S-18 · AC-44, AC-45, AC-48, AC-49 — the glance of the Mission pane, mounted against the
 * real stores with `window.api` faked.
 *
 * - AC-44: at a glance the pane shows the title, the progress bar with the count inside it, ONE next
 *   step and "N more waiting on you", and no Done when paragraph.
 * - AC-45: the tree opens with chevrons, milestone then step then criteria, and only the current
 *   milestone opens by itself.
 * - AC-48: a 10-milestone mission where nothing runs and five things wait shows the next step first and
 *   the other four one click away.
 * - AC-49: a milestone that waits on one that is not the previous says "waits for" and names it.
 *
 * The tree reads the view; it computes no state itself (the states and the progress are the server's).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionPane from '../src/renderer/src/components/MissionPane.vue'
import { buildPaneTree } from '../src/renderer/src/lib/mission-pane-view'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

const FOLDER = '/repo'
const SESSION = 'S1'

type StepState = 'todo' | 'running' | 'waiting-review' | 'done'
type MilestoneState = 'not-started' | 'in-progress' | 'waiting-review' | 'done'

interface StepSeed {
  id: string
  milestone?: string
  title: string
  state: StepState
  blocked?: boolean
  pr?: string
  /** Criteria as [text, settled]. */
  criteria?: Array<[string, boolean]>
}
interface MilestoneSeed {
  id: string
  title: string
  state: MilestoneState
  optional?: boolean
  waitsFor?: string | null
}
interface WaitingSeed {
  kind: 'main-failing' | 'unblock' | 'settle' | 'review' | 'close' | 'attach'
  stepId?: string
  stepIds?: string[]
  ask: string
  why: string
}
interface Seed {
  title?: string
  milestones: MilestoneSeed[]
  steps: StepSeed[]
  /** The server's current milestone (or step, with no milestones). */
  current: string | null
  waiting?: WaitingSeed[]
  progress?: { unit: 'milestones' | 'steps'; total: number; done: number }
}

/** A reply the way the server builds one (S-12's `missionGet`), with the counts it would derive. */
function reply(seed: Seed): MissionV4ViewReply {
  const optionalMilestones = new Set(seed.milestones.filter((m) => m.optional).map((m) => m.id))
  const isOptional = (s: StepSeed): boolean =>
    s.milestone !== undefined && optionalMilestones.has(s.milestone)
  const milestones = seed.milestones.map((m) => {
    const own = seed.steps.filter((s) => s.milestone === m.id && !isOptional(s))
    return {
      id: m.id,
      title: m.title,
      optional: m.optional === true,
      waitsFor: m.waitsFor ?? null,
      state: m.state,
      stateLabel: 'ZZZ server words',
      counts: {
        running: own.filter((s) => s.state === 'running').length,
        waitingReview: own.filter((s) => s.state === 'waiting-review').length,
        blocked: own.filter((s) => s.blocked === true).length
      }
    }
  })
  const steps = seed.steps.map((s) => ({
    id: s.id,
    title: s.title,
    milestone: s.milestone ?? null,
    optional: isOptional(s),
    state: s.state,
    stateLabel: 'ZZZ server words',
    blocked: s.blocked === true,
    card: null,
    startedAt: null,
    waitsFor: null,
    criteria: (s.criteria ?? []).map(([text, settled], i) => ({
      id: `ac-${i + 1}`,
      text,
      by: 'session' as const,
      settled,
      via: settled ? ('session' as const) : null
    })),
    open: [],
    blockers: [],
    links: s.pr !== undefined ? [{ kind: 'pr' as const, ref: s.pr }] : []
  }))
  const counted = steps.filter((s) => !s.optional)
  const unit = seed.progress?.unit ?? (milestones.length > 0 ? 'milestones' : 'steps')
  const total =
    seed.progress?.total ??
    (unit === 'milestones' ? milestones.filter((m) => !m.optional).length : counted.length)
  const done =
    seed.progress?.done ??
    (unit === 'milestones'
      ? milestones.filter((m) => !m.optional && m.state === 'done').length
      : counted.filter((s) => s.state === 'done').length)
  const items = (seed.waiting ?? []).map((w, i) => ({ id: `w${i}`, ...w }))
  return {
    state: 'mission',
    missionId: 'mnt-glance',
    source: 'v4',
    detail: {
      ok: true,
      id: 'mnt-glance',
      title: seed.title ?? 'Collect partner listings every day',
      doneWhen: 'A DONE WHEN PARAGRAPH THE PANE MUST NOT DRAW',
      status: 'open',
      state: 'open',
      stateLabel: 'ZZZ server words',
      standing: 'operator',
      leads: null,
      source: 'v4',
      progress: {
        unit,
        total,
        done,
        headline: `${done} of ${total} ZZZ headline words`,
        current: seed.current === null ? null : { id: seed.current, ordinal: 1 },
        allDone: false,
        counts: {
          todo: counted.filter((s) => s.state === 'todo').length,
          running: counted.filter((s) => s.state === 'running').length,
          waitingReview: counted.filter((s) => s.state === 'waiting-review').length,
          done: counted.filter((s) => s.state === 'done').length,
          blocked: counted.filter((s) => s.blocked).length
        }
      },
      milestones,
      steps,
      next: items[0] ?? null,
      waiting: {
        items,
        next: items[0] ?? null,
        more: items.slice(1),
        moreLine: items.length > 1 ? `${items.length - 1} ZZZ moreLine words` : null,
        people: [],
        peopleLine: null,
        peopleLines: []
      },
      summary: '',
      links: [],
      blockers: [],
      sessions: []
    },
    closeWarnings: [],
    pendingDoneWhen: null,
    sessions: [
      {
        id: SESSION,
        role: 'leads' as const,
        from: '2026-11-14T10:00:00.000Z',
        to: null,
        stoppedAt: null,
        open: true
      }
    ],
    handoff: { offer: false }
  } as unknown as MissionV4ViewReply
}

let current: MissionV4ViewReply
let wrapper: VueWrapper | null = null

async function mountPane(r: MissionV4ViewReply): Promise<VueWrapper> {
  current = r
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
    missionV4View: vi.fn(async () => current),
    missionV4Door: vi.fn(),
    missionOperatorDoor: vi.fn(),
    requestAttention: vi.fn(),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined)
  }
  const sessions = useSessionsStore()
  sessions.folders = [
    { path: FOLDER, sessions: [{ sessionId: SESSION, projectPath: FOLDER }] }
  ] as never
  sessions.select(SESSION)
  const w = mount(MissionPane, {
    props: {
      pane: { id: 'h-mission', type: 'mission', cwd: FOLDER, ratio: 1 },
      worktreePath: FOLDER
    },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  wrapper = w
  await flushPromises()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  localStorage.clear()
  // The steps start closed (stp-21); these cases are about what is inside them.
  localStorage.setItem('om2tab.missionPane.sections', '{"tree":true}')
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** Three milestones: one done, the current one, one not started. */
const THREE: Seed = {
  milestones: [
    { id: 'mls-1', title: 'A test set we can trust', state: 'done' },
    { id: 'mls-2', title: 'A tool that scores a spec', state: 'in-progress' },
    { id: 'mls-3', title: 'Two fixes, each proven by the score', state: 'not-started' }
  ],
  steps: [
    { id: 'stp-1', milestone: 'mls-1', title: 'Load the test files', state: 'done', pr: '256' },
    { id: 'stp-2', milestone: 'mls-1', title: 'Keep an untouched set', state: 'done', pr: '257' },
    {
      id: 'stp-3',
      milestone: 'mls-2',
      title: 'Run the tool on the whole test set',
      state: 'running',
      criteria: [
        ['The run finishes on both test sets', false],
        ['The pull request is open and passes CI', true]
      ]
    },
    { id: 'stp-4', milestone: 'mls-3', title: 'Fix the slowest rule', state: 'todo' }
  ],
  current: 'mls-2'
}

const row = (w: VueWrapper, id: string) =>
  w.get(`[data-test="milestone-row"][data-milestone="${id}"]`)
const stepRow = (w: VueWrapper, id: string) => w.get(`[data-test="step-row"][data-step="${id}"]`)

describe('AC-45 — the tree opens with chevrons, and only the current milestone opens by itself', () => {
  it('only the current milestone opens', async () => {
    const w = await mountPane(reply(THREE))

    // Every milestone has a chevron and a row; exactly one is open: the server's current one.
    expect(w.findAll('[data-test="milestone-row"]')).toHaveLength(3)
    expect(w.findAll('[data-test="milestone-row"] [data-test="chevron"]')).toHaveLength(3)
    const open = w.findAll('[data-test="milestone-row"][aria-expanded="true"]')
    expect(open).toHaveLength(1)
    expect(open[0].attributes('data-milestone')).toBe('mls-2')

    // Its steps show; a closed milestone's steps do not.
    expect(w.find('[data-step="stp-3"]').exists()).toBe(true)
    expect(w.find('[data-step="stp-1"]').exists()).toBe(false)
    expect(w.find('[data-step="stp-4"]').exists()).toBe(false)

    // The operator opens another one with its chevron row; the current one stays open.
    await row(w, 'mls-1').trigger('click')
    expect(row(w, 'mls-1').attributes('aria-expanded')).toBe('true')
    expect(row(w, 'mls-2').attributes('aria-expanded')).toBe('true')
    expect(row(w, 'mls-3').attributes('aria-expanded')).toBe('false')
  })

  it('the tree is data first: one milestone opens by default and it is the server’s current one', () => {
    const tree = buildPaneTree((reply(THREE) as { detail: never }).detail)
    expect(tree.milestones.map((m) => [m.id, m.openByDefault])).toEqual([
      ['mls-1', false],
      ['mls-2', true],
      ['mls-3', false]
    ])
  })

  it('opens milestone, then step, then criteria, each behind a chevron', async () => {
    const w = await mountPane(reply(THREE))

    // The step is closed: no criteria yet, and its row says so.
    expect(stepRow(w, 'stp-3').attributes('aria-expanded')).toBe('false')
    expect(w.findAll('[data-test="criterion"]')).toHaveLength(0)

    await stepRow(w, 'stp-3').trigger('click')
    expect(stepRow(w, 'stp-3').attributes('aria-expanded')).toBe('true')
    // S-19: the settled criterion folds into one line; only the open one is listed.
    const criteria = w.findAll('[data-test="criterion"]')
    expect(criteria.map((c) => c.get('[data-test="criterion-text"]').text())).toEqual([
      'The run finishes on both test sets'
    ])
    expect(w.get('[data-test="criteria-verified"]').text()).toBe('1 criterion verified')
    // Nested: the criteria sit inside the open milestone's own box, after their step.
    const body = w.get('[data-test="milestone-body"][data-milestone="mls-2"]')
    expect(body.findAll('[data-test="criterion"]')).toHaveLength(1)
    expect(body.get('[data-step="stp-3"]').exists()).toBe(true)
  })

  it('a mission with no current milestone opens none', async () => {
    const w = await mountPane(
      reply({
        ...THREE,
        milestones: THREE.milestones.map((m) => ({ ...m, state: 'done' as const })),
        current: null
      })
    )
    expect(w.findAll('[data-test="milestone-row"][aria-expanded="true"]')).toHaveLength(0)
  })
})

describe('AC-49 — a milestone says what it waits for', () => {
  const seed = (waitsFor: Record<string, string>, states: MilestoneState[]): Seed => ({
    ...THREE,
    milestones: THREE.milestones.map((m, i) => ({
      ...m,
      state: states[i],
      waitsFor: waitsFor[m.id] ?? null
    }))
  })

  it('a milestone says what it waits for', async () => {
    // mls-3 waits for mls-1, which is NOT the one just before it (mls-2): the line names it.
    const w = await mountPane(
      reply(seed({ 'mls-3': 'mls-1' }, ['in-progress', 'in-progress', 'not-started']))
    )
    const line = w.get('[data-test="waits-for"][data-milestone="mls-3"]')
    expect(line.text()).toBe('Waits for “A test set we can trust”')
    expect(w.findAll('[data-test="waits-for"]')).toHaveLength(1)
  })

  it('says nothing when the one it waits for is the previous milestone', async () => {
    const w = await mountPane(
      reply(seed({ 'mls-3': 'mls-2' }, ['done', 'in-progress', 'not-started']))
    )
    expect(w.findAll('[data-test="waits-for"]')).toHaveLength(0)
  })

  it('says nothing once the milestone it waited for is done', async () => {
    const w = await mountPane(
      reply(seed({ 'mls-3': 'mls-1' }, ['done', 'in-progress', 'not-started']))
    )
    expect(w.findAll('[data-test="waits-for"]')).toHaveLength(0)
  })

  it('is data first: the waited-for milestone is named, never an id', () => {
    const tree = buildPaneTree(
      (
        reply(seed({ 'mls-3': 'mls-1' }, ['in-progress', 'in-progress', 'not-started'])) as {
          detail: never
        }
      ).detail
    )
    expect(tree.milestones.map((m) => m.waitsFor)).toEqual([
      null,
      null,
      { id: 'mls-1', title: 'A test set we can trust' }
    ])
  })

  it('reads in Portuguese too', async () => {
    i18n.global.locale.value = 'pt-BR'
    const w = await mountPane(
      reply(seed({ 'mls-3': 'mls-1' }, ['in-progress', 'in-progress', 'not-started']))
    )
    expect(w.get('[data-test="waits-for"]').text()).toBe('Espera por “A test set we can trust”')
  })
})

describe('BUG-283 OI-4 — a milestone that waits on two or more says so, naming each', () => {
  const FOUR: Seed = {
    ...THREE,
    milestones: [
      { id: 'mls-1', title: 'A test set we can trust', state: 'in-progress' },
      { id: 'mls-2', title: 'A tool that scores a spec', state: 'in-progress' },
      { id: 'mls-3', title: 'Two fixes, each proven by the score', state: 'in-progress' },
      { id: 'mls-4', title: 'Publish the notes', state: 'not-started', waitsFor: 'mls-1, mls-2' }
    ],
    steps: [...THREE.steps, { id: 'stp-5', milestone: 'mls-4', title: 'Write them', state: 'todo' }]
  }

  it('the row names every milestone it waits for', async () => {
    const w = await mountPane(reply(FOUR))
    const line = w.get('[data-test="waits-for"][data-milestone="mls-4"]')
    expect(line.text()).toBe('Waits for “A test set we can trust”, “A tool that scores a spec”')
  })

  it('a milestone that waits on one that is done names only the ones still open', async () => {
    const w = await mountPane(
      reply({
        ...FOUR,
        milestones: FOUR.milestones.map((m) => (m.id === 'mls-1' ? { ...m, state: 'done' } : m))
      })
    )
    expect(w.get('[data-test="waits-for"]').text()).toBe('Waits for “A tool that scores a spec”')
  })

  it('says nothing when every one it waits for is done, or the previous one', async () => {
    const w = await mountPane(
      reply({
        ...FOUR,
        milestones: FOUR.milestones.map((m) =>
          m.id === 'mls-4' ? { ...m, waitsFor: 'mls-3, mls-2' } : { ...m, state: 'done' as const }
        )
      })
    )
    expect(w.findAll('[data-test="waits-for"]')).toHaveLength(0)
  })

  it('is data first: the first is `waitsFor`, the rest `waitsForMore`, each named, never an id', () => {
    const tree = buildPaneTree((reply(FOUR) as { detail: never }).detail)
    expect(tree.milestones[3].waitsFor).toEqual({ id: 'mls-1', title: 'A test set we can trust' })
    expect(tree.milestones[3].waitsForMore).toEqual([
      { id: 'mls-2', title: 'A tool that scores a spec' }
    ])
    expect(tree.milestones[0].waitsForMore).toEqual([])
  })

  it('reads in Portuguese too', async () => {
    i18n.global.locale.value = 'pt-BR'
    const w = await mountPane(reply(FOUR))
    expect(w.get('[data-test="waits-for"]').text()).toBe(
      'Espera por “A test set we can trust”, “A tool that scores a spec”'
    )
  })
})

describe('AC-44 — the glance: title, bar with the count inside, one next step, no Done when', () => {
  const WAITING: WaitingSeed[] = [
    {
      kind: 'settle',
      stepId: 'stp-3',
      ask: 'Approve the plan for the scoring tool',
      why: '9 finished steps wait for it.'
    },
    {
      kind: 'unblock',
      stepId: 'stp-4',
      ask: 'Tell this machine where the private test files are',
      why: 'The test run starts right after.'
    },
    { kind: 'review', stepIds: ['stp-1'], ask: 'Look over 8 pull requests', why: 'All pass CI.' }
  ]

  it('shows the title, the bar with the count inside it, one next step and N more, and no Done when', async () => {
    const w = await mountPane(
      reply({
        ...THREE,
        title: 'Measure the spec',
        waiting: WAITING,
        progress: { unit: 'steps', total: 21, done: 4 }
      })
    )
    expect(w.get('[data-test="mission-title"]').text()).toBe('Measure the spec')

    const bar = w.get('[role="progressbar"]')
    expect(bar.attributes('aria-valuemin')).toBe('0')
    expect(bar.attributes('aria-valuemax')).toBe('21')
    expect(bar.attributes('aria-valuenow')).toBe('4')
    // The count is INSIDE the bar, written from the server's numbers.
    expect(bar.get('[data-test="mission-count"]').text()).toBe('4 of 21 steps done')
    expect(bar.get('[data-test="mission-bar-fill"]').attributes('style')).toContain('width: 19')

    // One next step: its ask and its why, as the server wrote them.
    const next = w.get('[data-test="next-step"]')
    expect(next.text()).toContain('Your next step')
    expect(next.text()).toContain('Approve the plan for the scoring tool')
    expect(next.text()).toContain('9 finished steps wait for it.')
    // "N more waiting on you" is written by the renderer from the number, never the server's moreLine.
    expect(w.get('[data-test="next-more"]').text()).toBe('2 more waiting on you')
    expect(w.text()).not.toContain('ZZZ moreLine')
    expect(w.text()).not.toContain('ZZZ headline')

    // No Done when paragraph.
    expect(w.text()).not.toContain('A DONE WHEN PARAGRAPH')
  })

  it('says nothing is waiting when nothing is, with the number of running steps', async () => {
    const w = await mountPane(reply({ ...THREE, waiting: [] }))
    const next = w.get('[data-test="next-step"]')
    expect(next.text()).toContain('Next step')
    expect(next.text()).not.toContain('Your next step')
    expect(next.text()).toContain('1 step is running. Nothing for you right now.')
    expect(w.find('[data-test="next-more"]').exists()).toBe(false)
  })
})

describe('AC-48 — a 10-milestone mission where nothing runs and five things wait', () => {
  const ten: Seed = {
    title: 'Collect partner listings every day, live in production',
    milestones: Array.from({ length: 10 }, (_, i) => ({
      id: `mls-${i + 1}`,
      title: `Milestone ${i + 1}`,
      state: (i === 0 ? 'done' : i === 1 ? 'waiting-review' : 'not-started') as MilestoneState
    })),
    steps: [
      { id: 'stp-1', milestone: 'mls-1', title: 'Foundation', state: 'done' },
      {
        id: 'stp-2',
        milestone: 'mls-2',
        title: 'Sign-in by code',
        state: 'waiting-review',
        pr: '21'
      }
    ],
    current: 'mls-2',
    waiting: [
      {
        kind: 'main-failing',
        stepId: 'stp-1',
        ask: 'main is failing since #16 was merged. Fix it or undo the merge.',
        why: 'Every open pull request stacks on it.'
      },
      {
        kind: 'review',
        stepIds: ['stp-2'],
        ask: 'Review and merge #21, sign-in and users',
        why: '3 other pull requests stack on it.'
      },
      {
        kind: 'settle',
        stepId: 'stp-2',
        ask: 'In two browsers, switch a user off',
        why: 'Sign-in and users'
      },
      {
        kind: 'settle',
        stepId: 'stp-2',
        ask: 'Run one live call to the fetch service',
        why: 'Page fetcher · uses 1 credit'
      },
      {
        kind: 'review',
        stepIds: ['stp-2'],
        ask: 'Review #27, #29 and #28',
        why: '#29 and #28 fail CI until main is fixed.'
      }
    ]
  }

  it('shows the next step first and the other four one click away', async () => {
    const w = await mountPane(reply(ten))
    const next = w.get('[data-test="next-step"]')
    // The pane words a kind it knows itself, from the record: here the step the failing main follows.
    expect(next.text()).toContain('Fix the main branch: it broke after “Foundation”')
    // The other four are not on the screen yet…
    expect(w.findAll('[data-test="next-rest-row"]')).toHaveLength(0)
    expect(w.get('[data-test="next-more"]').text()).toBe('4 more waiting on you')

    // …one click opens them, in place, in the server's order.
    await w.get('[data-test="next-more"]').trigger('click')
    const rows = w.findAll('[data-test="next-rest-row"]')
    expect(rows).toHaveLength(4)
    expect(rows[0].text()).toContain('Look over the pull request for “Sign-in by code”')
    // A kind with no record to word it from (here a criterion the record does not hold) keeps the server's words.
    expect(rows[1].text()).toContain('In two browsers, switch a user off')
    expect(rows[3].text()).toContain('Look over the pull request for “Sign-in by code”')
    expect(w.get('[data-test="next-more"]').text()).toBe('Show less')

    await w.get('[data-test="next-more"]').trigger('click')
    expect(w.findAll('[data-test="next-rest-row"]')).toHaveLength(0)
  })

  it('opens the step an item names with its button, and a close item has Close mission, not Open step', async () => {
    const w = await mountPane(
      reply({
        ...ten,
        waiting: [
          ...ten.waiting!.slice(1, 2),
          {
            kind: 'close',
            ask: 'Everything is done. Look it over and close the mission.',
            why: 'The end is proven.'
          }
        ]
      })
    )
    // Review of one step: Open step unfolds that step in the tree.
    const button = w.get('[data-test="next-open-step"]')
    expect(button.text()).toBe('Open step')
    expect(stepRow(w, 'stp-2').attributes('aria-expanded')).toBe('false')
    await button.trigger('click')
    expect(stepRow(w, 'stp-2').attributes('aria-expanded')).toBe('true')

    // A close item names no step, so it has no Open step. Since S-22 it has its own button: Close mission…
    // (its door is the pane's, see tests/mission-close-confirm.test.ts).
    await w.get('[data-test="next-more"]').trigger('click')
    const rest = w.get('[data-test="next-rest-row"]')
    expect(rest.text()).toContain('Close the mission: every step is done')
    expect(rest.find('[data-test="next-rest-open"]').exists()).toBe(false)
    expect(rest.get('[data-test="next-close"]').text()).toBe('Close mission…')
  })
})
