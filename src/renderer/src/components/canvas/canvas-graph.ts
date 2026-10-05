import { Graph, Shape } from '@antv/x6'
import { Selection } from '@antv/x6-plugin-selection'
import { History } from '@antv/x6-plugin-history'
import { Transform } from '@antv/x6-plugin-transform'
import { Snapline } from '@antv/x6-plugin-snapline'
import type { CanvasDocument } from '../../../../main/canvas-core'
import { toX6Cells, type ResolvedImages } from './canvas-cells'
import { operatorEdgeData } from './canvas-edit'
import type { CanvasPalette } from './canvas-theme'
import {
  MOCKUP_CARD_DEFAULT_SIZE,
  LEGACY_MOCKUP_CARD_SHAPE,
  MOCKUP_CARD_SHAPE,
  buildMockupCardElement,
  mockupCardFields
} from './shapes/mockup-card'

/**
 * The X6 graph seam for the canvas pane (T218 U2). Everything that touches the
 * library lives here, so `DiagramPane.vue` stays a pane — header, states,
 * lifecycle — and the graph itself is constructible (and therefore testable)
 * without mounting a component.
 *
 * ## The version pin is the whole reason this file asserts anything
 *
 * X6 core is pinned to `2.19.2` with the 2.x plugins (spec §3.4, spike trap 1).
 * Core 3.x has NO working plugin ecosystem: the 2.x plugins throw
 * `TypeError: t.View.dispose is not a function` against it (3.x removed the
 * disposable-decorator API they compile against), and the published `3.0.0`
 * plugin packages ship CSS and **zero `.js` files**. Worse, the plugins' npm
 * `latest` dist-tag still points at 2.x, so `npm i @antv/x6@latest` silently
 * produces the BROKEN 3.x-core + 2.x-plugin pairing — and the symptom is a pane
 * that renders nodes and has no selection, no undo, no resize and no snaplines,
 * which reads as a bug in our code rather than a dependency mismatch.
 *
 * {@link CANVAS_PLUGIN_NAMES} plus {@link missingCanvasPlugins} exist so that
 * failure is an assertion instead of a matter of vigilance: a dependency bump
 * that moves X6 without re-verifying the plugins fails a test (U2-5), not a
 * code review.
 */

/**
 * The four plugins the canvas depends on, by the name X6 registers them under.
 * `graph.getPlugin(name)` returning the instance is the ONLY honest proof they
 * loaded — `new Graph(...)` followed by four `use()` calls throwing nothing is
 * not, because a plugin can register and be inert.
 */
export const CANVAS_PLUGIN_NAMES = ['selection', 'history', 'transform', 'snapline'] as const
export type CanvasPluginName = (typeof CANVAS_PLUGIN_NAMES)[number]

/** Zoom clamp (design.md §6 — Diagram pane). Below 0.2 a board is unreadable;
 *  above 3 it is a pixel inspector, and neither is worth the scroll distance. */
export const CANVAS_MIN_SCALE = 0.2
export const CANVAS_MAX_SCALE = 3
/** Dot-grid pitch, in world units — matches the design section's 16px. */
export const CANVAS_GRID_SIZE = 16
/**
 * Dot radius in world units. **2, not 1** — X6 scales the grid dot with the
 * zoom, so a 1px dot renders sub-pixel (~0.7px) the moment the board is zoomed
 * out, which is precisely when the grid is most needed to make panning legible.
 * Verified in the real app: at 74% a 1px dot was invisible against `--bg`.
 */
export const CANVAS_GRID_DOT = 2
/** Inset `zoomToFit` leaves so a node can never be born under the control cluster. */
export const CANVAS_FIT_PADDING = 40

export interface CreateCanvasGraphOptions {
  container: HTMLElement
  palette: CanvasPalette
  /** Explicit size for environments with no layout (jsdom); production measures. */
  width?: number
  height?: number
  /**
   * Arm the editing affordances (T218 U3). `false` — the default — keeps the
   * U2 viewer contract: nothing the pointer does may change the document.
   */
  editable?: boolean
}

