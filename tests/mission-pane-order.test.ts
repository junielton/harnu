// @vitest-environment jsdom
/**
 * Missions v4 · S-18 · AC-47 — a milestone's summary line counts running, waiting for review and
 * blocked; inside a milestone the steps run needs-the-operator first, then running, then the rest
 * collapsed behind "N more". Pure data (`buildPaneTree`) and mounted.
 *
 * The summary's numbers are the server's (`MilestoneView.counts`); to do steps are never in it. The
 * words are translated; none of them is read from the reply.
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

interface StepSeed {
  id: string
  title: string
  state: StepState
  blocked?: boolean
}
interface Waiting {
  kind: 'settle' | 'unblock' | 'review' | 'main-failing'
  stepId?: string
  stepIds?: string[]
}

/** One open milestone `mls-1` with the given steps, and the waiting items the server would list. */
function reply(
  steps: StepSeed[],
  waiting: Waiting[] = [],
  milestoneState: 'in-progress' | 'waiting-review' | 'done' | 'not-started' = 'in-progress'
): MissionV4ViewReply {
  const counts = {
    running: steps.filter((s) => s.state === 'running').length,
    waitingReview: steps.filter((s) => s.state === 'waiting-review').length,
    blocked: steps.filter((s) => s.blocked === true).length
  }
  const items = waiting.map((w, i) => ({ id: `w${i}`, ask: `Ask ${i}`, why: `Why ${i}`, ...w }))
  return {
    state: 'mission',
    missionId: 'mnt-order',
    source: 'v4',
    detail: {
      ok: true,
      id: 'mnt-order',
      title: 'Order inside a milestone',
      doneWhen: 'Never shown',
      status: 'open',
      state: 'open',
      stateLabel: 'Open',
      standing: 'operator',
      leads: null,
      source: 'v4',
      progress: {
        unit: 'milestones',
        total: 1,
        done: milestoneState === 'done' ? 1 : 0,
        headline: 'x',
        current: milestoneState === 'done' ? null : { id: 'mls-1', ordinal: 1 },
        allDone: false,
        counts: { todo: 0, running: 0, waitingReview: 0, done: 0, blocked: 0 }
      },
      milestones: [
        {
          id: 'mls-1',
          title: 'The only milestone',
          optional: false,
          waitsFor: null,
          state: milestoneState,
          stateLabel: 'ZZZ',
          counts
        }
      ],
      steps: steps.map((s) => ({
        id: s.id,
        title: s.title,
        milestone: 'mls-1',
        optional: false,
        state: s.state,
        stateLabel: 'ZZZ',
        blocked: s.blocked === true,
        card: null,
        startedAt: null,
        waitsFor: null,
        criteria: [],
        open: [],
        blockers: [],
        links: []
      })),
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
        role: 'leads',
        from: '2026-11-14T10:00:00.000Z',
        to: null,
        stoppedAt: null,
        open: true
      }
    ],
    handoff: { offer: false }
  } as unknown as MissionV4ViewReply
}

const detailOf = (r: MissionV4ViewReply): never => (r as { detail: never }).detail

/** Eight steps, one of each kind of trouble, in a plan order that is NOT the display order. */
const STEPS: StepSeed[] = [
  { id: 'stp-1', title: 'Write the schema', state: 'todo' },
  { id: 'stp-2', title: 'Load the files', state: 'waiting-review' },
  { id: 'stp-3', title: 'Score a spec', state: 'running' },
  { id: 'stp-4', title: 'Keep a hidden set', state: 'done' },
  { id: 'stp-5', title: 'Report the results', state: 'waiting-review' },
  { id: 'stp-6', title: 'Run on the whole set', state: 'running', blocked: true },
  { id: 'stp-7', title: 'Confirm the plan', state: 'todo' },
  { id: 'stp-8', title: 'Show the scores', state: 'running' }
]
const OWED: Waiting[] = [
  { kind: 'review', stepIds: ['stp-5'] },
  { kind: 'unblock', stepId: 'stp-6' },
  { kind: 'settle', stepId: 'stp-7' }
]

describe('AC-47 — the order inside a milestone (data)', () => {
  it('the order inside a milestone', () => {
    const [m] = buildPaneTree(detailOf(reply(STEPS, OWED))).milestones
    // Needs the operator first (plan order), then running (plan order); nothing is repeated.
    expect(m.shown.map((s) => s.id)).toEqual(['stp-5', 'stp-6', 'stp-7', 'stp-3', 'stp-8'])
    // Everything else is folded behind "N more", in plan order.
    expect(m.folded.map((s) => s.id)).toEqual(['stp-1', 'stp-2', 'stp-4'])
  })

  it('marks the steps the operator owes, from the waiting list and nothing else', () => {
    const [m] = buildPaneTree(detailOf(reply(STEPS, OWED))).milestones
    expect(m.shown.filter((s) => s.needsYou).map((s) => s.id)).toEqual(['stp-5', 'stp-6', 'stp-7'])
    expect(m.folded.some((s) => s.needsYou)).toBe(false)
  })

  it('with nothing owed, running steps come first and the rest fold', () => {
    const [m] = buildPaneTree(detailOf(reply(STEPS))).milestones
    expect(m.shown.map((s) => s.id)).toEqual(['stp-3', 'stp-6', 'stp-8'])
    expect(m.folded.map((s) => s.id)).toEqual(['stp-1', 'stp-2', 'stp-4', 'stp-5', 'stp-7'])
  })

  it('a step the operator owes that is done or folded by the server rank still shows first', () => {
    // A `main-failing` item names a merged (done) step: it is owed, so it leads.
    const [m] = buildPaneTree(
      detailOf(reply(STEPS, [{ kind: 'main-failing', stepId: 'stp-4' }]))
    ).milestones
    expect(m.shown.map((s) => s.id)).toEqual(['stp-4', 'stp-3', 'stp-6', 'stp-8'])
  })

  it('counts running, waiting for review and blocked from the server, never to do', () => {
    const [m] = buildPaneTree(detailOf(reply(STEPS, OWED))).milestones
    expect(m.counts).toEqual({ running: 3, waitingReview: 2, blocked: 1 })
  })

  it('counts a milestone by the steps the server says are done', () => {
    const [m] = buildPaneTree(detailOf(reply(STEPS))).milestones
    expect([m.done, m.total]).toEqual([1, 8])
  })
})

