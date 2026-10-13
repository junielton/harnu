import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * T456 W1 (spec §3.3, §6.5): the System Monitor's own `LiveSession` list must carry what the
 * policy reads, or it mislabels a row. Before W1 the sampler omitted `ownsLiveMission`, so an
 * exempt mission owner read "next to be swept"; with W1 it also carries the park episode, so a
 * session inside a granted delay reads `declined`.
 */

const h = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  now: Date.now()
}))

vi.mock('electron', () => ({
  app: {
    getAppMetrics: () => [],
    getPath: () => '/nonexistent-harnu-test-userdata'
  },
  ipcMain: {
    handle: (channel: string, cb: (...args: unknown[]) => unknown) => h.ipcHandlers.set(channel, cb)
  }
}))

vi.mock('../src/main/pty', () => {
  const base = {
    pid: process.pid,
    kind: 'claude-resume',
    startedAt: h.now - 5 * 60 * 60_000,
    lastActivityAt: h.now - 3 * 60 * 60_000,
    lastFocusedAt: h.now - 3 * 60 * 60_000,
    isSelected: false,
    taskState: 'idle'
  }
  return {
    livePtyDescriptors: () => [
      { ...base, ptyId: 'p1', sessionKey: 'owner', ownsLiveMission: true, episode: null },
      {
        ...base,
        ptyId: 'p2',
        sessionKey: 'asked',
        ownsLiveMission: false,
        episode: {
          firstDeclineAt: h.now,
          declines: 3,
          until: h.now + 9 * 60_000,
          reasons: ['background-task'],
          counts: { 'background-task': 2 }
        }
      },
      { ...base, ptyId: 'p3', sessionKey: 'plain', ownsLiveMission: false, episode: null }
    ]
  }
})

vi.mock('../src/main/hibernation', () => ({
  hibernatedKeys: () => new Set<string>(['parked-neg', 'parked-plain', 'parked-woken']),
  parkHistory: () => [
    // An older, already-woken park of the same session must not be read as its current one.
    {
      sessionKey: 'parked-woken',
      parkedAt: 1,
      wokenAt: 2,
      wakeGesture: 'select',
      negotiation: { declines: 9, reasons: ['turn'], why: 'limit' }
    },
    {
      sessionKey: 'parked-neg',
      parkedAt: 3,
      wokenAt: null,
      wakeGesture: null,
      negotiation: { declines: 8, reasons: ['background-task'], why: 'limit' }
    },
    { sessionKey: 'parked-plain', parkedAt: 4, wokenAt: null, wakeGesture: null }
  ]
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
})

describe('sampler — the LiveSession it explains', () => {
  it('reads mission-owner for an exempt owner and declined for a deferred session', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerMonitorHandlers(getWindow as any)
    await h.ipcHandlers.get('monitor:start')?.()
    const [, payload] = send.mock.calls.find(([c]) => c === 'monitor:sample')!
    const reason = (key: string): string =>
      payload.sessions.find((s: { sessionKey: string }) => s.sessionKey === key).reason
    expect(reason('owner')).toBe('mission-owner')
    expect(reason('asked')).toBe('declined')
    expect(reason('plain')).toBe('hard-idle')
  })
})

describe('sampler — T456 W3 payload', () => {
  async function sample(): Promise<{
    sessions: Array<Record<string, unknown> & { sessionKey: string }>
  }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerMonitorHandlers(getWindow as any)
    await h.ipcHandlers.get('monitor:start')?.()
    return send.mock.calls.find(([c]) => c === 'monitor:sample')![1]
  }

  it('hands a declined row what the chip needs: count, max, reasons, counts, wait', async () => {
    const { sessions } = await sample()
    const asked = sessions.find((s) => s.sessionKey === 'asked')!
    expect(asked.declined).toEqual({
      declines: 3,
      max: 8,
      reasons: ['background-task'],
      counts: { 'background-task': 2 },
      retryInMs: expect.any(Number)
    })
    const retry = (asked.declined as { retryInMs: number }).retryInMs
    expect(retry).toBeGreaterThan(8 * 60_000)
    expect(retry).toBeLessThanOrEqual(9 * 60_000)
  })

  it('a row that is not declining carries no `declined`', async () => {
    const { sessions } = await sample()
    for (const key of ['owner', 'plain']) {
      expect(sessions.find((s) => s.sessionKey === key)!.declined ?? null).toBeNull()
    }
  })

  it('a parked row carries the open ledger entry’s negotiation, never an older woken one', async () => {
    const { sessions } = await sample()
    const byKey = (k: string) => sessions.find((s) => s.sessionKey === k)!
    expect(byKey('parked-neg').negotiation).toEqual({
      declines: 8,
      reasons: ['background-task'],
      why: 'limit'
    })
    expect(byKey('parked-plain').negotiation ?? null).toBeNull()
    expect(byKey('parked-woken').negotiation ?? null).toBeNull()
  })

  it('a declining session produces no toast, notification or sound — only the monitor sample (§6.5)', async () => {
    await sample()
    const channels = new Set(send.mock.calls.map(([c]) => c as string))
    expect([...channels].every((c) => c.startsWith('monitor:'))).toBe(true)
  })
})
