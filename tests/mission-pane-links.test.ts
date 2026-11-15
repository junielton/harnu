// @vitest-environment jsdom
/**
 * Missions v4 · S-19 · AC-50, AC-51, AC-52 — an open step of the Mission pane, mounted against the real
 * stores with `window.api` faked.
 *
 * - AC-50: an open step lists its criteria with who settles each, collapses the verified ones into one
 *   line ("19 criteria verified") and lists only the open ones.
 * - AC-51: a blocked step shows the exact thing needed and the unblock action; the operator marks an
 *   operator criterion done, and marks another person's approval when they give it.
 * - AC-52: the pull request number on a step is a link, and an open step lists the links its session
 *   produced (the finished page among them), from the links Harnu already collects and from mission_link.
 *
 * The pane reads the view and computes no state; the doors are the operator's and always go through
 * `window.api.missionV4Door`, after which the view is read again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import enMessages from '../src/renderer/src/i18n/en.json'
import MissionPane from '../src/renderer/src/components/MissionPane.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

const FOLDER = '/repo'
const SESSION = 'S1'
const MISSION = 'mnt-open-step'

type By = 'fact' | 'session' | 'operator' | 'person'
interface CriterionSeed {
  id: string
  text: string
  by: By
  settled?: boolean
  person?: string
  selfCheck?: boolean
}
interface BlockerSeed {
  id: string
  reason: string
  ask?: string
  unblocks?: string
  owner: 'agent' | 'operator'
  raisedAt?: string
}
interface StepSeed {
  id: string
  title: string
  state: 'todo' | 'running' | 'waiting-review' | 'done'
  startedAt?: string
  criteria?: CriterionSeed[]
  blockers?: BlockerSeed[]
  links?: Array<{ kind: 'pr' | 'url' | 'doc' | 'worktree' | 'session'; ref: string }>
}

/** A reply the way the server builds one: one milestone, so the step opens from the tree. */
function reply(
  steps: StepSeed[],
  extra: { pendingDoneWhen?: { text: string } | null; people?: unknown[] } = {}
): MissionV4ViewReply {
  const views = steps.map((s) => ({
    id: s.id,
    title: s.title,
    milestone: 'mls-1',
    optional: false,
    state: s.state,
    stateLabel: 'ZZZ server words',
    blocked: (s.blockers ?? []).length > 0,
    card: null,
    startedAt: s.startedAt ?? null,
    waitsFor: null,
    criteria: (s.criteria ?? []).map((c) => ({
      id: c.id,
      text: c.text,
      by: c.by,
      ...(c.person !== undefined ? { person: c.person } : {}),
      settled: c.settled === true,
      via: c.settled === true ? c.by : null,
      ...(c.selfCheck
        ? { selfCheck: { at: '2026-11-14T10:00:00.000Z', by: 'S9', evidence: 'x' } }
        : {})
    })),
    open: (s.criteria ?? []).filter((c) => c.settled !== true).map((c) => c.id),
    blockers: s.blockers ?? [],
    links: s.links ?? []
  }))
  return {
    state: 'mission',
    missionId: MISSION,
    source: 'v4',
    detail: {
      ok: true,
      id: 'ZZZ-detail-id-is-not-the-mission-id',
      title: 'Score a spec',
      doneWhen: 'ZZZ done when',
      status: 'open',
      state: 'open',
      stateLabel: 'ZZZ server words',
      standing: 'operator',
      leads: null,
      source: 'v4',
      progress: {
        unit: 'milestones',
        total: 1,
        done: 0,
        headline: 'ZZZ',
        current: { id: 'mls-1', ordinal: 1 },
        allDone: false,
        counts: { todo: 0, running: steps.length, waitingReview: 0, done: 0, blocked: 0 }
      },
      milestones: [
        {
          id: 'mls-1',
          title: 'A tool that scores a spec',
          optional: false,
          waitsFor: null,
          state: 'in-progress',
          stateLabel: 'ZZZ',
          counts: { running: steps.length, waitingReview: 0, blocked: 0 }
        }
      ],
      steps: views,
      next: null,
      waiting: {
        items: [],
        next: null,
        more: [],
        moreLine: null,
        people: extra.people ?? [],
        peopleLine: null,
        peopleLines: []
      },
      summary: '',
      links: [],
      blockers: [],
      sessions: []
    },
    closeWarnings: [],
    pendingDoneWhen: extra.pendingDoneWhen ?? null,
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

interface SessionLinkSeed {
  url: string
  kind: 'pr' | 'issue' | 'task' | 'figma' | 'doc' | 'web'
  label: string
  source: 'user' | 'agent'
  at?: string
}

let current: MissionV4ViewReply
let wrapper: VueWrapper | null = null
let door: ReturnType<typeof vi.fn>
let openExternal: ReturnType<typeof vi.fn>
let view: ReturnType<typeof vi.fn>

async function mountPane(
  r: MissionV4ViewReply,
  links: SessionLinkSeed[] = []
): Promise<VueWrapper> {
  current = r
  door = vi.fn(async () => ({ ok: true, changed: true }))
  openExternal = vi.fn(async () => undefined)
  view = vi.fn(async () => current)
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
    campaignList: vi.fn(async () => ({ views: [], unreadable: [] })),
    missionV4View: view,
    missionV4Door: door,
    missionOperatorDoor: vi.fn(),
    requestAttention: vi.fn(),
    sessionLinksList: vi.fn(async () =>
      links.map((l) => ({ detail: '', at: '2026-11-14T10:00:00.000Z', excerpt: '', ...l }))
    ),
    shellOpenExternal: openExternal,
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
  // The session's links are read a beat after the session is known (the composable debounces a flip).
  await new Promise((resolve) => setTimeout(resolve, 150))
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

const stepRow = (w: VueWrapper, id: string) => w.get(`[data-test="step-row"][data-step="${id}"]`)
const openStep = async (w: VueWrapper, id: string): Promise<void> => {
  await stepRow(w, id).trigger('click')
  await flushPromises()
}

describe('AC-50 — an open step lists its criteria, who settles each, and folds the verified ones', () => {
  const NINETEEN: CriterionSeed[] = Array.from({ length: 19 }, (_, i) => ({
    id: `ac-${i + 1}`,
    text: `Verified criterion ${i + 1}`,
    by: 'session' as const,
    settled: true
  }))
  const PLAN: StepSeed = {
    id: 'stp-1',
    title: 'Write the plan for the scoring tool',
    // Running, so the tree shows the step (a step waiting for review folds behind "N more steps").
    state: 'running',
    criteria: [
      ...NINETEEN,
      { id: 'ac-fact', text: 'The plan names the test files', by: 'fact' },
      { id: 'ac-second', text: 'Every reviewer question has an answer', by: 'session' },
      { id: 'ac-you', text: 'You approved the plan', by: 'operator' },
      { id: 'ac-person', text: 'The designer likes the layout', by: 'person', person: 'Dana' }
    ]
  }

  it('folds the settled ones into one line and lists only the open ones', async () => {
    const w = await mountPane(reply([PLAN]))
    await openStep(w, 'stp-1')

    const folded = w.get('[data-test="criteria-verified"]')
    expect(folded.text()).toBe('19 criteria verified')
    // Only the four open criteria are listed; none of the 19 settled ones is.
    const rows = w.findAll('[data-test="criterion"]')
    expect(rows.map((r) => r.get('[data-test="criterion-text"]').text())).toEqual([
      'The plan names the test files',
      'Every reviewer question has an answer',
      'You approved the plan',
      'The designer likes the layout'
    ])
    expect(w.text()).not.toContain('Verified criterion 1')
  })

  it('says who settles each open criterion: Harnu, a second session, you, another person', async () => {
    const w = await mountPane(reply([PLAN]))
    await openStep(w, 'stp-1')

    const by = (id: string) =>
      w.get(`[data-test="criterion"][data-criterion="${id}"] [data-test="criterion-by"]`).text()
    expect(by('ac-fact')).toBe('Checked automatically')
    expect(by('ac-second')).toBe('Checked by a second session')
    expect(by('ac-you')).toBe('You')
    expect(by('ac-person')).toBe('Waiting for Dana')
    // The settler is an identifier translated by i18n: the pane never prints the English word it was sent.
    expect(w.text()).not.toContain('ZZZ')
  })

  it('one settled criterion reads in the singular; none settled draws no folded line', async () => {
    const one = await mountPane(
      reply([
        {
          id: 'stp-1',
          title: 'Only one done',
          state: 'running',
          criteria: [
            { id: 'ac-1', text: 'A', by: 'session', settled: true },
            { id: 'ac-2', text: 'B', by: 'session' }
          ]
        }
      ])
    )
    await openStep(one, 'stp-1')
    expect(one.get('[data-test="criteria-verified"]').text()).toBe('1 criterion verified')
    one.unmount()
    wrapper = null
    // A second mount in one test needs its own stores: the first answer would still be the store's.
    setActivePinia(createPinia())

    const none = await mountPane(
      reply([
        {
          id: 'stp-1',
          title: 'Nothing done',
          state: 'running',
          criteria: [{ id: 'ac-1', text: 'A', by: 'session' }]
        }
      ])
    )
    await openStep(none, 'stp-1')
    expect(none.find('[data-test="criteria-verified"]').exists()).toBe(false)
  })

  it('a builder’s own check is labelled and the criterion stays open', async () => {
    const w = await mountPane(
      reply([
        {
          id: 'stp-1',
          title: 'Self check',
          state: 'running',
          criteria: [{ id: 'ac-1', text: 'The run finishes', by: 'session', selfCheck: true }]
        }
      ])
    )
    await openStep(w, 'stp-1')
    const row = w.get('[data-test="criterion"][data-criterion="ac-1"]')
    expect(row.get('[data-test="criterion-selfcheck"]').text()).toBe(
      'The session says it is done. Not checked yet.'
    )
  })
})

describe('AC-51 — a blocked step shows the exact thing needed; the operator’s doors', () => {
  const BLOCKED: StepSeed = {
    id: 'stp-3',
    title: 'Run the tool on the whole test set',
    state: 'running',
    blockers: [
      {
        id: 'blk-1',
        reason: 'This machine does not know where the private test files are.',
        ask: 'Set HARNU_CORPUS_DIR to their folder.',
        unblocks: 'The test run starts right after.',
        owner: 'operator',
        raisedAt: new Date(Date.now() - 40 * 60_000).toISOString()
      }
    ],
    criteria: [
      { id: 'ac-1', text: 'The run finishes on both test sets', by: 'session' },
      { id: 'ac-2', text: 'You read the report', by: 'operator' },
      { id: 'ac-3', text: 'The designer signs the report off', by: 'person', person: 'Dana' }
    ]
  }

  it('shows the reason, the exact ask, what it unblocks and how long it has waited', async () => {
    const w = await mountPane(reply([BLOCKED]))
    await openStep(w, 'stp-3')

    const blocker = w.get('[data-test="blocker"]')
    expect(blocker.get('[data-test="blocker-head"]').text()).toBe('Blocked · waiting for you · 40m')
    expect(blocker.text()).toContain('This machine does not know where the private test files are.')
    expect(blocker.get('[data-test="blocker-ask"]').text()).toBe(
      'Set HARNU_CORPUS_DIR to their folder.'
    )
    expect(blocker.get('[data-test="blocker-unblocks"]').text()).toBe(
      'The test run starts right after.'
    )
  })

  it('“Done, continue” clears the operator’s blocker through the door, then the view is read again', async () => {
    const w = await mountPane(reply([BLOCKED]))
    await openStep(w, 'stp-3')
    const reads = view.mock.calls.length

    await w.get('[data-test="blocker-clear"]').trigger('click')
    await flushPromises()

    expect(door).toHaveBeenCalledTimes(1)
    // The door is addressed with the mission id the reply was answered for, never `detail.id`.
    expect(door).toHaveBeenCalledWith({
      door: 'clearBlocker',
      folder: FOLDER,
      missionId: MISSION,
      blockerId: 'blk-1',
      stepId: 'stp-3'
    })
    expect(view.mock.calls.length).toBeGreaterThan(reads)
  })

  it('a blocker that is the session’s move has no button: the pane does not offer a door that is not yours', async () => {
    const w = await mountPane(
      reply([
        {
          ...BLOCKED,
          blockers: [{ id: 'blk-2', reason: 'Waiting for the build to finish.', owner: 'agent' }]
        }
      ])
    )
    await openStep(w, 'stp-3')
    expect(w.get('[data-test="blocker-head"]').text()).toBe('Blocked · waiting for the session')
    expect(w.find('[data-test="blocker-clear"]').exists()).toBe(false)
  })

  it('“Mark done” settles an operator criterion; the other person’s approval is marked the same way', async () => {
    const w = await mountPane(reply([BLOCKED]))
    await openStep(w, 'stp-3')

    await w
      .get('[data-test="criterion"][data-criterion="ac-2"] [data-test="criterion-mark"]')
      .trigger('click')
    await flushPromises()
    expect(door).toHaveBeenLastCalledWith({
      door: 'mark',
      folder: FOLDER,
      missionId: MISSION,
      stepId: 'stp-3',
      criterionId: 'ac-2'
    })

    const mark = w.get(
      '[data-test="criterion"][data-criterion="ac-3"] [data-test="criterion-mark"]'
    )
    expect(mark.text()).toBe('Mark approved')
    await mark.trigger('click')
    await flushPromises()
    expect(door).toHaveBeenLastCalledWith({
      door: 'mark',
      folder: FOLDER,
      missionId: MISSION,
      stepId: 'stp-3',
      criterionId: 'ac-3'
    })

    // A criterion a fact or a second session settles has no button: only the operator's and a person's do.
    expect(
      w.find('[data-test="criterion"][data-criterion="ac-1"] [data-test="criterion-mark"]').exists()
    ).toBe(false)
  })

  it('a door that fails says what to do, not the code', async () => {
    const w = await mountPane(reply([BLOCKED]))
    await openStep(w, 'stp-3')
    door.mockResolvedValueOnce({
      ok: false,
      code: 'NOT_FOUND',
      error: 'NOT_FOUND: mnt-open-step has no open blocker blk-1.'
    })

    await w.get('[data-test="blocker-clear"]').trigger('click')
    await flushPromises()

    const failure = w.get('[data-test="door-error"]')
    expect(failure.text()).toBe(enMessages.missionPane.step.error.NOT_FOUND)
    expect(w.text()).not.toContain('NOT_FOUND')
    expect(w.text()).not.toContain('blk-1')
  })

  it('a door that throws, or an unknown code, still says what to do', async () => {
    const w = await mountPane(reply([BLOCKED]))
    await openStep(w, 'stp-3')
    door.mockRejectedValueOnce(new Error('ipc gone'))

    await w.get('[data-test="blocker-clear"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-test="door-error"]').text()).toBe(enMessages.missionPane.step.error.other)
    expect(w.text()).not.toContain('ipc gone')
  })
})

describe('AC-51 — a Done when a session staged waits for the operator', () => {
  it('Approve and Decline call their doors', async () => {
    const w = await mountPane(
      reply([{ id: 'stp-1', title: 'A step', state: 'running' }], {
        pendingDoneWhen: { text: 'The scores are in a report we can read.' }
      })
    )
    const box = w.get('[data-test="done-when-staged"]')
    expect(box.text()).toContain('The scores are in a report we can read.')

    await w.get('[data-test="done-when-approve"]').trigger('click')
    await flushPromises()
    expect(door).toHaveBeenLastCalledWith({
      door: 'approveDoneWhen',
      folder: FOLDER,
      missionId: MISSION
    })

    await w.get('[data-test="done-when-decline"]').trigger('click')
    await flushPromises()
    expect(door).toHaveBeenLastCalledWith({
      door: 'declineDoneWhen',
      folder: FOLDER,
      missionId: MISSION
    })
  })

  it('draws nothing when no Done when is staged', async () => {
    const w = await mountPane(reply([{ id: 'stp-1', title: 'A step', state: 'running' }]))
    expect(w.find('[data-test="done-when-staged"]').exists()).toBe(false)
  })
})

describe('AC-52 — step links open and come from the session’s links', () => {
  const STEP: StepSeed = {
    id: 'stp-1',
    title: 'Write the plan for the scoring tool',
    state: 'running',
    links: [
      { kind: 'pr', ref: '256' },
      { kind: 'doc', ref: 'docs/scoring-tool-plan.md' },
      { kind: 'url', ref: 'http://localhost:5173/score-report' }
    ]
  }
  const SESSION_LINKS: SessionLinkSeed[] = [
    {
      url: 'https://github.com/acme/web/pull/256',
      kind: 'pr',
      label: 'acme/web #256',
      source: 'agent'
    },
    {
      url: 'https://example.com/scoring-notes',
      kind: 'web',
      label: 'example.com/scoring-notes',
      source: 'agent'
    },
    {
      url: 'https://example.com/the-operators-own',
      kind: 'web',
      label: 'example.com/the-operators-own',
      source: 'user'
    }
  ]

  it('step links open and come from the session’s links', async () => {
    const w = await mountPane(reply([STEP]), SESSION_LINKS)

    // The pull request number on the row is a link: it opens the pull request the session wrote about,
    // and a click on it does not fold or unfold the step.
    const pr = w.get('[data-test="step-pr"]')
    expect(pr.text()).toBe('#256')
    expect(pr.attributes('role')).toBe('link')
    await pr.trigger('click')
    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/web/pull/256')
    expect(stepRow(w, 'stp-1').attributes('aria-expanded')).toBe('false')

    await openStep(w, 'stp-1')
    const list = w.get('[data-test="step-links"]')
    expect(list.get('[data-test="step-links-title"]').text()).toBe('Links from the session')
    const rows = list.findAll('[data-test="step-link"]')
    expect(rows.map((r) => r.text())).toEqual([
      '#256',
      'Page · localhost:5173/score-report',
      'docs/scoring-tool-plan.md',
      'example.com/scoring-notes'
    ])

    // An address opens in the browser; a repo path is text (nothing to open); a link the operator wrote
    // themselves is not "from the session" and is not listed.
    const page = rows[1]
    expect(page.attributes('role')).toBe('link')
    await page.trigger('click')
    expect(openExternal).toHaveBeenLastCalledWith('http://localhost:5173/score-report')
    expect(rows[2].attributes('role')).toBeUndefined()
    expect(list.text()).not.toContain('the-operators-own')
    // The pull request is listed once, though the step and the session both carry it.
    expect(rows.filter((r) => r.text() === '#256')).toHaveLength(1)
  })

  it('a step whose session produced no links yet says so', async () => {
    const w = await mountPane(reply([{ id: 'stp-1', title: 'Fresh step', state: 'running' }]))
    expect(w.find('[data-test="step-links"]').exists()).toBe(false)
    await openStep(w, 'stp-1')
    expect(w.get('[data-test="step-links-empty"]').text()).toBe(
      enMessages.missionPane.step.linksNone
    )
  })

  it('a step that is done lists what its record holds, not the links the session is writing now', async () => {
    const w = await mountPane(
      reply([
        { id: 'stp-1', title: 'Running step', state: 'running' },
        { id: 'stp-2', title: 'Closed step', state: 'done', links: [{ kind: 'pr', ref: '12' }] }
      ]),
      SESSION_LINKS
    )
    await w.get('[data-test="fold-more"]').trigger('click')
    await openStep(w, 'stp-2')
    const done = w.get('[data-test="step-links"][data-step="stp-2"]')
    // A pull request Harnu cannot resolve to an address is still shown, as plain text.
    const row = done.get('[data-test="step-link"]')
    expect(row.text()).toBe('#12')
    expect(row.attributes('role')).toBeUndefined()
    expect(done.text()).not.toContain('scoring-notes')
  })

  it('a link the session wrote before a step started, or to another step’s pull request, is not that step’s', async () => {
    const w = await mountPane(
      reply([
        {
          id: 'stp-1',
          title: 'The first step',
          state: 'running',
          startedAt: '2026-11-14T08:00:00.000Z',
          links: [{ kind: 'pr', ref: '256' }]
        },
        {
          id: 'stp-2',
          title: 'The second step',
          state: 'running',
          startedAt: '2026-11-14T12:00:00.000Z'
        }
      ]),
      [
        // Written at 10:00, between the two starts: the first step's, never the second's.
        ...SESSION_LINKS,
        // Written at 13:00, after the second step started: the second step's.
        {
          url: 'https://example.com/second-steps-page',
          kind: 'web',
          label: 'example.com/second-steps-page',
          source: 'agent',
          at: '2026-11-14T13:00:00.000Z'
        }
      ]
    )
    await openStep(w, 'stp-1')
    await openStep(w, 'stp-2')
    const first = w.get('[data-test="step-links"][data-step="stp-1"]').text()
    const second = w.get('[data-test="step-links"][data-step="stp-2"]').text()
    expect(first).toContain('example.com/scoring-notes')
    expect(first).not.toContain('second-steps-page')
    expect(second).toContain('example.com/second-steps-page')
    expect(second).not.toContain('scoring-notes')
    // The pull request of the first step is not listed under the second, though the session wrote it.
    expect(second).not.toContain('#256')
  })

  it('a pull request link written as an address opens that address', async () => {
    const w = await mountPane(
      reply([
        {
          id: 'stp-1',
          title: 'With an address',
          state: 'running',
          links: [{ kind: 'pr', ref: 'https://github.com/acme/web/pull/300' }]
        }
      ])
    )
    const pr = w.get('[data-test="step-pr"]')
    expect(pr.text()).toBe('#300')
    await pr.trigger('click')
    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/web/pull/300')
  })

  it('only http(s) addresses open: anything else a record holds stays text', async () => {
    const w = await mountPane(
      reply([
        {
          id: 'stp-1',
          title: 'Odd links',
          state: 'running',
          links: [
            { kind: 'url', ref: 'javascript:alert(1)' },
            { kind: 'url', ref: 'file:///etc/passwd' }
          ]
        }
      ])
    )
    await openStep(w, 'stp-1')
    const rows = w.findAll('[data-test="step-link"]')
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.attributes('role')).toBeUndefined()
  })
})
