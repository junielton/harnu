// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readCanvasFile } from '../src/main/canvas-read'
import { writeCanvasFile } from '../src/main/canvas-write'
import {
  serializeCanvasDocument,
  validateCanvasDocument,
  type CanvasDocument
} from '../src/main/canvas-core'
import { __resetCanvasWatchStateForTests } from '../src/main/canvas-watch'
import { buildCanvasDocumentFromCells } from '../src/renderer/src/components/canvas/canvas-edit'
import { toX6Cells } from '../src/renderer/src/components/canvas/canvas-cells'
import {
  createCanvasGraph,
  renderCanvasDocument
} from '../src/renderer/src/components/canvas/canvas-graph'
import { readCanvasPalette } from '../src/renderer/src/components/canvas/canvas-theme'
import type { CanvasPalette } from '../src/renderer/src/components/canvas/canvas-theme'
import type { Graph } from '@antv/x6'
import { installJsdomSvgShim, svgHost } from './helpers/jsdom-svg'

installJsdomSvgShim()

/**
 * T218 U3, the two ACs that are only true if you look at the BYTES on disk:
 *
 *  - **U3-9** — a Save that fails validation must abort and write **nothing**.
 *    "The call returned an error" is not that claim: the claim is that the file
 *    that was already there is still exactly the file that was there. So every
 *    case below reads the previous bytes back and compares them, the way U1's
 *    own atomicity test does.
 *  - **U3-5** — repeated Saves with no edits do not grow the file.
 *
 * `canvas-edit.ts` is a renderer module but a pure one — no DOM, no X6 — which
 * is exactly what lets the pane's Save payload be built here and driven through
 * the REAL confined writer against a REAL temp directory, rather than against a
 * mock of it.
 */

vi.mock('electron', () => ({
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

vi.mock('../src/main/markdown-read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/markdown-read')>()
  return {
    ...actual,
    markdownKnownRoots: async () => [(globalThis as Record<string, unknown>).__TEST_ROOT__]
  }
})

let dir: string
let file: string

const NOW = '2026-08-23T12:00:00.000Z'

const SAVED: CanvasDocument = {
  capycanvas: 1,
  meta: { title: 'Board', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: NOW },
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
      origin: 'operator'
    }
  ],
  edges: [{ id: 'e-1', source: 'n-a', target: 'n-b', label: 'IPC', origin: 'agent' }]
}

/** The plain-JSON cells `graph.toJSON()` yields — hand-built here so the byte
 *  assertions do not need a DOM. The graph round-trip itself is covered by
 *  `canvas-edit.test.ts` against a real X6 graph. */
function cellsFor(doc: CanvasDocument): unknown[] {
  return [
    ...doc.nodes.map((n) => ({
      id: n.id,
      shape: n.shape === 'image' ? 'image' : 'rect',
      position: { x: n.x, y: n.y },
      size: { width: n.width, height: n.height },
      attrs: { text: { text: n.label ?? '' }, label: { text: n.label ?? '' } },
      data: { origin: n.origin, kind: n.shape }
    })),
    ...doc.edges.map((e) => ({
      id: e.id,
      shape: 'edge',
      source: { cell: e.source, port: 'right' },
      target: { cell: e.target, port: 'left' },
      data: { origin: e.origin }
    }))
  ]
}

