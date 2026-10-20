<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Scan,
  Shapes,
  Undo2,
  X
} from 'lucide-vue-next'
import { ObjectExt, type Cell, type Graph, type Node } from '@antv/x6'
import CanvasToolbar from './CanvasToolbar.vue'
import CanvasPropertiesPanel from './CanvasPropertiesPanel.vue'
import { useHelpersStore, type AnyHelperPane } from '../stores/helpers'
import { useThemeStore } from '../stores/theme'
import { useUiStore } from '../stores/ui'
import {
  applyCanvasPalette,
  createCanvasGraph,
  fitCanvas,
  hideCanvasResizeHandles,
  missingCanvasPlugins,
  openCanvasResizeHandleId,
  operatorEdgeSpec,
  renderCanvasDocument,
  restyleCanvasEdge,
  restyleCanvasNode,
  setCanvasPortsVisible,
  showCanvasResizeHandles,
  setCanvasRubberband,
  zoomCanvasBy
} from './canvas/canvas-graph'
import { canvasImageSources, toX6Node, type ResolvedImages } from './canvas/canvas-cells'
import { arrowEdgeEnds, pointInRect, topmostNodeId } from './canvas/canvas-arrow'
import {
  ERASE_REACH_PX,
  edgeWithinReach,
  eraseReach,
  eraseRemovalOrder,
  strokeSamples
} from './canvas/canvas-erase'
import {
  buildCanvasDocumentFromCells,
  duplicateOperatorNode,
  imageNodeSize,
  isDrawGesture,
  operatorImageNode,
  operatorNode,
  placedRect,
  rectFromDrag,
  type CanvasDocumentDraft,
  type CanvasStackMode
} from './canvas/canvas-edit'
import {
  liveStackOrder,
  reorderStack,
  stackRanks,
  type LayerMove,
  type StackNode
} from './canvas/canvas-layers'
import { readCanvasPalette, type CanvasPalette } from './canvas/canvas-theme'
import {
  EDGE_STYLE_KIND,
  mergeCanvasStyle,
  panelValues,
  sharedStyleOptions,
  stylePanelCollapsed,
  stylePanelTop,
  styleKeysFor,
  styleOptionsFor,
  type CanvasStyleKey,
  type CanvasStylePatch,
  type StyleOptions
} from './canvas/canvas-style'
import {
  CANVAS_TOOLS,
  INITIAL_TOOL_STATE,
  afterCreate,
  blankIntent,
  effectiveTool,
  escapeOutcome,
  isShapeTool,
  nodeIntent,
  pressSpace,
  releaseSpace,
  selectTool,
  shapeForTool,
  toggleLock,
  toolForKey,
  toolbarNeedsOwnRow,
  type CanvasTool,
  type ShapeTool,
  type ToolState
} from './canvas/canvas-tools'
import type { CanvasDocument } from '../../../main/canvas-core'
import type { HelperPane } from '../../../preload'

/**
 * File-backed canvas viewer pane (T218 U2, spec §6, design.md §6 — "Diagram
 * pane"). Mounts AntV X6 over a `*.capycanvas.json` document read through U1's
 * confined `canvas:read` IPC and draws it in Harnu's tokens.
 *
 * **An editor since T218 U3 (spec §6, §7).** The operator draws, renames,
 * connects, selects, resizes, deletes, undoes and redoes against the in-memory
 * graph; NOTHING touches the file until an explicit Save (§7.1). Save goes
 * through U1's confined writer, which validates before it writes a byte — this
 * pane never serializes to disk itself.
 *
 * **The three cases in §7.3 are the whole subtlety.** The file can change under
 * a pane that is *clean* (case A — reload silently, keep the viewport, drop the
 * undo history because it now describes a document that no longer exists) or
 * under one that is *dirty* (case B — never reload; raise the stale banner and
 * let the operator choose). Case C is what happens if they then Save: last
 * write wins, deliberately, and the banner is what makes that informed rather
 * than silent.
 *
 * NON-PTY, like the Markdown/Memory/Explorer panes: reproducible from its
 * `filePath`, never enters `liveHelpers`, mounts and unmounts freely. The
 * terminal's detach-not-dispose rule does not apply — the graph is disposed on
 * unmount and rebuilt on the next mount.
 */
interface Props {
  /** The shared pane union (HelperStack routes only `type:'canvas'` here). */
  pane: AnyHelperPane
  worktreePath: string
  /** Whether this pane's header doubles as the resize handle (false for pane 0). */
  resizable?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{ headerMouseDown: [ev: MouseEvent] }>()

const { t } = useI18n()
const helpers = useHelpersStore()
const theme = useThemeStore()
const ui = useUiStore()

/** The pane's persisted `filePath` (HelperStack guarantees a canvas pane). */
const filePath = computed<string>(() => (props.pane as HelperPane).filePath ?? '')

/** Cross-platform basename/dirname — the renderer has no node `path`. */
function basename(p: string): string {
  return (
    p
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || p
  )
}
function dirname(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx <= 0 ? trimmed : trimmed.slice(0, idx)
}

const fileName = computed<string>(() => basename(filePath.value))

type ViewState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; code: string }
const state = ref<ViewState>({ status: 'loading' })

/** The last document read from disk — the authority this pane renders (spec §4). */
const doc = shallowRef<CanvasDocument | null>(null)
/** `props.src` → `data:` URL for every image node whose asset could be read. */
const images = ref<ResolvedImages>({})
/** Zoom percentage shown in the control cluster; kept in sync with the graph. */
const zoomPct = ref(100)

// ── Edit state (spec §7.1) ────────────────────────────────────────────────
/**
 * Unsaved edits present? Drives the dirty dot, the Save enablement and every
 * discard guard.
 *
 * A BOOLEAN, not a content comparison like `MarkdownPane`'s: spec §7.1 defines
 * it as "appears on the first change and clears on a successful Save", and the
 * honest alternative — re-serializing the whole graph on every mutation to
 * diff it — would run per `mousemove` of a node drag against a document capped
 * at 2,000 nodes. The cost of the simpler rule is that undoing back to the
 * original state still reads as dirty; the cost of that is one Save writing
 * bytes identical to what is already on disk, which is harmless.
 */
const dirty = ref(false)
/** §7.3 case B: the file moved under a pane with unsaved edits. */
const staleOnDisk = ref(false)
const canUndo = ref(false)
const canRedo = ref(false)
const saving = ref(false)

/**
 * Suppresses dirty-tracking while the PANE — not the operator — mutates the
 * graph: a load, a silent reload, a theme redraw, a port-visibility toggle on
 * hover. Every one of those fires the same `cell:*` events an operator edit
 * does, and without this a theme switch or a mouse passing over a node would
 * light the dirty dot.
 */
let programmatic = false
function withoutTracking<T>(fn: () => T): T {
  const prev = programmatic
  programmatic = true
  try {
    return fn()
  } finally {
    programmatic = prev
  }
}

const isEmpty = computed<boolean>(
  () => state.value.status === 'ready' && (doc.value?.nodes.length ?? 0) === 0
)

/**
 * `canvas:read` deny code → i18n subkey under `diagramPane.error`. The reader
 * refuses with a machine-readable code and never a clamp (§4.2/§4.7), so this
 * is the one place a code becomes a sentence — an operator must never be shown
 * `schema-unsupported` verbatim.
 */
function errorKey(code: string): string {
  const map: Record<string, string> = {
    'invalid-path': 'invalidPath',
    'outside-roots': 'outsideRoots',
    'not-found': 'notFound',
    'too-large': 'tooLarge',
    'read-failed': 'readFailed',
    'write-failed': 'writeFailed',
    'parse-failed': 'invalidDocument',
    'schema-unsupported': 'schemaUnsupported',
    'invalid-document': 'invalidDocument',
    'missing-origin': 'invalidDocument',
    'invalid-origin': 'invalidDocument',
    'duplicate-id': 'invalidDocument',
    'dangling-edge': 'invalidDocument',
    'too-many-nodes': 'tooLarge',
    'too-many-edges': 'tooLarge',
    'label-too-long': 'invalidDocument'
  }
  return `diagramPane.error.${map[code] ?? 'readFailed'}`
}
const errorMessage = computed<string>(() =>
  state.value.status === 'error' ? t(errorKey(state.value.code)) : ''
)

// ── The graph ─────────────────────────────────────────────────────────────
const hostEl = ref<HTMLElement | null>(null)
/** The host's parent — the element whose size actually tracks the pane. */
const bodyEl = ref<HTMLElement | null>(null)
/** `shallowRef`: X6's `Graph` is a large class instance and must never be made
 *  deeply reactive — Vue would proxy its internal model and wreck it. */
const graph = shallowRef<Graph | null>(null)
let palette: CanvasPalette = readCanvasPalette()
let resizeObserver: ResizeObserver | null = null

function ensureGraph(): Graph | null {
  if (graph.value) return graph.value
  const host = hostEl.value
  if (!host) return null
  palette = readCanvasPalette()
  const box = bodyEl.value
  const g = createCanvasGraph({
    container: host,
    palette,
    editable: true,
    // Read per gesture by X6: nodes move and their ports connect only in
    // Select (spec §5) — in every other tool a press on a node belongs to that
    // tool, and Space-held Hand must pan over a node rather than drag it.
    nodesInteractive: () => activeTool.value === 'select',
    // Explicit size from the PARENT: X6 would otherwise read the host's own
    // `clientWidth`, which is 0 before layout settles and would leave the graph
    // sized to nothing.
    ...(box && box.clientWidth > 0 ? { width: box.clientWidth, height: box.clientHeight } : {})
  })

  // The §3.4 guard, at runtime as well as in the test: if a dependency bump
  // ever lands the broken 3.x-core + 2.x-plugin pairing, the pane says so in
  // the console instead of silently losing selection and the viewport tools.
  const missing = missingCanvasPlugins(g)
  if (missing.length > 0) {
    console.error(
      `[DiagramPane] X6 plugins failed to load: ${missing.join(', ')}. ` +
        'The @antv/x6 pin in package.json is load-bearing — see spec §3.4.'
    )
  }

  wireEditing(g)
  graph.value = g
  applyToolToGraph()
  return g
}

// ── Editing (spec §6, §7.1) ───────────────────────────────────────────────
/**
 * Every graph listener the editor needs, in one place.
 *
 * `cell:added` / `cell:removed` / `cell:change:*` is the widest net X6 offers
 * for "the model moved", which is what dirty must actually mean — a rename
 * writes attrs, a resize writes size, a drag writes position, and watching only
 * the history plugin would miss whatever it chooses not to record.
 */
