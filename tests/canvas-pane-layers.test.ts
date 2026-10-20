// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VueWrapper } from '@vue/test-utils'
import type { Graph } from '@antv/x6'
import { setActivePinia, createPinia } from 'pinia'
import type { CanvasDocument } from '../src/main/canvas-core'
import { MOCKUP_CARD_SHAPE } from '../src/renderer/src/components/canvas/shapes/mockup-card'
import { useThemeStore } from '../src/renderer/src/stores/theme'
import { installJsdomSvgShim } from './helpers/jsdom-svg'
import {
  down,
  focusPane,
  key,
  mountPane,
  move,
  nodeEl,
  saveAndRead,
  settle,
  svgOf,
  unmountPanes,
  up
} from './helpers/canvas-pane-harness'

installJsdomSvgShim()

/**
 * T536 U4 — the Layers group wired into the canvas pane: a move restacks the
 * selected nodes in ONE undo step, a move that changes nothing writes nothing,
 * edges are never restacked, and the order survives Save, a reload and a theme
 * redraw. The panel's own rendering is `canvas-properties-panel.test.ts`; the
 * pure order rules are `canvas-layers.test.ts`.
 *
 * "The stack" is read off the graph's cell collection, which X6 re-sorts by z on
 * every z change (ties in insertion order) — `getCells()`, NOT `getNodes()`: the
 * latter reads an id-keyed cache in insertion order and never reflects a restack.
 */

// A mockup card off to the side at the bottom, then three boxes overlapping in a
// staircase, bottom → top in file order — none with a zIndex, so n-c is the top
// node — and one arrow from the bottom box.
const DOC: CanvasDocument = {
  capycanvas: 1,
  meta: { title: 'Board', createdAt: '2026-08-01T00:00:00.000Z' },
  nodes: [
    {
      id: 'n-m',
      shape: MOCKUP_CARD_SHAPE,
      x: 600,
      y: 40,
      width: 260,
      height: 160,
      origin: 'agent',
      props: { title: 'Card' }
    },
    { id: 'n-a', shape: 'box', x: 40, y: 40, width: 160, height: 100, label: 'A', origin: 'agent' },
    {
      id: 'n-b',
      shape: 'box',
      x: 100,
      y: 80,
      width: 160,
      height: 100,
      label: 'B',
      origin: 'agent'
    },
    {
      id: 'n-c',
      shape: 'box',
      x: 160,
      y: 120,
      width: 160,
      height: 100,
      label: 'C',
      origin: 'agent'
    }
  ],
  edges: [{ id: 'e-1', source: 'n-a', target: 'n-b', origin: 'agent' }]
}
const FILE_ORDER = DOC.nodes.map((n) => n.id)
const PATH = '/wt/board.harnucanvas.json'

/** A point inside each node that no other node covers — the jsdom CTM is the identity. */
const AT: Record<string, [number, number]> = {
  'n-a': [60, 50],
  'n-b': [240, 90],
  'n-c': [300, 200],
  'n-m': [700, 100],
  'e-1': [150, 160]
}

const canvasRead = vi.fn(async (p: string) => ({ ok: true as const, path: p, doc: DOC }))
const canvasWrite = vi.fn(async (p: string) => ({ ok: true as const, path: p, bytes: 1 }))
let changed: ((p: { path: string }) => void) | null = null

