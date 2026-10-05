import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'

/**
 * T2: pure correlated request/ack/timeout bridge for the Harnu MCP server.
 *
 * The bridge is framework-free: `send`/`now`/`setTimer`/`clearTimer` are injected
 * so the core is deterministic under `vi.useFakeTimers()`. Each `dispatch` mints a
 * unique correlation token, arms a single hard-deadline timer, and the matching
 * `ack` (or the deadline, or `rejectAll`) settles the promise exactly once.
 */
import {
  CommandBridge,
  DEADLINE,
  CONFIRM_WINDOW_MS,
  type CommandBridgeDeps,
  type CommandMessage,
  type TimerHandle
} from '../src/main/command-bridge'

interface Harness {
  bridge: CommandBridge
  send: Mock<(message: CommandMessage) => boolean>
  now: Mock<() => number>
  setTimer: Mock<(callback: () => void, ms: number) => TimerHandle>
  clearTimer: Mock<(handle: TimerHandle) => void>
}

/** Build a bridge wired to fresh spies; `sendOk=false` simulates "no window". */
function harness(sendOk = true): Harness {
  const send = vi.fn<(message: CommandMessage) => boolean>(() => sendOk)
  const now = vi.fn<() => number>(() => 1_000)
  const setTimer = vi.fn<(callback: () => void, ms: number) => TimerHandle>((fn, ms) =>
    setTimeout(fn, ms)
  )
  const clearTimer = vi.fn<(handle: TimerHandle) => void>((h) => clearTimeout(h))
  const deps: CommandBridgeDeps = { send, now, setTimer, clearTimer }
  const bridge = new CommandBridge(deps)
  return { bridge, send, now, setTimer, clearTimer }
}

const lastMessage = (send: Mock<(message: CommandMessage) => boolean>, i = 0): CommandMessage =>
  send.mock.calls[i][0]

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CommandBridge.dispatch', () => {
  it('mints a requestId and calls send({requestId,command,payload})', () => {
    const { bridge, send } = harness()
    bridge.dispatch('create_session', { cwd: '/x' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      requestId: expect.any(String),
      command: 'create_session',
      payload: { cwd: '/x' }
    })
    expect(lastMessage(send).requestId.length).toBeGreaterThan(0)
  })

  it('mints a UNIQUE requestId per dispatch', () => {
    const { bridge, send } = harness()
    bridge.dispatch('a', 1)
    bridge.dispatch('b', 2)
    const id0 = lastMessage(send, 0).requestId
    const id1 = lastMessage(send, 1).requestId
    expect(id0).not.toBe(id1)
  })

  it('arms exactly one deadline timer on a successful send and tracks the request', () => {
    const { bridge, setTimer } = harness()
    bridge.dispatch('spawn_terminal', {})
    expect(setTimer).toHaveBeenCalledTimes(1)
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), DEADLINE)
    expect(bridge.size).toBe(1)
  })
})

describe('CommandBridge.ack', () => {
  it('resolves the matching promise with the ack result, exactly once', async () => {
    const { bridge, send, clearTimer } = harness()
    const p = bridge.dispatch('create_session', {})
    const id = lastMessage(send).requestId

    expect(bridge.ack(id, { sessionId: 'abc' })).toBe(true)
    await expect(p).resolves.toEqual({ sessionId: 'abc' })
    expect(clearTimer).toHaveBeenCalledTimes(1) // deadline disarmed on settle
    expect(bridge.size).toBe(0) // evicted

    // double-settle is a no-op: the already-resolved value stands.
    expect(bridge.ack(id, { sessionId: 'SECOND' })).toBe(false)
    await expect(p).resolves.toEqual({ sessionId: 'abc' })
  })

  it('ack on an unknown requestId returns false and touches nothing', () => {
    const { bridge, clearTimer } = harness()
    bridge.dispatch('create_session', {}) // one live request
    expect(bridge.ack('does-not-exist', { sessionId: 'x' })).toBe(false)
    expect(clearTimer).not.toHaveBeenCalled() // no timer disarmed
    expect(bridge.size).toBe(1) // the live request is untouched
  })
})

describe('CommandBridge — no window', () => {
  it('rejects immediately with code NO_WINDOW and arms NO timer', async () => {
    const { bridge, setTimer } = harness(false)
    const p = bridge.dispatch('create_session', { cwd: '/x' })
    await expect(p).rejects.toMatchObject({ code: 'NO_WINDOW' })
    expect(setTimer).not.toHaveBeenCalled()
    expect(bridge.size).toBe(0) // nothing parked
  })
})

