// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CanvasPropertiesPanel from '../src/renderer/src/components/CanvasPropertiesPanel.vue'
import {
  CANVAS_STYLE_KEYS,
  CANVAS_STYLE_VALUES,
  MIXED,
  type CanvasStyleKey,
  type CanvasStyleValue
} from '../src/renderer/src/components/canvas/canvas-style'
import { LAYER_MOVES } from '../src/renderer/src/components/canvas/canvas-layers'
import { i18n } from '@renderer/i18n'

/**
 * Contract for the T536 U3 properties panel. Presentational: the pane feeds it the
 * keys, the resolved values and the collapse state as props, and reads the user's
 * intent back as `change` / `toggle` events.
 */

type Values = Partial<Record<CanvasStyleKey, CanvasStyleValue | typeof MIXED>>

function mountPanel(
  props: {
    keys?: readonly CanvasStyleKey[]
    values?: Values
    collapsed?: boolean
    open?: boolean
    layers?: boolean
  } = {}
): ReturnType<typeof mount> {
  return mount(CanvasPropertiesPanel, {
    props: {
      keys: props.keys ?? CANVAS_STYLE_KEYS,
      values: props.values ?? {},
      collapsed: props.collapsed ?? false,
      open: props.open ?? false,
      layers: props.layers ?? false
    },
    global: { plugins: [i18n] }
  })
}

const option = (w: ReturnType<typeof mount>, key: string, value: string | number) =>
  w.get(`[data-testid="canvas-prop-${key}-${value}"]`)

