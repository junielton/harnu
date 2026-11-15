// @vitest-environment jsdom
/**
 * Missions v4 · S-21 · AC-56, AC-57, AC-58 — attach, the attach request and Ask in the Mission pane,
 * mounted against the real stores with `window.api` faked and a fake PTY writer on the terminal bus.
 *
 * - AC-56: a session with no mission sees the folder's open missions with Attach and "Start a new
 *   mission". Attaching asks for confirmation first. "Start a new mission" writes no record: it puts
 *   the instruction into the session through the same writer Ask and "Reference in session" use.
 * - AC-57: a session that asks to join an existing mission shows Allow and Deny in the pane. The chime
 *   is S-23's (AC-63): the existing cue reads the v3 list and has no input for a v4 request.
 * - AC-58: Ask on a milestone sends the question to the LEADING session the way "Reference in
 *   session" does (the writer bus, no Enter), and the answer appears in that session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import enMessages from '../src/renderer/src/i18n/en.json'
import ptMessages from '../src/renderer/src/i18n/pt-BR.json'
import MissionPane from '../src/renderer/src/components/MissionPane.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { registerWriter, unregisterWriter } from '../src/renderer/src/lib/terminal-bus'
import {
  ATTACH_CODES,
  NEW_MISSION_INSTRUCTION,
  askMessage,
  attachErrorKey,
  attachRequestsOf,
  pickerRows,
  writeIntoSession
} from '../src/renderer/src/lib/mission-pane-view'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

const FOLDER = '/repo'
const SESSION = '11111111-1111-4111-8111-111111111111'
const LEADER = '22222222-2222-4222-8222-222222222222'
const ASKING = '33333333-3333-4333-8333-333333333333'
const MISSION = 'mnt-ask0001'
const OTHER_MISSION = 'mnt-ask0002'

type Waiting = Array<Record<string, unknown>>

interface MissionOpts {
  leader?: string | null
  attached?: string[]
  waiting?: Waiting
  id?: string
}

/** A mission reply the way the server builds one: one open milestone with two steps. */
function missionReply(opts: MissionOpts = {}): MissionV4ViewReply {
  const leader = opts.leader === undefined ? LEADER : opts.leader
  const attached = opts.attached ?? [leader ?? LEADER]
  const items = opts.waiting ?? []
  return {
    state: 'mission',
    missionId: opts.id ?? MISSION,
    source: 'v4',
    detail: {
      ok: true,
      id: 'ZZZ-detail-id-is-not-the-mission-id',
      title: 'Measure the spec skill, then fix what the numbers show',
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
        items,
        next: items[0] ?? null,
        more: items.slice(1),
        moreLine: null,
        people: [],
        peopleLine: null,
        peopleLines: []
      },
      summary: 'Mission summary',
      links: [],
      blockers: [],
      sessions: []
    },
    closeWarnings: [],
    pendingDoneWhen: null,
    sessions: [
      ...(leader
        ? [
            {
              id: leader,
              role: 'leads',
              from: '2026-11-13T10:00:00.000Z',
              to: null,
              stoppedAt: null,
              open: true
            }
          ]
        : []),
      ...attached
        .filter((id) => id !== leader)
        .map((id) => ({
          id,
          role: 'worked',
          from: '2026-11-13T11:00:00.000Z',
          to: null,
          stoppedAt: null,
          open: true
        }))
    ],
    handoff: { offer: false, percent: null }
  } as unknown as MissionV4ViewReply
}

const ROWS = [
  {
    id: MISSION,
    title: 'Measure the spec skill, then fix what the numbers show',
    headline: '4 of 21 steps done',
    leads: LEADER
  },
  {
    id: OTHER_MISSION,
    title: 'Make WebGL the default renderer',
    headline: '9 of 22 steps done',
    leads: null
  }
]

const noneReply = (missions: typeof ROWS = ROWS): MissionV4ViewReply =>
  ({ state: 'none', missions }) as unknown as MissionV4ViewReply

const attachItem = (requestId: string, sessionId: string): Record<string, unknown> => ({
  kind: 'attach',
  id: `attach:${requestId}`,
  requestId,
  sessionId,
  ask: 'Let another session join this mission',
  why: 'It asked to work on it and waits for your answer'
})

