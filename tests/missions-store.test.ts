// @vitest-environment jsdom
/**
 * Mission v3 S3 (spec §3.2, §3.5, §3.12) — the missions store.
 *
 * Doors answer with the view they changed: the store patches that one mission,
 * or removes it when an end returns `view: null` — at once, before any list
 * refresh. A door answer for a mission the store no longer holds is ignored, a
 * poll that started before a door landed is discarded (it can never resurrect
 * an ended mission), and a refused door or an IPC failure is a danger toast.
 *
 * The store also plays the owed-to-operator cue off its own poll (§3.12): chime
 * + OS attention + one Activity entry when a mission's owed list gains a kind
 * or a count grows, silence on a decrease, a re-nudge after 30 min, one combined
 * cue for a start with several missions owed, and never for a dead legacy draft.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { MissionDoor, MissionDoorResult, MissionView } from '../src/main/mission-ipc'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useNotificationsStore } from '../src/renderer/src/stores/notifications'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { playNotificationSound } from '../src/renderer/src/lib/notification-sound'
import { i18n } from '../src/renderer/src/i18n'
import { fixtureView } from './helpers/mission-v3-view'

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

type ListResult = { views: MissionView[]; unreadable: string[] }

function setApi(api: Record<string, unknown>): void {
  ;(window as unknown as { api: unknown }).api = { requestAttention: vi.fn(), ...api }
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
  vi.mocked(playNotificationSound).mockClear()
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runDoor — the door answer patches the store at once', () => {
  let listCalls: Array<ReturnType<typeof deferred<ListResult>>>
  let door: ReturnType<typeof vi.fn>
  const mission = (): MissionView => fixtureView('faq-like')

  /** A store already holding `views`, with every later list read left pending. */
  async function storeWith(views: MissionView[]): Promise<ReturnType<typeof useMissionsStore>> {
    let first = true
    setApi({
      missionList: vi.fn(() => {
        if (first) {
          first = false
          return Promise.resolve({ views, unreadable: [] })
        }
        const d = deferred<ListResult>()
        listCalls.push(d)
        return d.promise
      }),
      missionOperatorDoor: door
    })
    const store = useMissionsStore()
    await store.refresh()
    return store
  }

  beforeEach(() => {
    listCalls = []
    door = vi.fn()
  })

  it('an end removes the mission from the store before any list refresh lands', async () => {
    const v = mission()
    door.mockResolvedValue({ ok: true, view: null })
    const store = await storeWith([v])
    const res = await store.runDoor({
      door: 'end',
      root: '/repo',
      missionId: v.mission.id,
      closedAs: 'delivered'
    })
    expect(res).toEqual({ ok: true, view: null })
    expect(store.views).toEqual([])
    expect(store.viewForSession(v.mission.owner.sessionId)).toBeNull()
    // The background refresh was asked for, but nothing waited on it.
    expect(listCalls.length).toBeLessThanOrEqual(1)
    expect(store.doorInFlight).toBe(false)
  })

  it('a stale poll that started before the end cannot resurrect the mission', async () => {
    const v = mission()
    door.mockResolvedValue({ ok: true, view: null })
    const store = await storeWith([v])
    void store.refresh() // a poll in flight BEFORE the door
    expect(listCalls).toHaveLength(1)
    await store.runDoor({
      door: 'end',
      root: '/repo',
      missionId: v.mission.id,
      closedAs: 'discarded'
    })
    expect(store.views).toEqual([])
    listCalls[0].resolve({ views: [v], unreadable: [] }) // the pre-door list lands
    await vi.waitFor(() => expect(listCalls).toHaveLength(2)) // the post-door read follows
    expect(store.views).toEqual([])
    listCalls[1].resolve({ views: [], unreadable: [] })
    await vi.waitFor(() => expect(store.views).toEqual([]))
  })

  it('a tick patches that mission in place from the door’s view', async () => {
    const v = mission()
    const patched = fixtureView('faq-like', { view: { title: 'after the tick' } })
    door.mockResolvedValue({ ok: true, view: patched })
    const store = await storeWith([v, fixtureView('parallel')])
    await store.runDoor({
      door: 'tickCheck',
      root: '/repo',
      missionId: v.mission.id,
      stepId: 'stp-4',
      checkId: 'chk-1',
      ticked: true
    })
    expect(store.views.map((x) => x.title)).toEqual(['after the tick', 'Mission parallel'])
  })

  it('ignores a door answer for a mission the store no longer holds', async () => {
    const v = mission()
    const other = fixtureView('parallel')
    const d = deferred<MissionDoorResult>()
    door.mockReturnValue(d.promise)
    const store = await storeWith([v, other])
    const run = store.runDoor({
      door: 'tickCheck',
      root: '/repo',
      missionId: v.mission.id,
      stepId: 'stp-4',
      checkId: 'chk-1',
      ticked: true
    })
    // A concurrent end removed it while the slow re-derive was running.
    const end = vi.fn().mockResolvedValue({ ok: true, view: null })
    door.mockImplementationOnce(end)
    await store.runDoor({
      door: 'end',
      root: '/repo',
      missionId: v.mission.id,
      closedAs: 'delivered'
    })
    expect(store.views.map((x) => x.mission.id)).toEqual([other.mission.id])
    d.resolve({ ok: true, view: v })
    await run
    expect(store.views.map((x) => x.mission.id)).toEqual([other.mission.id])
  })

  it('a non-end door answering view: null keeps the mission (its re-derive failed)', async () => {
    const v = mission()
    door.mockResolvedValue({ ok: true, view: null })
    const store = await storeWith([v])
    await store.runDoor({
      door: 'addCheck',
      root: '/repo',
      missionId: v.mission.id,
      stepId: 'stp-4',
      label: 'DSQA'
    })
    expect(store.views).toHaveLength(1)
  })

  it.each([
    ['an IPC rejection', () => Promise.reject(new Error('IPC channel closed'))],
    [
      'a refusal',
      () => Promise.resolve({ ok: false, error: 'MISSION_UNREADABLE: mnt-x.md — bad yaml' })
    ]
  ])('%s raises a danger toast and resolves { ok: false } — never a throw', async (_l, impl) => {
    const v = mission()
    door.mockImplementation(impl)
    const store = await storeWith([v])
    const res = await store.runDoor({
      door: 'end',
      root: '/repo',
      missionId: v.mission.id,
      closedAs: 'delivered'
    } as MissionDoor)
    expect(res.ok).toBe(false)
    expect(store.doorInFlight).toBe(false)
    expect(store.views).toHaveLength(1)
    const toast = useUiStore().toasts.at(-1)
    expect(toast).toMatchObject({ kind: 'danger', title: 'Mission action refused' })
    expect(toast?.description).toMatch(/IPC channel closed|MISSION_UNREADABLE/)
  })

  it('a double Close: the second door is refused, nothing crashes or comes back', async () => {
    const v = mission()
    door
      .mockResolvedValueOnce({ ok: true, view: null })
      .mockResolvedValueOnce({ ok: false, error: 'MISSION_CLOSED: closed by the operator' })
    const store = await storeWith([v])
    const args = {
      door: 'end',
      root: '/repo',
      missionId: v.mission.id,
      closedAs: 'delivered'
    } as const
    const [a, b] = await Promise.all([store.runDoor(args), store.runDoor(args)])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(false)
    expect(store.views).toEqual([])
    // The mission is closed, which is what the operator asked for: no red toast.
    expect(useUiStore().toasts).toEqual([])
  })

  it('an end refused MISSION_CLOSED for a mission still held drops it, silently', async () => {
    const v = mission()
    const other = fixtureView('parallel')
    door.mockResolvedValue({ ok: false, error: 'MISSION_CLOSED: closed by the operator' })
    const store = await storeWith([v, other])
    const res = await store.runDoor({
      door: 'end',
      root: '/repo',
      missionId: v.mission.id,
      closedAs: 'discarded'
    })
    expect(res.ok).toBe(false)
    expect(store.views.map((x) => x.mission.id)).toEqual([other.mission.id])
    expect(useUiStore().toasts).toEqual([])
  })

  it('a non-end door refused MISSION_CLOSED still toasts (the tick did not land)', async () => {
    const v = mission()
    door.mockResolvedValue({ ok: false, error: 'MISSION_CLOSED: closed by the operator' })
    const store = await storeWith([v])
    await store.runDoor({
      door: 'tickCheck',
      root: '/repo',
      missionId: v.mission.id,
      stepId: 'stp-4',
      checkId: 'chk-1',
      ticked: true
    })
    expect(useUiStore().toasts.at(-1)).toMatchObject({ kind: 'danger' })
  })

  it('doorInFlight stays true until the LAST of two overlapping doors returns', async () => {
    const v = mission()
    const first = deferred<MissionDoorResult>()
    const second = deferred<MissionDoorResult>()
    door.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const store = await storeWith([v])
    const tick = (checkId: string): Promise<MissionDoorResult> =>
      store.runDoor({
        door: 'tickCheck',
        root: '/repo',
        missionId: v.mission.id,
        stepId: 'stp-4',
        checkId,
        ticked: true
      })
    const a = tick('chk-1')
    const b = tick('chk-2')
    expect(store.doorInFlight).toBe(true)
    first.resolve({ ok: true, view: v })
    await a
    expect(store.doorInFlight).toBe(true)
    second.resolve({ ok: true, view: v })
    await b
    expect(store.doorInFlight).toBe(false)
  })

  it('a discard sends its reason to the door', async () => {
    const v = mission()
    door.mockResolvedValue({ ok: true, view: null })
    const store = await storeWith([v])
    await store.runDoor({
      door: 'end',
      root: '/repo',
      missionId: v.mission.id,
      closedAs: 'discarded',
      reason: 'superseded by T400'
    })
    expect(door).toHaveBeenCalledWith(
      expect.objectContaining({ closedAs: 'discarded', reason: 'superseded by T400' })
    )
  })
})

