/**
 * T570 (browser pane U3, AC-2) — which path a screenshot takes (spec §6.2, §2.3, §2.4; U0 A3): capturePage for
 * a visible, parked or hidden pane; CDP only for the shots only CDP can render, and only on a view that is
 * shown; a hidden pane never goes through CDP.
 */
import { describe, it, expect } from 'vitest'
import {
  clampSize,
  fullPageHeight,
  elementCropScale,
  planScreenshot,
  rectFromQuad
} from '../src/main/browser/screenshot-plan'

const base = { fullPage: false, element: false, deviceMode: false }

describe('planScreenshot', () => {
  it('uses capturePage for a plain viewport shot on a visible, parked or hidden pane', () => {
    for (const mode of ['visible', 'parked', 'hidden'] as const) {
      expect(planScreenshot({ ...base, mode }), mode).toMatchObject({
        method: 'capturePage',
        cropToBounds: false,
        cropToElement: false
      })
    }
  })

  it('uses CDP for fullPage and element shots on a shown view', () => {
    for (const mode of ['visible', 'parked'] as const) {
      expect(planScreenshot({ ...base, mode, fullPage: true })).toEqual({
        method: 'cdp',
        clip: 'page',
        cropToBounds: false
      })
      expect(planScreenshot({ ...base, mode, element: true })).toEqual({
        method: 'cdp',
        clip: 'element',
        cropToBounds: false
      })
    }
  })

  it('never uses CDP on a hidden pane: an element is cropped from the capture, fullPage is downgraded', () => {
    expect(planScreenshot({ ...base, mode: 'hidden', element: true })).toMatchObject({
      method: 'capturePage',
      cropToElement: true,
      fullPageDowngraded: false
    })
    expect(planScreenshot({ ...base, mode: 'hidden', fullPage: true })).toMatchObject({
      method: 'capturePage',
      fullPageDowngraded: true
    })
  })

  it('in device mode renders the whole device through CDP when shown, and crops capturePage to the bounds when hidden', () => {
    expect(planScreenshot({ ...base, mode: 'visible', deviceMode: true })).toEqual({
      method: 'cdp',
      clip: 'none',
      cropToBounds: false
    })
    expect(planScreenshot({ ...base, mode: 'parked', deviceMode: true })).toMatchObject({
      method: 'cdp'
    })
    expect(planScreenshot({ ...base, mode: 'hidden', deviceMode: true })).toMatchObject({
      method: 'capturePage',
      cropToBounds: true
    })
  })
})

describe('clampSize', () => {
  it('leaves a small image alone and shrinks a large one keeping the aspect ratio', () => {
    expect(clampSize(800, 600, 1568)).toEqual({ width: 800, height: 600, clamped: false })
    expect(clampSize(3136, 1568, 1568)).toEqual({ width: 1568, height: 784, clamped: true })
    expect(clampSize(1000, 4000, 1568)).toEqual({ width: 392, height: 1568, clamped: true })
  })
})

describe('fullPageHeight', () => {
  it('caps a very tall page at 8000 px', () => {
    expect(fullPageHeight(1234.2)).toEqual({ height: 1235, clamped: false })
    expect(fullPageHeight(50_000)).toEqual({ height: 8000, clamped: true })
  })
})

describe('rectFromQuad', () => {
  it('turns a CDP box quad into a rectangle and rejects a malformed one', () => {
    expect(rectFromQuad([10, 20, 110, 20, 110, 70, 10, 70])).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50
    })
    expect(rectFromQuad([1, 2, 3])).toBeNull()
    expect(rectFromQuad([NaN, 0, 0, 0, 0, 0, 0, 0])).toBeNull()
  })
})

describe('elementCropScale (AC-6: an element shot on a hidden pane in device mode)', () => {
  const base = { imageWidth: 195, boundsWidth: 195, zoom: 1, parked: false, parkedWidth: 1280 }

  it('in device mode the page is laid out at the device width, not at the (fit-scaled) bounds', () => {
    // phone-m (390 wide) drawn in 195 px of window: the capture is 195 px wide and shows 390 CSS px.
    expect(elementCropScale({ ...base, deviceWidth: 390 })).toBeCloseTo(0.5)
    // The old rule divided the bounds by the zoom and got 1: the crop would have been twice too large.
    expect(elementCropScale({ ...base, deviceWidth: null })).toBeCloseTo(1)
  })

  it('the fit scale cancels: a bigger capture of the same device gives a proportionally bigger scale', () => {
    expect(elementCropScale({ ...base, imageWidth: 390, deviceWidth: 390 })).toBeCloseTo(1)
    expect(elementCropScale({ ...base, imageWidth: 585, deviceWidth: 390 })).toBeCloseTo(1.5)
  })

  it('without a device a parked view uses the parking width, a shown one its bounds over the zoom', () => {
    expect(
      elementCropScale({
        ...base,
        imageWidth: 1280,
        boundsWidth: 1,
        parked: true,
        deviceWidth: null
      })
    ).toBeCloseTo(1)
    expect(
      elementCropScale({ ...base, imageWidth: 800, boundsWidth: 800, zoom: 2, deviceWidth: null })
    ).toBeCloseTo(2)
  })

  it('a device wins over a parked view (a parked pane in device mode renders at the device size)', () => {
    expect(
      elementCropScale({ ...base, imageWidth: 390, parked: true, deviceWidth: 390 })
    ).toBeCloseTo(1)
  })
})
