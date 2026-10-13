import { describe, expect, test, beforeEach } from 'vitest'
import {
  createLegacyParkFacts,
  createParkCoordinator,
  legacyStopCounts,
  runParkPolicy,
  type LegacyParkFacts,
  type ParkCoordinator,
  type ParkCoordinatorDeps,
  type ParkMode,
  type ParkNegotiation
} from '../src/main/park-coordinator'
import {
  DEFAULT_NEGOTIATION,
  NEG_QUERY_WAIT_MS,
  NEG_RETRY_DEFAULT_MS,
  NEG_RETRY_MIN_MS,
  type Answer,
  type ParkSnapshot
} from '../src/main/park-negotiation-core'
import type { LiveSession, Policy } from '../src/main/fleet-policy'

/**
 * T456 W1 — the park coordinator (spec §5.1, §5.6, §9.2) over the pure core. Everything the
 * coordinator touches is injected: the clock, the PTY snapshot, the killer, the prefs key, the
 * bounds and the memory reading. W1 has no `park.query`; an injected `ask` stands in for W2 where a
 * test needs a real answer (AC-T456-1, AC-T456-10).
 */

const MIN = 60_000
const H = 60 * MIN
const BOUNDS = {
  maxDeclines: DEFAULT_NEGOTIATION.maxDeclines,
  maxDeferMs: DEFAULT_NEGOTIATION.maxDeferMs,
  pressureFloorMb: DEFAULT_NEGOTIATION.pressureFloorMb
}
const POLICY: Policy = { maxLive: 5, lruIdleMs: 15 * MIN, hardIdleMs: 60 * MIN }

interface Fake {
  now: number
  snaps: Map<string, ParkSnapshot>
  parked: Array<{ key: string; negotiation: ParkNegotiation | null }>
  mode: ParkMode
  mem: number | null
  facts: LegacyParkFacts
  asks: Array<{ key: string; cause: string }>
  ask?: ParkCoordinatorDeps['ask']
}

function snap(over: Partial<ParkSnapshot> = {}): ParkSnapshot {
  return {
    ptyId: 'p1',
    isSelected: false,
    lastFocusedAt: 0,
    lastActivityAt: 0,
    lastPromptAt: null,
    ...over
  }
}

function setup(over: Partial<Fake> = {}): { f: Fake; c: ParkCoordinator } {
  const f: Fake = {
    now: 10 * H,
    snaps: new Map([['s1', snap()]]),
    parked: [],
    mode: 'ask',
    mem: null,
    facts: createLegacyParkFacts(),
    asks: [],
    ...over
  }
  const c = createParkCoordinator({
    now: () => f.now,
    snapshot: (key) => {
      const s = f.snaps.get(key)
      if (!s) return null
      return { ...s, lastPromptAt: f.facts.lastPromptAt(key) ?? s.lastPromptAt }
    },
    hibernate: (key, negotiation) => {
      f.parked.push({ key, negotiation })
      f.snaps.delete(key)
    },
    parkMode: () => f.mode,
    bounds: () => BOUNDS,
    memAvailableMb: () => f.mem,
    facts: f.facts,
    ...(f.ask
      ? {
          ask: (key, cause) => {
            f.asks.push({ key, cause })
            return f.ask!(key, cause)
          }
        }
      : {})
  })
  return { f, c }
}

/** One main `Stop` as the legacy hook delivers it. */
function stop(
  facts: LegacyParkFacts,
  key: string,
  body: { background_tasks?: unknown[]; session_crons?: unknown[] },
  at = 0
): void {
  facts.noteHookBody(key, 'Stop', body, at)
}

const busyAnswer = (retryAfterMs?: number): Answer => ({
  kind: 'busy',
  reasons: ['background-task'],
  ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
})

