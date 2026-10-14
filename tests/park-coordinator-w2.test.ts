import { afterEach, describe, expect, test } from 'vitest'
import {
  createLegacyParkFacts,
  createParkCoordinator,
  type LegacyParkFacts,
  type ParkCoordinator,
  type ParkNegotiation
} from '../src/main/park-coordinator'
import {
  DEFAULT_NEGOTIATION,
  NEG_QUERY_WAIT_MS,
  type Answer,
  type ParkSnapshot
} from '../src/main/park-negotiation-core'

/**
 * T456 W2 — what the asynchronous `park.query` exposes in the coordinator (spec §6.4, §9.2):
 * "Park now" never waits behind a pending question and the late answer is discarded; the
 * coordinator's own throw parks; a host restart asks again; a rejected ask is handled at once.
 */

const MIN = 60_000
const BOUNDS = {
  maxDeclines: DEFAULT_NEGOTIATION.maxDeclines,
  maxDeferMs: DEFAULT_NEGOTIATION.maxDeferMs,
  pressureFloorMb: DEFAULT_NEGOTIATION.pressureFloorMb
}

interface World {
  c: ParkCoordinator
  facts: LegacyParkFacts
  parked: Array<{ key: string; negotiation: ParkNegotiation | null }>
  asks: number
  snaps: Map<string, ParkSnapshot>
  clock: { now: number }
  /** The next answer each ask gets: a value, or a deferred one the test releases. */
  answers: Array<Answer | Deferred>
}

interface Deferred {
  promise: Promise<Answer>
  release(a: Answer): void
}

function deferred(): Deferred {
  let release: (a: Answer) => void = () => undefined
  const promise = new Promise<Answer>((r) => (release = r))
  return { promise, release }
}

const snap = (ptyId = 'p1'): ParkSnapshot => ({
  ptyId,
  isSelected: false,
  lastFocusedAt: 0,
  lastActivityAt: 0,
  lastPromptAt: null
})

const open: ParkCoordinator[] = []
afterEach(() => {
  for (const c of open.splice(0)) c.dispose()
})

function world(over: { facts?: LegacyParkFacts; ask?: World['answers'] } = {}): World {
  const w = {
    facts: over.facts ?? createLegacyParkFacts(),
    parked: [],
    asks: 0,
    snaps: new Map([['s1', snap()]]),
    clock: { now: 10 * 60 * MIN },
    answers: over.ask ?? []
  } as unknown as World
  w.c = createParkCoordinator({
    now: () => w.clock.now,
    snapshot: (k) => w.snaps.get(k) ?? null,
    hibernate: (k, negotiation) => {
      w.parked.push({ key: k, negotiation })
      w.snaps.delete(k)
      w.c.forget(k) // as pty.ts does when the record goes
    },
    parkMode: () => 'ask',
    bounds: () => BOUNDS,
    memAvailableMb: () => null,
    facts: w.facts,
    ask: () => {
      w.asks++
      const next = w.answers.shift() ?? { kind: 'silent' }
      return 'promise' in next ? next.promise : Promise.resolve(next)
    }
  })
  open.push(w.c)
  return w
}

const busy = (retryAfterMs = 60_000): Answer => ({
  kind: 'busy',
  reasons: ['background-task'],
  retryAfterMs
})

// ---- "Park now" always wins (§6.4) ---------------------------------------------------------

describe('"Park now" during a pending question', () => {
  test('a sweep question is pending: manual parks at once, the late busy answer changes nothing', async () => {
    const later = deferred()
    const w = world({ ask: [busy(), later] })
    // One decline already: the row is declining when the operator clicks.
    expect((await w.c.requestPark('s1', 'sweep')).kind).toBe('declined')
    w.clock.now += 2 * MIN // past `until`: the next sweep asks again, and waits
    const sweep = w.c.requestPark('s1', 'sweep')
    await Promise.resolve()
    expect(w.asks).toBe(2)

    const manual = await w.c.requestPark('s1', 'manual')
    expect(manual).toEqual({
      kind: 'parked',
      negotiation: { declines: 1, reasons: ['background-task'], why: 'operator', override: true }
    })
    expect(w.parked).toHaveLength(1)

    // The session even came back (a resume) before the stale answer landed.
    w.snaps.set('s1', snap('p2'))
    later.release(busy())
    expect(await sweep).toEqual({ kind: 'cancelled', why: 'gone' })
    expect(w.c.episodeFor('s1')).toBeNull() // no episode reopened, no decline counted
    expect(w.parked).toHaveLength(1) // and no second kill
  })

  test('a cap question is pending: manual parks at once, the late answer changes nothing', async () => {
    const later = deferred()
    const w = world({ ask: [later] })
    const cap = w.c.requestCapParks(['s1'], 1)
    await Promise.resolve()
    expect(w.asks).toBe(1)

    const manual = await w.c.requestPark('s1', 'manual')
    // No decline yet (the first question is still pending), so no override is recorded: §6.4's
    // `override` means "the row was declining at that moment".
    expect(manual).toEqual({
      kind: 'parked',
      negotiation: { declines: 0, reasons: [], why: 'operator' }
    })
    later.release(busy())
    expect(await cap).toEqual([]) // the cap walk did not park it: the operator did
    expect(w.c.episodeFor('s1')).toBeNull()
    expect(w.parked).toHaveLength(1)
  })

  test('a free late answer does not kill the session a second time', async () => {
    const later = deferred()
    const w = world({ ask: [later] })
    const sweep = w.c.requestPark('s1', 'sweep')
    await Promise.resolve()
    await w.c.requestPark('s1', 'manual')
    w.snaps.set('s1', snap('p2')) // resumed
    later.release({ kind: 'free' })
    expect((await sweep).kind).toBe('cancelled')
    expect(w.parked).toHaveLength(1)
  })
})

