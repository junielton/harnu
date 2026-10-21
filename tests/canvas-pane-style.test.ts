// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import type { CanvasDocument } from '../src/main/canvas-core'
import CanvasPropertiesPanel from '../src/renderer/src/components/CanvasPropertiesPanel.vue'
import { stylePanelTop } from '../src/renderer/src/components/canvas/canvas-style'
import { MOCKUP_CARD_SHAPE } from '../src/renderer/src/components/canvas/shapes/mockup-card'
import { useThemeStore } from '../src/renderer/src/stores/theme'
import { installJsdomSvgShim } from './helpers/jsdom-svg'
import {
  bodyOf,
  down,
  focusPane,
  key,
  keyUp,
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
 * T536 U3 — the properties panel wired into the canvas pane: what it shows for a
 * selection, what a pick writes, and how that write behaves under undo and a
 * theme switch. The panel's own rendering is `canvas-properties-panel.test.ts`;
 * this file is the pane's half (Review Focus 1, 4 and 5 of the U3 plan).
 *
 * The palette is pinned through CSS variables on `<html>`, so a colour the board
 * paints can be compared with the token it must come from — and switched, to
 * stand in for a theme change.
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
      id: 'n-e',
      shape: 'ellipse',
      x: 40,
      y: 320,
      width: 132,
      height: 52,
      label: 'E',
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
  edges: [{ id: 'e-1', source: 'n-a', target: 'n-b', label: 'IPC', origin: 'agent' }]
}
const SEEDED = DOC.nodes.map((n) => n.id)

/** Where to press inside each node — the jsdom CTM is the identity. */
const AT: Record<string, [number, number]> = {
  'n-a': [100, 60],
  'n-b': [380, 220],
  'n-e': [100, 340],
  'n-c': [100, 230],
  'n-m': [700, 100],
  'e-1': [250, 150]
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
  vi.unstubAllGlobals()
})

// ── helpers ─────────────────────────────────────────────────────────────────
/** Click a cell in Select: the first replaces the selection, the rest add with shift. */
async function select(w: VueWrapper, ...ids: string[]): Promise<void> {
  // X6 draws views in time-sliced jobs (an arrow after the shapes it joins), so on a busy
  // runner a cell can still be missing after a fixed number of ticks: wait until it exists.
  await settleUntil(() => ids.every((id) => nodeEl(w, id) !== null))
  ids.forEach((id, i) => {
    const init = i === 0 ? {} : { shiftKey: true }
    down(nodeEl(w, id), AT[id], init)
    up(AT[id], init)
  })
  await settle()
}

/**
 * Settle until `done()` holds, bounded by wall time: X6 draws a view update in
 * time-sliced jobs, so how many ticks a repaint takes depends on how busy the run
 * is. The caller's own assertion reports a condition that never came true.
 */
async function settleUntil(done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  do await settle()
  while (!done() && Date.now() < deadline)
}

/** The selected cells, read off the class X6's Selection puts on their views. */
function selectedIds(w: VueWrapper): string[] {
  return [...svgOf(w).querySelectorAll('.x6-node-selected, .x6-edge-selected')]
    .map((el) => el.getAttribute('data-cell-id') ?? '?')
    .sort()
}

const panel = (w: VueWrapper): boolean => w.find('[data-testid="canvas-properties"]').exists()
const groups = (w: VueWrapper): string[] =>
  w
    .findAll('[data-testid^="canvas-prop-group-"]')
    .map((g) => g.attributes('data-testid')!.replace('canvas-prop-group-', ''))
const layers = (w: VueWrapper): boolean => w.find('[data-testid="canvas-layers"]').exists()
const isDirty = (w: VueWrapper): boolean => w.find('[data-testid="diagram-dirty-dot"]').exists()

