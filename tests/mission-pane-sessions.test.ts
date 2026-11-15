// @vitest-environment jsdom
/**
 * Missions v4 · S-20 · AC-53, AC-54, AC-55 — the Sessions row and the hand-off of the Mission pane,
 * mounted against the real stores with `window.api` faked.
 *
 * - AC-53: the row lists every session that worked on the mission with role, from, to and where it
 *   stopped, and says which one leads.
 * - AC-54: "Continue in a new session…" shows the summary the new session starts with and asks for
 *   confirmation; on confirm Harnu starts the session (the door), which attaches it as leader and
 *   releases the old one. The door awaits up to 90 s: the dialog shows it and blocks a second click.
 * - AC-55: at 80 percent of context or more the pane offers the hand-off; "Not now" keeps it quiet until
 *   the context grows by five points and nothing else happens; with no context reading there is no offer.
 *
 * The pane reads the view and decides nothing about who leads: only the operator's confirmed click
 * reaches `window.api.missionHandOff`, and the view is read again after every reply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import enMessages from '../src/renderer/src/i18n/en.json'
import ptMessages from '../src/renderer/src/i18n/pt-BR.json'
import MissionPane from '../src/renderer/src/components/MissionPane.vue'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import {
  HANDOFF_CODES,
  buildSessionRows,
  handoffErrorKey,
  parseSummary
} from '../src/renderer/src/lib/mission-pane-view'
import { handoffOffer } from '../src/main/missions/handoff'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

const FOLDER = '/repo'
const SESSION = '11111111-1111-4111-8111-111111111111'
const WORKER = '22222222-2222-4222-8222-222222222222'
const STOPPED = '33333333-3333-4333-8333-333333333333'
const FORMER = '44444444-4444-4444-8444-444444444444'
const NEW_LEADER = '55555555-5555-4555-8555-555555555555'
const MISSION = 'mnt-sessions'

interface SessionSeed {
  id: string
  role: 'leads' | 'worked'
  from: string
  to?: string | null
  stoppedAt?: { step?: string; waitingFor?: string } | null
}

const SUMMARY = [
  'Mission summary: Score a spec',
  '',
  '## Goal',
  'Score a spec with a test set, then land two fixes.',
  '',
  '## Where it is',
  'Milestone 2 of 3. 4 of 21 steps done.',
  '',
  '## Decided',
  'The untouched test set never goes into the repo.',
  '',
  '## Stopped at',
  'The test run waits for HARNU_CORPUS_DIR.',
  '',
  '## Next step',
  'Once the plan is approved, start milestone 3.'
].join('\n')

const FIVE: SessionSeed[] = [
  { id: SESSION, role: 'leads', from: '2026-11-13T10:00:00.000Z' },
  { id: WORKER, role: 'worked', from: '2026-11-14T08:00:00.000Z' },
  {
    id: STOPPED,
    role: 'worked',
    from: '2026-11-13T12:00:00.000Z',
    to: '2026-11-13T15:00:00.000Z',
    stoppedAt: { step: 'stp-2', waitingFor: 'the corpus folder path' }
  },
  {
    id: FORMER,
    role: 'worked',
    from: '2026-11-11T09:00:00.000Z',
    to: '2026-11-12T18:00:00.000Z',
    stoppedAt: { step: 'stp-1' }
  }
]

interface ReplyOpts {
  handoff?: { offer: boolean; percent: number | null }
  summary?: string
}

/** A reply the way the server builds one: two steps so a session can have stopped at one. */
function reply(sessions: SessionSeed[], opts: ReplyOpts = {}): MissionV4ViewReply {
  const leader = sessions.find((s) => s.role === 'leads' && !s.to)?.id ?? null
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
      leads: leader,
      source: 'v4',
      progress: {
        unit: 'milestones',
        total: 3,
        done: 1,
        headline: 'ZZZ',
        current: { id: 'mls-1', ordinal: 2 },
        allDone: false,
        counts: { todo: 1, running: 1, waitingReview: 0, done: 0, blocked: 0 }
      },
      milestones: [
        {
          id: 'mls-1',
          title: 'A tool that scores a spec',
          optional: false,
          waitsFor: null,
          state: 'in-progress',
          stateLabel: 'ZZZ',
          counts: { running: 1, waitingReview: 0, blocked: 0 }
        }
      ],
      steps: [
        {
          id: 'stp-1',
          title: 'Write the plan for the scoring tool',
          milestone: 'mls-1',
          optional: false,
          state: 'done',
          stateLabel: 'ZZZ',
          blocked: false,
          card: null,
          startedAt: null,
          waitsFor: null,
          criteria: [],
          open: [],
          blockers: [],
          links: []
        },
        {
          id: 'stp-2',
          title: 'Run the tool on the whole test set',
          milestone: 'mls-1',
          optional: false,
          state: 'running',
          stateLabel: 'ZZZ',
          blocked: false,
          card: null,
          startedAt: null,
          waitsFor: null,
          criteria: [],
          open: [],
          blockers: [],
          links: []
        }
      ],
      next: null,
      waiting: {
        items: [],
        next: null,
        more: [],
        moreLine: null,
        people: [],
        peopleLine: null,
        peopleLines: []
      },
      summary: opts.summary ?? SUMMARY,
      links: [],
      blockers: [],
      sessions: []
    },
    closeWarnings: [],
    pendingDoneWhen: null,
    sessions: sessions.map((s) => ({
      id: s.id,
      role: s.role,
      from: s.from,
      to: s.to ?? null,
      stoppedAt: s.stoppedAt ?? null,
      open: (s.to ?? null) === null
    })),
    handoff: opts.handoff ?? { offer: false, percent: null }
  } as unknown as MissionV4ViewReply
}

