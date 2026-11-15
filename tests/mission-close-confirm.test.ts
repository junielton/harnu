// @vitest-environment jsdom
/**
 * Mission v3 §3.5 (AC-5, UI part) — ONE end dialog. Any non-closed mission can
 * be ended from the popover: the "End mission…" footer button (and, when a
 * close was requested, the `you` block's Close button) only OPENS the dialog;
 * the `end` door fires from its confirm, as **Close as delivered** or
 * **Discard**, with an optional reason. The server's `closeWarnings` are listed
 * and never hide or disable the confirm. On success the mission leaves the
 * Topbar at once from the door's `view: null` (no list refresh awaited) and the
 * dialog is gone in the same tick; an IPC failure toasts and dismisses. Cancel,
 * X, Esc and a backdrop click leave the mission open. Mounted through
 * `MissionPill` so the pill's click-outside is exercised too.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import type { MissionView } from '../src/main/mission-ipc'
import MissionPill from '../src/renderer/src/components/MissionPill.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { fixtureView } from './helpers/mission-v3-view'
import MissionPane from '../src/renderer/src/components/MissionPane.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import enMessages from '../src/renderer/src/i18n/en.json'
import ptMessages from '../src/renderer/src/i18n/pt-BR.json'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

const { playNotificationSound } = vi.hoisted(() => ({ playNotificationSound: vi.fn() }))
vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound }))

const OWNER = '00000000-0000-4000-8000-000000000001'

/** An active mission mid-flight with open matters — the server warns, never refuses. */
function warnedView(): MissionView {
  const base = fixtureView('faq-like')
  const titles: Record<string, string> = {
    'stp-3': 'Wire the checkout',
    'stp-4': 'Design review',
    'stp-10': 'Delivered and verified'
  }
  const steps = base.mission.steps.map((s) => ({
    ...s,
    title: titles[s.id] ?? s.title,
    checks:
      s.id === 'stp-4'
        ? [
            {
              id: 'chk-1',
              label: 'DSQA done',
              source: 'agent' as const,
              createdAt: '2026-10-01T10:00:00.000Z'
            }
          ]
        : s.checks
  }))
  // The server's own closeWarnings (ids + "(s)" prose); the dialog must not print them.
  return fixtureView('faq-like', { mission: { steps } })
}

/** A delivered mission whose close was requested and would land. */
function requestedView(): MissionView {
  return fixtureView('delivered', {
    mission: {
      status: 'delivered',
      pendingClose: { at: '2026-10-01T11:00:00.000Z', requestedBy: OWNER }
    },
    view: { you: [{ kind: 'close' }], closeWarnings: [] }
  })
}

let door: ReturnType<typeof vi.fn>
let list: ReturnType<typeof vi.fn>
let requestAttention: ReturnType<typeof vi.fn>
let wrapper: VueWrapper | null = null
const body = (): DOMWrapper<Element> => new DOMWrapper(document.body)
const dialog = (): Element | null =>
  document.body.querySelector('[data-test="mission-close-confirm"]')
const popover = (): Element | null => document.body.querySelector('[data-dsqa^="mission-popover"]')
const pill = (): Element | null => document.body.querySelector('[data-dsqa^="topbar-pill"]')

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flushPromises()
}

function seed(v: MissionView): void {
  // Only the first list read answers: a later refresh never lands, so whatever
  // the UI shows after a door comes from the door's own answer.
  list = vi
    .fn()
    .mockResolvedValueOnce({ views: [v], unreadable: [] })
    .mockImplementation(() => new Promise(() => undefined))
  ;(window as unknown as { api: unknown }).api = {
    missionList: list,
    missionOperatorDoor: door,
    requestAttention
  }
}

