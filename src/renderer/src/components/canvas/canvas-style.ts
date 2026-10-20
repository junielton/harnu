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
 *
 * ## Arrows (T536 U5)
 *
 * An arrow takes the same style model on `edge.props.style`, but only two keys,
 * `tone` and `stroke`, and its tone list has no `accent`: an arrow's default
 * already IS the accent colour, so an `accent` value could only draw exactly like
 * `default`. To let the panel's selection maths treat nodes and arrows alike, an
 * arrow is the pseudo-kind {@link EDGE_STYLE_KIND}. It is not a document shape
 * name (a node's `shape` can never be `@edge`) and no file ever carries it. Its
 * table, {@link PANE_EDGE_STYLE}, is mirrored from the agent's `CANVAS_EDGE_STYLE`
 * and pinned by the same parity test.
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

/** `style.stroke` → `strokeDasharray`; `solid` (and an absent key) draws none. Nodes and arrows alike. */
export const DASH_BY_STROKE: Readonly<Record<string, string>> = { dashed: '6 4', dotted: '2 3' }

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

/**
 * The pseudo-kind of an arrow in the selection maths (T536 U5). Never a document
 * shape name: nodes keep their `shape`, arrows are tagged with this wherever the
 * panel needs one "kind" per selected element.
 */
export const EDGE_STYLE_KIND = '@edge'

/**
 * The style an arrow takes: the keys and, per key, the values. Mirrors
 * `CANVAS_EDGE_STYLE` in `src/main/mcp/canvas-shapes.ts` (pinned by the parity
 * test). No `accent` tone: an arrow's default already is the accent colour.
 */
export const PANE_EDGE_STYLE: Readonly<
  Partial<Record<CanvasStyleKey, readonly CanvasStyleValue[]>>
> = {
  tone: ['default', 'green', 'amber', 'red', 'muted'],
  stroke: CANVAS_STYLE_VALUES.stroke
}

/** A kind's style table: per key it takes, the values it accepts. */
export type StyleOptions = Partial<Record<CanvasStyleKey, readonly CanvasStyleValue[]>>

export type CanvasStyle = Partial<Record<CanvasStyleKey, CanvasStyleValue>>
/** A change to a style: a value sets the key, `null` removes it. */
export type CanvasStylePatch = Partial<Record<CanvasStyleKey, CanvasStyleValue | null>>

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * What a kind takes: per style key, the values it accepts, in {@link CANVAS_STYLE_KEYS}
 * order. An arrow ({@link EDGE_STYLE_KIND}) gets {@link PANE_EDGE_STYLE}; a shape gets its
 * keys with the full value lists; the mockup card and any unknown kind get `{}`.
 */
export function styleOptionsFor(kind: string): Readonly<StyleOptions> {
  if (kind === EDGE_STYLE_KIND) return PANE_EDGE_STYLE
  if (!Object.hasOwn(PANE_STYLE_KEYS_BY_SHAPE, kind)) return {}
  return Object.fromEntries(
    PANE_STYLE_KEYS_BY_SHAPE[kind].map((key) => [key, CANVAS_STYLE_VALUES[key]])
  )
}

/** The style keys a kind takes — `[]` for the mockup card and any unknown kind. */
export function styleKeysFor(kind: string): readonly CanvasStyleKey[] {
  return Object.keys(styleOptionsFor(kind)) as CanvasStyleKey[]
}

function isAllowed(options: Readonly<StyleOptions>, key: CanvasStyleKey, value: unknown): boolean {
  return (options[key] ?? []).some((allowed) => allowed === value)
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
  const options = styleOptionsFor(kind)
  for (const key of CANVAS_STYLE_KEYS) {
    if (!Object.hasOwn(options, key) || !Object.hasOwn(style, key)) continue
    const value = style[key]
    if (isAllowed(options, key, value)) out[key] = value as CanvasStyleValue
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

/**
 * An arrow's line colour for a tone (`design.md` §6 "Arrow styles"): `default` and
 * anything this build cannot read is the accent, as before U5. `muted` is `--text-3`,
 * not the node muted stroke (`--border`), which all but vanishes as a 1.5px line.
 */
export function edgeToneStroke(tone: CanvasStyleValue | undefined, palette: CanvasPalette): string {
  const byTone: Record<string, string> = {
    default: palette.accent,
    green: palette.green,
    amber: palette.warning,
    red: palette.red,
    muted: palette.text3
  }
  return typeof tone === 'string' && Object.hasOwn(byTone, tone) ? byTone[tone] : palette.accent
}

/**
 * The `attrs.line` of an arrow, derived from its `props` (T536 U5). Width stays 1.5 and
 * the arrowhead is the same `block` marker; it takes the line's colour and is never
 * dashed (a `strokeDasharray` only sits on the line, not in `targetMarker`). A `style`
 * this build cannot read renders as the unstyled arrow.
 */
export function edgeLineAttrs(props: unknown, palette: CanvasPalette): Record<string, unknown> {
  const style = readCanvasStyle(props, EDGE_STYLE_KIND)
  const dash = typeof style.stroke === 'string' ? DASH_BY_STROKE[style.stroke] : undefined
  return {
    stroke: edgeToneStroke(style.tone, palette),
    strokeWidth: 1.5,
    ...(dash === undefined ? {} : { strokeDasharray: dash }),
    targetMarker: { name: 'block', width: 8, height: 6 }
  }
}

// ------------------------------------------------------- properties panel ---

/**
 * The options every one of `kinds` shares, in {@link CANVAS_STYLE_KEYS} order: per key,
 * the values EVERY kind accepts (a tone list that loses `accent` beside an arrow). A key
 * with no value left is dropped. `{}` for an empty list.
 */
export function sharedStyleOptions(kinds: readonly string[]): StyleOptions {
  if (kinds.length === 0) return {}
  const tables = kinds.map(styleOptionsFor)
  const out: StyleOptions = {}
  for (const key of CANVAS_STYLE_KEYS) {
    if (!tables.every((t) => Object.hasOwn(t, key))) continue
    const first = tables[0][key] ?? []
    const values = first.filter((v) => tables.every((t) => (t[key] ?? []).includes(v)))
    if (values.length > 0) out[key] = values
  }
  return out
}

/** The keys every one of `kinds` takes a value for, in table order. `[]` for an empty list. */
export function sharedStyleKeys(kinds: readonly string[]): CanvasStyleKey[] {
  return Object.keys(sharedStyleOptions(kinds)) as CanvasStyleKey[]
}

/** What the panel shows for a key the selected nodes disagree on. */
export const MIXED = 'mixed' as const

/**
 * The panel's value per shared key: the value every node has (an unset key counts
 * as the key's default), or {@link MIXED} where they differ.
 */
export function panelValues(
  nodes: readonly { kind: string; props?: Record<string, unknown> }[] // `kind` may be EDGE_STYLE_KIND
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
