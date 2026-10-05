import { describe, it, expect, vi } from 'vitest'
import { withDeadline, TOOL_CALL_DEADLINE_MS, createDeadlineFlag } from '../src/main/mcp/deadline'

/**
 * Pure tests for T123 W5 — the server-side MCP tool-call deadline
 * (AC12/AC13). No electron/IPC — just the race, with the timer injected so
 * the deadline can be a few ms instead of the real 120 s constant.
 */

describe('withDeadline (T123 W5 — server-side MCP handler deadline)', () => {
  it('resolves with the handler value when the work settles before the deadline', async () => {
    const work = Promise.resolve('ok')
    const res = await withDeadline(work, 50)
    expect(res).toEqual({ timedOut: false, value: 'ok' })
  })

  it('resolves {timedOut:true} when the deadline fires before the work settles', async () => {
    let resolveWork!: (v: string) => void
    const work = new Promise<string>((resolve) => {
      resolveWork = resolve
    })
    const res = await withDeadline(work, 5)
    expect(res).toEqual({ timedOut: true })
    // Clean up the still-pending promise so it doesn't leak into another test.
    resolveWork('late')
  })

  it('propagates a rejection from work that settles before the deadline', async () => {
    const work = Promise.reject(new Error('handler blew up'))
    await expect(withDeadline(work, 50)).rejects.toThrow('handler blew up')
  })

  it('does not surface an unhandled rejection when work rejects AFTER the deadline already won', async () => {
    let rejectWork!: (e: Error) => void
    const work = new Promise<string>((_resolve, reject) => {
      rejectWork = reject
    })
    const res = await withDeadline(work, 5)
    expect(res).toEqual({ timedOut: true })
    // Reject after the race is already decided — must not throw/unhandled-reject.
    rejectWork(new Error('too late'))
    await new Promise((r) => setTimeout(r, 10))
  })

  it('clears the timer once work wins the race (no dangling timer)', async () => {
    const clearTimer = vi.fn()
    const setTimer = vi.fn(
      (cb: () => void, ms: number) => setTimeout(cb, ms) as unknown as ReturnType<typeof setTimeout>
    )
    await withDeadline(Promise.resolve('fast'), 1000, setTimer, clearTimer)
    expect(clearTimer).toHaveBeenCalledTimes(1)
  })

  it('clears the timer once the deadline wins the race too', async () => {
    const clearTimer = vi.fn()
    const work = new Promise<string>(() => {
      /* never settles */
    })
    await withDeadline(work, 5, setTimeout, clearTimer)
    expect(clearTimer).toHaveBeenCalledTimes(1)
  })

  it('uses injected setTimer/clearTimer instead of the real global timers', async () => {
    const handle = {} as ReturnType<typeof setTimeout>
    const setTimer = vi.fn((cb: () => void) => {
      cb() // fire "immediately" via the injected timer, not a real one
      return handle
    })
    const clearTimer = vi.fn()
    const work = new Promise<string>(() => {
      /* never settles — only the injected timer can resolve the race */
    })
    const res = await withDeadline(work, 999_999, setTimer, clearTimer)
    expect(res).toEqual({ timedOut: true })
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 999_999)
  })

  it('TOOL_CALL_DEADLINE_MS is the spec-mandated 120s constant (AC12)', () => {
    expect(TOOL_CALL_DEADLINE_MS).toBe(120_000)
  })
})

/**
 * BUG-33 §3.3: a handler still running past the deadline needs a way to check
 * "has the response already gone out?" before its final commit step. The flag
 * is the cooperative signal — Node still can't force-cancel `work`.
 */
describe('withDeadline — deadline flag (BUG-33 §3.3, per-verb post-deadline guard)', () => {
  it('createDeadlineFlag starts unfired', () => {
    expect(createDeadlineFlag()).toEqual({ fired: false })
  })

  it('sets flag.fired when the deadline wins the race', async () => {
    const flag = createDeadlineFlag()
    const work = new Promise<string>(() => {
      /* never settles */
    })
    const res = await withDeadline(work, 5, setTimeout, clearTimeout, flag)
    expect(res).toEqual({ timedOut: true })
    expect(flag.fired).toBe(true)
  })

  it('leaves flag.fired false when work wins the race', async () => {
    const flag = createDeadlineFlag()
    const res = await withDeadline(Promise.resolve('ok'), 50, setTimeout, clearTimeout, flag)
    expect(res).toEqual({ timedOut: false, value: 'ok' })
    expect(flag.fired).toBe(false)
  })

  it('works without a flag at all (backward compatible)', async () => {
    const res = await withDeadline(Promise.resolve('ok'), 50)
    expect(res).toEqual({ timedOut: false, value: 'ok' })
  })
})
