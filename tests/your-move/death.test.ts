import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HookTaskEvent } from '../../src/main/detect/task-state-hub'
import type { PtyExitFact } from '../../src/main/pty'
import type { CardLane, YourMoveMode } from '../../src/main/your-move/core'
import { createInspector, type InspectRequest } from '../../src/main/your-move/inspector'
import type { EnrichOutcome } from '../../src/main/your-move/judge'
import { openYourMoveStore, type YourMoveStore } from '../../src/main/your-move/store'
import type { ReadResult } from '../../src/main/your-move/transcript'
import {
  CTRL_C_GRACE_MS,
  createSystemCards,
  deathDraft,
  failureDraft,
  isDeathExit,
  type SystemCardDeps
} from '../../src/main/your-move/triggers'

let dir: string
let store: YourMoveStore
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-death-'))
  store = await openYourMoveStore(path.join(dir, 'your-move.json'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const NOW = 1_000_000

function make(over: Partial<SystemCardDeps> = {}) {
  let n = 0
  const mode = { value: 'observe' as YourMoveMode }
  const lane = { value: 'observe' as CardLane }
  const deps: SystemCardDeps = {
    store,
    mode: () => mode.value,
    lane: () => lane.value,
    eligible: async () => true,
    locate: async () => '/located/x.jsonl',
    resolveFolder: async (_id, cwd) => cwd ?? '/work/located',
    read: async () => ({ lines: [], nextOffset: 0, size: 0, shrunk: false }),
    classify: () => null,
    mintId: () => `card-${++n}`,
    now: () => NOW,
    ...over
  }
  return { cards: createSystemCards(deps), mode, lane }
}

const stopFailure = (
  sessionId = 'sess-0001',
  reason: HookTaskEvent['failureReason'] = 'rate_limit'
) =>
  ({
    sessionId,
    taskState: 'failed',
    event: 'StopFailure',
    ts: 1,
    failureReason: reason,
    source: 'hook',
    payload: { cwd: '/work/acme', transcriptPath: `/t/${sessionId}.jsonl` }
  }) as HookTaskEvent
const userPrompt = (sessionId = 'sess-0001') =>
  ({
    sessionId,
    taskState: 'working',
    event: 'UserPromptSubmit',
    ts: 0,
    source: 'hook',
    payload: { cwd: '/work/acme' }
  }) as HookTaskEvent
const stop = (sessionId = 'sess-0001') =>
  ({
    sessionId,
    taskState: 'idle',
    event: 'Stop',
    ts: 2,
    source: 'hook',
    payload: { cwd: '/work/acme' }
  }) as HookTaskEvent

const exitFact = (over: Partial<PtyExitFact> = {}): PtyExitFact => ({
  sessionKey: 'sess-0001',
  reason: 'natural',
  removedFirst: false,
  taskState: 'working',
  cwd: '/work/acme',
  now: NOW,
  ...over
})

const open = (source?: string) =>
  store.state().cards.filter((c) => c.closedAt === undefined && (!source || c.source === source))

describe('death cards', () => {
  it('StopFailure files one death card per session', async () => {
    const { cards } = make()
    cards.onTaskEvent(stopFailure('sess-0001'))
    cards.onTaskEvent(stopFailure('sess-0001'))
    cards.onTaskEvent(stopFailure('sess-0002', 'overloaded'))
    await cards.idle()
    const death = open('death')
    expect(death).toHaveLength(2)
    expect(death.map((c) => c.sourceKey).sort()).toEqual(['death:sess-0001', 'death:sess-0002'])
    expect(death[0]).toMatchObject({
      kind: 'do',
      source: 'death',
      folder: '/work/acme',
      lane: 'observe',
      askKey: { key: 'yourMove.system.stopped' }
    })
    expect(death[0].ask).toMatch(/^Session stopped: /)
    expect(death[0].ask).toContain('rate limit')
    // a second event for the same session kept the original clock
    expect(death[0].openedAt).toBe(NOW)
  })

  it('a natural exit while working counts', async () => {
    expect(isDeathExit(exitFact())).toBe(true)
    const { cards } = make()
    cards.onPtyExit(exitFact())
    await cards.idle()
    expect(open('death')).toHaveLength(1)
  })

  it('a session that was waiting on the operator and then died counts too', () => {
    expect(isDeathExit(exitFact({ taskState: 'needs-input' }))).toBe(true)
  })

  it('an exit of a session whose state is unknown counts: it cannot be shown to be idle', () => {
    expect(isDeathExit(exitFact({ taskState: undefined }))).toBe(true)
  })

  it.each([
    ['Harnu quit or operator close', { removedFirst: true }],
    ['hibernation', { reason: 'park' as const }],
    ['Ctrl+C', { lastCtrlCAt: NOW - 1_000 }],
    ['exit while idle', { taskState: 'idle' as const }]
  ])('%s does not count', async (_name, over) => {
    expect(isDeathExit(exitFact(over))).toBe(false)
    const { cards } = make()
    cards.onPtyExit(exitFact(over))
    await cards.idle()
    expect(open()).toHaveLength(0)
  })

  it('a Ctrl+C older than the grace window does not excuse an exit', () => {
    expect(isDeathExit(exitFact({ lastCtrlCAt: NOW - CTRL_C_GRACE_MS - 1 }))).toBe(true)
  })

  it('a later Stop closes the death card as source-resolved', async () => {
    const { cards } = make()
    cards.onTaskEvent(stopFailure())
    await cards.idle()
    expect(open('death')).toHaveLength(1)
    cards.onTaskEvent(stop())
    await cards.idle()
    expect(open('death')).toHaveLength(0)
    expect(store.state().cards[0]).toMatchObject({ closedBy: 'source-resolved' })
  })

  it('a Stop of another session leaves the card alone', async () => {
    const { cards } = make()
    cards.onTaskEvent(stopFailure('sess-0001'))
    cards.onTaskEvent(stop('sess-0002'))
    await cards.idle()
    expect(open('death')).toHaveLength(1)
  })

  it('a subagent Stop closes nothing', async () => {
    const { cards } = make()
    cards.onTaskEvent(stopFailure())
    cards.onTaskEvent({ ...stop(), agentId: 'agent-1' })
    await cards.idle()
    expect(open('death')).toHaveLength(1)
  })

  it('the draft shapes are fixed', () => {
    expect(
      deathDraft({ sessionId: 's', folder: '/f', failureReason: 'billing_error', lane: 'live' })
    ).toMatchObject({
      kind: 'do',
      source: 'death',
      sourceKey: 'death:s',
      lane: 'live',
      askKey: { key: 'yourMove.system.stopped' },
      ask: 'Session stopped: billing error'
    })
    expect(
      failureDraft({ sessionId: 's', folder: '/f', reason: 'timeout', lane: 'live' })
    ).toMatchObject({
      kind: 'do',
      source: 'judge-failure',
      sourceKey: 'judge-failure:s',
      askKey: { key: 'yourMove.system.couldNotCheck' }
    })
  })

  it('files nothing when Your move is Off, or the folder is blocked, archived or switched off', async () => {
    const off = make()
    off.mode.value = 'off'
    off.cards.onTaskEvent(stopFailure())
    off.cards.onPtyExit(exitFact())
    off.cards.onInspectFailure(req(), 'boom')
    await off.cards.idle()
    const blocked = make({ eligible: async () => false })
    blocked.cards.onTaskEvent(stopFailure())
    blocked.cards.onPtyExit(exitFact())
    blocked.cards.onInspectFailure(req(), 'boom')
    await blocked.cards.idle()
    expect(open()).toHaveLength(0)
  })

  it('a death with no resolvable folder is logged, never filed silently under nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { cards } = make({ resolveFolder: async () => null })
    cards.onPtyExit(exitFact({ cwd: undefined }))
    await cards.idle()
    expect(open('death')).toHaveLength(0)
    expect(error.mock.calls.flat().join(' ')).toContain('sess-0001')
    error.mockRestore()
  })

  it('a death takes the folder an earlier hook reported when the exit carries none', async () => {
    const { cards } = make({ resolveFolder: async () => null, locate: async () => null })
    cards.onTaskEvent({ ...userPrompt(), payload: { cwd: '/work/from-hook' } })
    cards.onPtyExit(exitFact({ cwd: undefined }))
    await cards.idle()
    expect(open('death')[0]).toMatchObject({ folder: '/work/from-hook' })
  })

  it('a death takes the PTY folder when no hook ever named one', async () => {
    const { cards } = make({ resolveFolder: async () => null, locate: async () => null })
    cards.onPtyExit(exitFact({ cwd: '/work/from-pty' }))
    await cards.idle()
    expect(open('death')[0]).toMatchObject({ folder: '/work/from-pty' })
  })

  it('a graceful shutdown mid-turn files a death card even after SessionEnd folds the state', async () => {
    const { cards } = make()
    cards.onTaskEvent(userPrompt())
    // SessionEnd folds working to completed before the PTY exits
    cards.onTaskEvent({
      ...userPrompt(),
      taskState: 'completed',
      event: 'SessionEnd',
      matcher: 'other'
    } as never)
    cards.onPtyExit(exitFact({ taskState: 'completed' }))
    await cards.idle()
    expect(open('death')).toHaveLength(1)
  })

  it('an exit after a Stop still does not count, whatever SessionEnd did', async () => {
    const { cards } = make()
    cards.onTaskEvent(userPrompt())
    cards.onTaskEvent(stop())
    cards.onTaskEvent({ ...stop(), taskState: 'completed', event: 'SessionEnd' } as never)
    cards.onPtyExit(exitFact({ taskState: 'completed' }))
    await cards.idle()
    expect(open()).toHaveLength(0)
  })

  it('a turn that ended in StopFailure is not an open turn', async () => {
    const { cards } = make()
    cards.onTaskEvent(userPrompt())
    cards.onTaskEvent(stopFailure())
    cards.onPtyExit(exitFact({ taskState: 'failed' }))
    await cards.idle()
    expect(open('death')).toHaveLength(1)
    cards.onTaskEvent(userPrompt())
    cards.onTaskEvent(stop())
    cards.onPtyExit(exitFact({ taskState: 'completed' }))
    await cards.idle()
    expect(open()).toHaveLength(0)
  })

  it('a subagent prompt or Stop does not change whether the main turn is open', async () => {
    const { cards } = make()
    cards.onTaskEvent(userPrompt())
    cards.onTaskEvent({ ...stop(), agentId: 'agent-1' })
    cards.onPtyExit(exitFact({ taskState: 'completed' }))
    await cards.idle()
    expect(open('death')).toHaveLength(1)
  })

  it('Harnu quit, parking and a recent Ctrl+C still excuse an open turn', async () => {
    for (const over of [
      { removedFirst: true },
      { reason: 'park' as const },
      { lastCtrlCAt: NOW - 1_000 }
    ]) {
      const { cards } = make()
      cards.onTaskEvent(userPrompt())
      cards.onPtyExit(exitFact({ taskState: 'completed', ...over }))
      await cards.idle()
    }
    expect(open()).toHaveLength(0)
  })

  it('a StopFailure from a programmatic transcript files nothing', async () => {
    const { cards } = make({
      read: async () => ({
        lines: [{ type: 'assistant', entrypoint: 'sdk-cli' }],
        nextOffset: 10,
        size: 10,
        shrunk: false
      }),
      classify: (lines) =>
        (lines[0] as { entrypoint?: string })?.entrypoint === 'sdk-cli' ? 'programmatic' : null
    })
    cards.onTaskEvent(stopFailure())
    await cards.idle()
    expect(store.state().cards).toEqual([])
  })

  it('a StopFailure whose transcript cannot be read still files the card', async () => {
    const { cards } = make({
      read: async () => {
        throw new Error('EIO')
      }
    })
    cards.onTaskEvent(stopFailure())
    await cards.idle()
    expect(open('death')).toHaveLength(1)
  })
})

const req = (over: Partial<InspectRequest> = {}): InspectRequest => ({
  sessionId: 'sess-0001',
  folder: '/work/acme',
  transcriptPath: '/t/sess-0001.jsonl',
  trigger: 'stop',
  ...over
})

describe('judge-failure cards', () => {
  it('judge failure opens one card per streak, not one per attempt', async () => {
    const { cards } = make()
    for (let i = 0; i < 4; i++) cards.onInspectFailure(req(), `attempt ${i}`)
    await cards.idle()
    const failures = open('judge-failure')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      kind: 'do',
      sourceKey: 'judge-failure:sess-0001',
      askKey: { key: 'yourMove.system.couldNotCheck' }
    })
    expect(failures[0].openedAt).toBe(NOW)
  })

  it('a success closes the failure card; a later failure opens a new one', async () => {
    const { cards } = make()
    cards.onInspectFailure(req(), 'first')
    await cards.idle()
    cards.onInspectSuccess(req())
    await cards.idle()
    expect(open('judge-failure')).toHaveLength(0)
    expect(store.state().cards[0]).toMatchObject({ closedBy: 'source-resolved' })
    cards.onInspectFailure(req(), 'second')
    await cards.idle()
    expect(open('judge-failure')).toHaveLength(1)
    expect(store.state().cards).toHaveLength(2)
  })

  it('only a Stop failure files a card; mid-turn and manual runs do not', async () => {
    const { cards } = make()
    cards.onInspectFailure(req({ trigger: 'mid-turn' }), 'x')
    cards.onInspectFailure(req({ trigger: 'manual' }), 'x')
    await cards.idle()
    expect(open()).toHaveLength(0)
  })

  it('a mid-turn success does not close a card a Stop failure opened', async () => {
    const { cards } = make()
    cards.onInspectFailure(req(), 'x')
    await cards.idle()
    cards.onInspectSuccess(req({ trigger: 'mid-turn' }))
    await cards.idle()
    expect(open('judge-failure')).toHaveLength(1)
  })

  it('the card carries the lane the inspection ran in', async () => {
    const { cards, lane } = make()
    lane.value = 'live'
    cards.onInspectFailure(req(), 'x')
    await cards.idle()
    expect(open('judge-failure')[0].lane).toBe('live')
  })
})

