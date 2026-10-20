import { describe, it, expect } from 'vitest'
import {
  EDGE_STYLE_KIND,
  PANE_EDGE_STYLE,
  CANVAS_STYLE_DEFAULTS,
  CANVAS_STYLE_KEYS,
  CANVAS_STYLE_VALUES,
  PANE_STYLE_KEYS_BY_SHAPE,
  mergeCanvasStyle,
  styleKeysFor
} from '../src/renderer/src/components/canvas/canvas-style'
import {
  CANVAS_STYLE_DEFAULTS as MAIN_DEFAULTS,
  CANVAS_STYLE_KEYS as MAIN_KEYS,
  CANVAS_STYLE_VALUES as MAIN_VALUES,
  CANVAS_EDGE_STYLE,
  CANVAS_SHAPE_CATALOG,
  LEGACY_CANVAS_SHAPE_NAMES,
  canvasShapeSpec
} from '../src/main/mcp/canvas-shapes'
import { applyCanvasOps, type CanvasIdMinter } from '../src/main/mcp/canvas-ops'
import { emptyCanvasDocument, type CanvasDocument } from '../src/main/canvas-core'
import { STYLE_MERGE_CASES } from './fixtures/canvas-style-merge'

/**
 * DRIFT VALVE for the node-style tables (T536 U3). The renderer cannot import
 * `src/main` at runtime, so `canvas-style.ts` mirrors the key list, the allowed
 * values, the defaults, and which shape takes which key. This test imports both
 * sides and pins them together — the same convention as the default-size drift
 * test in `tests/mcp-canvas-ops.test.ts`. It also runs the shared merge fixture
 * table through the renderer's `mergeCanvasStyle` AND the agent's real
 * `update_node` `style` path, so the two merges cannot disagree.
 */

describe('style tables — renderer mirror vs. the agent catalog', () => {
  it('the key list, allowed values and defaults are identical', () => {
    expect([...CANVAS_STYLE_KEYS]).toEqual([...MAIN_KEYS])
    expect(CANVAS_STYLE_VALUES).toEqual(MAIN_VALUES)
    expect(CANVAS_STYLE_DEFAULTS).toEqual(MAIN_DEFAULTS)
  })

  it('every catalog shape takes exactly the keys the pane table says, with the same values', () => {
    for (const spec of CANVAS_SHAPE_CATALOG) {
      const keys = Object.keys(spec.style)
      expect(styleKeysFor(spec.name), spec.name).toEqual(keys)
      for (const key of keys) {
        expect(
          CANVAS_STYLE_VALUES[key as keyof typeof CANVAS_STYLE_VALUES],
          `${spec.name}.${key}`
        ).toEqual(spec.style[key as keyof typeof spec.style])
      }
    }
  })

  it('the legacy shape names resolve to the same keys through the catalog', () => {
    for (const legacy of Object.keys(LEGACY_CANVAS_SHAPE_NAMES)) {
      const spec = canvasShapeSpec(legacy)!
      expect(Object.keys(spec.style), legacy).toEqual([...styleKeysFor(legacy)])
    }
  })

  it('the pane table names no shape the catalog has never heard of', () => {
    const names = new Set(CANVAS_SHAPE_CATALOG.map((s) => s.name))
    for (const name of Object.keys(PANE_STYLE_KEYS_BY_SHAPE)) {
      expect(names.has(name), `pane-only shape "${name}"`).toBe(true)
    }
  })

  it('and lists every catalog shape, so a new shape cannot be forgotten', () => {
    for (const spec of CANVAS_SHAPE_CATALOG) {
      expect(Object.hasOwn(PANE_STYLE_KEYS_BY_SHAPE, spec.name), spec.name).toBe(true)
    }
  })
})

