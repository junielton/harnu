import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync('src/renderer/src/styles/main.css', 'utf8')

/** The declaration block for a selector, up to its closing brace. */
function block(selector: string): string {
  const i = css.indexOf(selector)
  expect(i, `selector not found: ${selector}`).toBeGreaterThan(-1)
  return css.slice(i, css.indexOf('}', i))
}

/**
 * The Fleet state ring (design.md §7). This replaced the card border ring —
 * a masked `.anim-ring::before` plus an `<svg><rect>` animating
 * `stroke-dashoffset` — with a 16px badge built from a rotated border, which
 * is what lets the minimized rail render the whole fleet in 44px.
 *
 * These tests carry forward the INTENT of the retired
 * `.ring-stuck`/`ring-travel` assertions (BUG-51), re-expressed against the
 * new anatomy rather than dropped with the mechanism they guarded.
 */
describe('fleet state ring styles', () => {
  it('stuck is STILL and BROKEN — the contrast against errored (BUG-51)', () => {
    // Still: it was running and it stopped. Motion here would say "running".
    expect(block('.fleet-ring--stuck .fleet-ring-arc')).not.toMatch(/animation:/)
    expect(block('.fleet-ring--stuck .fleet-ring-track')).not.toMatch(/animation:/)

    // Broken: exactly two opposite edges are coloured, leaving gaps top and
    // bottom. Colouring all four would collapse it into errored's ring.
    const arc = block('.fleet-ring--stuck .fleet-ring-arc')
    expect(arc).toMatch(/border-left-color:\s*var\(--color-red\)/)
    expect(arc).toMatch(/border-right-color:\s*var\(--color-red\)/)
    expect(arc).not.toMatch(/border-top-color|border-bottom-color/)

    // errored is the unbroken one, and equally still.
    expect(block('.fleet-ring--errored .fleet-ring-track')).not.toMatch(/animation:/)
  })

  it('errored and done are still; only working and needs-input move', () => {
    for (const sel of ['.fleet-ring--errored', '.fleet-ring--done']) {
      expect(css.slice(css.indexOf(sel), css.indexOf(sel) + 400)).not.toMatch(/animation:/)
    }
    expect(block('.fleet-ring--working .fleet-ring-arc')).toMatch(/animation:\s*spin/)
    expect(block('.fleet-ring--needs-input .fleet-ring-track')).toMatch(/animation:\s*ring-breathe/)
  })

  it('working reuses the shared `spin` keyframe — no bespoke duplicate', () => {
    expect(css).toMatch(/@keyframes spin\b/)
    expect(css).not.toMatch(/@keyframes ring-spin\b/)
  })

  it('keeps `ring-breathe`, which the drop-target affordance also consumes', () => {
    expect(css).toMatch(/@keyframes ring-breathe\b/)
    expect(block('.anim-drop-pulse')).toMatch(/ring-breathe/)
  })

  it('the retired card border-ring mechanism is fully gone', () => {
    for (const dead of ['.anim-ring', '.ring-svg', '.ring-path', '@keyframes ring-travel']) {
      // Prose in comments may still explain what was replaced; only real
      // rule/at-rule declarations must be absent.
      const asDeclaration = new RegExp(
        `^\\s*\\${dead.startsWith('@') ? '' : ''}${dead.replace(/[.@]/g, '\\$&')}[\\s,{]`,
        'm'
      )
      expect(css, `${dead} still declared`).not.toMatch(asDeclaration)
    }
  })

  it('geometry stays on integer pixels — a half-pixel inset reads as off-centre', () => {
    // (ring - dot) / 2 must be an integer, and so must the border width.
    const ring = block('.fleet-ring {')
    const dot = block('.fleet-ring-dot {')
    const track = block('.fleet-ring-track,')
    const size = Number(/--ring-size,\s*(\d+(?:\.\d+)?)px/.exec(ring)?.[1])
    const dotPx = Number(/--ring-dot,\s*(\d+(?:\.\d+)?)px/.exec(dot)?.[1])
    const stroke = Number(/--ring-stroke,\s*(\d+(?:\.\d+)?)px/.exec(track)?.[1])

    expect(size).toBe(16)
    expect(dotPx).toBe(6)
    expect(stroke).toBe(2)
    expect(Number.isInteger((size - dotPx) / 2)).toBe(true)
    expect(Number.isInteger(stroke)).toBe(true)
  })
})
