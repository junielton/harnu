import type {
  CanvasDocument,
  CanvasEdge,
  CanvasMeta,
  CanvasNode,
  CanvasOrigin
} from '../../../../main/canvas-core'
import { DEFAULT_NODE_SIZE } from './canvas-cells'

/**
 * PURE edit model for the canvas pane (T218 U3, spec §4.4 + §7.2). No DOM, no
 * Vue, no X6 import — it turns the plain-JSON cell array `graph.toJSON()`
 * produces back into a canvas document, and mints the elements the operator
 * creates.
 *
 * This is the RETURN path U2 deliberately did not build: U2 rendered the
 * document into X6 and never read anything back, because a viewer has nothing
 * to read back. Everything here exists because the operator can now change the
 * graph, and the file has to learn what they did.
 *
 * ## Two decisions this module encodes, both load-bearing
 *
 * **1. The `origin` stamp is never defaulted, in either direction (§4.4).**
 * Every creation path here — {@link operatorNode}, {@link duplicateOperatorNode},
 * {@link operatorEdgeData} — stamps `"operator"` at creation. On the way back
 * out, {@link buildCanvasDocumentFromCells} reads the stamp from the cell's
 * `data` and passes it through UNCHANGED, including when it is absent: a cell
 * with no stamp reaches the writer's validator as `missing-origin` and the Save
 * is refused. That is the point. Defaulting a missing stamp to `"operator"`
 * would quietly claim the operator drew something they did not, which is
 * precisely the answer the field exists to give.
 *
 * **2. The DOCUMENT stays the author of an edge label (carried finding).**
 * X6 stores an edge label in a differently-shaped `labels[]` array, and
 * `canvas-core.ts` reads an edge's label straight from `raw.label` — in-spec,
 * because §4.5 scopes normalization to NODES. U2 kept that safe by rendering
 * `labels[]` from the document and never reading it back. U3 keeps the same
 * property by a different route: the pane offers no edge-label editing, and
 * {@link buildCanvasDocumentFromCells} takes an edge's label from the BASE
 * DOCUMENT by id rather than from the graph. So an agent-written edge label
 * survives an operator's Save untouched, and no rename can ever reach
 * `labels[]` to go stale there. A node label — which the operator CAN edit —
 * goes the other way: it is normalized out of the graph across both attribute
 * paths by {@link normalizeCellLabel}, exactly as §4.5 requires.
 */

/**
 * `normalizeCanvasLabel` from `canvas-core.ts`, MIRRORED rather than imported —
 * the same reason `canvas-cells.ts` mirrors `canvasLabelAttrs`: `canvas-core`
 * imports `MAX_MARKDOWN_BYTES` from `markdown-core.ts`, which imports
 * `node:path`, and a VALUE import would drag a node builtin into the sandboxed
 * renderer bundle. A type-only import is erased and costs nothing.
 *
 * The duplication is pinned by a test that runs both implementations over the
 * same four shapes (§4.5: only `attrs.text.text`; only `attrs.label.text`;
 * both agreeing; both disagreeing) and asserts they agree — so a change to one
 * that is not made to the other fails, instead of drifting silently.
 */