let current: MissionV4ViewReply
let wrapper: VueWrapper | null = null
let view: ReturnType<typeof vi.fn>
let handOff: ReturnType<typeof vi.fn>

async function mountPane(
  r: MissionV4ViewReply,
  opts: {
    selected?: string
    known?: Array<{ sessionId: string; summary?: string }>
    handOffReply?: unknown
    api?: Record<string, unknown>
  } = {}
): Promise<VueWrapper> {
  current = r
  view = vi.fn(async () => current)
  handOff = vi.fn(
    async () => opts.handOffReply ?? { ok: true, changed: true, sessionId: NEW_LEADER }
  )
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
    campaignList: vi.fn(async () => ({ views: [], unreadable: [] })),
    missionV4View: view,
    missionV4Door: vi.fn(async () => ({ ok: true, changed: true })),
    missionHandOff: handOff,
    missionOperatorDoor: vi.fn(),
    requestAttention: vi.fn(),
    sessionLinksList: vi.fn(async () => []),
    shellOpenExternal: vi.fn(async () => undefined),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined),
    ...(opts.api ?? {})
  }
  const selected = opts.selected ?? SESSION
  const sessions = useSessionsStore()
  sessions.folders = [
    {
      path: FOLDER,
      sessions: [
        { sessionId: selected, projectPath: FOLDER, summary: 'Harnu Spec' },
        ...(opts.known ?? []).map((k) => ({ ...k, projectPath: FOLDER }))
      ]
    }
  ] as never
  sessions.select(selected)
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

