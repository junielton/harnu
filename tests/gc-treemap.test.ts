import { describe, it, expect } from 'vitest'
import {
  squarify,
  planShelves,
  packCells,
  layoutMap,
  TM,
  type MapRegionIn,
  floorShares,
  type Rect,
  type TreemapItem
} from '../src/renderer/src/lib/gc-treemap'
import { formatBytes } from '../src/renderer/src/components/system-monitor-format'

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

/** Deterministic pseudo-random sizes, so the fixture is the same on every run. */
function rng(seed: number): () => number {
  let x = seed
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296
    return x / 4294967296
  }
}

/**
 * The operator's real workspace (BUG-171): 11 repos, 170 worktrees, 40 of them in one repo, sizes from
 * 51 MB to 2 GB, spread over the three buckets.
 */
function workspace(): MapRegionIn[] {
  const rand = rng(171)
  const counts = [40, 28, 22, 18, 16, 12, 10, 8, 6, 5, 5]
  const buckets = ['ready', 'review', 'in-use']
  return counts.map((n, r) => {
    const groups = buckets.map((b) => ({
      id: b,
      bytes: 0,
      items: [] as { id: string; value: number }[]
    }))
    for (let i = 0; i < n; i++) {
      const bytes = Math.round(51e6 * Math.pow(2e9 / 51e6, rand()))
      const g = groups[i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 2]
      g.items.push({ id: `r${r}-w${i}`, value: bytes })
      g.bytes += bytes
    }
    const present = groups.filter((g) => g.items.length > 0)
    return { id: `/w/repo${r}`, bytes: present.reduce((a, g) => a + g.bytes, 0), groups: present }
  })
}

describe('planShelves', () => {
  it('wraps 11 regions onto even shelves and never lays one narrower than the minimum', () => {
    const slots = planShelves(
      workspace().map((r) => ({ id: r.id, value: r.bytes })),
      1298
    )
    const perRow = new Map<number, number>()
    for (const s of slots) perRow.set(s.row, (perRow.get(s.row) ?? 0) + 1)
    expect([...perRow.values()]).toEqual([3, 3, 3, 2])
    for (const s of slots) expect(s.w).toBeGreaterThanOrEqual(TM.regionMinW - 1e-6)
  })

  it('fills each shelf edge to edge with a gutter between regions, and widths follow bytes', () => {
    const slots = planShelves(
      [
        { id: 'big', value: 90 },
        { id: 'mid', value: 40 },
        { id: 'small', value: 5 }
      ],
      1298
    )
    const last = slots[slots.length - 1]
    expect(last.x + last.w).toBeCloseTo(1298, 4)
    expect(slots[1].x - (slots[0].x + slots[0].w)).toBeCloseTo(TM.gap, 4)
    expect(slots[0].w).toBeGreaterThan(slots[1].w)
  })

  it('gives a lone region the whole width, and a narrow canvas one region per shelf', () => {
    expect(planShelves([{ id: 'a', value: 1 }], 900)[0].w).toBeCloseTo(900, 4)
    const narrow = planShelves(
      [
        { id: 'a', value: 2 },
        { id: 'b', value: 1 }
      ],
      500
    )
    expect(narrow.map((s) => s.row)).toEqual([0, 1])
  })
})

describe('packCells', () => {
  const MIN = { w: TM.cellMinW, h: TM.cellMinH }
  const box: Rect = { x: 0, y: 0, w: 320, h: 120 }

  it('keeps every cell at least the minimum and folds what cannot be that big', () => {
    const { placed, folded } = packCells(items(900, 700, 300, 120, 80, 60, 50), box, MIN, 'agg')
    expect(folded.length).toBeGreaterThan(0)
    for (const p of placed) {
      expect(p.rect.w).toBeGreaterThanOrEqual(MIN.w - 1e-6)
      expect(p.rect.h).toBeGreaterThanOrEqual(MIN.h - 1e-6)
    }
    expect(placed.some((p) => p.id === 'agg')).toBe(true)
  })

  it('loses no block: every input is either drawn or folded', () => {
    const input = items(900, 700, 300, 120, 80, 60, 50)
    const { placed, folded } = packCells(input, box, MIN, 'agg')
    const seen = [
      ...placed.map((p) => p.id).filter((id) => id !== 'agg'),
      ...folded.map((f) => f.id)
    ]
    expect(seen.sort()).toEqual(input.map((i) => i.id).sort())
  })

  it('grows the aggregate with the next smallest block until it is big enough to read', () => {
    // Two big blocks, then crumbs: the crumbs alone would make an unreadable sliver.
    const { placed } = packCells(
      items(1000, 900, 5, 4, 3),
      { x: 0, y: 0, w: 200, h: 100 },
      MIN,
      'agg'
    )
    for (const p of placed) {
      expect(p.rect.w).toBeGreaterThanOrEqual(MIN.w - 1e-6)
      expect(p.rect.h).toBeGreaterThanOrEqual(MIN.h - 1e-6)
    }
  })

  it('keeps a big block and gives its tiny tail a readable aggregate, however lopsided', () => {
    const { placed, folded } = packCells(
      [
        { id: 'big', value: 4096 },
        { id: 's1', value: 10 },
        { id: 's2', value: 20 },
        { id: 's3', value: 30 }
      ],
      { x: 0, y: 0, w: 996, h: 48 },
      MIN,
      'agg'
    )
    expect(placed.map((p) => p.id).sort()).toEqual(['agg', 'big'])
    expect(folded.map((f) => f.id).sort()).toEqual(['s1', 's2', 's3'])
    for (const p of placed) {
      expect(p.rect.w).toBeGreaterThanOrEqual(MIN.w - 1e-6)
      expect(p.rect.h).toBeGreaterThanOrEqual(MIN.h - 1e-6)
    }
  })

  it('folds a zero-byte block instead of losing it', () => {
    const { placed, folded } = packCells(items(900, 0), box, MIN, 'agg')
    const seen = [
      ...placed.map((p) => p.id).filter((id) => id !== 'agg'),
      ...folded.map((f) => f.id)
    ]
    expect(seen.sort()).toEqual(['b0', 'b1'])
  })

  it('returns nothing for an empty group or box', () => {
    expect(packCells([], box, MIN, 'agg').placed).toEqual([])
    expect(packCells(items(5), { x: 0, y: 0, w: 0, h: 5 }, MIN, 'agg').placed).toEqual([])
  })
})

