import { describe, it, expect } from 'vitest'
import {
  MIXED,
  STYLE_PANEL_WIDTH,
  mergeCanvasStyle,
  panelValues,
  readCanvasStyle,
  sharedStyleKeys,
  styleKeysFor,
  stylePanelCollapsed,
  stylePanelTop,
  toneColors
} from '../src/renderer/src/components/canvas/canvas-style'
import type { CanvasPalette } from '../src/renderer/src/components/canvas/canvas-theme'
import { STYLE_MERGE_CASES } from './fixtures/canvas-style-merge'

/**
 * The pure style module behind the node-style rendering and the properties panel
 * (T536 U3). No DOM, no X6: everything here is a function of plain data.
 */
const P: CanvasPalette = {
  bg: '#bg',
  surface: '#surface',
  border: '#border',
  border2: '#border2',
  text: '#text',
  text2: '#text2',
  text3: '#text3',
  accent: '#accent',
  accentSoft: '#accentSoft',
  green: '#green',
  greenSoft: '#greenSoft',
  warning: '#warning',
  warningSoft: '#warningSoft',
  red: '#red',
  redSoft: '#redSoft',
  fontSans: 'TestSans'
}

describe('readCanvasStyle', () => {
  it('keeps only known keys with known values', () => {
    expect(readCanvasStyle({ style: { tone: 'purple', fontSize: 'm', glow: 1 } }, 'box')).toEqual({
      fontSize: 'm'
    })
  })

  it('reads a numeric opacity strictly — "50" is not 50', () => {
    expect(readCanvasStyle({ style: { opacity: 50 } }, 'box')).toEqual({ opacity: 50 })
    expect(readCanvasStyle({ style: { opacity: '50' } }, 'box')).toEqual({})
    expect(readCanvasStyle({ style: { opacity: 40 } }, 'box')).toEqual({})
  })

  it('returns {} for a style that is not an object', () => {
    expect(readCanvasStyle({ style: 'red' }, 'box')).toEqual({})
    expect(readCanvasStyle({ style: ['tone'] }, 'box')).toEqual({})
    expect(readCanvasStyle({ style: null }, 'box')).toEqual({})
    expect(readCanvasStyle(undefined, 'box')).toEqual({})
    expect(readCanvasStyle('x', 'box')).toEqual({})
  })

  it('ignores a key the kind does not take', () => {
    expect(readCanvasStyle({ style: { corners: 'sharp' } }, 'ellipse')).toEqual({})
    expect(readCanvasStyle({ style: { tone: 'red', opacity: 50 } }, 'image')).toEqual({
      opacity: 50
    })
  })

  it('returns {} for a kind that takes no style', () => {
    expect(readCanvasStyle({ style: { tone: 'red' } }, 'harnu/mockup-card')).toEqual({})
    expect(readCanvasStyle({ style: { tone: 'red' } }, 'hexagon')).toEqual({})
  })

  it('does not read inherited names as style keys', () => {
    const style = JSON.parse('{"__proto__":{"tone":"red"},"constructor":"x"}')
    expect(readCanvasStyle({ style }, 'box')).toEqual({})
  })
})

describe('styleKeysFor', () => {
  it('lists the keys a kind takes, in table order', () => {
    expect(styleKeysFor('box')).toEqual([
      'tone',
      'stroke',
      'strokeWidth',
      'corners',
      'fontSize',
      'align',
      'opacity'
    ])
    expect(styleKeysFor('ellipse')).not.toContain('corners')
    expect(styleKeysFor('text')).toEqual(['tone', 'fontSize', 'align', 'opacity'])
    expect(styleKeysFor('image')).toEqual(['opacity'])
  })

  it('is [] for the mockup card, an unknown kind, and an inherited object name', () => {
    expect(styleKeysFor('harnu/mockup-card')).toEqual([])
    expect(styleKeysFor('harnu/unknown')).toEqual([])
    expect(styleKeysFor('constructor')).toEqual([])
    expect(styleKeysFor('__proto__')).toEqual([])
  })
})

describe('mergeCanvasStyle — the shared fixture table', () => {
  for (const c of STYLE_MERGE_CASES) {
    it(c.name, () => {
      const before = JSON.stringify(c.props)
      const out = mergeCanvasStyle(c.props, c.patch)
      expect(out).toEqual(c.expected)
      // Strict about own keys such as __proto__, which toEqual alone can gloss over.
      expect(JSON.stringify(out)).toBe(JSON.stringify(c.expected))
      expect(JSON.stringify(c.props), 'props must not be mutated').toBe(before)
    })
  }
})