describe('legacy Stop facts (spec §5.5)', () => {
  test('counts in-flight background tasks and crons, and keeps no text', () => {
    expect(
      legacyStopCounts({
        background_tasks: [
          { id: 'a', type: 'shell', status: 'running', command: 'git push --force' },
          { id: 'b', type: 'subagent', status: 'pending' },
          { id: 'c', type: 'shell', status: 'completed' }
        ],
        session_crons: [{ recurring: true, prompt: 'secret' }]
      })
    ).toEqual({ tasks: 2, crons: 1 })
  })

  test('an old CLI with no fields reads nothing busy', () => {
    expect(legacyStopCounts({})).toEqual({ tasks: 0, crons: 0 })
    expect(legacyStopCounts({ background_tasks: 'x', session_crons: null })).toEqual({
      tasks: 0,
      crons: 0
    })
  })

  test('a Stop maps to busy reasons; the next Stop replaces it', () => {
    const facts = createLegacyParkFacts()
    stop(facts, 's1', {
      background_tasks: [{ type: 'shell', status: 'running' }],
      session_crons: [{ recurring: false }]
    })
    expect(facts.busy('s1')).toEqual(['background-task', 'scheduled-wakeup'])
    stop(facts, 's1', { background_tasks: [], session_crons: [] })
    expect(facts.busy('s1')).toEqual([])
  })

  test('a subagent’s own Stop (agent_id) never replaces the main facts', () => {
    const facts = createLegacyParkFacts()
    stop(facts, 's1', { session_crons: [{ recurring: true }] })
    facts.noteHookBody('s1', 'Stop', { agent_id: 'ag-1', session_crons: [] }, 0)
    expect(facts.busy('s1')).toEqual(['scheduled-wakeup'])
  })

  test('UserPromptSubmit stamps lastPromptAt for any source', () => {
    const facts = createLegacyParkFacts()
    expect(facts.lastPromptAt('s1')).toBeNull()
    facts.noteHookBody('s1', 'UserPromptSubmit', { source: 'loop_wakeup' }, 123)
    expect(facts.lastPromptAt('s1')).toBe(123)
    facts.noteHookBody('s1', 'UserPromptSubmit', {}, 456)
    expect(facts.lastPromptAt('s1')).toBe(456)
  })
})

describe('AC-T456-1 — a busy answer defers the park and is not asked again before `until`', () => {
  test('through the session’s answer (an injected ask stands in for W2)', async () => {
    const { f, c } = setup({ ask: async () => busyAnswer(5 * MIN) })
    const first = await c.requestPark('s1', 'sweep')
    expect(first.kind).toBe('declined')
    expect(f.parked).toEqual([])
    const t0 = f.now
    expect(c.episodeFor('s1')!.until).toBe(t0 + 5 * MIN)
    for (const dt of [MIN, 2 * MIN, 5 * MIN - 1]) {
      f.now = t0 + dt
      expect((await c.requestPark('s1', 'sweep')).kind).toBe('deferred')
    }
    expect(f.asks).toHaveLength(1)
    expect(f.parked).toEqual([])
  })

  test('through the legacy facts, and the policy skips it while inside `until`', async () => {
    const { f, c } = setup()
    stop(f.facts, 's1', { background_tasks: [{ type: 'shell', status: 'running' }] })
    expect((await c.requestPark('s1', 'sweep')).kind).toBe('declined')
    const cold: LiveSession = {
      sessionKey: 's1',
      kind: 'claude-resume',
      taskState: 'idle',
      lastFocusedAt: f.now - 2 * H,
      lastActivityAt: f.now - 2 * H,
      isSelected: false,
      hasPendingApproval: false
    }
    f.now += MIN
    runParkPolicy(c, [{ ...cold, episode: c.episodeFor('s1')! }], f.now, POLICY, 'sweep')
    await Promise.resolve()
    expect(f.parked).toEqual([])
    expect(c.episodeFor('s1')!.declines).toBe(1)
  })
})

/**
 * Drives the coordinator the way `pty.ts` does: the sweep every 60 s over one hard-idle session,
 * through `runParkPolicy` and the episode the coordinator hands the policy.
 */