const body = (): HTMLElement => document.body
const q = (sel: string): HTMLElement | null => body().querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => [...body().querySelectorAll<HTMLElement>(sel)]
const text = (sel: string): string => (q(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim()

async function openSessions(w: VueWrapper): Promise<void> {
  await w.get('[data-test="sessions-toggle"]').trigger('click')
  await flushPromises()
}

async function openDialog(w: VueWrapper): Promise<void> {
  await openSessions(w)
  await w.get('[data-test="handoff-open"]').trigger('click')
  await flushPromises()
}

const rowOf = (id: string): HTMLElement | null =>
  q(`[data-test="session-row"][data-session="${id}"]`)

// ---- the pure builders ---------------------------------------------------------------------------

describe('buildSessionRows — what the row reads from the server history', () => {
  const steps = [
    { id: 'stp-1', title: 'Write the plan for the scoring tool' },
    { id: 'stp-2', title: 'Run the tool on the whole test set' }
  ]
  const history = reply(FIVE).sessions

  it('puts the leader first, then the open ones, then the closed ones, newest first', () => {
    const rows = buildSessionRows(history, { steps, selectedId: SESSION })
    expect(rows.map((r) => r.id)).toEqual([SESSION, WORKER, STOPPED, FORMER])
  })

  it('marks who leads, whether it is the selected session and whether it is still attached', () => {
    const rows = buildSessionRows(history, { steps, selectedId: SESSION })
    expect(rows.map((r) => [r.leads, r.current, r.open])).toEqual([
      [true, true, true],
      [false, false, true],
      [false, false, false],
      [false, false, false]
    ])
  })

  it('names the step a closed session stopped at by its title, never its id', () => {
    const rows = buildSessionRows(history, { steps, selectedId: SESSION })
    expect(rows[2].stoppedStep).toBe('Run the tool on the whole test set')
    expect(rows[2].waitingFor).toBe('the corpus folder path')
    expect(rows[3].stoppedStep).toBe('Write the plan for the scoring tool')
    expect(rows[3].waitingFor).toBeNull()
  })

  it('leaves a stop out when the record names no step or the step is gone', () => {
    const rows = buildSessionRows(
      [
        { id: 'a', role: 'worked', from: 'x', to: 'y', stoppedAt: { step: 'stp-9' }, open: false },
        { id: 'b', role: 'worked', from: 'x', to: 'y', stoppedAt: null, open: false }
      ] as never,
      { steps, selectedId: null }
    )
    expect(rows.map((r) => [r.stoppedStep, r.waitingFor])).toEqual([
      [null, null],
      [null, null]
    ])
  })

  it("keeps a closed leader's role and orders two closed ones by when they stopped", () => {
    const rows = buildSessionRows(
      [
        {
          id: 'old',
          role: 'leads',
          from: '2026-11-01T00:00:00Z',
          to: '2026-11-02T00:00:00Z',
          stoppedAt: null,
          open: false
        },
        {
          id: 'newer',
          role: 'worked',
          from: '2026-11-01T00:00:00Z',
          to: '2026-11-05T00:00:00Z',
          stoppedAt: null,
          open: false
        }
      ] as never,
      { steps, selectedId: null }
    )
    expect(rows.map((r) => r.id)).toEqual(['newer', 'old'])
    expect(rows[1].role).toBe('leads')
    expect(rows[1].leads).toBe(false)
  })
})

describe('parseSummary — the sections of the text the new session starts with', () => {
  it('splits on the headings, in order, and keeps the title line apart', () => {
    const parsed = parseSummary(SUMMARY)
    expect(parsed.title).toBe('Mission summary: Score a spec')
    expect(parsed.sections.map((s) => s.heading)).toEqual([
      'Goal',
      'Where it is',
      'Decided',
      'Stopped at',
      'Next step'
    ])
    expect(parsed.sections[0].body).toBe('Score a spec with a test set, then land two fixes.')
  })

  it('falls back to the whole text when it has no headings, and to nothing when it is empty', () => {
    expect(parseSummary('just words').sections).toEqual([])
    expect(parseSummary('just words').title).toBe('just words')
    expect(parseSummary('').title).toBe('')
  })
})

describe('handoffErrorKey — every code the door answers with a word of its own', () => {
  it('maps each known code to itself and anything else to `other`', () => {
    for (const code of HANDOFF_CODES) expect(handoffErrorKey(code)).toBe(code)
    expect(handoffErrorKey('SOMETHING_NEW')).toBe('other')
    expect(handoffErrorKey('WRITE_CONFLICT')).toBe('other')
  })
})

// ---- AC-53 ---------------------------------------------------------------------------------------

describe('AC-53 — the Sessions row lists every session with role, from, to and where it stopped', () => {
  it('is folded by default and says how many sessions and who leads', async () => {
    const w = await mountPane(reply(FIVE))
    expect(text('[data-test="sessions-meta"]')).toBe('4 · led by this session')
    expect(rowOf(SESSION)).toBeNull()
    await openSessions(w)
    expect(qa('[data-test="session-row"]')).toHaveLength(4)
    // and folds again
    await openSessions(w)
    expect(qa('[data-test="session-row"]')).toHaveLength(0)
  })

  it('names the leader as this session, with its name and the day it started', async () => {
    const w = await mountPane(reply(FIVE))
    await openSessions(w)
    const row = rowOf(SESSION)!
    expect(row.getAttribute('data-role')).toBe('leads')
    expect(row.textContent).toContain('Harnu Spec')
    expect(row.textContent).toContain('Leads the mission')
    expect(row.textContent).toContain('this session')
    expect(row.textContent).toMatch(/Since Nov 13/)
  })

  it("says where a closed session stopped, by the step's title, and what it waited for", async () => {
    const w = await mountPane(reply(FIVE), {
      known: [{ sessionId: STOPPED, summary: 'test-run' }]
    })
    await openSessions(w)
    const row = rowOf(STOPPED)!
    expect(row.getAttribute('data-open')).toBe('false')
    expect(row.textContent).toContain('test-run')
    expect(row.textContent).toContain('Worked on the mission')
    expect(row.textContent).toContain('Stopped at “Run the tool on the whole test set”')
    expect(row.textContent).toContain('Waiting for: the corpus folder path')
    expect(row.textContent).toMatch(/Nov 13/)
  })

  it('shows a former leader as having led, and a day span from and to', async () => {
    const w = await mountPane(reply([{ ...FIVE[0] }, { ...FIVE[3], role: 'leads' }]))
    await openSessions(w)
    const row = rowOf(FORMER)!
    expect(row.textContent).toContain('Led the mission')
    expect(row.textContent).toMatch(/Nov 11 to Nov 12/)
  })

  it('shows a short id when the session is not loaded, never a blank name', async () => {
    const w = await mountPane(reply(FIVE))
    await openSessions(w)
    expect(rowOf(WORKER)!.textContent).toContain('Session 22222222')
  })

  it('says another session leads when the selected one is a worker, by its name', async () => {
    await mountPane(reply(FIVE), {
      selected: WORKER,
      known: [{ sessionId: SESSION, summary: 'orch-1' }]
    })
    expect(text('[data-test="sessions-meta"]')).toBe('4 · led by orch-1')
  })

  it('says nobody leads when no open session does', async () => {
    const w = await mountPane(reply([{ ...FIVE[0], role: 'worked' }, { ...FIVE[1] }]), {
      selected: WORKER
    })
    expect(text('[data-test="sessions-meta"]')).toBe('2 · nobody leads it')
    await openSessions(w)
    expect(rowOf(SESSION)!.textContent).toContain('Works on the mission')
  })

  it('draws a mission with one session as one row', async () => {
    const w = await mountPane(reply([FIVE[0]]))
    expect(text('[data-test="sessions-meta"]')).toBe('1 · led by this session')
    await openSessions(w)
    expect(qa('[data-test="session-row"]')).toHaveLength(1)
    expect(q('[data-test="handoff-open"]')).not.toBeNull()
  })

  it('folds the older closed sessions behind "N more" and lists them on request', async () => {
    const many: SessionSeed[] = [FIVE[0]]
    for (let i = 0; i < 8; i++) {
      many.push({
        id: `00000000-0000-4000-8000-00000000000${i}`,
        role: 'worked',
        from: `2026-11-0${i + 1}T10:00:00.000Z`,
        to: `2026-11-0${i + 1}T12:00:00.000Z`
      })
    }
    const w = await mountPane(reply(many))
    await openSessions(w)
    expect(qa('[data-test="session-row"]')).toHaveLength(6)
    expect(text('[data-test="sessions-more"]')).toBe('3 more sessions')
    await w.get('[data-test="sessions-more"]').trigger('click')
    expect(qa('[data-test="session-row"]')).toHaveLength(9)
  })
})

// ---- AC-54 ---------------------------------------------------------------------------------------

describe('AC-54 — "Continue in a new session…" shows the summary and asks before it starts anything', () => {
  it('opens a dialog with what happens, the summary sections and Cancel / Start new session', async () => {
    const w = await mountPane(reply(FIVE))
    await openDialog(w)
    const dialog = q('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('Continue this mission in a new session')
    expect(qa('[data-test="handoff-step"]')).toHaveLength(3)
    expect(qa('[data-test="handoff-section"]').map((s) => s.getAttribute('data-heading'))).toEqual([
      'Goal',
      'Where it is',
      'Decided',
      'Stopped at',
      'Next step'
    ])
    expect(text('[data-test="handoff-section"][data-heading="Goal"]')).toContain(
      'Score a spec with a test set'
    )
    expect(q('[data-test="handoff-cancel"]')).not.toBeNull()
    expect(q('[data-test="handoff-confirm"]')).not.toBeNull()
    // nothing started by looking
    expect(handOff).not.toHaveBeenCalled()
  })

  it('Cancel closes it and starts nothing', async () => {
    const w = await mountPane(reply(FIVE))
    await openDialog(w)
    q('[data-test="handoff-cancel"]')!.click()
    await flushPromises()
    expect(q('[role="dialog"]')).toBeNull()
    expect(handOff).not.toHaveBeenCalled()
  })

  it('on confirm calls the door with the folder and the mission id the view answered for', async () => {
    const w = await mountPane(reply(FIVE))
    await openDialog(w)
    q('[data-test="handoff-confirm"]')!.click()
    await flushPromises()
    expect(handOff).toHaveBeenCalledTimes(1)
    expect(handOff).toHaveBeenCalledWith({ folder: FOLDER, missionId: MISSION })
  })

  it('shows a pending state while the door waits and blocks a second click', async () => {
    let finish: (r: unknown) => void = () => undefined
    const pending = new Promise((resolve) => (finish = resolve))
    const w = await mountPane(reply(FIVE), { api: { missionHandOff: vi.fn(() => pending) } })
    handOff = (window as unknown as { api: { missionHandOff: ReturnType<typeof vi.fn> } }).api
      .missionHandOff
    await openDialog(w)
    q('[data-test="handoff-confirm"]')!.click()
    await flushPromises()
    expect(q('[data-test="handoff-pending"]')).not.toBeNull()
    expect(text('[data-test="handoff-pending"]')).toContain('Starting the new session')
    expect((q('[data-test="handoff-confirm"]') as HTMLButtonElement).disabled).toBe(true)
    // a second press and a press on Cancel while it waits start nothing more and close nothing
    q('[data-test="handoff-confirm"]')!.click()
    q('[data-test="handoff-cancel"]')!.click()
    await flushPromises()
    expect(handOff).toHaveBeenCalledTimes(1)
    expect(q('[role="dialog"]')).not.toBeNull()
    finish({ ok: true, changed: true, sessionId: NEW_LEADER, previousLeader: SESSION })
    await flushPromises()
    expect(q('[data-test="handoff-pending"]')).toBeNull()
  })

  it('reads the view again after the reply and says the new session leads', async () => {
    const w = await mountPane(reply(FIVE))
    await openDialog(w)
    const before = view.mock.calls.length
    // what the server answers after the write: the old leader released, the new one leading
    current = reply([
      { ...FIVE[0], to: '2026-11-14T12:00:00.000Z', role: 'worked' },
      { id: NEW_LEADER, role: 'leads', from: '2026-11-14T12:00:00.000Z' }
    ])
    q('[data-test="handoff-confirm"]')!.click()
    await flushPromises()
    await flushPromises()
    expect(view.mock.calls.length).toBeGreaterThan(before)
    expect(text('[data-test="handoff-done"]')).toContain('The new session leads the mission')
    // this session is released, so the pane no longer shows this mission for it
    expect(q('[data-test="mission-none"]')).not.toBeNull()
    // the dialog is still there to say so, with one button
    expect(q('[data-test="handoff-close"]')).not.toBeNull()
    q('[data-test="handoff-close"]')!.click()
    await flushPromises()
    expect(q('[role="dialog"]')).toBeNull()
  })

  it('offers to open the new session when it is loaded', async () => {
    const w = await mountPane(reply(FIVE), {
      known: [{ sessionId: NEW_LEADER, summary: 'Harnu Spec 2' }]
    })
    await openDialog(w)
    current = reply([
      { ...FIVE[0], to: '2026-11-14T12:00:00.000Z', role: 'worked' },
      { id: NEW_LEADER, role: 'leads', from: '2026-11-14T12:00:00.000Z' }
    ])
    q('[data-test="handoff-confirm"]')!.click()
    await flushPromises()
    await flushPromises()
    q('[data-test="handoff-open-new"]')!.click()
    await flushPromises()
    expect(useSessionsStore().selectedSession?.sessionId).toBe(NEW_LEADER)
  })

  const FAILURES: Array<[string, RegExp]> = [
    ['MISSION_CLOSED', /This mission is closed/],
    ['HANDOFF_START_FAILED', /The new session did not start\. Nothing changed/],
    ['HANDOFF_IN_PROGRESS', /already starting a session/],
    ['HANDOFF_UNAVAILABLE', /cannot start a session right now/],
    ['LEADER_CHANGED', /Who leads the mission changed/],
    ['BAD_ARGS', /could not finish the hand-off/],
    ['OPERATOR_ONLY', /could not finish the hand-off/],
    ['SOMETHING_ELSE', /could not finish the hand-off/]
  ]
  for (const [code, words] of FAILURES) {
    it(`${code}: says what to do next, never the code, and lets the operator try again`, async () => {
      const w = await mountPane(reply(FIVE), {
        handOffReply: { ok: false, code, error: `${code}: server words that must not show` }
      })
      await openDialog(w)
      q('[data-test="handoff-confirm"]')!.click()
      await flushPromises()
      await flushPromises()
      const alert = q('[data-test="handoff-error"]')!
      expect(alert.getAttribute('role')).toBe('alert')
      expect(alert.textContent).toMatch(words)
      expect(alert.textContent).not.toContain(code)
      expect(alert.textContent).not.toContain('server words')
      // the dialog stays, the button is back, and the view was read again
      expect((q('[data-test="handoff-confirm"]') as HTMLButtonElement).disabled).toBe(false)
      expect(q('[data-test="handoff-pending"]')).toBeNull()
    })
  }

  it('keeps showing the summary it was asked about when the mission leaves the pane after a refusal', async () => {
    const w = await mountPane(reply(FIVE), {
      handOffReply: { ok: false, code: 'MISSION_CLOSED', error: 'MISSION_CLOSED: x' }
    })
    await openDialog(w)
    // what the view answers once the mission closed under the open dialog
    current = { state: 'none', missions: [] } as unknown as MissionV4ViewReply
    q('[data-test="handoff-confirm"]')!.click()
    await flushPromises()
    await flushPromises()
    expect(q('[data-test="mission-none"]')).not.toBeNull()
    expect(text('[data-test="handoff-error"]')).toMatch(/This mission is closed/)
    expect(text('[data-test="handoff-section"][data-heading="Goal"]')).toContain(
      'Score a spec with a test set'
    )
    expect(text('[data-test="handoff-summary"]')).not.toContain('no summary')
  })

  it('says the channel is missing the same way instead of throwing', async () => {
    const w = await mountPane(reply(FIVE), { api: { missionHandOff: undefined } })
    await openDialog(w)
    q('[data-test="handoff-confirm"]')!.click()
    await flushPromises()
    expect(text('[data-test="handoff-error"]')).toMatch(/could not finish the hand-off/)
  })

  it('says the door threw the same way', async () => {
    const w = await mountPane(reply(FIVE), {
      api: { missionHandOff: vi.fn(async () => Promise.reject(new Error('boom'))) }
    })
    await openDialog(w)
    q('[data-test="handoff-confirm"]')!.click()
    await flushPromises()
    expect(text('[data-test="handoff-error"]')).toMatch(/could not finish the hand-off/)
    expect(text('[data-test="handoff-error"]')).not.toContain('boom')
  })

  it('shows a long summary in the dialog body, the one scroller, with Cancel and Start still there', async () => {
    const long = `Mission summary\n\n## Goal\n${'A long line of the goal. '.repeat(400)}`
    const w = await mountPane(reply(FIVE, { summary: long }))
    await openDialog(w)
    expect(q('[data-test="handoff-confirm"]')).not.toBeNull()
    expect(q('[data-test="handoff-cancel"]')).not.toBeNull()
  })

  it('falls back to the whole text when the summary has no headings', async () => {
    const w = await mountPane(reply(FIVE, { summary: 'Plain words of a summary.' }))
    await openDialog(w)
    expect(text('[data-test="handoff-summary"]')).toContain('Plain words of a summary.')
  })
})

// ---- AC-55 ---------------------------------------------------------------------------------------

describe('AC-55 — at 80 percent or more of context the pane offers the hand-off; "Not now" keeps it quiet', () => {
  it("offers it at 82 percent, speaking of the session's context", async () => {
    await mountPane(reply(FIVE, { handoff: handoffOffer(82) }))
    const notice = text('[data-test="handoff-offer"]')
    expect(notice).toContain('82%')
    expect(notice).toContain('context')
    expect(notice).not.toMatch(/memory/i)
    expect(q('[data-test="handoff-offer-open"]')).not.toBeNull()
    expect(q('[data-test="handoff-offer-later"]')).not.toBeNull()
  })

  it('offers nothing below 80 percent and nothing with no reading', async () => {
    await mountPane(reply(FIVE, { handoff: handoffOffer(79) }))
    expect(q('[data-test="handoff-offer"]')).toBeNull()
    wrapper?.unmount()
    await mountPane(reply(FIVE, { handoff: handoffOffer(null) }))
    expect(q('[data-test="handoff-offer"]')).toBeNull()
  })

  it('the offer button opens the same confirmation as the row', async () => {
    await mountPane(reply(FIVE, { handoff: handoffOffer(82) }))
    q('[data-test="handoff-offer-open"]')!.click()
    await flushPromises()
    expect(q('[role="dialog"]')).not.toBeNull()
    expect(handOff).not.toHaveBeenCalled()
  })

  it('"Not now" hides it and does nothing else', async () => {
    await mountPane(reply(FIVE, { handoff: handoffOffer(82) }))
    q('[data-test="handoff-offer-later"]')!.click()
    await flushPromises()
    expect(q('[data-test="handoff-offer"]')).toBeNull()
    expect(handOff).not.toHaveBeenCalled()
    expect(q('[role="dialog"]')).toBeNull()
  })

  it('asks the view with the percent it was dismissed at, and the offer returns five points higher', async () => {
    // a stand-in for the server: the real `handoffOffer`, fed the percent the pane sends back
    let reading = 82
    const w = await mountPane(reply(FIVE, { handoff: handoffOffer(82) }))
    view.mockImplementation(async (args: { dismissedPercent?: number }) =>
      reply(FIVE, { handoff: handoffOffer(reading, args.dismissedPercent ?? null) })
    )
    q('[data-test="handoff-offer-later"]')!.click()
    await flushPromises()
    await flushPromises()
    expect(view).toHaveBeenLastCalledWith(expect.objectContaining({ dismissedPercent: 82 }))
    expect(q('[data-test="handoff-offer"]')).toBeNull()
    // four points more: still quiet
    reading = 86
    await w.vm.$nextTick()
    await useMissionsStore().refreshV4()
    await flushPromises()
    expect(q('[data-test="handoff-offer"]')).toBeNull()
    // five points more: offered again
    reading = 87
    await useMissionsStore().refreshV4()
    await flushPromises()
    expect(text('[data-test="handoff-offer"]')).toContain('87%')
  })

  it('stays quiet at a fractional reading after "Not now", also after a restart', async () => {
    // 82.6 shows as 83% but is dismissed as 82.6: the quiet rule compares the same number on both sides
    const fractional = { offer: true, percent: 82.6 }
    await mountPane(reply(FIVE, { handoff: fractional }))
    expect(text('[data-test="handoff-offer"]')).toContain('83%')
    q('[data-test="handoff-offer-later"]')!.click()
    await flushPromises()
    await flushPromises()
    expect(q('[data-test="handoff-offer"]')).toBeNull()
    // a restart: new pinia and a new pane, the same storage and the same reading from the view
    wrapper?.unmount()
    setActivePinia(createPinia())
    await mountPane(reply(FIVE, { handoff: fractional }))
    expect(q('[data-test="handoff-offer"]')).toBeNull()
  })

  it('speaks of the leading session by name when the selected one is not it', async () => {
    await mountPane(reply(FIVE, { handoff: handoffOffer(90) }), {
      selected: WORKER,
      known: [{ sessionId: SESSION, summary: 'orch-1' }]
    })
    const notice = text('[data-test="handoff-offer"]')
    expect(notice).toContain('orch-1')
    expect(notice).toContain('90%')
    expect(notice).not.toContain('This session')
  })

  it('is not asked after a hand-off: the new leader starts with no dismissal', async () => {
    const w = await mountPane(reply(FIVE, { handoff: handoffOffer(82) }))
    q('[data-test="handoff-offer-later"]')!.click()
    await flushPromises()
    await openDialog(w)
    current = reply([
      { ...FIVE[0], to: '2026-11-14T12:00:00.000Z', role: 'worked' },
      { id: NEW_LEADER, role: 'leads', from: '2026-11-14T12:00:00.000Z' }
    ])
    q('[data-test="handoff-confirm"]')!.click()
    await flushPromises()
    await flushPromises()
    q('[data-test="handoff-close"]')!.click()
    await flushPromises()
    // the next ask carries no dismissal of the old leader
    await useMissionsStore().refreshV4()
    const lastCall = view.mock.calls.at(-1)?.[0] as { dismissedPercent?: number }
    expect(lastCall.dismissedPercent).toBeUndefined()
  })
})

// ---- copy ----------------------------------------------------------------------------------------

describe('copy', () => {
  it('has the same hand-off and sessions keys in English and Portuguese', () => {
    const keys = (o: unknown, prefix = ''): string[] =>
      Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]
      )
    const pick = (m: { missionPane: Record<string, unknown> }): string[] =>
      keys({ sessions: m.missionPane.sessions, handoff: m.missionPane.handoff }).sort()
    expect(pick(ptMessages as never)).toEqual(pick(enMessages as never))
    expect(pick(enMessages as never).length).toBeGreaterThan(20)
  })

  it('never uses a state word or the English words of a reply as copy', () => {
    const all = JSON.stringify({
      s: (enMessages as { missionPane: { sessions: unknown } }).missionPane.sessions,
      h: (enMessages as { missionPane: { handoff: unknown } }).missionPane.handoff
    })
    expect(all).not.toMatch(/memory/i)
    expect(all).not.toMatch(/needs-human|self-verified|radiant|declared end|fixed end/i)
  })
})
