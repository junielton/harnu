// @vitest-environment jsdom
// U3.7 AC-2/AC-5: the Docker card's new blocks, from the approved mockup (screen docker-card).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupDockerCard from '../src/renderer/src/components/CleanupDockerCard.vue'
import { i18n } from '../src/renderer/src/i18n'
import enMessages from '../src/renderer/src/i18n/en.json'
import ptMessages from '../src/renderer/src/i18n/pt-BR.json'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { DockerReportItem, DockerWatchRecord } from '../src/main/gc/gc-wire'
import type { PausedStack, Tombstone } from '../src/main/containers/containers-wire'

const NOW = Date.parse('2026-11-05T12:00:00Z')
const HOUR = 3_600_000

const watch = (over: Partial<DockerWatchRecord> = {}): DockerWatchRecord => ({
  at: NOW,
  trigger: 'timer',
  mode: 'act',
  mark: 3,
  capacity: { known: true, total: 31, used: 15, free: 16, source: 'default' },
  pressure: false,
  found: 0,
  acted: 0,
  refused: 0,
  failed: 0,
  deferred: 0,
  locked: false,
  paused: false,
  pausedReason: null,
  nothingLeft: false,
  items: [],
  notice: null,
  report: null,
  ...over
})
const free = (n: number): DockerWatchRecord =>
  watch({ capacity: { known: true, total: 31, used: 31 - n, free: n, source: 'default' } })

const paused = (name: string, hoursAgo: number): PausedStack => ({
  stack: name,
  name,
  actor: 'autopilot',
  project: name,
  workingDir: `/w/${name}`,
  configFiles: [],
  profiles: [],
  envFile: null,
  hasBuild: false,
  ports: [],
  restoreCommand: `docker compose -p ${name} up -d`,
  pausedAt: NOW - hoursAgo * HOUR
})

const networkLine = (minAgo: number, name: string): Tombstone => ({
  at: NOW - minAgo * 60_000,
  actor: 'autopilot',
  verb: 'remove',
  stacks: [],
  restoreHint: null,
  reason: `Removed empty network \`${name}\` — no containers`
})

