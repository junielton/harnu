// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import { Graph } from '@antv/x6'
import DiagramPane from '../src/renderer/src/components/DiagramPane.vue'
import {
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  CANVAS_PLUGIN_NAMES,
  createCanvasGraph,
  fitCanvas,
  missingCanvasPlugins,
  renderCanvasDocument,
  zoomCanvasBy
} from '../src/renderer/src/components/canvas/canvas-graph'
import { readCanvasPalette } from '../src/renderer/src/components/canvas/canvas-theme'
import {
  CANVAS_SUFFIX as RENDERER_CANVAS_SUFFIX,
  hasCanvasSuffix as rendererHasCanvasSuffix
} from '../src/renderer/src/lib/canvas-suffix'
import { CANVAS_SUFFIX } from '../src/main/canvas-core'
import { paneComponents } from '../src/renderer/src/lib/pane-components'
import { paneRegistry } from '../src/renderer/src/lib/pane-registry'
import { i18n } from '@renderer/i18n'
import type { CanvasDocument } from '../src/main/canvas-core'
import { installJsdomSvgShim, svgHost } from './helpers/jsdom-svg'

// jsdom implements the SVG tree but none of its geometry — X6 cannot construct
// a graph without it. See the shim's header: it polyfills a jsdom gap, it does
// not stub X6.
installJsdomSvgShim()

/**
 * Render contract for the T218 U2 canvas pane.
 *
 * The load-bearing case is **"all four X6 plugins load"** (AC U2-5). The
 * `@antv/x6` pin exists because core 3.x has no working plugin ecosystem — the
 * 2.x plugins throw `TypeError: t.View.dispose is not a function` against it,
 * and the published 3.0.0 plugin packages ship zero `.js` files — while the
 * plugins' npm `latest` tag still points at 2.x, so an unpinned install
 * silently produces the broken pairing. These tests ask the graph for each
 * plugin INSTANCE rather than checking that nothing threw, because a plugin can
 * register and be inert; that difference is the whole guard.
 */

/** A container carrying the layout jsdom will not compute (see the shim). */
const host = svgHost

