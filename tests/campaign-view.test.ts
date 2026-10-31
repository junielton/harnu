/**
 * Campaign ch.4b (T596) — the renderer's campaign view model (`lib/campaign-view.ts`) and the
 * mission-view additions the chapter popover needs (`youRows`, `ledgerTail`).
 *
 *   AC-4b.1  the pill reads "Ch. N/M · Step a/b", adds "· n for you", and "Ch. M/M ✓" when delivered
 *   AC-4b.2  the popover's groups: Main quest / Side quests / Locked, the counts line, the You lane
 *   AC-4b.3  the ledger tail, the You lane as aged rows, the "Decide: …" row
 *   AC-4b.4  the renderer never recounts: every number is the server's `derived.progress`
 *
 * Expectations are written from the spec's words and hand-computed cases, never copied from what
 * the code returned (testing/003).
 */
import { describe, it, expect } from 'vitest'
import type { Campaign, Chapter } from '../src/main/campaign-core'
import type { CampaignView } from '../src/main/campaign-ipc'
import type { CampaignProgress, ChapterState } from '../src/main/campaign-progress'
import type { MissionView } from '../src/main/mission-ipc'
import type { MissionYouItem } from '../src/main/mcp/tool-handlers'
import type { LedgerRow, MissionStep } from '../src/main/mission-core'
import { i18n } from '../src/renderer/src/i18n'
import {
  buildCampaignModel,
  campaignForMission,
  campaignPillText
} from '../src/renderer/src/lib/campaign-view'
import { buildMissionModel, ledgerTail, youRows } from '../src/renderer/src/lib/mission-view'
import { FIXTURE_NOW, fixtureView } from './helpers/mission-v3-view'

const NOW = FIXTURE_NOW
const t = (key: string, named?: Record<string, unknown>): string =>
  i18n.global.t(key, named ?? {}) as string

function chapter(n: number, over: Partial<Chapter> = {}): Chapter {
  return { id: `chp-${n}`, ordinal: n, title: `Chapter ${n}`, required: true, ...over }
}

/** A campaign progress as the SERVER reports it — hand-built so a test controls every number. */
function progress(over: Partial<CampaignProgress> & { states: Record<string, ChapterState> }) {
  const base: CampaignProgress = {
    total: 3,
    current: { from: 2, to: 2 },
    allDone: false,
    done: 1,
    inReview: 0,
    running: 1,
    locked: 1,
    side: { total: 1, done: 0, open: 1 },
    states: {},
    computedAt: new Date(NOW).toISOString()
  }
  return { ...base, ...over }
}

function campaignView(
  chapters: Chapter[],
  p: CampaignProgress,
  over: Partial<Campaign> = {}
): CampaignView {
  return {
    root: '/repo',
    title: 'Acme content migration',
    campaign: {
      id: 'cmp-0000000a',
      slug: 'acme-content-migration',
      folder: '/repo',
      owner: { sessionId: 'owner', folder: '/repo' },
      title: 'Acme content migration',
      declaredEnd: { kind: 'code', target: 'all pages live', evidence: 'review sheets' },
      chapters,
      status: 'active',
      createdAt: '2026-10-30T10:00:00.000Z',
      updatedAt: '2026-10-30T10:00:00.000Z',
      provenance: { author: 'agent', at: '2026-10-30T10:00:00.000Z' },
      ...over
    },
    progress: p
  }
}

/** Three required chapters (done / running / locked) and one side chapter. */
function standard(): { cv: CampaignView; missions: MissionView[]; own: MissionView } {
  const own = fixtureView('faq-like', {
    mission: { id: 'mnt-00000002', campaignId: 'cmp-0000000a', chapterId: 'chp-2' }
  })
  const first = fixtureView('delivered', {
    mission: {
      id: 'mnt-00000001',
      campaignId: 'cmp-0000000a',
      chapterId: 'chp-1',
      status: 'delivered'
    }
  })
  const chapters = [
    chapter(1, { missionId: 'mnt-00000001', title: 'Pipeline' }),
    chapter(2, { missionId: 'mnt-00000002', title: 'Round 3' }),
    chapter(3, { title: 'Home', consumes: ['pages'] }),
    chapter(4, { title: 'Lighter images', required: false })
  ]
  const cv = campaignView(
    chapters,
    progress({
      states: { 'chp-1': 'done', 'chp-2': 'running', 'chp-3': 'locked', 'chp-4': 'todo' }
    })
  )
  return { cv, missions: [first, own], own }
}