describe('edge props survive a pane Save (T536 U2)', () => {
  const WITH_PROPS: CanvasDocument = {
    ...SAVED,
    edges: [
      {
        id: 'e-1',
        source: 'n-a',
        target: 'n-b',
        label: 'IPC',
        origin: 'agent',
        props: { style: { tone: 'green' }, weight: 2 }
      }
    ]
  }

  it('writes the edge props unchanged after an unrelated node move', async () => {
    const cells = cellsFor(WITH_PROPS) as { id: string; position?: { x: number; y: number } }[]
    cells.find((c) => c.id === 'n-b')!.position = { x: 500, y: 260 }
    const draft = buildCanvasDocumentFromCells(cells, WITH_PROPS, NOW)
    expect(draft.edges[0].props).toEqual({ style: { tone: 'green' }, weight: 2 })

    const r = await writeCanvasFile(file, draft)
    expect(r.ok).toBe(true)
    const onDisk = JSON.parse(await bytes()) as CanvasDocument
    expect(onDisk.edges[0].props).toEqual({ style: { tone: 'green' }, weight: 2 })
    expect(onDisk.nodes.find((n) => n.id === 'n-b')).toMatchObject({ x: 500, y: 260 })
  })

  it('leaves an edge without props without a props key', () => {
    const draft = buildCanvasDocumentFromCells(cellsFor(SAVED), SAVED, NOW)
    expect('props' in draft.edges[0]).toBe(false)
  })

  it('takes props from the base document, never from the cell', () => {
    const cells = cellsFor(WITH_PROPS) as { id: string; data?: Record<string, unknown> }[]
    cells.find((c) => c.id === 'e-1')!.data!.props = { style: { tone: 'red' } }
    const draft = buildCanvasDocumentFromCells(cells, WITH_PROPS, NOW)
    expect(draft.edges[0].props).toEqual({ style: { tone: 'green' }, weight: 2 })
  })
})

describe('node styles survive a pane Save (T536 U3)', () => {
  const STYLES: Record<string, Record<string, unknown>> = {
    'n-box': { tone: 'green', stroke: 'dashed', corners: 'sharp' },
    'n-ell': { tone: 'purple' }, // a value this build does not know
    'n-dia': { glow: 'max', opacity: 50 }, // a key this build does not know
    'n-txt': { fontSize: 'xl', align: 'left' },
    'n-img': { opacity: 25 }
  }
  const STYLED: CanvasDocument = {
    ...SAVED,
    nodes: [
      { id: 'n-box', shape: 'box', x: 0, y: 0, width: 132, height: 52, origin: 'agent' },
      { id: 'n-ell', shape: 'ellipse', x: 200, y: 0, origin: 'agent' },
      { id: 'n-dia', shape: 'diamond', x: 400, y: 0, origin: 'operator' },
      { id: 'n-txt', shape: 'text', x: 0, y: 200, label: 'note', origin: 'agent' },
      {
        id: 'n-img',
        shape: 'image',
        x: 200,
        y: 200,
        origin: 'agent',
        props: { src: 'assets/a.png' }
      }
    ].map((n) => ({
      ...n,
      props: { ...((n as { props?: object }).props ?? {}), style: STYLES[n.id] }
    })),
    edges: []
  }
  const PALETTE = new Proxy({}, { get: (_t, k) => `#${String(k)}` }) as unknown as CanvasPalette

  /** What the pane hands Save: the RENDERED cells, in `graph.toJSON()`'s shape. */
  function renderedCells(): { id: string; position: { x: number; y: number } }[] {
    return (toX6Cells(STYLED, PALETTE).cells as Record<string, unknown>[]).map((c) => ({
      ...c,
      position: { x: c.x as number, y: c.y as number },
      size: { width: c.width as number, height: c.height as number }
    })) as never
  }

  it('writes every props.style back unchanged after one node is moved', async () => {
    const cells = renderedCells()
    cells.find((c) => c.id === 'n-box')!.position = { x: 40, y: 60 }
    const draft = buildCanvasDocumentFromCells(cells, STYLED, NOW)
    for (const n of draft.nodes) {
      expect((n.props as { style?: unknown }).style, n.id).toEqual(STYLES[n.id])
    }
    const r = await writeCanvasFile(file, draft)
    expect(r.ok).toBe(true)
    const onDisk = JSON.parse(await bytes()) as CanvasDocument
    for (const n of onDisk.nodes) {
      expect(n.props?.style, n.id).toEqual(STYLES[n.id])
    }
    expect(onDisk.nodes.find((n) => n.id === 'n-box')).toMatchObject({ x: 40, y: 60 })
    expect(onDisk.nodes.find((n) => n.id === 'n-img')!.props).toEqual({
      src: 'assets/a.png',
      style: { opacity: 25 }
    })
  })
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'harnu-canvas-u3-'))
  file = join(dir, '.harnu', 'out', 'canvas', 'board.harnucanvas.json')
  ;(globalThis as Record<string, unknown>).__TEST_ROOT__ = dir
  __resetCanvasWatchStateForTests()
  const first = await writeCanvasFile(file, SAVED)
  expect(first.ok).toBe(true)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function bytes(): Promise<string> {
  return fs.readFile(file, 'utf8')
}

