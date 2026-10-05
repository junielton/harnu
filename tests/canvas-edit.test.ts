// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import type { Graph } from '@antv/x6'
import DiagramPane from '../src/renderer/src/components/DiagramPane.vue'
import {
  CANVAS_MIN_NODE_SIZE,
  CANVAS_RUBBERBAND_MODIFIER,
  createCanvasGraph,
  renderCanvasDocument,
  setCanvasPortsVisible
} from '../src/renderer/src/components/canvas/canvas-graph'
import { CANVAS_PORT_IDS, toX6Node } from '../src/renderer/src/components/canvas/canvas-cells'
import {
  DRAW_THRESHOLD,
  MIN_DRAWN_NODE_SIZE,
  buildCanvasDocumentFromCells,
  canvasIdSet,
  duplicateOperatorNode,
  isDrawGesture,
  mintCanvasId,
  normalizeCellLabel,
  operatorEdgeData,
  operatorNode,
  rectFromDrag
} from '../src/renderer/src/components/canvas/canvas-edit'
import { readCanvasPalette } from '../src/renderer/src/components/canvas/canvas-theme'
import {
  normalizeCanvasLabel,
  serializeCanvasDocument,
  validateCanvasDocument,
  type CanvasDocument
} from '../src/main/canvas-core'
import { i18n } from '@renderer/i18n'
import { installJsdomSvgShim, svgHost } from './helpers/jsdom-svg'

installJsdomSvgShim()

/**
 * T218 U3 — the edit half of the canvas pane.
 *
 * Two things here are load-bearing and everything else supports them:
 *
 *  - **AC U3-3: every element the operator creates carries
 *    `origin: "operator"`.** Not on one path — on EVERY creation path this unit
 *    implements: drag-to-create, edge-draw, and duplicate. Without a reliable
 *    stamp an agent re-reading the board cannot tell what the human added from
 *    what it drew itself, which is the entire reason the feature exists. Each
 *    path is asserted THROUGH a real X6 graph rather than on the helper alone,
 *    because the stamp's job is to survive the round-trip.
 *  - **AC U3-5: a Save that changes nothing produces the same bytes.** Asserted
 *    against the pure core's own serializer, over a document that has actually
 *    been through the graph.
 */

const palette = readCanvasPalette()

const DOC: CanvasDocument = {
  capycanvas: 1,
  meta: { title: 'Board', createdAt: '2026-08-01T00:00:00.000Z' },
  nodes: [
    {
      id: 'n-a',
      shape: 'box',
      x: 40,
      y: 40,
      width: 132,
      height: 52,
      label: 'Browser',
      origin: 'agent'
    },
    {
      id: 'n-b',
      shape: 'box',
      x: 320,
      y: 200,
      width: 132,
      height: 52,
      label: 'Main',
      origin: 'agent'
    },
    {
      id: 'n-c',
      shape: 'text',
      x: 40,
      y: 220,
      width: 160,
      height: 24,
      label: 'note',
      origin: 'operator'
    }
  ],
  edges: [{ id: 'e-1', source: 'n-a', target: 'n-b', label: 'IPC', origin: 'agent' }]
}

const NOW = '2026-08-23T12:00:00.000Z'

function makeGraph(doc: CanvasDocument = DOC): Graph {
  const g = createCanvasGraph({
    container: svgHost(),
    palette,
    width: 800,
    height: 600,
    editable: true
  })
  renderCanvasDocument(g, doc, palette)
  return g
}

/** What the pane would hand `canvas:write` for the graph as it stands. */
function draftOf(g: Graph, base: CanvasDocument = DOC) {
  const cells = (g.toJSON() as { cells?: unknown[] }).cells ?? []
  return buildCanvasDocumentFromCells(cells, base, NOW)
}

