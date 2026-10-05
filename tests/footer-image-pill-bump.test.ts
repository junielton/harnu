import { describe, it, expect } from 'vitest'
import { shouldBumpImagePill } from '../src/renderer/src/components/StatusFooter.vue'

/**
 * T186 — the Pasted-images pill "pop" trigger (design.md §7). The rule is
 * narrower than "the count changed": it must fire ONLY when a new screenshot
 * lands for the session already on screen. These cases pin the four boundaries
 * the spec calls out, so a future refactor can't quietly widen it into a bump
 * on every session switch.
 */

const A = '11111111-2222-4333-8444-555555555555'
const B = 'aaaaaaaa-2222-4333-8444-555555555555'

describe('shouldBumpImagePill', () => {
  it('bumps on a real increment for the session already on screen', () => {
    expect(shouldBumpImagePill({ uuid: A, count: 2, lastUuid: A, lastCount: 1 })).toBe(true)
    expect(shouldBumpImagePill({ uuid: A, count: 3, lastUuid: A, lastCount: 2 })).toBe(true)
    // A jump of more than one (two pastes inside a single poll window) still counts.
    expect(shouldBumpImagePill({ uuid: A, count: 5, lastUuid: A, lastCount: 2 })).toBe(true)
  })

  it('does NOT bump on the first image ever for a session (0 → 1)', () => {
    // Already covered by the pill's own hide-when-zero fade-in.
    expect(shouldBumpImagePill({ uuid: A, count: 1, lastUuid: A, lastCount: 0 })).toBe(false)
  })

  it('does NOT bump on a session switch, even into a session with more images', () => {
    expect(shouldBumpImagePill({ uuid: B, count: 9, lastUuid: A, lastCount: 1 })).toBe(false)
    // …and not on the way out of a session either (no uuid → count 0).
    expect(shouldBumpImagePill({ uuid: null, count: 0, lastUuid: A, lastCount: 3 })).toBe(false)
  })

  it('does NOT bump on a poll tick that found the same count, or a pruned image', () => {
    expect(shouldBumpImagePill({ uuid: A, count: 3, lastUuid: A, lastCount: 3 })).toBe(false)
    expect(shouldBumpImagePill({ uuid: A, count: 2, lastUuid: A, lastCount: 3 })).toBe(false)
  })
})
