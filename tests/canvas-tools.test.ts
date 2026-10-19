import { describe, expect, it } from 'vitest'
import {
  CANVAS_TOOLS,
  INITIAL_TOOL_STATE,
  LOCK_KEY,
  afterCreate,
  blankIntent,
  effectiveTool,
  escapeOutcome,
  nodeIntent,
  pressSpace,
  releaseSpace,
  selectTool,
  toggleLock,
  toolForKey,
  toolbarNeedsOwnRow,
  type BlankGesture,
  type CanvasTool,
  type GestureIntent,
  type KeyLike,
  type NodeGesture,
  type ToolState
} from '../src/renderer/src/components/canvas/canvas-tools'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods
})

describe('tool registry', () => {
  it('starts on select, unlocked, space not held', () => {
    expect(INITIAL_TOOL_STATE).toEqual({ tool: 'select', locked: false, spaceHeld: false })
  })

  it('lists the v1 tools in toolbar order', () => {
    expect(CANVAS_TOOLS.map((t) => t.id)).toEqual([
      'hand',
      'select',
      'rectangle',
      'arrow',
      'text',
      'eraser'
    ])
  })

  it('carries the spec cursors and creation kinds', () => {
    const byId = Object.fromEntries(CANVAS_TOOLS.map((t) => [t.id, t]))
    expect(byId.hand.cursor).toBe('grab')
    expect(byId.select.cursor).toBe('default')
    expect(byId.rectangle.cursor).toBe('crosshair')
    expect(byId.arrow.cursor).toBe('crosshair')
    expect(byId.text.cursor).toBe('text')
    expect(byId.eraser.cursor).toBe('cell')
    expect(byId.rectangle.creates).toBe('box')
    expect(byId.text.creates).toBe('text')
    expect(byId.select.creates).toBeNull()
  })
})

describe('toolForKey', () => {
  it.each(CANVAS_TOOLS)('round-trips the letter and digit of $id', (spec) => {
    expect(toolForKey(key(spec.key))).toBe(spec.id)
    if (spec.digit !== null) expect(toolForKey(key(spec.digit))).toBe(spec.id)
  })

  it('maps the spec key table', () => {
    expect(toolForKey(key('h'))).toBe('hand')
    expect(toolForKey(key('v'))).toBe('select')
    expect(toolForKey(key('1'))).toBe('select')
    expect(toolForKey(key('2'))).toBe('rectangle')
    expect(toolForKey(key('5'))).toBe('arrow')
    expect(toolForKey(key('6'))).toBe('text')
    expect(toolForKey(key('0'))).toBe('eraser')
  })

  it('maps the lock key', () => {
    expect(LOCK_KEY).toBe('q')
    expect(toolForKey(key('q'))).toBe('lock')
  })

  it('is case-insensitive', () => {
    expect(toolForKey(key('R'))).toBe('rectangle')
    expect(toolForKey(key('Q'))).toBe('lock')
  })

  it.each(['ctrlKey', 'metaKey', 'altKey'] as const)('ignores %s combinations', (mod) => {
    expect(toolForKey(key('r', { [mod]: true }))).toBeNull()
    expect(toolForKey(key('2', { [mod]: true }))).toBeNull()
  })

  it('leaves 3 and 4 reserved for U2 and ignores unknown keys', () => {
    expect(toolForKey(key('3'))).toBeNull()
    expect(toolForKey(key('4'))).toBeNull()
    expect(toolForKey(key('z'))).toBeNull()
    expect(toolForKey(key('Escape'))).toBeNull()
  })
})

describe('tool state transitions', () => {
  it('selectTool switches the tool and returns a new object', () => {
    const next = selectTool(INITIAL_TOOL_STATE, 'rectangle')
    expect(next.tool).toBe('rectangle')
    expect(next).not.toBe(INITIAL_TOOL_STATE)
    expect(INITIAL_TOOL_STATE.tool).toBe('select')
  })

  it('toggleLock flips the lock without touching the tool', () => {
    const on = toggleLock(selectTool(INITIAL_TOOL_STATE, 'text'))
    expect(on).toEqual({ tool: 'text', locked: true, spaceHeld: false })
    expect(toggleLock(on).locked).toBe(false)
  })

  it('afterCreate returns to select when unlocked', () => {
    const s = selectTool(INITIAL_TOOL_STATE, 'rectangle')
    expect(afterCreate(s).tool).toBe('select')
  })

  it('afterCreate keeps the tool when locked', () => {
    const s = toggleLock(selectTool(INITIAL_TOOL_STATE, 'rectangle'))
    expect(afterCreate(s).tool).toBe('rectangle')
    expect(afterCreate(s).locked).toBe(true)
  })

  it.each([false, true])('space is a temporary hand (locked=%s)', (locked) => {
    let s: ToolState = selectTool(INITIAL_TOOL_STATE, 'rectangle')
    if (locked) s = toggleLock(s)
    const held = pressSpace(s)
    expect(effectiveTool(held)).toBe('hand')
    expect(held.tool).toBe('rectangle')
    const released = releaseSpace(held)
    expect(effectiveTool(released)).toBe('rectangle')
    expect(released).toEqual(s)
  })

  it('effectiveTool is the plain tool while space is up', () => {
    expect(effectiveTool(selectTool(INITIAL_TOOL_STATE, 'arrow'))).toBe('arrow')
  })
})

