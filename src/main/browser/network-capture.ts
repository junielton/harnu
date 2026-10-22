/**
 * The browser pane's network capture and idle counter, pure core (T564 U3, spec §6.1 row 7, §6.2 and decision 9).
 *
 * Capture is **off by default**. `start` turns it on for a pane with an expiry; until then CDP `Network` events
 * feed only the idle counter ({@link createNetworkIdleTracker}: two integers, no URLs, no headers), which is
 * what `browser_wait_for`'s `networkIdleMs` reads. While active, entries hold method, URL (query values
 * scrubbed), status, mime type, sizes, timings, initiator and failure text. Headers are recorded only when asked
 * for, and `Authorization`, `Cookie` and `Set-Cookie` (and their kin) never are. Bodies are recorded only when
 * `bodies: true` was passed to `start`: text mime types, 64 KiB each, 2 MiB in all.
 *
 * Pure (ADR-0001): the clock and the body fetch are injected.
 */
import { createCursorRing, type CursorRing } from './cursor-ring'

export const NETWORK_MAX_ENTRIES = 1000
export const NETWORK_MAX_BYTES = 1024 * 1024
export const DEFAULT_CAPTURE_MINUTES = 10
export const MAX_CAPTURE_MINUTES = 30
export const MAX_BODY_BYTES = 64 * 1024
export const MAX_TOTAL_BODY_BYTES = 2 * 1024 * 1024
const MAX_HEADER_VALUE_CHARS = 512
const MAX_HEADERS = 60

/** Headers never recorded, with or without bodies (spec §6.2); matched case-insensitively. */
const NEVER_RECORDED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'set-cookie2',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token'
])

/** Request/response headers without the credential-bearing ones, values cut, at most {@link MAX_HEADERS}. */
export function scrubHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  let n = 0
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase()
    if (NEVER_RECORDED_HEADERS.has(name)) continue
    if (n >= MAX_HEADERS) break
    const value = String(rawValue)
    out[name] =
      value.length <= MAX_HEADER_VALUE_CHARS ? value : `${value.slice(0, MAX_HEADER_VALUE_CHARS)}…`
    n++
  }
  return out
}

/**
 * A URL safe to show an agent: no userinfo, no fragment, every query VALUE replaced by `*` (keys stay, because
 * they say what the request was; values are where tokens live). Non-web schemes collapse to their scheme.
 */
export function scrubQueryValues(rawUrl: string): string {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return ''
  }
  if (
    u.protocol !== 'http:' &&
    u.protocol !== 'https:' &&
    u.protocol !== 'ws:' &&
    u.protocol !== 'wss:'
  ) {
    return `${u.protocol}…`
  }
  u.username = ''
  u.password = ''
  u.hash = ''
  if (u.search !== '') {
    const keys = [...u.searchParams.keys()]
    u.search = ''
    for (const k of keys) u.searchParams.append(k, '*')
  }
  return u.toString()
}

/** Text-like mime types whose body is worth recording. */
export function isTextMime(mime: string | undefined): boolean {
  if (!mime) return false
  const m = mime.toLowerCase().split(';')[0]!.trim()
  return (
    m.startsWith('text/') ||
    m === 'application/json' ||
    m === 'application/xml' ||
    m === 'application/javascript' ||
    m === 'application/x-www-form-urlencoded' ||
    m.endsWith('+json') ||
    m.endsWith('+xml')
  )
}

export interface NetworkEntry {
  /** CDP request id; a redirect hop gets `<id>#<n>`. */
  id: string
  /** Epoch ms the request started. */
  startedAt: number
  method: string
  url: string
  resourceType?: string
  status?: number
  statusText?: string
  mimeType?: string
  fromCache?: boolean
  encodedBytes?: number
  durationMs?: number
  initiator?: string
  failure?: string
  canceled?: boolean
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  body?: { text: string; truncated: boolean }
}

export interface CaptureOptions {
  maxMinutes: number
  bodies: boolean
  headers: boolean
}

export interface CaptureStatus {
  active: boolean
  /** Epoch ms capture stops by itself; `null` when not active. */
  expiresAt: number | null
  bodies: boolean
  headers: boolean
}

export interface NetworkReadRequest {
  since?: string
  limit: number
  /** Case-insensitive substring of the scrubbed URL. */
  filter?: string
}