// ---- spec §9.2 "the coordinator itself throws" ---------------------------------------------

describe('the coordinator itself throws (§9.2)', () => {
  test('a throw while applying the answer: revalidate, then park, ledger silent', async () => {
    const facts = createLegacyParkFacts()
    const throwing: LegacyParkFacts = {
      ...facts,
      busy: () => {
        throw new Error('facts exploded')
      }
    }
    const w = world({ facts: throwing, ask: [busy()] })
    const out = await w.c.requestPark('s1', 'sweep')
    expect(out).toEqual({
      kind: 'parked',
      negotiation: { declines: 0, reasons: [], why: 'silent' }
    })
    expect(w.parked).toHaveLength(1)
  })

  test('that park is still revalidated: a selection during the wait cancels it', async () => {
    const facts = createLegacyParkFacts()
    const throwing: LegacyParkFacts = {
      ...facts,
      busy: () => {
        throw new Error('facts exploded')
      }
    }
    const later = deferred()
    const w = world({ facts: throwing, ask: [later] })
    const sweep = w.c.requestPark('s1', 'sweep')
    await Promise.resolve()
    w.snaps.set('s1', { ...snap(), isSelected: true })
    later.release(busy())
    expect(await sweep).toEqual({ kind: 'cancelled', why: 'selected' })
    expect(w.parked).toHaveLength(0)
  })

  test('a throw reading the display counts keeps the decline and never rejects', async () => {
    const facts = createLegacyParkFacts()
    const throwing: LegacyParkFacts = {
      ...facts,
      counts: () => {
        throw new Error('counts exploded')
      }
    }
    const w = world({ facts: throwing, ask: [{ kind: 'silent' }] })
    facts.noteHookBody('s1', 'Stop', { background_tasks: [], session_crons: [{}] }, 0)
    const out = await w.c.requestPark('s1', 'sweep')
    expect(out.kind).toBe('declined')
    expect(w.c.episodeFor('s1')?.counts).toEqual({})
  })
})

// ---- spec §9.2 "host restart during a deferral" --------------------------------------------

describe('a host restart during a deferral (§9.2)', () => {
  test('episodes are in memory: a fresh coordinator asks again and the budget restarts', async () => {
    // The parked set (`hibernation.ts`) and the episodes both live in memory, so a restart loses
    // the open episode. The next sweep asks again from scratch: at most one extra `maxDeferMs`
    // per restart, which §9.2 accepts.
    const facts = createLegacyParkFacts()
    const first = world({ facts, ask: [busy(), busy()] })
    await first.c.requestPark('s1', 'sweep')
    first.clock.now += 2 * MIN
    await first.c.requestPark('s1', 'sweep')
    expect(first.c.episodeFor('s1')?.declines).toBe(2)
    first.c.dispose()

    const second = world({ facts, ask: [busy()] })
    second.clock.now = first.clock.now // the restart is immediate: still inside the old `until`
    const out = await second.c.requestPark('s1', 'sweep')
    expect(second.asks).toBe(1) // asked again, not deferred on the lost episode
    expect(out.kind).toBe('declined')
    expect(second.c.episodeFor('s1')?.declines).toBe(1) // the budget restarted
  })
})

// ---- a rejected ask is handled at once -----------------------------------------------------

