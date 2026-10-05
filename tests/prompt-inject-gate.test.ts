import { describe, it, expect, vi } from 'vitest'
import {
  acquireInjectionTarget,
  acquireInjectionTargetWithRetry,
  createInjectGate,
  isComposerReadyHook
} from '../src/renderer/src/components/prompt-inject-gate'

/**
 * T75 / BUG-17 — an agent's injected pre-prompt must wait for the COMPOSER to be
 * ready before it is pasted. The old code pasted the instant `pty:sessionReady`
 * fired (right after `spawn()`, before the `claude` banner printed a byte), so
 * the bracketed-paste escapes leaked into the banner and the submit raced a
 * mid-banner lull (1/3 fan-out failures). This is the pure decision core: fed a
 * composer-ready hook signal, PTY output pings, and injected timers, it decides
 * WHEN to inject — hook-first, else banner quiescence, else a hard cap.
 */

/** A deterministic virtual clock: fires injected timers in chronological order. */
function makeClock(): {
  setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (h: ReturnType<typeof setTimeout>) => void
  advance: (ms: number) => void
  readonly now: number
} {
  let now = 0
  let seq = 0
  const timers = new Map<number, { fireAt: number; cb: () => void }>()
  return {
    setTimer(cb: () => void, ms: number) {
      const id = ++seq
      timers.set(id, { fireAt: now + ms, cb })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer(h: ReturnType<typeof setTimeout>) {
      timers.delete(h as unknown as number)
    },
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        let nextId = -1
        let nextAt = Infinity
        for (const [id, t] of timers) {
          if (t.fireAt <= target && t.fireAt < nextAt) {
            nextAt = t.fireAt
            nextId = id
          }
        }
        if (nextId === -1) break
        const t = timers.get(nextId)!
        timers.delete(nextId)
        now = t.fireAt
        t.cb()
      }
      now = target
    },
    get now() {
      return now
    }
  }
}

const CFG = { quietMs: 500, capMs: 2500 }

describe('isComposerReadyHook (composer-ready predicate)', () => {
  it('SessionStart is ready regardless of the folded state', () => {
    expect(isComposerReadyHook('SessionStart', 'idle')).toBe(true)
    expect(isComposerReadyHook('SessionStart', 'working')).toBe(true)
  })

  it('a folded idle task-state is ready (Stop / idle_prompt)', () => {
    expect(isComposerReadyHook('Stop', 'idle')).toBe(true)
    expect(isComposerReadyHook('Notification', 'idle')).toBe(true)
  })

  it('busy / gone / mid-turn states are NOT ready', () => {
    expect(isComposerReadyHook('PreToolUse', 'working')).toBe(false)
    expect(isComposerReadyHook('Notification', 'needs-input')).toBe(false)
    expect(isComposerReadyHook('SessionEnd', 'completed')).toBe(false)
    expect(isComposerReadyHook('StopFailure', 'failed')).toBe(false)
    expect(isComposerReadyHook('', '')).toBe(false)
  })
})

