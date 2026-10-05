import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/**
 * Remote push notifications (remote-push spec, design.md §6 → Remote
 * notifications). Fans the SAME notification decision the OS channel receives
 * (`session-notify.ts` → `maybeNotify`) out to user-configured remote channels —
 * an ntfy topic or a generic webhook — so a needs-input/completed/failed edge
 * reaches the operator's phone when they're away from the machine.
 *
 * Owns `<userData>/push.json`:
 *
 *   { version: 1,
 *     enabled: boolean,            // master switch
 *     pausedUntil: number | null,  // epoch ms — suppressed while now < pausedUntil
 *     channels: PushChannel[] }
 *
 * All HTTP leaves from the MAIN process (no CORS, tokens never live in the
 * renderer beyond the explicit Settings editor), mirroring the endpoint-registry
 * split in `claude-config.ts`. Pure helpers (`sanitizePushConfig`,
 * `channelsToNotify`, `buildPushRequest`) carry the logic and are unit-tested;
 * `registerPushHandlers` is the thin IPC shell.
 */

export type PushChannelKind = 'ntfy' | 'webhook'

/** Per-channel opt-in per notify-kind (mirrors `NotifyPrefs`' per-state flags). */
export interface PushChannelEvents {
  needsInput: boolean
  completed: boolean
  failed: boolean
}

export interface PushChannel {
  id: string
  kind: PushChannelKind
  /** Human label shown in the Settings row. Falls back to the URL. */
  label: string
  /** ntfy: full topic URL (https://ntfy.sh/my-topic). webhook: the POST target. */
  url: string
  /** Optional bearer token (ntfy access token / webhook auth). */
  token?: string
  enabled: boolean
  events: PushChannelEvents
}

export interface PushConfig {
  enabled: boolean
  pausedUntil: number | null
  channels: PushChannel[]
}

/** The three notify-kinds, matching `NotifyKind` in `session-notify.ts`. */
export type PushEventKind = 'needs-input' | 'completed' | 'failed'

export interface PushSendPayload {
  kind: PushEventKind
  title: string
  body: string
}

export interface PushTestResult {
  ok: boolean
  status?: number
  error?: string
}

interface PushFile extends PushConfig {
  version: 1
}

const FILE_NAME = 'push.json'
const TMP_SUFFIX = '.tmp'
const DELIVERY_TIMEOUT_MS = 10_000

const DEFAULT_EVENTS: PushChannelEvents = { needsInput: true, completed: true, failed: true }

export const DEFAULT_PUSH_CONFIG: PushConfig = { enabled: false, pausedUntil: null, channels: [] }

function pushFilePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

/** Accept only http(s) targets — a channel URL is renderer input, never trusted. */
export function isValidPushUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

const EVENT_KINDS: readonly PushEventKind[] = ['needs-input', 'completed', 'failed']

function sanitizeEvents(raw: unknown): PushChannelEvents {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_EVENTS }
  const o = raw as Record<string, unknown>
  const pick = (key: keyof PushChannelEvents): boolean =>
    key in o ? Boolean(o[key]) : DEFAULT_EVENTS[key]
  return { needsInput: pick('needsInput'), completed: pick('completed'), failed: pick('failed') }
}

/** Coerce one persisted/renderer-supplied channel. Null = invalid, drop it. */
export function sanitizeChannel(raw: unknown): PushChannel | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Partial<PushChannel>
  const kind: PushChannelKind = c.kind === 'webhook' ? 'webhook' : 'ntfy'
  const url = typeof c.url === 'string' ? c.url.trim() : ''
  if (!isValidPushUrl(url)) return null
  const label = typeof c.label === 'string' && c.label.trim() ? c.label.trim() : url
  const token = typeof c.token === 'string' && c.token.trim() ? c.token.trim() : undefined
  return {
    id: typeof c.id === 'string' && c.id ? c.id : randomUUID(),
    kind,
    label,
    url,
    ...(token ? { token } : {}),
    enabled: c.enabled !== false,
    events: sanitizeEvents(c.events)
  }
}

/**
 * Coerce a persisted blob (or arbitrary renderer input) into a well-formed
 * `PushConfig`. Never throws; anything unrecognizable degrades to defaults.
 */
export function sanitizePushConfig(raw: unknown): PushConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PUSH_CONFIG, channels: [] }
  const o = raw as Record<string, unknown>
  const pausedUntil =
    typeof o.pausedUntil === 'number' && Number.isFinite(o.pausedUntil) && o.pausedUntil > 0
      ? o.pausedUntil
      : null
  const channels = Array.isArray(o.channels)
    ? o.channels.map(sanitizeChannel).filter((c): c is PushChannel => c !== null)
    : []
  return { enabled: Boolean(o.enabled), pausedUntil, channels }
}