// ── AC U3-3: the origin stamp, on every creation path ─────────────────────
describe('U3-3 — every element the operator creates is stamped operator (§4.4)', () => {
  it('drag-to-create: a drawn box round-trips through X6 stamped operator', () => {
    const g = makeGraph()
    const node = operatorNode(rectFromDrag(500, 500, 640, 560), canvasIdSet(DOC))
    expect(node.origin).toBe('operator')
    g.addNode(toX6Node(node, palette))

    const drafted = draftOf(g).nodes.find((n) => n.id === node.id)
    expect(drafted?.origin).toBe('operator')
    // And it is a document the writer will actually accept.
    expect(validateCanvasDocument(draftOf(g)).ok).toBe(true)
    g.dispose()
  })

  it('edge-draw: the connecting hook the graph is configured with stamps operator', () => {
    const g = makeGraph()
    // THE production path — the hook X6 itself calls mid-gesture, read back off
    // the graph's own options rather than re-declared by the test.
    const hook = (g.options as unknown as { connecting?: { createEdge?: () => unknown } })
      .connecting?.createEdge
    expect(typeof hook).toBe('function')
    const edge = (
      hook as () => { setSource: (id: string) => void; setTarget: (id: string) => void }
    )()
    edge.setSource('n-a')
    edge.setTarget('n-c')
    g.addEdge(edge as never)

    const drafted = draftOf(g).edges
    expect(drafted).toHaveLength(2)
    expect(drafted.find((e) => e.id !== 'e-1')?.origin).toBe('operator')
    // The agent's pre-existing edge keeps ITS stamp — the field is creation
    // provenance, and the operator saving the file does not re-author it.
    expect(drafted.find((e) => e.id === 'e-1')?.origin).toBe('agent')
    expect(validateCanvasDocument(draftOf(g)).ok).toBe(true)
    g.dispose()
  })

  it('duplicate: a copy of an AGENT node is stamped operator, not inherited', () => {
    const g = makeGraph()
    const source = draftOf(g).nodes.find((n) => n.id === 'n-a')
    expect(source?.origin).toBe('agent')
    const copy = duplicateOperatorNode(source!, canvasIdSet(DOC))
    g.addNode(toX6Node(copy, palette))

    const drafted = draftOf(g).nodes.find((n) => n.id === copy.id)
    // The operator created THIS one. Inheriting `agent` would be the quiet
    // version of the same lie defaulting a missing stamp would tell.
    expect(drafted?.origin).toBe('operator')
    expect(drafted?.label).toBe('Browser')
    expect(drafted?.x).toBe(56)
    g.dispose()
  })

  it('a stamp is never invented: a cell that lost its origin reaches the writer without one', () => {
    const g = makeGraph()
    const orphan = toX6Node(
      { id: 'n-x', shape: 'box', x: 0, y: 0, origin: 'operator' },
      palette
    ) as Record<string, unknown>
    delete (orphan.data as Record<string, unknown>).origin
    g.addNode(orphan as never)

    const drafted = draftOf(g)
    expect(drafted.nodes.find((n) => n.id === 'n-x')?.origin).toBeUndefined()
    // §4.4 is explicit that this is a refusal, not a defaulted value — the
    // whole point being that nobody may claim the human drew something.
    const verdict = validateCanvasDocument(drafted)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('missing-origin')
    g.dispose()
  })

  it('every element the operator did NOT create keeps the stamp it arrived with', () => {
    const g = makeGraph()
    const drafted = draftOf(g)
    expect(drafted.nodes.map((n) => n.origin)).toEqual(['agent', 'agent', 'operator'])
    expect(drafted.edges.map((e) => e.origin)).toEqual(['agent'])
    g.dispose()
  })
})

