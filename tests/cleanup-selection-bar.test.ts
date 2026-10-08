// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupSelectionBar from '../src/renderer/src/components/CleanupSelectionBar.vue'
import { i18n } from '@renderer/i18n'

const mountBar = (count: number, bytes = 3_466_000_000, canKeep = true) =>
  mount(CleanupSelectionBar, { props: { count, bytes, canKeep }, global: { plugins: [i18n] } })

describe('CleanupSelectionBar', () => {
  it('renders nothing with an empty selection', () => {
    const w = mountBar(0)
    expect(w.find('[data-testid="selection-bar"]').exists()).toBe(false)
  })

  it('states how many are selected and how much disk they hold', () => {
    const w = mountBar(4)
    expect(w.get('[data-testid="sel-count"]').text()).toBe('4 selected · 3.47 GB')
  })

  it('emits remove, dehydrate, keep and clear', async () => {
    const w = mountBar(2)
    await w.get('[data-testid="sel-remove"]').trigger('click')
    await w.get('[data-testid="sel-dehydrate"]').trigger('click')
    await w.get('[data-testid="sel-keep"]').trigger('click')
    await w.get('[data-testid="sel-clear"]').trigger('click')
    expect(w.emitted('remove')).toHaveLength(1)
    expect(w.emitted('dehydrate')).toHaveLength(1)
    expect(w.emitted('keep')).toHaveLength(1)
    expect(w.emitted('clear')).toHaveLength(1)
  })

  it('Remove selected is the Danger button', () => {
    const w = mountBar(2)
    expect(w.get('[data-testid="sel-remove"]').classes()).toContain('text-red')
  })

  it('Ask for an opinion is visible but disabled, with the S6 tooltip', async () => {
    const w = mountBar(2)
    const ask = w.get('[data-testid="sel-ask"]')
    expect(ask.text()).toBe('Ask for an opinion')
    expect((ask.element as HTMLButtonElement).disabled).toBe(true)
    expect(ask.element.parentElement?.getAttribute('title')).toBe('coming in S6')
    await ask.trigger('click')
    expect(w.emitted()).not.toHaveProperty('ask')
  })

  it('hints at Shift+click for adding more', () => {
    expect(mountBar(1).get('kbd').text()).toBe('⇧')
  })
})

describe('CleanupSelectionBar — Keep only when something can be kept', () => {
  it('hides Keep when the selection holds no worktree (orphan volumes have no Keep)', () => {
    const w = mountBar(2, 3_000_000, false)
    expect(w.find('[data-testid="sel-keep"]').exists()).toBe(false)
    expect(w.find('[data-testid="sel-remove"]').exists()).toBe(true)
  })
  it('shows Keep by default', () => {
    expect(mountBar(1).find('[data-testid="sel-keep"]').exists()).toBe(true)
  })
})
