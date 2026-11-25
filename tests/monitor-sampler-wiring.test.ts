import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Manual-verification-as-a-test for T127 S1's done criterion: "a manual
 * `monitor:start` produces `monitor:sample` pushes and `monitor:heap`
 * heartbeats." Exercises `sampler.ts`'s real imperative shell (the actual
 * `/proc` walk on this Linux CI box, the real `explainFleet`/`aggregateSubtree`
 * pure cores) with only `electron`, `pty.ts`, and `hibernation.ts` doubled —
 * same harness shape as `tests/usage-poller.test.ts`.
 */

const h = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  ipcListeners: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: {
    getAppMetrics: () => [
      {
        pid: process.pid,
        type: 'Browser',
        cpu: { percentCPUUsage: 3.2 },
        memory: { workingSetSize: 1024 }
      }
    ],
    getPath: () =>
      '/tmp/claude-1000/-home-u-Workspace-me-harnu--claude-worktrees-feat-system-monitor-s1/1a8b5504-95c7-4832-8978-9e19b4d39df4/scratchpad'
  },
  ipcMain: {
    handle: (channel: string, cb: (...args: unknown[]) => unknown) =>
      h.ipcHandlers.set(channel, cb),
    on: (channel: string, cb: (...args: unknown[]) => unknown) => h.ipcListeners.set(channel, cb)
  }
}))

vi.mock('../src/main/pty', () => ({
  livePtyDescriptors: () => [
    {
      ptyId: 'pty-1',
      sessionKey: 'sess-live',
      pid: process.pid, // a real, readable /proc/<pid> on this box
      kind: 'claude-resume',
      startedAt: Date.now() - 120_000,
      lastActivityAt: Date.now() - 5_000,
      lastFocusedAt: Date.now() - 5_000,
      isSelected: false,
      taskState: 'idle'
    }
  ]
}))

vi.mock('../src/main/hibernation', () => ({
  hibernatedKeys: () => new Set(['sess-parked'])
}))

type Mod = typeof import('../src/main/monitor/sampler')

let mod: Mod
const send = vi.fn()
const getWindow = (): unknown => ({
  isDestroyed: () => false,
  webContents: { send, getOSProcessId: () => process.pid }
})

beforeEach(async () => {
  vi.resetModules()
  h.ipcHandlers.clear()
  h.ipcListeners.clear()
  send.mockClear()
  mod = await import('../src/main/monitor/sampler')
})

afterEach(() => {
  mod.stopHeartbeat()
  mod.stopFullSamplerForced()
  vi.useRealTimers()
})

describe('registerMonitorHandlers — the always-on heartbeat', () => {
  it('pushes a monitor:heap sample immediately on registration, unconditionally', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerMonitorHandlers(getWindow as any)
    const heapCalls = send.mock.calls.filter(([channel]) => channel === 'monitor:heap')
    expect(heapCalls).toHaveLength(1)
    const [, payload] = heapCalls[0]
    expect(payload).toMatchObject({ status: expect.stringMatching(/^(ok|warn|critical)$/) })
    expect(typeof payload.usedBytes).toBe('number')
    expect(typeof payload.limitBytes).toBe('number')
  })

  it('registers monitor:start/stop/policyGet/policySet handlers — monitor:park is GONE (BUG-69)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerMonitorHandlers(getWindow as any)
    expect([...h.ipcHandlers.keys()].sort()).toEqual(
      [
        'monitor:injectStall',
        'monitor:policyGet',
        'monitor:policySet',
        'monitor:stallEnabled',
        'monitor:start',
        'monitor:stop'
      ].sort()
    )
    expect([...h.ipcListeners.keys()]).toEqual(['monitor:stallReport'])
  })
})

