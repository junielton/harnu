import { describe, it, expect } from 'vitest'
import {
  bootVerdict,
  shouldReapAtDeadline,
  shouldReapUndeliveredPrompt,
  AGENT_BOOT_TIMEOUT_MS,
  type BootProbe
} from '../src/renderer/src/stores/synthetic-reaper'

/**
 * Pure verdict tests for the dead-synthetic reaper (BUG-23). The timeout
 * arithmetic + three-way verdict are framework-free, so they unit-test in the
 * `node` env exactly like `fleet-state` / `closure-core`.
 */
describe('bootVerdict', () => {
  const base: BootProbe = {
    present: true,
    isLive: false,
    elapsedMs: 0,
    timeoutMs: AGENT_BOOT_TIMEOUT_MS
  }

  it('is pending within the window with no PTY yet', () => {
    expect(bootVerdict({ ...base, elapsedMs: 0 })).toBe('pending')
    expect(bootVerdict({ ...base, elapsedMs: AGENT_BOOT_TIMEOUT_MS - 1 })).toBe('pending')
  })

  it('fails once the elapsed time crosses the ceiling with no PTY', () => {
    expect(bootVerdict({ ...base, elapsedMs: AGENT_BOOT_TIMEOUT_MS })).toBe('failed')
    expect(bootVerdict({ ...base, elapsedMs: AGENT_BOOT_TIMEOUT_MS + 10_000 })).toBe('failed')
  })

  it('is booted the instant a live PTY exists — never falsely failed, even past the ceiling', () => {
    // A slow-but-live session (PTY up, JSONL not written yet) must never be reaped.
    expect(bootVerdict({ ...base, isLive: true, elapsedMs: 0 })).toBe('booted')
    expect(bootVerdict({ ...base, isLive: true, elapsedMs: AGENT_BOOT_TIMEOUT_MS * 10 })).toBe(
      'booted'
    )
  })

  it('is booted once the row is gone (migrated to a real uuid / dismissed)', () => {
    expect(bootVerdict({ ...base, present: false, elapsedMs: AGENT_BOOT_TIMEOUT_MS })).toBe(
      'booted'
    )
    // liveness is irrelevant when the row is no longer a tracked synthetic.
    expect(bootVerdict({ ...base, present: false, isLive: false, elapsedMs: 0 })).toBe('booted')
  })

  it('liveness/absence win over the timeout (checked before the ceiling)', () => {
    // Present + live past the ceiling → booted, not failed.
    expect(
      bootVerdict({ present: true, isLive: true, elapsedMs: AGENT_BOOT_TIMEOUT_MS, timeoutMs: 1 })
    ).toBe('booted')
  })
})

describe('shouldReapAtDeadline', () => {
  it('reaps only a still-present, PTY-less synthetic', () => {
    expect(shouldReapAtDeadline(true, false)).toBe(true)
  })

  it('never reaps a live session', () => {
    expect(shouldReapAtDeadline(true, true)).toBe(false)
  })

  it('never reaps a migrated/removed row', () => {
    expect(shouldReapAtDeadline(false, false)).toBe(false)
    expect(shouldReapAtDeadline(false, true)).toBe(false)
  })
})

/**
 * BUG-60: the sibling verdict for a live-PTY synthetic whose queued pre-prompt
 * was never confirmed delivered — the case `bootVerdict` alone treats as
 * unconditional success and `shouldReapAtDeadline` never reaches.
 */
describe('shouldReapUndeliveredPrompt', () => {
  it('never reaps a session with no prompt ever queued (the common, promptless case)', () => {
    expect(shouldReapUndeliveredPrompt({ promptQueued: false, ledgerStatus: 'none' })).toBe(false)
  })

  it('never reaps once the ledger confirms the paste actually landed', () => {
    expect(shouldReapUndeliveredPrompt({ promptQueued: false, ledgerStatus: 'injected' })).toBe(
      false
    )
    // Even a stale `promptQueued: true` (e.g. a racy read) can't override a
    // confirmed injection — `injected` is checked first.
    expect(shouldReapUndeliveredPrompt({ promptQueued: true, ledgerStatus: 'injected' })).toBe(
      false
    )
  })

  it('reaps a prompt still queued and never even acquired', () => {
    expect(shouldReapUndeliveredPrompt({ promptQueued: true, ledgerStatus: 'none' })).toBe(true)
  })

  it("reaps a prompt dequeued but never pasted (D2's exact blind spot)", () => {
    expect(shouldReapUndeliveredPrompt({ promptQueued: false, ledgerStatus: 'dequeued' })).toBe(
      true
    )
  })

  it('reaps a cancelled gate that never injected', () => {
    expect(shouldReapUndeliveredPrompt({ promptQueued: false, ledgerStatus: 'cancelled' })).toBe(
      true
    )
  })
})