describe('U3-9 — a Save that fails validation aborts and writes NOTHING (§7.2)', () => {
  const CASES: { name: string; code: string; mutate: (cells: unknown[]) => unknown[] }[] = [
    {
      name: 'a node whose origin stamp is gone',
      code: 'missing-origin',
      mutate: (cells) => {
        const first = cells[0] as { data: Record<string, unknown> }
        delete first.data.origin
        return cells
      }
    },
    {
      name: 'a node stamped with something neither side may write',
      code: 'invalid-origin',
      mutate: (cells) => {
        // Not reachable through the pane's own creation paths — which is the
        // point: main validates the renderer's payload anyway, because the
        // renderer is untrusted from main's side of the IPC.
        const first = cells[0] as { data: Record<string, unknown> }
        first.data.origin = 'paste'
        return cells
      }
    },
    {
      name: 'an edge left dangling by a deleted node',
      code: 'dangling-edge',
      mutate: (cells) => cells.filter((c) => (c as { id: string }).id !== 'n-b')
    },
    {
      name: 'a label past the 2,000-char cap',
      code: 'label-too-long',
      mutate: (cells) => {
        const first = cells[0] as { attrs: { text: { text: string }; label: { text: string } } }
        first.attrs.label.text = 'x'.repeat(2001)
        first.attrs.text.text = 'x'.repeat(2001)
        return cells
      }
    }
  ]

  for (const c of CASES) {
    it(`${c.name} → refused with ${c.code}, and the previous file is untouched`, async () => {
      const before = await bytes()
      const draft = buildCanvasDocumentFromCells(
        c.mutate(cellsFor(SAVED)),
        SAVED,
        '2026-09-09T09:09:09.000Z'
      )
      const res = await writeCanvasFile(file, draft)

      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe(c.code)
      // THE assertion. A refusal that still rewrote the file would be worse
      // than no validation at all — the operator would have lost the document
      // AND been told the Save failed.
      expect(await bytes()).toBe(before)
    })
  }

  it('a refused Save leaves no temp file behind either', async () => {
    const draft = buildCanvasDocumentFromCells(
      CASES[0].mutate(cellsFor(SAVED)),
      SAVED,
      '2026-09-09T09:09:09.000Z'
    )
    await writeCanvasFile(file, draft)
    const siblings = await fs.readdir(join(dir, '.harnu', 'out', 'canvas'))
    expect(siblings).toEqual(['board.harnucanvas.json'])
  })

  it('the very next Save, once the document is valid again, does land', async () => {
    const before = await bytes()
    const bad = buildCanvasDocumentFromCells(CASES[0].mutate(cellsFor(SAVED)), SAVED, NOW)
    expect((await writeCanvasFile(file, bad)).ok).toBe(false)
    expect(await bytes()).toBe(before)

    const good = buildCanvasDocumentFromCells(cellsFor(SAVED), SAVED, '2026-08-24T00:00:00.000Z')
    expect((await writeCanvasFile(file, good)).ok).toBe(true)
    expect(await bytes()).toContain('2026-08-24T00:00:00.000Z')
  })
})

