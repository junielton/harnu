import type { CanvasDocument, CanvasEdge, CanvasNode } from '../../../../main/canvas-core'
import type { CanvasPalette } from './canvas-theme'
import {
  LEGACY_MOCKUP_CARD_SHAPE,
  MOCKUP_CARD_DEFAULT_SIZE,
  MOCKUP_CARD_SHAPE
} from './shapes/mockup-card'

/**
 * PURE document → X6 cell mapping (T218 U2). No DOM, no Vue, no X6 import —
 * it emits the plain-object cell specs `graph.fromJSON()` accepts, which is
 * exactly what makes the render path unit-testable without a graph.
 *
 * The direction is deliberately ONE-WAY in this unit. U2 is read-only, so the
 * canvas FILE is the authority (spec §4) and X6 is a viewer: every render
 * rebuilds the cells from the document, and nothing ever reads back out of the
 * graph. U3 adds the return path, and that is where §4.5's write half starts to
 * matter for real.
 *
 * **Why the document types are imported TYPE-ONLY** (and `canvasLabelAttrs` is
 * mirrored below rather than imported): `canvas-core.ts` is pure in the sense
 * ADR-0001 means — no fs, no electron — but it imports `MAX_MARKDOWN_BYTES`
 * from `markdown-core.ts`, which imports `node:path`. A type-only import is
 * erased at compile time and costs nothing; a VALUE import would drag a node
 * builtin into the sandboxed renderer bundle. Recorded as a finding for U1: if
 * `canvas-core.ts` inlined that one constant it would become value-importable
 * from the renderer exactly as spec §5.2 assumes, and this mirror could go.
 */

/**
 * The write half of §4.5, mirrored from `canvasLabelAttrs` in `canvas-core.ts`
 * (see the note above for why it is mirrored and not imported). The normalized
 * label is authoritative and BOTH X6 attribute paths are set from it, so a
 * round-trip through the pane can never resurrect a stale name: in X6 a label
 * given at creation lands on `attrs.text.text` while a later rename writes
 * `attrs.label.text` and leaves the original stale (spike trap 3).
 */
function labelAttrsFor(label: string): { text: { text: string }; label: { text: string } } {
  return { text: { text: label }, label: { text: label } }
}

/** Fallbacks for a node that omits its size (§4.3 makes width/height optional). */
export const DEFAULT_NODE_SIZE = { width: 132, height: 52 } as const
/** A bare `text` node needs height for its label but no frame around it. */
export const DEFAULT_TEXT_SIZE = { width: 160, height: 24 } as const
/** An `image` node is a picture, so its fallback is a picture's footprint —
 *  not the box's, which would letterbox every un-sized asset. */
export const DEFAULT_IMAGE_SIZE = { width: 240, height: 160 } as const

/**
 * Per-shape size fallbacks, keyed by DOCUMENT shape. Anything absent from this
 * map falls back to {@link DEFAULT_NODE_SIZE}.
 *
 * Every entry MIRRORS the corresponding `defaultSize` in the manifest
 * (`src/main/mcp/canvas-shapes.ts`), which lives in main because the MCP verb
 * needs a value import of it at runtime. The manifest is what the verb writes
 * when a caller omits `width`/`height`; this map is what the PANE draws when a
 * hand-written document omits them. They must agree or the same board renders
 * at two different sizes depending on who wrote it — pinned by the drift test
 * in `tests/mcp-canvas-ops.test.ts`, which walks the whole catalog rather than
 * naming shapes one at a time.
 */
export const DEFAULT_SIZE_BY_SHAPE: Readonly<
  Record<string, { readonly width: number; readonly height: number }>
> = {
  box: DEFAULT_NODE_SIZE,
  text: DEFAULT_TEXT_SIZE,
  image: DEFAULT_IMAGE_SIZE,
  [MOCKUP_CARD_SHAPE]: MOCKUP_CARD_DEFAULT_SIZE,
  [LEGACY_MOCKUP_CARD_SHAPE]: MOCKUP_CARD_DEFAULT_SIZE
}

/** The §5.1 kinds this unit draws. Anything else falls back to a box (below). */
const BUILTIN_KINDS = new Set(['box', 'text', 'image'])

