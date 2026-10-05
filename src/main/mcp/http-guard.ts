/**
 * Pure request guard for Harnu's loopback MCP HTTP server (T6).
 *
 * This module is the security boundary that sits in front of the MCP transport.
 * It is intentionally framework-free + side-effect-free (no `http`/`electron`
 * import) so the accept/reject decision is unit-testable in the node vitest env
 * (ADR-0001 pure-core / thin-shell). The shell (`pty.ts` / the http listener)
 * feeds it the request line + headers and acts on the verdict.
 *
 * Four invariants live here:
 *  1. **Constant-time token compare.** The presented Bearer token is matched
 *     against the session secret with `crypto.timingSafeEqual`, guarded by an
 *     equal-length check (timingSafeEqual throws on unequal lengths) — see
 *     {@link constantTimeEqual}. A length mismatch is a miss, never a throw.
 *  2. **Route lock.** Only `POST /mcp` is served — any other path is 404, any
 *     other method on `/mcp` is 405.
 *  3. **DNS-rebind guard.** `Origin` (when present) and `Host` must be loopback
 *     (`127.0.0.1` / `localhost` / `::1`) or the literal `null` Origin. A
 *     public hostname pointed at the loopback port is refused with 403.
 *  4. **Body cap.** A declared `Content-Length` over {@link BODY_MAX} (1 MiB) is
 *     refused with 413 before the body is ever read.
 */

import { timingSafeEqual } from 'node:crypto'

/** The single served route. Anything else is a 404. */
export const MCP_PATH = '/mcp'

/** Maximum accepted request body, in bytes. A larger declared length is 413. */
export const BODY_MAX = 1024 * 1024

/** Hostnames treated as loopback for the Origin/Host DNS-rebind allowlist. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

/** The request facts the guard needs to render a verdict. */
export interface McpGuardInput {
  /** HTTP method (e.g. `POST`); `undefined` is treated as a non-POST. */
  method: string | undefined
  /** Request target/path, optionally with a query string (e.g. `/mcp?x=1`). */
  url: string | undefined
  /** Raw request headers (Node `IncomingHttpHeaders` shape; case-insensitive). */
  headers: Record<string, string | string[] | undefined>
  /** The expected session Bearer token to match against in constant time. */
  token: string
  /** Declared `Content-Length`, when known; over {@link BODY_MAX} is 413. */
  contentLength?: number
}

/** Accept (`ok: true`) carrying the resolved op, or reject with an HTTP status. */
export type McpGuardResult = { ok: true; op?: string } | { ok: false; status: number }

/**
 * Compare two strings for equality in constant time, guarding the unequal-length
 * case that `crypto.timingSafeEqual` would otherwise throw on. A length mismatch
 * is reported as a (non-throwing) miss; equal-length inputs are compared with
 * `timingSafeEqual` so a timing side-channel cannot leak how many leading bytes
 * matched.
 *
 * @param a - first string (e.g. the presented token).
 * @param b - second string (e.g. the expected secret).
 * @returns `true` iff the two strings are byte-for-byte equal.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  // Equal-length guard: timingSafeEqual requires identical byte lengths.
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** Lowercase header keys + collapse array values to their first entry. */
function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value
  }
  return out
}

/** Extract the hostname from an `authority` like `127.0.0.1:51789` / `[::1]:80`. */
export function hostnameOfAuthority(authority: string): string | null {
  try {
    return new URL(`http://${authority}`).hostname
  } catch {
    return null
  }
}

/** Whether a parsed hostname is a loopback target (brackets on `[::1]` stripped). */
export function isLoopbackHostname(hostname: string | null): boolean {
  if (hostname === null) return false
  const bare = hostname.replace(/^\[/, '').replace(/\]$/, '')
  return LOOPBACK_HOSTNAMES.has(bare)
}

/** Whether an `Origin` value is allowed: the literal `null` or a loopback origin. */
export function isAllowedOrigin(origin: string): boolean {
  if (origin === 'null') return true
  try {
    return isLoopbackHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}

/** Pull the token out of an `Authorization: Bearer <token>` header (scheme-insensitive). */
function bearerTokenOf(authorization: string | undefined): string | null {
  if (!authorization) return null
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return match ? match[1] : null
}

/**
 * Decide whether an inbound HTTP request may reach Harnu's MCP transport.
 *
 * Checks run cheapest/most-specific first so the returned status is meaningful:
 * path (404) → method (405) → Host loopback (403) → Origin loopback (403) →
 * Bearer token (403, constant-time) → body cap (413). On success the resolved
 * op (`'mcp'`) is returned for the caller to dispatch.
 *
 * @param input - the request method/url/headers, expected token, and optional
 *   declared content length.
 * @returns `{ ok: true, op }` to proceed, or `{ ok: false, status }` to reject.
 */
export function parseMcpRequest(input: McpGuardInput): McpGuardResult {
  const { method, url, token, contentLength } = input
  const headers = normalizeHeaders(input.headers)

  const path = (url ?? '').split('?', 1)[0]
  if (path !== MCP_PATH) return { ok: false, status: 404 }

  if ((method ?? '').toUpperCase() !== 'POST') return { ok: false, status: 405 }

  const host = headers['host']
  if (host === undefined || !isLoopbackHostname(hostnameOfAuthority(host))) {
    return { ok: false, status: 403 }
  }

  const origin = headers['origin']
  if (origin !== undefined && !isAllowedOrigin(origin)) {
    return { ok: false, status: 403 }
  }

  const presented = bearerTokenOf(headers['authorization'])
  if (presented === null || !constantTimeEqual(presented, token)) {
    return { ok: false, status: 403 }
  }

  if (contentLength !== undefined && contentLength > BODY_MAX) {
    return { ok: false, status: 413 }
  }

  return { ok: true, op: 'mcp' }
}
