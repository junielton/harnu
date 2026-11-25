// @vitest-environment jsdom
/**
 * Closing a mission from the Mission dropdown (Missions v4 S-22, AC-60; the dropdown replaced the pane in the
 * Mission dropdown work) — ONE end dialog. It offers Close as delivered and Discard, with an optional reason;
 * every open matter is a warning in words and never disables the confirm; a closed mission leaves the Topbar and
 * takes the dropdown with it. (The v3 popover that used to open the same dialog is gone, S-37, and its tests
 * with it.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import MissionDropdown from '../src/renderer/src/components/MissionDropdown.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import enMessages from '../src/renderer/src/i18n/en.json'
import ptMessages from '../src/renderer/src/i18n/pt-BR.json'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

const { playNotificationSound } = vi.hoisted(() => ({ playNotificationSound: vi.fn() }))
vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound }))

let requestAttention: ReturnType<typeof vi.fn>
let wrapper: VueWrapper | null = null
const dialog = (): Element | null =>
  document.body.querySelector('[data-test="mission-close-confirm"]')

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  playNotificationSound.mockClear()
  requestAttention = vi.fn()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------------------------------
// Missions v4 · S-22 · AC-60 — closing a mission from the Mission dropdown. It offers Close as delivered and
// Discard, lists the open matters as warnings and never refuses; a mission that is closed leaves the Topbar.
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

/** Mount the dropdown open; the view answers `viewAnswers` in order, then keeps answering the last one. */
async function mountPane(
  first: MissionV4ViewReply,
  doorReply: unknown = { ok: true, changed: true }
) {
  viewAnswers = [first]
  paneView = vi.fn(async () => (viewAnswers.length > 1 ? viewAnswers.shift()! : viewAnswers[0]))
  paneDoor = vi.fn(async () => doorReply)
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
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
  useMissionsStore().ensureStarted()
  await paneSettle()
  wrapper = mount(MissionDropdown, { global: { plugins: [i18n] }, attachTo: document.body })
  const ui = useUiStore()
  ui.setPopoverAnchor('missionProgress', true)
  ui.openPopover('missionProgress')
  await paneSettle()
}

