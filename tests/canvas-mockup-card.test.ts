// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { Graph } from '@antv/x6'
import {
  createCanvasGraph,
  registerCanvasHtmlShapes,
  renderCanvasDocument
} from '../src/renderer/src/components/canvas/canvas-graph'
import { toX6Node } from '../src/renderer/src/components/canvas/canvas-cells'
import { buildCanvasDocumentFromCells } from '../src/renderer/src/components/canvas/canvas-edit'
import { readCanvasPalette } from '../src/renderer/src/components/canvas/canvas-theme'
import {
  MOCKUP_CARD_DEFAULT_SIZE,
  MOCKUP_CARD_SHAPE,
  buildMockupCardElement,
  mockupCardFields,
  mockupCardTone
} from '../src/renderer/src/components/canvas/shapes/mockup-card'
import { validateCanvasDocument, type CanvasDocument } from '../src/main/canvas-core'
import { installJsdomSvgShim, svgHost } from './helpers/jsdom-svg'

installJsdomSvgShim()

/**
 * T218 U7 — the registered HTML component (`harnu/mockup-card`), spec §5.2.
 *
 * U5 shipped the shape in the verb's catalog and validated its props; NOTHING
 * read them. `canvas-cells.ts`'s `BUILTIN_KINDS` was `['box','text','image']`
 * and everything else fell through to a dashed box. This file is the proof that
 * the props now reach a component, and — the part that matters more — that
 * there is still no path by which agent-written MARKUP could reach the DOM.
 *
 * The graph tests run against a REAL `Graph` under the jsdom SVG shim, not a
 * stub: `Shape.HTML.register` is X6 API and "the card is in the same document,
 * not an iframe" is a claim about X6's `foreignObject`, so a mock would assert
 * our own mock.
 */

const PALETTE = readCanvasPalette()

function cardNode(over: Record<string, unknown> = {}): CanvasDocument['nodes'][number] {
  return {
    id: 'n-card',
    shape: MOCKUP_CARD_SHAPE,
    x: 40,
    y: 40,
    width: 260,
    height: 160,
    origin: 'agent',
    props: { title: 'Sidebar', subtitle: 'Folder rows', status: 'done', body: 'Two zones.' },
    ...over
  } as CanvasDocument['nodes'][number]
}

function docWith(node: CanvasDocument['nodes'][number]): CanvasDocument {
  return { capycanvas: 1, meta: { title: 'Deliverables' }, nodes: [node], edges: [] }
}

/**
 * Render, then WAIT for X6 to have drawn.
 *
 * `Graph`'s `async` option defaults to TRUE, so `fromJSON` only queues the
 * views — the SVG stage is still empty when the call returns, and asserting on
 * the DOM straight after it reads "the component did not render" for a graph
 * that simply has not painted yet. `render:done` is X6's own signal that the
 * job queue drained; the timeout is a floor so a genuine failure fails the
 * assertion below rather than hanging the suite.
 */
async function renderAndSettle(
  graph: Graph,
  doc: CanvasDocument,
  images: Record<string, string> = {}
): Promise<void> {
  renderCanvasDocument(graph, doc, PALETTE, images)
  await new Promise<void>((resolve) => {
    graph.once('render:done', () => resolve())
    setTimeout(resolve, 1000)
  })
}

// ------------------------------------------------------- the pure card model ---