describe('CommandBridge — deadline', () => {
  it('rejects with code TIMEOUT and evicts when the deadline fires', async () => {
    const { bridge } = harness()
    const p = bridge.dispatch('spawn_terminal', {})
    const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' })
    vi.advanceTimersByTime(DEADLINE)
    await assertion
    expect(bridge.size).toBe(0)
  })

  it('drops a late ack that arrives after the deadline already fired', async () => {
    const { bridge, send } = harness()
    const p = bridge.dispatch('spawn_terminal', {})
    const id = lastMessage(send).requestId
    const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' })
    vi.advanceTimersByTime(DEADLINE)
    await assertion

    // The agent's ack lands after the timeout — it must be ignored.
    expect(bridge.ack(id, { sessionId: 'too-late' })).toBe(false)
    await expect(p).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})

describe('CommandBridge.rejectAll', () => {
  it('settles every pending request with the given reason and clears them', async () => {
    const { bridge, clearTimer } = harness()
    const p1 = bridge.dispatch('a', {})
    const p2 = bridge.dispatch('b', {})
    const a1 = expect(p1).rejects.toMatchObject({ code: 'shutdown' })
    const a2 = expect(p2).rejects.toMatchObject({ code: 'shutdown' })

    bridge.rejectAll('shutdown')
    await a1
    await a2

    expect(bridge.size).toBe(0)
    expect(clearTimer).toHaveBeenCalledTimes(2) // both deadlines disarmed
  })

  it('is a no-op when there is nothing pending', () => {
    const { bridge } = harness()
    expect(() => bridge.rejectAll('shutdown')).not.toThrow()
    expect(bridge.size).toBe(0)
  })
})

describe('DEADLINE constant', () => {
  it('is strictly greater than the in-UI confirm window', () => {
    // The renderer may have to run the full human-in-the-loop confirm (whose own
    // timeout = DENY) before it can ack, so the bridge must outlive that window.
    expect(DEADLINE).toBeGreaterThan(CONFIRM_WINDOW_MS)
  })
})

describe('CommandBridge.awaitMaterialization / notifyMaterialized (this card / ADR-0003)', () => {
  it('resolves with the materialization info when notifyMaterialized arrives in time', async () => {
    const { bridge } = harness()
    const p = bridge.awaitMaterialization('synthetic-1', 60_000)
    expect(
      bridge.notifyMaterialized({ syntheticId: 'synthetic-1', sessionId: 'real-1', folder: '/x' })
    ).toBe(true)
    await expect(p).resolves.toEqual({
      syntheticId: 'synthetic-1',
      sessionId: 'real-1',
      folder: '/x'
    })
  })

  it('resolves with null (not a rejection) when the deadline fires before any notify', async () => {
    const { bridge } = harness()
    const p = bridge.awaitMaterialization('synthetic-1', 60_000)
    vi.advanceTimersByTime(60_000)
    await expect(p).resolves.toBeNull()
  })

  it('a notifyMaterialized for an unknown/already-settled syntheticId returns false and touches nothing', () => {
    const { bridge } = harness()
    expect(
      bridge.notifyMaterialized({ syntheticId: 'never-awaited', sessionId: 'real-1', folder: '/x' })
    ).toBe(false)
  })

  it('a LATE notify — after the deadline already resolved null — is dropped (AC4: cannot attach after the fact)', async () => {
    const { bridge } = harness()
    const p = bridge.awaitMaterialization('synthetic-1', 60_000)
    vi.advanceTimersByTime(60_000)
    await expect(p).resolves.toBeNull()

    expect(
      bridge.notifyMaterialized({ syntheticId: 'synthetic-1', sessionId: 'too-late', folder: '/x' })
    ).toBe(false)
  })

  it('settles at most once — a second notifyMaterialized for the same id is a no-op', () => {
    const { bridge } = harness()
    void bridge.awaitMaterialization('synthetic-1', 60_000)
    expect(
      bridge.notifyMaterialized({ syntheticId: 'synthetic-1', sessionId: 'real-1', folder: '/x' })
    ).toBe(true)
    expect(
      bridge.notifyMaterialized({ syntheticId: 'synthetic-1', sessionId: 'real-2', folder: '/x' })
    ).toBe(false)
  })

  it('tracks multiple in-flight materialization waits independently by syntheticId', async () => {
    const { bridge } = harness()
    const p1 = bridge.awaitMaterialization('synthetic-1', 60_000)
    const p2 = bridge.awaitMaterialization('synthetic-2', 60_000)
    bridge.notifyMaterialized({ syntheticId: 'synthetic-2', sessionId: 'real-2', folder: '/y' })
    await expect(p2).resolves.toMatchObject({ sessionId: 'real-2' })
    vi.advanceTimersByTime(60_000)
    await expect(p1).resolves.toBeNull()
  })
})