// ── AC U3-5: repeated Saves are byte-stable ───────────────────────────────
describe('U3-5 — a Save that changes nothing produces the same bytes (§4.1)', () => {
  it('a document survives render → toJSON → build with an identical serialization', () => {
    const g = makeGraph()
    const drafted = draftOf(g) as unknown as CanvasDocument
    const verdict = validateCanvasDocument(drafted)
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    // `updatedAt` is the ONE thing §7.2 step 6 changes; align it and the round
    // trip must be byte-identical, or the graph is injecting churn.
    const expected = serializeCanvasDocument({
      ...DOC,
      meta: { ...DOC.meta, updatedAt: NOW }
    })
    expect(serializeCanvasDocument(verdict.doc)).toBe(expected)
    g.dispose()
  })

  it('two consecutive builds with no edits between them are byte-identical', () => {
    const g = makeGraph()
    const first = draftOf(g) as unknown as CanvasDocument
    const second = buildCanvasDocumentFromCells(
      (g.toJSON() as { cells?: unknown[] }).cells ?? [],
      first,
      NOW
    ) as unknown as CanvasDocument
    expect(serializeCanvasDocument(second)).toBe(serializeCanvasDocument(first))
    g.dispose()
  })

  it('the document order is preserved, not X6 model order', () => {
    const g = makeGraph()
    // Delete the FIRST node and re-add it: X6 now holds it last.
    const cell = g.getCellById('n-a')!
    g.removeCell(cell)
    g.addNode(toX6Node(DOC.nodes[0], palette))
    const ids = draftOf(g).nodes.map((n) => n.id)
    // `n-a` is still first, because the base document says so. Taking X6's
    // order verbatim would reshuffle the file for an edit that changed nothing.
    expect(ids).toEqual(['n-a', 'n-b', 'n-c'])
    g.dispose()
  })

  it('unknown top-level keys and meta survive a graph round-trip (§4.3)', () => {
    const withExtras: CanvasDocument = { ...DOC, layouts: { hint: 'from a newer Harnu' } }
    const g = makeGraph(withExtras)
    const drafted = draftOf(g, withExtras)
    expect(drafted.layouts).toEqual({ hint: 'from a newer Harnu' })
    expect(drafted.meta.title).toBe('Board')
    expect(drafted.meta.createdAt).toBe('2026-08-01T00:00:00.000Z')
    expect(drafted.meta.updatedAt).toBe(NOW)
    g.dispose()
  })

  it('a node kind X6 draws as a plain rect is not flattened into a box', () => {
    const g = makeGraph()
    // `text` and an unknown `harnu/<name>` are both rendered as an X6 `rect`;
    // only the `data.kind` stamp can tell them apart on the way back.
    expect(draftOf(g).nodes.find((n) => n.id === 'n-c')?.shape).toBe('text')

    const exotic: CanvasDocument = {
      ...DOC,
      nodes: [{ id: 'n-z', shape: 'harnu/budget-row', x: 0, y: 0, origin: 'agent' }],
      edges: []
    }
    const g2 = makeGraph(exotic)
    expect(draftOf(g2, exotic).nodes[0].shape).toBe('harnu/budget-row')
    g.dispose()
    g2.dispose()
  })
})

// ── Labels: §4.5 in both directions ───────────────────────────────────────
describe('label handling across the edit round-trip (§4.5)', () => {
  const SHAPES = [
    {
      name: 'only attrs.text.text (creation path)',
      cell: { attrs: { text: { text: 'created' } } },
      expected: 'created'
    },
    {
      name: 'only attrs.label.text (rename path)',
      cell: { attrs: { label: { text: 'renamed' } } },
      expected: 'renamed'
    },
    {
      name: 'both, agreeing',
      cell: { attrs: { text: { text: 'same' }, label: { text: 'same' } } },
      expected: 'same'
    },
    {
      name: 'both, disagreeing — the rename path wins',
      cell: { attrs: { text: { text: 'stale' }, label: { text: 'fresh' } } },
      expected: 'fresh'
    }
  ]

  for (const shape of SHAPES) {
    it(`the renderer's mirror agrees with the pure core: ${shape.name}`, () => {
      // The mirror exists because a VALUE import of `canvas-core` would drag
      // `node:path` into the renderer bundle. This is what stops the two copies
      // from drifting apart in silence.
      expect(normalizeCellLabel(shape.cell)).toBe(shape.expected)
      expect(normalizeCanvasLabel(shape.cell)).toBe(normalizeCellLabel(shape.cell))
    })
  }

  it('a rename written to both paths reads back as the new name', () => {
    const g = makeGraph()
    const node = g.getCellById('n-a')!
    node.attr({ text: { text: 'Renderer' }, label: { text: 'Renderer' } })
    expect(draftOf(g).nodes.find((n) => n.id === 'n-a')?.label).toBe('Renderer')
    g.dispose()
  })

  it("an EDGE label comes from the document, never from X6's labels[]", () => {
    const g = makeGraph()
    const edge = g.getCellById('e-1')!
    // Simulate X6 becoming the author of the label — the exact trap that would
    // reopen on edges, since `canvas-core` reads an edge label from `raw.label`
    // and normalization is scoped to nodes.
    ;(edge as unknown as { setLabels: (l: unknown[]) => void }).setLabels([
      { attrs: { text: { text: 'STALE FROM X6' } } }
    ])
    expect(draftOf(g).edges[0].label).toBe('IPC')
    g.dispose()
  })

  it('an edge the operator draws carries no label at all', () => {
    const g = makeGraph()
    const hook = (g.options as unknown as { connecting: { createEdge: () => unknown } }).connecting
      .createEdge
    const edge = hook() as { setSource: (id: string) => void; setTarget: (id: string) => void }
    edge.setSource('n-b')
    edge.setTarget('n-c')
    g.addEdge(edge as never)
    expect(draftOf(g).edges.find((e) => e.id !== 'e-1')?.label).toBeUndefined()
    g.dispose()
  })
})