export type NetworkReadResult =
  | { ok: true; entries: NetworkEntry[]; cursor: string; droppedEntries: number }
  | { ok: false; error: 'CURSOR_EXPIRED' }

export interface NetworkCapture {
  /** Begin (or restart: the previous entries are dropped) capture. Returns the clamped options and expiry. */
  start(opts: Partial<CaptureOptions>): CaptureStatus
  /** End capture; entries stay readable until the next `start` or the pane closes. */
  stop(): CaptureStatus
  status(): CaptureStatus
  ingest(method: string, params: unknown): void
  read(req: NetworkReadRequest): NetworkReadResult
}

interface CdpRequestWillBeSent {
  requestId?: string
  type?: string
  wallTime?: number
  request?: { url?: string; method?: string; headers?: Record<string, unknown> }
  initiator?: { type?: string; url?: string }
  redirectResponse?: CdpResponse
}
interface CdpResponse {
  url?: string
  status?: number
  statusText?: string
  mimeType?: string
  headers?: Record<string, unknown>
  fromDiskCache?: boolean
  fromServiceWorker?: boolean
  encodedDataLength?: number
}

export interface CaptureDeps {
  now(): number
  /** Fetch a finished response's body (CDP `Network.getResponseBody`); `undefined` when it is gone. */
  fetchBody(requestId: string): Promise<{ body: string; base64Encoded: boolean } | undefined>
  /** Redact secret shapes in recorded text (best-effort, like every other reading verb). */
  scrub(text: string): string
}

function entryBytes(e: NetworkEntry): number {
  let n = 160 + e.url.length + (e.initiator?.length ?? 0) + (e.failure?.length ?? 0)
  for (const h of [e.requestHeaders, e.responseHeaders]) {
    if (h) for (const [k, v] of Object.entries(h)) n += k.length + v.length
  }
  return n
}

