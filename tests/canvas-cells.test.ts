import { describe, it, expect } from 'vitest'
import {
  DEFAULT_IMAGE_SIZE,
  DEFAULT_NODE_SIZE,
  DEFAULT_TEXT_SIZE,
  canvasImageSources,
  toX6Cells,
  toX6Edge,
  toX6Node
} from '../src/renderer/src/components/canvas/canvas-cells'
import type { CanvasPalette } from '../src/renderer/src/components/canvas/canvas-theme'
import type { CanvasDocument, CanvasNode } from '../src/main/canvas-core'

/**
 * PURE mapping contract for the T218 U2 canvas pane: a validated canvas
 * document becomes X6 cell specs, coloured only from the resolved §9 palette.
 * No DOM and no X6 here — that is the point of keeping the mapping pure, and it
 * is what lets the render path be asserted without a graph.
 */
const PALETTE: CanvasPalette = {
  bg: '#bg',
  surface: '#surface',
  border: '#border',
  border2: '#border2',
  text: '#text',
  text2: '#text2',
  text3: '#text3',
  accent: '#accent',
  fontSans: 'TestSans'
}

function node(over: Partial<CanvasNode> = {}): CanvasNode {
  return { id: 'n1', shape: 'box', x: 10, y: 20, origin: 'agent', ...over }
}

describe('toX6Node — labels', () => {
  it('writes the normalized label to BOTH X6 attribute paths (§4.5, spike trap 3)', () => {
    const cell = toX6Node(node({ label: 'Renamed' }), PALETTE) as Record<string, never>
    const attrs = cell.attrs as unknown as Record<string, { text: string }>
    // Setting only one path is how the stale-label bug is born: a reader that
    // picks the other reports the name the node had BEFORE the rename.
    expect(attrs.text.text).toBe('Renamed')
    expect(attrs.label.text).toBe('Renamed')
  })

  it('an absent label becomes an empty string on both paths, never undefined', () => {
    const cell = toX6Node(node(), PALETTE) as Record<string, never>
    const attrs = cell.attrs as unknown as Record<string, { text: string }>
    expect(attrs.text.text).toBe('')
    expect(attrs.label.text).toBe('')
  })
})

describe('toX6Node — sizing and provenance', () => {
  it('falls back to the default box size when the document omits one', () => {
    const cell = toX6Node(node(), PALETTE)
    expect(cell.width).toBe(DEFAULT_NODE_SIZE.width)
    expect(cell.height).toBe(DEFAULT_NODE_SIZE.height)
  })

  it('a text node gets the bare-label default size, not the box one', () => {
    const cell = toX6Node(node({ shape: 'text' }), PALETTE)
    expect(cell.width).toBe(DEFAULT_TEXT_SIZE.width)
    expect(cell.height).toBe(DEFAULT_TEXT_SIZE.height)
  })

  it('an explicit size always wins over the default', () => {
    const cell = toX6Node(node({ width: 300, height: 90 }), PALETTE)
    expect(cell.width).toBe(300)
    expect(cell.height).toBe(90)
  })

  it('carries the origin stamp into the cell data (§4.4)', () => {
    // Creation provenance must survive the trip through the graph, or U3's
    // round-trip erases "what did the human contribute".
    expect(
      (toX6Node(node({ origin: 'operator' }), PALETTE).data as { origin: string }).origin
    ).toBe('operator')
  })
})

describe('toX6Node — colours come only from the palette', () => {
  it('a box body uses the surface/border-2 tokens', () => {
    const attrs = toX6Node(node(), PALETTE).attrs as Record<string, Record<string, unknown>>
    expect(attrs.body.fill).toBe(PALETTE.surface)
    expect(attrs.body.stroke).toBe(PALETTE.border2)
    expect(attrs.label.fill).toBe(PALETTE.text)
    expect(attrs.label.fontFamily).toBe(PALETTE.fontSans)
  })

  it('a text node has no frame and uses the softer text token', () => {
    const attrs = toX6Node(node({ shape: 'text' }), PALETTE).attrs as Record<
      string,
      Record<string, unknown>
    >
    expect(attrs.body.fill).toBe('none')
    expect(attrs.body.stroke).toBe('none')
    expect(attrs.label.fill).toBe(PALETTE.text2)
  })

  it('every emitted colour is a palette value — no raw hex leaks from the mapper (U2-3)', () => {
    const doc: CanvasDocument = {
      capycanvas: 1,
      meta: {},
      nodes: [node({ label: 'a' }), node({ id: 'n2', shape: 'text', label: 'b' })],
      edges: []
    }
    const allowed = new Set<string>([...Object.values(PALETTE), 'none'])
    const serialized = JSON.stringify(toX6Cells(doc, PALETTE))
    // Anything that looks like a CSS hex/rgb literal in the output would be a
    // colour the mapper invented instead of reading from the theme.
    const literals = serialized.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? []
    for (const lit of literals) expect(allowed.has(lit)).toBe(true)
  })
})

