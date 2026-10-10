// @vitest-environment jsdom
/**
 * BUG-173 S4 (spec §3.3, §3.4) — the missions store's posting side of the one
 * grouped Activity entry.
 *
 * The cue posts ONE `group: 'mission-cue'` record whose `items` are every
 * mission owed right now (not only the ones this poll cued), ordered cued first,
 * then blocking kinds, then newest. `ts` moves only when a poll cued; a quiet
 * sync after every poll rewrites title + items without touching `ts`, removes
 * the entry at zero and never resurrects a dismissed one. `openReview` leaves a
 * request for the review dialog (S5).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import type { MissionView } from '../src/main/mission-ipc'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useNotificationsStore } from '../src/renderer/src/stores/notifications'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { playNotificationSound } from '../src/renderer/src/lib/notification-sound'
import { i18n } from '../src/renderer/src/i18n'

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

const GROUP = 'mission-cue'
const CUES_KEY = 'om2tab.missionCues'

let current: MissionView[]
let list: ReturnType<typeof vi.fn>

function view(
  id: string,
  title: string,
  you: MissionView['you'],
  over: { owner?: string; updatedAt?: string; status?: string } = {}
): MissionView {
  return {
    root: '/repo',
    mission: {
      id,
      status: over.status ?? 'active',
      updatedAt: over.updatedAt ?? '2026-10-09T10:00:00.000Z',
      owner: { sessionId: over.owner ?? `owner-${id}`, folder: '/repo' },
      steps: [{ id: 'stp-2', title: 'Build the API' }]
    },
    title,
    derived: { stale: false },
    you,
    closeWarnings: []
  } as unknown as MissionView
}
const blocker = (id: string, title: string, reason = 'merge PR', updatedAt?: string): MissionView =>
  view(id, title, [{ kind: 'blocker', reason, unblocks: 'merged' }], { updatedAt })
const closing = (id: string, title: string, updatedAt?: string): MissionView =>
  view(id, title, [{ kind: 'close' }], { status: 'delivered', updatedAt })
const checks = (id: string, title: string, count: number): MissionView =>
  view(id, title, [{ kind: 'checks', count, stepIds: ['stp-2'] }])

function mountStore(): ReturnType<typeof useMissionsStore> {
  setActivePinia(createPinia())
  useSessionsStore().folders = [{ path: '/repo', sessions: [] }] as never
  return useMissionsStore()
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
  vi.mocked(playNotificationSound).mockClear()
  current = []
  list = vi.fn(async () => ({ views: current, unreadable: [] }))
  ;(window as unknown as { api: unknown }).api = {
    missionList: list,
    missionOperatorDoor: vi.fn(),
    requestAttention: vi.fn(async () => undefined)
  }
  localStorage.clear()
  // A previous run left an empty memory: not a first run, so cues play.
  localStorage.setItem(CUES_KEY, JSON.stringify({ v: 1, owed: {} }))
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-09T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

const entry = (): ReturnType<typeof useNotificationsStore>['records'][number] | undefined =>
  useNotificationsStore().records.find((r) => r.group === GROUP)

describe('postMissionActivity — one grouped entry with a row per owed mission', () => {
  it('posts ONE group record whose items are every owed mission, with owner and target', async () => {
    const store = mountStore()
    current = [blocker('mnt-1', 'Ship it', 'merge PR #6'), closing('mnt-2', 'Docs pass')]
    await store.refresh()
    const records = useNotificationsStore().records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      group: GROUP,
      source: 'app',
      kind: 'warning',
      title: '2 missions need you'
    })
    expect(records[0].items).toEqual([
      {
        id: 'mnt-1',
        title: 'Ship it',
        description: 'merge PR #6',
        sessionId: 'owner-mnt-1',
        target: { view: 'mission', missionId: 'mnt-1' }
      },
      {
        id: 'mnt-2',
        title: 'Docs pass',
        description: 'delivered, awaiting your close',
        sessionId: 'owner-mnt-2',
        target: { view: 'mission', missionId: 'mnt-2' }
      }
    ])
  })

  it('names the mission itself in the title when exactly one is owed', async () => {
    const store = mountStore()
    current = [blocker('mnt-1', 'Ship it', 'merge PR #6')]
    await store.refresh()
    expect(entry()?.title).toBe('Mission “Ship it” needs you: merge PR #6')
    expect(entry()?.items).toHaveLength(1)
  })

  it('lists everything owed, not only what this poll cued, deduped by mission id', async () => {
    const store = mountStore()
    current = [closing('mnt-1', 'Old backlog')]
    await store.refresh() // cues mnt-1
    current = [
      closing('mnt-1', 'Old backlog'),
      blocker('mnt-2', 'Fresh'),
      blocker('mnt-2', 'Fresh')
    ]
    await store.refresh() // cues mnt-2 only
    expect(entry()?.title).toBe('2 missions need you')
    expect(entry()?.items?.map((i) => i.id)).toEqual(['mnt-2', 'mnt-1'])
  })

  it('orders cued-this-poll first, then blocking kinds, then newest updatedAt', async () => {
    const store = mountStore()
    current = [
      closing('mnt-old', 'Old close', '2026-10-01T00:00:00.000Z'),
      closing('mnt-new', 'New close', '2026-10-08T00:00:00.000Z'),
      blocker('mnt-block', 'Blocked', 'merge', '2026-10-02T00:00:00.000Z')
    ]
    await store.refresh() // all three cue in this poll: blocking, then newest
    expect(entry()?.items?.map((i) => i.id)).toEqual(['mnt-block', 'mnt-new', 'mnt-old'])
    current = [...current, checks('mnt-fresh', 'Fresh checks', 1)]
    await store.refresh() // only mnt-fresh cues: it leads, the rest keep their order
    expect(entry()?.items?.map((i) => i.id)).toEqual([
      'mnt-fresh',
      'mnt-block',
      'mnt-new',
      'mnt-old'
    ])
  })

  it('a later cue replaces the entry in place: same id, still one record, ts moved', async () => {
    const store = mountStore()
    current = [closing('mnt-1', 'A')]
    await store.refresh()
    const first = { ...entry()! }
    vi.setSystemTime(new Date('2026-10-09T12:05:00Z'))
    current = [closing('mnt-1', 'A'), closing('mnt-2', 'B')]
    await store.refresh()
    const records = useNotificationsStore().records
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(first.id)
    expect(records[0].ts).toBeGreaterThan(first.ts)
    expect(records[0].title).toBe('2 missions need you')
  })

  it('never posts the legacy joined-titles description or a record-level session', async () => {
    const store = mountStore()
    current = [closing('mnt-1', 'A'), closing('mnt-2', 'B')]
    await store.refresh()
    expect(entry()?.description).toBeUndefined()
    expect(entry()?.sessionId).toBeUndefined()
  })
})

describe('syncMissionActivity — quiet rewrite after every poll', () => {
  it('shrinks the entry without touching ts, id, sound or attention', async () => {
    const store = mountStore()
    current = [closing('mnt-1', 'A'), closing('mnt-2', 'B'), closing('mnt-3', 'C')]
    await store.refresh()
    const before = { ...entry()! }
    vi.mocked(playNotificationSound).mockClear()
    vi.setSystemTime(new Date('2026-10-09T13:00:00Z'))
    current = [closing('mnt-3', 'C')] // two were closed
    await store.refresh()
    expect(entry()).toMatchObject({ id: before.id, ts: before.ts })
    expect(entry()?.title).toBe('Mission “C” needs you: delivered, awaiting your close')
    expect(entry()?.items?.map((i) => i.id)).toEqual(['mnt-3'])
    expect(playNotificationSound).not.toHaveBeenCalled()
  })

  it('removes the entry when nothing is owed any more', async () => {
    const store = mountStore()
    current = [closing('mnt-1', 'A')]
    await store.refresh()
    expect(entry()).toBeDefined()
    current = []
    await store.refresh()
    expect(useNotificationsStore().records).toHaveLength(0)
  })

  it('never resurrects an entry the operator dismissed', async () => {
    const store = mountStore()
    current = [closing('mnt-1', 'A'), closing('mnt-2', 'B')]
    await store.refresh()
    useNotificationsStore().dismiss(entry()!.id)
    await store.refresh() // same backlog, nothing cued
    current = [closing('mnt-1', 'A')]
    await store.refresh() // shrank, still nothing cued
    expect(entry()).toBeUndefined()
  })

  it('a new cue after a dismissal posts a fresh entry (news is news)', async () => {
    const store = mountStore()
    current = [closing('mnt-1', 'A')]
    await store.refresh()
    useNotificationsStore().dismiss(entry()!.id)
    current = [closing('mnt-1', 'A'), closing('mnt-2', 'B')]
    await store.refresh()
    expect(entry()?.items?.map((i) => i.id)).toEqual(['mnt-2', 'mnt-1'])
  })

  it('the silent first-run seed poll still syncs a surviving entry', async () => {
    localStorage.removeItem(CUES_KEY) // no memory: this poll seeds
    const store = mountStore()
    useNotificationsStore().notify({
      ts: Date.now(),
      source: 'app',
      kind: 'warning',
      title: '9 missions need you',
      group: GROUP,
      items: []
    })
    const id = entry()!.id
    current = [closing('mnt-1', 'A')]
    await store.refresh()
    expect(playNotificationSound).not.toHaveBeenCalled()
    expect(entry()?.id).toBe(id)
    expect(entry()?.items?.map((i) => i.id)).toEqual(['mnt-1'])
  })

  it('a poll with no folders loaded never syncs', async () => {
    setActivePinia(createPinia())
    const store = useMissionsStore() // folders still empty
    useNotificationsStore().notify({
      ts: Date.now(),
      source: 'app',
      kind: 'warning',
      title: 'keep me',
      group: GROUP,
      items: []
    })
    current = []
    await store.refresh()
    expect(entry()?.title).toBe('keep me')
  })

  it('a failed read leaves the entry alone', async () => {
    const store = mountStore()
    current = [closing('mnt-1', 'A')]
    await store.refresh()
    list.mockRejectedValueOnce(new Error('EIO'))
    await store.refresh()
    expect(entry()?.items).toHaveLength(1)
  })
})

describe('openReview — the request S5’s review dialog will consume', () => {
  it('records the focused mission and a timestamp', () => {
    const store = mountStore()
    expect(store.reviewRequest).toBeNull()
    store.openReview('mnt-9')
    expect(store.reviewRequest).toEqual({ missionId: 'mnt-9', at: Date.now() })
  })

  it('with no argument asks for the whole review', () => {
    const store = mountStore()
    store.openReview()
    expect(store.reviewRequest).toEqual({ missionId: null, at: Date.now() })
  })

  it('consumeReviewRequest hands it over once', async () => {
    const store = mountStore()
    store.openReview('mnt-9')
    await nextTick()
    expect(store.consumeReviewRequest()?.missionId).toBe('mnt-9')
    expect(store.reviewRequest).toBeNull()
    expect(store.consumeReviewRequest()).toBeNull()
  })
})
