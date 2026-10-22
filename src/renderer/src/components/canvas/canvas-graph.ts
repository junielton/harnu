import { Graph, ObjectExt, Shape, type Edge, Node } from '@antv/x6'
import { Selection } from '@antv/x6-plugin-selection'
import { History } from '@antv/x6-plugin-history'
import { Transform } from '@antv/x6-plugin-transform'
import { Snapline } from '@antv/x6-plugin-snapline'
import type { CanvasDocument, CanvasNode } from '../../../../main/canvas-core'
import { toX6Cells, toX6Node, type ResolvedImages } from './canvas-cells'
import { nodeDraftFromCell, operatorEdgeData } from './canvas-edit'
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
  /**
   * Whether nodes take pointer input right now (T536 U1). Read on EVERY
   * gesture through X6's `interacting` hook, never captured, so a tool switch
   * (Select → Hand) needs no graph rebuild. `false` means a node does not move
   * and its ports do not start an edge; the press falls through to whatever
   * the active tool does with it. Defaults to `() => true`. Ignored on a
   * read-only graph, where nothing is interactive anyway.
   */
  nodesInteractive?: () => boolean
}

/**
 * Minimum footprint X6's resize handles may shrink a node to. Matches
 * `MIN_DRAWN_NODE_SIZE` in `canvas-edit.ts` — a node the operator can draw but
 * cannot resize back to is an inconsistency the operator would read as a bug.
 */
export const CANVAS_MIN_NODE_SIZE = { width: 48, height: 32 } as const

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

/**
 * Graphs built with `editable: true`. {@link setCanvasRubberband} consults it
 * before ARMING the rubberband: X6 cannot tell a viewer from an editor on its
 * own (see the guard's comment). A WeakSet, so a disposed graph is not kept
 * alive by being recorded here.
 */
const editableGraphs = new WeakSet<Graph>()

