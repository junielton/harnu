// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import { Shape, type Graph } from '@antv/x6'
import DiagramPane from '../src/renderer/src/components/DiagramPane.vue'
import {
  CANVAS_DERIVED_CHANGE,
  CANVAS_MIN_NODE_SIZE,
  createCanvasGraph,
  operatorEdgeSpec,
  renderCanvasDocument,
  restyleCanvasEdge,
  restyleCanvasNode,
  setCanvasPortsVisible,
  setCanvasRubberband
} from '../src/renderer/src/components/canvas/canvas-graph'
import {
  CANVAS_PORT_IDS,
  DEFAULT_NODE_SIZE,
  toX6Node
} from '../src/renderer/src/components/canvas/canvas-cells'
import {
  DRAW_THRESHOLD,
  MIN_DRAWN_NODE_SIZE,
  buildCanvasDocumentFromCells,
  canvasIdSet,
  duplicateOperatorNode,
  isDrawGesture,
  mintCanvasId,
  nodeDraftFromCell,
  normalizeCellLabel,
  operatorEdgeData,
  operatorNode,
  placedRect,
  rectFromDrag
} from '../src/renderer/src/components/canvas/canvas-edit'
import {
  CANVAS_LOAD_Z,
  documentStackOrder,
  renderStackZ
} from '../src/renderer/src/components/canvas/canvas-layers'
import { readCanvasPalette } from '../src/renderer/src/components/canvas/canvas-theme'
import {
  normalizeCanvasLabel,
  serializeCanvasDocument,
  validateCanvasDocument,
  type CanvasDocument
} from '../src/main/canvas-core'
import { i18n } from '@renderer/i18n'
import { installJsdomSvgShim, svgHost } from './helpers/jsdom-svg'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { mountCloseTakeover, pressEsc } from './helpers/close-takeover-harness'

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