async function pick(w: VueWrapper, key: string, value: string | number): Promise<void> {
  const option = w.find(`[data-testid="canvas-prop-${key}-${value}"]`)
  expect(option.exists(), `no option ${key}-${value}`).toBe(true)
  await option.trigger('mousedown')
  await option.trigger('click')
  await settle()
}

/**
 * An attribute of a framed node's body shape as X6 drew it — `undefined` while
 * the node has no view (mid-redraw), so "attribute absent" (`null`) stays a
 * distinct, assertable answer.
 */
function bodyAttr(w: VueWrapper, id: string, attr: string): string | null | undefined {
  const body = nodeEl(w, id)?.querySelector('rect, ellipse, polygon')
  return body ? body.getAttribute(attr) : undefined
}
function labelFill(w: VueWrapper, id: string): string | null | undefined {
  const label = nodeEl(w, id)?.querySelector('text')
  return label ? label.getAttribute('fill') : undefined
}
/** Wait for the repaint, then assert what the body shows. */
async function expectBody(
  w: VueWrapper,
  id: string,
  attr: string,
  value: string | null
): Promise<void> {
  await settleUntil(() => bodyAttr(w, id, attr) === value)
  expect(bodyAttr(w, id, attr), `${id} ${attr}`).toBe(value)
}

const nodeOf = (doc: CanvasDocument, id: string): CanvasDocument['nodes'][number] =>
  doc.nodes.find((n) => n.id === id)!

/**
 * Switch theme and wait for the redraw to LAND: the board is rebuilt from the
 * working state, and X6 draws the new views over several macrotasks.
 */
async function switchTheme(w: VueWrapper, vars: Record<string, string>): Promise<void> {
  const before = nodeEl(w, 'n-a')
  applyPalette(vars)
  useThemeStore().set('light')
  await settleUntil(() => nodeEl(w, 'n-a') !== null && nodeEl(w, 'n-a') !== before)
}

// ── an arrow through delete, Save and undo ─────────────────────────────────
describe('DiagramPane — an arrow restored by undo after a Save (T536 U4)', () => {
  it('keeps its label, router and props in the second Save', async () => {
    const doc: CanvasDocument = {
      ...DOC,
      edges: [
        {
          id: 'e-1',
          source: 'n-a',
          target: 'n-b',
          label: 'IPC',
          router: 'normal',
          origin: 'agent',
          props: { weight: 2 }
        }
      ]
    }
    canvasRead.mockImplementation(async (p: string) => ({ ok: true, path: p, doc }))
    const w = mountPane()
    await settle()
    await select(w, 'e-1')
    expect(selectedIds(w)).toEqual(['e-1'])
    focusPane(w)
    key('Delete')
    await settle()
    expect((await saveAndRead(w)).edges).toEqual([])

    // Save keeps the undo history, and the pane's own write is not echoed back, so
    // the graph restores the arrow while the base document no longer has it.
    focusPane(w)
    key('z', { ctrlKey: true })
    await settle()
    const saved = await saveAndRead(w)
    expect(saved.edges).toEqual([
      {
        id: 'e-1',
        source: 'n-a',
        target: 'n-b',
        label: 'IPC',
        router: 'normal',
        origin: 'agent',
        props: { weight: 2 }
      }
    ])
  })
})