describe('monitor:start — the full sampler, refcounted', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerMonitorHandlers(getWindow as any)
    send.mockClear()
  })

  it('pushes a monitor:sample immediately on monitor:start, with both groups populated', async () => {
    await h.ipcHandlers.get('monitor:start')?.()
    const sampleCalls = send.mock.calls.filter(([channel]) => channel === 'monitor:sample')
    expect(sampleCalls).toHaveLength(1)
    const [, payload] = sampleCalls[0]
    expect(payload.harnu).toEqual([
      expect.objectContaining({
        pid: process.pid,
        name: 'main',
        cpuPct: 3.2,
        rssBytes: 1024 * 1024
      })
    ])
    const live = payload.sessions.find((s: { sessionKey: string }) => s.sessionKey === 'sess-live')
    const parked = payload.sessions.find(
      (s: { sessionKey: string }) => s.sessionKey === 'sess-parked'
    )
    expect(live).toMatchObject({ state: 'live' })
    expect(parked).toMatchObject({ state: 'parked', cpuPct: null, rssBytes: null, procs: [] })
  })

  it('a stray monitor:stop cannot silence a still-open sibling (refcount)', async () => {
    vi.useFakeTimers()
    await h.ipcHandlers.get('monitor:start')?.() // ref 1
    await h.ipcHandlers.get('monitor:start')?.() // ref 2 (e.g. two mounted panes)
    await h.ipcHandlers.get('monitor:stop')?.() // ref 1 — still open
    send.mockClear()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(send.mock.calls.some(([channel]) => channel === 'monitor:sample')).toBe(true)
  })

  it('stops pushing monitor:sample once every start has a matching stop', async () => {
    vi.useFakeTimers()
    await h.ipcHandlers.get('monitor:start')?.()
    await h.ipcHandlers.get('monitor:stop')?.()
    send.mockClear()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(send.mock.calls.some(([channel]) => channel === 'monitor:sample')).toBe(false)
  })
})

describe('monitor:policyGet / monitor:policySet', () => {
  it('round-trips a patch through the persisted policy', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerMonitorHandlers(getWindow as any)
    const before = await h.ipcHandlers.get('monitor:policyGet')?.()
    expect(before).toMatchObject({ maxLive: expect.any(Number) })
    const after = await h.ipcHandlers.get('monitor:policySet')?.(null, { maxLive: 7 })
    expect(after).toMatchObject({ maxLive: 7 })
    const reread = await h.ipcHandlers.get('monitor:policyGet')?.()
    expect(reread).toMatchObject({ maxLive: 7 })
  })
})

describe('the stall monitor in the sample (T697)', () => {
  const summary = {
    main: { over50: 2, over100: 1, over250: 0, offenders: [] },
    renderer: { over50: 1, over100: 1, over250: 1, offenders: [] }
  }
  const stub = {
    summary: () => summary,
    mainBusyPct: () => 37.4,
    rendererStalledMs: () => 3_000,
    reportRenderer: vi.fn(() => 1),
    injectMainStall: vi.fn(),
    stop: async () => undefined
  }

  it('carries both threads, with the main thread measured and the renderer read from its own thread CPU', async () => {
    const { setStallMonitor } = await import('../src/main/monitor/stall-registry')
    setStallMonitor(stub)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerMonitorHandlers(getWindow as any)
    send.mockClear()
    await h.ipcHandlers.get('monitor:start')?.()
    const [, payload] = send.mock.calls.find(([c]) => c === 'monitor:sample') ?? []
    expect(payload.stalls.main).toMatchObject({ over50: 2, busyPct: 37.4, busyApprox: false })
    expect(payload.stalls.renderer).toMatchObject({ over250: 1, busyApprox: false })
    setStallMonitor(null)
  })

  it('leaves the block out when the monitor is off, and reports the setting', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerMonitorHandlers(getWindow as any)
    send.mockClear()
    await h.ipcHandlers.get('monitor:start')?.()
    const [, payload] = send.mock.calls.find(([c]) => c === 'monitor:sample') ?? []
    expect(payload.stalls).toBeUndefined()
    expect(h.ipcHandlers.get('monitor:stallEnabled')?.()).toBe(false)
  })

  it('forwards renderer reports to the monitor, and injects a stall only when the env allows it', async () => {
    const { setStallMonitor } = await import('../src/main/monitor/stall-registry')
    setStallMonitor(stub)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerMonitorHandlers(getWindow as any)
    h.ipcListeners.get('monitor:stallReport')?.({}, [{ x: 1 }])
    expect(stub.reportRenderer).toHaveBeenCalledWith([{ x: 1 }])
    expect(h.ipcHandlers.get('monitor:injectStall')?.({}, 'main', 200)).toBe(false)
    expect(stub.injectMainStall).not.toHaveBeenCalled()
    process.env.HARNU_STALL_INJECT = '1'
    try {
      expect(h.ipcHandlers.get('monitor:injectStall')?.({}, 'main', 200)).toBe(true)
      expect(stub.injectMainStall).toHaveBeenCalledWith(200)
      expect(h.ipcHandlers.get('monitor:injectStall')?.({}, 'nope', 200)).toBe(false)
    } finally {
      delete process.env.HARNU_STALL_INJECT
      setStallMonitor(null)
    }
  })
})
