import { describe, expect, it } from 'vitest'
import {
  OPERATOR_QUIET_CAP_MS,
  OPERATOR_TYPING_WINDOW_MS,
  createOperatorInputTracker,
  isOperatorKeystroke,
  pasteWhenOperatorQuiet,
  quietDelayMs
} from '../src/renderer/src/lib/operator-input'

describe('isOperatorKeystroke', () => {
  it('counts typed characters, Enter, arrows and pasted text', () => {
    for (const d of ['a', '\r', '\x7f', '\x1b[A', '\x1b[1;5C', 'hello world', '\x03', '\x1b']) {
      expect(isOperatorKeystroke(d), JSON.stringify(d)).toBe(true)
    }
  })
  it('does not count what the terminal answers on the program’s behalf', () => {
    for (const d of [
      '\x1b[I',
      '\x1b[O',
      '\x1b[12;40R',
      '\x1b[?62;4c',
      '\x1b[>0;276;0c',
      '\x1b[0n'
    ]) {
      expect(isOperatorKeystroke(d), JSON.stringify(d)).toBe(false)
    }
    expect(isOperatorKeystroke('\x1b]11;rgb:0000/0000/0000\x07')).toBe(false)
    expect(isOperatorKeystroke('')).toBe(false)
  })
  it('does not count xterm mouse reports (pointer moves and wheel over a terminal that asked for them)', () => {
    for (const d of [
      '\x1b[<0;12;7M',
      '\x1b[<0;12;7m',
      '\x1b[<64;40;9M',
      '\x1b[<35;1;1M\x1b[<35;2;1M',
      '\x1b[M #!'
    ]) {
      expect(isOperatorKeystroke(d), JSON.stringify(d)).toBe(false)
    }
  })
})

describe('quietDelayMs', () => {
  it('is 0 with no input or after the window, and the remainder inside it', () => {
    expect(quietDelayMs(null, 1000)).toBe(0)
    expect(quietDelayMs(1000, 1000 + OPERATOR_TYPING_WINDOW_MS)).toBe(0)
    expect(quietDelayMs(1000, 1200)).toBe(OPERATOR_TYPING_WINDOW_MS - 200)
  })
})

describe('pasteWhenOperatorQuiet', () => {
  function rig() {
    let t = 10_000
    let alive = true
    const timers: Array<{ at: number; fn: () => void }> = []
    const pasted: Array<[string, string]> = []
    const tracker = createOperatorInputTracker(() => t)
    const deps = {
      tracker,
      now: () => t,
      setTimer: (fn: () => void, ms: number) => void timers.push({ at: t + ms, fn }),
      paste: (p: string, x: string) => {
        pasted.push([p, x])
        return alive
      }
    }
    const advance = (ms: number): void => {
      const end = t + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift()
        t = next.at
        next.fn()
      }
      t = end
    }
    return {
      deps,
      tracker,
      pasted,
      advance,
      kill: () => (alive = false),
      setNow: (v: number) => (t = v)
    }
  }

  it('pastes at once when the operator has not typed', () => {
    const r = rig()
    pasteWhenOperatorQuiet(r.deps, 'pty1', 'hello')
    expect(r.pasted).toEqual([['pty1', 'hello']])
  })

  it('waits out a typing burst, then pastes', () => {
    const r = rig()
    r.tracker.note('pty1', 'a')
    pasteWhenOperatorQuiet(r.deps, 'pty1', 'hello')
    expect(r.pasted).toEqual([])
    r.advance(1000)
    r.tracker.note('pty1', 'b') // still typing
    r.advance(1000)
    expect(r.pasted).toEqual([])
    r.advance(1600)
    expect(r.pasted).toEqual([['pty1', 'hello']])
  })

  it('does not wait for typing in a DIFFERENT terminal', () => {
    const r = rig()
    r.tracker.note('other', 'a')
    pasteWhenOperatorQuiet(r.deps, 'pty1', 'hello')
    expect(r.pasted).toEqual([['pty1', 'hello']])
  })

  it('gives up waiting at the cap so a terminal that is never quiet still gets the message', () => {
    const r = rig()
    r.tracker.note('pty1', 'a')
    pasteWhenOperatorQuiet(r.deps, 'pty1', 'late')
    for (let i = 0; i < 40; i++) {
      r.advance(1000)
      r.tracker.note('pty1', 'x')
    }
    expect(r.pasted).toEqual([['pty1', 'late']])
    expect(OPERATOR_QUIET_CAP_MS).toBeGreaterThan(OPERATOR_TYPING_WINDOW_MS)
  })

  it('resolves only AFTER the paste ran, so a caller can keep its draft until then', async () => {
    const r = rig()
    r.tracker.note('pty1', 'a')
    let settled: boolean | null = null
    void pasteWhenOperatorQuiet(r.deps, 'pty1', 'hello').then((ok) => (settled = ok))
    await Promise.resolve()
    expect(settled).toBeNull() // still waiting for the operator to pause: nothing delivered yet
    r.advance(2000)
    await Promise.resolve()
    expect(r.pasted).toEqual([['pty1', 'hello']])
    expect(settled).toBe(true)
  })

  it('resolves false when the terminal died during the wait, so nothing is lost', async () => {
    const r = rig()
    r.tracker.note('pty1', 'a')
    const done = pasteWhenOperatorQuiet(r.deps, 'pty1', 'hello')
    r.kill()
    r.advance(2000)
    expect(await done).toBe(false)
  })
})