function wireEditing(g: Graph): void {
  const touched = (): void => {
    if (programmatic) return
    dirty.value = true
    refreshHistoryFlags()
  }
  g.on('cell:added', touched)
  g.on('cell:removed', touched)
  g.on('cell:change:*', touched)
  g.on('history:change', refreshHistoryFlags)

  // Ports are hidden until the pointer is on the node that owns them — see
  // `canvas-cells.ts`. The toggle writes a cell prop, so it MUST go through
  // `withoutTracking` or merely hovering a node would light the dirty dot.
  g.on('node:mouseenter', ({ node }) => {
    withoutTracking(() => setCanvasPortsVisible(g, node.id, true))
  })
  g.on('node:mouseleave', ({ node }) => {
    withoutTracking(() => setCanvasPortsVisible(g, node.id, false))
  })

  g.on('node:dblclick', ({ node }) => {
    if (nodeIntent(activeTool.value, 'dblclick', nodeKind(node)) === 'rename-node') {
      startRename(node.id)
    }
  })
  g.on('blank:dblclick', onBlankDblClick)
  g.on('blank:mousedown', onBlankMouseDown)
  g.on('node:mousedown', onNodeMouseDown)
  g.on('edge:mousedown', onEdgeMouseDown)

  // These run AFTER the Selection plugin's own listeners on the same events
  // (it registered at graph construction, before this function), which is the
  // whole point: they repair what the plugin just did to the selection.
  g.on('blank:mouseup', onBlankMouseUp)
  g.on('blank:click', restorePendingSelection)
  g.on('cell:mouseup', restorePendingSelection)
  g.on('selection:changed', ({ selected }: { selected: Cell[] }) => {
    selectedIds.value = selected.map((c) => c.id)
    if (!repairingSelection && activeTool.value === 'select' && selected.length > 0) {
      markUsed('select')
    }
  })

  // Node and arrow styles (T536 U3, U5): `data` is the only style state, and the
  // only part of a style change History records. The attrs are re-derived from it
  // here on every data write — the panel's, its undo and its redo alike — in the
  // palette in force now, and that re-derive never enters the undo stack (see
  // `restyleCanvasNode` / `restyleCanvasEdge`). So undo after a theme switch
  // restores a STYLE, never the colours the previous theme resolved it to (U3
  // Review Focus 1).
  g.on('cell:change:data', ({ cell }: { cell: Cell }) => {
    if (cell.isNode() && styleKeysFor(nodeKind(cell)).length > 0) {
      restyleCanvasNode(cell, palette, images.value)
    } else if (cell.isEdge()) {
      restyleCanvasEdge(cell, palette)
    }
    styleRevision.value++
  })
  const restyled = (): void => {
    styleRevision.value++
  }
  g.on('history:undo', restyled)
  g.on('history:redo', restyled)
}

function refreshHistoryFlags(): void {
  const g = graph.value
  canUndo.value = g ? g.canUndo() : false
  canRedo.value = g ? g.canRedo() : false
}

/** Every id currently in play — what a new element must be minted against. */
function takenIds(): Set<string> {
  const g = graph.value
  if (!g) return new Set()
  return new Set(g.getCells().map((c) => c.id))
}

// ── Tool modes (T536 U1, spec §4.3, §5) ───────────────────────────────────
/**
 * The pane's tool, in memory and never saved to the file. One per pane
 * instance, so two canvases open side by side keep independent tools.
 */
const toolState = ref<ToolState>({ ...INITIAL_TOOL_STATE })
/** Tools used successfully in this pane's lifetime; the toolbar hides their hint. */
const usedTools = ref(new Set<CanvasTool>())
/** The tool that actually owns gestures — Space held is a temporary Hand. */
const activeTool = computed<CanvasTool>(() => effectiveTool(toolState.value))
/** A Hand gesture is in flight (the cursor reads `grabbing`). */
const panning = ref(false)
const bodyCursor = computed<string>(() =>
  panning.value
    ? 'grabbing'
    : (CANVAS_TOOLS.find((t) => t.id === activeTool.value)?.cursor ?? 'default')
)

/**
 * Every tool change goes through here. A change of the EFFECTIVE tool cancels
 * whatever gesture was in flight (Review Focus 2: no preview left behind) and
 * re-arms the graph for the new owner of a blank drag.
 */
function setToolState(next: ToolState): void {
  const before = effectiveTool(toolState.value)
  toolState.value = next
  if (effectiveTool(next) !== before) {
    cancelGesture()
    applyToolToGraph()
  }
}

/**
 * A blank drag goes to EXACTLY ONE owner. X6's rubberband starts on any plain
 * left drag while it is armed (`modifiers: null`) and is checked before
 * panning, so every tool but Select must switch it off — or one drag would
 * both rubberband and draw/pan (the Task 2 spike, measured live).
 */
function applyToolToGraph(): void {
  const g = graph.value
  if (!g) return
  const select = activeTool.value === 'select'
  setCanvasRubberband(g, select)
  // Resize handles belong to Select too: one left open in another tool would
  // resize the node on a press that should go to that tool.
  if (!select) hideCanvasResizeHandles(g)
}

function markUsed(tool: CanvasTool): void {
  if (!usedTools.value.has(tool)) usedTools.value.add(tool)
}

function onToolbarSelect(tool: CanvasTool): void {
  setToolState(selectTool(toolState.value, tool))
  focusBody()
}
function onToolbarToggleLock(): void {
  setToolState(toggleLock(toolState.value))
  focusBody()
}

/** The document shape of a node (`box`, `text`, …), as `canvas-cells` stamps it. */
function nodeKind(node: Node): string {
  const data = node.getData() as { kind?: unknown } | undefined
  return typeof data?.kind === 'string' ? data.kind : node.shape
}

// ── Properties panel (T536 U3, design.md §6 "Properties panel") ───────────
/** The selection, mirrored from X6's `selection:changed` so the panel can react. */
const selectedIds = ref<string[]>([])
/**
 * Bumped on every `data` write and every undo/redo. The graph is not reactive,
 * so this is what makes the panel re-read the selected nodes' styles — after a
 * pick, and after an undo puts an old one back.
 */
const styleRevision = ref(0)
/** Collapsed form only: whether the `palette` button has opened the panel. */
const panelOpen = ref(false)
/** The pane is too narrow for the panel beside a usable board. */
const panelCollapsed = ref(false)
/** Measured top offset, in px from the top of the body. */
const panelTop = ref(stylePanelTop(0, false, 0))

/** What a cell is in the selection maths: its node kind, or {@link EDGE_STYLE_KIND} for an arrow. */
function cellKind(cell: Cell): string {
  return cell.isNode() ? nodeKind(cell) : EDGE_STYLE_KIND
}

function cellProps(cell: Cell): Record<string, unknown> | undefined {
  const props = (cell.getData() as { props?: unknown } | undefined)?.props
  return typeof props === 'object' && props !== null && !Array.isArray(props)
    ? (props as Record<string, unknown>)
    : undefined
}

/** The selected cells, nodes AND arrows (T536 U5): what the style groups act on. */
const panelCells = computed<Cell[]>(() => {
  void styleRevision.value
  const g = graph.value
  if (!g) return []
  return selectedIds.value.map((id) => g.getCellById(id)).filter((c): c is Cell => c !== null)
})
/** The selected NODES only: Layers acts on nodes, never on an arrow (T536 U4). */
const panelNodes = computed<Node[]>(() => panelCells.value.filter((c): c is Node => c.isNode()))
/** What EVERY selected cell takes, per key (U3 Review Focus 4, U5 Review Focus 3). */
const panelOptions = computed<StyleOptions>(() =>
  sharedStyleOptions(panelCells.value.map(cellKind))
)
const panelKeys = computed<CanvasStyleKey[]>(
  () => Object.keys(panelOptions.value) as CanvasStyleKey[]
)
/** Every selected cell is an arrow: the panel draws line glyphs for its tones. */
const panelEdgeOnly = computed<boolean>(
  () => panelCells.value.length > 0 && panelCells.value.every((c) => c.isEdge())
)
const panelStyleValues = computed(() =>
  panelValues(panelCells.value.map((c) => ({ kind: cellKind(c), props: cellProps(c) })))
)
/**
 * The CHOSEN tool, not the effective one: holding Space is a temporary Hand, and
 * the panel stays put through it. It shows for a selection with a shared style
 * key (an arrow alone has two) or a node (the Layers group, T536 U4, takes every
 * kind, even one with no shared style key).
 */
const panelVisible = computed<boolean>(
  () =>
    state.value.status === 'ready' &&
    toolState.value.tool === 'select' &&
    (panelKeys.value.length > 0 || panelNodes.value.length > 0)
)

watch(
  () => selectedIds.value.length,
  (n) => {
    if (n === 0) panelOpen.value = false
  }
)
watch(panelVisible, async (visible) => {
  if (!visible) return
  await nextTick()
  measureStylePanel()
})

/** The properties panel's history batch: one pick, one undo step. */
const STYLE_BATCH = 'style'

/**
 * A panel pick. Each cell keeps only the patch keys AND values its kind takes
 * (an arrow takes no `accent` tone and no `strokeWidth`), so a mixed selection
 * never writes `corners` onto an ellipse or anything onto a mockup card; a cell
 * whose props would come out unchanged is skipped. Whatever does change is
 * written in ONE history batch: one pick, one undo step, however many cells it
 * styled. The attrs follow through `cell:change:data`. A reset removes the props
 * from the cell data, so a Save writes none.
 */
function applyStylePatch(patch: CanvasStylePatch): void {
  const g = graph.value
  if (!g) return
  const writes: [Cell, Record<string, unknown>][] = []
  for (const cell of panelCells.value) {
    const allowed = styleOptionsFor(cellKind(cell))
    const own: CanvasStylePatch = {}
    for (const key of Object.keys(patch) as CanvasStyleKey[]) {
      const value = patch[key]
      // `null` removes the key: always fine for a key the cell takes.
      const options = allowed[key]
      if (options === undefined) continue
      if (value === null || value === undefined || options.includes(value)) own[key] = value
    }
    if (Object.keys(own).length === 0) continue
    const props = cellProps(cell)
    const next = mergeCanvasStyle(props, own)
    if (ObjectExt.isEqual(next, props)) continue
    const data: Record<string, unknown> = { ...(cell.getData() as Record<string, unknown>) }
    if (next === undefined) delete data.props
    else data.props = next
    writes.push([cell, data])
  }
  if (writes.length === 0) return
  g.startBatch(STYLE_BATCH)
  try {
    for (const [cell, data] of writes) cell.setData(data, { overwrite: true })
  } finally {
    g.stopBatch(STYLE_BATCH)
  }
}

/** The Layers group's history batch: one move, one undo step. */
const LAYER_BATCH = 'layer'