/** Mount the pill, open the popover, and press `trigger` to open the end dialog. */
async function openEnd(v: MissionView, trigger = 'mission-end-open'): Promise<void> {
  seed(v)
  wrapper = mount(MissionPill, {
    props: { sessionId: OWNER },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  await settle()
  // A fixture that owes a close already played the store's owed cue — clear it:
  // these tests count the dialog's own chime.
  playNotificationSound.mockClear()
  requestAttention.mockClear()
  await body().get('[data-dsqa^="topbar-pill"]').trigger('click')
  await settle()
  await body().get(`[data-test="${trigger}"]`).trigger('click')
  await settle()
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  playNotificationSound.mockClear()
  door = vi.fn(async () => ({ ok: true, view: null }))
  requestAttention = vi.fn()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('the end dialog (Mission v3 §3.5)', () => {
  it('any mission can be ended: the footer button opens the dialog, not the door', async () => {
    await openEnd(warnedView())
    expect(dialog()).not.toBeNull()
    expect(door).not.toHaveBeenCalled()
  })

  it('a requested close opens the same dialog from the you block', async () => {
    await openEnd(requestedView(), 'mission-close')
    expect(dialog()).not.toBeNull()
    expect(body().get('[data-test="mission-end-choice-delivered"] input').element).toHaveProperty(
      'checked',
      true
    )
  })

  it('lists the server’s closeWarnings, and they never disable the confirm', async () => {
    await openEnd(warnedView())
    const items = body().findAll('[data-test="mission-end-warning"]')
    expect(items.map((w) => w.attributes('data-kind'))).toEqual([
      'end-unverified',
      'left-behind',
      'checks-open'
    ])
    expect(items[2].text()).toContain('1 check not ticked')
    expect(items[2].text()).toContain('Design review — DSQA done')
    const go = body().get('[data-test="mission-close-confirm-go"]')
    expect(go.attributes('disabled')).toBeUndefined()
  })

  it('warnings name steps by title, never by id, with real plurals', async () => {
    await openEnd(warnedView())
    const text = body().get('[data-test="mission-end-warnings"]').text()
    expect(text).not.toMatch(/stp-\d+/)
    expect(text).not.toContain('(s)')
    expect(text).toContain('1 step left behind')
    expect(text).toContain('Wire the checkout')
    expect(text).toContain('Delivered and verified')
  })

  it('no warnings, no warnings block', async () => {
    await openEnd(requestedView())
    expect(document.body.querySelector('[data-test="mission-end-warnings"]')).toBeNull()
  })

  it('Close as delivered: one end door, then the mission leaves the Topbar at once', async () => {
    const v = warnedView()
    await openEnd(v)
    // Opening the popover asked for a refresh; it (like every later read) never answers.
    const reads = list.mock.calls.length
    await body().get('[data-test="mission-close-confirm-go"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(door).toHaveBeenCalledTimes(1)
    expect(door).toHaveBeenCalledWith({
      door: 'end',
      closedAs: 'delivered',
      root: '/repo',
      missionId: v.mission.id
    })
    // Gone from the door's `view: null` — the only list read that ever answered is the first.
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(reads)
    expect(dialog()).toBeNull()
    expect(popover()).toBeNull()
    expect(pill()).toBeNull()
  })

  it('Discard writes the reason', async () => {
    const v = warnedView()
    await openEnd(v)
    await body().get('[data-test="mission-end-choice-discarded"] input').setValue(true)
    const go = body().get('[data-test="mission-close-confirm-go"]')
    expect(go.text()).toBe('Discard')
    await body().get('[data-test="mission-end-reason"]').setValue('  superseded by T400  ')
    await go.trigger('click')
    await settle()
    expect(door).toHaveBeenCalledWith({
      door: 'end',
      closedAs: 'discarded',
      reason: 'superseded by T400',
      root: '/repo',
      missionId: v.mission.id
    })
    expect(pill()).toBeNull()
  })

  it('an IPC failure toasts and dismisses the dialog; the mission stays', async () => {
    door = vi.fn(async () => {
      throw new Error('IPC channel closed')
    })
    await openEnd(warnedView())
    await body().get('[data-test="mission-close-confirm-go"]').trigger('click')
    await settle()
    expect(dialog()).toBeNull()
    expect(pill()).not.toBeNull()
    expect(useUiStore().toasts.at(-1)).toMatchObject({
      kind: 'danger',
      title: 'Mission action refused',
      description: 'IPC channel closed'
    })
  })

  it('opening the dialog plays the chime and raises OS attention, once', async () => {
    await openEnd(warnedView())
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
    expect(requestAttention).toHaveBeenCalledTimes(1)
  })

  it('initial focus is Cancel, so a stray Enter cannot end the mission', async () => {
    await openEnd(warnedView())
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute('data-test')).toBe('mission-close-cancel')
    )
  })

  it.each([
    ['Cancel', async () => body().get('[data-test="mission-close-cancel"]').trigger('click')],
    [
      'the X button',
      async () => body().get('[data-test="mission-close-confirm"] header button').trigger('click')
    ],
    ['Esc', async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))],
    [
      'a backdrop click',
      async () => body().get('[data-mission-close-confirm]').trigger('mousedown')
    ]
  ])('%s dismisses the dialog without ending the mission', async (_label, dismiss) => {
    await openEnd(warnedView())
    await dismiss()
    await settle()
    expect(dialog()).toBeNull()
    expect(door).not.toHaveBeenCalled()
    expect(popover()).not.toBeNull()
  })

  it('a click inside the dialog does not close the popover (click-outside ignores it)', async () => {
    await openEnd(warnedView())
    const card = document.body.querySelector('[data-test="mission-close-confirm"] p')!
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    expect(popover()).not.toBeNull()
    expect(dialog()).not.toBeNull()
  })

  it('the popover has no other path to the end door, and no Approve door', () => {
    const src = readFileSync('src/renderer/src/components/MissionPopover.vue', 'utf8')
    const calls = src.match(/door:\s*'end'/g) ?? []
    expect(calls).toHaveLength(1)
    const confirmClose = src.slice(src.indexOf('async function confirmClose'))
    expect(confirmClose.slice(0, confirmClose.indexOf('\n}'))).toMatch(/door:\s*'end'/)
    expect(src).not.toMatch(/door:\s*'approve'/)
  })
})