describe('useMissionsStore — owed-to-operator cue', () => {
  const OWNER = '11111111-2222-4333-8444-555555555555'
  let list: ReturnType<typeof vi.fn>
  let requestAttention: ReturnType<typeof vi.fn>
  let current: MissionView[]

  function owed(
    id: string,
    title: string,
    over: { status?: string; you?: MissionView['you']; stale?: boolean } = {}
  ): MissionView {
    return {
      root: '/repo',
      mission: {
        id,
        status: over.status ?? 'active',
        owner: { sessionId: OWNER, folder: '/repo' },
        steps: [{ id: 'stp-2', title: 'Build the API' }]
      },
      title,
      derived: { stale: over.stale ?? false },
      you: over.you ?? [],
      closeWarnings: []
    } as unknown as MissionView
  }
  const blocked = (id: string, title: string, reason: string): MissionView =>
    owed(id, title, { you: [{ kind: 'blocker', reason, unblocks: 'merged' }] })
  const due = (id: string, title: string, count: number): MissionView =>
    owed(id, title, { you: [{ kind: 'checks', count, stepIds: ['stp-2'] }] })

  beforeEach(() => {
    current = []
    list = vi.fn(async () => ({ views: current, unreadable: [] }))
    requestAttention = vi.fn(async () => undefined)
    setApi({ missionList: list, missionOperatorDoor: vi.fn(), requestAttention })
    localStorage.clear()
  })

  it('cues due checks once — chime, attention, one Activity entry — and not on the next poll', async () => {
    const store = useMissionsStore()
    const activity = useNotificationsStore()
    current = [due('mnt-00000001', 'Ship T373', 2)]
    await store.refresh()
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
    expect(requestAttention).toHaveBeenCalledTimes(1)
    expect(activity.list).toHaveLength(1)
    expect(activity.list[0]).toMatchObject({
      kind: 'warning',
      title: 'Mission “Ship T373” needs you: Tick 2 due checks on Build the API.',
      sessionId: OWNER
    })
    await store.refresh()
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
    expect(activity.list).toHaveLength(1)
  })

  it('cues when due checks grow, and stays silent when one is ticked', async () => {
    const store = useMissionsStore()
    current = [due('mnt-00000001', 'Ship T373', 1)]
    await store.refresh()
    current = [due('mnt-00000001', 'Ship T373', 2)]
    await store.refresh()
    expect(playNotificationSound).toHaveBeenCalledTimes(2)
    current = [due('mnt-00000001', 'Ship T373', 1)] // a tick
    await store.refresh()
    expect(playNotificationSound).toHaveBeenCalledTimes(2)
  })

  it('a dead legacy draft never cues', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_790_000_000_000)
    const store = useMissionsStore()
    current = [owed('mnt-00000001', 'Old draft', { status: 'draft', stale: true })]
    store.ensureStarted()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(playNotificationSound).not.toHaveBeenCalled()
    expect(requestAttention).not.toHaveBeenCalled()
    expect(useNotificationsStore().list).toHaveLength(0)
  })

  it('words an operator blocker by its reason and cues a new reason again', async () => {
    const store = useMissionsStore()
    const activity = useNotificationsStore()
    current = [blocked('mnt-00000001', 'Ship T373', 'merge PR #6')]
    await store.refresh()
    expect(activity.list[0].title).toBe('Mission “Ship T373” needs you: merge PR #6')
    current = [blocked('mnt-00000001', 'Ship T373', 'merge PR #7')]
    await store.refresh()
    expect(playNotificationSound).toHaveBeenCalledTimes(2)
    expect(activity.list[0].title).toBe('Mission “Ship T373” needs you: merge PR #7')
  })

  it('gives ONE combined cue when a start finds several missions already owed', async () => {
    const store = useMissionsStore()
    const activity = useNotificationsStore()
    current = [
      blocked('mnt-00000001', 'Ship T373', 'merge PR #6'),
      owed('mnt-00000002', 'Docs pass', { status: 'delivered', you: [{ kind: 'close' }] })
    ]
    await store.refresh()
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
    expect(requestAttention).toHaveBeenCalledTimes(1)
    expect(activity.list).toHaveLength(1)
    expect(activity.list[0].title).toBe('2 missions need you')
    expect(activity.list[0].description).toBe('Ship T373 · Docs pass')
    expect(activity.list[0].sessionId).toBeUndefined()
  })

  it('does not cue approvals or needs-input — they already chime elsewhere', async () => {
    const store = useMissionsStore()
    current = [
      owed('mnt-00000001', 'A', { you: [{ kind: 'approvals', count: 2, sessionId: OWNER }] }),
      owed('mnt-00000002', 'B', { you: [{ kind: 'needs-input', sessionId: OWNER }] })
    ]
    await store.refresh()
    expect(playNotificationSound).not.toHaveBeenCalled()
    expect(requestAttention).not.toHaveBeenCalled()
    expect(useNotificationsStore().list).toHaveLength(0)
  })

  it('stays quiet on the 20 s polls, then re-nudges after 30 minutes while unchanged', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_790_000_000_000)
    const store = useMissionsStore()
    current = [blocked('mnt-00000001', 'Ship T373', 'merge PR #6')]
    store.ensureStarted()
    await vi.advanceTimersByTimeAsync(0)
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(29 * 60 * 1000) // 87 polls, all silent
    expect(list.mock.calls.length).toBeGreaterThan(80)
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000) // the poll past 30 min
    expect(playNotificationSound).toHaveBeenCalledTimes(2)
    expect(requestAttention).toHaveBeenCalledTimes(2)
    expect(useNotificationsStore().list).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(playNotificationSound).toHaveBeenCalledTimes(2)
  })

  it('a failed read neither cues nor forgets what was already heard', async () => {
    const store = useMissionsStore()
    current = [blocked('mnt-00000001', 'Ship T373', 'merge PR #6')]
    await store.refresh()
    list.mockRejectedValueOnce(new Error('EIO'))
    await store.refresh()
    await store.refresh()
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
  })
})

