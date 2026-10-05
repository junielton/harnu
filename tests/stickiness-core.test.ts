import { describe, it, expect } from 'vitest'
import { applyStickiness } from '../src/main/detect/stickiness-core'

/**
 * T3 — `applyStickiness` is the anti-flicker guard. The invariants pinned here:
 *
 *   - a `needs-input` (blocked) pane HOLDS until the screen actually changes — a
 *     spinner frame (screenChanged=false) must not un-block it;
 *   - once the screen DOES change, the freshly-merged `next` is accepted;
 *   - `working ↔ idle` carry no stickiness — they flip freely either way.
 */

describe('applyStickiness — blocked holds until the screen changes', () => {
  it('holds needs-input when the screen is unchanged, even if next says working', () => {
    expect(applyStickiness('needs-input', 'working', false)).toBe('needs-input')
  })

  it('holds needs-input when the screen is unchanged, even if next says idle', () => {
    expect(applyStickiness('needs-input', 'idle', false)).toBe('needs-input')
  })

  it('accepts the new state once the screen changes (prompt answered → working)', () => {
    expect(applyStickiness('needs-input', 'working', true)).toBe('working')
  })

  it('accepts a change that stays blocked (a new prompt) when the screen changed', () => {
    expect(applyStickiness('needs-input', 'needs-input', true)).toBe('needs-input')
  })
})

describe('applyStickiness — working ↔ idle flip freely (no stickiness)', () => {
  it('working → idle flips even without a screen change', () => {
    expect(applyStickiness('working', 'idle', false)).toBe('idle')
  })

  it('idle → working flips even without a screen change', () => {
    expect(applyStickiness('idle', 'working', false)).toBe('working')
  })

  it('working → needs-input is adopted immediately (entering blocked is not gated)', () => {
    expect(applyStickiness('working', 'needs-input', false)).toBe('needs-input')
  })

  it('idle → needs-input is adopted immediately', () => {
    expect(applyStickiness('idle', 'needs-input', false)).toBe('needs-input')
  })
})
