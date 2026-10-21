// Pure decisions for the canvas Eraser tool (T536 U1, spec §5).
//
// The pane reads the pointer, X6's hit queries and each edge's closest path
// point, and hands plain values here. Keeping the geometry free of X6 and Vue
// is what lets "what does this stroke cross?" be tested as a table.

/** A point, in whichever space the caller works in. */
export interface Pt {
  x: number
  y: number
}

/**
 * How close the pointer must come to an edge to erase it, in SCREEN pixels.
 * An edge is a 1.5px line: asking the operator to land on it exactly would
 * make the Eraser miss most strokes that visibly cross it.
 */
export const ERASE_REACH_PX = 6

/**
 * `ERASE_REACH_PX` in world units at this zoom, so the reach the operator sees
 * stays 6px whether the board is zoomed in or out.
 */
export function eraseReach(zoom: number): number {
  return zoom > 0 ? ERASE_REACH_PX / zoom : ERASE_REACH_PX
}

/**
 * The points one pointer move sweeps, `step` apart at most, ending exactly on
 * `to`. `from` is left out: the previous move (or the press) already probed
 * it. A fast stroke reaches the pane as a few far-apart `mousemove`s, and
 * probing only those would skip a node it visibly crossed.
 */
export function strokeSamples(from: Pt, to: Pt, step: number): Pt[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy)
  if (!(step > 0) || len <= step) return [{ x: to.x, y: to.y }]
  const n = Math.ceil(len / step)
  const out: Pt[] = []
  for (let i = 1; i < n; i++) out.push({ x: from.x + (dx * i) / n, y: from.y + (dy * i) / n })
  out.push({ x: to.x, y: to.y })
  return out
}

/**
 * Is `p` within `reach` of an edge whose rendered path comes closest to it at
 * `closest`? `null` means the edge has no rendered path (not drawn yet), and
 * what the operator cannot see they cannot mean to erase.
 */
export function edgeWithinReach(p: Pt, closest: Pt | null, reach: number): boolean {
  if (!closest) return false
  return Math.hypot(p.x - closest.x, p.y - closest.y) <= reach
}

/**
 * The order a stroke's marked cells are removed in: edges first, then nodes,
 * each group in marking order. Removing a node takes its edges with it, so
 * removing the edges first means every id is still there when its turn comes,
 * and the undo puts the nodes back before the edges that hang off them.
 */
export function eraseRemovalOrder(marked: ReadonlyMap<string, 'node' | 'edge'>): string[] {
  const edges: string[] = []
  const nodes: string[] = []
  for (const [id, kind] of marked) (kind === 'edge' ? edges : nodes).push(id)
  return [...edges, ...nodes]
}
