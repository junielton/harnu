/**
 * T589: the feed that keeps a session's quiet rows in step with its missions. It re-reads the missions
 * of every live, enabled binding on a poll, sends `mission.state` when what the card draws changed
 * (debounced), sends it again at a hello, and stops when the binding ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMissionStateFeed } from '../../src/main/companion/mission-state'
import { MISSION_DEBOUNCE_MS, MISSION_POLL_MS } from '../../src/main/companion/contract'
import type { BindingView } from '../../src/main/companion/session-table'

const SID = '19cc0181-9f04-41a9-b93a-18231ee36b64'

const binding = (over: Partial<BindingView> = {}): BindingView =>
  ({
    key: 1,
    owner: { kind: 'pty', sessionKey: 'k1' },
    trust: 'operator',
    sid: SID,
    sessionKey: 'k1',
    cwd: '/work/acme/www',
    profile: 'interactive',
    cliVersion: '2.1.312',
    modVersion: '0.1.0',
    declared: ['ui.quietRows'],
    enabled: ['sense.identity', 'act.channel', 'ui.quietRows'],
    proven: [],
    lease: 'live',
    state: 'bound',
    helloAfterSpawnMs: 100,
    ...over
  }) as BindingView

const mission = (over: Record<string, unknown> = {}) => ({
  mission: {
    id: 'mnt-7be1529e',
    owner: { sessionId: SID },
    steps: [{ id: 'stp-2', title: 'phase A', kind: 'custom', links: [], blockers: [] }],
    blockers: []
  },
  title: 'Acme content migration',
  progress: {
    total: 1,
    current: { from: 1, to: 1 },
    allDone: false,
    done: 0,
    verified: 0,
    states: { 'stp-2': 'running' },
    leftBehind: [],
    unprovable: [],
    computedAt: 'x'
  },
  derived: { steps: [] },
  you: [],
  ...over
})

function rig() {
  type Fn = (...a: never[]) => void
  const handlers: Record<string, Fn[]> = {}
  const bus = {
    on: (name: string, fn: Fn) => {
      ;(handlers[name] ??= []).push(fn)
      return () => undefined
    }
  }
  let changeFn: ((b: BindingView) => void) | null = null
  const host = {
    bus,
    onBindingChange: (fn: (b: BindingView) => void) => {
      changeFn = fn
      return () => undefined
    }
  }
  const views = { current: [mission()] as unknown[] }
  const listViews = vi.fn(async (_folders: readonly string[]) => ({
    views: views.current,
    unreadable: [],
    shadowed: []
  }))
  const sent: { sid: string; args: { missions: { id: string; title: string }[] } }[] = []
  const send = vi.fn((req: { sid: string; args: never }) => {
    sent.push(req as never)
    return { ok: true } as const
  })
  const feed = createMissionStateFeed({
    host: host as never,
    listViews: listViews as never,
    send: send as never,
    log: () => undefined
  })
  const emit = (name: string, ...a: unknown[]) =>
    (handlers[name] ?? []).forEach((fn) => (fn as (...x: unknown[]) => void)(...a))
  return { feed, emit, views, listViews, sent, send, change: (b: BindingView) => changeFn?.(b) }
}

const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the mission state feed', () => {
  it('sends a session its missions at its hello, after the debounce', async () => {
    const r = rig()
    r.emit('hello', binding(), 'spawn')
    await flush(MISSION_DEBOUNCE_MS - 1)
    expect(r.sent).toHaveLength(0)
    await flush(5)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0].sid).toBe(SID)
    expect(r.sent[0].args.missions.map((m) => m.id)).toEqual(['mnt-7be1529e'])
    expect(r.listViews).toHaveBeenCalledWith(['/work/acme/www'])
    r.feed.dispose()
  })

  it('sends nothing to a session with no mission of its own', async () => {
    const r = rig()
    r.views.current = [
      mission({ mission: { ...mission().mission, owner: { sessionId: 'someone-else' } } })
    ]
    r.emit('hello', binding(), 'spawn')
    await flush(MISSION_DEBOUNCE_MS + MISSION_POLL_MS)
    expect(r.sent).toHaveLength(0)
    r.feed.dispose()
  })

  it('re-reads on a poll and sends only when what the card draws changed', async () => {
    const r = rig()
    r.emit('hello', binding(), 'spawn')
    await flush(MISSION_DEBOUNCE_MS + 5)
    expect(r.sent).toHaveLength(1)
    await flush(MISSION_POLL_MS + MISSION_DEBOUNCE_MS + 5) // same state: quiet
    expect(r.sent).toHaveLength(1)
    r.views.current = [
      mission({
        progress: {
          ...mission().progress,
          current: { from: 1, to: 1 },
          states: { 'stp-2': 'verified' },
          done: 1,
          verified: 1
        }
      })
    ]
    await flush(MISSION_POLL_MS + MISSION_DEBOUNCE_MS + 5)
    expect(r.sent).toHaveLength(2)
    r.feed.dispose()
  })

  it('a hello again (a reload, a resume) sends the state again, even when nothing changed', async () => {
    const r = rig()
    r.emit('hello', binding(), 'spawn')
    await flush(MISSION_DEBOUNCE_MS + 5)
    r.emit('hello', binding(), 'resume')
    await flush(MISSION_DEBOUNCE_MS + 5)
    expect(r.sent).toHaveLength(2)
    r.feed.dispose()
  })

  it('tells the mod when its last mission is gone, so no stale card is drawn', async () => {
    const r = rig()
    r.emit('hello', binding(), 'spawn')
    await flush(MISSION_DEBOUNCE_MS + 5)
    r.views.current = []
    await flush(MISSION_POLL_MS + MISSION_DEBOUNCE_MS + 5)
    expect(r.sent).toHaveLength(2)
    expect(r.sent[1].args.missions).toEqual([])
    await flush(MISSION_POLL_MS * 2) // and then nothing more
    expect(r.sent).toHaveLength(2)
    r.feed.dispose()
  })

  it('ignores a binding that is not interactive, has no feature, or has lost its lease', async () => {
    const r = rig()
    r.emit('hello', binding({ profile: 'external', key: 2 }), 'spawn')
    r.emit('hello', binding({ profile: 'headless', key: 3 }), 'spawn')
    r.emit('hello', binding({ enabled: ['sense.identity', 'act.channel'], key: 4 }), 'spawn')
    r.emit('hello', binding({ lease: 'lost', key: 5 }), 'spawn')
    await flush(MISSION_DEBOUNCE_MS + MISSION_POLL_MS)
    expect(r.sent).toHaveLength(0)
    expect(r.listViews).not.toHaveBeenCalled()
    r.feed.dispose()
  })

  it('stops reading when the binding ends, and when the feed is disposed', async () => {
    const r = rig()
    r.emit('hello', binding(), 'spawn')
    await flush(MISSION_DEBOUNCE_MS + 5)
    r.emit('end', binding({ state: 'ended' }))
    const calls = r.listViews.mock.calls.length
    await flush(MISSION_POLL_MS * 3)
    expect(r.listViews.mock.calls.length).toBe(calls)
    r.emit('hello', binding(), 'resume')
    r.feed.dispose()
    const after = r.listViews.mock.calls.length
    await flush(MISSION_POLL_MS * 3)
    expect(r.listViews.mock.calls.length).toBe(after)
  })

  it('a read that fails changes nothing and is tried again on the next poll', async () => {
    const r = rig()
    r.listViews.mockRejectedValueOnce(new Error('disk'))
    r.emit('hello', binding(), 'spawn')
    await flush(MISSION_DEBOUNCE_MS + 5)
    expect(r.sent).toHaveLength(0)
    await flush(MISSION_POLL_MS + MISSION_DEBOUNCE_MS + 5)
    expect(r.sent).toHaveLength(1)
    r.feed.dispose()
  })

  it('a send the channel refuses is not recorded as sent: the next poll tries again', async () => {
    const r = rig()
    r.send.mockReturnValueOnce({ ok: false, reason: 'QUEUE_FULL' } as never)
    r.emit('hello', binding(), 'spawn')
    await flush(MISSION_DEBOUNCE_MS + 5)
    expect(r.send).toHaveBeenCalledTimes(1)
    await flush(MISSION_POLL_MS + MISSION_DEBOUNCE_MS + 5)
    expect(r.send).toHaveBeenCalledTimes(2)
    r.feed.dispose()
  })

  it('reads each folder once per pass, however many sessions are in it', async () => {
    const r = rig()
    r.emit('hello', binding({ key: 1 }), 'spawn')
    r.emit('hello', binding({ key: 2, sid: 'other-session' }), 'spawn')
    await flush(5)
    expect(r.listViews).toHaveBeenCalledTimes(1)
    r.feed.dispose()
  })
})
