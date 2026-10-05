import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUsageStore } from '../src/renderer/src/stores/usage'
import type { SessionTelemetry } from '../src/main/statusline-parse'

/**
 * Usage store unit tests (plan-usage-widget spec). Default `node` vitest env, so
 * `window.api` is stubbed with spies — the store only talks to main through it.
 */

type UpdatedCb = (s: unknown) => void
let updatedCb: UpdatedCb | null = null
let telemetryCb: UpdatedCb | null = null

const EMPTY_TELEMETRY = {
  perSession: [],
  fleet: {
    totalCostUsd: 0,
    sessionCount: 0,
    fiveHour: null,
    sevenDay: null,
    fiveHourAtMs: null,
    sevenDayAtMs: null
  }
}

function telemetry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    perSession: [],
    fleet: {
      totalCostUsd: 0.5,
      sessionCount: 2,
      // Future reset + fresh provenance so the merge treats the cockpit window
      // as live and newer than the snapshot's fetchedAtMs.
      fiveHour: { usedPercent: 23.5, resetsAtMs: Date.now() + 3_600_000 },
      sevenDay: null,
      fiveHourAtMs: Date.now(),
      sevenDayAtMs: null,
      ...((over.fleet as Record<string, unknown>) ?? {})
    },
    ...over
  }
}

/** A per-session telemetry entry (as tailed from the statusLine inbox). */
function sessTele(over: Partial<SessionTelemetry> & { sessionId: string }): SessionTelemetry {
  return {
    sessionId: over.sessionId,
    cwd: null,
    modelId: 'm',
    modelName: 'M',
    costUsd: null,
    linesAdded: null,
    linesRemoved: null,
    durationMs: null,
    contextPercent: null,
    contextWindowSize: null,
    exceeds200k: false,
    effortLevel: null,
    thinkingEnabled: false,
    outputStyle: null,
    pr: null,
    rateLimits: { fiveHour: null, sevenDay: null },
    updatedAtMs: 0,
    ...over
  }
}

const bucket = (key: string, usedPercent: number): Record<string, unknown> => ({
  key,
  usedPercent,
  resetsAtText: 'resets soon',
  resetsAtMs: null
})

function snap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true,
    subscription: true,
    session: bucket('session', 39),
    weekAll: bucket('week_all', 11),
    perModel: [bucket('Sonnet', 5)],
    fetchedAtMs: 1000,
    stale: false,
    status: 'ready',
    ...overrides
  }
}

function makeApi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    usageGet: vi.fn(async () => snap()),
    usageRefresh: vi.fn(async () => snap({ session: bucket('session', 50) })),
    onUsageUpdated: vi.fn((cb: UpdatedCb) => {
      updatedCb = cb
      return () => {}
    }),
    telemetryGet: vi.fn(async () => EMPTY_TELEMETRY),
    onTelemetryUpdated: vi.fn((cb: UpdatedCb) => {
      telemetryCb = cb
      return () => {}
    }),
    ...overrides
  }
}

