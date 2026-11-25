/**
 * BUG-308, rules A, B (re-filing) and C: the queue holds only what the operator can still act on.
 *
 * Everything here goes through entry points that existed before the fix (the inspector, the
 * structured upsert, the mission reconcile), so each case fails on its assertion without it.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WaitingItemV4 } from '../../src/main/missions/waiting'
import {
  emptyState,
  upsertStructured,
  type StructuredDraft,
  type YourMoveCard,
  type YourMoveState
} from '../../src/main/your-move/core'
import {
  createInspector,
  type InspectRequest,
  type InspectorDeps
} from '../../src/main/your-move/inspector'
import type { EnrichOutcome, JudgeOutcome } from '../../src/main/your-move/judge'
import {
  readRecordViews,
  reconcileMissions,
  type DraftView,
  type RecordViews
} from '../../src/main/your-move/source-mission'
import { openYourMoveStore, type YourMoveStore } from '../../src/main/your-move/store'
import type { ReadResult } from '../../src/main/your-move/transcript'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 24, 12)
const ROOT = '/org/proj/www'

let dir: string
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'your-move-supersede-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const card = (id: string, over: Partial<YourMoveCard> = {}): YourMoveCard => ({
  id,
  sessionId: 'sess-alpha',
  folder: ROOT,
  kind: 'decide',
  ask: `ask ${id}`,
  source: 'judge',
  lane: 'live',
  openedAt: NOW - DAY,
  updatedAt: NOW - DAY,
  ...over
})

const openIds = (s: YourMoveState): string[] =>
  s.cards.filter((c) => c.closedAt === undefined).map((c) => c.id)

// ─── A: supersession ──────────────────────────────────────────────────────────

const verdict = (
  over: Partial<{ new: unknown[]; update: { id: string }[]; close: string[] }> = {}
): JudgeOutcome =>
  ({
    ok: true,
    costUsd: 0,
    durationMs: 1,
    verdict: { new: [], update: [], close: [], ...over }
  }) as JudgeOutcome

async function inspectorWith(
  cards: YourMoveCard[],
  outcome: JudgeOutcome
): Promise<{
  store: YourMoveStore
  request(over?: Partial<InspectRequest>): Promise<string>
}> {
  const store = await openYourMoveStore(path.join(dir, 'your-move.json'))
  await store.transact(() => ({
    next: {
      version: 1,
      cards,
      cursors: { 'sess-alpha': { offset: 100, lastInspectedAt: 1 } }
    },
    result: null
  }))
  let n = 0
  const deps: InspectorDeps = {
    store,
    read: (async (): Promise<ReadResult> => ({
      lines: [
        // BUG-308 delta 2: only a turn the operator typed in supersedes.
        {
          type: 'user',
          entrypoint: 'cli',
          timestamp: new Date(NOW - 1_000).toISOString(),
          origin: { kind: 'human' },
          message: { content: 'carry on' }
        },
        {
          type: 'assistant',
          entrypoint: 'cli',
          message: { content: [{ type: 'text', text: 'done for now' }] }
        }
      ],
      nextOffset: 900,
      size: 900,
      shrunk: false
    })) as unknown as InspectorDeps['read'],
    detect: vi.fn(async () => outcome),
    enrich: vi.fn(async (): Promise<EnrichOutcome> => ({ ok: false, reason: 'off' })),
    now: () => NOW,
    mintId: () => `fresh-${String.fromCharCode(97 + n++)}`,
    isBlocked: () => false,
    isArchived: () => false,
    isFolderOff: () => false,
    mode: () => 'live',
    midTurnLive: () => false,
    classify: () => 'interactive',
    hasOperator: async () => true
  }
  const insp = createInspector(deps)
  return {
    store,
    request: (over = {}) =>
      insp.request({
        sessionId: 'sess-alpha',
        folder: ROOT,
        transcriptPath: '/t/sess-alpha.jsonl',
        trigger: 'stop',
        ...over
      })
  }
}

describe('AC-1: a new judged turn supersedes the older judge cards of its session', () => {
  const seeded = (): YourMoveCard[] => [
    card('old-live'),
    card('old-observe', { lane: 'observe' }),
    card('old-hidden', { lane: 'mid-turn' }),
    card('other-session', { sessionId: 'sess-beta' }),
    card('a-verb', { source: 'verb' }),
    card('a-death', { source: 'death', sourceKey: 'death:sess-alpha' })
  ]

  it('closes the older ones and keeps the cards of the new turn', async () => {
    const h = await inspectorWith(
      seeded(),
      verdict({ new: [{ kind: 'do', ask: 'Merge the branch' }] })
    )
    expect(await h.request()).toBe('judged')
    expect(openIds(h.store.state()).sort()).toEqual(
      ['a-death', 'a-verb', 'fresh-a', 'other-session'].sort()
    )
    const old = h.store.state().cards.find((c) => c.id === 'old-live')
    expect(old).toMatchObject({ closedAt: NOW, closedBy: 'superseded' })
  })

  it('a verdict that owes nothing still closes them', async () => {
    const h = await inspectorWith(seeded(), verdict())
    await h.request()
    expect(openIds(h.store.state()).sort()).toEqual(['a-death', 'a-verb', 'other-session'].sort())
  })

  it('an item the new turn restates (update) is one of its own and stays', async () => {
    const h = await inspectorWith(
      [card('kept'), card('dropped')],
      verdict({ update: [{ id: 'kept' }] })
    )
    await h.request()
    expect(openIds(h.store.state())).toEqual(['kept'])
    expect(h.store.state().cards.find((c) => c.id === 'kept')).toMatchObject({
      openedAt: NOW - DAY,
      updatedAt: NOW
    })
  })

  it('a mid-turn look is not a turn: it closes nothing', async () => {
    const h = await inspectorWith(seeded(), verdict())
    await h.request({ trigger: 'mid-turn' })
    expect(openIds(h.store.state())).toHaveLength(6)
  })

  it('a judge that failed closes nothing', async () => {
    const h = await inspectorWith(seeded(), { ok: false, reason: 'timeout' } as JudgeOutcome)
    expect(await h.request()).toBe('failed')
    expect(openIds(h.store.state())).toHaveLength(6)
  })
})

// ─── B: re-filing is not activity ─────────────────────────────────────────────

const gate = (over: Partial<StructuredDraft> = {}): StructuredDraft => ({
  sessionId: 'sess-alpha',
  folder: ROOT,
  kind: 'decide',
  ask: 'Which branch?',
  source: 'human-gate',
  sourceKey: 'gate:toolu_alpha',
  lane: 'live',
  ...over
})

let m = 0
const mint = (): string => `m-${String.fromCharCode(97 + (m++ % 26))}${m}`

describe('AC-2: re-filing an unchanged card does not reset its clock', () => {
  it('an unchanged structured card keeps updatedAt; a changed one moves it', () => {
    const a = upsertStructured(emptyState(), gate(), mint, 1_000)
    const same = upsertStructured(a, gate(), mint, 9_000)
    expect(same.cards).toHaveLength(1)
    expect(same.cards[0]).toMatchObject({ openedAt: 1_000, updatedAt: 1_000 })
    const changed = upsertStructured(same, gate({ ask: 'Which tag?' }), mint, 12_000)
    expect(changed.cards[0]).toMatchObject({ openedAt: 1_000, updatedAt: 12_000 })
  })

  it('a card that expired is not filed again while nothing changed', () => {
    const filed = upsertStructured(emptyState(), gate(), mint, 1_000)
    const expired: YourMoveState = {
      ...filed,
      cards: filed.cards.map((c) => ({ ...c, closedAt: 5_000, closedBy: 'expired' as never }))
    }
    expect(openIds(upsertStructured(expired, gate(), mint, 9_000))).toHaveLength(0)
    // but a different item under the same key is news
    expect(
      openIds(upsertStructured(expired, gate({ ask: 'Which tag?' }), mint, 9_000))
    ).toHaveLength(1)
  })
})

// ─── C: one card per mission ──────────────────────────────────────────────────

const item = (kind: string, id: string, ask: string): WaitingItemV4 =>
  ({ kind, id, ask, why: 'why' }) as unknown as WaitingItemV4

const unblock = item('unblock', 'blk-a', 'Set the key folder')
const settle = item('settle', 'settle:a', 'Mark the layout confirmed')
const close = item('close', 'close', 'Close the mission')

const view = (id: string, you: WaitingItemV4[], over: Record<string, unknown> = {}): DraftView =>
  ({
    root: ROOT,
    mission: { id, owner: { sessionId: 'sess-owner' } },
    you,
    changedAt: NOW - DAY,
    ...over
  }) as DraftView

const records = (views: DraftView[], unreadable = false): RecordViews =>
  new Map([[ROOT, { views, unreadable }]])

const pass = (s: YourMoveState, views: DraftView[], now = NOW, unreadable = false): YourMoveState =>
  reconcileMissions(s, { unreadable: [] }, [ROOT], 'live', mint, now, records(views, unreadable))

const openCards = (s: YourMoveState): YourMoveCard[] =>
  s.cards.filter((c) => c.closedAt === undefined)

describe('AC-3: a mission has at most one open card, its next item', () => {
  it('files only the first waiting item', () => {
    const s = pass(emptyState(), [view('mnt-alpha', [unblock, settle, close])])
    expect(openCards(s).map((c) => c.ask)).toEqual(['Set the key folder'])
  })

  it('refreshes that card in place when the next item changes', () => {
    const a = pass(emptyState(), [view('mnt-alpha', [unblock, close])], NOW)
    const b = pass(a, [view('mnt-alpha', [close])], NOW + 5_000)
    expect(b.cards).toHaveLength(1)
    expect(b.cards[0]).toMatchObject({
      id: a.cards[0].id,
      ask: 'Close the mission',
      sourceKey: 'mnt-alpha:close',
      openedAt: NOW,
      updatedAt: NOW + 5_000
    })
  })

  it('collapses the several cards an earlier build left, keeping the next one', () => {
    const old = (id: string, key: string, openedAt: number): YourMoveCard =>
      card(id, {
        source: 'mission',
        sessionId: 'sess-owner',
        sourceKey: key,
        openedAt,
        mission: { missionId: 'mnt-alpha', root: ROOT, item: {} as never }
      })
    const s: YourMoveState = {
      ...emptyState(),
      cards: [
        old('c-close', 'mnt-alpha:close', NOW - 3 * DAY),
        old('c-settle', 'mnt-alpha:settle:a', NOW - 2 * DAY)
      ]
    }
    expect(openIds(pass(s, [view('mnt-alpha', [settle, close])]))).toEqual(['c-settle'])
    // while a mission file cannot be read, and the records are not there yet, still only one stays
    expect(openIds(pass(s, [], NOW, true))).toHaveLength(1)
  })

  it('a mission untouched for 7 days files nothing and its card closes as expired', () => {
    const a = pass(emptyState(), [view('mnt-alpha', [close], { changedAt: NOW - DAY })])
    const stale = [view('mnt-alpha', [close], { changedAt: NOW - 8 * DAY })]
    const b = pass(a, stale)
    expect(openCards(b)).toHaveLength(0)
    expect(b.cards[0]).toMatchObject({ closedBy: 'expired' })
    expect(openCards(pass(emptyState(), stale))).toHaveLength(0)
    // activity brings it back
    const c = pass(b, [view('mnt-alpha', [close], { changedAt: NOW + 1_000 })], NOW + 2_000)
    expect(openCards(c)).toHaveLength(1)
  })

  it('an unchanged mission does not reset the card age on every poll', () => {
    const v = [view('mnt-alpha', [close], { changedAt: NOW - 3 * DAY })]
    const a = pass(emptyState(), v, NOW - 2 * DAY)
    const b = pass(a, v, NOW)
    expect(b.cards[0].updatedAt).toBe(NOW - 2 * DAY)
  })

  it('a mission whose leader session is gone files nothing', () => {
    const s = pass(emptyState(), [view('mnt-alpha', [close], { leaderGone: true })])
    expect(openCards(s)).toHaveLength(0)
  })
})

describe('AC-3: the record views carry the mission record’s own change time', () => {
  const fixture = path.join(
    __dirname,
    '..',
    'fixtures',
    'missions-v4-compat',
    'missions',
    'mnt-5c0de001-modern-active.md'
  )
  const seedRoot = (mtime: number): string => {
    const root = path.join(dir, 'repo')
    mkdirSync(path.join(root, '.git'), { recursive: true })
    mkdirSync(path.join(root, '.harnu', 'missions'), { recursive: true })
    const file = path.join(root, '.harnu', 'missions', path.basename(fixture))
    writeFileSync(file, readFileSync(fixture, 'utf8'))
    utimesSync(file, mtime / 1000, mtime / 1000)
    return root
  }
  const detail = vi.fn(async () => ({ ok: true, waiting: { items: [close] } }) as never)

  it('reads the change time from the record file', async () => {
    const root = seedRoot(NOW - DAY)
    const read = await readRecordViews([root], { readDetail: detail, now: NOW } as never)
    const [v] = read.get(root)!.views
    expect((v as unknown as { changedAt: number }).changedAt).toBeCloseTo(NOW - DAY, -3)
  })

  it('does not even read the detail of a mission untouched for 7 days', async () => {
    detail.mockClear()
    const root = seedRoot(NOW - 30 * DAY)
    const read = await readRecordViews([root], { readDetail: detail, now: NOW } as never)
    expect(detail).not.toHaveBeenCalled()
    expect(read.get(root)!.views.map((v) => v.you)).toEqual([[]])
  })

  it('marks a mission whose leader transcript is gone', async () => {
    const root = seedRoot(NOW - DAY)
    const read = await readRecordViews([root], {
      readDetail: detail,
      now: NOW,
      leaderGone: async () => true
    } as never)
    expect((read.get(root)!.views[0] as unknown as { leaderGone: boolean }).leaderGone).toBe(true)
  })
})

describe('AC-3: one card per mission never reaches a root the pass does not follow', () => {
  it('leaves the extra cards of a folder switched off', () => {
    const other = (id: string): YourMoveCard =>
      card(id, {
        source: 'mission',
        sourceKey: `mnt-off:${id}`,
        mission: { missionId: 'mnt-off', root: '/org/other/www', item: {} as never }
      })
    const s: YourMoveState = { ...emptyState(), cards: [other('x'), other('y')] }
    expect(openIds(pass(s, []))).toEqual(['x', 'y'])
  })
})