const DOC: CanvasDocument = {
  capycanvas: 1,
  meta: { title: 'Hand-written board' },
  nodes: [
    {
      id: 'n-a',
      shape: 'box',
      x: 40,
      y: 40,
      width: 132,
      height: 52,
      label: 'Browser',
      origin: 'operator'
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
    { id: 'n-c', shape: 'text', x: 40, y: 220, label: 'annotation', origin: 'operator' }
  ],
  edges: [{ id: 'e-1', source: 'n-a', target: 'n-b', label: 'reads', origin: 'agent' }]
}

describe('canvas-graph — the §3.4 version-pin guard (U2-5)', () => {
  let graph: Graph | null = null
  afterEach(() => {
    graph?.dispose()
    graph = null
  })

  it('installs all four plugins, and each one is retrievable by name', () => {
    graph = createCanvasGraph({
      container: host(),
      palette: readCanvasPalette(),
      width: 800,
      height: 600
    })
    for (const name of CANVAS_PLUGIN_NAMES) {
      // getPlugin returns the INSTANCE — the only honest proof it loaded.
      expect(graph.getPlugin(name), `X6 plugin "${name}" did not load`).toBeTruthy()
    }
  })

  it('missingCanvasPlugins reports an empty list against the pinned versions', () => {
    graph = createCanvasGraph({
      container: host(),
      palette: readCanvasPalette(),
      width: 800,
      height: 600
    })
    expect(missingCanvasPlugins(graph)).toEqual([])
  })

  it('missingCanvasPlugins names what is absent — it does not just count', () => {
    // A bare graph with no `use()` calls stands in for the broken 3.x pairing:
    // the failure mode this guard exists for is plugins that do not register.
    const bare = new Graph({ container: host(), width: 800, height: 600 })
    expect(missingCanvasPlugins(bare).sort()).toEqual([...CANVAS_PLUGIN_NAMES].sort())
    bare.dispose()
  })

  it('the four plugin packages are the 2.x line the pin names', async () => {
    // Reads the resolved versions rather than package.json's ranges, so a
    // hoisted or overridden install is caught too.
    const versions = await Promise.all(
      ['selection', 'history', 'transform', 'snapline'].map(async (n) => {
        const pkg = await import(`@antv/x6-plugin-${n}/package.json`)
        return [n, (pkg.default ?? pkg).version as string] as const
      })
    )
    for (const [name, version] of versions) {
      expect(version.startsWith('2.'), `@antv/x6-plugin-${name} is ${version}, not 2.x`).toBe(true)
    }
  })
})

describe('canvas-graph — rendering a document', () => {
  let graph: Graph | null = null
  afterEach(() => {
    graph?.dispose()
    graph = null
  })

  it('renders every node and edge from the document', () => {
    graph = createCanvasGraph({
      container: host(),
      palette: readCanvasPalette(),
      width: 800,
      height: 600
    })
    renderCanvasDocument(graph, DOC, readCanvasPalette())
    expect(
      graph
        .getNodes()
        .map((n) => n.id)
        .sort()
    ).toEqual(['n-a', 'n-b', 'n-c'])
    expect(graph.getEdges().map((e) => e.id)).toEqual(['e-1'])
  })

  it('a re-render replaces the contents rather than accumulating them', () => {
    graph = createCanvasGraph({
      container: host(),
      palette: readCanvasPalette(),
      width: 800,
      height: 600
    })
    renderCanvasDocument(graph, DOC, readCanvasPalette())
    renderCanvasDocument(graph, DOC, readCanvasPalette())
    expect(graph.getNodes()).toHaveLength(3)
  })

  it('a re-render does NOT move the viewport (AC U2-8)', () => {
    graph = createCanvasGraph({
      container: host(),
      palette: readCanvasPalette(),
      width: 800,
      height: 600
    })
    renderCanvasDocument(graph, DOC, readCanvasPalette())
    graph.zoomTo(1.75)
    graph.translate(120, -60)
    const scale = graph.zoom()
    const translate = graph.translate()
    renderCanvasDocument(graph, DOC, readCanvasPalette())
    expect(graph.zoom()).toBe(scale)
    expect(graph.translate()).toEqual(translate)
  })

  it('recolouring re-renders every cell from the NEW palette (AC U2-4)', () => {
    const first = { ...readCanvasPalette(), surface: '#111111', accent: '#222222' }
    const second = { ...readCanvasPalette(), surface: '#333333', accent: '#444444' }
    graph = createCanvasGraph({ container: host(), palette: first, width: 800, height: 600 })
    renderCanvasDocument(graph, DOC, first)
    expect(graph.getCellById('n-a').attr('body/fill')).toBe('#111111')
    renderCanvasDocument(graph, DOC, second)
    expect(graph.getCellById('n-a').attr('body/fill')).toBe('#333333')
    expect(graph.getCellById('e-1').attr('line/stroke')).toBe('#444444')
  })

  it('clamps zoom at both ends', () => {
    graph = createCanvasGraph({
      container: host(),
      palette: readCanvasPalette(),
      width: 800,
      height: 600
    })
    for (let i = 0; i < 40; i++) zoomCanvasBy(graph, 1.5)
    expect(graph.zoom()).toBeCloseTo(CANVAS_MAX_SCALE, 5)
    for (let i = 0; i < 60; i++) zoomCanvasBy(graph, 1 / 1.5)
    expect(graph.zoom()).toBeCloseTo(CANVAS_MIN_SCALE, 5)
  })

  it('fit is a no-op on an empty document — it has no box to fit', () => {
    graph = createCanvasGraph({
      container: host(),
      palette: readCanvasPalette(),
      width: 800,
      height: 600
    })
    const before = graph.zoom()
    fitCanvas(graph)
    expect(graph.zoom()).toBe(before)
  })
})

describe('canvas pane registration', () => {
  it('the renderer suffix constant matches the pure core', () => {
    // The renderer cannot value-import `canvas-core.ts` (it transitively pulls
    // `node:path`), so the constant is mirrored — and pinned here so it cannot
    // drift silently.
    expect(RENDERER_CANVAS_SUFFIX).toBe(CANVAS_SUFFIX)
  })

  it('the renderer routes both the current and the legacy suffix to the canvas pane (AC-3)', () => {
    expect(rendererHasCanvasSuffix('/r/.harnu/out/canvas/b.harnucanvas.json')).toBe(true)
    expect(rendererHasCanvasSuffix('/r/.capy/out/canvas/b.capycanvas.json')).toBe(true)
    expect(rendererHasCanvasSuffix('/r/package.json')).toBe(false)
  })

  it('the canvas pane type renders DiagramPane', () => {
    expect(paneComponents.canvas).toBe(DiagramPane)
  })

  it('a canvas pane persists and dedupes by filePath', () => {
    const entry = paneRegistry.canvas
    expect(entry.persistable).toBe(true)
    expect(
      entry.dedupKey?.({
        id: 'h-1',
        type: 'canvas',
        cwd: '/wt',
        ratio: 1,
        filePath: '/wt/b.harnucanvas.json'
      })
    ).toBe('/wt/b.harnucanvas.json')
    expect(entry.maxInstances).toBe(4)
  })

  it('a canvas pane requests no PTY', () => {
    expect(paneRegistry.canvas.ptyKind).toBeUndefined()
  })
})

// ── The pane component ────────────────────────────────────────────────────
const canvasRead = vi.fn(async (p: string) => ({ ok: true as const, path: p, doc: DOC }))
const canvasWatchStart = vi.fn(async () => undefined)
const canvasWatchStop = vi.fn(async () => undefined)
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
  canvasWatchStart.mockClear()
  canvasWatchStop.mockClear()
  markdownRead.mockClear()
  canvasRead.mockImplementation(async (p: string) => ({ ok: true, path: p, doc: DOC }))
  canvasChangedCb = null
  const api = {
    canvasRead,
    canvasWatchStart,
    canvasWatchStop,
    markdownRead,
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

function mountPane(pane = PANE) {
  return mount(DiagramPane, {
    props: { pane: { ...pane }, worktreePath: '/wt' },
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

describe('DiagramPane', () => {
  it('reads the file through the confined canvas IPC and renders it (AC U2-2)', async () => {
    const w = mountPane()
    await settle()
    expect(canvasRead).toHaveBeenCalledWith('/wt/board.harnucanvas.json')
    const svg = w.find('[data-testid="diagram-canvas-host"] svg')
    expect(svg.exists()).toBe(true)
    // Every node's label reaches the DOM — "renders its nodes" is the AC, and a
    // graph object with the right cell count would not prove it.
    const text = w.find('[data-testid="diagram-canvas-host"]').text()
    expect(text).toContain('Browser')
    expect(text).toContain('Main')
    expect(text).toContain('annotation')
    expect(text).toContain('reads')
    w.unmount()
  })

  it('starts and stops the disk watch with the pane lifecycle', async () => {
    const w = mountPane()
    await settle()
    expect(canvasWatchStart).toHaveBeenCalledWith('/wt/board.harnucanvas.json')
    w.unmount()
    expect(canvasWatchStop).toHaveBeenCalledWith('/wt/board.harnucanvas.json')
  })

  it('a change on disk reloads silently while the pane is clean (§7.3 case A)', async () => {
    const w = mountPane()
    await settle()
    expect(canvasRead).toHaveBeenCalledTimes(1)
    canvasChangedCb?.({ path: '/wt/board.harnucanvas.json' })
    await settle()
    expect(canvasRead).toHaveBeenCalledTimes(2)
    w.unmount()
  })

  it('ignores a change reported for a different file', async () => {
    const w = mountPane()
    await settle()
    canvasChangedCb?.({ path: '/wt/other.harnucanvas.json' })
    await settle()
    expect(canvasRead).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('a reader refusal shows one localized line, never the raw code', async () => {
    canvasRead.mockImplementation(async () => ({
      ok: false as const,
      code: 'schema-unsupported',
      error: 'unknown capycanvas major'
    }))
    const w = mountPane()
    await settle()
    expect(w.text()).toContain('newer version of Harnu')
    expect(w.text()).not.toContain('schema-unsupported')
    w.unmount()
  })

  it('an empty document reads as a board, not a failure', async () => {
    canvasRead.mockImplementation(async (p: string) => ({
      ok: true as const,
      path: p,
      doc: { capycanvas: 1, meta: {}, nodes: [], edges: [] } as CanvasDocument
    }))
    const w = mountPane()
    await settle()
    expect(w.text()).toContain('empty')
    // The grid host stays mounted underneath — an empty board still looks like one.
    expect(w.find('[data-testid="diagram-canvas-host"] svg').exists()).toBe(true)
    w.unmount()
  })

  it('the read-only chip is gone now that the pane edits (U3, design.md §6)', async () => {
    const w = mountPane()
    await settle()
    // It disappeared rather than becoming a mode switch: an honest label for a
    // half-built pane, not a permanent state.
    expect(w.text()).not.toContain('read-only')
    // And the affordances it stood in for are real.
    expect(w.find('[data-testid="diagram-save"]').exists()).toBe(true)
    expect(w.find('[data-testid="diagram-undo"]').exists()).toBe(true)
    expect(w.find('[data-testid="diagram-redo"]').exists()).toBe(true)
    w.unmount()
  })

  it('the zoom controls change the reported percentage', async () => {
    const w = mountPane()
    await settle()
    const readout = () => w.find('[data-testid="diagram-zoom"]').text()
    const before = readout()
    await w.find('button[aria-label="Zoom in"]').trigger('click')
    await settle()
    expect(readout()).not.toBe(before)
    w.unmount()
  })

  it('resolves image assets through the confined reader, relative to the canvas dir', async () => {
    canvasRead.mockImplementation(async (p: string) => ({
      ok: true as const,
      path: p,
      doc: {
        capycanvas: 1,
        meta: {},
        nodes: [
          {
            id: 'n-i',
            shape: 'image',
            x: 0,
            y: 0,
            origin: 'agent',
            label: 'shot',
            props: { src: 'assets/shot-1.png' }
          }
        ],
        edges: []
      } as CanvasDocument
    }))
    const w = mountPane()
    await settle()
    // `file://` is blocked by the CSP; the existing image fast-path returns a
    // data: URL, which is allowed — so this is the reader we must go through.
    expect(markdownRead).toHaveBeenCalledWith('assets/shot-1.png', '/wt')
    w.unmount()
  })

  it('the X6 host is absolutely positioned inside a measured parent', async () => {
    // Regression guard for a real layout bug: X6 writes an inline
    // `width`/`height` onto its own container, which then stops tracking the
    // pane. Observing that container is a deadlock — X6 pins it, so it never
    // changes, so the ResizeObserver never fires — and the graph stayed sized
    // to whatever the pane happened to be at mount. Verified in the real app:
    // the board stayed 320px wide in a 548px pane and fit-to-view computed 51%
    // where it should have computed 100%. The fix is structural, so the guard
    // is too: the host must NOT drive its parent's size.
    const w = mountPane()
    await settle()
    const host = w.find('[data-testid="diagram-canvas-host"]')
    expect(host.classes()).toContain('absolute')
    expect(host.classes()).toContain('inset-0')
    expect(host.element.parentElement?.className).toContain('relative')
    w.unmount()
  })

  it('an invalid pane path fails closed instead of calling the reader', async () => {
    const w = mountPane({ ...PANE, filePath: '' })
    await settle()
    expect(canvasRead).not.toHaveBeenCalled()
    expect(w.text()).toContain("isn't a canvas file")
    w.unmount()
  })
})
