// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UsageMeter from '../src/renderer/src/components/UsageMeter.vue'

/** Presentational meter row — all i18n/formatting is done by the parent panel,
 *  so this component takes plain string/number props and owns only the bar. */
describe('UsageMeter', () => {
  it('renders the label, percent and reset label', () => {
    const w = mount(UsageMeter, {
      props: { label: 'Current session', usedPercent: 39, resetLabel: 'resets in 57m' }
    })
    expect(w.text()).toContain('Current session')
    expect(w.text()).toContain('39%')
    expect(w.text()).toContain('resets in 57m')
  })

  it('sets the fill width to the percentage', () => {
    const w = mount(UsageMeter, { props: { label: 'x', usedPercent: 39, resetLabel: '' } })
    expect(w.get('[data-usage-fill]').attributes('style')).toContain('width: 39%')
  })

  it('clamps an over-100 percent to 100% width', () => {
    const w = mount(UsageMeter, { props: { label: 'x', usedPercent: 130, resetLabel: '' } })
    expect(w.get('[data-usage-fill]').attributes('style')).toContain('width: 100%')
  })

  it('rounds the displayed percent for fractional usage', () => {
    const w = mount(UsageMeter, { props: { label: 'x', usedPercent: 23.5, resetLabel: '' } })
    expect(w.text()).toContain('24%')
  })

  it('colors the fill green / accent / red by threshold', () => {
    const at = (p: number): string[] =>
      mount(UsageMeter, { props: { label: 'x', usedPercent: p, resetLabel: '' } })
        .get('[data-usage-fill]')
        .classes()
    expect(at(10)).toContain('bg-green')
    expect(at(85)).toContain('bg-accent')
    expect(at(97)).toContain('bg-red')
  })

  it('omits the reset line when no reset label is given', () => {
    const w = mount(UsageMeter, { props: { label: 'x', usedPercent: 10, resetLabel: '' } })
    expect(w.find('[data-usage-reset]').exists()).toBe(false)
  })

  it('exposes the absolute reset string as the title tooltip', () => {
    const w = mount(UsageMeter, {
      props: {
        label: 'x',
        usedPercent: 10,
        resetLabel: 'resets in 57m',
        resetTitle: 'Jun 10, 8:40pm (America/Sao_Paulo)'
      }
    })
    expect(w.get('[data-usage-reset]').attributes('title')).toBe(
      'Jun 10, 8:40pm (America/Sao_Paulo)'
    )
  })

  it('omits the title attribute when no reset title is provided', () => {
    const w = mount(UsageMeter, {
      props: { label: 'x', usedPercent: 10, resetLabel: 'resets soon' }
    })
    expect(w.get('[data-usage-reset]').attributes('title')).toBeUndefined()
  })
})