describe('closing a mission from the dropdown (Missions v4 S-22, AC-60)', () => {
  it('a mission that is not ready can still be closed: a quiet Close mission… opens the dialog, not the door', async () => {
    await mountPane(paneReply())
    expect(dialog()).toBeNull()
    await pressOn('[data-test="footer-close"]')
    expect(dialog()).not.toBeNull()
    expect(paneDoor).not.toHaveBeenCalled()
    // Both ends are offered; a mission that is not done opens on Discard, so a stray Enter confirms nothing it did not mean.
    expect(q('[data-test="mission-end-choice-delivered"]')).not.toBeNull()
    expect(q('[data-test="mission-end-choice-discarded"]')).not.toBeNull()
  })

  it('the body names the Topbar', async () => {
    await mountPane(paneReply())
    await pressOn('[data-test="footer-close"]')
    // The dropdown is the only surface that opens this dialog (S-7): the mission leaves the Topbar.
    const body = text('[data-test="mission-close-confirm"] p')
    expect(body).toContain('leaves the Topbar and cannot be reopened.')
    expect(body).not.toMatch(/Mission pane/)
    const close = (m: unknown): string =>
      (m as { missionPane: { close: { body: string } } }).missionPane.close.body
    expect(close(enMessages)).toBe(
      '{title} leaves the Topbar and cannot be reopened. The mission file stays on disk as the record.'
    )
    // pt-BR says the same thing in Portuguese: it names the Topbar and no longer names a pane.
    expect(close(ptMessages)).toContain('{title}')
    expect(close(ptMessages)).toContain('Topbar')
    expect(close(ptMessages)).not.toMatch(/painel/i)
  })

  it('the dialog says "How to close it" and the confirm says "Close mission" (the mockup\'s close-confirm)', async () => {
    await mountPane(paneReply({ ready: true }))
    await pressOn('[data-test="next-button"]')
    // The legend is drawn (not screen-reader only), in the mission's words.
    const legend = q('[data-test="mission-close-confirm"] legend')!
    expect(legend.textContent?.trim()).toBe('How to close it')
    expect(legend.classList.contains('sr-only')).toBe(false)
    // A delivered end reads "Close mission"; Discard keeps its own word, so the button never hides the choice.
    expect(text('[data-test="mission-close-confirm-go"]')).toBe('Close mission')
    ;(q('[data-test="mission-end-choice-discarded"] input') as HTMLInputElement).click()
    await paneSettle()
    expect(text('[data-test="mission-close-confirm-go"]')).toBe('Discard')
    // The Reason box stays: the spec keeps the pane's dialog and the reason goes to the mission's Log.
    expect(q('[data-test="mission-end-reason"]')).not.toBeNull()
    const pick = (m: unknown, k: string): string =>
      (m as { missionPane: { close: Record<string, string> } }).missionPane.close[k]
    expect(pick(enMessages, 'how')).toBe('How to close it')
    expect(pick(enMessages, 'confirm')).toBe('Close mission')
    expect(pick(ptMessages, 'how')).not.toBe(pick(enMessages, 'how'))
    expect(pick(ptMessages, 'confirm')).not.toBe(pick(enMessages, 'confirm'))
    expect(pick(ptMessages, 'confirm').length).toBeGreaterThan(0)
  })

  it('close never refuses: every open matter is a warning in words, and the confirm stays enabled', async () => {
    await mountPane(paneReply({ warnings: ALL_WARNINGS }))
    await pressOn('[data-test="footer-close"]')
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
    await pressOn('[data-test="next-button"]')
    expect(q('[data-test="mission-end-warnings"]')).toBeNull()
  })

  it('closing as delivered says the Done when it confirms; discarding says it confirms nothing', async () => {
    await mountPane(paneReply({ ready: true }))
    await pressOn('[data-test="next-button"]')
    expect(text('[data-test="mission-close-confirm"]')).toContain(
      'The spec skill is scored and both fixes are proven by the score'
    )
    expect(text('[data-test="mission-close-done-when"]')).toContain('confirm')
    await pressOn('[data-test="mission-end-choice-discarded"] input')
    expect(q('[data-test="mission-close-done-when"]')).toBeNull()
  })

  it('Discard sends the reason, and the mission leaves the Topbar: the dropdown closes with the dialog', async () => {
    await mountPane(paneReply({ warnings: ALL_WARNINGS }))
    expect(q('[data-test="mission-title"]')).not.toBeNull()
    await pressOn('[data-test="footer-close"]')
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
    // A door that ends the mission closes the dropdown too: there is no mission left to look at.
    expect(dialog()).toBeNull()
    expect(q('[data-test="mission-dropdown"]')).toBeNull()
  })

  it('a mission the view reports closed leaves the dropdown at once, and the dialog with it', async () => {
    await mountPane(paneReply())
    await pressOn('[data-test="footer-close"]')
    const closed = paneReply()
    if (closed.state !== 'mission') throw new Error('fixture')
    ;(closed.detail as { status: string }).status = 'closed'
    ;(closed.detail as { state: string }).state = 'closed'
    viewAnswers = [closed, NONE]
    await pressOn('[data-test="mission-close-confirm-go"]')
    expect(dialog()).toBeNull()
    expect(q('[data-test="mission-dropdown"]')).toBeNull()
  })

  it('a door that fails keeps the dialog open and says what to do, never its code', async () => {
    await mountPane(paneReply(), { ok: false, code: 'WRITE_CONFLICT', error: 'WRITE_CONFLICT: x' })
    await pressOn('[data-test="footer-close"]')
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
    await pressOn('[data-test="footer-close"]')
    await pressOn('[data-test="mission-close-cancel"]')
    expect(dialog()).toBeNull()
    await pressOn('[data-test="footer-close"]')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await paneSettle()
    expect(dialog()).toBeNull()
    expect(paneDoor).not.toHaveBeenCalled()
    expect(q('[data-test="mission-title"]')).not.toBeNull()
  })

  it('a ready mission: the Next card offers Close mission… (the owner of the close), and it opens the same dialog', async () => {
    await mountPane(paneReply({ ready: true }))
    const btn = q('[data-test="next-button"]')
    expect(btn?.textContent).toContain('Close mission')
    // The dropdown words a close item itself (stp-21): the server's English is never shown for a kind it knows.
    expect(text('[data-test="next-card"]')).toContain('Close the mission: every step is done')
    expect(text('[data-test="next-card"]')).not.toContain('ZZZ server ask')
    // The footer does not repeat it.
    expect(q('[data-test="footer-close"]')).toBeNull()
    await pressOn('[data-test="next-button"]')
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
    expect(row?.querySelector('[data-test="next-button-rest"]')).not.toBeNull()
    ;(row?.querySelector('[data-test="next-button-rest"]') as HTMLElement).click()
    await paneSettle()
    expect(dialog()).not.toBeNull()
  })

  it('a mission that is not ready draws no Close button in the Next card, only the footer one', async () => {
    await mountPane(paneReply())
    expect(q('[data-test="next-button"]')).toBeNull()
    expect(q('[data-test="footer-close"]')).not.toBeNull()
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
