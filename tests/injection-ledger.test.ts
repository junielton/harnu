import { describe, it, expect, vi } from 'vitest'
import { createInjectionLedger } from '../src/renderer/src/stores/injection-ledger'
import {
  acquireInjectionTargetWithRetry,
  createInjectGate
} from '../src/renderer/src/components/prompt-inject-gate'

/**
 * T172 — the pre-prompt injection trail. Before this module, nothing recorded
 * whether an agent's queued pre-prompt was ever actually pasted (see the
 * 2026-07-20 orphan-spawn post-mortem's "Not proven" section and
 * `docs/adr/0007-injection-trail-is-an-in-memory-renderer-ledger.md`). These
 * tests cover the ledger's own pure behavior, then compose it with the real
 * `prompt-inject-gate.ts` cores to prove the acceptance criteria end to end:
 * a prompted session emits the full trail with the injected/dequeued
 * distinction; a promptless session emits nothing.
 */

describe('createInjectionLedger (pure state)', () => {
  it('starts empty: no trail, status "none", not injected', () => {
    const ledger = createInjectionLedger()
    expect(ledger.getTrail('s1')).toEqual([])
    expect(ledger.statusFor('s1')).toBe('none')
    expect(ledger.wasInjected('s1')).toBe(false)
  })

  it('record appends in order and stamps a timestamp', () => {
    const ledger = createInjectionLedger()
    ledger.record('s1', { type: 'target-resolved', attempt: 1 })
    ledger.record('s1', { type: 'prompt-dequeued', attempt: 1 })
    const trail = ledger.getTrail('s1')
    expect(trail.map((e) => e.type)).toEqual(['target-resolved', 'prompt-dequeued'])
    expect(trail.every((e) => typeof e.at === 'number')).toBe(true)
  })

  it('a different session id has an independent trail', () => {
    const ledger = createInjectionLedger()
    ledger.record('s1', { type: 'paste-written' })
    expect(ledger.getTrail('s2')).toEqual([])
    expect(ledger.wasInjected('s2')).toBe(false)
  })

  it('statusFor: dequeued when consumed but never pasted', () => {
    const ledger = createInjectionLedger()
    ledger.record('s1', { type: 'target-resolved', attempt: 1 })
    ledger.record('s1', { type: 'prompt-dequeued', attempt: 1 })
    expect(ledger.statusFor('s1')).toBe('dequeued')
    expect(ledger.wasInjected('s1')).toBe(false)
  })

  it('statusFor: injected once the bracketed paste actually lands', () => {
    const ledger = createInjectionLedger()
    ledger.record('s1', { type: 'prompt-dequeued', attempt: 1 })
    ledger.record('s1', { type: 'gate-fired', via: 'quiescence' })
    ledger.record('s1', { type: 'paste-written' })
    expect(ledger.statusFor('s1')).toBe('injected')
    expect(ledger.wasInjected('s1')).toBe(true)
  })

  it('statusFor: cancelled when the gate aborts before any paste', () => {
    const ledger = createInjectionLedger()
    ledger.record('s1', { type: 'prompt-dequeued', attempt: 1 })
    ledger.record('s1', { type: 'gate-cancelled' })
    expect(ledger.statusFor('s1')).toBe('cancelled')
    expect(ledger.wasInjected('s1')).toBe(false)
  })

  it('injected wins over a later-recorded cancel (paste already landed)', () => {
    const ledger = createInjectionLedger()
    ledger.record('s1', { type: 'paste-written' })
    ledger.record('s1', { type: 'gate-cancelled' })
    expect(ledger.statusFor('s1')).toBe('injected')
  })

  it('statusFor: escalated when a composer-ready hook was required and never arrived (BUG-64)', () => {
    const ledger = createInjectionLedger()
    ledger.record('s1', { type: 'prompt-dequeued', attempt: 1 })
    ledger.record('s1', { type: 'gate-escalated', via: 'quiescence' })
    expect(ledger.statusFor('s1')).toBe('escalated')
    expect(ledger.wasInjected('s1')).toBe(false)
  })

  it('injected wins over a later-recorded escalation (paste already landed)', () => {
    const ledger = createInjectionLedger()
    ledger.record('s1', { type: 'paste-written' })
    ledger.record('s1', { type: 'gate-escalated', via: 'cap' })
    expect(ledger.statusFor('s1')).toBe('injected')
  })

  it('rekey moves the whole trail from the synthetic id to the real id', () => {
    const ledger = createInjectionLedger()
    ledger.record('synthetic-abc', { type: 'target-resolved', attempt: 1 })
    ledger.record('synthetic-abc', { type: 'prompt-dequeued', attempt: 1 })
    ledger.rekey('synthetic-abc', 'real-uuid-1')
    expect(ledger.getTrail('synthetic-abc')).toEqual([])
    expect(ledger.getTrail('real-uuid-1').map((e) => e.type)).toEqual([
      'target-resolved',
      'prompt-dequeued'
    ])
  })

  it('rekey is a no-op when there is nothing to move', () => {
    const ledger = createInjectionLedger()
    ledger.rekey('nothing-here', 'real-uuid-1')
    expect(ledger.getTrail('real-uuid-1')).toEqual([])
  })

  it('rekey is a no-op when fromId === toId', () => {
    const ledger = createInjectionLedger()
    ledger.record('s1', { type: 'paste-written' })
    ledger.rekey('s1', 's1')
    expect(ledger.getTrail('s1')).toHaveLength(1)
  })

  it('rekey merges onto an existing trail at the target id rather than clobbering it', () => {
    const ledger = createInjectionLedger()
    ledger.record('real-uuid-1', { type: 'gate-fired', via: 'hook' })
    ledger.record('synthetic-abc', { type: 'target-resolved', attempt: 1 })
    ledger.rekey('synthetic-abc', 'real-uuid-1')
    expect(ledger.getTrail('real-uuid-1').map((e) => e.type)).toEqual([
      'gate-fired',
      'target-resolved'
    ])
  })

  it('clear drops a session trail', () => {
    const ledger = createInjectionLedger()
    ledger.record('s1', { type: 'paste-written' })
    ledger.clear('s1')
    expect(ledger.getTrail('s1')).toEqual([])
    expect(ledger.statusFor('s1')).toBe('none')
  })
})

