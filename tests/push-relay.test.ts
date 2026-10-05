import { describe, it, expect, vi } from 'vitest'
import * as os from 'node:os'

/**
 * Pure-logic suite for the remote-push relay (`src/main/push.ts`): config
 * sanitization (renderer input + disk blobs are both untrusted), the
 * master/pause/per-channel delivery gate, and the per-kind HTTP request shape
 * (ntfy JSON-publish vs generic webhook).
 */

// push.ts imports `electron` at module top; stub it so the pure helpers are
// importable without an Electron runtime (cf. settings-path-containment.test.ts).
vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir() },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

import {
  sanitizeChannel,
  sanitizePushConfig,
  channelsToNotify,
  buildPushRequest,
  isValidSendPayload,
  DEFAULT_PUSH_CONFIG,
  type PushChannel,
  type PushConfig
} from '../src/main/push'

function channel(over: Partial<PushChannel> = {}): PushChannel {
  return {
    id: 'c1',
    kind: 'ntfy',
    label: 'Phone',
    url: 'https://ntfy.sh/harnu-secret',
    enabled: true,
    events: { needsInput: true, completed: true, failed: true },
    ...over
  }
}

describe('sanitizeChannel', () => {
  it('drops a channel without a valid http(s) URL', () => {
    expect(sanitizeChannel({ url: 'ftp://x' })).toBeNull()
    expect(sanitizeChannel({ url: 'not a url' })).toBeNull()
    expect(sanitizeChannel({ url: '' })).toBeNull()
    expect(sanitizeChannel(null)).toBeNull()
  })

  it('fills defaults: generated id, url as label, enabled, all events on', () => {
    const c = sanitizeChannel({ url: 'https://ntfy.sh/t' })
    expect(c).not.toBeNull()
    expect(c!.id).toBeTruthy()
    expect(c!.label).toBe('https://ntfy.sh/t')
    expect(c!.enabled).toBe(true)
    expect(c!.events).toEqual({ needsInput: true, completed: true, failed: true })
    expect(c!.kind).toBe('ntfy')
  })

  it('coerces an unknown kind to ntfy and keeps webhook', () => {
    expect(sanitizeChannel({ url: 'https://x.dev/h', kind: 'webhook' })!.kind).toBe('webhook')
    expect(sanitizeChannel({ url: 'https://x.dev/h', kind: 'pigeon' })!.kind).toBe('ntfy')
  })

  it('drops a blank token, keeps a real one', () => {
    expect(sanitizeChannel({ url: 'https://x.dev/h', token: '  ' })!.token).toBeUndefined()
    expect(sanitizeChannel({ url: 'https://x.dev/h', token: 'tk' })!.token).toBe('tk')
  })
})

describe('sanitizePushConfig', () => {
  it('degrades garbage to defaults', () => {
    expect(sanitizePushConfig(null)).toEqual(DEFAULT_PUSH_CONFIG)
    expect(sanitizePushConfig('nope')).toEqual(DEFAULT_PUSH_CONFIG)
    expect(sanitizePushConfig(42)).toEqual(DEFAULT_PUSH_CONFIG)
  })

  it('drops invalid channels but keeps valid ones', () => {
    const cfg = sanitizePushConfig({
      enabled: true,
      channels: [{ url: 'https://ntfy.sh/a' }, { url: 'garbage' }, null]
    })
    expect(cfg.enabled).toBe(true)
    expect(cfg.channels).toHaveLength(1)
  })

  it('rejects a non-positive or non-numeric pausedUntil', () => {
    expect(sanitizePushConfig({ pausedUntil: -5 }).pausedUntil).toBeNull()
    expect(sanitizePushConfig({ pausedUntil: 'soon' }).pausedUntil).toBeNull()
    expect(sanitizePushConfig({ pausedUntil: 123 }).pausedUntil).toBe(123)
  })
})

