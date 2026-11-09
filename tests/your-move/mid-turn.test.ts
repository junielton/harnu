import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskState } from '../../src/main/hook-state'
import type { YourMoveMode } from '../../src/main/your-move/core'
import { createInspector, type InspectRequest } from '../../src/main/your-move/inspector'
import type { EnrichOutcome, JudgeOutcome } from '../../src/main/your-move/judge'
import { openYourMoveStore, type YourMoveStore } from '../../src/main/your-move/store'
import { readFrom } from '../../src/main/your-move/transcript'
import {
  MID_TURN_AFTER_MS,
  SWEEP_MS,
  createMidTurnSweep,
  type MidTurnDeps
} from '../../src/main/your-move/triggers'

let dir: string
let file: string
let store: YourMoveStore
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-midturn-'))
  file = path.join(dir, 'sess-0001.jsonl')
  store = await openYourMoveStore(path.join(dir, 'your-move.json'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const human = (text: string) => ({
  type: 'user',
  entrypoint: 'cli',
  origin: { kind: 'human' },
  message: { content: text }
})
const asst = (text: string) => ({
  type: 'assistant',
  entrypoint: 'cli',
  message: { content: [{ type: 'text', text }] }
})
const tool = () => ({
  type: 'assistant',
  entrypoint: 'cli',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }
})
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

const T0 = 10_000_000
const putCursor = (offset: number, lastInspectedAt: number, shadowOffset?: number) =>
  store.transact((s) => ({
    next: {
      ...s,
      cursors: {
        'sess-0001': {
          offset,
          lastInspectedAt,
          ...(shadowOffset !== undefined ? { shadowOffset } : {})
        }
      }
    },
    result: null
  }))

function sweepHarness(over: Partial<MidTurnDeps> = {}) {
  const requests: InspectRequest[] = []
  const reads = vi.fn(readFrom)
  const deps: MidTurnDeps = {
    inspector: {
      request: async (r) => {
        requests.push(r)
        return 'judged'
      }
    },
    store,
    mode: () => 'observe' as YourMoveMode,
    eligible: async () => true,
    locate: async () => file,
    resolveFolder: async () => '/work/acme',
    read: reads,
    states: () => new Map<string, TaskState>([['sess-0001', 'working']]),
    now: () => T0,
    ...over
  }
  return { sweep: createMidTurnSweep(deps), requests, reads }
}

describe('five-minute inspection without a Stop', () => {
  it('requests trigger mid-turn when lastInspectedAt is older than 5 minutes and new assistant text exists', async () => {
    await writeFile(file, jsonl([human('go'), asst('Which database should I use?')]))
    await putCursor(0, T0 - MID_TURN_AFTER_MS - 1)
    const h = sweepHarness()
    await h.sweep.tick()
    expect(h.requests).toEqual([
      {
        sessionId: 'sess-0001',
        folder: '/work/acme',
        transcriptPath: file,
        trigger: 'mid-turn'
      }
    ])
  })

  it('waits until 5 minutes have passed since the last inspection', async () => {
    await writeFile(file, jsonl([asst('Which database should I use?')]))
    await putCursor(0, T0 - MID_TURN_AFTER_MS + 1_000)
    const h = sweepHarness()
    await h.sweep.tick()
    expect(h.requests).toHaveLength(0)
  })

  it('reads from the shadow cursor, not the live one', async () => {
    const first = jsonl([asst('old question?')])
    await writeFile(file, first)
    // The live cursor is behind, the shadow cursor already passed the only text there is.
    await putCursor(0, T0 - MID_TURN_AFTER_MS - 1, Buffer.byteLength(first))
    const h = sweepHarness()
    await h.sweep.tick()
    expect(h.requests).toHaveLength(0)
  })

  it('does nothing when only TOOL entries were added, and leaves shadowOffset alone', async () => {
    const first = jsonl([human('go')])
    await writeFile(file, first)
    const at = Buffer.byteLength(first)
    await putCursor(at, T0 - MID_TURN_AFTER_MS - 1, at)
    await appendFile(file, jsonl([tool(), tool()]))
    const h = sweepHarness()
    await h.sweep.tick()
    expect(h.requests).toHaveLength(0)
    expect(store.state().cursors['sess-0001'].shadowOffset).toBe(at)
  })

  it('a working session with no cursor yet is requested, so its cursor gets set', async () => {
    await writeFile(file, jsonl([asst('hello')]))
    const h = sweepHarness()
    await h.sweep.tick()
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0].trigger).toBe('mid-turn')
  })

  it('only working sessions are swept', async () => {
    await writeFile(file, jsonl([asst('Which database should I use?')]))
    await putCursor(0, T0 - MID_TURN_AFTER_MS - 1)
    const h = sweepHarness({
      states: () =>
        new Map<string, TaskState>([
          ['sess-0001', 'idle'],
          ['sess-0002', 'failed']
        ])
    })
    await h.sweep.tick()
    expect(h.requests).toHaveLength(0)
  })

  it('Off reads nothing: no locate, no transcript, no request', async () => {
    const locate = vi.fn(async () => file)
    const h = sweepHarness({ mode: () => 'off', locate })
    await h.sweep.tick()
    expect(locate).not.toHaveBeenCalled()
    expect(h.reads).not.toHaveBeenCalled()
    expect(h.requests).toHaveLength(0)
  })

  it('a blocked, archived or folder-off session is not read', async () => {
    await putCursor(0, T0 - MID_TURN_AFTER_MS - 1)
    const h = sweepHarness({ eligible: async () => false })
    await h.sweep.tick()
    expect(h.reads).not.toHaveBeenCalled()
    expect(h.requests).toHaveLength(0)
  })

  it('a session with an inspection still running is not requested again', async () => {
    await writeFile(file, jsonl([asst('Which database should I use?')]))
    await putCursor(0, T0 - MID_TURN_AFTER_MS - 1)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    const h = sweepHarness({
      inspector: {
        request: async () => {
          calls++
          await gate
          return 'judged'
        }
      }
    })
    await h.sweep.tick()
    await h.sweep.tick()
    expect(calls).toBe(1)
    release()
  })

  it('a failing dependency never escapes a tick', async () => {
    const h = sweepHarness({
      locate: async () => {
        throw new Error('boom')
      }
    })
    await expect(h.sweep.tick()).resolves.toBeUndefined()
  })

  it('sweeps once a minute', () => {
    expect(SWEEP_MS).toBe(60_000)
    expect(MID_TURN_AFTER_MS).toBe(5 * 60_000)
  })
})

