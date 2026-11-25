import { describe, it, expect } from 'vitest'
import {
  SECTION_MIN_HEIGHT,
  SECTION_MAX_HEIGHT,
  SIDEBAR_LIST_MIN_HEIGHT,
  sectionStorageKey,
  parseSectionState,
  serializeSectionState,
  clampSectionHeight,
  dragCeiling,
  heightFromDrag,
  DEFAULT_SECTION_STATE
} from '../src/renderer/src/lib/sidebar-section'

describe('sectionStorageKey', () => {
  it('namespaces the key under om2tab. and the section id', () => {
    expect(sectionStorageKey('return')).toBe('om2tab.sidebarSection.return')
  })
})

describe('parseSectionState', () => {
  it('reads a stored height and collapsed flag', () => {
    expect(parseSectionState('{"height":220,"collapsed":true}')).toEqual({
      height: 220,
      collapsed: true
    })
  })

  it('keeps null for a section that was never dragged', () => {
    expect(parseSectionState('{"height":null,"collapsed":false}')).toEqual({
      height: null,
      collapsed: false
    })
  })

  it('falls back to the default for missing, corrupt or non-object values', () => {
    for (const raw of [null, '', 'not json', '[]', '42', 'null', '"x"']) {
      expect(parseSectionState(raw)).toEqual(DEFAULT_SECTION_STATE)
    }
  })

  it('drops a height that is not a finite number in range, keeps the collapsed flag', () => {
    expect(parseSectionState('{"height":"tall","collapsed":true}')).toEqual({
      height: null,
      collapsed: true
    })
    expect(parseSectionState('{"height":-5}')).toEqual({ height: null, collapsed: false })
    expect(parseSectionState('{"height":0}')).toEqual({ height: null, collapsed: false })
    expect(parseSectionState('{"height":99999}')).toEqual({ height: null, collapsed: false })
  })

  it('only the literal true collapses', () => {
    expect(parseSectionState('{"height":null,"collapsed":"true"}').collapsed).toBe(false)
    expect(parseSectionState('{"height":null,"collapsed":1}').collapsed).toBe(false)
  })

  it('round-trips through serializeSectionState', () => {
    const s = { height: 301, collapsed: true }
    expect(parseSectionState(serializeSectionState(s))).toEqual(s)
    expect(parseSectionState(serializeSectionState(DEFAULT_SECTION_STATE))).toEqual(
      DEFAULT_SECTION_STATE
    )
  })
})

describe('clampSectionHeight', () => {
  it('passes a height that is inside the bounds, rounded to whole pixels', () => {
    expect(clampSectionHeight(200.4, { min: 88, max: 640, ceiling: 500 })).toBe(200)
  })

  it('never goes below the floor (eyebrow + one row)', () => {
    expect(clampSectionHeight(10, { min: SECTION_MIN_HEIGHT, max: 640, ceiling: 500 })).toBe(
      SECTION_MIN_HEIGHT
    )
  })

  it('never goes above the configured max', () => {
    expect(clampSectionHeight(900, { min: 88, max: 400, ceiling: 800 })).toBe(400)
  })

  it('never goes above the ceiling the folder list leaves it', () => {
    expect(clampSectionHeight(600, { min: 88, max: 640, ceiling: 300 })).toBe(300)
  })

  it('the floor wins when the window is too short for both', () => {
    expect(clampSectionHeight(200, { min: 88, max: 640, ceiling: 40 })).toBe(88)
  })

  it('treats a non-finite input as the floor', () => {
    expect(clampSectionHeight(Number.NaN, { min: 88, max: 640, ceiling: 500 })).toBe(88)
  })
})

describe('dragCeiling', () => {
  it('is the height at drag start plus the list height spare above its minimum', () => {
    expect(dragCeiling({ startHeight: 150, listHeight: 500, listMin: 160, max: 640 })).toBe(490)
  })

  it('adds nothing when the list is already at or under its minimum', () => {
    expect(dragCeiling({ startHeight: 150, listHeight: 160, listMin: 160, max: 640 })).toBe(150)
    expect(dragCeiling({ startHeight: 150, listHeight: 90, listMin: 160, max: 640 })).toBe(150)
  })

  it('is capped by max', () => {
    expect(dragCeiling({ startHeight: 150, listHeight: 2000, listMin: 160, max: 640 })).toBe(640)
  })

  it('uses the shared list minimum constant', () => {
    expect(SIDEBAR_LIST_MIN_HEIGHT).toBe(160)
    expect(SECTION_MAX_HEIGHT).toBeGreaterThan(SECTION_MIN_HEIGHT)
  })
})

describe('heightFromDrag', () => {
  const bounds = { min: 88, max: 640, ceiling: 400 }

  it('dragging up makes the section taller, 1:1', () => {
    expect(heightFromDrag({ startHeight: 200, startY: 500, y: 450, ...bounds })).toBe(250)
  })

  it('dragging down makes it shorter, 1:1', () => {
    expect(heightFromDrag({ startHeight: 200, startY: 500, y: 540, ...bounds })).toBe(160)
  })

  it('clamps at the floor and at the ceiling', () => {
    expect(heightFromDrag({ startHeight: 200, startY: 500, y: 900, ...bounds })).toBe(88)
    expect(heightFromDrag({ startHeight: 200, startY: 500, y: 0, ...bounds })).toBe(400)
  })
})
