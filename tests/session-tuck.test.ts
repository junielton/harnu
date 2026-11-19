import { describe, it, expect } from 'vitest'
import { SESSION_TUCK_ARM_PX, resolveDividerDrag } from '../src/renderer/src/lib/session-tuck'
import { SPLIT_RATIO_MAX, SPLIT_RATIO_MIN } from '../src/renderer/src/lib/split-orientation'

/**
 * T790 AC-1 — dragging the divider past the 0.4 floor. Short of the threshold the ratio sits at the
 * floor and releasing springs back; past it the drag is armed and releasing tucks the session away.
 * The drag axis is X side by side and Y stacked: the maths only sees the row's size along it.
 */
describe('resolveDividerDrag', () => {
  const FLOOR_PX = (total: number, start: number): number => (start - SPLIT_RATIO_MIN) * total

  it('arms at 80px', () => {
    expect(SESSION_TUCK_ARM_PX).toBe(80)
  })

  it('follows the pointer inside the normal range, never armed', () => {
    const r = resolveDividerDrag({ startRatio: 0.65, deltaPx: -100, totalPx: 1000 })
    expect(r.ratio).toBeCloseTo(0.55, 10)
    expect(r.armed).toBe(false)
  })

  it('stops at the floor when dragged exactly onto it', () => {
    const r = resolveDividerDrag({
      startRatio: 0.65,
      deltaPx: -FLOOR_PX(1000, 0.65),
      totalPx: 1000
    })
    expect(r.ratio).toBeCloseTo(SPLIT_RATIO_MIN, 10)
    expect(r.armed).toBe(false)
  })

  it('holds the floor and does not arm while the overshoot is under the threshold', () => {
    const over = SESSION_TUCK_ARM_PX - 1
    const r = resolveDividerDrag({
      startRatio: 0.65,
      deltaPx: -(FLOOR_PX(1000, 0.65) + over),
      totalPx: 1000
    })
    expect(r.ratio).toBe(SPLIT_RATIO_MIN)
    expect(r.armed).toBe(false)
  })

  it('arms once the overshoot reaches the threshold, the ratio still at the floor', () => {
    const r = resolveDividerDrag({
      startRatio: 0.65,
      deltaPx: -(FLOOR_PX(1000, 0.65) + SESSION_TUCK_ARM_PX),
      totalPx: 1000
    })
    expect(r.ratio).toBe(SPLIT_RATIO_MIN)
    expect(r.armed).toBe(true)
  })

  it('stays armed however far the divider is pulled', () => {
    const r = resolveDividerDrag({ startRatio: 0.65, deltaPx: -5000, totalPx: 1000 })
    expect(r.ratio).toBe(SPLIT_RATIO_MIN)
    expect(r.armed).toBe(true)
  })

  it('springs back: pulling back under the threshold disarms', () => {
    const base = { startRatio: 0.65, totalPx: 1000 }
    const armed = resolveDividerDrag({ ...base, deltaPx: -(FLOOR_PX(1000, 0.65) + 120) })
    const back = resolveDividerDrag({ ...base, deltaPx: -(FLOOR_PX(1000, 0.65) + 40) })
    expect(armed.armed).toBe(true)
    expect(back.armed).toBe(false)
  })

  it('measures the threshold in pixels, so a short stacked row arms at the same 80px', () => {
    // Stacked: the row's height is the axis, 600px here.
    const total = 600
    const under = resolveDividerDrag({
      startRatio: 0.65,
      deltaPx: -(FLOOR_PX(total, 0.65) + 79),
      totalPx: total
    })
    const at = resolveDividerDrag({
      startRatio: 0.65,
      deltaPx: -(FLOOR_PX(total, 0.65) + 80),
      totalPx: total
    })
    expect(under.armed).toBe(false)
    expect(at.armed).toBe(true)
  })

  it('starts armed-ready from the floor itself: 80px from a ratio of 0.4', () => {
    expect(resolveDividerDrag({ startRatio: 0.4, deltaPx: -79, totalPx: 1000 }).armed).toBe(false)
    expect(resolveDividerDrag({ startRatio: 0.4, deltaPx: -80, totalPx: 1000 }).armed).toBe(true)
  })

  it('keeps the 0.8 ceiling of a normal drag and never arms on the way out', () => {
    const r = resolveDividerDrag({ startRatio: 0.65, deltaPx: 900, totalPx: 1000 })
    expect(r.ratio).toBe(SPLIT_RATIO_MAX)
    expect(r.armed).toBe(false)
  })

  it('never arms on an unmeasured row', () => {
    const r = resolveDividerDrag({ startRatio: 0.65, deltaPx: -5000, totalPx: 0 })
    expect(r.armed).toBe(false)
    expect(r.ratio).toBeGreaterThanOrEqual(SPLIT_RATIO_MIN)
    expect(r.ratio).toBeLessThanOrEqual(SPLIT_RATIO_MAX)
  })
})
