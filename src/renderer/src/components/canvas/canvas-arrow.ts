// Pure decisions for the canvas Arrow tool (T536 U1, spec §5).
//
// The pane asks X6 what is under the pointer and which edges already leave the
// source, then hands plain values here. Keeping the decisions free of X6 and Vue
// is what lets the release rules ("another node: an edge; blank, itself, or a
// duplicate: nothing") be tested as a table.

/** A node under the pointer, as the pane reads it off X6. */
export interface StackedNode {
  id: string
  zIndex: number
}

/**
 * The node actually drawn on top at the pointer. `hits` is in model order, the
 * order X6's `getNodesFromPoint` returns. X6 paints a higher `zIndex` above a
 * lower one and, on a tie, the later cell above the earlier, so the last of the
 * highest zIndex wins.
 */
export function topmostNodeId(hits: readonly StackedNode[]): string | null {
  let best: StackedNode | null = null
  for (const hit of hits) {
    if (!best || hit.zIndex >= best.zIndex) best = hit
  }
  return best ? best.id : null
}

/** An edge's two ends, by node id. */
export interface EdgeEnds {
  source: string
  target: string
}

/**
 * The edge an Arrow release creates, or `null` for none. These are the rules a
 * port drag in Select already follows (`connecting` in `canvas-graph.ts`):
 * - no target (blank board) makes nothing, because a dangling edge cannot be
 *   saved (`allowBlank: false`);
 * - the source itself makes nothing (`allowLoop: false`);
 * - an edge already going `source → target` makes nothing (`allowMulti: false`,
 *   which is directional, so the reverse direction is a different edge).
 */
export function arrowEdgeEnds(
  source: string,
  target: string | null,
  existing: readonly EdgeEnds[]
): EdgeEnds | null {
  if (target === null || target === source) return null
  if (existing.some((e) => e.source === source && e.target === target)) return null
  return { source, target }
}

/** Is a client point inside a client rect (edges included)? */
export function pointInRect(
  p: { x: number; y: number },
  r: { left: number; top: number; right: number; bottom: number }
): boolean {
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
}
