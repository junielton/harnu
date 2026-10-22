/**
 * T568 (browser pane U1) — the navigation policy matrix (spec §3.2).
 */
import { describe, it, expect } from 'vitest'
import {
  certificateDecision,
  checkTopLevelNavigation,
  decidePopup,
  isPermissionGranted,
  isSubresourceSchemeAllowed,
  shouldFlagNavigation,
  URL_SCHEME_BLOCKED
} from '../src/main/browser/nav-policy'

describe('checkTopLevelNavigation', () => {
  it('allows http, https and about:blank from every initiator', () => {
    for (const initiator of ['verb', 'operator', 'page'] as const) {
      expect(checkTopLevelNavigation('https://example.com/a?b=1', initiator).ok).toBe(true)
      expect(checkTopLevelNavigation('http://localhost:3000', initiator).ok).toBe(true)
      expect(checkTopLevelNavigation('about:blank', initiator).ok).toBe(true)
    }
  })

  it.each([
    ['file:///etc/passwd', 'file'],
    ['chrome://settings', 'chrome'],
    ['chrome-extension://abc/page.html', 'chrome-extension'],
    ['devtools://devtools/bundled/inspector.html', 'devtools'],
    ['view-source:https://example.com', 'view-source'],
    ['javascript:alert(1)', 'javascript'],
    ['harnu-voice://x', 'harnu-voice'],
    ['capy-voice://x', 'capy-voice'],
    ['data:text/html,<h1>x</h1>', 'data'],
    ['blob:https://example.com/uuid', 'blob'],
    ['ftp://example.com/', 'ftp'],
    ['about:srcdoc', 'about']
  ])('refuses %s as URL_SCHEME_BLOCKED', (url, scheme) => {
    for (const initiator of ['verb', 'operator', 'page'] as const) {
      expect(checkTopLevelNavigation(url, initiator)).toEqual({
        ok: false,
        code: URL_SCHEME_BLOCKED,
        scheme
      })
    }
  })

  it('refuses an unparseable target', () => {
    expect(checkTopLevelNavigation('::::', 'verb')).toEqual({
      ok: false,
      code: URL_SCHEME_BLOCKED,
      scheme: ''
    })
  })

  it('reaches harnu-page: only from a verb or the operator, never from a link inside a page', () => {
    const url = 'harnu-page://f0123456789ab/panel.html'
    expect(checkTopLevelNavigation(url, 'verb').ok).toBe(true)
    expect(checkTopLevelNavigation(url, 'operator').ok).toBe(true)
    expect(checkTopLevelNavigation(url, 'page').ok).toBe(false)
  })
})

describe('isSubresourceSchemeAllowed', () => {
  it('adds blob, data, ws and wss to the top-level set', () => {
    for (const url of [
      'https://cdn.example.com/a.js',
      'blob:https://example.com/x',
      'data:image/png;base64,AAAA',
      'ws://localhost:5173/',
      'wss://example.com/socket',
      'harnu-page://f0123456789ab/a.css'
    ]) {
      expect(isSubresourceSchemeAllowed(url), url).toBe(true)
    }
  })

  it('blocks file, chrome and the app voice schemes', () => {
    for (const url of ['file:///etc/passwd', 'chrome://gpu', 'harnu-voice://m', 'capy-voice://m']) {
      expect(isSubresourceSchemeAllowed(url), url).toBe(false)
    }
  })
})

describe('decidePopup', () => {
  it('opens a pane only with a real user activation and an allowed scheme', () => {
    expect(decidePopup('https://example.com/x', true)).toEqual({
      action: 'open-pane',
      url: 'https://example.com/x'
    })
    expect(decidePopup('https://example.com/x', false)).toEqual({
      action: 'deny',
      reason: 'no-activation'
    })
    expect(decidePopup('file:///etc/passwd', true)).toEqual({
      action: 'deny',
      reason: 'scheme-blocked'
    })
  })

  it('never lets a popup land on harnu-page: from inside a page', () => {
    expect(decidePopup('harnu-page://f0123456789ab/a.html', true).action).toBe('deny')
  })
})

describe('permissions, certificates and the agent flag', () => {
  it('grants only clipboard-sanitized-write', () => {
    expect(isPermissionGranted('clipboard-sanitized-write')).toBe(true)
    for (const p of [
      'geolocation',
      'notifications',
      'media',
      'clipboard-read',
      'midi',
      'fullscreen'
    ]) {
      expect(isPermissionGranted(p), p).toBe(false)
    }
  })

  it('accepts a certificate error only on a loopback host', () => {
    expect(certificateDecision('localhost', true)).toBe('accept-flagged')
    expect(certificateDecision('example.com', false)).toBe('deny')
    expect(certificateDecision('', true)).toBe('deny')
  })

  it('flags a verb navigation to a host the pane has not shown, and nothing else', () => {
    const seen = new Set(['localhost:5173'])
    expect(shouldFlagNavigation('verb', 'docs.example.com', seen)).toBe(true)
    expect(shouldFlagNavigation('verb', 'localhost:5173', seen)).toBe(false)
    expect(shouldFlagNavigation('operator', 'docs.example.com', seen)).toBe(false)
    expect(shouldFlagNavigation('page', 'docs.example.com', seen)).toBe(false)
    expect(shouldFlagNavigation('verb', '', seen)).toBe(false)
  })
})
