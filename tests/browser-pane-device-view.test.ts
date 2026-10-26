/**
 * T572 (browser pane U5, AC-1, AC-3, AC-4, AC-5) — the pane chrome's view model for zoom, the device picker, the
 * device frame and the download notices. Pure: `BrowserPane.vue` renders these answers.
 */
import { describe, it, expect } from 'vitest'
import {
  BACKDROP_PAD_PX,
  CAPTION_BLOCK_PX,
  FRAME_BEZEL_PX,
  FRAME_RING_PX,
  deviceChipText,
  deviceIconName,
  deviceLayout,
  frameCaption,
  freeSizePatch,
  noticeTone,
  presetRows,
  zoomView
} from '../src/renderer/src/lib/browser-pane'
import { deviceFromPreset, mergeEmulation } from '../src/shared/browser-emulation'
import type { BrowserEmulationState, BrowserDeviceState } from '../src/main/browser/state-types'
import type { EmulationRecord } from '../src/shared/browser-emulation'

const phone = deviceFromPreset('phone-m')

describe('the wire type mirrors the shared record', () => {
  it('is assignable both ways (a test pins the two declarations together)', () => {
    const a: BrowserEmulationState = {
      device: phone,
      colorScheme: 'dark',
      reducedMotion: true,
      touch: false
    }
    const b: EmulationRecord = a
    const c: BrowserEmulationState = b
    expect(c).toEqual(a)
    const d: BrowserDeviceState = phone
    expect(d.preset).toBe('phone-m')
  })
})

describe('zoomView', () => {
  it('shows the percentage and what the buttons can do', () => {
    expect(zoomView({ zoom: 1.1, emulation: {} })).toEqual({
      percent: 110,
      disabled: false,
      canZoomIn: true,
      canZoomOut: true,
      canReset: true
    })
    expect(zoomView({ zoom: 1, emulation: {} }).canReset).toBe(false)
    expect(zoomView({ zoom: 5, emulation: {} }).canZoomIn).toBe(false)
    expect(zoomView({ zoom: 0.25, emulation: {} }).canZoomOut).toBe(false)
  })

  it('in device mode the group is disabled and reads 100% (Q15, AC-4)', () => {
    expect(zoomView({ zoom: 1.5, emulation: { device: phone } })).toEqual({
      percent: 100,
      disabled: true,
      canZoomIn: false,
      canZoomOut: false,
      canReset: false
    })
  })
})

describe('deviceLayout (AC-3)', () => {
  const chromeW = 2 * (BACKDROP_PAD_PX + FRAME_BEZEL_PX + FRAME_RING_PX)
  const chromeH = chromeW + CAPTION_BLOCK_PX

  it('a device that fits is shown at 1:1', () => {
    const l = deviceLayout(phone, { width: 600 + chromeW, height: 1000 + chromeH })
    expect(l).toEqual({ fit: 1, screenWidth: 390, screenHeight: 844 })
  })

  it('a tall device in a short pane shrinks by the height, keeping its shape', () => {
    const l = deviceLayout(phone, { width: 800, height: 422 + chromeH })
    expect(l.fit).toBeCloseTo(0.5, 2)
    expect(l.screenHeight).toBe(422)
    expect(l.screenWidth).toBe(Math.round(390 * l.fit))
    // The page never sees the fit: the screen is the device times the fit, nothing else.
    expect(l.screenHeight / l.screenWidth).toBeCloseTo(844 / 390, 1)
  })

  it('whole pixels, never below the minimum fit, and never zero', () => {
    const tiny = deviceLayout({ width: 1920, height: 1080 }, { width: 10, height: 10 })
    expect(tiny.fit).toBe(0.25)
    expect(Number.isInteger(tiny.screenWidth)).toBe(true)
    expect(tiny.screenWidth).toBe(480)
  })
})

describe('the device chip and presets (AC-5)', () => {
  it('writes the chip the way the mockup does', () => {
    expect(deviceChipText(phone)).toBe('phone-m · 390×844 @3')
    expect(deviceChipText({ ...phone, rotated: true, width: 844, height: 390 })).toBe(
      'phone-m ↻ · 844×390 @3'
    )
    expect(deviceChipText(mergeEmulation({}, { width: 1000, height: 700 }).device!)).toBe(
      'custom · 1000×700 @1'
    )
  })

  it('lists the seven presets and marks the active one (not a rotated one)', () => {
    const rows = presetRows(phone)
    expect(rows.map((r) => r.name)).toHaveLength(7)
    expect(rows.find((r) => r.active)?.name).toBe('phone-m')
    expect(presetRows({ ...phone, rotated: true }).some((r) => r.active)).toBe(false)
    expect(presetRows(undefined).some((r) => r.active)).toBe(false)
    expect(rows[0]).toEqual({ name: 'phone-s', size: '360×800 @3', active: false })
  })

  it('picks an icon by the kind of device', () => {
    expect(deviceIconName(phone)).toBe('smartphone')
    expect(deviceIconName(deviceFromPreset('tablet'))).toBe('tablet')
    expect(deviceIconName(deviceFromPreset('laptop'))).toBe('laptop')
    expect(deviceIconName(deviceFromPreset('desktop'))).toBe('monitor')
  })

  it('the caption is the shared one', () => {
    expect(frameCaption({ emulation: { device: phone, colorScheme: 'light' } }, 0.66)).toBe(
      'fit 66% · touch on · mobile UA · prefers-color-scheme: light'
    )
  })
})

describe('freeSizePatch', () => {
  it('turns the editor’s text into a patch', () => {
    expect(freeSizePatch({ width: '800', height: '600', dpr: '2' }, true)).toEqual({
      width: 800,
      height: 600,
      dpr: 2,
      mobile: true
    })
    expect(freeSizePatch({ width: '800', height: '600', dpr: '' }, false)).toMatchObject({ dpr: 1 })
    expect(freeSizePatch({ width: '800', height: '600', dpr: '1,5' }, false)).toMatchObject({
      dpr: 1.5
    })
  })

  it('refuses anything out of range or not a number', () => {
    for (const bad of [
      { width: '99', height: '600', dpr: '1' },
      { width: '800', height: '10001', dpr: '1' },
      { width: 'abc', height: '600', dpr: '1' },
      { width: '800', height: '600', dpr: '0.1' },
      { width: '800', height: '600', dpr: '9' }
    ]) {
      expect(freeSizePatch(bad, false), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('noticeTone', () => {
  it('a saved or cancelled download is a report, everything else a warning', () => {
    expect(noticeTone({ kind: 'downloaded', name: 'a' })).toBe('info')
    expect(noticeTone({ kind: 'download-cancelled' })).toBe('info')
    expect(noticeTone({ kind: 'download-failed' })).toBe('warning')
    expect(noticeTone({ kind: 'crashed' })).toBe('warning')
  })
})
