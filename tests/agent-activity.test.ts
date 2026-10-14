/**
 * T476 (agent terminals U1) — the chip's live word, against fake timers:
 *   AC-U1-4  `reading`/`typing` is shown for ≥ 1.2 s, clears 3 s after the last event, and
 *            `write` outranks `read`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CLEAR_AFTER_MS,
  LiveWordTracker,
  MIN_HOLD_MS,
  wordAt,
  type LiveWord
} from '../src/renderer/src/lib/agent-activity'

let changes: Array<[string, LiveWord]>
let tracker: LiveWordTracker

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  changes = []
  tracker = new LiveWordTracker((id, w) => changes.push([id, w]), {
    now: () => Date.now(),
    startTimer: (fn, ms) => {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    }
  })
})
afterEach(() => {
  tracker.dispose()
  vi.useRealTimers()
})

describe('LiveWordTracker', () => {
  it('shows `reading` on a read and clears 3 s after the last event', () => {
    tracker.note('t', 'read')
    expect(tracker.word('t')).toBe('reading')
    vi.advanceTimersByTime(CLEAR_AFTER_MS - 1)
    expect(tracker.word('t')).toBe('reading')
    vi.advanceTimersByTime(1)
    expect(tracker.word('t')).toBeNull()
    expect(changes).toEqual([
      ['t', 'reading'],
      ['t', null]
    ])
  })

  it('every new event restarts the 3 s clear', () => {
    tracker.note('t', 'read')
    vi.advanceTimersByTime(2_500)
    tracker.note('t', 'read')
    vi.advanceTimersByTime(2_500)
    expect(tracker.word('t')).toBe('reading')
    vi.advanceTimersByTime(500)
    expect(tracker.word('t')).toBeNull()
  })

  it('a word is on screen for at least 1.2 s', () => {
    tracker.note('t', 'write')
    vi.advanceTimersByTime(MIN_HOLD_MS)
    expect(tracker.word('t')).toBe('typing')
    expect(changes).toEqual([['t', 'typing']])
  })

  it('write outranks read: reads inside the 1.2 s hold do not downgrade `typing`', () => {
    tracker.note('t', 'write')
    vi.advanceTimersByTime(300)
    tracker.note('t', 'read')
    expect(tracker.word('t')).toBe('typing')
    vi.advanceTimersByTime(MIN_HOLD_MS - 300 - 1)
    expect(tracker.word('t')).toBe('typing')
    // The hold ends; reads keep arriving, so the word steps down to `reading`.
    vi.advanceTimersByTime(1)
    expect(tracker.word('t')).toBe('reading')
    expect(changes).toEqual([
      ['t', 'typing'],
      ['t', 'reading']
    ])
  })

  it('a read followed by a write upgrades at once, and a write while typing stays typing', () => {
    tracker.note('t', 'read')
    tracker.note('t', 'write')
    expect(tracker.word('t')).toBe('typing')
    vi.advanceTimersByTime(2_000)
    tracker.note('t', 'write')
    expect(tracker.word('t')).toBe('typing')
    expect(changes.filter(([, w]) => w === 'typing')).toHaveLength(1)
  })

  it('terminals are independent, and forget() clears one without a stale timer', () => {
    tracker.note('a', 'read')
    tracker.note('b', 'write')
    tracker.forget('a')
    expect(tracker.word('a')).toBeNull()
    expect(tracker.word('b')).toBe('typing')
    vi.advanceTimersByTime(10_000)
    expect(tracker.word('b')).toBeNull()
    expect(changes.filter(([id]) => id === 'a').map(([, w]) => w)).toEqual(['reading', null])
  })

  it('wordAt is a pure function of the stamps', () => {
    const slot = { lastEventAt: 100, lastWriteAt: 100, lastKind: 'read' as const }
    expect(wordAt(slot, 100 + MIN_HOLD_MS - 1)).toBe('typing')
    expect(wordAt(slot, 100 + MIN_HOLD_MS)).toBe('reading')
    expect(wordAt(slot, 100 + CLEAR_AFTER_MS)).toBeNull()
  })
})
