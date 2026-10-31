// @vitest-environment jsdom
/**
 * Campaign ch.4b (T596) — the CampaignPopover and the MissionPopover additions, mounted with
 * props only (no store traffic).
 *
 *   AC-4b.2  Main quest / Side quests / Locked on the left, the open chapter's objectives with
 *            gate dots on the right, the You lane, the footer ("End campaign…" disabled with a
 *            reason because no campaign end door exists in main yet; "Open map" enabled by T607); no steward line and no merge-batch (chapter 5)
 *   AC-4b.3  the chapter popover: the back link, the You lane as aged rows (no "+N more"), the
 *            "Decide: …" row, the ledger tail
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import CampaignPopover from '../src/renderer/src/components/CampaignPopover.vue'
import MissionPopover from '../src/renderer/src/components/MissionPopover.vue'
import { buildCampaignModel } from '../src/renderer/src/lib/campaign-view'
import { buildMissionModel } from '../src/renderer/src/lib/mission-view'
import type { CampaignView } from '../src/main/campaign-ipc'
import type { MissionYouItem } from '../src/main/mcp/tool-handlers'
import type { LedgerRow, MissionStep } from '../src/main/mission-core'
import { FIXTURE_NOW, fixtureView } from './helpers/mission-v3-view'

const NOW = FIXTURE_NOW
const HOUR = 3_600_000

beforeEach(() => {
  setActivePinia(createPinia())
  ;(window as unknown as { api: unknown }).api = {
    missionList: async () => ({ views: [], unreadable: [], shadowed: [] }),
    campaignList: async () => ({ views: [], unreadable: [] })
  }
})

function setup(youOnOwn: MissionYouItem[] = []) {
  const own = fixtureView('faq-like', {
    mission: { id: 'mnt-00000002', campaignId: 'cmp-0000000a', chapterId: 'chp-2' },
    view: { you: youOnOwn }
  })
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
        { id: 'chp-2', ordinal: 2, title: 'Round 3', required: true, missionId: 'mnt-00000002' },
        { id: 'chp-3', ordinal: 3, title: 'Home', required: true },
        { id: 'chp-4', ordinal: 4, title: 'Lighter images', required: false }
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
      side: { total: 1, done: 0, open: 1 },
      states: { 'chp-1': 'done', 'chp-2': 'running', 'chp-3': 'locked', 'chp-4': 'todo' },
      computedAt: new Date(NOW).toISOString()
    }
  }
  const model = buildCampaignModel(cv, [own], own.mission.id, NOW)
  return { cv, model, own }
}

describe('AC-4b.2 — CampaignPopover', () => {
  function mountIt(you: MissionYouItem[] = []) {
    const { cv, model } = setup(you)
    return mount(CampaignPopover, {
      props: { view: cv, model },
      global: { plugins: [i18n] }
    })
  }

  it('is the 520px wide popover with the three groups on the left', () => {
    const w = mountIt()
    const root = w.get('[data-test="campaign-popover"]')
    expect(root.attributes('style')).toContain('width: 520px')
    expect(w.get('[data-test="campaign-main"]').text()).toContain('Pipeline')
    expect(w.get('[data-test="campaign-main"]').text()).toContain('Round 3')
    expect(w.get('[data-test="campaign-side"]').text()).toContain('Lighter images')
    expect(w.get('[data-test="campaign-locked"]').text()).toContain('Home')
  })

  it('prints the headline and the counts the server reported, and the declared end', () => {
    const w = mountIt()
    expect(w.get('[data-test="campaign-headline"]').text()).toBe('Chapter 2 of 3')
    expect(w.get('[data-test="campaign-counts"]').text()).toContain('1 done')
    expect(w.text()).toContain('All pages live')
  })

  it('the right pane lists the open chapter’s objectives with four gate dots each', () => {
    const w = mountIt()
    const pane = w.get('[data-test="campaign-objectives"]')
    const steps = pane.findAll('[data-objective]')
    // faq-like has nine counted steps.
    expect(steps).toHaveLength(9)
    expect(steps[0].findAll('[data-gate]')).toHaveLength(4)
  })

  it('shows the You lane: the first item boxed, the rest as rows', () => {
    const w = mountIt([
      { kind: 'human-steps', stepIds: ['stp-9'] },
      { kind: 'checks', count: 1, stepIds: ['stp-8'] }
    ])
    expect(w.get('[data-test="campaign-you"]').exists()).toBe(true)
    expect(w.findAll('[data-test="campaign-you-row"]')).toHaveLength(1)
  })

  it('has no steward line and no merge-batch control (chapter 5)', () => {
    const w = mountIt()
    expect(w.find('[data-test="campaign-steward"]').exists()).toBe(false)
    expect(w.find('[data-test="campaign-merge-batch"]').exists()).toBe(false)
  })

  it('"End campaign…" is rendered disabled with a tooltip saying why; "Open map" is enabled (T607)', () => {
    const w = mountIt()
    const end = w.get('[data-test="campaign-end"]')
    expect(end.attributes('disabled')).toBeDefined()
    expect(end.attributes('title')).toBeTruthy()
    const map = w.get('[data-test="campaign-open-map"]')
    expect(map.attributes('disabled')).toBeUndefined()
  })

  it('"Open chapter" emits the chapter’s mission id', async () => {
    const w = mountIt()
    await w.get('[data-test="campaign-open-chapter"]').trigger('click')
    expect(w.emitted('openChapter')?.[0]).toEqual(['mnt-00000002'])
  })
})

describe('AC-4b.3 — MissionPopover additions', () => {
  function mountMission(
    over: Parameters<typeof fixtureView>[1] = {},
    props: { campaignBack?: { ordinal: number; total: number } } = {}
  ) {
    const view = fixtureView('faq-like', over)
    const model = buildMissionModel(view, NOW)
    return mount(MissionPopover, {
      props: { view, model, ...props },
      global: { plugins: [i18n] }
    })
  }

  it('the back link names the chapter and emits back', async () => {
    const w = mountMission({}, { campaignBack: { ordinal: 9, total: 12 } })
    const back = w.get('[data-test="mission-back-to-campaign"]')
    expect(back.text()).toContain('Campaign')
    expect(back.text()).toContain('Chapter 9 of 12')
    await back.trigger('click')
    expect(w.emitted('back')).toHaveLength(1)
  })

  it('no back link without a campaign', () => {
    expect(mountMission().find('[data-test="mission-back-to-campaign"]').exists()).toBe(false)
  })

  it('the You lane is a boxed first item then one row per remaining item, with ages — no "+N more"', async () => {
    const raisedAt = new Date(NOW - 3 * HOUR).toISOString()
    const w = mountMission({
      mission: {
        blockers: [
          { reason: 'Need the CDN key', unblocks: 'it is shared', owner: 'operator', raisedAt }
        ]
      },
      view: {
        you: [
          { kind: 'human-steps', stepIds: ['stp-9'] },
          { kind: 'blocker', reason: 'Need the CDN key', unblocks: 'it is shared' },
          { kind: 'checks', count: 1, stepIds: ['stp-8'] }
        ]
      }
    })
    await flushPromises()
    expect(w.find('[data-test="mission-you-more"]').exists()).toBe(false)
    const rows = w.findAll('[data-test="mission-you-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Need the CDN key')
    expect(rows[0].get('[data-test="mission-you-age"]').text()).toBe('3h 0m')
    // No timestamp in the record: no age, rather than an invented one.
    expect(rows[1].find('[data-test="mission-you-age"]').exists()).toBe(false)
  })

  it('an undecided decision node adds a "Decide: …" row', () => {
    const steps: MissionStep[] = [
      {
        id: 'stp-1',
        ordinal: 1,
        kind: 'custom',
        title: 'Landing',
        verification: 'verifier',
        proof: 'unproven',
        links: [],
        blockers: [],
        decision: { title: 'Standard vs Combined', options: ['Standard', 'Combined'], blocks: [] }
      },
      {
        id: 'stp-2',
        ordinal: 2,
        kind: 'fixed-end',
        title: 'Delivered and verified',
        verification: 'verifier',
        proof: 'unproven',
        links: [],
        blockers: []
      }
    ]
    const w = mountMission({ mission: { steps } })
    expect(w.get('[data-test="mission-you-first"]').text()).toBe('Decide: Standard vs Combined')
  })

  it('renders the ledger tail: the last 5 rows, newest first, each with its age', () => {
    const ledger: LedgerRow[] = Array.from({ length: 7 }, (_, i) => ({
      at: new Date(NOW - (7 - i) * 60_000).toISOString(),
      kind: 'pr-merged' as const,
      ref: `#${300 + i}`,
      pr: 300 + i
    }))
    const w = mountMission({ mission: { ledger } })
    const rows = w.findAll('[data-test="mission-ledger-row"]')
    expect(rows).toHaveLength(5)
    expect(rows[0].text()).toContain('#306')
    expect(rows[4].text()).toContain('#302')
  })

  it('has no ledger section when the mission has no ledger', () => {
    expect(mountMission().find('[data-test="mission-ledger"]').exists()).toBe(false)
  })
})