async function sweepUntilParked(
  f: Fake,
  c: ParkCoordinator,
  hours = 12
): Promise<{ parkedAt: number | null; questions: number; firstDeclineAt: number | null }> {
  const start = f.now
  let firstDeclineAt: number | null = null
  for (let t = start; t <= start + hours * H; t += MIN) {
    f.now = t
    if (f.parked.length > 0) break
    const ep = c.policyEpisodes().get('s1')
    const session: LiveSession = {
      sessionKey: 's1',
      kind: 'claude-resume',
      taskState: 'idle',
      lastFocusedAt: start - 2 * H,
      lastActivityAt: start - 2 * H,
      isSelected: false,
      hasPendingApproval: false,
      ...(ep ? { episode: ep } : {})
    }
    runParkPolicy(c, [session], t, POLICY, 'sweep')
    for (let i = 0; i < 5; i++) await Promise.resolve()
    firstDeclineAt ??= c.episodeFor('s1')?.firstDeclineAt ?? null
    if (f.parked.length > 0) return { parkedAt: t, questions: f.asks.length, firstDeclineAt }
  }
  return { parkedAt: null, questions: f.asks.length, firstDeclineAt }
}

describe('AC-T456-2 — an always-busy session is parked by maxDeclines or maxDeferMs (§6.6)', () => {
  test('after maxDeclines questions when it asks to be asked again soon', async () => {
    const { f, c } = setup({ ask: async () => busyAnswer(1) })
    const start = f.now
    const r = await sweepUntilParked(f, c)
    expect(r.questions).toBe(BOUNDS.maxDeclines)
    expect(r.parkedAt! - start).toBe(BOUNDS.maxDeclines * NEG_RETRY_MIN_MS)
    expect(f.parked[0].negotiation).toMatchObject({ why: 'limit', declines: BOUNDS.maxDeclines })
  })

  test('after maxDeferMs when declines alone would never run out', async () => {
    const { f, c } = setup({ ask: async () => busyAnswer(H) })
    const start = f.now
    const r = await sweepUntilParked(f, c)
    // 60-min hints: asked at 0, 60, then the ceiling at 120 parks it — 2 questions, not 8.
    expect(r.questions).toBeLessThan(BOUNDS.maxDeclines)
    expect(r.parkedAt! - start).toBe(BOUNDS.maxDeferMs)
    expect(f.parked[0].negotiation?.why).toBe('limit')
  })

  test.each([undefined, 1, 59_000, 10 * MIN, 29 * MIN, H, 10 * H])(
    'the hold past the first decline never exceeds maxDeferMs (hint %s)',
    async (hint) => {
      const { f, c } = setup({ ask: async () => busyAnswer(hint) })
      const r = await sweepUntilParked(f, c)
      expect(r.parkedAt).not.toBeNull()
      expect(r.parkedAt! - r.firstDeclineAt!).toBeLessThanOrEqual(BOUNDS.maxDeferMs)
      expect(r.questions).toBeLessThanOrEqual(BOUNDS.maxDeclines)
    }
  )

  test('on legacy facts alone (W1’s only path): parked at the 8th decline’s `until`', async () => {
    const { f, c } = setup()
    stop(f.facts, 's1', { background_tasks: [{ type: 'shell', status: 'running' }] })
    const start = f.now
    const r = await sweepUntilParked(f, c, 24)
    // Default retry 10 min, 8 declines: asked at 0..70, the 8th grants until 80 ≤ maxDeferMs.
    expect(r.parkedAt! - start).toBe(BOUNDS.maxDeclines * NEG_RETRY_DEFAULT_MS)
    expect(f.parked[0].negotiation).toMatchObject({
      why: 'limit',
      declines: BOUNDS.maxDeclines,
      reasons: ['background-task']
    })
  })
})

