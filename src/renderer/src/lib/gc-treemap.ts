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
 * Splits off the long tail: items under `threshold` that would be too small to read. A tail of one
 * stays in place — an "N smaller" block holding a single block is just a worse label.
 */
export function foldSmall<T extends TreemapItem>(
  items: readonly T[],
  threshold: number,
  minFold = 2
): { kept: T[]; folded: T[] } {
  const sorted = [...items].sort(byValueThenId)
  const small = sorted.filter((i) => i.value < threshold)
  if (small.length < minFold) return { kept: sorted, folded: [] }
  return { kept: sorted.filter((i) => i.value >= threshold), folded: small }
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