describe('popoverRequest — open-the-mission request (BUG-173 S2, spec §3.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'))
    setApi({ missionList: vi.fn(() => new Promise(() => {})) })
  })

  it('starts empty', () => {
    expect(useMissionsStore().popoverRequest).toBeNull()
  })

  it("openNavigableView('mission', { missionId }) records { missionId, at }", () => {
    const missions = useMissionsStore()
    useUiStore().openNavigableView('mission', { missionId: 'mis-1' })

    expect(missions.popoverRequest).toEqual({ missionId: 'mis-1', at: Date.now() })
  })

  it("openNavigableView('mission') without a missionId records nothing", () => {
    const missions = useMissionsStore()
    useUiStore().openNavigableView('mission')

    expect(missions.popoverRequest).toBeNull()
  })

  it('a newer request replaces the older one', () => {
    const missions = useMissionsStore()
    const ui = useUiStore()
    ui.openNavigableView('mission', { missionId: 'mis-1' })
    vi.advanceTimersByTime(1000)
    ui.openNavigableView('mission', { missionId: 'mis-2' })

    expect(missions.popoverRequest?.missionId).toBe('mis-2')
  })

  it('expires after 5 s', () => {
    const missions = useMissionsStore()
    useUiStore().openNavigableView('mission', { missionId: 'mis-1' })

    vi.advanceTimersByTime(4999)
    expect(missions.popoverRequest).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(missions.popoverRequest).toBeNull()
  })

  it('an expired older request timer does not clear a newer request', () => {
    const missions = useMissionsStore()
    const ui = useUiStore()
    ui.openNavigableView('mission', { missionId: 'mis-1' })
    vi.advanceTimersByTime(3000)
    ui.openNavigableView('mission', { missionId: 'mis-2' })
    vi.advanceTimersByTime(3000) // first request's 5 s have passed; the second's have not

    expect(missions.popoverRequest?.missionId).toBe('mis-2')
  })

  it('consumePopoverRequest returns the live request once and clears it', () => {
    const missions = useMissionsStore()
    useUiStore().openNavigableView('mission', { missionId: 'mis-1' })

    expect(missions.consumePopoverRequest()?.missionId).toBe('mis-1')
    expect(missions.popoverRequest).toBeNull()
    expect(missions.consumePopoverRequest()).toBeNull()
  })

  it('consumePopoverRequest never returns an expired request, even if the timer was throttled', () => {
    const missions = useMissionsStore()
    useUiStore().openNavigableView('mission', { missionId: 'mis-1' })
    // Move the clock without firing the timer (a throttled background tab).
    vi.setSystemTime(Date.now() + 6000)

    expect(missions.consumePopoverRequest()).toBeNull()
    expect(missions.popoverRequest).toBeNull()
  })
})