beforeEach(() => {
  canvasRead.mockClear()
  canvasWrite.mockClear()
  canvasRead.mockImplementation(async (p: string) => ({ ok: true, path: p, doc: DOC }))
  changed = null
  const api = {
    canvasRead,
    canvasWrite,
    markdownRead: vi.fn(async () => ({ ok: false as const, code: 'not-found', error: 'x' })),
    canvasWatchStart: vi.fn(async () => undefined),
    canvasWatchStop: vi.fn(async () => undefined),
    onCanvasChanged: (cb: (p: { path: string }) => void) => {
      changed = cb
      return () => {}
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
/** Node ids bottom → top, as X6's z-sorted collection holds them. */
const stack = (w: VueWrapper): string[] =>
  graphOf(w)
    .getCells()
    .filter((c) => c.isNode())
    .map((n) => n.id)
const zOf = (w: VueWrapper): Record<string, number | undefined> =>
  Object.fromEntries(
    graphOf(w)
      .getCells()
      .map((c) => [c.id, c.getZIndex()])
  )

/** Click a cell in Select: the first replaces the selection, the rest add with shift. */
async function select(w: VueWrapper, ...ids: string[]): Promise<void> {
  ids.forEach((id, i) => {
    const init = i === 0 ? {} : { shiftKey: true }
    down(nodeEl(w, id), AT[id], init)
    up(AT[id], init)
  })
  await settle()
}
function selectedIds(w: VueWrapper): string[] {
  return [...svgOf(w).querySelectorAll('.x6-node-selected, .x6-edge-selected')]
    .map((el) => el.getAttribute('data-cell-id') ?? '?')
    .sort()
}

async function layer(w: VueWrapper, move: string): Promise<void> {
  const button = w.find(`[data-testid="canvas-layer-${move}"]`)
  expect(button.exists(), `no layer button ${move}`).toBe(true)
  await button.trigger('mousedown')
  await button.trigger('click')
  await settle()
}

const isDirty = (w: VueWrapper): boolean => w.find('[data-testid="diagram-dirty-dot"]').exists()
const undoDisabled = (w: VueWrapper): boolean =>
  w.find('[data-testid="diagram-undo"]').attributes('disabled') !== undefined
const redoDisabled = (w: VueWrapper): boolean =>
  w.find('[data-testid="diagram-redo"]').attributes('disabled') !== undefined
const layersShown = (w: VueWrapper): boolean => w.find('[data-testid="canvas-layers"]').exists()
const styleGroups = (w: VueWrapper): number =>
  w.findAll('[data-testid^="canvas-prop-group-"]').length

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

const zIndexOf = (doc: CanvasDocument, id: string): number | undefined =>
  doc.nodes.find((n) => n.id === id)?.zIndex

/** Settle until `done()` holds, bounded by wall time (X6 renders in time-sliced jobs). */
async function settleUntil(done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  do await settle()
  while (!done() && Date.now() < deadline)
}

/** Simulate the file watcher (an agent's write) and wait for the reload to land. */
async function reloadFromDisk(w: VueWrapper): Promise<void> {
  const before = nodeEl(w, 'n-a')
  changed!({ path: PATH })
  await settleUntil(() => nodeEl(w, 'n-a') !== null && nodeEl(w, 'n-a') !== before)
}

// ── a move, Save and undo ───────────────────────────────────────────────────
describe('DiagramPane layers — a move restacks, saves and undoes as one step', () => {
  it('front on the bottom box puts it on top, dirties the pane, and Save writes every rank', async () => {
    const w = mountPane()
    await settle()
    expect(stack(w)).toEqual(FILE_ORDER)
    await select(w, 'n-a')
    await layer(w, 'front')

    expect(stack(w).at(-1)).toBe('n-a')
    expect(isDirty(w)).toBe(true)
    const doc = await saveAndRead(w)
    const zs = doc.nodes.map((n) => n.zIndex)
    expect(zs.every((z) => typeof z === 'number')).toBe(true)
    expect(zIndexOf(doc, 'n-a')).toBe(Math.max(...(zs as number[])))
    expect(doc.edges[0].zIndex).toBeUndefined()
  })

  it('one ctrl+z restores the file order and Save then writes no zIndex; ctrl+y restacks', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a')
    await layer(w, 'front')
    expect(stack(w).at(-1)).toBe('n-a')

    await undo(w)
    expect(stack(w)).toEqual(FILE_ORDER)
    // ONE undo step for the whole move: nothing is left to undo.
    expect(undoDisabled(w)).toBe(true)
    const doc = await saveAndRead(w)
    expect(doc.nodes.filter((n) => n.zIndex !== undefined)).toEqual([])

    await redo(w)
    expect(stack(w).at(-1)).toBe('n-a')
  })

  it('multi-select front keeps the selection order: n-c, n-a, n-b, and one undo restores it', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a', 'n-b')
    expect(selectedIds(w)).toEqual(['n-a', 'n-b'])
    await layer(w, 'front')
    expect(stack(w)).toEqual(['n-m', 'n-c', 'n-a', 'n-b'])

    await undo(w)
    expect(stack(w)).toEqual(FILE_ORDER)
    expect(undoDisabled(w)).toBe(true)
  })
})

// ── Review Focus 4: a no-op writes nothing; z never reaches the edges ───────
describe('DiagramPane layers — Review Focus 4: no-ops and the floor at 1', () => {
  it('front and forward on the top node write nothing; back keeps every z >= 1 and the edge at 0', async () => {
    const w = mountPane()
    await settle()
    expect(stack(w).at(-1)).toBe('n-c')
    await select(w, 'n-c')
    await layer(w, 'front')
    await layer(w, 'forward')
    expect(isDirty(w)).toBe(false)
    expect(undoDisabled(w)).toBe(true)
    expect(stack(w)).toEqual(FILE_ORDER)

    await select(w, 'n-a')
    await layer(w, 'back')
    expect(stack(w)[0]).toBe('n-a')
    const z = zOf(w)
    for (const id of FILE_ORDER) expect(z[id], id).toBeGreaterThanOrEqual(1)
    expect(z['e-1']).toBe(0)
  })

  it('a move on a clean board that changes nothing leaves it clean with Undo disabled', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-m')
    await layer(w, 'back')
    await layer(w, 'backward')
    expect(isDirty(w)).toBe(false)
    expect(undoDisabled(w)).toBe(true)
  })
})

// ── Review Focus 2: a node drawn after a restack lands on top after a reload ─
describe('DiagramPane layers — Review Focus 2: Save, draw, Save, reload', () => {
  it('a box drawn after a saved restack is the top node once the file is read back', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a')
    await layer(w, 'front')
    await saveAndRead(w)

    focusPane(w)
    key('r')
    await settle()
    down(svgOf(w), [400, 300])
    move([500, 380])
    up([500, 380])
    await settle()
    const saved = await saveAndRead(w)
    const drawn = saved.nodes.filter((n) => !FILE_ORDER.includes(n.id))
    expect(drawn).toHaveLength(1)

    canvasRead.mockImplementation(async (p: string) => ({ ok: true, path: p, doc: saved }))
    await reloadFromDisk(w)
    expect(stack(w).at(-1)).toBe(drawn[0].id)
    expect(stack(w).at(-2)).toBe('n-a')
  })
})