function mountCard(over: Record<string, unknown> = {}) {
  return mount(CleanupDockerCard, {
    props: {
      orphanVolumes: { count: 0, bytes: 0 },
      volumes: [],
      docker: { buildCacheReclaimableBytes: null, danglingImages: null, orphanVolumesHidden: null },
      lastCycle: null,
      prefs: defaultGcPrefs(),
      ...over
    },
    global: { plugins: [i18n] }
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('Docker networks block', () => {
  it('known: "16 of 31 network slots free" over a gauge, with the mark in the caption', () => {
    const w = mountCard({ dockerWatch: watch() })
    expect(w.get('[data-testid="docker-slots-free"]').text()).toBe('16 of 31 network slots free')
    expect(w.get('[data-testid="docker-slots-free"]').classes()).toContain('text-green')
    expect(w.get('[data-testid="docker-slots-caption"]').text()).toBe(
      'Default address pools. Cleanup acts when 3 or fewer are free.'
    )
    expect(w.find('[data-testid="docker-slots-badge"]').exists()).toBe(false)
    expect(w.get('[data-testid="docker-slots-gauge"]').attributes('aria-label')).toBe(
      '16 of 31 network slots free'
    )
  })

  it('the mark follows the Docker prefs (low-water slots)', () => {
    const prefs = defaultGcPrefs()
    prefs.docker.lowWaterSlots = 5
    const w = mountCard({ dockerWatch: watch(), prefs })
    expect(w.get('[data-testid="docker-slots-caption"]').text()).toContain('5 or fewer')
  })

  it('low: warning number, Low badge, the low-water caption', () => {
    const w = mountCard({ dockerWatch: free(3) })
    expect(w.get('[data-testid="docker-slots-free"]').classes()).toContain('text-warning')
    expect(w.get('[data-testid="docker-slots-badge"]').text()).toBe('Low')
    expect(w.get('[data-testid="docker-slots-caption"]').text()).toBe(
      'At the low-water mark of 3. Cleanup is clearing garbage and pausing the longest-idle stacks.'
    )
  })

  it('low while cleanup is off or paused says nothing will be freed on its own', () => {
    const off = mountCard({ dockerWatch: watch({ ...free(3), mode: 'off' }) })
    expect(off.get('[data-testid="docker-slots-caption"]').text()).toContain(
      'Automatic Docker cleanup is off, so nothing will be freed on its own.'
    )
    const paused = mountCard({ dockerWatch: watch({ ...free(3), mode: 'paused' }) })
    expect(paused.get('[data-testid="docker-slots-caption"]').text()).toContain(
      'Automatic Docker cleanup is paused, so nothing will be freed on its own.'
    )
  })

  it('none left: red number, None left badge, the compose up warning', () => {
    const w = mountCard({ dockerWatch: free(0) })
    expect(w.get('[data-testid="docker-slots-free"]').text()).toBe('0 of 31 network slots free')
    expect(w.get('[data-testid="docker-slots-free"]').classes()).toContain('text-red')
    expect(w.get('[data-testid="docker-slots-badge"]').text()).toBe('None left')
    expect(w.get('[data-testid="docker-slots-caption"]').text()).toContain(
      'A new compose up will fail until a slot opens.'
    )
  })

  it('unknown: the reason U3.6 sends, the Unknown badge and what cleanup still does', () => {
    const reason = "Docker Desktop runs its engine in a VM, so Harnu can't read its address pools."
    const w = mountCard({ dockerWatch: watch({ capacity: { known: false, reason } }) })
    expect(w.get('[data-testid="docker-slots-badge"]').text()).toBe('Unknown')
    expect(w.get('[data-testid="docker-slots-unknown"]').text()).toContain('Network slots unknown')
    expect(w.get('[data-testid="docker-slots-reason"]').text()).toBe(reason)
    expect(w.get('[data-testid="docker-slots"]').text()).toContain(
      'Cleanup still removes garbage and pauses idle stacks.'
    )
    expect(w.find('[data-testid="docker-slots-free"]').exists()).toBe(false)
  })

  it('no pass yet: unknown with a plain sentence, never "0 of 0"', () => {
    const w = mountCard()
    expect(w.get('[data-testid="docker-slots-badge"]').text()).toBe('Unknown')
    expect(w.get('[data-testid="docker-slots"]').text()).not.toContain('0 of 0')
  })
})

describe('Paused stacks block', () => {
  it('counts the paused stacks and lists the newest three with a copy button', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const w = mountCard({
      paused: [
        paused('proj-34', 72),
        paused('ext-12', 120),
        paused('ext-15', 48),
        paused('ext-16', 30),
        paused('ext-17', 24)
      ]
    })
    expect(w.get('[data-testid="docker-paused-count"]').text()).toBe('5 paused')
    const rows = w.findAll('[data-testid="docker-paused-row"]')
    expect(rows).toHaveLength(3)
    // Newest first: ext-17 (24 h), ext-16 (30 h), ext-15 (48 h).
    expect(rows[0]!.text()).toContain('ext-17')
    expect(rows[0]!.text()).toContain('idle 1 d')
    expect(w.get('[data-testid="docker-paused-more"]').text()).toBe('+ 2 more in Inspect stacks')
    await rows[0]!.get('[data-testid="docker-paused-copy"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith('docker compose -p ext-17 up -d')
  })

  it('says "None paused" when nothing is paused', () => {
    const w = mountCard()
    expect(w.get('[data-testid="docker-paused-count"]').text()).toBe('None paused')
    expect(w.find('[data-testid="docker-paused-row"]').exists()).toBe(false)
  })

  it('never says "parked"', () => {
    const w = mountCard({ paused: [paused('ext-12', 5)] })
    expect(w.get('[data-testid="docker-paused"]').text().toLowerCase()).not.toContain('park')
  })
})

describe('Automatic actions block', () => {
  it('lists the newest five with their reasons and offers Show all in Activity', async () => {
    const recent = Array.from({ length: 7 }, (_, i) => networkLine(i + 1, `ext-${i}_default`))
    const w = mountCard({ recent })
    const rows = w.findAll('[data-testid="docker-action-row"]')
    expect(rows).toHaveLength(5)
    expect(rows[0]!.get('[data-testid="docker-action-title"]').text()).toBe(
      'Removed empty network ext-0_default'
    )
    expect(rows[0]!.text()).toContain('No containers were attached')
    expect(rows[0]!.text()).toContain('1 min ago')
    expect(w.find('[data-testid="docker-action-would"]').exists()).toBe(false)
    await w.get('[data-testid="docker-actions-show-all"]').trigger('click')
    expect(w.emitted('showAll')).toHaveLength(1)
  })

  it('empty: the sentence about what is handled each cycle', () => {
    const w = mountCard()
    expect(w.get('[data-testid="docker-actions-empty"]').text()).toBe(
      'Nothing automatic yet. Empty networks, orphan stacks and idle stacks are handled each cycle.'
    )
  })
})

describe('the report-only first cycle', () => {
  const items: DockerReportItem[] = [
    {
      kind: 'network',
      target: 'ext-12_default',
      reason: 'Removed empty network `ext-12_default` — no containers'
    },
    { kind: 'pause', target: 'ext-12', reason: 'idle 120 h' }
  ]

  it('shows the badge, a link to Settings, and the list as Would have rows with the verb rewritten', async () => {
    const prefs = defaultGcPrefs()
    prefs.docker.firstReportAcknowledged = false
    const w = mountCard({
      prefs,
      dockerWatch: watch({ mode: 'report' }),
      report: { items, found: 2 },
      recent: [networkLine(5, 'old_default')]
    })
    expect(w.get('[data-testid="docker-report-badge"]').text()).toBe('Report only · first cycle')
    await w.get('[data-testid="docker-report-settings"]').trigger('click')
    expect(w.emitted('openSettings')).toHaveLength(1)

    const rows = w.findAll('[data-testid="docker-action-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.get('[data-testid="docker-action-would"]').text()).toBe('Would have')
    expect(rows[0]!.get('[data-testid="docker-action-title"]').text()).toBe(
      'Would remove empty network ext-12_default'
    )
    expect(rows[1]!.get('[data-testid="docker-action-title"]').text()).toBe('Would pause ext-12')
    expect(rows[1]!.text()).toContain('Idle for 120 h')
    expect(w.get('[data-testid="docker-actions"]').text()).toContain('nothing was changed')
    // The journal line is NOT mixed into a report-only list.
    expect(w.text()).not.toContain('old_default')
  })

  it('the paused block counts what the plan would pause', () => {
    const prefs = defaultGcPrefs()
    prefs.docker.firstReportAcknowledged = false
    const w = mountCard({ prefs, report: { items, found: 2 } })
    expect(w.get('[data-testid="docker-paused-count"]').text()).toBe('Would pause 1')
  })

  it('no badge once the report is acknowledged', () => {
    const prefs = defaultGcPrefs()
    prefs.docker.firstReportAcknowledged = true
    const w = mountCard({ prefs, report: null })
    expect(w.find('[data-testid="docker-report-badge"]').exists()).toBe(false)
  })
})

describe('order and copy', () => {
  it('lays the grid out slots, paused, the three existing blocks, then automatic actions', () => {
    const w = mountCard()
    const ids = [
      'docker-slots',
      'docker-paused',
      'docker-cache',
      'docker-images',
      'docker-volumes',
      'docker-actions'
    ]
    const order = w
      .findAll('[data-testid]')
      .map((n) => n.attributes('data-testid'))
      .filter((id) => ids.includes(id!))
    expect(order).toEqual(ids)
  })

  it('every new string exists in pt-BR as well', () => {
    const tree = (o: unknown, path = ''): string[] =>
      o && typeof o === 'object'
        ? Object.entries(o).flatMap(([k, v]) => tree(v, path ? `${path}.${k}` : k))
        : [path]
    const get = (m: unknown): unknown =>
      (m as { cleanup: { gc: { docker: Record<string, unknown> } } }).cleanup.gc.docker
    const en = get(enMessages) as Record<string, unknown>
    const pt = get(ptMessages) as Record<string, unknown>
    for (const group of ['slots', 'paused', 'actions', 'report', 'age']) {
      expect(en[group], `${group} in en`).toBeDefined()
      expect(tree(pt[group]).sort()).toEqual(tree(en[group]).sort())
    }
  })
})
