import { describe, it, expect, beforeEach, afterEach } from 'vitest'

/**
 * BUG-30 — the pure core for the in-flight agent-session registry. Mirrors
 * `grant-registry`'s in-memory-only posture (no persistence across restart) but
 * the decisions (register / evict-on-disk-appearance / TTL / cap) are pure
 * functions over an explicit, immutable registry value — same discipline as
 * `grant-core.ts` (injected `now`, no fake timers needed).
 */
import {
  emptyRegistry,
  register,
  list,
  evictObserved,
  evictById,
  reconcile,
  INFLIGHT_CAP,
  INFLIGHT_TTL_MS,
  registerInflightSession,
  listInflightSessions,
  evictObservedSessions,
  evictInflightSessionById,
  _resetInflightRegistry,
  type InflightRegistryState
} from '../src/main/mcp/inflight-session-registry'

describe('inflight-session-registry — pure core', () => {
  it('register then list surfaces the entry', () => {
    const reg = register(emptyRegistry(), {
      syntheticId: 'synthetic-1',
      folderPath: '/repo',
      createdAt: 0
    })
    expect(list(reg, { now: 0 })).toHaveLength(1)
    expect(list(reg, { now: 0 })[0]).toMatchObject({
      syntheticId: 'synthetic-1',
      folderPath: '/repo'
    })
  })

  it('evicts an entry once the real session is observed on disk', () => {
    let reg = register(emptyRegistry(), {
      syntheticId: 'synthetic-1',
      folderPath: '/repo',
      createdAt: 0
    })
    expect(list(reg, { now: 0 })).toHaveLength(1)
    reg = evictObserved(reg, ['synthetic-1'])
    expect(list(reg, { now: 0 })).toEqual([])
  })

  it('evictObserved only removes matching ids, leaving the rest untouched', () => {
    let reg = register(emptyRegistry(), {
      syntheticId: 'synthetic-1',
      folderPath: '/repo',
      createdAt: 0
    })
    reg = register(reg, { syntheticId: 'synthetic-2', folderPath: '/repo', createdAt: 0 })
    reg = evictObserved(reg, ['synthetic-1'])
    expect(list(reg, { now: 0 }).map((e) => e.syntheticId)).toEqual(['synthetic-2'])
  })

  it('evictObserved with an unmatched id is a no-op', () => {
    const reg = register(emptyRegistry(), {
      syntheticId: 'synthetic-1',
      folderPath: '/repo',
      createdAt: 0
    })
    const next = evictObserved(reg, ['some-other-id'])
    expect(list(next, { now: 0 })).toHaveLength(1)
  })

  it('list filters by folderPath when given', () => {
    let reg = register(emptyRegistry(), { syntheticId: 's1', folderPath: '/a', createdAt: 0 })
    reg = register(reg, { syntheticId: 's2', folderPath: '/b', createdAt: 0 })
    expect(list(reg, { now: 0, folderPath: '/a' }).map((e) => e.syntheticId)).toEqual(['s1'])
  })

  it('an entry younger than the TTL is listed', () => {
    const reg = register(emptyRegistry(), { syntheticId: 's1', folderPath: '/repo', createdAt: 0 })
    expect(list(reg, { now: INFLIGHT_TTL_MS - 1 })).toHaveLength(1)
  })

  it('an entry older than the TTL is evicted even if the session never appears', () => {
    const reg = register(emptyRegistry(), { syntheticId: 's1', folderPath: '/repo', createdAt: 0 })
    expect(list(reg, { now: INFLIGHT_TTL_MS + 1 })).toEqual([])
  })

  it('holds the entry cap under a burst — oldest evicted first', () => {
    let reg: InflightRegistryState = emptyRegistry()
    for (let i = 0; i < INFLIGHT_CAP + 10; i++) {
      reg = register(reg, { syntheticId: `s${i}`, folderPath: '/repo', createdAt: i })
    }
    const surviving = list(reg, { now: INFLIGHT_CAP + 10 })
    expect(surviving).toHaveLength(INFLIGHT_CAP)
    // The oldest 10 (s0..s9) were evicted first; the newest survive.
    expect(surviving.map((e) => e.syntheticId)).not.toContain('s0')
    expect(surviving.map((e) => e.syntheticId)).toContain(`s${INFLIGHT_CAP + 9}`)
  })

  it('re-registering the same syntheticId refreshes rather than duplicates', () => {
    let reg = register(emptyRegistry(), { syntheticId: 's1', folderPath: '/repo', createdAt: 0 })
    reg = register(reg, { syntheticId: 's1', folderPath: '/repo', createdAt: 5 })
    expect(list(reg, { now: 5 })).toHaveLength(1)
    expect(list(reg, { now: 5 })[0].createdAt).toBe(5)
  })

  it('does not mutate its inputs', () => {
    const reg = register(emptyRegistry(), { syntheticId: 's1', folderPath: '/repo', createdAt: 0 })
    const before = JSON.parse(JSON.stringify(reg))
    register(reg, { syntheticId: 's2', folderPath: '/repo', createdAt: 1 })
    evictObserved(reg, ['s1'])
    expect(reg).toEqual(before)
  })
})

