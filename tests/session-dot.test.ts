import { describe, it, expect } from 'vitest'
import { dotFor } from '../src/renderer/src/components/session-dot'

/**
 * Projection of (hook-derived taskState, legacy status, resolved activity) onto a
 * single sidebar dot (design.md §6 — Session status).
 *
 * The hook-only sticky states (needs-input, failed, completed) and the archived
 * flag win first. The working/stuck/idle painting now comes from the canonical
 * `activity` (resolved by `resolveActivity` in `fleet-state.ts`), the SAME source
 * the Fleet board reads — so dot and board agree by construction (BUG-13). `stuck`
 * is the state the old grey dot had no name for.
 */
describe('dotFor', () => {
  it('needs-input overrides everything, including active status + activity', () => {
    expect(dotFor('needs-input', 'active', 'working')).toBe('needs-input')
    expect(dotFor('needs-input', 'idle', 'idle')).toBe('needs-input')
  })

  it('failed and completed override the activity axis too', () => {
    expect(dotFor('failed', 'active', 'working')).toBe('failed')
    expect(dotFor('completed', 'active', 'working')).toBe('completed')
  })

  it('archived status wins over the activity axis (but not over the sticky FSM states)', () => {
    expect(dotFor(undefined, 'archived', 'idle')).toBe('archived')
    // A non-terminal taskState + archived status → archived (status branch beats activity).
    expect(dotFor('working', 'archived', 'working')).toBe('archived')
    // …but a sticky terminal state still wins first.
    expect(dotFor('failed', 'archived', 'idle')).toBe('failed')
  })

  it('working activity → green working dot', () => {
    expect(dotFor('working', 'active', 'working')).toBe('working')
    expect(dotFor(undefined, 'active', 'working')).toBe('working')
  })

  it('BUG-13: a quiet-but-still-working session reads working, not grey idle', () => {
    // status relaxed to idle after 5s, but activity says working (under N).
    expect(dotFor('working', 'idle', 'working')).toBe('working')
  })

  it('stuck activity → the new stuck dot (working gone quiet ≥ N)', () => {
    expect(dotFor('working', 'idle', 'stuck')).toBe('stuck')
  })

  it('idle activity → grey idle dot', () => {
    expect(dotFor('idle', 'idle', 'idle')).toBe('idle')
    expect(dotFor('stopped', 'idle', 'idle')).toBe('idle')
    expect(dotFor(undefined, 'idle', 'idle')).toBe('idle')
  })

  it('T91: a transcript needs-input (no hook) shows the amber needs-input dot', () => {
    expect(dotFor(undefined, 'idle', 'idle', 'needs-input')).toBe('needs-input')
  })

  it('T91: a live hook keeps priority — transcript needs-input does not override it', () => {
    // Hook says the model resumed working; the on-disk tail lags → still working.
    expect(dotFor('working', 'active', 'working', 'needs-input')).toBe('working')
  })
})
