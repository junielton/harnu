/**
 * T572 (browser pane U5, AC-1) — zoom: the clamp, the ladder, the remembered-per-origin map and the prefs file.
 */
import { describe, it, expect } from 'vitest'
import {
  ZOOM_STEPS,
  clampZoom,
  parseBrowserPrefs,
  serializeBrowserPrefs,
  stepZoom,
  withZoom,
  zoomFor,
  zoomOriginKey,
  zoomPercent,
  MAX_ZOOM_ORIGINS
} from '../src/shared/browser-zoom'
import { createBrowserPrefsStore } from '../src/main/browser/browser-prefs'

describe('clampZoom', () => {
  it('clamps to 0.25–5 and treats junk as 1', () => {
    expect(clampZoom(0.1)).toBe(0.25)
    expect(clampZoom(9)).toBe(5)
    expect(clampZoom(1.5)).toBe(1.5)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(-3)).toBe(1)
    expect(clampZoom(0)).toBe(1)
  })
})

describe('stepZoom', () => {
  it('walks the browser ladder in and out', () => {
    expect(stepZoom(1, 'in')).toBe(1.1)
    expect(stepZoom(1.1, 'in')).toBe(1.25)
    expect(stepZoom(1, 'out')).toBe(0.9)
    expect(stepZoom(0.9, 'out')).toBe(0.8)
  })

  it('stops at the ends', () => {
    expect(stepZoom(5, 'in')).toBe(5)
    expect(stepZoom(0.25, 'out')).toBe(0.25)
  })

  it('snaps an off-ladder factor to the next step in that direction', () => {
    expect(stepZoom(1.05, 'in')).toBe(1.1)
    expect(stepZoom(1.05, 'out')).toBe(1)
  })

  it('every step is inside the clamp', () => {
    for (const s of ZOOM_STEPS) expect(clampZoom(s)).toBe(s)
  })

  it('the percentage is rounded', () => {
    expect(zoomPercent(1.1)).toBe(110)
    expect(zoomPercent(0.33)).toBe(33)
  })
})

describe('origin key', () => {
  it('is scheme, host and port for http(s) and harnu-page, null otherwise', () => {
    expect(zoomOriginKey('https://example.com/a/b?q=1#x')).toBe('https://example.com')
    expect(zoomOriginKey('http://localhost:5173/x')).toBe('http://localhost:5173')
    expect(zoomOriginKey('harnu-page://f1/page.html')).toBe('harnu-page://f1')
    expect(zoomOriginKey('about:blank')).toBeNull()
    expect(zoomOriginKey('not a url')).toBeNull()
    expect(zoomOriginKey('')).toBeNull()
  })
})

describe('zoom by origin', () => {
  it('remembers per origin, not per page', () => {
    const m = withZoom({}, 'https://a.test/x', 1.5)
    expect(zoomFor(m, 'https://a.test/other')).toBe(1.5)
    expect(zoomFor(m, 'https://b.test/x')).toBe(1)
    expect(zoomFor(m, 'http://a.test/x')).toBe(1)
  })

  it('1.0 forgets the origin, and a URL with no origin changes nothing', () => {
    const m = withZoom({}, 'https://a.test', 2)
    expect(withZoom(m, 'https://a.test', 1)).toEqual({})
    expect(withZoom(m, 'about:blank', 3)).toBe(m)
  })

  it('returns the same object when nothing changed', () => {
    const m = withZoom({}, 'https://a.test', 2)
    expect(withZoom(m, 'https://a.test', 2)).toBe(m)
    expect(withZoom({}, 'https://a.test', 1)).toEqual({})
  })

  it('clamps what it stores', () => {
    expect(zoomFor(withZoom({}, 'https://a.test', 99), 'https://a.test')).toBe(5)
  })

  it('keeps at most MAX_ZOOM_ORIGINS, dropping the least recently set', () => {
    let m: Record<string, number> = {}
    for (let i = 0; i < MAX_ZOOM_ORIGINS + 5; i++) m = { ...withZoom(m, `https://h${i}.test`, 2) }
    expect(Object.keys(m)).toHaveLength(MAX_ZOOM_ORIGINS)
    expect(m['https://h0.test']).toBeUndefined()
    expect(m[`https://h${MAX_ZOOM_ORIGINS + 4}.test`]).toBe(2)
  })
})

describe('browser-prefs.json', () => {
  it('round-trips', () => {
    const text = serializeBrowserPrefs({ version: 1, zoomByOrigin: { 'https://a.test': 1.25 } })
    expect(parseBrowserPrefs(text).zoomByOrigin).toEqual({ 'https://a.test': 1.25 })
  })

  it('survives garbage: unreadable text is empty, bad entries are dropped', () => {
    expect(parseBrowserPrefs('not json').zoomByOrigin).toEqual({})
    expect(parseBrowserPrefs('[]').zoomByOrigin).toEqual({})
    const p = parseBrowserPrefs(
      JSON.stringify({
        zoomByOrigin: {
          'https://ok.test': 2,
          'file:///etc/passwd': 2,
          'https://nan.test': 'x',
          'https://one.test': 1,
          'https://big.test': 50
        }
      })
    )
    expect(p.zoomByOrigin).toEqual({ 'https://ok.test': 2, 'https://big.test': 5 })
  })

  it('the store loads once, persists every change and forgets 1.0', () => {
    let disk: string | null = null
    let writes = 0
    const store = createBrowserPrefsStore({
      read: () => disk,
      write: (t) => {
        disk = t
        writes++
      }
    })
    expect(store.zoomFor('https://a.test/x')).toBe(1)
    store.setZoom('https://a.test/x', 1.5)
    expect(writes).toBe(1)
    expect(store.zoomFor('https://a.test/y')).toBe(1.5)
    store.setZoom('https://a.test/y', 1.5)
    expect(writes).toBe(1)
    expect(JSON.parse(disk!).zoomByOrigin).toEqual({ 'https://a.test': 1.5 })
    // A fresh store reads what the first wrote: the zoom survives a restart.
    const again = createBrowserPrefsStore({ read: () => disk, write: () => undefined })
    expect(again.zoomFor('https://a.test/z')).toBe(1.5)
    store.setZoom('https://a.test', 1)
    expect(JSON.parse(disk!).zoomByOrigin).toEqual({})
  })

  it('a failing disk keeps the zoom for this run', () => {
    const store = createBrowserPrefsStore({
      read: () => {
        throw new Error('EACCES')
      },
      write: () => {
        throw new Error('EROFS')
      }
    })
    store.setZoom('https://a.test', 2)
    expect(store.zoomFor('https://a.test')).toBe(2)
  })
})