/**
 * A Layers move (T536 U4). The new order is computed on node ids by the pure
 * `reorderStack` and written back as dense ranks 1..n — never X6's `toFront` /
 * `toBack`, which rank against the edges too (see `canvas-layers.ts`). Only the
 * nodes whose z actually changes are written, in ONE history batch, so a move is
 * one undo step and a move that changes nothing writes nothing: no undo step, no
 * dirty dot. Edges keep z 0 and are never touched.
 */
function applyLayerMove(move: LayerMove): void {
  const g = graph.value
  if (!g) return
  const nodes = g.getNodes()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const live = nodes.map((n) => ({ id: n.id, z: n.getZIndex() ?? 0 }))
  const stack: StackNode[] = liveStackOrder(live).map((id) => {
    const node = byId.get(id)!
    const { x, y, width, height } = node.getBBox()
    return { id, z: node.getZIndex() ?? 0, bbox: { x, y, width, height } }
  })
  const order = reorderStack(stack, new Set(panelNodes.value.map((n) => n.id)), move)
  if (order === null) return
  const ranks = stackRanks(order)
  const writes = order.filter((id) => byId.get(id)!.getZIndex() !== ranks.get(id))
  if (writes.length === 0) return
  g.startBatch(LAYER_BATCH)
  try {
    for (const id of writes) byId.get(id)!.setZIndex(ranks.get(id)!)
  } finally {
    g.stopBatch(LAYER_BATCH)
  }
}

function onPanelToggle(): void {
  panelOpen.value = !panelOpen.value
}

// ── Selection bookkeeping around X6's own mouseup handling ────────────────
/**
 * The selection as it stood just BEFORE this press, captured on the body in
 * the capture phase — i.e. before X6 sees the event. It has to be that early:
 * X6's rubberband `clean()`s the selection as it starts, inside the very
 * `blank:mousedown` dispatch the pane listens to.
 */
let preGestureSelection: string[] = []
/** `shift`+drag in Select: union this back in once the rubberband finishes. */
let additiveSelection: string[] | null = null
/**
 * What the selection must be once X6 finishes the current release. A tool
 * other than Select owns its gesture, but X6's Selection plugin still reacts
 * to the same mouseup — `cell:mouseup` selects the pressed node and
 * `blank:click` clears everything. Both run after the pane's capture-phase
 * release, so the pane re-applies its answer after them.
 */
let pendingSelection: string[] | null = null
/** The pane, not the operator, is re-selecting: not a use of the Select tool. */
let repairingSelection = false
/**
 * The press point in CLIENT pixels, read off the native event. The point X6
 * hands its `blank:mousedown`/`node:mousedown` listeners is snapped to the
 * 16px grid, which would put a placed shape up to 8px off the click and make a
 * pan jump on its first move — so every tool gesture starts from this instead.
 */
let pressClient = { x: 0, y: 0 }

function onBodyMouseDownCapture(ev: MouseEvent): void {
  const g = graph.value
  pressClient = { x: ev.clientX, y: ev.clientY }
  preGestureSelection = g ? g.getSelectedCells().map((c) => c.id) : []
  additiveSelection = null
  pendingSelection = null
}

function selectIds(g: Graph, ids: readonly string[]): void {
  const cells = ids.map((id) => g.getCellById(id)).filter((c) => c !== null)
  if (cells.length > 0) g.select(cells)
}

function restorePendingSelection(): void {
  const g = graph.value
  const ids = pendingSelection
  // NOT consumed here: one release can reach X6 as BOTH `cell:mouseup` and
  // `blank:click` — an Eraser press removes the very view it landed on, so X6
  // reads the rest of that release as blank board and clears the selection
  // again after the first repair. It is reset by the next press instead
  // (`onBodyMouseDownCapture`).
  if (!g || !ids) return
  repairingSelection = true
  try {
    g.cleanSelection()
    selectIds(g, ids)
  } finally {
    repairingSelection = false
  }
}

/** The rubberband has just replaced the selection; with shift, add the old one back. */
function onBlankMouseUp(): void {
  const g = graph.value
  const ids = additiveSelection
  additiveSelection = null
  if (g && ids) selectIds(g, ids)
}

// ── Gestures: draw, place, pan ────────────────────────────────────────────
/** A tool gesture in flight, in graph-local coordinates where it matters. */
type Gesture =
  | {
      kind: 'create'
      tool: ShapeTool | 'text'
      start: { x: number; y: number }
      /** The node the press landed on, or `null` for empty board. */
      node: { id: string; shape: string } | null
    }
  | {
      kind: 'pan'
      client: { x: number; y: number }
      origin: { tx: number; ty: number }
      moved: boolean
    }
  | {
      kind: 'arrow'
      /** The node the arrow starts from. */
      source: string
    }
  | {
      kind: 'erase'
      /** What the press landed on: a blank press that never drags erases nothing. */
      on: 'blank' | 'cell'
      /** The press, graph-local, for the click-or-drag test. */
      start: { x: number; y: number }
      /** The last CLIENT point the stroke was probed at. */
      last: { x: number; y: number }
      /** Past the click threshold: from here on every move is probed. */
      dragged: boolean
      /** Everything the stroke has crossed, in marking order. */
      marked: Map<string, 'node' | 'edge'>
    }
let gesture: Gesture | null = null

/** The in-flight Rectangle draw, in graph-local coordinates; `null` when not drawing. */
const drawStart = ref<{ x: number; y: number } | null>(null)
const drawNow = ref<{ x: number; y: number } | null>(null)

/**
 * The preview rectangle, positioned in the BODY's coordinate space. The graph
 * is panned and zoomed underneath, so the rect is computed in world units and
 * projected back through `localToClient` — drawing it in client pixels instead
 * would drift the moment the operator draws at anything but 100%.
 */
const drawPreviewStyle = computed<Record<string, string> | null>(() => {
  const g = graph.value
  const a = drawStart.value
  const b = drawNow.value
  const box = bodyEl.value
  if (!g || !a || !b || !box) return null
  const tl = g.localToClient(Math.min(a.x, b.x), Math.min(a.y, b.y))
  const br = g.localToClient(Math.max(a.x, b.x), Math.max(a.y, b.y))
  const host = box.getBoundingClientRect()
  return {
    left: `${tl.x - host.left}px`,
    top: `${tl.y - host.top}px`,
    width: `${Math.max(0, br.x - tl.x)}px`,
    height: `${Math.max(0, br.y - tl.y)}px`
  }
})

/**
 * The in-flight Arrow, in graph-local coordinates: from the source node's
 * centre to the pointer. Drawn as an overlay, never as a graph cell, so the
 * preview can never enter the undo history or reach a Save.
 */
const arrowFrom = ref<{ x: number; y: number } | null>(null)
const arrowNow = ref<{ x: number; y: number } | null>(null)

/** The preview line in the BODY's coordinate space, projected like the draw preview. */
const arrowPreviewLine = computed<{ x1: number; y1: number; x2: number; y2: number } | null>(() => {
  const g = graph.value
  const a = arrowFrom.value
  const b = arrowNow.value
  const box = bodyEl.value
  if (!g || !a || !b || !box) return null
  const from = g.localToClient(a.x, a.y)
  const to = g.localToClient(b.x, b.y)
  const host = box.getBoundingClientRect()
  return {
    x1: from.x - host.left,
    y1: from.y - host.top,
    x2: to.x - host.left,
    y2: to.y - host.top
  }
})

/**
 * CAPTURE phase, and that is not a detail. X6 handles the drag's `mouseup` on
 * `document` and stops its propagation, so a bubble-phase listener on `window`
 * — the last hop in the bubble chain — never sees the release: the preview rect
 * stayed on screen and no box was ever created. Capture runs window → document
 * → target, so it lands before X6 can swallow it. Found in the real app;
 * jsdom's dispatch reaches the listener either way, so it does not reproduce
 * there. `removeEventListener` must be given the same flag or it removes
 * nothing. Every tool gesture (draw, place, pan) ends through it.
 */
const DRAW_LISTENER = { capture: true } as const

function beginGesture(next: Gesture): void {
  // A press after a lost release: end the old gesture first, or its listeners
  // stay doubled and an erase stroke's marks are left on the board for good.
  cancelGesture()
  gesture = next
  window.addEventListener('mousemove', onGestureMove, DRAW_LISTENER)
  window.addEventListener('mouseup', onGestureUp, DRAW_LISTENER)
}

function endGesture(): void {
  window.removeEventListener('mousemove', onGestureMove, DRAW_LISTENER)
  window.removeEventListener('mouseup', onGestureUp, DRAW_LISTENER)
  if (gesture?.kind === 'erase') clearEraseMarks(gesture)
  gesture = null
  drawStart.value = null
  drawNow.value = null
  arrowFrom.value = null
  arrowNow.value = null
  panning.value = false
}

/** Esc mid-gesture, or a tool switch: drop the gesture, create nothing. */
function cancelGesture(): void {
  if (gesture) endGesture()
}

function onBlankMouseDown({ e }: { e: MouseEvent }): void {
  // Left button only: right-drag belongs to panning in every tool (see
  // `canvas-graph.ts`).
  if (e.button !== 0) return
  focusBody()
  const tool = activeTool.value
  if (tool === 'select') {
    // The plugin owns the drag (rubberband) and the click (clear selection).
    // `shift` makes the drag ADD to the selection — X6 replaces it natively.
    if (e.shiftKey) additiveSelection = [...preGestureSelection]
    return
  }
  startToolGesture(tool, null)
}

function onNodeMouseDown({ e, node }: { e: MouseEvent; node: Node }): void {
  if (e.button !== 0) return
  const tool = activeTool.value
  // Select: X6's own select/move — nodes are interactive only in this tool.
  if (tool === 'select') return
  focusBody()
  startToolGesture(tool, { id: node.id, shape: nodeKind(node) })
}

/**
 * A press on an EDGE. Select keeps X6's own handling (select the edge). The
 * Eraser erases it. In every other tool an edge is not a target, so the press
 * is a press on blank board: Hand pans, Rectangle and Text place, Arrow does
 * nothing. Either way the tool owns it, so X6 must not select the edge on the
 * release (`pendingSelection`, set in `startToolGesture`).
 */
function onEdgeMouseDown({ e, edge }: { e: MouseEvent; edge: Cell }): void {
  if (e.button !== 0) return
  const tool = activeTool.value
  if (tool === 'select') return
  focusBody()
  startToolGesture(tool, null, tool === 'eraser' ? edge.id : null)
}

