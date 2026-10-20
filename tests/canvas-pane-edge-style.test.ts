// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VueWrapper } from '@vue/test-utils'
import type { Cell, Graph } from '@antv/x6'
import { setActivePinia, createPinia } from 'pinia'
import type { CanvasDocument } from '../src/main/canvas-core'
import CanvasPropertiesPanel from '../src/renderer/src/components/CanvasPropertiesPanel.vue'
import { MOCKUP_CARD_SHAPE } from '../src/renderer/src/components/canvas/shapes/mockup-card'
import { useThemeStore } from '../src/renderer/src/stores/theme'
import { installJsdomSvgShim } from './helpers/jsdom-svg'
import {
  down,
  focusPane,
  key,
  mountPane,
  nodeEl,
  saveAndRead,
  settle,
  svgOf,
  unmountPanes,
  up
} from './helpers/canvas-pane-harness'

installJsdomSvgShim()

/**
 * T536 U5 — arrow styles through the canvas pane: the properties panel over a
 * selection that holds arrows, the live restyle of an edge on every data write
 * (a pick, its undo, its redo), and what a Save writes. The pure maths are
 * `canvas-style.test.ts`; the panel's own rendering is
 * `canvas-properties-panel.test.ts`. This file is the pane's half.
 */

const DOC: CanvasDocument = {
  capycanvas: 1,
  meta: { title: 'Board', createdAt: '2026-08-01T00:00:00.000Z' },
  nodes: [
    { id: 'n-a', shape: 'box', x: 40, y: 40, width: 132, height: 52, label: 'A', origin: 'agent' },
    {
      id: 'n-b',
      shape: 'box',
      x: 320,
      y: 200,
      width: 132,
      height: 52,
      label: 'B',
      origin: 'agent'
    },
    {
      id: 'n-m',
      shape: MOCKUP_CARD_SHAPE,
      x: 600,
      y: 40,
      width: 260,
      height: 160,
      origin: 'agent',
      props: { title: 'Card' }
    }
  ],
  edges: [
    { id: 'e-1', source: 'n-a', target: 'n-b', origin: 'agent', props: { weight: 2 } },
    { id: 'e-2', source: 'n-b', target: 'n-a', origin: 'operator' }
  ]
}

const AT: Record<string, [number, number]> = {
  'n-a': [100, 60],
  'n-b': [380, 220],
  'n-m': [700, 100],
  'e-1': [304, 142],
  'e-2': [250, 150]
}

/** Two palettes, as two themes would resolve them. Every value is distinct. */
const DARK: Record<string, string> = {
  '--color-bg': '#100001',
  '--color-surface': '#100002',
  '--color-border': '#100003',
  '--color-border-2': '#100004',
  '--color-text': '#100005',
  '--color-text-2': '#100006',
  '--color-text-3': '#100007',
  '--color-accent': '#100008',
  '--color-accent-soft': '#100009',
  '--color-green': '#10000a',
  '--color-green-soft': '#10000b',
  '--color-warning': '#10000c',
  '--color-warning-soft': '#10000d',
  '--color-red': '#10000e',
  '--color-red-soft': '#10000f'
}
const LIGHT: Record<string, string> = Object.fromEntries(
  Object.entries(DARK).map(([k, v]) => [k, v.replace('#1', '#2')])
)
function applyPalette(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v)
}

const canvasRead = vi.fn(async (p: string) => ({ ok: true as const, path: p, doc: DOC }))
const canvasWrite = vi.fn(async (p: string) => ({ ok: true as const, path: p, bytes: 1 }))

beforeEach(() => {
  canvasRead.mockClear()
  canvasWrite.mockClear()
  canvasRead.mockImplementation(async (p: string) => ({ ok: true, path: p, doc: DOC }))
  const api = {
    canvasRead,
    canvasWrite,
    markdownRead: vi.fn(async () => ({ ok: false as const, code: 'not-found', error: 'x' })),
    canvasWatchStart: vi.fn(async () => undefined),
    canvasWatchStop: vi.fn(async () => undefined),
    onCanvasChanged: () => () => {},
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn()
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, k: string) {
      return k in t ? t[k] : () => () => {}
    }
  })
  setActivePinia(createPinia())
  applyPalette(DARK)
})

