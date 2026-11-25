import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MissionListResult } from '../../src/main/mission-ipc'
import type { WaitingItemV4 } from '../../src/main/missions/waiting'
import {
  reportedUnreadableMissionFiles,
  resetUnreadableMissionFiles
} from '../../src/main/missions/store'
import { emptyState, type YourMoveState } from '../../src/main/your-move/core'
import {
  missionDrafts,
  readRecordViews,
  reconcileMissions,
  refreshRecordViews,
  selectForReconcile,
  type DraftView,
  type RecordViews
} from '../../src/main/your-move/source-mission'

const ROOT = '/org/proj/www'

/** One owed item, as the one waiting list words it (`ask`, `why`). */
const item = {
  close: (): WaitingItemV4 => ({
    kind: 'close',
    id: 'close',
    ask: 'Close the mission',
    why: 'Every step is done.'
  }),
  unblock: (reason: string): WaitingItemV4 => ({
    kind: 'unblock',
    id: `blk-${reason}`,
    ask: `Unblock: ${reason}`,
    why: 'Phase B starts.',
    stepId: 'stp-2',
    blockerId: 'blk-1'
  }),
  settle: (id: string): WaitingItemV4 => ({
    kind: 'settle',
    id,
    ask: 'Mark the layout confirmed',
    why: 'The step is done.',
    stepId: 'stp-1',
    criterionId: 'ac-1'
  }),
  review: (id: string): WaitingItemV4 => ({
    kind: 'review',
    id,
    ask: 'Review pull request 305',
    why: 'It unlocks the next step.',
    stepIds: ['stp-3'],
    prs: [305]
  }),
  failing: (): WaitingItemV4 => ({
    kind: 'main-failing',
    id: 'main-failing:stp-3',
    ask: 'Fix main after pull request 305',
    why: 'main is red.',
    stepId: 'stp-3',
    pr: '305'
  }),
  attach: (): WaitingItemV4 => ({
    kind: 'attach',
    id: 'attach:req-1',
    ask: 'Let session 2a2a join',
    why: 'It asked to help.',
    requestId: 'req-1',
    sessionId: '2a2a2a2a-0000-4000-8000-000000000002'
  })
} as unknown as Record<string, (...a: string[]) => WaitingItemV4>

const view = (
  id: string,
  you: WaitingItemV4[],
  over: { root?: string; owner?: string } = {}
): DraftView => ({
  root: over.root ?? ROOT,
  mission: { id, owner: { sessionId: over.owner ?? 'sess-owner-1' } },
  you
})

/** What the record store answered, per root: the views of that root. */
const records = (views: DraftView[], unreadable = false): RecordViews => {
  const byRoot = new Map<string, DraftView[]>()
  for (const v of views) byRoot.set(v.root, [...(byRoot.get(v.root) ?? []), v])
  return new Map([...byRoot].map(([root, vs]) => [root, { views: vs, unreadable }]))
}

const result = (unreadable: string[] = []): Pick<MissionListResult, 'unreadable'> => ({
  unreadable
})

let n = 0
const mint = (): string => `card-${++n}`

const open = (s: YourMoveState) => s.cards.filter((c) => c.closedAt === undefined)

beforeEach(() => resetUnreadableMissionFiles())

describe('missionDrafts', () => {
  it('maps each waiting kind to a card kind and a key, one card per item', () => {
    const drafts = missionDrafts(
      view('mnt-1', [
        item.failing(),
        item.unblock('need the API key'),
        item.settle('stp-1:ac-1'),
        item.review('review:305'),
        item.close(),
        item.attach()
      ]),
      'live'
    )
    expect(drafts.map((d) => [d.kind, d.sourceKey])).toEqual([
      ['do', 'mnt-1:main-failing:stp-3'],
      ['do', 'mnt-1:blocker:Unblock: need the API key'],
      ['check', 'mnt-1:stp-1:ac-1'],
      ['check', 'mnt-1:review:305'],
      ['go_no_go', 'mnt-1:close'],
      ['go_no_go', 'mnt-1:attach:req-1']
    ])
  })

  it('files each card under the mission leader, in the repo root, as source mission', () => {
    const [d] = missionDrafts(view('mnt-1', [item.close()], { owner: 'sess-owner-9' }), 'observe')
    expect(d).toMatchObject({
      sessionId: 'sess-owner-9',
      folder: ROOT,
      source: 'mission',
      lane: 'observe',
      mission: { missionId: 'mnt-1', root: ROOT }
    })
  })

  it("writes the ask in the waiting list's one wording (no second sentence)", () => {
    const [d] = missionDrafts(view('mnt-1', [item.unblock('need the API key')]), 'live')
    expect(d.ask).toBe('Unblock: need the API key')
  })

  it('two blockers worded the same are one card, and two worded differently are two', () => {
    const same = missionDrafts(view('mnt-1', [item.unblock('a'), item.unblock('a')]), 'live')
    expect(same).toHaveLength(1)
    const two = missionDrafts(view('mnt-1', [item.unblock('a'), item.unblock('b')]), 'live')
    expect(new Set(two.map((d) => d.sourceKey)).size).toBe(2)
  })
})