function startToolGesture(
  tool: CanvasTool,
  node: { id: string; shape: string } | null,
  edgeId: string | null = null
): void {
  const g = graph.value
  if (!g) return
  // Whatever X6's Selection plugin does on this release, a non-Select tool
  // leaves the selection as it was unless it creates something.
  pendingSelection = [...preGestureSelection]
  const { x, y } = g.clientToLocal(pressClient.x, pressClient.y)
  switch (tool) {
    case 'hand': {
      const t = g.translate()
      beginGesture({
        kind: 'pan',
        client: { ...pressClient },
        origin: { tx: t.tx, ty: t.ty },
        moved: false
      })
      panning.value = true
      return
    }
    case 'rectangle':
    case 'diamond':
    case 'ellipse':
      beginGesture({ kind: 'create', tool, start: { x, y }, node })
      drawStart.value = { x, y }
      drawNow.value = { x, y }
      return
    case 'text':
      // No preview: a text is placed at the press point whatever the drag.
      beginGesture({ kind: 'create', tool, start: { x, y }, node })
      return
    case 'arrow': {
      // Only a node starts an arrow (spec §5: no free arrows in v1). A press
      // on blank board shows nothing; the toolbar hint already says why.
      if (!node || nodeIntent(tool, 'press', node.shape) !== 'start-arrow') return
      const cell = g.getCellById(node.id)
      if (!cell || !cell.isNode()) return
      const centre = cell.getBBox().getCenter()
      beginGesture({ kind: 'arrow', source: node.id })
      arrowFrom.value = { x: centre.x, y: centre.y }
      arrowNow.value = { x, y }
      return
    }
    case 'eraser': {
      const gs: Gesture = {
        kind: 'erase',
        on: node || edgeId ? 'cell' : 'blank',
        start: { x, y },
        last: { ...pressClient },
        dragged: false,
        marked: new Map()
      }
      beginGesture(gs)
      // A press on a node or an edge erases it even without a drag (spec §5),
      // so it is marked at once. A blank press marks nothing until it drags.
      const pressedCell = g.getCellById(node?.id ?? edgeId ?? '')
      if (pressedCell) markForErase(g, gs, pressedCell)
      return
    }
    default:
      return
  }
}

// ── Eraser (spec §5) ──────────────────────────────────────────────────────
/**
 * The dimming a crossed-but-not-yet-erased cell gets (`design.md` §6, Eraser
 * mark). A class on the cell's VIEW, never a cell attribute: marking is not an
 * edit, so it never lights the dirty dot or enters the undo history.
 */
const ERASE_MARK = 'canvas-erase-mark'
/** The eraser's history batch: one stroke, one undo step. */
const ERASE_BATCH = 'erase'

type EraseGesture = Extract<Gesture, { kind: 'erase' }>

function markForErase(g: Graph, gs: EraseGesture, cell: Cell): void {
  if (gs.marked.has(cell.id)) return
  const view = g.findViewByCell(cell)
  if (!view) return
  view.addClass(ERASE_MARK)
  gs.marked.set(cell.id, cell.isEdge() ? 'edge' : 'node')
}

function clearEraseMarks(gs: EraseGesture): void {
  const g = graph.value
  if (!g) return
  for (const id of gs.marked.keys()) {
    const cell = g.getCellById(id)
    const view = cell ? g.findViewByCell(cell) : null
    view?.removeClass(ERASE_MARK)
  }
}

/**
 * Mark what lies under one CLIENT point of the stroke: every node there, and
 * every edge whose rendered path passes within `ERASE_REACH_PX` screen pixels.
 * A point outside the pane's body probes nothing — what lies there in world
 * space is hidden past the pane's edge, so the operator cannot mean it.
 */
function probeErase(g: Graph, gs: EraseGesture, client: { x: number; y: number }): void {
  const box = bodyEl.value
  if (!box || !pointInRect(client, box.getBoundingClientRect())) return
  const p = g.clientToLocal(client.x, client.y)
  for (const n of g.getNodesFromPoint(p.x, p.y)) markForErase(g, gs, n)
  const reach = eraseReach(g.zoom())
  for (const edge of g.getEdges()) {
    if (gs.marked.has(edge.id)) continue
    const view = g.findViewByCell(edge)
    const closest = view?.isEdgeView() ? view.getClosestPoint(p) : null
    if (edgeWithinReach(p, closest, reach)) markForErase(g, gs, edge)
  }
}

function moveErase(g: Graph, gs: EraseGesture, ev: MouseEvent): void {
  const client = { x: ev.clientX, y: ev.clientY }
  if (!gs.dragged) {
    const p = g.clientToLocal(client.x, client.y)
    // Under the click threshold the stroke is still a press: nothing beyond
    // the pressed cell is marked, so a plain press erases just that.
    if (!isDrawGesture(gs.start.x, gs.start.y, p.x, p.y, g.zoom())) return
    gs.dragged = true
    probeErase(g, gs, gs.last)
  }
  for (const s of strokeSamples(gs.last, client, ERASE_REACH_PX)) probeErase(g, gs, s)
  gs.last = client
}

/**
 * The release: remove everything the stroke marked as ONE undo step, edges
 * attached to an erased node included (X6 removes them with it, inside the
 * same batch). A blank press that never dragged erases nothing. The release
 * may land outside the pane or the window: the marks were made while the
 * operator could see them, so they are honoured either way.
 */
function finishErase(g: Graph, gs: EraseGesture): void {
  if (gs.on === 'blank' && blankIntent('eraser', gs.dragged ? 'drag' : 'click') !== 'erase') return
  const ids = eraseRemovalOrder(gs.marked)
  if (ids.length === 0) return
  // Never nest: a placed text's batch is closed by its rename, which a press
  // elsewhere has already blurred — this only guards the impossible case.
  endPlaceTextBatch()
  g.startBatch(ERASE_BATCH)
  try {
    for (const id of ids) {
      const cell = g.getCellById(id)
      if (cell) g.removeCell(cell)
    }
  } finally {
    g.stopBatch(ERASE_BATCH)
  }
  // X6's Selection drops removed cells itself; the repair it runs after this
  // release must not bring one back.
  if (pendingSelection) pendingSelection = pendingSelection.filter((id) => g.getCellById(id))
  markUsed('eraser')
}

function onGestureMove(ev: MouseEvent): void {
  const g = graph.value
  const gs = gesture
  if (!g || !gs) return
  if (gs.kind === 'pan') {
    const dx = ev.clientX - gs.client.x
    const dy = ev.clientY - gs.client.y
    if (dx !== 0 || dy !== 0) gs.moved = true
    g.translate(gs.origin.tx + dx, gs.origin.ty + dy)
    return
  }
  if (gs.kind === 'arrow') {
    const p = g.clientToLocal(ev.clientX, ev.clientY)
    arrowNow.value = { x: p.x, y: p.y }
    return
  }
  if (gs.kind === 'erase') {
    // No button held: the release landed somewhere the pane never heard about
    // (a native menu, say). Hovering on must not keep marking, and the next
    // release must not commit a stroke the operator already let go of.
    if (ev.buttons === 0) {
      cancelGesture()
      return
    }
    moveErase(g, gs, ev)
    return
  }
  if (isShapeTool(gs.tool)) {
    const p = g.clientToLocal(ev.clientX, ev.clientY)
    drawNow.value = { x: p.x, y: p.y }
  }
}

function onGestureUp(ev: MouseEvent): void {
  const gs = gesture
  // A right or middle release mid-stroke is not the end of an erase: only the
  // primary button that started it can commit it.
  if (gs?.kind === 'erase' && ev.button !== 0) return
  endGesture()
  const g = graph.value
  if (!g || !gs) return
  if (gs.kind === 'pan') {
    if (gs.moved) markUsed('hand')
    return
  }
  if (gs.kind === 'arrow') {
    finishArrow(g, gs.source, ev)
    return
  }
  if (gs.kind === 'erase') {
    finishErase(g, gs)
    return
  }
  const a = gs.start
  const p = g.clientToLocal(ev.clientX, ev.clientY)
  // Click or drag? BOTH ends are world coordinates measured through the
  // graph's own transform from NATIVE client points, and the threshold is
  // converted with `g.zoom()`. X6's wrapped event object is not a reliable
  // source of `clientX` in Electron — an earlier version read it there and
  // the comparison silently became `NaN >= 6`, so every drag was classified as
  // a click. jsdom did not reproduce it; the real app did.
  const dragged = isDrawGesture(a.x, a.y, p.x, p.y, g.zoom())
  const intent = gs.node
    ? nodeIntent(gs.tool, dragged ? 'drag' : 'press', gs.node.shape)
    : blankIntent(gs.tool, dragged ? 'drag' : 'click')
  switch (intent) {
    case 'place-shape':
      if (gs.tool === 'text') return
      createNode(
        operatorNode(
          placedRect(a.x, a.y, shapeForTool(gs.tool)),
          takenIds(),
          '',
          shapeForTool(gs.tool)
        ),
        gs.tool
      )
      return
    case 'draw-shape':
      if (gs.tool === 'text') return
      createNode(
        operatorNode(rectFromDrag(a.x, a.y, p.x, p.y), takenIds(), '', shapeForTool(gs.tool)),
        gs.tool
      )
      return
    case 'place-text':
      createNode(operatorNode(placedRect(a.x, a.y, 'text'), takenIds(), '', 'text'), gs.tool)
      return
    case 'edit-text':
      // On the RELEASE, not the press: a press's default action moves focus to
      // the body, which would blur — and so commit — a rename opened on it.
      if (gs.node) startRename(gs.node.id)
      return
    default:
      return
  }
}

/**
 * The Arrow's release: an operator edge from `source` to the node on top under
 * the pointer, or nothing (see `arrowEdgeEnds`). A release outside the pane's
 * body is "elsewhere" even when a node lies under that point in world space,
 * hidden past the pane's edge: the operator cannot see it, so cannot mean it.
 */
function finishArrow(g: Graph, source: string, ev: MouseEvent): void {
  const box = bodyEl.value
  if (!box || !pointInRect({ x: ev.clientX, y: ev.clientY }, box.getBoundingClientRect())) return
  const p = g.clientToLocal(ev.clientX, ev.clientY)
  const hits = g.getNodesFromPoint(p.x, p.y).map((n) => ({ id: n.id, zIndex: n.getZIndex() ?? 0 }))
  const sourceCell = g.getCellById(source)
  // The source can vanish mid-drag: a reload keeps an Arrow in flight (an
  // agent's write, a Save's echo), and the new document may no longer hold
  // it. An edge from a missing node would dangle. The preview is already gone
  // (`endGesture` ran before this).
  if (!sourceCell || !sourceCell.isNode()) return
  const outgoing = g.getOutgoingEdges(sourceCell) ?? []
  const ends = arrowEdgeEnds(
    source,
    topmostNodeId(hits),
    outgoing.map((e) => ({ source: e.getSourceCellId(), target: e.getTargetCellId() }))
  )
  if (!ends) return
  const edge = g.addEdge({
    ...operatorEdgeSpec(palette),
    source: { cell: ends.source },
    target: { cell: ends.target }
  })
  // Selected, like a new shape: a Delete right after takes a mistake back.
  g.cleanSelection()
  g.select(edge)
  pendingSelection = [edge.id]
  markUsed('arrow')
  setToolState(afterCreate(toolState.value))
}