let current: MissionV4ViewReply
let wrapper: VueWrapper | null = null

async function mountPane(r: MissionV4ViewReply): Promise<VueWrapper> {
  current = r
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
    campaignList: vi.fn(async () => ({ views: [], unreadable: [] })),
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
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

const ids = (w: VueWrapper): string[] =>
  w.findAll('[data-test="step-row"]').map((r) => r.attributes('data-step') ?? '')

describe('AC-47 — the order inside a milestone (mounted)', () => {
  it('draws the owed and running steps first and folds the rest behind "N more steps"', async () => {
    const w = await mountPane(reply(STEPS, OWED))
    expect(ids(w)).toEqual(['stp-5', 'stp-6', 'stp-7', 'stp-3', 'stp-8'])
    const fold = w.get('[data-test="fold-more"]')
    expect(fold.text()).toBe('3 more steps')
    expect(fold.attributes('aria-expanded')).toBe('false')

    // One click unfolds them in place, in plan order, after the others; the link now says Show less.
    await fold.trigger('click')
    expect(ids(w)).toEqual(['stp-5', 'stp-6', 'stp-7', 'stp-3', 'stp-8', 'stp-1', 'stp-2', 'stp-4'])
    expect(w.get('[data-test="fold-more"]').text()).toBe('Show less')
    await w.get('[data-test="fold-more"]').trigger('click')
    expect(ids(w)).toHaveLength(5)
  })

  it('has no fold link when every step is shown', async () => {
    const w = await mountPane(
      reply([
        { id: 'stp-1', title: 'Build it', state: 'running' },
        { id: 'stp-2', title: 'Check it', state: 'running' }
      ])
    )
    expect(w.find('[data-test="fold-more"]').exists()).toBe(false)
  })

  it('marks the owed steps Yours and the blocked ones Blocked', async () => {
    const w = await mountPane(reply(STEPS, OWED))
    const text = (id: string): string => w.get(`[data-test="step-row"][data-step="${id}"]`).text()
    expect(text('stp-5')).toContain('Yours')
    expect(text('stp-6')).toContain('Blocked')
    expect(text('stp-3')).not.toContain('Yours')
    expect(text('stp-3')).not.toContain('Blocked')
  })
})

describe('AC-47 — the milestone summary line', () => {
  const summary = (w: VueWrapper): string => w.get('[data-test="milestone-summary"]').text()

  it('counts running, waiting for review and blocked, and not to do', async () => {
    const w = await mountPane(reply(STEPS, OWED))
    expect(summary(w)).toBe('3 running · 2 waiting for review · 1 blocked')
  })

  it('leaves a zero count out', async () => {
    const w = await mountPane(
      reply([
        { id: 'stp-1', title: 'Build it', state: 'running' },
        { id: 'stp-2', title: 'Later', state: 'todo' }
      ])
    )
    expect(summary(w)).toBe('1 running')
  })

  it('opens with "Nothing running" when only review waits', async () => {
    const w = await mountPane(
      reply(
        [
          { id: 'stp-1', title: 'Sign-in by code', state: 'waiting-review' },
          { id: 'stp-2', title: 'Later', state: 'todo' }
        ],
        [{ kind: 'review', stepIds: ['stp-1'] }]
      )
    )
    expect(summary(w)).toBe('Nothing running · 1 waiting for review')
  })

  it('says "Nothing running" when only to do steps are left', async () => {
    const w = await mountPane(reply([{ id: 'stp-1', title: 'Later', state: 'todo' }]))
    expect(summary(w)).toBe('Nothing running')
  })

  it('says every step is done for a done milestone the operator opened', async () => {
    const w = await mountPane(reply([{ id: 'stp-1', title: 'Built', state: 'done' }], [], 'done'))
    await w.get('[data-test="milestone-row"]').trigger('click')
    expect(summary(w)).toBe('Every step is done')
  })

  it('reads in Portuguese too', async () => {
    i18n.global.locale.value = 'pt-BR'
    const w = await mountPane(reply(STEPS, OWED))
    expect(summary(w)).toBe('3 em andamento · 2 aguardando revisão · 1 bloqueado')
  })
})
