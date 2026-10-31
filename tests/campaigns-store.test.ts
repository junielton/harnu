// @vitest-environment jsdom
/**
 * Campaign ch.4b (T596) — the campaigns store and the pill it feeds, mounted against the real
 * stores with `window.api` faked.
 *
 *   AC-4b.5  the store reads `campaign:list` through `window.api.campaignList`, and refreshes
 *            whenever the mission store refreshes
 *   AC-4b.1  a session whose mission is bound to a campaign gets the campaign pill; a session
 *            whose mission has none keeps today's pill, byte for byte
 *   AC-4b.2  the pill opens the CampaignPopover; its "Open chapter" opens the chapter popover
 *            with the back link (AC-4b.3)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { i18n } from '../src/renderer/src/i18n'
import MissionPill from '../src/renderer/src/components/MissionPill.vue'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useCampaignsStore } from '../src/renderer/src/stores/campaigns'
import type { CampaignView } from '../src/main/campaign-ipc'
import type { MissionView } from '../src/main/mission-ipc'
import { fixtureView } from './helpers/mission-v3-view'

const OWNER = '11111111-2222-4333-8444-555555555555'

let missionList: ReturnType<typeof vi.fn>
let campaignList: ReturnType<typeof vi.fn>

function campaignFor(ownView: MissionView): CampaignView {
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
      chapters: [
        { id: 'chp-1', ordinal: 1, title: 'Pipeline', required: true },
        {
          id: 'chp-2',
          ordinal: 2,
          title: 'Round 3',
          required: true,
          missionId: ownView.mission.id
        },
        { id: 'chp-3', ordinal: 3, title: 'Home', required: true }
      ],
      status: 'active',
      createdAt: '2026-10-30T10:00:00.000Z',
      updatedAt: '2026-10-30T10:00:00.000Z',
      provenance: { author: 'agent', at: '2026-10-30T10:00:00.000Z' }
    },
    progress: {
      total: 3,
      current: { from: 2, to: 2 },
      allDone: false,
      done: 1,
      inReview: 0,
      running: 1,
      locked: 1,
      side: { total: 0, done: 0, open: 0 },
      states: { 'chp-1': 'done', 'chp-2': 'running', 'chp-3': 'locked' },
      computedAt: '2026-10-01T12:00:00.000Z'
    }
  }
}

function install(views: MissionView[], campaigns: CampaignView[]): void {
  missionList = vi.fn(async () => ({ views, unreadable: [], shadowed: [] }))
  campaignList = vi.fn(async () => ({ views: campaigns, unreadable: [] }))
  ;(window as unknown as { api: unknown }).api = {
    missionList,
    campaignList,
    requestAttention: vi.fn(),
    foldersLoad: vi.fn(async () => [])
  }
}

const owned = (over: Parameters<typeof fixtureView>[1] = {}): MissionView =>
  fixtureView('faq-like', {
    ...over,
    mission: { owner: { sessionId: OWNER, folder: '/repo' }, ...over.mission }
  })

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('AC-4b.5 — the campaigns store', () => {
  it('loads campaigns through window.api.campaignList', async () => {
    const m = owned({ mission: { campaignId: 'cmp-0000000a', chapterId: 'chp-2' } })
    install([m], [campaignFor(m)])
    const campaigns = useCampaignsStore()
    await campaigns.refresh()
    expect(campaignList).toHaveBeenCalledTimes(1)
    expect(campaigns.views.map((v) => v.campaign.id)).toEqual(['cmp-0000000a'])
  })

  it('refreshes whenever the mission store refreshes', async () => {
    const m = owned({ mission: { campaignId: 'cmp-0000000a', chapterId: 'chp-2' } })
    install([m], [campaignFor(m)])
    const missions = useMissionsStore()
    const campaigns = useCampaignsStore()
    campaigns.ensureStarted()
    await flushPromises()
    campaignList.mockClear()
    await missions.refresh()
    await flushPromises()
    expect(campaignList).toHaveBeenCalledTimes(1)
    await missions.refresh()
    await flushPromises()
    expect(campaignList).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good list when a read fails', async () => {
    const m = owned({ mission: { campaignId: 'cmp-0000000a', chapterId: 'chp-2' } })
    install([m], [campaignFor(m)])
    const campaigns = useCampaignsStore()
    await campaigns.refresh()
    campaignList.mockRejectedValueOnce(new Error('boom'))
    await campaigns.refresh()
    expect(campaigns.views).toHaveLength(1)
  })

  it('finds the campaign a mission is bound to, and none for an unbound mission', async () => {
    const bound = owned({ mission: { campaignId: 'cmp-0000000a', chapterId: 'chp-2' } })
    install([bound], [campaignFor(bound)])
    const campaigns = useCampaignsStore()
    await campaigns.refresh()
    expect(campaigns.forMission(bound)?.campaign.id).toBe('cmp-0000000a')
    expect(campaigns.forMission(owned())).toBeNull()
  })
})

describe('AC-4b.1 — the pill', () => {
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

  it('a mission bound to a campaign reads "Ch. 2/3 · Step 8/9"', async () => {
    const m = owned({ mission: { campaignId: 'cmp-0000000a', chapterId: 'chp-2' } })
    install([m], [campaignFor(m)])
    const w = await mountPill()
    const btn = w.find('button[data-state]')
    expect(btn.text()).toContain('Ch. 2/3 · Step 8/9')
    expect(btn.attributes('data-campaign')).toBe('true')
    w.unmount()
  })

  it('a mission with no campaign keeps today’s pill: "Step 8 of 9"', async () => {
    install([owned()], [])
    const w = await mountPill()
    const btn = w.find('button[data-state]')
    expect(btn.text()).toBe('Step 8 of 9')
    expect(btn.attributes('data-campaign')).toBeUndefined()
    w.unmount()
  })

  it('a bound mission whose campaign is not loaded falls back to today’s pill', async () => {
    install([owned({ mission: { campaignId: 'cmp-0000000a', chapterId: 'chp-2' } })], [])
    const w = await mountPill()
    expect(w.find('button[data-state]').text()).toBe('Step 8 of 9')
    w.unmount()
  })

  it('clicking the campaign pill opens the CampaignPopover, not the mission popover', async () => {
    const m = owned({ mission: { campaignId: 'cmp-0000000a', chapterId: 'chp-2' } })
    install([m], [campaignFor(m)])
    const w = await mountPill()
    await w.find('button[data-state]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="campaign-popover"]').exists()).toBe(true)
    expect(w.find('[data-test="mission-count"]').exists()).toBe(false)
    w.unmount()
  })

  it('"Open chapter" opens the chapter popover with the back link, which returns to the campaign', async () => {
    const m = owned({ mission: { campaignId: 'cmp-0000000a', chapterId: 'chp-2' } })
    install([m], [campaignFor(m)])
    const w = await mountPill()
    await w.find('button[data-state]').trigger('click')
    await flushPromises()
    await w.find('[data-test="campaign-open-chapter"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="mission-count"]').exists()).toBe(true)
    const back = w.find('[data-test="mission-back-to-campaign"]')
    expect(back.exists()).toBe(true)
    expect(back.text()).toContain('Chapter 2 of 3')
    await back.trigger('click')
    await flushPromises()
    expect(w.find('[data-test="campaign-popover"]').exists()).toBe(true)
    w.unmount()
  })

  it('a mission with no campaign shows no back link in its popover', async () => {
    install([owned()], [])
    const w = await mountPill()
    await w.find('button[data-state]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="mission-count"]').exists()).toBe(true)
    expect(w.find('[data-test="mission-back-to-campaign"]').exists()).toBe(false)
    w.unmount()
  })
})
