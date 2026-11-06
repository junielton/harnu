// @vitest-environment jsdom
/**
 * Campaign ch.4c (T607, AC-4c.5 and the pill half of AC-4c.6) — the campaign pill's margin rail
 * (one tick per chapter) and the radiant counter, mounted against the real stores with
 * `window.api` faked. Mockup `screens/v6--pill.html`.
 *
 * Every tick and number comes from the SERVER's `derived.progress` (`states`, `current`,
 * `radiant`): the fixtures below deliberately disagree with what the stored chapters would give
 * a recount, and the DOM must print the server's.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { i18n } from '../src/renderer/src/i18n'
import MissionPill from '../src/renderer/src/components/MissionPill.vue'
import { buildCampaignModel } from '../src/renderer/src/lib/campaign-view'
import type { CampaignView } from '../src/main/campaign-ipc'
import type { Chapter } from '../src/main/campaign-core'
import type { CampaignProgress, ChapterState } from '../src/main/campaign-progress'
import type { MissionView } from '../src/main/mission-ipc'
import { FIXTURE_NOW, fixtureView } from './helpers/mission-v3-view'

const OWNER = '11111111-2222-4333-8444-555555555555'

function chapter(n: number, over: Partial<Chapter> = {}): Chapter {
  return { id: `chp-${n}`, ordinal: n, title: `Chapter ${n}`, required: true, ...over }
}

/** Twelve required chapters + one side chapter; the 9th is bound to the session's own mission. */
function twelve(own: MissionView): Chapter[] {
  return [
    ...Array.from({ length: 12 }, (_, i) =>
      chapter(i + 1, i === 8 ? { missionId: own.mission.id } : {})
    ),
    chapter(13, { required: false, title: 'Lighter images' })
  ]
}

function view(
  own: MissionView,
  over: { states: Record<string, ChapterState> } & Partial<CampaignProgress>
): CampaignView {
  const progress: CampaignProgress = {
    total: 12,
    current: { from: 9, to: 9 },
    allDone: false,
    done: 7,
    inReview: 1,
    running: 1,
    locked: 3,
    side: { total: 1, done: 0, open: 1 },
    computedAt: new Date(FIXTURE_NOW).toISOString(),
    ...over
  }
  return {
    root: '/repo',
    title: 'Acme content migration',
    campaign: {
      id: 'cmp-0000000a',
      slug: 'acme-content-migration',
      folder: '/repo',
      owner: { sessionId: OWNER, folder: '/repo' },
      title: 'Acme content migration',
      declaredEnd: { kind: 'code', target: 'all pages live', evidence: 'review sheets' },
      chapters: twelve(own),
      status: 'active',
      createdAt: '2026-10-30T10:00:00.000Z',
      updatedAt: '2026-10-30T10:00:00.000Z',
      provenance: { author: 'agent', at: '2026-10-30T10:00:00.000Z' }
    },
    progress
  }
}

const NINE_OF_TWELVE: Record<string, ChapterState> = {
  'chp-1': 'done',
  'chp-2': 'done',
  'chp-3': 'done',
  'chp-4': 'done',
  'chp-5': 'done',
  'chp-6': 'done',
  'chp-7': 'done',
  'chp-8': 'inReview',
  'chp-9': 'running',
  'chp-10': 'locked',
  'chp-11': 'locked',
  'chp-12': 'locked',
  'chp-13': 'todo'
}

function install(own: MissionView, cv: CampaignView): void {
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [own], unreadable: [], shadowed: [] })),
    campaignList: vi.fn(async () => ({ views: [cv], unreadable: [] })),
    requestAttention: vi.fn(),
    foldersLoad: vi.fn(async () => [])
  }
}

const owned = (): MissionView =>
  fixtureView('faq-like', {
    mission: {
      owner: { sessionId: OWNER, folder: '/repo' },
      campaignId: 'cmp-0000000a',
      chapterId: 'chp-9'
    }
  })

