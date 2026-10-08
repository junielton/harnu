import { describe, it, expect } from 'vitest'
import {
  squarify,
  foldSmall,
  floorShares,
  type Rect,
  type TreemapItem
} from '../src/renderer/src/lib/gc-treemap'

const BOX: Rect = { x: 0, y: 0, w: 100, h: 60 }

const area = (r: Rect): number => r.w * r.h
const items = (...values: number[]): TreemapItem[] =>
  values.map((value, i) => ({ id: `b${i}`, value }))

function overlaps(a: Rect, b: Rect): boolean {
  const eps = 1e-6
  return (
    a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps
  )
}

describe('squarify', () => {
  it('returns nothing for no items or an empty box', () => {
    expect(squarify([], BOX)).toEqual([])
    expect(squarify(items(5), { x: 0, y: 0, w: 0, h: 10 })).toEqual([])
  })

  it('gives a single item the whole box', () => {
    const out = squarify(items(7), BOX)
    expect(out).toHaveLength(1)
    expect(out[0].rect).toEqual(BOX)
  })

  it('sizes every rectangle in proportion to its value and fills the box', () => {
    const vs = [6, 6, 4, 3, 2, 2, 1]
    const out = squarify(items(...vs), BOX)
    const total = vs.reduce((a, b) => a + b, 0)
    for (const o of out) {
      const v = vs[Number(o.id.slice(1))]
      expect(area(o.rect)).toBeCloseTo((v / total) * area(BOX), 4)
    }
    expect(out.reduce((a, o) => a + area(o.rect), 0)).toBeCloseTo(area(BOX), 4)
  })

  it('keeps every rectangle inside the box and never overlaps two of them', () => {
    const out = squarify(items(29, 17, 10, 8, 8, 5, 3, 3, 2, 1, 1), {
      x: 10,
      y: 20,
      w: 300,
      h: 120
    })
    for (const o of out) {
      expect(o.rect.x).toBeGreaterThanOrEqual(10 - 1e-6)
      expect(o.rect.y).toBeGreaterThanOrEqual(20 - 1e-6)
      expect(o.rect.x + o.rect.w).toBeLessThanOrEqual(310 + 1e-6)
      expect(o.rect.y + o.rect.h).toBeLessThanOrEqual(140 + 1e-6)
    }
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++)
        expect(overlaps(out[i].rect, out[j].rect)).toBe(false)
  })

  it('is deterministic and breaks ties by id, so order is stable between scans', () => {
    const a = squarify(
      [
        { id: 'z', value: 5 },
        { id: 'a', value: 5 },
        { id: 'm', value: 5 }
      ],
      BOX
    )
    const b = squarify(
      [
        { id: 'a', value: 5 },
        { id: 'm', value: 5 },
        { id: 'z', value: 5 }
      ],
      BOX
    )
    expect(a.map((o) => o.id)).toEqual(['a', 'm', 'z'])
    expect(a).toEqual(b)
  })

  it('drops items with no size instead of drawing zero-area blocks', () => {
    const out = squarify(items(4, 0, -3, Number.NaN, 2), BOX)
    expect(out.map((o) => o.id).sort()).toEqual(['b0', 'b4'])
  })

  it('produces reasonably square blocks (worst aspect ratio stays small)', () => {
    const out = squarify(items(30, 20, 15, 10, 10, 8, 4, 3), { x: 0, y: 0, w: 400, h: 300 })
    const worst = Math.max(...out.map((o) => Math.max(o.rect.w / o.rect.h, o.rect.h / o.rect.w)))
    expect(worst).toBeLessThan(4)
  })
})

describe('foldSmall', () => {
  it('folds the long tail below the threshold into one aggregate', () => {
    const { kept, folded } = foldSmall(items(900, 500, 100, 90, 80), 256)
    expect(kept.map((i) => i.id)).toEqual(['b0', 'b1'])
    expect(folded.map((i) => i.id)).toEqual(['b2', 'b3', 'b4'])
  })

  it('does not fold a single small item — an aggregate of one is just noise', () => {
    const { kept, folded } = foldSmall(items(900, 100), 256)
    expect(kept.map((i) => i.id)).toEqual(['b0', 'b1'])
    expect(folded).toEqual([])
  })

  it('keeps everything when nothing is small', () => {
    expect(foldSmall(items(900, 400), 256).folded).toEqual([])
  })
})

describe('floorShares', () => {
  it('normalizes to 1 and lifts a sliver to the floor', () => {
    const shares = floorShares([29, 1.9, 1], 0.15)
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    expect(Math.min(...shares)).toBeGreaterThanOrEqual(0.15 - 1e-6)
    expect(shares[0]).toBeGreaterThan(shares[1])
  })

  it('leaves proportional shares alone when none is under the floor', () => {
    const shares = floorShares([3, 1], 0.1)
    expect(shares[0]).toBeCloseTo(0.75, 6)
    expect(shares[1]).toBeCloseTo(0.25, 6)
  })

  it('handles zero totals and the empty list', () => {
    expect(floorShares([], 0.1)).toEqual([])
    const z = floorShares([0, 0], 0.1)
    expect(z[0]).toBeCloseTo(0.5, 6)
  })
})
