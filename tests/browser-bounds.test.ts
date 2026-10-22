/**
 * T568 (browser pane U1) — view geometry: edge rounding (spec §2.3), parking, overlay intersection and
 * the freeze capture rule (§2.4).
 */
import { describe, it, expect } from 'vitest'
import {
  FREEZE_JPEG_QUALITY,
  PARKED_METRICS,
  freezeCaptureRect,
  needsFreeze,
  parkedBounds,
  placeView,
  rectsIntersect,
  toViewBounds
} from '../src/main/browser/bounds'

describe('toViewBounds (edge rounding)', () => {
  it('is the identity at zoom 1 for integer rects', () => {
    expect(toViewBounds({ x: 10, y: 20, width: 300, height: 200 }, 1)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200
    })
  })

  it('rounds edges, not x and width separately, so the far edge cannot drift', () => {
    // x=10.4, w=100.4 at zoom 1: x0=10, x1=round(110.8)=111 → width 101 (separate rounding would give 100).
    const b = toViewBounds({ x: 10.4, y: 0, width: 100.4, height: 50 }, 1)
    expect(b.x + b.width).toBe(111)
    expect(b.width).toBe(101)
  })

  it('applies the window zoom factor before rounding', () => {
    const b = toViewBounds({ x: 100, y: 50, width: 400, height: 300 }, 1.25)
    expect(b).toEqual({ x: 125, y: 63, width: 500, height: 375 })
    expect(b.y + b.height).toBe(Math.round(350 * 1.25))
  })

  it('keeps the right and bottom edges where they would round for every fractional zoom', () => {
    for (const f of [0.8, 1.1, 1.25, 1.33, 1.5]) {
      const r = { x: 17.3, y: 41.7, width: 333.3, height: 222.2 }
      const b = toViewBounds(r, f)
      expect(b.x + b.width).toBe(Math.round((r.x + r.width) * f))
      expect(b.y + b.height).toBe(Math.round((r.y + r.height) * f))
    }
  })

  it('never returns a negative size and survives a bad zoom factor', () => {
    expect(toViewBounds({ x: 5, y: 5, width: -3, height: 0 }, 1).width).toBe(0)
    expect(toViewBounds({ x: 5, y: 5, width: 10, height: 10 }, 0)).toEqual({
      x: 5,
      y: 5,
      width: 10,
      height: 10
    })
    expect(toViewBounds({ x: 5, y: 5, width: 10, height: 10 }, Number.NaN).width).toBe(10)
  })
})

describe('parking', () => {
  it('parks 1×1 in the bottom-right corner of the content area', () => {
    expect(parkedBounds({ width: 1280, height: 800 })).toEqual({
      x: 1279,
      y: 799,
      width: 1,
      height: 1
    })
    expect(parkedBounds({ width: 0, height: 0 })).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })

  it('pairs with a 1280×800 DPR 1 metrics override (U0 A3)', () => {
    expect(PARKED_METRICS).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1 })
  })
})

describe('needsFreeze', () => {
  const pane = { x: 400, y: 100, width: 600, height: 500 }

  it('freezes when an overlay intersects the pane, and not when it is clear of it', () => {
    expect(needsFreeze(pane, [{ x: 900, y: 50, width: 200, height: 100 }])).toBe(true)
    expect(needsFreeze(pane, [{ x: 0, y: 0, width: 300, height: 800 }])).toBe(false)
  })

  it('treats touching edges as clear', () => {
    expect(needsFreeze(pane, [{ x: 1000, y: 100, width: 50, height: 50 }])).toBe(false)
  })

  it('freezes for a fullscreen layer and ignores empty rects', () => {
    expect(needsFreeze(pane, ['fullscreen'])).toBe(true)
    expect(needsFreeze(pane, [{ x: 500, y: 200, width: 0, height: 0 }])).toBe(false)
    expect(needsFreeze(pane, [])).toBe(false)
  })

  it('judges a parked 1×1 view on its corner, so a toast in that corner hides it', () => {
    const parked = parkedBounds({ width: 1280, height: 800 })
    expect(needsFreeze(parked, [{ x: 1000, y: 700, width: 280, height: 100 }])).toBe(true)
    expect(needsFreeze(parked, [{ x: 0, y: 0, width: 300, height: 800 }])).toBe(false)
  })

  it('rectsIntersect is symmetric', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 }
    const b = { x: 5, y: 5, width: 10, height: 10 }
    expect(rectsIntersect(a, b)).toBe(rectsIntersect(b, a))
  })
})

describe('freeze capture', () => {
  it('crops to the view bounds in device mode and captures the whole view otherwise', () => {
    const bounds = { x: 400, y: 120, width: 195, height: 422 }
    expect(freezeCaptureRect(bounds, true)).toEqual({ x: 0, y: 0, width: 195, height: 422 })
    expect(freezeCaptureRect(bounds, false)).toBeUndefined()
  })

  it('encodes as JPEG 80 (U0 A12)', () => {
    expect(FREEZE_JPEG_QUALITY).toBe(80)
  })
})

describe('placeView (AC-3: parking, unparking, hiding)', () => {
  const content = { width: 1280, height: 800 }
  const real = { x: 400, y: 100, width: 600, height: 500 }
  const base = {
    parked: true,
    rect: null,
    visible: false,
    frozen: false,
    zoomFactor: 1,
    content,
    current: { x: 0, y: 0, width: 0, height: 0 }
  }

  it('keeps an agent-opened pane for an unviewed folder PARKED: attached, visible, 1×1 in the corner', () => {
    // The pane never mounted, so the renderer never reported a rect.
    expect(placeView(base)).toEqual({
      bounds: { x: 1279, y: 799, width: 1, height: 1 },
      visible: true,
      parked: true,
      clearParkedMetrics: false
    })
  })

  it('stays parked while the renderer reports it hidden or with no area (a folder that is not selected)', () => {
    for (const input of [
      { ...base, rect: real, visible: false },
      { ...base, rect: { x: 0, y: 0, width: 0, height: 0 }, visible: true }
    ]) {
      expect(placeView(input)).toMatchObject({ parked: true, visible: true })
    }
  })

  it('unparks on the first real rect: the override is cleared and the view takes the rounded rect', () => {
    expect(placeView({ ...base, rect: real, visible: true })).toEqual({
      bounds: { x: 400, y: 100, width: 600, height: 500 },
      visible: true,
      parked: false,
      clearParkedMetrics: true
    })
    // Fractional zoom rounds by edges.
    expect(placeView({ ...base, rect: real, visible: true, zoomFactor: 1.25 }).bounds).toEqual({
      x: 500,
      y: 125,
      width: 750,
      height: 625
    })
  })

  it('a pane that has painted and is then hidden is just hidden, at the bounds it had', () => {
    const current = { x: 400, y: 100, width: 600, height: 500 }
    expect(placeView({ ...base, parked: false, rect: real, visible: false, current })).toEqual({
      bounds: current,
      visible: false,
      parked: false,
      clearParkedMetrics: false
    })
  })

  it('an overlay hides a parked corner and a live view alike (frozen)', () => {
    expect(placeView({ ...base, frozen: true })).toMatchObject({ parked: true, visible: false })
    expect(
      placeView({ ...base, parked: false, rect: real, visible: true, frozen: true })
    ).toMatchObject({
      visible: false,
      parked: false
    })
  })

  it('never reports an unparked pane as clearing the override twice', () => {
    expect(
      placeView({ ...base, parked: false, rect: real, visible: true }).clearParkedMetrics
    ).toBe(false)
  })
})