describe('AC-T456-3 — memory under the floor parks a busy session without asking', () => {
  test('a fresh candidate', async () => {
    const { f, c } = setup({ ask: async () => busyAnswer(), mem: BOUNDS.pressureFloorMb - 1 })
    stop(f.facts, 's1', { session_crons: [{ recurring: true }] })
    const out = await c.requestPark('s1', 'sweep')
    expect(out.kind).toBe('parked')
    expect(f.asks).toHaveLength(0)
    expect(f.parked[0].negotiation?.why).toBe('memory-pressure')
  })

  test('a session inside its granted delay, which the policy sees again under pressure', async () => {
    const { f, c } = setup({ ask: async () => busyAnswer(30 * MIN) })
    await c.requestPark('s1', 'sweep')
    expect(c.policyEpisodes().has('s1')).toBe(true)
    f.mem = 100
    // Under pressure the policy gets no episode, so the deferred session is a candidate again.
    expect(c.policyEpisodes().has('s1')).toBe(false)
    f.now += MIN
    const out = await c.requestPark('s1', 'sweep')
    expect(out.kind).toBe('parked')
    expect(f.asks).toHaveLength(1)
    expect(f.parked[0].negotiation).toMatchObject({ why: 'memory-pressure', declines: 1 })
  })

  test('memory at the floor is not pressure', async () => {
    const { f, c } = setup({ mem: BOUNDS.pressureFloorMb })
    stop(f.facts, 's1', { session_crons: [{ recurring: true }] })
    expect((await c.requestPark('s1', 'sweep')).kind).toBe('declined')
  })
})

describe('AC-T456-4 — Park now parks without a question', () => {
  test('a busy session is parked at once by cause manual, and the ledger marks the override', async () => {
    const { f, c } = setup({ ask: async () => busyAnswer() })
    await c.requestPark('s1', 'sweep')
    expect(f.parked).toEqual([])
    const out = c.requestPark('s1', 'manual')
    // Synchronous: the kill happened before the promise settled (pty:park keeps its contract).
    expect(f.parked).toHaveLength(1)
    expect((await out).kind).toBe('parked')
    expect(f.asks).toHaveLength(1)
    expect(f.parked[0].negotiation).toMatchObject({ why: 'operator', override: true })
  })

  test('Park now on a selected session still parks (the operator pointed at it)', async () => {
    const { f, c } = setup()
    f.snaps.set('s1', snap({ isSelected: true }))
    await c.requestPark('s1', 'manual')
    expect(f.parked).toHaveLength(1)
    expect(f.parked[0].negotiation).toEqual({ declines: 0, reasons: [], why: 'operator' })
  })
})

describe('AC-T456-5 — no binding and a legacy Stop with one cron defers the session', () => {
  test('silent (W1 asks nothing) falls back to the cron and defers', async () => {
    const { f, c } = setup()
    stop(f.facts, 's1', { session_crons: [{ recurring: true }] })
    const out = await c.requestPark('s1', 'sweep')
    expect(out).toMatchObject({ kind: 'declined' })
    expect(c.episodeFor('s1')).toMatchObject({
      declines: 1,
      reasons: ['scheduled-wakeup'],
      until: f.now + NEG_RETRY_DEFAULT_MS
    })
    f.now += MIN
    expect((await c.requestPark('s1', 'sweep')).kind).toBe('deferred')
    expect(f.parked).toEqual([])
  })

  test('an ask that times out is silent and falls back to the same facts', async () => {
    const { f, c } = setup({ ask: () => new Promise<Answer>(() => {}) })
    stop(f.facts, 's1', { session_crons: [{ recurring: true }] })
    const realSetTimeout = globalThis.setTimeout
    let fired: (() => void) | null = null
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      expect(ms).toBe(NEG_QUERY_WAIT_MS)
      fired = fn
      return 0
    }) as unknown as typeof setTimeout
    try {
      const pending = c.requestPark('s1', 'sweep')
      ;(fired as unknown as () => void)()
      expect((await pending).kind).toBe('declined')
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })

  test('with no facts at all, silent is today’s park', async () => {
    const { f, c } = setup()
    expect((await c.requestPark('s1', 'sweep')).kind).toBe('parked')
    expect(f.parked[0].negotiation).toEqual({ declines: 0, reasons: [], why: 'silent' })
  })

  test('key park = off is today’s behaviour exactly: the facts are not read', async () => {
    const { f, c } = setup({ mode: 'off', mem: 1 })
    stop(f.facts, 's1', { session_crons: [{ recurring: true }] })
    expect((await c.requestPark('s1', 'sweep')).kind).toBe('parked')
    expect(f.parked[0].negotiation).toBeNull()
  })

  test('an ask that throws is silent, then the facts, then the park (§9.2)', async () => {
    const { f, c } = setup({
      ask: async () => {
        throw new Error('boom')
      }
    })
    expect((await c.requestPark('s1', 'sweep')).kind).toBe('parked')
    expect(f.parked[0].negotiation?.why).toBe('silent')
  })
})

