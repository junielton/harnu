import { describe, expect, it } from 'vitest'
import {
  COMPUTED_STYLE_ALLOWLIST,
  MAX_STYLES,
  originOf,
  scrubUrl
} from '../src/shared/browser-comment'
import {
  cropRect,
  cropRelPath,
  scaledCropSize,
  toRect,
  validatePicked
} from '../src/main/browser/comment-payload'

const good = {
  selector: '#pay',
  tag: 'button',
  outerHTML: '<button id="pay">Pay</button>',
  component: 'src/Pay.vue:42',
  styles: { color: 'red', 'border-radius': '12px' },
  rect: { x: 10, y: 20, width: 100, height: 40 },
  viewport: { width: 1280, height: 800 }
}

describe('validatePicked', () => {
  it('accepts a well-formed pick', () => {
    expect(validatePicked(good)).toEqual(good)
  })
  it('refuses malformed input', () => {
    expect(validatePicked(null)).toBeNull()
    expect(validatePicked('x')).toBeNull()
    expect(validatePicked({ ...good, selector: '' })).toBeNull()
    expect(validatePicked({ ...good, rect: { x: 1, y: 1, width: NaN, height: 1 } })).toBeNull()
    expect(validatePicked({ ...good, rect: { x: 1, y: 1, width: -3, height: 1 } })).toBeNull()
    expect(validatePicked({ ...good, viewport: undefined })).toBeNull()
    expect(validatePicked({ ...good, viewport: { width: 0, height: 0 } })).toBeNull()
  })
  it('applies the caps: selector 512, html ~2 KB, component 200', () => {
    const v = validatePicked({
      ...good,
      selector: 's'.repeat(2000),
      outerHTML: 'h'.repeat(9000),
      component: 'c'.repeat(900)
    })!
    expect(v.selector.length).toBeLessThanOrEqual(513)
    expect(v.outerHTML.length).toBeLessThanOrEqual(2049)
    expect(v.component!.length).toBeLessThanOrEqual(201)
  })
  it('keeps only allowlisted style properties, at most 40', () => {
    expect(COMPUTED_STYLE_ALLOWLIST.length).toBeLessThanOrEqual(MAX_STYLES)
    const v = validatePicked({
      ...good,
      styles: { color: 'red', '--secret': 'x', 'background-image': 'url(x)', display: 'block' }
    })!
    expect(Object.keys(v.styles).sort()).toEqual(['color', 'display'])
    const many: Record<string, string> = {}
    for (let i = 0; i < 200; i++) many[`prop-${i}`] = 'v'
    for (const k of COMPUTED_STYLE_ALLOWLIST) many[k] = 'v'
    expect(
      Object.keys(validatePicked({ ...good, styles: many })!.styles).length
    ).toBeLessThanOrEqual(MAX_STYLES)
  })
  it('turns a missing or empty component into null and drops non-string style values', () => {
    expect(validatePicked({ ...good, component: undefined })!.component).toBeNull()
    expect(validatePicked({ ...good, styles: { color: 3 as unknown as string } })!.styles).toEqual(
      {}
    )
  })
})

describe('toRect', () => {
  it('rejects absurd rects', () => {
    expect(toRect({ x: 0, y: 0, width: 2e6, height: 1 })).toBeNull()
    expect(toRect({ x: 5e7, y: 0, width: 1, height: 1 })).toBeNull()
    expect(toRect([])).toBeNull()
  })
})

describe('crop geometry', () => {
  it('pads by 8 px and clamps to the viewport', () => {
    expect(
      cropRect({ x: 100, y: 100, width: 50, height: 20 }, { width: 1280, height: 800 })
    ).toEqual({
      x: 92,
      y: 92,
      width: 66,
      height: 36
    })
    expect(cropRect({ x: 2, y: 3, width: 50, height: 20 }, { width: 1280, height: 800 })).toEqual({
      x: 0,
      y: 0,
      width: 60,
      height: 31
    })
    expect(
      cropRect({ x: 1250, y: 780, width: 100, height: 100 }, { width: 1280, height: 800 })
    ).toEqual({
      x: 1242,
      y: 772,
      width: 38,
      height: 28
    })
  })
  it('is null for a node wholly outside the viewport', () => {
    expect(
      cropRect({ x: 3000, y: 0, width: 10, height: 10 }, { width: 1280, height: 800 })
    ).toBeNull()
    expect(
      cropRect({ x: 0, y: -500, width: 10, height: 10 }, { width: 1280, height: 800 })
    ).toBeNull()
  })
  it('scales so the longest side is at most 800 and never upscales', () => {
    expect(scaledCropSize(1600, 400)).toEqual({ width: 800, height: 200 })
    expect(scaledCropSize(300, 2400)).toEqual({ width: 100, height: 800 })
    expect(scaledCropSize(300, 200)).toEqual({ width: 300, height: 200 })
    expect(scaledCropSize(10000, 1)).toEqual({ width: 800, height: 1 })
  })
  it('names the crop under .harnu/out/browser/comments/<batch>/<n>.png', () => {
    expect(cropRelPath('b3f9', 2)).toBe('.harnu/out/browser/comments/b3f9/2.png')
  })
})

describe('scrubUrl / originOf', () => {
  it('drops query, fragment and userinfo', () => {
    expect(scrubUrl('https://u:p@ex.com:8443/a/b?token=1#frag')).toBe('https://ex.com:8443/a/b')
    expect(scrubUrl('http://localhost:3000/checkout?x=1')).toBe('http://localhost:3000/checkout')
    expect(scrubUrl('about:blank')).toBe('about:blank')
    expect(scrubUrl('harnu-page://fabc/.harnu/out/p.html?x=1')).toBe(
      'harnu-page://fabc/.harnu/out/p.html'
    )
  })
  it('caps at 512', () => {
    expect(scrubUrl(`https://ex.com/${'a'.repeat(900)}`).length).toBeLessThanOrEqual(513)
  })
  it('does not throw on garbage', () => {
    expect(scrubUrl('not a url?x=1')).toBe('not a url')
  })
  it('gives the same origin across paths and a distinct one across hosts and schemes', () => {
    expect(originOf('https://a.com/x?y')).toBe(originOf('https://a.com/z'))
    expect(originOf('https://a.com/x')).not.toBe(originOf('http://a.com/x'))
    expect(originOf('https://a.com/x')).not.toBe(originOf('https://b.com/x'))
    expect(originOf('harnu-page://fabc/p.html')).toBe(originOf('harnu-page://fabc/q.html'))
    expect(originOf('garbage')).toBe('')
  })
})