describe('reconcileMissions', () => {
  const roots = [ROOT]

  it('files the owed cards and keeps their clock across polls', () => {
    const rec = records([view('mnt-1', [item.close()])])
    const a = reconcileMissions(emptyState(), result(), roots, 'live', mint, 1_000, rec)
    const b = reconcileMissions(a, result(), roots, 'live', mint, 9_000, rec)
    expect(open(b)).toHaveLength(1)
    // BUG-308: re-filing an unchanged card is not activity, so its clock does not move.
    expect(open(b)[0]).toMatchObject({ openedAt: 1_000, updatedAt: 1_000 })
  })

  it('files the cards of a mission read from a v3 file the same way (no second path)', () => {
    // The record store reads a v3 file in memory, so its views arrive here like any other record's.
    const rec = records([view('mnt-3', [item.unblock('the vendor export'), item.close()])])
    const a = reconcileMissions(emptyState(), result(), roots, 'live', mint, 1_000, rec)
    // BUG-308: one card per mission, its next item.
    expect(open(a).map((c) => c.sourceKey)).toEqual(['mnt-3:blocker:Unblock: the vendor export'])
  })

  it('a cleared blocker turns the card into the next item', () => {
    const withBlocker = records([view('mnt-1', [item.unblock('a'), item.close()])])
    const a = reconcileMissions(emptyState(), result(), roots, 'live', mint, 1_000, withBlocker)
    expect(open(a)).toHaveLength(1)
    const cleared = records([view('mnt-1', [item.close()])])
    const b = reconcileMissions(a, result(), roots, 'live', mint, 2_000, cleared)
    expect(b.cards).toHaveLength(1)
    expect(open(b)[0]).toMatchObject({ id: a.cards[0].id, sourceKey: 'mnt-1:close' })
  })

  it('BUG-294: the main-failing item leaves the card once it leaves the list (the base went green)', () => {
    const red = records([view('mnt-1', [item.failing(), item.close()])])
    const a = reconcileMissions(emptyState(), result(), roots, 'live', mint, 1_000, red)
    expect(open(a).map((c) => c.sourceKey)).toEqual(['mnt-1:main-failing:stp-3'])
    // A later commit turned the branch green: the same mission now owes only the close.
    const green = records([view('mnt-1', [item.close()])])
    const b = reconcileMissions(a, result(), roots, 'live', mint, 2_000, green)
    expect(open(b).map((c) => c.sourceKey)).toEqual(['mnt-1:close'])
    // ...and a mission that owes nothing at all closes the card.
    const c = reconcileMissions(
      b,
      result(),
      roots,
      'live',
      mint,
      3_000,
      records([view('mnt-1', [])])
    )
    expect(open(c)).toHaveLength(0)
    expect(c.cards[0]).toMatchObject({ closedBy: 'source-resolved', closedAt: 3_000 })
  })

  it('a mission absent from the records under a queried root closes its cards', () => {
    const a = reconcileMissions(
      emptyState(),
      result(),
      roots,
      'live',
      mint,
      1_000,
      records([view('mnt-1', [item.close()])])
    )
    const b = reconcileMissions(
      a,
      result(),
      roots,
      'live',
      mint,
      2_000,
      new Map([[ROOT, { views: [], unreadable: false }]])
    )
    expect(open(b)).toHaveLength(0)
    expect(b.cards[0]).toMatchObject({ closedBy: 'source-resolved' })
  })

  it('a mission under a root that was not queried is untouched', () => {
    const a = reconcileMissions(
      emptyState(),
      result(),
      ['/org/other/www'],
      'live',
      mint,
      1_000,
      records([view('mnt-9', [item.close()], { root: '/org/other/www' })])
    )
    const b = reconcileMissions(a, result(), roots, 'live', mint, 2_000, new Map())
    expect(open(b)).toHaveLength(1)
  })

  it('an unreadable mission file closes nothing, whichever reader found it', () => {
    const a = reconcileMissions(
      emptyState(),
      result(),
      roots,
      'live',
      mint,
      1_000,
      records([view('mnt-1', [item.close()])])
    )
    const viaList = reconcileMissions(
      a,
      result(['mnt-broken.md']),
      roots,
      'live',
      mint,
      2_000,
      new Map()
    )
    expect(open(viaList)).toHaveLength(1)
    const viaRecords = reconcileMissions(
      a,
      result(),
      roots,
      'live',
      mint,
      2_000,
      new Map([[ROOT, { views: [], unreadable: true }]])
    )
    expect(open(viaRecords)).toHaveLength(1)
  })

  it('never touches a card of another source or of another mission', () => {
    const two = reconcileMissions(
      emptyState(),
      result(),
      roots,
      'live',
      mint,
      1_000,
      records([view('mnt-1', [item.close()]), view('mnt-2', [item.close()])])
    )
    const withJudgeCard: YourMoveState = {
      ...two,
      cards: [
        ...two.cards,
        {
          id: 'judge-1',
          sessionId: 'sess-owner-1',
          folder: ROOT,
          kind: 'decide',
          ask: 'Which one?',
          source: 'judge',
          lane: 'live',
          openedAt: 1,
          updatedAt: 1
        }
      ]
    }
    const next = reconcileMissions(
      withJudgeCard,
      result(),
      roots,
      'live',
      mint,
      2_000,
      records([view('mnt-1', []), view('mnt-2', [item.close()])])
    )
    expect(
      open(next)
        .map((c) => c.id)
        .sort()
    ).toEqual(['judge-1', two.cards.find((c) => c.mission?.missionId === 'mnt-2')!.id].sort())
  })

  it('a mission card never writes to the mission', () => {
    const src = readFileSync(
      path.join(__dirname, '../../src/main/your-move/source-mission.ts'),
      'utf8'
    )
    // no door, no mission_* verb, no file write: it only reads
    expect(src).not.toMatch(/mission_[a-z_]+\(/)
    expect(src).not.toMatch(/runOperatorDoor|operatorDoor|atomicWrite|writeFile/)
    // types from the mission list are fine; a value import from the mission module is not
    expect(src).not.toMatch(/import\s+(?!type\b)[^;]*?from\s+'\.\.\/mission-ipc'/)
    expect(src).not.toMatch(/from '\.\.\/mission-store'|from '\.\.\/mcp\/mission/)
  })
})

describe('which missions the queue follows', () => {
  const roots = [ROOT, '/org/other/www']
  const owed = [item.close()]

  it('switching a folder off leaves its mission cards open', () => {
    const a = view('mnt-1', owed, { root: ROOT })
    const b = view('mnt-2', owed, { root: '/org/other/www', owner: 'sess-owner-2' })
    const rec = records([a, b])
    const filed = reconcileMissions(emptyState(), result(), roots, 'live', mint, 1_000, rec)
    expect(open(filed)).toHaveLength(2)

    // the folder of mnt-1 is switched off: its root leaves the pass
    const picked = selectForReconcile(result(), roots, {
      ownerArchived: () => false,
      folderOff: (root) => root === ROOT
    })
    const after = reconcileMissions(filed, picked.result, picked.roots, 'live', mint, 2_000, rec)
    // still owed, still open, same clock: nothing was resolved
    expect(
      open(after)
        .map((c) => c.mission?.missionId)
        .sort()
    ).toEqual(['mnt-1', 'mnt-2'])
    expect(open(after).find((c) => c.mission?.missionId === 'mnt-1')?.openedAt).toBe(1_000)

    // switching it back on keeps the very same card and its clock
    const back = reconcileMissions(after, result(), roots, 'live', mint, 3_000, rec)
    expect(open(back)).toHaveLength(2)
    expect(open(back).find((c) => c.mission?.missionId === 'mnt-1')?.openedAt).toBe(1_000)
  })

  it('a mission whose leader is archived leaves the pass, and its cards close', () => {
    const a = view('mnt-1', owed, { owner: 'sess-archived' })
    const b = view('mnt-2', owed, { owner: 'sess-live' })
    const rec = records([a, b])
    const filed = reconcileMissions(emptyState(), result(), roots, 'live', mint, 1_000, rec)
    const picked = selectForReconcile(result(), roots, {
      ownerArchived: (id) => id === 'sess-archived',
      folderOff: () => false
    })
    const after = reconcileMissions(filed, picked.result, picked.roots, 'live', mint, 2_000, rec)
    expect(open(after).map((c) => c.mission?.missionId)).toEqual(['mnt-2'])
    // restore the default so the module-level choice never leaks into another case
    selectForReconcile(result(), roots, { ownerArchived: () => false, folderOff: () => false })
  })

  it('unreadable missions are carried through untouched', () => {
    const picked = selectForReconcile(result(['broken.md']), roots, {
      ownerArchived: () => false,
      folderOff: () => false
    })
    expect(picked.result.unreadable).toEqual(['broken.md'])
    expect(picked.roots).toEqual(roots)
  })
})

// ---- Missions v4 S-40 (Decision 12): a mission file nobody could read is named, never skipped silently ---------

describe('an unreadable record file is named to the app, never skipped silently', () => {
  let root = ''
  const FILE = 'mnt-0badc0de-broken.md'
  const writeBad = (): void => {
    mkdirSync(path.join(root, '.harnu', 'missions-v4'), { recursive: true })
    // Not valid: a record that is neither frontmatter nor JSON.
    writeFileSync(
      path.join(root, '.harnu', 'missions-v4', FILE),
      '{ this is not a mission record',
      'utf8'
    )
  }
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'harnu-ym-unreadable-'))
    mkdirSync(path.join(root, '.git'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('names the file the store could not parse, and stops naming it once it reads again', async () => {
    writeBad()
    const read = await readRecordViews([root], { readDetail: async () => null })
    expect(read.get(root)?.unreadable).toBe(true)
    expect(reportedUnreadableMissionFiles()).toEqual([FILE])
    // A second pass names it once, not twice: it is one failure.
    await readRecordViews([root], { readDetail: async () => null })
    expect(reportedUnreadableMissionFiles()).toEqual([FILE])
    // The file is removed: the next read is whole and the name leaves the list.
    rmSync(path.join(root, '.harnu', 'missions-v4', FILE))
    await readRecordViews([root], { readDetail: async () => null })
    expect(reportedUnreadableMissionFiles()).toEqual([])
  })

  it('a read that throws names the records directory instead of failing silently', async () => {
    writeBad()
    // Record the real answer first so a later failure has a "last good answer" to keep.
    await refreshRecordViews([root], { readDetail: async () => null })
    rmSync(path.join(root, '.harnu', 'missions-v4', FILE))
    mkdirSync(path.join(root, '.harnu', 'missions-v4'), { recursive: true })
    // A valid v3 mission so the read has a record to ask `readDetail` about; `readDetail` throws.
    const v3 = readFileSync(
      path.join(
        __dirname,
        '..',
        'fixtures',
        'missions-v4-compat',
        'missions',
        'mnt-5c0de001-modern-active.md'
      ),
      'utf8'
    )
    mkdirSync(path.join(root, '.harnu', 'missions'), { recursive: true })
    writeFileSync(
      path.join(root, '.harnu', 'missions', 'mnt-5c0de001-modern-active.md'),
      v3,
      'utf8'
    )
    await refreshRecordViews([root], {
      readDetail: async () => {
        throw new Error('boom')
      }
    })
    expect(reportedUnreadableMissionFiles()).toEqual([`${root}/.harnu/missions-v4`])
    // The next read succeeds: the name leaves the list.
    await refreshRecordViews([root], { readDetail: async () => null })
    expect(reportedUnreadableMissionFiles()).toEqual([])
  })
})
