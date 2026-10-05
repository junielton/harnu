import { describe, it, expect } from 'vitest'
import { dedupeAfterSeq, type SeqChunk } from '../src/renderer/src/lib/adoptDedupe'

describe('dedupeAfterSeq', () => {
  it('returns nothing when all chunks are at or before the replay seq', () => {
    const chunks: SeqChunk[] = [
      { data: 'a', seq: 5 },
      { data: 'b', seq: 10 }
    ]
    expect(dedupeAfterSeq(chunks, 10)).toEqual([])
  })

  it('returns only chunks strictly after the replay seq, in order', () => {
    const chunks: SeqChunk[] = [
      { data: 'old', seq: 10 },
      { data: 'new1', seq: 14 },
      { data: 'new2', seq: 18 }
    ]
    expect(dedupeAfterSeq(chunks, 10).map((c) => c.data)).toEqual(['new1', 'new2'])
  })

  it('returns everything when replay seq is 0', () => {
    const chunks: SeqChunk[] = [
      { data: 'x', seq: 4 },
      { data: 'y', seq: 8 }
    ]
    expect(dedupeAfterSeq(chunks, 0).map((c) => c.data)).toEqual(['x', 'y'])
  })

  it('handles an empty queue', () => {
    expect(dedupeAfterSeq([], 42)).toEqual([])
  })
})