describe('inflight-session-registry — evictById (BUG-89: unconditional eviction by syntheticId)', () => {
  it('evicts the matching entry and returns it, regardless of TTL or observed-id evidence', () => {
    const reg = register(emptyRegistry(), {
      syntheticId: 'synthetic-1',
      folderPath: '/repo',
      createdAt: 0
    })
    const { state, evicted } = evictById(reg, 'synthetic-1')
    expect(list(state, { now: 0 })).toEqual([])
    expect(evicted).toMatchObject({ syntheticId: 'synthetic-1', folderPath: '/repo' })
  })

  it('leaves other entries untouched', () => {
    let reg = register(emptyRegistry(), { syntheticId: 's1', folderPath: '/repo', createdAt: 0 })
    reg = register(reg, { syntheticId: 's2', folderPath: '/repo', createdAt: 0 })
    const { state } = evictById(reg, 's1')
    expect(list(state, { now: 0 }).map((e) => e.syntheticId)).toEqual(['s2'])
  })

  it('is a no-op returning null when the id is unknown', () => {
    const reg = register(emptyRegistry(), { syntheticId: 's1', folderPath: '/repo', createdAt: 0 })
    const { state, evicted } = evictById(reg, 'some-other-id')
    expect(state).toBe(reg)
    expect(evicted).toBeNull()
  })

  it('does not mutate its input', () => {
    const reg = register(emptyRegistry(), { syntheticId: 's1', folderPath: '/repo', createdAt: 0 })
    const before = JSON.parse(JSON.stringify(reg))
    evictById(reg, 's1')
    expect(reg).toEqual(before)
  })
})

describe('inflight-session-registry — reconcile (BUG-58: active eviction, returns evicted entries)', () => {
  it('evicts an observed entry and returns it', () => {
    const reg = register(emptyRegistry(), {
      syntheticId: 'synthetic-1',
      folderPath: '/repo',
      createdAt: 0
    })
    const { state, evicted } = reconcile(reg, ['synthetic-1'], 0)
    expect(list(state, { now: 0 })).toEqual([])
    expect(evicted).toHaveLength(1)
    expect(evicted[0]).toMatchObject({ syntheticId: 'synthetic-1', folderPath: '/repo' })
  })

  it('ACTIVELY removes a TTL-expired entry (not just hides it from list) and returns it', () => {
    const reg = register(emptyRegistry(), {
      syntheticId: 'synthetic-1',
      folderPath: '/repo',
      createdAt: 0
    })
    const { state, evicted } = reconcile(reg, [], INFLIGHT_TTL_MS + 1)
    expect(state).toEqual(emptyRegistry())
    expect(evicted.map((e) => e.syntheticId)).toEqual(['synthetic-1'])
  })

  it('leaves a live, unobserved entry untouched and returns no evictions', () => {
    const reg = register(emptyRegistry(), {
      syntheticId: 'synthetic-1',
      folderPath: '/repo',
      createdAt: 0
    })
    const { state, evicted } = reconcile(reg, ['some-other-id'], INFLIGHT_TTL_MS - 1)
    expect(list(state, { now: INFLIGHT_TTL_MS - 1 })).toHaveLength(1)
    expect(evicted).toEqual([])
  })

  it('does not mutate its inputs', () => {
    const reg = register(emptyRegistry(), { syntheticId: 's1', folderPath: '/repo', createdAt: 0 })
    const before = JSON.parse(JSON.stringify(reg))
    reconcile(reg, ['s1'], 0)
    expect(reg).toEqual(before)
  })
})

