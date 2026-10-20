/**
 * The canvas SHAPE MANIFEST (T218 §5.2) — the fixed vocabulary the
 * `draw_canvas` MCP verb validates against and advertises in every ACK.
 *
 * Deliberately PURE: no Vue, no DOM, no `node:` import, no electron. §5.2's
 * requirement is that the manifest be importable by `src/main` so the verb's
 * validator can read it without pulling the renderer into the main process —
 * that requirement is met here.
 *
 * WHERE IT LIVES, and why not §5.2's literal path. The spec places this module
 * at `src/renderer/src/components/canvas/canvas-shapes.ts` and has main import
 * it. TYPE-level that would be fine — `npm run typecheck` passes
 * `--composite false` to both projects, and the repo already crosses this
 * boundary in both directions (`canvas-cells.ts` imports `../../../../main/
 * canvas-core`; `preload/index.ts` imports `../main/approval-parse`). The
 * reason it lives here is the BUNDLE, not the typechecker: main needs a VALUE
 * import of the catalog at runtime (it validates a shape name and ships the
 * ACK), so leaving it under `src/renderer/` would make electron-vite pull a
 * renderer file into the main bundle. A type-only import could stay there; this
 * one cannot. The MCP verb is also the side with the hard dependency — an
 * unvalidatable shape name is a wrong file on disk — so main owns it, and the
 * pane's own fallback sizes are pinned equal to this module's by a drift test
 * in `tests/mcp-canvas-ops.test.ts` so the two cannot disagree.
 *
 * Why a manifest at all: an HTML node is a REGISTERED component referenced by
 * shape name (§5.2). The agent writes `shape: "harnu/mockup-card"`, never
 * markup — an inline element makes `graph.toJSON()` throw (spike trap 2), and
 * since the file IS the contract (§4), a node that cannot be serialized is a
 * node that cannot exist. A name is also a stable contract across a substrate
 * swap, which a serialized DOM fragment is not.
 *
 * The agent discovers the names three ways, none of them guessing (§5.2):
 *  1. every `draw_canvas` ACK carries {@link CANVAS_SHAPE_CATALOG};
 *  2. an unknown shape is refused BY NAME, listing the valid set;
 *  3. `docs/harnu-features.md` says the catalog is discoverable from the ACK and
 *     names the built-ins in passing; the ACK stays the authority, because this
 *     list changes with the code and a doc that drifts is worse than one that points.
 */

/**
 * The seven keys of a node's `props.style` (T536 U3, `design.md` §6 "Node
 * styles"), in the order the catalog lists them. A key that is absent renders
 * as its default, so a board drawn before U3 looks exactly as it did.
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
/** A style value as the file spells it — `opacity` is a JSON number, the rest are strings. */
export type CanvasStyleValue = string | number

/** The allowed values per key, in file spelling. Mirrors the `design.md` table. */
export const CANVAS_STYLE_VALUES: Readonly<Record<CanvasStyleKey, readonly CanvasStyleValue[]>> = {
  tone: ['default', 'accent', 'green', 'amber', 'red', 'muted'],
  stroke: ['solid', 'dashed', 'dotted'],
  strokeWidth: ['thin', 'regular', 'bold'],
  corners: ['sharp', 'round'],
  fontSize: ['s', 'm', 'l', 'xl'],
  align: ['left', 'center', 'right'],
  opacity: [25, 50, 75, 100]
}

/**
 * What an absent key renders as. Writing a value equal to its default REMOVES
 * the key, so a reset node is byte-identical to one that was never styled.
 */
export const CANVAS_STYLE_DEFAULTS: Readonly<Record<CanvasStyleKey, CanvasStyleValue>> = {
  tone: 'default',
  stroke: 'solid',
  strokeWidth: 'regular',
  corners: 'round',
  fontSize: 'm',
  align: 'center',
  opacity: 100
}

/**
 * T536 U5 — the style keys an ARROW takes: the node model applied to edges
 * (`design.md` §6 "Arrow styles"). Only `tone` and `stroke`, and the tone list
 * has no `accent` because an arrow's default already is the accent colour.
 * Stored in `edge.props.style` like a node's, merged per key, default removes.
 */
export const CANVAS_EDGE_STYLE: Readonly<
  Partial<Record<CanvasStyleKey, readonly CanvasStyleValue[]>>
> = {
  tone: ['default', 'green', 'amber', 'red', 'muted'],
  stroke: CANVAS_STYLE_VALUES.stroke
}

/** Build a shape's `style` table from the keys it takes, in {@link CANVAS_STYLE_KEYS} order. */
function styleOf(...keys: CanvasStyleKey[]): CanvasShapeSpec['style'] {
  return Object.fromEntries(
    CANVAS_STYLE_KEYS.filter((k) => keys.includes(k)).map((k) => [k, CANVAS_STYLE_VALUES[k]])
  )
}