describe('mockupCardFields — props → the four fields', () => {
  it('reads the four declared props', () => {
    expect(mockupCardFields({ title: 'T', subtitle: 'S', status: 'wip', body: 'B' })).toEqual({
      title: 'T',
      subtitle: 'S',
      status: 'wip',
      body: 'B'
    })
  })

  it('falls back to the node label for the title (design.md §6)', () => {
    // A card written with only a label still reads as a card — and this is why
    // X6's own SVG label is hidden rather than drawn beside it.
    expect(mockupCardFields({ body: 'B' }, 'From the label').title).toBe('From the label')
  })

  it('an explicit title beats the label', () => {
    expect(mockupCardFields({ title: 'Prop wins' }, 'label').title).toBe('Prop wins')
  })

  it('a non-string prop renders as nothing, never as "[object Object]"', () => {
    // §4.3 already guarantees `props` is plain JSON, so this is about a number
    // or an array — not a DOM node getting in.
    expect(mockupCardFields({ title: 7, body: ['a'] })).toEqual({
      title: '',
      subtitle: '',
      status: '',
      body: ''
    })
  })

  it('missing props are empty strings, and props being absent entirely is fine', () => {
    expect(mockupCardFields(undefined)).toEqual({ title: '', subtitle: '', status: '', body: '' })
  })
})

describe('mockupCardTone', () => {
  it('maps the known words, case- and separator-insensitively', () => {
    expect(mockupCardTone('Done')).toBe('green')
    expect(mockupCardTone('In Progress')).toBe('warning')
    expect(mockupCardTone('in-progress')).toBe('warning')
    expect(mockupCardTone('  BLOCKED ')).toBe('red')
  })

  it('an unrecognized status is neutral, never dropped', () => {
    // The manifest declares the KEY, not a vocabulary. Refusing or hiding a
    // word we do not know would make the pane lie about what the file says.
    expect(mockupCardTone('needs a decision')).toBe('neutral')
    expect(mockupCardTone('')).toBe('neutral')
  })
})

describe('buildMockupCardElement — every string arrives as TEXT', () => {
  it('renders the four fields into class-styled elements', () => {
    const el = buildMockupCardElement(
      mockupCardFields({ title: 'T', subtitle: 'S', status: 'done', body: 'B' })
    )
    expect(el.className).toBe('canvas-mockup-card')
    expect(el.querySelector('.canvas-mockup-card__title')?.textContent).toBe('T')
    expect(el.querySelector('.canvas-mockup-card__subtitle')?.textContent).toBe('S')
    expect(el.querySelector('.canvas-mockup-card__body')?.textContent).toBe('B')
    const pill = el.querySelector('.canvas-mockup-card__status')
    expect(pill?.textContent).toBe('done')
    expect(pill?.className).toContain('canvas-mockup-card__status--green')
  })

  it('an absent prop yields NO element rather than an empty row', () => {
    const el = buildMockupCardElement(mockupCardFields({ title: 'Only a title' }))
    expect(el.querySelector('.canvas-mockup-card__subtitle')).toBeNull()
    expect(el.querySelector('.canvas-mockup-card__body')).toBeNull()
    expect(el.querySelector('.canvas-mockup-card__status')).toBeNull()
  })

  it('markup inside a prop stays CHARACTERS — no element is created (U7-4)', () => {
    // `props.body` is agent-written prose and may legitimately contain `<`.
    // Rendered through `textContent` it is text; through `innerHTML` it would
    // be a hole. This is the renderer half of §5.2's security argument — the
    // file half is asserted in `mcp-draw-canvas-handler.test.ts`.
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>'
    const el = buildMockupCardElement(
      mockupCardFields({ title: '<b>bold</b>', body: hostile, status: '<i>x</i>' })
    )
    expect(el.querySelector('script')).toBeNull()
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('b')).toBeNull()
    expect(el.querySelector('.canvas-mockup-card__body')?.textContent).toBe(hostile)
    expect(el.querySelector('.canvas-mockup-card__title')?.textContent).toBe('<b>bold</b>')
  })

  it('carries no inline colour — the tokens arrive through the class (U2-3)', () => {
    const el = buildMockupCardElement(
      mockupCardFields({ title: 'T', subtitle: 'S', status: 'blocked', body: 'B' })
    )
    for (const node of [el, ...Array.from(el.querySelectorAll('*'))]) {
      expect((node as HTMLElement).getAttribute('style')).toBeNull()
    }
  })
})

// --------------------------------------------------------- the cell mapping ---

