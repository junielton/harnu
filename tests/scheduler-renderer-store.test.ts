// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSchedulerStore } from '../src/renderer/src/stores/scheduler'
import type { Worker } from '../src/main/scheduler-core'

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: 'w1',
    name: 'Worker One',
    enabled: true,
    prompt: 'do the thing',
    folder: '/repo',
    everyMinutes: 5,
    runOnBoot: false,
    model: 'sonnet',
    effort: 'low',
    mode: 'observe',
    timeoutSeconds: 60,
    carryLastResult: false,
    failureStreak: 0,
    ...overrides
  }
}

let schedulerSave: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  schedulerSave = vi.fn().mockResolvedValue([])
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: {
      schedulerSave
    }
  }
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('scheduler renderer store', () => {
  it('coalesces rapid edits to a single worker into one IPC call after 300ms', async () => {
    const store = useSchedulerStore()
    store.workers = [makeWorker()]

    store.save('w1', { name: 'a' })
    await vi.advanceTimersByTimeAsync(100)
    store.save('w1', { name: 'ab' })
    await vi.advanceTimersByTimeAsync(100)
    store.save('w1', { name: 'abc' })
    await vi.advanceTimersByTimeAsync(300)

    expect(schedulerSave).toHaveBeenCalledTimes(1)
    expect(schedulerSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1', name: 'abc' }))
  })

  it('re-syncs workers from the IPC response, not from the optimistic local patch', async () => {
    const store = useSchedulerStore()
    store.workers = [makeWorker({ everyMinutes: 5 })]

    // Main clamps everyMinutes to 15 — a value the renderer's optimistic
    // patch (which only touched `name`) has no way to know in advance.
    const serverEcho = [makeWorker({ name: 'Renamed', everyMinutes: 15 })]
    schedulerSave.mockResolvedValue(serverEcho)

    store.save('w1', { name: 'Renamed' })
    // Immediately after save(), the optimistic echo is in place: the
    // untouched field still holds the pre-save value.
    expect(store.workers[0].everyMinutes).toBe(5)

    await vi.advanceTimersByTimeAsync(300)

    // Once the response lands, the store must hold what main returned —
    // not the renderer's guess.
    expect(store.workers).toEqual(serverEcho)
    expect(store.workers[0].everyMinutes).toBe(15)
  })

  it('keys debounce timers per worker id: editing two workers produces two calls', async () => {
    const store = useSchedulerStore()
    store.workers = [makeWorker({ id: 'w1' }), makeWorker({ id: 'w2', name: 'Worker Two' })]

    store.save('w1', { name: 'edited-1' })
    await vi.advanceTimersByTimeAsync(50)
    store.save('w2', { name: 'edited-2' })
    await vi.advanceTimersByTimeAsync(300)

    expect(schedulerSave).toHaveBeenCalledTimes(2)
    expect(schedulerSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w1', name: 'edited-1' })
    )
    expect(schedulerSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w2', name: 'edited-2' })
    )
  })
})

describe('scheduler renderer store — run history for every worker (T590 AC-5)', () => {
  let changed: ((s: { workers: Worker[]; runningIds: string[] }) => void) | null
  let schedulerRuns: ReturnType<typeof vi.fn>

  beforeEach(() => {
    changed = null
    schedulerRuns = vi.fn(async (id: string) => [{ workerId: id, status: 'ok', startedAt: 1 }])
    ;(globalThis as unknown as { window: { api: unknown } }).window = {
      api: {
        schedulerList: vi.fn(async () => [makeWorker({ id: 'a' }), makeWorker({ id: 'b' })]),
        schedulerRuns,
        onSchedulerChanged: vi.fn((cb: typeof changed) => {
          changed = cb
          return () => {}
        })
      }
    }
  })

  it('init() loads the last runs of EVERY worker, not only a selected one', async () => {
    const store = useSchedulerStore()
    await store.init()
    expect(schedulerRuns).toHaveBeenCalledTimes(2)
    expect(Object.keys(store.runsByWorker).sort()).toEqual(['a', 'b'])
  })

  it('loads a worker that appears after init, and refreshes one whose tick just finished', async () => {
    const store = useSchedulerStore()
    await store.init()
    schedulerRuns.mockClear()

    changed?.({
      workers: [makeWorker({ id: 'a' }), makeWorker({ id: 'b' }), makeWorker({ id: 'c' })],
      runningIds: ['a']
    })
    await Promise.resolve()
    expect(schedulerRuns.mock.calls.map((c) => c[0])).toEqual(['c'])

    schedulerRuns.mockClear()
    changed?.({
      workers: [makeWorker({ id: 'a' }), makeWorker({ id: 'b' }), makeWorker({ id: 'c' })],
      runningIds: []
    })
    await Promise.resolve()
    expect(schedulerRuns.mock.calls.map((c) => c[0])).toEqual(['a'])
  })

  it('loadAllRuns() refreshes every worker', async () => {
    const store = useSchedulerStore()
    await store.init()
    schedulerRuns.mockClear()
    await store.loadAllRuns()
    expect(schedulerRuns).toHaveBeenCalledTimes(2)
  })
})
