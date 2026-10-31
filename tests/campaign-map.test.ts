// @vitest-environment jsdom
/**
 * Campaign ch.4c (T607) — the CampaignMap takeover, mounted against the real stores with
 * `window.api` faked. Mockup `screens/v6--map.html` (states `default`, `chapter-focus`).
 *
 *   AC-4c.1  tiles by dependency with arrows, side quests docked under their origin, locked tiles
 *            with the padlock, "You are here" on `progress.current`, the header (title, declared
 *            end, radiant counter)
 *   AC-4c.2  chapter-focus: a click shows that chapter's mission steps with gate dots
 *   AC-4c.3  right column: the You ledger with ages, the Steward feed's empty state, side quests
 *   AC-4c.4  "Open map" in the Campaign popover opens the map; Esc (the shared binding) closes it
 *   AC-4c.6  every number printed is the server's (`derived.progress`): a disagreeing fixture
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { i18n } from '../src/renderer/src/i18n'
import CampaignMap from '../src/renderer/src/components/CampaignMap.vue'
import CampaignPopover from '../src/renderer/src/components/CampaignPopover.vue'
import { buildCampaignModel } from '../src/renderer/src/lib/campaign-view'
import { closeTakeoverBinding } from '../src/renderer/src/lib/takeover-esc'
import { useUiStore } from '../src/renderer/src/stores/ui'
import type { CampaignView } from '../src/main/campaign-ipc'
import type { Chapter } from '../src/main/campaign-core'
import type { CampaignProgress, ChapterState } from '../src/main/campaign-progress'
import type { MissionView } from '../src/main/mission-ipc'
import type { MissionStep } from '../src/main/mission-core'
import { FIXTURE_NOW, fixtureView } from './helpers/mission-v3-view'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'

const OWNER = '11111111-2222-4333-8444-555555555555'
const CMP = 'cmp-0000000a'

function chapter(n: number, over: Partial<Chapter> = {}): Chapter {
  return { id: `chp-${n}`, ordinal: n, title: `Chapter ${n}`, required: true, ...over }
}

/** Mission for chapter 2: nine counted steps (faq-like), the owner's. */
function ownMission(): MissionView {
  return fixtureView('faq-like', {
    mission: {
      id: 'mnt-00000002',
      owner: { sessionId: OWNER, folder: '/repo' },
      campaignId: CMP,
      chapterId: 'chp-2'
    }
  })
}

/**
 * Acme: 5 required chapters (done, running, two locked, one todo) and two side chapters, one
 * docked under chapter 2 and one under chapter 1. Chapter 4 is the radiant one.
 */
function acme(own: MissionView, over: Partial<CampaignProgress> = {}): CampaignView {
  const chapters: Chapter[] = [
    chapter(1, { title: 'Pipeline', produces: ['pipeline'] }),
    chapter(2, { title: 'Round 3', missionId: own.mission.id, produces: ['pages'] }),
    chapter(3, { title: 'Home', consumes: ['pages'] }),
    chapter(4, {
      title: 'Content batches',
      consumes: ['pipeline', 'pages'],
      radiant: { template: 'migrate page {slug}', total: 88 }
    }),
    chapter(5, { title: 'Closing' }),
    chapter(6, {
      title: 'Lighter images',
      required: false,
      discoveredFrom: { chapterId: 'chp-1' }
    }),
    chapter(7, {
      title: 'Docker address pool exhausted',
      required: false,
      discoveredFrom: { chapterId: 'chp-2' }
    })
  ]
  const states: Record<string, ChapterState> = {
    'chp-1': 'done',
    'chp-2': 'running',
    'chp-3': 'locked',
    'chp-4': 'locked',
    'chp-5': 'todo',
    'chp-6': 'done',
    'chp-7': 'todo'
  }
  return {
    root: '/repo',
    title: 'Acme content migration',
    campaign: {
      id: CMP,
      slug: 'acme-content-migration',
      folder: '/repo',
      owner: { sessionId: OWNER, folder: '/repo' },
      title: 'Acme content migration',
      declaredEnd: { kind: 'code', target: 'All 88 pages live', evidence: 'review sheets' },
      chapters,
      status: 'active',
      createdAt: '2026-10-30T10:00:00.000Z',
      updatedAt: '2026-10-30T10:00:00.000Z',
      provenance: { author: 'agent', at: '2026-10-30T10:00:00.000Z' }
    },
    progress: {
      total: 5,
      current: { from: 2, to: 2 },
      allDone: false,
      done: 1,
      inReview: 0,
      running: 1,
      locked: 2,
      side: { total: 2, done: 1, open: 1 },
      radiant: { done: 48, total: 88 },
      states,
      computedAt: new Date(FIXTURE_NOW).toISOString(),
      ...over
    }
  }
}

