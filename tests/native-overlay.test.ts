/**
 * T568 (browser pane U1, AC-4) — which app layers count as overlays: body-level candidates, zero-size
 * wrappers, fullscreen backdrops (spec §2.4).
 */
import { describe, it, expect } from 'vitest'
import { collectOverlays, overlaySignature } from '../src/renderer/src/lib/native-overlay'

const vp = { width: 1280, height: 800 }
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

describe('collectOverlays', () => {
  it('returns a real body-level layer as one rect', () => {
    expect(collectOverlays([{ box: box(900, 80, 200, 300), children: [] }], vp)).toEqual([
      { x: 900, y: 80, width: 200, height: 300 }
    ])
  })

  it('reads the children of a zero-size wrapper (a fixed container of fixed layers)', () => {
    const wrapper = {
      box: box(0, 0, 0, 0),
      children: [box(10, 10, 100, 40), box(0, 0, 0, 0), box(20, 60, 100, 40)]
    }
    expect(collectOverlays([wrapper], vp)).toEqual([
      { x: 10, y: 10, width: 100, height: 40 },
      { x: 20, y: 60, width: 100, height: 40 }
    ])
  })

  it('turns a window-covering backdrop (a modal) into fullscreen and drops everything else', () => {
    const modal = { box: box(0, 0, 1280, 800), children: [] }
    const toast = { box: box(1000, 700, 260, 60), children: [] }
    expect(collectOverlays([toast, modal], vp)).toEqual(['fullscreen'])
  })

  it('does not call a large but not window-covering panel fullscreen', () => {
    expect(collectOverlays([{ box: box(200, 100, 800, 500), children: [] }], vp)).toEqual([
      { x: 200, y: 100, width: 800, height: 500 }
    ])
  })

  it('ignores empty layers and returns nothing for no layers', () => {
    expect(collectOverlays([{ box: box(5, 5, 0, 30), children: [] }], vp)).toEqual([])
    expect(collectOverlays([], vp)).toEqual([])
  })

  it('has a stable signature for unchanged lists', () => {
    const a = collectOverlays([{ box: box(1, 2, 3, 4), children: [] }], vp)
    const b = collectOverlays([{ box: box(1, 2, 3, 4), children: [] }], vp)
    expect(overlaySignature(a)).toBe(overlaySignature(b))
    expect(overlaySignature(a)).not.toBe(overlaySignature([]))
  })
})