describe('AC-4b.1 — the campaign pill text', () => {
  it('reads "Ch. N/M · Step a/b": the campaign position plus the own mission headline', () => {
    const { cv, missions, own } = standard()
    const model = buildCampaignModel(cv, missions, own.mission.id, NOW)
    // faq-like is on step 8 of 9 (its fixture's expectation); the campaign is on chapter 2 of 3.
    expect(campaignPillText(t, model)).toBe('Ch. 2/3 · Step 8/9')
    expect(model.tone).toBe('accent')
  })

  it('a parallel range reads "Ch. 2–3/5" and the step range likewise', () => {
    const { cv, missions, own } = standard()
    const wide = { ...cv, progress: { ...cv.progress, total: 5, current: { from: 2, to: 3 } } }
    const model = buildCampaignModel(wide, missions, own.mission.id, NOW)
    expect(campaignPillText(t, model).startsWith('Ch. 2–3/5')).toBe(true)
  })

  it('the warning state adds "· n for you", n counted across every chapter mission of the campaign', () => {
    const { cv, missions, own } = standard()
    const owed: MissionYouItem[] = [
      { kind: 'human-steps', stepIds: ['stp-9'] },
      { kind: 'blocker', reason: 'Need the CDN key', unblocks: 'a key is shared' }
    ]
    const other = { ...missions[0], you: [{ kind: 'close' } as MissionYouItem] }
    const withYou = { ...own, you: owed }
    const model = buildCampaignModel(cv, [other, withYou], own.mission.id, NOW)
    expect(model.tone).toBe('warning')
    expect(campaignPillText(t, model)).toBe('Ch. 2/3 · Step 8/9 · 3 for you')
  })

  it('delivered reads green "Ch. M/M ✓" with no step part', () => {
    const { cv, missions, own } = standard()
    const delivered = {
      ...cv,
      progress: {
        ...cv.progress,
        allDone: true,
        current: null,
        done: 3,
        running: 0,
        locked: 0,
        states: { 'chp-1': 'done', 'chp-2': 'done', 'chp-3': 'done', 'chp-4': 'done' } as const
      }
    }
    const model = buildCampaignModel(delivered, missions, own.mission.id, NOW)
    expect(model.tone).toBe('success')
    expect(campaignPillText(t, model)).toBe('Ch. 3/3 ✓')
  })

  it('a mission with no campaign is not matched, so the pill keeps its mission look', () => {
    const { cv } = standard()
    const lone = fixtureView('faq-like')
    expect(campaignForMission([cv], lone)).toBeNull()
    const bound = fixtureView('faq-like', {
      mission: { campaignId: 'cmp-0000000a', chapterId: 'chp-2' }
    })
    expect(campaignForMission([cv], bound)?.campaign.id).toBe('cmp-0000000a')
    // A bound mission whose campaign is not loaded (closed, unreadable) falls back too.
    expect(campaignForMission([], bound)).toBeNull()
  })
})

describe('AC-4b.2 — the campaign popover model', () => {
  it('partitions the chapters into Main quest / Side quests / Locked, in order', () => {
    const { cv, missions, own } = standard()
    const m = buildCampaignModel(cv, missions, own.mission.id, NOW)
    expect(m.main.map((r) => r.chapter.id)).toEqual(['chp-1', 'chp-2'])
    expect(m.side.map((r) => r.chapter.id)).toEqual(['chp-4'])
    expect(m.locked.map((r) => r.chapter.id)).toEqual(['chp-3'])
    expect(m.main.map((r) => r.state)).toEqual(['done', 'running'])
  })

  it('selects the open chapter by the server current marker and carries its mission headline', () => {
    const { cv, missions, own } = standard()
    const m = buildCampaignModel(cv, missions, own.mission.id, NOW)
    expect(m.currentId).toBe('chp-2')
    const row = m.main.find((r) => r.chapter.id === 'chp-2')!
    expect(row.current).toBe(true)
    expect(row.missionId).toBe('mnt-00000002')
    expect(row.stepHeadline).toEqual({ kind: 'single', n: 8, to: 8, m: 9 })
  })

  it('prints the counts the server reported and the radiant counter when there is one', () => {
    const { cv, missions, own } = standard()
    const withRadiant = {
      ...cv,
      progress: { ...cv.progress, inReview: 1, radiant: { done: 48, total: 88 } }
    }
    const m = buildCampaignModel(withRadiant, missions, own.mission.id, NOW)
    expect(m.counts).toEqual({
      done: 1,
      inReview: 1,
      running: 1,
      locked: 1,
      sideTotal: 1,
      sideDone: 0,
      sideOpen: 1
    })
    expect(m.radiant).toEqual({ done: 48, total: 88 })
    expect(buildCampaignModel(cv, missions, own.mission.id, NOW).radiant).toBeNull()
  })

  it('the You lane lists every chapter mission owes, tagged with its chapter', () => {
    const { cv, missions, own } = standard()
    const first = {
      ...missions[0],
      you: [{ kind: 'close' } as MissionYouItem]
    }
    const second = {
      ...own,
      you: [{ kind: 'human-steps', stepIds: ['stp-9'] } as MissionYouItem]
    }
    const m = buildCampaignModel(cv, [first, second], own.mission.id, NOW)
    expect(m.you.map((y) => [y.chapterOrdinal, y.row.kind])).toEqual([
      [1, 'close'],
      [2, 'human-steps']
    ])
  })
})

