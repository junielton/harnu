/**
 * T574 (browser pane U7, AC-6) — restart restore, pure (spec §10.3): what `helpers.json` kept becomes a DISCARDED
 * record at the same address, with its emulation, zoom, scroll, owner, network switch and pins; what must not
 * survive a restart does not; and a file anyone can edit never loads an address a pane may not load.
 */
import { describe, expect, it } from 'vitest'
import {
  planRestore,
  restorePane,
  sanitizeEmulation,
  sanitizePin,
  sanitizePins
} from '../src/main/browser/restore-plan'
import { MAX_PINS_PER_PANE } from '../src/shared/browser-comment'

const WT = '/work/acme-store'
const pin = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ab12cd34',
  n: 1,
  state: 'draft',
  origin: 'http://localhost:3000',
  url: 'http://localhost:3000/cart',
  selector: 'button.pay',
  tag: 'button',
  html: '<button class="pay">Pay</button>',
  component: 'src/Cart.vue:42',
  styles: { color: 'rgb(0, 0, 0)' },
  rect: { x: 10, y: 20, width: 100, height: 40 },
  cropPath: '.harnu/out/browser/comments/b1/1.png',
  comment: 'make this bigger',
  batchId: 'b1',
  createdAt: 1234,
  ...over
})
const pane = (payload: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id: 'bp-1a2b3c4d',
  type: 'browser',
  worktreePath: WT,
  payload,
  ...over
})

describe('a restored pane', () => {
  it('comes back DISCARDED at the same address with everything the record kept', () => {
    const r = restorePane(
      pane({
        name: 'cart',
        url: 'http://localhost:3000/cart?x=1',
        openedBy: 'agent',
        partition: 'agent',
        ownerSessionId: 'sess-1',
        zoom: 1.25,
        scroll: { x: 0, y: 900 },
        emulation: {
          device: {
            preset: 'phone-m',
            width: 390,
            height: 844,
            dpr: 3,
            mobile: true,
            rotated: false
          },
          colorScheme: 'dark'
        },
        pins: [pin()]
      }),
      5_000
    )!
    expect(r.rec).toMatchObject({
      paneId: 'bp-1a2b3c4d',
      folder: WT,
      name: 'cart',
      openedBy: 'agent',
      partition: 'agent',
      ownerSessionId: 'sess-1',
      allowNetwork: false,
      pagePath: null,
      emulation: {
        device: { preset: 'phone-m', width: 390, height: 844, dpr: 3, mobile: true },
        colorScheme: 'dark'
      },
      discarded: {
        reason: 'restored',
        url: 'http://localhost:3000/cart?x=1',
        scroll: { x: 0, y: 900 },
        zoom: 1.25
      }
    })
    expect(r.pins).toHaveLength(1)
    expect(r.pins[0]).toMatchObject({ state: 'draft', comment: 'make this bigger', n: 1 })
  })

  it('does not bring back what must not survive: flagged, seen hosts, the lease and the pause live in memory only', () => {
    const r = restorePane(pane({ url: 'https://docs.example.com', openedBy: 'agent' }), 1)!
    expect(r.rec.flagged).toBeNull()
    expect(r.rec.seenHosts.size).toBe(0)
    expect(Object.keys(r.rec)).not.toContain('pausedUntil')
    expect(Object.keys(r.rec)).not.toContain('lease')
  })

  it('a page pane re-reads its sidecar: the page file and the network switch come back, nothing else is copied', () => {
    const r = restorePane(
      pane({
        url: 'harnu-page://f0123456789ab/docs/board.html',
        pagePath: 'docs/board.html',
        allowNetwork: true
      }),
      1
    )!
    expect(r.rec).toMatchObject({ pagePath: 'docs/board.html', allowNetwork: true })
    expect(r.rec.discarded?.url).toBe('harnu-page://f0123456789ab/docs/board.html')
  })

  it('the network switch means nothing on a pane that is not a page pane', () => {
    const r = restorePane(pane({ url: 'http://localhost:3000', allowNetwork: true }), 1)!
    expect(r.rec.allowNetwork).toBe(false)
  })

  it('keeps the owner as written: delivery falls back to the folder’s selected session when it is gone', () => {
    const r = restorePane(pane({ url: 'http://localhost:3000', ownerSessionId: 'gone-9' }), 1)!
    expect(r.rec.ownerSessionId).toBe('gone-9')
    expect(restorePane(pane({ url: 'http://localhost:3000' }), 1)!.rec.ownerSessionId).toBeNull()
  })

  it('an operator pane with no payload at all still opens: blank, operator-owned', () => {
    const r = restorePane({ id: 'bp-9', type: 'browser', worktreePath: WT }, 1)!
    expect(r.rec).toMatchObject({ openedBy: 'operator', partition: 'operator', name: '' })
    expect(r.rec.discarded?.url).toBe('about:blank')
  })
})