// ── visibility ──────────────────────────────────────────────────────────────
describe('DiagramPane properties panel — when it shows', () => {
  it('shows for a selected node in Select only, and holding Space keeps it', async () => {
    const w = mountPane()
    await settle()
    expect(panel(w)).toBe(false)

    await select(w, 'n-a')
    expect(panel(w)).toBe(true)

    focusPane(w)
    key('r')
    await settle()
    expect(panel(w)).toBe(false)
    key('v')
    await settle()
    expect(panel(w)).toBe(true)

    // Space is a temporary Hand, not a tool choice: the panel stays.
    key(' ')
    await settle()
    expect(bodyOf(w).style.cursor).toBe('grab')
    expect(panel(w)).toBe(true)
    keyUp(' ')
    await settle()
  })

  it('Review Focus 4: shows only the keys every selected node takes, and ignores edges', async () => {
    const w = mountPane()
    await settle()

    // Everything, edge included: the mockup card takes no key, so none is shared.
    // T536 U4 changed this ON PURPOSE: it used to show no panel at all; now the
    // panel shows for any node selection, with the Layers group and no style group.
    focusPane(w)
    key('a', { ctrlKey: true })
    await settle()
    expect(selectedIds(w)).toContain('n-m')
    expect(panel(w)).toBe(true)
    expect(layers(w)).toBe(true)
    expect(groups(w)).toEqual([])

    // A box plus the mockup card: no shared key, so again Layers alone (T536 U4).
    await select(w, 'n-a', 'n-m')
    expect(selectedIds(w)).toEqual(['n-a', 'n-m'])
    expect(panel(w)).toBe(true)
    expect(layers(w)).toBe(true)
    expect(groups(w)).toEqual([])

    // A box, an ellipse and the edge: the ellipse has no corners; the edge is ignored.
    await select(w, 'n-a', 'n-e', 'e-1')
    expect(selectedIds(w)).toEqual(['e-1', 'n-a', 'n-e'])
    expect(groups(w)).toEqual(['tone', 'stroke', 'strokeWidth', 'fontSize', 'align', 'opacity'])

    await pick(w, 'fontSize', 'l')
    const doc = await saveAndRead(w)
    expect(nodeOf(doc, 'n-a').props).toEqual({ style: { fontSize: 'l' } })
    expect(nodeOf(doc, 'n-e').props).toEqual({ style: { fontSize: 'l' } })
    expect(doc.edges[0].props).toBeUndefined()
  })

  it('Review Focus 4: a key one node takes is never written onto another that does not', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a')
    await pick(w, 'corners', 'sharp')

    await select(w, 'n-a', 'n-e')
    expect(groups(w)).not.toContain('corners')
    await pick(w, 'tone', 'red')

    const doc = await saveAndRead(w)
    expect(nodeOf(doc, 'n-e').props).toEqual({ style: { tone: 'red' } })
    expect(nodeOf(doc, 'n-a').props).toEqual({ style: { corners: 'sharp', tone: 'red' } })
  })

  it('Review Focus 4: the pane filters a patch per node, whatever the panel sends', async () => {
    // The panel only offers shared keys, so this patch cannot be clicked; the pane
    // must still not trust its input to be pre-filtered.
    const w = mountPane()
    await settle()
    await select(w, 'n-a', 'n-e')
    w.findComponent(CanvasPropertiesPanel).vm.$emit('change', { corners: 'sharp', tone: 'red' })
    await settle()
    const doc = await saveAndRead(w)
    expect(nodeOf(doc, 'n-e').props).toEqual({ style: { tone: 'red' } })
    expect(nodeOf(doc, 'n-a').props).toEqual({ style: { corners: 'sharp', tone: 'red' } })
  })

  it('an edge alone shows no panel', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'e-1')
    expect(selectedIds(w)).toEqual(['e-1'])
    expect(panel(w)).toBe(false)
  })

  it('a mixed value checks no option in its group', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a')
    await pick(w, 'tone', 'green')
    await select(w, 'n-a', 'n-b')
    const checked = w.findAll('[data-testid^="canvas-prop-tone-"][aria-checked="true"]')
    expect(checked).toHaveLength(0)
    // The other groups agree (both at their defaults), so they still check one.
    expect(w.find('[data-testid="canvas-prop-stroke-solid"]').attributes('aria-checked')).toBe(
      'true'
    )
  })
})

