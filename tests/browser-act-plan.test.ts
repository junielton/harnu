/**
 * T571 (browser pane U4, AC-4) — what makes an element actionable, where a click lands, how the fit scale is
 * applied (A5), and the CDP mouse events of a click (spec §6.1 rows 11–14, §6.2).
 */
import { describe, it, expect } from 'vitest'
import {
  tapEvents,
  ACTIONABLE_TIMEOUT_MS,
  actionableRefusal,
  clickEvents,
  clickTarget,
  judgeActionable,
  modifierMask,
  toViewPoint,
  waitActionable,
  type ElementProbe
} from '../src/main/browser/act-plan'

const probe = (over: Partial<ElementProbe> = {}): ElementProbe => ({
  rect: { x: 10, y: 20, width: 100, height: 40 },
  disabled: false,
  hit: 'self',
  editable: false,
  isSelect: false,
  tag: 'button',
  ...over
})
const vp = { width: 1280, height: 800 }

describe('judgeActionable', () => {
  it('is ready only when visible, enabled, unmoved since the last sample and un-obscured', () => {
    expect(judgeActionable(probe(), probe(), { needsHit: true, viewport: vp })).toBe('ready')
  })
  it('needs two samples with the same box: the first one is unstable', () => {
    expect(judgeActionable(probe(), null, { needsHit: true, viewport: vp })).toBe('unstable')
    expect(
      judgeActionable(probe(), probe({ rect: { x: 12, y: 20, width: 100, height: 40 } }), {
        needsHit: true,
        viewport: vp
      })
    ).toBe('unstable')
  })
  it('refuses a box with no size, none, or wholly outside the viewport', () => {
    for (const rect of [
      null,
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 5000, y: 0, width: 10, height: 10 }
    ]) {
      expect(
        judgeActionable(probe({ rect }), probe({ rect }), { needsHit: true, viewport: vp })
      ).toBe('not-visible')
    }
  })
  it('refuses disabled before obscured, and obscured only when the click needs a hit', () => {
    expect(
      judgeActionable(probe({ disabled: true, hit: 'other' }), probe(), {
        needsHit: true,
        viewport: vp
      })
    ).toBe('disabled')
    expect(
      judgeActionable(probe({ hit: 'other' }), probe(), { needsHit: true, viewport: vp })
    ).toBe('obscured')
    expect(
      judgeActionable(probe({ hit: 'other' }), probe(), { needsHit: false, viewport: vp })
    ).toBe('ready')
  })
})

describe('waitActionable', () => {
  function io(samples: ElementProbe[], needsHit = true) {
    let t = 0
    let i = 0
    return {
      sample: async () => samples[Math.min(i++, samples.length - 1)]!,
      now: () => t,
      sleep: async (ms: number) => void (t += ms),
      needsHit,
      viewport: async () => vp
    }
  }
  it('returns once two consecutive samples agree', async () => {
    const r = await waitActionable(io([probe(), probe()]))
    expect(r).toMatchObject({ ok: true })
  })
  it('waits out an overlay that goes away', async () => {
    const r = await waitActionable(
      io([probe({ hit: 'other' }), probe({ hit: 'other' }), probe(), probe()])
    )
    expect(r.ok).toBe(true)
  })
  it('gives up after 5 s with the concrete reason, not "unstable"', async () => {
    // First sample moved (unstable), every later one is still but covered: the refusal says obscured.
    const samples = [
      probe({ rect: { x: 1, y: 1, width: 10, height: 10 } }),
      probe({ hit: 'other' })
    ]
    const r = await waitActionable(io(samples))
    expect(r).toMatchObject({ ok: false, reason: 'obscured' })
    expect(ACTIONABLE_TIMEOUT_MS).toBe(5000)
  })
  it('a target that only ever moves is unstable, which maps to ELEMENT_NOT_VISIBLE', async () => {
    const samples = Array.from({ length: 200 }, (_, n) =>
      probe({ rect: { x: n, y: 0, width: 10, height: 10 } })
    )
    const r = await waitActionable(io(samples))
    expect(r).toMatchObject({ ok: false, reason: 'unstable' })
    expect(actionableRefusal('unstable')).toBe('ELEMENT_NOT_VISIBLE')
  })
  it('lets a vanished node (a throwing sample) escape for the caller to call REF_STALE', async () => {
    await expect(
      waitActionable({ ...io([probe()]), sample: async () => Promise.reject(new Error('no node')) })
    ).rejects.toThrow('no node')
  })
  it('maps every reason to its refusal', () => {
    expect(actionableRefusal('obscured')).toBe('ELEMENT_OBSCURED')
    expect(actionableRefusal('disabled')).toBe('ELEMENT_DISABLED')
    expect(actionableRefusal('not-visible')).toBe('ELEMENT_NOT_VISIBLE')
  })
})

