import { describe, expect, it } from 'vitest'
import {
  wipPauseNotice,
  wipPauseSignature,
  type WipPauseMemory
} from '../src/renderer/src/lib/wip-pause'

/**
 * BUG-197 (AC-3) — a paused drain says so ONCE: one notice per pause, no repeat
 * for the same pause, and a new notice once the pause ended and returns.
 */

const pause = (holders: string[], limit = 5) => ({
  limit,
  live: holders.length,
  holders: holders.map((slug) => ({ slug, id: slug.toUpperCase() }))
})

describe('wipPauseSignature', () => {
  it('is the ceiling plus the holders, order-independent', () => {
    expect(wipPauseSignature(pause(['b', 'a']))).toBe(wipPauseSignature(pause(['a', 'b'])))
    expect(wipPauseSignature(pause(['a'], 4))).not.toBe(wipPauseSignature(pause(['a'], 5)))
    expect(wipPauseSignature(pause(['a']))).not.toBe(wipPauseSignature(pause(['a', 'b'])))
  })
})

describe('wipPauseNotice', () => {
  it('notifies the first time a folder pauses', () => {
    const r = wipPauseNotice({}, '/repo', pause(['a', 'b']))
    expect(r.notify).toBe(true)
  })

  it('does NOT notify again for the same pause', () => {
    const first = wipPauseNotice({}, '/repo', pause(['a', 'b']))
    const again = wipPauseNotice(first.memory, '/repo', pause(['a', 'b']))
    expect(again.notify).toBe(false)
    expect(again.memory).toEqual(first.memory)
  })

  it('notifies again when the holders change (new information)', () => {
    const first = wipPauseNotice({}, '/repo', pause(['a', 'b']))
    expect(wipPauseNotice(first.memory, '/repo', pause(['a', 'c'])).notify).toBe(true)
  })

  it('forgets the pause when it ends, so the next pause notifies again', () => {
    const first = wipPauseNotice({}, '/repo', pause(['a', 'b']))
    const ended = wipPauseNotice(first.memory, '/repo', undefined)
    expect(ended.notify).toBe(false)
    expect(ended.memory).toEqual({})
    expect(wipPauseNotice(ended.memory, '/repo', pause(['a', 'b'])).notify).toBe(true)
  })

  it('tracks folders independently and never mutates its input', () => {
    const mem: WipPauseMemory = {}
    const a = wipPauseNotice(mem, '/a', pause(['x']))
    expect(mem).toEqual({})
    expect(wipPauseNotice(a.memory, '/b', pause(['x'])).notify).toBe(true)
    expect(wipPauseNotice(a.memory, '/a', pause(['x'])).notify).toBe(false)
  })
})
