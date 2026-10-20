// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  arrowEdgeEnds,
  pointInRect,
  topmostNodeId
} from '../src/renderer/src/components/canvas/canvas-arrow'
import { operatorEdgeSpec } from '../src/renderer/src/components/canvas/canvas-graph'
import { edgeLineAttrs } from '../src/renderer/src/components/canvas/canvas-style'
import type { CanvasPalette } from '../src/renderer/src/components/canvas/canvas-theme'

/** T536 U1 — the Arrow tool's pure decisions: where it lands, and whether it may. */

describe('topmostNodeId', () => {
  it('is null when nothing is under the pointer', () => {
    expect(topmostNodeId([])).toBeNull()
  })

  it('picks the highest zIndex', () => {
    expect(
      topmostNodeId([
        { id: 'top', zIndex: 5 },
        { id: 'low', zIndex: 1 }
      ])
    ).toBe('top')
  })

  it('breaks a zIndex tie by model order: the later node is drawn on top', () => {
    expect(
      topmostNodeId([
        { id: 'first', zIndex: 2 },
        { id: 'second', zIndex: 2 }
      ])
    ).toBe('second')
  })
})

describe('arrowEdgeEnds', () => {
  const existing = [{ source: 'n-a', target: 'n-b' }]

  it('a release on another node makes an edge from the source to it', () => {
    expect(arrowEdgeEnds('n-a', 'n-c', existing)).toEqual({ source: 'n-a', target: 'n-c' })
  })

  it('a release on blank board makes nothing', () => {
    expect(arrowEdgeEnds('n-a', null, existing)).toBeNull()
  })

  it('a release on the source node itself makes nothing (no loops)', () => {
    expect(arrowEdgeEnds('n-a', 'n-a', [])).toBeNull()
  })

  it('a duplicate in the same direction makes nothing (X6 allowMulti: false)', () => {
    expect(arrowEdgeEnds('n-a', 'n-b', existing)).toBeNull()
  })

  it('the reverse direction is a different edge and is allowed', () => {
    expect(arrowEdgeEnds('n-b', 'n-a', existing)).toEqual({ source: 'n-b', target: 'n-a' })
  })
})

describe('pointInRect', () => {
  const rect = { left: 10, top: 20, right: 110, bottom: 220 }

  it('is true inside and on the edge of the rect', () => {
    expect(pointInRect({ x: 50, y: 50 }, rect)).toBe(true)
    expect(pointInRect({ x: 10, y: 220 }, rect)).toBe(true)
  })

  it('is false outside it on any side', () => {
    expect(pointInRect({ x: 9, y: 50 }, rect)).toBe(false)
    expect(pointInRect({ x: 111, y: 50 }, rect)).toBe(false)
    expect(pointInRect({ x: 50, y: 19 }, rect)).toBe(false)
    expect(pointInRect({ x: 50, y: 221 }, rect)).toBe(false)
  })
})

describe('operatorEdgeSpec — the ONE operator edge shape', () => {
  const palette = { accent: '#abcdef' } as unknown as CanvasPalette

  it('is stamped operator, routed manhattan with rounded corners, in the accent stroke', () => {
    const spec = operatorEdgeSpec(palette)
    expect(spec).toMatchObject({
      shape: 'edge',
      data: { origin: 'operator' },
      router: { name: 'manhattan' },
      connector: { name: 'rounded', args: { radius: 8 } },
      attrs: {
        line: {
          stroke: '#abcdef',
          strokeWidth: 1.5,
          targetMarker: { name: 'block', width: 8, height: 6 }
        }
      }
    })
  })

  it('draws its line exactly as an unstyled arrow is drawn (one source of the attrs)', () => {
    expect(operatorEdgeSpec(palette).attrs).toEqual({ line: edgeLineAttrs(undefined, palette) })
  })

  it('is a fresh object each call, so one edge can never share data with another', () => {
    const a = operatorEdgeSpec(palette)
    const b = operatorEdgeSpec(palette)
    expect(a).not.toBe(b)
    expect(a.data).not.toBe(b.data)
  })
})
