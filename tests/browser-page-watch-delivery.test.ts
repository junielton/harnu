/**
 * T569 (browser pane U2, AC-5, AC-9) — reload on change (the dependency cap, the planner, the debounce) and the
 * delivery of a page event to a session (owner, selected, parked-then-woken, held).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_WATCH_DEPENDENCIES,
  RELOAD_DEBOUNCE_MS,
  createDebouncer,
  createDependencySet,
  planWatchEvent
} from '../src/main/browser/page-watch'
import {
  WAKE_READY_TIMEOUT_MS,
  createHeldEvents,
  deliverUserTurn,
  type DeliveryDeps
} from '../src/main/browser/page-delivery'

describe('dependency set', () => {
  it('caps at 500 and says so', () => {
    const set = createDependencySet()
    for (let i = 0; i < MAX_WATCH_DEPENDENCIES; i++) expect(set.add(`/f/${i}`)).toBe(true)
    expect(set.add('/f/over')).toBe(false)
    expect(set.size).toBe(500)
    expect(set.add('/f/3')).toBe(true) // already held
    set.clear()
    expect(set.size).toBe(0)
  })
})

describe('watch planner', () => {
  const ctx = (mainRemoved = false) => {
    const deps = createDependencySet()
    deps.add('/p/app.js')
    return { mainFile: '/p/index.html', deps, mainRemoved }
  }
  it('reloads on a change to the page or a served dependency', () => {
    expect(planWatchEvent('change', '/p/index.html', ctx())).toBe('reload')
    expect(planWatchEvent('change', '/p/app.js', ctx())).toBe('reload')
    expect(planWatchEvent('unlink', '/p/app.js', ctx())).toBe('reload')
  })
  it('ignores files the pane never loaded', () => {
    expect(planWatchEvent('change', '/p/other.txt', ctx())).toBe('ignore')
  })
  it('shows the placeholder when the page file is deleted and restores on re-creation', () => {
    expect(planWatchEvent('unlink', '/p/index.html', ctx())).toBe('removed')
    expect(planWatchEvent('add', '/p/index.html', ctx(true))).toBe('restored')
    expect(planWatchEvent('change', '/p/index.html', ctx(true))).toBe('restored')
  })
})

describe('150 ms debounce', () => {
  it('collapses a burst into one call', () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn()
      const d = createDebouncer(fn, {
        setTimer: (f, ms) => setTimeout(f, ms),
        clearTimer: (h) => clearTimeout(h as never)
      })
      expect(RELOAD_DEBOUNCE_MS).toBe(150)
      d.trigger()
      vi.advanceTimersByTime(100)
      d.trigger()
      vi.advanceTimersByTime(100)
      expect(fn).not.toHaveBeenCalled()
      vi.advanceTimersByTime(60)
      expect(fn).toHaveBeenCalledTimes(1)
      d.trigger()
      d.cancel()
      vi.advanceTimersByTime(500)
      expect(fn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

const turn = { sessionId: 'owner-1', folder: '/w', text: 'hi', source: 'page-event' as const }
function deps(
  answers: unknown[],
  ready = true
): DeliveryDeps & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  let i = 0
  return {
    calls,
    dispatch: async (command, payload) => {
      calls.push([command, payload])
      if (command === 'session.wake') return { queued: true }
      return answers[i++]
    },
    waitForSessionReady: async () => ready
  }
}

describe('delivering a page event as a user turn', () => {
  it('delivers to a live session through session.userTurn (NOT message_session)', async () => {
    const d = deps([{ delivered: true, sessionId: 'owner-1' }])
    expect(await deliverUserTurn(d, turn)).toEqual({
      status: 'delivered',
      sessionId: 'owner-1',
      woke: false
    })
    expect(d.calls).toEqual([['session.userTurn', turn]])
  })

  it('wakes a parked session headlessly, waits for it, then delivers', async () => {
    const d = deps([
      { parked: true, sessionId: 'owner-1' },
      { delivered: true, sessionId: 'owner-1' }
    ])
    expect(await deliverUserTurn(d, turn)).toEqual({
      status: 'delivered',
      sessionId: 'owner-1',
      woke: true
    })
    expect(d.calls.map(([c]) => c)).toEqual([
      'session.userTurn',
      'session.wake',
      'session.userTurn'
    ])
    expect(WAKE_READY_TIMEOUT_MS).toBe(40_000)
  })

  it('does not deliver when the woken session never comes up', async () => {
    const d = deps([{ parked: true, sessionId: 'owner-1' }], false)
    expect(await deliverUserTurn(d, turn)).toMatchObject({ status: 'failed' })
    expect(d.calls.filter(([c]) => c === 'session.userTurn')).toHaveLength(1)
  })

  it('reports held when neither the owner nor a selected session exists', async () => {
    expect(await deliverUserTurn(deps([{ held: true }]), { ...turn, sessionId: null })).toEqual({
      status: 'held'
    })
  })

  it('fails (never throws) when the renderer does not answer', async () => {
    const d: DeliveryDeps = {
      dispatch: async () => {
        throw new Error('bridge down')
      },
      waitForSessionReady: async () => true
    }
    expect(await deliverUserTurn(d, turn)).toMatchObject({ status: 'failed' })
  })
})

describe('held events', () => {
  it('keeps the newest 20 per pane and hands them over once', () => {
    const h = createHeldEvents()
    for (let i = 0; i < 25; i++) h.hold('p', `e${i}`)
    expect(h.count('p')).toBe(20)
    const taken = h.take('p')
    expect(taken[0]).toBe('e5')
    expect(h.count('p')).toBe(0)
    h.hold('q', 'x')
    h.forget('q')
    expect(h.take('q')).toEqual([])
  })
})
