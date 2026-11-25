/**
 * BUG-277: the store must stay cheap at the size the operator's real file reached (7,432 cards,
 * 5.9 MB). Before the fix `state()` deep-cloned the whole store and `transact` cloned it again and
 * serialized it twice, so every hook event, judge run and IPC list blocked the main thread for
 * up to 530 ms. This file is the gate: it fails on the old code and holds the new one to budgets.
 *
 * Budgets come from the card (AC-4): a read < 5 ms, a single-card transact < 30 ms, at 10,000
 * cards of which 7,000 are open. Medians over several runs keep a noisy CI box from flaking it.
 */
import { promises as fsp } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pruneClosed, type YourMoveCard, type YourMoveState } from '../../src/main/your-move/core'
import { sweepStaleCards } from '../../src/main/your-move/hygiene'
import { openYourMoveStore, type YourMoveStore } from '../../src/main/your-move/store'

const TOTAL = 10_000
const OPEN = 7_000
const NOW = Date.UTC(2026, 10, 24, 12)
/** Timed samples behind every budget: a median of this many warm runs, never a single sample. */
const SAMPLES = 7

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-scale-'))
  file = path.join(dir, 'your-move.json')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

/** A card the size of a real one: the judge's `ask`, `context`, `evidence` and options. */
function mk(i: number, closed: boolean): YourMoveCard {
  const open = NOW - (i % 5_000) * 60_000
  return {
    id: `card-${i}`,
    sessionId: `session-${i % 400}`,
    folder: `/org/proj/www-${i % 40}`,
    kind: 'decide',
    ask: `Which of these two approaches should session ${i} take for the migration?`,
    context: 'The session compared the two approaches in its last turn and stopped to ask. '.repeat(
      3
    ),
    blocks: 'The migration step stays blocked until the operator picks one.',
    options: ['Approach A: keep the table', 'Approach B: add a view'],
    recommended: 'Approach B: add a view',
    confidence: 'high',
    evidence: 'Which one do you prefer? I would go with B, but A is the safer rollback.',
    source: i % 10 === 0 ? 'human-gate' : 'judge',
    lane: 'live',
    openedAt: open,
    updatedAt: open,
    ...(closed ? { closedAt: open + 1_000, closedBy: 'judge' as const } : {})
  }
}

