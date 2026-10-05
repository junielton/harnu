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
 *  3. `docs/harnu-features.md` says the catalog is discoverable from the ACK —
 *     it deliberately does NOT enumerate the shapes, because this list changes
 *     with the code and a doc that drifts is worse than one that points.
 */

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
}

/**
 * Fallback size for a framed node, and for a bare `text` node.
 *
 * These MIRROR `canvas-cells.ts`'s `DEFAULT_NODE_SIZE` / `DEFAULT_TEXT_SIZE`
 * rather than importing them: that module pulls the palette/port types the
 * pane needs, and this manifest must stay importable from `src/main`. The
 * duplication is pinned by a drift test (`tests/mcp-canvas-ops.test.ts`), so
 * the two cannot silently disagree about how big an un-sized node is.
 */
const DEFAULT_FRAMED_SIZE = { width: 132, height: 52 } as const
const DEFAULT_TEXT_SIZE = { width: 160, height: 24 } as const

/**
 * The four built-in kinds of §5.1. `frame`/container is deliberately absent —
 * deferred to v2 because X6's `embedding` was never exercised in the spike.
 */
export const CANVAS_BUILTIN_SHAPES: readonly CanvasShapeSpec[] = [
  {
    name: 'box',
    description: 'Rounded rectangle with a centred label. The default.',
    defaultSize: DEFAULT_FRAMED_SIZE,
    props: []
  },
  {
    name: 'text',
    description: 'A bare label with no frame or fill — for annotations and callouts.',
    defaultSize: DEFAULT_TEXT_SIZE,
    props: []
  },
  {
    name: 'image',
    description:
      'Renders an asset by relative path. props.src is "assets/<file>" — never a data URI; attach the bytes with the verb\'s images[] first.',
    defaultSize: { width: 240, height: 160 },
    props: ['src']
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
    props: ['title', 'subtitle', 'status', 'body']
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
