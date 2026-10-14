/* eslint-disable @typescript-eslint/no-explicit-any -- test code reads wire bodies loosely */
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HEARTBEAT_MS, ROW_DEBOUNCE_MS, ROW_MAX_WAIT_MS } from '../hooks/contract'
import { FIXTURE_SID } from './fixtures/hello'
import {
  PROBE_TURN_COMPLETE_AT,
  attachment,
  probeAfterTurn,
  probeStream,
  responseText,
  typed,
  type TraceRow
} from './fixtures/row-traces'
import { START, ackAll, defaultScript, helloOk, installRig, type Rig } from './support/rig'

/**
 * T455 W1 (spec §5.4, AC-4): the `session.row` coalescer, on the kit's held clock. A trailing
 * debounce of ROW_DEBOUNCE_MS, a maximum wait of ROW_MAX_WAIT_MS, an immediate flush at a
 * main-loop `turn.complete`, at `session.start`, after a hello and on a resync. Rows that change
 * nothing send nothing.
 */

const ROW_FEATURES = ['sense.identity', 'sense.row']

/** The rig with the row feature enabled, and the engine's own `session.append` beneath. */
function rowRig(on: On, opts: Parameters<typeof installRig>[1] = {}): Rig {
  const rig = installRig(on, {
    script: (route, body, n) =>
      route === 'hello' ? helloOk(ROW_FEATURES) : defaultScript(route, body, n),
    ...opts
  })
  mock.session(on)
  on('classic.UserPromptSubmit', async () => ({}))
  return rig
}

const rows = (rig: Rig): { seq: number; t: string; d: any }[] =>
  rig.events().filter((e) => e.t === 'session.row')

/** Lets un-awaited work (the pump, the fetch hook) run without moving the clock. */
async function drain(rig: Rig): Promise<void> {
  for (let i = 0; i < 4; i++) await rig.clock.settle()
}

const append = ($: any, r: TraceRow): Promise<unknown> => $.session.append(r)

const turnComplete = (agentId?: string): any => ({
  answer: '',
  durationMs: 5,
  isAborted: false,
  turnId: 't1',
  reason: 'answer',
  ...(agentId !== undefined ? { agentId } : {})
})

async function start($: any, rig: Rig): Promise<number> {
  await $.classic.SessionStart({
    source: 'startup',
    session_id: FIXTURE_SID,
    transcript_path: `/tmp/example-project/${FIXTURE_SID}.jsonl`
  })
  await $.session.start(START)
  await drain(rig)
  return rig.clock.now()
}

test('the probe stream: 26 rows make 4 session.row events', async ($: any, on) => {
  const rig = rowRig(on)
  const stream = probeStream()
  expect(stream.length).toBe(26)
  const t0 = rig.clock.now()
  // the first row is appended before session.start, as in the -p run
  await append($, stream[0]!.row)
  await start($, rig)
  for (const { at, row } of stream.slice(1)) {
    await rig.clock.set(t0 + at)
    await append($, row)
  }
  await rig.clock.set(t0 + PROBE_TURN_COMPLETE_AT)
  await $.turn.complete(turnComplete())
  await append($, probeAfterTurn())
  await rig.clock.advance(ROW_MAX_WAIT_MS * 2)
  await drain(rig)
  const sent = rows(rig)
  expect(sent.length).toBe(4)
  expect(sent.map((e) => [e.d.userRows, e.d.toolCalls, e.d.lastAssistant])).toEqual([
    [0, 0, null],
    [1, 0, null],
    [2, 1, null],
    [2, 1, 'Finished.']
  ])
  expect(sent.every((e) => e.d.fold === 1)).toBe(true)
})

test('one change is sent after the debounce, not before', async ($: any, on) => {
  const rig = rowRig(on)
  await start($, rig)
  const before = rows(rig).length
  await append($, typed('hello there'))
  await rig.clock.advance(ROW_DEBOUNCE_MS - 1)
  await drain(rig)
  expect(rows(rig).length).toBe(before)
  await rig.clock.advance(1)
  await drain(rig)
  expect(rows(rig).length).toBe(before + 1)
  expect(rows(rig).at(-1)!.d.lastPrompt).toBe('hello there')
})

test('the debounce trails: a burst is one event, ROW_DEBOUNCE_MS after its last change', async ($: any, on) => {
  const rig = rowRig(on)
  await start($, rig)
  const before = rows(rig).length
  await append($, typed('one'))
  await rig.clock.advance(300)
  await append($, typed('two'))
  await rig.clock.advance(300)
  await append($, typed('three'))
  await rig.clock.advance(ROW_DEBOUNCE_MS - 1)
  await drain(rig)
  expect(rows(rig).length).toBe(before)
  await rig.clock.advance(1)
  await drain(rig)
  expect(rows(rig).length).toBe(before + 1)
  expect(rows(rig).at(-1)!.d.lastPrompt).toBe('three')
})