/** One entry in the shape catalog — what the agent is told about a shape. */
export interface CanvasShapeSpec {
  /**
   * The `shape` value written into the document. A registered HTML component
   * is namespaced `harnu/<name>` so it can never collide with a built-in;
   * the built-ins (§5.1) carry their bare kind.
   */
  name: string
  /** One line, shown to the agent — this is how it decides which to use. */
  description: string
  /** Size used when the caller omits `width`/`height`. */
  defaultSize: { width: number; height: number }
  /**
   * The plain-JSON keys this shape reads from `node.props`. §8.3 rule 6: a key
   * NOT listed here is REFUSED rather than stored, so the file cannot
   * accumulate junk no renderer reads.
   */
  props: readonly string[]
  /**
   * The `props.style` keys this shape honours, each with its allowed values
   * (T536 U3). It is separate from {@link props} on purpose: `style` merges per
   * key and survives a `props` replace, so it is never a `props` key. A key not
   * listed here is refused `BAD_PROPS`; an empty table means the shape takes no
   * style at all.
   */
  style: Readonly<Partial<Record<CanvasStyleKey, readonly CanvasStyleValue[]>>>
}

/**
 * Fallback size for a framed node, and for a bare `text` node.
 *
 * These MIRROR `canvas-cells.ts`'s `DEFAULT_NODE_SIZE` / `DEFAULT_TEXT_SIZE`
 * rather than importing them: that module pulls the palette/port types the
 * pane needs, and this manifest must stay importable from `src/main`. The
 * duplication is pinned by a drift test (`tests/mcp-canvas-ops.test.ts`), so
 * the two cannot silently disagree about how big an un-sized node is. The
 * `ellipse` and `diamond` sizes in the catalog below are inline literals,
 * covered by the same drift test.
 */
const DEFAULT_FRAMED_SIZE = { width: 132, height: 52 } as const
const DEFAULT_TEXT_SIZE = { width: 160, height: 24 } as const

/**
 * The built-in kinds of §5.1 (plus `ellipse` and `diamond`, T536 U2).
 * `frame`/container is deliberately absent — deferred to v2 because X6's
 * `embedding` was never exercised in the spike.
 */
export const CANVAS_BUILTIN_SHAPES: readonly CanvasShapeSpec[] = [
  {
    name: 'box',
    description: 'Rounded rectangle with a centred label. The default.',
    defaultSize: DEFAULT_FRAMED_SIZE,
    props: [],
    style: styleOf(...CANVAS_STYLE_KEYS)
  },
  {
    name: 'ellipse',
    description: 'Ellipse with a centred label — for states, start/end points.',
    defaultSize: { width: 132, height: 64 },
    props: [],
    style: styleOf('tone', 'stroke', 'strokeWidth', 'fontSize', 'align', 'opacity')
  },
  {
    name: 'diamond',
    description: 'Diamond with a centred label — for decisions in a flow.',
    defaultSize: { width: 132, height: 80 },
    props: [],
    style: styleOf('tone', 'stroke', 'strokeWidth', 'fontSize', 'align', 'opacity')
  },
  {
    name: 'text',
    description: 'A bare label with no frame or fill — for annotations and callouts.',
    defaultSize: DEFAULT_TEXT_SIZE,
    props: [],
    style: styleOf('tone', 'fontSize', 'align', 'opacity')
  },
  {
    name: 'image',
    description:
      'Renders an asset by relative path. props.src is "assets/<file>" — never a data URI; attach the bytes with the verb\'s images[] first.',
    defaultSize: { width: 240, height: 160 },
    props: ['src'],
    style: styleOf('opacity')
  }
] as const

/**
 * The registered HTML components (§5.2). v1 ships exactly ONE beyond the
 * built-ins, because one is enough to prove the mechanism and a catalog is
 * cheaper to grow than to shrink.
 */
export const CANVAS_HTML_SHAPES: readonly CanvasShapeSpec[] = [
  {
    name: 'harnu/mockup-card',
    description:
      'A titled card that renders a live Harnu component on the board — for a mockup or a deliverable summary.',
    defaultSize: { width: 260, height: 160 },
    props: ['title', 'subtitle', 'status', 'body'],
    style: styleOf()
  }
] as const

/** Built-ins + registered HTML shapes — the whole vocabulary, in ACK order. */
export const CANVAS_SHAPE_CATALOG: readonly CanvasShapeSpec[] = [
  ...CANVAS_BUILTIN_SHAPES,
  ...CANVAS_HTML_SHAPES
]

/**
 * Shape names a board carried before the rename, mapped to their current catalog
 * name. A document using one is still READ and validated; the catalog (and so every
 * ACK) only ever advertises the current names.
 */
export const LEGACY_CANVAS_SHAPE_NAMES: Readonly<Record<string, string>> = {
  'capy/mockup-card': 'harnu/mockup-card'
}

const BY_NAME: ReadonlyMap<string, CanvasShapeSpec> = new Map([
  ...CANVAS_SHAPE_CATALOG.map((s): [string, CanvasShapeSpec] => [s.name, s]),
  ...Object.entries(LEGACY_CANVAS_SHAPE_NAMES).flatMap(
    ([legacy, current]): [string, CanvasShapeSpec][] => {
      const spec = CANVAS_SHAPE_CATALOG.find((s) => s.name === current)
      return spec ? [[legacy, spec]] : []
    }
  )
])

/** The spec for `name`, or `undefined` when the name is not in the catalog. */
export function canvasShapeSpec(name: string): CanvasShapeSpec | undefined {
  return BY_NAME.get(name)
}

/** Every valid shape name, in catalog order — the set an `UNKNOWN_SHAPE`
 *  refusal lists so the failure is self-correcting rather than silent. */
export function canvasShapeNames(): string[] {
  return CANVAS_SHAPE_CATALOG.map((s) => s.name)
}