describe('CanvasPropertiesPanel', () => {
  it('renders one radiogroup per key, in key order, under a chrome root', () => {
    const w = mountPanel()
    const root = w.get('[data-testid="canvas-properties"]')
    expect(root.attributes('data-canvas-chrome')).toBeDefined()
    const groups = w.findAll('[role="radiogroup"]')
    expect(groups).toHaveLength(7)
    expect(groups.map((g) => g.attributes('data-testid'))).toEqual(
      CANVAS_STYLE_KEYS.map((k) => `canvas-prop-group-${k}`)
    )
    expect(groups.map((g) => g.attributes('aria-label'))).toEqual([
      'Color',
      'Stroke',
      'Stroke width',
      'Corners',
      'Text size',
      'Align',
      'Opacity'
    ])
  })

  it('renders an option for every allowed value of every key', () => {
    const w = mountPanel()
    for (const key of CANVAS_STYLE_KEYS) {
      for (const value of CANVAS_STYLE_VALUES[key]) {
        expect(w.find(`[data-testid="canvas-prop-${key}-${value}"]`).exists()).toBe(true)
      }
    }
  })

  it('renders only the groups it is given', () => {
    const w = mountPanel({ keys: ['opacity'] })
    const groups = w.findAll('[role="radiogroup"]')
    expect(groups).toHaveLength(1)
    expect(groups[0].attributes('data-testid')).toBe('canvas-prop-group-opacity')
    expect(w.find('[data-testid="canvas-prop-tone-green"]').exists()).toBe(false)
  })

  it('checks exactly the option equal to the key value', () => {
    const w = mountPanel({ values: { tone: 'amber', opacity: 50 } })
    const checked = w
      .findAll('[role="radio"][aria-checked="true"]')
      .map((o) => o.attributes('data-testid'))
    expect(checked).toEqual(['canvas-prop-tone-amber', 'canvas-prop-opacity-50'])
  })

  it('checks nothing in a group whose value is mixed', () => {
    const w = mountPanel({ values: { tone: MIXED, stroke: 'dashed' } })
    const tone = w.get('[data-testid="canvas-prop-group-tone"]')
    expect(tone.findAll('[aria-checked="true"]')).toHaveLength(0)
    expect(option(w, 'stroke', 'dashed').attributes('aria-checked')).toBe('true')
  })

  it('emits change with the clicked value', async () => {
    const w = mountPanel({ values: { tone: 'default' } })
    await option(w, 'tone', 'green').trigger('click')
    expect(w.emitted('change')).toEqual([[{ tone: 'green' }]])
  })

  it('emits the opacity as a number', async () => {
    const w = mountPanel()
    await option(w, 'opacity', 50).trigger('click')
    expect(w.emitted('change')).toEqual([[{ opacity: 50 }]])
  })

  it('emits nothing when the already-checked option is clicked', async () => {
    const w = mountPanel({ values: { tone: 'green' } })
    await option(w, 'tone', 'green').trigger('click')
    expect(w.emitted('change')).toBeUndefined()
  })

  it('emits when an option of a mixed group is clicked', async () => {
    const w = mountPanel({ values: { tone: MIXED } })
    await option(w, 'tone', 'default').trigger('click')
    expect(w.emitted('change')).toEqual([[{ tone: 'default' }]])
  })

  it('collapsed and closed renders only the toggle', async () => {
    const w = mountPanel({ collapsed: true, open: false })
    const toggle = w.get('[data-testid="canvas-properties-toggle"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(toggle.attributes('title')).toBe('Show style options')
    expect(w.findAll('[role="radiogroup"]')).toHaveLength(0)
    await toggle.trigger('click')
    expect(w.emitted('toggle')).toHaveLength(1)
  })

  it('collapsed and open renders the toggle and the groups', () => {
    const w = mountPanel({ collapsed: true, open: true })
    expect(w.get('[data-testid="canvas-properties-toggle"]').attributes('aria-expanded')).toBe(
      'true'
    )
    expect(w.findAll('[role="radiogroup"]')).toHaveLength(7)
  })

  it('expanded renders no toggle', () => {
    const w = mountPanel({ collapsed: false })
    expect(w.find('[data-testid="canvas-properties-toggle"]').exists()).toBe(false)
  })

  it('keeps mousedown and pointerdown away from the canvas', async () => {
    const seen: string[] = []
    const parent = document.createElement('div')
    parent.addEventListener('mousedown', () => seen.push('mousedown'))
    parent.addEventListener('pointerdown', () => seen.push('pointerdown'))
    document.body.appendChild(parent)
    const w = mount(CanvasPropertiesPanel, {
      props: { keys: CANVAS_STYLE_KEYS, values: {}, collapsed: true, open: true, layers: false },
      global: { plugins: [i18n] },
      attachTo: parent
    })
    await option(w, 'tone', 'green').trigger('mousedown')
    await option(w, 'tone', 'green').trigger('pointerdown')
    await w.get('[data-testid="canvas-properties-toggle"]').trigger('mousedown')
    await w.get('[data-testid="canvas-properties"]').trigger('mousedown')
    expect(seen).toEqual([])
    w.unmount()
    parent.remove()
  })

  it('draws a tone swatch with the tone utilities and no inline colour', () => {
    const w = mountPanel()
    const swatch = option(w, 'tone', 'green').get('[data-testid="canvas-prop-swatch"]')
    expect(swatch.classes()).toEqual(expect.arrayContaining(['bg-green-soft', 'border-green']))
    expect(swatch.attributes('style') ?? '').not.toMatch(/color|background|border/i)
    const muted = option(w, 'tone', 'muted').get('[data-testid="canvas-prop-swatch"]')
    expect(muted.classes()).toEqual(expect.arrayContaining(['bg-bg', 'border-border']))
  })

  it('gives every option a localized title and aria-label', () => {
    const w = mountPanel()
    const radios = w.findAll('[role="radio"]')
    expect(radios).toHaveLength(
      CANVAS_STYLE_KEYS.reduce((n, k) => n + CANVAS_STYLE_VALUES[k].length, 0)
    )
    for (const r of radios) {
      const label = r.attributes('aria-label')
      expect(label).toBeTruthy()
      expect(label).not.toMatch(/^diagramPane\./)
      expect(r.attributes('title')).toBe(label)
    }
    expect(option(w, 'tone', 'amber').attributes('aria-label')).toBe('Amber')
    expect(option(w, 'stroke', 'dotted').attributes('aria-label')).toBe('Dotted')
    expect(option(w, 'fontSize', 'xl').attributes('aria-label')).toBe('Extra large')
    expect(option(w, 'align', 'center').attributes('aria-label')).toBe('Center')
    expect(option(w, 'opacity', 50).attributes('aria-label')).toBe('50%')
  })

  it('marks active and idle options with the toolbar classes', () => {
    const w = mountPanel({ values: { tone: 'red' } })
    expect(option(w, 'tone', 'red').classes()).toEqual(
      expect.arrayContaining(['bg-accent-soft', 'text-accent'])
    )
    expect(option(w, 'tone', 'green').classes()).toEqual(
      expect.arrayContaining(['text-text-3', 'hover:bg-surface-2', 'hover:text-text'])
    )
  })
})

describe('CanvasPropertiesPanel — Layers (T536 U4)', () => {
  const layerButtons = (w: ReturnType<typeof mount>) =>
    w.get('[data-testid="canvas-layers"]').findAll('button')

  it('layers with no style keys renders only the Layers group, four buttons in move order', () => {
    const w = mountPanel({ keys: [], layers: true })
    expect(w.findAll('[role="radiogroup"]')).toHaveLength(0)
    const group = w.get('[data-testid="canvas-layers"]')
    expect(group.attributes('role')).toBe('group')
    expect(group.attributes('aria-label')).toBe('Layers')
    expect(layerButtons(w).map((b) => b.attributes('data-testid'))).toEqual(
      LAYER_MOVES.map((m) => `canvas-layer-${m}`)
    )
  })

  it('shows the Layers group after the style groups', () => {
    const w = mountPanel({ keys: ['tone'], layers: true })
    const tested = w
      .findAll('[data-testid="canvas-prop-group-tone"], [data-testid="canvas-layers"]')
      .map((g) => g.attributes('data-testid'))
    expect(tested).toEqual(['canvas-prop-group-tone', 'canvas-layers'])
  })

  it('emits layer with the clicked move', async () => {
    const w = mountPanel({ keys: [], layers: true })
    await w.get('[data-testid="canvas-layer-front"]').trigger('click')
    await w.get('[data-testid="canvas-layer-backward"]').trigger('click')
    expect(w.emitted('layer')).toEqual([['front'], ['backward']])
    expect(w.emitted('change')).toBeUndefined()
  })

  it('layers false renders no Layers group', () => {
    const w = mountPanel({ layers: false })
    expect(w.find('[data-testid="canvas-layers"]').exists()).toBe(false)
    expect(w.find('[data-testid^="canvas-layer-"]').exists()).toBe(false)
  })

  it('the buttons are actions: no radio role and no aria-checked', () => {
    const w = mountPanel({ keys: [], layers: true })
    for (const b of layerButtons(w)) {
      expect(b.attributes('role')).toBeUndefined()
      expect(b.attributes('aria-checked')).toBeUndefined()
      expect(b.attributes('type')).toBe('button')
      expect(b.classes()).toEqual(
        expect.arrayContaining(['text-text-3', 'hover:bg-surface-2', 'hover:text-text'])
      )
    }
  })

  it('gives every Layers button a localized title and aria-label', () => {
    const w = mountPanel({ keys: [], layers: true })
    const labels = layerButtons(w).map((b) => {
      expect(b.attributes('title')).toBe(b.attributes('aria-label'))
      return b.attributes('aria-label')
    })
    expect(labels).toEqual(['Send to back', 'Send backward', 'Bring forward', 'Bring to front'])
  })

  it('a press on a Layers button does not reach the parent', async () => {
    const seen: string[] = []
    const parent = document.createElement('div')
    parent.addEventListener('mousedown', () => seen.push('mousedown'))
    parent.addEventListener('pointerdown', () => seen.push('pointerdown'))
    document.body.appendChild(parent)
    const w = mount(CanvasPropertiesPanel, {
      props: { keys: [], values: {}, collapsed: false, open: false, layers: true },
      global: { plugins: [i18n] },
      attachTo: parent
    })
    await w.get('[data-testid="canvas-layer-back"]').trigger('mousedown')
    await w.get('[data-testid="canvas-layer-back"]').trigger('pointerdown')
    expect(seen).toEqual([])
    w.unmount()
    parent.remove()
  })

  it('collapsed and closed hides the Layers group with the rest', () => {
    const w = mountPanel({ keys: [], layers: true, collapsed: true, open: false })
    expect(w.find('[data-testid="canvas-properties-toggle"]').exists()).toBe(true)
    expect(w.find('[data-testid="canvas-layers"]').exists()).toBe(false)
  })
})
