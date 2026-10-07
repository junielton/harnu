// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupFirstCycleBanner from '../src/renderer/src/components/CleanupFirstCycleBanner.vue'
import { i18n } from '@renderer/i18n'

const mountBanner = (count = 12, bytes = 6_000_000_000) =>
  mount(CleanupFirstCycleBanner, { props: { count, bytes }, global: { plugins: [i18n] } })

describe('CleanupFirstCycleBanner', () => {
  it('asks to enable autopilot with the count and the bytes it found', () => {
    expect(mountBanner().text()).toContain('Found 12 corpses, 6.00 GB — enable autopilot?')
    expect(mountBanner(1, 5_000_000).text()).toContain('Found 1 corpse, 5 MB')
  })

  it('says the first cycle deletes nothing', () => {
    expect(mountBanner().text()).toContain('nothing is deleted until you turn it on')
  })

  it('Enable autopilot is the one Primary; Not now is Ghost', () => {
    const w = mountBanner()
    expect(w.get('[data-testid="first-enable"]').classes()).toContain('bg-accent')
    expect(w.get('[data-testid="first-dismiss"]').classes()).not.toContain('bg-accent')
    expect(w.findAll('button.bg-accent')).toHaveLength(1)
  })

  it('emits enable and dismiss', async () => {
    const w = mountBanner()
    await w.get('[data-testid="first-enable"]').trigger('click')
    await w.get('[data-testid="first-dismiss"]').trigger('click')
    expect(w.emitted('enable')).toHaveLength(1)
    expect(w.emitted('dismiss')).toHaveLength(1)
  })
})