// jsdom lacks `document.elementFromPoint`, which X6 calls on a node's `mouseup`.
if (!('elementFromPoint' in document)) {
  ;(document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null
}

afterEach(() => {
  unmountPanes()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('style')
})

// ── helpers ─────────────────────────────────────────────────────────────────
function graphOf(w: VueWrapper): Graph {
  const g = (w.vm as unknown as { graph: Graph | null }).graph
  expect(g, 'the pane has no graph').toBeTruthy()
  return g!
}

/** Click a cell in Select: the first replaces the selection, the rest add with shift. */
async function select(w: VueWrapper, ...ids: string[]): Promise<void> {
  ids.forEach((id, i) => {
    const init = i === 0 ? {} : { shiftKey: true }
    down(nodeEl(w, id), AT[id], init)
    up(AT[id], init)
  })
  await settle()
}

async function settleUntil(done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  do await settle()
  while (!done() && Date.now() < deadline)
}

function selectedIds(w: VueWrapper): string[] {
  return [...svgOf(w).querySelectorAll('.x6-node-selected, .x6-edge-selected')]
    .map((el) => el.getAttribute('data-cell-id') ?? '?')
    .sort()
}

const panel = (w: VueWrapper): boolean => w.find('[data-testid="canvas-properties"]').exists()
const layersShown = (w: VueWrapper): boolean => w.find('[data-testid="canvas-layers"]').exists()
const groups = (w: VueWrapper): string[] =>
  w
    .findAll('[data-testid^="canvas-prop-group-"]')
    .map((g) => g.attributes('data-testid')!.replace('canvas-prop-group-', ''))
const has = (w: VueWrapper, testid: string): boolean => w.find(`[data-testid="${testid}"]`).exists()
const isDirty = (w: VueWrapper): boolean => w.find('[data-testid="diagram-dirty-dot"]').exists()
const redoDisabled = (w: VueWrapper): boolean =>
  w.find('[data-testid="diagram-redo"]').attributes('disabled') !== undefined

async function pick(w: VueWrapper, name: string, value: string | number): Promise<void> {
  const option = w.find(`[data-testid="canvas-prop-${name}-${value}"]`)
  expect(option.exists(), `no option ${name}-${value}`).toBe(true)
  await option.trigger('mousedown')
  await option.trigger('click')
  await settle()
}

async function undo(w: VueWrapper): Promise<void> {
  focusPane(w)
  key('z', { ctrlKey: true })
  await settle()
}
async function redo(w: VueWrapper): Promise<void> {
  focusPane(w)
  key('y', { ctrlKey: true })
  await settle()
}

/** The arrow's visible line: the path that carries the arrowhead. */
function lineOf(w: VueWrapper, id: string): Element | null {
  return nodeEl(w, id)?.querySelector('path[marker-end]') ?? null
}
function lineStroke(w: VueWrapper, id: string): string | null | undefined {
  return lineOf(w, id)?.getAttribute('stroke')
}
/** The fill of the arrowhead the line points at. */
function headFill(w: VueWrapper, id: string): string | null | undefined {
  const ref = lineOf(w, id)?.getAttribute('marker-end')
  const markerId = ref?.match(/url\(#(.+)\)/)?.[1]
  if (markerId === undefined) return undefined
  const head = svgOf(w).querySelector(`[id="${markerId}"]`)?.querySelector('[fill]')
  return head?.getAttribute('fill')
}
async function expectStroke(w: VueWrapper, id: string, color: string): Promise<void> {
  await settleUntil(() => lineStroke(w, id) === color)
  expect(lineStroke(w, id), `${id} stroke`).toBe(color)
}

const edgeOf = (doc: CanvasDocument, id: string): CanvasDocument['edges'][number] =>
  doc.edges.find((e) => e.id === id)!
const nodeOf = (doc: CanvasDocument, id: string): CanvasDocument['nodes'][number] =>
  doc.nodes.find((n) => n.id === id)!

async function switchTheme(w: VueWrapper, vars: Record<string, string>): Promise<void> {
  const before = nodeEl(w, 'e-1')
  applyPalette(vars)
  useThemeStore().set('light')
  await settleUntil(() => nodeEl(w, 'e-1') !== null && nodeEl(w, 'e-1') !== before)
}

// ── the panel for a selected arrow ──────────────────────────────────────────
describe('DiagramPane arrow styles — the panel for a selected arrow (T536 U5)', () => {
  it('an arrow alone shows Color (five options, line glyphs) and Stroke, and no Layers', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'e-1')
    expect(selectedIds(w)).toEqual(['e-1'])
    expect(panel(w)).toBe(true)
    expect(groups(w)).toEqual(['tone', 'stroke'])
    expect(layersShown(w)).toBe(false)

    const tones = w.findAll('[data-testid^="canvas-prop-tone-"]')
    expect(tones.map((t) => t.attributes('data-testid'))).toEqual([
      'canvas-prop-tone-default',
      'canvas-prop-tone-green',
      'canvas-prop-tone-amber',
      'canvas-prop-tone-red',
      'canvas-prop-tone-muted'
    ])
    expect(has(w, 'canvas-prop-tone-accent')).toBe(false)
    // Line glyphs, not the node swatches.
    expect(
      w.findAll('[data-testid="canvas-prop-group-tone"] [data-testid="canvas-prop-glyph"]')
    ).toHaveLength(5)
    expect(has(w, 'canvas-prop-swatch')).toBe(false)
    expect(has(w, 'canvas-prop-strokeWidth-thin')).toBe(false)
    expect(has(w, 'canvas-prop-corners-sharp')).toBe(false)
  })

  it('a mousedown on an option keeps the arrow selected (no selection:changed to empty)', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'e-1')
    const seen: number[] = []
    graphOf(w).on('selection:changed', ({ selected }: { selected: Cell[] }) => {
      seen.push(selected.length)
    })
    await pick(w, 'tone', 'red')
    expect(seen.filter((n) => n === 0)).toEqual([])
    expect(selectedIds(w)).toEqual(['e-1'])
    expect(panel(w)).toBe(true)
  })
})

