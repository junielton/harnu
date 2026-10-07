// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupDockerCard from '../src/renderer/src/components/CleanupDockerCard.vue'
import { i18n } from '@renderer/i18n'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { CycleRecord, OrphanVolumeItem } from '../src/main/gc/gc-wire'

const vol = (name: string, project: string | null, sizeBytes = 100_000_000): OrphanVolumeItem => ({
  id: `volume:${name}`,
  name,
  sizeBytes,
  project,
  reason: { code: 'no-known-worktree', detail: 'No known worktree.' }
})

const cycle = (over: Partial<CycleRecord> = {}): CycleRecord => ({
  at: Date.now(),
  trigger: 'timer',
  mode: 'clean',
  found: 0,
  foundBytes: 0,
  cleaned: [],
  freedBytes: 0,
  deferred: 0,
  housekeeping: {
    buildCacheBytes: 3_800_000_000,
    imageBytes: 1_100_000_000,
    volumeBytes: 0,
    errors: []
  },
  notified: false,
  jobId: null,
  ...over
})

function mountCard(over: Record<string, unknown> = {}) {
  return mount(CleanupDockerCard, {
    props: {
      orphanVolumes: { count: 0, bytes: 0 },
      volumes: [],
      lastCycle: null,
      prefs: defaultGcPrefs(),
      ...over
    },
    global: { plugins: [i18n] }
  })
}

describe('CleanupDockerCard', () => {
  it('zero state: muted zeros for volumes and no invented cache figures', () => {
    const w = mountCard({
      lastCycle: cycle({
        housekeeping: { buildCacheBytes: 0, imageBytes: 0, volumeBytes: 0, errors: [] }
      })
    })
    const volumes = w.get('[data-testid="docker-volumes-size"]')
    expect(volumes.text()).toBe('0 volumes · 0 B')
    expect(volumes.classes()).toContain('text-text-3')
    expect(w.get('[data-testid="docker-cache-size"]').text()).toBe('Last cycle reclaimed 0 B')
  })

  it('before any cycle the engine has no cache figure: it says so instead of guessing', () => {
    const w = mountCard()
    expect(w.get('[data-testid="docker-cache-size"]').text()).toBe(
      'Size unavailable until the next cycle'
    )
    expect(w.get('[data-testid="docker-images-size"]').text()).toBe(
      'Size unavailable until the next cycle'
    )
  })

  it('shows what the last cycle reclaimed and the cache age cutoff', () => {
    const w = mountCard({ lastCycle: cycle() })
    expect(w.get('[data-testid="docker-cache-size"]').text()).toBe('Last cycle reclaimed 3.80 GB')
    expect(w.get('[data-testid="docker-images-size"]').text()).toBe('Last cycle reclaimed 1.10 GB')
    expect(w.get('[data-testid="docker-cache"]').text()).toContain('Older than 7 days')
  })

  it("orphan volumes: count, bytes, the can't-be-restored warning and the first projects", () => {
    const volumes = [
      vol('a', 'alpha'),
      vol('b', 'beta'),
      vol('c', 'gamma'),
      vol('d', 'delta'),
      vol('e', null)
    ]
    const w = mountCard({ orphanVolumes: { count: 5, bytes: 500_000_000 }, volumes })
    const block = w.get('[data-testid="docker-volumes"]')
    expect(w.get('[data-testid="docker-volumes-size"]').text()).toBe('5 volumes · 500 MB')
    expect(block.text()).toContain("Can't be restored")
    expect(block.text()).toContain('Projects: alpha, beta, gamma')
    expect(block.text()).toContain('+1 more')
  })

  it('toggles emit their category and the new value', async () => {
    const w = mountCard()
    await w.get('[data-testid="docker-toggle-cache"]').trigger('click')
    await w.get('[data-testid="docker-toggle-volumes"]').trigger('click')
    await w.get('[data-testid="docker-toggle-images"]').trigger('click')
    expect(w.emitted('toggle')).toEqual([
      ['dockerCache', false],
      ['volumes', false],
      ['dockerCache', false]
    ])
  })

  it('toggles reflect the prefs', () => {
    const prefs = defaultGcPrefs()
    prefs.categories.volumes = false
    const w = mountCard({ prefs })
    expect(w.get('[data-testid="docker-toggle-volumes"]').attributes('aria-checked')).toBe('false')
    expect(w.get('[data-testid="docker-toggle-cache"]').attributes('aria-checked')).toBe('true')
  })
})

describe('CleanupDockerCard — inspector door', () => {
  it('offers an Inspect stacks link that asks to open the Containers inspector', async () => {
    const w = mountCard()
    await w.get('[data-testid="docker-inspect"]').trigger('click')
    expect(w.emitted('inspect')).toHaveLength(1)
  })
})
