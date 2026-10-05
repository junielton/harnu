import { DATA_DIR } from './data-dir'
import { MAX_MARKDOWN_BYTES } from './markdown-core'

/**
 * Pure core for the T218 canvas file seam (ADR-0001 pure-core / thin-shell).
 * Everything that decides — the suffix classification, the schema, the caps,
 * label normalization, validation and the stable serialization — lives here,
 * with NO filesystem and NO electron, so the confined reader
 * (`canvas-read.ts`), the confined writer (`canvas-write.ts`), the watcher
 * (`canvas-watch.ts`), the pane (U2/U3) and the `draw_canvas` MCP verb (U5)
 * can never disagree about what a canvas document is.
 *
 * Deliberately electron-free (it only imports the equally-pure
 * `markdown-core.ts` for the shared 2 MB cap): the U5 verb validator is a pure
 * module whose tests import it WITHOUT an Electron mock, so anything it
 * transitively pulls must stay pure. Containment needs `settings.ts` (which
 * imports electron) and therefore stays in `canvas-read.ts`, exactly as the
 * markdown quartet splits it.
 *
 * Contract source: `docs/specs/2026-08-23-t218-canvas-pane.md` §4.
 */

/**
 * Canvas files are named `<name>.harnucanvas.json` (§4.1). The DOUBLE extension
 * is load-bearing: `extname()` still returns `.json`, so nothing that already
 * classifies by extension changes behaviour — which is exactly why a canvas
 * classifier must match the SUFFIX rather than the extension (§4.1's
 * implementation trap; U4 AC-2 pins it).
 */
export const CANVAS_SUFFIX = '.harnucanvas.json'

/**
 * Suffixes boards carried before the rename. They are still READ (and a file with
 * one keeps its name when saved back); new boards are only ever written with
 * {@link CANVAS_SUFFIX}.
 */
export const LEGACY_CANVAS_SUFFIXES: readonly string[] = ['.capycanvas.json']

/** Every suffix that names a canvas file: the current one first, then the legacy ones. */
export const ALL_CANVAS_SUFFIXES: readonly string[] = [CANVAS_SUFFIX, ...LEGACY_CANVAS_SUFFIXES]

/** Default canvas file, relative to the worktree root (§4.2). */
export const CANVAS_DEFAULT_RELATIVE_PATH = `${DATA_DIR}/out/canvas/board.harnucanvas.json`

/** Directory holding externalised image bytes, relative to the canvas file (§4.6). */
export const CANVAS_ASSETS_DIRNAME = 'assets'

/**
 * The only `capycanvas` major this build understands. An unknown major is
 * REFUSED (`schema-unsupported`), never migrated silently (§4.3) — a silent
 * migration of a document written by a newer Harnu would destroy data the older
 * build cannot even name.
 */
export const CANVAS_SCHEMA_VERSION = 1

/**
 * Caps (§4.7). Exceeding one is a refusal with a machine-readable code, never
 * a truncation. The byte cap is `MAX_MARKDOWN_BYTES` REUSED on purpose: it is
 * the same "a giant file must not blow up the renderer" reason, and
 * externalising images (§4.6) is what makes 2 MB generous rather than tight.
 */
export const MAX_CANVAS_BYTES = MAX_MARKDOWN_BYTES
/** A ceiling no hand-built board approaches and a runaway verb call would. */
export const MAX_CANVAS_NODES = 2000
/** As above, for edges. */
export const MAX_CANVAS_EDGES = 2000
/** A label is a label. */
export const MAX_CANVAS_LABEL_CHARS = 2000

/**
 * Creation provenance (§4.4) — REQUIRED on every node and every edge. The pane
 * stamps `operator` on anything the operator creates; the MCP verb stamps
 * `agent` on anything it adds. Neither side may set the other's value, and a
 * node arriving WITHOUT an origin is a validation failure, not a defaulted one:
 * without the stamp an agent re-reading a canvas it previously drew on cannot
 * tell what the human added from what it drew last time, which is the entire
 * review loop.
 *
 * The stamp is creation provenance, NOT ownership. Either side may move,
 * relabel or delete any element; the stamp records who first put it there and
 * does not change when the other side edits it.
 */
export type CanvasOrigin = 'agent' | 'operator'

export interface CanvasNode {
  /** Stable, opaque, unique across nodes AND edges in one document. */
  id: string
  /** A built-in kind (§5.1) or a registered HTML shape name (`harnu/<name>`, §5.2). */
  shape: string
  /** World coordinates — finite numbers. */
  x: number
  y: number
  /** Optional size — finite and strictly positive when present. */
  width?: number
  height?: number
  /** Normalized on read (§4.5) — the single label everything above this sees. */
  label?: string
  origin: CanvasOrigin
  zIndex?: number
  /** Shape-specific, plain JSON only (§5.2 — no functions, no DOM, no class instances). */
  props?: Record<string, unknown>
}

