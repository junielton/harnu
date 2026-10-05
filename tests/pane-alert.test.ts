import { describe, it, expect } from 'vitest'
import {
  createPaneAlertQueue,
  enqueuePaneAlert,
  drainPaneAlert,
  mostRecentlyActive
} from '../src/renderer/src/lib/pane-alert'

/**
 * 2026-07-13 agent-pane-routing design §Alert — the coalescing counter and the
 * "most recently active session" pick are both PURE (no timers, no Pinia), so
 * they unit-test in isolation. The store (`helpers.ts`) owns the impure
 * `setTimeout` debounce around `enqueuePaneAlert`/`drainPaneAlert` — covered
 * end to end in `agent-pane-routing.test.ts`.
 */
describe('pane-alert queue (coalescing counter)', () => {
  it('enqueue returns the running count per folder', () => {
    const q = createPaneAlertQueue()
    expect(enqueuePaneAlert(q, '/repo/a')).toBe(1)
    expect(enqueuePaneAlert(q, '/repo/a')).toBe(2)
    expect(enqueuePaneAlert(q, '/repo/a')).toBe(3)
  })

  it('folders are counted independently', () => {
    const q = createPaneAlertQueue()
    enqueuePaneAlert(q, '/repo/a')
    enqueuePaneAlert(q, '/repo/a')
    enqueuePaneAlert(q, '/repo/b')
    expect(drainPaneAlert(q, '/repo/a')).toBe(2)
    expect(drainPaneAlert(q, '/repo/b')).toBe(1)
  })

  it('drain returns 0 and stays idempotent for a folder with nothing queued', () => {
    const q = createPaneAlertQueue()
    expect(drainPaneAlert(q, '/repo/never-touched')).toBe(0)
  })

  it('drain CLEARS the count — a second drain sees 0, not the stale count', () => {
    const q = createPaneAlertQueue()
    enqueuePaneAlert(q, '/repo/a')
    enqueuePaneAlert(q, '/repo/a')
    expect(drainPaneAlert(q, '/repo/a')).toBe(2)
    expect(drainPaneAlert(q, '/repo/a')).toBe(0)
  })

  it('a fresh burst after a drain starts counting from 1 again', () => {
    const q = createPaneAlertQueue()
    enqueuePaneAlert(q, '/repo/a')
    drainPaneAlert(q, '/repo/a')
    expect(enqueuePaneAlert(q, '/repo/a')).toBe(1)
  })
})

describe('mostRecentlyActive', () => {
  it('null on an empty list', () => {
    expect(mostRecentlyActive([])).toBeNull()
  })

  it('picks the entry with the newest `modified` timestamp', () => {
    const older = { sessionId: 'a', modified: '2026-07-01T00:00:00.000Z' }
    const newer = { sessionId: 'b', modified: '2026-07-13T00:00:00.000Z' }
    expect(mostRecentlyActive([older, newer])).toBe(newer)
    expect(mostRecentlyActive([newer, older])).toBe(newer)
  })

  it('an unparseable/empty date sinks to the end (-Infinity), never wins', () => {
    const broken = { sessionId: 'broken', modified: '' }
    const valid = { sessionId: 'valid', modified: '2026-07-01T00:00:00.000Z' }
    expect(mostRecentlyActive([broken, valid])).toBe(valid)
    expect(mostRecentlyActive([valid, broken])).toBe(valid)
  })

  it('a tie keeps the first-seen entry', () => {
    const first = { sessionId: 'first', modified: '2026-07-01T00:00:00.000Z' }
    const second = { sessionId: 'second', modified: '2026-07-01T00:00:00.000Z' }
    expect(mostRecentlyActive([first, second])).toBe(first)
  })
})
