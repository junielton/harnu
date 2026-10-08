import { describe, it, expect } from 'vitest'
import { parseOptions } from '../src/main/gc/gc-options'

const good = {
  bucket: 'review',
  reasonCode: 'dirty',
  headSha: 'a'.repeat(40),
  stackIds: ['s1'],
  ownedVolumes: ['v1'],
  bytes: 12
}

describe('parseOptions: the gc:clean payload is untrusted', () => {
  it('keeps well-formed confirmed ids and expected facts', () => {
    expect(parseOptions({ confirmed: ['a', 'b'], expected: { a: good } })).toEqual({
      confirmed: ['a', 'b'],
      expected: { a: good }
    })
  })

  it('keeps the project of an orphan volume', () => {
    const volume = { ...good, bucket: 'orphan-volume', headSha: null, project: 'shop' }
    expect(parseOptions({ expected: { 'volume:x': volume } }).expected!['volume:x']).toEqual(volume)
  })

  it('ignores a blanket confirmDecide: it confirms nothing', () => {
    const out = parseOptions({ confirmDecide: true })
    expect(out).toEqual({ confirmed: [], expected: {} })
  })

  it.each([undefined, null, 'yes', 7, []])('treats %j as no options', (raw) => {
    expect(parseOptions(raw)).toEqual({ confirmed: [], expected: {} })
  })

  it('drops non-string confirmed ids and caps the list', () => {
    const many = Array.from({ length: 600 }, (_, i) => `id${i}`)
    expect(parseOptions({ confirmed: ['a', 3, null, 'b'] }).confirmed).toEqual(['a', 'b'])
    expect(parseOptions({ confirmed: many }).confirmed).toHaveLength(500)
  })

  it.each([
    ['an unknown bucket', { ...good, bucket: 'everything' }],
    ['a string for stackIds', { ...good, stackIds: 's1' }],
    ['a non-string stack id', { ...good, stackIds: [1] }],
    ['a missing reasonCode', { ...good, reasonCode: undefined }],
    ['a numeric headSha', { ...good, headSha: 5 }],
    ['a string for bytes', { ...good, bytes: '12' }],
    ['a numeric project', { ...good, project: 4 }],
    ['not an object', 'review']
  ])('drops an expected entry with %s, so that id is refused', (_name, entry) => {
    expect(parseOptions({ expected: { a: entry, b: good } }).expected).toEqual({ b: good })
  })

  it('ignores an expected that is not a record', () => {
    expect(parseOptions({ expected: [good] }).expected).toEqual({})
    expect(parseOptions({ expected: 'x' }).expected).toEqual({})
  })
})