describe('sharedStyleKeys', () => {
  it('is the keys every kind takes, in table order', () => {
    expect(sharedStyleKeys(['box', 'text'])).toEqual(['tone', 'fontSize', 'align', 'opacity'])
    expect(sharedStyleKeys(['box', 'ellipse'])).not.toContain('corners')
    expect(sharedStyleKeys(['box'])).toEqual(styleKeysFor('box'))
  })

  it('is [] when any kind takes no style, and for an empty list', () => {
    expect(sharedStyleKeys(['box', 'harnu/mockup-card'])).toEqual([])
    expect(sharedStyleKeys([])).toEqual([])
  })
})

describe('panelValues', () => {
  it('is "mixed" where the nodes disagree', () => {
    const v = panelValues([
      { kind: 'box', props: { style: { tone: 'green' } } },
      { kind: 'box', props: { style: { tone: 'red' } } }
    ])
    expect(v.tone).toBe(MIXED)
  })

  it('is the default where nothing is set', () => {
    const v = panelValues([{ kind: 'box' }, { kind: 'box', props: {} }])
    expect(v.tone).toBe('default')
    expect(v.opacity).toBe(100)
    expect(v.corners).toBe('round')
  })

  it('is the shared value where the nodes agree, treating unset as the default', () => {
    expect(
      panelValues([{ kind: 'box', props: { style: { tone: 'green' } } }, { kind: 'box' }]).tone
    ).toBe(MIXED)
    expect(
      panelValues([
        { kind: 'box', props: { style: { tone: 'green' } } },
        { kind: 'ellipse', props: { style: { tone: 'green' } } }
      ]).tone
    ).toBe('green')
  })

  it('only reports keys every node takes', () => {
    const v = panelValues([{ kind: 'box' }, { kind: 'text' }])
    expect(Object.keys(v)).toEqual(['tone', 'fontSize', 'align', 'opacity'])
  })

  it('is {} for no nodes', () => {
    expect(panelValues([])).toEqual({})
  })
})

describe('panel geometry', () => {
  it('collapses below the panel width plus 200px of board', () => {
    expect(STYLE_PANEL_WIDTH).toBe(184)
    expect(stylePanelCollapsed(383)).toBe(true)
    expect(stylePanelCollapsed(384)).toBe(false)
  })

  it('sits 8px below the zoom cluster, or below the toolbar when it has its own row', () => {
    expect(stylePanelTop(48, false, 0)).toBe(56)
    expect(stylePanelTop(48, true, 120)).toBe(128)
  })
})

describe('toneColors', () => {
  it('maps every framed tone to its token pair (design.md §6 tone table)', () => {
    const rows: [string, string, string, string][] = [
      ['default', P.border2, P.surface, P.text],
      ['accent', P.accent, P.accentSoft, P.text],
      ['green', P.green, P.greenSoft, P.text],
      ['amber', P.warning, P.warningSoft, P.text],
      ['red', P.red, P.redSoft, P.text],
      ['muted', P.border, P.bg, P.text3]
    ]
    for (const [tone, stroke, fill, label] of rows) {
      expect(toneColors(tone, 'box', P), tone).toEqual({ stroke, fill, label })
    }
    expect(toneColors('amber', 'box', P)).toEqual({
      stroke: P.warning,
      fill: P.warningSoft,
      label: P.text
    })
  })

  it('defaults to the default tone, also for a value it does not know', () => {
    expect(toneColors(undefined, 'box', P)).toEqual(toneColors('default', 'box', P))
    expect(toneColors('purple', 'box', P)).toEqual(toneColors('default', 'box', P))
    expect(toneColors(40, 'box', P)).toEqual(toneColors('default', 'box', P))
  })

  it('colours a bare text node by its label alone', () => {
    expect(toneColors('accent', 'text', P).label).toBe(P.accent)
    expect(toneColors('green', 'text', P).label).toBe(P.green)
    expect(toneColors('amber', 'text', P).label).toBe(P.warning)
    expect(toneColors('red', 'text', P).label).toBe(P.red)
    expect(toneColors('muted', 'text', P).label).toBe(P.text3)
    expect(toneColors(undefined, 'text', P).label).toBe(P.text2)
    expect(toneColors('default', 'text', P).label).toBe(P.text2)
  })
})
