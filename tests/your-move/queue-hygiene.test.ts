/**
 * BUG-308, rules B (expiry) and D (gone sessions and folders), and the startup cleanup that
 * applies A, B, C and D to what is already on disk, through the store's own `transact`.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WaitingItemV4 } from '../../src/main/missions/waiting'
import type { YourMoveCard } from '../../src/main/your-move/core'
import { cleanupQueue, folderPresence, sweepStaleCards } from '../../src/main/your-move/hygiene'
import type { TranscriptLookup } from '../../src/main/your-move/locate'
import type { DraftView, RecordViews } from '../../src/main/your-move/source-mission'
import { openYourMoveStore, type YourMoveStore } from '../../src/main/your-move/store'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 24, 12)
const HERE = '/org/proj/www'
const GONE = '/org/proj/removed-worktree'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-hygiene-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const card = (id: string, over: Partial<YourMoveCard> = {}): YourMoveCard => ({
  id,
  sessionId: 'alive',
  folder: HERE,
  kind: 'decide',
  ask: `ask ${id}`,
  source: 'judge',
  lane: 'live',
  openedAt: NOW - DAY,
  updatedAt: NOW - DAY,
  ...over
})

async function storeWith(cards: YourMoveCard[]): Promise<YourMoveStore> {
  const file = path.join(dir, 'your-move.json')
  await writeFile(file, JSON.stringify({ version: 1, cards, cursors: {} }))
  return openYourMoveStore(file)
}

const presence = {
  lookup: async (id: string): Promise<TranscriptLookup> => {
    if (id === 'ghost') return { state: 'missing' }
    if (id === 'flaky') return { state: 'unknown' }
    if (id === 'throws') throw new Error('EMFILE')
    return { state: 'found', path: `/t/${id}.jsonl` }
  },
  folder: async (f: string): Promise<'present' | 'missing' | 'unknown'> =>
    f === GONE ? 'missing' : f === '/org/proj/unreadable' ? 'unknown' : 'present'
}

const open = (store: YourMoveStore): string[] =>
  store
    .state()
    .cards.filter((c) => c.closedAt === undefined)
    .map((c) => c.id)
    .sort()
const closedBy = (store: YourMoveStore, id: string): string | undefined =>
  store.state().cards.find((c) => c.id === id)?.closedBy

describe('AC-2: a live card with no activity for 7 days expires', () => {
  it('closes it as expired and keeps it in the history; a younger one stays', async () => {
    const store = await storeWith([
      card('old', { updatedAt: NOW - 7 * DAY - 1, openedAt: NOW - 20 * DAY }),
      card('edge', { updatedAt: NOW - 7 * DAY }),
      card('touched', { openedAt: NOW - 20 * DAY, updatedAt: NOW - DAY }),
      card('old-observe', { lane: 'observe', updatedAt: NOW - 20 * DAY }),
      card('old-death', { source: 'death', updatedAt: NOW - 8 * DAY })
    ])
    const r = await sweepStaleCards({ store, ...presence, now: () => NOW })
    expect(r.expired).toBe(2)
    expect(open(store)).toEqual(['edge', 'old-observe', 'touched'])
    expect(closedBy(store, 'old')).toBe('expired')
    expect(store.state().cards).toHaveLength(5)
  })
})

describe('AC-4: a card whose transcript or folder is gone closes', () => {
  it('by source, and never on an unknown answer', async () => {
    const store = await storeWith([
      card('no-transcript', { sessionId: 'ghost' }),
      card('no-transcript-mission', { sessionId: 'ghost', source: 'mission' }),
      card('no-folder', { folder: GONE }),
      card('death-no-transcript', { sessionId: 'ghost', source: 'death' }),
      card('death-no-folder', { sessionId: 'ghost', folder: GONE, source: 'death' }),
      card('lookup-unknown', { sessionId: 'flaky' }),
      card('lookup-throws', { sessionId: 'throws' }),
      card('folder-unknown', { folder: '/org/proj/unreadable' }),
      card('fine')
    ])
    const r = await sweepStaleCards({ store, ...presence, now: () => NOW })
    expect(r.gone).toBe(4)
    expect(open(store)).toEqual([
      'death-no-transcript',
      'fine',
      'folder-unknown',
      'lookup-throws',
      'lookup-unknown'
    ])
    expect(closedBy(store, 'no-folder')).toBe('folder-removed')
    expect(closedBy(store, 'no-transcript')).toBe('source-resolved')
  })

  it('the folder probe: a directory is present, a missing path or a file is not', async () => {
    const sub = path.join(dir, 'a-folder')
    await mkdir(sub)
    await writeFile(path.join(dir, 'a-file'), 'x')
    expect(await folderPresence(sub)).toBe('present')
    expect(await folderPresence(path.join(dir, 'nowhere'))).toBe('missing')
    expect(await folderPresence(path.join(dir, 'a-file'))).toBe('missing')
    expect(await folderPresence(path.join(dir, 'a-file', 'under'))).toBe('missing')
    // not a path anything can be checked at: never a reason to close
    expect(await folderPresence('')).toBe('unknown')
  })
})

describe('the startup cleanup applies the four rules to what is on disk', () => {
  const missionCard = (id: string, missionId: string, key: string): YourMoveCard =>
    card(id, {
      source: 'mission',
      sourceKey: `${missionId}:${key}`,
      updatedAt: NOW,
      mission: { missionId, root: HERE, item: {} as never }
    })
  const item = (id: string): WaitingItemV4 =>
    ({ kind: 'settle', id, ask: `Mark ${id}`, why: 'why' }) as unknown as WaitingItemV4
  const view = (id: string, you: WaitingItemV4[], changedAt: number): DraftView =>
    ({ root: HERE, mission: { id, owner: { sessionId: 'alive' } }, you, changedAt }) as DraftView

  const views: RecordViews = new Map([
    [
      HERE,
      {
        views: [
          view('mnt-active', [item('settle:b'), item('settle:c')], NOW - DAY),
          view('mnt-stale', [], NOW - 30 * DAY),
          view('mnt-new', [item('settle:z')], NOW - DAY)
        ],
        unreadable: false
      }
    ]
  ])

  const seed = (): YourMoveCard[] => [
    // D
    card('d-transcript', { sessionId: 'ghost' }),
    card('d-folder', { folder: GONE }),
    // A: two turns of one session; the newest batch is one filed card plus one restated card
    card('a-older', { sessionId: 'talker', updatedAt: NOW - 3 * DAY }),
    card('a-hidden', { sessionId: 'talker', lane: 'mid-turn', updatedAt: NOW - 4 * DAY }),
    card('a-new', { sessionId: 'talker', updatedAt: NOW - DAY }),
    card('a-restated', { sessionId: 'talker', openedAt: NOW - 5 * DAY, updatedAt: NOW - DAY }),
    card('a-single', { sessionId: 'quiet', updatedAt: NOW - 2 * DAY }),
    // B
    card('b-old', { sessionId: 'sleeper', updatedAt: NOW - 10 * DAY }),
    // C
    missionCard('c-next', 'mnt-active', 'settle:b'),
    missionCard('c-extra', 'mnt-active', 'settle:c'),
    missionCard('c-stale', 'mnt-stale', 'close'),
    missionCard('c-closed', 'mnt-closed', 'close')
  ]

  const run = (store: YourMoveStore): ReturnType<typeof cleanupQueue> =>
    cleanupQueue({
      store,
      ...presence,
      now: () => NOW,
      readViews: async () => views,
      folderOff: () => false
    })

  it('reports what each rule closed, and files no new card', async () => {
    const store = await storeWith(seed())
    const r = await run(store)
    expect(r).toEqual({ gone: 2, superseded: 2, expired: 1, mission: 3 })
    expect(open(store)).toEqual(['a-new', 'a-restated', 'a-single', 'c-next'])
  })

  it('is safe to run again', async () => {
    const store = await storeWith(seed())
    await run(store)
    const before = store.state()
    expect(await run(store)).toEqual({ gone: 0, superseded: 0, expired: 0, mission: 0 })
    expect(store.state()).toBe(before)
  })

  it('leaves the mission cards of a folder switched off', async () => {
    const store = await storeWith(seed())
    const r = await cleanupQueue({
      store,
      ...presence,
      now: () => NOW,
      readViews: async (roots) => (roots.includes(HERE) ? views : new Map()),
      folderOff: (root) => root === HERE
    })
    expect(r.mission).toBe(0)
    expect(open(store)).toEqual(expect.arrayContaining(['c-next', 'c-extra', 'c-stale']))
  })

  it('a mission read that fails closes nothing by itself and does not stop the other rules', async () => {
    const store = await storeWith(seed())
    const r = await cleanupQueue({
      store,
      ...presence,
      now: () => NOW,
      readViews: async () => {
        throw new Error('boom')
      },
      folderOff: () => false
    })
    expect(r).toEqual({ gone: 2, superseded: 2, expired: 1, mission: 0 })
  })
})

describe('a mission card ages with its mission record, not with the card', () => {
  const missionCard = card('m-old', {
    source: 'mission',
    sourceKey: 'mnt-alpha:close',
    updatedAt: NOW - 20 * DAY,
    openedAt: NOW - 20 * DAY,
    mission: { missionId: 'mnt-alpha', root: HERE, item: {} as never }
  })

  it('expiry alone never closes it: an app that was closed for a week keeps an active mission', async () => {
    const store = await storeWith([missionCard])
    expect(await sweepStaleCards({ store, ...presence, now: () => NOW })).toEqual({
      gone: 0,
      expired: 0
    })
    const views: RecordViews = new Map([
      [
        HERE,
        {
          views: [
            {
              root: HERE,
              mission: { id: 'mnt-alpha', owner: { sessionId: 'alive' } },
              you: [{ kind: 'close', id: 'close', ask: 'Close it', why: 'why' } as never],
              changedAt: NOW - DAY
            }
          ],
          unreadable: false
        }
      ]
    ])
    const r = await cleanupQueue({
      store,
      ...presence,
      now: () => NOW,
      readViews: async () => views,
      folderOff: () => false
    })
    expect(r).toEqual({ gone: 0, superseded: 0, expired: 0, mission: 0 })
    expect(open(store)).toEqual(['m-old'])
  })
})