describe('what a hand-edited file cannot do', () => {
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'chrome://settings',
    'view-source:https://example.com',
    'not a url',
    'about:srcdoc'
  ])('never restores the address %s: the pane opens blank', (url) => {
    expect(restorePane(pane({ url }), 1)!.rec.discarded?.url).toBe('about:blank')
  })

  it('a harnu-page address needs a page file behind it', () => {
    const r = restorePane(pane({ url: 'harnu-page://f0123456789ab/x.html' }), 1)!
    expect(r.rec.discarded?.url).toBe('about:blank')
  })

  it('drops a pane of another type, with a bad id, or with no stack', () => {
    expect(restorePane(pane({}, { type: 'shell' }), 1)).toBeNull()
    expect(restorePane(pane({}, { id: '../../x' }), 1)).toBeNull()
    expect(restorePane(pane({}, { id: 42 }), 1)).toBeNull()
    expect(restorePane(pane({}, { worktreePath: '' }), 1)).toBeNull()
  })

  it('clamps an absurd zoom and a bad scroll', () => {
    const r = restorePane(
      pane({ url: 'http://localhost:1', zoom: 99, scroll: { x: -4, y: 'a' } }),
      1
    )!
    expect(r.rec.discarded).toMatchObject({ zoom: 5, scroll: null })
    expect(restorePane(pane({ zoom: 0.0001 }), 1)!.rec.discarded?.zoom).toBe(0.25)
  })

  it('plans several panes and keeps the first of a repeated id', () => {
    const out = planRestore(
      [
        pane({ url: 'http://localhost:1' }),
        pane({ url: 'http://localhost:2' }),
        pane({ url: 'http://localhost:3' }, { id: 'bp-other' }),
        { id: 'h-1', type: 'shell', worktreePath: WT }
      ],
      1
    )
    expect(out.map((r) => r.rec.paneId)).toEqual(['bp-1a2b3c4d', 'bp-other'])
    expect(out[0]!.rec.discarded?.url).toBe('http://localhost:1/')
  })
})

describe('emulation from a file', () => {
  it('keeps a valid device and the media settings', () => {
    expect(
      sanitizeEmulation({
        device: { preset: null, width: 500, height: 600, dpr: 2, mobile: false, rotated: true },
        touch: true,
        userAgent: 'x',
        colorScheme: 'light',
        reducedMotion: true
      })
    ).toEqual({
      device: { preset: null, width: 500, height: 600, dpr: 2, mobile: false, rotated: true },
      touch: true,
      userAgent: 'x',
      colorScheme: 'light',
      reducedMotion: true
    })
  })

  it('drops a device out of range or malformed, keeps the rest, and ignores a non-object', () => {
    expect(
      sanitizeEmulation({
        device: { width: 10, height: 600, dpr: 2 },
        colorScheme: 'dark',
        userAgent: ''
      })
    ).toEqual({ colorScheme: 'dark' })
    expect(sanitizeEmulation({ device: { width: 500, height: 600, dpr: 99 } })).toEqual({})
    expect(sanitizeEmulation('x')).toEqual({})
    expect(sanitizeEmulation({ colorScheme: 'sepia' })).toEqual({})
  })
})

describe('pins from a file (draft and sent come back)', () => {
  it('keeps draft and sent pins with their text, selector, rect and crop', () => {
    const pins = sanitizePins([
      pin(),
      pin({ id: 'ee00ff11', n: 2, state: 'sent', comment: 'done' })
    ])
    expect(pins.map((p) => [p.n, p.state, p.comment])).toEqual([
      [1, 'draft', 'make this bigger'],
      [2, 'sent', 'done']
    ])
    expect(pins[0]).toMatchObject({
      selector: 'button.pay',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      cropPath: '.harnu/out/browser/comments/b1/1.png',
      component: 'src/Cart.vue:42'
    })
  })

  it('drops a pin with no id, selector, number, state or rect, and a repeated id', () => {
    expect(sanitizePin(pin({ id: '' }))).toBeNull()
    expect(sanitizePin(pin({ selector: undefined }))).toBeNull()
    expect(sanitizePin(pin({ n: 0 }))).toBeNull()
    expect(sanitizePin(pin({ n: 1.5 }))).toBeNull()
    expect(sanitizePin(pin({ state: 'open' }))).toBeNull()
    expect(sanitizePin(pin({ rect: { x: 1, y: 2, width: Infinity, height: 3 } }))).toBeNull()
    expect(sanitizePin('x')).toBeNull()
    expect(sanitizePins([pin(), pin()])).toHaveLength(1)
    expect(sanitizePins('nope')).toEqual([])
  })

  it('loses a crop that points outside the comments folder, never the pin', () => {
    for (const cropPath of [
      '/etc/passwd',
      '../../secret.png',
      '.harnu/out/browser/comments/../../x',
      'x.png'
    ]) {
      expect(sanitizePin(pin({ cropPath }))!.cropPath, cropPath).toBeNull()
    }
  })

  it('bounds the number of pins and every text field', () => {
    const many = Array.from({ length: MAX_PINS_PER_PANE + 20 }, (_, i) =>
      pin({ id: `p${i}`, n: i + 1 })
    )
    expect(sanitizePins(many)).toHaveLength(MAX_PINS_PER_PANE)
    const big = sanitizePin(pin({ comment: 'x'.repeat(5000), html: 'y'.repeat(5000) }))!
    expect(big.comment).toBe('')
    expect(big.html).toBe('')
  })

  it('a pin with bad optional fields is repaired, not lost', () => {
    const p = sanitizePin(pin({ tag: 7, styles: 'no', component: 5, url: null }))!
    expect(p).toMatchObject({ tag: '', styles: {}, component: null, url: '' })
  })
})
