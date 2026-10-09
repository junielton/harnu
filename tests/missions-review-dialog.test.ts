// @vitest-environment jsdom
/**
 * BUG-173 S5 (spec §3.5, I-8) — the Missions review dialog and its bulk-close
 * confirm. Opens on `missions.reviewRequest` with no session selected, lists the
 * owed missions in three groups, pre-selects only the ready ones, and closes the
 * selection as delivered through the existing end door — one call per mission,
 * `bulk close` in every reason.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import type { MissionDoor, MissionDoorResult, MissionView } from '../src/main/mission-ipc'
import MissionsReviewDialog from '../src/renderer/src/components/MissionsReviewDialog.vue'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

function view(
  id: string,
  over: {
    status?: string
    pendingClose?: boolean
    allDone?: boolean
    you?: MissionView['you']
    warnings?: MissionView['closeWarnings']
  } = {}
): MissionView {
  return {
    root: '/repo',
    mission: {
      id,
      status: over.status ?? 'active',
      updatedAt: '2026-10-09T10:00:00.000Z',
      owner: { sessionId: `owner-${id}`, folder: '/repo' },
      ...(over.pendingClose
        ? { pendingClose: { at: '2026-10-09T09:00:00.000Z', requestedBy: 'x' } }
        : {}),
      blockers: [],
      steps: [{ id: 'stp-9', kind: 'fixed-end', title: 'Delivered and verified', blockers: [] }]
    },
    title: `Mission ${id}`,
    derived: { stale: false },
    progress: { allDone: over.allDone ?? false, leftBehind: [] },
    you: over.you ?? [{ kind: 'checks', count: 1, stepIds: ['stp-9'] }],
    closeWarnings: over.warnings ?? []
  } as unknown as MissionView
}
const ready = (id: string): MissionView =>
  view(id, { status: 'delivered', pendingClose: true, allDone: true, you: [{ kind: 'close' }] })
const finished = (id: string): MissionView =>
  view(id, { allDone: true, warnings: [{ kind: 'end-unverified', detail: '' }] as never })
const other = (id: string): MissionView =>
  view(id, { you: [{ kind: 'blocker', reason: 'merge PR', unblocks: 'merged' }] as never })

let wrapper: VueWrapper | null = null
let doorFn: ReturnType<typeof vi.fn>
let answers: Record<string, MissionDoorResult>
/** What the server still lists when the end-of-batch refresh reads it. */
let serverViews: MissionView[]
let activate: ReturnType<typeof vi.fn>

const body = (): HTMLElement => document.body
const q = (sel: string): HTMLElement | null => body().querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => [...body().querySelectorAll<HTMLElement>(sel)]
const rowIds = (group: string): string[] =>
  qa(`[data-test="review-group-${group}"] [data-test="review-row"]`).map(
    (r) => r.dataset.missionId ?? ''
  )

async function open(views: MissionView[], focus?: string): Promise<void> {
  const store = useMissionsStore()
  store.views = views
  wrapper = mount(MissionsReviewDialog, { attachTo: document.body, global: { plugins: [i18n] } })
  store.openReview(focus)
  await flushPromises()
  await nextTick()
}