export function normalizeCellLabel(rawCell: unknown): string | undefined {
  if (!isPlainObject(rawCell)) return undefined
  const attrs = isPlainObject(rawCell.attrs) ? rawCell.attrs : undefined
  if (attrs) {
    const renamed = isPlainObject(attrs.label) ? attrs.label.text : undefined
    if (typeof renamed === 'string') return renamed
    const created = isPlainObject(attrs.text) ? attrs.text.text : undefined
    if (typeof created === 'string') return created
  }
  return typeof rawCell.label === 'string' ? rawCell.label : undefined
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** What the operator stamps. Never written by the agent side, and vice versa. */
export const OPERATOR_ORIGIN: CanvasOrigin = 'operator'

/**
 * A document the pane has BUILT but nothing has validated yet — the shape
 * handed to `canvas:write`, where main's validator is the only thing allowed to
 * decide it is a document.
 *
 * `origin` is `unknown` here ON PURPOSE. It is a required `CanvasOrigin` in a
 * `CanvasNode`, and a draft carrying a missing or bogus one is exactly what the
 * Save must refuse; typing it as required would have forced a cast that quietly
 * invents a value, and narrowing it to the valid pair would have thrown away
 * the difference between `missing-origin` and `invalid-origin` — two distinct
 * machine-readable refusals that tell an operator two different things.
 */
export type CanvasNodeDraft = Omit<CanvasNode, 'origin'> & { origin?: unknown }
export type CanvasEdgeDraft = Omit<CanvasEdge, 'origin'> & { origin?: unknown }
export interface CanvasDocumentDraft {
  capycanvas: number
  meta: CanvasMeta
  nodes: CanvasNodeDraft[]
  edges: CanvasEdgeDraft[]
  [key: string]: unknown
}

/** Minimum footprint a drag-created box may have — below this a node is a
 *  mis-click, not a shape, and it would be unclickable once created. */
export const MIN_DRAWN_NODE_SIZE = { width: 48, height: 32 } as const
/**
 * Drag distance below which a blank drag is a CLICK, not a draw — without it
 * every stray click on the board would litter it with boxes.
 *
 * Expressed in SCREEN pixels and divided by the zoom at the comparison (see
 * {@link isDrawGesture}). That distinction is a real bug avoided rather than a
 * detail: a raw 6-WORLD-unit threshold fires on a 1px twitch of the hand at 20%
 * zoom, which is exactly where a board full of accidental boxes comes from.
 */
export const DRAW_THRESHOLD = 6
/** Offset a duplicate lands at, so it is visibly a second thing. */
export const DUPLICATE_OFFSET = 16

/**
 * Mint an id not already taken in this document. Sequential and deterministic
 * rather than random: the ids a human reads in the file stay short and stable,
 * and a test can assert exactly what was created.
 *
 * Uniqueness is only ever needed WITHIN one document — the file is replaced
 * whole on Save (§7.3 case C), never merged — so a counter checked against the
 * live id set is sufficient, and it does not need to be globally unique.
 */
export function mintCanvasId(prefix: string, taken: ReadonlySet<string>): string {
  for (let i = 1; ; i++) {
    const id = `${prefix}-${i}`
    if (!taken.has(id)) return id
  }
}

/** Every id in `doc`, nodes and edges together — the set §4.3 requires to be
 *  unique across BOTH, and therefore the set an id must be minted against. */
export function canvasIdSet(doc: {
  nodes: readonly { id: string }[]
  edges: readonly { id: string }[]
}): Set<string> {
  return new Set([...doc.nodes.map((n) => n.id), ...doc.edges.map((e) => e.id)])
}

export interface DrawnRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Normalize a drag into a rect: any drag direction becomes a positive-extent
 * box, and anything smaller than {@link MIN_DRAWN_NODE_SIZE} is grown to it,
 * anchored at the drag's top-left.
 */
export function rectFromDrag(x0: number, y0: number, x1: number, y1: number): DrawnRect {
  const x = Math.min(x0, x1)
  const y = Math.min(y0, y1)
  return {
    x,
    y,
    width: Math.max(MIN_DRAWN_NODE_SIZE.width, Math.abs(x1 - x0)),
    height: Math.max(MIN_DRAWN_NODE_SIZE.height, Math.abs(y1 - y0))
  }
}

/**
 * Was that gesture a draw, or a click? Below {@link DRAW_THRESHOLD} on BOTH
 * axes it is a click — the operator meant to clear the selection, not to make
 * a box.
 *
 * The points come in as WORLD coordinates (both ends measured the same way,
 * through the same graph transform) and `scale` is the graph's current zoom, so
 * the threshold itself is converted into world units rather than the points
 * being converted into screen units. Same answer, one fewer coordinate space to
 * get wrong — and it is what keeps the threshold a property of the operator's
 * HAND rather than of the zoom.
 */
export function isDrawGesture(x0: number, y0: number, x1: number, y1: number, scale = 1): boolean {
  const threshold = DRAW_THRESHOLD / (scale > 0 ? scale : 1)
  return Math.abs(x1 - x0) >= threshold || Math.abs(y1 - y0) >= threshold
}

/**
 * A box the operator just drew. **Stamped `operator` at creation** — the U3-3
 * contract, on the drag-to-create path.
 */
export function operatorNode(rect: DrawnRect, taken: ReadonlySet<string>, label = ''): CanvasNode {
  return {
    id: mintCanvasId('n', taken),
    shape: 'box',
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    label,
    origin: OPERATOR_ORIGIN
  }
}

/**
 * The footprint an attached image node is given (T218 U6). The long side is
 * clamped to {@link IMAGE_NODE_MAX_EXTENT} and the aspect ratio is preserved,
 * so a 4K screenshot lands as a card on the board rather than as a wall the
 * operator has to zoom out of. A natural size that is missing or nonsensical
 * (0, negative, NaN — jsdom and a failed decode both produce it) falls back to
 * the default node size rather than guessing.
 */
export const IMAGE_NODE_MAX_EXTENT = 320
export const IMAGE_NODE_MIN_EXTENT = 48

export function imageNodeSize(
  naturalWidth: number,
  naturalHeight: number
): { width: number; height: number } {
  const w = Number(naturalWidth)
  const h = Number(naturalHeight)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { width: DEFAULT_NODE_SIZE.width, height: DEFAULT_NODE_SIZE.height }
  }
  const scale = Math.min(1, IMAGE_NODE_MAX_EXTENT / Math.max(w, h))
  return {
    width: Math.max(IMAGE_NODE_MIN_EXTENT, Math.round(w * scale)),
    height: Math.max(IMAGE_NODE_MIN_EXTENT, Math.round(h * scale))
  }
}

