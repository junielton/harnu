import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  runCreateSession,
  MATERIALIZE_DEADLINE_MS,
  type CreateSessionDeps,
  type Materialization
} from '../src/main/mcp/create-session-core'
import {
  tryReserveInFlight,
  attachSyntheticId,
  releaseInFlight,
  releaseIfCurrentHolder,
  _resetInFlightRegistry
} from '../src/main/mcp/agent-inflight-registry'

/**
 * ADR-0003 / this card: `create_session`'s `ok:true` must mean the session
 * MATERIALIZED, never merely "dispatched". `runCreateSession` is the pure
 * decision `createSessionHandler` (tool-handlers.ts, a thin shell) delegates
 * to — bridge/registry collaborators are injected here as plain fakes, no
 * Electron, no fake timers (per ADR-0001).
 */

function harness(overrides: Partial<CreateSessionDeps> = {}): {
  deps: CreateSessionDeps
  released: string[]
  attached: Array<{ folder: string; syntheticId: string }>
} {
  const released: string[] = []
  const attached: Array<{ folder: string; syntheticId: string }> = []
  const deps: CreateSessionDeps = {
    dispatchCreate: vi.fn(async () => ({ syntheticId: 'synthetic-1', correlationId: 'corr-1' })),
    awaitMaterialization: vi.fn(async () => null),
    tryReserve: vi.fn(() => true),
    attachSyntheticId: vi.fn((folder: string, syntheticId: string) => {
      attached.push({ folder, syntheticId })
    }),
    release: vi.fn((folder: string) => {
      released.push(folder)
    }),
    ...overrides
  }
  return { deps, released, attached }
}

function parse(result: Awaited<ReturnType<typeof runCreateSession>>): Record<string, unknown> {
  const first = result.content[0]
  expect(first.type).toBe('text')
  return JSON.parse((first as { text: string }).text)
}

describe('runCreateSession — materialization', () => {
  it('returns ok:false and holds the reservation when the spawn never materializes (BUG-58: does NOT release)', async () => {
    const { deps, released } = harness({
      awaitMaterialization: vi.fn(async () => null)
    })
    const result = await runCreateSession('/home/u/repo', { folder: '/home/u/repo' }, {}, deps)
    expect(result.isError).toBe(true)
    const payload = parse(result)
    expect(payload.error).toBe('SPAWN_NOT_MATERIALIZED')
    // BUG-58: a materialization timeout no longer releases the folder's
    // single-occupancy claim — the dispatched session may still land, and a
    // blind retry into a freed folder would race a second process into it.
    // Ownership of the eventual release transfers to the in-flight registry's
    // eviction path (materialize-late or TTL reap), not runCreateSession.
    expect(released).toEqual([])
  })

  it('carries the syntheticId in the timeout ACK so the caller can adopt/poll it (BUG-58)', async () => {
    const { deps } = harness({
      dispatchCreate: vi.fn(async () => ({ syntheticId: 'synthetic-timeout-1' })),
      awaitMaterialization: vi.fn(async () => null)
    })
    const result = await runCreateSession('/home/u/repo', { folder: '/home/u/repo' }, {}, deps)
    const payload = parse(result)
    expect(payload.error).toBe('SPAWN_NOT_MATERIALIZED')
    expect(payload.syntheticId).toBe('synthetic-timeout-1')
  })

  it('returns ok:true with the materialized sessionId when materialization lands in time', async () => {
    const mat: Materialization = {
      syntheticId: 'synthetic-1',
      sessionId: 'real-uuid-1',
      folder: '/home/u/repo'
    }
    const { deps } = harness({
      awaitMaterialization: vi.fn(async () => mat)
    })
    const result = await runCreateSession(
      '/home/u/repo',
      { folder: '/home/u/repo' },
      { effectiveModel: 'sonnet', effectiveEffort: 'high' },
      deps
    )
    expect(result.isError).toBeUndefined()
    const payload = parse(result)
    expect(payload.ok).toBe(true)
    expect(payload.effectiveModel).toBe('sonnet')
    expect((payload.result as Record<string, unknown>).sessionId).toBe('real-uuid-1')
  })

  it('never claims ok:true when the dispatch itself failed (e.g. FOLDER_NOT_FOUND) — never awaits materialization', async () => {
    const awaitMaterialization = vi.fn(async () => null)
    const { deps } = harness({
      dispatchCreate: vi.fn(async () => ({ error: 'FOLDER_ADOPT_TIMEOUT' })),
      awaitMaterialization
    })
    const result = await runCreateSession('/home/u/repo', { folder: '/home/u/repo' }, {}, deps)
    const payload = parse(result)
    expect(payload.ok).toBe(false)
    expect(awaitMaterialization).not.toHaveBeenCalled()
  })

  it('records the syntheticId against the folder before awaiting materialization (AC5 lookup wiring)', async () => {
    const { deps, attached } = harness({ awaitMaterialization: vi.fn(async () => null) })
    await runCreateSession('/home/u/repo', { folder: '/home/u/repo' }, {}, deps)
    expect(attached).toEqual([{ folder: '/home/u/repo', syntheticId: 'synthetic-1' }])
  })

  it('passes the configured deadline through to awaitMaterialization', async () => {
    const awaitMaterialization = vi.fn(async () => null)
    const { deps } = harness({ awaitMaterialization })
    await runCreateSession('/home/u/repo', { folder: '/home/u/repo' }, {}, deps, 5_000)
    expect(awaitMaterialization).toHaveBeenCalledWith('synthetic-1', 5_000)
  })

  it('defaults the deadline to MATERIALIZE_DEADLINE_MS', async () => {
    const awaitMaterialization = vi.fn(async () => null)
    const { deps } = harness({ awaitMaterialization })
    await runCreateSession('/home/u/repo', { folder: '/home/u/repo' }, {}, deps)
    expect(awaitMaterialization).toHaveBeenCalledWith('synthetic-1', MATERIALIZE_DEADLINE_MS)
  })
})

