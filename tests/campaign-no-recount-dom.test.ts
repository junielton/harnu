// @vitest-environment jsdom
/**
 * Campaign ch.4b (T596, AC-4b.4, Delta 1) — the RENDERED text never recounts. Both popovers are
 * mounted with a fixture whose `derived.progress` disagrees with a naive count of the stored
 * chapters / steps, and the DOM must print the server's numbers: "Chapter N of M", the Locked
 * count, the side open/done, "Step N of M", and the chapter back link.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import CampaignPopover from '../src/renderer/src/components/CampaignPopover.vue'
import MissionPopover from '../src/renderer/src/components/MissionPopover.vue'
import { buildCampaignModel } from '../src/renderer/src/lib/campaign-view'
import { buildMissionModel } from '../src/renderer/src/lib/mission-view'
import type { CampaignView } from '../src/main/campaign-ipc'
import type { MissionStep } from '../src/main/mission-core'
import { FIXTURE_NOW, fixtureView } from './helpers/mission-v3-view'

const NOW = FIXTURE_NOW

beforeEach(() => {
  setActivePinia(createPinia())
  ;(window as unknown as { api: unknown }).api = {
    missionList: async () => ({ views: [], unreadable: [], shadowed: [] }),
    campaignList: async () => ({ views: [], unreadable: [] })
  }
})

describe('CampaignPopover prints the campaign’s derived.progress', () => {
  // Stored: 4 chapters, ONE of them locked, ONE side chapter. Server: 12 required chapters, on the
  // 9th, 7 locked, 4 side (3 done, 1 open).
  const cv: CampaignView = {
    root: '/repo',
    title: 'Acme content migration',
    campaign: {
      id: 'cmp-0000000a',
      slug: 'acme',
      folder: '/repo',
      owner: { sessionId: 'owner', folder: '/repo' },
      title: 'Acme content migration',
      declaredEnd: { kind: 'code', target: 'All pages live', evidence: 'review sheets' },
      chapters: [
        { id: 'chp-1', ordinal: 1, title: 'Pipeline', required: true },
        { id: 'chp-2', ordinal: 2, title: 'Round 3', required: true },
        { id: 'chp-3', ordinal: 3, title: 'Home', required: true },
        { id: 'chp-4', ordinal: 4, title: 'Lighter images', required: false }
      ],
      status: 'active',
      createdAt: '2026-10-30T10:00:00.000Z',
      updatedAt: '2026-10-30T10:00:00.000Z',
      provenance: { author: 'agent', at: '2026-10-30T10:00:00.000Z' }
    },
    progress: {
      total: 12,
      current: { from: 2, to: 2 },
      allDone: false,
      done: 8,
      inReview: 1,
      running: 1,
      locked: 7,
      side: { total: 4, done: 3, open: 1 },
      states: { 'chp-1': 'done', 'chp-2': 'running', 'chp-3': 'locked', 'chp-4': 'todo' },
      computedAt: new Date(NOW).toISOString()
    }
  }

  it('the headline, the counts line and the group metas are the server’s', () => {
    const model = buildCampaignModel(cv, [], null, NOW)
    const w = mount(CampaignPopover, { props: { view: cv, model }, global: { plugins: [i18n] } })
    expect(w.get('[data-test="campaign-headline"]').text()).toBe('Chapter 2 of 12')
    expect(w.get('[data-test="campaign-counts"]').text()).toBe(
      '8 done · 1 in review · 1 running · 7 locked · 4 side (3 done, 1 open)'
    )
    // One locked chapter is listed, but the group says what the server counted.
    expect(w.get('[data-test="campaign-locked"]').text()).toMatch(/Locked\s*7/)
    expect(w.get('[data-test="campaign-main"]').text()).toMatch(/Main quest\s*2 of 12/)
    expect(w.get('[data-test="campaign-side"]').text()).toMatch(/Side quests\s*1 open/)
  })
})

describe('MissionPopover prints the mission’s derived.progress', () => {
  const step = (n: number, extra: Partial<MissionStep> = {}): MissionStep => ({
    id: `stp-${n}`,
    ordinal: n,
    kind: 'custom',
    title: `Step ${n}`,
    verification: 'verifier',
    proof: 'unproven',
    links: [],
    blockers: [],
    ...extra
  })

  /**
   * Stored: 3 counted steps and one side step whose STORED proof is `verified` (a naive read: the
   * side bucket is all done). Server: 20 steps, on the 15th, and the side step is still `todo`
   * (gates govern the stored proof).
   */
  function disagreeing() {
    const base = fixtureView('faq-like', {
      mission: {
        steps: [
          step(1, { proof: 'verified' }),
          step(2),
          step(3, { kind: 'fixed-end', title: 'Delivered and verified' }),
          step(4, { required: false, discoveredFrom: 'stp-2', title: 'Fix CI', proof: 'verified' })
        ]
      }
    })
    const progress = {
      ...base.progress,
      total: 20,
      current: { from: 15, to: 15 },
      done: 14,
      verified: 9,
      side: {
        count: 1,
        steps: [{ id: 'stp-4', state: 'todo' as const, discoveredFrom: 'stp-2' }]
      },
      states: { ...base.progress.states, 'stp-4': 'todo' as const }
    }
    return { ...base, progress, derived: { ...base.derived, progress } }
  }

  it('prints "Step 15 of 20", the server’s counts and the server’s side open/done', async () => {
    const view = disagreeing()
    const w = mount(MissionPopover, {
      props: { view, model: buildMissionModel(view, NOW) },
      global: { plugins: [i18n] }
    })
    expect(w.get('[data-test="mission-count"]').text()).toBe('Step 15 of 20')
    expect(w.get('[data-test="mission-counts"]').text()).toContain('14 done · 9 verified')
    // Stored proof says the side step is done; the server says it is open.
    expect(w.text()).toContain('1 open')
    expect(w.text()).not.toMatch(/0 open/)
  })

  it('the back link names a position only for the chapter the campaign is on, from the server', () => {
    const view = disagreeing()
    const model = buildMissionModel(view, NOW)
    const on = mount(MissionPopover, {
      props: { view, model, campaignBack: { ordinal: 9, total: 12 } },
      global: { plugins: [i18n] }
    })
    expect(on.get('[data-test="mission-back-to-campaign"]').text()).toContain('Chapter 9 of 12')
    // Not the current chapter: just "Campaign", no number made up.
    const off = mount(MissionPopover, {
      props: { view, model, campaignBack: { ordinal: null, total: 12 } },
      global: { plugins: [i18n] }
    })
    expect(off.get('[data-test="mission-back-to-campaign"]').text()).toBe('Campaign')
    // A side chapter says so.
    const side = mount(MissionPopover, {
      props: { view, model, campaignBack: { ordinal: null, total: 12, side: true } },
      global: { plugins: [i18n] }
    })
    expect(side.get('[data-test="mission-back-to-campaign"]').text()).toContain('Side quest')
  })
})