// ── The gesture split and the edit affordances ────────────────────────────
describe('the editing affordances the ACs name (U3-1, U3-2)', () => {
  it('an editable graph arms selection, rubberband, resizing and history', () => {
    const g = makeGraph()
    const selection = g.getPlugin('selection') as unknown as { options: Record<string, unknown> }
    expect(selection.options.rubberband).toBe(true)
    // Shift, so the plain drag stays free to DRAW — the three-way conflict
    // (pan / rubberband / draw) resolved explicitly rather than by luck.
    expect(selection.options.modifiers).toBe(CANVAS_RUBBERBAND_MODIFIER)
    const transform = g.getPlugin('transform') as unknown as {
      options: { resizing: { enabled: boolean; minWidth: number } }
    }
    expect(transform.options.resizing.enabled).toBe(true)
    expect(transform.options.resizing.minWidth).toBe(CANVAS_MIN_NODE_SIZE.width)
    g.dispose()
  })

  it('a read-only graph still arms none of them (the U2 contract is intact)', () => {
    const g = createCanvasGraph({ container: svgHost(), palette, width: 400, height: 300 })
    const selection = g.getPlugin('selection') as unknown as { options: Record<string, unknown> }
    expect(selection.options.rubberband).toBe(false)
    // `interacting: false` is the U2 contract in one flag: nothing the pointer
    // does may change the document, so no port drag can start an edge either.
    expect((g.options as unknown as { interacting: unknown }).interacting).toBe(false)
    const transform = g.getPlugin('transform') as unknown as { options: { resizing: unknown } }
    expect(transform.options.resizing).toBe(false)
    g.dispose()
  })

  it('undo and redo take an edit back and put it again', () => {
    const g = makeGraph()
    g.cleanHistory()
    expect(g.canUndo()).toBe(false)
    g.addNode(toX6Node(operatorNode(rectFromDrag(0, 0, 90, 60), canvasIdSet(DOC)), palette))
    expect(g.canUndo()).toBe(true)
    expect(draftOf(g).nodes).toHaveLength(4)
    g.undo()
    expect(draftOf(g).nodes).toHaveLength(3)
    g.redo()
    expect(draftOf(g).nodes).toHaveLength(4)
    g.dispose()
  })

  it('deleting a node deletes the edges that hung off it, so the file stays valid', () => {
    const g = makeGraph()
    g.removeCell(g.getCellById('n-a')!)
    const drafted = draftOf(g)
    expect(drafted.nodes.map((n) => n.id)).toEqual(['n-b', 'n-c'])
    // §4.3 refuses a dangling edge outright, so a node deletion that left one
    // behind would produce a board that can never be saved again.
    expect(drafted.edges).toHaveLength(0)
    expect(validateCanvasDocument(drafted).ok).toBe(true)
    g.dispose()
  })

  it('a resize is what the document records', () => {
    const g = makeGraph()
    g.getCellById('n-a')!.setProp('size', { width: 240, height: 90 })
    const drafted = draftOf(g).nodes.find((n) => n.id === 'n-a')
    expect(drafted?.width).toBe(240)
    expect(drafted?.height).toBe(90)
    g.dispose()
  })

  it('a framed node carries four ports; a bare text annotation carries none', () => {
    const g = makeGraph()
    expect(
      (g.getCellById('n-a') as never as { getPorts: () => unknown[] }).getPorts()
    ).toHaveLength(CANVAS_PORT_IDS.length)
    expect(
      (g.getCellById('n-c') as never as { getPorts: () => unknown[] }).getPorts()
    ).toHaveLength(0)
    g.dispose()
  })

  it('ports are hidden until the pointer is on their node, and hiding them is not an edit', () => {
    const g = makeGraph()
    const node = g.getCellById('n-a')!
    const vis = (): unknown =>
      (node as never as { getPortProp: (id: string, path: string) => unknown }).getPortProp(
        'top',
        'attrs/circle/style/visibility'
      )
    // Nothing on the port ITEM yet — the hidden default lives on the port
    // GROUP, which is what makes a board free of permanent dots.
    expect(vis()).toBeUndefined()
    setCanvasPortsVisible(g, 'n-a', true)
    expect(vis()).toBe('visible')
    setCanvasPortsVisible(g, 'n-a', false)
    expect(vis()).toBe('hidden')
    // Port visibility is chrome — it must never reach the file.
    expect(serializeCanvasDocument(draftOf(g) as unknown as CanvasDocument)).toContain('"n-a"')
    g.dispose()
  })
})