describe('a rejected ask', () => {
  test('reads silent at once, not after NEG_QUERY_WAIT_MS, with no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => void unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    // The wait timer is captured and never fires: only the reject handler can settle the ask.
    globalThis.setTimeout = ((_fn: () => void, ms: number) => {
      expect(ms).toBe(NEG_QUERY_WAIT_MS)
      return 0
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout
    try {
      const facts = createLegacyParkFacts()
      const w = world({ facts })
      ;(w as { answers: unknown[] }).answers = [
        { promise: Promise.reject(new Error('channel exploded')), release: () => undefined }
      ]
      const out = await Promise.race([
        w.c.requestPark('s1', 'sweep'),
        new Promise<'stuck'>((r) => realSetTimeout(() => r('stuck'), 200))
      ])
      expect(out).toEqual({
        kind: 'parked',
        negotiation: { declines: 0, reasons: [], why: 'silent' }
      })
      await new Promise((r) => realSetTimeout(r, 20))
      expect(unhandled).toEqual([])
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

// ---- the hold is stamped at the question, not at the answer (W4 §4.2) ----------------------

describe('a late answer does not stretch the hold by a sweep (T456 W4 §4.2)', () => {
  const TICK = 60_000 // SWEEP_INTERVAL_MS
  const T0 = 10 * 60 * MIN

  /**
   * Runs the sweep every TICK on a fake clock. Each question is answered busy after `latencyMs`
   * of that clock (the mod's round trip), so `deps.now()` after the answer reads later than the
   * tick. Returns the tick at which the session was parked, and how many questions it took.
   */
  async function sweepUntilParked(o: {
    latencyMs: number
    retryAfterMs?: number
    bounds: { maxDeclines: number; maxDeferMs: number }
    ticks?: number
  }): Promise<{ parkedAt: number | null; asks: number[] }> {
    const clock = { now: T0 }
    const asks: number[] = []
    let parkedAt: number | null = null
    const snaps = new Map([['s1', snap()]])
    const c = createParkCoordinator({
      now: () => clock.now,
      snapshot: (k) => snaps.get(k) ?? null,
      hibernate: (k) => {
        parkedAt = clock.now
        snaps.delete(k)
      },
      parkMode: () => 'ask',
      bounds: () => ({ ...o.bounds, pressureFloorMb: BOUNDS.pressureFloorMb }),
      memAvailableMb: () => null,
      facts: createLegacyParkFacts(),
      ask: async () => {
        asks.push(clock.now)
        clock.now += o.latencyMs // the answer lands this much after the tick
        return {
          kind: 'busy',
          reasons: ['background-task'],
          ...(o.retryAfterMs !== undefined ? { retryAfterMs: o.retryAfterMs } : {})
        }
      }
    })
    open.push(c)
    for (let i = 0; i <= (o.ticks ?? 20) && parkedAt === null; i++) {
      const tick = T0 + i * TICK
      clock.now = tick
      // The policy's own skip, as `evaluateFleet` does it: a session inside `until` is no victim.
      const ep = c.episodeFor('s1')
      if (ep && tick < ep.until) continue
      await c.requestPark('s1', 'sweep')
      if (parkedAt !== null) parkedAt = tick // the park belongs to this tick
    }
    return { parkedAt, asks: asks.map((a) => a - T0) }
  }

  // 1 ms, 4 s, and the 5 s edge (an answer the wait still accepts).
  const LATENCIES = [1, 4_000, NEG_QUERY_WAIT_MS - 1]

  test('maxDeferMs: parked at the same tick whatever the answer latency', async () => {
    const bounds = { maxDeclines: 100, maxDeferMs: 2 * MIN }
    const base = await sweepUntilParked({ latencyMs: 0, retryAfterMs: TICK, bounds })
    expect(base.parkedAt).toBe(T0 + 2 * MIN) // exactly maxDeferMs after the first decline
    for (const latencyMs of LATENCIES) {
      const got = await sweepUntilParked({ latencyMs, retryAfterMs: TICK, bounds })
      expect(got.parkedAt, `latency ${latencyMs} ms`).toBe(base.parkedAt)
      expect(got.asks, `latency ${latencyMs} ms`).toEqual(base.asks)
    }
  })

  test('maxDeclines: parked at the same tick whatever the answer latency', async () => {
    const bounds = { maxDeclines: 3, maxDeferMs: 60 * MIN }
    const base = await sweepUntilParked({ latencyMs: 0, retryAfterMs: TICK, bounds })
    expect(base.asks).toEqual([0, TICK, 2 * TICK]) // asked at every sweep
    expect(base.parkedAt).toBe(T0 + 3 * TICK)
    for (const latencyMs of LATENCIES) {
      const got = await sweepUntilParked({ latencyMs, retryAfterMs: TICK, bounds })
      expect(got.parkedAt, `latency ${latencyMs} ms`).toBe(base.parkedAt)
      expect(got.asks, `latency ${latencyMs} ms`).toEqual(base.asks)
    }
  })

  test('the default 10-minute retry re-asks at the first sweep at or after until, no drift', async () => {
    const bounds = { maxDeclines: 3, maxDeferMs: 60 * MIN }
    for (const latencyMs of [0, ...LATENCIES]) {
      const got = await sweepUntilParked({ latencyMs, bounds, ticks: 35 })
      expect(got.asks, `latency ${latencyMs} ms`).toEqual([0, 10 * MIN, 20 * MIN])
      expect(got.parkedAt, `latency ${latencyMs} ms`).toBe(T0 + 30 * MIN)
    }
  })
})