describe('the merge — renderer vs. the agent path, one fixture table', () => {
  const mint: CanvasIdMinter = (prefix, attempt) => `${prefix}-${attempt}`

  for (const c of STYLE_MERGE_CASES) {
    it(c.name, () => {
      const doc: CanvasDocument = {
        ...emptyCanvasDocument('2026-10-19T12:00:00.000Z'),
        nodes: [
          {
            id: 's',
            shape: 'box',
            x: 0,
            y: 0,
            origin: 'operator',
            ...(c.props === undefined ? {} : { props: c.props })
          }
        ]
      }
      const res = applyCanvasOps({
        doc,
        ops: [{ op: 'update_node', id: 's', style: c.patch }],
        mintId: mint
      })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      const viaAgent = res.doc.nodes[0].props
      const viaPane = mergeCanvasStyle(c.props, c.patch)
      expect(viaPane).toEqual(viaAgent)
      expect(JSON.stringify(viaPane)).toBe(JSON.stringify(viaAgent))
      expect(viaAgent).toEqual(c.expected)
    })
  }
})

describe('arrow styles — renderer mirror vs. the agent catalog (T536 U5)', () => {
  it("the pane's arrow table deep-equals the agent's", () => {
    expect(PANE_EDGE_STYLE).toEqual(CANVAS_EDGE_STYLE)
    expect(Object.keys(PANE_EDGE_STYLE)).toEqual(Object.keys(CANVAS_EDGE_STYLE))
  })

  it('every arrow value is a value the node tables know, so a node option can name it', () => {
    for (const [key, values] of Object.entries(PANE_EDGE_STYLE)) {
      const known = MAIN_VALUES[key as keyof typeof MAIN_VALUES] as readonly unknown[]
      for (const v of values ?? []) expect(known, `${key}=${String(v)}`).toContain(v)
    }
  })

  it('the pseudo-kind is never a document shape name', () => {
    const names = new Set<string>([
      ...CANVAS_SHAPE_CATALOG.map((s) => s.name),
      ...Object.keys(LEGACY_CANVAS_SHAPE_NAMES)
    ])
    expect(names.has(EDGE_STYLE_KIND)).toBe(false)
  })
})

describe('the merge — renderer vs. the agent path, on an EDGE (T536 U5)', () => {
  const mint: CanvasIdMinter = (prefix, attempt) => `${prefix}-${attempt}`
  // The table's patches are written for a box. The agent refuses a key or value an
  // arrow does not take, so only the cases an arrow can receive run here.
  const arrowTakes = (patch: Record<string, string | number | null>): boolean =>
    Object.entries(patch).every(
      ([key, value]) =>
        Object.hasOwn(CANVAS_EDGE_STYLE, key) &&
        (value === null ||
          (CANVAS_EDGE_STYLE[key as keyof typeof CANVAS_EDGE_STYLE] ?? []).includes(value))
    )
  const ARROW_CASES = STYLE_MERGE_CASES.filter((c) => arrowTakes(c.patch))

  it('runs most of the table, so the filter cannot hollow the test out', () => {
    expect(ARROW_CASES.length).toBeGreaterThanOrEqual(10)
    expect(ARROW_CASES.length).toBeLessThan(STYLE_MERGE_CASES.length)
  })

  for (const c of ARROW_CASES) {
    it(c.name, () => {
      const doc: CanvasDocument = {
        ...emptyCanvasDocument('2026-10-19T12:00:00.000Z'),
        nodes: [
          { id: 'a', shape: 'box', x: 0, y: 0, origin: 'operator' },
          { id: 'b', shape: 'box', x: 200, y: 0, origin: 'operator' }
        ],
        edges: [
          {
            id: 'e',
            source: 'a',
            target: 'b',
            origin: 'operator',
            ...(c.props === undefined ? {} : { props: c.props })
          }
        ]
      }
      const res = applyCanvasOps({
        doc,
        ops: [{ op: 'update_edge', id: 'e', style: c.patch }],
        mintId: mint
      })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      const viaAgent = res.doc.edges[0].props
      const viaPane = mergeCanvasStyle(c.props, c.patch)
      expect(viaPane).toEqual(viaAgent)
      expect(JSON.stringify(viaPane)).toBe(JSON.stringify(viaAgent))
      expect(viaAgent).toEqual(c.expected)
    })
  }
})
