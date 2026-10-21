/**
 * T257 U2a-i — the delivery tracker (§9) and the band driver (§8), driven by a fake host bus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandOutcome } from '../../src/main/companion/command-types'
import type { WireEvent } from '../../src/main/companion/contract'
import type {
  BandSelection,
  SelectionStateEvent
} from '../../src/main/companion/review-selection-core'
import {
  createBandDriver,
  createSelectionTracker,
  createSidFollower,
  type BandSender,
  type SelectionTracker
} from '../../src/main/companion/review-selection-tracker'
import type { BindingView } from '../../src/main/companion/session-table'

type Listener = (...a: never[]) => void

function fakeHost() {
  const handlers = new Map<string, Set<Listener>>()
  return {
    bus: {
      on(type: string, fn: Listener) {
        if (!handlers.has(type)) handlers.set(type, new Set())
        handlers.get(type)!.add(fn)
        return () => void handlers.get(type)!.delete(fn)
      }
    } as never,
    fire(type: string, ...args: unknown[]) {
      for (const fn of [...(handlers.get(type) ?? [])]) (fn as (...a: unknown[]) => void)(...args)
    },
    listeners: (type: string) => handlers.get(type)?.size ?? 0
  }
}

const binding = (over: Partial<BindingView> = {}): BindingView =>
  ({
    key: 7,
    owner: { kind: 'pty', ptyId: 'pty-9' },
    trust: 'read-only',
    sid: 'sid-1',
    sessionKey: null,
    cwd: '/work/example-web',
    profile: 'interactive',
    cliVersion: '2.1.290',
    modVersion: '0.1.0',
    declared: [],
    enabled: ['act.channel', 'act.context', 'ui.band', 'sense.turn'],
    proven: [],
    lease: 'live',
    state: 'bound',
    helloAfterSpawnMs: 0,
    ...over
  }) as BindingView

let seq = 0
const ev = (t: WireEvent['t'], d: Record<string, unknown>, turnId?: string): WireEvent =>
  ({ seq: ++seq, t, ts: 1, ...(turnId ? { turnId } : {}), d }) as WireEvent

const SEL = {
  subjectType: 'LINE',
  path: 'src/main/speech.ts',
  line: 92,
  side: 'RIGHT',
  startLine: 85,
  startSide: 'RIGHT'
} as const

function rig() {
  const host = fakeHost()
  const events: SelectionStateEvent[] = []
  const tracker = createSelectionTracker({
    host,
    emit: (e) => void events.push(e),
    now: () => 1_000
  })
  const states = (): string[] => events.map((e) => e.state)
  let n = 0
  const track = (
    outcome?: Promise<CommandOutcome>,
    key = 7,
    selection: BandSelection | null = SEL
  ) => {
    const id = `sel_${++n}`
    let resolve!: (o: CommandOutcome) => void
    const settled = outcome ?? new Promise<CommandOutcome>((r) => (resolve = r))
    tracker.track({
      selectionId: id,
      bindingKey: key,
      sid: 'sid-1',
      cmd: `cmd_${n}`,
      settled,
      selection
    })
    return { id, cmd: `cmd_${n}`, resolve }
  }
  const ok = (cmd: string) => host.fire('event', binding(), ev('command.result', { cmd, ok: true }))
  const turnStarted = (origin: string, turnId: string, b = binding()) =>
    host.fire('event', b, ev('turn.started', { origin }, turnId))
  const turnDone = (turnId: string, reason: string, b = binding()) =>
    host.fire('event', b, ev('turn.completed', { reason, isAborted: false, durationMs: 1 }, turnId))
  return { host, tracker, events, states, track, ok, turnStarted, turnDone }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('U2a-i-AC-12 — the tracker emits review:selection:state per §9.2', () => {
  it('queued → delivered → asked → answered', () => {
    const r = rig()
    const t = r.track()
    expect(r.states()).toEqual(['queued'])
    r.ok(t.cmd)
    r.turnStarted('human', 'turn-1')
    r.turnDone('turn-1', 'answer')
    expect(r.states()).toEqual(['queued', 'delivered', 'asked', 'answered'])
    expect(r.events.every((e) => e.selectionId === t.id)).toBe(true)
  })

  it('delivered comes only from a result with ok:true, never from the settled promise alone being something else', async () => {
    const r = rig()
    const t = r.track(Promise.resolve({ state: 'resulted', ok: true }))
    await flush()
    expect(r.states()).toEqual(['queued', 'delivered'])
    // a second ok for the same cmd moves nothing
    r.ok(t.cmd)
    expect(r.states()).toEqual(['queued', 'delivered'])
  })

  it('a result for another cmd, or ok:false, is not a delivery', () => {
    const r = rig()
    r.track()
    r.ok('cmd_other')
    r.host.fire('event', binding(), ev('command.result', { cmd: 'cmd_1', ok: false }))
    expect(r.states()).toEqual(['queued'])
  })

  it('origin other than human never advances', () => {
    const r = rig()
    const t = r.track()
    r.ok(t.cmd)
    for (const origin of ['peer', 'plugin', 'unknown']) r.turnStarted(origin, `t-${origin}`)
    expect(r.states()).toEqual(['queued', 'delivered'])
    // a human turn after those still counts
    r.turnStarted('human', 'turn-h')
    expect(r.states()).toEqual(['queued', 'delivered', 'asked'])
  })

  it('a turn that started before delivered never counts', () => {
    const r = rig()
    const t = r.track()
    r.turnStarted('human', 'early') // before the result
    r.ok(t.cmd)
    r.turnDone('early', 'answer') // its completion is not ours either
    expect(r.states()).toEqual(['queued', 'delivered'])
  })

  it('a turn completion for another turn does not answer', () => {
    const r = rig()
    const t = r.track()
    r.ok(t.cmd)
    r.turnStarted('human', 'turn-1')
    r.turnDone('turn-other', 'answer')
    expect(r.states()).toEqual(['queued', 'delivered', 'asked'])
    r.turnDone('turn-1', 'answer')
    expect(r.states().at(-1)).toBe('answered')
  })

  it('aborted, refusal and error are three distinct states', () => {
    const outcomes = { aborted: 'turn-stopped', refusal: 'turn-declined', error: 'turn-failed' }
    const seen = new Set<string>()
    for (const [reason, state] of Object.entries(outcomes)) {
      const r = rig()
      const t = r.track()
      r.ok(t.cmd)
      r.turnStarted('human', 'turn-1')
      r.turnDone('turn-1', reason)
      expect(r.states().at(-1)).toBe(state)
      seen.add(state)
    }
    expect(seen.size).toBe(3)
  })

  it('session.rebound of every cause gives cleared, after delivered', () => {
    for (const cause of ['clear', 'resume', 'unknown']) {
      const r = rig()
      const t = r.track()
      r.ok(t.cmd)
      r.host.fire(
        'event',
        binding(),
        ev('session.rebound', { prevSid: 'sid-1', sid: 'sid-2', cause })
      )
      expect(r.states(), cause).toEqual(['queued', 'delivered', 'cleared'])
    }
  })

  it('a rebound while still queued is not "cleared": the queue drop speaks for it', async () => {
    const r = rig()
    const t = r.track()
    r.host.fire(
      'event',
      binding(),
      ev('session.rebound', { prevSid: 'a', sid: 'b', cause: 'clear' })
    )
    expect(r.states()).toEqual(['queued'])
    t.resolve({ state: 'dropped', why: 'rebound', delivered: false })
    await flush()
    expect(r.events.at(-1)).toMatchObject({ state: 'not-delivered', code: 'dropped-rebound' })
  })

  it('the binding ending gives ended, after delivered or asked', () => {
    for (const asked of [false, true]) {
      const r = rig()
      const t = r.track()
      r.ok(t.cmd)
      if (asked) r.turnStarted('human', 'turn-1')
      r.host.fire('end', binding({ state: 'ended' }), 'bye')
      expect(r.states().at(-1)).toBe('ended')
    }
  })

  it('with no sense.turn it stops at delivered and infers nothing', () => {
    const r = rig()
    const t = r.track()
    const noTurn = binding({ enabled: ['act.channel', 'act.context'] })
    r.host.fire('event', noTurn, ev('command.result', { cmd: t.cmd, ok: true }))
    r.turnStarted('human', 'turn-1', noTurn)
    r.turnDone('turn-1', 'answer', noTurn)
    expect(r.states()).toEqual(['queued', 'delivered'])
  })

  it('every non-delivery is not-delivered with its code and its next steps', async () => {
    const cases: Array<[CommandOutcome, string]> = [
      [{ state: 'resulted', ok: false, code: 'CMD_PRECONDITION' }, 'CMD_PRECONDITION'],
      [{ state: 'expired' }, 'expired'],
      [{ state: 'lost' }, 'lost'],
      [{ state: 'dropped', why: 'lease-lost', delivered: false }, 'dropped-lease-lost']
    ]
    for (const [outcome, code] of cases) {
      const r = rig()
      r.track(Promise.resolve(outcome))
      await flush()
      expect(r.events.at(-1)).toMatchObject({ state: 'not-delivered', code })
      expect(Array.isArray(r.events.at(-1)!.next)).toBe(true)
      expect(r.states()).not.toContain('delivered')
    }
  })

  it('an unconfirmed send is never shown as sent', async () => {
    const r = rig()
    r.track(Promise.resolve({ state: 'lost' }))
    await flush()
    expect(r.states()).not.toContain('delivered')
  })

  it('a newer selection on the same binding replaces the older one', () => {
    const r = rig()
    const a = r.track()
    const b = r.track()
    r.ok(a.cmd) // the old row's result no longer moves anything
    expect(r.events.filter((e) => e.selectionId === a.id).map((e) => e.state)).toEqual(['queued'])
    r.ok(b.cmd)
    expect(r.events.at(-1)).toMatchObject({ selectionId: b.id, state: 'delivered' })
  })

  it('a replaced selection whose settled resolves after the newer one was delivered moves nothing', async () => {
    const r = rig()
    const a = r.track()
    const b = r.track()
    r.ok(b.cmd)
    a.resolve({ state: 'resulted', ok: true }) // A's late success
    await flush()
    expect(r.events.map((e) => `${e.selectionId}:${e.state}`)).toEqual([
      `${a.id}:queued`,
      `${b.id}:queued`,
      `${b.id}:delivered`
    ])
    expect(r.tracker.current(7)?.selectionId).toBe(b.id)
  })

  it('a replaced selection’s late failure is ignored too, and cannot end the live one', async () => {
    const r = rig()
    const a = r.track()
    const b = r.track()
    a.resolve({ state: 'dropped', why: 'rebound', delivered: false })
    await flush()
    expect(r.events.map((e) => e.state)).toEqual(['queued', 'queued'])
    r.ok(b.cmd)
    expect(r.events.at(-1)).toMatchObject({ selectionId: b.id, state: 'delivered' })
  })

  it('a settled that rejects lands in not-delivered, not stuck on queued', async () => {
    const r = rig()
    const t = r.track(Promise.reject(new Error('channel exploded')))
    await flush()
    expect(r.events.at(-1)).toMatchObject({
      selectionId: t.id,
      state: 'not-delivered',
      code: 'CMD_FAILED',
      next: ['try-again', 'copy']
    })
    expect(JSON.stringify(r.events)).not.toContain('exploded')
    expect(r.tracker.current(7)).toBeNull()
  })

  it('a rejected settled of a replaced selection is ignored', async () => {
    const r = rig()
    let reject!: (e: Error) => void
    const a = r.track(new Promise<CommandOutcome>((_, rej) => (reject = rej)))
    r.track()
    reject(new Error('x'))
    await flush()
    expect(r.events.filter((e) => e.selectionId === a.id).map((e) => e.state)).toEqual(['queued'])
  })

  it('a turn that ended does not end the tracking: the next question is followed too (U2d-AC-4)', () => {
    const r = rig()
    const t = r.track()
    r.ok(t.cmd)
    r.turnStarted('human', 'turn-1')
    r.turnDone('turn-1', 'answer')
    expect(r.tracker.current(7)?.selectionId).toBe(t.id)
    r.turnStarted('human', 'turn-2')
    r.turnDone('turn-2', 'answer')
    expect(r.states()).toEqual(['queued', 'delivered', 'asked', 'answered', 'asked', 'answered'])
    expect(r.events.every((e) => e.selectionId === t.id)).toBe(true)
  })

  it('every kind of ended turn lets the next one start', () => {
    for (const reason of ['aborted', 'refusal', 'error']) {
      const r = rig()
      const t = r.track()
      r.ok(t.cmd)
      r.turnStarted('human', 'turn-1')
      r.turnDone('turn-1', reason)
      r.turnStarted('human', 'turn-2')
      expect(r.states().at(-1), reason).toBe('asked')
    }
  })

  it('a completion of a turn it did not start, or a second start while one runs, moves nothing', () => {
    const r = rig()
    const t = r.track()
    r.ok(t.cmd)
    r.turnStarted('human', 'turn-1')
    r.turnStarted('human', 'turn-2') // overlapping: the running turn is still turn-1
    r.turnDone('turn-2', 'answer')
    expect(r.states()).toEqual(['queued', 'delivered', 'asked'])
    r.turnDone('turn-1', 'answer')
    expect(r.states().at(-1)).toBe('answered')
  })

  it('only the row going away ends the tracking: a rebound or the binding ending, after any turn', () => {
    for (const how of ['rebound', 'end'] as const) {
      const r = rig()
      const t = r.track()
      r.ok(t.cmd)
      r.turnStarted('human', 'turn-1')
      r.turnDone('turn-1', 'answer')
      if (how === 'rebound') {
        r.host.fire(
          'event',
          binding(),
          ev('session.rebound', { prevSid: 'sid-1', sid: 'sid-2', cause: 'clear' })
        )
      } else {
        r.host.fire('end', binding({ state: 'ended' }), 'bye')
      }
      expect(r.states().at(-1), how).toBe(how === 'rebound' ? 'cleared' : 'ended')
      expect(r.tracker.current(7)).toBeNull()
      const n = r.events.length
      r.turnStarted('human', 'turn-2')
      expect(r.events.length).toBe(n)
    }
  })

  it('the row that says nothing is selected is tracked like any other', () => {
    const r = rig()
    const t = r.track(undefined, 7, null)
    r.ok(t.cmd)
    r.turnStarted('human', 'turn-1')
    r.turnDone('turn-1', 'answer')
    expect(r.states()).toEqual(['queued', 'delivered', 'asked', 'answered'])
  })

  it('an event of another binding is ignored', () => {
    const r = rig()
    const t = r.track()
    r.host.fire('event', binding({ key: 99 }), ev('command.result', { cmd: t.cmd, ok: true }))
    expect(r.states()).toEqual(['queued'])
  })

  it('dispose unsubscribes', () => {
    const r = rig()
    expect(r.host.listeners('event')).toBe(1)
    r.tracker.dispose()
    expect(r.host.listeners('event')).toBe(0)
    expect(r.host.listeners('end')).toBe(0)
  })

  it('reads no word the model wrote: the state events hold only closed fields', () => {
    const r = rig()
    const t = r.track()
    r.ok(t.cmd)
    r.turnStarted('human', 'turn-1')
    r.host.fire(
      'event',
      binding(),
      ev(
        'turn.completed',
        { reason: 'answer', isAborted: false, durationMs: 1, text: 'You are right!' },
        'turn-1'
      )
    )
    for (const e of r.events) {
      expect(
        Object.keys(e).every((k) => ['selectionId', 'state', 'at', 'code', 'next'].includes(k))
      ).toBe(true)
    }
    expect(JSON.stringify(r.events)).not.toContain('right')
  })
})

describe('U2a-i-AC-13 — the band driver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function bandRig() {
    const r = rig()
    const sent: Array<{ sid: string; args: Record<string, unknown> }> = []
    const send: BandSender = (req) => {
      sent.push({ sid: req.sid, args: req.args as never })
      return { ok: true }
    }
    const driver = createBandDriver({ send, log: () => undefined })
    driver.attach(r.tracker as SelectionTracker)
    return { ...r, sent, driver }
  }

  it('sets on delivered, after the 500 ms debounce, with the §8 line', () => {
    const r = bandRig()
    const t = r.track()
    r.ok(t.cmd)
    expect(r.sent).toEqual([])
    vi.advanceTimersByTime(499)
    expect(r.sent).toEqual([])
    vi.advanceTimersByTime(1)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toEqual({
      sid: 'sid-1',
      args: {
        line: '⧉ speech.ts L85–92 · src/main · ask your question below',
        parts: { lead: '⧉ speech.ts L85–92', detail: 'src/main', hint: 'ask your question below' }
      }
    })
    expect(JSON.stringify(r.sent)).not.toContain('"link"')
  })

  it('refreshes every 60 s while delivered or asked, under the mod’s 90 s lifetime', () => {
    const r = bandRig()
    const t = r.track()
    r.ok(t.cmd)
    vi.advanceTimersByTime(500)
    expect(r.sent).toHaveLength(1)
    vi.advanceTimersByTime(60_000)
    expect(r.sent).toHaveLength(2)
    r.turnStarted('human', 'turn-1') // asked keeps the same line: no flicker, no extra send
    vi.advanceTimersByTime(600)
    expect(r.sent).toHaveLength(2)
    vi.advanceTimersByTime(60_000)
    expect(r.sent).toHaveLength(3)
    expect(r.sent.every((s) => s.args.line !== null)).toBe(true)
    expect(60_000).toBeLessThan(90_000)
  })

  const cleared = (r: ReturnType<typeof bandRig>): void => {
    vi.advanceTimersByTime(500)
    expect(r.sent.at(-1)!.args).toEqual({ line: null })
    const n = r.sent.length
    vi.advanceTimersByTime(180_000)
    expect(r.sent.length).toBe(n) // and the refresh stopped
  }
  const standing = () => {
    const r = bandRig()
    const t = r.track()
    r.ok(t.cmd)
    vi.advanceTimersByTime(500)
    return r
  }

  it('stays after an answer, a stop, a refusal or an error: the row is still in the companion (U2d-AC-2)', () => {
    for (const reason of ['answer', 'aborted', 'refusal', 'error']) {
      const r = standing()
      r.turnStarted('human', 'turn-1')
      r.turnDone('turn-1', reason)
      vi.advanceTimersByTime(1_000)
      expect(r.sent, reason).toHaveLength(1)
      expect(r.sent.every((s) => s.args.line !== null)).toBe(true)
      // and it keeps refreshing under the mod's lifetime, through a second question as well
      r.turnStarted('human', 'turn-2')
      r.turnDone('turn-2', 'answer')
      vi.advanceTimersByTime(60_000)
      expect(r.sent.length, reason).toBe(2)
      expect(r.sent.every((s) => s.args.line !== null)).toBe(true)
    }
  })
  it('clears when the row that says nothing is selected is delivered, and stops refreshing', () => {
    const r = standing()
    const none = r.track(undefined, 7, null)
    r.ok(none.cmd)
    cleared(r)
  })
  it('a row that says nothing is selected never sets a line', () => {
    const r = bandRig()
    const none = r.track(undefined, 7, null)
    r.ok(none.cmd)
    r.turnStarted('human', 'turn-1')
    r.turnDone('turn-1', 'answer')
    vi.advanceTimersByTime(180_000)
    expect(r.sent.every((s) => s.args.line === null)).toBe(true)
  })
  it('clears on cleared (session.rebound), and to the NEW sid', () => {
    const r = standing()
    r.host.fire(
      'event',
      binding(),
      ev('session.rebound', { prevSid: 'sid-1', sid: 'sid-2', cause: 'clear' })
    )
    cleared(r)
    expect(r.sent.at(-1)!.sid).toBe('sid-2')
  })
  it('clears when a newer selection replaces it, and sets the new line once', () => {
    const r = standing()
    const b = r.track() // replaces: wants null...
    r.ok(b.cmd) // ...then the new delivery wants the new line inside the same debounce
    vi.advanceTimersByTime(500)
    // same line text as before: nothing flickers, nothing is re-sent
    expect(r.sent).toHaveLength(1)
  })
  it('a replaced selection’s late result never puts its line back over the newer one', async () => {
    const r = bandRig()
    const other: BandSelection = { ...SEL, path: 'src/other/voice.ts', startLine: 3, line: 4 }
    const a = r.track(undefined, 7, SEL)
    const b = r.track(undefined, 7, other)
    r.ok(b.cmd)
    a.resolve({ state: 'resulted', ok: true })
    await vi.advanceTimersByTimeAsync(5_000)
    const lines = r.sent.map((s) => String(s.args.line))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l.includes('voice.ts L3–4'))).toBe(true)
    expect(lines.some((l) => l.includes('speech.ts'))).toBe(false)
  })
  it('a replaced selection that never delivers leaves the band cleared', () => {
    const r = standing()
    r.track()
    cleared(r)
  })
  it('stops timers on ended and sends nothing to a binding that is gone', () => {
    const r = standing()
    r.host.fire('end', binding({ state: 'ended' }), 'bye')
    const n = r.sent.length
    vi.advanceTimersByTime(300_000)
    expect(r.sent.length).toBe(n)
  })
  it('a quick clear-then-set inside the debounce sends once, not twice', () => {
    const r = bandRig()
    const a = r.track()
    r.ok(a.cmd)
    vi.advanceTimersByTime(100)
    const none = r.track(undefined, 7, null) // wants null
    r.ok(none.cmd)
    vi.advanceTimersByTime(100)
    const b = r.track()
    r.ok(b.cmd) // wants the line again, still inside 500 ms of the first
    vi.advanceTimersByTime(600)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0].args.line).not.toBeNull()
  })
  it('a refused band send is logged and does not throw or stop the timers', () => {
    const r = rig()
    const logs: string[] = []
    const driver = createBandDriver({
      send: () => ({ ok: false, reason: 'FEATURE_OFF' }) as never,
      log: (m) => void logs.push(m)
    })
    driver.attach(r.tracker)
    const t = r.track()
    r.ok(t.cmd)
    vi.advanceTimersByTime(500 + 60_000)
    expect(logs.length).toBe(2)
  })
  it('never sends for a selection that was not delivered', async () => {
    const r = bandRig()
    r.track(Promise.resolve({ state: 'expired' }))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(r.sent).toEqual([])
  })
})

describe('U2d-AC-3 — the sid follower: a companion is the same companion after /clear', () => {
  const rebound = (host: ReturnType<typeof fakeHost>, prevSid: string, sid: string, key = 7) =>
    host.fire(
      'event',
      binding({ key, sid }),
      ev('session.rebound', { prevSid, sid, cause: 'clear' })
    )

  it('an id it has never heard of is its own answer', () => {
    const host = fakeHost()
    const f = createSidFollower({ host })
    expect(f.resolve('minted')).toBe('minted')
  })

  it('follows the minted id to the id the conversation has now, across several rebounds', () => {
    const host = fakeHost()
    const f = createSidFollower({ host })
    rebound(host, 'minted', 'second')
    expect(f.resolve('minted')).toBe('second')
    rebound(host, 'second', 'third')
    expect(f.resolve('minted')).toBe('third')
    expect(f.resolve('second')).toBe('third')
    expect(f.resolve('third')).toBe('third')
  })

  it('ignores a rebound that does not name both ids as strings', () => {
    const host = fakeHost()
    const f = createSidFollower({ host })
    host.fire('event', binding(), ev('session.rebound', { sid: 'x' }))
    host.fire('event', binding(), ev('session.rebound', { prevSid: 3, sid: 'y' }))
    host.fire('event', binding(), ev('turn.started', { origin: 'human' }, 't'))
    expect(f.resolve('minted')).toBe('minted')
  })

  it('forgets a binding once it ends, so a reused id is not followed into a dead conversation', () => {
    const host = fakeHost()
    const f = createSidFollower({ host })
    rebound(host, 'minted', 'second')
    host.fire('end', binding({ state: 'ended', sid: 'second' }), 'bye')
    expect(f.resolve('minted')).toBe('minted')
  })

  it('a loop of rebounds cannot hang it', () => {
    const host = fakeHost()
    const f = createSidFollower({ host })
    rebound(host, 'a', 'b')
    rebound(host, 'b', 'a')
    expect(['a', 'b']).toContain(f.resolve('a'))
  })

  it('dispose unsubscribes', () => {
    const host = fakeHost()
    const f = createSidFollower({ host })
    expect(host.listeners('event')).toBe(1)
    expect(host.listeners('end')).toBe(1)
    f.dispose()
    expect(host.listeners('event')).toBe(0)
    expect(host.listeners('end')).toBe(0)
    rebound(host, 'minted', 'second')
    expect(f.resolve('minted')).toBe('minted')
  })
})