// ── a pick on an arrow ──────────────────────────────────────────────────────
describe('DiagramPane arrow styles — a pick restyles the arrow and saves into props.style', () => {
  it('Review Focus 1, 4: red paints line and arrowhead, and Save keeps the other props', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'e-1')
    expect(isDirty(w)).toBe(false)
    await pick(w, 'tone', 'red')
    expect(isDirty(w)).toBe(true)

    await expectStroke(w, 'e-1', DARK['--color-red'])
    await settleUntil(() => headFill(w, 'e-1') === DARK['--color-red'])
    expect(headFill(w, 'e-1')).toBe(DARK['--color-red'])

    const doc = await saveAndRead(w)
    expect(edgeOf(doc, 'e-1').props).toEqual({ weight: 2, style: { tone: 'red' } })
    expect(edgeOf(doc, 'e-2').props).toBeUndefined()
  })

  it('reset to default is written: the style is gone and the other props stay', async () => {
    const doc: CanvasDocument = {
      ...DOC,
      edges: [
        {
          id: 'e-1',
          source: 'n-a',
          target: 'n-b',
          origin: 'agent',
          props: { weight: 2, style: { tone: 'red' } }
        },
        DOC.edges[1]
      ]
    }
    canvasRead.mockImplementation(async (p: string) => ({ ok: true, path: p, doc }))
    const w = mountPane()
    await settle()
    await select(w, 'e-1')
    await expectStroke(w, 'e-1', DARK['--color-red'])
    await pick(w, 'tone', 'default')
    await expectStroke(w, 'e-1', DARK['--color-accent'])
    const saved = await saveAndRead(w)
    expect(edgeOf(saved, 'e-1').props).toEqual({ weight: 2 })
  })

  it('a stroke pick on two arrows is ONE undo step, and redo puts both back', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'e-1', 'e-2')
    expect(selectedIds(w)).toEqual(['e-1', 'e-2'])
    await pick(w, 'stroke', 'dashed')

    let doc = await saveAndRead(w)
    expect(edgeOf(doc, 'e-1').props).toEqual({ weight: 2, style: { stroke: 'dashed' } })
    expect(edgeOf(doc, 'e-2').props).toEqual({ style: { stroke: 'dashed' } })

    await undo(w)
    doc = await saveAndRead(w)
    expect(edgeOf(doc, 'e-1').props).toEqual({ weight: 2 })
    expect(edgeOf(doc, 'e-2').props).toBeUndefined()

    await redo(w)
    doc = await saveAndRead(w)
    expect(edgeOf(doc, 'e-1').props).toEqual({ weight: 2, style: { stroke: 'dashed' } })
    expect(edgeOf(doc, 'e-2').props).toEqual({ style: { stroke: 'dashed' } })
  })

  it('picking the value already in force changes nothing: clean', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'e-1')
    // The panel itself returns early for the value already in force, so emit straight
    // from it: this reaches the pane's own equality skip in applyStylePatch.
    // X6 ignores a setData that changes nothing, so the pane's skip is observable only
    // as "setData is never called".
    const setData = vi.spyOn(graphOf(w).getCellById('e-1')!, 'setData')
    w.findComponent(CanvasPropertiesPanel).vm.$emit('change', { tone: 'default' })
    await settle()
    expect(setData).not.toHaveBeenCalled()
    expect(isDirty(w)).toBe(false)
  })
})