/**
 * Minimum footprint X6's resize handles may shrink a node to. Matches
 * `MIN_DRAWN_NODE_SIZE` in `canvas-edit.ts` — a node the operator can draw but
 * cannot resize back to is an inconsistency the operator would read as a bug.
 */
export const CANVAS_MIN_NODE_SIZE = { width: 48, height: 32 } as const

/**
 * How the three blank-area gestures are split (T218 U3).
 *
 * A blank drag is claimed by THREE things at once — pan, rubberband select and
 * draw-a-box — and X6 will happily run two of them over the same gesture (U2
 * verified exactly that in the real app: one drag panned AND left a selection
 * box behind it). So the split is explicit and asserted:
 *
 *  - **plain left drag → draw a box** (AC U3-1: "drag on empty canvas creates
 *    a box"). The most-used gesture gets the unmodified drag.
 *  - **shift + left drag → rubberband select** (AC U3-2). X6's Selection
 *    plugin owns this one, gated on the modifier.
 *  - **right-button drag → pan.** design.md's "panning moves to a held
 *    modifier" resolved to a held BUTTON instead: every keyboard modifier was
 *    already spoken for (shift by rubberband, ctrl/meta by zoom and by
 *    multi-select), and the pane has no context menu for a right-drag to
 *    collide with. Fit and the zoom cluster remain the discoverable path.
 */
export const CANVAS_RUBBERBAND_MODIFIER = 'shift'

/**
 * Build the graph and install the four plugins.
 *
 * READ-ONLY in this unit: `interacting` refuses node movement and edge
 * creation, and `connecting` is not configured at all, because U2 renders a
 * document and U3 owns editing. The plugins are still installed — selection and
 * the viewport are read affordances, and installing them here is what makes the
 * §3.4 guard testable before there is anything to edit.
 */
/**
 * Register every `harnu/<name>` HTML component this build ships (§5.2, T218 U7).
 *
 * **`Shape.HTML.register` and not an inline payload**, on the spike's evidence
 * (README trap 2): an `html` element or function handed to a NODE makes
 * `graph.toJSON()` throw `Can only serialize node with plain-object props`, and
 * a node that cannot be serialized cannot exist in a file-backed canvas (§4).
 * Registering under a NAME moves the markup into the renderer, where it belongs
 * — the document then carries a name plus plain JSON, and there is no field an
 * agent could put markup into.
 *
 * **`html` is a FUNCTION returning an element, never a string.** X6's HTML view
 * takes the `container.innerHTML = html` path when the registered value is a
 * string; the element path goes through `Dom.append`. Since the card's text is
 * agent-written, the element form is what keeps `props.body` characters instead
 * of markup — together with `mockup-card.ts` using `textContent` throughout.
 *
 * `effect` narrows the re-render triggers: `data` carries `props`, `attrs`
 * carries the label a rename writes. Omitting it entirely would rebuild the
 * card's DOM on every `change:position` — i.e. per `mousemove` of a drag.
 *
 * Idempotent by construction: `Graph.registerNode` is called with `overwrite`,
 * and the registry is global to X6, so calling this once per graph costs a map
 * write and cannot conflict with a second open pane.
 */
export function registerCanvasHtmlShapes(): void {
  // The current name and the pre-rename one: a board written before the rename
  // still renders (and keeps its shape name when saved back).
  for (const shape of [MOCKUP_CARD_SHAPE, LEGACY_MOCKUP_CARD_SHAPE]) {
    Shape.HTML.register({
      shape,
      width: MOCKUP_CARD_DEFAULT_SIZE.width,
      height: MOCKUP_CARD_DEFAULT_SIZE.height,
      effect: ['data', 'attrs'],
      html: (cell) => {
        const data = cell.getData() as { props?: unknown } | undefined
        // Both label paths, most-recently-written first — the same precedence
        // `normalizeCellLabel` applies (§4.5, spike trap 3). Reading only one is
        // how a renamed card keeps showing its old title.
        const label = cell.attr('label/text') ?? cell.attr('text/text')
        return buildMockupCardElement(mockupCardFields(data?.props, label))
      }
    })
  }
}