describe('inflight-session-registry — module shell (register/list/evict wired to a mutable store)', () => {
  beforeEach(() => _resetInflightRegistry())
  afterEach(() => _resetInflightRegistry())

  it('registerInflightSession then listInflightSessions surfaces the session', () => {
    registerInflightSession({ syntheticId: 'synthetic-9', folderPath: '/repo', createdAt: 0 })
    const out = listInflightSessions({ now: 0 })
    expect(out.map((e) => e.syntheticId)).toEqual(['synthetic-9'])
  })

  it('evictObservedSessions removes a session once it is observed on disk', () => {
    registerInflightSession({ syntheticId: 'synthetic-9', folderPath: '/repo', createdAt: 0 })
    evictObservedSessions(['synthetic-9'])
    expect(listInflightSessions({ now: 0 })).toEqual([])
  })

  it('evictObservedSessions returns the evicted entries (BUG-58 release wiring)', () => {
    registerInflightSession({ syntheticId: 'synthetic-9', folderPath: '/repo-a', createdAt: 0 })
    const evicted = evictObservedSessions(['synthetic-9'], 0)
    expect(evicted).toEqual([{ syntheticId: 'synthetic-9', folderPath: '/repo-a', createdAt: 0 }])
  })

  it('evictObservedSessions also reaps a TTL-expired entry that was never observed (BUG-58)', () => {
    registerInflightSession({ syntheticId: 'synthetic-9', folderPath: '/repo-a', createdAt: 0 })
    const evicted = evictObservedSessions([], INFLIGHT_TTL_MS + 1)
    expect(evicted.map((e) => e.syntheticId)).toEqual(['synthetic-9'])
    expect(listInflightSessions({ now: INFLIGHT_TTL_MS + 1 })).toEqual([])
  })

  it('evictObservedSessions returns [] when nothing resolves', () => {
    registerInflightSession({ syntheticId: 'synthetic-9', folderPath: '/repo-a', createdAt: 0 })
    expect(evictObservedSessions(['some-other-id'], 0)).toEqual([])
  })

  it('a failed dispatch registers nothing — the caller simply never calls register', () => {
    // Contract test: registerInflightSession is opt-in per successful dispatch;
    // never calling it (the failure path) leaves the registry empty.
    expect(listInflightSessions({ now: 0 })).toEqual([])
  })

  it('BUG-89 AC-1/AC-3: evictInflightSessionById removes the entry immediately on materialization, ahead of the TTL and independent of an observed-id read', () => {
    registerInflightSession({ syntheticId: 'synthetic-9', folderPath: '/repo-a', createdAt: 0 })
    const evicted = evictInflightSessionById('synthetic-9')
    expect(evicted).toEqual({ syntheticId: 'synthetic-9', folderPath: '/repo-a', createdAt: 0 })
    expect(listInflightSessions({ now: 0 })).toEqual([])
  })

  it('BUG-89 AC-2: evicts even when nothing is waiting on the id — the registry has no notion of a parked waiter', () => {
    // The late-notify case: a create_session ACK already timed out with
    // SPAWN_NOT_MATERIALIZED (its awaitMaterialization waiter is long gone),
    // yet the session finally materializes. The registry entry and its
    // reservation must still clear — evictInflightSessionById never consults
    // any waiter table, so this is identical to the "waiter parked" case from
    // the registry's point of view.
    registerInflightSession({ syntheticId: 'synthetic-late', folderPath: '/repo-b', createdAt: 0 })
    const evicted = evictInflightSessionById('synthetic-late')
    expect(evicted).not.toBeNull()
    expect(listInflightSessions({ now: 0 })).toEqual([])
  })

  it('evictInflightSessionById returns null and is a no-op for an unknown id', () => {
    registerInflightSession({ syntheticId: 'synthetic-9', folderPath: '/repo-a', createdAt: 0 })
    expect(evictInflightSessionById('some-other-id')).toBeNull()
    expect(listInflightSessions({ now: 0 })).toHaveLength(1)
  })
})