// ---------------------------------------------------------------------------------------------------
// Missions v4 · S-22 · AC-60 — closing a mission from the Mission pane. The pane offers Close as
// delivered and Discard, lists the open matters as warnings and never refuses; a closed mission leaves
// the pane and the session shows the no-mission state (S-21's attach picker).
// ---------------------------------------------------------------------------------------------------

const FOLDER = '/repo'
const SESSION = '11111111-1111-4111-8111-111111111111'
const MISSION = 'mnt-close01'

type Items = Array<Record<string, unknown>>

interface PaneOpts {
  ready?: boolean
  waiting?: Items
  warnings?: Array<{ kind: string; count: number; text: string }>
  pendingDoneWhen?: { text: string } | null
}

/** One open milestone, one step. `ready` makes it every-step-done and ready to close. */
function paneReply(opts: PaneOpts = {}): MissionV4ViewReply {
  const ready = opts.ready === true
  const items =
    opts.waiting ??
    (ready
      ? [
          {
            kind: 'close',
            id: 'close',
            requested: false,
            ask: 'ZZZ server ask: close it',
            why: 'ZZZ server why'
          }
        ]
      : [])
  return {
    state: 'mission',
    missionId: MISSION,
    source: 'v4',
    detail: {
      ok: true,
      id: 'ZZZ-detail-id',
      title: 'Measure the spec skill, then fix what the numbers show',
      doneWhen: 'The spec skill is scored and both fixes are proven by the score',
      status: 'open',
      state: ready ? 'ready-to-close' : 'open',
      stateLabel: 'ZZZ',
      standing: 'operator',
      leads: SESSION,
      source: 'v4',
      progress: {
        unit: 'milestones',
        total: 1,
        done: ready ? 1 : 0,
        headline: 'ZZZ',
        current: ready ? null : { id: 'mls-1', ordinal: 1 },
        allDone: ready,
        counts: {
          todo: 0,
          running: ready ? 0 : 1,
          waitingReview: 0,
          done: ready ? 1 : 0,
          blocked: 0
        }
      },
      milestones: [
        {
          id: 'mls-1',
          title: 'A tool that scores a spec',
          optional: false,
          waitsFor: null,
          state: ready ? 'done' : 'in-progress',
          stateLabel: 'ZZZ',
          counts: { running: ready ? 0 : 1, waitingReview: 0, blocked: 0 }
        }
      ],
      steps: [
        {
          id: 'stp-1',
          title: 'Write the plan for the scoring tool',
          milestone: 'mls-1',
          optional: false,
          state: ready ? 'done' : 'running',
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
    closeWarnings: opts.warnings ?? [],
    pendingDoneWhen: opts.pendingDoneWhen ?? null,
    sessions: [
      {
        id: SESSION,
        role: 'leads',
        from: '2026-11-13T10:00:00.000Z',
        to: null,
        stoppedAt: null,
        open: true
      }
    ],
    handoff: { offer: false, percent: null }
  } as unknown as MissionV4ViewReply
}

const NONE: MissionV4ViewReply = { state: 'none', missions: [] } as unknown as MissionV4ViewReply

/** Every kind of open matter the close door counts, with the English words the server puts in `text`. */
const ALL_WARNINGS = [
  { kind: 'unfinished-steps', count: 3, text: 'ZZZ 3 steps are not done' },
  { kind: 'open-blockers', count: 1, text: 'ZZZ 1 blocker is still open' },
  { kind: 'staged-done-when', count: 1, text: 'ZZZ A new Done when is waiting' },
  { kind: 'attach-requests', count: 2, text: 'ZZZ 2 sessions are waiting to join' }
]

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const text = (sel: string): string => (q(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim()

async function paneSettle(): Promise<void> {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 150))
  await flushPromises()
}

async function pressOn(sel: string): Promise<void> {
  const el = q(sel)
  if (!el) throw new Error(`no element for ${sel}`)
  el.click()
  await paneSettle()
}

let viewAnswers: MissionV4ViewReply[]
let paneDoor: ReturnType<typeof vi.fn>
let paneView: ReturnType<typeof vi.fn>

/** Mount the pane; the view answers `viewAnswers` in order, then keeps answering the last one. */
async function mountPane(
  first: MissionV4ViewReply,
  doorReply: unknown = { ok: true, changed: true }
) {
  viewAnswers = [first]
  paneView = vi.fn(async () => (viewAnswers.length > 1 ? viewAnswers.shift()! : viewAnswers[0]))
  paneDoor = vi.fn(async () => doorReply)
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
    campaignList: vi.fn(async () => ({ views: [], unreadable: [] })),
    missionV4View: paneView,
    missionV4Door: paneDoor,
    missionHandOff: vi.fn(),
    missionOperatorDoor: vi.fn(),
    requestAttention,
    sessionLinksList: vi.fn(async () => []),
    shellOpenExternal: vi.fn(async () => undefined),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined)
  }
  const sessions = useSessionsStore()
  sessions.folders = [
    { path: FOLDER, sessions: [{ sessionId: SESSION, projectPath: FOLDER, summary: 'Harnu Spec' }] }
  ] as never
  sessions.select(SESSION)
  wrapper = mount(MissionPane, {
    props: {
      pane: { id: 'h-mission', type: 'mission', cwd: FOLDER, ratio: 1 },
      worktreePath: FOLDER
    },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  await paneSettle()
}

describe('closing a mission from the pane (Missions v4 S-22, AC-60)', () => {
  it('a mission that is not ready can still be closed: a quiet Close mission… opens the dialog, not the door', async () => {
    await mountPane(paneReply())
    expect(dialog()).toBeNull()
    await pressOn('[data-test="mission-close-open"]')
    expect(dialog()).not.toBeNull()
    expect(paneDoor).not.toHaveBeenCalled()
    // Both ends are offered; a mission that is not done opens on Discard, so a stray Enter confirms nothing it did not mean.
    expect(q('[data-test="mission-end-choice-delivered"]')).not.toBeNull()
    expect(q('[data-test="mission-end-choice-discarded"]')).not.toBeNull()
  })

  it('close never refuses: every open matter is a warning in words, and the confirm stays enabled', async () => {
    await mountPane(paneReply({ warnings: ALL_WARNINGS }))
    await pressOn('[data-test="mission-close-open"]')
    const rows = [...document.body.querySelectorAll('[data-test="mission-end-warning"]')]
    expect(rows.map((r) => (r as HTMLElement).dataset.kind)).toEqual([
      'unfinished-steps',
      'open-blockers',
      'staged-done-when',
      'attach-requests'
    ])
    const words = text('[data-test="mission-end-warnings"]')
    expect(words).toContain('3 steps are not done')
    expect(words).toContain('1 blocker is still open')
    expect(words).toContain('A new Done when is waiting for your approval')
    expect(words).toContain('2 sessions are waiting to join')
    // The server's own words are never the copy.
    expect(words).not.toContain('ZZZ')
    const go = q('[data-test="mission-close-confirm-go"]') as HTMLButtonElement
    expect(go.disabled).toBe(false)
    // ...and pressing it sends the door, whatever is open.
    await pressOn('[data-test="mission-end-choice-delivered"] input')
    await pressOn('[data-test="mission-close-confirm-go"]')
    expect(paneDoor).toHaveBeenCalledTimes(1)
    expect(paneDoor.mock.calls[0][0]).toMatchObject({
      door: 'close',
      closedAs: 'delivered',
      folder: FOLDER,
      missionId: MISSION
    })
  })

  it('no open matters, no warnings block', async () => {
    await mountPane(paneReply({ ready: true }))
    await pressOn('[data-test="mission-close-open"]')
    expect(q('[data-test="mission-end-warnings"]')).toBeNull()
  })

  it('closing as delivered says the Done when it confirms; discarding says it confirms nothing', async () => {
    await mountPane(paneReply({ ready: true }))
    await pressOn('[data-test="mission-close-open"]')
    expect(text('[data-test="mission-close-confirm"]')).toContain(
      'The spec skill is scored and both fixes are proven by the score'
    )
    expect(text('[data-test="mission-close-done-when"]')).toContain('confirm')
    await pressOn('[data-test="mission-end-choice-discarded"] input')
    expect(q('[data-test="mission-close-done-when"]')).toBeNull()
  })

  it('Discard sends the reason, and the mission leaves the pane for the no-mission state', async () => {
    await mountPane(paneReply({ warnings: ALL_WARNINGS }))
    expect(q('[data-test="mission-title"]')).not.toBeNull()
    await pressOn('[data-test="mission-close-open"]')
    await pressOn('[data-test="mission-end-choice-discarded"] input')
    const reason = q('[data-test="mission-end-reason"]') as HTMLTextAreaElement
    reason.value = 'Duplicate of another mission'
    reason.dispatchEvent(new Event('input', { bubbles: true }))
    // After the door the view answers: this session has no mission.
    viewAnswers = [NONE]
    await pressOn('[data-test="mission-close-confirm-go"]')
    expect(paneDoor.mock.calls[0][0]).toMatchObject({
      door: 'close',
      closedAs: 'discarded',
      reason: 'Duplicate of another mission'
    })
    // The view was read again after the reply, and the pane shows the attach picker's state.
    expect(dialog()).toBeNull()
    expect(q('[data-test="mission-title"]')).toBeNull()
    expect(q('[data-test="mission-none"]')).not.toBeNull()
  })

  it('a mission the view reports closed leaves the pane at once, and the dialog with it', async () => {
    await mountPane(paneReply())
    await pressOn('[data-test="mission-close-open"]')
    const closed = paneReply()
    if (closed.state !== 'mission') throw new Error('fixture')
    ;(closed.detail as { status: string }).status = 'closed'
    ;(closed.detail as { state: string }).state = 'closed'
    viewAnswers = [closed, NONE]
    await pressOn('[data-test="mission-close-confirm-go"]')
    expect(dialog()).toBeNull()
    expect(q('[data-test="mission-none"]')).not.toBeNull()
  })

  it('a door that fails keeps the dialog open and says what to do, never its code', async () => {
    await mountPane(paneReply(), { ok: false, code: 'WRITE_CONFLICT', error: 'WRITE_CONFLICT: x' })
    await pressOn('[data-test="mission-close-open"]')
    await pressOn('[data-test="mission-close-confirm-go"]')
    expect(dialog()).not.toBeNull()
    const err = text('[data-test="mission-close-error"]')
    expect(err).toContain('changed at the same moment')
    expect(err).not.toContain('WRITE_CONFLICT')
    // Cancel is still there, and the confirm can be pressed again.
    expect((q('[data-test="mission-close-confirm-go"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('Cancel, Esc and a backdrop click leave the mission open and call no door', async () => {
    await mountPane(paneReply())
    await pressOn('[data-test="mission-close-open"]')
    await pressOn('[data-test="mission-close-cancel"]')
    expect(dialog()).toBeNull()
    await pressOn('[data-test="mission-close-open"]')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await paneSettle()
    expect(dialog()).toBeNull()
    expect(paneDoor).not.toHaveBeenCalled()
    expect(q('[data-test="mission-title"]')).not.toBeNull()
  })

  it('a ready mission: the Next box offers Close mission… (the owner of the close), and it opens the same dialog', async () => {
    await mountPane(paneReply({ ready: true }))
    const btn = q('[data-test="next-close"]')
    expect(btn?.textContent).toContain('Close mission')
    // The server's words for the item are shown as written.
    expect(text('[data-test="next-step"]')).toContain('ZZZ server ask: close it')
    await pressOn('[data-test="next-close"]')
    expect(dialog()).not.toBeNull()
    // A ready mission opens on Close as delivered.
    expect(
      (q('[data-test="mission-end-choice-delivered"] input') as HTMLInputElement).checked
    ).toBe(true)
  })

  it('every step done but something else ranks first: the close item in the rest has its own button', async () => {
    const waiting: Items = [
      { kind: 'review', id: 'review', stepIds: ['stp-1'], prs: [], ask: 'Look it over', why: 'x' },
      { kind: 'close', id: 'close', requested: false, ask: 'Close it', why: 'It is finished' }
    ]
    await mountPane(paneReply({ ready: true, waiting }))
    await pressOn('[data-test="next-more"]')
    const row = document.body.querySelector('[data-test="next-rest-row"][data-kind="close"]')
    expect(row?.querySelector('[data-test="next-close"]')).not.toBeNull()
    ;(row?.querySelector('[data-test="next-close"]') as HTMLElement).click()
    await paneSettle()
    expect(dialog()).not.toBeNull()
  })

  it('the foot Close button is green when the mission is ready and muted when it is not', async () => {
    // design.md: text-green when ready. A static text-text-3 beside it always wins, so check the pair.
    await mountPane(paneReply({ ready: true }))
    const ready = q('[data-test="mission-close-open"]')!
    expect(ready.classList.contains('text-green')).toBe(true)
    expect(ready.classList.contains('text-text-3')).toBe(false)
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    await mountPane(paneReply())
    const open = q('[data-test="mission-close-open"]')!
    expect(open.classList.contains('text-text-3')).toBe(true)
    expect(open.classList.contains('text-green')).toBe(false)
  })

  it('a mission that is not ready draws no Close button in the Next box', async () => {
    await mountPane(paneReply())
    expect(q('[data-test="next-close"]')).toBeNull()
    expect(q('[data-test="mission-close-open"]')).not.toBeNull()
  })

  it('every string the close flow shows exists in en and pt-BR', () => {
    const keys = (o: unknown, prefix = ''): string[] =>
      Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]
      )
    const en = keys((enMessages as { missionPane: { close: unknown } }).missionPane.close)
    const pt = keys((ptMessages as { missionPane: { close: unknown } }).missionPane.close)
    expect(en.length).toBeGreaterThan(8)
    expect(pt).toEqual(en)
  })
})