// ── Review Focus 3: a theme redraw keeps the order and the history ───────────
describe('DiagramPane layers — Review Focus 3: a theme switch', () => {
  afterEach(() => useThemeStore().set('default-dark'))

  it('keeps the live order and z, and undo/redo after it still walk the same steps', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a')
    await layer(w, 'front')
    const order = stack(w)
    const z = zOf(w)
    expect(order.at(-1)).toBe('n-a')

    const before = nodeEl(w, 'n-a')
    document.documentElement.style.setProperty('--color-surface', '#200002')
    useThemeStore().set('light')
    await settleUntil(() => nodeEl(w, 'n-a') !== null && nodeEl(w, 'n-a') !== before)
    expect(nodeEl(w, 'n-a')).not.toBe(before)

    expect(stack(w)).toEqual(order)
    expect(zOf(w)).toEqual(z)

    await undo(w)
    expect(stack(w)).toEqual(FILE_ORDER)
    // The redo stack survived the redraw.
    expect(redoDisabled(w)).toBe(false)
    await redo(w)
    expect(stack(w).at(-1)).toBe('n-a')
    expect(zOf(w)).toEqual(z)
  })
  it('redo after the switch lands the exact order, even where the live z are not dense ranks', async () => {
    // The file's own z values render verbatim (all distinct, all > 0) — with gaps.
    // A drawn box takes X6's max + 1 (31). `back` on n-a then writes only the nodes
    // whose rank changes: n-m is already at rank 2 and is NOT written. Undo leaves
    // the board at the gapped values with the move on the redo stack. A redraw that
    // re-ranked those (the Save rule would, the drawn box having no file z) would
    // move n-m to 1 under the redo's n-a = 1: a tie, and n-a no longer at the bottom.
    const gapped: CanvasDocument = {
      ...DOC,
      nodes: DOC.nodes.map((n) => ({
        ...n,
        zIndex: { 'n-m': 2, 'n-a': 10, 'n-b': 20, 'n-c': 30 }[n.id]
      }))
    }
    canvasRead.mockImplementation(async (p: string) => ({ ok: true, path: p, doc: gapped }))
    const w = mountPane()
    await settle()
    focusPane(w)
    key('r')
    await settle()
    down(svgOf(w), [400, 300])
    move([500, 380])
    up([500, 380])
    await settle()
    const drawn = stack(w).at(-1)!
    expect(FILE_ORDER).not.toContain(drawn)

    focusPane(w)
    key('v')
    await settle()
    await select(w, 'n-a')
    await layer(w, 'back')
    const moved = stack(w)
    expect(moved).toEqual(['n-a', 'n-m', 'n-b', 'n-c', drawn])
    await undo(w)
    expect(stack(w)).toEqual([...FILE_ORDER, drawn])
    const z = zOf(w)

    const before = nodeEl(w, 'n-a')
    document.documentElement.style.setProperty('--color-surface', '#200002')
    useThemeStore().set('light')
    await settleUntil(() => nodeEl(w, 'n-a') !== null && nodeEl(w, 'n-a') !== before)
    expect(zOf(w)).toEqual(z)
    expect(redoDisabled(w)).toBe(false)

    await redo(w)
    expect(stack(w)).toEqual(moved)
    const after = zOf(w)
    const nodeZ = moved.map((id) => after[id])
    expect(new Set(nodeZ).size).toBe(moved.length)
  })
})