describe('AC-T456-6 — a cap spawn is not delayed and a declining candidate passes to the next', () => {
  test('runParkPolicy returns before any answer, then the next candidate is parked', async () => {
    let release: ((a: Answer) => void) | null = null
    const { f, c } = setup({
      ask: (key) =>
        key === 'a'
          ? new Promise<Answer>((r) => (release = r))
          : Promise.resolve({ kind: 'free' } as Answer)
    })
    f.snaps = new Map([
      ['a', snap({ ptyId: 'pa' })],
      ['b', snap({ ptyId: 'pb' })],
      ['c', snap({ ptyId: 'pc' })]
    ])
    const fleet = (['a', 'b', 'c', 'd', 'e'] as const).map((key, i): LiveSession => ({
      sessionKey: key,
      kind: 'claude-resume',
      taskState: 'idle',
      // a is coldest, then b, then c; d and e are warm.
      lastFocusedAt: f.now - (i < 3 ? (50 - i * 10) * MIN : MIN),
      lastActivityAt: f.now - (i < 3 ? (50 - i * 10) * MIN : MIN),
      isSelected: false,
      hasPendingApproval: false
    }))
    // The spawn path calls this synchronously and goes on to spawn: it must not return a promise.
    const ret = runParkPolicy(c, fleet, f.now, POLICY, 'cap')
    expect(ret).toBeUndefined()
    expect(f.parked).toEqual([])
    expect(f.asks.map((a) => a.key)).toEqual(['a'])
    ;(release as unknown as (a: Answer) => void)(busyAnswer())
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(f.asks.map((a) => a.key)).toEqual(['a', 'b'])
    expect(f.parked.map((p) => p.key)).toEqual(['b'])
    expect(c.episodeFor('a')?.declines).toBe(1)
  })

  test('requestCapParks frees exactly the slots asked for, skipping decliners', async () => {
    const { f, c } = setup()
    f.snaps = new Map([
      ['a', snap({ ptyId: 'pa' })],
      ['b', snap({ ptyId: 'pb' })],
      ['c', snap({ ptyId: 'pc' })]
    ])
    stop(f.facts, 'a', { session_crons: [{ recurring: true }] })
    const parked = await c.requestCapParks(['a', 'b', 'c'], 1)
    expect(parked).toEqual(['b'])
    expect(f.parked.map((p) => p.key)).toEqual(['b'])
  })

  test('every candidate declining leaves the fleet over the ceiling (T119 §3.5)', async () => {
    const { f, c } = setup()
    f.snaps = new Map([['a', snap({ ptyId: 'pa' })]])
    stop(f.facts, 'a', { background_tasks: [{ type: 'monitor', status: 'running' }] })
    expect(await c.requestCapParks(['a'], 1)).toEqual([])
    expect(f.parked).toEqual([])
  })
})

