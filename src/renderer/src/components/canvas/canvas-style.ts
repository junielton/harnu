import type { CanvasPalette } from './canvas-theme'

/**
 * Node styles for the canvas pane (T536 U3) — PURE: no DOM, no Vue, no X6, and
 * only a TYPE import of the palette. Everything the renderer needs to turn a
 * node's `props.style` into colours and to drive the properties panel lives here.
 *
 * **Why the tables are mirrored, not imported.** The key list, the allowed
 * values, the defaults and "which shape takes which key" are the agent's
 * contract and live in `src/main/mcp/canvas-shapes.ts`, because the `draw_canvas`
 * verb needs a VALUE import of them at runtime and a renderer file imported by
 * main would drag the renderer into the main bundle. The renderer cannot import
 * `src/main` at runtime either (see the note in `canvas-cells.ts`), so it carries
 * a copy — the same convention as the default-size fallbacks. The copy is pinned
 * by `tests/canvas-style-parity.test.ts`, which imports both sides: the three
 * tables, the per-shape key lists, and the merge itself (one shared fixture table
 * run through {@link mergeCanvasStyle} and through the agent's `update_node`
 * `style` path). Change a table here and that test says which side to follow.
 *
 * The value spelling is the FILE's: `opacity` is a JSON number, everything else a
 * string. A value outside these lists is never rendered and never rewritten — the
 * reader ignores it and the merge keeps it verbatim, so a board written by a newer
 * Harnu survives a Save from this one.
 */

export const CANVAS_STYLE_KEYS = [
  'tone',
  'stroke',
  'strokeWidth',
  'corners',
  'fontSize',
  'align',
  'opacity'
] as const
export type CanvasStyleKey = (typeof CANVAS_STYLE_KEYS)[number]
export type CanvasStyleValue = string | number

/** The allowed values per key, in file spelling. Mirrors `design.md` §6 "Node styles". */
export const CANVAS_STYLE_VALUES: Readonly<Record<CanvasStyleKey, readonly CanvasStyleValue[]>> = {
  tone: ['default', 'accent', 'green', 'amber', 'red', 'muted'],
  stroke: ['solid', 'dashed', 'dotted'],
  strokeWidth: ['thin', 'regular', 'bold'],
  corners: ['sharp', 'round'],
  fontSize: ['s', 'm', 'l', 'xl'],
  align: ['left', 'center', 'right'],
  opacity: [25, 50, 75, 100]
}

/** What an absent key renders as. Writing a value equal to its default removes the key. */
export const CANVAS_STYLE_DEFAULTS: Readonly<Record<CanvasStyleKey, CanvasStyleValue>> = {
  tone: 'default',
  stroke: 'solid',
  strokeWidth: 'regular',
  corners: 'round',
  fontSize: 'm',
  align: 'center',
  opacity: 100
}

const ALL_KEYS: readonly CanvasStyleKey[] = CANVAS_STYLE_KEYS
const NO_CORNERS: readonly CanvasStyleKey[] = ALL_KEYS.filter((k) => k !== 'corners')

/**
 * Which keys each shape takes, in {@link CANVAS_STYLE_KEYS} order. Mirrors the
 * `style` table of each entry in the agent's `CANVAS_SHAPE_CATALOG`; the parity
 * test fails if a shape is added to one side only. A shape absent from this table
 * (an unknown kind from a newer Harnu) takes no style.
 */
export const PANE_STYLE_KEYS_BY_SHAPE: Readonly<Record<string, readonly CanvasStyleKey[]>> = {
  box: ALL_KEYS,
  ellipse: NO_CORNERS,
  diamond: NO_CORNERS,
  text: ['tone', 'fontSize', 'align', 'opacity'],
  image: ['opacity'],
  'harnu/mockup-card': []
}

export type CanvasStyle = Partial<Record<CanvasStyleKey, CanvasStyleValue>>
/** A change to a style: a value sets the key, `null` removes it. */
export type CanvasStylePatch = Partial<Record<CanvasStyleKey, CanvasStyleValue | null>>

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The style keys a shape takes — `[]` for the mockup card and any unknown kind. */
export function styleKeysFor(kind: string): readonly CanvasStyleKey[] {
  return Object.hasOwn(PANE_STYLE_KEYS_BY_SHAPE, kind) ? PANE_STYLE_KEYS_BY_SHAPE[kind] : []
}

function isAllowed(key: CanvasStyleKey, value: unknown): value is CanvasStyleValue {
  return CANVAS_STYLE_VALUES[key].some((allowed) => allowed === value)
}

/**
 * The renderable style of a node: the keys its kind takes, with values this build
 * knows. Anything else — an unknown key, an out-of-list value, a `style` that is
 * not an object — is ignored here, so a hand-edited or newer file renders as the
 * defaults for the parts it cannot read rather than as garbage.
 */
export function readCanvasStyle(props: unknown, kind: string): CanvasStyle {
  const out: CanvasStyle = {}
  if (!isRecord(props) || !isRecord(props.style)) return out
  const style = props.style
  for (const key of styleKeysFor(kind)) {
    if (!Object.hasOwn(style, key)) continue
    const value = style[key]
    if (isAllowed(key, value)) out[key] = value
  }
  return out
}