function makeGraph(doc: CanvasDocument = DOC, images: Record<string, string> = {}): Graph {
  const g = createCanvasGraph({
    container: svgHost(),
    palette,
    width: 800,
    height: 600,
    editable: true
  })
  renderCanvasDocument(g, doc, palette, images)
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
    // No modifier: in the Select tool the plain drag IS the rubberband (T536
    // §5). The pane decides per tool whether it is armed — see
    // `setCanvasRubberband` — so the graph no longer splits it by a key.
    expect(selection.options.modifiers).toBeNull()
    // Shift joins ctrl/meta: shift+click toggles a node in the selection.
    expect(selection.options.multipleSelectionModifiers).toEqual(['ctrl', 'meta', 'shift'])
    const transform = g.getPlugin('transform') as unknown as {
      options: { resizing: { enabled: () => boolean; minWidth: number } }
    }
    // A function since T536 U1: handles open only while nodes are interactive
    // (the Select tool). With the default `nodesInteractive`, that is always.
    expect(transform.options.resizing.enabled()).toBe(true)
    expect(transform.options.resizing.minWidth).toBe(CANVAS_MIN_NODE_SIZE.width)
    g.dispose()
  })

  it('resize handles follow nodesInteractive: none while another tool owns the press', () => {
    let interactive = true
    const g = createCanvasGraph({
      container: svgHost(),
      palette,
      width: 800,
      height: 600,
      editable: true,
      nodesInteractive: () => interactive
    })
    const transform = g.getPlugin('transform') as unknown as {
      options: { resizing: { enabled: () => boolean } }
    }
    expect(transform.options.resizing.enabled()).toBe(true)
    interactive = false
    expect(transform.options.resizing.enabled()).toBe(false)
    g.dispose()
  })

  it('setCanvasRubberband switches the rubberband off and on again at runtime', () => {
    const g = makeGraph()
    expect(g.isRubberbandEnabled()).toBe(true)
    setCanvasRubberband(g, false)
    expect(g.isRubberbandEnabled()).toBe(false)
    setCanvasRubberband(g, true)
    expect(g.isRubberbandEnabled()).toBe(true)
    g.dispose()
  })

  it('nodes are movable and connectable by default', () => {
    const g = makeGraph()
    const view = g.findViewByCell(g.getCellById('n-a')!)!
    expect(view.can('nodeMovable')).toBe(true)
    expect(view.can('magnetConnectable')).toBe(true)
    g.dispose()
  })

  it('nodesInteractive() is read per gesture: false freezes nodes and their ports', () => {
    let interactive = false
    const g = createCanvasGraph({
      container: svgHost(),
      palette,
      width: 800,
      height: 600,
      editable: true,
      nodesInteractive: () => interactive
    })
    renderCanvasDocument(g, DOC, palette)
    const view = g.findViewByCell(g.getCellById('n-a')!)!
    expect(view.can('nodeMovable')).toBe(false)
    expect(view.can('magnetConnectable')).toBe(false)
    // Read at gesture time, not captured at construction: a tool switch needs
    // no graph rebuild.
    interactive = true
    expect(view.can('nodeMovable')).toBe(true)
    expect(view.can('magnetConnectable')).toBe(true)
    // Edges stay pinned to their endpoints whatever the tool (§4.3 schema).
    expect(view.can('edgeMovable')).toBe(false)
    g.dispose()
  })

  it('setCanvasRubberband never arms a read-only graph, but may still disarm it', () => {
    const g = createCanvasGraph({ container: svgHost(), palette, width: 400, height: 300 })
    expect(g.isRubberbandEnabled()).toBe(false)
    // A viewer's Selection keeps `enabled: true` (only `rubberband` is off), so
    // X6's own `enableRubberband()` WOULD arm blank-drag selection in it — the
    // U2 contract says nothing the pointer does may change a read-only board.
    setCanvasRubberband(g, true)
    expect(g.isRubberbandEnabled()).toBe(false)
    expect(
      (g.getPlugin('selection') as unknown as { options: Record<string, unknown> }).options
        .rubberband
    ).toBe(false)
    setCanvasRubberband(g, false)
    expect(g.isRubberbandEnabled()).toBe(false)
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

  it('history drops a change marked CANVAS_DERIVED_CHANGE and keeps an ordinary one (T536 U3)', () => {
    const g = makeGraph()
    g.cleanHistory()
    const node = g.getCellById('n-a')!
    node.setAttrs({ body: { stroke: '#123456' } }, { [CANVAS_DERIVED_CHANGE]: true })
    expect(node.attr('body/stroke')).toBe('#123456')
    expect(g.canUndo()).toBe(false)
    node.setAttrs({ body: { stroke: '#654321' } })
    expect(g.canUndo()).toBe(true)
    g.dispose()
  })

  it('a derived change neither records nor clears the redo stack (T536 U3)', () => {
    const g = makeGraph()
    g.cleanHistory()
    const node = g.getCellById('n-a')!
    node.setData({ ...node.getData(), props: { style: { tone: 'red' } } }, { overwrite: true })
    g.undo()
    expect(g.canRedo()).toBe(true)
    restyleCanvasNode(node as never, palette, {})
    expect(g.canRedo()).toBe(true)
    expect(g.canUndo()).toBe(false)
    g.dispose()
  })

  it('restyleCanvasNode re-derives the attrs from the node data, label and all (T536 U3)', () => {
    const g = makeGraph()
    const node = g.getCellById('n-a')!
    node.attr({ text: { text: 'Renamed' }, label: { text: 'Renamed' } })
    // Written with `silent`, so nothing re-derives behind the test's back.
    node.setData(
      { ...node.getData(), props: { style: { tone: 'red', stroke: 'dashed' } } },
      { overwrite: true, silent: true }
    )
    restyleCanvasNode(node as never, palette, {})
    expect(node.attr('body/stroke')).toBe(palette.red)
    expect(node.attr('body/strokeDasharray')).toBe('6 4')
    expect(node.attr('label/text')).toBe('Renamed')
    expect(nodeDraftFromCell(node.toJSON() as Record<string, unknown>).label).toBe('Renamed')
    g.dispose()
  })

  // Live matrix (T536 U3, row S1/S3): `overwrite` dropped the X6 shape's own default
  // attrs (a rect's `refWidth`/`refHeight`, an ellipse's `refRx`, the label's centring
  // `refX`/`refY`/`textAnchor`), so a box collapsed to 0×0 and its label jumped to the
  // corner after any pick — invisible to an attr-only assertion. A restyled node must
  // carry exactly the attrs a fresh render of the same style gives it.
  it('a restyled node carries exactly the attrs a fresh render of that style gives it (T536 U3)', () => {
    const style = { tone: 'green', stroke: 'dashed', fontSize: 'xl', align: 'left', opacity: 50 }
    const kinds: [string, number, number][] = [
      ['box', 132, 52],
      ['ellipse', 132, 64],
      ['diamond', 132, 80],
      ['text', 132, 40]
    ]
    const plain: CanvasDocument = {
      ...DOC,
      nodes: kinds.map(([shape, width, height], i) => ({
        id: `n-${shape}`,
        shape,
        x: 40 + i * 180,
        y: 40,
        width,
        height,
        label: shape,
        origin: 'agent' as const
      })),
      edges: []
    }
    const styledDoc: CanvasDocument = {
      ...plain,
      nodes: plain.nodes.map((n) => ({ ...n, props: { style } }))
    }
    const g = makeGraph(plain)
    const fresh = makeGraph(styledDoc)
    for (const [shape] of kinds) {
      const node = g.getCellById(`n-${shape}`)!
      node.setData({ ...node.getData(), props: { style } }, { overwrite: true, silent: true })
      restyleCanvasNode(node as never, palette, {})
      expect(node.getAttrs(), shape).toEqual(fresh.getCellById(`n-${shape}`)!.getAttrs())
    }
    // The shape defaults themselves, spelled out for the box.
    const box = g.getCellById('n-box')!
    expect(box.attr('body/refWidth')).toBe('100%')
    expect(box.attr('body/refHeight')).toBe('100%')
    g.dispose()
    fresh.dispose()
  })

  // Final review M4: `image` is the one class whose constructor adds something outside the
  // derived attrs (`xlink:href`, through the `imageUrl` hook), so pin it on its own: the
  // RENDERED `<image>` is compared, because `xlinkHref` and `xlink:href` differ as keys
  // but not on screen.
  it('a restyled image, resolved or not, renders exactly as a fresh render of that style (T536 U3)', async () => {
    const style = { opacity: 50 }
    const images = { 'a.png': 'data:image/png;base64,AAAA' }
    const base = (id: string, src: string): CanvasDocument['nodes'][number] => ({
      id,
      shape: 'image',
      x: 40,
      y: 40,
      width: 200,
      height: 100,
      label: id,
      origin: 'agent' as const,
      props: { src }
    })
    const plain: CanvasDocument = {
      ...DOC,
      nodes: [base('n-img', 'a.png'), base('n-gone', 'missing.png')],
      edges: []
    }
    const styledDoc: CanvasDocument = {
      ...plain,
      nodes: plain.nodes.map((n) => ({ ...n, props: { ...n.props, style } }))
    }
    const g = makeGraph(plain, images)
    const fresh = makeGraph(styledDoc, images)
    const imageOf = (graph: Graph, id: string): Element | null =>
      (
        graph.findViewByCell(graph.getCellById(id)!)?.container as Element | undefined
      )?.querySelector('image') ?? null

    for (const id of ['n-img', 'n-gone']) {
      const node = g.getCellById(id)!
      node.setData(
        { ...node.getData(), props: { ...node.getData().props, style } },
        { overwrite: true, silent: true }
      )
      restyleCanvasNode(node as never, palette, images)
    }
    // X6 paints on a frame: let both graphs flush before reading the SVG.
    await new Promise((r) => setTimeout(r, 100))

    // Resolved: the same `<image>` element attributes (href, size, opacity).
    const got = imageOf(g, 'n-img')!
    const want = imageOf(fresh, 'n-img')!
    expect(got).not.toBeNull()
    for (const name of ['xlink:href', 'href', 'width', 'height', 'opacity']) {
      expect(got.getAttribute(name), name).toBe(want.getAttribute(name))
    }
    expect(got.getAttribute('opacity')).toBe('0.5')
    expect(got.getAttribute('width')).toBe('200')
    expect(got.getAttribute('height')).toBe('100')

    // Unresolved placeholder: a rect with the same attrs as a fresh render.
    expect(g.getCellById('n-gone')!.getAttrs()).toEqual(fresh.getCellById('n-gone')!.getAttrs())
    g.dispose()
    fresh.dispose()
  })

  it("applying a style leaves a node's ports exactly as they were (T536 U3)", () => {
    const g = makeGraph()
    const node = g.getCellById('n-a') as never as {
      getPorts: () => unknown[]
      getData: () => Record<string, unknown>
      setData: (d: unknown, o: unknown) => void
    }
    const before = JSON.parse(JSON.stringify(node.getPorts()))
    expect(before).toHaveLength(CANVAS_PORT_IDS.length)
    node.setData(
      { ...node.getData(), props: { style: { tone: 'red', stroke: 'dashed' } } },
      { overwrite: true, silent: true }
    )
    restyleCanvasNode(node as never, palette, {})
    expect(JSON.parse(JSON.stringify(node.getPorts()))).toEqual(before)
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

  it('revealing ports on hover is not an undo step, so it never empties the redo stack (T536 U3)', () => {
    const g = makeGraph()
    g.cleanHistory()
    g.getCellById('n-b')!.setAttrs({ body: { stroke: '#654321' } })
    g.undo()
    expect(g.canRedo()).toBe(true)
    setCanvasPortsVisible(g, 'n-a', true)
    setCanvasPortsVisible(g, 'n-a', false)
    expect(g.canUndo()).toBe(false)
    expect(g.canRedo()).toBe(true)
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

  it('placedRect centres a shape-default footprint on the click (T536 U1)', () => {
    expect(placedRect(300, 300, 'box')).toEqual({ x: 234, y: 274, width: 132, height: 52 })
    expect(placedRect(300, 300, 'text')).toEqual({ x: 220, y: 288, width: 160, height: 24 })
    // An unknown shape falls back to the box footprint, as the renderer does.
    expect(placedRect(0, 0, 'nope')).toEqual({ x: -66, y: -26, width: 132, height: 52 })
  })

  it('placedRect centres the ellipse and diamond default footprints (T536 U2)', () => {
    expect(placedRect(300, 300, 'ellipse')).toEqual({ x: 234, y: 268, width: 132, height: 64 })
    expect(placedRect(300, 300, 'diamond')).toEqual({ x: 234, y: 260, width: 132, height: 80 })
  })

  it('operatorNode mints ellipse and diamond stamped operator (T536 U2)', () => {
    const rect = { x: 1, y: 2, width: 132, height: 80 }
    expect(operatorNode(rect, new Set(), '', 'ellipse')).toMatchObject({
      shape: 'ellipse',
      origin: 'operator'
    })
    expect(operatorNode(rect, new Set(), '', 'diamond')).toMatchObject({
      shape: 'diamond',
      origin: 'operator'
    })
  })

  it('ellipse and diamond round-trip through a real graph with kind and origin intact (T536 U2)', () => {
    const doc: CanvasDocument = {
      ...DOC,
      nodes: [
        ...DOC.nodes,
        { id: 'n-e', shape: 'ellipse', x: 10, y: 400, label: 'Start', origin: 'agent' },
        { id: 'n-d', shape: 'diamond', x: 200, y: 400, width: 90, height: 60, origin: 'operator' }
      ]
    }
    const g = makeGraph(doc)
    expect(g.getCellById('n-e')?.shape).toBe('ellipse')
    expect(g.getCellById('n-d')?.shape).toBe('polygon')
    const draft = draftOf(g, doc)
    expect(draft.nodes.find((n) => n.id === 'n-e')).toMatchObject({
      shape: 'ellipse',
      label: 'Start',
      origin: 'agent'
    })
    expect(draft.nodes.find((n) => n.id === 'n-d')).toMatchObject({
      shape: 'diamond',
      width: 90,
      height: 60,
      origin: 'operator'
    })
  })

  it('operatorNode mints a box by default and a text when asked, both stamped operator', () => {
    const rect = { x: 1, y: 2, width: 160, height: 24 }
    expect(operatorNode(rect, new Set()).shape).toBe('box')
    expect(operatorNode(rect, new Set(), 'hi', 'text')).toMatchObject({
      shape: 'text',
      label: 'hi',
      origin: 'operator'
    })
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

/**
 * A plain blank drag no longer draws (T536 U1: Select is the default tool and
 * the drag belongs to the rubberband). Every test below that drew a box with a
 * plain drag now arms the Rectangle tool first; its assertions are unchanged.
 */
function armRectangle(root: Element): void {
  ;(root.querySelector('[data-testid="diagram-canvas-host"]')!.parentElement as HTMLElement).focus()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
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

    armRectangle(w.element)
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
    armRectangle(w.element)
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
    // Under Rectangle (T536 U1) a sub-threshold drag is still a CLICK, and a
    // click places ONE default-size box — not a floored 48×32 "drawn" one, and
    // not one per jittery pixel.
    const w = mountPane()
    await settle()
    armRectangle(w.element)
    dragOnBlankCanvas(w.element, [200, 200], [202, 201])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()
    await w.find('[data-testid="diagram-save"]').trigger('click')
    await settle()
    const doc = (canvasWrite.mock.calls[0] as unknown as [string, CanvasDocument])[1]
    const boxes = doc.nodes.filter((n) => !['n-a', 'n-b', 'n-c'].includes(n.id))
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).toMatchObject({
      shape: 'box',
      width: DEFAULT_NODE_SIZE.width,
      height: DEFAULT_NODE_SIZE.height
    })
    w.unmount()
  })

  it('U3-6 case B — a disk change while dirty raises the banner and does NOT reload', async () => {
    const w = mountPane()
    await settle()
    expect(canvasRead).toHaveBeenCalledTimes(1)
    armRectangle(w.element)
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

    armRectangle(w.element)
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

  it('T486 AC-27 — pane.close (closeRegion) on a dirty canvas keeps the discard guard', async () => {
    const { closeRegion } = await import('../src/renderer/src/composables/useTerminalFocus')
    const w = mountPane()
    await settle()
    const helpers = (await import('../src/renderer/src/stores/helpers')).useHelpersStore()
    const removed = vi.spyOn(helpers, 'removeHelper')

    armRectangle(w.element)
    dragOnBlankCanvas(w.element, [200, 200], [400, 320])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()

    expect(closeRegion('h-canvas')).toBe(true)
    await settle()
    // Held by the guard: the discard toast decides, not the chord.
    expect(removed).not.toHaveBeenCalled()
    const ui = (await import('../src/renderer/src/stores/ui')).useUiStore()
    expect(ui.toasts.some((t) => t.action)).toBe(true)
    w.unmount()
  })

  it('pressing Close twice leaves ONE warning, not a stack of permanent ones', async () => {
    const w = mountPane()
    await settle()
    armRectangle(w.element)
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
    armRectangle(w.element)
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
    expect(w.text()).toContain('Pick a shape from the toolbar')
    w.unmount()
  })
})

// T486 AC-20 — a Diagram pane beside Roadmap or Review: Esc clears its
// selection first (document capture, stopped), and only the next Esc reaches
// `view.closeTakeover`.
describe('DiagramPane — Esc peels the selection before the takeover', () => {
  it('first Esc clears the selection, the second closes the Roadmap', async () => {
    const harness = mountCloseTakeover()
    const ui = useUiStore()
    ui.openRoadmap('/wt', 'wt')
    const w = mountPane()
    await settle()
    const body = w.find('[data-testid="diagram-canvas-host"]').element.parentElement as HTMLElement
    body.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', ctrlKey: true, bubbles: true }))
    await settle()

    await pressEsc(body)
    await settle()
    expect(ui.activeView?.id).toBe('roadmap')
    // Selection empty now: Delete has nothing to remove, so Save stays absent.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    await settle()
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)

    await pressEsc(body)
    expect(ui.activeView).toBeNull()
    w.unmount()
    harness.unmount()
  })

  it('with nothing selected the first Esc closes the takeover', async () => {
    const harness = mountCloseTakeover()
    const ui = useUiStore()
    ui.openReview('/wt', null)
    const w = mountPane()
    await settle()
    const body = w.find('[data-testid="diagram-canvas-host"]').element.parentElement as HTMLElement
    body.focus()
    await pressEsc(body)
    expect(ui.activeView).toBeNull()
    w.unmount()
    harness.unmount()
  })

  // T536 put a tool ladder in front of the selection (tool → Select → clear):
  // every rung it peels stays in the pane, so the takeover waits for the last Esc.
  it('a drawing tool is peeled back to Select before the takeover closes', async () => {
    const harness = mountCloseTakeover()
    const ui = useUiStore()
    ui.openRoadmap('/wt', 'wt')
    const w = mountPane()
    await settle()
    const body = w.find('[data-testid="diagram-canvas-host"]').element.parentElement as HTMLElement
    body.focus()
    const pressed = (): string[] =>
      w
        .findAll('[data-testid^="canvas-tool-"][aria-pressed="true"]')
        .map((b) => b.attributes('data-testid')!.replace('canvas-tool-', ''))
        .filter((id) => id !== 'lock')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
    await settle()
    expect(pressed()).toEqual(['rectangle'])

    await pressEsc(body)
    await settle()
    expect(pressed()).toEqual(['select'])
    expect(ui.activeView?.id).toBe('roadmap')

    await pressEsc(body)
    expect(ui.activeView).toBeNull()
    w.unmount()
    harness.unmount()
  })
})

describe('an operator edge is minted at z 0 (T536 U4)', () => {
  it('operatorEdgeSpec carries zIndex 0, so X6 never stamps it max + 1', () => {
    expect(operatorEdgeSpec(palette).zIndex).toBe(0)
  })

  it('a port drag adds the new edge at z 0 (the z X6 restores when the drag ends)', async () => {
    // The real X6 path: a mousedown on a port runs `startConnectting` →
    // `createEdgeFromMagnet` → the graph's `connecting.createEdge` hook → `addTo`
    // the model. X6 then lifts the edge to the front for the drag and restores the z
    // it had here on release (`beforeArrowheadDragging` / `afterArrowheadDragging`).
    // jsdom cannot finish the release (the snap search needs layout), so the added z
    // is what is asserted.
    const g = makeGraph()
    const portOf = (): Element | null =>
      g.findViewByCell(g.getCellById('n-a')!)?.container.querySelector('[magnet="true"]') ?? null
    // X6 draws the views in time-sliced jobs: wait (bounded) for the ports to exist.
    const deadline = Date.now() + 2000
    while (!portOf() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    const added: number[] = []
    g.on('edge:added', ({ edge }) => added.push(edge.getZIndex() as number))
    const port = portOf()
    expect(port, 'n-a has no port').not.toBeNull()
    port!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 60, clientY: 40 })
    )
    expect(added).toEqual([0])
    g.dispose()
  })
})

describe('X6 stacking on a fresh render (T536 U4)', () => {
  const STACKED: CanvasDocument = {
    ...DOC,
    nodes: [
      { ...DOC.nodes[0] },
      { ...DOC.nodes[1], zIndex: 5 },
      { ...DOC.nodes[2] },
      { id: 'n-d', shape: 'box', x: 600, y: 40, label: 'D', origin: 'agent', zIndex: 0 }
    ]
  }
  const nodeZ = (g: Graph): Record<string, number> =>
    Object.fromEntries(g.getNodes().map((n) => [n.id, n.getZIndex() as number]))

  it('pins what every earlier build passes: a node without zIndex comes up at CANVAS_LOAD_Z', () => {
    const g = makeGraph(DOC)
    g.clearCells()
    g.fromJSON({
      cells: [
        { id: 'n-a', shape: 'rect', x: 0, y: 0, width: 10, height: 10 },
        { id: 'n-b', shape: 'rect', x: 0, y: 0, width: 10, height: 10, zIndex: 5 },
        { id: 'n-c', shape: 'rect', x: 0, y: 0, width: 10, height: 10 },
        { id: 'n-d', shape: 'rect', x: 0, y: 0, width: 10, height: 10, zIndex: 0 }
      ]
    })
    const z = nodeZ(g)
    expect(z['n-a']).toBe(CANVAS_LOAD_Z)
    expect(z['n-c']).toBe(CANVAS_LOAD_Z)
    expect(g.getNodes().map((n) => n.id)).toEqual(documentStackOrder(STACKED.nodes))
  })

  it('renders every node at a distinct z above the edges, in the document stack order', () => {
    const g = makeGraph(STACKED)
    const expected = renderStackZ(STACKED.nodes)
    expect(nodeZ(g)).toEqual(Object.fromEntries(expected))
    expect(new Set(Object.values(nodeZ(g))).size).toBe(STACKED.nodes.length)
    expect(g.getEdges()[0].getZIndex()).toBe(0)
    expect(g.getNodes().map((n) => n.id)).toEqual(documentStackOrder(STACKED.nodes))
  })

  it('puts a node added afterwards above every other cell', () => {
    const g = makeGraph(STACKED)
    const added = g.addNode({ id: 'n-new', shape: 'rect', x: 0, y: 0, width: 10, height: 10 })
    const others = [...g.getNodes(), ...g.getEdges()].filter((c) => c.id !== 'n-new')
    expect(added.getZIndex() as number).toBeGreaterThan(
      Math.max(...others.map((c) => c.getZIndex() as number))
    )
  })

  it('keeps the file order after a batched restack is undone (the tie trap)', () => {
    // The stack is read off `getCells()`, the collection X6 re-sorts on every z
    // change. `getNodes()` reads an insertion-order cache that never moves on a z
    // change, so an order claim made with it after a restack could not fail.
    const stack = (g: Graph): string[] =>
      g
        .getCells()
        .filter((c) => c.isNode())
        .map((c) => c.id)
    const g = makeGraph(DOC)
    const fileOrder = DOC.nodes.map((n) => n.id)
    expect(stack(g)).toEqual(fileOrder)
    g.startBatch('layer')
    g.getCellById('n-a')!.setZIndex(3)
    g.getCellById('n-b')!.setZIndex(1)
    g.getCellById('n-c')!.setZIndex(2)
    g.stopBatch('layer')
    // The restack really moved the order, so the equality after undo is not trivial.
    expect(stack(g)).toEqual(['n-b', 'n-c', 'n-a'])
    g.undo()
    // Undo restores distinct render z, not ties a stable re-sort would leave as n-b, n-c, n-a.
    expect(stack(g)).toEqual(fileOrder)
  })
})

// Arrow styles (T536 U5). Same shape as the node restyle above: the style lives in
// the edge's `data.props.style`, the line attrs are derived from it, and only the
// `data` write is an undo step.
describe('restyleCanvasEdge — arrow styles (T536 U5)', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 100))
  const styleData = (g: Graph, style: Record<string, unknown> | undefined): void => {
    const edge = g.getCellById('e-1')!
    const { props: _old, ...rest } = edge.getData() as Record<string, unknown>
    void _old
    // Written `silent` where a test wants to run the restyle by hand.
    edge.setData(style === undefined ? rest : { ...rest, props: { style } }, { overwrite: true })
  }
  const linePath = (g: Graph): Element =>
    g.findViewByCell(g.getCellById('e-1')!)!.container.querySelector('[stroke-width="1.5"]')!

  it('re-derives the line from the edge data and keeps the class defaults (Review Focus 2)', () => {
    const g = makeGraph()
    const edge = g.getCellById('e-1') as never as import('@antv/x6').Edge
    const defaults = (Shape.Edge.getDefaults().attrs ?? {}) as Record<string, never>
    // X6's Edge puts `connection: true` on the `lines` group, which both the visible
    // `line` and the hit-path `wrap` belong to: lose it and the arrow stops following its route.
    expect(edge.attr('lines/connection')).toBe(true)
    styleData(g, { tone: 'red' })
    restyleCanvasEdge(edge, palette)
    expect(edge.attr('line/stroke')).toBe(palette.red)
    expect(edge.attr('lines')).toEqual(defaults.lines)
    expect(edge.attr('lines/connection')).toBe(true)
    // The wide transparent hit path survives: it is what makes a 1.5px line clickable.
    expect(edge.attr('wrap')).toEqual(defaults.wrap)
    expect(edge.attr('wrap/strokeWidth')).toBe(10)
    expect(edge.attr('line/strokeWidth')).toBe(1.5)
    expect(edge.attr('line/targetMarker')).toEqual({ name: 'block', width: 8, height: 6 })
    g.dispose()
  })

  it('draws the same attrs a fresh render of that style gives the arrow', () => {
    const style = { tone: 'amber', stroke: 'dotted' }
    const styledDoc: CanvasDocument = {
      ...DOC,
      edges: [{ ...DOC.edges[0], props: { style } }]
    }
    const g = makeGraph()
    const fresh = makeGraph(styledDoc)
    const edge = g.getCellById('e-1') as never as import('@antv/x6').Edge
    styleData(g, style)
    restyleCanvasEdge(edge, palette)
    expect(edge.getAttrs()).toEqual(fresh.getCellById('e-1')!.getAttrs())
    g.dispose()
    fresh.dispose()
  })

  it('removes the dasharray from the rendered path after a reset to solid', async () => {
    const g = makeGraph()
    const edge = g.getCellById('e-1') as never as import('@antv/x6').Edge
    styleData(g, { stroke: 'dashed' })
    restyleCanvasEdge(edge, palette)
    await settle()
    expect(linePath(g).getAttribute('stroke-dasharray')).toBe('6 4')
    styleData(g, undefined)
    restyleCanvasEdge(edge, palette)
    await settle()
    expect(linePath(g).hasAttribute('stroke-dasharray')).toBe(false)
    expect(linePath(g).getAttribute('stroke')).toBe(palette.accent)
    g.dispose()
  })

  it('keeps the data write in history and drops the restyle', () => {
    const g = makeGraph()
    g.cleanHistory()
    const edge = g.getCellById('e-1') as never as import('@antv/x6').Edge
    styleData(g, { tone: 'green' })
    restyleCanvasEdge(edge, palette)
    expect(g.canUndo()).toBe(true)
    g.undo()
    // The one undo step was the data write; the restyle left nothing behind it.
    expect(g.canUndo()).toBe(false)
    expect(g.canRedo()).toBe(true)
    expect((edge.getData() as { props?: unknown }).props).toBeUndefined()
    // A derived write neither records nor empties the redo stack.
    restyleCanvasEdge(edge, palette)
    expect(g.canRedo()).toBe(true)
    expect(g.canUndo()).toBe(false)
    expect(edge.attr('line/stroke')).toBe(palette.accent)
    g.dispose()
  })

  it('repaints in the palette in force now, not the one the style was written in', () => {
    const g = makeGraph()
    const edge = g.getCellById('e-1') as never as import('@antv/x6').Edge
    styleData(g, { tone: 'green' })
    restyleCanvasEdge(edge, palette)
    const other = { ...palette, green: '#0a0b0c' }
    restyleCanvasEdge(edge, other)
    expect(edge.attr('line/stroke')).toBe('#0a0b0c')
    g.dispose()
  })

  it('leaves the label, router and endpoints alone', () => {
    const g = makeGraph()
    const edge = g.getCellById('e-1') as never as import('@antv/x6').Edge
    const before = JSON.stringify([edge.getLabels(), edge.getRouter(), edge.getSource()])
    styleData(g, { tone: 'red', stroke: 'dashed' })
    restyleCanvasEdge(edge, palette)
    expect(JSON.stringify([edge.getLabels(), edge.getRouter(), edge.getSource()])).toBe(before)
    g.dispose()
  })

  it('a clicked arrow joins the selection and shows the selection box', () => {
    const g = makeGraph()
    const edge = g.getCellById('e-1')!
    const selection = g.getPlugin('selection') as unknown as { options: Record<string, unknown> }
    expect(selection.options.showEdgeSelectionBox).toBe(true)
    expect(selection.options.showNodeSelectionBox).toBe(true)
    // The plugin's own click handler, driven the way X6 does on a cell mouseup.
    g.trigger('cell:mouseup', { e: new MouseEvent('mouseup'), cell: edge })
    expect(g.getSelectedCells().map((c) => c.id)).toEqual(['e-1'])
    // The view container carries data-cell-id too, so the box is picked by its own class.
    expect(g.container.querySelector('.x6-widget-selection-box[data-cell-id="e-1"]')).not.toBeNull()
    g.dispose()
  })
})