describe('U3-5 — repeated Saves with no edits do not grow the file (§4.1)', () => {
  it('saving the untouched board back produces the file it was read from', async () => {
    const before = await bytes()
    const read = await readCanvasFile(file)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    // Same `nowIso` as the document already carries: nothing changed, so
    // nothing in the bytes may change either.
    const draft = buildCanvasDocumentFromCells(cellsFor(read.doc), read.doc, NOW)
    expect((await writeCanvasFile(file, draft)).ok).toBe(true)
    expect(await bytes()).toBe(before)
  })

  it('three Saves in a row differ only in meta.updatedAt, and never in length', async () => {
    const lengths: number[] = []
    let previous: string | null = null
    for (const stamp of [
      '2026-08-24T00:00:00.000Z',
      '2026-08-25T00:00:00.000Z',
      '2026-08-26T00:00:00.000Z'
    ]) {
      const read = await readCanvasFile(file)
      expect(read.ok).toBe(true)
      if (!read.ok) return
      const draft = buildCanvasDocumentFromCells(cellsFor(read.doc), read.doc, stamp)
      expect((await writeCanvasFile(file, draft)).ok).toBe(true)
      const now = await bytes()
      lengths.push(now.length)
      if (previous !== null) {
        // §7.2 step 6 updates the timestamp; everything else must be identical.
        expect(now.replace(stamp, 'X')).toBe(previous.replace(/2026-08-2\dT00:00:00\.000Z/, 'X'))
      }
      previous = now
    }
    expect(new Set(lengths).size).toBe(1)
  })

  it('the key order the pure serializer defines is what a pane Save writes', async () => {
    const read = await readCanvasFile(file)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const draft = buildCanvasDocumentFromCells(cellsFor(read.doc), read.doc, NOW)
    await writeCanvasFile(file, draft)
    expect(await bytes()).toBe(serializeCanvasDocument(draft as unknown as CanvasDocument))
  })

  it('an unknown top-level key written by a newer Harnu survives a pane Save', async () => {
    const withExtras = { ...SAVED, layouts: { hint: 'newer Harnu' } } as CanvasDocument
    await writeCanvasFile(file, withExtras)
    const read = await readCanvasFile(file)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const draft = buildCanvasDocumentFromCells(cellsFor(read.doc), read.doc, NOW)
    await writeCanvasFile(file, draft)
    expect(JSON.parse(await bytes()).layouts).toEqual({ hint: 'newer Harnu' })
  })
})

