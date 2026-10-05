import { describe, it, expect, beforeEach } from 'vitest'
import { RingBuffer } from '../src/main/pty-ring-buffer'

describe('RingBuffer', () => {
  let ring: RingBuffer
  beforeEach(() => {
    ring = new RingBuffer(10) // 10-byte cap for easy reasoning
  })

  it('is empty initially', () => {
    expect(ring.snapshot()).toBe('')
    expect(ring.byteLength).toBe(0)
  })

  it('keeps everything while under the cap', () => {
    ring.push('abc')
    ring.push('de')
    expect(ring.snapshot()).toBe('abcde')
    expect(ring.byteLength).toBe(5)
  })

  it('evicts whole oldest chunks once the cap is exceeded', () => {
    ring.push('aaaa') // 4
    ring.push('bbbb') // 8
    ring.push('cccc') // 12 > 10 -> evict 'aaaa' (now 8)
    expect(ring.snapshot()).toBe('bbbbcccc')
    expect(ring.byteLength).toBe(8)
  })

  it('preserves order across many pushes', () => {
    for (const c of ['11', '22', '33', '44', '55', '66']) ring.push(c) // 12 bytes total
    // cap 10 -> oldest '11' evicted (would be 12), keep last 5 chunks = 10 bytes
    expect(ring.snapshot()).toBe('2233445566')
    expect(ring.byteLength).toBe(10)
  })

  it('counts multibyte characters by UTF-8 byte length', () => {
    ring = new RingBuffer(8)
    ring.push('é') // 2 bytes
    ring.push('ABCDEF') // 6 bytes -> total 8, fits
    expect(ring.byteLength).toBe(8)
    expect(ring.snapshot()).toBe('éABCDEF')
    ring.push('Z') // 9 -> evict 'é' (2) -> 'ABCDEFZ' = 7
    expect(ring.snapshot()).toBe('ABCDEFZ')
  })

  it('drops a single chunk larger than the cap down to nothing but the newest', () => {
    ring = new RingBuffer(4)
    ring.push('ab')
    ring.push('cdefgh') // 6 > 4: evict 'ab', single remaining chunk still 6 > 4 but cannot evict the only chunk
    expect(ring.snapshot()).toBe('cdefgh')
    expect(ring.byteLength).toBe(6)
  })
})
