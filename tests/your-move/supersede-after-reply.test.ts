/**
 * BUG-308 delta 2 (operator's decision): a newer turn closes a session's older judge cards only
 * when the operator typed in that session after those cards were filed. A turn made only of agent
 * work closes nothing, and anything unknown keeps the card.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { YourMoveCard } from '../../src/main/your-move/core'
import { cleanupQueue } from '../../src/main/your-move/hygiene'
import {
  createInspector,
  type InspectRequest,
  type InspectorDeps
} from '../../src/main/your-move/inspector'
import type { EnrichOutcome, JudgeOutcome } from '../../src/main/your-move/judge'
import { createOperatorGate } from '../../src/main/your-move/operator'
import { openYourMoveStore, type YourMoveStore } from '../../src/main/your-move/store'
import type { ReadResult } from '../../src/main/your-move/transcript'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 24, 12)

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-reply-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const human = (text: string, at: number): Record<string, unknown> => ({
  type: 'user',
  entrypoint: 'cli',
  timestamp: new Date(at).toISOString(),
  origin: { kind: 'human' },
  message: { content: text }
})
const asst = (text: string): Record<string, unknown> => ({
  type: 'assistant',
  entrypoint: 'cli',
  message: { content: [{ type: 'text', text }] }
})

const card = (id: string, over: Partial<YourMoveCard> = {}): YourMoveCard => ({
  id,
  sessionId: 'sess-alpha',
  folder: '/org/proj/www',
  kind: 'go_no_go',
  ask: `ask ${id}`,
  source: 'judge',
  lane: 'live',
  openedAt: NOW - DAY,
  updatedAt: NOW - DAY,
  ...over
})

async function storeWith(
  cards: YourMoveCard[],
  cursor: number | null = 100
): Promise<YourMoveStore> {
  const file = path.join(dir, 'your-move.json')
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      cards,
      cursors: cursor === null ? {} : { 'sess-alpha': { offset: cursor, lastInspectedAt: 1 } }
    })
  )
  return openYourMoveStore(file)
}

const open = (store: YourMoveStore): string[] =>
  store
    .state()
    .cards.filter((c) => c.closedAt === undefined)
    .map((c) => c.id)

async function judge(
  store: YourMoveStore,
  lines: Record<string, unknown>[],
  over: Partial<InspectorDeps> = {}
): Promise<void> {
  const outcome = {
    ok: true,
    costUsd: 0,
    durationMs: 1,
    verdict: { new: [{ kind: 'do', ask: 'Check the build' }], update: [], close: [] }
  } as unknown as JudgeOutcome
  const deps: InspectorDeps = {
    store,
    read: (async (): Promise<ReadResult> => ({
      lines,
      nextOffset: 900,
      size: 900,
      shrunk: false
    })) as unknown as InspectorDeps['read'],
    detect: vi.fn(async () => outcome),
    enrich: vi.fn(async (): Promise<EnrichOutcome> => ({ ok: false, reason: 'off' })),
    now: () => NOW,
    mintId: () => 'fresh',
    isBlocked: () => false,
    isArchived: () => false,
    isFolderOff: () => false,
    mode: () => 'live',
    midTurnLive: () => false,
    classify: () => 'interactive',
    hasOperator: async () => true,
    ...over
  }
  const req: InspectRequest = {
    sessionId: 'sess-alpha',
    folder: '/org/proj/www',
    transcriptPath: '/t/sess-alpha.jsonl',
    trigger: 'stop'
  }
  expect(await createInspector(deps).request(req)).toBe('judged')
}

describe('at filing', () => {
  it('a turn made only of agent work leaves the older card open, beside the new one', async () => {
    const store = await storeWith([card('merge')])
    await judge(store, [
      asst('Tests pass.'),
      {
        type: 'user',
        origin: { kind: 'task-notification' },
        message: { content: 'the tick ran' }
      },
      human('[Harnu · Roadmap dispatch] go', NOW - 1_000),
      asst('Done with the tick.')
    ])
    expect(open(store)).toEqual(['merge', 'fresh'])
  })

  it('a turn the operator typed in closes it', async () => {
    const store = await storeWith([card('merge')])
    await judge(store, [human('merge it later', NOW - 1_000), asst('ok')])
    expect(open(store)).toEqual(['fresh'])
    expect(store.state().cards[0]).toMatchObject({ closedBy: 'superseded' })
  })

  it('a reply typed while the card was still being judged still counts', async () => {
    // The card was filed after the reply's own clock, but the reply is in the unread segment.
    const store = await storeWith([card('merge', { updatedAt: NOW - 500 })])
    await judge(store, [human('go ahead', NOW - 1_000), asst('ok')])
    expect(open(store)).toEqual(['fresh'])
  })

  it('on a first sight, only a reply newer than the card closes it', async () => {
    const before = [human('start the work', NOW - 2 * DAY), asst('ok')]
    const kept = await storeWith([card('merge')], null)
    await judge(kept, before)
    expect(open(kept)).toEqual(['merge', 'fresh'])
    const closed = await storeWith([card('merge')], null)
    await judge(closed, [...before, human('and ship', NOW - 1_000), asst('ok')])
    expect(open(closed)).toEqual(['fresh'])
  })

  it('with mid-turn cards on, a card filed after the reply stays', async () => {
    const store = await storeWith([card('mid', { updatedAt: NOW - 500 }), card('old')])
    await judge(store, [human('do it', NOW - 1_000), asst('ok')], { midTurnLive: () => true })
    expect(open(store)).toEqual(['mid', 'fresh'])
  })
})

describe('at startup', () => {
  const pair = (sessionId: string): YourMoveCard[] => [
    card(`${sessionId}-old`, { sessionId, updatedAt: NOW - 3 * DAY }),
    card(`${sessionId}-new`, { sessionId, updatedAt: NOW - DAY })
  ]

  it('closes an older card only on a reply after it; an unknown keeps it', async () => {
    const store = await storeWith([
      ...pair('replied'),
      ...pair('silent'),
      ...pair('earlier'),
      ...pair('unreadable'),
      ...pair('throws')
    ])
    const r = await cleanupQueue({
      store,
      lookup: async (id) => ({ state: 'found', path: `/t/${id}.jsonl` }),
      folder: async () => 'present',
      now: () => NOW,
      readViews: async () => new Map(),
      folderOff: () => false,
      lastReplyAt: async (id) => {
        if (id === 'throws') throw new Error('EMFILE')
        if (id === 'replied') return NOW - 2 * DAY
        if (id === 'earlier') return NOW - 4 * DAY
        return null
      }
    })
    expect(r.superseded).toBe(1)
    expect(open(store)).not.toContain('replied-old')
    expect(open(store)).toEqual(
      expect.arrayContaining(['silent-old', 'earlier-old', 'unreadable-old', 'throws-old'])
    )
  })

  it('reads the reply from the transcript the way the gate does', async () => {
    const file = path.join(dir, 't.jsonl')
    const rows = [
      human('first', NOW - 3 * DAY),
      human('last typed', NOW - 2 * DAY),
      human('[Harnu · Roadmap dispatch] go', NOW - DAY),
      { ...human('meta', NOW - 1_000), isMeta: true },
      asst('ok')
    ]
    await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const gate = createOperatorGate()
    expect(await gate.lastReplyAt(file)).toBe(NOW - 2 * DAY)
    expect(await gate.lastReplyAt(path.join(dir, 'nowhere.jsonl'))).toBeNull()
  })
})
