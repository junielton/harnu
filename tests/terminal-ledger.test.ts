import { describe, it, expect } from 'vitest'
import {
  emptyLedger,
  recordTerminal,
  clearTerminalEntry,
  recordShutdown,
  restorable,
  evictStale,
  serializeLedger,
  parseLedger,
  type TerminalLedgerState
} from '../src/main/terminal-ledger'

describe('recordTerminal / restorable — supersede on new life', () => {
  it('supersedes a failed entry once the session shows new life', () => {
    const led = recordTerminal(emptyLedger(), 's1', {
      state: 'failed',
      failureReason: 'usage_limit',
      at: 1_000
    })
    expect(
      restorable(led, { s1: { lastEventMs: undefined, cleanEndOfTurnMs: undefined } })
    ).toEqual([{ sessionId: 's1', state: 'failed', failureReason: 'usage_limit', at: 1_000 }])
    // new life in this run → the entry must not be restored
    expect(restorable(led, { s1: { lastEventMs: 2_000, cleanEndOfTurnMs: undefined } })).toEqual([])
  })

  it('restores a completed entry with no failure metadata', () => {
    const led = recordTerminal(emptyLedger(), 's2', { state: 'completed', at: 5_000 })
    expect(restorable(led, {})).toEqual([{ sessionId: 's2', state: 'completed', at: 5_000 }])
  })

  it('a session with no freshness info at all is still restorable', () => {
    const led = recordTerminal(emptyLedger(), 's3', { state: 'failed', at: 10 })
    expect(restorable(led, {})).toEqual([{ sessionId: 's3', state: 'failed', at: 10 }])
  })

  it('drops an entry when the transcript gained a newer clean end-of-turn', () => {
    const led = recordTerminal(emptyLedger(), 's4', { state: 'failed', at: 1_000 })
    // clean end-of-turn strictly newer than entry.at supersedes
    expect(restorable(led, { s4: { cleanEndOfTurnMs: 1_500 } })).toEqual([])
    // clean end-of-turn at or before entry.at does not supersede
    expect(restorable(led, { s4: { cleanEndOfTurnMs: 1_000 } })).toEqual([
      { sessionId: 's4', state: 'failed', at: 1_000 }
    ])
    expect(restorable(led, { s4: { cleanEndOfTurnMs: 500 } })).toEqual([
      { sessionId: 's4', state: 'failed', at: 1_000 }
    ])
  })

  it('last write wins for the same session', () => {
    let led = recordTerminal(emptyLedger(), 's5', { state: 'failed', at: 1_000 })
    led = recordTerminal(led, 's5', { state: 'completed', at: 2_000 })
    expect(restorable(led, {})).toEqual([{ sessionId: 's5', state: 'completed', at: 2_000 }])
  })
})

describe('clearTerminalEntry', () => {
  it('drops a session entry (any sign of life supersede path)', () => {
    const led = recordTerminal(emptyLedger(), 's1', { state: 'failed', at: 1_000 })
    const cleared = clearTerminalEntry(led, 's1')
    expect(restorable(cleared, {})).toEqual([])
  })

  it('is a no-op for a session with no entry', () => {
    const led = emptyLedger()
    expect(clearTerminalEntry(led, 'nope')).toEqual(led)
  })
})

describe('retention', () => {
  it('evicts entries older than 72h on evictStale', () => {
    const HOUR = 60 * 60 * 1000
    const now = 1_000_000 * HOUR
    let led = recordTerminal(emptyLedger(), 'old', { state: 'failed', at: now - 73 * HOUR })
    led = recordTerminal(led, 'fresh', { state: 'completed', at: now - 1 * HOUR })
    const evicted = evictStale(led, now)
    expect(
      restorable(evicted, {})
        .map((e) => e.sessionId)
        .sort()
    ).toEqual(['fresh'])
  })

  it('caps the map at 200 entries, evicting the oldest first', () => {
    let led = emptyLedger()
    for (let i = 0; i < 210; i++) {
      led = recordTerminal(led, `s${i}`, { state: 'completed', at: i })
    }
    const evicted = evictStale(led, 1_000_000)
    const remaining = restorable(evicted, {})
    expect(remaining).toHaveLength(200)
    // the oldest 10 (at: 0..9) must have been evicted first
    const ids = new Set(remaining.map((e) => e.sessionId))
    for (let i = 0; i < 10; i++) expect(ids.has(`s${i}`)).toBe(false)
    for (let i = 10; i < 210; i++) expect(ids.has(`s${i}`)).toBe(true)
  })
})

describe('lastShutdown — replace, not append', () => {
  it('replaces the shutdown set across three consecutive quits', () => {
    let led = emptyLedger()
    led = recordShutdown(led, ['a', 'b'], 1_000)
    led = recordShutdown(led, ['c'], 2_000)
    led = recordShutdown(led, ['d', 'e', 'f'], 3_000)
    expect(led.lastShutdown).toEqual({ at: 3_000, sessionIds: ['d', 'e', 'f'] })
  })

  it('starts as null in a fresh ledger', () => {
    expect(emptyLedger().lastShutdown).toBeNull()
  })
})

describe('serializeLedger / parseLedger round-trip', () => {
  it('round-trips a populated ledger', () => {
    let led = recordTerminal(emptyLedger(), 's1', {
      state: 'failed',
      failureReason: 'rate_limit',
      resetsAt: 9_999,
      at: 1_000
    })
    led = recordShutdown(led, ['s1'], 2_000)
    const raw = serializeLedger(led)
    expect(parseLedger(raw)).toEqual(led)
  })

  it('loads a corrupt file as an empty ledger and never throws', () => {
    expect(parseLedger('not json at all {{{')).toEqual(emptyLedger())
  })

  it('loads an absent/empty string as an empty ledger', () => {
    expect(parseLedger('')).toEqual(emptyLedger())
  })

  it('rejects an unrecognized version and falls back to empty', () => {
    const bogus = JSON.stringify({ version: 99, terminal: {}, lastShutdown: null })
    expect(parseLedger(bogus)).toEqual(emptyLedger())
  })

  it('rejects a malformed shape and falls back to empty', () => {
    expect(parseLedger(JSON.stringify({ version: 1, terminal: 'nope' }))).toEqual(emptyLedger())
  })
})

describe('emptyLedger', () => {
  it('has no terminal entries and no lastShutdown', () => {
    const led: TerminalLedgerState = emptyLedger()
    expect(led.version).toBe(1)
    expect(led.terminal).toEqual({})
    expect(led.lastShutdown).toBeNull()
  })
})
