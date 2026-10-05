import { describe, it, expect } from 'vitest'
import { parseMcpRequest, constantTimeEqual, BODY_MAX } from '../src/main/mcp/http-guard'

/**
 * T6 — the pure request guard in front of Harnu's loopback MCP HTTP server.
 *
 * The guard is the security boundary: it (1) compares the Bearer token in
 * constant time with an equal-length guard around `crypto.timingSafeEqual`,
 * (2) refuses anything but `POST /mcp`, and (3) blocks DNS-rebind by allowing
 * only loopback (or `null`) `Origin`/`Host` values, and (4) caps the request
 * body at 1 MiB. It is framework-free so the decision is unit-testable in the
 * node vitest env (ADR-0001 pure-core / thin-shell).
 */

const TOKEN = 's3cr3t-token-abc123'

/** A baseline valid `POST /mcp` request with a matching Bearer + loopback Host. */
function base(
  overrides: Partial<Parameters<typeof parseMcpRequest>[0]> = {}
): Parameters<typeof parseMcpRequest>[0] {
  return {
    method: 'POST',
    url: '/mcp',
    headers: {
      host: '127.0.0.1:51789',
      authorization: `Bearer ${TOKEN}`
    },
    token: TOKEN,
    ...overrides
  }
}

describe('parseMcpRequest — happy path', () => {
  it('accepts a valid POST /mcp with a matching Bearer token', () => {
    expect(parseMcpRequest(base())).toEqual({ ok: true, op: 'mcp' })
  })

  it('matches /mcp even with a query string', () => {
    expect(parseMcpRequest(base({ url: '/mcp?session=1' }))).toEqual({ ok: true, op: 'mcp' })
  })
})

describe('parseMcpRequest — token / Bearer', () => {
  it('rejects an absent Authorization header with 403', () => {
    expect(parseMcpRequest(base({ headers: { host: '127.0.0.1:51789' } }))).toEqual({
      ok: false,
      status: 403
    })
  })

  it('rejects a wrong same-length Bearer token with 403', () => {
    // same length as TOKEN but different content
    const wrong = 'X'.repeat(TOKEN.length)
    expect(
      parseMcpRequest(
        base({ headers: { host: '127.0.0.1:51789', authorization: `Bearer ${wrong}` } })
      )
    ).toEqual({ ok: false, status: 403 })
  })

  it('rejects a wrong-length Bearer token with 403 (no throw — equal-length guard)', () => {
    expect(() =>
      parseMcpRequest(base({ headers: { host: '127.0.0.1:51789', authorization: 'Bearer x' } }))
    ).not.toThrow()
    expect(
      parseMcpRequest(base({ headers: { host: '127.0.0.1:51789', authorization: 'Bearer x' } }))
    ).toEqual({ ok: false, status: 403 })
  })

  it('accepts a case-insensitive Bearer scheme', () => {
    expect(
      parseMcpRequest(
        base({ headers: { host: '127.0.0.1:51789', authorization: `bearer ${TOKEN}` } })
      )
    ).toEqual({ ok: true, op: 'mcp' })
  })
})

describe('constantTimeEqual', () => {
  it('returns true only for an exact match', () => {
    expect(constantTimeEqual(TOKEN, TOKEN)).toBe(true)
  })

  it('returns false for a same-length mismatch', () => {
    expect(constantTimeEqual('aaaaaa', 'aaaaab')).toBe(false)
  })

  it('returns false (no throw) on a length mismatch — the equal-length guard around timingSafeEqual', () => {
    expect(() => constantTimeEqual('short', 'a-much-longer-token')).not.toThrow()
    expect(constantTimeEqual('short', 'a-much-longer-token')).toBe(false)
    expect(constantTimeEqual('', TOKEN)).toBe(false)
  })
})

describe('parseMcpRequest — method / path', () => {
  it('rejects a non-POST method on /mcp with 405', () => {
    expect(parseMcpRequest(base({ method: 'GET' }))).toEqual({ ok: false, status: 405 })
  })

  it('rejects an unknown path with 404', () => {
    expect(parseMcpRequest(base({ url: '/admin' }))).toEqual({ ok: false, status: 404 })
  })

  it('checks path before method (404 wins on a bad path with a bad method)', () => {
    expect(parseMcpRequest(base({ url: '/admin', method: 'GET' }))).toEqual({
      ok: false,
      status: 404
    })
  })
})

describe('parseMcpRequest — Origin (DNS-rebind guard)', () => {
  it('rejects a cross-origin request (Origin not loopback/null) with 403', () => {
    expect(
      parseMcpRequest(
        base({
          headers: {
            host: '127.0.0.1:51789',
            authorization: `Bearer ${TOKEN}`,
            origin: 'http://evil.example.com'
          }
        })
      )
    ).toEqual({ ok: false, status: 403 })
  })

  it('allows a loopback Origin', () => {
    expect(
      parseMcpRequest(
        base({
          headers: {
            host: '127.0.0.1:51789',
            authorization: `Bearer ${TOKEN}`,
            origin: 'http://127.0.0.1:51789'
          }
        })
      )
    ).toEqual({ ok: true, op: 'mcp' })
  })

  it('allows a null Origin', () => {
    expect(
      parseMcpRequest(
        base({
          headers: {
            host: '127.0.0.1:51789',
            authorization: `Bearer ${TOKEN}`,
            origin: 'null'
          }
        })
      )
    ).toEqual({ ok: true, op: 'mcp' })
  })

  it('allows an absent Origin (non-browser client)', () => {
    // base() carries no Origin header
    expect(parseMcpRequest(base())).toEqual({ ok: true, op: 'mcp' })
  })
})

describe('parseMcpRequest — Host (DNS-rebind guard)', () => {
  it('rejects a non-loopback Host with 403', () => {
    expect(
      parseMcpRequest(
        base({ headers: { host: 'evil.example.com', authorization: `Bearer ${TOKEN}` } })
      )
    ).toEqual({ ok: false, status: 403 })
  })

  it('rejects a missing Host with 403', () => {
    expect(parseMcpRequest(base({ headers: { authorization: `Bearer ${TOKEN}` } }))).toEqual({
      ok: false,
      status: 403
    })
  })

  it('allows localhost / 127.0.0.1 / [::1] loopback Hosts', () => {
    for (const host of ['localhost:51789', '127.0.0.1:51789', '[::1]:51789', 'localhost']) {
      expect(
        parseMcpRequest(base({ headers: { host, authorization: `Bearer ${TOKEN}` } }))
      ).toEqual({ ok: true, op: 'mcp' })
    }
  })
})

describe('parseMcpRequest — body cap', () => {
  it('exposes a 1 MiB body cap', () => {
    expect(BODY_MAX).toBe(1024 * 1024)
  })

  it('flags a body larger than 1 MiB with 413', () => {
    expect(parseMcpRequest(base({ contentLength: BODY_MAX + 1 }))).toEqual({
      ok: false,
      status: 413
    })
  })

  it('allows a body at exactly the 1 MiB cap', () => {
    expect(parseMcpRequest(base({ contentLength: BODY_MAX }))).toEqual({ ok: true, op: 'mcp' })
  })

  it('allows a request with no declared content length', () => {
    expect(parseMcpRequest(base())).toEqual({ ok: true, op: 'mcp' })
  })
})
