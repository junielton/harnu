import { describe, it, expect } from 'vitest'
import { badgeStrategy, normalizeBadgeCount, overlayAssetName } from '../src/main/badge'

describe('badgeStrategy', () => {
  it('count on macOS/Linux, overlay on Windows, none elsewhere', () => {
    expect(badgeStrategy('darwin')).toBe('count')
    expect(badgeStrategy('linux')).toBe('count')
    expect(badgeStrategy('win32')).toBe('overlay')
    expect(badgeStrategy('aix')).toBe('none')
  })
})

describe('normalizeBadgeCount', () => {
  it('floors finite non-negative numbers', () => {
    expect(normalizeBadgeCount(3)).toBe(3)
    expect(normalizeBadgeCount(3.9)).toBe(3)
    expect(normalizeBadgeCount(0)).toBe(0)
  })
  it('guards negatives and non-numbers to 0 (never throws)', () => {
    expect(normalizeBadgeCount(-2)).toBe(0)
    for (const x of [NaN, Infinity, undefined, null, 'x', {}]) {
      expect(normalizeBadgeCount(x)).toBe(0)
    }
  })
})

describe('overlayAssetName', () => {
  it('maps 1..9 to badge-N.png, >=10 to the 9plus cap, 0 to null', () => {
    expect(overlayAssetName(0)).toBeNull()
    expect(overlayAssetName(1)).toBe('badge-1.png')
    expect(overlayAssetName(9)).toBe('badge-9.png')
    expect(overlayAssetName(10)).toBe('badge-9plus.png')
    expect(overlayAssetName(99)).toBe('badge-9plus.png')
  })
})
