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
  createEnsureCursor,
  createMidTurnSweep,
  createTriggers,
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

describe('a session already seen is never given a live offset by a hook (delta 2)', () => {
  const ev = (event: string, matcher?: string) =>
    ({
      sessionId: 'sess-0001',
      taskState: 'working',
      event,
      matcher,
      ts: 1,
      source: 'hook',
      payload: { cwd: '/work/acme', transcriptPath: file }
    }) as never

  async function fire(event: string, matcher?: string): Promise<void> {
    const t = createTriggers({
      inspector: { request: async () => 'judged' },
      store,
      mode: () => 'observe',
      eligible: async () => true,
      locate: async () => file,
      resolveFolder: async (_id, cwd) => cwd ?? '/work/acme',
      now: () => T0,
      setTimer: () => 0,
      ensureCursor: createEnsureCursor({
        store,
        read: readFrom,
        classify: () => 'interactive',
        now: () => T0
      }),
      transcriptHas: async () => true,
      delay: async () => undefined
    })
    t.onTaskEvent(ev(event, matcher))
    await new Promise((r) => setTimeout(r, 40))
  }

  it('a compaction on a shadow-only cursor leaves the live cursor unset', async () => {
    await writeFile(file, jsonl([human('go'), asst('Which database should I use?')]))
    await store.transact((s) => ({
      next: { ...s, cursors: { 'sess-0001': { shadowOffset: 10, lastInspectedAt: T0 } } },
      result: null
    }))
    await fire('SessionStart', 'compact')
    expect(store.state().cursors['sess-0001'].offset).toBeUndefined()
    expect(store.state().cursors['sess-0001'].shadowOffset).toBe(10)
  })

  it('a prompt on a shadow-only cursor leaves the live cursor unset too', async () => {
    await writeFile(file, jsonl([human('go'), asst('Which database should I use?')]))
    await store.transact((s) => ({
      next: { ...s, cursors: { 'sess-0001': { shadowOffset: 10, lastInspectedAt: T0 } } },
      result: null
    }))
    await fire('UserPromptSubmit')
    expect(store.state().cursors['sess-0001'].offset).toBeUndefined()
  })

  it('a session never seen still gets its cursor at its first hook', async () => {
    await writeFile(file, jsonl([human('go')]))
    await fire('SessionStart', 'startup')
    expect(store.state().cursors['sess-0001'].offset).toBeGreaterThan(0)
  })
})

describe('mid-turn cursor discipline (delta 1)', () => {
  function rig(detectImpl?: () => Promise<JudgeOutcome>) {
    const clock = { now: T0 }
    const detect = vi.fn(
      detectImpl ??
        (async () =>
          ({
            ok: true,
            costUsd: 0,
            durationMs: 1,
            verdict: { new: [{ kind: 'decide', ask: 'Which?' }], update: [], close: [] }
          }) as JudgeOutcome)
    )
    const enrich = vi.fn(async (): Promise<EnrichOutcome> => ({ ok: false, reason: 'off' }))
    let n = 0
    const inspector = createInspector({
      store,
      read: readFrom,
      detect: detect as never,
      enrich,
      now: () => clock.now,
      mintId: () => `id-${++n}`,
      isBlocked: () => false,
      isArchived: () => false,
      isFolderOff: () => false,
      mode: () => 'observe',
      midTurnLive: () => false,
      classify: () => 'interactive'
    })
    const h = sweepHarness({ inspector, now: () => clock.now })
    const stop = () =>
      inspector.request({
        sessionId: 'sess-0001',
        folder: '/work/acme',
        transcriptPath: file,
        trigger: 'stop'
      })
    return { clock, detect, inspector, sweep: h.sweep, stop }
  }

  it('a mid-turn first sight leaves the live cursor unset, so the Stop judges the recent tail', async () => {
    await writeFile(file, jsonl([human('go'), asst('Which database should I use?')]))
    const r = rig()
    await r.sweep.tick()
    await r.inspector.idle()
    expect(store.state().cursors['sess-0001'].offset).toBeUndefined()
    expect(r.detect).not.toHaveBeenCalled()
    expect(await r.stop()).toBe('judged')
    expect(r.detect).toHaveBeenCalled()
    expect(store.state().cards.map((c) => c.lane)).toEqual(['observe'])
  })

  it('a failing mid-turn inspection is not retried before MID_TURN_AFTER_MS', async () => {
    await writeFile(file, jsonl([human('go'), asst('Which database should I use?')]))
    await putCursor(0, T0 - MID_TURN_AFTER_MS - 1, 0)
    const r = rig(async () => ({ ok: false, reason: 'rate limited' }) as JudgeOutcome)
    const perTick: number[] = []
    for (let i = 0; i < 6; i++) {
      const before = r.detect.mock.calls.length
      await r.sweep.tick()
      await r.inspector.idle()
      await new Promise((res) => setTimeout(res, 2))
      perTick.push(r.detect.mock.calls.length - before)
      r.clock.now += SWEEP_MS
    }
    // one attempt on the first tick, then silence for the five minutes that follow
    expect(perTick[0]).toBeGreaterThan(0)
    expect(perTick.slice(1, 5)).toEqual([0, 0, 0, 0])
    // the cursor still did not move on failure
    expect(store.state().cursors['sess-0001'].offset).toBe(0)
    // after the wait it tries again
    r.clock.now += MID_TURN_AFTER_MS
    const before = r.detect.mock.calls.length
    await r.sweep.tick()
    await r.inspector.idle()
    expect(r.detect.mock.calls.length).toBeGreaterThan(before)
  })

  it('a long turn after a Stop judges only the text since that Stop', async () => {
    await writeFile(file, jsonl([human('first'), asst('TURN-ONE-QUESTION?')]))
    await putCursor(0, T0, 0)
    const r = rig()
    expect(await r.stop()).toBe('judged')
    await appendFile(file, jsonl([human('second'), asst('turn two text')]))
    r.clock.now += MID_TURN_AFTER_MS + 1
    const before = r.detect.mock.calls.length
    await r.sweep.tick()
    await r.inspector.idle()
    await new Promise((res) => setTimeout(res, 2))
    const later = r.detect.mock.calls.slice(before)
    expect(later.length).toBeGreaterThan(0)
    for (const call of later) {
      expect(JSON.stringify(call)).not.toContain('TURN-ONE-QUESTION?')
      expect(JSON.stringify(call)).toContain('turn two text')
    }
  })

  it('a Stop never moves shadowOffset backward', async () => {
    const text = jsonl([human('go'), asst('Which database should I use?')])
    await writeFile(file, text)
    const end = Buffer.byteLength(text)
    await putCursor(0, T0, end + 1000)
    const r = rig()
    await r.stop()
    expect(store.state().cursors['sess-0001'].shadowOffset).toBe(end + 1000)
  })
})