/**
 * Add a node the operator just made, select it, and open its rename: a new
 * shape is always unlabelled, and making them double-click the thing they are
 * already looking at is a step with no decision in it. Then the tool reverts
 * to Select unless Lock is on (spec §4.3).
 */
function createNode(node: ReturnType<typeof operatorNode>, tool: CanvasTool): void {
  const g = graph.value
  if (!g) return
  // A text is only finished once it has a label, so the add and whatever its
  // rename does (label it, or remove it again) are ONE undo step.
  if (node.shape === 'text') beginPlaceTextBatch(g)
  const cell = g.addNode(toX6Node(node, palette, images.value))
  g.cleanSelection()
  g.select(cell)
  pendingSelection = [node.id]
  markUsed(tool)
  setToolState(afterCreate(toolState.value))
  void nextTick(() => startRename(node.id))
}

/**
 * The history batch a placed text holds open until its rename ends. Without
 * it the add and the rename's label (or its removal, on an empty commit) are
 * two undo steps, and one ⌘Z brings back an invisible empty text that a Save
 * would then write. Closed by `commitRename`/`cancelRename`, and defensively
 * by every path that could otherwise leave it open: a re-render (reload, a
 * disk change, a theme switch) and unmount.
 */
const PLACE_TEXT_BATCH = 'place-text'
let placeTextBatch: Graph | null = null

function beginPlaceTextBatch(g: Graph): void {
  endPlaceTextBatch()
  g.startBatch(PLACE_TEXT_BATCH)
  placeTextBatch = g
}

function endPlaceTextBatch(): void {
  const g = placeTextBatch
  placeTextBatch = null
  g?.stopBatch(PLACE_TEXT_BATCH)
}

/**
 * Double-click on empty board: in Select, place a text (Excalidraw idiom),
 * centred on the second press — the raw point, not X6's grid-snapped one.
 */
function onBlankDblClick(): void {
  const g = graph.value
  if (!g || rename.value) return
  if (blankIntent(activeTool.value, 'dblclick') !== 'place-text') return
  const { x, y } = g.clientToLocal(pressClient.x, pressClient.y)
  createNode(operatorNode(placedRect(x, y, 'text'), takenIds(), '', 'text'), 'text')
}

// ── Double-click renames (AC U3-1) ────────────────────────────────────────
interface RenameState {
  id: string
  value: string
  left: number
  top: number
  width: number
  height: number
}
const rename = ref<RenameState | null>(null)
const renameEl = ref<HTMLInputElement | null>(null)

function startRename(nodeId: string): void {
  const g = graph.value
  const box = bodyEl.value
  if (!g || !box) return
  const cell = g.getCellById(nodeId)
  if (!cell || !cell.isNode()) return
  const bbox = cell.getBBox()
  const tl = g.localToClient(bbox.x, bbox.y)
  const br = g.localToClient(bbox.x + bbox.width, bbox.y + bbox.height)
  const host = box.getBoundingClientRect()
  rename.value = {
    id: nodeId,
    value: String(cell.attr('label/text') ?? cell.attr('text/text') ?? ''),
    left: tl.x - host.left,
    top: tl.y - host.top,
    width: Math.max(48, br.x - tl.x),
    height: Math.max(20, br.y - tl.y)
  }
  void nextTick(() => {
    renameEl.value?.focus()
    renameEl.value?.select()
  })
}

/**
 * Commit the rename to BOTH X6 attribute paths in ONE `attr` call (§4.5, spike
 * trap 3). Both, because a reader that picks the path we did not write reports
 * the name the node had before the rename; one call, because two would cost the
 * operator two presses of undo to take back one rename.
 */
function commitRename(): void {
  try {
    applyRename()
  } finally {
    endPlaceTextBatch()
  }
}

function applyRename(): void {
  const r = rename.value
  rename.value = null
  // The input is about to leave the DOM, taking focus to `<body>` with it —
  // and every board shortcut is gated on the focus being INSIDE this pane, so
  // without this the operator would have to click the board again before
  // Delete or undo did anything.
  void nextTick(focusBody)
  const g = graph.value
  if (!g || !r) return
  const cell = g.getCellById(r.id)
  if (!cell || !cell.isNode()) return
  // A text node IS its label: committed empty, it would be an invisible node
  // nobody can find again, so it goes (spec §5). A framed shape stays,
  // unlabelled.
  if (nodeKind(cell) === 'text' && r.value.trim() === '') {
    g.removeCell(cell)
    return
  }
  cell.attr({ text: { text: r.value }, label: { text: r.value } })
}

function cancelRename(): void {
  const r = rename.value
  rename.value = null
  void nextTick(focusBody)
  // Esc on a text that was never given a label (a fresh Text-tool placement)
  // leaves nothing behind, for the same reason an empty commit does not.
  const g = graph.value
  const cell = g && r ? g.getCellById(r.id) : null
  if (g && cell && cell.isNode() && nodeKind(cell) === 'text') {
    const label = String(cell.attr('label/text') ?? cell.attr('text/text') ?? '')
    if (label.trim() === '') g.removeCell(cell)
  }
  endPlaceTextBatch()
}

// ── Selection, delete, duplicate, undo/redo ───────────────────────────────
function deleteSelection(): void {
  const g = graph.value
  if (!g) return
  const cells = g.getSelectedCells()
  if (cells.length === 0) return
  g.removeCells(cells)
}

/**
 * Duplicate the selected NODES (⌘/Ctrl-D). Stamped `operator` rather than
 * inheriting the source's stamp — see `duplicateOperatorNode`. Edges are not
 * duplicated: a copied edge would have to point at the copies or at the
 * originals, and neither answer is right often enough to guess.
 */
function duplicateSelection(): void {
  const g = graph.value
  const base = doc.value
  if (!g || !base) return
  const draft = currentDraft(base)
  const selected = new Set(g.getSelectedCells().map((c) => c.id))
  const sources = draft.nodes.filter((n) => selected.has(n.id))
  if (sources.length === 0) return
  const taken = takenIds()
  const created: string[] = []
  for (const source of sources) {
    const copy = duplicateOperatorNode(source, taken)
    taken.add(copy.id)
    g.addNode(toX6Node(copy, palette, images.value))
    created.push(copy.id)
  }
  g.cleanSelection()
  g.select(created.map((id) => g.getCellById(id)).filter((c) => c !== null))
}

function onUndo(): void {
  graph.value?.undo()
  refreshHistoryFlags()
}
function onRedo(): void {
  graph.value?.redo()
  refreshHistoryFlags()
}

function syncZoom(): void {
  const g = graph.value
  if (g) zoomPct.value = Math.round(g.zoom() * 100)
}

// ── Paste / drop an image (T218 U6, spec §4.6) ────────────────────────────
/** How far each extra image in one paste is offset, so a multi-image paste is
 *  a visible stack rather than one node hiding the others. */
const IMAGE_PASTE_STAGGER = 24

/**
 * **The bytes never enter the canvas file.** The clipboard payload is handed to
 * main, which externalises it into the canvas's `assets/` sibling directory
 * through the SAME server-side pipeline `draw_canvas` uses, and hands back the
 * RELATIVE `assets/<file>` the node stores. U3 could reasonably have inlined a
 * `data:` URI here — U6 is the unit that says why it must not: a 1,486-byte
 * paste became a 2,006-byte data URI and grew the spike's canvas by ~4.5 KB,
 * and §7.2 rewrites the whole file on every Save.
 *
 * **This is §7.1's one exception to "nothing touches the file until Save":**
 * the asset bytes are written immediately, because they exist only in a
 * clipboard event. The NODE that points at them is ordinary unsaved working
 * state, so an operator who never saves leaves an orphan in a gitignored
 * directory — the accepted cost, and why §4.6 does not garbage-collect.
 *
 * The pane sends BYTES, never a path: supplying bytes it already holds cannot
 * be a way to read a file it could not already read, so it stays strictly
 * inside main's source jail rather than asking to be let through it.
 */
async function attachImageFiles(
  files: readonly File[],
  at: { x: number; y: number }
): Promise<void> {
  const g = graph.value
  if (!g || state.value.status !== 'ready' || files.length === 0) return
  const inputs = await Promise.all(
    files.map(async (file) => ({
      kind: 'bytes' as const,
      mime: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      name: file.name || undefined
    }))
  )
  const res = await window.api.canvasAttachAssets(filePath.value, inputs)
  if (!res.ok) {
    ui.pushToast({ kind: 'danger', title: t('diagramPane.imageFailed') })
    return
  }

  // Resolve the freshly written assets through the SAME confined reader a load
  // uses, so a pasted image and a reloaded one render off one code path.
  const resolved = { ...images.value }
  await Promise.all(
    res.srcs.map(async (src) => {
      try {
        const read = await window.api.markdownRead(src, dirname(filePath.value))
        if (read.ok && read.kind === 'image') resolved[src] = read.content
      } catch {
        /* a node whose bytes cannot be read draws as a labelled placeholder */
      }
    })
  )
  images.value = resolved

  const taken = takenIds()
  const created: string[] = []
  for (let i = 0; i < res.srcs.length; i++) {
    const src = res.srcs[i]
    const [naturalW, naturalH] = await naturalSize(files[i])
    const size = imageNodeSize(naturalW, naturalH)
    const node = operatorImageNode(
      src,
      { x: at.x + i * IMAGE_PASTE_STAGGER, y: at.y + i * IMAGE_PASTE_STAGGER },
      size,
      taken,
      files[i].name || ''
    )
    taken.add(node.id)
    g.addNode(toX6Node(node, palette, images.value))
    created.push(node.id)
  }
  g.cleanSelection()
  g.select(created.map((id) => g.getCellById(id)).filter((c) => c !== null))
}

/**
 * The image's intrinsic pixel size, or `[0, 0]` when it cannot be decoded —
 * `imageNodeSize` reads that as "unknown" and falls back to the default node
 * footprint. `createImageBitmap` is absent in jsdom and can reject on a corrupt
 * payload; neither is a reason to refuse an image main already accepted.
 */
async function naturalSize(file: File): Promise<[number, number]> {
  if (typeof createImageBitmap !== 'function') return [0, 0]
  try {
    const bitmap = await createImageBitmap(file)
    const size: [number, number] = [bitmap.width, bitmap.height]
    bitmap.close?.()
    return size
  } catch {
    return [0, 0]
  }
}