export function createCanvasGraph(opts: CreateCanvasGraphOptions): Graph {
  const { container, palette } = opts
  const editable = opts.editable === true
  const nodesInteractive = opts.nodesInteractive ?? (() => true)
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
    // Editable: the plain left drag belongs to the active tool (T536 §5 —
    // rubberband in Select, draw in a shape tool), so panning stays on the
    // right button in EVERY tool. A keyboard modifier would not do: shift is
    // add-to-selection and ctrl/meta are zoom and multi-select.
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
    //
    // A FUNCTION, not an object (T536 U1): X6 calls it per gesture (`CellView.
    // can`), so `nodesInteractive()` is read live and a tool switch takes
    // effect on the next press without rebuilding the graph.
    interacting: editable
      ? () => ({
          nodeMovable: nodesInteractive(),
          magnetConnectable: nodesInteractive(),
          edgeMovable: false,
          edgeLabelMovable: false,
          arrowheadMovable: false,
          vertexMovable: false,
          vertexAddable: false,
          vertexDeletable: false
        })
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
            createEdge: () => (self as Graph).createEdge(operatorEdgeSpec(palette))
          }
        }
      : {})
  })
  self = graph
  if (editable) editableGraphs.add(graph)

  // Rubberband is OFF in U2, and `showNodeSelectionBox` with it. The plugin is
  // still INSTALLED — that is what {@link missingCanvasPlugins} guards, and it
  // is what U3 switches on — but its blank-area drag competes with panning for
  // the same gesture, and selecting a node in a read-only pane leads nowhere.
  // Verified in the real app: with both on, one drag panned AND left a
  // selection box behind it. Editable, panning lives on the right button, and
  // the plain left drag is the rubberband — armed or not per tool by the pane
  // through {@link setCanvasRubberband}.
  graph.use(
    new Selection(
      editable
        ? {
            enabled: true,
            multiple: true,
            rubberband: true,
            // No modifier: in the Select tool the plain drag IS the
            // rubberband (T536 §5). Which tool owns the drag is the pane's call,
            // made through `setCanvasRubberband` — not a key split in here.
            modifiers: null,
            // Shift joins ctrl/meta so shift+click toggles a node in the
            // selection, as in Excalidraw.
            multipleSelectionModifiers: ['ctrl', 'meta', 'shift'],
            showNodeSelectionBox: true,
            pointerEvents: 'none'
          }
        : { rubberband: false, showNodeSelectionBox: false }
    )
  )
  graph.use(
    new History({
      enabled: true,
      // A change marked derived is the pane re-deriving attrs from `data` (T536
      // U3, {@link restyleCanvasNode}): never a command of its own. Returning
      // `false` here stops it before X6's `push`, which is also what would
      // otherwise empty the redo stack.
      beforeAddCommand: (_event, args) => !isDerivedChange(args)
    })
  )
  graph.use(
    new Transform({
      resizing: editable
        ? {
            // Read per node click, like `interacting`: a node clicked in any
            // tool but Select gets no handles (T536 U1). Handles already open
            // when the tool changes are closed by `hideCanvasResizeHandles`.
            enabled: () => nodesInteractive(),
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
 * The option a write carries when it is DERIVED state, not an edit (T536 U3).
 * Node styles live in `data` (`props.style`); the colours, dasharray and sizes
 * they turn into are attrs computed from it with the current palette. Only the
 * `data` write may enter the undo history: if the attrs did too, an undo after a
 * theme switch would restore colours resolved for the theme before it (U3
 * Review Focus 1). The History plugin installed by {@link createCanvasGraph}
 * drops any change whose options carry this key.
 */
export const CANVAS_DERIVED_CHANGE = 'harnuDerived'

function isDerivedChange(args: unknown): boolean {
  if (typeof args !== 'object' || args === null) return false
  const options = (args as { options?: unknown }).options
  return (
    typeof options === 'object' &&
    options !== null &&
    (options as Record<string, unknown>)[CANVAS_DERIVED_CHANGE] === true
  )
}

/**
 * Re-derive a node's attrs from its own cell — its `data` (kind, props, style),
 * its label and its size — exactly as a render from the file would draw it. The
 * pane calls this on every `cell:change:data`, so a style write, its undo and its
 * redo all repaint from the style alone, in the palette in force NOW.
 *
 * The write is marked {@link CANVAS_DERIVED_CHANGE} (never recorded in history)
 * and `dirty` (X6 re-renders the view instead of patching it, so an attribute the
 * new attrs no longer carry — a dasharray after a reset to `solid` — is removed
 * from the SVG rather than left behind). It runs inside X6's own `change:data`
 * dispatch, so it also lands during an undo, while History is not recording.
 */
export function restyleCanvasNode(
  node: Node,
  palette: CanvasPalette,
  images: ResolvedImages
): void {
  const draft = nodeDraftFromCell(node.toJSON() as Record<string, unknown>)
  // `origin` is only read into `data`, which this does not write: the cast
  // invents nothing that reaches the file.
  const attrs = toX6Node(draft as CanvasNode, palette, images).attrs
  if (typeof attrs !== 'object' || attrs === null) return
  // `overwrite` replaces the WHOLE attrs object, including what the X6 shape class
  // itself contributes at construction (a rect's `refWidth`/`refHeight`, an
  // ellipse's `refRx`, the label's centring `refX`/`refY`): without them a box
  // collapses to 0×0 and its label jumps to the corner. So lay the derived attrs
  // over the class defaults, exactly as the constructor does on a fresh render.
  const defaults = (node.constructor as typeof Node).getDefaults().attrs ?? {}
  node.setAttrs(ObjectExt.merge({}, defaults, attrs) as Node.Properties['attrs'], {
    overwrite: true,
    dirty: true,
    [CANVAS_DERIVED_CHANGE]: true
  })
}

/**
 * The edge an OPERATOR draws, without its ends: stamped `operator` (AC U3-3),
 * routed and styled the same way whichever gesture made it. Both creation paths
 * mint through this one spec, a port drag in Select (`connecting.createEdge`)
 * and the Arrow tool (T536 U1), so the two can never drift apart. A fresh object
 * per call, so no two edges share a `data` bag.
 */
export function operatorEdgeSpec(palette: CanvasPalette): Edge.Metadata {
  return {
    shape: 'edge',
    data: operatorEdgeData(),
    // Edges draw under every node (T536 U4), like `toX6Edge`. Without a z, X6's
    // `prepareCell` would give the new edge max + 1 and paint it over every shape
    // until the next redraw. A drag's own temporary `toFront` restores this on release.
    zIndex: 0,
    router: { name: 'manhattan' },
    connector: { name: 'rounded', args: { radius: 8 } },
    attrs: {
      line: {
        stroke: palette.accent,
        strokeWidth: 1.5,
        targetMarker: { name: 'block', width: 8, height: 6 }
      }
    }
  }
}

/**
 * Close any open resize handles. The pane calls it when the tool leaves Select
 * (T536 U1): a handle left on screen in Arrow or Eraser would still resize the
 * node on a press, so the press would not belong to the active tool. New
 * handles stay closed because `resizing.enabled` reads `nodesInteractive()`.
 */
export function hideCanvasResizeHandles(graph: Graph): void {
  const transform = graph.getPlugin('transform') as Transform | undefined
  transform?.clearWidgets()
}

/**
 * The id of the node whose resize handles are open, or `null` (T536 U3). A
 * redraw (a theme switch) replaces every cell and closes the handles with them;
 * this is what lets the pane reopen them on the same node. X6 keeps its open
 * widgets keyed by node in a field it does not type as public, so it is read
 * defensively: an X6 without it reports none, and the handles simply stay closed.
 */
export function openCanvasResizeHandleId(graph: Graph): string | null {
  const transform = graph.getPlugin('transform') as { widgets?: unknown } | undefined
  const widgets = transform?.widgets
  if (!(widgets instanceof Map)) return null
  for (const node of widgets.keys()) {
    // A node deleted and brought back by undo is a different instance under the same
    // id: its stale widget entry is not an open handle on anything on the board.
    if (node instanceof Node && graph.getCellById(node.id) === node) return node.id
  }
  return null
}

/**
 * Open the resize handles on node `id`, as a click on it in Select would. The
 * plugin's own `resizing.enabled` still decides, so outside Select this opens
 * nothing.
 */
export function showCanvasResizeHandles(graph: Graph, id: string): void {
  const cell = graph.getCellById(id)
  const transform = graph.getPlugin('transform') as Transform | undefined
  if (transform && cell?.isNode()) transform.createWidget(cell)
}

/**
 * Arm or disarm the rubberband (the blank-area drag-select) at runtime.
 *
 * Spike, 2026-10-19 (T536 U1, ≤1h, real app): an isolated second Harnu
 * instance, a live editable canvas pane, real pointer input through CDP
 * `Input.dispatchMouseEvent` (not jsdom), with the pane's own draw-a-box
 * listener detached so only X6 was measured. Findings, on X6 2.19.2 +
 * x6-plugin-selection 2.x:
 *
 *  - **A Selection built with `modifiers: null` rubberbands on a plain left
 *    drag.** The band rendered mid-drag and the release selected exactly the
 *    two nodes it covered.
 *  - **`disableRubberband()` / `enableRubberband()` toggle at runtime.** After
 *    `disableRubberband()` the same plain drag showed no band and selected
 *    nothing; after `enableRubberband()` it selected the two nodes again. No
 *    graph rebuild, no plugin re-install: the plugin reads
 *    `options.rubberband` on every `blank:mousedown`.
 *  - **shift + drag still rubberbands with these options, but REPLACES the
 *    selection.** `Selection.startSelecting` calls `clean()` before the band
 *    starts, so a shift-drag over A and B with C selected ended on {A, B}, not
 *    {A, B, C}. "shift+drag adds to the selection" (§5) needs the pane to
 *    re-add the prior selection itself — X6 will not.
 *  - shift+click adds a node and ctrl+click toggles it, with
 *    `multipleSelectionModifiers: ['ctrl', 'meta', 'shift']`.
 *  - With the pane's current draw-a-box listener still attached, one plain
 *    drag both drew a box AND ran the band, and ended with nothing selected:
 *    a blank drag must belong to exactly one tool.
 *
 * Disarm it in any tool whose blank drag is not a selection (Hand pans, the
 * shape tools draw), or X6 runs both over the same gesture — the conflict U2
 * observed live.
 *
 * **Arming is refused on a graph not built `editable`.** X6 alone would not
 * refuse it: a read-only graph's Selection still has `enabled: true` (the
 * plugin defaults it on; only `rubberband` is off), so `enableRubberband()`
 * would switch blank-drag selection on in a viewer and break the U2 contract
 * that nothing the pointer does may change a read-only board. Disarming is
 * allowed on any graph — turning an input off can never violate that.
 */
export function setCanvasRubberband(graph: Graph, enabled: boolean): void {
  if (!enabled) {
    graph.disableRubberband()
    return
  }
  if (!editableGraphs.has(graph)) return
  graph.enableRubberband()
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
    // Chrome, not an edit: marked derived so a hover never becomes an undo step
    // (and never empties the redo stack — X6 clears it on every recorded change).
    node.setPortProp(port.id, 'attrs/circle/style/visibility', visible ? 'visible' : 'hidden', {
      [CANVAS_DERIVED_CHANGE]: true
    })
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