// ── Review Focus 5: every node kind, edges ignored ──────────────────────────
describe('DiagramPane layers — Review Focus 5: who gets the Layers group', () => {
  it('the mockup card alone shows Layers and no style group', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-m')
    expect(selectedIds(w)).toEqual(['n-m'])
    expect(layersShown(w)).toBe(true)
    expect(styleGroups(w)).toBe(0)
  })

  it('ctrl+a shows Layers, and back restacks the nodes but never the edge', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('a', { ctrlKey: true })
    await settle()
    expect(selectedIds(w)).toContain('e-1')
    expect(layersShown(w)).toBe(true)

    // Everything to the back: the nodes keep their order, so nothing moves.
    await layer(w, 'back')
    expect(stack(w)).toEqual(FILE_ORDER)
    expect(zOf(w)['e-1']).toBe(0)

    // A real move with the edge still selected: the edge is in no reorder.
    await select(w, 'n-a', 'e-1')
    expect(selectedIds(w)).toEqual(['e-1', 'n-a'])
    await layer(w, 'front')
    expect(stack(w).at(-1)).toBe('n-a')
    expect(zOf(w)['e-1']).toBe(0)
    const doc = await saveAndRead(w)
    expect(doc.edges[0].zIndex).toBeUndefined()
  })

  it('an edge alone shows no panel', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'e-1')
    expect(selectedIds(w)).toEqual(['e-1'])
    expect(w.find('[data-testid="canvas-properties"]').exists()).toBe(false)
  })
})

// ── creation paths and the agent ────────────────────────────────────────────
describe('DiagramPane layers — duplicates and agent writes', () => {
  it('ctrl+d after a back puts the copy on top of the stack', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a')
    await layer(w, 'back')
    expect(stack(w)[0]).toBe('n-a')
    focusPane(w)
    key('d', { ctrlKey: true })
    await settle()
    const top = stack(w).at(-1)!
    expect(FILE_ORDER).not.toContain(top)
  })

  it('an agent write with zIndex 10 on n-a, while clean, reloads with n-a on top', async () => {
    const w = mountPane()
    await settle()
    expect(stack(w)).toEqual(FILE_ORDER)
    const written: CanvasDocument = {
      ...DOC,
      nodes: DOC.nodes.map((n) => (n.id === 'n-a' ? { ...n, zIndex: 10 } : n))
    }
    canvasRead.mockImplementation(async (p: string) => ({ ok: true, path: p, doc: written }))
    await reloadFromDisk(w)
    expect(stack(w).at(-1)).toBe('n-a')
    expect(zOf(w)['e-1']).toBe(0)
  })
})