/**
 * The registered HTML components this build knows (§5.2, T218 U7) — the shape
 * names `canvas-graph.ts` passes to `Shape.HTML.register` at graph
 * construction, and therefore the only `harnu/<name>` (or legacy `capy/<name>`) values it is SAFE to emit
 * as an X6 `shape`.
 *
 * The two lists must not drift, and the direction of the dependency is what
 * keeps them from drifting: this set is built from the same
 * {@link MOCKUP_CARD_SHAPE} constant the registration reads. Emitting a name X6
 * does not know is not a cosmetic mistake — `graph.addNode({ shape })` THROWS
 * on an unregistered shape, which would take the whole pane down rather than
 * drawing one node wrong.
 */
const REGISTERED_HTML_SHAPES = new Set<string>([MOCKUP_CARD_SHAPE, LEGACY_MOCKUP_CARD_SHAPE])

/**
 * The four connection ports every framed node carries (T218 U3). Their ids are
 * FIXED (`top`/`right`/`bottom`/`left`) rather than generated, so a re-render
 * rebuilds the same ports and an edge the operator drew from one of them is not
 * orphaned by the next `fromJSON`.
 *
 * They are born `visibility: hidden` and revealed on node hover by the pane —
 * a board covered in permanent dots reads as a wiring diagram rather than a
 * whiteboard. Hidden is a *style*, not a removal: the magnet is still there, so
 * X6's connecting hit-test still finds it under the pointer.
 *
 * A `text` node deliberately has NO ports (see {@link toX6Node}): it is an
 * annotation with no frame, and hanging connectors off a bare label makes the
 * board read as if the note were a box.
 */
export const CANVAS_PORT_IDS = ['top', 'right', 'bottom', 'left'] as const
export type CanvasPortId = (typeof CANVAS_PORT_IDS)[number]

/** Radius of a port dot, in world units. */
export const CANVAS_PORT_RADIUS = 4

function portsFor(palette: CanvasPalette): X6CellSpec {
  const attrs = {
    circle: {
      r: CANVAS_PORT_RADIUS,
      magnet: true,
      stroke: palette.accent,
      strokeWidth: 1,
      fill: palette.bg,
      style: { visibility: 'hidden' }
    }
  }
  return {
    groups: Object.fromEntries(CANVAS_PORT_IDS.map((id) => [id, { position: id, attrs }] as const)),
    items: CANVAS_PORT_IDS.map((id) => ({ id, group: id }))
  }
}

/**
 * The X6 cell spec `fromJSON` consumes. Deliberately a loose plain-JSON shape
 * rather than X6's own `Node.Metadata`: this module must stay importable
 * without pulling the graph library into a pure test, and every field here is
 * plain JSON by construction (§4.3 / §5.2 — a non-plain prop is what makes
 * `toJSON()` throw).
 */
export type X6CellSpec = Record<string, unknown>

/**
 * Resolved image sources, keyed by the node's `props.src` exactly as written in
 * the document. The pane fills this by reading each relative path through the
 * SAME confined reader the Markdown pane's image fast-path uses, which returns
 * a `data:` URL — the CSP allows `img-src data:` and would block `file://`.
 * A `src` missing from the map renders as a labelled placeholder rather than a
 * broken image, which is the honest state for an asset that could not be read.
 */
export type ResolvedImages = Readonly<Record<string, string>>

function sizeFor(node: CanvasNode): { width: number; height: number } {
  const base = DEFAULT_SIZE_BY_SHAPE[node.shape] ?? DEFAULT_NODE_SIZE
  return {
    width: typeof node.width === 'number' ? node.width : base.width,
    height: typeof node.height === 'number' ? node.height : base.height
  }
}

/**
 * Node → cell. The label is written through {@link labelAttrsFor}, so BOTH
 * X6 attribute paths carry the normalized value (§4.5, spike trap 3). Setting
 * only one is how the stale-label bug is born: a reader that picks the other
 * path reports the name the node had before it was renamed.
 */