describe('AC-4b.4 — the renderer never recounts', () => {
  // A naive count would read 4 chapters, 1 of them done ("Ch. 2/4"), and 9 steps, 6 verified.
  // The server says otherwise on every number; the UI must show the server's.
  it('shows derived.progress of the campaign, not chapters.length or a count of done chapters', () => {
    const { cv, missions, own } = standard()
    const server = progress({
      total: 12,
      current: { from: 9, to: 9 },
      done: 7,
      running: 1,
      locked: 3,
      inReview: 1,
      states: { 'chp-1': 'done', 'chp-2': 'running', 'chp-3': 'locked', 'chp-4': 'todo' }
    })
    const model = buildCampaignModel({ ...cv, progress: server }, missions, own.mission.id, NOW)
    expect(model.headline).toEqual({ kind: 'single', n: 9, to: 9, m: 12 })
    expect(campaignPillText(t, model).startsWith('Ch. 9/12')).toBe(true)
    expect(model.counts).toMatchObject({ done: 7, inReview: 1, running: 1, locked: 3 })
  })

  it("shows the mission's derived.progress for the step part, not a count of its steps", () => {
    const { cv, missions, own } = standard()
    // The mission has 10 stored steps; the server says: 3 of 5, step 2 current.
    const lying: MissionView = {
      ...own,
      progress: { ...own.progress, total: 5, current: { from: 2, to: 2 }, done: 1, verified: 1 },
      derived: {
        ...own.derived,
        progress: { ...own.progress, total: 5, current: { from: 2, to: 2 }, done: 1, verified: 1 }
      }
    }
    const model = buildCampaignModel(cv, [missions[0], lying], lying.mission.id, NOW)
    expect(campaignPillText(t, model)).toBe('Ch. 2/3 · Step 2/5')
    const row = model.main.find((r) => r.chapter.id === 'chp-2')!
    expect(row.stepHeadline).toEqual({ kind: 'single', n: 2, to: 2, m: 5 })
  })
})

function step(n: number, extra: Partial<MissionStep> = {}): MissionStep {
  return {
    id: `stp-${n}`,
    ordinal: n,
    kind: 'custom',
    title: `Step ${n}`,
    verification: 'verifier',
    proof: 'unproven',
    links: [],
    blockers: [],
    ...extra
  }
}