async function mountPill(): Promise<ReturnType<typeof mount>> {
  const w = mount(MissionPill, {
    props: { sessionId: OWNER },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  await flushPromises()
  await nextTick()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('AC-4c.5 — the campaign model carries the rail', () => {
  it('one tick per REQUIRED chapter, in plan order, with the server’s state', () => {
    const own = owned()
    const model = buildCampaignModel(
      view(own, { states: NINE_OF_TWELVE }),
      [own],
      own.mission.id,
      FIXTURE_NOW
    )
    expect(model.ticks).toHaveLength(12)
    expect(model.ticks.map((t) => t.state)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
      'done',
      'done',
      'inReview',
      'running',
      'locked',
      'locked',
      'locked'
    ])
    // The side chapter is not a tick.
    expect(model.ticks.find((t) => t.chapterId === 'chp-13')).toBeUndefined()
  })

  it('marks the chapters the server’s current range names, and only those', () => {
    const own = owned()
    const model = buildCampaignModel(
      view(own, { states: NINE_OF_TWELVE, current: { from: 8, to: 9 } }),
      [own],
      own.mission.id,
      FIXTURE_NOW
    )
    expect(model.ticks.filter((t) => t.current).map((t) => t.chapterId)).toEqual(['chp-8', 'chp-9'])
    expect(model.currentIds).toEqual(['chp-8', 'chp-9'])
  })

  it('nothing is current once every chapter is done', () => {
    const own = owned()
    const done = Object.fromEntries(
      Object.keys(NINE_OF_TWELVE).map((k) => [k, 'done' as ChapterState])
    )
    const model = buildCampaignModel(
      view(own, { states: done, allDone: true, current: null }),
      [own],
      own.mission.id,
      FIXTURE_NOW
    )
    expect(model.ticks.some((t) => t.current)).toBe(false)
    expect(model.currentIds).toEqual([])
  })
})

describe('AC-4c.5 — the pill’s margin rail', () => {
  it('draws 12 ticks: done green, the in-review one dimmer green, the current one accent and wider, locked ones faint', async () => {
    const own = owned()
    install(own, view(own, { states: NINE_OF_TWELVE }))
    const w = await mountPill()
    const ticks = w.findAll('[data-test="campaign-ticks"] [data-tick]')
    expect(ticks).toHaveLength(12)
    expect(ticks[0].attributes('data-state')).toBe('done')
    expect(ticks[0].classes()).toContain('bg-green')
    expect(ticks[7].attributes('data-state')).toBe('inReview')
    expect(ticks[7].classes()).toContain('bg-green')
    expect(ticks[7].classes()).toContain('opacity-50')
    expect(ticks[8].attributes('data-current')).toBe('true')
    expect(ticks[8].classes()).toContain('bg-accent')
    // Wider than the others: 4px against 2px.
    expect(ticks[8].attributes('style')).toContain('width: 4px')
    expect(ticks[0].attributes('style')).toContain('width: 2px')
    expect(ticks[9].attributes('data-state')).toBe('locked')
    expect(ticks[9].classes()).toContain('bg-border-2')
    expect(ticks[9].classes()).toContain('opacity-50')
    w.unmount()
  })

  it('the rail is decoration: hidden from assistive tech, the label already says the position', async () => {
    const own = owned()
    install(own, view(own, { states: NINE_OF_TWELVE }))
    const w = await mountPill()
    expect(w.get('[data-test="campaign-ticks"]').attributes('aria-hidden')).toBe('true')
    w.unmount()
  })

  it('in the warning state the current tick is warning-coloured', async () => {
    const own = owned()
    // An owed item makes the campaign pill warning.
    own.you = [{ kind: 'human-steps', stepIds: ['stp-9'] }]
    install(own, view(own, { states: NINE_OF_TWELVE }))
    const w = await mountPill()
    const btn = w.get('button[data-state]')
    expect(btn.attributes('data-dsqa')).toBe('topbar-pill--warning')
    expect(w.findAll('[data-test="campaign-ticks"] [data-tick]')[8].classes()).toContain(
      'bg-warning'
    )
    w.unmount()
  })

  it('delivered: every tick is solid green and nothing is current', async () => {
    const own = owned()
    const done = Object.fromEntries(
      Object.keys(NINE_OF_TWELVE).map((k) => [k, 'done' as ChapterState])
    )
    install(own, view(own, { states: done, allDone: true, current: null, done: 12, locked: 0 }))
    const w = await mountPill()
    const ticks = w.findAll('[data-test="campaign-ticks"] [data-tick]')
    expect(ticks).toHaveLength(12)
    for (const t of ticks) {
      expect(t.classes()).toContain('bg-green')
      expect(t.attributes('data-current')).toBeUndefined()
    }
    w.unmount()
  })

  it('a campaign with no chapters draws no rail', async () => {
    const own = owned()
    const cv = view(own, { states: {}, total: 0, current: null })
    cv.campaign.chapters = []
    install(own, cv)
    const w = await mountPill()
    expect(w.find('[data-test="campaign-ticks"]').exists()).toBe(false)
    w.unmount()
  })

  it('a mission with no campaign keeps today’s pill: no rail, no radiant', async () => {
    const own = fixtureView('faq-like', {
      mission: { owner: { sessionId: OWNER, folder: '/repo' } }
    })
    ;(window as unknown as { api: unknown }).api = {
      missionList: vi.fn(async () => ({ views: [own], unreadable: [], shadowed: [] })),
      campaignList: vi.fn(async () => ({ views: [], unreadable: [] })),
      requestAttention: vi.fn(),
      foldersLoad: vi.fn(async () => [])
    }
    const w = await mountPill()
    expect(w.find('[data-test="campaign-ticks"]').exists()).toBe(false)
    expect(w.find('[data-test="campaign-pill-radiant"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('AC-4c.5 / AC-4c.6 — the radiant counter on the pill', () => {
  it('prints "48/88" from progress.radiant when the campaign has radiant chapters', async () => {
    const own = owned()
    const cv = view(own, { states: NINE_OF_TWELVE, radiant: { done: 48, total: 88 } })
    // Stored: one radiant chapter of 5 units. The server says 48 of 88 — the pill prints the server's.
    cv.campaign.chapters[3] = chapter(4, { radiant: { template: 'migrate page {slug}', total: 5 } })
    install(own, cv)
    const w = await mountPill()
    expect(w.get('[data-test="campaign-pill-radiant"]').text()).toBe('48/88')
    w.unmount()
  })

  it('prints nothing when the server reports no radiant', async () => {
    const own = owned()
    install(own, view(own, { states: NINE_OF_TWELVE }))
    const w = await mountPill()
    expect(w.find('[data-test="campaign-pill-radiant"]').exists()).toBe(false)
    w.unmount()
  })

  it('delivered still prints the final radiant, "88/88"', async () => {
    const own = owned()
    const done = Object.fromEntries(
      Object.keys(NINE_OF_TWELVE).map((k) => [k, 'done' as ChapterState])
    )
    install(
      own,
      view(own, {
        states: done,
        allDone: true,
        current: null,
        radiant: { done: 88, total: 88 }
      })
    )
    const w = await mountPill()
    expect(w.get('[data-test="campaign-pill-radiant"]').text()).toBe('88/88')
    w.unmount()
  })
})

describe('AC-4c.6 — the pill never recounts', () => {
  it('ticks follow progress.states and not the stored chapters', async () => {
    const own = owned()
    // Stored chapters know nothing of state; the server says only chapter 1 is done, 11 are not.
    const states: Record<string, ChapterState> = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`chp-${i + 1}`, i === 0 ? 'done' : 'todo'])
    )
    install(own, view(own, { states, done: 1, locked: 0, running: 0, inReview: 0 }))
    const w = await mountPill()
    const ticks = w.findAll('[data-test="campaign-ticks"] [data-tick]')
    expect(ticks.filter((t) => t.attributes('data-state') === 'done')).toHaveLength(1)
    expect(ticks.filter((t) => t.attributes('data-state') === 'todo')).toHaveLength(11)
    w.unmount()
  })
})
