import { describe, it, expect } from 'vitest'
import { imageCacheRoot, resolveImagePath, sortImagesNewestFirst } from '../src/main/image-cache'

// Pasted-images gallery — pure core (no electron/fs). The risk surface is the
// path-traversal defense (lesson security/001): every assertion observes an
// independent signal — an exact path literal, the real sort order — never a
// value derived from the function under test (lesson testing/001).

const UUID = '11111111-2222-4333-8444-555555555555'

describe('imageCacheRoot', () => {
  it('joins homeDir with ~/.claude/image-cache', () => {
    expect(imageCacheRoot('/home/x')).toBe('/home/x/.claude/image-cache')
  })
})

describe('resolveImagePath — path-traversal defense (security/001)', () => {
  it('resolves a valid <uuid>/<n>.png to the exact confined path', () => {
    // Independent signal: a hand-written absolute path literal, NOT a value
    // built by calling imageCacheRoot() (which is itself under test).
    expect(resolveImagePath('/home/u', UUID, '3.png')).toBe(
      `/home/u/.claude/image-cache/${UUID}/3.png`
    )
  })

  it('accepts multi-digit stems', () => {
    expect(resolveImagePath('/home/u', UUID, '12.png')).toBe(
      `/home/u/.claude/image-cache/${UUID}/12.png`
    )
  })

  it('rejects path-traversal in name', () => {
    expect(resolveImagePath('/home/u', UUID, '../../etc/passwd')).toBeNull()
    expect(resolveImagePath('/home/u', UUID, '../7.png')).toBeNull()
    expect(resolveImagePath('/home/u', UUID, '/abs/evil.png')).toBeNull()
  })

  it('rejects non-<digits>.png names', () => {
    expect(resolveImagePath('/home/u', UUID, '3.jpg')).toBeNull()
    expect(resolveImagePath('/home/u', UUID, '3.txt')).toBeNull()
    expect(resolveImagePath('/home/u', UUID, 'foo.png')).toBeNull()
    expect(resolveImagePath('/home/u', UUID, '.png')).toBeNull()
    expect(resolveImagePath('/home/u', UUID, '')).toBeNull()
  })

  it('rejects an invalid uuid', () => {
    expect(resolveImagePath('/home/u', 'not-a-uuid', '3.png')).toBeNull()
    expect(resolveImagePath('/home/u', '../x', '3.png')).toBeNull()
    expect(resolveImagePath('/home/u', `${UUID}/..`, '3.png')).toBeNull()
  })
})

describe('sortImagesNewestFirst', () => {
  it('orders by numeric stem descending (not lexicographically)', () => {
    // The lexicographic trap: '10' < '2' as strings. Assert the real order.
    expect(sortImagesNewestFirst(['1.png', '10.png', '2.png'])).toEqual([
      '10.png',
      '2.png',
      '1.png'
    ])
  })

  it('pushes non-numeric names to the end, stably', () => {
    expect(sortImagesNewestFirst(['2.png', 'cover.png', '1.png', 'x.png'])).toEqual([
      '2.png',
      '1.png',
      'cover.png',
      'x.png'
    ])
  })

  it('returns [] for an empty list', () => {
    expect(sortImagesNewestFirst([])).toEqual([])
  })
})