describe('createInjectGate (composer-readiness gate — T75/BUG-17)', () => {
  it('a composer-ready hook injects IMMEDIATELY, before any output or cap', () => {
    const clock = makeClock()
    const injects: number[] = []
    let settled = 0
    const gate = createInjectGate({
      inject: () => injects.push(clock.now),
      onSettled: () => settled++,
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    clock.advance(30)
    gate.signalReady()
    expect(injects).toEqual([30]) // no wait — the hook says the composer is up
    expect(settled).toBe(1)
    // Later output / the cap must not inject again.
    clock.advance(3000)
    gate.onData()
    expect(injects).toEqual([30])
  })

  it('with no hook, injects after the banner settles (output quiescence)', () => {
    const clock = makeClock()
    const injects: number[] = []
    const gate = createInjectGate({
      inject: () => injects.push(clock.now),
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    // Banner prints at t=10 and t=40, then goes silent.
    clock.advance(10)
    gate.onData()
    clock.advance(30) // now=40
    gate.onData()
    clock.advance(499) // now=539 — quiet window (40+500=540) not elapsed yet
    expect(injects).toEqual([])
    clock.advance(1) // now=540 — quiescence → inject
    expect(injects).toEqual([540])
  })

  it('waits through a continuously-printing banner and injects only after it stops', () => {
    const clock = makeClock()
    const injects: number[] = []
    const gate = createInjectGate({
      inject: () => injects.push(clock.now),
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    // A chunk every 100 ms (< quietMs) keeps re-arming the quiet timer.
    for (let i = 0; i < 15; i++) {
      clock.advance(100)
      gate.onData()
    }
    expect(injects).toEqual([]) // never silent for 500 ms → never pasted mid-banner
    clock.advance(500) // last onData at 1500 → quiet fires at 2000
    expect(injects).toEqual([2000])
  })

  it('injects at the hard cap when output never settles (hooks off, endless banner)', () => {
    const clock = makeClock()
    const injects: number[] = []
    const gate = createInjectGate({
      inject: () => injects.push(clock.now),
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    // Output every 200 ms (< quietMs) up to the cap — quiescence never triggers.
    for (let i = 0; i < 13; i++) {
      clock.advance(200)
      gate.onData()
    } // now=2600 → the cap (2500) fired on the last advance
    expect(injects).toEqual([2500])
  })

  it('a hook wins over a pending quiescence timer (injects once, at the hook)', () => {
    const clock = makeClock()
    const injects: number[] = []
    const gate = createInjectGate({
      inject: () => injects.push(clock.now),
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    clock.advance(50)
    gate.onData() // arms the 500 ms quiet timer (would fire at 550)
    clock.advance(100) // now=150 — a composer-ready hook arrives first
    gate.signalReady()
    expect(injects).toEqual([150])
    clock.advance(1000) // the pre-armed quiet timer must NOT fire a second inject
    expect(injects).toEqual([150])
  })

  it('cancel aborts with no injection (PTY died before the composer was ready)', () => {
    const clock = makeClock()
    const injects: number[] = []
    let settled = 0
    const gate = createInjectGate({
      inject: () => injects.push(clock.now),
      onSettled: () => settled++,
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    clock.advance(20)
    gate.onData()
    gate.cancel() // PTY exited mid-banner
    clock.advance(5000)
    expect(injects).toEqual([]) // no paste into a dead PTY
    expect(settled).toBe(1)
    // A late hook / output after cancel is inert.
    gate.signalReady()
    gate.onData()
    expect(injects).toEqual([])
    expect(settled).toBe(1)
  })

  it('onSettled fires exactly once even if cancel follows a natural inject', () => {
    const clock = makeClock()
    let settled = 0
    const gate = createInjectGate({
      inject: () => {},
      onSettled: () => settled++,
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    gate.signalReady()
    expect(settled).toBe(1)
    gate.cancel()
    expect(settled).toBe(1)
  })
})

/**
 * BUG-64: for an agent session whose composer-ready hook is expected to be
 * wired, quiescence/cap must NOT blind-paste — T174's live validation caught a
 * session sitting on a READY, EMPTY composer with its prompt never delivered,
 * proving output quiescence alone cannot tell "the banner settled" from "an
 * unknown prompt is idling waiting for a keypress." Only the hook may inject;
 * everything else settles without pasting and records `gate-escalated` so the
 * existing watchdog (BUG-61) can escalate to `prompt_undelivered`.
 */
describe('createInjectGate — requireComposerReadyHook (BUG-64)', () => {
  it('BUG-85: quiescence neither injects NOR settles — the gate keeps waiting for the hook', () => {
    const clock = makeClock()
    const injects: number[] = []
    const events: unknown[] = []
    let settled = 0
    const gate = createInjectGate({
      inject: () => injects.push(clock.now),
      onSettled: () => settled++,
      record: (e) => events.push(e),
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      requireComposerReadyHook: true
    })
    clock.advance(10)
    gate.onData()
    clock.advance(500) // the old code escalated here, destroying the prompt
    expect(injects).toEqual([]) // still no blind paste — BUG-64's posture holds
    expect(settled).toBe(0) // ...but the gate is still open, waiting for the hook
    expect(events).toEqual([])
  })

  it('BUG-85: a hook arriving after several banner lulls still injects', () => {
    const clock = makeClock()
    const injects: number[] = []
    const gate = createInjectGate({
      inject: () => injects.push(clock.now),
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      requireComposerReadyHook: true
    })
    // A cold `claude` boot: output, a lull, more output, another lull...
    for (let i = 0; i < 3; i++) {
      gate.onData()
      clock.advance(600)
    }
    expect(injects).toEqual([]) // nothing pasted on any of those lulls
    gate.signalReady() // SessionStart finally lands, well past 500 ms
    expect(injects).toEqual([1800])
  })

  it('the hard cap does NOT inject either — same escalation, via "cap"', () => {
    const clock = makeClock()
    const injects: number[] = []
    const events: unknown[] = []
    createInjectGate({
      inject: () => injects.push(clock.now),
      record: (e) => events.push(e),
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      requireComposerReadyHook: true
    })
    clock.advance(2500) // the cap fires; no hook, no quiescence ever armed
    expect(injects).toEqual([])
    expect(events).toEqual([{ type: 'gate-escalated', via: 'cap' }])
  })

  it('a composer-ready hook still injects immediately — the happy path is unaffected', () => {
    const clock = makeClock()
    const injects: number[] = []
    const events: unknown[] = []
    const gate = createInjectGate({
      inject: () => injects.push(clock.now),
      record: (e) => events.push(e),
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      requireComposerReadyHook: true
    })
    clock.advance(30)
    gate.signalReady()
    expect(injects).toEqual([30]) // no added latency — the hook wins as before
    expect(events).toEqual([{ type: 'gate-fired', via: 'hook' }])
    // A later quiescence/cap must not do anything further.
    clock.advance(3000)
    gate.onData()
    expect(injects).toEqual([30])
  })

  it('once escalated, a late hook is inert (the gate already settled)', () => {
    const clock = makeClock()
    const injects: number[] = []
    const gate = createInjectGate({
      inject: () => injects.push(clock.now),
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      requireComposerReadyHook: true
    })
    clock.advance(2500) // escalates via cap
    gate.signalReady() // arrives too late
    expect(injects).toEqual([])
  })

  it('default (false/absent) preserves the old best-effort behavior — hooks-off sessions still get their prompt', () => {
    const clock = makeClock()
    const injects: number[] = []
    const gate = createInjectGate({
      inject: () => injects.push(clock.now),
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
      // requireComposerReadyHook omitted — the documented safe default.
    })
    clock.advance(10)
    gate.onData()
    clock.advance(500)
    expect(injects).toEqual([510]) // quiescence still injects — no regression
  })

  it('BUG-85: the cap escalation requeues the prompt so a retry can re-arm', () => {
    const clock = makeClock()
    const events: unknown[] = []
    let requeued = 0
    createInjectGate({
      inject: () => {},
      requeue: () => requeued++,
      record: (e) => events.push(e),
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      requireComposerReadyHook: true
    })
    clock.advance(2500)
    expect(requeued).toBe(1)
    expect(events).toEqual([{ type: 'prompt-requeued' }, { type: 'gate-escalated', via: 'cap' }])
  })

  it('BUG-85: a cancel (the PTY died) requeues too', () => {
    const clock = makeClock()
    let requeued = 0
    const gate = createInjectGate({
      inject: () => {},
      requeue: () => requeued++,
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      requireComposerReadyHook: true
    })
    gate.cancel()
    expect(requeued).toBe(1)
  })

  it('BUG-85: a successful injection never requeues', () => {
    const clock = makeClock()
    let requeued = 0
    const gate = createInjectGate({
      inject: () => {},
      requeue: () => requeued++,
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      requireComposerReadyHook: true
    })
    gate.signalReady()
    clock.advance(5000)
    expect(requeued).toBe(0)
  })
})

/**
 * BUG (T25 last-mile): `armInjectGate` used to CONSUME the queued pre-prompt
 * (`takeAgentPrompt`, which deletes it) BEFORE it resolved the PTY to paste into,
 * then `return` when no PTY was reachable — dropping the one-shot prompt forever,
 * so the session booted blank (observed when a live terminal wasn't attached AND
 * the main-side PTY lookup was unavailable, e.g. during an MCP reconnect). This
 * pure core enforces the correct order: peek → resolve → consume-only-on-success,
 * so a failed resolve leaves the prompt queued and recoverable.
 */
describe('acquireInjectionTarget (resolve-before-consume — pre-prompt drop fix)', () => {
  it('no prompt queued → null, never resolves a PTY, never consumes', async () => {
    const resolvePtyId = vi.fn(async () => 'pty-1')
    const takePrompt = vi.fn(() => 'hello')
    const target = await acquireInjectionTarget({
      hasPrompt: () => false,
      resolvePtyId,
      takePrompt
    })
    expect(target).toBeNull()
    expect(resolvePtyId).not.toHaveBeenCalled()
    expect(takePrompt).not.toHaveBeenCalled()
  })

  it('prompt queued + PTY resolves → returns { ptyId, prompt } and consumes exactly once', async () => {
    const takePrompt = vi.fn(() => 'boot me')
    const target = await acquireInjectionTarget({
      hasPrompt: () => true,
      resolvePtyId: async () => 'pty-42',
      takePrompt
    })
    expect(target).toEqual({ ptyId: 'pty-42', prompt: 'boot me' })
    expect(takePrompt).toHaveBeenCalledTimes(1)
  })

  it('prompt queued but PTY resolves null → null and does NOT consume (the drop-fix)', async () => {
    const takePrompt = vi.fn(() => 'must survive')
    const target = await acquireInjectionTarget({
      hasPrompt: () => true,
      resolvePtyId: async () => null,
      takePrompt
    })
    expect(target).toBeNull()
    expect(takePrompt).not.toHaveBeenCalled() // prompt left queued, recoverable
  })

  it('prompt queued but resolvePtyId rejects → null and does NOT consume', async () => {
    const takePrompt = vi.fn(() => 'must survive')
    const target = await acquireInjectionTarget({
      hasPrompt: () => true,
      resolvePtyId: async () => {
        throw new Error('mcp reconnecting')
      },
      takePrompt
    })
    expect(target).toBeNull()
    expect(takePrompt).not.toHaveBeenCalled()
  })

  it('resolvePtyId may be synchronous (live-terminal cache hit)', async () => {
    const target = await acquireInjectionTarget({
      hasPrompt: () => true,
      resolvePtyId: () => 'pty-sync',
      takePrompt: () => 'go'
    })
    expect(target).toEqual({ ptyId: 'pty-sync', prompt: 'go' })
  })

  it('PTY resolves but the prompt was taken meanwhile → null, no throw (race guard)', async () => {
    const target = await acquireInjectionTarget({
      hasPrompt: () => true,
      resolvePtyId: async () => 'pty-7',
      takePrompt: () => undefined
    })
    expect(target).toBeNull()
  })
})

/**
 * A lookup that fails once and then resolves (the mid-MCP-reconnect case) used
 * to strand the prompt forever — `armInjectGate` only ever called
 * `acquireInjectionTarget` once. `acquireInjectionTargetWithRetry` re-attempts
 * on a fixed backoff until a target resolves, the prompt is gone, or the
 * attempts run out.
 */
describe('acquireInjectionTargetWithRetry (bounded retry over a flaky resolve)', () => {
  it('resolvePtyId fails once then succeeds → retries and returns the target', async () => {
    let calls = 0
    const takePrompt = vi.fn(() => 'boot me')
    const setTimer = vi.fn((cb: () => void) => {
      cb()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    const target = await acquireInjectionTargetWithRetry(
      {
        hasPrompt: () => true,
        resolvePtyId: async () => {
          calls += 1
          return calls === 1 ? null : 'pty-42'
        },
        takePrompt,
        setTimer
      },
      { retryMs: 400, maxAttempts: 5 }
    )
    expect(target).toEqual({ ptyId: 'pty-42', prompt: 'boot me' })
    expect(calls).toBe(2)
    expect(takePrompt).toHaveBeenCalledTimes(1)
    expect(setTimer).toHaveBeenCalledTimes(1)
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 400)
  })

  it('resolvePtyId never resolves → null after maxAttempts, prompt left queued', async () => {
    const resolvePtyId = vi.fn(async () => null)
    const takePrompt = vi.fn(() => 'must survive')
    const setTimer = vi.fn((cb: () => void) => {
      cb()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    const target = await acquireInjectionTargetWithRetry(
      { hasPrompt: () => true, resolvePtyId, takePrompt, setTimer },
      { retryMs: 400, maxAttempts: 3 }
    )
    expect(target).toBeNull()
    expect(resolvePtyId).toHaveBeenCalledTimes(3)
    expect(takePrompt).not.toHaveBeenCalled()
    expect(setTimer).toHaveBeenCalledTimes(2) // no wait after the last attempt
  })

  it('the prompt is consumed by a racing caller mid-retry → stops early, no throw', async () => {
    let calls = 0
    let promptGone = false
    const resolvePtyId = vi.fn(async () => {
      calls += 1
      return null
    })
    const setTimer = vi.fn((cb: () => void) => {
      promptGone = true // simulate another consumer winning the race between attempts
      cb()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    const target = await acquireInjectionTargetWithRetry(
      { hasPrompt: () => !promptGone, resolvePtyId, takePrompt: () => 'never', setTimer },
      { retryMs: 400, maxAttempts: 5 }
    )
    expect(target).toBeNull()
    expect(calls).toBe(1) // stopped after the first failed attempt, no further retries
  })

  it('no prompt queued from the start → null immediately, no retry scheduled', async () => {
    const resolvePtyId = vi.fn(async () => 'pty-1')
    const setTimer = vi.fn()
    const target = await acquireInjectionTargetWithRetry(
      { hasPrompt: () => false, resolvePtyId, takePrompt: () => 'x', setTimer },
      { retryMs: 400, maxAttempts: 5 }
    )
    expect(target).toBeNull()
    expect(resolvePtyId).not.toHaveBeenCalled()
    expect(setTimer).not.toHaveBeenCalled()
  })
})
