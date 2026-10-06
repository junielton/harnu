// @vitest-environment jsdom
/**
 * `acquireAltTracker` lives in `terminal-file-links.ts` alongside the pure
 * extractor/provider logic, but it touches `document`/`window`, so it gets its
 * own jsdom-environment file rather than pulling the whole module's test file
 * into jsdom (see the brief for why the main file stays `node`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { acquireAltTracker } from '../src/renderer/src/lib/terminal-file-links'

describe('acquireAltTracker', () => {
  beforeEach(() => {
    // jsdom has no layout engine, so `elementFromPoint` isn't implemented at
    // all — stub a default of "nothing under the pointer" so a press/release
    // that doesn't care about the resync target (most tests below) doesn't
    // crash. Tests that DO care override this with their own mock.
    document.elementFromPoint = vi.fn().mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('reflects Alt press and release at the window level', () => {
    const tracker = acquireAltTracker()
    expect(tracker.isAltHeld()).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true }))
    expect(tracker.isAltHeld()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keyup', { altKey: false }))
    expect(tracker.isAltHeld()).toBe(false)
    tracker.release()
  })

  it('also reflects Ctrl press and release (Ctrl+click opens links too)', () => {
    const tracker = acquireAltTracker()
    expect(tracker.isAltHeld()).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true }))
    expect(tracker.isAltHeld()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keyup', { ctrlKey: false }))
    expect(tracker.isAltHeld()).toBe(false)
    tracker.release()
  })

  it('stays held while one of Alt/Ctrl is released but the other is still down', () => {
    const tracker = acquireAltTracker()
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { altKey: false, ctrlKey: true }))
    expect(tracker.isAltHeld()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keyup', { altKey: false, ctrlKey: false }))
    expect(tracker.isAltHeld()).toBe(false)
    tracker.release()
  })

  it('shares one tracker across concurrent acquisitions and only tears down at zero refcount', () => {
    const a = acquireAltTracker()
    const b = acquireAltTracker()
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true }))
    expect(a.isAltHeld()).toBe(true)
    expect(b.isAltHeld()).toBe(true)

    a.release()
    // `b` still holds a reference — the shared listeners must still be live.
    window.dispatchEvent(new KeyboardEvent('keyup', { altKey: false }))
    expect(b.isAltHeld()).toBe(false)

    b.release()
  })

  it('release is idempotent — a second release does not double-decrement the refcount', () => {
    const a = acquireAltTracker()
    a.release()
    a.release() // must not throw, must not affect the tracker below

    const b = acquireAltTracker()
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true }))
    expect(b.isAltHeld()).toBe(true)
    b.release()
  })

  it('forces a genuine cell transition on a modifier edge, WITHOUT clobbering the real position', () => {
    // Reproduces the bug: xterm's own mousemove handler no-ops when an event
    // lands on the same buffer cell it last saw, so simply re-dispatching at
    // the unchanged pointer position (the old behaviour) never reaches
    // `provideLinks` again. The fix dispatches a decoy move at a different row
    // FIRST, then the real position.
    //
    // The element MUST be attached to `document.body` — the tracker's own
    // position listener is `document.addEventListener('mousemove', ..., true)`
    // (capture phase), which only sees events that actually propagate through
    // the document tree. A detached element has no such path, so a version of
    // this test that never appends the element would pass even for a broken
    // fix that reads the position AFTER dispatching the decoy (the decoy's
    // own dispatch would silently clobber `lastClientX`/`lastClientY` via that
    // same listener before the "real" dispatch reads them) — the false-green
    // this exact regression produced.
    const moves: MouseEvent[] = []
    const target = document.createElement('div')
    target.addEventListener('mousemove', (e) => moves.push(e as MouseEvent))
    document.body.appendChild(target)
    // jsdom doesn't implement `elementFromPoint` (no layout engine) — stub it
    // directly rather than `vi.spyOn`, which requires the property to exist.
    document.elementFromPoint = vi.fn().mockReturnValue(target)

    const tracker = acquireAltTracker()
    // Seed the tracker's last-known position via `document` — the capture
    // listener sees it either way, and dispatching on `target` here would
    // also trigger `target`'s OWN listener above, polluting `moves` with an
    // entry that isn't one of the resync's synthetic dispatches.
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }))
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true }))

    expect(moves.length).toBeGreaterThanOrEqual(2)
    const real = moves[moves.length - 1]
    // The real dispatch must land at the pointer's ACTUAL last-known
    // position, not at whatever the decoy dispatch overwrote it to.
    expect(real.clientX).toBe(100)
    expect(real.clientY).toBe(100)
    const decoy = moves[moves.length - 2]
    expect(decoy.clientX).toBe(100)
    expect(decoy.clientY).not.toBe(real.clientY)

    tracker.release()
  })

  it('resyncs on blur only when Alt was actually held', () => {
    const moves: MouseEvent[] = []
    const target = document.createElement('div')
    target.addEventListener('mousemove', (e) => moves.push(e as MouseEvent))
    document.body.appendChild(target)
    // jsdom doesn't implement `elementFromPoint` (no layout engine) — stub it
    // directly rather than `vi.spyOn`, which requires the property to exist.
    document.elementFromPoint = vi.fn().mockReturnValue(target)

    const tracker = acquireAltTracker()
    // Seed via `document` — dispatching on `target` would also trigger
    // `target`'s own listener above and pollute the "nothing happened yet"
    // assertion below.
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }))

    // Alt never pressed — a blur must not synthesize a resync.
    window.dispatchEvent(new Event('blur'))
    expect(moves).toHaveLength(0)

    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true }))
    moves.length = 0 // discard the press's own resync
    window.dispatchEvent(new Event('blur'))
    expect(moves.length).toBeGreaterThanOrEqual(2)
    expect(moves[moves.length - 1].clientX).toBe(10)
    expect(moves[moves.length - 1].clientY).toBe(10)
    expect(tracker.isAltHeld()).toBe(false)

    tracker.release()
  })
})