describe('the pure drag geometry', () => {
  it('a drag under the threshold is a click, not a draw', () => {
    expect(isDrawGesture(0, 0, DRAW_THRESHOLD - 1, DRAW_THRESHOLD - 1)).toBe(false)
    expect(isDrawGesture(0, 0, DRAW_THRESHOLD, 0)).toBe(true)
    expect(isDrawGesture(0, 0, 0, -DRAW_THRESHOLD)).toBe(true)
  })

  it('the threshold is screen distance, so a zoomed-out board is not litter-prone', () => {
    // At 20% zoom the same 6px of hand movement covers 30 world units. Judging
    // the gesture in raw world units would turn a 1px twitch into a box.
    expect(isDrawGesture(0, 0, 20, 0, 0.2)).toBe(false)
    expect(isDrawGesture(0, 0, 30, 0, 0.2)).toBe(true)
    // And at 3× the opposite: 6px of hand is only 2 world units.
    expect(isDrawGesture(0, 0, 2, 0, 3)).toBe(true)
  })

  it('any drag direction becomes a positive rect, floored at the minimum size', () => {
    expect(rectFromDrag(200, 200, 100, 100)).toEqual({
      x: 100,
      y: 100,
      width: 100,
      height: 100
    })
    expect(rectFromDrag(10, 10, 12, 11)).toEqual({
      x: 10,
      y: 10,
      width: MIN_DRAWN_NODE_SIZE.width,
      height: MIN_DRAWN_NODE_SIZE.height
    })
  })

  it('a minted id never collides with one already in the document', () => {
    expect(mintCanvasId('n', new Set())).toBe('n-1')
    expect(mintCanvasId('n', new Set(['n-1', 'n-2']))).toBe('n-3')
    // §4.3 makes ids unique across nodes AND edges together.
    expect(canvasIdSet(DOC).has('e-1')).toBe(true)
  })

  it('operatorEdgeData is the stamp and nothing else', () => {
    expect(operatorEdgeData()).toEqual({ origin: 'operator' })
  })
})

// ── The pane, end to end ──────────────────────────────────────────────────
const canvasRead = vi.fn(async (p: string) => ({ ok: true as const, path: p, doc: DOC }))
const canvasWrite = vi.fn(async () => ({
  ok: true as const,
  path: '/wt/b.harnucanvas.json',
  bytes: 1
}))
const markdownRead = vi.fn(async () => ({ ok: false as const, code: 'not-found', error: 'x' }))
let canvasChangedCb: ((p: { path: string }) => void) | null = null

const PANE = {
  id: 'h-canvas',
  type: 'canvas' as const,
  cwd: '/wt',
  ratio: 1,
  filePath: '/wt/board.harnucanvas.json'
}

beforeEach(() => {
  canvasRead.mockClear()
  canvasWrite.mockClear()
  canvasRead.mockImplementation(async (p: string) => ({ ok: true, path: p, doc: DOC }))
  canvasWrite.mockImplementation(async () => ({
    ok: true,
    path: '/wt/board.harnucanvas.json',
    bytes: 1
  }))
  canvasChangedCb = null
  const api = {
    canvasRead,
    canvasWrite,
    markdownRead,
    canvasWatchStart: vi.fn(async () => undefined),
    canvasWatchStop: vi.fn(async () => undefined),
    onCanvasChanged: (cb: (p: { path: string }) => void) => {
      canvasChangedCb = cb
      return () => {
        canvasChangedCb = null
      }
    },
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn()
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, k: string) {
      return k in t ? t[k] : () => () => {}
    }
  })
  setActivePinia(createPinia())
})

function mountPane() {
  return mount(DiagramPane, {
    props: { pane: { ...PANE }, worktreePath: '/wt' },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await flushPromises()
    await nextTick()
  }
}

/** Drive a real blank-canvas drag through the graph's own event plumbing. */
function dragOnBlankCanvas(root: Element, from: [number, number], to: [number, number]): void {
  const svg = root.querySelector('[data-testid="diagram-canvas-host"] svg')!
  svg.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: from[0], clientY: from[1] })
  )
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: to[0], clientY: to[1] }))
  window.dispatchEvent(new MouseEvent('mouseup', { clientX: to[0], clientY: to[1] }))
}