export interface CanvasEdge {
  id: string
  /** Must resolve to a node id present in the SAME document (§4.3). */
  source: string
  target: string
  label?: string
  origin: CanvasOrigin
  router?: string
}

export interface CanvasMeta {
  title?: string
  createdAt?: string
  updatedAt?: string
  /** Unknown `meta` keys are preserved verbatim, same reason as {@link CanvasDocument.extra}. */
  [key: string]: unknown
}

export interface CanvasDocument {
  capycanvas: number
  meta: CanvasMeta
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  /**
   * Unknown TOP-LEVEL keys, preserved verbatim across a read/write round-trip
   * (§4.3), so a newer minor schema written by a newer Harnu is not destroyed by
   * an older build.
   *
   * They are kept AT the top level rather than hoisted into a container field,
   * so the in-memory document and the on-disk document are the SAME shape.
   * That makes validation idempotent — validating an already-validated document
   * is a no-op — which matters because the writer re-validates whatever the
   * renderer hands it, and a container field would have been re-read as just
   * another unknown key on the way back in, silently losing the extras.
   *
   * Unknown keys INSIDE a node or edge are deliberately NOT preserved: those
   * round-trip through X6, which normalizes them.
   */
  [key: string]: unknown
}

/** The four keys this schema knows. Everything else at the top level is an
 *  unknown key to be preserved (§4.3). */
export const CANVAS_KNOWN_TOP_LEVEL_KEYS = ['capycanvas', 'meta', 'nodes', 'edges'] as const

/** The unknown top-level keys carried by `doc` — the extras §4.3 promises to
 *  preserve. Exported so a caller can inspect them without re-deriving the
 *  known-key list. */
export function canvasExtraKeys(doc: CanvasDocument): string[] {
  return Object.keys(doc)
    .filter((k) => !(CANVAS_KNOWN_TOP_LEVEL_KEYS as readonly string[]).includes(k))
    .sort()
}

/**
 * Machine-readable denial reasons. Every refusal names one of these — a cap is
 * never silently truncated and a path is never silently clamped (§4.2, §4.7).
 * The renderer maps each to a localized steer, exactly as `MarkdownDenyCode` is
 * mapped today.
 */
export type CanvasDenyCode =
  | 'invalid-path'
  | 'outside-roots'
  | 'not-found'
  | 'too-large'
  | 'read-failed'
  | 'write-failed'
  | 'parse-failed'
  | 'schema-unsupported'
  | 'invalid-document'
  | 'missing-origin'
  | 'invalid-origin'
  | 'duplicate-id'
  | 'dangling-edge'
  | 'too-many-nodes'
  | 'too-many-edges'
  | 'label-too-long'

export interface CanvasValidateOk {
  ok: true
  doc: CanvasDocument
}
export interface CanvasValidateErr {
  ok: false
  code: CanvasDenyCode
  /** Human-readable detail naming the offending element — actionable, never just the code. */
  error: string
}
export type CanvasValidateResult = CanvasValidateOk | CanvasValidateErr

/**
 * Pure: does this path name a canvas file? Matches the SUFFIX (current or legacy)
 * `.harnucanvas.json` / `.capycanvas.json` case-insensitively — NOT `extname()`,
 * which yields a bare `.json` here and would misroute every ordinary JSON file in
 * a repo (§4.1).
 */
export function hasCanvasSuffix(p: string): boolean {
  if (typeof p !== 'string') return false
  const lower = p.toLowerCase()
  return ALL_CANVAS_SUFFIXES.some((s) => lower.endsWith(s))
}

