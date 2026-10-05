import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync('src/renderer/src/styles/main.css', 'utf8')
const design = readFileSync('design.md', 'utf8')

function block(src: string, selector: string): string {
  const i = src.indexOf(selector)
  expect(i, `not found: ${selector}`).toBeGreaterThan(-1)
  return src.slice(i, src.indexOf('}', src.indexOf('{', i)) + 1)
}

function keyframes(src: string, name: string): string {
  const i = src.indexOf(`@keyframes ${name}`)
  expect(i, `keyframes ${name} missing`).toBeGreaterThan(-1)
  let depth = 0
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++
    if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1)
  }
  throw new Error('unbalanced')
}

describe('pulse dot is compositor-only (AC-24, AC-37)', () => {
  it('pulse-ring animates only transform and opacity', () => {
    const k = keyframes(css, 'pulse-ring')
    const props = [...k.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1])
    expect(new Set(props)).toEqual(new Set(['transform', 'opacity']))
    expect(css).not.toMatch(/@keyframes pulse-dot\b/)
  })

  it('the ring lives on ::after with a 4px outset, the class never animates box-shadow', () => {
    const after = block(css, '.anim-pulse-dot::after')
    expect(after).toMatch(/inset:\s*-4px/)
    expect(after).toMatch(/animation:\s*pulse-ring 1\.8s ease-in-out infinite/)
    expect(css).not.toMatch(/\.anim-pulse-dot\s*\{[^}]*box-shadow/)
  })

  it('positioning uses :where() so utilities like absolute still win', () => {
    expect(block(css, ':where(.anim-pulse-dot)')).toMatch(/position:\s*relative/)
    expect(css).not.toMatch(/(^|\n)\.anim-pulse-dot\s*\{[^}]*position:/)
  })

  it('the :where() positioning sits in @layer components so utilities (layer utilities) win (AC-37)', () => {
    // Tailwind v4 utilities are layered; an UNLAYERED rule beats every layered
    // one whatever its specificity, so :where() alone would turn the absolute
    // Inbox badge into `position: relative`.
    const i = css.indexOf(':where(.anim-pulse-dot)')
    expect(i).toBeGreaterThan(-1)
    const open = css.lastIndexOf('@layer components', i)
    expect(open, 'rule is not inside @layer components').toBeGreaterThan(-1)
    const between = css.slice(css.indexOf('{', open) + 1, i)
    // every brace opened since the layer started is still open => i is inside it
    expect((between.match(/{/g) ?? []).length).toBe((between.match(/}/g) ?? []).length)
  })

  it('the ring never covers the dot: it paints below a static copy of the dot colour (AC-24)', () => {
    // A negative-z child paints ABOVE its stacking context root's own
    // background, so z-index alone cannot put the ring behind `bg-*`. The
    // dot's colour is re-painted by ::before (background: inherit) above the
    // ring (::after, z-index -2) and below the content (the badge digit).
    expect(block(css, ':where(.anim-pulse-dot)')).toMatch(/isolation:\s*isolate/)
    const before = block(css, '.anim-pulse-dot::before')
    expect(before).toMatch(/inset:\s*0/)
    expect(before).toMatch(/border-radius:\s*inherit/)
    expect(before).toMatch(/background:\s*inherit/)
    expect(before).toMatch(/z-index:\s*-1/)
    expect(before).not.toMatch(/animation/)
    expect(block(css, '.anim-pulse-dot::after')).toMatch(/z-index:\s*-2/)
  })

  it('design.md documents the same keyframe', () => {
    expect(keyframes(design, 'pulse-ring').replace(/\s+/g, ' ')).toBe(
      keyframes(css, 'pulse-ring').replace(/\s+/g, ' ')
    )
  })

  it('prefers-reduced-motion still neutralizes animations', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation/)
  })

  it('the ring is hidden at rest, so reduced motion leaves no static halo', () => {
    // The reduced-motion reset runs one 0.01ms iteration with no fill, so the
    // ring falls back to its unanimated style. That style must be invisible —
    // the old box-shadow pulse ended with no halo too.
    expect(block(css, '.anim-pulse-dot::after')).toMatch(/opacity:\s*0\s*;/)
    expect(block(design, '.anim-pulse-dot::after')).toMatch(/opacity:\s*0\s*;/)
  })
})