describe('AC-T456-10 — revalidation cancels a free park after a gap, and counts no decline', () => {
  const gap = (change: (f: Fake) => void) => {
    const { f, c } = setup({
      ask: async () => {
        change(f)
        return { kind: 'free' }
      }
    })
    return { f, c }
  }

  test('the operator selected the session during the wait', async () => {
    const { f, c } = gap((f) => {
      f.now += 1_000
      f.snaps.set('s1', snap({ isSelected: true, lastFocusedAt: f.now }))
    })
    const out = await c.requestPark('s1', 'sweep')
    expect(out).toEqual({ kind: 'cancelled', why: 'selected' })
    expect(f.parked).toEqual([])
    expect(c.episodeFor('s1')).toBeNull()
  })

  test('a prompt arrived during the wait (legacy UserPromptSubmit, any source)', async () => {
    const { f, c } = gap((f) => {
      f.now += 1_000
      f.facts.noteHookBody('s1', 'UserPromptSubmit', { source: 'loop_wakeup' }, f.now)
    })
    const out = await c.requestPark('s1', 'cap')
    expect(out).toEqual({ kind: 'cancelled', why: 'prompted' })
    expect(f.parked).toEqual([])
    expect(c.episodeFor('s1')).toBeNull()
  })

  test('PTY bytes or a respawn in the gap cancel too', async () => {
    const a = gap((f) => {
      f.now += 1_000
      f.snaps.set('s1', snap({ lastActivityAt: f.now }))
    })
    expect(await a.c.requestPark('s1', 'sweep')).toEqual({ kind: 'cancelled', why: 'active' })
    const b = gap((f) => f.snaps.set('s1', snap({ ptyId: 'p2' })))
    expect(await b.c.requestPark('s1', 'sweep')).toEqual({ kind: 'cancelled', why: 'respawned' })
    expect(a.f.parked).toEqual([])
    expect(b.f.parked).toEqual([])
  })

  test('a busy answer after the operator came back counts no decline either', async () => {
    const { f, c } = setup({
      ask: async () => {
        f.snaps.set('s1', snap({ isSelected: true }))
        return busyAnswer()
      }
    })
    expect(await c.requestPark('s1', 'sweep')).toEqual({ kind: 'cancelled', why: 'selected' })
    expect(c.episodeFor('s1')).toBeNull()
  })

  test('a session asked twice at once is asked once', async () => {
    let release: ((a: Answer) => void) | null = null
    const { f, c } = setup({ ask: () => new Promise<Answer>((r) => (release = r)) })
    const one = c.requestPark('s1', 'sweep')
    expect(await c.requestPark('s1', 'cap')).toEqual({ kind: 'in-flight' })
    ;(release as unknown as (a: Answer) => void)({ kind: 'free' })
    expect((await one).kind).toBe('parked')
    expect(f.asks).toHaveLength(1)
  })
})

describe('AC-T456-11 — only a person closes an episode', () => {
  let f: Fake
  let c: ParkCoordinator
  beforeEach(async () => {
    ;({ f, c } = setup())
    stop(f.facts, 's1', { session_crons: [{ recurring: true }] })
    await c.requestPark('s1', 'sweep')
  })

  test.each(['schedule_wakeup', 'loop_wakeup', 'system', 'sdk', undefined, 42])(
    'a UserPromptSubmit with source %s leaves it unchanged',
    (source) => {
      const before = c.episodeFor('s1')
      expect(before).not.toBeNull()
      f.facts.noteHookBody('s1', 'UserPromptSubmit', source === undefined ? {} : { source }, f.now)
      expect(c.episodeFor('s1')).toEqual(before)
    }
  )

  test('a UserPromptSubmit with source user closes it', () => {
    f.facts.noteHookBody('s1', 'UserPromptSubmit', { source: 'user' }, f.now)
    expect(c.episodeFor('s1')).toBeNull()
  })

  test('the operator selecting the session closes it', () => {
    c.onFocus('s1')
    expect(c.episodeFor('s1')).toBeNull()
  })

  test('a subagent’s prompt never closes it', () => {
    f.facts.noteHookBody('s1', 'UserPromptSubmit', { source: 'user', agent_id: 'ag' }, f.now)
    expect(c.episodeFor('s1')).not.toBeNull()
  })
})
