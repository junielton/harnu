// Pure tool-state module for the canvas tool modes (T536 U1).
//
// The canvas pane holds one `ToolState` in memory (never saved to the file) and
// asks this module two questions: "what does this key do?" and "what does this
// gesture mean under the active tool?". Everything here is a plain function over
// plain objects so the gesture contract (spec §5) can be tested as a table.

export type CanvasTool = 'hand' | 'select' | 'rectangle' | 'arrow' | 'text' | 'eraser'

export interface CanvasToolSpec {
  id: CanvasTool
  /** Lower-case letter shortcut. */
  key: string
  /** Number-row shortcut, when the tool has one. */
  digit: string | null
  cursor: 'grab' | 'default' | 'crosshair' | 'text' | 'cell'
  /** What a successful gesture with this tool creates, if anything. */
  creates: 'box' | 'text' | null
}

/** The v1 tools in toolbar order. Digits 3 and 4 are reserved for U2 (diamond, ellipse). */
export const CANVAS_TOOLS: readonly CanvasToolSpec[] = [
  { id: 'hand', key: 'h', digit: null, cursor: 'grab', creates: null },
  { id: 'select', key: 'v', digit: '1', cursor: 'default', creates: null },
  { id: 'rectangle', key: 'r', digit: '2', cursor: 'crosshair', creates: 'box' },
  { id: 'arrow', key: 'a', digit: '5', cursor: 'crosshair', creates: null },
  { id: 'text', key: 't', digit: '6', cursor: 'text', creates: 'text' },
  { id: 'eraser', key: 'e', digit: '0', cursor: 'cell', creates: null }
]

/** Toggles "keep the tool active after a creation". */
export const LOCK_KEY = 'q'

export interface ToolState {
  tool: CanvasTool
  locked: boolean
  spaceHeld: boolean
}

export const INITIAL_TOOL_STATE: ToolState = { tool: 'select', locked: false, spaceHeld: false }

/** The tool that actually drives gestures: Space held is a temporary Hand. */
export function effectiveTool(s: ToolState): CanvasTool {
  return s.spaceHeld ? 'hand' : s.tool
}

export function selectTool(s: ToolState, t: CanvasTool): ToolState {
  return { ...s, tool: t }
}

export function toggleLock(s: ToolState): ToolState {
  return { ...s, locked: !s.locked }
}

/** After a creation the tool reverts to Select, unless Lock is on. */
export function afterCreate(s: ToolState): ToolState {
  return s.locked ? { ...s } : { ...s, tool: 'select' }
}

export function pressSpace(s: ToolState): ToolState {
  return { ...s, spaceHeld: true }
}

export function releaseSpace(s: ToolState): ToolState {
  return { ...s, spaceHeld: false }
}

export type EscOutcome = 'cancel-gesture' | 'to-select' | 'clear-selection'

/** Esc: cancel a gesture in progress, else leave the tool, else clear the selection. */
export function escapeOutcome(s: ToolState, gestureInProgress: boolean): EscOutcome {
  if (gestureInProgress) return 'cancel-gesture'
  if (s.tool !== 'select') return 'to-select'
  return 'clear-selection'
}

export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/**
 * Resolve a key press to a tool switch or the lock toggle. Shortcuts never fire
 * with ctrl/⌘/alt, so ⌘D, ⌘A and friends keep their current meaning.
 */
export function toolForKey(ev: KeyLike): CanvasTool | 'lock' | null {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null
  const k = ev.key.toLowerCase()
  if (k === LOCK_KEY) return 'lock'
  const spec = CANVAS_TOOLS.find((t) => t.key === k || t.digit === k)
  return spec ? spec.id : null
}

export type BlankGesture = 'click' | 'drag' | 'dblclick'
export type NodeGesture = 'press' | 'drag' | 'dblclick'

export type GestureIntent =
  | 'none'
  | 'clear-selection'
  | 'rubberband'
  | 'select-node'
  | 'move-node'
  | 'pan'
  | 'place-shape'
  | 'draw-shape'
  | 'start-arrow'
  | 'place-text'
  | 'edit-text'
  | 'rename-node'
  | 'erase'

/** What a gesture on empty canvas means under `tool` (spec §5). */
export function blankIntent(tool: CanvasTool, g: BlankGesture): GestureIntent {
  switch (tool) {
    case 'select':
      return g === 'click' ? 'clear-selection' : g === 'drag' ? 'rubberband' : 'place-text'
    case 'hand':
      return g === 'drag' ? 'pan' : 'none'
    case 'rectangle':
      return g === 'click' ? 'place-shape' : g === 'drag' ? 'draw-shape' : 'none'
    case 'arrow':
      return 'none'
    case 'text':
      return 'place-text'
    case 'eraser':
      return g === 'drag' ? 'erase' : 'none'
  }
}

/** What a gesture on a node means under `tool` (spec §5). `nodeShape` is the node's shape. */
export function nodeIntent(tool: CanvasTool, g: NodeGesture, nodeShape: string): GestureIntent {
  // Double-click renames a node in every tool except Eraser (spec §5).
  if (g === 'dblclick') return tool === 'eraser' ? 'none' : 'rename-node'
  switch (tool) {
    case 'select':
      return g === 'press' ? 'select-node' : 'move-node'
    case 'hand':
      return g === 'drag' ? 'pan' : 'none'
    case 'rectangle':
      return g === 'press' ? 'place-shape' : 'draw-shape'
    case 'arrow':
      return 'start-arrow'
    case 'text':
      if (g === 'press') return nodeShape === 'text' ? 'edit-text' : 'place-text'
      return 'none'
    case 'eraser':
      return 'erase'
  }
}

/**
 * The toolbar is centred in the pane. It needs its own row (under the zoom
 * cluster) when its left edge would come within 8px of the cluster's right edge.
 */
export function toolbarNeedsOwnRow(
  paneWidth: number,
  toolbarWidth: number,
  clusterRight: number
): boolean {
  return (paneWidth - toolbarWidth) / 2 < clusterRight + 8
}