/** Image files out of a clipboard or drop payload, in the order they arrived.
 *  The MIME prefix is a cheap pre-filter only — main is the authority on what
 *  is an image, and refuses anything else with a code. */
function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return []
  return Array.from(data.files ?? []).filter((f) => f.type.startsWith('image/'))
}

/** Where a pasted image lands: the centre of what the operator is looking at,
 *  in world coordinates, so it appears in view at any pan or zoom. */
function viewportCentre(): { x: number; y: number } {
  const g = graph.value
  const box = bodyEl.value
  if (!g || !box) return { x: 0, y: 0 }
  const rect = box.getBoundingClientRect()
  const p = g.clientToLocal(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return { x: p.x - 80, y: p.y - 60 }
}

function onPaste(ev: ClipboardEvent): void {
  const files = imageFilesFrom(ev.clipboardData)
  if (files.length === 0) return
  ev.preventDefault()
  void attachImageFiles(files, viewportCentre())
}

/** `dragover` must be prevented or the browser never fires `drop` — and
 *  without the guard Electron would NAVIGATE the window to the dropped file,
 *  which replaces the whole app with an image. */
function onDragOver(ev: DragEvent): void {
  if (!ev.dataTransfer) return
  ev.preventDefault()
  ev.dataTransfer.dropEffect = 'copy'
}

/**
 * Drop is deliberately the SAME path as paste (AC U6-2): the file's bytes are
 * read here and externalised by main exactly as a clipboard payload is. Reading
 * the dropped file's filesystem PATH instead would be a second, looser route to
 * the same directory — and the one the operator would find behaves differently
 * from paste the first time they dropped something from outside the repo.
 */
function onDrop(ev: DragEvent): void {
  const files = imageFilesFrom(ev.dataTransfer)
  if (files.length === 0) return
  ev.preventDefault()
  const g = graph.value
  const at = g ? g.clientToLocal(ev.clientX, ev.clientY) : viewportCentre()
  void attachImageFiles(files, { x: at.x, y: at.y })
}

/**
 * Resolve every image node's relative `props.src` through the SAME confined
 * reader the Markdown pane's image fast-path uses: it returns a base64 `data:`
 * URL, which the CSP allows (`img-src data:`) where a `file://` reference would
 * be blocked outright. An asset that cannot be read is simply absent from the
 * map, and `canvas-cells.ts` draws a labelled placeholder — the honest state
 * for a node whose bytes are missing, rather than a broken-image glyph.
 */
async function resolveImages(document_: CanvasDocument, dir: string): Promise<ResolvedImages> {
  const sources = canvasImageSources(document_)
  if (sources.length === 0) return {}
  const entries = await Promise.all(
    sources.map(async (src) => {
      try {
        const res = await window.api.markdownRead(src, dir)
        return res.ok && res.kind === 'image' ? ([src, res.content] as const) : null
      } catch {
        return null
      }
    })
  )
  return Object.fromEntries(entries.filter((e): e is readonly [string, string] => e !== null))
}

/**
 * Draw the current document. `fit` is opt-in and NOT the default: fitting on
 * every render would move the view under an operator who is reading it, which
 * is exactly what AC U2-8 and spec §7.3 case A forbid. It runs on first open
 * and on an explicit Fit press — never on a theme switch or a silent reload.
 */
async function draw(source: CanvasDocument, fit = false): Promise<void> {
  const g = ensureGraph()
  if (!g) return
  // A render recreates every cell view. An Eraser stroke's dimming dies with
  // the old views while its marked ids survive, so its release would delete
  // cells the operator sees undimmed: it ends here. Every other gesture
  // survives — a reload keeps the viewport (`fit=false`), so a draw, an arrow
  // or a pan in flight is still valid across an agent's write or the echo of
  // a Save.
  if (gesture?.kind === 'erase') cancelGesture()
  endPlaceTextBatch()
  // A render REPLACES every cell, so it must never reach dirty tracking or the
  // undo stack: rebuilding the board is the pane's own bookkeeping, not an edit
  // the operator made and could take back.
  withoutTracking(() => {
    g.disableHistory()
    renderCanvasDocument(g, source, palette, images.value)
    g.enableHistory()
  })
  if (fit) {
    await nextTick()
    fitCanvas(g)
  }
  syncZoom()
  refreshHistoryFlags()
}

/**
 * The document as the graph currently holds it — the operator's WORKING state
 * (§7.1), including everything they have not saved. `base` supplies `meta`, the
 * preserved unknown top-level keys, and the edge labels the document rather
 * than X6 is the author of.
 */
function currentDraft(
  base: CanvasDocument,
  nowIso?: string,
  stack: CanvasStackMode = 'save'
): CanvasDocumentDraft {
  const g = graph.value
  const cells = g ? ((g.toJSON() as { cells?: unknown[] }).cells ?? []) : []
  return buildCanvasDocumentFromCells(cells, base, nowIso ?? base.meta.updatedAt ?? '', stack)
}

async function load(path: string, fit: boolean): Promise<void> {
  if (!path) {
    state.value = { status: 'error', code: 'invalid-path' }
    return
  }
  state.value = { status: 'loading' }
  const res = await window.api.canvasRead(path)
  if (!res.ok) {
    state.value = { status: 'error', code: res.code }
    doc.value = null
    return
  }
  doc.value = res.doc
  images.value = await resolveImages(res.doc, dirname(res.path))
  state.value = { status: 'ready' }
  // The host is `v-show`n rather than `v-if`d, so it already has layout — but
  // wait a tick anyway so a first mount measures a laid-out container.
  await nextTick()
  await draw(res.doc, fit)
  // The board on screen is now exactly the file on disk: no unsaved edits, and
  // an undo history that would otherwise describe a document that no longer
  // exists (§7.3 case A).
  dirty.value = false
  staleOnDisk.value = false
  dismissUnsavedToast()
  rename.value = null
  graph.value?.cleanHistory()
  refreshHistoryFlags()
}

// ── Theme (spec §6.4, AC U2-4) ────────────────────────────────────────────
/**
 * Re-resolve the palette and repaint on a theme switch — chrome through
 * `applyCanvasPalette`, cells through a re-render, since a cell's colour is an
 * SVG attribute rather than a CSS class. Deliberately does NOT re-read the file
 * and does NOT fit: the operator changed a colour, not the document, and moving
 * their viewport for it would be a bug. `nextTick` first, so `data-theme` is on
 * `<html>` and `getComputedStyle` reflects the new palette — the same ordering
 * `TerminalPane`'s theme watch relies on.
 */
watch(
  () => theme.current,
  async () => {
    await nextTick()
    const g = graph.value
    if (!g) return
    palette = readCanvasPalette()
    applyCanvasPalette(g, palette)
    const base = doc.value
    if (!base) return
    // Redraw from the WORKING state, not from `doc` — `doc` is the last thing
    // read from disk, and re-rendering it here would silently throw away every
    // unsaved edit the operator has made. `dirty` is untouched: recolouring is
    // not an edit.
    const wasDirty = dirty.value
    // The redraw replaces every cell, which empties the selection and closes any
    // resize handles — and would close the properties panel under the operator.
    // Put them back: same ids.
    const kept = g.getSelectedCells().map((c) => c.id)
    const handles = openCanvasResizeHandleId(g)
    // The emptied selection would fold the opened panel shut (the length watch);
    // remember it and put it back after the re-select.
    const wasPanelOpen = panelOpen.value
    // `'live'`: every node keeps its exact z, so the undo stack — which records z
    // values, not an order — still describes the board after the redraw (T536 U4).
    // That holds only while the live node z are distinct and > 0 (else renderStackZ
    // re-ranks them), which they are: a load gives 1..n or the file's distinct
    // positive values, a new node takes max + 1, and undo is LIFO.
    await draw(currentDraft(base, undefined, 'live') as CanvasDocument, false)
    dirty.value = wasDirty
    repairingSelection = true
    try {
      selectIds(g, kept)
    } finally {
      repairingSelection = false
    }
    panelOpen.value = wasPanelOpen
    if (handles !== null) showCanvasResizeHandles(g, handles)
  }
)

// ── The file changed on disk (spec §7.3 case A) ───────────────────────────
/**
 * Spec §7.3, the two cases a watcher event can land in:
 *
 *  - **A — clean.** Reload silently and keep the viewport (`fit=false`): the
 *    operator may be reading the board while the agent draws on it, and moving
 *    the camera under them is the failure this rule exists to prevent.
 *  - **B — dirty.** Do NOT reload. Raise the stale banner and let the operator
 *    choose. Clobbering unsaved work because a file moved is never the answer;
 *    the banner is also what makes a later Save (case C, last-write-wins) an
 *    informed choice rather than a silent loss.
 */
let unsubscribeCanvasChanged: (() => void) | undefined
async function handleCanvasChanged(payload: { path: string }): Promise<void> {
  if (payload.path !== filePath.value) return
  if (dirty.value) {
    staleOnDisk.value = true
    return
  }
  await load(filePath.value, false)
}

onMounted(async () => {
  unsubscribeCanvasChanged = window.api.onCanvasChanged(handleCanvasChanged)
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('keyup', onWindowKeyup)
  window.addEventListener('blur', onWindowBlur)
  void window.api.canvasWatchStart(filePath.value)
  await load(filePath.value, true)
  // Follow the pane as the operator drags the inter-pane divider or maximizes.
  // X6 reads its container's size only at construction and then PINS an inline
  // width/height on it, so the parent — not the container — is what still
  // tracks the layout and is therefore what we observe.
  const box = bodyEl.value
  if (box && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      const g = graph.value
      if (g && box.clientWidth > 0 && box.clientHeight > 0) {
        g.resize(box.clientWidth, box.clientHeight)
      }
      measureToolbar()
    })
    resizeObserver.observe(box)
  }
  await nextTick()
  measureToolbar()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('keyup', onWindowKeyup)
  window.removeEventListener('blur', onWindowBlur)
  endGesture()
  endPlaceTextBatch()
  unsubscribeCanvasChanged?.()
  void window.api.canvasWatchStop(filePath.value)
  resizeObserver?.disconnect()
  resizeObserver = null
  graph.value?.dispose()
  graph.value = null
})

// The store may swap the pane's file (an `open_file` re-targeting the same pane
// id, or a dedup hit). Re-point the watch and reload, fitting the new document.
watch(
  () => filePath.value,
  (next, prev) => {
    if (!next || next === prev) return
    // Re-targeting throws the current board away, so it goes through the same
    // discard guard as Reload and Close.
    withDiscardGuard(async () => {
      if (prev) await window.api.canvasWatchStop(prev)
      await window.api.canvasWatchStart(next)
      await load(next, true)
    })
  }
)