// ── writing a style ─────────────────────────────────────────────────────────
describe('DiagramPane properties panel — a pick styles the selected nodes', () => {
  it('a tone pick dirties the pane, saves into props.style and paints the token', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a')
    await pick(w, 'tone', 'green')

    expect(isDirty(w)).toBe(true)
    await expectBody(w, 'n-a', 'stroke', DARK['--color-green'])
    await expectBody(w, 'n-a', 'fill', DARK['--color-green-soft'])
    const doc = await saveAndRead(w)
    expect(nodeOf(doc, 'n-a').props).toEqual({ style: { tone: 'green' } })
  })

  it('a text node tone colours its label with the tone', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-c')
    expect(groups(w)).toEqual(['tone', 'fontSize', 'align', 'opacity'])
    await pick(w, 'tone', 'accent')
    await settleUntil(() => labelFill(w, 'n-c') === DARK['--color-accent'])
    expect(labelFill(w, 'n-c')).toBe(DARK['--color-accent'])
  })

  it('a pick on two nodes is ONE undo step, and redo puts both back', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a', 'n-b')
    await pick(w, 'stroke', 'dashed')
    await expectBody(w, 'n-a', 'stroke-dasharray', '6 4')

    focusPane(w)
    key('z', { ctrlKey: true })
    await settle()
    // The derived attribute is gone from the DOM too, not just from the model.
    await expectBody(w, 'n-a', 'stroke-dasharray', null)
    await expectBody(w, 'n-b', 'stroke-dasharray', null)
    let doc = await saveAndRead(w)
    expect(nodeOf(doc, 'n-a').props).toBeUndefined()
    expect(nodeOf(doc, 'n-b').props).toBeUndefined()

    focusPane(w)
    key('y', { ctrlKey: true })
    await settle()
    expect(w.find('[data-testid="diagram-save"]').attributes('disabled')).toBeUndefined()
    doc = await saveAndRead(w)
    expect(nodeOf(doc, 'n-a').props).toEqual({ style: { stroke: 'dashed' } })
    expect(nodeOf(doc, 'n-b').props).toEqual({ style: { stroke: 'dashed' } })
  })

  it('undo after a pick puts the panel back on the old value', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a')
    await pick(w, 'tone', 'red')
    focusPane(w)
    key('z', { ctrlKey: true })
    await settle()
    expect(w.find('[data-testid="canvas-prop-tone-default"]').attributes('aria-checked')).toBe(
      'true'
    )
  })

  it('picking the value already checked changes nothing: clean, nothing to undo', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a')
    // Selecting (and the port reveal the pointer triggers) is not an edit either.
    expect(w.find('[data-testid="diagram-undo"]').attributes('disabled')).toBeDefined()
    await pick(w, 'tone', 'default')
    expect(isDirty(w)).toBe(false)
    expect(w.find('[data-testid="diagram-undo"]').attributes('disabled')).toBeDefined()
  })

  it('⌘D copies the style with the node', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a')
    await pick(w, 'tone', 'amber')
    focusPane(w)
    key('d', { ctrlKey: true })
    await settle()
    const doc = await saveAndRead(w)
    const copies = doc.nodes.filter((n) => !SEEDED.includes(n.id))
    expect(copies).toHaveLength(1)
    expect(copies[0].props).toEqual(nodeOf(doc, 'n-a').props)
    expect(copies[0].props).toEqual({ style: { tone: 'amber' } })
  })
})