/** A canvas file's name without its (current or legacy) double extension; `base` unchanged if it has neither. */
export function canvasStem(base: string): string {
  const lower = base.toLowerCase()
  const suffix = ALL_CANVAS_SUFFIXES.find((s) => lower.endsWith(s))
  return suffix ? base.slice(0, base.length - suffix.length) : base
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Label normalization (§4.5, spike trap 3) — REQUIRED in every canvas-file
 * reader, and the reason it lives in the pure core rather than in the pane or
 * the verb handler.
 *
 * In X6 a label given at node CREATION lands on `attrs.text.text`; a later
 * `node.attr('label/text', …)` writes `attrs.label.text` and **leaves the
 * original stale**. A reader that picks the wrong path reports the name a node
 * had BEFORE the human renamed it. That happened during the spike: the agent
 * misreported what the operator had named things — a confidently wrong read,
 * which is worse than no read.
 *
 * So the precedence is "most recently written path first":
 *
 *  1. `attrs.label.text` — written by the RENAME path, therefore the newest.
 *  2. `attrs.text.text` — written at creation, therefore possibly stale.
 *  3. the node's own top-level `label` — what OUR persisted schema carries
 *     (§4.3), used when the input has no X6 attrs at all.
 *
 * An empty string is a legitimate label (the operator cleared it) and wins over
 * a stale non-empty value at a lower-precedence path; only a missing/non-string
 * value falls through. Returns `undefined` when no path carries one.
 */
export function normalizeCanvasLabel(rawNode: unknown): string | undefined {
  if (!isPlainObject(rawNode)) return undefined
  const attrs = isPlainObject(rawNode.attrs) ? rawNode.attrs : undefined
  if (attrs) {
    const renamed = isPlainObject(attrs.label) ? attrs.label.text : undefined
    if (typeof renamed === 'string') return renamed
    const created = isPlainObject(attrs.text) ? attrs.text.text : undefined
    if (typeof created === 'string') return created
  }
  return typeof rawNode.label === 'string' ? rawNode.label : undefined
}

/**
 * The write half of §4.5: the normalized label is authoritative, and BOTH X6
 * attribute paths are set from it, so round-tripping a document through the
 * pane can never resurrect a stale name. Used by the pane (U2/U3) when it hands
 * a document to X6; kept here so the read and write halves of the same rule sit
 * next to each other.
 */
export function canvasLabelAttrs(label: string): {
  text: { text: string }
  label: { text: string }
} {
  return { text: { text: label }, label: { text: label } }
}

/** Recursive plain-JSON check for `props` (§4.3 / §5.2): no functions, no DOM
 *  nodes, no class instances, no `NaN`/`Infinity` — anything that would make
 *  `graph.toJSON()` throw or would not survive `JSON.stringify` round-tripping. */
function isPlainJson(v: unknown, depth = 0): boolean {
  if (depth > 32) return false
  if (v === null) return true
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(v)
    case 'object':
      break
    default:
      return false
  }
  if (Array.isArray(v)) return v.every((item) => isPlainJson(item, depth + 1))
  if (!isPlainObject(v)) return false
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
    return false
  }
  return Object.values(v).every((item) => isPlainJson(item, depth + 1))
}

function fail(code: CanvasDenyCode, error: string): CanvasValidateErr {
  return { ok: false, code, error }
}

/** Shared origin check for nodes and edges — a MISSING origin and an INVALID
 *  one are distinct machine-readable refusals, and neither is ever defaulted. */
function readOrigin(raw: Record<string, unknown>, what: string): CanvasOrigin | CanvasValidateErr {
  const origin = raw.origin
  if (origin === undefined || origin === null) {
    return fail('missing-origin', `${what} is missing the required "origin" stamp`)
  }
  if (origin !== 'agent' && origin !== 'operator') {
    return fail(
      'invalid-origin',
      `${what} has origin ${JSON.stringify(origin)}; expected "agent" or "operator"`
    )
  }
  return origin
}

function readLabel(value: unknown, what: string): { label?: string } | CanvasValidateErr {
  if (value === undefined) return {}
  if (typeof value !== 'string') return fail('invalid-document', `${what} has a non-string label`)
  if (value.length > MAX_CANVAS_LABEL_CHARS) {
    return fail(
      'label-too-long',
      `${what} label is ${value.length} chars; the cap is ${MAX_CANVAS_LABEL_CHARS}`
    )
  }
  return { label: value }
}

function isErr(v: unknown): v is CanvasValidateErr {
  return isPlainObject(v) && v.ok === false
}

/**
 * Validate an arbitrary parsed value as a canvas document (§4.3), returning the
 * NORMALIZED document (labels resolved per §4.5, unknown top-level keys
 * collected into `extra`) or the first machine-readable refusal.
 *
 * Every rule here is a refusal, never a repair:
 *  - an unknown `capycanvas` major is refused, not migrated;
 *  - a node or edge without an `origin` is refused, not defaulted;
 *  - a duplicate id (across nodes AND edges) is refused;
 *  - a dangling edge is refused, not silently dropped;
 *  - a cap is refused, not truncated.
 */
