// @vitest-environment jsdom
/**
 * BUG-284 (compat re-run 2 on PR #338) — what an old (v3) record raises must be true.
 *
 * NC-1 (N1) a chapter whose mission is still active never raises "Mark done: … handed in as delivered":
 *      the operator is never asked to confirm a delivery that has not happened.
 * NC-2 (N3) a mission whose only owed item is a review (or any one item of any kind) shows "N for you" on
 *      the pill and names the item in the Next line, never "Nothing for you right now".
 * NC-3 (N2) a campaign's headline counts a delivered chapter done exactly as v3 did, even while its close
 *      request or an unticked check is still owed; those stay owed items.
 *
 * Read through the real view channel on neutral campaigns ("Acme", "Import core"); reads write nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs, mkdirSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { i18n } from '../src/renderer/src/i18n'
import {
  missionNumbers,
  missionPillText,
  nextLook,
  waitingText
} from '../src/renderer/src/lib/mission-pane-view'
import { missionGet } from '../src/main/missions/verbs-read'
import {
  CHAPTERS,
  CHAPTERS_ACTIVE_END_VERIFIED,
  CHAPTERS_ALL_DELIVERED_OWING,
  CHAPTERS_DELIVERED_OWING,
  writeCampaign13
} from './fixtures/missions-v4-campaign-13/build'
import { writeReviewOnly } from './fixtures/missions-v4-owed-standalone/build'

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.userDataDir
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => []
}))

const noFacts = {
  findPrs: async () => ({ ghAvailable: true, worktrees: {}, branches: {}, numbers: {} }),
  findMainCi: async () => ({ ghAvailable: true, byNumber: {} }),
  lastKnown: () => null,
  pathExists: async () => true,
  taskState: () => undefined
}

let root = ''
beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-nc-ud-'))
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-nc-'))
  mkdirSync(path.join(root, '.git'), { recursive: true })
  vi.resetModules()
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(h.userDataDir, { recursive: true, force: true })
})

type Item = { kind: string; ask: string }
interface CampaignDetail {
  waiting: { items: Item[] }
  milestones: Array<{ id: string; state: string }>
  progress: { done: number; total: number }
  state: string
  steps: Array<{ criteria: Array<{ text: string }> }>
}

async function campaign(specs: typeof CHAPTERS): Promise<CampaignDetail> {
  writeCampaign13(root, specs)
  const { buildMissionV4View } = await import('../src/main/mission-ipc')
  const list = await buildMissionV4View(
    { folder: root, sessionId: 'harnu-readers' },
    { facts: () => noFacts }
  )
  if (list.state !== 'none') throw new Error(JSON.stringify(list))
  const named = await buildMissionV4View(
    { folder: root, sessionId: 'harnu-readers', missionId: list.missions[0].id },
    { facts: () => noFacts }
  )
  if (named.state !== 'mission') throw new Error(JSON.stringify(named))
  return named.detail as never
}

const HANDED_IN = /handed in as delivered/i

describe('NC-1 · the words the conversion writes and the list skips are the same', () => {
  it("an active chapter's fixed end carries the criterion the waiting list skips", async () => {
    const d = await campaign(CHAPTERS)
    const { CHAPTER_HANDED_IN } = await import('../src/main/missions/waiting')
    const texts = d.steps.flatMap((s) => s.criteria.map((c) => c.text))
    expect(texts).toContain(CHAPTER_HANDED_IN)
  }, 60_000)
})

describe('NC-1 · the operator is never asked to confirm a delivery that has not happened', () => {
  it('chapters whose mission is still active (locked or not) raise no "handed in as delivered" item', async () => {
    const d = await campaign(CHAPTERS)
    expect(d.waiting.items.filter((i) => HANDED_IN.test(i.ask))).toEqual([])
    expect(JSON.stringify(d.waiting.items)).not.toMatch(HANDED_IN)
  }, 60_000)

  it('a chapter finished and verified but never delivered raises none either, and still reads in review', async () => {
    const d = await campaign(CHAPTERS_ACTIVE_END_VERIFIED)
    expect(d.waiting.items.filter((i) => HANDED_IN.test(i.ask))).toEqual([])
    // v3 read it in review, never done: the headline does not count it.
    expect(d.milestones.find((m) => m.id === 'mls-3')?.state).not.toBe('done')
    expect(d.progress.done).toBe(2)
  }, 60_000)

  it('still raises what an active chapter genuinely owes (recall over noise)', async () => {
    const d = await campaign(CHAPTERS)
    const asks = d.waiting.items.map((i) => i.ask).join('\n')
    // chapter 5: an unticked agent check and an unproven human step; chapter 7: an unticked check on its end
    expect(asks).toContain('Mark done: Plan read by the owner')
    expect(asks).toContain('Mark done: Sign off the plan')
    expect(asks).toContain('Redirects tested on staging')
  }, 60_000)

  it('a chapter delivered and not yet closed raises its close request, once, and no "handed in" item', async () => {
    const d = await campaign(CHAPTERS)
    const close = d.waiting.items.filter(
      (i) => i.kind === 'unblock' && /Chapter 2 · Report/.test(i.ask) && /close/i.test(i.ask)
    )
    expect(close).toHaveLength(1)
    expect(d.waiting.items.filter((i) => HANDED_IN.test(i.ask))).toEqual([])
  }, 60_000)
})

describe('NC-3 · a delivered chapter counts done as v3 counted it, and what it owes stays owed', () => {
  it('chapter 2 (delivered, close requested, two checks unticked) counts done: 2 of 11, as in v3', async () => {
    const d = await campaign(CHAPTERS_DELIVERED_OWING)
    expect(d.milestones.find((m) => m.id === 'mls-1')?.state).toBe('done')
    expect(d.milestones.find((m) => m.id === 'mls-2')?.state).toBe('done')
    expect(d.progress.done).toBe(2)
    expect(d.progress.total).toBe(11)
  }, 60_000)

  it('and still owes the unticked check, the unproven human step and the chapter close request', async () => {
    const d = await campaign(CHAPTERS_DELIVERED_OWING)
    const settle = d.waiting.items.filter((i) => i.kind === 'settle').map((i) => i.ask)
    expect(settle).toContain('Mark done: Report figures re-read by finance')
    expect(settle).toContain('Mark done: Sign off the report wording')
    expect(
      d.waiting.items.filter(
        (i) => i.kind === 'unblock' && /Chapter 2 · Report/.test(i.ask) && /close/i.test(i.ask)
      )
    ).toHaveLength(1)
  }, 60_000)

  it('a campaign whose chapters are all delivered reads 3 of 3, with every close request still owed', async () => {
    const d = await campaign(CHAPTERS_ALL_DELIVERED_OWING)
    expect(d.progress.done).toBe(3)
    expect(d.progress.total).toBe(3)
    const closes = d.waiting.items.filter(
      (i) => i.kind === 'unblock' && /close the chapter/i.test(i.ask)
    )
    expect(closes).toHaveLength(3)
    expect(d.waiting.items.map((i) => i.ask)).toContain(
      'Mark done: Report figures re-read by finance'
    )
  }, 60_000)

  it('a chapter whose own step still owes something does not count done when it is not delivered', async () => {
    const d = await campaign(CHAPTERS)
    expect(d.progress.done).toBe(2) // chapters 1 and 2 only: nothing else gained
  }, 60_000)
})

// ---- NC-2 --------------------------------------------------------------------------------------

describe('NC-2 · one owed item shows on the pill and in the Next line, whatever its kind', () => {
  const t = i18n.global.t as never

  it('a mission whose only owed item is a review (a standalone v3 file, its pull request open)', async () => {
    const r = writeReviewOnly(root)
    const d = await missionGet(
      root,
      { kind: 'operator' },
      { missionId: r.id },
      { inputs: { 'stp-1': { pr: 'open' } } }
    )
    if (!d.ok) throw new Error(d.error)
    expect(d.waiting.items.map((i) => i.kind)).toEqual(['review'])
    const detail = d as never
    expect(missionNumbers(detail).forYou).toBe(1)
    expect(missionPillText(t, detail)).toBe('0/1 · 1 for you')
    expect(nextLook(detail)).toBe('you')
    const words = waitingText(t, detail, d.waiting.next as never)
    expect(words.ask).toContain('Look over the pull request for “Import core”')
    expect(words.ask).not.toMatch(/nothing for you/i)
  }, 60_000)

  it.each([
    [
      'main-failing',
      { kind: 'main-failing', id: 'm', stepId: 'stp-1', pr: '1', ask: 'Fix main', why: 'w' }
    ],
    [
      'unblock',
      { kind: 'unblock', id: 'u', stepId: null, blockerId: 'blk-1', ask: 'Do it', why: 'w' }
    ],
    ['rescope', { kind: 'rescope', id: 'r', end: 'x', ask: 'Approve', why: 'w' }],
    [
      'settle',
      {
        kind: 'settle',
        id: 's',
        stepId: 'stp-1',
        criterionId: 'ac-1',
        ask: 'Mark done: x',
        why: 'w'
      }
    ],
    [
      'review',
      { kind: 'review', id: 'review', stepIds: ['stp-1'], prs: ['1'], ask: 'Look', why: 'w' }
    ],
    ['close', { kind: 'close', id: 'close', requested: false, ask: 'Close', why: 'w' }],
    [
      'attach',
      { kind: 'attach', id: 'a', requestId: 'atr-1', sessionId: 's', ask: 'Join', why: 'w' }
    ]
  ])('a single %s item counts as 1 for you and is never "Nothing for you"', (kind, item) => {
    const detail = {
      state: 'open',
      progress: { done: 0, total: 1, unit: 'steps', counts: { running: 0 } },
      steps: [
        {
          id: 'stp-1',
          title: 'Import core',
          criteria: [{ id: 'ac-1', text: 'x', settled: false }],
          blockers: []
        }
      ],
      blockers: [],
      waiting: { items: [item], next: item, more: [] }
    } as never
    expect(missionNumbers(detail).forYou).toBe(1)
    expect(missionPillText(t, detail)).toMatch(kind === 'close' ? /ready|for you/ : /1 for you/)
    expect(nextLook(detail)).toBe(kind === 'close' ? 'ok' : 'you')
    const words = waitingText(t, detail, item as never)
    expect(words.ask.length).toBeGreaterThan(0)
    expect(words.ask).not.toMatch(/nothing for you/i)
  })
})
