import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * BUG-32: a parked confirm never reached the modal, even after the operator
 * returned. `confirm-core.ts` stamped the render `mode` once, at park time
 * (`deps.isFocused?.() ? 'modal' : 'parked'`), with no promotion path — the
 * operator's return was not an event anything listened to.
 *
 * This covers the fix's pure core surface: `promotePending()` (D1/D2/D5),
 * `dismiss()` (D3 — never denies, never settles) and `advanceFocusEpoch()`
 * (D4 — a dismissed confirm doesn't immediately re-promote).
 */
import {
  createConfirmCore,
  PARK_TTL_MS,
  type ConfirmDisclosure,
  type ConfirmWire,
  type ConfirmOutcome,
  type ConfirmCore
} from '../src/main/mcp/confirm-core'

const disclosure = (over: Partial<ConfirmDisclosure> = {}): ConfirmDisclosure => ({
  prompt: over.prompt ?? 'Allow agent to boot with elevated flags?',
  permissionMode: over.permissionMode ?? 'default',
  nonDefaultFlags: over.nonDefaultFlags ?? []
})

function makeCore(opts: { send?: (w: ConfirmWire) => boolean; focused?: boolean } = {}) {
  const send = vi.fn(opts.send ?? (() => true))
  const onSettled = vi.fn()
  const core = createConfirmCore({
    send,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h),
    now: () => Date.now(),
    isFocused: () => opts.focused ?? true,
    onSettled
  })
  return { send, onSettled, core }
}

/** Park and assert it went live; return the live fields. */
function parkLive(
  core: ConfirmCore,
  d: ConfirmDisclosure = disclosure()
): { id: string; mode: 'modal' | 'parked'; settled: Promise<ConfirmOutcome> } {
  const r = core.park(d)
  if (r.kind !== 'live') throw new Error(`expected live park, got ${r.kind}`)
  return { id: r.id, mode: r.mode, settled: r.settled }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('parked confirm promotion (D1)', () => {
  it('promotes a still-pending parked confirm to modal on focus regain', () => {
    const { core } = makeCore({ focused: false })
    const { id, mode } = parkLive(core)
    expect(mode).toBe('parked')

    const promoted = core.promotePending()

    expect(promoted).toHaveLength(1)
    expect(promoted[0]).toMatchObject({ id, mode: 'modal' })
  })

  it('a confirm that was already modal at park time is not re-emitted by promotePending', () => {
    const { core } = makeCore({ focused: true })
    parkLive(core)
    expect(core.promotePending()).toEqual([])
  })
})

describe('promotePending is idempotent (D2)', () => {
  it('a second call with nothing newly parked returns []', () => {
    const { core } = makeCore({ focused: false })
    parkLive(core)
    expect(core.promotePending()).toHaveLength(1)
    expect(core.promotePending()).toEqual([])
  })

  it('a settled confirm is never returned by promotePending', async () => {
    const { core } = makeCore({ focused: false })
    const { id, settled } = parkLive(core)
    core.respond(id, 'deny')
    await settled
    expect(core.promotePending()).toEqual([])
  })
})

describe('dismiss (D3 — defers, never denies, never settles)', () => {
  it('leaves the confirm pending with no onSettled call and no verdict', async () => {
    const { core, onSettled } = makeCore({ focused: false })
    const { id, settled } = parkLive(core)
    core.promotePending()

    const wire = core.dismiss(id)

    expect(wire).not.toBe(false)
    expect(core.pendingCount()).toBe(1)
    expect(onSettled).not.toHaveBeenCalled()
    // the confirm is still live — respond() still works afterwards.
    expect(core.respond(id, 'allow')).toBe('allow')
    await expect(settled).resolves.toEqual({ verdict: 'allow', reason: 'RESPONDED' })
  })

  it('reverts the wire mode back to parked', () => {
    const { core } = makeCore({ focused: false })
    const { id } = parkLive(core)
    core.promotePending()

    const wire = core.dismiss(id)

    expect(wire && wire.mode).toBe('parked')
    expect(core.list().find((w) => w.id === id)?.mode).toBe('parked')
  })

  it('returns false for an id that is not currently modal', () => {
    const { core } = makeCore({ focused: false })
    const { id } = parkLive(core) // still 'parked', never promoted
    expect(core.dismiss(id)).toBe(false)
    expect(core.dismiss('confirm-does-not-exist')).toBe(false)
  })
})

describe('dismissal exclusion until the focus epoch advances (D4)', () => {
  it('a dismissed confirm is excluded from promotePending in the same focus session', () => {
    const { core } = makeCore({ focused: false })
    const { id } = parkLive(core)
    core.promotePending()
    core.dismiss(id)

    // Same focus session (no blur in between) — must not re-promote.
    expect(core.promotePending()).toEqual([])
  })

  it('re-promotes after a blur -> focus cycle (advanceFocusEpoch)', () => {
    const { core } = makeCore({ focused: false })
    const { id } = parkLive(core)
    core.promotePending()
    core.dismiss(id)
    expect(core.promotePending()).toEqual([])

    core.advanceFocusEpoch() // blur
    const promoted = core.promotePending() // next focus event

    expect(promoted).toHaveLength(1)
    expect(promoted[0]).toMatchObject({ id, mode: 'modal' })
  })
})

describe('multiple parked confirms promote in park order (D5)', () => {
  it('returns promoted wires in the order they were parked', () => {
    const { core } = makeCore({ focused: false })
    const a = parkLive(core, disclosure({ prompt: 'first' }))
    const b = parkLive(core, disclosure({ prompt: 'second' }))

    const promoted = core.promotePending()

    expect(promoted.map((w) => w.id)).toEqual([a.id, b.id])
    expect(promoted.map((w) => w.prompt)).toEqual(['first', 'second'])
  })
})

describe('promotion never touches the fail-closed TTL', () => {
  it('a promoted-then-unanswered confirm still denies at PARK_TTL, never earlier', async () => {
    const { core } = makeCore({ focused: false })
    const { settled } = parkLive(core)
    core.promotePending()

    vi.advanceTimersByTime(PARK_TTL_MS - 1)
    expect(core.pendingCount()).toBe(1)
    vi.advanceTimersByTime(1)
    await expect(settled).resolves.toEqual({ verdict: 'deny', reason: 'TTL_EXPIRED' })
  })
})