/** Read + parse. Never throws — a missing/corrupt file degrades to defaults. */
export async function readPushConfig(): Promise<PushConfig> {
  let raw: string
  try {
    raw = await fs.readFile(pushFilePath(), 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.warn('[push] read failed:', err)
    return { ...DEFAULT_PUSH_CONFIG, channels: [] }
  }
  try {
    return sanitizePushConfig(JSON.parse(raw))
  } catch (err) {
    console.warn('[push] corrupt JSON:', err)
    return { ...DEFAULT_PUSH_CONFIG, channels: [] }
  }
}

/** Atomic write (tmp + rename), 0600 — channel tokens live in this file. */
async function writePushConfig(cfg: PushConfig): Promise<PushConfig> {
  const fp = pushFilePath()
  await fs.mkdir(path.dirname(fp), { recursive: true })
  const file: PushFile = { version: 1, ...cfg }
  const tmp = fp + TMP_SUFFIX
  await fs.writeFile(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await fs.rename(tmp, fp)
  return cfg
}

/** Maps a notify-kind to its per-channel opt-in flag (exhaustive by construction). */
const EVENT_FLAG: Record<PushEventKind, keyof PushChannelEvents> = {
  'needs-input': 'needsInput',
  completed: 'completed',
  failed: 'failed'
}

/**
 * The channels a `kind` event should reach right now: master switch on, not
 * paused, channel enabled, channel opted into the kind. Pure — `now` injected.
 */
export function channelsToNotify(cfg: PushConfig, kind: PushEventKind, now: number): PushChannel[] {
  if (!cfg.enabled) return []
  if (cfg.pausedUntil !== null && now < cfg.pausedUntil) return []
  return cfg.channels.filter((c) => c.enabled && c.events[EVENT_FLAG[kind]])
}

/** ntfy emoji tag per kind (rendered as ⚠️ / ✅ / ❌ in the phone notification). */
const NTFY_TAG: Record<PushEventKind, string> = {
  'needs-input': 'warning',
  completed: 'white_check_mark',
  failed: 'x'
}

/** ntfy priority: attention-demanding kinds ride high (4), completed default (3). */
const NTFY_PRIORITY: Record<PushEventKind, number> = {
  'needs-input': 4,
  completed: 3,
  failed: 4
}

export interface PushRequest {
  url: string
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
  }
}

/**
 * Shape the HTTP request for one channel. Pure — no fetch, no clock.
 *
 * - `ntfy`: JSON-publish to the server ROOT with the topic in the body (not the
 *   `Title` header) so PT-BR titles survive — HTTP headers are latin-1, the JSON
 *   body is UTF-8. The topic is the last path segment of the configured URL.
 * - `webhook`: generic JSON POST. Carries structured fields plus `text` and
 *   `content` so Slack / Discord incoming webhooks work without a dedicated kind.
 *
 * Returns null for a malformed URL / topicless ntfy URL — the caller drops it.
 */
export function buildPushRequest(
  channel: PushChannel,
  payload: PushSendPayload
): PushRequest | null {
  if (!isValidPushUrl(channel.url)) return null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (channel.token) headers.Authorization = `Bearer ${channel.token}`
  if (channel.kind === 'ntfy') {
    const u = new URL(channel.url)
    const topic = u.pathname.split('/').filter(Boolean).pop()
    if (!topic) return null
    return {
      url: u.origin,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          topic,
          title: payload.title,
          message: payload.body,
          priority: NTFY_PRIORITY[payload.kind],
          tags: [NTFY_TAG[payload.kind]]
        })
      }
    }
  }
  const text = payload.body ? `${payload.title} — ${payload.body}` : payload.title
  return {
    url: channel.url,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event: payload.kind,
        title: payload.title,
        body: payload.body,
        text,
        content: text
      })
    }
  }
}

/** Defensive gate on the fire-and-forget `push:send` payload (cf. notifications.ts). */
export function isValidSendPayload(payload: unknown): payload is PushSendPayload {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Partial<PushSendPayload>
  if (!EVENT_KINDS.includes(p.kind as PushEventKind)) return false
  return typeof p.title === 'string' && p.title.trim().length > 0 && typeof p.body === 'string'
}

/** POST one request; per-channel failures log and die here, never escape. */
async function deliver(req: PushRequest, label: string): Promise<void> {
  try {
    const res = await fetch(req.url, {
      ...req.init,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
    })
    if (!res.ok) console.warn(`[push] ${label}: HTTP ${res.status}`)
  } catch (err) {
    console.warn(`[push] ${label}: delivery failed`, err)
  }
}

/** Fan a payload out to every channel that should receive it. */
async function dispatchPush(payload: PushSendPayload): Promise<void> {
  const cfg = await readPushConfig()
  const targets = channelsToNotify(cfg, payload.kind, Date.now())
  await Promise.all(
    targets.map((ch) => {
      const req = buildPushRequest(ch, payload)
      return req ? deliver(req, ch.label) : Promise.resolve()
    })
  )
}

/** Send a synthetic test message to ONE channel draft (unsaved drafts included). */
async function testChannel(raw: unknown, title: string, body: string): Promise<PushTestResult> {
  const channel = sanitizeChannel(raw)
  if (!channel) return { ok: false, error: 'invalid-channel' }
  const req = buildPushRequest(channel, { kind: 'needs-input', title, body })
  if (!req) return { ok: false, error: 'invalid-channel' }
  try {
    const res = await fetch(req.url, {
      ...req.init,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
    })
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerPushHandlers(): void {
  ipcMain.handle('push:config:get', () => readPushConfig())
  ipcMain.handle('push:config:set', (_e, cfg: unknown) => writePushConfig(sanitizePushConfig(cfg)))
  // Fire-and-forget from the notification funnel — a slow phone relay must never
  // block the renderer's hook-stream path.
  ipcMain.on('push:send', (_e, payload: unknown) => {
    if (!isValidSendPayload(payload)) return
    void dispatchPush(payload)
  })
  ipcMain.handle(
    'push:test',
    (_e, channel: unknown, { title, body }: { title: string; body: string }) =>
      testChannel(channel, title, body)
  )
}
