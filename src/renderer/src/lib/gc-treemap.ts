// Pure treemap geometry for the Cleanup map (design.md "Workspace GC — unified Cleanup / Treemap").
// Squarified layout (Bruls, Huizing, van Wijk): rectangles keep their area proportional to the
// value and stay as close to square as the data allows. No DOM, no Vue — unit-tested in
// tests/gc-treemap.test.ts.

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface TreemapItem {
  id: string
  value: number
}

export interface Placed {
  id: string
  value: number
  rect: Rect
}

const usable = (v: number): boolean => Number.isFinite(v) && v > 0

/** Largest first; ties break by id so the order is stable from one scan to the next. */
function byValueThenId(a: TreemapItem, b: TreemapItem): number {
  return b.value - a.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Worst aspect ratio of a row laid along a side of length `side`. */
function worst(row: readonly number[], sum: number, side: number): number {
  if (row.length === 0 || sum <= 0) return Infinity
  const s2 = side * side
  const sumSq = sum * sum
  return Math.max((s2 * Math.max(...row)) / sumSq, sumSq / (s2 * Math.min(...row)))
}

/**
 * Lays `items` out inside `box`. Items with no usable size are dropped (a zero-area block would
 * be an invisible, unclickable button). Returns rectangles in descending value order.
 */
export function squarify(items: readonly TreemapItem[], box: Rect): Placed[] {
  if (!(box.w > 0) || !(box.h > 0)) return []
  const sorted = items.filter((i) => usable(i.value)).sort(byValueThenId)
  if (sorted.length === 0) return []

  const total = sorted.reduce((a, i) => a + i.value, 0)
  const scale = (box.w * box.h) / total
  const out: Placed[] = []
  let free: Rect = { ...box }
  let i = 0

  while (i < sorted.length) {
    const side = Math.min(free.w, free.h)
    const row: TreemapItem[] = []
    let rowAreas: number[] = []
    let rowSum = 0
    // Grow the row while it does not make the worst aspect ratio worse.
    while (i < sorted.length) {
      const area = sorted[i].value * scale
      const next = [...rowAreas, area]
      if (row.length > 0 && worst(next, rowSum + area, side) > worst(rowAreas, rowSum, side)) break
      row.push(sorted[i])
      rowAreas = next
      rowSum += area
      i++
    }

    // The row occupies a strip of thickness rowSum / side along the short side.
    const thickness = rowSum / side
    const horizontal = free.w >= free.h // strip is a column on the left when the box is wide
    let offset = 0
    for (let k = 0; k < row.length; k++) {
      const length = rowAreas[k] / thickness
      out.push({
        id: row[k].id,
        value: row[k].value,
        rect: horizontal
          ? { x: free.x, y: free.y + offset, w: thickness, h: length }
          : { x: free.x + offset, y: free.y, w: length, h: thickness }
      })
      offset += length
    }
    free = horizontal
      ? { x: free.x + thickness, y: free.y, w: free.w - thickness, h: free.h }
      : { x: free.x, y: free.y + thickness, w: free.w, h: free.h - thickness }
  }
  return out
}

/**
 * Region shares that sum to 1 but never fall under `minShare`, so a small repo next to a large one
 * does not shrink to a sliver (the overview's width floor). Byte totals stay on the header.
 */
export function floorShares(values: readonly number[], minShare: number): number[] {
  const n = values.length
  if (n === 0) return []
  const clean = values.map((v) => (usable(v) ? v : 0))
  const total = clean.reduce((a, b) => a + b, 0)
  if (total <= 0) return clean.map(() => 1 / n)

  const floor = Math.min(minShare, 1 / n)
  let shares = clean.map((v) => v / total)
  // Pin the small ones at the floor and shrink the others to pay for it. One or two passes settle.
  for (let pass = 0; pass < n; pass++) {
    const pinned = shares.map((s) => s < floor)
    if (!pinned.some(Boolean)) break
    const pinnedTotal = pinned.filter(Boolean).length * floor
    const freeSum = shares.reduce((a, s, k) => a + (pinned[k] ? 0 : s), 0)
    shares = shares.map((s, k) => (pinned[k] ? floor : (s / freeSum) * (1 - pinnedTotal)))
  }
  return shares
}

// ---- the map: shelves of regions, stacked groups, readable blocks (BUG-171) ---------------------
//
// design.md "Workspace GC — unified Cleanup / Treemap". The map may grow downward: repo regions sit on
// wrapping shelves (never squeezed under a minimum width), the bucket groups of a region stack at its full
// width, and a block is drawn only when its cell can hold its label AND its whole size — anything smaller
// folds into the group's "N smaller" block. Everything here is pure geometry; the Vue component only maps
// ids back to the model.

/** Layout constants, mirrored in design.md ("Treemap geometry") and asserted in the tests. */
export const TM = {
  /** Gutter between regions and between shelves (spacing token `s-2`). */
  gap: 8,
  regionMinW: 340,
  /** Two-line region header: repo label, then meta and badges. */
  regionHead: 50,
  /** 1px border on each side of a region. */
  regionBorder: 2,
  groupHead: 22,
  /** 2px inset on each side of a group. */
  groupInset: 4,
  /** A cell below this cannot hold the name line, the size line and the padding. */
  cellMinW: 88,
  cellMinH: 44,
  /** Area density of the map: 24,000 px² per decimal GB, as `formatBytes` counts. */
  areaPerByte: 24_000 / 1e9,
  groupBodyMin: 48,
  groupBodyMax: 560
} as const

export interface ShelfSlot {
  id: string
  /** Shelf index, 0 = top. */
  row: number
  x: number
  w: number
}

/**
 * Places regions on shelves. A shelf holds as many regions as fit at `minW`; the count is evened out
 * (11 regions at 1298px → 3/3/3/2, not 3/3/3/1+…), biggest first. Widths inside a shelf follow bytes but
 * never fall under `minW`, so a small repo is not a sliver.
 */
export function planShelves(
  items: readonly TreemapItem[],
  width: number,
  minW: number = TM.regionMinW,
  gap: number = TM.gap
): ShelfSlot[] {
  const sorted = [...items].sort(byValueThenId)
  const n = sorted.length
  if (n === 0 || !(width > 0)) return []
  const perShelf = Math.max(1, Math.floor((width + gap) / (minW + gap)))
  const shelves = Math.ceil(n / perShelf)
  const per = Math.ceil(n / shelves)

  const out: ShelfSlot[] = []
  for (let row = 0; row * per < n; row++) {
    const chunk = sorted.slice(row * per, row * per + per)
    const usable = width - gap * (chunk.length - 1)
    const shares = floorShares(
      chunk.map((c) => c.value),
      usable > 0 ? Math.min(1, minW / usable) : 0
    )
    let x = 0
    chunk.forEach((c, k) => {
      const w = shares[k] * usable
      out.push({ id: c.id, row, x, w })
      x += w + gap
    })
  }
  return out
}

/** Body height of a bucket group: its bytes at the map's density, clamped so it is readable and bounded. */
export function groupBodyHeight(bytes: number, bodyW: number): number {
  if (!(bodyW > 0) || !usable(bytes)) return TM.groupBodyMin
  const h = (bytes * TM.areaPerByte) / bodyW
  return Math.min(TM.groupBodyMax, Math.max(TM.groupBodyMin, h))
}

export interface PackedCells {
  placed: Placed[]
  /** Items folded into the aggregate, biggest first. */
  folded: TreemapItem[]
}

/**
 * Squarifies `items` in `box` so that EVERY returned rectangle is at least `min.w × min.h`. What cannot be
 * that big folds into one aggregate (id `aggId`, value = its members' sum), which has to meet the minimum
 * too — when it does not, it takes in the next smallest block until it does. A zero-byte item counts as
 * 1 byte so it folds instead of vanishing.
 */
export function packCells(
  items: readonly TreemapItem[],
  box: Rect,
  min: { w: number; h: number },
  aggId: string
): PackedCells {
  const all = items.map((i) => ({ id: i.id, value: usable(i.value) ? i.value : 1 }))
  const kept = [...all].sort(byValueThenId)
  const folded: TreemapItem[] = []
  if (kept.length === 0 || !(box.w > 0) || !(box.h > 0)) return { placed: [], folded }

  // First pass: whatever its byte share cannot give the minimum area is folded without a squarify each.
  const total = kept.reduce((a, i) => a + i.value, 0)
  const minValue = ((min.w * min.h) / (box.w * box.h)) * total
  while (kept.length > 0 && kept[kept.length - 1].value < minValue) folded.push(kept.pop()!)

  const eps = 1e-6
  const tooSmall = (p: Placed): boolean => p.rect.w < min.w - eps || p.rect.h < min.h - eps
  for (;;) {
    let aggValue = sum(folded)
    let placed = squarify(folded.length > 0 ? [...kept, { id: aggId, value: aggValue }] : kept, box)
    // The tail is small by definition, so its byte share alone would draw it unreadably thin. The
    // aggregate is given as much area as it needs (never more than the blocks it sits beside).
    if (folded.length > 0 && kept.length > 0) {
      const cap = sum(kept) * 3
      for (let k = 0; k < 16 && aggValue < cap; k++) {
        const agg = placed.find((p) => p.id === aggId)
        if (agg && !tooSmall(agg)) break
        aggValue *= 1.3
        placed = squarify([...kept, { id: aggId, value: aggValue }], box)
      }
    }
    const bad = placed.filter(tooSmall)
    if (bad.length === 0 || kept.length === 0) return { placed, folded: sortBig(folded) }
    // The smallest offending block folds; if only the aggregate is too small, the smallest kept one joins it.
    const offenders = bad.filter((p) => p.id !== aggId).map((p) => p.id)
    const victim =
      kept
        .filter((k) => offenders.includes(k.id))
        .sort(byValueThenId)
        .pop() ?? kept[kept.length - 1]
    kept.splice(kept.indexOf(victim), 1)
    folded.push(victim)
  }
}

const sum = (xs: readonly TreemapItem[]): number => xs.reduce((a, i) => a + i.value, 0)
const sortBig = (xs: TreemapItem[]): TreemapItem[] => [...xs].sort(byValueThenId)

export interface MapGroupIn {
  id: string
  bytes: number
  items: TreemapItem[]
}
export interface MapRegionIn {
  id: string
  bytes: number
  groups: MapGroupIn[]
}

export interface MapGroup {
  id: string
  /** In the region body: x/y from its top-left, width = the body's. */
  rect: Rect
  /** The cells' drawing box inside the group (after its inset and header). */
  box: Rect
  /** Cell rectangles relative to `box`; the aggregate has id `agg:<regionId>:<groupId>`. */
  cells: (Placed & { cx: number; cy: number })[]
  folded: string[]
  aggId: string
}
export interface MapRegion {
  id: string
  /** In canvas coordinates. */
  rect: Rect
  /** The region body below its header and inside its border. */
  body: Rect
  groups: MapGroup[]
}
export interface MapLayout {
  width: number
  height: number
  shelves: number
  regions: MapRegion[]
}

const aggIdOf = (region: string, group: string): string => `agg:${region}:${group}`

/** Region height before any slack: header, borders and its stacked groups at their own heights. */
function naturalHeight(r: MapRegionIn, bodyW: number): number {
  const groups = r.groups.reduce(
    (a, g) => a + TM.groupHead + TM.groupInset + groupBodyHeight(g.bytes, bodyW - TM.groupInset),
    0
  )
  return TM.regionHead + TM.regionBorder + groups
}

export function layoutMap(regions: readonly MapRegionIn[], width: number): MapLayout {
  const slots = planShelves(
    regions.map((r) => ({ id: r.id, value: r.bytes })),
    width
  )
  const byId = new Map(regions.map((r) => [r.id, r]))
  const shelfCount = slots.reduce((m, s) => Math.max(m, s.row + 1), 0)

  // Phase 1: a shelf is as tall as its tallest region.
  const shelfH: number[] = Array.from({ length: shelfCount }, () => 0)
  for (const s of slots) {
    const r = byId.get(s.id)!
    shelfH[s.row] = Math.max(shelfH[s.row], naturalHeight(r, s.w - TM.regionBorder))
  }
  const shelfY: number[] = []
  let y = 0
  shelfH.forEach((h, i) => {
    shelfY[i] = y
    y += h + TM.gap
  })
  const height = shelfCount > 0 ? y - TM.gap : 0

  // Phase 2: stretch each region's groups over the slack, then pack the cells.
  const out: MapRegion[] = slots.map((s) => {
    const r = byId.get(s.id)!
    const rect: Rect = { x: s.x, y: shelfY[s.row], w: s.w, h: shelfH[s.row] }
    const bodyW = rect.w - TM.regionBorder
    const body: Rect = {
      x: 1,
      y: TM.regionHead,
      w: bodyW,
      h: rect.h - TM.regionHead - TM.regionBorder
    }
    const bodies = r.groups.map((g) => groupBodyHeight(g.bytes, bodyW - TM.groupInset))
    const natural = bodies.reduce((a, b) => a + b, 0)
    const slack = body.h - r.groups.length * (TM.groupHead + TM.groupInset) - natural
    let gy = 0
    const groups = r.groups.map((g, k): MapGroup => {
      const extra = natural > 0 ? (slack * bodies[k]) / natural : 0
      const h = TM.groupHead + TM.groupInset + bodies[k] + extra
      const G: Rect = { x: 0, y: gy, w: bodyW, h }
      gy += h
      const box: Rect = {
        x: TM.groupInset / 2,
        y: TM.groupInset / 2 + TM.groupHead,
        w: bodyW - TM.groupInset,
        h: h - TM.groupInset - TM.groupHead
      }
      const aggId = aggIdOf(r.id, g.id)
      const packed = packCells(
        g.items,
        { x: 0, y: 0, w: box.w, h: box.h },
        { w: TM.cellMinW, h: TM.cellMinH },
        aggId
      )
      const cells = packed.placed.map((p) => ({
        ...p,
        cx: rect.x + body.x + G.x + box.x + p.rect.x + p.rect.w / 2,
        cy: rect.y + body.y + G.y + box.y + p.rect.y + p.rect.h / 2
      }))
      return { id: g.id, rect: G, box, cells, folded: packed.folded.map((f) => f.id), aggId }
    })
    return { id: r.id, rect, body, groups }
  })

  return { width, height, shelves: shelfCount, regions: out }
}
