// @vitest-environment jsdom
/**
 * BUG-173 S5 (spec §3.5, I-8) — `runDoors`, the missions store's batch of the
 * EXISTING end door: sequential, one call per mission, never aborting on the
 * first error, one in-flight raise for the batch, one refresh at the end.
 * `MISSION_CLOSED` counts as closed. No tool in the MCP catalog can set `closedAs`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { z } from 'zod'
import { setActivePinia, createPinia } from 'pinia'
import type { MissionDoor, MissionDoorResult, MissionView } from '../src/main/mission-ipc'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

type EndDoor = Extract<MissionDoor, { door: 'end' }>

const mv = (id: string): MissionView =>
  ({
    root: '/repo',
    mission: { id, status: 'delivered', updatedAt: '2026-10-09T10:00:00.000Z', steps: [] },
    title: `Mission ${id}`,
    derived: { stale: false },
    you: [{ kind: 'close' }],
    closeWarnings: []
  }) as unknown as MissionView

const end = (id: string, reason = 'bulk close'): EndDoor => ({
  door: 'end',
  root: '/repo',
  missionId: id,
  closedAs: 'delivered',
  reason
})

let answers: Record<string, MissionDoorResult | Error>
let doorFn: ReturnType<typeof vi.fn>
let listFn: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  useSessionsStore().folders = [{ path: '/repo', sessions: [] }] as never
  localStorage.clear()
  localStorage.setItem('om2tab.missionCues', JSON.stringify({ v: 1, owed: {} }))
  answers = {}
  doorFn = vi.fn(async (d: MissionDoor) => {
    const a = answers[d.missionId] ?? { ok: true, view: null }
    if (a instanceof Error) throw a
    return a
  })
  listFn = vi.fn(async () => ({ views: [], unreadable: [] }))
  ;(window as unknown as { api: unknown }).api = {
    missionList: listFn,
    missionOperatorDoor: doorFn,
    requestAttention: vi.fn(async () => undefined)
  }
})

describe('runDoors', () => {
  it('calls the end door once per mission, in order, with the door unchanged', async () => {
    const store = useMissionsStore()
    store.views = [mv('a'), mv('b'), mv('c')]
    const doors = [end('a'), end('b'), end('c')]
    const res = await store.runDoors(doors)
    expect(doorFn.mock.calls.map((c) => c[0])).toEqual(doors)
    expect(res).toEqual({ closed: 3, failed: [] })
  })

  it('runs one door at a time: the next call waits for the previous answer', async () => {
    const store = useMissionsStore()
    store.views = [mv('a'), mv('b')]
    let release: (r: MissionDoorResult) => void = () => undefined
    doorFn.mockImplementationOnce(
      () => new Promise<MissionDoorResult>((resolve) => (release = resolve))
    )
    const pending = store.runDoors([end('a'), end('b')])
    await Promise.resolve()
    expect(doorFn).toHaveBeenCalledTimes(1)
    release({ ok: true, view: null })
    await pending
    expect(doorFn).toHaveBeenCalledTimes(2)
  })

  it('removes each mission as its answer lands, before the batch ends', async () => {
    const store = useMissionsStore()
    store.views = [mv('a'), mv('b')]
    let release: (r: MissionDoorResult) => void = () => undefined
    doorFn.mockImplementationOnce(async () => ({ ok: true, view: null }))
    doorFn.mockImplementationOnce(
      () => new Promise<MissionDoorResult>((resolve) => (release = resolve))
    )
    const pending = store.runDoors([end('a'), end('b')])
    await new Promise((r) => setTimeout(r, 0))
    expect(store.views.map((v) => v.mission.id)).toEqual(['b'])
    release({ ok: true, view: null })
    await pending
    expect(store.views).toEqual([])
  })

  it('raises the in-flight counter once for the whole batch', async () => {
    const store = useMissionsStore()
    store.views = [mv('a'), mv('b')]
    const seen: boolean[] = []
    doorFn.mockImplementation(async () => {
      seen.push(store.doorInFlight)
      return { ok: true, view: null }
    })
    expect(store.doorInFlight).toBe(false)
    await store.runDoors([end('a'), end('b')])
    expect(seen).toEqual([true, true])
    expect(store.doorInFlight).toBe(false)
  })

  it('schedules ONE refresh at the end, not one per door', async () => {
    const store = useMissionsStore()
    store.views = [mv('a'), mv('b'), mv('c')]
    await store.runDoors([end('a'), end('b'), end('c')])
    await vi.waitFor(() => expect(listFn).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(listFn).toHaveBeenCalledTimes(1)
  })

  it('does not abort on a failure: reports it per mission and keeps going', async () => {
    const store = useMissionsStore()
    store.views = [mv('a'), mv('b'), mv('c')]
    answers.b = { ok: false, error: 'DOOR_REFUSED: nope' }
    const res = await store.runDoors([end('a'), end('b'), end('c')])
    expect(doorFn).toHaveBeenCalledTimes(3)
    expect(res).toEqual({ closed: 2, failed: [{ missionId: 'b', error: 'DOOR_REFUSED: nope' }] })
    expect(store.views.map((v) => v.mission.id)).toEqual(['b'])
  })

  it('treats a thrown IPC failure as a failed row', async () => {
    const store = useMissionsStore()
    store.views = [mv('a')]
    answers.a = new Error('ipc gone')
    const res = await store.runDoors([end('a')])
    expect(res).toEqual({ closed: 0, failed: [{ missionId: 'a', error: 'ipc gone' }] })
  })

  it('counts MISSION_CLOSED as closed and drops the mission silently', async () => {
    const store = useMissionsStore()
    store.views = [mv('a')]
    answers.a = { ok: false, error: 'MISSION_CLOSED: already closed' }
    const res = await store.runDoors([end('a')])
    expect(res).toEqual({ closed: 1, failed: [] })
    expect(store.views).toEqual([])
    expect(useUiStore().toasts).toEqual([])
  })

  it('does not toast per door: the dialog reports the batch once', async () => {
    const store = useMissionsStore()
    store.views = [mv('a'), mv('b')]
    answers.b = { ok: false, error: 'DOOR_REFUSED: nope' }
    await store.runDoors([end('a'), end('b')])
    expect(useUiStore().toasts).toEqual([])
  })

  it('reports progress after every door', async () => {
    const store = useMissionsStore()
    store.views = [mv('a'), mv('b')]
    const onProgress = vi.fn()
    await store.runDoors([end('a'), end('b')], onProgress)
    expect(onProgress.mock.calls).toEqual([
      [1, 2],
      [2, 2]
    ])
  })

  it('schedules no refresh when nothing changed', async () => {
    const store = useMissionsStore()
    store.views = [mv('a')]
    answers.a = { ok: false, error: 'DOOR_REFUSED: nope' }
    await store.runDoors([end('a')])
    await new Promise((r) => setTimeout(r, 10))
    expect(listFn).not.toHaveBeenCalled()
  })
})

describe('operator-only invariant', () => {
  it('no tool in the MCP catalog can set closedAs', () => {
    for (const def of MCP_TOOLS) {
      const json = JSON.stringify(z.toJSONSchema(def.inputSchema, { unrepresentable: 'any' }))
      expect(json, def.name).not.toMatch(/closedAs/)
    }
  })
})