// ── Review Focus 1: undo after a theme switch ───────────────────────────────
describe('DiagramPane properties panel — Review Focus 1: undo never paints an old theme', () => {
  afterEach(() => useThemeStore().set('default-dark'))

  it('undo and redo after a theme switch resolve the NEW theme, and keep the redo stack', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a')
    await pick(w, 'tone', 'green')
    await expectBody(w, 'n-a', 'stroke', DARK['--color-green'])

    await switchTheme(w, LIGHT)
    await expectBody(w, 'n-a', 'stroke', LIGHT['--color-green'])

    focusPane(w)
    key('z', { ctrlKey: true })
    await expectBody(w, 'n-a', 'stroke', LIGHT['--color-border-2'])
    await expectBody(w, 'n-a', 'fill', LIGHT['--color-surface'])
    // Re-deriving the attrs on undo recorded nothing, so redo is still there.
    expect(w.find('[data-testid="diagram-redo"]').attributes('disabled')).toBeUndefined()

    focusPane(w)
    key('y', { ctrlKey: true })
    await expectBody(w, 'n-a', 'stroke', LIGHT['--color-green'])
    expect(w.find('[data-testid="diagram-undo"]').attributes('disabled')).toBeUndefined()
  })

  // Live matrix (T536 U3, row TH1): the theme redraw rebuilds every cell, which used to
  // drop the selection — and the properties panel with it — mid-edit.
  it('a theme switch keeps the selection, so the panel stays open on the same nodes', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a', 'n-b')
    expect(panel(w)).toBe(true)

    await switchTheme(w, LIGHT)
    await settle()
    expect(selectedIds(w)).toEqual(['n-a', 'n-b'])
    expect(panel(w)).toBe(true)
  })

  it('a theme switch keeps open resize handles on their node', async () => {
    const w = mountPane()
    await settle()
    const handles = (): Element[] => [...w.element.querySelectorAll('.x6-widget-transform')]
    // A real click is mousedown + mouseup + click; X6 opens the handles on `click`.
    const at = AT['n-a']
    focusPane(w)
    down(nodeEl(w, 'n-a'), at)
    for (const type of ['mouseup', 'click']) {
      nodeEl(w, 'n-a').dispatchEvent(
        new MouseEvent(type, { bubbles: true, button: 0, clientX: at[0], clientY: at[1] })
      )
    }
    await settle()
    expect(handles()).toHaveLength(1)
    const before = handles()[0]

    await switchTheme(w, LIGHT)
    await settle()
    expect(handles()).toHaveLength(1)
    // A NEW widget, on the new view of the same node.
    expect(handles()[0]).not.toBe(before)
    expect(selectedIds(w)).toEqual(['n-a'])
  })

  // Final review M2: X6 keeps a Transform widget entry for a node that was deleted, so a
  // later theme switch used to reopen handles on a node that undo had brought back as a
  // NEW instance — with nothing selected.
  it('a theme switch does not reopen handles on a node deleted and restored by undo', async () => {
    const w = mountPane()
    await settle()
    const handles = (): Element[] => [...w.element.querySelectorAll('.x6-widget-transform')]
    const at = AT['n-a']
    focusPane(w)
    down(nodeEl(w, 'n-a'), at)
    for (const type of ['mouseup', 'click']) {
      nodeEl(w, 'n-a').dispatchEvent(
        new MouseEvent(type, { bubbles: true, button: 0, clientX: at[0], clientY: at[1] })
      )
    }
    await settle()
    expect(handles()).toHaveLength(1)

    focusPane(w)
    key('Delete')
    await settle()
    expect(handles()).toHaveLength(0)
    focusPane(w)
    key('z', { ctrlKey: true })
    await settle()
    expect(handles()).toHaveLength(0)
    expect(selectedIds(w)).toEqual([])

    await switchTheme(w, LIGHT)
    await settle()
    expect(handles()).toHaveLength(0)
    expect(selectedIds(w)).toEqual([])
  })

  it('a theme switch recolours a styled board and leaves the pane clean', async () => {
    const styled: CanvasDocument = {
      ...DOC,
      nodes: DOC.nodes.map((n) =>
        n.id === 'n-a' ? { ...n, props: { style: { tone: 'green' } } } : n
      )
    }
    canvasRead.mockImplementation(async (p: string) => ({ ok: true, path: p, doc: styled }))
    const w = mountPane()
    await settle()
    await expectBody(w, 'n-a', 'stroke', DARK['--color-green'])

    await switchTheme(w, LIGHT)
    await expectBody(w, 'n-a', 'stroke', LIGHT['--color-green'])
    expect(isDirty(w)).toBe(false)
  })
})