export function toX6Node(
  node: CanvasNode,
  palette: CanvasPalette,
  images: ResolvedImages = {}
): X6CellSpec {
  const { width, height } = sizeFor(node)
  const label = node.label ?? ''
  const labelAttrs = labelAttrsFor(label)

  const common: X6CellSpec = {
    id: node.id,
    x: node.x,
    y: node.y,
    width,
    height,
    ...(typeof node.zIndex === 'number' ? { zIndex: node.zIndex } : {}),
    // Connection ports (U3) — on everything with a frame, never on a bare
    // `text` annotation. See {@link CANVAS_PORT_IDS}.
    ...(node.shape === 'text' ? {} : { ports: portsFor(palette) }),
    // The origin stamp (§4.4) rides along in `data` so it survives into the
    // graph and back out again in U3 — it is creation provenance, and losing it
    // on a round-trip through the pane would erase the "what did the human
    // contribute" answer the field exists to give.
    //
    // `kind` rides along for the same reason: EVERY document shape except
    // `image` is drawn as an X6 `rect`, so the graph alone cannot say whether a
    // cell was a `text` annotation, a `box`, or a `harnu/<name>` this build does
    // not know. Without it, U3's read-back would flatten every annotation into
    // a box on the first Save — a silent, permanent edit nobody asked for.
    data: {
      origin: node.origin,
      kind: node.shape,
      ...(node.props ? { props: node.props } : {})
    }
  }

  if (node.shape === 'text') {
    // No frame, no fill — a bare label. `--text-2` rather than `--text`: with no
    // body behind it, a callout that shouts competes with the boxes.
    return {
      ...common,
      shape: 'rect',
      attrs: {
        body: { fill: 'none', stroke: 'none' },
        text: {
          ...labelAttrs.text,
          fill: palette.text2,
          fontSize: 12,
          fontFamily: palette.fontSans
        },
        label: {
          ...labelAttrs.label,
          fill: palette.text2,
          fontSize: 12,
          fontFamily: palette.fontSans
        }
      }
    }
  }

  if (node.shape === 'image') {
    const src = typeof node.props?.src === 'string' ? node.props.src : ''
    const resolved = images[src]
    if (resolved) {
      return {
        ...common,
        shape: 'image',
        imageUrl: resolved,
        attrs: {
          image: { xlinkHref: resolved },
          // The label sits BELOW the frame so it never covers the picture.
          text: {
            ...labelAttrs.text,
            fill: palette.text3,
            fontSize: 11,
            fontFamily: palette.fontSans,
            refY: '100%',
            refY2: 4,
            textVerticalAnchor: 'top'
          },
          label: {
            ...labelAttrs.label,
            fill: palette.text3,
            fontSize: 11,
            fontFamily: palette.fontSans,
            refY: '100%',
            refY2: 4,
            textVerticalAnchor: 'top'
          }
        }
      }
    }
    // Unresolvable asset → a placeholder that still occupies the node's real
    // footprint, so the layout is honest about what the document says is there.
    const placeholder = label || src
    return {
      ...common,
      shape: 'rect',
      attrs: {
        body: {
          fill: palette.surface,
          stroke: palette.border,
          strokeWidth: 1,
          strokeDasharray: '3 3',
          rx: 7,
          ry: 7
        },
        text: {
          text: placeholder,
          fill: palette.text3,
          fontSize: 11,
          fontFamily: palette.fontSans
        },
        label: {
          text: placeholder,
          fill: palette.text3,
          fontSize: 11,
          fontFamily: palette.fontSans
        }
      }
    }
  }

  if (REGISTERED_HTML_SHAPES.has(node.shape)) {
    // A REGISTERED HTML component (§5.2, T218 U7). The `shape` goes through
    // VERBATIM — that name is the whole contract, and X6 resolves it to the
    // component `canvas-graph.ts` registered. `props` already rides in
    // `common.data`, which is where the registered `html` function reads them
    // from; nothing about the markup is expressed here or anywhere in the file.
    //
    // The SVG label is written to BOTH attribute paths (§4.5, spike trap 3) so
    // a Save round-trips the name and double-click rename still works, then
    // hidden: the card draws its own heading from `props.title` — falling back
    // to this very label — and painting X6's `<text>` over the DOM card would
    // show the same string twice. `display: none`, not absent, is the whole
    // point (design.md §6).
    return {
      ...common,
      shape: node.shape,
      attrs: {
        // The HTML shape's own `body` rect is already `fill: none` — restated
        // so a future change to X6's defaults cannot draw a second frame behind
        // the card's own border.
        body: { fill: 'none', stroke: 'none' },
        text: { ...labelAttrs.text, display: 'none' },
        label: { ...labelAttrs.label, display: 'none' }
      }
    }
  }

  // `box` — and the fallback for any shape this unit does not draw, which today
  // means a `harnu/<name>` component from a NEWER Harnu than this one. Falling
  // back is not politeness: `graph.addNode({ shape: 'harnu/foo' })` THROWS on an
  // unregistered name, so an agent-written shape this build does not know would
  // take the whole pane down instead of rendering as an unremarkable box.
  const known = BUILTIN_KINDS.has(node.shape)
  return {
    ...common,
    shape: 'rect',
    attrs: {
      body: {
        fill: palette.surface,
        stroke: palette.border2,
        strokeWidth: 1.5,
        rx: 7,
        ry: 7,
        // An unknown shape reads as a box, but a dashed outline says so rather
        // than pretending the document rendered exactly as written.
        ...(known ? {} : { strokeDasharray: '4 3' })
      },
      text: { ...labelAttrs.text, fill: palette.text, fontSize: 12, fontFamily: palette.fontSans },
      label: { ...labelAttrs.label, fill: palette.text, fontSize: 12, fontFamily: palette.fontSans }
    }
  }
}

