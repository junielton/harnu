/**
 * The renderer IPC of the command channel (T389 P2W1 §7.6): the one diagnostics action, and the
 * debug-only enqueue route that must not exist unless Harnu main started with the variable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandOutcome } from '../../src/main/companion/command-types'
import type { EnqueueResult } from '../../src/main/companion/command-channel'

const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp' },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => void handlers.set(ch, fn),
    on: (): void => undefined
  },
  shell: { showItemInFolder: (): void => undefined }
}))

import {
  debugEnqueue,
  pingSession,
  registerCompanionIpc,
  type CompanionIpcExtras
} from '../../src/main/companion/companion-ipc'

const extras = (over: Partial<CompanionIpcExtras> = {}): CompanionIpcExtras => ({
  identityClaims: () => [],
  identityOutcome: () => undefined,
  restartListener: async () => undefined,
  status: () => ({}) as never,
  stagedDir: async () => null,
  ...over
})
const host = { diagnostics: () => ({}) as never, mintSpawnToken: () => null }

beforeEach(() => handlers.clear())

describe('registration', () => {
  it('debug route is off by default', () => {
    registerCompanionIpc(host, extras())
    expect(handlers.has('companion:debug:enqueue')).toBe(false)
    expect(handlers.has('companion:diagnostics:ping')).toBe(true)
  })

  it('debug route is off when the flag is false', () => {
    registerCompanionIpc(host, extras({ debug: false }))
    expect(handlers.has('companion:debug:enqueue')).toBe(false)
  })

  it('the route exists only with the flag', () => {
    registerCompanionIpc(host, extras({ debug: true }))
    expect(handlers.has('companion:debug:enqueue')).toBe(true)
  })
})

const settled = (o: CommandOutcome): Promise<CommandOutcome> => Promise.resolve(o)
const okResult = (o: CommandOutcome): EnqueueResult => ({
  ok: true,
  cmd: 'cmd_1',
  n: 1,
  settled: settled(o)
})

describe('ping', () => {
  it('enqueues a flush and the channel-ok toast with the operator gesture', async () => {
    const seen: { name: string; args: unknown; cause: unknown }[] = []
    let t = 1_000
    const out = await pingSession(
      'key:pty-1',
      ((req: { name: string; args: unknown; cause: unknown }) => {
        seen.push(req)
        t += 40
        return okResult({ state: 'resulted', ok: true })
      }) as never,
      () => t
    )
    expect(seen.map((s) => s.name)).toEqual(['flush', 'ui.toast'])
    expect(seen[0]?.cause).toEqual({ kind: 'operator', gesture: 'diagnostics.ping' })
    expect(seen[1]?.args).toEqual({ text: 'Harnu mod channel check' })
    expect(out.ok).toBe(true)
    expect(out.roundTripMs).toBeGreaterThan(0)
    expect(out.outcomes.length).toBe(2)
  })

  it('a refused flush is reported with its reason and nothing is awaited', async () => {
    const out = await pingSession('key:pty-1', (() => ({
      ok: false,
      reason: 'STICKY_LEGACY'
    })) as never)
    expect(out).toEqual({ ok: false, roundTripMs: 0, refusal: 'STICKY_LEGACY', outcomes: [] })
  })

  it('a refused toast (shadow) is reported beside a working flush', async () => {
    let calls = 0
    const out = await pingSession('key:pty-1', (() =>
      ++calls === 1
        ? okResult({ state: 'resulted', ok: true })
        : { ok: false, reason: 'MODE_SHADOW' }) as never)
    expect(out.ok).toBe(false)
    expect(out.refusal).toBe('MODE_SHADOW')
    expect(out.outcomes.length).toBe(1)
  })

  it('a missing session key is refused without touching the queue', async () => {
    const send = vi.fn()
    expect(await pingSession(undefined, send as never)).toMatchObject({
      ok: false,
      refusal: 'NO_BINDING'
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('no answer within the wait is not ok', async () => {
    vi.useFakeTimers()
    try {
      const never = new Promise<CommandOutcome>(() => undefined)
      const p = pingSession('key:pty-1', (() => ({
        ok: true,
        cmd: 'cmd_1',
        n: 1,
        settled: never
      })) as never)
      await vi.advanceTimersByTimeAsync(5_001)
      expect(await p).toMatchObject({ ok: false, roundTripMs: 0, outcomes: [] })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('debug enqueue', () => {
  it('builds the debug gesture and maps a text id to the constant table', async () => {
    const seen: { name: string; args: unknown; cause: unknown }[] = []
    const out = await debugEnqueue(
      { sessionKey: 'key:pty-1', name: 'ui.status', textId: 'status-test' },
      ((req: { name: string; args: unknown; cause: unknown }) => {
        seen.push(req)
        return okResult({ state: 'resulted', ok: true })
      }) as never
    )
    expect(seen[0]).toMatchObject({
      name: 'ui.status',
      args: { text: 'Harnu mod status test' },
      cause: { kind: 'operator', gesture: 'debug' }
    })
    expect(out).toMatchObject({ ok: true, cmd: 'cmd_1', outcome: { state: 'resulted', ok: true } })
  })

  it('refuses a request that is not shaped like one, and free text', async () => {
    const send = vi.fn()
    for (const bad of [
      {},
      { sessionKey: 'k' },
      { sessionKey: 'k', name: 'rm -rf' },
      { sessionKey: 'k', name: 'ui.status', textId: 'not-a-text-id' },
      { sessionKey: 5, name: 'flush' }
    ]) {
      expect(await debugEnqueue(bad as never, send as never)).toEqual({
        ok: false,
        reason: 'BAD_REQUEST'
      })
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('passes the gate’s refusal back', async () => {
    const out = await debugEnqueue(
      { sessionKey: 'k', name: 'prompt.submit', args: { text: 'x' } },
      (() => ({ ok: false, reason: 'ORIGIN_DENIED' })) as never
    )
    expect(out).toEqual({ ok: false, reason: 'ORIGIN_DENIED' })
  })

  it('an unsettled command comes back with a null outcome after the wait', async () => {
    vi.useFakeTimers()
    try {
      const p = debugEnqueue({ sessionKey: 'k', name: 'session.compact', waitMs: 1_000 }, (() => ({
        ok: true,
        cmd: 'cmd_9',
        n: 3,
        settled: new Promise<CommandOutcome>(() => undefined)
      })) as never)
      await vi.advanceTimersByTimeAsync(1_001)
      expect(await p).toEqual({ ok: true, cmd: 'cmd_9', n: 3, outcome: null })
    } finally {
      vi.useRealTimers()
    }
  })
})
