import { describe, it, expect } from 'vitest'
import {
  CANVAS_PORT_IDS,
  DEFAULT_DIAMOND_SIZE,
  DEFAULT_ELLIPSE_SIZE,
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
  accentSoft: '#accentSoft',
  green: '#green',
  greenSoft: '#greenSoft',
  warning: '#warning',
  warningSoft: '#warningSoft',
  red: '#red',
  redSoft: '#redSoft',
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
    expect(attrs.body.fill).toBe('transparent')
    expect(attrs.body.stroke).toBe('none')
    expect(attrs.label.fill).toBe(PALETTE.text2)
  })

  it('a text node keeps a transparent full-frame hit area, so a press anywhere in its frame hits it (X4b)', () => {
    // SVG hit-tests a shape only where its fill is painted: `fill: none` lets a
    // press at the centre of a left/right aligned label fall through to the board.
    // `transparent` is painted for hit-testing and invisible on screen.
    for (const style of [undefined, { align: 'left' }, { align: 'right', fontSize: 's' }]) {
      const cell = toX6Node(
        node({ shape: 'text', width: 132, height: 40, ...(style ? { props: { style } } : {}) }),
        PALETTE
      )
      const body = (cell.attrs as Record<string, Record<string, unknown>>).body
      // The X6 rect's body spans the whole node (its class default refWidth/refHeight
      // 100%); nothing here shrinks it.
      expect(cell.shape).toBe('rect')
      expect(body).not.toHaveProperty('width')
      expect(body).not.toHaveProperty('height')
      expect(body).not.toHaveProperty('refWidth')
      expect(body).not.toHaveProperty('refHeight')
      expect(body).not.toHaveProperty('pointerEvents')
      // Hit-testable, yet nothing visible: no colour, no outline.
      expect(body.fill).toBe('transparent')
      expect(body.stroke).toBe('none')
      expect(body).not.toHaveProperty('fillOpacity')
    }
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

describe('toX6Node — ellipse and diamond (T536 U2)', () => {
  const DIAMOND_POINTS = '0.5,0 1,0.5 0.5,1 0,0.5'

  /** Every port group sits on its own side: top/right/bottom/left (spec §6 vertex ports). */
  function expectSidePorts(cell: Record<string, unknown>): void {
    const ports = cell.ports as { groups: Record<string, { position: string }> }
    expect(Object.keys(ports.groups)).toEqual(['top', 'right', 'bottom', 'left'])
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(ports.groups[side].position).toBe(side)
    }
  }

  it('exports the default footprints', () => {
    expect(DEFAULT_ELLIPSE_SIZE).toEqual({ width: 132, height: 64 })
    expect(DEFAULT_DIAMOND_SIZE).toEqual({ width: 132, height: 80 })
  })

  it('an ellipse is an X6 ellipse stamped kind ellipse, framed like a box', () => {
    const cell = toX6Node(node({ shape: 'ellipse', label: 'Start' }), PALETTE)
    expect(cell.shape).toBe('ellipse')
    expect((cell.data as { kind: string }).kind).toBe('ellipse')
    expect(cell.width).toBe(DEFAULT_ELLIPSE_SIZE.width)
    expect(cell.height).toBe(DEFAULT_ELLIPSE_SIZE.height)
    const ports = cell.ports as { items: Array<{ id: string }> }
    expect(ports.items.map((p) => p.id)).toEqual([...CANVAS_PORT_IDS])
    expectSidePorts(cell)
    const attrs = cell.attrs as Record<string, Record<string, unknown>>
    expect(attrs.body.fill).toBe(PALETTE.surface)
    expect(attrs.body.stroke).toBe(PALETTE.border2)
    expect(attrs.body.strokeDasharray).toBeUndefined()
    expect(attrs.body.rx).toBeUndefined()
    expect(attrs.text.text).toBe('Start')
    expect(attrs.label.text).toBe('Start')
  })

  it('a diamond is an X6 polygon on the four midpoints, framed like a box', () => {
    const cell = toX6Node(node({ shape: 'diamond', label: 'Ok?' }), PALETTE)
    expect(cell.shape).toBe('polygon')
    expect((cell.data as { kind: string }).kind).toBe('diamond')
    expect(cell.width).toBe(DEFAULT_DIAMOND_SIZE.width)
    expect(cell.height).toBe(DEFAULT_DIAMOND_SIZE.height)
    const ports = cell.ports as { items: Array<{ id: string }> }
    expect(ports.items.map((p) => p.id)).toEqual([...CANVAS_PORT_IDS])
    expectSidePorts(cell)
    const attrs = cell.attrs as Record<string, Record<string, unknown>>
    expect(attrs.body.refPoints).toBe(DIAMOND_POINTS)
    expect(attrs.body.fill).toBe(PALETTE.surface)
    expect(attrs.body.stroke).toBe(PALETTE.border2)
    expect(attrs.body.strokeDasharray).toBeUndefined()
    expect(attrs.body.rx).toBeUndefined()
    expect(attrs.text.text).toBe('Ok?')
    expect(attrs.label.text).toBe('Ok?')
  })

  it('a small diamond still carries its label attrs on both paths', () => {
    const cell = toX6Node(node({ shape: 'diamond', width: 48, height: 32, label: 'x' }), PALETTE)
    expect(cell.width).toBe(48)
    expect(cell.height).toBe(32)
    const attrs = cell.attrs as Record<string, Record<string, unknown>>
    expect(attrs.text).toMatchObject({ text: 'x', fill: PALETTE.text })
    expect(attrs.label).toMatchObject({ text: 'x', fill: PALETTE.text })
  })

  it('an unknown shape still falls back to a DASHED box (§3 C2)', () => {
    const cell = toX6Node(node({ shape: 'hexagon' }), PALETTE)
    expect(cell.shape).toBe('rect')
    const attrs = cell.attrs as Record<string, Record<string, unknown>>
    expect(attrs.body.strokeDasharray).toBe('4 3')
  })

  it('both bodies take their stroke and fill from the palette they were rendered with', () => {
    const other: CanvasPalette = {
      ...PALETTE,
      border2: '#other-border2',
      surface: '#other-surface'
    }
    for (const shape of ['ellipse', 'diamond']) {
      const a = toX6Node(node({ shape }), PALETTE).attrs as Record<string, Record<string, unknown>>
      const b = toX6Node(node({ shape }), other).attrs as Record<string, Record<string, unknown>>
      expect(a.body.stroke).toBe('#border2')
      expect(b.body.stroke).toBe('#other-border2')
      expect(b.body.fill).toBe('#other-surface')
    }
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

describe('toX6Node — node styles (T536 U3)', () => {
  type Attrs = Record<string, Record<string, unknown>>
  const attrsOf = (n: CanvasNode, palette: CanvasPalette = PALETTE): Attrs =>
    toX6Node(n, palette).attrs as Attrs
  const styled = (style: unknown, over: Partial<CanvasNode> = {}): CanvasNode =>
    node({ props: { style: style as Record<string, unknown> }, ...over })

  it('tone green: stroke and fill from the green pair, the label stays --text', () => {
    const a = attrsOf(styled({ tone: 'green' }))
    expect(a.body.stroke).toBe('#green')
    expect(a.body.fill).toBe('#greenSoft')
    expect(a.text.fill).toBe('#text')
    expect(a.label.fill).toBe('#text')
  })

  it('tone muted: --border / --bg / --text-3', () => {
    const a = attrsOf(styled({ tone: 'muted' }))
    expect(a.body.stroke).toBe('#border')
    expect(a.body.fill).toBe('#bg')
    expect(a.text.fill).toBe('#text3')
    expect(a.label.fill).toBe('#text3')
  })

  it('stroke style maps to a dasharray; solid adds none', () => {
    expect(attrsOf(styled({ stroke: 'dashed' })).body.strokeDasharray).toBe('6 4')
    expect(attrsOf(styled({ stroke: 'dotted' })).body.strokeDasharray).toBe('2 3')
    expect(attrsOf(styled({ stroke: 'solid' })).body).not.toHaveProperty('strokeDasharray')
  })

  it('strokeWidth maps to 1 / 1.5 / 2.5', () => {
    expect(attrsOf(styled({ strokeWidth: 'thin' })).body.strokeWidth).toBe(1)
    expect(attrsOf(styled({ strokeWidth: 'regular' })).body.strokeWidth).toBe(1.5)
    expect(attrsOf(styled({ strokeWidth: 'bold' })).body.strokeWidth).toBe(2.5)
  })

  it('corners sharp zeroes the radius on a box; an ellipse never gets one', () => {
    const box = attrsOf(styled({ corners: 'sharp' }))
    expect(box.body.rx).toBe(0)
    expect(box.body.ry).toBe(0)
    expect(attrsOf(styled({ corners: 'sharp' }, { shape: 'ellipse' })).body).not.toHaveProperty(
      'rx'
    )
    expect(attrsOf(styled({ corners: 'round' })).body.rx).toBe(7)
  })

  it('fontSize reaches BOTH label attribute paths', () => {
    for (const n of [styled({ fontSize: 'xl' }), styled({ fontSize: 'xl' }, { shape: 'text' })]) {
      const a = attrsOf(n)
      expect(a.text.fontSize).toBe(20)
      expect(a.label.fontSize).toBe(20)
    }
    expect(attrsOf(styled({ fontSize: 's' })).text.fontSize).toBe(11)
    expect(attrsOf(styled({ fontSize: 'l' })).text.fontSize).toBe(15)
  })

  it('align left anchors the text at the start with an 8px inset, on both paths', () => {
    for (const shape of ['box', 'ellipse', 'text']) {
      const a = attrsOf(styled({ align: 'left' }, { shape }))
      for (const path of ['text', 'label']) {
        expect(a[path].textAnchor, `${shape}.${path}`).toBe('start')
        expect(a[path].refX, `${shape}.${path}`).toBe('0%')
        expect(a[path].refX2, `${shape}.${path}`).toBe(8)
      }
    }
  })

  it('align right anchors at the end, inset from the far edge', () => {
    const a = attrsOf(styled({ align: 'right' }))
    for (const path of ['text', 'label']) {
      expect(a[path].textAnchor).toBe('end')
      expect(a[path].refX).toBe('100%')
      expect(a[path].refX2).toBe(-8)
    }
  })

  // Live matrix (T536 U3, row S4): 8px from the bounding box is where a diamond is a
  // point, so a left/right label poked past its slanted edges at every size. A diamond
  // aligns to its inscribed box instead: a quarter of the width in, where the frame is
  // half its height tall.
  it('a diamond aligns left/right to its inscribed box, a quarter of the width in', () => {
    const left = attrsOf(styled({ align: 'left' }, { shape: 'diamond' }))
    const right = attrsOf(styled({ align: 'right' }, { shape: 'diamond' }))
    for (const path of ['text', 'label']) {
      expect(left[path].textAnchor, path).toBe('start')
      expect(left[path].refX, path).toBe('25%')
      expect(left[path].refX2 ?? 0, path).toBe(0)
      expect(right[path].textAnchor, path).toBe('end')
      expect(right[path].refX, path).toBe('75%')
      expect(right[path].refX2 ?? 0, path).toBe(0)
    }
  })

  it('align center adds nothing', () => {
    const a = attrsOf(styled({ align: 'center' }))
    expect(a.text).not.toHaveProperty('textAnchor')
    expect(a.text).not.toHaveProperty('refX')
  })

  it('opacity lands on the body and both label paths', () => {
    const a = attrsOf(styled({ opacity: 50 }))
    expect(a.body.opacity).toBe(0.5)
    expect(a.text.opacity).toBe(0.5)
    expect(a.label.opacity).toBe(0.5)
    expect(attrsOf(styled({ opacity: 100 })).body).not.toHaveProperty('opacity')
  })

  it('opacity on a resolved image lands on the picture and its caption', () => {
    const cell = toX6Node(
      styled(
        { opacity: 25 },
        { shape: 'image', props: { src: 'assets/a.png', style: { opacity: 25 } } }
      ),
      PALETTE,
      { 'assets/a.png': 'data:image/png;base64,AA' }
    )
    const a = cell.attrs as Attrs
    expect(a.image.opacity).toBe(0.25)
    expect(a.label.opacity).toBe(0.25)
  })

  it('an image ignores every style key but opacity', () => {
    const src = 'assets/a.png'
    const images = { [src]: 'data:image/png;base64,AA' }
    const plain = toX6Node(node({ shape: 'image', props: { src } }), PALETTE, images)
    const noisy = toX6Node(
      node({
        shape: 'image',
        props: { src, style: { tone: 'red', align: 'left', fontSize: 'xl' } }
      }),
      PALETTE,
      images
    )
    expect(noisy.attrs).toEqual(plain.attrs)
  })

  it('a text node: tone colours the label, the body stays invisible', () => {
    const a = attrsOf(styled({ tone: 'red' }, { shape: 'text' }))
    expect(a.text.fill).toBe('#red')
    expect(a.label.fill).toBe('#red')
    expect(a.body).toEqual({ fill: 'transparent', stroke: 'none' })
  })

  it('a text node with no tone keeps --text-2', () => {
    expect(attrsOf(styled({ fontSize: 'l' }, { shape: 'text' })).text.fill).toBe('#text2')
  })

  it('an ellipse and a diamond take tone and stroke too', () => {
    for (const shape of ['ellipse', 'diamond']) {
      const a = attrsOf(styled({ tone: 'amber', stroke: 'dashed' }, { shape }))
      expect(a.body.stroke).toBe('#warning')
      expect(a.body.fill).toBe('#warningSoft')
      expect(a.body.strokeDasharray).toBe('6 4')
    }
  })

  it('the mockup card ignores a style entirely', () => {
    const plain = toX6Node(node({ shape: 'harnu/mockup-card' }), PALETTE)
    const withStyle = toX6Node(
      styled({ tone: 'green', opacity: 25, fontSize: 'xl' }, { shape: 'harnu/mockup-card' }),
      PALETTE
    )
    expect(withStyle.attrs).toEqual(plain.attrs)
  })

  it('an unknown kind keeps its dashed fallback and ignores the style', () => {
    const a = attrsOf(styled({ tone: 'green', stroke: 'dotted' }, { shape: 'hexagon' }))
    expect(a.body.stroke).toBe('#border2')
    expect(a.body.strokeDasharray).toBe('4 3')
  })

  it('REVIEW FOCUS 3: unknown values and a non-object style render exactly like no style', () => {
    for (const shape of ['box', 'ellipse', 'diamond', 'text', 'image']) {
      const plain = toX6Node(node({ shape, props: { src: 'assets/a.png' } }), PALETTE)
      for (const style of [{ tone: 'purple', fontSize: 40 }, 'red', null, ['tone'], 7]) {
        const odd = toX6Node(
          node({ shape, props: { src: 'assets/a.png', style: style as never } }),
          PALETTE
        )
        expect(odd.attrs, `${shape} ${JSON.stringify(style)}`).toEqual(plain.attrs)
        expect(odd.shape).toBe(plain.shape)
      }
    }
  })

  it('an explicit default-valued style renders like no style', () => {
    const plain = attrsOf(node())
    const explicit = attrsOf(
      styled({
        tone: 'default',
        stroke: 'solid',
        strokeWidth: 'regular',
        corners: 'round',
        fontSize: 'm',
        align: 'center',
        opacity: 100
      })
    )
    expect(explicit).toEqual(plain)
  })

  it('the style never leaks into the cell data beyond the props the document carried', () => {
    const cell = toX6Node(styled({ tone: 'green' }), PALETTE)
    expect(cell.data).toMatchObject({ props: { style: { tone: 'green' } } })
    expect(cell.ports).toBeDefined()
  })

  it('is re-resolved per palette: a theme switch recolours a styled node', () => {
    const other: CanvasPalette = { ...PALETTE, green: '#other-green' }
    expect(attrsOf(styled({ tone: 'green' })).body.stroke).toBe('#green')
    expect(attrsOf(styled({ tone: 'green' }), other).body.stroke).toBe('#other-green')
  })
})