/**
 * Edge → cell.
 *
 * **The edge-label trap (carried from U1's verification).** X6 stores an edge
 * label in a differently-shaped `labels[]` array, and `canvas-core.ts` reads an
 * edge's label straight from `raw.label` — in-spec, because §4.5 scopes
 * normalization to nodes. This unit keeps that safe by making the DOCUMENT the
 * only author of an edge label: `labels[]` is derived from `edge.label` on
 * every render and X6 never writes back (U2 is read-only). U3 adds operator
 * editing, and the moment a rename can reach `labels[]` the stale-label trap
 * reopens ON EDGES — so U3 must either normalize the edge label on the way out
 * or keep the document authoritative the way this does.
 */
export function toX6Edge(edge: CanvasEdge, palette: CanvasPalette): X6CellSpec {
  return {
    id: edge.id,
    shape: 'edge',
    source: edge.source,
    target: edge.target,
    zIndex: 0,
    data: { origin: edge.origin },
    router: { name: edge.router ?? 'manhattan' },
    connector: { name: 'rounded', args: { radius: 8 } },
    attrs: {
      line: {
        stroke: palette.accent,
        strokeWidth: 1.5,
        targetMarker: { name: 'block', width: 8, height: 6 }
      }
    },
    ...(edge.label
      ? {
          labels: [
            {
              attrs: {
                text: {
                  text: edge.label,
                  fill: palette.text3,
                  fontSize: 11,
                  fontFamily: palette.fontSans
                },
                // A plate in `--bg` keeps the label readable where it crosses
                // its own line; no new token, the board colour is already there.
                rect: { fill: palette.bg }
              }
            }
          ]
        }
      : {})
  }
}

/** The whole document as one `fromJSON` payload — nodes first, then edges. */
export function toX6Cells(
  doc: CanvasDocument,
  palette: CanvasPalette,
  images: ResolvedImages = {}
): { cells: X6CellSpec[] } {
  return {
    cells: [
      ...doc.nodes.map((n) => toX6Node(n, palette, images)),
      ...doc.edges.map((e) => toX6Edge(e, palette))
    ]
  }
}

/** The relative `props.src` of every image node — what the pane must resolve
 *  before rendering. Deduped, order-stable, empties dropped. */
export function canvasImageSources(doc: CanvasDocument): string[] {
  const seen = new Set<string>()
  for (const node of doc.nodes) {
    if (node.shape !== 'image') continue
    const src = node.props?.src
    if (typeof src === 'string' && src) seen.add(src)
  }
  return [...seen]
}
