// @vitest-environment jsdom
/**
 * BUG-173 S4 (spec §3.4, I-6, I-7) — the Activity bell renders a record's
 * `items` as clickable rows, and `MissionPill` answers the popover request.
 *
 * - up to 5 rows (`MISSION_ROWS_MAX`) plus a "Review all {n}" button past that;
 * - a row with its owner loaded activates the owner session, then asks the
 *   missions store to open that mission's popover — without dismissing the entry;
 * - a row whose owner is not loaded shows a muted hint and opens the review
 *   focused on that mission;
 * - a record without `items` behaves exactly as before (click navigates + dismisses).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import ActivityBell from '../src/renderer/src/components/ActivityBell.vue'
import MissionPill from '../src/renderer/src/components/MissionPill.vue'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import {
  useNotificationsStore,
  type NotificationItem
} from '../src/renderer/src/stores/notifications'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { fixtureView } from './helpers/mission-v3-view'

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

const GROUP = 'mission-cue'

function item(n: number, over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: `mnt-${n}`,
    title: `Mission ${n}`,
    description: `owes ${n}`,
    sessionId: `owner-${n}`,
    target: { view: 'mission', missionId: `mnt-${n}` },
    ...over
  }
}

function post(items: NotificationItem[]): string {
  return useNotificationsStore().notify({
    ts: Date.now(),
    source: 'app',
    kind: 'warning',
    title: `${items.length} missions need you`,
    group: GROUP,
    items
  }).id
}

let wrapper: VueWrapper | null = null
let activate: ReturnType<typeof vi.fn>

async function openBell(): Promise<VueWrapper> {
  wrapper = mount(ActivityBell, { attachTo: document.body, global: { plugins: [i18n] } })
  await wrapper.get('[data-dsqa="topbar-bell"]').trigger('click')
  await nextTick()
  return wrapper
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
  setActivePinia(createPinia())
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(() => new Promise(() => {}))
  }
  activate = vi.fn(() => true)
  useSessionsStore().activateSession = activate as never
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ActivityBell — grouped entry rows', () => {
  it('renders one row per item with its title and what it owes', async () => {
    post([item(1), item(2)])
    const w = await openBell()
    const rows = w.findAll('[data-dsqa="activity-item"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Mission 1')
    expect(rows[0].text()).toContain('owes 1')
    expect(rows[0].attributes('aria-label')).toBe('Open mission Mission 1')
  })

  it('caps at 5 rows and offers "Review all {n}" for the rest', async () => {
    post([1, 2, 3, 4, 5, 6, 7].map((n) => item(n)))
    const w = await openBell()
    expect(w.findAll('[data-dsqa="activity-item"]')).toHaveLength(5)
    const all = w.get('[data-dsqa="activity-review-all"]')
    expect(all.text()).toBe('Review all 7')
  })

  it('shows no "Review all" at 5 rows or fewer', async () => {
    post([1, 2, 3, 4, 5].map((n) => item(n)))
    const w = await openBell()
    expect(w.findAll('[data-dsqa="activity-item"]')).toHaveLength(5)
    expect(w.find('[data-dsqa="activity-review-all"]').exists()).toBe(false)
  })

  it('"Review all" opens the review and does not dismiss the entry', async () => {
    post([1, 2, 3, 4, 5, 6].map((n) => item(n)))
    const w = await openBell()
    await w.get('[data-dsqa="activity-review-all"]').trigger('click')
    expect(useMissionsStore().reviewRequest).toMatchObject({ missionId: null })
    expect(useNotificationsStore().records).toHaveLength(1)
  })
})

describe('ActivityBell — item click', () => {
  it('owner loaded: activates the owner, requests that popover, keeps the entry', async () => {
    post([item(1), item(2)])
    const w = await openBell()
    await w.findAll('[data-dsqa="activity-item"]')[1].trigger('click')
    expect(activate).toHaveBeenCalledWith('owner-2')
    expect(useMissionsStore().popoverRequest).toMatchObject({ missionId: 'mnt-2' })
    expect(useMissionsStore().reviewRequest).toBeNull()
    expect(useNotificationsStore().records).toHaveLength(1)
  })

  it('owner missing: muted hint, opens the review on that mission, no popover request', async () => {
    activate.mockReturnValue(false)
    post([item(1), item(2)])
    const w = await openBell()
    const rows = w.findAll('[data-dsqa="activity-item"]')
    await rows[0].trigger('click')
    expect(useMissionsStore().reviewRequest).toMatchObject({ missionId: 'mnt-1' })
    expect(useMissionsStore().popoverRequest).toBeNull()
    expect(useNotificationsStore().records).toHaveLength(1)
  })

  it('renders the muted owner hint for a row whose owner is not a loaded session', async () => {
    const sessions = useSessionsStore()
    vi.spyOn(sessions, 'findSessionById' as never).mockImplementation(((id: string) =>
      id === 'owner-1' ? ({ id } as never) : null) as never)
    post([item(1), item(2)])
    const w = await openBell()
    const rows = w.findAll('[data-dsqa="activity-item"]')
    expect(rows[0].attributes('data-owner-missing')).toBeUndefined()
    expect(rows[1].attributes('data-owner-missing')).toBe('true')
    expect(rows[1].attributes('title')).toBe(
      'The owner session isn’t open here — click to review this mission instead.'
    )
  })

  it('a click on the entry’s title or body does nothing and does not dismiss', async () => {
    post([item(1)])
    const w = await openBell()
    await w.get('[data-dsqa="activity-row"]').trigger('click')
    expect(activate).not.toHaveBeenCalled()
    expect(useNotificationsStore().records).toHaveLength(1)
  })

  it('the hover × still dismisses the whole entry', async () => {
    post([item(1)])
    const w = await openBell()
    await w.get('button[aria-label="Dismiss"]').trigger('click')
    expect(useNotificationsStore().records).toHaveLength(0)
  })
})

describe('ActivityBell — records without items are unchanged (I-7)', () => {
  it('a plain session row still navigates and dismisses on click', async () => {
    useNotificationsStore().notify({
      ts: Date.now(),
      source: 'app',
      kind: 'info',
      title: 'Plain',
      sessionId: 'sess-1'
    })
    const w = await openBell()
    expect(w.find('[data-dsqa="activity-item"]').exists()).toBe(false)
    await w.get('[data-dsqa="activity-row"]').trigger('click')
    expect(activate).toHaveBeenCalledWith('sess-1')
    expect(useNotificationsStore().records).toHaveLength(0)
  })
})

describe('MissionPill — answers popoverRequest', () => {
  let pill: VueWrapper | null = null
  afterEach(() => {
    pill?.unmount()
    pill = null
  })

  async function mountPill(
    request: 'before' | 'after' | 'other'
  ): Promise<{ w: VueWrapper; id: string }> {
    const v = fixtureView('faq-like')
    ;(window as unknown as { api: unknown }).api = {
      missionList: vi.fn(async () => ({ views: [v], unreadable: [] })),
      missionOperatorDoor: vi.fn()
    }
    useSessionsStore().folders = [{ path: '/repo', sessions: [] }] as never
    const missions = useMissionsStore()
    await missions.refresh()
    const id = v.mission.id
    const wanted = request === 'other' ? 'mnt-someone-else' : id
    if (request === 'before') missions.requestPopover(wanted)
    const w = mount(MissionPill, {
      attachTo: document.body,
      props: { sessionId: v.mission.owner.sessionId },
      global: { plugins: [i18n] }
    })
    pill = w
    await flushPromises()
    if (request !== 'before') {
      missions.requestPopover(wanted)
      await flushPromises()
    }
    return { w, id }
  }

  it('opens its popover for a request made before it mounted, and consumes it', async () => {
    const { w } = await mountPill('before')
    expect(w.get('button').attributes('aria-expanded')).toBe('true')
    expect(useMissionsStore().popoverRequest).toBeNull()
  })

  it('opens its popover for a request made while mounted, and consumes it', async () => {
    const { w } = await mountPill('after')
    expect(w.get('button').attributes('aria-expanded')).toBe('true')
    expect(useMissionsStore().popoverRequest).toBeNull()
  })

  it('ignores a request for another mission and leaves it pending', async () => {
    const { w } = await mountPill('other')
    expect(w.get('button').attributes('aria-expanded')).toBe('false')
    expect(useMissionsStore().popoverRequest).toMatchObject({ missionId: 'mnt-someone-else' })
  })
})
