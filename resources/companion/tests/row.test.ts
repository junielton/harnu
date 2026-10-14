/* eslint-disable @typescript-eslint/no-explicit-any -- test code reads wire bodies loosely */
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HEARTBEAT_MS, ROW_DEBOUNCE_MS, ROW_MAX_WAIT_MS } from '../hooks/contract'
import { FIXTURE_CONN, FIXTURE_SID } from './fixtures/hello'
import {
  PROBE_TURN_COMPLETE_AT,
  attachment,
  clearCommandRows,
  hookContext,
  probeAfterTurn,
  probeStream,
  responseText,
  typed,
  type TraceRow
} from './fixtures/row-traces'
import {
  BOOT,
  CONN_2,
  START,
  ackAll,
  defaultScript,
  helloOk,
  installRig,
  type Rig
} from './support/rig'

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

// ---- AC-5: the wire (spec §5.3) ----------------------------------------------------------------

const PATH = `/tmp/example-project/${FIXTURE_SID}.jsonl`
const snapshots = (rig: Rig): { d: any }[] => rig.events().filter((e) => e.t === 'session.snapshot')

test('the hello declares sense.row; the hello snapshot carries the start facts', async ($: any, on) => {
  const rig = rowRig(on)
  await start($, rig)
  const hello = rig.of('hello')[0]!.body
  expect(hello.declared).toContain('sense.row')
  expect(hello.declared.at(-1)).toBe('sense.mods')
  expect(snapshots(rig)[0]!.d.start).toEqual({ source: 'startup', transcriptPath: PATH })
})

test('M8: a classic.SessionStart still running at session.start: the hello carries its start', async ($: any, on) => {
  const rig = rowRig(on)
  // the engine dispatches session.start before the classic handler passes its first await
  const classic = $.classic.SessionStart({
    source: 'fork',
    session_id: FIXTURE_SID,
    transcript_path: PATH
  })
  await $.session.start(START)
  await classic
  await drain(rig)
  expect(snapshots(rig)[0]!.d.start).toEqual({ source: 'fork', transcriptPath: PATH })
})

test('M8: a hello that went out first is followed by a probe snapshot with the start', async ($: any, on) => {
  const rig = rowRig(on)
  await $.session.start(START)
  await drain(rig)
  expect(snapshots(rig).every((s) => s.d.start === undefined)).toBe(true)
  await $.classic.SessionStart({ source: 'resume', session_id: FIXTURE_SID, transcript_path: PATH })
  await drain(rig)
  const last = snapshots(rig).at(-1)!.d
  expect(last.reason).toBe('probe')
  expect(last.start).toEqual({ source: 'resume', transcriptPath: PATH })
})

test('a path over 4,096 chars is never sent', async ($: any, on) => {
  const rig = rowRig(on)
  await $.classic.SessionStart({
    source: 'startup',
    session_id: FIXTURE_SID,
    transcript_path: `/${'p'.repeat(4_096)}.jsonl`
  })
  await $.session.start(START)
  await drain(rig)
  expect(snapshots(rig)[0]!.d).not.toHaveProperty('start')
})

test('a /clear: the rebound names the new file and a fresh fold starts under the new id', async ($: any, on) => {
  const NEW = '22222222-2222-4222-8222-222222222222'
  const NEW_PATH = `/tmp/example-project/${NEW}.jsonl`
  const rig = rowRig(on)
  await start($, rig)
  await append($, typed('before the clear'))
  await $.turn.complete(turnComplete())
  await drain(rig)
  await $.session.end({
    reason: 'clear',
    sessionId: FIXTURE_SID,
    resume: { sessionId: FIXTURE_SID }
  })
  // W0 §2.1: the /clear command rows are appended before the new conversation's classic hook
  for (const r of clearCommandRows()) await append($, r)
  rig.sid.value = NEW
  await $.classic.SessionStart({ source: 'clear', session_id: NEW, transcript_path: NEW_PATH })
  await append($, hookContext('hook_success'))
  await drain(rig)
  const rebound = rig.events().find((e) => e.t === 'session.rebound')!
  expect(rebound.d).toEqual({
    prevSid: FIXTURE_SID,
    sid: NEW,
    cause: 'clear',
    transcriptPath: NEW_PATH
  })
  const after = rig.events().filter((e) => e.seq > rebound.seq && e.t === 'session.row')
  expect(after.length).toBe(1)
  expect(after[0]!.d).toMatchObject({
    firstPrompt: '/clear',
    lastPrompt: null,
    userRows: 3,
    toolCalls: 0
  })
  // the envelope of everything after the rebound names the new conversation
  const lastEvents = rig.of('events').at(-1)!.body
  expect(lastEvents.sid).toBe(NEW)
})

test('the title is the latest session_title of a classic hook (recorded only)', async ($: any, on) => {
  const rig = rowRig(on)
  await start($, rig)
  await $.classic.UserPromptSubmit({ prompt: 'x', session_title: 'a custom title' })
  await $.turn.complete(turnComplete())
  await drain(rig)
  expect(rows(rig).at(-1)!.d.title).toBe('a custom title')
})

// ---- AC-6: no text at rest (spec §5.5 rule 1) ----------------------------------------------------