describe('runCreateSession — single occupancy (AC3)', () => {
  it('refuses (steerable, never a silent queue) when the folder already has a spawn in flight', async () => {
    const dispatchCreate = vi.fn(async () => ({ syntheticId: 'synthetic-1' }))
    const { deps } = harness({
      tryReserve: vi.fn(() => false),
      dispatchCreate
    })
    const result = await runCreateSession('/home/u/repo', { folder: '/home/u/repo' }, {}, deps)
    expect(result.isError).toBe(true)
    const payload = parse(result)
    expect(payload.error).toBe('SESSION_ALREADY_IN_FLIGHT')
    // Never dispatched at all — the refusal happens before any renderer round trip.
    expect(dispatchCreate).not.toHaveBeenCalled()
  })

  it('always releases occupancy exactly once, even when dispatchCreate throws', async () => {
    const { deps, released } = harness({
      dispatchCreate: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    await expect(
      runCreateSession('/home/u/repo', { folder: '/home/u/repo' }, {}, deps)
    ).rejects.toThrow('boom')
    expect(released).toEqual(['/home/u/repo'])
  })
})

describe('runCreateSession — post-deadline commit guard (BUG-33 AC5)', () => {
  it('refuses to dispatch when the deadline already fired, without ever calling dispatchCreate', async () => {
    const dispatchCreate = vi.fn(async () => ({ syntheticId: 'synthetic-1' }))
    const { deps, released } = harness({ dispatchCreate, deadlineFired: () => true })
    const result = await runCreateSession('/home/u/repo', { folder: '/home/u/repo' }, {}, deps)
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('DEADLINE_FIRED')
    expect(dispatchCreate).not.toHaveBeenCalled()
    // The occupancy claim is still released so a fresh retry is never
    // refused as a phantom duplicate (mirrors AC3's guarantee).
    expect(released).toEqual(['/home/u/repo'])
  })

  it('dispatches normally when no deadlineFired guard is supplied (backward compatible)', async () => {
    const dispatchCreate = vi.fn(async () => ({ syntheticId: 'synthetic-1' }))
    const { deps } = harness({ dispatchCreate, awaitMaterialization: vi.fn(async () => null) })
    await runCreateSession('/home/u/repo', { folder: '/home/u/repo' }, {}, deps)
    expect(dispatchCreate).toHaveBeenCalled()
  })

  it('dispatches normally when deadlineFired reports false', async () => {
    const dispatchCreate = vi.fn(async () => ({ syntheticId: 'synthetic-1' }))
    const { deps } = harness({
      dispatchCreate,
      deadlineFired: () => false,
      awaitMaterialization: vi.fn(async () => null)
    })
    await runCreateSession('/home/u/repo', { folder: '/home/u/repo' }, {}, deps)
    expect(dispatchCreate).toHaveBeenCalled()
  })
})

describe('runCreateSession — BUG-58: held reservation closes the double-spawn hole', () => {
  // Wires runCreateSession to the REAL agent-inflight-registry.ts (not the
  // mock harness) to prove the end-to-end contract: a timeout holds the
  // folder's occupancy claim, a retry into that same folder is refused, and
  // the claim is only released once the inflight registration resolves
  // (materializes late or is reaped) — exactly what tool-handlers.ts wires
  // via evictObservedSessions + releaseIfCurrentHolder.
  beforeEach(() => _resetInFlightRegistry())
  afterEach(() => _resetInFlightRegistry())

  function realDeps(overrides: Partial<CreateSessionDeps> = {}): CreateSessionDeps {
    return {
      dispatchCreate: vi.fn(async () => ({ syntheticId: 'synthetic-real-1' })),
      awaitMaterialization: vi.fn(async () => null),
      tryReserve: (f) => tryReserveInFlight(f),
      attachSyntheticId: (f, syntheticId) => attachSyntheticId(f, syntheticId),
      release: (f) => releaseInFlight(f),
      ...overrides
    }
  }

  it('a retry into the same folder is refused with SESSION_ALREADY_IN_FLIGHT after a timeout', async () => {
    const first = await runCreateSession('/home/u/repo', { folder: '/home/u/repo' }, {}, realDeps())
    expect(parse(first).error).toBe('SPAWN_NOT_MATERIALIZED')

    const retry = await runCreateSession('/home/u/repo', { folder: '/home/u/repo' }, {}, realDeps())
    expect(parse(retry).error).toBe('SESSION_ALREADY_IN_FLIGHT')
  })

  it('releases the reservation once the inflight registration resolves, allowing a fresh retry', async () => {
    const timedOut = await runCreateSession(
      '/home/u/repo',
      { folder: '/home/u/repo' },
      {},
      realDeps()
    )
    const syntheticId = parse(timedOut).syntheticId as string
    expect(syntheticId).toBe('synthetic-real-1')
    expect(tryReserveInFlight('/home/u/repo')).toBe(false) // still held

    // The moment the spawn is later observed on disk (or reaped), the SAME
    // release path tool-handlers.ts wires fires here directly.
    releaseIfCurrentHolder('/home/u/repo', syntheticId)

    expect(tryReserveInFlight('/home/u/repo')).toBe(true) // freed
    releaseInFlight('/home/u/repo') // cleanup for the next test
  })

  it('does NOT release a folder reservation belonging to a different (newer) syntheticId', async () => {
    // Simulate: the timed-out spawn's folder claim was already released by
    // some other path and re-reserved by a brand-new create_session before
    // the stale eviction runs.
    tryReserveInFlight('/home/u/repo')
    attachSyntheticId('/home/u/repo', 'synthetic-new')

    releaseIfCurrentHolder('/home/u/repo', 'synthetic-stale')

    expect(tryReserveInFlight('/home/u/repo')).toBe(false) // still held by the new spawn
  })
})