async function seed(): Promise<YourMoveStore> {
  const cards = Array.from({ length: TOTAL }, (_, i) => mk(i, i >= OPEN))
  await writeFile(file, JSON.stringify({ version: 1, cards, cursors: {} }))
  return openYourMoveStore(file)
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

async function timed<T>(fn: () => T | Promise<T>): Promise<number> {
  const t0 = performance.now()
  await fn()
  return performance.now() - t0
}

describe('your move store at 10,000 cards (7,000 open)', () => {
  it('AC-1: a read does not copy the store and costs under 5 ms', async () => {
    const store = await seed()
    const clone = vi.spyOn(globalThis, 'structuredClone')
    store.state() // warm-up: the first call pays for JIT and the freshly parsed heap, not the read
    const runs: number[] = []
    for (let i = 0; i < SAMPLES; i++) runs.push(await timed(() => store.state()))
    expect(clone).not.toHaveBeenCalled()
    expect(median(runs)).toBeLessThan(5)
    // The same snapshot is handed to every reader until a write replaces it.
    expect(store.state()).toBe(store.state())
  })

  it('AC-1: the snapshot cannot be mutated, so sharing it is safe', async () => {
    const store = await seed()
    expect(() => store.state().cards.push(mk(99_999, false))).toThrow()
    expect(() => {
      store.state().cards[0].ask = 'changed'
    }).toThrow()
    expect(() => {
      store.state().cursors['x'] = { lastInspectedAt: 1 }
    }).toThrow()
    expect(store.state().cards).toHaveLength(TOTAL)
  })

  it('AC-1: a listener is handed the same immutable snapshot, not a copy', async () => {
    const store = await seed()
    const seen: YourMoveState[] = []
    store.onChange((s) => seen.push(s))
    await store.transact((s) => ({
      next: { ...s, cards: [...s.cards, mk(TOTAL, false)] },
      result: null
    }))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(store.state())
  })

  it('AC-2: a no-op transact clones nothing, writes nothing and is fast', async () => {
    const store = await seed()
    const before = await stat(file)
    const clone = vi.spyOn(globalThis, 'structuredClone')
    const write = vi.spyOn(fsp, 'writeFile')
    const onChange = vi.fn()
    store.onChange(onChange)
    // A fresh object with the same content, the shape a reducer that changed nothing returns.
    const noop = (): Promise<null> =>
      store.transact((s) => ({ next: { ...s, cards: [...s.cards] }, result: null }))
    await noop() // warm-up, not timed
    const runs: number[] = []
    for (let i = 0; i < SAMPLES; i++) runs.push(await timed(noop))
    expect(clone).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
    expect(median(runs)).toBeLessThan(10)
  })

  it('AC-2: a no-op decided without serializing the whole state', async () => {
    const store = await seed()
    const stringify = vi.spyOn(JSON, 'stringify')
    await store.transact((s) => ({ next: { ...s, cards: [...s.cards] }, result: null }))
    const wholeState = stringify.mock.calls.filter(
      ([v]) => v !== null && typeof v === 'object' && 'cards' in (v as object)
    )
    expect(wholeState).toHaveLength(0)
  })

  it('AC-4: a single-card transact commits in under 30 ms', async () => {
    const store = await seed()
    const edit = (i: number): Promise<null> =>
      store.transact((s) => {
        const cards = s.cards.slice()
        cards[i] = { ...cards[i], ask: `edited ${i}`, updatedAt: NOW + i }
        return { next: { ...s, cards }, result: null }
      })
    // The first write fills the per-card serialization cache (all 10,000 cards, once per process):
    // a warm-up, not the steady cost a hook event pays. The gate is the median of the next
    // SAMPLES single-card writes, so one noisy sample on a shared CI runner cannot fail it.
    await edit(0)
    const runs: number[] = []
    for (let i = 1; i <= SAMPLES; i++) runs.push(await timed(() => edit(i)))
    expect(median(runs)).toBeLessThan(30)
  })

  it('AC-4: the single-card commit still lands on disk and reloads', async () => {
    const store = await seed()
    await store.transact((s) => {
      const cards = s.cards.slice()
      cards[3] = { ...cards[3], ask: 'edited on disk' }
      return { next: { ...s, cards }, result: null }
    })
    const again = await openYourMoveStore(file)
    expect(again.state().cards).toHaveLength(TOTAL)
    expect(again.state().cards[3].ask).toBe('edited on disk')
  })
})

describe('AC-3 / AC-7: closed cards live for a 7-day window, then go', () => {
  const day = 86_400_000
  const closedAt = (id: string, ago: number): YourMoveCard => ({
    ...mk(1, true),
    id,
    closedAt: NOW - ago
  })

  it('drops closed cards older than 7 days and keeps newer ones and every open card', () => {
    const s: YourMoveState = {
      version: 1,
      cursors: {},
      cards: [
        mk(1, false),
        closedAt('fresh', 6 * day),
        closedAt('edge', 7 * day),
        closedAt('stale', 8 * day),
        closedAt('ancient', 29 * day)
      ]
    }
    const ids = pruneClosed(s, NOW).cards.map((c) => c.id)
    expect(ids).toEqual(['card-1', 'fresh', 'edge'])
  })

  it('the one-time migration: a 10,000-card file with 3,000 stale closed cards shrinks to open + window', async () => {
    const cards = Array.from({ length: TOTAL }, (_, i) =>
      i < OPEN ? mk(i, false) : closedAt(`old-${i}`, 8 * day + i)
    )
    await writeFile(file, JSON.stringify({ version: 1, cards, cursors: {} }))
    const store = await openYourMoveStore(file)
    await store.transact((s) => ({ next: pruneClosed(s, NOW), result: null }))
    expect(store.state().cards).toHaveLength(OPEN)
    const again = await openYourMoveStore(file)
    expect(again.state().cards).toHaveLength(OPEN)
  })
})

describe('BUG-308: the stale sweep at 10,000 cards', () => {
  it('asks each session and folder once and commits in one write', async () => {
    const store = await seed()
    const sessions: string[] = []
    const folders: string[] = []
    const onChange = vi.fn()
    store.onChange(onChange)
    const r = await sweepStaleCards({
      store,
      lookup: async (id) => {
        sessions.push(id)
        return id === 'session-0' ? { state: 'missing' } : { state: 'found', path: `/t/${id}` }
      },
      folder: async (f) => {
        folders.push(f)
        return 'present'
      },
      now: () => NOW
    })
    expect(new Set(sessions).size).toBe(sessions.length)
    expect(new Set(folders).size).toBe(folders.length)
    expect(r.gone).toBeGreaterThan(0)
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
