import { describe, it, expect } from 'vitest'
import {
  ERASE_REACH_PX,
  eraseReach,
  eraseRemovalOrder,
  edgeWithinReach,
  strokeSamples
} from '../src/renderer/src/components/canvas/canvas-erase'

/** T536 U1 — the Eraser's pure hit-test decisions (spec §5, Eraser row). */

describe('eraseReach', () => {
  it('is 6 screen pixels, converted to world units by the zoom', () => {
    expect(ERASE_REACH_PX).toBe(6)
    expect(eraseReach(1)).toBe(6)
    expect(eraseReach(2)).toBe(3)
    expect(eraseReach(0.5)).toBe(12)
  })

  it('never divides by a zero or negative zoom', () => {
    expect(eraseReach(0)).toBe(6)
    expect(eraseReach(-1)).toBe(6)
  })
})

describe('strokeSamples', () => {
  it('a still pointer samples just the point it is on', () => {
    expect(strokeSamples({ x: 5, y: 5 }, { x: 5, y: 5 }, 6)).toEqual([{ x: 5, y: 5 }])
  })

  it('a short move samples only its end: the start was probed by the previous move', () => {
    expect(strokeSamples({ x: 0, y: 0 }, { x: 4, y: 0 }, 6)).toEqual([{ x: 4, y: 0 }])
  })

  it('a fast move is filled in, no gap wider than the step, ending exactly on the pointer', () => {
    const pts = strokeSamples({ x: 0, y: 0 }, { x: 30, y: 40 }, 6) // 50 long
    expect(pts[pts.length - 1]).toEqual({ x: 30, y: 40 })
    expect(pts).toHaveLength(9) // ceil(50 / 6)
    let prev = { x: 0, y: 0 }
    for (const p of pts) {
      expect(Math.hypot(p.x - prev.x, p.y - prev.y)).toBeLessThanOrEqual(6 + 1e-9)
      prev = p
    }
    // The start is not repeated.
    expect(pts[0]).not.toEqual({ x: 0, y: 0 })
  })

  it('a non-positive step degrades to the end point instead of looping forever', () => {
    expect(strokeSamples({ x: 0, y: 0 }, { x: 100, y: 0 }, 0)).toEqual([{ x: 100, y: 0 }])
  })
})

describe('edgeWithinReach', () => {
  it('a point on or within reach of the path hits', () => {
    expect(edgeWithinReach({ x: 10, y: 10 }, { x: 10, y: 10 }, 6)).toBe(true)
    expect(edgeWithinReach({ x: 10, y: 16 }, { x: 10, y: 10 }, 6)).toBe(true)
  })

  it('a point past reach misses', () => {
    expect(edgeWithinReach({ x: 10, y: 16.5 }, { x: 10, y: 10 }, 6)).toBe(false)
  })

  it('an edge with no rendered path cannot be hit', () => {
    expect(edgeWithinReach({ x: 0, y: 0 }, null, 6)).toBe(false)
  })
})

describe('eraseRemovalOrder', () => {
  it('removes edges before nodes, each group in the order it was marked', () => {
    const marked = new Map<string, 'node' | 'edge'>([
      ['n-a', 'node'],
      ['e-1', 'edge'],
      ['n-b', 'node'],
      ['e-2', 'edge']
    ])
    expect(eraseRemovalOrder(marked)).toEqual(['e-1', 'e-2', 'n-a', 'n-b'])
  })

  it('nothing marked, nothing removed', () => {
    expect(eraseRemovalOrder(new Map())).toEqual([])
  })
})