test('a long stream is sent at most every ROW_MAX_WAIT_MS, and at most 2 events/s', async ($: any, on) => {
  const rig = rowRig(on)
  await start($, rig)
  const before = rows(rig).length
  // one changing row every 300 ms for 10 s: the debounce alone would never fire
  for (let i = 1; i <= 33; i++) {
    await append($, responseText(`step ${i}`))
    await rig.clock.advance(300)
    if (i * 300 === ROW_MAX_WAIT_MS + 100) {
      await drain(rig)
      expect(rows(rig).length).toBe(before + 1) // the max wait fired once by 2.1 s
    }
  }
  await drain(rig)
  const during = rows(rig).length - before
  expect(during).toBeGreaterThanOrEqual(4)
  expect(during).toBeLessThanOrEqual(20)
})

test('a main-loop turn.complete flushes at once; a subagent one does not', async ($: any, on) => {
  const rig = rowRig(on)
  await start($, rig)
  const before = rows(rig).length
  await append($, typed('do it'))
  await $.turn.complete(turnComplete('agent-1'))
  await drain(rig)
  expect(rows(rig).length).toBe(before)
  await $.turn.complete(turnComplete())
  await drain(rig)
  expect(rows(rig).length).toBe(before + 1)
  // the debounce that was pending sends nothing more: nothing changed since
  await rig.clock.advance(ROW_MAX_WAIT_MS)
  await drain(rig)
  expect(rows(rig).length).toBe(before + 1)
})

test('session.start sends the row at once', async ($: any, on) => {
  const rig = rowRig(on)
  await start($, rig)
  expect(rows(rig).length).toBe(1)
  expect(rows(rig)[0]!.d).toMatchObject({ fold: 1, firstPrompt: null, userRows: 0 })
})

test('rows that change nothing send nothing', async ($: any, on) => {
  const rig = rowRig(on)
  await start($, rig)
  const before = rows(rig).length
  for (let i = 0; i < 10; i++) await append($, attachment(`a${i}`))
  await rig.clock.advance(ROW_MAX_WAIT_MS * 3)
  await drain(rig)
  expect(rows(rig).length).toBe(before)
})

test('a resync re-sends the row even when nothing changed', async ($: any, on) => {
  let resyncNext = false
  const rig = rowRig(on, {
    script: (route, body, n) => {
      if (route === 'hello') return helloOk(ROW_FEATURES)
      if (route === 'events' && resyncNext) {
        resyncNext = false
        const a = ackAll(body) as any
        return { kind: 'body', body: { ...a.body, resync: true } }
      }
      return defaultScript(route, body, n)
    }
  })
  await start($, rig)
  const before = rows(rig).length
  resyncNext = true
  await rig.clock.advance(HEARTBEAT_MS) // the heartbeat's batch is answered with a resync
  await drain(rig)
  await rig.clock.advance(HEARTBEAT_MS)
  await drain(rig)
  expect(rows(rig).length).toBe(before + 1)
})

test('the payload stays under ~1.5 KB with every text at its cap', async ($: any, on) => {
  const rig = rowRig(on)
  await start($, rig)
  await $.classic.UserPromptSubmit({ session_title: 'T'.repeat(400), prompt: 'x' })
  await append($, typed('p'.repeat(400)))
  await append($, typed('q'.repeat(400)))
  await append($, responseText('r'.repeat(400)))
  await $.turn.complete(turnComplete())
  await drain(rig)
  const d = rows(rig).at(-1)!.d
  expect(d.firstPrompt.length).toBe(240)
  expect(d.lastPrompt.length).toBe(240)
  expect(d.lastAssistant.length).toBe(240)
  expect(d.title.length).toBe(240)
  expect(JSON.stringify(d).length).toBeLessThanOrEqual(1536)
})

test('nothing is sent while the host has not enabled sense.row', async ($: any, on) => {
  const rig = rowRig(on, {
    script: (route, body, n) =>
      route === 'hello' ? helloOk(['sense.identity']) : defaultScript(route, body, n)
  })
  await start($, rig)
  await append($, typed('hello'))
  await $.turn.complete(turnComplete())
  await rig.clock.advance(ROW_MAX_WAIT_MS)
  await drain(rig)
  expect(rows(rig).length).toBe(0)
})