describe('escapeOutcome', () => {
  it('cancels a gesture in progress first', () => {
    expect(escapeOutcome(selectTool(INITIAL_TOOL_STATE, 'rectangle'), true)).toBe('cancel-gesture')
    expect(escapeOutcome(INITIAL_TOOL_STATE, true)).toBe('cancel-gesture')
  })

  it('goes back to select from any other tool', () => {
    expect(escapeOutcome(selectTool(INITIAL_TOOL_STATE, 'text'), false)).toBe('to-select')
  })

  it('clears the selection when already on select', () => {
    expect(escapeOutcome(INITIAL_TOOL_STATE, false)).toBe('clear-selection')
  })
})

describe('blankIntent (spec §5)', () => {
  const rows: [CanvasTool, BlankGesture, GestureIntent][] = [
    ['select', 'click', 'clear-selection'],
    ['select', 'drag', 'rubberband'],
    ['select', 'dblclick', 'place-text'],
    ['hand', 'click', 'none'],
    ['hand', 'drag', 'pan'],
    ['hand', 'dblclick', 'none'],
    ['rectangle', 'click', 'place-shape'],
    ['rectangle', 'drag', 'draw-shape'],
    ['rectangle', 'dblclick', 'none'],
    ['arrow', 'click', 'none'],
    ['arrow', 'drag', 'none'],
    ['arrow', 'dblclick', 'none'],
    ['text', 'click', 'place-text'],
    ['text', 'drag', 'place-text'],
    ['text', 'dblclick', 'place-text'],
    ['eraser', 'click', 'none'],
    ['eraser', 'drag', 'erase'],
    ['eraser', 'dblclick', 'none']
  ]
  it.each(rows)('%s + blank %s => %s', (tool, gesture, expected) => {
    expect(blankIntent(tool, gesture)).toBe(expected)
  })
})

describe('nodeIntent (spec §5)', () => {
  const rows: [CanvasTool, NodeGesture, string, GestureIntent][] = [
    ['select', 'press', 'box', 'select-node'],
    ['select', 'drag', 'box', 'move-node'],
    ['select', 'dblclick', 'box', 'rename-node'],
    ['hand', 'press', 'box', 'none'],
    ['hand', 'drag', 'box', 'pan'],
    ['hand', 'dblclick', 'box', 'none'],
    ['rectangle', 'press', 'box', 'place-shape'],
    ['rectangle', 'drag', 'box', 'draw-shape'],
    ['rectangle', 'dblclick', 'box', 'none'],
    ['arrow', 'press', 'box', 'start-arrow'],
    ['arrow', 'drag', 'box', 'start-arrow'],
    ['arrow', 'dblclick', 'box', 'rename-node'],
    ['text', 'press', 'text', 'edit-text'],
    ['text', 'press', 'box', 'place-text'],
    ['text', 'drag', 'text', 'none'],
    ['text', 'drag', 'box', 'none'],
    ['text', 'dblclick', 'text', 'rename-node'],
    ['text', 'dblclick', 'box', 'rename-node'],
    ['eraser', 'press', 'box', 'erase'],
    ['eraser', 'drag', 'box', 'erase'],
    ['eraser', 'dblclick', 'box', 'none']
  ]
  it.each(rows)('%s + node %s (%s) => %s', (tool, gesture, shape, expected) => {
    expect(nodeIntent(tool, gesture, shape)).toBe(expected)
  })
})

describe('toolbarNeedsOwnRow', () => {
  it('drops to its own row when the centred bar would touch the zoom cluster', () => {
    expect(toolbarNeedsOwnRow(320, 220, 160)).toBe(true)
  })

  it('stays on one row in a wide pane', () => {
    expect(toolbarNeedsOwnRow(900, 220, 160)).toBe(false)
  })

  it('needs an 8px gap: the boundary fits exactly', () => {
    // left edge = (pane - bar) / 2 = 168 = clusterRight + 8
    expect(toolbarNeedsOwnRow(556, 220, 160)).toBe(false)
    expect(toolbarNeedsOwnRow(554, 220, 160)).toBe(true)
  })
})