export function createCanvasGraph(opts: CreateCanvasGraphOptions): Graph {
  const { container, palette } = opts
  const editable = opts.editable === true
  // Before the graph exists, and therefore before anything can `fromJSON` a
  // document holding one: an unregistered `harnu/<name>` THROWS on add.
  registerCanvasHtmlShapes()
  // Forward reference so `connecting.createEdge` can mint through the graph it
  // is being installed on. X6 calls the hook mid-gesture, long after this
  // assignment, so the closure is always resolved by the time it fires.
  let self: Graph | null = null
  const graph = new Graph({
    container,
    ...(opts.width ? { width: opts.width } : {}),
    ...(opts.height ? { height: opts.height } : {}),
    background: { color: palette.bg },
    grid: {
      visible: true,
      type: 'dot',
      size: CANVAS_GRID_SIZE,
      args: { color: palette.border2, thickness: CANVAS_GRID_DOT }
    },
    // U2: drag-to-pan on empty canvas, because there is nothing to create.
    // U3: the plain drag DRAWS, so panning moves to the right button — see
    // {@link CANVAS_RUBBERBAND_MODIFIER} for why not a keyboard modifier.
    panning: editable ? { enabled: true, eventTypes: ['rightMouseDown'] } : { enabled: true },
    // Ctrl/Cmd-wheel only: a bare wheel belongs to whatever is scrolling around
    // the pane, and stealing it makes the canvas fight the helper stack.
    mousewheel: {
      enabled: true,
      modifiers: ['ctrl', 'meta'],
      minScale: CANVAS_MIN_SCALE,
      maxScale: CANVAS_MAX_SCALE
    },
    // U2 is a viewer — the document is the authority and nothing the pointer
    // does may change it (spec §6, "read-only in this unit"). U3 opens exactly
    // the affordances its ACs name and no more: nodes move and connect, but an
    // edge is not draggable off its endpoints and its label is not movable,
    // because neither survives the round-trip through our schema (§4.3 stores
    // an edge as source + target, with no waypoints and no label geometry) —
    // an operator dragging one would watch their work vanish on the next
    // reload.
    interacting: editable
      ? {
          nodeMovable: true,
          magnetConnectable: true,
          edgeMovable: false,
          edgeLabelMovable: false,
          arrowheadMovable: false,
          vertexMovable: false,
          vertexAddable: false,
          vertexDeletable: false
        }
      : false,
    // Edge drawing, armed only when editing. `allowBlank: false` — an edge must
    // land on a node, because §4.3 refuses a dangling edge outright, so letting
    // one be drawn would only produce a document that cannot be saved.
    ...(editable
      ? {
          connecting: {
            snap: { radius: 24 },
            allowBlank: false,
            allowLoop: false,
            allowMulti: false,
            allowNode: true,
            highlight: true,
            router: { name: 'manhattan' },
            connector: { name: 'rounded', args: { radius: 8 } },
            // THE operator-edge creation path (AC U3-3). X6 mints the edge
            // mid-gesture, so the stamp has to go on here — there is no later
            // point where "this edge is new" is still knowable.
            createEdge: () =>
              (self as Graph).createEdge({
                shape: 'edge',
                data: operatorEdgeData(),
                router: { name: 'manhattan' },
                connector: { name: 'rounded', args: { radius: 8 } },
                attrs: {
                  line: {
                    stroke: palette.accent,
                    strokeWidth: 1.5,
                    targetMarker: { name: 'block', width: 8, height: 6 }
                  }
                }
              })
          }
        }
      : {})
  })
  self = graph

  // Rubberband is OFF in U2, and `showNodeSelectionBox` with it. The plugin is
  // still INSTALLED — that is what {@link missingCanvasPlugins} guards, and it
  // is what U3 switches on — but its blank-area drag competes with panning for
  // the same gesture, and selecting a node in a read-only pane leads nowhere.
  // Verified in the real app: with both on, one drag panned AND left a
  // selection box behind it. U3 resolves the conflict the way the spike did —
  // rubberband takes the plain drag and panning moves to a held modifier —
  // which is a change worth making when there is something to do with a
  // selection, not before.
  graph.use(
    new Selection(
      editable
        ? {
            enabled: true,
            multiple: true,
            rubberband: true,
            // Gated on shift so the plain drag stays free for drawing — the
            // conflict U2 observed live, resolved rather than left to luck.
            modifiers: CANVAS_RUBBERBAND_MODIFIER,
            showNodeSelectionBox: true,
            pointerEvents: 'none'
          }
        : { rubberband: false, showNodeSelectionBox: false }
    )
  )
  graph.use(new History({ enabled: true }))
  graph.use(
    new Transform({
      resizing: editable
        ? {
            enabled: true,
            minWidth: CANVAS_MIN_NODE_SIZE.width,
            minHeight: CANVAS_MIN_NODE_SIZE.height,
            orthogonal: false,
            preserveAspectRatio: false
          }
        : false,
      rotating: false
    })
  )
  graph.use(new Snapline({ enabled: true, sharp: true }))

  return graph
}

