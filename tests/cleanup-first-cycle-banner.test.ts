// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupFirstCycleBanner from '../src/renderer/src/components/CleanupFirstCycleBanner.vue'
import { i18n } from '@renderer/i18n'

const mountBanner = (count = 12, bytes = 6_000_000_000, extra: Record<string, unknown> = {}) =>
  mount(CleanupFirstCycleBanner, {
    props: { count, bytes, cleanCount: 2, cleanBytes: 6_000_000, when: '58 min', ...extra },
    global: { plugins: [i18n] }
  })

describe('CleanupFirstCycleBanner', () => {
  it('asks to enable autopilot with the count and the bytes it found', () => {
    expect(mountBanner().text()).toContain('Found 12 ready items, 6.00 GB — enable autopilot?')
    expect(mountBanner(1, 5_000_000).text()).toContain('Found 1 ready item, 5 MB')
  })

  it('says exactly what the next cycle will clean once enabled', () => {
    const text = mountBanner().text()
    expect(text).toContain('next cycle, in 58 min, will clean 2 items, 6 MB')
    expect(text).not.toContain('nothing is deleted')
  })

  it('discloses the Docker housekeeping the ack also turns on, when it is on and Docker answers', () => {
    const text = mountBanner(12, 1, { dockerDays: 7 }).text()
    expect(text).toContain('also prune Docker build cache older than 7 days and dangling images')
    expect(mountBanner(12, 1, { dockerDays: 1 }).text()).toContain('older than 1 day and')
  })

  it('says nothing about Docker when there is nothing Docker-side to do', () => {
    expect(mountBanner().text()).not.toContain('Docker')
    expect(mountBanner(12, 1, { dockerDays: null }).text()).not.toContain('Docker')
  })

  it('also discloses Docker in the "Allow cleaning" variant', () => {
    const text = mountBanner(12, 1, { autopilotOn: true, dockerDays: 7 }).text()
    expect(text).toContain('also prune Docker build cache')
  })

  it('says so when no cycle is scheduled because the background scan is off', () => {
    const text = mountBanner(12, 1, { when: null }).text()
    expect(text).toContain('will clean 2 items, 6 MB')
    expect(text).toContain('background scan is off')
  })

  it('with autopilot already on it asks to allow cleaning, and says it has only reported', () => {
    const w = mountBanner(12, 6_000_000_000, { autopilotOn: true })
    expect(w.text()).toContain('Autopilot found 12 ready items')
    expect(w.text()).toContain('only reported so far')
    expect(w.text()).toContain('Allow it and the next cycle, in 58 min, will clean 2 items, 6 MB')
    expect(w.text()).not.toContain('Enable it')
    expect(w.get('[data-testid="first-enable"]').text()).toBe('Allow cleaning')
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
