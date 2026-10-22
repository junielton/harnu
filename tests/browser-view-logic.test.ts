/**
 * T568 delta 2 (AC-3, AC-4, AC-6) — the decisions the electron-bound view host makes, as pure functions:
 * freeze/thaw rect choice, the freeze-generation race, the one-popup-per-activation gate, the certificate host
 * rule and the "opened by agent" flag; plus the gate-resolution function the MCP shell calls.
 */
import { describe, it, expect } from 'vitest'
import {
  FreezeGeneration,
  GESTURE_WINDOW_MS,
  certificateVerdictFor,
  createGestureGate,
  decideFreeze,
  flagAfterOperatorAction,
  flagAfterVerbNavigation,
  type FreezeView
} from '../src/main/browser/view-logic'
import { resolveGateInput } from '../src/main/browser/gate-resolve'
import { parkedBounds } from '../src/main/browser/bounds'
import type { BrowserPaneRecord } from '../src/main/browser/registry'

const parkedRect = parkedBounds({ width: 1280, height: 800 })
const live = (over: Partial<FreezeView> = {}): FreezeView => ({
  parked: false,
  visibleReported: true,
  rectCss: { x: 400, y: 100, width: 600, height: 500 },
  frozen: false,
  ...over
})
const ctx = (over: Partial<Parameters<typeof decideFreeze>[1]> = {}) => ({
  overlays: [] as Parameters<typeof decideFreeze>[1]['overlays'],
  dragActive: false,
  parkedRect,
  ...over
})

describe('decideFreeze', () => {
  it('freezes a live view under an overlay, thaws it when the overlay is gone, and otherwise keeps', () => {
    const overlay = [{ x: 900, y: 50, width: 200, height: 100 }]
    expect(decideFreeze(live(), ctx({ overlays: overlay }))).toBe('freeze')
    expect(decideFreeze(live({ frozen: true }), ctx({ overlays: overlay }))).toBe('keep')
    expect(decideFreeze(live({ frozen: true }), ctx())).toBe('thaw')
    expect(decideFreeze(live(), ctx())).toBe('keep')
  })

  it('judges a PARKED view on its 1×1 corner, so a toast there hides it and a far overlay does not', () => {
    const corner = [{ x: 1000, y: 700, width: 280, height: 100 }]
    const far = [{ x: 0, y: 0, width: 300, height: 800 }]
    expect(
      decideFreeze(
        live({ parked: true, rectCss: null, visibleReported: false }),
        ctx({ overlays: corner })
      )
    ).toBe('freeze')
    expect(
      decideFreeze(
        live({ parked: true, rectCss: null, visibleReported: false }),
        ctx({ overlays: far })
      )
    ).toBe('keep')
  })

  it('a hidden pane (not reported visible, not parked) is never touched, even by a fullscreen layer', () => {
    expect(decideFreeze(live({ visibleReported: false }), ctx({ overlays: ['fullscreen'] }))).toBe(
      'keep'
    )
    expect(decideFreeze(live({ rectCss: null }), ctx({ overlays: ['fullscreen'] }))).toBe('keep')
  })

  it('a drag freezes every LIVE view but not a parked corner', () => {
    expect(decideFreeze(live(), ctx({ dragActive: true }))).toBe('freeze')
    expect(
      decideFreeze(live({ parked: true, visibleReported: false }), ctx({ dragActive: true }))
    ).toBe('keep')
    expect(decideFreeze(live({ frozen: true }), ctx({ dragActive: false }))).toBe('thaw')
  })

  it('a fullscreen layer freezes a live view and a parked one', () => {
    expect(decideFreeze(live(), ctx({ overlays: ['fullscreen'] }))).toBe('freeze')
    expect(decideFreeze(live({ parked: true }), ctx({ overlays: ['fullscreen'] }))).toBe('freeze')
  })
})

describe('FreezeGeneration (the async freeze race)', () => {
  it('a newer freeze makes the older one stale', () => {
    const g = new FreezeGeneration()
    const first = g.next()
    expect(g.isCurrent(first)).toBe(true)
    const second = g.next()
    expect(g.isCurrent(first)).toBe(false)
    expect(g.isCurrent(second)).toBe(true)
  })

  it('a bump (thaw, hide, destroy) invalidates the freeze in flight', () => {
    const g = new FreezeGeneration()
    const inFlight = g.next()
    g.bump()
    expect(g.isCurrent(inFlight)).toBe(false)
  })

  it('models the overlay closing while the capture is awaited', async () => {
    const g = new FreezeGeneration()
    let hidden = false
    const freeze = async (): Promise<void> => {
      const gen = g.next()
      await Promise.resolve() // capturePage
      if (!g.isCurrent(gen)) return
      hidden = true // setVisible(false) must NOT run for a stale freeze
    }
    const p = freeze()
    g.bump() // the overlay closed (thaw) before the capture returned
    await p
    expect(hidden).toBe(false)
  })
})

