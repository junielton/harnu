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
import type { Graph } from '@antv/x6'
import { useHelpersStore, type AnyHelperPane } from '../stores/helpers'
import { useThemeStore } from '../stores/theme'
import { useUiStore } from '../stores/ui'
import {
  applyCanvasPalette,
  createCanvasGraph,
  fitCanvas,
  missingCanvasPlugins,
  renderCanvasDocument,
  setCanvasPortsVisible,
  zoomCanvasBy
} from './canvas/canvas-graph'
import { canvasImageSources, toX6Node, type ResolvedImages } from './canvas/canvas-cells'
import {
  buildCanvasDocumentFromCells,
  duplicateOperatorNode,
  imageNodeSize,
  isDrawGesture,
  operatorImageNode,
  operatorNode,
  rectFromDrag,
  type CanvasDocumentDraft
} from './canvas/canvas-edit'
import { readCanvasPalette, type CanvasPalette } from './canvas/canvas-theme'
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

  g.on('node:dblclick', ({ node }) => startRename(node.id))
  g.on('blank:mousedown', onBlankMouseDown)
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

// ── Drag on blank canvas draws a box (AC U3-1) ────────────────────────────
/** The in-flight draw, in graph-local coordinates; `null` when not drawing. */
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
 * CAPTURE phase, and that is not a detail. X6 handles the drag's `mouseup` on
 * `document` and stops its propagation, so a bubble-phase listener on `window`
 * — the last hop in the bubble chain — never sees the release: the preview rect
 * stayed on screen and no box was ever created. Capture runs window → document
 * → target, so it lands before X6 can swallow it. Found in the real app;
 * jsdom's dispatch reaches the listener either way, so it does not reproduce
 * there. `removeEventListener` must be given the same flag or it removes
 * nothing.
 */
const DRAW_LISTENER = { capture: true } as const

function onBlankMouseDown({ e, x, y }: { e: MouseEvent; x: number; y: number }): void {
  // Left button only, and never while shift is held: shift+drag belongs to the
  // rubberband, right-drag belongs to panning (see `canvas-graph.ts`).
  if (e.button !== 0 || e.shiftKey) return
  focusBody()
  drawStart.value = { x, y }
  drawNow.value = { x, y }
  window.addEventListener('mousemove', onDrawMove, DRAW_LISTENER)
  window.addEventListener('mouseup', onDrawUp, DRAW_LISTENER)
}

function onDrawMove(ev: MouseEvent): void {
  const g = graph.value
  if (!g || !drawStart.value) return
  const p = g.clientToLocal(ev.clientX, ev.clientY)
  drawNow.value = { x: p.x, y: p.y }
}

function onDrawUp(ev: MouseEvent): void {
  window.removeEventListener('mousemove', onDrawMove, DRAW_LISTENER)
  window.removeEventListener('mouseup', onDrawUp, DRAW_LISTENER)
  const g = graph.value
  const a = drawStart.value
  drawStart.value = null
  drawNow.value = null
  if (!g || !a) return
  const p = g.clientToLocal(ev.clientX, ev.clientY)
  // A short drag is a CLICK on empty board: clear the selection, draw nothing.
  // BOTH ends are world coordinates measured through the graph's own transform,
  // and the threshold is converted with `g.zoom()`. Reading `e.clientX` off the
  // mousedown instead is what the first version did, and X6's wrapped event
  // object carries no `clientX` in Electron — the comparison silently became
  // `NaN >= 6`, so every drag was classified as a click and no box was ever
  // created. jsdom did not reproduce it; the real app did.
  if (!isDrawGesture(a.x, a.y, p.x, p.y, g.zoom())) {
    g.cleanSelection()
    return
  }
  const node = operatorNode(rectFromDrag(a.x, a.y, p.x, p.y), takenIds())
  const cell = g.addNode(toX6Node(node, palette, images.value))
  g.cleanSelection()
  g.select(cell)
  // Straight into rename: a box the operator just drew is always unlabelled,
  // and making them double-click the thing they are already looking at is a
  // step with no decision in it.
  void nextTick(() => startRename(node.id))
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
  cell.attr({ text: { text: r.value }, label: { text: r.value } })
}

function cancelRename(): void {
  rename.value = null
  void nextTick(focusBody)
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
function currentDraft(base: CanvasDocument, nowIso?: string): CanvasDocumentDraft {
  const g = graph.value
  const cells = g ? ((g.toJSON() as { cells?: unknown[] }).cells ?? []) : []
  return buildCanvasDocumentFromCells(cells, base, nowIso ?? base.meta.updatedAt ?? '')
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
    await draw(currentDraft(base) as CanvasDocument, false)
    dirty.value = wasDirty
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
    })
    resizeObserver.observe(box)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('mousemove', onDrawMove, DRAW_LISTENER)
  window.removeEventListener('mouseup', onDrawUp, DRAW_LISTENER)
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
  if (ev.key === 'Escape') graph.value?.cleanSelection()
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
    </div>
  </div>
</template>
