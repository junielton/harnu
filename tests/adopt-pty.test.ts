/**
 * T479 (agent terminals B2) — AC-B2-2: adopting a PTY someone else started is
 * subscribe-first → queue → replay → `dedupeAfterSeq`, with no duplicated and no missing bytes.
 */
import { describe, it, expect } from 'vitest'
import {
  adoptPtyStream,
  adoptTerminal,
  type AdoptApi,
  type AdoptTerm
} from '../src/renderer/src/lib/adopt-pty'

/** A PTY whose output is a growing string, `seq` being the byte offset after each chunk. */
function fakePty(): {
  api: AdoptApi
  emit: (data: string) => void
  /** Settle the replay that is in flight, as the main process would. */
  resolveReplay: () => void
  failReplay: () => void
  subscribers: () => number
} {
  let full = ''
  const subs = new Set<(data: string, seq: number) => void>()
  let release: (() => void) | null = null
  let fail: (() => void) | null = null
  let atReplay = { data: '', seq: 0 }
  return {
    api: {
      onPtyData: (_id, cb) => {
        subs.add(cb)
        return () => subs.delete(cb)
      },
      ptyReplay: () =>
        new Promise((resolve, reject) => {
          // Main snapshots at the moment it handles the request, not when the answer arrives.
          atReplay = { data: full, seq: Buffer.byteLength(full) }
          release = () => resolve(atReplay)
          fail = () => reject(new Error('ipc'))
        })
    },
    emit: (data) => {
      full += data
      for (const cb of subs) cb(data, Buffer.byteLength(full))
    },
    resolveReplay: () => release?.(),
    failReplay: () => fail?.(),
    subscribers: () => subs.size
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('adoptPtyStream', () => {
  it('writes the scrollback, then follows the live stream', async () => {
    const pty = fakePty()
    pty.emit('history\r\n')
    const written: string[] = []
    const p = adoptPtyStream(pty.api, 'p1', (d) => written.push(d))
    pty.resolveReplay()
    await p
    pty.emit('live\r\n')
    expect(written.join('')).toBe('history\r\nlive\r\n')
  })

  it('subscribes BEFORE asking for the replay', async () => {
    const pty = fakePty()
    const p = adoptPtyStream(pty.api, 'p1', () => {})
    // The replay is still pending, and the live stream is already being listened to.
    expect(pty.subscribers()).toBe(1)
    pty.resolveReplay()
    await p
  })

  it('output emitted while the replay is in flight is neither duplicated nor lost', async () => {
    const pty = fakePty()
    pty.emit('A')
    const written: string[] = []
    const p = adoptPtyStream(pty.api, 'p1', (d) => written.push(d))

    // Replay was snapshotted at "A"; B and C arrive while the answer is still travelling.
    pty.emit('B')
    pty.emit('C')
    pty.resolveReplay()
    await p
    pty.emit('D')

    expect(written.join('')).toBe('ABCD')
  })

  it('a chunk already inside the replay is dropped, one straddling nothing is kept', async () => {
    const pty = fakePty()
    const written: string[] = []
    const p = adoptPtyStream(pty.api, 'p1', (d) => written.push(d))
    // The chunk lands in the queue AND in the snapshot main takes right after.
    pty.emit('X')
    pty.resolveReplay()
    await p
    expect(written.join('')).toBe('X')
  })

  it('a failing replay does not leave the gate shut: queued output still paints, later output follows', async () => {
    const pty = fakePty()
    const written: string[] = []
    const p = adoptPtyStream(pty.api, 'p1', (d) => written.push(d))
    pty.emit('queued')
    pty.failReplay()
    await p
    pty.emit('after')
    expect(written.join('')).toBe('queuedafter')
  })

  it('T480: hands the replay write a done callback, and reports it parsed only when it fires', async () => {
    const pty = fakePty()
    pty.emit('history\r\n')
    const dones: Array<(() => void) | undefined> = []
    const writes: string[] = []
    let parsed = 0
    const p = adoptPtyStream(
      pty.api,
      'p1',
      (d, done) => {
        writes.push(d)
        dones.push(done)
      },
      () => parsed++
    )
    pty.resolveReplay()
    await p
    // The replay write carries the callback; the pane has not been told it is parsed yet.
    expect(writes).toEqual(['history\r\n'])
    expect(dones[0]).toBeTypeOf('function')
    expect(parsed).toBe(0)
    pty.emit('live\r\n')
    expect(dones[1]).toBeUndefined() // live chunks are not part of the replay
    dones[0]!()
    expect(parsed).toBe(1)
  })

  it('T480: with no replay (empty or failed) the pane is told at once', async () => {
    const empty = fakePty()
    let parsed = 0
    const p1 = adoptPtyStream(
      empty.api,
      'p1',
      () => {},
      () => parsed++
    )
    empty.resolveReplay()
    await p1
    expect(parsed).toBe(1)

    const failing = fakePty()
    const p2 = adoptPtyStream(
      failing.api,
      'p2',
      () => {},
      () => parsed++
    )
    failing.failReplay()
    await p2
    expect(parsed).toBe(2)
  })

  it('returns the unsubscribe for the live stream', async () => {
    const pty = fakePty()
    const p = adoptPtyStream(pty.api, 'p1', () => {})
    pty.resolveReplay()
    const off = await p
    expect(pty.subscribers()).toBe(1)
    off()
    expect(pty.subscribers()).toBe(0)
    await flush()
  })
})

describe("adoptTerminal: the pane's xterm answers only what main did not (T480, AC-B3-7 renderer half)", () => {
  /** A fake xterm whose write callback the test settles, as the parser would. */
  function fakeTerm(): {
    term: AdoptTerm
    /** What the xterm itself emits on `onData`: a typed key or an automatic query reply. */
    emit: (data: string) => void
    /** The parser finishes the chunk written `n`-th (0-based). */
    parsed: (n: number) => void
    writes: string[]
    listeners: () => number
  } {
    const cbs: Array<(() => void) | undefined> = []
    const writes: string[] = []
    const subs = new Set<(d: string) => void>()
    return {
      term: {
        write: (data, done) => {
          writes.push(data)
          cbs.push(done)
        },
        onData: (cb) => {
          subs.add(cb)
          return { dispose: () => subs.delete(cb) }
        }
      },
      emit: (d) => subs.forEach((cb) => cb(d)),
      parsed: (n) => cbs[n]?.(),
      writes,
      listeners: () => subs.size
    }
  }

  const apiWith = (
    pty: ReturnType<typeof fakePty>
  ): AdoptApi & { ptyWrite: (id: string, d: string) => void; sent: string[] } => {
    const sent: string[] = []
    return { ...pty.api, ptyWrite: (_id, d) => sent.push(d), sent }
  }

  it('drops what the xterm emits while it parses the replay, forwards it once parsed', async () => {
    const pty = fakePty()
    pty.emit('history\x1b[6n') // a query inside the replayed bytes: main already answered it
    const api = apiWith(pty)
    const t = fakeTerm()
    const p = adoptTerminal(api, 'p1', t.term)
    pty.resolveReplay()
    await p
    expect(t.writes).toEqual(['history\x1b[6n'])

    t.emit('\x1b[1;8R') // the xterm's own reply to that query, emitted mid-parse
    expect(api.sent).toEqual([])
    t.parsed(0) // the replay is parsed
    t.emit('\x1b[1;8R') // a reply to a LIVE query, which only this xterm answers
    t.emit('k') // and the operator typing
    expect(api.sent).toEqual(['\x1b[1;8R', 'k'])
  })

  it('live chunks queued behind the replay are written, and their replies are not dropped', async () => {
    const pty = fakePty()
    pty.emit('A')
    const api = apiWith(pty)
    const t = fakeTerm()
    const p = adoptTerminal(api, 'p1', t.term)
    pty.emit('B\x1b[6n') // arrives while the replay is in flight; ends after the snapshot
    pty.resolveReplay()
    await p
    expect(t.writes.join('')).toBe('AB\x1b[6n')
    t.parsed(0) // replay (A) parsed; B's query parses after it
    t.emit('\x1b[1;2R')
    expect(api.sent).toEqual(['\x1b[1;2R'])
  })

  it('with no replay the gate opens at once', async () => {
    const pty = fakePty()
    const api = apiWith(pty)
    const t = fakeTerm()
    const p = adoptTerminal(api, 'p1', t.term)
    pty.resolveReplay()
    await p
    t.emit('typed')
    expect(api.sent).toEqual(['typed'])
  })

  it('a failed replay does not leave the pane mute', async () => {
    const pty = fakePty()
    const api = apiWith(pty)
    const t = fakeTerm()
    const p = adoptTerminal(api, 'p1', t.term)
    pty.failReplay()
    await p
    t.emit('typed')
    expect(api.sent).toEqual(['typed'])
  })

  it('keystrokes before the replay lands are dropped, not queued', async () => {
    const pty = fakePty()
    pty.emit('x')
    const api = apiWith(pty)
    const t = fakeTerm()
    const p = adoptTerminal(api, 'p1', t.term)
    t.emit('early')
    pty.resolveReplay()
    await p
    t.parsed(0)
    expect(api.sent).toEqual([])
  })

  it('its disposer unsubscribes the live stream AND the input', async () => {
    const pty = fakePty()
    const api = apiWith(pty)
    const t = fakeTerm()
    const p = adoptTerminal(api, 'p1', t.term)
    pty.resolveReplay()
    const off = await p
    expect(pty.subscribers()).toBe(1)
    expect(t.listeners()).toBe(1)
    off()
    expect(pty.subscribers()).toBe(0)
    expect(t.listeners()).toBe(0)
  })
})
