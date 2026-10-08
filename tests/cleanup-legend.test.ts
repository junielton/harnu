// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupLegend from '../src/renderer/src/components/CleanupLegend.vue'
import { i18n } from '@renderer/i18n'

const mountLegend = (hasBytes = true) =>
  mount(CleanupLegend, { props: { hasBytes }, global: { plugins: [i18n] } })

describe('CleanupLegend', () => {
  it('names the three buckets, each with its icon, word and gloss', () => {
    const w = mountLegend()
    const items = {
      ready: w.get('[data-testid="legend-ready"]'),
      review: w.get('[data-testid="legend-review"]'),
      'in-use': w.get('[data-testid="legend-in-use"]')
    }
    expect(items.ready.text()).toBe('Ready to clean · cleaned by one click or the autopilot')
    expect(items.review.text()).toBe('Needs review · your call')
    expect(items['in-use'].text()).toBe('In use · never touched')
    for (const el of Object.values(items)) expect(el.find('svg').exists()).toBe(true)
  })

  it('colours each item in its bucket ink — never colour alone, the icon and word are there too', () => {
    const w = mountLegend()
    expect(w.get('[data-testid="legend-ready"]').classes()).toContain('text-green')
    expect(w.get('[data-testid="legend-review"]').classes()).toContain('text-warning')
    expect(w.get('[data-testid="legend-in-use"]').classes()).toContain('text-text-3')
  })

  it('says what the area of a block means, and how to act on it', () => {
    expect(mountLegend().get('[data-testid="legend-area"]').text()).toBe(
      'Block area = size on disk · click a block to act'
    )
  })

  it('drops the area note when there are no disk sizes to draw', () => {
    expect(mountLegend(false).find('[data-testid="legend-area"]').exists()).toBe(false)
  })
})
