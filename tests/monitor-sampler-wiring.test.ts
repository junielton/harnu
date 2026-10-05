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
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>()
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
    handle: (channel: string, cb: (...args: unknown[]) => unknown) => h.ipcHandlers.set(channel, cb)
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
const getWindow = (): unknown => ({ isDestroyed: () => false, webContents: { send } })

beforeEach(async () => {
  vi.resetModules()
  h.ipcHandlers.clear()
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
      ['monitor:policyGet', 'monitor:policySet', 'monitor:start', 'monitor:stop'].sort()
    )
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
