import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  registerWriter,
  unregisterWriter,
  writeToSession
} from '../src/renderer/src/lib/terminal-bus'

// The writer registry decouples the footer's Re-attach from TerminalPane's
// module-private `liveTerminals` map. Each assertion observes an independent
// signal: the captured argument the writer received, and the boolean return.

afterEach(() => {
  // The registry is module-level state — clear the ids each test touches.
  unregisterWriter('S1')
  unregisterWriter('S2')
})

describe('terminal-bus writer registry', () => {
  it('routes writeToSession to the registered writer and returns true', () => {
    const fn = vi.fn()
    registerWriter('S1', fn)
    const ok = writeToSession('S1', 'hello')
    expect(ok).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('hello')
  })

  it('returns false and calls nothing when the session has no writer', () => {
    const fn = vi.fn()
    registerWriter('S1', fn)
    const ok = writeToSession('S2', 'x')
    expect(ok).toBe(false)
    expect(fn).not.toHaveBeenCalled()
  })

  it('stops routing after unregister; unregistering an absent id is a no-op', () => {
    const fn = vi.fn()
    registerWriter('S1', fn)
    unregisterWriter('S1')
    expect(writeToSession('S1', 'after')).toBe(false)
    expect(fn).not.toHaveBeenCalled()
    // Idempotent: unregistering an id that was never registered must not throw.
    expect(() => unregisterWriter('never')).not.toThrow()
  })
})
