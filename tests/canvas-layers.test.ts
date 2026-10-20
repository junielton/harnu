import { describe, it, expect } from 'vitest'
import {
  CANVAS_LOAD_Z,
  LAYER_MOVES,
  documentStackOrder,
  liveStackOrder,
  renderStackZ,
  reorderStack,
  savedZIndexes,
  stackRanks,
  type LayerMove,
  type StackBox,
  type StackNode
} from '../src/renderer/src/components/canvas/canvas-layers'

const ids = (...list: string[]): { id: string; zIndex?: number }[] => list.map((id) => ({ id }))
const withZ = (id: string, zIndex: number): { id: string; zIndex?: number } => ({ id, zIndex })
const obj = (m: Map<string, number>): Record<string, number> => Object.fromEntries(m)

// Every box overlaps every other one unless a case says otherwise.
const BIG: StackBox = { x: 0, y: 0, width: 100, height: 100 }
const FAR: StackBox = { x: 1000, y: 1000, width: 100, height: 100 }
const stackOf = (spec: [string, StackBox?][]): StackNode[] =>
  spec.map(([id, bbox], i) => ({ id, z: i + 1, bbox: bbox ?? BIG }))
const abcd = stackOf([['a'], ['b'], ['c'], ['d']])
const move = (stack: StackNode[], sel: string[], m: LayerMove): string[] | null =>
  reorderStack(stack, new Set(sel), m)

describe('constants', () => {
  it('lists the four moves in panel order', () => {
    expect(LAYER_MOVES).toEqual(['back', 'backward', 'forward', 'front'])
  })

  it('loads an unstacked node at z 1', () => {
    expect(CANVAS_LOAD_Z).toBe(1)
  })
})

describe('documentStackOrder', () => {
  it('keeps file order when no node is stacked', () => {
    expect(documentStackOrder(ids('a', 'b', 'c'))).toEqual(['a', 'b', 'c'])
  })

  it('puts a node with a high zIndex above the unstacked ones', () => {
    expect(documentStackOrder([withZ('a', 5), { id: 'b' }, { id: 'c' }])).toEqual(['b', 'c', 'a'])
  })

  it('breaks a tie with the load z by file order', () => {
    expect(documentStackOrder([withZ('a', 1), { id: 'b' }])).toEqual(['a', 'b'])
  })

  it('puts a zero zIndex below the load z', () => {
    expect(documentStackOrder([withZ('a', 0), { id: 'b' }])).toEqual(['a', 'b'])
  })

  it('orders fractional zIndexes numerically', () => {
    expect(documentStackOrder([withZ('a', 2.5), withZ('b', 2)])).toEqual(['b', 'a'])
  })
})

describe('renderStackZ', () => {
  it('ranks around a lone stacked node', () => {
    expect(obj(renderStackZ([{ id: 'a' }, withZ('b', 5), { id: 'c' }]))).toEqual({
      a: 1,
      c: 2,
      b: 3
    })
  })

  it('keeps the file values verbatim when all are present and distinct', () => {
    expect(obj(renderStackZ([withZ('a', 7), withZ('b', 2)]))).toEqual({ a: 7, b: 2 })
  })

  it('re-ranks a zero zIndex so the node stays above the edges', () => {
    expect(obj(renderStackZ([withZ('a', 0), withZ('b', 2)]))).toEqual({ a: 1, b: 2 })
  })

  it('re-ranks a negative zIndex so the node stays above the edges', () => {
    expect(obj(renderStackZ([withZ('a', -3), withZ('b', 2)]))).toEqual({ a: 1, b: 2 })
  })

  it('re-ranks a tie', () => {
    expect(obj(renderStackZ([withZ('a', 2), withZ('b', 2)]))).toEqual({ a: 1, b: 2 })
  })

  it('is empty for no nodes', () => {
    expect(renderStackZ([]).size).toBe(0)
  })

  it('gives every node a distinct z for any input', () => {
    const inputs = [
      ids('a', 'b', 'c'),
      [withZ('a', 3), withZ('b', 3), withZ('c', 3)],
      [withZ('a', 0), { id: 'b' }, withZ('c', 1)],
      [withZ('a', 9), withZ('b', 4), { id: 'c' }]
    ]
    for (const nodes of inputs) {
      const values = [...renderStackZ(nodes).values()]
      expect(new Set(values).size).toBe(nodes.length)
    }
  })
})

describe('liveStackOrder', () => {
  it('keeps model order for equal z', () => {
    expect(
      liveStackOrder([
        { id: 'a', z: 1 },
        { id: 'b', z: 1 },
        { id: 'c', z: 3 }
      ])
    ).toEqual(['a', 'b', 'c'])
  })

  it('sorts by z', () => {
    expect(
      liveStackOrder([
        { id: 'a', z: 4 },
        { id: 'b', z: 1 }
      ])
    ).toEqual(['b', 'a'])
  })
})