/**
 * Reveal or hide a node's connection ports. Called from the pane on node hover:
 * the ports are rendered `visibility: hidden` (`canvas-cells.ts`) so a board is
 * not permanently speckled with dots, and this is what makes them grabbable
 * when the pointer is actually on a node.
 */
export function setCanvasPortsVisible(graph: Graph, nodeId: string, visible: boolean): void {
  const node = graph.getCellById(nodeId)
  if (!node || !node.isNode()) return
  for (const port of node.getPorts()) {
    if (!port.id) continue
    node.setPortProp(port.id, 'attrs/circle/style/visibility', visible ? 'visible' : 'hidden')
  }
}

/**
 * Which of {@link CANVAS_PLUGIN_NAMES} did NOT load. Empty means the pin holds.
 *
 * This is the §3.4 guard in one function: it asks the graph for each plugin
 * INSTANCE rather than trusting that `use()` returned without throwing, which
 * is the exact difference between "the plugins are installed" and "nothing
 * blew up while installing them".
 */
export function missingCanvasPlugins(graph: Graph): CanvasPluginName[] {
  return CANVAS_PLUGIN_NAMES.filter((name) => !graph.getPlugin(name))
}

/**
 * Replace the graph's contents with `doc`, rendered in `palette`.
 *
 * `fromJSON` after a `clearCells` rather than a diff: U2 has no edit state to
 * preserve, the caps (§4.7) bound the document at 2,000 nodes, and a full
 * rebuild is the only way a palette change reaches EVERY existing cell. It
 * deliberately does NOT touch the viewport — preserving pan/zoom across a
 * re-render is spec §7.3 case A and AC U2-8, and it is why fitting is a
 * separate, explicit call.
 */
export function renderCanvasDocument(
  graph: Graph,
  doc: CanvasDocument,
  palette: CanvasPalette,
  images: ResolvedImages = {}
): void {
  graph.clearCells()
  graph.fromJSON(toX6Cells(doc, palette, images))
}

/**
 * Push a new palette onto the graph chrome (background + grid). The CELLS are
 * recoloured by re-rendering the document through {@link renderCanvasDocument},
 * since their colours are SVG attributes rather than CSS classes — together the
 * two calls are what makes a theme switch recolour the canvas without a reload
 * (spec §6.4, AC U2-4).
 */
export function applyCanvasPalette(graph: Graph, palette: CanvasPalette): void {
  graph.drawBackground({ color: palette.bg })
  // `drawGrid` re-paints with a new *appearance*; the PITCH is graph state and
  // is not part of these options — it was set at construction and a theme
  // switch has no business changing it.
  graph.drawGrid({ type: 'dot', args: { color: palette.border2, thickness: CANVAS_GRID_DOT } })
}

/** Zoom by a factor, clamped. Returns the scale actually applied. */
export function zoomCanvasBy(graph: Graph, factor: number): number {
  const next = Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, graph.zoom() * factor))
  graph.zoomTo(next)
  return next
}

/**
 * Fit the document into view. A no-op on an empty document — `zoomToFit` with
 * no cells has no bounding box to fit and would jump the viewport to nowhere.
 */
export function fitCanvas(graph: Graph): void {
  if (graph.getCellCount() === 0) return
  graph.zoomToFit({ padding: CANVAS_FIT_PADDING, maxScale: 1, minScale: CANVAS_MIN_SCALE })
}
