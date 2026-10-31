/**
 * Campaign ch.4c (T607, AC-4c.1) — the map's pure board layout (`lib/campaign-map.ts`).
 *
 * Expectations are hand-computed from the mockup's grid (`screens/v6--map.html`: 4 columns of
 * 164px tiles, 36px gutters, a 192px row pitch when a dock sits under the first row) and written
 * out as numbers, never copied from what the code returned (testing/003).
 */
import { describe, expect, it } from 'vitest'
import type { Chapter } from '../src/main/campaign-core'
import type { ChapterState } from '../src/main/campaign-progress'
import { layoutCampaignMap } from '../src/renderer/src/lib/campaign-map'

const ch = (n: number, over: Partial<Chapter> = {}): Chapter => ({
  id: `chp-${n}`,
  ordinal: n,
  title: `Chapter ${n}`,
  required: true,
  ...over
})

/**
 * Five required chapters + one side chapter docked under chapter 4.
 *  - chapter 3 produces `pages`, chapter 5 consumes it  → an explicit edge 3 → 5
 *  - chapter 4 unlocks on chapter 1                       → an explicit edge 1 → 4
 *  - everything else is the plan's order                  → sequence edges 1→2, 2→3
 */
const chapters: Chapter[] = [
  ch(1),
  ch(2),
  ch(3, { produces: ['pages'] }),
  ch(4, { unlocks: { kind: 'chapter', ref: 'chp-1' } }),
  ch(5, { consumes: ['pages'] }),
  ch(6, { required: false, discoveredFrom: { chapterId: 'chp-4' } })
]
const states: Record<string, ChapterState> = {
  'chp-1': 'done',
  'chp-2': 'done',
  'chp-3': 'running',
  'chp-4': 'locked',
  'chp-5': 'locked',
  'chp-6': 'todo'
}

describe('layoutCampaignMap — tiles', () => {
  const layout = layoutCampaignMap(chapters, states, ['chp-3'])

  it('places the required chapters in plan order on a 4-column grid (200px pitch)', () => {
    const at = (id: string) => {
      const t = layout.tiles.find((x) => x.chapterId === id)!
      return [t.x, t.y]
    }
    expect(layout.tiles.map((t) => t.chapterId)).toEqual([
      'chp-1',
      'chp-2',
      'chp-3',
      'chp-4',
      'chp-5'
    ])
    expect(at('chp-1')).toEqual([0, 24])
    expect(at('chp-2')).toEqual([200, 24])
    expect(at('chp-3')).toEqual([400, 24])
    expect(at('chp-4')).toEqual([600, 24])
    // Row 0 carries one dock (8 + 24 under its tile), so row 1 starts at 24 + 96 + 32 + 40.
    expect(at('chp-5')).toEqual([0, 192])
    expect(layout.tiles[0]).toMatchObject({ w: 164, h: 96 })
  })

  it('carries the state and the current marker on each tile', () => {
    const t = (id: string) => layout.tiles.find((x) => x.chapterId === id)!
    expect(t('chp-3')).toMatchObject({ state: 'running', current: true })
    expect(t('chp-1')).toMatchObject({ state: 'done', current: false })
    expect(t('chp-4')).toMatchObject({ state: 'locked', current: false })
  })

  it('sizes the board: 4 tiles + 3 gutters + the 20px return lane wide', () => {
    expect(layout.width).toBe(784)
    // Row 1 ends at 192 + 96, plus 24 of bottom padding.
    expect(layout.height).toBe(312)
  })

  it('a board of fewer than four chapters is only as wide as it needs', () => {
    const small = layoutCampaignMap([ch(1), ch(2)], { 'chp-1': 'done', 'chp-2': 'todo' }, [])
    expect(small.width).toBe(2 * 164 + 36 + 20)
  })
})

