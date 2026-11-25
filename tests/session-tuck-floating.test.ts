// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@renderer/i18n'
import SessionTuckStrip from '../src/renderer/src/components/SessionTuckStrip.vue'
import type { Dot } from '../src/renderer/src/components/session-dot'

/**
 * T790 delta 2 — the tuck strip in Floating panels mode (design.md §6 "Tucking the session away", the
 * floating bullet). jsdom has no layout engine and cannot resolve `calc()` or `var()`, so the layout
 * contract is asserted on the CSS the floating block carries (the way `floating-panels.test.ts` does) and
 * on the hooks the component gives that CSS; the pixels are proven by captures in the real app.
 */

const ROOT = resolve(__dirname, '..')
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8')

function floatingCss(): string {
  const css = read('src/renderer/src/styles/main.css')
  const start = css.indexOf('/* floating-panels:start */')
  const end = css.indexOf('/* floating-panels:end */')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return css.slice(start, end)
}

interface Rule {
  selectors: string[]
  decls: Record<string, string>
}
function parseRules(css: string): Rule[] {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls: Record<string, string> = {}
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':')
      if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim()
    }
    rules.push({ selectors: m[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim()), decls })
  }
  return rules
}
/** Declarations of the rules whose selector list holds EXACTLY `selector` (after the floating prefix). */
function declsOf(rules: Rule[], selector: string): Record<string, string> {
  const full = `:root[data-floating='on'] ${selector}`
  const out: Record<string, string> = {}
  for (const r of rules) if (r.selectors.includes(full)) Object.assign(out, r.decls)
  return out
}

let wrapper: VueWrapper | null = null
beforeEach(() => {
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

const mountStrip = (
  dot: Dot = 'idle',
  orientation: 'vertical' | 'horizontal' = 'vertical'
): VueWrapper =>
  (wrapper = mount(SessionTuckStrip, {
    global: { plugins: [i18n] },
    props: {
      orientation,
      name: 'Walk the CMS editor',
      dot,
      stateLabel: 'Idle',
      where: 'repo',
      chord: 'Ctrl+Shift+J'
    }
  }))

describe('the strip as its own island in floating mode', () => {
  it('gives the floating CSS an island bar to draw: data-island, the strip hook, and the state colour on the bar', () => {
    const w = mountStrip('idle')
    expect(w.get('[data-test="session-tuck-strip"]').attributes('data-tuck-strip')).toBeDefined()
    const bar = w.get('[data-island="tuck-strip"]')
    expect(bar.classes()).toContain('bg-text-4')
  })

  it('shows the state on the bar: working green, failed red, needs-you warning and blinking', () => {
    expect(mountStrip('working').get('[data-island="tuck-strip"]').classes()).toContain('bg-green')
    wrapper?.unmount()
    expect(mountStrip('failed').get('[data-island="tuck-strip"]').classes()).toContain('bg-red')
    wrapper?.unmount()
    const needs = mountStrip('needs-input').get('[data-island="tuck-strip"]')
    expect(needs.classes()).toEqual(expect.arrayContaining(['bg-warning', 'anim-attention-dot']))
  })

  it('marks the classic dot, grip and tag so floating mode can leave them out', () => {
    const w = mountStrip('idle')
    expect(w.findAll('[data-tuck-classic]').length).toBeGreaterThanOrEqual(2) // dot + grip
    wrapper?.unmount()
    const n = mountStrip('needs-input')
    expect(n.get('[data-test="session-tuck-tag"]').attributes('data-tuck-classic')).toBeDefined()
  })

  it('declares the three sizes once, 4px bar / 10px on hover / a 14px hit area', () => {
    const rules = parseRules(floatingCss())
    const strip = declsOf(rules, '[data-tuck-strip]')
    expect(strip['--tuck-bar-w']).toBe('4px')
    expect(strip['--tuck-bar-w-hover']).toBe('10px')
    expect(strip['--tuck-hit']).toBe('14px')
  })

  it('lays the strip out as the bar plus the float gap, with no padding, border or fill of its own', () => {
    const strip = declsOf(parseRules(floatingCss()), '[data-tuck-strip]')
    expect(strip.width).toBe('calc(var(--bar) + var(--float-gap))')
    expect(strip['--bar']).toBe('var(--tuck-bar-w)')
    expect(strip.background).toBe('transparent')
    expect(strip.border).toBe('0')
    expect(strip.padding).toBe('0')
  })

  it('stacked: the same on the Y axis, bar plus float gap tall and the whole row wide', () => {
    const h = declsOf(parseRules(floatingCss()), "[data-tuck-strip][data-orientation='horizontal']")
    expect(h.height).toBe('calc(var(--bar) + var(--float-gap))')
    expect(h.width).toBe('100%')
  })

  it('draws the bar as an island: --float-radius corners, no border, the bar width', () => {
    const bar = declsOf(parseRules(floatingCss()), "[data-island='tuck-strip']")
    expect(bar['border-radius']).toBe('var(--float-radius)')
    expect(bar.border).toBe('0')
    expect(bar.width).toBe('var(--bar)')
    const bh = declsOf(
      parseRules(floatingCss()),
      "[data-tuck-strip][data-orientation='horizontal'] [data-island='tuck-strip']"
    )
    expect(bh.height).toBe('var(--bar)')
    expect(bh.width).toBe('auto')
  })

  it('keeps the hit area at least as wide as the classic 14px through an invisible ::before', () => {
    const rules = parseRules(floatingCss())
    const hit = declsOf(rules, '[data-tuck-strip]::before')
    expect(hit.content).toBe("''")
    expect(hit.width).toBe('var(--tuck-hit)')
    expect(hit.position).toBe('absolute')
    expect(hit.background).toBeUndefined()
    const hitH = declsOf(rules, "[data-tuck-strip][data-orientation='horizontal']::before")
    expect(hitH.height).toBe('var(--tuck-hit)')
    // The classic strip is 14px wide; the floating hit area must not be smaller.
    expect(read('src/renderer/src/components/SessionTuckStrip.vue')).toContain('w-[14px]')
  })

  it('widens the bar on hover and keyboard focus, never past its own island', () => {
    const rules = parseRules(floatingCss())
    const hover = declsOf(rules, '[data-tuck-strip]:hover')
    const focus = declsOf(rules, '[data-tuck-strip]:focus-visible')
    expect(hover['--bar']).toBe('var(--tuck-bar-w-hover)')
    expect(focus['--bar']).toBe('var(--tuck-bar-w-hover)')
  })

  it('hides the classic parts and draws no raw colour in any of it', () => {
    const css = floatingCss()
    const rules = parseRules(css)
    expect(declsOf(rules, '[data-tuck-classic]').display).toBe('none')
    const tuckRules = rules.filter((r) => r.selectors.some((s) => /tuck/.test(s)))
    expect(tuckRules.length).toBeGreaterThanOrEqual(8)
    for (const r of tuckRules) {
      for (const v of Object.values(r.decls))
        expect(v, r.selectors.join(',')).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
    }
  })

  it('every one of those rules is scoped to the attribute, so layout off changes no pixel', () => {
    for (const r of parseRules(floatingCss())) {
      if (!r.selectors.some((s) => /tuck/.test(s))) continue
      for (const s of r.selectors) expect(s.startsWith(":root[data-floating='on']"), s).toBe(true)
    }
  })
})