describe('a failure wave', () => {
  const asst = (text: string) => ({
    type: 'assistant',
    entrypoint: 'cli',
    message: { content: [{ type: 'text', text }] }
  })

  function waveInspector(sys: ReturnType<typeof createSystemCards>) {
    const detect = vi.fn(async () => ({ ok: false as const, reason: 'auth: not logged in' }))
    const enrich = vi.fn(async (): Promise<EnrichOutcome> => ({
      ok: false,
      reason: 'enrichment off'
    }))
    const read = vi.fn(async (): Promise<ReadResult> => ({
      lines: [asst('Should I continue?')],
      nextOffset: 500,
      size: 500,
      shrunk: false
    }))
    const timers = vi.fn()
    const inspector = createInspector({
      store,
      read: read as never,
      detect,
      enrich,
      now: () => NOW,
      mintId: () => 'x',
      isBlocked: () => false,
      isArchived: () => false,
      isFolderOff: () => false,
      mode: () => 'observe',
      midTurnLive: () => false,
      classify: () => 'interactive',
      onFailure: (r, why) => sys.onInspectFailure(r, why),
      onSuccess: (r) => sys.onInspectSuccess(r)
    })
    return { inspector, detect, timers }
  }

  it('a 30-session failure wave leaves 30 cards and cursors unmoved', async () => {
    const { cards } = make()
    const { inspector } = waveInspector(cards)
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        inspector.request(req({ sessionId: `sess-${String(i).padStart(4, '0')}` }))
      )
    )
    await inspector.idle()
    await cards.idle()
    expect(open('judge-failure')).toHaveLength(30)
    expect(store.state().cursors).toEqual({})
  })

  it('failed inspections retry only on the next trigger, never in a loop', async () => {
    const { cards } = make()
    const { inspector, detect } = waveInspector(cards)
    expect(await inspector.request(req())).toBe('failed')
    await cards.idle()
    const calls = detect.mock.calls.length
    await new Promise((r) => setTimeout(r, 60))
    expect(detect.mock.calls.length).toBe(calls)
    // the next trigger tries again, and the streak still has one card
    expect(await inspector.request(req())).toBe('failed')
    await cards.idle()
    expect(detect.mock.calls.length).toBeGreaterThan(calls)
    expect(open('judge-failure')).toHaveLength(1)
  })
})