test('a reload keeps the counts, never stores text', async ($: any, on) => {
  const saved = {
    sid: FIXTURE_SID,
    counts: { toolCalls: 7, subagentToolCalls: 1, userRows: 4, lastRowAt: 5, lastUuid: 'u9' }
  }
  const rig = rowRig(on, {
    savedState: { conn: FIXTURE_CONN, bootId: BOOT, sid: FIXTURE_SID, boot: START, row: saved },
    script: (route, body, n) =>
      route === 'hello' ? helloOk(ROW_FEATURES, CONN_2) : defaultScript(route, body, n)
  })
  // a reload: register runs again and session.start fires again, with no classic.SessionStart
  await $.session.start(START)
  await drain(rig)
  const first = rows(rig)[0]!.d
  expect(first).toMatchObject({ toolCalls: 7, subagentToolCalls: 1, userRows: 4, lastUuid: 'u9' })
  for (const k of ['firstPrompt', 'lastPrompt', 'lastAssistant', 'title'])
    expect(first).not.toHaveProperty(k) // absent: unknown, the host keeps what it had
  await append($, typed('secret-looking prompt'))
  await append($, responseText('secret-looking answer'))
  await $.turn.complete(turnComplete())
  await drain(rig)
  expect(rows(rig).at(-1)!.d).toMatchObject({
    lastPrompt: 'secret-looking prompt',
    lastAssistant: 'secret-looking answer',
    userRows: 5
  })
  expect(rows(rig).at(-1)!.d).not.toHaveProperty('firstPrompt')
  const kept = rig.state.get('row') as any
  expect(kept).toEqual({
    sid: FIXTURE_SID,
    counts: {
      toolCalls: 7,
      subagentToolCalls: 1,
      userRows: 5,
      lastRowAt: expect.any(Number),
      lastUuid: expect.any(String)
    }
  })
  const all = JSON.stringify([...rig.state.entries()])
  expect(all).not.toContain('secret-looking')
})

test('a resume starts empty: its history is the host baseline, never restored', async ($: any, on) => {
  const saved = {
    sid: FIXTURE_SID,
    counts: { toolCalls: 7, subagentToolCalls: 0, userRows: 4, lastRowAt: 5, lastUuid: 'u9' }
  }
  const rig = rowRig(on, { savedState: { row: saved } })
  await $.classic.SessionStart({ source: 'resume', session_id: FIXTURE_SID, transcript_path: PATH })
  await $.session.start(START)
  await drain(rig)
  expect(rows(rig)[0]!.d).toMatchObject({
    firstPrompt: null,
    lastPrompt: null,
    userRows: 0,
    toolCalls: 0,
    lastUuid: null
  })
})

// ---- AC-3 / AC-7: fail open (spec §10.2) ---------------------------------------------------------

test('the step folds the row as stored, after the hooks beneath rewrote it', async ($: any, on) => {
  const rig = installRig(on, {
    script: (route, body, n) =>
      route === 'hello' ? helloOk(ROW_FEATURES) : defaultScript(route, body, n)
  })
  on('classic.UserPromptSubmit', async () => ({}))
  // a rewriting plugin beneath (T450's scrubber): the step must fold the RESULT of next(e)
  on('session.append', async (_$: any, e: any, next: any) =>
    next({
      ...e,
      message: { ...e.message, content: [{ type: 'text', text: 'scrubbed by the store' }] }
    })
  )
  await start($, rig)
  await append($, typed('raw text the store rewrote'))
  await $.turn.complete(turnComplete())
  await drain(rig)
  expect(rows(rig).at(-1)!.d.lastPrompt).toBe('scrubbed by the store')
})

test('outside Harnu (dormant) nothing is folded or sent', async ($: any, on) => {
  const rig = rowRig(on, { token: false })
  await $.session.start({ ...START, isInteractive: false })
  await append($, typed('hello'))
  await rig.clock.advance(ROW_MAX_WAIT_MS)
  await drain(rig)
  expect(rig.sent).toEqual([])
  expect(rig.state.has('row')).toBe(false)
})

// ---- round 2, D6 -----------------------------------------------------------------------------------

test('a classic.SessionStart with an invalid path clears the earlier start facts', async ($: any, on) => {
  const rig = rowRig(on)
  await $.classic.SessionStart({
    source: 'startup',
    session_id: FIXTURE_SID,
    transcript_path: PATH
  })
  await $.classic.SessionStart({
    source: 'compact',
    session_id: FIXTURE_SID,
    transcript_path: `/${'p'.repeat(4_096)}.jsonl`
  })
  await $.session.start(START)
  await drain(rig)
  expect(snapshots(rig)[0]!.d).not.toHaveProperty('start')
})

test('rows folded after a reload but before its session.start add to the restored counts', async ($: any, on) => {
  const saved = {
    sid: FIXTURE_SID,
    counts: { toolCalls: 2, subagentToolCalls: 0, userRows: 4, lastRowAt: 5, lastUuid: 'u9' }
  }
  const rig = rowRig(on, {
    savedState: { conn: FIXTURE_CONN, bootId: BOOT, sid: FIXTURE_SID, boot: START, row: saved },
    script: (route, body, n) =>
      route === 'hello' ? helloOk(ROW_FEATURES, CONN_2) : defaultScript(route, body, n)
  })
  await append($, typed('typed during the reload'))
  await $.session.start(START)
  await drain(rig)
  const d = rows(rig)[0]!.d
  expect(d).toMatchObject({ userRows: 5, toolCalls: 2, lastPrompt: 'typed during the reload' })
  expect(d).not.toHaveProperty('firstPrompt')
})