// ── Review Focus 5: the panel does not disturb the board ────────────────────
describe('DiagramPane properties panel — Review Focus 5: using it leaves the board alone', () => {
  it('a press and click on a swatch keep the selection and start no rubberband or draw', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a', 'n-b')
    const before = selectedIds(w)
    expect(before).toEqual(['n-a', 'n-b'])

    const swatch = w.find('[data-testid="canvas-prop-tone-green"]').element
    down(swatch, [20, 120])
    expect(w.element.querySelector('.x6-widget-selection-rubberband')).toBeNull()
    expect(w.find('[data-testid="diagram-draw-preview"]').exists()).toBe(false)
    up([20, 120])
    swatch.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    await settle()

    expect(selectedIds(w)).toEqual(before)
    expect(w.element.querySelector('.x6-widget-selection-rubberband')).toBeNull()
    expect(w.find('[data-testid="diagram-draw-preview"]').exists()).toBe(false)
    expect(panel(w)).toBe(true)
  })

  it('Space on a focused panel option does not pan: the tool stays Select', async () => {
    const w = mountPane()
    await settle()
    await select(w, 'n-a')
    const option = w.find('[data-testid="canvas-prop-tone-green"]').element as HTMLElement
    option.focus()
    expect(document.activeElement).toBe(option)
    key(' ')
    await settle()
    expect(bodyOf(w).style.cursor).toBe('default')
    expect(panel(w)).toBe(true)
    keyUp(' ')
  })
})

// ── narrow panes ────────────────────────────────────────────────────────────
describe('DiagramPane properties panel — narrow panes', () => {
  it('below 384px it folds into a toggle that opens it in place', async () => {
    let tick: (() => void) | null = null
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          tick = cb
        }
        // Ticks are driven by hand below, so neither needs to do anything.
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
    const w = mountPane()
    await settle()
    Object.defineProperty(bodyOf(w), 'clientWidth', { configurable: true, value: 320 })
    tick!()
    await settle()

    await select(w, 'n-a')
    expect(w.find('[data-testid="canvas-properties-toggle"]').exists()).toBe(true)
    expect(groups(w)).toEqual([])

    await w.find('[data-testid="canvas-properties-toggle"]').trigger('click')
    await settle()
    expect(groups(w)).toContain('tone')
  })

  // Final review I1: the redraw empties the selection for a tick, which used to fold the
  // opened panel shut — and the folded toggle is the default layout (about 243px).
  it('a theme switch keeps the folded panel open below 384px', async () => {
    let tick: (() => void) | null = null
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          tick = cb
        }
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
    const w = mountPane()
    await settle()
    Object.defineProperty(bodyOf(w), 'clientWidth', { configurable: true, value: 320 })
    tick!()
    await settle()

    await select(w, 'n-a')
    await w.find('[data-testid="canvas-properties-toggle"]').trigger('click')
    await settle()
    expect(groups(w)).toContain('tone')

    await switchTheme(w, LIGHT)
    await settle()
    expect(selectedIds(w)).toEqual(['n-a'])
    expect(groups(w)).toContain('tone')
    expect(w.find('[data-testid="canvas-properties-toggle"]').attributes('aria-expanded')).toBe(
      'true'
    )
  })

  it('when the toolbar drops to its own row, the panel moves under it — not under its old place', async () => {
    let tick: (() => void) | null = null
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          tick = cb
        }
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
    const w = mountPane()
    await settle()

    // jsdom has no layout: give the chrome the geometry the real app measures.
    const pin = (el: Element, props: Record<string, () => number>): void => {
      for (const [name, get] of Object.entries(props)) {
        Object.defineProperty(el, name, { configurable: true, get })
      }
    }
    let width = 1000
    pin(bodyOf(w), { clientWidth: () => width })
    const cluster = w.get('[data-testid="diagram-zoom"]').element.parentElement!
    pin(cluster, {
      offsetLeft: () => 12,
      offsetWidth: () => 120,
      offsetTop: () => 12,
      offsetHeight: () => 36
    })
    pin(w.get('[role="toolbar"]').element, { offsetWidth: () => 300 })
    // The toolbar's slot: centred at the top, or `top-14` on its own row.
    const slot = w.get('[data-testid="canvas-toolbar"]').element.parentElement!
    pin(slot, {
      offsetTop: () => (slot.className.includes('top-14') ? 56 : 12),
      offsetHeight: () => 36
    })
    const panelTop = (): number =>
      parseFloat(
        (w.get('[data-testid="canvas-properties"]').element.parentElement as HTMLElement).style.top
      )

    tick!()
    await settle()
    await select(w, 'n-a')
    expect(panelTop()).toBe(stylePanelTop(48, false, 48))

    // One resize step across the own-row threshold, still wide enough for the panel.
    width = 400
    tick!()
    await settle()
    expect(slot.className).toContain('top-14')
    expect(panelTop()).toBe(stylePanelTop(48, true, 56 + 36))
    expect(panelTop()).toBeGreaterThan(56 + 36)
  })
})

