// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CanvasToolbar from '../src/renderer/src/components/CanvasToolbar.vue'
import { CANVAS_TOOLS, type CanvasTool } from '../src/renderer/src/components/canvas/canvas-tools'
import { i18n } from '@renderer/i18n'

/**
 * Contract for the T536 U1 canvas toolbar. The component is presentational:
 * it receives the tool state as props and reports intent as events, so every
 * case here drives it through props and reads events back.
 */

const NAMES: Record<CanvasTool, string> = {
  hand: 'Hand',
  select: 'Select',
  rectangle: 'Rectangle',
  arrow: 'Arrow',
  text: 'Text',
  eraser: 'Eraser'
}

function mountBar(
  props: { tool?: CanvasTool; locked?: boolean; used?: ReadonlySet<CanvasTool> } = {}
): ReturnType<typeof mount> {
  return mount(CanvasToolbar, {
    props: {
      tool: props.tool ?? 'select',
      locked: props.locked ?? false,
      used: props.used ?? new Set<CanvasTool>()
    },
    global: { plugins: [i18n] }
  })
}

describe('CanvasToolbar', () => {
  it('renders the lock plus one button per tool, in CANVAS_TOOLS order', () => {
    const w = mountBar()
    const ids = w
      .findAll('button')
      .map((b) => b.attributes('data-testid'))
      .filter(Boolean)
    expect(ids).toEqual(['canvas-tool-lock', ...CANVAS_TOOLS.map((t) => `canvas-tool-${t.id}`)])
    expect(w.find('[data-testid="canvas-toolbar"]').exists()).toBe(true)
  })

  it('places a separator after Hand and nowhere else', () => {
    const w = mountBar()
    const seps = w.findAll('[role="separator"]')
    expect(seps).toHaveLength(1)
    const children = Array.from(
      w.find('[data-testid="canvas-toolbar"] [role="toolbar"]').element.children
    )
    const sepIndex = children.indexOf(seps[0].element)
    expect(children[sepIndex - 1].getAttribute('data-testid')).toBe('canvas-tool-hand')
    expect(children[sepIndex + 1].getAttribute('data-testid')).toBe('canvas-tool-select')
  })

  it('marks exactly the active tool as pressed', () => {
    const w = mountBar({ tool: 'arrow' })
    const pressed = w
      .findAll('[data-testid^="canvas-tool-"]')
      .filter(
        (b) =>
          b.attributes('aria-pressed') === 'true' &&
          b.attributes('data-testid') !== 'canvas-tool-lock'
      )
    expect(pressed.map((b) => b.attributes('data-testid'))).toEqual(['canvas-tool-arrow'])
  })

  it('gives hover classes to idle buttons only, never over the accent state', () => {
    const w = mountBar({ tool: 'arrow', locked: true })
    const active = [
      w.get('[data-testid="canvas-tool-arrow"]'),
      w.get('[data-testid="canvas-tool-lock"]')
    ]
    for (const b of active) {
      expect(b.classes()).toContain('bg-accent-soft')
      expect(b.classes()).not.toContain('hover:bg-surface-2')
      expect(b.classes()).not.toContain('hover:text-text')
    }
    const idle = w.get('[data-testid="canvas-tool-select"]')
    expect(idle.classes()).toContain('hover:bg-surface-2')
    expect(idle.classes()).toContain('hover:text-text')
  })

  it('emits select with the tool id when a tool button is clicked', async () => {
    const w = mountBar()
    await w.get('[data-testid="canvas-tool-rectangle"]').trigger('click')
    expect(w.emitted('select')).toEqual([['rectangle']])
  })

  it('emits toggle-lock when the lock is clicked and reflects locked in aria-pressed', async () => {
    const w = mountBar({ locked: true })
    const lock = w.get('[data-testid="canvas-tool-lock"]')
    expect(lock.attributes('aria-pressed')).toBe('true')
    await lock.trigger('click')
    expect(w.emitted('toggle-lock')).toHaveLength(1)
    const idle = mountBar({ locked: false })
    expect(idle.get('[data-testid="canvas-tool-lock"]').attributes('aria-pressed')).toBe('false')
  })

  it('titles each button with the localized name and key', () => {
    const w = mountBar()
    for (const t of CANVAS_TOOLS) {
      const title = w.get(`[data-testid="canvas-tool-${t.id}"]`).attributes('title')
      const key = t.key.toUpperCase()
      expect(title).toBe(
        t.digit ? `${NAMES[t.id]} — ${key} or ${t.digit}` : `${NAMES[t.id]} — ${key}`
      )
    }
    expect(w.get('[data-testid="canvas-tool-lock"]').attributes('title')).toBe('Keep tool active')
  })

  it('shows the digit as the corner label when a tool has one, else the letter', () => {
    const w = mountBar()
    for (const t of CANVAS_TOOLS) {
      const label = w.get(`[data-testid="canvas-tool-${t.id}"] [data-testid="canvas-tool-key"]`)
      expect(label.text()).toBe(t.digit ?? t.key.toUpperCase())
    }
    expect(w.get('[data-testid="canvas-tool-lock"] [data-testid="canvas-tool-key"]').text()).toBe(
      'Q'
    )
  })

  it('shows the hint for the active tool until that tool has been used', async () => {
    const w = mountBar({ tool: 'select' })
    const hint = (): string => w.find('[data-testid="canvas-tool-hint"]').text()
    expect(hint()).toBe('Drag to select · Space+drag to pan')
    await w.setProps({ used: new Set<CanvasTool>(['select']) })
    expect(w.find('[data-testid="canvas-tool-hint"]').exists()).toBe(false)
    await w.setProps({ tool: 'arrow' })
    expect(hint()).toBe('Drag from one shape to another')
  })

  it('stops mousedown so a press never starts a canvas gesture or a pane resize', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    let reached = false
    host.addEventListener('mousedown', () => (reached = true))
    const w = mount(CanvasToolbar, {
      props: { tool: 'select', locked: false, used: new Set<CanvasTool>() },
      global: { plugins: [i18n] },
      attachTo: host
    })
    w.get('[data-testid="canvas-tool-hand"]').element.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    )
    expect(reached).toBe(false)
    w.unmount()
    host.remove()
  })
})