describe('createGestureGate (one popup per activation)', () => {
  it('allows one popup per real activation inside the window, then none until the next gesture', () => {
    let t = 10_000
    const gate = createGestureGate(() => t)
    expect(gate.consume()).toBe(false) // no gesture yet
    gate.note()
    t += 200
    expect(gate.pending()).toBe(true)
    expect(gate.consume()).toBe(true)
    expect(gate.consume()).toBe(false) // a loop of window.open inside the same activation
    gate.note()
    expect(gate.consume()).toBe(true)
  })

  it('an activation expires after the window', () => {
    let t = 1_000_000
    const gate = createGestureGate(() => t)
    gate.note()
    t += GESTURE_WINDOW_MS + 1
    expect(gate.pending()).toBe(false)
    expect(gate.consume()).toBe(false)
  })

  it('treats the boundary as still fresh', () => {
    let t = 5_000
    const gate = createGestureGate(() => t)
    gate.note()
    t += GESTURE_WINDOW_MS
    expect(gate.consume()).toBe(true)
  })
})

describe('certificateVerdictFor', () => {
  it.each([
    ['https://localhost:3000/', 'accept-flagged', 'localhost:3000'],
    ['https://127.0.0.1:8443/x', 'accept-flagged', '127.0.0.1:8443'],
    ['https://[::1]:8443/', 'accept-flagged', '[::1]:8443'],
    ['https://[::ffff:7f00:1]:8443/', 'accept-flagged', '[::ffff:7f00:1]:8443'],
    ['https://app.localhost/', 'accept-flagged', 'app.localhost']
  ])('accepts and flags loopback %s', (url, verdict, host) => {
    expect(certificateVerdictFor(url)).toEqual({ verdict, host })
  })

  it.each([
    'https://example.com/',
    'https://localhost.evil.com:3000/',
    'https://10.0.0.5:8443/',
    'https://[2001:db8::1]/',
    'not a url'
  ])('denies %s', (url) => {
    expect(certificateVerdictFor(url).verdict).toBe('deny')
  })
})

describe('the "opened by agent" flag', () => {
  const seen = new Set(['localhost:5173'])

  it('sets on a verb navigation to a new external host and keeps an existing flag otherwise', () => {
    expect(
      flagAfterVerbNavigation(null, {
        origin: 'external',
        host: 'docs.example.com',
        seenBefore: seen
      })
    ).toEqual({
      host: 'docs.example.com'
    })
    const existing = { host: 'docs.example.com' }
    expect(
      flagAfterVerbNavigation(existing, {
        origin: 'external',
        host: 'docs.example.com',
        seenBefore: new Set(['docs.example.com'])
      })
    ).toBe(existing)
    expect(
      flagAfterVerbNavigation(existing, {
        origin: 'local',
        host: 'localhost:5173',
        seenBefore: seen
      })
    ).toBe(existing)
  })

  it('never flags a local dev server, a blank page, or an empty host', () => {
    expect(
      flagAfterVerbNavigation(null, { origin: 'local', host: 'localhost:9', seenBefore: new Set() })
    ).toBeNull()
    expect(
      flagAfterVerbNavigation(null, { origin: 'blank', host: '', seenBefore: new Set() })
    ).toBeNull()
    expect(
      flagAfterVerbNavigation(null, { origin: 'external', host: '', seenBefore: new Set() })
    ).toBeNull()
  })

  it('does not flag a host the pane had already shown', () => {
    expect(
      flagAfterVerbNavigation(null, {
        origin: 'external',
        host: 'a.example.com',
        seenBefore: new Set(['a.example.com'])
      })
    ).toBeNull()
  })

  it('is cleared by the operator navigating or dismissing', () => {
    expect(flagAfterOperatorAction()).toBeNull()
  })
})