describe('AC-4b.3 — the You lane as aged rows (Amendment d) and the Decide row (Amendment e)', () => {
  const HOUR = 3_600_000

  it('is one row per owed item, in the server order, each with its age where the record has one', () => {
    const raisedAt = new Date(NOW - 2 * HOUR).toISOString()
    const view = fixtureView('faq-like', {
      mission: {
        blockers: [
          { reason: 'Need the CDN key', unblocks: 'a key is shared', owner: 'operator', raisedAt }
        ]
      },
      view: {
        you: [
          { kind: 'blocker', reason: 'Need the CDN key', unblocks: 'a key is shared' },
          { kind: 'human-steps', stepIds: ['stp-9'] }
        ]
      }
    })
    const rows = youRows(view, NOW)
    expect(rows.map((r) => r.kind)).toEqual(['blocker', 'human-steps'])
    expect(rows[0].ageMs).toBe(2 * HOUR)
    // Nothing in the record says when a human step became due: no age, never a guess.
    expect(rows[1].ageMs).toBeNull()
  })

  it('the requested close is aged from pendingClose.at', () => {
    const view = fixtureView('delivered', {
      mission: {
        status: 'delivered',
        pendingClose: { at: new Date(NOW - 5 * HOUR).toISOString(), requestedBy: 'owner' }
      },
      view: { you: [{ kind: 'close' }] }
    })
    expect(youRows(view, NOW)[0]).toMatchObject({ kind: 'close', ageMs: 5 * HOUR })
  })

  it('a main-red item is aged from the ledger row that merged that PR', () => {
    const ledger: LedgerRow[] = [
      { at: new Date(NOW - 3 * HOUR).toISOString(), kind: 'pr-merged', ref: '#316', pr: 316 }
    ]
    const view = fixtureView('faq-like', {
      mission: { ledger },
      view: { you: [{ kind: 'main-red', stepId: 'stp-8', pr: 316 }] }
    })
    expect(youRows(view, NOW)[0]).toMatchObject({ kind: 'main-red', ageMs: 3 * HOUR })
  })

  it('an undecided decision node becomes a "Decide" row (high risk), after the blockers', () => {
    const steps = [
      step(1, { proof: 'verified' }),
      step(2, {
        decision: { title: 'Standard vs Combined', options: ['Standard', 'Combined'], blocks: [] }
      }),
      step(3, { kind: 'fixed-end', title: 'Delivered and verified' })
    ]
    const view = fixtureView('faq-like', {
      mission: { steps },
      view: {
        you: [
          { kind: 'blocker', reason: 'r', unblocks: 'u' },
          { kind: 'human-steps', stepIds: ['stp-2'] }
        ]
      }
    })
    const rows = youRows(view, NOW)
    expect(rows.map((r) => r.kind)).toEqual(['blocker', 'decide', 'human-steps'])
    expect(rows[1]).toMatchObject({ kind: 'decide', stepId: 'stp-2', item: null, risk: 'high' })
  })

  it('a decided decision node adds no row, and a clear mission has no rows', () => {
    const steps = [
      step(1, { proof: 'verified' }),
      step(2, {
        decision: { title: 'Standard vs Combined', options: ['A', 'B'], chosen: 1, blocks: [] }
      }),
      step(3, { kind: 'fixed-end', title: 'Delivered and verified' })
    ]
    const view = fixtureView('faq-like', { mission: { steps } })
    expect(youRows(view, NOW)).toEqual([])
  })

  it('the model carries the rows and the You look follows them (a Decide row alone is a warning)', () => {
    const steps = [
      step(1, { proof: 'verified' }),
      step(2, { decision: { title: 'Pick', options: ['A', 'B'], blocks: [] } }),
      step(3, { kind: 'fixed-end', title: 'Delivered and verified' })
    ]
    const model = buildMissionModel(fixtureView('faq-like', { mission: { steps } }), NOW)
    expect(model.youRows.map((r) => r.kind)).toEqual(['decide'])
    expect(model.youLook).toBe('warning')
  })
})

describe('AC-4b.3 — the ledger tail (Amendment c)', () => {
  const rows = (n: number): LedgerRow[] =>
    Array.from({ length: n }, (_, i) => ({
      at: new Date(NOW - (n - i) * 60_000).toISOString(),
      kind: 'ci' as const,
      ref: `#${300 + i}`,
      detail: 'passing'
    }))

  it('shows the last 5 rows, newest first', () => {
    const view = fixtureView('faq-like', { mission: { ledger: rows(8) } })
    const tail = ledgerTail(view)
    expect(tail.map((r) => r.ref)).toEqual(['#307', '#306', '#305', '#304', '#303'])
  })

  it('shows all rows when there are fewer, and none when there is no ledger', () => {
    expect(ledgerTail(fixtureView('faq-like', { mission: { ledger: rows(2) } }))).toHaveLength(2)
    expect(ledgerTail(fixtureView('faq-like'))).toEqual([])
  })

  it('the model carries the tail so the popover renders it', () => {
    const model = buildMissionModel(fixtureView('faq-like', { mission: { ledger: rows(8) } }), NOW)
    expect(model.ledgerTail).toHaveLength(5)
  })
})