/**
 * The literal acceptance criteria: "a session with a pre-prompt emits the full
 * trail with the injected/dequeued distinction; a promptless session emits
 * nothing." Wires the REAL `acquireInjectionTargetWithRetry` +
 * `createInjectGate` cores from `prompt-inject-gate.ts` against a fresh ledger,
 * the same way `TerminalPane.vue`'s `armInjectGate` does in production —
 * without xterm, Pinia, or a live PTY, per ADR-0001's pure-core convention.
 */
describe('full injection trail — composed from the real prompt-inject-gate cores (T172 AC)', () => {
  it('a prompted session records target-resolved, prompt-dequeued, then gate-fired on the hook', async () => {
    const ledger = createInjectionLedger()
    const sessionId = 'synthetic-agent-1'

    const target = await acquireInjectionTargetWithRetry(
      {
        hasPrompt: () => true,
        resolvePtyId: async () => 'pty-1',
        takePrompt: () => 'do the thing',
        setTimer: (cb, ms) => setTimeout(cb, ms),
        record: (event) => ledger.record(sessionId, event)
      },
      { retryMs: 50, maxAttempts: 3 }
    )
    expect(target).toEqual({ ptyId: 'pty-1', prompt: 'do the thing' })

    const gate = createInjectGate({
      inject: () => {
        // Mirrors `pasteAndSubmit`'s two write points.
        ledger.record(sessionId, { type: 'paste-written' })
        ledger.record(sessionId, { type: 'submit-written' })
      },
      quietMs: 500,
      capMs: 2500,
      setTimer: vi.fn() as unknown as (cb: () => void, ms: number) => ReturnType<typeof setTimeout>,
      clearTimer: vi.fn(),
      record: (event) => ledger.record(sessionId, event)
    })
    gate.signalReady() // the composer-ready hook fires

    expect(ledger.getTrail(sessionId).map((e) => e.type)).toEqual([
      'target-resolved',
      'prompt-dequeued',
      'gate-fired',
      'paste-written',
      'submit-written'
    ])
    // The injected/dequeued distinction: this trail's terminal verdict is
    // "injected", not merely "dequeued" — exactly what BUG-61 needs to read
    // that today's `injectionVerdict` cannot.
    expect(ledger.statusFor(sessionId)).toBe('injected')
    expect(ledger.wasInjected(sessionId)).toBe(true)
  })

  it('records which of the three inputs fired the gate (quiescence)', async () => {
    const ledger = createInjectionLedger()
    let quietCb: (() => void) | null = null
    const gate = createInjectGate({
      inject: () => {},
      quietMs: 500,
      capMs: 2500,
      setTimer: ((cb: () => void) => {
        quietCb = cb
        return 0 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as (cb: () => void, ms: number) => ReturnType<typeof setTimeout>,
      clearTimer: () => {},
      record: (event) => ledger.record('s1', event)
    })
    gate.onData() // arms the quiescence timer
    quietCb?.() // simulate the banner going silent
    const fired = ledger.getTrail('s1').find((e) => e.type === 'gate-fired')
    expect(fired).toMatchObject({ type: 'gate-fired', via: 'quiescence' })
  })

  it('records the hard cap as the trigger when nothing else fires', () => {
    const ledger = createInjectionLedger()
    let capCb: (() => void) | null = null
    createInjectGate({
      inject: () => {},
      quietMs: 500,
      capMs: 2500,
      setTimer: ((cb: () => void) => {
        capCb = cb
        return 0 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as (cb: () => void, ms: number) => ReturnType<typeof setTimeout>,
      clearTimer: () => {},
      record: (event) => ledger.record('s1', event)
    })
    capCb?.() // simulate the cap timer firing with nothing else having settled
    const fired = ledger.getTrail('s1').find((e) => e.type === 'gate-fired')
    expect(fired).toMatchObject({ type: 'gate-fired', via: 'cap' })
  })

  it('BUG-64: with requireComposerReadyHook, the cap records gate-escalated instead of pasting', () => {
    const ledger = createInjectionLedger()
    let capCb: (() => void) | null = null
    const gate = createInjectGate({
      inject: () => {
        throw new Error('must not blind-paste when a composer-ready hook is required')
      },
      quietMs: 500,
      capMs: 2500,
      setTimer: ((cb: () => void) => {
        capCb = cb
        return 0 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as (cb: () => void, ms: number) => ReturnType<typeof setTimeout>,
      clearTimer: () => {},
      record: (event) => ledger.record('s1', event),
      requireComposerReadyHook: true
    })
    capCb?.()
    expect(ledger.getTrail('s1')).toEqual([
      expect.objectContaining({ type: 'gate-escalated', via: 'cap' })
    ])
    expect(ledger.statusFor('s1')).toBe('escalated')
    expect(ledger.wasInjected('s1')).toBe(false)
    // The gate is settled — a hook that arrives after this point is inert.
    gate.signalReady()
    expect(ledger.getTrail('s1')).toHaveLength(1)
  })

  it('records gate-cancelled and lands on status "cancelled" when pty:exit aborts before injection', () => {
    const ledger = createInjectionLedger()
    const gate = createInjectGate({
      inject: () => {
        throw new Error('must not inject after cancel')
      },
      quietMs: 500,
      capMs: 2500,
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
      record: (event) => ledger.record('s1', event)
    })
    gate.cancel() // pty:exit fired before the composer was ever ready
    expect(ledger.getTrail('s1').map((e) => e.type)).toEqual(['gate-cancelled'])
    expect(ledger.statusFor('s1')).toBe('cancelled')
  })

  it('a failed target resolve records target-resolve-failed with the attempt number, not target-resolved', async () => {
    const ledger = createInjectionLedger()
    const sessionId = 's1'
    await acquireInjectionTargetWithRetry(
      {
        hasPrompt: () => true,
        resolvePtyId: async () => null,
        takePrompt: () => 'unreachable',
        setTimer: (cb) => {
          cb()
          return 0 as unknown as ReturnType<typeof setTimeout>
        },
        record: (event) => ledger.record(sessionId, event)
      },
      { retryMs: 10, maxAttempts: 3 }
    )
    const trail = ledger.getTrail(sessionId)
    expect(trail.map((e) => e.type)).toEqual([
      'target-resolve-failed',
      'target-resolve-failed',
      'target-resolve-failed'
    ])
    expect(trail.map((e) => ('attempt' in e ? e.attempt : undefined))).toEqual([1, 2, 3])
    // Left queued, never dequeued — the trail must not claim delivery.
    expect(ledger.statusFor(sessionId)).toBe('none')
  })

  it('a promptless (normal) session emits NOTHING — the ledger stays empty', async () => {
    const ledger = createInjectionLedger()
    const sessionId = 'normal-session'
    const resolvePtyId = vi.fn(async () => 'pty-1')
    const takePrompt = vi.fn(() => 'should never be read')

    const target = await acquireInjectionTargetWithRetry(
      {
        hasPrompt: () => false,
        resolvePtyId,
        takePrompt,
        setTimer: (cb, ms) => setTimeout(cb, ms),
        record: (event) => ledger.record(sessionId, event)
      },
      { retryMs: 50, maxAttempts: 3 }
    )

    expect(target).toBeNull()
    expect(resolvePtyId).not.toHaveBeenCalled()
    expect(takePrompt).not.toHaveBeenCalled()
    // `createInjectGate` is only ever constructed by the shell after a target
    // resolves (see `armInjectGate` in TerminalPane.vue) — a promptless session
    // never reaches it, so there is nothing further to assert here; the trail
    // this call alone could have produced is empty.
    expect(ledger.getTrail(sessionId)).toEqual([])
    expect(ledger.statusFor(sessionId)).toBe('none')
  })
})