// ── a text node is clickable anywhere in its frame (live row X4b) ───────────
describe('DiagramPane — a left or right aligned text node is clickable anywhere in its frame', () => {
  /**
   * Four bare text nodes, 132×40 with a short label, as in the live row: aligned
   * left or right, the glyphs sit against one edge and leave the frame centre
   * (x = 66) uncovered.
   */
  const TEXTS: CanvasDocument['nodes'] = [
    ['t-sl', 's', 'left'],
    ['t-sr', 's', 'right'],
    ['t-ml', undefined, 'left'],
    ['t-mr', undefined, 'right']
  ].map(([id, fontSize, align], i) => ({
    id: id as string,
    shape: 'text',
    x: 40,
    y: 40 + i * 80,
    width: 132,
    height: 40,
    label: 'Text note',
    origin: 'operator' as const,
    props: { style: { align: align as string, ...(fontSize ? { fontSize } : {}) } }
  }))
  const TEXT_DOC: CanvasDocument = { ...DOC, nodes: TEXTS, edges: [] }

  /**
   * jsdom does not hit-test, so this applies the SVG rule the browser does
   * (`pointer-events: visiblePainted`): a point inside a shape hits it only where
   * its fill is painted, and `fill="none"` is not painted. With the label away
   * from the centre, the only shape that can cover the frame centre is a
   * full-frame rect; when it paints nothing, the press lands on the blank board.
   */
  function hitAtFrameCentre(w: VueWrapper, n: CanvasDocument['nodes'][number]): Element {
    const rect = [...(nodeEl(w, n.id)?.querySelectorAll('rect') ?? [])].find(
      (r) =>
        r.getAttribute('width') === String(n.width) && r.getAttribute('height') === String(n.height)
    )
    const fill = rect?.getAttribute('fill')
    const painted =
      rect !== undefined && fill !== 'none' && rect.getAttribute('pointer-events') !== 'none'
    return painted ? rect : svgOf(w)
  }

  for (const n of TEXTS) {
    const style = (n.props as { style: Record<string, string> }).style
    it(`size ${style.fontSize ?? 'm'}, align ${style.align}: a press at the frame centre selects it`, async () => {
      canvasRead.mockImplementation(async (p: string) => ({ ok: true, path: p, doc: TEXT_DOC }))
      const w = mountPane()
      await settle()
      const centre: [number, number] = [n.x + n.width! / 2, n.y + n.height! / 2]
      down(hitAtFrameCentre(w, n), centre)
      up(centre)
      await settle()
      expect(selectedIds(w)).toEqual([n.id])
    })
  }
})