describe('layoutMap — the BUG-171 workspace (11 repos, 170 worktrees)', () => {
  // Widest size label a block can print ("999.99 MB"), at a generous 6.5px per character for 11px text.
  const WIDEST_LABEL_PX = 9 * 6.5
  const CHROME_PX = 4 + 2 + 12 // cell inset + border + padding

  for (const width of [1298, 1342, 1956]) {
    describe(`at ${width}px`, () => {
      const input = workspace()
      const map = layoutMap(input, width)

      it('lays every region out at least 340px wide, inside the canvas, with a gutter between them', () => {
        expect(map.regions).toHaveLength(11)
        for (const r of map.regions) {
          expect(r.rect.w).toBeGreaterThanOrEqual(TM.regionMinW - 1e-6)
          expect(r.rect.x).toBeGreaterThanOrEqual(0)
          expect(r.rect.x + r.rect.w).toBeLessThanOrEqual(width + 1e-6)
          expect(r.rect.y + r.rect.h).toBeLessThanOrEqual(map.height + 1e-6)
        }
        for (let i = 0; i < map.regions.length; i++)
          for (let j = i + 1; j < map.regions.length; j++) {
            const a = map.regions[i].rect
            const b = map.regions[j].rect
            // Gutter: shrink one rectangle by half the gap on each side — they must still not touch.
            const grown = {
              x: a.x - TM.gap / 2,
              y: a.y - TM.gap / 2,
              w: a.w + TM.gap,
              h: a.h + TM.gap
            }
            expect(overlaps(grown, b)).toBe(false)
          }
      })

      it('never draws a block that cannot show its name line and its whole size', () => {
        let drawn = 0
        for (const r of map.regions)
          for (const g of r.groups)
            for (const c of g.cells) {
              drawn++
              expect(c.rect.w).toBeGreaterThanOrEqual(TM.cellMinW - 1e-6)
              expect(c.rect.h).toBeGreaterThanOrEqual(TM.cellMinH - 1e-6)
              expect(c.rect.w - CHROME_PX).toBeGreaterThanOrEqual(WIDEST_LABEL_PX)
            }
        expect(drawn).toBeGreaterThan(40)
      })

      it('accounts for every worktree: drawn or folded into "N smaller", none lost', () => {
        for (const r of map.regions) {
          const src = input.find((x) => x.id === r.id)!
          for (const g of r.groups) {
            const ids = src.groups.find((x) => x.id === g.id)!.items.map((i) => i.id)
            const drawn = g.cells.map((c) => c.id).filter((id) => id !== g.aggId)
            expect([...drawn, ...g.folded].sort()).toEqual([...ids].sort())
          }
        }
      })

      it('keeps cells inside their group and off each other', () => {
        for (const r of map.regions)
          for (const g of r.groups) {
            for (const c of g.cells) {
              expect(c.rect.x).toBeGreaterThanOrEqual(-1e-6)
              expect(c.rect.y).toBeGreaterThanOrEqual(-1e-6)
              expect(c.rect.x + c.rect.w).toBeLessThanOrEqual(g.box.w + 1e-6)
              expect(c.rect.y + c.rect.h).toBeLessThanOrEqual(g.box.h + 1e-6)
            }
            for (let i = 0; i < g.cells.length; i++)
              for (let j = i + 1; j < g.cells.length; j++)
                expect(overlaps(g.cells[i].rect, g.cells[j].rect)).toBe(false)
          }
      })

      it("stacks a region's groups inside its body and grows the canvas downward", () => {
        for (const r of map.regions) {
          const bottom = r.groups.reduce((m, g) => Math.max(m, g.rect.y + g.rect.h), 0)
          expect(bottom).toBeLessThanOrEqual(r.body.h + 1e-6)
        }
        expect(map.height).toBeGreaterThan(372)
      })
    })
  }

  it('a size label is never wider than the cell the layout guarantees', () => {
    // The invariant the CSS relies on: a minimum cell holds the widest label, so a size is shown whole.
    expect(TM.cellMinW - 18).toBeGreaterThanOrEqual(9 * 6.5)
    expect(formatBytes(999.99e6).length).toBeLessThanOrEqual(9)
  })

  it('lays one region out across the whole width (the drilled-in view)', () => {
    const one = layoutMap([workspace()[0]], 1298)
    expect(one.shelves).toBe(1)
    expect(one.regions[0].rect.w).toBeCloseTo(1298, 4)
  })

  it('returns an empty map for no regions', () => {
    expect(layoutMap([], 1298)).toMatchObject({ height: 0, shelves: 0, regions: [] })
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