// ── The discard guard (spec §7.1, `MarkdownPane`'s convention) ────────────
/**
 * Run `proceed` unless there are unsaved edits — then surface a non-blocking
 * "unsaved changes" toast whose action discards and proceeds. The SAME idiom
 * `MarkdownPane` uses, deliberately: a blocking `window.confirm` freezes the
 * renderer, and a second dialect of "are you sure" in the same helper stack is
 * worse than either. Reused by Reload, the stale banner, a file re-target and
 * Close (AC U3-8).
 */
let unsavedToastId: string | null = null
function withDiscardGuard(proceed: () => void): void {
  if (!dirty.value) {
    proceed()
    return
  }
  // ONE toast, replaced rather than stacked. It never auto-dismisses
  // (`timeoutMs: 0`), so a second Close press — the natural reaction to a
  // click that visibly did nothing — would otherwise leave two identical
  // permanent warnings on screen, and a few more after that. Observed in the
  // real app during verification.
  if (unsavedToastId) ui.dismissToast(unsavedToastId)
  unsavedToastId = ui.pushToast({
    kind: 'warning',
    title: t('diagramPane.unsaved.title'),
    timeoutMs: 0,
    action: {
      label: t('diagramPane.unsaved.discard'),
      handler: () => {
        unsavedToastId = null
        proceed()
      }
    }
  })
}

/** Retire the standing "unsaved edits" warning — the pane is clean, so the
 *  question it was asking has been answered. */
function dismissUnsavedToast(): void {
  if (!unsavedToastId) return
  ui.dismissToast(unsavedToastId)
  unsavedToastId = null
}

// ── Save (spec §7.2) ──────────────────────────────────────────────────────
/**
 * The six ordered steps of §7.2, three of which are NOT here on purpose.
 *
 * 1. serialize the graph → `currentDraft`;
 * 2. normalize every label → `buildCanvasDocumentFromCells` (both attribute
 *    paths were written at rename time, and the normalizer reads them back);
 * 3-4. assert `origin` and validate against §4.3/§4.7 → **main's validator**,
 *    the only thing allowed to decide a payload is a document. The pane does
 *    not pre-validate: a second copy of the rules here could only ever drift
 *    from the one that actually gates the bytes;
 * 5. write atomically → U1's confined writer;
 * 6. `meta.updatedAt` + clear the dirty state → here, on success only.
 *
 * A refusal aborts with a localized toast and **leaves the pane dirty** — the
 * operator's work is still in front of them, and the file is untouched
 * (U1 writes nothing when validation fails).
 */
async function save(): Promise<void> {
  const base = doc.value
  if (state.value.status !== 'ready' || !base || !dirty.value || saving.value) return
  saving.value = true
  const draft = currentDraft(base, new Date().toISOString())
  const res = await window.api.canvasWrite(filePath.value, draft)
  saving.value = false
  if (res.ok) {
    doc.value = draft as CanvasDocument
    dirty.value = false
    staleOnDisk.value = false
    dismissUnsavedToast()
    ui.pushToast({ kind: 'success', title: t('diagramPane.saved'), timeoutMs: 2500 })
  } else {
    ui.pushToast({ kind: 'danger', title: t(errorKey(res.code)) })
  }
}

// ── Toolbar placement (design.md §6 "Diagram pane → Toolbar") ────────────
const clusterEl = ref<HTMLElement | null>(null)
const toolbarEl = ref<HTMLElement | null>(null)
/** The pane is too narrow for bar and zoom cluster on one row. */
const toolbarOwnRow = ref(false)

/**
 * Measured on the body's existing ResizeObserver: the bar is centred, and drops
 * to its own row under the zoom cluster once its left edge would come within
 * 8px of the cluster. The BAR is measured, not the hint under it, so the hint
 * appearing or hiding never flips the row.
 */
function measureToolbar(): void {
  try {
    const box = bodyEl.value
    const cluster = clusterEl.value
    const bar = toolbarEl.value?.querySelector<HTMLElement>('[role="toolbar"]')
    if (!box || !cluster || !bar) return
    toolbarOwnRow.value = toolbarNeedsOwnRow(
      box.clientWidth,
      bar.offsetWidth,
      cluster.offsetLeft + cluster.offsetWidth
    )
  } finally {
    // AFTER the row write, on every path: the `nextTick` inside then chains behind
    // the re-render that write queued, so the panel measures the toolbar where it
    // now sits rather than where it was (it would overlap a freshly own-row bar).
    measureStylePanel()
  }
}
watch(
  () => state.value.status,
  async (status) => {
    if (status !== 'ready') return
    await nextTick()
    measureToolbar()
  }
)

/**
 * The properties panel's slot (design.md §6): collapsed below 384px of pane, and
 * 8px under the zoom cluster — or under the toolbar once it has its own row. The
 * width is read now; the top after a tick. Callers that change `toolbarOwnRow`
 * must call this AFTER that write (see `measureToolbar`): Vue's `nextTick` then
 * resolves after the re-render the write queued, so the toolbar's offsets are
 * its new ones. A body with no layout (0 wide) collapses nothing: there is no
 * width to judge by.
 */
function measureStylePanel(): void {
  const box = bodyEl.value
  if (box && box.clientWidth > 0) panelCollapsed.value = stylePanelCollapsed(box.clientWidth)
  void nextTick(() => {
    const cluster = clusterEl.value
    if (!cluster) return
    const bar = toolbarEl.value
    panelTop.value = stylePanelTop(
      cluster.offsetTop + cluster.offsetHeight,
      toolbarOwnRow.value,
      bar ? bar.offsetTop + bar.offsetHeight : 0
    )
  })
}

// ── Keyboard ──────────────────────────────────────────────────────────────
/** Does the focus sit inside THIS pane? Several panes can be open at once, so
 *  a shortcut must never reach the one the operator is not looking at. */
function hasFocus(): boolean {
  const root = bodyEl.value?.closest('[data-testid="diagram-pane"]')
  return !!root && root.contains(document.activeElement)
}

function focusBody(): void {
  bodyEl.value?.focus()
}

function onWindowKeydown(ev: KeyboardEvent): void {
  if (!hasFocus()) return
  // Already handled on its way here — the rename input's own Enter/Esc
  // (`.prevent`). Without this an Esc that cancels a rename would ALSO run
  // `escapeOutcome` below and drop a locked tool back to Select.
  if (ev.defaultPrevented) return
  const mod = ev.metaKey || ev.ctrlKey
  if (mod && (ev.key === 's' || ev.key === 'S')) {
    ev.preventDefault()
    void save()
    return
  }
  // While renaming, the input owns the keyboard — Enter/Escape are handled on
  // the field itself and everything else is ordinary typing.
  if (rename.value) return
  if (mod && (ev.key === 'z' || ev.key === 'Z')) {
    ev.preventDefault()
    if (ev.shiftKey) onRedo()
    else onUndo()
    return
  }
  if (mod && (ev.key === 'y' || ev.key === 'Y')) {
    ev.preventDefault()
    onRedo()
    return
  }
  if (mod && (ev.key === 'd' || ev.key === 'D')) {
    ev.preventDefault()
    duplicateSelection()
    return
  }
  if (mod && (ev.key === 'a' || ev.key === 'A')) {
    ev.preventDefault()
    const g = graph.value
    if (g) g.select(g.getCells())
    return
  }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault()
    deleteSelection()
    return
  }
  // Space held = a temporary Hand from any tool (spec §4.3). Below the rename
  // early return, so typing a space into a label never pans.
  if (ev.key === ' ') {
    // Space on a focused toolbar or properties-panel button activates that
    // button, as a keyboard user expects — it never pans.
    const focused = document.activeElement
    if (
      focused instanceof HTMLElement &&
      focused.closest('[role="toolbar"], [data-canvas-chrome]')
    ) {
      return
    }
    ev.preventDefault()
    if (!toolState.value.spaceHeld) setToolState(pressSpace(toolState.value))
    return
  }
  if (ev.key === 'Escape') {
    const outcome = escapeOutcome(toolState.value, gesture !== null)
    if (outcome === 'cancel-gesture') cancelGesture()
    else if (outcome === 'to-select') setToolState(selectTool(toolState.value, 'select'))
    else graph.value?.cleanSelection()
    return
  }
  const pick = toolForKey(ev)
  if (!pick) return
  ev.preventDefault()
  // Ignored while Space is held: switching then would make the release
  // "restore" a tool the operator never chose to return to.
  if (toolState.value.spaceHeld) return
  setToolState(pick === 'lock' ? toggleLock(toolState.value) : selectTool(toolState.value, pick))
}

/** Releasing Space restores the tool. Not focus-gated: a release must always land. */
function onWindowKeyup(ev: KeyboardEvent): void {
  if (ev.key !== ' ' || !toolState.value.spaceHeld) return
  ev.preventDefault()
  setToolState(releaseSpace(toolState.value))
}

/** The window lost focus: a Space keyup will never arrive here (Review Focus 3),
 *  so the pane must not stay stuck in Hand. */
function onWindowBlur(): void {
  // A gesture in flight may never see its release either (it can land in
  // another window), so it goes too — no preview left on screen.
  cancelGesture()
  if (toolState.value.spaceHeld) setToolState(releaseSpace(toolState.value))
}

// ── Header actions ────────────────────────────────────────────────────────
function reload(): void {
  // Re-reads WITHOUT fitting: a manual refresh must not move the viewport
  // either — the operator asked for fresh data, not a new camera.
  withDiscardGuard(() => void load(filePath.value, false))
}

/** The stale banner's Reload — the same guard, and it clears the banner. */
function reloadFromStaleBanner(): void {
  withDiscardGuard(() => {
    staleOnDisk.value = false
    void load(filePath.value, false)
  })
}
function onFit(): void {
  const g = graph.value
  if (!g) return
  fitCanvas(g)
  syncZoom()
}
function onZoom(factor: number): void {
  const g = graph.value
  if (!g) return
  zoomCanvasBy(g, factor)
  syncZoom()
}

const isMaximized = computed(() => helpers.maximizedPaneId(props.worktreePath) === props.pane.id)
function onToggleMaximize(): void {
  helpers.toggleMaximizePane(props.worktreePath, props.pane.id)
}
function onClose(): void {
  // AC U3-8: a dirty pane never closes on the first click — the discard toast
  // does, and only its action actually removes the pane.
  withDiscardGuard(() => helpers.removeHelper(props.worktreePath, props.pane.id))
}
function onHeaderMouseDown(ev: MouseEvent): void {
  if (props.resizable) emit('headerMouseDown', ev)
}
</script>

