// U3.6 AC-1: the read-only `docker events` reader the capacity watcher listens on. Network create and
// destroy are the only events that change the free slots; a dead stream restarts with back-off.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NETWORK_EVENTS_ARGS,
  parseNetworkEvent,
  watchNetworkEvents,
  type EventsProcess
} from '../src/main/containers/docker-facts-shell'

const line = (action: string, type = 'network', id = 'abc123'): string =>
  JSON.stringify({
    status: action,
    id,
    Type: type,
    Action: action,
    Actor: { ID: id, Attributes: {} }
  })

describe('parseNetworkEvent', () => {
  it('reads a network create and destroy', () => {
    expect(parseNetworkEvent(line('create'))).toEqual({ action: 'create', id: 'abc123' })
    expect(parseNetworkEvent(line('destroy', 'network', 'zz'))).toEqual({
      action: 'destroy',
      id: 'zz'
    })
  })
  it('ignores other types, other actions, junk and empty lines', () => {
    expect(parseNetworkEvent(line('create', 'container'))).toBeNull()
    expect(parseNetworkEvent(line('connect'))).toBeNull()
    expect(parseNetworkEvent('not json')).toBeNull()
    expect(parseNetworkEvent('')).toBeNull()
    expect(parseNetworkEvent('{"Type":"network","Action":"create"}')).toBeNull()
  })
})

describe('NETWORK_EVENTS_ARGS', () => {
  it('asks only for network create and destroy, as JSON, and no mutating verb', () => {
    expect(NETWORK_EVENTS_ARGS).toEqual([
      'events',
      '--filter',
      'type=network',
      '--filter',
      'event=create',
      '--filter',
      'event=destroy',
      '--format',
      '{{json .}}'
    ])
    expect(NETWORK_EVENTS_ARGS.join(' ')).not.toMatch(
      /\b(rm|down|stop|kill|prune|up|start|create)\b(?!\s*$)/
    )
  })
})

interface FakeProc extends EventsProcess {
  emit(l: string): void
  exit(): void
  killed: boolean
}
function fakeSpawn(): { spawn: () => FakeProc; procs: FakeProc[] } {
  const procs: FakeProc[] = []
  return {
    procs,
    spawn: () => {
      let lineCb: (l: string) => void = () => {}
      let exitCb: () => void = () => {}
      const p: FakeProc = {
        killed: false,
        onLine: (cb) => (lineCb = cb),
        onExit: (cb) => (exitCb = cb),
        kill() {
          p.killed = true
        },
        emit: (l) => lineCb(l),
        exit: () => exitCb()
      }
      procs.push(p)
      return p
    }
  }
}

describe('watchNetworkEvents', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('hands network events to the listener and skips junk', () => {
    const f = fakeSpawn()
    const got: unknown[] = []
    watchNetworkEvents({ spawn: f.spawn }, (e) => got.push(e))
    f.procs[0]!.emit(line('create'))
    f.procs[0]!.emit('garbage')
    f.procs[0]!.emit(line('destroy'))
    expect(got).toEqual([
      { action: 'create', id: 'abc123' },
      { action: 'destroy', id: 'abc123' }
    ])
  })

  it('restarts after the stream ends: 5 s, then 10 s, then 20 s, capped at 60 s', () => {
    const f = fakeSpawn()
    watchNetworkEvents({ spawn: f.spawn }, () => {})
    f.procs[0]!.exit()
    vi.advanceTimersByTime(4_999)
    expect(f.procs).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(f.procs).toHaveLength(2)
    f.procs[1]!.exit()
    vi.advanceTimersByTime(9_999)
    expect(f.procs).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(f.procs).toHaveLength(3)
    for (let i = 3; i < 8; i++) {
      f.procs[i - 1]!.exit()
      vi.advanceTimersByTime(60_000)
    }
    f.procs[f.procs.length - 1]!.exit()
    vi.advanceTimersByTime(59_999)
    const n = f.procs.length
    vi.advanceTimersByTime(1)
    expect(f.procs).toHaveLength(n + 1)
  })

  it('a received line resets the back-off', () => {
    const f = fakeSpawn()
    watchNetworkEvents({ spawn: f.spawn }, () => {})
    f.procs[0]!.exit()
    vi.advanceTimersByTime(5_000)
    f.procs[1]!.exit()
    vi.advanceTimersByTime(10_000)
    f.procs[2]!.emit(line('create'))
    f.procs[2]!.exit()
    vi.advanceTimersByTime(5_000)
    expect(f.procs).toHaveLength(4)
  })

  it('stop kills the stream and never restarts', () => {
    const f = fakeSpawn()
    const w = watchNetworkEvents({ spawn: f.spawn }, () => {})
    w.stop()
    expect(f.procs[0]!.killed).toBe(true)
    f.procs[0]!.exit()
    vi.advanceTimersByTime(120_000)
    expect(f.procs).toHaveLength(1)
  })

  it('a spawn that throws is retried like a stream that ended', () => {
    let n = 0
    const f = fakeSpawn()
    watchNetworkEvents(
      {
        spawn: (args) => {
          n++
          if (n === 1) throw new Error('ENOENT')
          return f.spawn(args)
        }
      },
      () => {}
    )
    expect(f.procs).toHaveLength(0)
    vi.advanceTimersByTime(5_000)
    expect(f.procs).toHaveLength(1)
  })
})
