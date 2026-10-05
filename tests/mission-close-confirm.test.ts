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