// ── Review Focus 3: a mixed selection ───────────────────────────────────────
describe('DiagramPane arrow styles — Review Focus 3: nodes and arrows together', () => {
  it('offers only what both take, writes it to both, and leaves Layers to the nodes', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a', 'e-1')
    expect(selectedIds(w)).toEqual(['e-1', 'n-a'])
    expect(groups(w)).toEqual(['tone', 'stroke'])
    expect(layersShown(w)).toBe(true)
    expect(has(w, 'canvas-prop-tone-accent')).toBe(false)
    expect(w.findAll('[data-testid^="canvas-prop-strokeWidth-"]')).toHaveLength(0)
    expect(w.findAll('[data-testid^="canvas-prop-corners-"]')).toHaveLength(0)

    await pick(w, 'tone', 'green')
    const doc = await saveAndRead(w)
    expect(nodeOf(doc, 'n-a').props).toEqual({ style: { tone: 'green' } })
    expect(edgeOf(doc, 'e-1').props).toEqual({ weight: 2, style: { tone: 'green' } })
  })

  it('the pane filters a patch per cell: accent never reaches an arrow, nor strokeWidth', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a', 'e-1')
    const panelVm = w.findComponent({ name: 'CanvasPropertiesPanel' })
    panelVm.vm.$emit('change', { tone: 'accent', strokeWidth: 'bold' })
    await settle()
    const doc = await saveAndRead(w)
    expect(edgeOf(doc, 'e-1').props).toEqual({ weight: 2 })
    expect(nodeOf(doc, 'n-a').props).toEqual({ style: { tone: 'accent', strokeWidth: 'bold' } })
  })

  it('ctrl+a (boxes, card, arrows) shows Layers alone, and back never restacks an arrow', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('a', { ctrlKey: true })
    await settle()
    expect(selectedIds(w)).toEqual(['e-1', 'e-2', 'n-a', 'n-b', 'n-m'])
    expect(panel(w)).toBe(true)
    expect(groups(w)).toEqual([])
    expect(layersShown(w)).toBe(true)

    const back = w.find('[data-testid="canvas-layer-back"]')
    await back.trigger('mousedown')
    await back.trigger('click')
    await settle()
    const g = graphOf(w)
    expect(g.getCellById('e-1')!.getZIndex()).toBe(0)
    expect(g.getCellById('e-2')!.getZIndex()).toBe(0)
  })
})

// ── Review Focus 5: undo and theme ──────────────────────────────────────────
describe('DiagramPane arrow styles — Review Focus 5: a theme switch never strands an old palette', () => {
  afterEach(() => useThemeStore().set('default-dark'))

  it('a switch recolours a styled arrow, stays dirty, and the pick survives a Save', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'e-1')
    await pick(w, 'tone', 'green')
    await expectStroke(w, 'e-1', DARK['--color-green'])

    await switchTheme(w, LIGHT)
    await expectStroke(w, 'e-1', LIGHT['--color-green'])
    expect(isDirty(w)).toBe(true)

    const doc = await saveAndRead(w)
    expect(edgeOf(doc, 'e-1').props).toEqual({ weight: 2, style: { tone: 'green' } })
  })

  it('undo and redo after a switch resolve the NEW palette, and keep the redo stack', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'e-1')
    await pick(w, 'tone', 'green')
    await switchTheme(w, LIGHT)
    await expectStroke(w, 'e-1', LIGHT['--color-green'])

    await undo(w)
    await expectStroke(w, 'e-1', LIGHT['--color-accent'])
    expect(redoDisabled(w)).toBe(false)

    await redo(w)
    await expectStroke(w, 'e-1', LIGHT['--color-green'])
  })
})