function install(views: MissionView[], campaigns: CampaignView[]): void {
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views, unreadable: [], shadowed: [] })),
    campaignList: vi.fn(async () => ({ views: campaigns, unreadable: [] })),
    requestAttention: vi.fn(),
    foldersLoad: vi.fn(async () => [])
  }
}

async function mountMap(cv: CampaignView = acme(ownMission()), mv: MissionView[] = [ownMission()]) {
  install(mv, [cv])
  const ui = useUiStore()
  ui.openCampaignMap(cv.campaign.id)
  const w = mount(CampaignMap, { global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  await nextTick()
  return { w, ui }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  stubTakeoverShellTargets()
})

describe('AC-4c.1 — the board', () => {
  it('draws one tile per required chapter in plan order, with number, title and the state word', async () => {
    const { w } = await mountMap()
    const tiles = w.findAll('[data-test="campaign-map-tile"]')
    expect(tiles.map((t) => t.attributes('data-chapter'))).toEqual([
      'chp-1',
      'chp-2',
      'chp-3',
      'chp-4',
      'chp-5'
    ])
    expect(tiles[1].text()).toContain('Round 3')
    expect(tiles[1].get('[data-test="campaign-map-tile-n"]').text()).toBe('2')
    expect(tiles[0].attributes('data-state')).toBe('done')
    expect(tiles[0].text()).toContain('done')
    expect(tiles[1].text()).toContain('running')
    w.unmount()
  })

  it('places each tile on the 4-column grid (the layout lib’s coordinates)', async () => {
    const { w } = await mountMap()
    const style = (id: string) =>
      w.get(`[data-test="campaign-map-tile"][data-chapter="${id}"]`).attributes('style')
    expect(style('chp-1')).toContain('left: 0px')
    expect(style('chp-2')).toContain('left: 200px')
    expect(style('chp-4')).toContain('left: 600px')
    // The 5th wraps to the second row.
    expect(style('chp-5')).toContain('left: 0px')
    w.unmount()
  })

  it('locked tiles carry the padlock and a dashed look; unlocked tiles do not', async () => {
    const { w } = await mountMap()
    const locked = w.get('[data-test="campaign-map-tile"][data-chapter="chp-3"]')
    expect(locked.find('[data-test="campaign-map-lock"]').exists()).toBe(true)
    expect(locked.classes()).toContain('border-dashed')
    const open = w.get('[data-test="campaign-map-tile"][data-chapter="chp-2"]')
    expect(open.find('[data-test="campaign-map-lock"]').exists()).toBe(false)
    w.unmount()
  })

  it('"You are here" sits on the chapter progress.current names, and only there', async () => {
    const { w } = await mountMap()
    const here = w.findAll('[data-test="campaign-map-here"]')
    expect(here).toHaveLength(1)
    expect(here[0].text()).toContain('You are here')
    expect(
      here[0].element.closest('[data-test="campaign-map-tile"]')?.getAttribute('data-chapter')
    ).toBe('chp-2')
    w.unmount()
  })

  it('draws arrows from the dependency edges: tokens, plus the plan order where none enters', async () => {
    const { w } = await mountMap()
    const edges = w.findAll('[data-test="campaign-map-edge"]')
    const names = edges.map((e) => `${e.attributes('data-from')}>${e.attributes('data-to')}`)
    // 2 produces `pages`, 3 consumes it; 4 consumes `pipeline` (1) and `pages` (2); 5 has no
    // dependency so it follows the plan order from 4.
    expect(names).toContain('chp-1>chp-2')
    expect(names).toContain('chp-2>chp-3')
    expect(names).toContain('chp-1>chp-4')
    expect(names).toContain('chp-2>chp-4')
    expect(names).toContain('chp-4>chp-5')
    expect(names).not.toContain('chp-3>chp-4')
    const toLocked = edges.find((e) => e.attributes('data-to') === 'chp-3')!
    expect(toLocked.attributes('data-kind')).toBe('lock')
    expect(
      edges
        .find((e) => e.attributes('data-from') === 'chp-1' && e.attributes('data-to') === 'chp-2')!
        .attributes('data-kind')
    ).toBe('cur')
    w.unmount()
  })

  it('docks each side chapter under the chapter it was discovered from', async () => {
    const { w } = await mountMap()
    const docks = w.findAll('[data-test="campaign-map-dock"]')
    expect(
      docks.map((d) => `${d.attributes('data-origin')}:${d.attributes('data-chapter')}`)
    ).toEqual(['chp-1:chp-6', 'chp-2:chp-7'])
    expect(docks[0].text()).toContain('Lighter images')
    // A done side quest wears the check, an open one the diamond.
    expect(docks[0].text()).toContain('✓')
    expect(docks[1].text()).toContain('◇')
    w.unmount()
  })

  it('the header holds the title, the server headline, the declared end and the radiant counter', async () => {
    const { w } = await mountMap()
    expect(w.get('[data-test="campaign-map-title"]').text()).toBe('Acme content migration')
    expect(w.get('[data-test="campaign-map-headline"]').text()).toBe('Chapter 2 of 5')
    expect(w.get('[data-test="campaign-map-end"]').text()).toContain('All 88 pages live')
    expect(w.get('[data-test="campaign-map-radiant"]').text()).toContain('48 / 88')
    w.unmount()
  })

  it('no radiant chapter, no radiant counter', async () => {
    const own = ownMission()
    const cv = acme(own)
    delete cv.progress.radiant
    const { w } = await mountMap(cv, [own])
    expect(w.find('[data-test="campaign-map-radiant"]').exists()).toBe(false)
    w.unmount()
  })

  it('the footer prints the server’s counts line', async () => {
    const { w } = await mountMap()
    expect(w.get('[data-test="campaign-map-counts"]').text()).toBe(
      '1 done · 0 in review · 1 running · 2 locked · 2 side (1 done, 1 open)'
    )
    w.unmount()
  })

  it('a campaign that is not loaded says so instead of drawing an empty board', async () => {
    install([], [])
    const ui = useUiStore()
    ui.openCampaignMap('cmp-gone')
    const w = mount(CampaignMap, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(w.find('[data-test="campaign-map-board"]').exists()).toBe(false)
    expect(w.get('[data-test="campaign-map-missing"]').text()).toContain('isn’t available')
    w.unmount()
  })
})

describe('AC-4c.2 — chapter-focus', () => {
  it('clicking a tile shows that chapter’s steps with four gate dots each', async () => {
    const { w } = await mountMap()
    expect(w.find('[data-test="campaign-map-focus"]').exists()).toBe(false)
    await w.get('[data-test="campaign-map-tile"][data-chapter="chp-2"]').trigger('click')
    const focus = w.get('[data-test="campaign-map-focus"]')
    expect(focus.text()).toContain('Round 3')
    const steps = focus.findAll('[data-objective]')
    // faq-like has nine counted steps (the end step included in the list the popover uses).
    expect(steps).toHaveLength(9)
    expect(steps[0].findAll('[data-gate]')).toHaveLength(4)
    expect(w.get('[data-test="campaign-map"]').attributes('data-state')).toBe('chapter-focus')
    w.unmount()
  })

  it('the focus panel names the mission’s own server headline', async () => {
    const { w } = await mountMap()
    await w.get('[data-test="campaign-map-tile"][data-chapter="chp-2"]').trigger('click')
    expect(w.get('[data-test="campaign-map-focus-headline"]').text()).toBe('Step 8 of 9')
    w.unmount()
  })

  it('dims the other tiles while one is focused, and Back returns to the default state', async () => {
    const { w } = await mountMap()
    await w.get('[data-test="campaign-map-tile"][data-chapter="chp-2"]').trigger('click')
    expect(w.get('[data-test="campaign-map-tile"][data-chapter="chp-1"]').classes()).toContain(
      'opacity-50'
    )
    expect(w.get('[data-test="campaign-map-tile"][data-chapter="chp-3"]').classes()).toContain(
      'opacity-30'
    )
    expect(w.get('[data-test="campaign-map-tile"][data-chapter="chp-2"]').classes()).not.toContain(
      'opacity-50'
    )
    await w.get('[data-test="campaign-map-focus-back"]').trigger('click')
    expect(w.find('[data-test="campaign-map-focus"]').exists()).toBe(false)
    expect(w.get('[data-test="campaign-map"]').attributes('data-state')).toBe('default')
    expect(w.find('[data-test="campaign-map-side"]').exists()).toBe(true)
    w.unmount()
  })

  it('a chapter with no open mission says so, with no steps', async () => {
    const { w } = await mountMap()
    await w.get('[data-test="campaign-map-tile"][data-chapter="chp-3"]').trigger('click')
    const focus = w.get('[data-test="campaign-map-focus"]')
    expect(focus.findAll('[data-objective]')).toHaveLength(0)
    expect(focus.get('[data-test="campaign-map-focus-empty"]').text()).toContain('Locked until')
    w.unmount()
  })

  it('a docked side quest focuses too', async () => {
    const { w } = await mountMap()
    await w.get('[data-test="campaign-map-dock"][data-chapter="chp-7"]').trigger('click')
    expect(w.get('[data-test="campaign-map-focus"]').text()).toContain(
      'Docker address pool exhausted'
    )
    w.unmount()
  })
})

describe('AC-4c.3 — the right column', () => {
  it('lists the You ledger with ages: every owed item of the open chapters', async () => {
    const own = ownMission()
    own.you = [
      { kind: 'human-steps', stepIds: ['stp-9'] },
      { kind: 'checks', count: 1, stepIds: ['stp-8'] }
    ]
    const { w } = await mountMap(acme(own), [own])
    const ledger = w.get('[data-test="campaign-map-ledger"]')
    expect(ledger.get('[data-test="campaign-map-ledger-total"]').text()).toBe('2 owed')
    const rows = ledger.findAll('[data-test="campaign-map-ledger-row"]')
    expect(rows).toHaveLength(2)
    // Each row is tagged with the chapter that owes it.
    expect(rows[0].text()).toContain('ch. 2')
    w.unmount()
  })

  it('an empty ledger reads clear', async () => {
    const { w } = await mountMap()
    expect(w.get('[data-test="campaign-map-ledger"]').text()).toContain('Nothing')
    w.unmount()
  })

  it('a ledger row’s button focuses the chapter that owes it', async () => {
    const own = ownMission()
    own.you = [{ kind: 'human-steps', stepIds: ['stp-9'] }]
    const { w } = await mountMap(acme(own), [own])
    await w.get('[data-test="campaign-map-ledger-open"]').trigger('click')
    expect(w.get('[data-test="campaign-map-focus"]').text()).toContain('Round 3')
    w.unmount()
  })

  it('the Steward feed renders an empty state — chapter 5 wires the feed', async () => {
    const { w } = await mountMap()
    const steward = w.get('[data-test="campaign-map-steward"]')
    expect(steward.text()).toContain('Steward')
    expect(steward.text()).toContain('No steward yet')
    w.unmount()
  })

  it('lists the side quests with their origin chapter and state, meta from the server', async () => {
    const { w } = await mountMap()
    const side = w.get('[data-test="campaign-map-side"]')
    expect(side.get('[data-test="campaign-map-side-meta"]').text()).toBe('2 · 1 done · 1 open')
    const rows = side.findAll('[data-test="campaign-map-side-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Lighter images')
    expect(rows[0].text()).toContain('ch. 1')
    expect(rows[0].text()).toContain('done')
    expect(rows[1].text()).toContain('ch. 2')
    w.unmount()
  })
})

describe('AC-4c.4 — opening and closing the map', () => {
  function popover(cv: CampaignView) {
    const own = ownMission()
    return mount(CampaignPopover, {
      props: { view: cv, model: buildCampaignModel(cv, [own], own.mission.id, FIXTURE_NOW) },
      global: { plugins: [i18n] }
    })
  }

  it('"Open map" in the Campaign popover is enabled', () => {
    const w = popover(acme(ownMission()))
    expect(w.get('[data-test="campaign-open-map"]').attributes('disabled')).toBeUndefined()
  })

  it('clicking it opens the campaign map takeover for that campaign', async () => {
    const w = popover(acme(ownMission()))
    const ui = useUiStore()
    expect(ui.activeView).toBeNull()
    await w.get('[data-test="campaign-open-map"]').trigger('click')
    expect(ui.activeView?.id).toBe('campaignMap')
    expect(ui.campaignMap).toEqual({ open: true, campaignId: CMP })
  })

  it('clicking it closes the Topbar popover that hosted the button', async () => {
    const w = popover(acme(ownMission()))
    const ui = useUiStore()
    ui.setPopoverAnchor('missionProgress', true)
    ui.openPopover('missionProgress')
    await w.get('[data-test="campaign-open-map"]').trigger('click')
    expect(ui.popovers.missionProgress).toBe(false)
  })

  it('Esc closes it through the shared view.closeTakeover binding', () => {
    const ui = useUiStore()
    ui.openCampaignMap(CMP)
    const b = closeTakeoverBinding(ui)
    expect(b.enabled()).toBe(true)
    b.handler()
    expect(ui.activeView).toBeNull()
  })

  it('opening it again keeps it open; closeCampaignMap closes it', () => {
    const ui = useUiStore()
    ui.openCampaignMap(CMP)
    ui.openCampaignMap(CMP)
    expect(ui.activeView?.id).toBe('campaignMap')
    ui.closeCampaignMap()
    expect(ui.activeView).toBeNull()
  })
})

describe('AC-4c.6 — the map never recounts', () => {
  /**
   * Stored: 5 required chapters, one locked in the data's tokens, two side chapters, a radiant
   * chapter of 88 units. The server says: 30 chapters, on the 22nd, 4 done, 17 locked, 6 side
   * (2 done, 4 open), radiant 3 of 4.
   */
  function disagreeing(own: MissionView): CampaignView {
    return acme(own, {
      total: 30,
      current: { from: 22, to: 22 },
      done: 4,
      inReview: 9,
      running: 2,
      locked: 17,
      side: { total: 6, done: 2, open: 4 },
      radiant: { done: 3, total: 4 }
    })
  }

  it('prints the server headline, counts, side meta and radiant', async () => {
    const own = ownMission()
    const { w } = await mountMap(disagreeing(own), [own])
    expect(w.get('[data-test="campaign-map-headline"]').text()).toBe('Chapter 22 of 30')
    expect(w.get('[data-test="campaign-map-counts"]').text()).toBe(
      '4 done · 9 in review · 2 running · 17 locked · 6 side (2 done, 4 open)'
    )
    expect(w.get('[data-test="campaign-map-side-meta"]').text()).toBe('6 · 2 done · 4 open')
    const radiant = w.get('[data-test="campaign-map-radiant"]').text()
    expect(radiant).toContain('3 / 4')
    expect(radiant).not.toContain('88')
    w.unmount()
  })

  it('the radiant bar is the server’s ratio', async () => {
    const own = ownMission()
    const { w } = await mountMap(disagreeing(own), [own])
    expect(w.get('[data-test="campaign-map-radiant-bar"]').attributes('style')).toContain(
      'width: 75%'
    )
    w.unmount()
  })

  it('the focus headline is the mission’s server headline, not a count of its steps', async () => {
    const own = ownMission()
    const progress = {
      ...own.progress,
      total: 40,
      current: { from: 31, to: 31 }
    }
    const stepsBefore: MissionStep[] = own.mission.steps
    const disagree: MissionView = {
      ...own,
      progress,
      derived: { ...own.derived, progress }
    }
    expect(stepsBefore.length).not.toBe(40)
    const { w } = await mountMap(acme(disagree), [disagree])
    await w.get('[data-test="campaign-map-tile"][data-chapter="chp-2"]').trigger('click')
    expect(w.get('[data-test="campaign-map-focus-headline"]').text()).toBe('Step 31 of 40')
    w.unmount()
  })
})
