/**
 * T487 (agent terminals B7) — AC-B7-6: `terminal:activity` is emitted per verb call, coalesced to
 * one event per 250 ms per terminal. Pure coalescer under fake timers, plus the registry wiring
 * (a read and a write each notify) and the registry's Disconnect listeners.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ACTIVITY_WINDOW_MS,
  TerminalActivityCoalescer,
  type TerminalActivityEvent
} from '../src/main/terminal-activity'
import { TerminalRegistry } from '../src/main/terminal-registry'

describe('TerminalActivityCoalescer', () => {
  let events: TerminalActivityEvent[]
  let c: TerminalActivityCoalescer

  beforeEach(() => {
    vi.useFakeTimers()
    events = []
    c = new TerminalActivityCoalescer((e) => events.push(e))
  })
  afterEach(() => {
    c.dispose()
    vi.useRealTimers()
  })

  it('the first call goes out at once', () => {
    c.note('t1', 'read')
    expect(events).toMatchObject([{ terminalId: 't1', kind: 'read' }])
  })

  it('a burst inside one window is ONE immediate event plus ONE trailing event', () => {
    c.note('t1', 'read')
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(5)
      c.note('t1', 'read')
    }
    expect(events).toHaveLength(1)
    vi.advanceTimersByTime(ACTIVITY_WINDOW_MS)
    expect(events).toHaveLength(2)
    // Nothing more once the burst is over.
    vi.advanceTimersByTime(ACTIVITY_WINDOW_MS * 4)
    expect(events).toHaveLength(2)
  })

  it('never emits twice for one terminal within 250 ms', () => {
    for (let i = 0; i < 100; i++) {
      c.note('t1', i % 2 ? 'read' : 'write')
      vi.advanceTimersByTime(7)
    }
    vi.advanceTimersByTime(ACTIVITY_WINDOW_MS)
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.at - events[i - 1]!.at).toBeGreaterThanOrEqual(ACTIVITY_WINDOW_MS)
    }
  })

  it('a write outranks a read folded into the same window', () => {
    c.note('t1', 'read')
    c.note('t1', 'write')
    c.note('t1', 'read')
    vi.advanceTimersByTime(ACTIVITY_WINDOW_MS)
    expect(events.map((e) => e.kind)).toEqual(['read', 'write'])
  })

  it('terminals are independent', () => {
    c.note('t1', 'read')
    c.note('t2', 'write')
    expect(events.map((e) => e.terminalId)).toEqual(['t1', 't2'])
  })

  it('after a quiet window the next call is immediate again', () => {
    c.note('t1', 'read')
    vi.advanceTimersByTime(ACTIVITY_WINDOW_MS)
    c.note('t1', 'write')
    expect(events).toHaveLength(2)
    expect(events[1]!.kind).toBe('write')
  })

  it('forget drops a pending trailing event', () => {
    c.note('t1', 'read')
    c.note('t1', 'read')
    c.forget('t1')
    vi.advanceTimersByTime(ACTIVITY_WINDOW_MS * 2)
    expect(events).toHaveLength(1)
  })
})

describe('registry → activity wiring and Disconnect listeners', () => {
  const reg = (): TerminalRegistry => {
    const r = new TerminalRegistry()
    r.register({
      terminalId: 'h-1',
      ptyId: 'p-1',
      folder: '/f',
      origin: 'agent',
      size: { cols: 80, rows: 24 }
    })
    return r
  }

  it('noteAgentRead / noteAgentWrite notify their listeners, and unsubscribe stops it', () => {
    const r = reg()
    const seen: string[] = []
    const off = r.onAgentActivity((id, kind) => seen.push(`${id}:${kind}`))
    r.noteAgentRead('h-1')
    r.noteAgentWrite('h-1')
    r.noteAgentRead('h-unknown')
    off()
    r.noteAgentRead('h-1')
    expect(seen).toEqual(['h-1:read', 'h-1:write'])
  })

  it('a throwing activity listener cannot fail a verb', () => {
    const r = reg()
    r.onAgentActivity(() => {
      throw new Error('boom')
    })
    expect(() => r.noteAgentRead('h-1')).not.toThrow()
    expect(r.get('h-1')!.lastAgentReadAt).not.toBeNull()
  })

  it('disconnect flips the flag once, wakes listeners once, and is permanent', () => {
    const r = reg()
    const cb = vi.fn()
    r.onDisconnect('h-1', cb)
    expect(r.disconnect('h-1')).toBe(true)
    expect(r.disconnect('h-1')).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(r.get('h-1')!.disconnected).toBe(true)
    expect(r.get('h-1')!.state).toBe('running')
  })

  it('a listener added after the disconnect fires at once; an unsubscribed one never does', () => {
    const r = reg()
    const late = vi.fn()
    const gone = vi.fn()
    r.onDisconnect('h-1', gone)()
    r.disconnect('h-1')
    r.onDisconnect('h-1', late)
    expect(late).toHaveBeenCalledTimes(1)
    expect(gone).not.toHaveBeenCalled()
  })

  it('an unknown terminal cannot be disconnected', () => {
    expect(reg().disconnect('h-nope')).toBe(false)
  })
})