describe('click geometry', () => {
  const rect = { x: 10, y: 20, width: 100, height: 40 }
  it('aims at the centre, or at an offset INSIDE the box', () => {
    expect(clickTarget(rect)).toEqual({ ok: true, point: { x: 60, y: 40 } })
    expect(clickTarget(rect, { x: 5, y: 5 })).toEqual({ ok: true, point: { x: 15, y: 25 } })
    expect(clickTarget(rect, { x: 100, y: 40 })).toEqual({ ok: true, point: { x: 110, y: 60 } })
  })
  it.each([
    { x: -1, y: 0 },
    { x: 0, y: 41 },
    { x: 101, y: 0 },
    { x: Number.NaN, y: 0 }
  ])('refuses the offset %j', (offset) => {
    expect(clickTarget(rect, offset)).toEqual({ ok: false, error: 'offset-outside-box' })
  })
  it('multiplies by the fit scale: a tap at 150,150 under scale 0.5 must be sent as 75,75 (A5)', () => {
    expect(toViewPoint({ x: 150, y: 150 }, 0.5)).toEqual({ x: 75, y: 75 })
    expect(toViewPoint({ x: 150, y: 150 }, 1)).toEqual({ x: 150, y: 150 })
    expect(toViewPoint({ x: 150, y: 150 }, 0)).toEqual({ x: 150, y: 150 })
  })
})

describe('mouse events', () => {
  it('moves, then presses and releases once for a click', () => {
    const e = clickEvents({ x: 1, y: 2 }, {})
    expect(e.map((x) => `${x.type}:${x.clickCount}`)).toEqual([
      'mouseMoved:0',
      'mousePressed:1',
      'mouseReleased:1'
    ])
    expect(e[1]).toMatchObject({ button: 'left', buttons: 1 })
  })
  it('numbers a double click 1 then 2, and supports the right button and modifiers', () => {
    const e = clickEvents(
      { x: 1, y: 2 },
      { clickCount: 2, button: 'right', modifiers: ['Shift', 'Control'] }
    )
    expect(e.filter((x) => x.type === 'mousePressed').map((x) => x.clickCount)).toEqual([1, 2])
    expect(e[1]).toMatchObject({ button: 'right', buttons: 2, modifiers: 10 })
    expect(modifierMask(['Alt', 'Meta'])).toBe(5)
    expect(modifierMask(undefined)).toBe(0)
  })
})

describe('tapEvents (T572: a click while touch is emulated)', () => {
  it('is touchStart then touchEnd at the point', () => {
    expect(tapEvents({ x: 30, y: 20 }, {})).toEqual([
      { type: 'touchStart', touchPoints: [{ x: 30, y: 20 }], modifiers: 0 },
      { type: 'touchEnd', touchPoints: [], modifiers: 0 }
    ])
  })

  it('repeats once per click, clamped to three, and carries the modifiers', () => {
    expect(tapEvents({ x: 1, y: 2 }, { clickCount: 2 }).map((e) => e.type)).toEqual([
      'touchStart',
      'touchEnd',
      'touchStart',
      'touchEnd'
    ])
    expect(tapEvents({ x: 1, y: 2 }, { clickCount: 9 })).toHaveLength(6)
    expect(tapEvents({ x: 1, y: 2 }, { modifiers: ['Shift'] })[0]!.modifiers).toBe(8)
  })
})