describe('channelsToNotify', () => {
  const base: PushConfig = { enabled: true, pausedUntil: null, channels: [channel()] }

  it('is empty when the master switch is off', () => {
    expect(channelsToNotify({ ...base, enabled: false }, 'needs-input', 0)).toEqual([])
  })

  it('is empty while paused, delivers again after the pause expires', () => {
    const paused = { ...base, pausedUntil: 1000 }
    expect(channelsToNotify(paused, 'needs-input', 999)).toEqual([])
    expect(channelsToNotify(paused, 'needs-input', 1000)).toHaveLength(1)
  })

  it('filters disabled channels and per-event opt-outs', () => {
    const cfg: PushConfig = {
      enabled: true,
      pausedUntil: null,
      channels: [
        channel({ id: 'off', enabled: false }),
        channel({
          id: 'no-completed',
          events: { needsInput: true, completed: false, failed: true }
        }),
        channel({ id: 'all' })
      ]
    }
    expect(channelsToNotify(cfg, 'completed', 0).map((c) => c.id)).toEqual(['all'])
    expect(channelsToNotify(cfg, 'needs-input', 0).map((c) => c.id)).toEqual([
      'no-completed',
      'all'
    ])
  })
})

describe('buildPushRequest', () => {
  const payload = {
    kind: 'needs-input' as const,
    title: 'Precisa de você',
    body: 'harnu · fix bug'
  }

  it('ntfy: JSON-publishes to the server root with the topic in the body', () => {
    const req = buildPushRequest(channel(), payload)
    expect(req).not.toBeNull()
    expect(req!.url).toBe('https://ntfy.sh')
    const body = JSON.parse(req!.init.body)
    expect(body.topic).toBe('harnu-secret')
    expect(body.title).toBe('Precisa de você')
    expect(body.message).toBe('harnu · fix bug')
    expect(body.priority).toBe(4)
    expect(body.tags).toEqual(['warning'])
  })

  it('ntfy: completed rides default priority (3)', () => {
    const req = buildPushRequest(channel(), { ...payload, kind: 'completed' })
    expect(JSON.parse(req!.init.body).priority).toBe(3)
  })

  it('ntfy: a topicless URL is rejected', () => {
    expect(buildPushRequest(channel({ url: 'https://ntfy.sh' }), payload)).toBeNull()
    expect(buildPushRequest(channel({ url: 'https://ntfy.sh/' }), payload)).toBeNull()
  })

  it('ntfy: a self-hosted server keeps its origin', () => {
    const req = buildPushRequest(channel({ url: 'http://192.168.0.10:8080/harnu' }), payload)
    expect(req!.url).toBe('http://192.168.0.10:8080')
    expect(JSON.parse(req!.init.body).topic).toBe('harnu')
  })

  it('webhook: POSTs generic JSON with Slack/Discord-compatible text/content', () => {
    const req = buildPushRequest(
      channel({ kind: 'webhook', url: 'https://hooks.slack.com/services/x' }),
      payload
    )
    expect(req!.url).toBe('https://hooks.slack.com/services/x')
    const body = JSON.parse(req!.init.body)
    expect(body.event).toBe('needs-input')
    expect(body.text).toBe('Precisa de você — harnu · fix bug')
    expect(body.content).toBe(body.text)
  })

  it('sets a Bearer Authorization header only when a token exists', () => {
    const noToken = buildPushRequest(channel(), payload)
    expect(noToken!.init.headers.Authorization).toBeUndefined()
    const withToken = buildPushRequest(channel({ token: 'tk_1' }), payload)
    expect(withToken!.init.headers.Authorization).toBe('Bearer tk_1')
  })
})

describe('isValidSendPayload', () => {
  it('accepts the three kinds with a non-empty title', () => {
    expect(isValidSendPayload({ kind: 'needs-input', title: 'x', body: '' })).toBe(true)
    expect(isValidSendPayload({ kind: 'completed', title: 'x', body: 'y' })).toBe(true)
    expect(isValidSendPayload({ kind: 'failed', title: 'x', body: 'y' })).toBe(true)
  })

  it('rejects unknown kinds, blank titles, and non-objects', () => {
    expect(isValidSendPayload({ kind: 'working', title: 'x', body: '' })).toBe(false)
    expect(isValidSendPayload({ kind: 'failed', title: '  ', body: '' })).toBe(false)
    expect(isValidSendPayload({ kind: 'failed', title: 'x' })).toBe(false)
    expect(isValidSendPayload(null)).toBe(false)
  })
})