describe('toX6Node — a registered HTML shape', () => {
  it('emits the shape NAME verbatim, never markup', () => {
    const cell = toX6Node(cardNode(), PALETTE)
    expect(cell.shape).toBe(MOCKUP_CARD_SHAPE)
    expect(JSON.stringify(cell)).not.toContain('<')
    expect(cell).not.toHaveProperty('html')
  })

  it('carries props through the cell `data`, where the registered component reads them', () => {
    const data = toX6Node(cardNode(), PALETTE).data as { kind: string; props: unknown }
    expect(data.kind).toBe(MOCKUP_CARD_SHAPE)
    expect(data.props).toEqual({
      title: 'Sidebar',
      subtitle: 'Folder rows',
      status: 'done',
      body: 'Two zones.'
    })
  })

  it("writes the label to BOTH attribute paths but hides X6's own <text>", () => {
    // Both paths so §4.5's normalizer round-trips the name and rename works;
    // hidden because the card draws that name itself (design.md §6).
    const attrs = toX6Node(cardNode({ label: 'Card' }), PALETTE).attrs as Record<
      string,
      Record<string, unknown>
    >
    expect(attrs.text.text).toBe('Card')
    expect(attrs.label.text).toBe('Card')
    expect(attrs.text.display).toBe('none')
    expect(attrs.label.display).toBe('none')
  })

  it('falls back to the manifest footprint when the document omits a size', () => {
    const cell = toX6Node(cardNode({ width: undefined, height: undefined }), PALETTE)
    expect(cell.width).toBe(MOCKUP_CARD_DEFAULT_SIZE.width)
    expect(cell.height).toBe(MOCKUP_CARD_DEFAULT_SIZE.height)
  })
})

// ------------------------------------------- U7-2: live, in the SAME document ---

describe('U7-2 — the card renders as a live component in this document', () => {
  let graph: Graph | null = null
  afterEach(() => {
    graph?.dispose()
    graph = null
  })

  it('renders a real DOM subtree inside X6 foreignObject — not an iframe', async () => {
    graph = createCanvasGraph({ container: svgHost(), palette: PALETTE, width: 800, height: 600 })
    await renderAndSettle(graph, docWith(cardNode()))

    const card = graph.container.querySelector('.canvas-mockup-card')
    expect(card, 'the registered component did not render').not.toBeNull()

    // THE property §3 chose X6 for: the component is in OUR document, so it
    // reads Capy's CSS custom properties straight off the cascade. An iframe
    // would be an isolated CSS context needing the token sheet injected into it
    // on every theme switch.
    expect(card!.ownerDocument).toBe(graph.container.ownerDocument)
    expect(card!.closest('iframe')).toBeNull()
    // Walked by `localName` rather than `closest('foreignObject')`: a CSS type
    // selector is case-INSENSITIVE, and the SVG element's name is camelCase, so
    // the selector form matches nothing and would pass this test for the wrong
    // reason (it would also "pass" if the card were nowhere near the graph).
    const ancestors: string[] = []
    for (let el: Element | null = card; el; el = el.parentElement) ancestors.push(el.localName)
    expect(ancestors, 'not inside the graph SVG').toContain('foreignObject')
    expect(ancestors).toContain('svg')
    expect(graph.container.contains(card)).toBe(true)

    expect(card!.querySelector('.canvas-mockup-card__title')?.textContent).toBe('Sidebar')
    expect(card!.querySelector('.canvas-mockup-card__body')?.textContent).toBe('Two zones.')
    expect(card!.querySelector('.canvas-mockup-card__status')?.className).toContain('--green')
  })

  it('an unregistered harnu/ shape still opens the board instead of throwing', () => {
    // `graph.addNode({ shape })` throws on an unknown name, so the dashed-box
    // fallback is what keeps a NEWER Capy's board openable in this build.
    graph = createCanvasGraph({ container: svgHost(), palette: PALETTE, width: 800, height: 600 })
    expect(() =>
      renderCanvasDocument(
        graph!,
        docWith(cardNode({ shape: 'harnu/from-the-future', props: undefined })),
        PALETTE
      )
    ).not.toThrow()
    expect(graph.getCellCount()).toBe(1)
  })

  it('a board saved under the legacy capy/mockup-card name still renders and keeps its name (AC-3)', () => {
    graph = createCanvasGraph({ container: svgHost(), palette: PALETTE, width: 800, height: 600 })
    const cell = toX6Node(cardNode({ shape: 'capy/mockup-card' }), PALETTE)
    // Registered, so drawn as the card (no dashed "unknown shape" box) and emitted by name.
    expect(cell.shape).toBe('capy/mockup-card')
    expect(() =>
      renderCanvasDocument(graph!, docWith(cardNode({ shape: 'capy/mockup-card' })), PALETTE)
    ).not.toThrow()
    expect(graph.getCellCount()).toBe(1)
    expect(graph.getCells()[0].shape).toBe('capy/mockup-card')
  })

  it('registering twice is a no-op, so a second open pane cannot conflict', () => {
    expect(() => {
      registerCanvasHtmlShapes()
      registerCanvasHtmlShapes()
    }).not.toThrow()
  })
})