describe('mid-turn cards and the live cursor', () => {
  const verdict = (ask: string) =>
    ({
      ok: true,
      costUsd: 0,
      durationMs: 1,
      verdict: { new: [{ kind: 'decide', ask }], update: [], close: [] }
    }) as JudgeOutcome

  function realInspector(mode: YourMoveMode) {
    const detect = vi.fn(async () => verdict('Which database should I use?'))
    const enrich = vi.fn(async (): Promise<EnrichOutcome> => ({
      ok: false,
      reason: 'enrichment off'
    }))
    let n = 0
    const inspector = createInspector({
      store,
      read: readFrom,
      detect,
      enrich,
      now: () => T0,
      mintId: () => `id-${++n}`,
      isBlocked: () => false,
      isArchived: () => false,
      isFolderOff: () => false,
      mode: () => mode,
      midTurnLive: () => false,
      classify: () => 'interactive'
    })
    return { inspector, detect }
  }

  it('files lane mid-turn cards that the queue never shows while midTurnLive is false', async () => {
    await writeFile(file, jsonl([human('go'), asst('Which database should I use?')]))
    await putCursor(0, T0 - MID_TURN_AFTER_MS - 1)
    const { inspector } = realInspector('live')
    const h = sweepHarness({ inspector })
    await h.sweep.tick()
    await inspector.idle()
    const cards = store.state().cards
    expect(cards).toHaveLength(1)
    expect(cards[0].lane).toBe('mid-turn')
  })

  it('a later Stop still judges the same text on the live cursor', async () => {
    const text = jsonl([human('go'), asst('Which database should I use?')])
    await writeFile(file, text)
    await putCursor(0, T0 - MID_TURN_AFTER_MS - 1)
    const { inspector, detect } = realInspector('live')
    const h = sweepHarness({ inspector })
    await h.sweep.tick()
    await inspector.idle()
    const afterMid = detect.mock.calls.length
    expect(afterMid).toBeGreaterThan(0)
    // the mid-turn pass moved the shadow cursor only
    expect(store.state().cursors['sess-0001']).toMatchObject({
      offset: 0,
      shadowOffset: Buffer.byteLength(text)
    })

    await inspector.request({
      sessionId: 'sess-0001',
      folder: '/work/acme',
      transcriptPath: file,
      trigger: 'stop'
    })
    // the Stop saw the same text again and filed it on the live lane
    expect(detect.mock.calls.length).toBeGreaterThan(afterMid)
    const lanes = store
      .state()
      .cards.map((c) => c.lane)
      .sort()
    expect(lanes).toEqual(['live', 'mid-turn'])
    expect(store.state().cursors['sess-0001'].offset).toBe(Buffer.byteLength(text))
  })
})