async function click(el: HTMLElement | null): Promise<void> {
  if (!el) throw new Error('element not found')
  el.click()
  await flushPromises()
  await nextTick()
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
  localStorage.setItem('om2tab.missionCues', JSON.stringify({ v: 1, owed: {} }))
  setActivePinia(createPinia())
  useSessionsStore().folders = [{ path: '/repo', sessions: [] }] as never
  activate = vi.fn(() => true)
  useSessionsStore().activateSession = activate as never
  useSessionsStore().findSessionById = vi.fn(() => ({})) as never
  answers = {}
  serverViews = []
  doorFn = vi.fn(async (d: MissionDoor) => answers[d.missionId] ?? { ok: true, view: null })
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: serverViews, unreadable: [] })),
    missionOperatorDoor: doorFn,
    requestAttention: vi.fn(async () => undefined)
  }
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('MissionsReviewDialog — listing', () => {
  it('stays closed until a review is requested', async () => {
    useMissionsStore().views = [ready('r1')]
    wrapper = mount(MissionsReviewDialog, { attachTo: document.body, global: { plugins: [i18n] } })
    await nextTick()
    expect(q('[data-test="missions-review"]')).toBeNull()
  })

  it('opens on the request with no session selected, and consumes it', async () => {
    await open([ready('r1')])
    expect(q('[data-test="missions-review"]')).not.toBeNull()
    expect(useSessionsStore().selectedId).toBeFalsy()
    expect(useMissionsStore().reviewRequest).toBeNull()
  })

  it('lists the three groups, ready first', async () => {
    await open([other('o1'), finished('f1'), ready('r1'), ready('r2')])
    expect(rowIds('ready')).toEqual(['r1', 'r2'])
    expect(rowIds('finished')).toEqual(['f1'])
    expect(rowIds('other')).toEqual(['o1'])
  })

  it('pre-selects the ready group only and counts the selection', async () => {
    await open([other('o1'), finished('f1'), ready('r1'), ready('r2')])
    const checked = (id: string): boolean =>
      (q(`[data-mission-id="${id}"] input[type="checkbox"]`) as HTMLInputElement).checked
    expect(checked('r1')).toBe(true)
    expect(checked('r2')).toBe(true)
    expect(checked('f1')).toBe(false)
    expect(q('[data-test="review-count"]')?.textContent).toContain('2 selected')
  })

  it('gives the other group no checkbox, and shows warnings inline for finished rows', async () => {
    await open([other('o1'), finished('f1')])
    expect(q('[data-mission-id="o1"] input[type="checkbox"]')).toBeNull()
    const warn = q('[data-mission-id="f1"] [data-test="review-row-warnings"]')
    expect(warn?.textContent).toContain('The end is not verified')
    expect(warn?.textContent).toContain('Delivered and verified')
  })

  it('highlights and scrolls to the focused mission', async () => {
    await open([ready('r1'), other('o1')], 'o1')
    expect(q('[data-mission-id="o1"]')?.dataset.focused).toBe('true')
    expect(q('[data-mission-id="r1"]')?.dataset.focused).toBeUndefined()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('says so when nothing is owed', async () => {
    await open([])
    expect(q('[data-test="review-empty"]')).not.toBeNull()
  })
})

describe('MissionsReviewDialog — selection', () => {
  it('disables the primary at zero and enables it with a selection', async () => {
    await open([finished('f1')])
    const go = q('[data-test="review-close-selected"]') as HTMLButtonElement
    expect(go.disabled).toBe(true)
    await click(q('[data-mission-id="f1"] input[type="checkbox"]'))
    expect(go.disabled).toBe(false)
    expect(go.textContent).toContain('Close 1 as delivered')
  })

  it('"Select all ready" selects the ready group and not the finished one', async () => {
    await open([ready('r1'), ready('r2'), finished('f1')])
    await click(q('[data-mission-id="r1"] input[type="checkbox"]'))
    await click(q('[data-mission-id="r2"] input[type="checkbox"]'))
    expect(q('[data-test="review-count"]')?.textContent).toContain('0 selected')
    await click(q('[data-test="review-select-all"]'))
    expect(q('[data-test="review-count"]')?.textContent).toContain('2 selected')
    expect((q('[data-mission-id="f1"] input[type="checkbox"]') as HTMLInputElement).checked).toBe(
      false
    )
  })

  it('"Open" on an other row activates the owner, asks for the popover and closes the review', async () => {
    await open([other('o1')])
    await click(q('[data-mission-id="o1"] [data-test="review-open"]'))
    expect(activate).toHaveBeenCalledWith('owner-o1')
    expect(useMissionsStore().popoverRequest).toMatchObject({ missionId: 'o1' })
    expect(q('[data-test="missions-review"]')).toBeNull()
  })

  it('disables "Open" when the owner session is not loaded', async () => {
    useSessionsStore().findSessionById = vi.fn(() => null) as never
    await open([other('o1')])
    const openBtn = q('[data-mission-id="o1"] [data-test="review-open"]') as HTMLButtonElement
    expect(openBtn.disabled).toBe(true)
    await click(openBtn)
    expect(activate).not.toHaveBeenCalled()
    expect(useMissionsStore().popoverRequest).toBeNull()
  })

  it('never closes anything on the primary alone: it only opens the confirm', async () => {
    await open([ready('r1')])
    await click(q('[data-test="review-close-selected"]'))
    expect(q('[data-test="bulk-close-confirm"]')).not.toBeNull()
    expect(doorFn).not.toHaveBeenCalled()
  })
})

describe('MissionBulkCloseConfirmDialog', () => {
  it('lists each mission with its warnings, and offers no discard', async () => {
    await open([ready('r1'), finished('f1')])
    await click(q('[data-mission-id="f1"] input[type="checkbox"]'))
    await click(q('[data-test="review-close-selected"]'))
    const items = qa('[data-test="bulk-close-item"]')
    expect(items.map((i) => i.dataset.missionId)).toEqual(['r1', 'f1'])
    expect(items[1].textContent).toContain('The end is not verified')
    expect(q('[data-test="bulk-close-confirm"]')?.textContent).toContain(
      'Close 2 missions as delivered?'
    )
    expect(q('[data-test="bulk-close-confirm"]')?.textContent).not.toMatch(/discard/i)
  })

  it('cancel closes the confirm, keeps the review and closes nothing', async () => {
    await open([ready('r1')])
    await click(q('[data-test="review-close-selected"]'))
    await click(q('[data-test="bulk-close-cancel"]'))
    expect(q('[data-test="bulk-close-confirm"]')).toBeNull()
    expect(q('[data-test="missions-review"]')).not.toBeNull()
    expect(doorFn).not.toHaveBeenCalled()
  })

  it('Esc closes the confirm first, then the review', async () => {
    await open([ready('r1')])
    await click(q('[data-test="review-close-selected"]'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(q('[data-test="bulk-close-confirm"]')).toBeNull()
    expect(q('[data-test="missions-review"]')).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(q('[data-test="missions-review"]')).toBeNull()
  })

  it('confirms through the end door, one call per mission, closedAs delivered, "bulk close" reason', async () => {
    await open([ready('r1'), ready('r2')])
    await click(q('[data-test="review-close-selected"]'))
    await click(q('[data-test="bulk-close-go"]'))
    expect(doorFn.mock.calls.map((c) => c[0])).toEqual([
      { door: 'end', root: '/repo', missionId: 'r1', closedAs: 'delivered', reason: 'bulk close' },
      { door: 'end', root: '/repo', missionId: 'r2', closedAs: 'delivered', reason: 'bulk close' }
    ])
  })

  it('puts the operator’s text after the prefix', async () => {
    await open([ready('r1')])
    await click(q('[data-test="review-close-selected"]'))
    const reason = q('[data-test="bulk-close-reason"]') as HTMLTextAreaElement
    reason.value = 'docs pass merged'
    reason.dispatchEvent(new Event('input'))
    await nextTick()
    await click(q('[data-test="bulk-close-go"]'))
    expect(doorFn.mock.calls[0][0].reason).toBe('bulk close: docs pass merged')
  })

  it('on success: one success toast, the missions are gone and the review closes', async () => {
    await open([ready('r1'), ready('r2')])
    await click(q('[data-test="review-close-selected"]'))
    await click(q('[data-test="bulk-close-go"]'))
    const toasts = useUiStore().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ kind: 'success', title: '2 missions closed' })
    expect(useMissionsStore().views).toEqual([])
    expect(q('[data-test="missions-review"]')).toBeNull()
  })

  it('on a partial failure: a danger toast, the review stays on the failed row, still selected', async () => {
    answers.r2 = { ok: false, error: 'DOOR_REFUSED: nope' }
    serverViews = [ready('r2')]
    await open([ready('r1'), ready('r2')])
    await click(q('[data-test="review-close-selected"]'))
    await click(q('[data-test="bulk-close-go"]'))
    const toasts = useUiStore().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ kind: 'danger', title: '1 of 2 could not be closed' })
    expect(q('[data-test="bulk-close-confirm"]')).toBeNull()
    expect(rowIds('ready')).toEqual(['r2'])
    expect((q('[data-mission-id="r2"] input[type="checkbox"]') as HTMLInputElement).checked).toBe(
      true
    )
  })
})