// --------------------------------------------- U7-3: Save → reload round trip ---

describe('U7-3 — a registered HTML node survives Save → reload with its props', () => {
  let graph: Graph | null = null
  afterEach(() => {
    graph?.dispose()
    graph = null
  })

  it('keeps shape and props byte-identical through graph → document → graph', async () => {
    const base = docWith(cardNode({ label: 'Card' }))
    graph = createCanvasGraph({ container: svgHost(), palette: PALETTE, width: 800, height: 600 })
    await renderAndSettle(graph, base)

    // The pane's Save path, exactly: serialize the graph, rebuild the document.
    const cells = (graph.toJSON() as { cells?: unknown[] }).cells ?? []
    const draft = buildCanvasDocumentFromCells(cells, base, '2026-08-24T00:00:00.000Z')

    // It must still be a DOCUMENT — main's validator is the only thing allowed
    // to say so, and it is what refuses props that are not plain JSON.
    const validated = validateCanvasDocument(draft)
    expect(validated.ok, validated.ok ? '' : validated.error).toBe(true)

    expect(draft.nodes).toHaveLength(1)
    const saved = draft.nodes[0]
    // `data.kind`, not the X6 shape — but for a registered component those are
    // the same string, which is the whole point of a name-based contract.
    expect(saved.shape).toBe(MOCKUP_CARD_SHAPE)
    expect(saved.label).toBe('Card')
    expect(saved.origin).toBe('agent')
    expect(saved.props).toEqual(base.nodes[0].props)

    // …and the reload half: the rebuilt document draws the same live card.
    graph.dispose()
    graph = createCanvasGraph({ container: svgHost(), palette: PALETTE, width: 800, height: 600 })
    await renderAndSettle(graph, validated.ok ? validated.doc : base)
    const card = graph.container.querySelector('.canvas-mockup-card')
    expect(card?.querySelector('.canvas-mockup-card__title')?.textContent).toBe('Sidebar')
  })

  it('an operator MOVE is saved without touching the props', () => {
    const base = docWith(cardNode())
    graph = createCanvasGraph({
      container: svgHost(),
      palette: PALETTE,
      editable: true,
      width: 800,
      height: 600
    })
    renderCanvasDocument(graph, base, PALETTE)
    graph.getCellById('n-card')?.setProp('position', { x: 500, y: 300 })

    const cells = (graph.toJSON() as { cells?: unknown[] }).cells ?? []
    const saved = buildCanvasDocumentFromCells(cells, base, 'now').nodes[0]
    expect({ x: saved.x, y: saved.y }).toEqual({ x: 500, y: 300 })
    expect(saved.props).toEqual(base.nodes[0].props)
    // Moving an agent's card does not make it the operator's (§4.4).
    expect(saved.origin).toBe('agent')
  })
})