/**
 * An image the operator just pasted or dropped (T218 U6, spec §4.6 + §4.4).
 *
 * **`src` is the RELATIVE `assets/<file>` main handed back**, never a data URI
 * and never an absolute path: the bytes were already externalised next to the
 * canvas, and the node carries a pointer. Inlining them here is the exact
 * failure §4.6 exists to prevent — one 1.5 KB paste cost ~4.5 KB of canvas file
 * in the spike, and every Save rewrites the whole file.
 *
 * **Stamped `operator`**, like every other creation path in this module. This
 * is U6's half of the origin chain: without it an agent re-reading the board
 * cannot tell the screenshot the human dropped from one it attached itself.
 */
export function operatorImageNode(
  src: string,
  at: { x: number; y: number },
  size: { width: number; height: number },
  taken: ReadonlySet<string>,
  label = ''
): CanvasNode {
  return {
    id: mintCanvasId('n', taken),
    shape: 'image',
    x: Math.round(at.x),
    y: Math.round(at.y),
    width: size.width,
    height: size.height,
    label,
    origin: OPERATOR_ORIGIN,
    props: { src }
  }
}

/**
 * A copy of `source`, offset and re-identified. **Stamped `operator`, not
 * inherited** — duplicating an agent's box produces the operator's box, because
 * the stamp is creation provenance and the operator is who created THIS one.
 * Inheriting `agent` here would be the subtle version of the same lie
 * defaulting a missing stamp would tell.
 */
export function duplicateOperatorNode(
  source: CanvasNodeDraft,
  taken: ReadonlySet<string>
): CanvasNode {
  return {
    id: mintCanvasId('n', taken),
    shape: source.shape,
    x: source.x + DUPLICATE_OFFSET,
    y: source.y + DUPLICATE_OFFSET,
    width: source.width ?? DEFAULT_NODE_SIZE.width,
    height: source.height ?? DEFAULT_NODE_SIZE.height,
    ...(source.label === undefined ? {} : { label: source.label }),
    origin: OPERATOR_ORIGIN,
    ...(source.props === undefined ? {} : { props: source.props })
  }
}

/**
 * The `data` bag every operator-drawn EDGE is born with. X6 mints the edge
 * itself (the `connecting.createEdge` hook fires mid-gesture, before there is a
 * document to mint an id against), so this is the one creation path where all
 * we contribute is the stamp — which is the part that matters.
 */
export function operatorEdgeData(): { origin: CanvasOrigin } {
  return { origin: OPERATOR_ORIGIN }
}

/** An X6 edge endpoint is `{ cell, port? }` once bound, or a bare id string. */
function endpointId(end: unknown): string {
  if (typeof end === 'string') return end
  if (isPlainObject(end) && typeof end.cell === 'string') return end.cell
  return ''
}

function readData(cell: Record<string, unknown>): Record<string, unknown> {
  return isPlainObject(cell.data) ? cell.data : {}
}

/**
 * The stamp exactly as the cell carries it — passed through VERBATIM, never
 * defaulted and never sanitized (§4.4). A bogus value must reach the validator
 * as itself, or a Save refused for `invalid-origin` would report
 * `missing-origin` instead and send the operator looking for the wrong thing.
 */
function readOrigin(data: Record<string, unknown>): { origin?: unknown } {
  return 'origin' in data ? { origin: data.origin } : {}
}

function isEdgeCell(cell: Record<string, unknown>): boolean {
  return cell.shape === 'edge' || cell.source !== undefined || cell.target !== undefined
}