<template>
  <div
    data-testid="diagram-pane"
    class="flex h-full w-full flex-col overflow-hidden bg-bg"
    :aria-label="$t('diagramPane.label')"
  >
    <header
      class="flex h-6 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2 text-[11px] text-text-2 transition-colors"
      :class="
        resizable ? 'cursor-row-resize border-t border-t-border-2 hover:border-t-accent-line' : ''
      "
      @mousedown="onHeaderMouseDown"
    >
      <!-- Stale-on-disk banner (§7.3 case B): replaces the filename row when the
           file changed on disk while the pane has unsaved edits. Identical
           treatment to the Markdown pane's — one banner idiom, not two. -->
      <template v-if="staleOnDisk">
        <span
          data-testid="diagram-stale-banner"
          class="anim-fade-in flex min-w-0 flex-1 items-center gap-1.5 rounded bg-warning/10 px-1 text-warning"
        >
          <span class="truncate">{{ $t('diagramPane.changedOnDisk.title') }}</span>
          <button
            class="shrink-0 underline underline-offset-2 hover:no-underline"
            @mousedown.stop
            @click="reloadFromStaleBanner"
          >
            {{ $t('diagramPane.changedOnDisk.reload') }}
          </button>
        </span>
      </template>
      <template v-else>
        <Shapes :size="12" :stroke-width="1.6" class="shrink-0 text-text-3" />
        <span class="min-w-0 flex-1 truncate" :title="filePath">{{ fileName }}</span>
      </template>
      <!-- Dirty dot (design.md §6): an accent bullet, only with unsaved edits. -->
      <span
        v-if="dirty"
        data-testid="diagram-dirty-dot"
        class="shrink-0 text-accent"
        style="font-size: 14px; line-height: 1"
        :title="$t('diagramPane.unsaved.title')"
        :aria-label="$t('diagramPane.unsaved.title')"
        >•</span
      >
      <button
        class="flex shrink-0 items-center justify-center rounded transition"
        :class="
          canUndo
            ? 'text-text-3 hover:bg-surface-2 hover:text-text'
            : 'cursor-default text-text-disabled hover:bg-transparent'
        "
        style="width: 18px; height: 18px"
        :disabled="!canUndo"
        data-testid="diagram-undo"
        :title="$t('diagramPane.undo')"
        :aria-label="$t('diagramPane.undo')"
        @mousedown.stop
        @click="onUndo"
      >
        <Undo2 :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="flex shrink-0 items-center justify-center rounded transition"
        :class="
          canRedo
            ? 'text-text-3 hover:bg-surface-2 hover:text-text'
            : 'cursor-default text-text-disabled hover:bg-transparent'
        "
        style="width: 18px; height: 18px"
        :disabled="!canRedo"
        data-testid="diagram-redo"
        :title="$t('diagramPane.redo')"
        :aria-label="$t('diagramPane.redo')"
        @mousedown.stop
        @click="onRedo"
      >
        <Redo2 :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="flex shrink-0 items-center justify-center rounded transition"
        :class="
          dirty
            ? 'text-accent hover:bg-surface-2'
            : 'cursor-default text-text-disabled hover:bg-transparent'
        "
        style="width: 18px; height: 18px"
        :disabled="!dirty"
        data-testid="diagram-save"
        :title="$t('diagramPane.save')"
        :aria-label="$t('diagramPane.save')"
        @mousedown.stop
        @click="save"
      >
        <Save :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('diagramPane.reload')"
        :aria-label="$t('diagramPane.reload')"
        @mousedown.stop
        @click="reload"
      >
        <RotateCcw :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="isMaximized ? $t('helperPane.restore') : $t('helperPane.maximize')"
        :aria-label="isMaximized ? $t('helperPane.restore') : $t('helperPane.maximize')"
        @mousedown.stop
        @click="onToggleMaximize"
      >
        <Minimize2 v-if="isMaximized" :size="12" :stroke-width="1.5" />
        <Maximize2 v-else :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="-mr-1 flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('helperPane.close')"
        :aria-label="$t('helperPane.close')"
        @mousedown.stop
        @click="onClose"
      >
        <X :size="12" :stroke-width="1.5" />
      </button>
    </header>

    <!-- Body. The X6 host is always in the DOM (v-show, not v-if) so the graph
         keeps its container — and therefore its viewport — across a loading or
         empty state. Overlays sit above it rather than replacing it. -->
    <div
      ref="bodyEl"
      tabindex="0"
      class="relative min-h-0 flex-1 overflow-hidden outline-none"
      :style="{ cursor: bodyCursor }"
      @mousedown.capture="onBodyMouseDownCapture"
      @pointerdown="focusBody"
      @paste="onPaste"
      @dragover="onDragOver"
      @drop="onDrop"
    >
      <!-- X6 writes its own inline `width`/`height` onto its container, which
           then stops tracking the layout. So the host is absolutely positioned
           (it never drives its parent's size) and the RESIZE OBSERVER watches
           the PARENT — observing the container itself is a deadlock: X6 pins
           it, so it never changes, so the observer never fires. -->
      <div
        v-show="state.status !== 'error'"
        ref="hostEl"
        data-testid="diagram-canvas-host"
        class="absolute inset-0"
      ></div>

      <div
        v-if="state.status === 'loading'"
        class="absolute inset-0 grid place-items-center text-text-3"
        style="font-size: 12px"
      >
        {{ $t('diagramPane.loading') }}
      </div>
      <div
        v-else-if="state.status === 'error'"
        class="absolute inset-0 grid place-items-center px-6 text-center text-text-3"
        style="font-size: 12px"
      >
        {{ errorMessage }}
      </div>
      <!-- An empty document is a board, not a failure: the grid stays visible
           underneath so the pane reads as "nothing drawn yet". -->
      <div
        v-else-if="isEmpty"
        class="pointer-events-none absolute inset-0 grid place-items-center text-text-4"
        style="font-size: 12px"
      >
        {{ $t('diagramPane.empty') }} {{ $t('diagramPane.emptyHint') }}
      </div>

      <!-- The in-flight draw. A plain outline in `--accent-line` over the board:
           it is a preview of a node that does not exist yet, so it must not look
           like one that does. -->
      <div
        v-if="drawPreviewStyle"
        data-testid="diagram-draw-preview"
        class="pointer-events-none absolute rounded border border-dashed border-accent-line bg-accent-soft"
        :style="drawPreviewStyle"
      ></div>

      <!-- The in-flight Arrow: a dashed line from the source's centre to the
           pointer. An overlay, not a cell, so it never reaches the undo history. -->
      <svg
        v-if="arrowPreviewLine"
        data-testid="diagram-arrow-preview"
        class="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
      >
        <line
          :x1="arrowPreviewLine.x1"
          :y1="arrowPreviewLine.y1"
          :x2="arrowPreviewLine.x2"
          :y2="arrowPreviewLine.y2"
          class="stroke-accent-line"
          stroke-width="1.5"
          stroke-dasharray="4 3"
        />
      </svg>

      <!-- Inline rename. Positioned over the node itself rather than in a
           dialog: renaming a box is a one-word edit, and moving the operator's
           eyes off the board for it is more disruptive than the edit is. -->
      <input
        v-if="rename"
        ref="renameEl"
        v-model="rename.value"
        data-testid="diagram-rename-input"
        class="absolute rounded border border-accent-line bg-surface px-1 text-center text-[12px] text-text outline-none"
        :style="{
          left: `${rename.left}px`,
          top: `${rename.top}px`,
          width: `${rename.width}px`,
          height: `${rename.height}px`
        }"
        :aria-label="$t('diagramPane.rename')"
        @mousedown.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="cancelRename"
        @blur="commitRename"
      />

      <!-- Floating control cluster: absolute to the VIEWPORT, so it neither
           pans nor scales — the anatomy PrStackCanvas established (design.md §6). -->
      <div
        v-if="state.status === 'ready'"
        ref="clusterEl"
        class="absolute left-3 top-3 inline-flex items-center gap-0.5 rounded border border-border bg-surface p-1 shadow-pop"
        @pointerdown.stop
        @mousedown.stop
      >
        <button
          class="grid h-[26px] w-[26px] place-items-center rounded-sm text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
          :title="$t('diagramPane.fit')"
          :aria-label="$t('diagramPane.fit')"
          @click="onFit"
        >
          <Scan :size="13" />
        </button>
        <button
          class="grid h-[26px] w-[26px] place-items-center rounded-sm text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
          :title="$t('diagramPane.zoomOut')"
          :aria-label="$t('diagramPane.zoomOut')"
          @click="onZoom(1 / 1.2)"
        >
          <Minus :size="13" />
        </button>
        <span
          data-testid="diagram-zoom"
          class="grid h-[26px] min-w-[34px] place-items-center text-[11px] tabular-nums text-text-4"
        >
          {{ zoomPct }}%
        </span>
        <button
          class="grid h-[26px] w-[26px] place-items-center rounded-sm text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
          :title="$t('diagramPane.zoomIn')"
          :aria-label="$t('diagramPane.zoomIn')"
          @click="onZoom(1.2)"
        >
          <Plus :size="13" />
        </button>
      </div>

      <!-- Tool bar: top-centre of the VIEWPORT (neither pans nor zooms), or its
           own row under the zoom cluster when the pane is too narrow for both
           (design.md §6). 56px = the cluster's 12px inset + 36px height + 8px.
           Capped at the pane minus its 12px left inset, so the full bar fits down
           to ≈237px; below that its buttons wrap onto more rows instead of
           clipping (design.md §6 "Narrow panes"). -->
      <div
        v-if="state.status === 'ready'"
        ref="toolbarEl"
        class="absolute max-w-[calc(100%-var(--spacing)*3)]"
        :class="toolbarOwnRow ? 'left-3 top-14' : 'left-1/2 top-3 -translate-x-1/2'"
      >
        <CanvasToolbar
          :tool="toolState.tool"
          :locked="toolState.locked"
          :used="usedTools"
          @select="onToolbarSelect"
          @toggle-lock="onToolbarToggleLock"
        />
      </div>

      <!-- Properties panel (T536 U3): left edge of the VIEWPORT, under the zoom
           cluster (or the toolbar, when it has its own row). Shown only in the
           chosen Select tool, for a selection that holds a node or an arrow: the
           style groups it shares, then Layers for the nodes (T536 U4, U5). -->
      <div v-if="panelVisible" class="absolute left-3" :style="{ top: `${panelTop}px` }">
        <CanvasPropertiesPanel
          :keys="panelKeys"
          :options="panelOptions"
          :edge-only="panelEdgeOnly"
          :values="panelStyleValues"
          :collapsed="panelCollapsed"
          :open="panelOpen"
          :layers="panelNodes.length > 0"
          @change="applyStylePatch"
          @layer="applyLayerMove"
          @toggle="onPanelToggle"
        />
      </div>
    </div>
  </div>
</template>