export function createNetworkCapture(deps: CaptureDeps): NetworkCapture {
  let ring: CursorRing<NetworkEntry> = newRing()
  let state: { expiresAt: number; opts: CaptureOptions } | null = null
  /** In-flight requests by CDP id, so response and finish events can complete the entry. */
  let pending = new Map<string, { entry: NetworkEntry; startedMono?: number }>()
  let bodyBytes = 0
  let hop = 0

  function newRing(): CursorRing<NetworkEntry> {
    return createCursorRing(
      { maxEntries: NETWORK_MAX_ENTRIES, maxBytes: NETWORK_MAX_BYTES },
      entryBytes
    )
  }

  const isActive = (): boolean => {
    if (!state) return false
    if (deps.now() >= state.expiresAt) {
      state = null
      return false
    }
    return true
  }

  const status = (): CaptureStatus => {
    const active = isActive()
    return {
      active,
      expiresAt: active ? state!.expiresAt : null,
      bodies: active ? state!.opts.bodies : false,
      headers: active ? state!.opts.headers : false
    }
  }

  function applyResponse(entry: NetworkEntry, r: CdpResponse, headers: boolean): void {
    if (r.status !== undefined) entry.status = r.status
    if (r.statusText) entry.statusText = r.statusText
    if (r.mimeType) entry.mimeType = r.mimeType
    if (r.fromDiskCache || r.fromServiceWorker) entry.fromCache = true
    if (headers) entry.responseHeaders = scrubHeaders(r.headers)
  }

  return {
    start(opts) {
      const maxMinutes = Math.min(
        Math.max(opts.maxMinutes ?? DEFAULT_CAPTURE_MINUTES, 1),
        MAX_CAPTURE_MINUTES
      )
      ring = newRing()
      pending = new Map()
      bodyBytes = 0
      hop = 0
      state = {
        expiresAt: deps.now() + maxMinutes * 60_000,
        opts: { maxMinutes, bodies: opts.bodies === true, headers: opts.headers === true }
      }
      return status()
    },
    stop() {
      state = null
      return status()
    },
    status,
    ingest(method, params) {
      if (!isActive() || !state) return
      const opts = state.opts
      const p = (params ?? {}) as Record<string, unknown>
      const requestId = typeof p.requestId === 'string' ? p.requestId : ''
      if (requestId === '') return

      if (method === 'Network.requestWillBeSent') {
        const e = p as CdpRequestWillBeSent
        const prior = pending.get(requestId)
        // A redirect: the previous hop ends with the redirect response, and a new entry starts.
        if (prior && e.redirectResponse) {
          applyResponse(prior.entry, e.redirectResponse, opts.headers)
          pending.delete(requestId)
        }
        const startedAt = Math.round((e.wallTime ?? deps.now() / 1000) * 1000)
        const entry: NetworkEntry = {
          id: prior && e.redirectResponse ? `${requestId}#${++hop}` : requestId,
          startedAt,
          method: e.request?.method ?? 'GET',
          url: scrubQueryValues(e.request?.url ?? ''),
          ...(e.type ? { resourceType: e.type } : {})
        }
        if (e.initiator?.type) {
          const from = e.initiator.url ? scrubQueryValues(e.initiator.url) : ''
          entry.initiator = from ? `${e.initiator.type} ${from}` : e.initiator.type
        }
        if (opts.headers) entry.requestHeaders = scrubHeaders(e.request?.headers)
        ring.push(entry)
        pending.set(requestId, { entry })
        return
      }

      const rec = pending.get(requestId)
      if (!rec) return
      const entry = rec.entry
      if (method === 'Network.responseReceived') {
        applyResponse(entry, (p.response ?? {}) as CdpResponse, opts.headers)
        if (typeof p.type === 'string') entry.resourceType = p.type
      } else if (method === 'Network.loadingFinished') {
        if (typeof p.encodedDataLength === 'number') entry.encodedBytes = p.encodedDataLength
        entry.durationMs = Math.max(0, deps.now() - entry.startedAt)
        pending.delete(requestId)
        if (opts.bodies && isTextMime(entry.mimeType) && bodyBytes < MAX_TOTAL_BODY_BYTES) {
          void deps
            .fetchBody(requestId)
            .then((res) => {
              if (!res || res.base64Encoded || !state || state.opts !== opts) return
              const room = Math.min(MAX_BODY_BYTES, MAX_TOTAL_BODY_BYTES - bodyBytes)
              if (room <= 0) return
              const truncated = res.body.length > room
              const text = deps.scrub(truncated ? res.body.slice(0, room) : res.body)
              bodyBytes += text.length
              entry.body = { text, truncated }
            })
            .catch(() => undefined)
        }
      } else if (method === 'Network.loadingFailed') {
        entry.failure = typeof p.errorText === 'string' ? p.errorText : 'failed'
        if (p.canceled === true) entry.canceled = true
        entry.durationMs = Math.max(0, deps.now() - entry.startedAt)
        pending.delete(requestId)
      }
    },
    read(req) {
      const needle = req.filter?.toLowerCase()
      const keep = needle ? (e: NetworkEntry) => e.url.toLowerCase().includes(needle) : undefined
      const res =
        req.since !== undefined
          ? ring.since(req.since, req.limit, keep)
          : ring.tail(req.limit, keep)
      if (!res.ok) return res
      return {
        ok: true,
        entries: res.entries.map((e) => e.value),
        cursor: res.cursor,
        droppedEntries: res.droppedEntries
      }
    }
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* The idle counter                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

export interface NetworkIdleTracker {
  ingest(method: string, params: unknown): void
  /** Whether nothing is in flight and nothing started or finished for at least `idleMs`. */
  isIdle(idleMs: number): boolean
  readonly inflight: number
}

/**
 * The lightweight counter behind `waitFor`'s `networkIdleMs` (spec §6.2): in-flight requests and the time of the
 * last request activity. It keeps no URL and no header, so it is always on without being a capture. Streams
 * that never end (EventSource) are not counted, or no page with one would ever be idle.
 */
export function createNetworkIdleTracker(now: () => number): NetworkIdleTracker {
  const open = new Set<string>()
  let lastActivityAt = now()
  return {
    ingest(method, params) {
      const p = (params ?? {}) as { requestId?: string; type?: string }
      const id = p.requestId
      if (typeof id !== 'string') return
      if (method === 'Network.requestWillBeSent') {
        if (p.type !== 'EventSource') open.add(id)
        lastActivityAt = now()
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        if (open.delete(id)) lastActivityAt = now()
      }
    },
    isIdle: (idleMs) => open.size === 0 && now() - lastActivityAt >= idleMs,
    get inflight() {
      return open.size
    }
  }
}