describe('DiagramPane — the edit loop (U3-1, U3-3, U3-8)', () => {
  it('the dirty dot and Save are absent on a freshly loaded board', async () => {
    const w = mountPane()
    await settle()
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
    expect(w.find('[data-testid="diagram-save"]').attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('drag → rename → Save writes an operator-stamped box through the confined writer', async () => {
    const w = mountPane()
    await settle()

    dragOnBlankCanvas(w.element, [200, 200], [400, 320])
    await settle()

    // The box is born straight into rename: the operator is already looking at
    // it, and it has no name yet.
    const input = w.find('[data-testid="diagram-rename-input"]')
    expect(input.exists()).toBe(true)
    await input.setValue('Router')
    await input.trigger('keydown', { key: 'Enter' })
    await settle()

    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(true)
    expect(w.find('[data-testid="diagram-save"]').attributes('disabled')).toBeUndefined()

    await w.find('[data-testid="diagram-save"]').trigger('click')
    await settle()

    expect(canvasWrite).toHaveBeenCalledTimes(1)
    const [path, doc] = canvasWrite.mock.calls[0] as unknown as [string, CanvasDocument]
    expect(path).toBe('/wt/board.harnucanvas.json')
    const created = doc.nodes.find((n) => !['n-a', 'n-b', 'n-c'].includes(n.id))
    expect(created?.origin).toBe('operator')
    expect(created?.label).toBe('Router')
    // §7.2 step 6 — and the whole payload is something the writer will accept.
    expect(doc.meta.updatedAt).toBeTruthy()
    expect(validateCanvasDocument(doc).ok).toBe(true)

    // A successful Save clears the dirty state.
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
    w.unmount()
  })

  it('U3-9 — a refused Save leaves the pane dirty and says so', async () => {
    canvasWrite.mockImplementation(async () => ({
      ok: false as const,
      code: 'invalid-document',
      error: 'node "n-x" is missing the required "origin" stamp'
    }))
    const w = mountPane()
    await settle()
    dragOnBlankCanvas(w.element, [200, 200], [400, 320])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()

    await w.find('[data-testid="diagram-save"]').trigger('click')
    await settle()

    // The operator's work is still in front of them; the file was not touched.
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(true)
    expect(w.find('[data-testid="diagram-save"]').attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('a short drag on the blank board is a click — it does not litter it with boxes', async () => {
    const w = mountPane()
    await settle()
    dragOnBlankCanvas(w.element, [200, 200], [202, 201])
    await settle()
    expect(w.find('[data-testid="diagram-rename-input"]').exists()).toBe(false)
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
    w.unmount()
  })

  it('U3-6 case B — a disk change while dirty raises the banner and does NOT reload', async () => {
    const w = mountPane()
    await settle()
    expect(canvasRead).toHaveBeenCalledTimes(1)
    dragOnBlankCanvas(w.element, [200, 200], [400, 320])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()

    canvasChangedCb?.({ path: '/wt/board.harnucanvas.json' })
    await settle()

    expect(w.find('[data-testid="diagram-stale-banner"]').exists()).toBe(true)
    // The whole safety property: the pane did not re-read, so the operator's
    // unsaved work is untouched and their next Save (case C) is informed.
    expect(canvasRead).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(true)
    w.unmount()
  })

  it('U3-7 case A — a disk change while clean reloads silently, no banner', async () => {
    const w = mountPane()
    await settle()
    canvasChangedCb?.({ path: '/wt/board.harnucanvas.json' })
    await settle()
    expect(canvasRead).toHaveBeenCalledTimes(2)
    expect(w.find('[data-testid="diagram-stale-banner"]').exists()).toBe(false)
    w.unmount()
  })

  it('U3-8 — closing a dirty pane does not close it; the discard toast does', async () => {
    const w = mountPane()
    await settle()
    const helpers = (await import('../src/renderer/src/stores/helpers')).useHelpersStore()
    const removed = vi.spyOn(helpers, 'removeHelper')

    dragOnBlankCanvas(w.element, [200, 200], [400, 320])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()

    await w.find('button[aria-label="Close helper"]').trigger('click')
    await settle()
    expect(removed).not.toHaveBeenCalled()

    const ui = (await import('../src/renderer/src/stores/ui')).useUiStore()
    const toast = ui.toasts.find((t) => t.action)
    expect(toast).toBeTruthy()
    toast!.action!.handler()
    await settle()
    expect(removed).toHaveBeenCalledWith('/wt', 'h-canvas')
    w.unmount()
  })

  it('pressing Close twice leaves ONE warning, not a stack of permanent ones', async () => {
    const w = mountPane()
    await settle()
    dragOnBlankCanvas(w.element, [200, 200], [400, 320])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()

    const ui = (await import('../src/renderer/src/stores/ui')).useUiStore()
    await w.find('button[aria-label="Close helper"]').trigger('click')
    await w.find('button[aria-label="Close helper"]').trigger('click')
    await w.find('button[aria-label="Close helper"]').trigger('click')
    await settle()
    // The toast never auto-dismisses, so stacking it would leave three
    // identical permanent warnings on screen — seen in the real app.
    expect(ui.toasts.filter((t) => t.action).length).toBe(1)

    // And a Save retires it: the question it was asking has been answered.
    await w.find('[data-testid="diagram-save"]').trigger('click')
    await settle()
    expect(ui.toasts.filter((t) => t.action).length).toBe(0)
    w.unmount()
  })

  it('a clean pane closes on the first click', async () => {
    const w = mountPane()
    await settle()
    const helpers = (await import('../src/renderer/src/stores/helpers')).useHelpersStore()
    const removed = vi.spyOn(helpers, 'removeHelper')
    await w.find('button[aria-label="Close helper"]').trigger('click')
    await settle()
    expect(removed).toHaveBeenCalledWith('/wt', 'h-canvas')
    w.unmount()
  })

  it('U3-2 — Delete removes the selection, and ⌘Z puts it back', async () => {
    const w = mountPane()
    await settle()
    dragOnBlankCanvas(w.element, [200, 200], [400, 320])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()
    // The freshly drawn box is selected; the pane has focus because the drag
    // took it. Both are what make the bare Delete key safe to bind.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    await settle()
    await w.find('[data-testid="diagram-save"]').trigger('click')
    await settle()
    const afterDelete = (canvasWrite.mock.calls[0] as unknown as [string, CanvasDocument])[1]
    expect(afterDelete.nodes.map((n) => n.id)).toEqual(['n-a', 'n-b', 'n-c'])

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    await settle()
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(true)
    await w.find('[data-testid="diagram-save"]').trigger('click')
    await settle()
    const afterUndo = (canvasWrite.mock.calls[1] as unknown as [string, CanvasDocument])[1]
    expect(afterUndo.nodes).toHaveLength(4)
    expect(afterUndo.nodes.find((n) => !['n-a', 'n-b', 'n-c'].includes(n.id))?.origin).toBe(
      'operator'
    )
    w.unmount()
  })

  it('U3-3 — ⌘D duplicates the selection, stamped operator even off an agent node', async () => {
    const w = mountPane()
    await settle()
    // Select everything, then duplicate: the agent's two boxes and the
    // operator's annotation all become operator-stamped copies.
    w.find('[data-testid="diagram-canvas-host"]').element.parentElement?.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }))
    await settle()
    await w.find('[data-testid="diagram-save"]').trigger('click')
    await settle()
    const doc = (canvasWrite.mock.calls[0] as unknown as [string, CanvasDocument])[1]
    const copies = doc.nodes.filter((n) => !['n-a', 'n-b', 'n-c'].includes(n.id))
    expect(copies).toHaveLength(3)
    for (const copy of copies) expect(copy.origin).toBe('operator')
    // The originals are untouched — the stamp is creation provenance, and a
    // duplicate does not re-author what it was copied from.
    expect(doc.nodes.find((n) => n.id === 'n-a')?.origin).toBe('agent')
    expect(validateCanvasDocument(doc).ok).toBe(true)
    w.unmount()
  })

  it('the empty board says how to start drawing on it', async () => {
    canvasRead.mockImplementation(async (p: string) => ({
      ok: true,
      path: p,
      doc: { capycanvas: 1, meta: {}, nodes: [], edges: [] } as CanvasDocument
    }))
    const w = mountPane()
    await settle()
    expect(w.text()).toContain('Drag anywhere to draw a box')
    w.unmount()
  })
})
