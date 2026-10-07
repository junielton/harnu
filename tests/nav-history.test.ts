import { describe, expect, it } from 'vitest'
import { createNavHistory } from '../src/renderer/src/lib/nav-history'

/** Every id is live — the default for walks that don't exercise skipping. */
const allLive = (): boolean => true

/** Build a history from a sequence of visits. */
function visited(...ids: string[]): ReturnType<typeof createNavHistory> {
  const h = createNavHistory()
  for (const id of ids) h.push(id)
  return h
}

describe('nav-history — empty', () => {
  it('returns null everywhere', () => {
    const h = createNavHistory()
    expect(h.current()).toBeNull()
    expect(h.back(allLive)).toBeNull()
    expect(h.forward(allLive)).toBeNull()
    expect(h.current()).toBeNull()
  })

  it('rename on an empty history is a no-op', () => {
    const h = createNavHistory()
    h.rename('a', 'b')
    expect(h.current()).toBeNull()
  })
})

describe('nav-history — push / back / forward', () => {
  it('push moves the cursor to the new entry', () => {
    const h = visited('A', 'B', 'C')
    expect(h.current()).toBe('C')
  })

  it('back walks the visits in reverse and forward replays them', () => {
    const h = visited('A', 'B', 'C')
    expect(h.back(allLive)).toBe('B')
    expect(h.back(allLive)).toBe('A')
    expect(h.current()).toBe('A')
    expect(h.forward(allLive)).toBe('B')
    expect(h.current()).toBe('B')
    expect(h.forward(allLive)).toBe('C')
  })

  it('push after back truncates forward history (spec §4 worked example)', () => {
    const h = visited('A', 'B', 'C')
    expect(h.back(allLive)).toBe('B')
    expect(h.back(allLive)).toBe('A')
    expect(h.forward(allLive)).toBe('B')
    h.push('D')
    expect(h.current()).toBe('D')
    expect(h.forward(allLive)).toBeNull()
    expect(h.back(allLive)).toBe('B')
    expect(h.back(allLive)).toBe('A')
    expect(h.back(allLive)).toBeNull()
  })

  it('pushing the id already under the cursor records nothing', () => {
    const h = visited('A', 'B', 'B', 'B')
    expect(h.back(allLive)).toBe('A')
    expect(h.back(allLive)).toBeNull()
  })

  it('pushing the id under the cursor after a back keeps forward history', () => {
    const h = visited('A', 'B', 'C')
    h.back(allLive)
    h.push('B')
    expect(h.forward(allLive)).toBe('C')
  })

  it('ends return null and leave the cursor in place', () => {
    const h = visited('A', 'B')
    expect(h.forward(allLive)).toBeNull()
    expect(h.current()).toBe('B')
    expect(h.back(allLive)).toBe('A')
    expect(h.back(allLive)).toBeNull()
    expect(h.current()).toBe('A')
  })
})

describe('nav-history — skipping', () => {
  it('back skips dead entries and continues to the next live one', () => {
    const h = visited('A', 'B', 'C')
    const live = (id: string): boolean => id !== 'B'
    expect(h.back(live)).toBe('A')
    expect(h.current()).toBe('A')
  })

  it('forward skips dead entries and continues to the next live one', () => {
    const h = visited('A', 'B', 'C')
    h.back(allLive)
    h.back(allLive)
    const live = (id: string): boolean => id !== 'B'
    expect(h.forward(live)).toBe('C')
  })

  it('returns null and keeps the cursor when every entry in that direction is dead', () => {
    const h = visited('A', 'B', 'C')
    expect(h.back(() => false)).toBeNull()
    expect(h.current()).toBe('C')
  })

  it('skips entries equal to the current id', () => {
    // A, B, A — then B is closed: back from A must not land on the older A.
    const h = visited('A', 'B', 'A')
    const live = (id: string): boolean => id !== 'B'
    expect(h.back(live)).toBeNull()
    expect(h.current()).toBe('A')
  })

  it('skips an equal entry but still reaches an older distinct one', () => {
    const h = visited('X', 'A', 'B', 'A')
    const live = (id: string): boolean => id !== 'B'
    expect(h.back(live)).toBe('X')
  })
})

describe('nav-history — cap', () => {
  it('holds at most 50 entries by default, dropping the oldest', () => {
    const h = createNavHistory()
    for (let i = 0; i < 60; i++) h.push(`s${i}`)
    expect(h.current()).toBe('s59')
    let steps = 0
    let last: string | null = null
    for (let id = h.back(allLive); id !== null; id = h.back(allLive)) {
      last = id
      steps++
    }
    expect(steps).toBe(49)
    expect(last).toBe('s10')
  })

  it('keeps the cursor right when the oldest entry is dropped', () => {
    const h = createNavHistory(3)
    h.push('A')
    h.push('B')
    h.push('C')
    h.push('D')
    expect(h.current()).toBe('D')
    expect(h.back(allLive)).toBe('C')
    expect(h.back(allLive)).toBe('B')
    expect(h.back(allLive)).toBeNull()
    expect(h.forward(allLive)).toBe('C')
    expect(h.forward(allLive)).toBe('D')
    expect(h.forward(allLive)).toBeNull()
  })

  it('caps after a truncating push too', () => {
    const h = createNavHistory(3)
    h.push('A')
    h.push('B')
    h.push('C')
    h.back(allLive)
    h.push('D') // A, B, D
    h.push('E') // B, D, E
    expect(h.current()).toBe('E')
    expect(h.back(allLive)).toBe('D')
    expect(h.back(allLive)).toBe('B')
    expect(h.back(allLive)).toBeNull()
  })
})

describe('nav-history — rename (synthetic → real migration)', () => {
  it('rewrites every occurrence of the old id', () => {
    const h = visited('synthetic-1', 'B', 'synthetic-1', 'C')
    h.rename('synthetic-1', 'real-1')
    expect(h.back(allLive)).toBe('real-1')
    expect(h.back(allLive)).toBe('B')
    expect(h.back(allLive)).toBe('real-1')
    expect(h.back(allLive)).toBeNull()
  })

  it('renames the entry under the cursor so a later push of the real id is a no-op', () => {
    const h = visited('A', 'synthetic-1')
    h.rename('synthetic-1', 'real-1')
    expect(h.current()).toBe('real-1')
    h.push('real-1')
    expect(h.back(allLive)).toBe('A')
    expect(h.back(allLive)).toBeNull()
  })

  it('a migrated session stays reachable by its real id only', () => {
    const h = visited('synthetic-1', 'B')
    h.rename('synthetic-1', 'real-1')
    const live = (id: string): boolean => id !== 'synthetic-1'
    expect(h.back(live)).toBe('real-1')
  })
})
