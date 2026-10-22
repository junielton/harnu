/**
 * T571 Delta 2 (AC-8) — the two operator-only folder settings (browser read opt-in, trusted dev hosts) accept calls
 * only from the app window's own webContents and only with the payload the editor could have produced.
 */
import { describe, it, expect } from 'vitest'
import {
  isFromAppWindow,
  parseBrowserReadPayload,
  parseTrustedHostsPayload
} from '../src/main/browser/folder-flag-ipc'
import { MAX_TRUSTED_HOSTS } from '../src/shared/browser-trusted-hosts'

const KNOWN = ['/work/app', '/work/other']
const HOME = '/home/u'

describe('isFromAppWindow', () => {
  const wc = {}
  const win = { isDestroyed: () => false, webContents: wc }
  it('accepts only the app window’s own webContents', () => {
    expect(isFromAppWindow(wc, win)).toBe(true)
    expect(isFromAppWindow({}, win)).toBe(false) // a guest page's webContents
    expect(isFromAppWindow(undefined, win)).toBe(false)
  })
  it('refuses when there is no window or it is gone', () => {
    expect(isFromAppWindow(wc, null)).toBe(false)
    expect(isFromAppWindow(wc, { ...win, isDestroyed: () => true })).toBe(false)
  })
})

describe('parseBrowserReadPayload', () => {
  it('accepts a known folder and a boolean', () => {
    expect(
      parseBrowserReadPayload({ targetPath: '/work/app', enabled: true }, KNOWN, HOME)
    ).toEqual({
      ok: true,
      targetPath: '/work/app',
      enabled: true
    })
    expect(
      parseBrowserReadPayload({ targetPath: '/work/app/', enabled: false }, KNOWN, HOME)
    ).toMatchObject({ ok: true, enabled: false })
  })
  it.each([
    [undefined],
    [null],
    ['x'],
    [[]],
    [{ targetPath: '/work/app' }],
    [{ targetPath: '/work/app', enabled: 'true' }],
    [{ targetPath: '/work/app', enabled: 1 }],
    [{ enabled: true }],
    [{ targetPath: 5, enabled: true }]
  ])('refuses the malformed payload %j as BAD_ARGS', (raw) => {
    expect(parseBrowserReadPayload(raw, KNOWN, HOME)).toEqual({ ok: false, error: 'BAD_ARGS' })
  })
  it('refuses a folder Harnu does not track, and a path with a NUL', () => {
    expect(parseBrowserReadPayload({ targetPath: '/etc', enabled: true }, KNOWN, HOME)).toEqual({
      ok: false,
      error: 'UNKNOWN_FOLDER'
    })
    expect(parseBrowserReadPayload({ targetPath: '', enabled: true }, KNOWN, HOME)).toEqual({
      ok: false,
      error: 'UNKNOWN_FOLDER'
    })
    expect(
      parseBrowserReadPayload({ targetPath: '/work/app\0', enabled: true }, KNOWN, HOME)
    ).toMatchObject({ ok: false })
  })
})

describe('parseTrustedHostsPayload', () => {
  const ok = (hosts: unknown) =>
    parseTrustedHostsPayload({ targetPath: '/work/app', hosts }, KNOWN, HOME)
  it('accepts valid hosts, normalised and de-duplicated', () => {
    expect(ok(['App.Test', '*.test', 'app.test', 'web'])).toEqual({
      ok: true,
      targetPath: '/work/app',
      hosts: ['app.test', '*.test', 'web']
    })
    expect(ok([])).toMatchObject({ ok: true, hosts: [] })
  })
  it('refuses the whole call when any entry is something the editor would have refused', () => {
    for (const bad of [
      ['*.com'],
      ['http://x'],
      ['a.test', 'b:3000'],
      [''],
      ['*'],
      ['x'.repeat(300)],
      [5],
      [null],
      [['a']]
    ]) {
      expect(ok(bad), JSON.stringify(bad)).toEqual({ ok: false, error: 'BAD_HOSTS' })
    }
  })
  it('caps the count', () => {
    const many = Array.from({ length: MAX_TRUSTED_HOSTS + 1 }, (_, i) => `h${i}.test`)
    expect(ok(many)).toEqual({ ok: false, error: 'BAD_HOSTS' })
    expect(ok(many.slice(0, MAX_TRUSTED_HOSTS))).toMatchObject({ ok: true })
  })
  it('refuses a non-array, a missing folder and an unknown folder', () => {
    expect(ok('a.test')).toEqual({ ok: false, error: 'BAD_ARGS' })
    expect(parseTrustedHostsPayload({ hosts: [] }, KNOWN, HOME)).toEqual({
      ok: false,
      error: 'BAD_ARGS'
    })
    expect(parseTrustedHostsPayload({ targetPath: '/etc', hosts: [] }, KNOWN, HOME)).toEqual({
      ok: false,
      error: 'UNKNOWN_FOLDER'
    })
    expect(parseTrustedHostsPayload(null, KNOWN, HOME)).toEqual({ ok: false, error: 'BAD_ARGS' })
  })
})