// ── Review Focus 2: the arrow stays clickable ───────────────────────────────
describe('DiagramPane arrow styles — Review Focus 2: a restyled arrow stays a live element', () => {
  function expectLive(w: VueWrapper): void {
    const g = nodeEl(w, 'e-1')
    const paths = [...g.querySelectorAll('path')]
    expect(paths.length).toBeGreaterThanOrEqual(2)
    for (const p of paths) expect(p.getAttribute('d') ?? '').not.toBe('')
  }
  async function clickable(w: VueWrapper): Promise<void> {
    // Press on the wide invisible hit path at the midpoint.
    const wrap = nodeEl(w, 'e-1').querySelector('path')!
    down(wrap, AT['e-1'])
    up(AT['e-1'])
    await settle()
    expect(selectedIds(w)).toEqual(['e-1'])
  }

  it('after a pick and after its undo the path has geometry and a press still selects it', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'e-1')
    await pick(w, 'stroke', 'dotted')
    await settleUntil(() => lineOf(w, 'e-1')?.getAttribute('stroke-dasharray') === '2 3')
    expectLive(w)
    await select(w, 'n-m')
    await clickable(w)

    await undo(w)
    await settleUntil(() => lineOf(w, 'e-1')?.getAttribute('stroke-dasharray') === null)
    expectLive(w)
    await select(w, 'n-m')
    await clickable(w)
  })
})

// ── audit row B ─────────────────────────────────────────────────────────────
describe('DiagramPane arrow styles — an arrow restored by undo after a Save keeps its style', () => {
  it('writes the style and the other props in the second Save', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'e-1')
    await pick(w, 'tone', 'red')
    await select(w, 'e-1')
    focusPane(w)
    key('Delete')
    await settle()
    expect((await saveAndRead(w)).edges.map((e) => e.id)).toEqual(['e-2'])

    await undo(w)
    const saved = await saveAndRead(w)
    expect(edgeOf(saved, 'e-1').props).toEqual({ weight: 2, style: { tone: 'red' } })
  })
})

// ── hardening: edge cases the reviews flagged ───────────────────────────────
describe('DiagramPane arrow styles — hardening (T536 U5)', () => {
  it('a tone pick on a box and an arrow is ONE undo step: neither stays green', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a', 'e-1')
    await pick(w, 'tone', 'green')
    let doc = await saveAndRead(w)
    expect(nodeOf(doc, 'n-a').props).toEqual({ style: { tone: 'green' } })
    expect(edgeOf(doc, 'e-1').props).toEqual({ weight: 2, style: { tone: 'green' } })

    await undo(w)
    doc = await saveAndRead(w)
    expect(nodeOf(doc, 'n-a').props).toBeUndefined()
    expect(edgeOf(doc, 'e-1').props).toEqual({ weight: 2 })
  })

  describe('a file written by a newer build', () => {
    const NEWER: CanvasDocument = {
      ...DOC,
      edges: [
        {
          id: 'e-1',
          source: 'n-a',
          target: 'n-b',
          origin: 'agent',
          props: { style: { glow: 1, tone: 'purple', stroke: 'dashed' }, weight: 2 }
        },
        DOC.edges[1]
      ]
    }
    beforeEach(() => {
      canvasRead.mockImplementation(async (p: string) => ({ ok: true, path: p, doc: NEWER }))
    })

    it('a tone pick keeps the unknown style key, the other known key and the other props', async () => {
      const w = mountPane()
      await settle()
      await select(w, 'e-1')
      await pick(w, 'tone', 'green')
      const doc = await saveAndRead(w)
      expect(edgeOf(doc, 'e-1').props).toEqual({
        style: { glow: 1, tone: 'green', stroke: 'dashed' },
        weight: 2
      })
    })

    it('a stroke-only pick keeps the unknown tone verbatim in the saved file', async () => {
      const w = mountPane()
      await settle()
      await select(w, 'e-1')
      await pick(w, 'stroke', 'dotted')
      const doc = await saveAndRead(w)
      expect(edgeOf(doc, 'e-1').props).toEqual({
        style: { glow: 1, tone: 'purple', stroke: 'dotted' },
        weight: 2
      })
    })
  })
})
