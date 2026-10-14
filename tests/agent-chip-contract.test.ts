/**
 * T476 (agent terminals U1) — the design contract the chip ships with:
 *   AC-U1-1  design.md carries the §7.4 delta and CLAUDE.md the design-entity row
 *   AC-U1-4  no pulse under prefers-reduced-motion
 *   AC-U1-6  every `agentTerminal.*` key is in both locales; the pulse variant is accent-soft
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

const css = readFileSync('src/renderer/src/styles/main.css', 'utf8')
const design = readFileSync('design.md', 'utf8')
const claude = readFileSync('CLAUDE.md', 'utf8')
const chipSfc = readFileSync('src/renderer/src/components/AgentConnectionChip.vue', 'utf8')

function block(src: string, selector: string): string {
  const i = src.indexOf(selector)
  expect(i, `not found: ${selector}`).toBeGreaterThan(-1)
  return src.slice(i, src.indexOf('}', src.indexOf('{', i)) + 1)
}

describe('AC-U1-6 — i18n and the pulse variant', () => {
  const KEYS = [
    'connectedTo',
    'connectedToClosed',
    'connectedToAgent',
    'parked',
    'canType',
    'canTypeAnon',
    'readingAnon',
    'reading',
    'typing',
    'disconnect',
    'disconnectHint',
    'disconnected',
    'goToSession'
  ]

  it('en and pt-BR carry exactly the same agentTerminal keys, all non-empty', () => {
    expect(Object.keys(en.agentTerminal).sort()).toEqual([...KEYS].sort())
    expect(Object.keys(ptBR.agentTerminal).sort()).toEqual([...KEYS].sort())
    for (const k of KEYS) {
      expect((en.agentTerminal as Record<string, string>)[k]).toBeTruthy()
      expect((ptBR.agentTerminal as Record<string, string>)[k]).toBeTruthy()
    }
  })

  it('placeholders match across locales', () => {
    const ph = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()
    for (const k of KEYS) {
      expect(ph((ptBR.agentTerminal as Record<string, string>)[k]!)).toEqual(
        ph((en.agentTerminal as Record<string, string>)[k]!)
      )
    }
  })

  it('.anim-pulse-dot--accent swaps only the halo colour to --color-accent-soft', () => {
    const v = block(css, '.anim-pulse-dot--accent::after')
    expect(v).toMatch(/background:\s*var\(--color-accent-soft\)/)
    expect(v).not.toMatch(/animation|transform|opacity|inset/)
    // Declared after the base rule so the equal-specificity override wins.
    expect(css.indexOf('.anim-pulse-dot--accent::after')).toBeGreaterThan(
      css.indexOf('.anim-pulse-dot::after')
    )
  })
})

describe('AC-U1-4 — reduced motion', () => {
  it('the global reduced-motion reset still covers ::after, and the variant adds no animation', () => {
    const rm = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
    expect(rm).toMatch(/\*::after/)
    expect(rm).toMatch(/animation-duration:\s*0\.01ms !important/)
    expect(rm).toMatch(/animation-iteration-count:\s*1 !important/)
    expect(block(css, '.anim-pulse-dot--accent::after')).not.toMatch(/animation/)
  })
})

describe('AC-U1-1 — the design contract', () => {
  it('design.md carries the §6 subsection, the §7 motion row and the §5 icons', () => {
    expect(design).toContain('#### Agent connection chip (helper pane header)')
    expect(design).toMatch(/\| Agent activity pulse\s+\|/)
    expect(design).toMatch(/\| `unplug`\s+\|/)
    expect(design).toMatch(/\| `bot`\s+\|[^\n]*agent connection chip/)
    expect(design).toContain('.anim-pulse-dot--accent')
  })

  it('CLAUDE.md maps the chip to its Vue file', () => {
    expect(claude).toMatch(/\| Agent connection chip[^\n]*AgentConnectionChip\.vue/)
  })

  it('the component uses tokens only: no raw colour, no off-system keyframe', () => {
    expect(chipSfc).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
    expect(chipSfc).not.toMatch(/@keyframes|animation:/)
  })
})
