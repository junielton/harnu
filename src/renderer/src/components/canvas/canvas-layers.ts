/**
 * Stacking order for the canvas pane (T536 U4) — PURE: no DOM, no Vue, no X6. The
 * four layer moves, the order a document renders in, and the rule that decides
 * what Save writes all live here, so the panel and the graph adapter only
 * translate between this and X6's `zIndex`.
 *
 * **Ranks start at 1.** Edges are drawn at z 0 and must stay under every node
 * (design.md §6 "Layers"), so a node can never be ranked 0. {@link stackRanks}
 * hands out 1..n and nothing here returns a smaller number.
 *
 * **Why X6's `toFront` / `toBack` are not used.** They pick `max + 1` / `min - 1`
 * over ALL cells, edges included, and write z values nothing else knows about:
 * `toBack` can push a node to a negative z under the edges, and neither can
 * express "one step forward past the nearest node that overlaps me". The moves
 * are computed on the ordered list of node ids ({@link reorderStack}) and the
 * result is written back as dense ranks, so the live z values are always 1..n.
 *
 * **Why `CANVAS_LOAD_Z` is 1.** A node whose JSON has no `zIndex` is given z 1 by
 * X6 on a fresh `fromJSON` after `clearCells` — it is X6's value, not ours.
 * `documentStackOrder` has to predict the order the graph will come up in, so it
 * reads a missing `zIndex` as that same 1; a test against real X6 pins that
 * side so an X6 upgrade that changes the default fails loudly rather than
 * silently reordering every saved board.
 *
 * **Saving.** A file nobody restacked must not be rewritten (it would dirty a
 * hand-written agent canvas with `zIndex` on every node), so {@link savedZIndexes}
 * answers `null` whenever the live order is already the one the file renders in.
 */

export type LayerMove = 'back' | 'backward' | 'forward' | 'front'

/** The four moves in the order the panel shows them. */
export const LAYER_MOVES: readonly LayerMove[] = ['back', 'backward', 'forward', 'front']

/** The z X6 gives every node without a zIndex on a fresh fromJSON (after clearCells). */
export const CANVAS_LOAD_Z = 1

export interface StackBox {
  x: number
  y: number
  width: number
  height: number
}

export interface StackNode {
  id: string
  z: number
  bbox: StackBox
}

interface DocumentNode {
  id: string
  zIndex?: number
}

function hasZ(node: DocumentNode): node is DocumentNode & { zIndex: number } {
  return typeof node.zIndex === 'number' && Number.isFinite(node.zIndex)
}

/** Bottom → top as a document renders: stable sort by (zIndex ?? CANVAS_LOAD_Z); ties keep file order. */
export function documentStackOrder(nodes: readonly DocumentNode[]): string[] {
  return nodes
    .map((n, index) => ({ id: n.id, z: hasZ(n) ? n.zIndex : CANVAS_LOAD_Z, index }))
    .sort((a, b) => a.z - b.z || a.index - b.index)
    .map((n) => n.id)
}

/**
 * The z each node is RENDERED with: the file's values when every node has one and they
 * are distinct, else the ranks of {@link documentStackOrder} (1..n). Never written to
 * the file.
 */
export function renderStackZ(nodes: readonly DocumentNode[]): Map<string, number> {
  const verbatim = nodes.every(hasZ) && new Set(nodes.map((n) => n.zIndex)).size === nodes.length
  if (verbatim) return new Map(nodes.map((n) => [n.id, n.zIndex as number]))
  return stackRanks(documentStackOrder(nodes))
}

/** Bottom → top as the graph holds it: `nodes` in model order, stable sort by z. */
export function liveStackOrder(nodes: readonly { id: string; z: number }[]): string[] {
  return nodes
    .map((n, index) => ({ id: n.id, z: n.z, index }))
    .sort((a, b) => a.z - b.z || a.index - b.index)
    .map((n) => n.id)
}

/** Bounding boxes intersect with positive area — boxes that only touch do not overlap. */
function overlaps(a: StackBox, b: StackBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * New bottom → top order, or null when the move changes nothing. `stack` is bottom →
 * top. Ids in `selected` that are not in `stack` (an edge id from a rubberband) are
 * ignored.
 *
 * `front` / `back` move the selection past every other node and keep its internal
 * order. `forward` takes each selected node from the top down and puts it just above
 * the nearest unselected node above it whose bounds overlap it (stays if none);
 * `backward` is the mirror, bottom up.
 */
export function reorderStack(
  stack: readonly StackNode[],
  selected: ReadonlySet<string>,
  move: LayerMove
): string[] | null {
  const order = stack.map((n) => n.id)
  const picked = order.filter((id) => selected.has(id))
  if (picked.length === 0) return null
  const pickedSet = new Set(picked)
  const rest = order.filter((id) => !pickedSet.has(id))
  let next: string[]

  if (move === 'front') next = [...rest, ...picked]
  else if (move === 'back') next = [...picked, ...rest]
  else {
    const bbox = new Map(stack.map((n) => [n.id, n.bbox]))
    next = [...order]
    const forward = move === 'forward'
    for (const id of forward ? [...picked].reverse() : picked) {
      const at = next.indexOf(id)
      const step = forward ? 1 : -1
      for (let j = at + step; j >= 0 && j < next.length; j += step) {
        const other = next[j]
        if (pickedSet.has(other) || !overlaps(bbox.get(id)!, bbox.get(other)!)) continue
        next.splice(at, 1)
        // Inserting at j lands just above `other` going up (it shifted to j - 1) and
        // just below it going down (it stayed at j).
        next.splice(j, 0, id)
        break
      }
    }
  }

  return next.every((id, i) => id === order[i]) ? null : next
}

/** id → rank, 1-based, bottom → top. */
export function stackRanks(order: readonly string[]): Map<string, number> {
  return new Map(order.map((id, i) => [id, i + 1]))
}

/**
 * The Save rule: null = keep each node's base zIndex; otherwise the rank every node
 * gets. The file is only rewritten when the live order differs from the order the
 * draft would render in, so a board nobody restacked round-trips untouched — and a
 * node added this session (no zIndex, rendered at the load z) that now sits on top
 * counts as a difference.
 */
export function savedZIndexes(
  draftNodes: readonly DocumentNode[],
  live: readonly string[]
): Map<string, number> | null {
  const base = documentStackOrder(draftNodes)
  const known = new Set(base)
  const current = live.filter((id) => known.has(id))
  const seen = new Set(current)
  const order = [...current, ...base.filter((id) => !seen.has(id))]
  if (order.every((id, i) => id === base[i])) return null
  return stackRanks(order)
}