describe('useUsageStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    updatedCb = null
    telemetryCb = null
    vi.stubGlobal('window', { api: makeApi() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('init adopts the snapshot returned by usageGet', async () => {
    const store = useUsageStore()
    await store.init()
    expect(window.api.usageGet).toHaveBeenCalled()
    expect(store.snapshot?.session?.usedPercent).toBe(39)
    expect(store.available).toBe(true)
  })

  it('available is false before init (snapshot null)', () => {
    expect(useUsageStore().available).toBe(false)
  })

  it('reports loading before init so the panel can show a skeleton (not hide)', () => {
    const store = useUsageStore()
    expect(store.status).toBe('loading')
    expect(store.loading).toBe(true)
  })

  it('status becomes ready (not loading) once a usable snapshot arrives', async () => {
    const store = useUsageStore()
    await store.init()
    expect(store.status).toBe('ready')
    expect(store.loading).toBe(false)
  })

  it('an unavailable push flips status to unavailable so the panel hides', async () => {
    const store = useUsageStore()
    await store.init()
    updatedCb!(
      snap({ available: false, session: null, weekAll: null, perModel: [], status: 'unavailable' })
    )
    expect(store.status).toBe('unavailable')
    expect(store.loading).toBe(false)
  })

  it('a usage:updated push replaces the snapshot', async () => {
    const store = useUsageStore()
    await store.init()
    expect(updatedCb).toBeTypeOf('function')
    updatedCb!(snap({ session: bucket('session', 77) }))
    expect(store.snapshot?.session?.usedPercent).toBe(77)
  })

  it('buckets returns session, weekAll, then per-model in order, skipping nulls', async () => {
    const store = useUsageStore()
    await store.init()
    expect(store.buckets.map((b) => b.key)).toEqual(['session', 'week_all', 'Sonnet'])
  })

  it('buckets is empty when unavailable', async () => {
    vi.stubGlobal('window', {
      api: makeApi({
        usageGet: vi.fn(async () =>
          snap({ available: false, session: null, weekAll: null, perModel: [] })
        )
      })
    })
    const store = useUsageStore()
    await store.init()
    expect(store.buckets).toEqual([])
    expect(store.available).toBe(false)
  })

  it('refresh adopts the snapshot returned by usageRefresh', async () => {
    const store = useUsageStore()
    await store.init()
    await store.refresh()
    expect(window.api.usageRefresh).toHaveBeenCalled()
    expect(store.snapshot?.session?.usedPercent).toBe(50)
  })

  it('double init does not subscribe twice', async () => {
    const store = useUsageStore()
    await store.init()
    await store.init()
    expect((window.api.onUsageUpdated as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('rateLimits merges per window: /usage fills it, a fresher cockpit overrides', async () => {
    const store = useUsageStore()
    await store.init()
    // The snapshot alone already yields windows (session → 5h, week_all → 7d).
    expect(store.rateLimits?.fiveHour?.usedPercent).toBe(39)
    expect(store.rateLimits?.fiveHour?.source).toBe('usage')
    expect(store.rateLimits?.sevenDay?.usedPercent).toBe(11)
    telemetryCb!(telemetry())
    // Cockpit is fresher for 5h → wins; 7d is still only known to /usage.
    expect(store.rateLimits?.fiveHour?.usedPercent).toBe(23.5)
    expect(store.rateLimits?.fiveHour?.source).toBe('statusline')
    expect(store.rateLimits?.sevenDay?.usedPercent).toBe(11)
    expect(store.rateLimitsUpdatedAtMs).toBe(1000) // oldest shown datum (the /usage 7d)
  })

  it('available is true from statusLine rate-limits even when /usage is unavailable', async () => {
    vi.stubGlobal('window', {
      api: makeApi({
        usageGet: vi.fn(async () =>
          snap({
            available: false,
            session: null,
            weekAll: null,
            perModel: [],
            status: 'unavailable'
          })
        ),
        telemetryGet: vi.fn(async () => telemetry())
      })
    })
    const store = useUsageStore()
    await store.init()
    expect(store.available).toBe(true)
    expect(store.status).toBe('ready')
  })

  it('fleetSummary reflects the pushed telemetry cost and tab count', async () => {
    const store = useUsageStore()
    await store.init()
    expect(store.fleetSummary).toBeNull() // empty at init
    telemetryCb!(telemetry())
    expect(store.fleetSummary).toEqual({ totalCostUsd: 0.5, sessionCount: 2 })
  })

  // --- telemetryForSession — BUG-8 synthetic-session correlation --------------
  type Sess = { sessionId: string; projectPath: string; synthetic?: boolean }

  it('telemetryForSession returns the exact-id match for a real session', async () => {
    const store = useUsageStore()
    await store.init()
    const real = sessTele({ sessionId: 'real-uuid', cwd: '/home/u/repo' })
    telemetryCb!(telemetry({ perSession: [real] }))
    const sess: Sess = { sessionId: 'real-uuid', projectPath: '/home/u/repo' }
    expect(store.telemetryForSession(sess)).toMatchObject({ sessionId: 'real-uuid' })
  })

  it('telemetryForSession falls back to cwd for a synthetic session (the bug)', async () => {
    const store = useUsageStore()
    await store.init()
    // Blob keyed by the REAL uuid + cwd; the footer still holds the synthetic id.
    telemetryCb!(
      telemetry({ perSession: [sessTele({ sessionId: 'real-uuid', cwd: '/home/u/repo' })] })
    )
    const synth: Sess = { sessionId: 'synthetic-abc', projectPath: '/home/u/repo', synthetic: true }
    expect(store.telemetryForSession(synth)).toMatchObject({ sessionId: 'real-uuid' })
  })

  it('telemetryForSession picks the freshest blob when two claudes share a cwd', async () => {
    const store = useUsageStore()
    await store.init()
    telemetryCb!(
      telemetry({
        perSession: [
          sessTele({ sessionId: 'a', cwd: '/home/u/repo', updatedAtMs: 100 }),
          sessTele({ sessionId: 'b', cwd: '/home/u/repo', updatedAtMs: 200 })
        ]
      })
    )
    const synth: Sess = { sessionId: 'synthetic-abc', projectPath: '/home/u/repo', synthetic: true }
    expect(store.telemetryForSession(synth)).toMatchObject({ sessionId: 'b' })
  })

  it('telemetryForSession does NOT borrow a neighbor blob for a non-synthetic session', async () => {
    const store = useUsageStore()
    await store.init()
    telemetryCb!(telemetry({ perSession: [sessTele({ sessionId: 'other', cwd: '/home/u/repo' })] }))
    const sess: Sess = { sessionId: 'missing', projectPath: '/home/u/repo' }
    expect(store.telemetryForSession(sess)).toBeNull()
  })

  it('telemetryForSession returns null when nothing matches the synthetic cwd', async () => {
    const store = useUsageStore()
    await store.init()
    telemetryCb!(
      telemetry({ perSession: [sessTele({ sessionId: 'x', cwd: '/home/u/elsewhere' })] })
    )
    const synth: Sess = { sessionId: 'synthetic-abc', projectPath: '/home/u/repo', synthetic: true }
    expect(store.telemetryForSession(synth)).toBeNull()
  })

  it('telemetryForSession returns null for a null session', async () => {
    const store = useUsageStore()
    await store.init()
    expect(store.telemetryForSession(null)).toBeNull()
  })
})