describe('reorderStack', () => {
  it('brings a node to the front', () => {
    expect(move(abcd, ['b'], 'front')).toEqual(['a', 'c', 'd', 'b'])
  })

  it('sends a node to the back', () => {
    expect(move(abcd, ['c'], 'back')).toEqual(['c', 'a', 'b', 'd'])
  })

  it('keeps the relative order of several nodes sent to the front', () => {
    expect(move(abcd, ['a', 'c'], 'front')).toEqual(['b', 'd', 'a', 'c'])
  })

  it('keeps the relative order of several nodes sent to the back', () => {
    expect(move(abcd, ['b', 'd'], 'back')).toEqual(['b', 'd', 'a', 'c'])
  })

  it('moves a node one step forward', () => {
    expect(move(abcd, ['b'], 'forward')).toEqual(['a', 'c', 'b', 'd'])
  })

  it('moves a node one step backward', () => {
    expect(move(abcd, ['c'], 'backward')).toEqual(['a', 'c', 'b', 'd'])
  })

  it('moves two adjacent nodes forward past the node above them', () => {
    expect(move(abcd, ['b', 'c'], 'forward')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('returns null for a move that changes nothing', () => {
    expect(move(abcd, ['d'], 'forward')).toBeNull()
    expect(move(abcd, ['d'], 'front')).toBeNull()
    expect(move(abcd, ['a'], 'back')).toBeNull()
    expect(move(abcd, ['a'], 'backward')).toBeNull()
  })

  it('returns null when the selection already is the whole top', () => {
    expect(move(abcd, ['c', 'd'], 'front')).toBeNull()
  })

  it('returns null for every move when the selection holds only unknown ids', () => {
    for (const m of LAYER_MOVES) expect(move(abcd, ['e-1'], m)).toBeNull()
  })

  it('ignores an unknown id next to a real one', () => {
    expect(move(abcd, ['b', 'e-1'], 'front')).toEqual(['a', 'c', 'd', 'b'])
  })

  it('does not mutate the stack it is given', () => {
    const before = abcd.map((n) => n.id)
    move(abcd, ['b'], 'front')
    expect(abcd.map((n) => n.id)).toEqual(before)
  })
})

describe('reorderStack overlap rule', () => {
  it('passes the nearest overlapping node above', () => {
    const stack = stackOf([['a'], ['b'], ['c', FAR]])
    expect(move(stack, ['a'], 'forward')).toEqual(['b', 'a', 'c'])
  })

  it('skips a non-overlapping node and passes the next overlapping one', () => {
    const stack = stackOf([['a'], ['c', FAR], ['b']])
    expect(move(stack, ['a'], 'forward')).toEqual(['c', 'b', 'a'])
  })

  it('stays when nothing above overlaps', () => {
    const stack = stackOf([['a'], ['c', FAR]])
    expect(move(stack, ['a'], 'forward')).toBeNull()
  })

  it('mirrors the rule for backward', () => {
    const stack = stackOf([['b'], ['c', FAR], ['a']])
    expect(move(stack, ['a'], 'backward')).toEqual(['a', 'b', 'c'])
    expect(move(stackOf([['c', FAR], ['a']]), ['a'], 'backward')).toBeNull()
  })

  it('does not count boxes that share only an edge as overlapping', () => {
    const left: StackBox = { x: 0, y: 0, width: 100, height: 100 }
    const right: StackBox = { x: 100, y: 0, width: 100, height: 100 }
    const below: StackBox = { x: 0, y: 100, width: 100, height: 100 }
    expect(
      move(
        stackOf([
          ['a', left],
          ['b', right]
        ]),
        ['a'],
        'forward'
      )
    ).toBeNull()
    expect(
      move(
        stackOf([
          ['a', left],
          ['b', below]
        ]),
        ['a'],
        'forward'
      )
    ).toBeNull()
  })

  it('counts boxes that overlap by a sliver', () => {
    const left: StackBox = { x: 0, y: 0, width: 100, height: 100 }
    const right: StackBox = { x: 99, y: 99, width: 100, height: 100 }
    expect(
      move(
        stackOf([
          ['a', left],
          ['b', right]
        ]),
        ['a'],
        'forward'
      )
    ).toEqual(['b', 'a'])
  })

  it('never lets a selected node pass another selected node', () => {
    const stack = stackOf([['a'], ['b'], ['c']])
    expect(move(stack, ['a', 'b'], 'forward')).toEqual(['c', 'a', 'b'])
  })
})

describe('stackRanks', () => {
  it('numbers bottom to top from 1', () => {
    expect(obj(stackRanks(['b', 'a']))).toEqual({ b: 1, a: 2 })
  })

  it('never hands out a rank below 1', () => {
    for (const order of [[], ['a'], ['a', 'b', 'c']]) {
      for (const rank of stackRanks(order).values()) expect(rank).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('savedZIndexes', () => {
  it('keeps the file as it is when nothing was restacked', () => {
    expect(savedZIndexes(ids('a', 'b', 'c'), ['a', 'b', 'c'])).toBeNull()
  })

  it('keeps a lone stacked node when the live order is the document order', () => {
    expect(savedZIndexes([withZ('a', 5), { id: 'b' }, { id: 'c' }], ['b', 'c', 'a'])).toBeNull()
  })

  it('writes ranks for every node once the order differs', () => {
    const saved = savedZIndexes([withZ('a', 5), { id: 'b' }, { id: 'c' }], ['b', 'a', 'c'])
    expect(saved && obj(saved)).toEqual({ b: 1, a: 2, c: 3 })
  })

  it('keeps the file when a new node sits on top where it would render', () => {
    expect(savedZIndexes(ids('a', 'b', 'c', 'n'), ['a', 'b', 'c', 'n'])).toBeNull()
  })

  it('writes ranks when a new node is on top live but would render in the middle', () => {
    const draft = [withZ('a', 3), withZ('b', 1), withZ('c', 2), { id: 'n' }]
    const saved = savedZIndexes(draft, ['b', 'c', 'a', 'n'])
    expect(saved && obj(saved)).toEqual({ b: 1, c: 2, a: 3, n: 4 })
  })

  it('puts a draft node missing from live on top', () => {
    const saved = savedZIndexes(ids('a', 'b', 'c'), ['b', 'c'])
    expect(saved && obj(saved)).toEqual({ b: 1, c: 2, a: 3 })
  })

  it('ranks only the nodes the draft holds', () => {
    const saved = savedZIndexes(ids('a', 'b'), ['b', 'gone', 'a'])
    expect(saved && obj(saved)).toEqual({ b: 1, a: 2 })
  })
})
