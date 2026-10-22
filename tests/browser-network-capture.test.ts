/**
 * T570 (browser pane U3, AC-4) — network capture is off by default, scrubs query values and credential headers,
 * records bodies only when asked (text, capped), expires on its own clock, keeps cursors; and the idle counter
 * works without capture. Also the pane readers' lifecycle (expiry timer, ref invalidation).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  MAX_BODY_BYTES,
  createNetworkCapture,
  createNetworkIdleTracker,
  isTextMime,
  scrubHeaders,
  scrubQueryValues
} from '../src/main/browser/network-capture'
import { createPaneReaders } from '../src/main/browser/pane-readers'

function rig(
  fetchBody: (
    id: string
  ) => Promise<{ body: string; base64Encoded: boolean } | undefined> = async () => undefined
) {
  let t = 1_000_000
  const cap = createNetworkCapture({ now: () => t, fetchBody, scrub: (s) => s })
  return { cap, advance: (ms: number) => void (t += ms), now: () => t }
}

const send = (id: string, url: string, extra: object = {}) => ({
  requestId: id,
  type: 'XHR',
  wallTime: 1000,
  request: {
    url,
    method: 'GET',
    headers: { Accept: 'x', Authorization: 'Bearer abc', Cookie: 'sid=1' }
  },
  initiator: { type: 'script', url: 'http://localhost/app.js?v=9' },
  ...extra
})

describe('scrubbing', () => {
  it('replaces every query value, drops userinfo and fragment, keeps keys', () => {
    expect(scrubQueryValues('https://u:p@example.com/a/b?token=abc&q=1&q=2#frag')).toBe(
      'https://example.com/a/b?token=*&q=*&q=*'
    )
    expect(scrubQueryValues('http://localhost:3000/x')).toBe('http://localhost:3000/x')
    expect(scrubQueryValues('data:text/plain;base64,SECRET')).toBe('data:…')
    expect(scrubQueryValues('not a url')).toBe('')
  })

  it('never keeps credential headers, with any casing, and cuts long values', () => {
    const out = scrubHeaders({
      Authorization: 'Bearer x',
      COOKIE: 'a=b',
      'Set-Cookie': 'c=d',
      'Proxy-Authorization': 'p',
      'X-Api-Key': 'k',
      'Content-Type': 'text/html',
      'X-Long': 'y'.repeat(2000)
    })
    expect(Object.keys(out).sort()).toEqual(['content-type', 'x-long'])
    expect(out['x-long']!.length).toBeLessThan(600)
  })

  it('knows which mime types are text', () => {
    for (const m of [
      'text/html',
      'application/json; charset=utf-8',
      'application/vnd.api+json',
      'image/svg+xml'
    ]) {
      expect(isTextMime(m), m).toBe(true)
    }
    for (const m of ['image/png', 'application/octet-stream', undefined])
      expect(isTextMime(m), String(m)).toBe(false)
  })
})

describe('network capture', () => {
  it('is off by default and records nothing until started', () => {
    const { cap } = rig()
    expect(cap.status()).toEqual({ active: false, expiresAt: null, bodies: false, headers: false })
    cap.ingest('Network.requestWillBeSent', send('1', 'http://localhost/a'))
    const res = cap.read({ limit: 10 })
    if (!res.ok) throw new Error('unexpected')
    expect(res.entries).toEqual([])
  })

  it('start sets a clamped expiry (default 10 min, max 30) and stops by itself', () => {
    const { cap, advance, now } = rig()
    expect(cap.start({}).expiresAt).toBe(now() + 10 * 60_000)
    expect(cap.start({ maxMinutes: 99 }).expiresAt).toBe(now() + 30 * 60_000)
    cap.start({ maxMinutes: 1 })
    advance(60_001)
    expect(cap.status().active).toBe(false)
    cap.ingest('Network.requestWillBeSent', send('late', 'http://localhost/late'))
    const res = cap.read({ limit: 10 })
    if (!res.ok) throw new Error('unexpected')
    expect(res.entries).toEqual([])
  })

  it('records a request with status, mime, sizes, timing, initiator and a scrubbed URL', () => {
    const { cap, advance } = rig()
    cap.start({})
    cap.ingest('Network.requestWillBeSent', send('1', 'http://localhost/api?token=s3cret&page=2'))
    advance(40)
    cap.ingest('Network.responseReceived', {
      requestId: '1',
      type: 'XHR',
      response: { status: 200, mimeType: 'application/json' }
    })
    cap.ingest('Network.loadingFinished', { requestId: '1', encodedDataLength: 512 })
    const res = cap.read({ limit: 10 })
    if (!res.ok) throw new Error('unexpected')
    expect(res.entries[0]).toMatchObject({
      id: '1',
      method: 'GET',
      url: 'http://localhost/api?token=*&page=*',
      status: 200,
      mimeType: 'application/json',
      encodedBytes: 512,
      durationMs: 40,
      resourceType: 'XHR',
      initiator: 'script http://localhost/app.js?v=*'
    })
    expect(res.entries[0]).not.toHaveProperty('requestHeaders')
    expect(res.entries[0]).not.toHaveProperty('body')
  })

  it('records failures', () => {
    const { cap } = rig()
    cap.start({})
    cap.ingest('Network.requestWillBeSent', send('1', 'http://localhost/x'))
    cap.ingest('Network.loadingFailed', {
      requestId: '1',
      errorText: 'net::ERR_CONNECTION_REFUSED'
    })
    const res = cap.read({ limit: 1 })
    if (!res.ok) throw new Error('unexpected')
    expect(res.entries[0]!.failure).toBe('net::ERR_CONNECTION_REFUSED')
  })

  it('records headers only when asked, and never the credential ones', () => {
    const { cap } = rig()
    cap.start({ headers: true })
    cap.ingest('Network.requestWillBeSent', send('1', 'http://localhost/x'))
    cap.ingest('Network.responseReceived', {
      requestId: '1',
      response: { status: 200, headers: { 'Set-Cookie': 'a=b', 'Content-Type': 'text/plain' } }
    })
    const res = cap.read({ limit: 1 })
    if (!res.ok) throw new Error('unexpected')
    expect(res.entries[0]!.requestHeaders).toEqual({ accept: 'x' })
    expect(res.entries[0]!.responseHeaders).toEqual({ 'content-type': 'text/plain' })
  })

  it('splits a redirect into two entries', () => {
    const { cap } = rig()
    cap.start({})
    cap.ingest('Network.requestWillBeSent', send('1', 'http://localhost/a'))
    cap.ingest(
      'Network.requestWillBeSent',
      send('1', 'http://localhost/b', { redirectResponse: { status: 302 } })
    )
    const res = cap.read({ limit: 10 })
    if (!res.ok) throw new Error('unexpected')
    expect(res.entries.map((e) => [e.id, e.url, e.status])).toEqual([
      ['1', 'http://localhost/a', 302],
      ['1#1', 'http://localhost/b', undefined]
    ])
  })

  it('reads with a cursor and a URL filter', () => {
    const { cap } = rig()
    cap.start({})
    cap.ingest('Network.requestWillBeSent', send('1', 'http://localhost/api/users'))
    const first = cap.read({ limit: 10 })
    if (!first.ok) throw new Error('unexpected')
    cap.ingest('Network.requestWillBeSent', send('2', 'http://localhost/img.png'))
    cap.ingest('Network.requestWillBeSent', send('3', 'http://localhost/api/orders'))
    const next = cap.read({ since: first.cursor, limit: 10, filter: 'API' })
    if (!next.ok) throw new Error('unexpected')
    expect(next.entries.map((e) => e.id)).toEqual(['3'])
    expect(cap.read({ since: 'bogus', limit: 1 })).toEqual({ ok: false, error: 'CURSOR_EXPIRED' })
  })

  it('keeps entries readable after stop, and a restart drops them', () => {
    const { cap } = rig()
    cap.start({})
    cap.ingest('Network.requestWillBeSent', send('1', 'http://localhost/a'))
    cap.stop()
    const after = cap.read({ limit: 10 })
    if (!after.ok) throw new Error('unexpected')
    expect(after.entries).toHaveLength(1)
    cap.start({})
    const fresh = cap.read({ limit: 10 })
    if (!fresh.ok) throw new Error('unexpected')
    expect(fresh.entries).toHaveLength(0)
  })

  it('fetches a text body only with bodies:true, cuts it at 64 KiB and flags the cut', async () => {
    const fetchBody = vi.fn(async () => ({
      body: 'z'.repeat(MAX_BODY_BYTES + 100),
      base64Encoded: false
    }))
    const { cap } = rig(fetchBody)
    cap.start({})
    cap.ingest('Network.requestWillBeSent', send('1', 'http://localhost/a'))
    cap.ingest('Network.responseReceived', {
      requestId: '1',
      response: { status: 200, mimeType: 'text/html' }
    })
    cap.ingest('Network.loadingFinished', { requestId: '1', encodedDataLength: 1 })
    expect(fetchBody).not.toHaveBeenCalled()

    cap.start({ bodies: true })
    cap.ingest('Network.requestWillBeSent', send('2', 'http://localhost/b'))
    cap.ingest('Network.responseReceived', {
      requestId: '2',
      response: { status: 200, mimeType: 'text/html' }
    })
    cap.ingest('Network.loadingFinished', { requestId: '2', encodedDataLength: 1 })
    cap.ingest('Network.requestWillBeSent', send('3', 'http://localhost/c.png'))
    cap.ingest('Network.responseReceived', {
      requestId: '3',
      response: { status: 200, mimeType: 'image/png' }
    })
    cap.ingest('Network.loadingFinished', { requestId: '3', encodedDataLength: 1 })
    await new Promise((r) => setTimeout(r, 0))
    const res = cap.read({ limit: 10 })
    if (!res.ok) throw new Error('unexpected')
    expect(fetchBody).toHaveBeenCalledTimes(1)
    expect(res.entries[0]!.body).toEqual({ text: 'z'.repeat(MAX_BODY_BYTES), truncated: true })
    expect(res.entries[1]).not.toHaveProperty('body')
  })

  it('stops recording bodies after 2 MiB in all', async () => {
    const fetchBody = vi.fn(async () => ({
      body: 'q'.repeat(MAX_BODY_BYTES),
      base64Encoded: false
    }))
    const { cap } = rig(fetchBody)
    cap.start({ bodies: true })
    for (let i = 0; i < 40; i++) {
      cap.ingest('Network.requestWillBeSent', send(`r${i}`, `http://localhost/${i}`))
      cap.ingest('Network.responseReceived', {
        requestId: `r${i}`,
        response: { status: 200, mimeType: 'text/plain' }
      })
      cap.ingest('Network.loadingFinished', { requestId: `r${i}`, encodedDataLength: 1 })
      await new Promise((r) => setTimeout(r, 0))
    }
    const res = cap.read({ limit: 100 })
    if (!res.ok) throw new Error('unexpected')
    const withBody = res.entries.filter((e) => e.body).length
    expect(withBody).toBe(32) // 32 × 64 KiB = 2 MiB
  })
})

describe('idle tracker', () => {
  it('is idle only with nothing in flight and quiet for long enough, without any capture', () => {
    let t = 0
    const idle = createNetworkIdleTracker(() => t)
    t = 100
    idle.ingest('Network.requestWillBeSent', { requestId: 'a', type: 'Fetch' })
    expect(idle.inflight).toBe(1)
    t = 5_000
    expect(idle.isIdle(500)).toBe(false) // still in flight
    idle.ingest('Network.loadingFinished', { requestId: 'a' })
    t = 5_300
    expect(idle.isIdle(500)).toBe(false) // finished 300 ms ago
    t = 5_500
    expect(idle.isIdle(500)).toBe(true)
  })

  it('does not count an event stream, which never ends', () => {
    let t = 0
    const idle = createNetworkIdleTracker(() => t)
    idle.ingest('Network.requestWillBeSent', { requestId: 's', type: 'EventSource' })
    t = 1_000
    expect(idle.inflight).toBe(0)
    expect(idle.isIdle(500)).toBe(true)
  })

  it('treats a failed request as finished', () => {
    let t = 0
    const idle = createNetworkIdleTracker(() => t)
    idle.ingest('Network.requestWillBeSent', { requestId: 'a', type: 'Fetch' })
    idle.ingest('Network.loadingFailed', { requestId: 'a' })
    t = 1_000
    expect(idle.isIdle(500)).toBe(true)
  })
})

describe('pane readers', () => {
  function readers() {
    let t = 0
    const timers: Array<{ fn: () => void; at: number }> = []
    const changes: string[] = []
    const r = createPaneReaders({
      now: () => t,
      send: async () => undefined,
      scrub: (s) => s,
      setTimer: (fn, ms) => {
        const timer = { fn, at: t + ms }
        timers.push(timer)
        return timer
      },
      clearTimer: (h) => void timers.splice(timers.indexOf(h as never), 1),
      onCaptureChange: (_s, reason) => void changes.push(reason)
    })
    return {
      r,
      changes,
      tick: (ms: number) => {
        t += ms
        for (const x of [...timers])
          if (x.at <= t) {
            timers.splice(timers.indexOf(x), 1)
            x.fn()
          }
      }
    }
  }

  it('routes events: network to the counter and capture, console to the ring', () => {
    const { r } = readers()
    r.startCapture({})
    r.ingest('Network.requestWillBeSent', {
      requestId: '1',
      type: 'XHR',
      request: { url: 'http://localhost/a', method: 'GET' }
    })
    r.ingest('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'hello' }]
    })
    const net = r.capture.read({ limit: 5 })
    const con = r.console.read({ mode: 'tail', lines: 5 })
    expect(net.ok && net.entries.length).toBe(1)
    expect(con.ok && con.entries[0]!.text).toBe('hello')
    expect(r.idle.inflight).toBe(1)
  })

  it('ends capture on its timer, tells the header, and stays quiet when already stopped', () => {
    const { r, changes, tick } = readers()
    r.startCapture({ maxMinutes: 2 })
    tick(2 * 60_000 + 1)
    expect(r.capture.status().active).toBe(false)
    expect(changes).toEqual(['started', 'expired'])
    r.stopCapture('disconnected')
    expect(changes).toEqual(['started', 'expired'])
  })

  it('ends capture on dispose, disconnect and kill-switch with the reason', () => {
    for (const reason of ['disconnected', 'kill-switch'] as const) {
      const { r, changes } = readers()
      r.startCapture({})
      r.stopCapture(reason)
      expect(changes).toEqual(['started', reason])
    }
    const { r, changes } = readers()
    r.startCapture({})
    r.dispose()
    expect(changes).toEqual(['started', 'closed'])
  })

  it('a main-frame navigation kills refs; a sub-frame one does not', () => {
    const { r } = readers()
    r.refs.commit(r.refs.nextSnapshotId(), new Map([[1, 5]]))
    r.ingest('Page.frameNavigated', { frame: { id: 'child', parentId: 'main' } })
    expect(r.refs.resolve('s1e1').ok).toBe(true)
    r.ingest('Page.frameNavigated', { frame: { id: 'main' } })
    expect(r.refs.resolve('s1e1')).toEqual({ ok: false, error: 'REF_STALE' })
  })
})