describe('layoutCampaignMap — docks', () => {
  const layout = layoutCampaignMap(chapters, states, ['chp-3'])

  it('docks a side chapter under the chapter it was discovered from', () => {
    expect(layout.docks).toHaveLength(1)
    expect(layout.docks[0]).toMatchObject({
      chapterId: 'chp-6',
      originId: 'chp-4',
      x: 600,
      y: 128,
      w: 164,
      h: 20
    })
    // The dashed stem runs from the tile's bottom edge to the last dock's bottom edge.
    expect(layout.stems).toEqual([{ originId: 'chp-4', x: 610, y: 120, h: 28 }])
  })

  it('stacks two docks 24px apart and lengthens the stem', () => {
    const two = layoutCampaignMap(
      [...chapters, ch(7, { required: false, discoveredFrom: { chapterId: 'chp-4' } })],
      { ...states, 'chp-7': 'done' },
      []
    )
    expect(two.docks.map((d) => d.y)).toEqual([128, 152])
    expect(two.stems[0].h).toBe(52)
  })

  it('a side chapter with no resolvable origin is not docked; it is listed as undocked', () => {
    const loose = layoutCampaignMap(
      [
        ch(1),
        ch(2, { required: false }),
        ch(3, { required: false, discoveredFrom: { chapterId: 'chp-nope' } })
      ],
      { 'chp-1': 'todo', 'chp-2': 'todo', 'chp-3': 'todo' },
      []
    )
    expect(loose.docks).toEqual([])
    expect(loose.undocked).toEqual(['chp-2', 'chp-3'])
  })
})

describe('layoutCampaignMap — edges', () => {
  const layout = layoutCampaignMap(chapters, states, ['chp-3'])
  const edge = (from: string, to: string) =>
    layout.edges.find((e) => e.from === from && e.to === to)

  it('draws sequence edges only where no explicit dependency enters the chapter', () => {
    expect(layout.edges.map((e) => `${e.from}>${e.to}`)).toEqual([
      'chp-1>chp-2',
      'chp-2>chp-3',
      'chp-1>chp-4',
      'chp-3>chp-5'
    ])
    // 3→4 and 4→5 are NOT drawn: chapters 4 and 5 have explicit edges into them.
    expect(edge('chp-3', 'chp-4')).toBeUndefined()
    expect(edge('chp-4', 'chp-5')).toBeUndefined()
  })

  it('names where each edge came from', () => {
    expect(edge('chp-1', 'chp-2')?.via).toBe('sequence')
    expect(edge('chp-1', 'chp-4')?.via).toBe('unlocks')
    expect(edge('chp-3', 'chp-5')?.via).toBe('token')
  })

  it('classes an edge by its target: locked is dashed, the current chapter is accent, a done source is green', () => {
    expect(edge('chp-1', 'chp-2')?.kind).toBe('ok')
    expect(edge('chp-2', 'chp-3')?.kind).toBe('cur')
    expect(edge('chp-1', 'chp-4')?.kind).toBe('lock')
    expect(edge('chp-3', 'chp-5')?.kind).toBe('lock')
  })

  it('routes neighbours straight and everything else through the gutter and the row channel', () => {
    expect(edge('chp-1', 'chp-2')?.d).toBe('M164,72 H198')
    expect(edge('chp-2', 'chp-3')?.d).toBe('M364,72 H398')
    // Same row, not adjacent: out into the gutter, up to the channel above the row, along, down.
    expect(edge('chp-1', 'chp-4')?.d).toBe('M164,72 H182 V4 H682 V22')
    // Wrapping to the next row: through the gutter right of the source, along the channel above row 1.
    expect(edge('chp-3', 'chp-5')?.d).toBe('M564,72 H582 V172 H82 V190')
  })

  it('a last-column source leaves through the return lane on the right', () => {
    const wrap = layoutCampaignMap(
      [ch(1), ch(2), ch(3), ch(4), ch(5)],
      { 'chp-1': 'done', 'chp-2': 'done', 'chp-3': 'done', 'chp-4': 'done', 'chp-5': 'running' },
      ['chp-5']
    )
    // No docks: row 1 starts at 24 + 96 + 40 = 160, its channel at 140.
    expect(wrap.edges.find((e) => e.from === 'chp-4' && e.to === 'chp-5')?.d).toBe(
      'M764,72 H780 V140 H82 V158'
    )
  })

  it('an edge to a chapter that has no tile (a side chapter, an unknown id) is dropped', () => {
    const odd = layoutCampaignMap(
      [
        ch(1, { produces: ['x'] }),
        ch(2, { required: false, produces: ['y'] }),
        ch(3, { consumes: ['y'], unlocks: { kind: 'chapter', ref: 'chp-nope' } })
      ],
      { 'chp-1': 'done', 'chp-2': 'todo', 'chp-3': 'todo' },
      []
    )
    // Chapter 3's only prerequisites resolve to nothing drawable, so it falls back to the sequence edge.
    expect(odd.edges.map((e) => `${e.from}>${e.to}:${e.via}`)).toEqual(['chp-1>chp-3:sequence'])
  })
})
