import { describe, it, expect, afterEach } from 'vitest'
import { request } from 'node:http'
import {
  buildHookSettingsBlob,
  buildHookSettingsBlobJson,
  composeSettingsArgs,
  injectHookSettings,
  mergeInlineSettings,
  HOOK_TIMEOUT_S,
  NEEDS_YOU_NOTIFICATION_TYPES
} from '../src/main/hook-settings-blob'
import { startHookServer, type BridgeEvent } from '../src/main/hook-bridge'

/**
 * T92 per-session hook injection blob (`hook-settings-blob.ts`). Two concerns:
 *  1. The blob is a well-formed Claude Code settings source pointing at the bridge.
 *  2. Injecting it into an argv NEVER clobbers a user-provided `--settings` (the
 *     three merge cases: none / file path / inline JSON).
 * Plus a live-bridge auth check: the blob's own URLs authenticate, and a tampered
 * token is rejected (listener auth — "reject without token").
 */

const PORT = 54321
const TOKEN = 'tok-abc'

describe('buildHookSettingsBlob', () => {
  const blob = buildHookSettingsBlob(PORT, TOKEN)

  it('sets preferredNotifChannel to notifications_disabled (Harnu owns notifications)', () => {
    expect(blob.preferredNotifChannel).toBe('notifications_disabled')
  })

  it('subscribes exactly the narrow state event set (no chatty/decision events)', () => {
    expect(Object.keys(blob.hooks).sort()).toEqual(
      ['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort()
    )
    // never the high-frequency / decision-carrying events (those stay global-only)
    expect(blob.hooks.PreToolUse).toBeUndefined()
    expect(blob.hooks.PermissionRequest).toBeUndefined()
    expect(blob.hooks.PostToolUse).toBeUndefined()
  })

  it('every handler is an http hook at the bridge URL with the 5s timeout', () => {
    const handlers = Object.values(blob.hooks).flatMap((entries) => entries.flatMap((e) => e.hooks))
    expect(handlers.length).toBeGreaterThan(0)
    for (const h of handlers) {
      expect(h.type).toBe('http')
      expect(h.timeout).toBe(HOOK_TIMEOUT_S)
      expect(h.timeout).toBe(5)
      expect(String(h.url)).toMatch(
        new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/hook/${TOKEN}/[A-Za-z]+/[A-Za-z_]+$`)
      )
    }
  })

  it('routes each blocking notification type on its own matcher entry', () => {
    const matchers = blob.hooks.Notification.map((e) => e.matcher)
    for (const t of NEEDS_YOU_NOTIFICATION_TYPES) expect(matchers).toContain(t)
    // idle_prompt is still subscribed (so idle relaxes event-drivenly), just not "needs-you"
    expect(matchers).toContain('idle_prompt')
    // the URL tag matches the notification_type so the bridge recovers the matcher
    for (const entry of blob.hooks.Notification) {
      expect(String(entry.hooks[0].url)).toContain(`/Notification/${entry.matcher}`)
    }
  })

  it('buildHookSettingsBlobJson is compact, single-line, parseable', () => {
    const json = buildHookSettingsBlobJson(PORT, TOKEN)
    expect(json).not.toContain('\n')
    expect(JSON.parse(json)).toEqual(blob)
  })
})

describe('injectHookSettings (merge with a user --settings)', () => {
  const blobJson = buildHookSettingsBlobJson(PORT, TOKEN)
  const parseAfterFlag = (args: string[]): string[] => {
    // collect every --settings value (both forms)
    const vals: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--settings') vals.push(args[i + 1])
      else if (args[i].startsWith('--settings=')) vals.push(args[i].slice(11))
    }
    return vals
  }

  it('CASE none: no user --settings → appends our blob', () => {
    const out = injectHookSettings(['--resume', 'uuid', '--model', 'opus'], blobJson)
    expect(out).toEqual(['--resume', 'uuid', '--model', 'opus', '--settings', blobJson])
  })

  it('CASE file path: keeps the user path verbatim and does NOT add ours (no clobber)', () => {
    const out = injectHookSettings(
      ['--settings', '/home/u/settings.json', '--model', 'opus'],
      blobJson
    )
    const vals = parseAfterFlag(out)
    expect(vals).toEqual(['/home/u/settings.json']) // ours skipped — path never lost
    expect(out).toContain('--model') // other flags preserved
  })

  it('CASE inline JSON: deep-merges our hooks in, keeps the user hooks + keys', () => {
    const userInline = JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
      permissions: { allow: ['Bash'] }
    })
    const out = injectHookSettings(['--settings', userInline], blobJson)
    const vals = parseAfterFlag(out)
    expect(vals).toHaveLength(1) // composed into ONE --settings value
    const merged = JSON.parse(vals[0])
    // user's UserPromptSubmit entry preserved AND ours appended after it
    expect(merged.hooks.UserPromptSubmit).toHaveLength(2)
    expect(merged.hooks.UserPromptSubmit[0].hooks[0].command).toBe('echo hi')
    expect(merged.hooks.UserPromptSubmit[1].hooks[0].type).toBe('http')
    // our other events added
    expect(merged.hooks.Stop[0].hooks[0].type).toBe('http')
    // unrelated user key untouched; our notif channel filled in
    expect(merged.permissions).toEqual({ allow: ['Bash'] })
    expect(merged.preferredNotifChannel).toBe('notifications_disabled')
  })

  it('CASE inline JSON: never overrides a user-chosen preferredNotifChannel', () => {
    const userInline = JSON.stringify({ preferredNotifChannel: 'iterm2' })
    const merged = JSON.parse(
      parseAfterFlag(injectHookSettings(['--settings', userInline], blobJson))[0]
    )
    expect(merged.preferredNotifChannel).toBe('iterm2')
  })

  it('handles the --settings=<v> single-token form', () => {
    const out = injectHookSettings(['--settings=/etc/s.json'], blobJson)
    expect(parseAfterFlag(out)).toEqual(['/etc/s.json'])
  })

  it('more than one user --settings → keeps them all, skips ours (too ambiguous to merge)', () => {
    const out = injectHookSettings(['--settings', 'a.json', '--settings', 'b.json'], blobJson)
    expect(parseAfterFlag(out)).toEqual(['a.json', 'b.json'])
  })

  it('composeSettingsArgs: unparseable inline (starts with { but broken) → kept verbatim', () => {
    const broken = '{not json'
    expect(composeSettingsArgs(broken, blobJson)).toEqual(['--settings', broken])
  })

  it('mergeInlineSettings returns null for a non-object user value', () => {
    expect(mergeInlineSettings('[1,2,3]', blobJson)).toBeNull()
    expect(mergeInlineSettings('"a string"', blobJson)).toBeNull()
  })
})

describe('blob URLs authenticate against the live bridge (listener auth)', () => {
  let close: (() => Promise<void>) | null = null
  afterEach(async () => {
    if (close) await close()
    close = null
  })

  const post = (
    port: number,
    path: string,
    body: unknown
  ): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
        },
        (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
        }
      )
      req.on('error', reject)
      req.write(data)
      req.end()
    })

  it('a POST to a blob URL is accepted (200) and emits; a tampered token is rejected (403)', async () => {
    const events: BridgeEvent[] = []
    const started = await startHookServer((e) => events.push(e), TOKEN)
    close = started.close
    // Take one of the blob's own hook URLs (built for the real port + token).
    const blob = buildHookSettingsBlob(started.port, TOKEN)
    const url = new URL(String(blob.hooks.UserPromptSubmit[0].hooks[0].url))

    const ok = await post(started.port, url.pathname, { session_id: 'S1', cwd: '/x' })
    expect(ok.status).toBe(200)
    expect(ok.text).toBe('{}') // pure observer — never a decision
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ sessionId: 'S1', event: 'UserPromptSubmit' })

    // Same path, wrong token → rejected, nothing emitted.
    const badPath = url.pathname.replace(`/hook/${TOKEN}/`, '/hook/WRONG/')
    const bad = await post(started.port, badPath, { session_id: 'S2' })
    expect(bad.status).toBe(403)
    expect(events).toHaveLength(1)
  })
})