describe('stacking survives a pane Save (T536 U4)', () => {
  const palette = readCanvasPalette()
  const box = (id: string, zIndex?: number): CanvasDocument['nodes'][number] => ({
    id,
    shape: 'box',
    x: 40,
    y: 40,
    width: 132,
    height: 52,
    label: id,
    origin: 'agent',
    ...(zIndex === undefined ? {} : { zIndex })
  })
  const board = (nodes: CanvasDocument['nodes']): CanvasDocument => ({
    capycanvas: 1,
    meta: { title: 'Board', createdAt: '2026-08-01T00:00:00.000Z' },
    nodes,
    edges: [{ id: 'e-1', source: nodes[0].id, target: nodes[1].id, origin: 'agent' }]
  })
  const graphOf = (doc: CanvasDocument): Graph => {
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
  const cellsOf = (g: Graph): unknown[] => (g.toJSON() as { cells?: unknown[] }).cells ?? []
  const zs = (d: { nodes: { id: string; zIndex?: number }[] }): (number | undefined)[] =>
    d.nodes.map((n) => n.zIndex)

  it('writes no zIndex for an unstacked board after a move, a restyle or an added box (Review Focus 1)', () => {
    const doc = board([box('a'), box('b'), box('c')])
    const g = graphOf(doc)
    g.getCellById('b')!.setProp('position', { x: 300, y: 300 })
    expect(zs(buildCanvasDocumentFromCells(cellsOf(g), doc, NOW))).toEqual([
      undefined,
      undefined,
      undefined
    ])

    g.getCellById('a')!.setData({ props: { style: { tone: 'green' } } }, { deep: false })
    expect(zs(buildCanvasDocumentFromCells(cellsOf(g), doc, NOW))).toEqual([
      undefined,
      undefined,
      undefined
    ])

    g.addNode({ id: 'n-new', shape: 'rect', x: 0, y: 0, width: 10, height: 10 })
    const added = buildCanvasDocumentFromCells(cellsOf(g), doc, NOW)
    expect(added.nodes.map((n) => n.id)).toContain('n-new')
    expect(added.nodes.some((n) => n.zIndex !== undefined)).toBe(false)
  })

  it('keeps exactly the file zIndex values after a move on a partly stacked board', () => {
    const doc = board([box('a'), box('b', 7), box('c', 2)])
    const g = graphOf(doc)
    g.getCellById('a')!.setProp('position', { x: 99, y: 99 })
    expect(zs(buildCanvasDocumentFromCells(cellsOf(g), doc, NOW))).toEqual([undefined, 7, 2])
  })

  it('writes every rank once a node was put on top, and the draft validates', () => {
    const doc = board([box('a'), box('b'), box('c')])
    const g = graphOf(doc)
    g.startBatch('layer')
    g.getCellById('a')!.setZIndex(3)
    g.getCellById('b')!.setZIndex(1)
    g.getCellById('c')!.setZIndex(2)
    g.stopBatch('layer')
    const draft = buildCanvasDocumentFromCells(cellsOf(g), doc, NOW)
    expect(Object.fromEntries(draft.nodes.map((n) => [n.id, n.zIndex]))).toEqual({
      a: 3,
      b: 1,
      c: 2
    })
    expect(validateCanvasDocument(draft).ok).toBe(true)
  })

  it('returns the file to no zIndex once the rendered z values are restored (an undo)', () => {
    const doc = board([box('a'), box('b'), box('c')])
    const g = graphOf(doc)
    g.getCellById('a')!.setZIndex(3)
    g.getCellById('c')!.setZIndex(1)
    expect(
      zs(buildCanvasDocumentFromCells(cellsOf(g), doc, NOW)).every((z) => z !== undefined)
    ).toBe(true)
    g.getCellById('a')!.setZIndex(1)
    g.getCellById('b')!.setZIndex(2)
    g.getCellById('c')!.setZIndex(3)
    const draft = buildCanvasDocumentFromCells(cellsOf(g), doc, NOW)
    expect(zs(draft)).toEqual([undefined, undefined, undefined])
    expect(serializeCanvasDocument(draft as unknown as CanvasDocument)).toBe(
      serializeCanvasDocument({
        ...doc,
        meta: { ...doc.meta, updatedAt: NOW }
      })
    )
  })

  it('gives a node added to a stacked board the top rank and re-ranks the rest (Review Focus 2)', () => {
    const doc = board([box('a', 3), box('b', 1), box('c', 2)])
    const g = graphOf(doc)
    g.addNode({ id: 'n-new', shape: 'rect', x: 0, y: 0, width: 10, height: 10 })
    const draft = buildCanvasDocumentFromCells(cellsOf(g), doc, NOW)
    expect(Object.fromEntries(draft.nodes.map((n) => [n.id, n.zIndex]))).toEqual({
      b: 1,
      c: 2,
      a: 3,
      'n-new': 4
    })
    const again = graphOf(draft as unknown as CanvasDocument)
    expect(again.getNodes().map((n) => n.id)).toEqual(['b', 'c', 'a', 'n-new'])
  })

  it("stack: 'live' carries every cell's exact z, the unstacked ones included", () => {
    const doc = board([box('a'), box('b'), box('c')])
    const g = graphOf(doc)
    const draft = buildCanvasDocumentFromCells(cellsOf(g), doc, NOW, 'live')
    expect(zs(draft)).toEqual([1, 2, 3])
  })
})