function nodeFromCell(cell: Record<string, unknown>, base?: CanvasNode): CanvasNodeDraft {
  const data = readData(cell)
  const position = isPlainObject(cell.position) ? cell.position : {}
  const size = isPlainObject(cell.size) ? cell.size : {}
  const label = normalizeCellLabel(cell)
  const props = isPlainObject(data.props) ? (data.props as Record<string, unknown>) : undefined
  return {
    id: String(cell.id),
    // `data.kind` is the DOCUMENT's shape, stamped at render time — the X6
    // `shape` is `rect` for a box, a text annotation and an unknown kind alike,
    // so trusting it would flatten all three into boxes on the first Save.
    shape: typeof data.kind === 'string' && data.kind ? data.kind : (base?.shape ?? 'box'),
    x: typeof position.x === 'number' ? position.x : (base?.x ?? 0),
    y: typeof position.y === 'number' ? position.y : (base?.y ?? 0),
    ...(typeof size.width === 'number' ? { width: size.width } : {}),
    ...(typeof size.height === 'number' ? { height: size.height } : {}),
    ...(label === undefined ? {} : { label }),
    ...readOrigin(data),
    // zIndex is preserved only when the DOCUMENT already carried one: X6 hands
    // every cell an automatic z, and writing those back would add a field to
    // every node on the first Save for a stacking order nothing in U3 can even
    // change.
    ...(base?.zIndex === undefined ? {} : { zIndex: base.zIndex }),
    ...(props === undefined ? {} : { props })
  }
}

function edgeFromCell(cell: Record<string, unknown>, base?: CanvasEdge): CanvasEdgeDraft {
  const data = readData(cell)
  return {
    id: String(cell.id),
    source: endpointId(cell.source),
    target: endpointId(cell.target),
    // The document is the author (see this module's header): an edge label comes
    // from the base document, NEVER from X6's `labels[]`.
    ...(base?.label === undefined ? {} : { label: base.label }),
    ...readOrigin(data),
    // Same reasoning as zIndex above: an omitted router renders as `manhattan`
    // (`toX6Edge`), so a new edge needs no field written for it.
    ...(base?.router === undefined ? {} : { router: base.router })
  }
}

/**
 * `graph.toJSON().cells` → the document to hand the confined writer (§7.2
 * steps 1–3). `base` supplies everything the graph does not carry — `meta`, the
 * unknown top-level keys §4.3 promises to preserve, edge labels, routers, and
 * the original per-node `zIndex`. `nowIso` is passed IN rather than read from
 * the clock, so this stays pure and a test can pin the bytes exactly.
 *
 * **Order is the base document's order, then new cells in graph order.** X6 is
 * free to hand cells back in whatever order its model holds them; taking that
 * order verbatim would reshuffle a file on a Save that changed nothing, which
 * is exactly the churn AC U3-5 forbids.
 */
export function buildCanvasDocumentFromCells(
  rawCells: readonly unknown[],
  base: CanvasDocument,
  nowIso: string
): CanvasDocumentDraft {
  const cells = rawCells.filter(isPlainObject)
  const nodeCells = new Map<string, Record<string, unknown>>()
  const edgeCells = new Map<string, Record<string, unknown>>()
  for (const cell of cells) {
    const id = typeof cell.id === 'string' ? cell.id : ''
    if (!id) continue
    ;(isEdgeCell(cell) ? edgeCells : nodeCells).set(id, cell)
  }

  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]))
  const baseEdges = new Map(base.edges.map((e) => [e.id, e]))

  const nodes: CanvasNodeDraft[] = []
  const seenNodes = new Set<string>()
  for (const n of base.nodes) {
    const cell = nodeCells.get(n.id)
    if (!cell) continue // deleted in the pane
    nodes.push(nodeFromCell(cell, n))
    seenNodes.add(n.id)
  }
  for (const [id, cell] of nodeCells) {
    if (seenNodes.has(id)) continue
    nodes.push(nodeFromCell(cell, baseNodes.get(id)))
  }

  const edges: CanvasEdgeDraft[] = []
  const seenEdges = new Set<string>()
  for (const e of base.edges) {
    const cell = edgeCells.get(e.id)
    if (!cell) continue
    edges.push(edgeFromCell(cell, e))
    seenEdges.add(e.id)
  }
  for (const [id, cell] of edgeCells) {
    if (seenEdges.has(id)) continue
    edges.push(edgeFromCell(cell, baseEdges.get(id)))
  }

  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(base)) {
    if (key === 'capycanvas' || key === 'meta' || key === 'nodes' || key === 'edges') continue
    extras[key] = value
  }

  return {
    ...extras,
    capycanvas: base.capycanvas,
    // §7.2 step 6. Everything else in `meta` — including a `createdAt` written
    // by whoever made the file — is carried through untouched.
    meta: { ...base.meta, updatedAt: nowIso },
    nodes,
    edges
  }
}