/**
 * Merge a style `patch` into a node's `props`, per key — the renderer twin of the
 * agent's `mergeNodeStyle` (`src/main/mcp/canvas-ops.ts`), with the same
 * semantics, pinned by the shared fixture table in the parity test:
 *
 * - `null` removes a key, and so does a value equal to the key's default, so a
 *   reset node is byte-identical to one that was never styled;
 * - keys already in the file and not named by the patch are kept verbatim, even
 *   ones this build does not know;
 * - an emptied `style` is deleted, and `props` is deleted only if that emptied it;
 * - own-property safe: a file key named `__proto__` or `constructor` is data.
 *
 * Pure: `props` is never mutated.
 */
export function mergeCanvasStyle(
  props: Record<string, unknown> | undefined,
  patch: CanvasStylePatch
): Record<string, unknown> | undefined {
  const existing = isRecord(props?.style) ? props.style : undefined
  const merged: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    const isDefault =
      Object.hasOwn(CANVAS_STYLE_DEFAULTS, key) &&
      CANVAS_STYLE_DEFAULTS[key as CanvasStyleKey] === value
    if (value === null || isDefault) delete merged[key]
    else {
      // defineProperty, not assignment: a key named `__proto__` must land as data.
      Object.defineProperty(merged, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true
      })
    }
  }
  const { style: _old, ...rest } = props ?? {}
  void _old
  if (Object.keys(merged).length > 0) return { ...rest, style: merged }
  if (props === undefined) return undefined
  // Only drop `props` if losing its style is what emptied it.
  return existing !== undefined && Object.keys(rest).length === 0 ? undefined : rest
}

/** The colours a tone resolves to for one node. */
export interface ToneColors {
  stroke: string
  fill: string
  label: string
}

/**
 * Tone → palette tokens (`design.md` §6 "Node styles", tone table). An unknown or
 * absent tone is `default`. A bare `text` node has no frame, so its tone colours
 * the label alone — with the table's stroke column — and `stroke`/`fill` are
 * `none`.
 */
export function toneColors(
  tone: CanvasStyleValue | undefined,
  kind: string,
  palette: CanvasPalette
): ToneColors {
  const p = palette
  const framed: Record<string, ToneColors> = {
    default: { stroke: p.border2, fill: p.surface, label: p.text },
    accent: { stroke: p.accent, fill: p.accentSoft, label: p.text },
    green: { stroke: p.green, fill: p.greenSoft, label: p.text },
    amber: { stroke: p.warning, fill: p.warningSoft, label: p.text },
    red: { stroke: p.red, fill: p.redSoft, label: p.text },
    muted: { stroke: p.border, fill: p.bg, label: p.text3 }
  }
  const name = typeof tone === 'string' && Object.hasOwn(framed, tone) ? tone : 'default'
  if (kind !== 'text') return framed[name]
  const textLabel: Record<string, string> = {
    default: p.text2,
    accent: p.accent,
    green: p.green,
    amber: p.warning,
    red: p.red,
    muted: p.text3
  }
  return { stroke: 'none', fill: 'none', label: textLabel[name] }
}

// ------------------------------------------------------- properties panel ---

/** The keys every one of `kinds` takes, in table order. `[]` for an empty list. */
export function sharedStyleKeys(kinds: readonly string[]): CanvasStyleKey[] {
  if (kinds.length === 0) return []
  return CANVAS_STYLE_KEYS.filter((key) => kinds.every((kind) => styleKeysFor(kind).includes(key)))
}

/** What the panel shows for a key the selected nodes disagree on. */
export const MIXED = 'mixed' as const

/**
 * The panel's value per shared key: the value every node has (an unset key counts
 * as the key's default), or {@link MIXED} where they differ.
 */
export function panelValues(
  nodes: readonly { kind: string; props?: Record<string, unknown> }[]
): Partial<Record<CanvasStyleKey, CanvasStyleValue | typeof MIXED>> {
  const out: Partial<Record<CanvasStyleKey, CanvasStyleValue | typeof MIXED>> = {}
  const styles = nodes.map((n) => readCanvasStyle(n.props, n.kind))
  for (const key of sharedStyleKeys(nodes.map((n) => n.kind))) {
    const values = styles.map((s) => s[key] ?? CANVAS_STYLE_DEFAULTS[key])
    out[key] = values.every((v) => v === values[0]) ? values[0] : MIXED
  }
  return out
}

/** The properties panel's width, in px (`design.md` §6). */
export const STYLE_PANEL_WIDTH = 184

/** Below this pane width the panel collapses to a single button (184 + 200px of board). */
export function stylePanelCollapsed(paneWidth: number): boolean {
  return paneWidth < STYLE_PANEL_WIDTH + 200
}

/**
 * The panel's top offset: 8px below the zoom cluster, or below the toolbar when
 * the toolbar has dropped to its own row (whichever sits lower).
 */
export function stylePanelTop(
  clusterBottom: number,
  toolbarOwnRow: boolean,
  toolbarBottom: number
): number {
  return Math.max(clusterBottom, toolbarOwnRow ? toolbarBottom : 0) + 8
}
