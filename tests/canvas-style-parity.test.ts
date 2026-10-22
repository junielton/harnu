import { describe, it, expect } from 'vitest'
import {
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