export function validateCanvasDocument(value: unknown): CanvasValidateResult {
  if (!isPlainObject(value))
    return fail('invalid-document', 'canvas document must be a JSON object')

  const version = value.capycanvas
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return fail('invalid-document', 'missing or non-integer "capycanvas" schema version')
  }
  if (version !== CANVAS_SCHEMA_VERSION) {
    return fail(
      'schema-unsupported',
      `canvas schema version ${version} is not supported by this build (expected ${CANVAS_SCHEMA_VERSION})`
    )
  }

  const rawMeta = value.meta === undefined ? {} : value.meta
  if (!isPlainObject(rawMeta)) return fail('invalid-document', '"meta" must be an object')
  for (const key of ['title', 'createdAt', 'updatedAt'] as const) {
    if (rawMeta[key] !== undefined && typeof rawMeta[key] !== 'string') {
      return fail('invalid-document', `meta.${key} must be a string`)
    }
  }
  if (!isPlainJson(rawMeta)) return fail('invalid-document', '"meta" must be plain JSON')

  const rawNodes = value.nodes === undefined ? [] : value.nodes
  if (!Array.isArray(rawNodes)) return fail('invalid-document', '"nodes" must be an array')
  if (rawNodes.length > MAX_CANVAS_NODES) {
    return fail(
      'too-many-nodes',
      `document has ${rawNodes.length} nodes; the cap is ${MAX_CANVAS_NODES}`
    )
  }
  const rawEdges = value.edges === undefined ? [] : value.edges
  if (!Array.isArray(rawEdges)) return fail('invalid-document', '"edges" must be an array')
  if (rawEdges.length > MAX_CANVAS_EDGES) {
    return fail(
      'too-many-edges',
      `document has ${rawEdges.length} edges; the cap is ${MAX_CANVAS_EDGES}`
    )
  }

  const ids = new Set<string>()
  const nodes: CanvasNode[] = []
  for (let i = 0; i < rawNodes.length; i++) {
    const raw = rawNodes[i]
    const at = `node #${i}`
    if (!isPlainObject(raw)) return fail('invalid-document', `${at} must be an object`)
    const id = raw.id
    if (typeof id !== 'string' || id.length === 0) {
      return fail('invalid-document', `${at} is missing a non-empty string "id"`)
    }
    if (ids.has(id)) return fail('duplicate-id', `id ${JSON.stringify(id)} appears more than once`)
    ids.add(id)
    const what = `node ${JSON.stringify(id)}`

    const shape = raw.shape
    if (typeof shape !== 'string' || shape.length === 0) {
      return fail('invalid-document', `${what} is missing a non-empty string "shape"`)
    }
    for (const axis of ['x', 'y'] as const) {
      if (typeof raw[axis] !== 'number' || !Number.isFinite(raw[axis])) {
        return fail('invalid-document', `${what} has a non-finite "${axis}"`)
      }
    }
    for (const dim of ['width', 'height'] as const) {
      const v = raw[dim]
      if (v === undefined) continue
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        return fail('invalid-document', `${what} has a non-finite or non-positive "${dim}"`)
      }
    }
    if (
      raw.zIndex !== undefined &&
      (typeof raw.zIndex !== 'number' || !Number.isFinite(raw.zIndex))
    ) {
      return fail('invalid-document', `${what} has a non-finite "zIndex"`)
    }
    if (raw.props !== undefined && (!isPlainObject(raw.props) || !isPlainJson(raw.props))) {
      return fail('invalid-document', `${what} has "props" that are not plain JSON`)
    }

    const origin = readOrigin(raw, what)
    if (isErr(origin)) return origin

    // §4.5: resolve the label ONCE, here, across both X6 attribute paths and the
    // persisted top-level field — so nothing above this ever sees a stale name.
    const label = readLabel(normalizeCanvasLabel(raw), what)
    if (isErr(label)) return label

    nodes.push({
      id,
      shape,
      x: raw.x as number,
      y: raw.y as number,
      ...(raw.width === undefined ? {} : { width: raw.width as number }),
      ...(raw.height === undefined ? {} : { height: raw.height as number }),
      ...label,
      origin,
      ...(raw.zIndex === undefined ? {} : { zIndex: raw.zIndex as number }),
      ...(raw.props === undefined ? {} : { props: raw.props as Record<string, unknown> })
    })
  }

  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges: CanvasEdge[] = []
  for (let i = 0; i < rawEdges.length; i++) {
    const raw = rawEdges[i]
    const at = `edge #${i}`
    if (!isPlainObject(raw)) return fail('invalid-document', `${at} must be an object`)
    const id = raw.id
    if (typeof id !== 'string' || id.length === 0) {
      return fail('invalid-document', `${at} is missing a non-empty string "id"`)
    }
    if (ids.has(id)) return fail('duplicate-id', `id ${JSON.stringify(id)} appears more than once`)
    ids.add(id)
    const what = `edge ${JSON.stringify(id)}`

    for (const end of ['source', 'target'] as const) {
      const v = raw[end]
      if (typeof v !== 'string' || v.length === 0) {
        return fail('invalid-document', `${what} is missing a non-empty string "${end}"`)
      }
      // §4.3: a dangling edge is a validation failure, NOT a silently-dropped
      // edge — dropping it would make the file quietly disagree with what the
      // author wrote, which is the class of bug the origin stamp exists to avoid.
      if (!nodeIds.has(v)) {
        return fail(
          'dangling-edge',
          `${what} ${end} ${JSON.stringify(v)} is not a node in this document`
        )
      }
    }
    if (raw.router !== undefined && typeof raw.router !== 'string') {
      return fail('invalid-document', `${what} has a non-string "router"`)
    }

    const origin = readOrigin(raw, what)
    if (isErr(origin)) return origin
    const label = readLabel(raw.label, what)
    if (isErr(label)) return label

    edges.push({
      id,
      source: raw.source as string,
      target: raw.target as string,
      ...label,
      origin,
      ...(raw.router === undefined ? {} : { router: raw.router as string })
    })
  }

  const extra: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    if ((CANVAS_KNOWN_TOP_LEVEL_KEYS as readonly string[]).includes(key)) continue
    if (!isPlainJson(v)) {
      return fail('invalid-document', `top-level key ${JSON.stringify(key)} is not plain JSON`)
    }
    extra[key] = v
  }

  return {
    ok: true,
    doc: { ...extra, capycanvas: version, meta: rawMeta as CanvasMeta, nodes, edges }
  }
}