let wrapper: VueWrapper | null = null
let view: ReturnType<typeof vi.fn>
let door: ReturnType<typeof vi.fn>
let writes: Record<string, string[]> = {}

function liveWriter(id: string): void {
  writes[id] = []
  registerWriter(id, (data) => writes[id].push(data))
  useSessionsStore().registerLiveSession(id)
}

interface MountOpts {
  selected?: string
  /** What the view answers: by name (a mission id) or by session. */
  answer: (req: { sessionId: string; missionId?: string }) => MissionV4ViewReply
  doorReply?: unknown
  known?: Array<{ sessionId: string; summary: string }>
}

async function mountPane(opts: MountOpts): Promise<VueWrapper> {
  view = vi.fn(async (req: { sessionId: string; missionId?: string }) => opts.answer(req))
  door = vi.fn(async () => opts.doorReply ?? { ok: true, changed: true })
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
    campaignList: vi.fn(async () => ({ views: [], unreadable: [] })),
    missionV4View: view,
    missionV4Door: door,
    missionHandOff: vi.fn(),
    missionOperatorDoor: vi.fn(),
    requestAttention: vi.fn(),
    sessionLinksList: vi.fn(async () => []),
    shellOpenExternal: vi.fn(async () => undefined),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined)
  }
  const selected = opts.selected ?? SESSION
  const sessions = useSessionsStore()
  sessions.folders = [
    {
      path: FOLDER,
      sessions: [
        { sessionId: selected, projectPath: FOLDER, summary: 'Scratch' },
        ...(opts.known ?? [{ sessionId: LEADER, summary: 'Harnu Spec' }]).map((k) => ({
          ...k,
          projectPath: FOLDER
        }))
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
  await settle()
  return w
}

async function settle(): Promise<void> {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 150))
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  localStorage.clear()
  writes = {}
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  for (const id of [SESSION, LEADER, ASKING]) unregisterWriter(id)
  document.body.innerHTML = ''
})

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(sel)]
const text = (sel: string): string => (q(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim()

async function click(sel: string): Promise<void> {
  const el = q(sel)
  if (!el) throw new Error(`no element for ${sel}`)
  el.click()
  await flushPromises()
}

async function typeInto(sel: string, value: string): Promise<void> {
  const el = q(sel) as HTMLTextAreaElement | null
  if (!el) throw new Error(`no element for ${sel}`)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

// ---- the pure helpers ----------------------------------------------------------------------------

describe('S-21 helpers', () => {
  it('writeIntoSession writes through the bus only to a live session', () => {
    const write = vi.fn(() => true)
    expect(writeIntoSession({ isLive: () => true, write }, 's1', 'hello')).toBe('sent')
    expect(write).toHaveBeenCalledWith('s1', expect.stringContaining('hello'))
    write.mockClear()
    expect(writeIntoSession({ isLive: () => false, write }, 's1', 'hello')).toBe('not-running')
    expect(write).not.toHaveBeenCalled()
    expect(writeIntoSession({ isLive: () => true, write: () => false }, 's1', 'hello')).toBe(
      'not-running'
    )
  })

  it('writeIntoSession fences the text as one paste and never presses Enter', () => {
    const write = vi.fn(() => true)
    writeIntoSession({ isLive: () => true, write }, 's1', 'one\ntwo')
    const data = write.mock.calls[0][1] as string
    expect(data.startsWith('\x1b[200~')).toBe(true)
    expect(data).toContain('\x1b[201~')
    expect(data.endsWith('\r')).toBe(false)
    expect(data.split('\x1b[201~')[1] ?? '').not.toContain('\r')
  })

  it('askMessage quotes the milestone title and keeps the question as written', () => {
    expect(askMessage('A tool that scores a spec', ' What is missing? ')).toBe(
      'About the milestone “A tool that scores a spec”: What is missing?'
    )
  })

  it('attachRequestsOf lists every undecided request of the waiting list, not only the next one', () => {
    const r = missionReply({
      waiting: [attachItem('atr-1', ASKING), attachItem('atr-2', SESSION)]
    })
    if (r.state !== 'mission') throw new Error('fixture')
    expect(attachRequestsOf(r.detail)).toEqual([
      { id: 'atr-1', sessionId: ASKING },
      { id: 'atr-2', sessionId: SESSION }
    ])
  })

  it('pickerRows keeps the server rows and says who leads, or that nobody does', () => {
    expect(pickerRows(ROWS)).toEqual([
      { id: MISSION, title: ROWS[0].title, headline: '4 of 21 steps done', leaderId: LEADER },
      { id: OTHER_MISSION, title: ROWS[1].title, headline: '9 of 22 steps done', leaderId: null }
    ])
  })

  it('attachErrorKey words the codes the doors answer and sends any other to `other`', () => {
    for (const code of ATTACH_CODES) expect(attachErrorKey(code)).toBe(code)
    expect(attachErrorKey('SOMETHING_NEW')).toBe('other')
  })

  it('the new-mission instruction asks the session, in one place, and names no record', () => {
    expect(NEW_MISSION_INSTRUCTION).toMatch(/new Harnu mission/i)
    expect(NEW_MISSION_INSTRUCTION).not.toContain('\n')
  })

  it('every key of the pane copy this slice adds exists in en and pt-BR', () => {
    const keys = (o: unknown, p = ''): string[] =>
      typeof o === 'object' && o !== null
        ? Object.entries(o).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k))
        : [p]
    const pick = (m: unknown): string[] =>
      keys((m as { missionPane: Record<string, unknown> }).missionPane).filter((k) =>
        /^(attach|ask|refused)\./.test(k)
      )
    const en = pick(enMessages).sort()
    expect(en.length).toBeGreaterThan(10)
    expect(pick(ptMessages).sort()).toEqual(en)
  })
})

// ---- AC-58 --------------------------------------------------------------------------------------

describe('AC-58 — Ask on a milestone', () => {
  it('ask goes to the session', async () => {
    liveWriter(LEADER)
    liveWriter(SESSION)
    await mountPane({
      selected: SESSION,
      answer: () => missionReply({ leader: LEADER, attached: [LEADER, SESSION] })
    })
    await click('[data-test="ask-open"]')
    expect(q('[data-test="ask-box"]')).not.toBeNull()
    await typeInto('[data-test="ask-input"]', 'What is still missing to finish this milestone?')
    await click('[data-test="ask-send"]')

    // It went to the session that LEADS, not to the one the pane follows.
    expect(writes[SESSION]).toEqual([])
    expect(writes[LEADER]).toHaveLength(1)
    expect(writes[LEADER][0]).toContain(
      'About the milestone “A tool that scores a spec”: What is still missing to finish this milestone?'
    )
    // The way "Reference in session" does it: into the composer, never submitted.
    expect(writes[LEADER][0]).not.toMatch(/\r$/)
    // It writes no record.
    expect(door).not.toHaveBeenCalled()
    // The pane says where the answer will be.
    expect(text('[data-test="ask-done"]')).toContain('Harnu Spec')
  })

  it('says so, and writes nothing, when the leading session is not running', async () => {
    liveWriter(SESSION)
    await mountPane({
      selected: SESSION,
      answer: () => missionReply({ leader: LEADER, attached: [LEADER, SESSION] })
    })
    await click('[data-test="ask-open"]')
    await typeInto('[data-test="ask-input"]', 'Anything left?')
    await click('[data-test="ask-send"]')
    expect(writes[SESSION]).toEqual([])
    expect(text('[data-test="ask-error"]')).toContain('Harnu Spec')
    // The question stays in the box so the operator can send it once the session runs again.
    expect((q('[data-test="ask-input"]') as HTMLTextAreaElement).value).toBe('Anything left?')
  })

  it('sends nothing for an empty question and Cancel closes the box', async () => {
    liveWriter(LEADER)
    await mountPane({ answer: () => missionReply({ leader: LEADER, attached: [LEADER, SESSION] }) })
    await click('[data-test="ask-open"]')
    expect((q('[data-test="ask-send"]') as HTMLButtonElement).disabled).toBe(true)
    await click('[data-test="ask-cancel"]')
    expect(q('[data-test="ask-box"]')).toBeNull()
    expect(writes[LEADER]).toEqual([])
  })

  it('draws no Ask when nobody leads the mission', async () => {
    await mountPane({ answer: () => missionReply({ leader: null, attached: [SESSION] }) })
    expect(q('[data-test="milestone-row"]')).not.toBeNull()
    expect(q('[data-test="ask-open"]')).toBeNull()
  })
})

// ---- AC-56 --------------------------------------------------------------------------------------

describe('AC-56 — a session with no mission', () => {
  it('lists the folder’s open missions with Attach and Start a new mission', async () => {
    await mountPane({ answer: () => noneReply() })
    const rows = qa('[data-test="attach-row"]')
    expect(rows.map((r) => r.getAttribute('data-mission'))).toEqual([MISSION, OTHER_MISSION])
    expect(rows[0].textContent).toContain('Measure the spec skill, then fix what the numbers show')
    expect(rows[0].textContent).toContain('4 of 21 steps done')
    expect(rows[0].textContent).toContain('Harnu Spec')
    expect(rows[1].textContent).toMatch(/nobody leads/i)
    expect(q('[data-test="attach-start"]')).not.toBeNull()
  })

  it('asks for confirmation before attaching, and a cancel writes nothing', async () => {
    await mountPane({ answer: () => noneReply() })
    await click(`[data-test="attach-row"][data-mission="${MISSION}"] [data-test="attach-open"]`)
    expect(q('[data-test="attach-confirm"]')).not.toBeNull()
    expect(door).not.toHaveBeenCalled()
    await click('[data-test="attach-cancel"]')
    expect(q('[data-test="attach-confirm"]')).toBeNull()
    expect(door).not.toHaveBeenCalled()
  })

  it('attaches through the attach door once confirmed, then reads the view again', async () => {
    let attached = false
    await mountPane({
      answer: (req) =>
        attached
          ? missionReply({ leader: LEADER, attached: [LEADER, SESSION] })
          : req.missionId
            ? missionReply({ leader: LEADER })
            : noneReply(),
      doorReply: { ok: true, changed: true }
    })
    door.mockImplementation(async () => {
      attached = true
      return { ok: true, changed: true }
    })
    const reads = view.mock.calls.length
    await click(`[data-test="attach-row"][data-mission="${MISSION}"] [data-test="attach-open"]`)
    await click('[data-test="attach-confirm-yes"]')
    expect(door).toHaveBeenCalledTimes(1)
    expect(door).toHaveBeenCalledWith({
      door: 'attach',
      folder: FOLDER,
      missionId: MISSION,
      sessionId: SESSION
    })
    expect(view.mock.calls.length).toBeGreaterThan(reads)
    await settle()
    expect(q('[data-test="mission-title"]')).not.toBeNull()
  })

  it('says what to do when the attach was refused and keeps the picker', async () => {
    await mountPane({
      answer: () => noneReply(),
      doorReply: { ok: false, code: 'NOT_FOUND', error: 'NOT_FOUND: gone' }
    })
    await click(`[data-test="attach-row"][data-mission="${MISSION}"] [data-test="attach-open"]`)
    await click('[data-test="attach-confirm-yes"]')
    expect(text('[data-test="attach-error"]')).toMatch(/no longer|could not/i)
    expect(qa('[data-test="attach-row"]')).toHaveLength(2)
  })

  it('Start a new mission writes no record: it puts the instruction into this session', async () => {
    liveWriter(SESSION)
    await mountPane({ answer: () => noneReply() })
    await click('[data-test="attach-start"]')
    expect(door).not.toHaveBeenCalled()
    expect(writes[SESSION]).toHaveLength(1)
    expect(writes[SESSION][0]).toContain(NEW_MISSION_INSTRUCTION)
    expect(writes[SESSION][0]).not.toMatch(/\r$/)
    expect(text('[data-test="attach-start-done"]')).toMatch(/press enter/i)
  })

  it('Start a new mission says so when the session is not running', async () => {
    await mountPane({ answer: () => noneReply() })
    await click('[data-test="attach-start"]')
    expect(door).not.toHaveBeenCalled()
    expect(text('[data-test="attach-start-error"]')).toMatch(/not running/i)
  })

  it('a folder with no open mission says so and still offers Start a new mission', async () => {
    await mountPane({ answer: () => noneReply([]) })
    expect(qa('[data-test="attach-row"]')).toHaveLength(0)
    expect(text('[data-test="attach-empty"]')).toMatch(/no open mission/i)
    expect(q('[data-test="attach-start"]')).not.toBeNull()
  })

  it('a refused reply is the no-mission layout with one sentence and a way to retry', async () => {
    let refuse = true
    await mountPane({
      answer: () =>
        refuse
          ? ({ state: 'refused', code: 'UNREADABLE', error: 'UNREADABLE: x' } as never)
          : noneReply()
    })
    expect(q('[data-test="mission-refused"]')).not.toBeNull()
    refuse = false
    await click('[data-test="refused-retry"]')
    await settle()
    expect(qa('[data-test="attach-row"]')).toHaveLength(2)
  })
})

// ---- AC-57 --------------------------------------------------------------------------------------

describe('AC-57 — a session asks to join', () => {
  const askedBy =
    (id: string): ((req: { sessionId: string; missionId?: string }) => MissionV4ViewReply) =>
    (req) =>
      req.missionId === MISSION
        ? missionReply({ leader: LEADER, waiting: [attachItem('atr-1', id)] })
        : req.missionId
          ? missionReply({ id: OTHER_MISSION, leader: null, attached: [] })
          : noneReply()

  it('shows Allow and Deny on the pane of the session that asked', async () => {
    await mountPane({ selected: ASKING, answer: askedBy(ASKING) })
    const card = q('[data-test="attach-request"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('Measure the spec skill, then fix what the numbers show')
    expect(q('[data-test="attach-allow"]')).not.toBeNull()
    expect(q('[data-test="attach-deny"]')).not.toBeNull()
  })

  it('Allow goes through the decideAttach door for that mission and request', async () => {
    await mountPane({ selected: ASKING, answer: askedBy(ASKING) })
    await click('[data-test="attach-allow"]')
    expect(door).toHaveBeenCalledWith({
      door: 'decideAttach',
      folder: FOLDER,
      missionId: MISSION,
      requestId: 'atr-1',
      decision: 'allowed'
    })
  })

  it('Deny goes through the same door as denied', async () => {
    await mountPane({ selected: ASKING, answer: askedBy(ASKING) })
    await click('[data-test="attach-deny"]')
    expect(door).toHaveBeenCalledWith({
      door: 'decideAttach',
      folder: FOLDER,
      missionId: MISSION,
      requestId: 'atr-1',
      decision: 'denied'
    })
  })

  it('does not show another session’s request on a session that asked for nothing', async () => {
    await mountPane({ selected: SESSION, answer: askedBy(ASKING) })
    expect(q('[data-test="attach-request"]')).toBeNull()
    expect(qa('[data-test="attach-row"]')).toHaveLength(2)
  })

  it('the attached pane shows the request too, naming the session that asked', async () => {
    liveWriter(LEADER)
    await mountPane({
      selected: LEADER,
      known: [{ sessionId: ASKING, summary: 'Harnu Scratch' }],
      answer: () => missionReply({ leader: LEADER, waiting: [attachItem('atr-9', ASKING)] })
    })
    const card = q('[data-test="attach-request"]')
    expect(card?.textContent).toContain('Harnu Scratch')
    await click('[data-test="attach-allow"]')
    expect(door).toHaveBeenCalledWith({
      door: 'decideAttach',
      folder: FOLDER,
      missionId: MISSION,
      requestId: 'atr-9',
      decision: 'allowed'
    })
  })

  it('says it changed nothing when the request was already answered elsewhere', async () => {
    await mountPane({
      selected: ASKING,
      answer: askedBy(ASKING),
      doorReply: { ok: true, changed: false }
    })
    await click('[data-test="attach-allow"]')
    expect(text('[data-test="attach-request-note"]')).toMatch(/already/i)
  })

  it('says what to do when the request is gone', async () => {
    await mountPane({
      selected: ASKING,
      answer: askedBy(ASKING),
      doorReply: { ok: false, code: 'NOT_FOUND', error: 'NOT_FOUND: gone' }
    })
    await click('[data-test="attach-deny"]')
    expect(text('[data-test="attach-request-note"]')).toMatch(/no longer|could not/i)
  })
})
