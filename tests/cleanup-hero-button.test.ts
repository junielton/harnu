// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupHeroButton from '../src/renderer/src/components/CleanupHeroButton.vue'
import { i18n } from '@renderer/i18n'
import type { HeroState } from '../src/renderer/src/lib/gc-model'

const MB = 1_000_000

function mountHero(hero: HeroState, scanning = false) {
  return mount(CleanupHeroButton, { props: { hero, scanning }, global: { plugins: [i18n] } })
}

describe('CleanupHeroButton', () => {
  it('clean: a Primary button with the count and the bytes in its label', () => {
    const w = mountHero({ kind: 'clean', count: 12, bytes: 600 * MB, soft: false })
    const btn = w.get('[data-testid="hero-clean"]')
    expect(btn.text()).toBe('Clean 12 ready · 600 MB')
    expect(btn.classes()).toContain('bg-accent')
    expect((btn.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('clean: same wording for one ready item', () => {
    const w = mountHero({ kind: 'clean', count: 1, bytes: 5 * MB, soft: false })
    expect(w.get('[data-testid="hero-clean"]').text()).toBe('Clean 1 ready · 5 MB')
  })

  it('clean: the first-cycle state is Soft, because Enable autopilot owns the Primary', () => {
    const w = mountHero({ kind: 'clean', count: 2, bytes: MB, soft: true })
    const btn = w.get('[data-testid="hero-clean"]')
    expect(btn.classes()).not.toContain('bg-accent')
    expect(btn.classes()).toContain('bg-surface')
  })

  it('clean: a click emits click', async () => {
    const w = mountHero({ kind: 'clean', count: 2, bytes: MB, soft: false })
    await w.get('[data-testid="hero-clean"]').trigger('click')
    expect(w.emitted('click')).toHaveLength(1)
  })

  it('empty: disabled, keeps its label, and never emits', async () => {
    const w = mountHero({ kind: 'empty' })
    const btn = w.get('[data-testid="hero-empty"]')
    expect(btn.text()).toBe('Nothing to clean')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    await btn.trigger('click')
    expect(w.emitted('click')).toBeUndefined()
  })

  it('running: not a button — a polite live region with counts, freed bytes and a bar by item', () => {
    const w = mountHero({ kind: 'running', done: 3, total: 12, freedBytes: 1400 * MB })
    const chip = w.get('[data-testid="hero-chip"]')
    expect(chip.element.tagName).not.toBe('BUTTON')
    expect(w.find('button').exists()).toBe(false)
    expect(chip.attributes('role')).toBe('status')
    expect(chip.attributes('aria-live')).toBe('polite')
    expect(chip.text()).toBe('Cleaning 3/12 · 1.40 GB freed')
    expect(w.get('[data-testid="hero-chip-bar"]').attributes('style')).toContain('width: 25%')
  })

  it('running: draws no cancel control (the engine has none)', () => {
    const w = mountHero({ kind: 'running', done: 0, total: 3, freedBytes: 0 })
    expect(w.text().toLowerCase()).not.toContain('cancel')
  })

  it('running: a zero total does not divide by zero', () => {
    const w = mountHero({ kind: 'running', done: 0, total: 0, freedBytes: 0 })
    expect(w.get('[data-testid="hero-chip-bar"]').attributes('style')).toContain('width: 0%')
  })

  it('scanning: a disabled "Scanning…" button — never the "Nothing to clean" result', () => {
    const w = mountHero({ kind: 'empty' }, true)
    const btn = w.get('[data-testid="hero-scanning"]')
    expect(btn.text()).toBe('Scanning…')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    expect(w.find('[data-testid="hero-empty"]').exists()).toBe(false)
  })
})