describe('toX6Node — shapes this unit does not draw', () => {
  it('falls back to a box for an UNREGISTERED harnu/ shape name instead of throwing', () => {
    // `graph.addNode({ shape: 'harnu/foo' })` throws on an unregistered name, so
    // an agent-written shape from a newer Harnu would take the pane down.
    //
    // This used to be asserted with `harnu/mockup-card`, which U7 registers —
    // so the case moved to a name no build has ever shipped. The property under
    // test was never "the mockup card is a box"; it was "a shape THIS build
    // does not know still opens the board".
    const cell = toX6Node(node({ shape: 'harnu/from-the-future', label: 'Mockup' }), PALETTE)
    expect(cell.shape).toBe('rect')
    const attrs = cell.attrs as Record<string, Record<string, unknown>>
    // Marked as "not drawn as written" rather than silently pretending.
    expect(attrs.body.strokeDasharray).toBe('4 3')
  })

  it('a plain box carries no dash — the marker means something', () => {
    const attrs = toX6Node(node(), PALETTE).attrs as Record<string, Record<string, unknown>>
    expect(attrs.body.strokeDasharray).toBeUndefined()
  })
})

describe('toX6Node — image nodes', () => {
  const imageNode = node({ shape: 'image', label: 'Screenshot', props: { src: 'assets/a-1.png' } })

  it('renders the resolved data: URL when the asset was read', () => {
    const cell = toX6Node(imageNode, PALETTE, { 'assets/a-1.png': 'data:image/png;base64,AA' })
    expect(cell.shape).toBe('image')
    expect(cell.imageUrl).toBe('data:image/png;base64,AA')
  })

  it('an unresolvable asset renders a labelled placeholder at the real footprint', () => {
    const cell = toX6Node(imageNode, PALETTE)
    expect(cell.shape).toBe('rect')
    // The IMAGE fallback, not the box one (T218 U7): the manifest sizes an
    // un-sized image node 240x160 and the pane used to draw it 132x52, so the
    // same document rendered at two sizes depending on who wrote it.
    expect(cell.width).toBe(DEFAULT_IMAGE_SIZE.width)
    expect(cell.height).toBe(DEFAULT_IMAGE_SIZE.height)
    const attrs = cell.attrs as Record<string, Record<string, unknown>>
    expect(attrs.label.text).toBe('Screenshot')
  })

  it('canvasImageSources lists every image src once, in document order', () => {
    const doc: CanvasDocument = {
      capycanvas: 1,
      meta: {},
      nodes: [
        imageNode,
        node({ id: 'n2', shape: 'image', props: { src: 'assets/b-2.png' } }),
        node({ id: 'n3', shape: 'image', props: { src: 'assets/a-1.png' } }),
        node({ id: 'n4' })
      ],
      edges: []
    }
    expect(canvasImageSources(doc)).toEqual(['assets/a-1.png', 'assets/b-2.png'])
  })
})

describe('toX6Edge', () => {
  const edge = { id: 'e1', source: 'n1', target: 'n2', origin: 'agent' as const }

  it('defaults to a manhattan router with the accent line token', () => {
    const cell = toX6Edge(edge, PALETTE)
    expect(cell.router).toEqual({ name: 'manhattan' })
    const attrs = cell.attrs as Record<string, Record<string, unknown>>
    expect(attrs.line.stroke).toBe(PALETTE.accent)
  })

  it("honours the document's own router when it names one", () => {
    expect(toX6Edge({ ...edge, router: 'orth' }, PALETTE).router).toEqual({ name: 'orth' })
  })

  it('derives the X6 labels[] array from the document label — the document stays the author', () => {
    // Carried finding from U1: `canvas-core.ts` reads an edge label from
    // `raw.label`, while X6 stores it in a differently-shaped `labels[]`. As
    // long as `labels[]` is DERIVED here and X6 never writes back (U2 is
    // read-only), the stale-label trap cannot reopen on edges.
    const cell = toX6Edge({ ...edge, label: 'reads' }, PALETTE)
    const labels = cell.labels as Array<{ attrs: { text: { text: string } } }>
    expect(labels).toHaveLength(1)
    expect(labels[0].attrs.text.text).toBe('reads')
  })

  it('emits no labels[] at all when the edge has no label', () => {
    expect(toX6Edge(edge, PALETTE).labels).toBeUndefined()
  })

  it('carries the origin stamp (§4.4)', () => {
    expect((toX6Edge(edge, PALETTE).data as { origin: string }).origin).toBe('agent')
  })
})

describe('toX6Cells', () => {
  it('emits every node and edge, nodes first', () => {
    const doc: CanvasDocument = {
      capycanvas: 1,
      meta: {},
      nodes: [node({ id: 'n1' }), node({ id: 'n2', x: 300 })],
      edges: [{ id: 'e1', source: 'n1', target: 'n2', origin: 'operator' }]
    }
    const { cells } = toX6Cells(doc, PALETTE)
    expect(cells.map((c) => c.id)).toEqual(['n1', 'n2', 'e1'])
  })

  it('an empty document emits no cells', () => {
    expect(toX6Cells({ capycanvas: 1, meta: {}, nodes: [], edges: [] }, PALETTE).cells).toEqual([])
  })
})