/** Known `meta` keys, written first and in this order (§4.1: a stable key order
 *  so a Save produces a minimal diff). */
const META_KEY_ORDER = ['title', 'createdAt', 'updatedAt'] as const

function orderedMeta(meta: CanvasMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of META_KEY_ORDER) if (meta[key] !== undefined) out[key] = meta[key]
  for (const key of Object.keys(meta).sort()) {
    if ((META_KEY_ORDER as readonly string[]).includes(key)) continue
    out[key] = meta[key]
  }
  return out
}

function orderedNode(node: CanvasNode): Record<string, unknown> {
  const out: Record<string, unknown> = { id: node.id, shape: node.shape, x: node.x, y: node.y }
  if (node.width !== undefined) out.width = node.width
  if (node.height !== undefined) out.height = node.height
  if (node.label !== undefined) out.label = node.label
  out.origin = node.origin
  if (node.zIndex !== undefined) out.zIndex = node.zIndex
  if (node.props !== undefined) out.props = node.props
  return out
}

function orderedEdge(edge: CanvasEdge): Record<string, unknown> {
  const out: Record<string, unknown> = { id: edge.id, source: edge.source, target: edge.target }
  if (edge.label !== undefined) out.label = edge.label
  out.origin = edge.origin
  if (edge.router !== undefined) out.router = edge.router
  return out
}

/**
 * Serialize to the on-disk form (§4.1): UTF-8, LF, 2-space indent, a stable key
 * order at every level, and a trailing newline. Deterministic by construction —
 * serializing the same document twice yields byte-identical output, which is
 * what makes repeated Saves produce an empty diff (U3 AC-5) and what U1 AC-1's
 * round-trip actually pins.
 *
 * Unknown top-level keys are written LAST, sorted, so their presence can never
 * reorder the four keys a human reads first.
 */
export function serializeCanvasDocument(doc: CanvasDocument): string {
  const out: Record<string, unknown> = {
    capycanvas: doc.capycanvas,
    meta: orderedMeta(doc.meta),
    nodes: doc.nodes.map(orderedNode),
    edges: doc.edges.map(orderedEdge)
  }
  for (const key of canvasExtraKeys(doc)) out[key] = doc[key]
  return `${JSON.stringify(out, null, 2)}\n`
}

/**
 * Parse + validate UTF-8 canvas text. A malformed JSON body refuses with
 * `parse-failed` rather than throwing, so every caller handles one envelope.
 */
export function parseCanvasDocument(text: string): CanvasValidateResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return fail('parse-failed', `canvas file is not valid JSON: ${(err as Error).message}`)
  }
  return validateCanvasDocument(parsed)
}

/**
 * A valid empty document. `nowIso` is passed IN rather than read from the clock
 * so this stays pure (and so tests are deterministic).
 */
export function emptyCanvasDocument(nowIso: string, title?: string): CanvasDocument {
  return {
    capycanvas: CANVAS_SCHEMA_VERSION,
    meta: { ...(title === undefined ? {} : { title }), createdAt: nowIso, updatedAt: nowIso },
    nodes: [],
    edges: []
  }
}
