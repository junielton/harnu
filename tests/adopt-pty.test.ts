/**
 * T479 (agent terminals B2) — AC-B2-2: adopting a PTY someone else started is
 * subscribe-first → queue → replay → `dedupeAfterSeq`, with no duplicated and no missing bytes.
 */
import { describe, it, expect } from 'vitest'
import { adoptPtyStream, type AdoptApi } from '../src/renderer/src/lib/adopt-pty'

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
