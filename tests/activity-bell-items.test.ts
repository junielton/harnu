// @vitest-environment jsdom
/**
 * BUG-173 S4 (spec §3.4, I-6, I-7) — the Activity bell renders a record's
 * `items` as clickable rows, and an Activity row opens the Mission pane.
 *
 * - every row of the group is listed (S-37: the Missions review that took the rows past five is gone);
 * - a row with its owner loaded activates the owner session, then opens that mission's
 *   pane (S-35) — without dismissing the entry;
 * - a row whose owner is not loaded shows a muted hint and, on click, a notice that names the
 *   mission: never a dead click, and never a second surface (S-37);
 * - a record without `items` behaves exactly as before (click navigates + dismisses).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import ActivityBell from '../src/renderer/src/components/ActivityBell.vue'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useUiStore } from '../src/renderer/src/stores/ui'
import {
  useNotificationsStore,
  type NotificationItem
} from '../src/renderer/src/stores/notifications'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'

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

  it('lists every row of the group and offers no second surface to take the rest', async () => {
    post([1, 2, 3, 4, 5, 6, 7].map((n) => item(n)))
    const w = await openBell()
    expect(w.findAll('[data-dsqa="activity-item"]')).toHaveLength(7)
    expect(w.find('[data-dsqa="activity-review-all"]').exists()).toBe(false)
  })
})

describe('ActivityBell — item click', () => {
  it('owner loaded: activates the owner, opens that mission, keeps the entry', async () => {
    post([item(1), item(2)])
    const w = await openBell()
    await w.findAll('[data-dsqa="activity-item"]')[1].trigger('click')
    expect(activate).toHaveBeenCalledWith('owner-2')
    expect(useNotificationsStore().records).toHaveLength(1)
  })

  it('owner missing: a notice that names the mission, no pane, the entry stays', async () => {
    activate.mockReturnValue(false)
    post([item(1), item(2)])
    const w = await openBell()
    const rows = w.findAll('[data-dsqa="activity-item"]')
    const ui = useUiStore()
    await rows[0].trigger('click')
    const notice = ui.toasts.find((t) => `${t.title} ${t.description ?? ''}`.includes('Mission 1'))
    expect(notice).toBeDefined()
    expect(notice?.kind).toBe('warning')
    expect(useHelpersStore().panesForCurrentWorktree.map((p) => p.type)).not.toContain('mission')
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
      'The owner session isn’t open here — click to see why this mission can’t open.'
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

describe('an Activity row opens the Mission pane (S-35)', () => {
  const OWNER = 'sess-1'
  const panes = (): string[] => useHelpersStore().panesForCurrentWorktree.map((p) => p.type)

  function select(): void {
    const sessions = useSessionsStore()
    sessions.folders = [
      { path: '/repo', sessions: [{ sessionId: OWNER, projectPath: '/repo' }] }
    ] as never
    sessions.select(OWNER)
  }
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      missionList: vi.fn(async () => ({ views: [], unreadable: [] })),
      missionOperatorDoor: vi.fn(),
      helpersGet: vi.fn(async () => null),
      helpersSet: vi.fn(async () => undefined)
    }
  })

  it('opens the pane of the selected owner, and never a popover', () => {
    select()
    useUiStore().openNavigableView('mission', { missionId: 'mnt-1' })
    expect(panes()).toEqual(['mission'])
    expect(useUiStore().popovers.missionProgress).toBe(false)
  })

  it('leaves an open pane open', () => {
    select()
    const ui = useUiStore()
    ui.openNavigableView('mission', { missionId: 'mnt-1' })
    ui.openNavigableView('mission', { missionId: 'mnt-1' })
    expect(panes()).toEqual(['mission'])
  })

  it('opens nothing without a selected session', () => {
    useUiStore().openNavigableView('mission', { missionId: 'mnt-1' })
    expect(panes()).toEqual([])
  })
})