describe('resolveGateInput (the shell half of the plan gate)', () => {
  const rec: BrowserPaneRecord = {
    paneId: 'bp-1',
    folder: '/work/app',
    name: 'x',
    openedBy: 'agent',
    partition: 'agent',
    ownerSessionId: null,
    createdAt: 1,
    lastActiveAt: 1,
    seenHosts: new Set(),
    flagged: null
  }
  const base = {
    liveUrl: 'http://localhost:5173/',
    writesEnabled: true,
    disconnected: false,
    paused: false,
    harnuPorts: [41999],
    trustedHosts: [] as string[]
  }

  it('an unknown pane resolves with no pane and no folder, keeping the kill-switch', () => {
    expect(resolveGateInput({ ...base, rec: undefined, writesEnabled: false })).toEqual({
      folder: undefined,
      input: {
        pane: undefined,
        writesEnabled: false,
        classify: { harnuPorts: [41999], extraTrustedHosts: [] }
      }
    })
  })

  it('a known pane carries its folder, access state and the origin class of its LIVE url', () => {
    const r = resolveGateInput({ ...base, rec, paused: true })
    expect(r.folder).toBe('/work/app')
    expect(r.input.pane).toEqual({
      openedBy: 'agent',
      originClass: 'local',
      disconnected: false,
      paused: true,
      // The U4 gate inputs default to "no opt-in, no lease, no cooldown".
      readOptIn: false,
      leaseActive: false,
      writeDenied: false,
      inputReady: true,
      // T572: no emulation record, so no device.
      deviceActive: false
    })
    expect(
      resolveGateInput({ ...base, rec, liveUrl: 'https://example.com/' }).input.pane?.originClass
    ).toBe('external')
    expect(resolveGateInput({ ...base, rec, liveUrl: '' }).input.pane?.originClass).toBe('blank')
  })

  it("classifies Harnu's own port as external and honours trusted hosts", () => {
    expect(
      resolveGateInput({ ...base, rec, liveUrl: 'http://localhost:41999/' }).input.pane?.originClass
    ).toBe('external')
    expect(
      resolveGateInput({ ...base, rec, liveUrl: 'http://shop.test/', trustedHosts: ['*.test'] })
        .input.pane?.originClass
    ).toBe('local')
  })

  it('reports Disconnect and an operator-opened pane, and passes the args through', () => {
    const r = resolveGateInput({
      ...base,
      rec: { ...rec, openedBy: 'operator' },
      disconnected: true,
      args: { url: 'http://x.test' }
    })
    expect(r.input.pane).toMatchObject({ openedBy: 'operator', disconnected: true })
    expect(r.input.args).toEqual({ url: 'http://x.test' })
  })
})

import { captureMatchesBounds, freezeImagePlan } from '../src/main/browser/view-logic'

describe('freezeImagePlan (never stretch a tiny capture over the host)', () => {
  const reported = { x: 400, y: 100, width: 600, height: 500 }
  const atRect = { x: 400, y: 100, width: 600, height: 500 }

  it('captures a live view that is at its reported rect', () => {
    expect(freezeImagePlan({ parked: false, bounds: atRect, reported, zoomFactor: 1 })).toBe(
      'capture'
    )
    expect(
      freezeImagePlan({
        parked: false,
        bounds: { x: 500, y: 125, width: 750, height: 625 },
        reported,
        zoomFactor: 1.25
      })
    ).toBe('capture')
  })

  it('only hides a PARKED view, whatever rect the renderer reported', () => {
    expect(
      freezeImagePlan({
        parked: true,
        bounds: { x: 1279, y: 799, width: 1, height: 1 },
        reported,
        zoomFactor: 1
      })
    ).toBe('hide-only')
  })

  it('only hides a view the renderer never reported a rect for', () => {
    expect(freezeImagePlan({ parked: false, bounds: atRect, reported: null, zoomFactor: 1 })).toBe(
      'hide-only'
    )
  })

  it('only hides a view whose bounds are not yet the reported rect (a late or lost report)', () => {
    expect(
      freezeImagePlan({
        parked: false,
        bounds: { x: 1279, y: 799, width: 1, height: 1 },
        reported,
        zoomFactor: 1
      })
    ).toBe('hide-only')
    expect(
      freezeImagePlan({ parked: false, bounds: { ...atRect, width: 300 }, reported, zoomFactor: 1 })
    ).toBe('hide-only')
    // A few px of rounding slack is fine.
    expect(
      freezeImagePlan({ parked: false, bounds: { ...atRect, width: 603 }, reported, zoomFactor: 1 })
    ).toBe('capture')
  })
})

describe('captureMatchesBounds', () => {
  const bounds = { x: 0, y: 0, width: 600, height: 500 }

  it('accepts an image of the view, at 1× or at device pixels', () => {
    expect(captureMatchesBounds({ width: 600, height: 500 }, bounds)).toBe(true)
    expect(captureMatchesBounds({ width: 1200, height: 1000 }, bounds)).toBe(true)
  })

  it('rejects a tiny, stale, or wrong-shaped image', () => {
    expect(captureMatchesBounds({ width: 1, height: 1 }, bounds)).toBe(false)
    expect(captureMatchesBounds({ width: 1280, height: 800 }, bounds)).toBe(false)
    expect(captureMatchesBounds({ width: 300, height: 250 }, bounds)).toBe(false)
    expect(captureMatchesBounds({ width: 0, height: 0 }, bounds)).toBe(false)
    expect(captureMatchesBounds({ width: 600, height: 500 }, { ...bounds, width: 0 })).toBe(false)
  })
})
