// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
      docker: { buildCacheReclaimableBytes: null, danglingImages: null },
      lastCycle: null,
      prefs: defaultGcPrefs(),
      ...over
    },
    global: { plugins: [i18n] }
  })
}

describe('CleanupDockerCard', () => {
  it('zero state: muted zeros for volumes, and real zeros when Docker says nothing is reclaimable', () => {
    const w = mountCard({
      docker: { buildCacheReclaimableBytes: 0, danglingImages: { count: 0, bytes: 0 } }
    })
    const volumes = w.get('[data-testid="docker-volumes-size"]')
    expect(volumes.text()).toBe('No orphan volumes')
    expect(volumes.classes()).toContain('text-text-3')
    expect(w.get('[data-testid="docker-cache-size"]').text()).toBe('0 B reclaimable')
    expect(w.get('[data-testid="docker-images-size"]').text()).toBe('0 images · 0 B')
  })

  it('shows what Docker could reclaim right now: the build cache and the dangling images', () => {
    const w = mountCard({
      docker: {
        buildCacheReclaimableBytes: 3_800_000_000,
        danglingImages: { count: 14, bytes: 1_100_000_000 }
      }
    })
    expect(w.get('[data-testid="docker-cache-size"]').text()).toBe('3.80 GB reclaimable')
    expect(w.get('[data-testid="docker-images-size"]').text()).toBe('14 images · 1.10 GB')
    expect(w.get('[data-testid="docker-cache"]').text()).toContain('Older than 7 days')
    expect(w.get('[data-testid="docker-cache-size"]').classes()).toContain('text-green')
  })

  it('says "size unavailable" only for a figure Docker did not give — never a confident zero', () => {
    const w = mountCard({
      docker: { buildCacheReclaimableBytes: null, danglingImages: { count: 2, bytes: 5_000_000 } }
    })
    expect(w.get('[data-testid="docker-cache-size"]').text()).toBe(
      i18n.global.t('cleanup.gc.docker.unavailable')
    )
    expect(w.get('[data-testid="docker-cache-size"]').classes()).toContain('text-text-3')
    expect(w.get('[data-testid="docker-images-size"]').text()).toBe('2 images · 5 MB')
  })

  it('also shows what the last automatic cycle reclaimed, once one has run', () => {
    const none = mountCard()
    expect(none.find('[data-testid="docker-cache-last"]').exists()).toBe(false)
    const w = mountCard({ lastCycle: cycle() })
    expect(w.get('[data-testid="docker-cache-last"]').text()).toBe('Last cycle reclaimed 3.80 GB')
    expect(w.get('[data-testid="docker-images-last"]').text()).toBe('Last cycle reclaimed 1.10 GB')
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

  it('the cache and image toggles emit the dockerCache category and the new value', async () => {
    const w = mountCard()
    await w.get('[data-testid="docker-toggle-cache"]').trigger('click')
    await w.get('[data-testid="docker-toggle-images"]').trigger('click')
    expect(w.emitted('toggle')).toEqual([
      ['dockerCache', false],
      ['dockerCache', false]
    ])
  })

  it('the toggles reflect the prefs', () => {
    const prefs = defaultGcPrefs()
    prefs.categories.dockerCache = false
    const w = mountCard({ prefs })
    expect(w.get('[data-testid="docker-toggle-cache"]').attributes('aria-checked')).toBe('false')
  })

  it('orphan volumes have no switch: they are never removed automatically (D1), only by hand', () => {
    const w = mountCard({ orphanVolumes: { count: 2, bytes: 500_000_000 } })
    expect(w.find('[data-testid="docker-toggle-volumes"]').exists()).toBe(false)
    expect(w.get('[data-testid="docker-volumes-note"]').text()).toBe(
      i18n.global.t('cleanup.gc.docker.volumesNote')
    )
  })
})

describe('CleanupDockerCard — inspector door', () => {
  it('offers an Inspect stacks link that asks to open the Containers inspector', async () => {
    const w = mountCard()
    await w.get('[data-testid="docker-inspect"]').trigger('click')
    expect(w.emitted('inspect')).toHaveLength(1)
  })
})

describe('CleanupDockerCard — parity with the approved mockup', () => {
  const figures = {
    buildCacheReclaimableBytes: 3_800_000_000,
    danglingImages: { count: 14, bytes: 1_100_000_000 }
  }

  it('has a subtitle saying it runs each cycle, with what the next cycle could reclaim', () => {
    const w = mountCard({ docker: figures })
    expect(w.get('[data-testid="docker-sub"]').text()).toBe('runs each cycle · 4.90 GB')
  })

  it('the subtitle is just "runs each cycle" when Docker gave no figure', () => {
    const w = mountCard()
    expect(w.get('[data-testid="docker-sub"]').text()).toBe('runs each cycle')
  })

  it('the subtitle says the autopilot leaves Docker alone when that switch is off', () => {
    const prefs = defaultGcPrefs()
    prefs.categories.dockerCache = false
    const w = mountCard({ docker: figures, prefs })
    expect(w.get('[data-testid="docker-sub"]').text()).toBe('Docker cleaning is off')
  })

  it('draws a split bar of cache, images and orphan volumes by bytes', () => {
    const w = mountCard({
      docker: figures,
      orphanVolumes: { count: 3, bytes: 900_000_000 },
      volumes: [vol('a', 'alpha')]
    })
    const bar = w.get('[data-testid="docker-split"]')
    const segs = bar.findAll('[data-seg]')
    expect(segs.map((s) => s.attributes('data-seg'))).toEqual(['cache', 'images', 'volumes'])
    expect(segs[0].attributes('style')).toContain('flex: 3800000000')
    expect(segs[2].classes()).toContain('bg-warning')
    expect(segs[0].classes()).toContain('bg-green')
  })

  it('draws no bar when every figure is zero or unavailable', () => {
    expect(mountCard().find('[data-testid="docker-split"]').exists()).toBe(false)
  })

  it('draws the orphan-volume block in the review (warning) colours, not the ready green', () => {
    const w = mountCard({
      orphanVolumes: { count: 2, bytes: 5_000_000 },
      volumes: [vol('a', 'alpha')]
    })
    const block = w.get('[data-testid="docker-volumes"]')
    expect(block.classes()).toContain('border-warning-line')
    expect(block.classes()).toContain('bg-warning-soft')
    expect(block.classes()).not.toContain('bg-green-soft')
    expect(w.get('[data-testid="docker-volumes-size"]').classes()).toContain('text-warning')
    // …while the cache and image blocks keep the ready green.
    expect(w.get('[data-testid="docker-cache"]').classes()).toContain('bg-green-soft')
  })
})

describe('CleanupDockerCard — hidden orphan volumes (S3 delta 4)', () => {
  const hidden = (reason: string, folders: string[]) => ({
    buildCacheReclaimableBytes: null,
    danglingImages: null,
    orphanVolumesHidden: { reason, folders }
  })

  it('shows no hint when nothing is hidden (null or absent)', () => {
    expect(mountCard().find('[data-testid="docker-hidden"]').exists()).toBe(false)
    const w = mountCard({
      docker: { buildCacheReclaimableBytes: null, danglingImages: null, orphanVolumesHidden: null }
    })
    expect(w.find('[data-testid="docker-hidden"]').exists()).toBe(false)
  })

  it('explains an unresolved compose name in one short sentence, without naming the folders', () => {
    const w = mountCard({
      docker: hidden('unresolved-compose-name', ['/ws/org/proj/www', '/ws/org/portal'])
    })
    const hint = w.get('[data-testid="docker-hidden"]')
    expect(hint.attributes('role')).toBe('note')
    expect(w.get('[data-testid="docker-hidden-text"]').text()).toBe(
      "Orphan volumes hidden: a compose project name couldn't be resolved in 2 folders"
    )
    // Folded away by default: no wall of folder names.
    expect(hint.findAll('[data-testid="docker-hidden-folder"]')).toHaveLength(0)
  })

  it('"Show folders" opens the list: basenames, each with its full path as a tooltip', async () => {
    const w = mountCard({
      docker: hidden('unresolved-compose-name', ['/ws/org/proj/www', '/ws/org/portal'])
    })
    const toggle = w.get('[data-testid="docker-hidden-toggle"]')
    expect(toggle.text()).toBe('Show folders')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(toggle.text()).toBe('Hide folders')
    const folders = w.findAll('[data-testid="docker-hidden-folder"]')
    expect(folders.map((f) => f.text())).toEqual(['www', 'portal'])
    expect(folders.map((f) => f.attributes('title'))).toEqual([
      '/ws/org/proj/www',
      '/ws/org/portal'
    ])
    await toggle.trigger('click')
    expect(w.findAll('[data-testid="docker-hidden-folder"]')).toHaveLength(0)
  })

  it('explains a scan limit with its own sentence, singular for one folder', () => {
    const w = mountCard({ docker: hidden('scan-limit', ['/ws/org/proj/www']) })
    expect(w.get('[data-testid="docker-hidden-text"]').text()).toBe(
      'Orphan volumes hidden: the compose scan hit its limit in 1 folder'
    )
  })

  it('says 0 volumes is not the full story: the volumes block explains instead of a bare zero', () => {
    const w = mountCard({ docker: hidden('unresolved-compose-name', ['/ws/a']) })
    expect(w.get('[data-testid="docker-volumes-size"]').text()).toBe('hidden')
  })

  it('says what the card counts, and what it never counts', () => {
    const w = mountCard()
    const text = w.get('[data-testid="docker-scope"]').text()
    expect(text).toContain('build cache older than 7 days and dangling images')
    expect(text).toContain('Images in use and the volumes of live stacks are never counted')
  })

  it('has a Portuguese sentence for both reasons', () => {
    for (const k of ['unresolvedCompose', 'scanLimit']) {
      const pt = JSON.parse(
        readFileSync(join(process.cwd(), 'src/renderer/src/i18n/pt-BR.json'), 'utf8')
      )
      expect(pt.cleanup.gc.docker.hidden[k]).toContain('{n}')
    }
  })
})
