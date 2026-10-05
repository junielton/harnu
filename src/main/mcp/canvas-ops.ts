/**
 * The PURE half of the `draw_canvas` MCP verb (T218 U5, spec §8) — path
 * containment (§8.3 rule 2), op application (§8.2) and every validation rule
 * that does not need the disk (§8.3 rules 2, 4–10). Framework-free and
 * side-effect-free per ADR-0001, so it lands in the coverage surface while the
 * handler in `tool-handlers.ts` (Electron/fs, coverage-excluded) stays a thin
 * shell that only reads, calls this, copies bytes and writes.
 *
 * THE ONE RULE THIS MODULE OBEYS: it never re-implements a rule U1 already
 * owns. `validateCanvasDocument` (`canvas-core.ts`) is the authority on what a
 * document is — origin stamps, duplicate ids, dangling edges, label length,
 * node/edge caps — and this module runs it over the RESULT of the ops as its
 * final gate, mapping its `CanvasDenyCode` to the verb's uppercase code. Only
 * the rules that are new to the VERB live here:
 *
 *  - rule 2  path containment for what an AGENT may write (the reader is
 *            deliberately broader — see `canvas-read.ts`'s module doc);
 *  - rule 4  1..200 ops;
 *  - rule 5  shape names, refused BY NAME listing the valid set;
 *  - rule 6  `props` keys must be declared by the shape's manifest entry;
 *  - rule 7  geometry, checked per-op so the refusal names which op;
 *  - rule 8  referential integrity AS THE DOCUMENT STANDS after the preceding
 *            ops in the same call;
 *  - rule 9  a caller-supplied `origin` is REFUSED, never overwritten.
 *
 * NO PARTIAL APPLY (§8.3): everything here works on a CLONE. A failure returns
 * a refusal and the clone is dropped, so the caller has nothing to write and
 * the file on disk is byte-identical to what it was. That is the property the
 * whole verb exists to protect: a batch of 20 ops whose 17th is invalid must
 * leave the document exactly as it was, not 16 ops applied.
 */

import * as path from 'node:path'
import { DATA_DIR, dataDir } from '../data-dir'
import {
  CANVAS_SUFFIX,
  canvasStem,
  hasCanvasSuffix,
  validateCanvasDocument,
  type CanvasDenyCode,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasNode
} from '../canvas-core'
import {
  CANVAS_SHAPE_CATALOG,
  canvasShapeNames,
  canvasShapeSpec,
  type CanvasShapeSpec
} from './canvas-shapes'
import { buildCardAssetFilename, resolveCardAssetSource } from '../roadmap-core'

/** Max ops in a single call (§4.7 / §8.3 rule 4). Over or empty: `BAD_ARGS`. */
export const MAX_CANVAS_OPS_PER_CALL = 200
/** Max image sources externalised per call (§4.6 — the board's cap, verbatim). */
export const MAX_CANVAS_IMAGES_PER_CALL = 6

/** The seven ops of §8.2, in table order. */
export const CANVAS_OP_NAMES = [
  'add_node',
  'add_edge',
  'update_node',
  'update_edge',
  'remove_node',
  'remove_edge',
  'clear'
] as const
export type CanvasOpName = (typeof CANVAS_OP_NAMES)[number]

/**
 * Machine-readable refusals. `PATH_NOT_ALLOWED`, `SCHEMA_UNSUPPORTED`,
 * `BAD_ARGS`, `UNKNOWN_SHAPE` and `UNKNOWN_ID` are the codes §8.3 names
 * explicitly; the rest name the rules §8.3 states without spelling a code, and
 * are documented in `docs/harnu-features.md` so an agent never has to guess one.
 */
export type CanvasVerbCode =
  | 'BAD_ARGS'
  | 'PATH_NOT_ALLOWED'
  | 'SCHEMA_UNSUPPORTED'
  | 'UNKNOWN_SHAPE'
  | 'UNKNOWN_ID'
  | 'ORIGIN_NOT_ALLOWED'
  | 'BAD_PROPS'
  | 'BAD_GEOMETRY'
  | 'LABEL_TOO_LONG'
  | 'TOO_MANY_NODES'
  | 'TOO_MANY_EDGES'
  | 'DUPLICATE_ID'
  | 'DANGLING_EDGE'
  | 'INVALID_DOCUMENT'
  | 'TOO_LARGE'
  | 'PARSE_FAILED'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'NOT_FOUND'
  | 'ID_MINT_FAILED'
  | 'SOURCE_NOT_IMAGE'
  | 'SOURCE_NOT_ALLOWED'

/**
 * U1's document-level codes → the verb's. Kept as one exhaustive table so a
 * new `CanvasDenyCode` in the pure core is a TYPE ERROR here rather than an
 * unmapped refusal the agent cannot act on.
 */
const CORE_CODE_TO_VERB: Record<CanvasDenyCode, CanvasVerbCode> = {
  'invalid-path': 'PATH_NOT_ALLOWED',
  'outside-roots': 'PATH_NOT_ALLOWED',
  'not-found': 'NOT_FOUND',
  'too-large': 'TOO_LARGE',
  'read-failed': 'READ_FAILED',
  'write-failed': 'WRITE_FAILED',
  'parse-failed': 'PARSE_FAILED',
  'schema-unsupported': 'SCHEMA_UNSUPPORTED',
  'invalid-document': 'INVALID_DOCUMENT',
  // A document that reaches disk without an origin stamp is an INVALID DOCUMENT,
  // not the caller-supplied-origin refusal — that one (rule 9) is raised per-op,
  // before anything is applied, and carries its own code.
  'missing-origin': 'INVALID_DOCUMENT',
  'invalid-origin': 'INVALID_DOCUMENT',
  'duplicate-id': 'DUPLICATE_ID',
  'dangling-edge': 'DANGLING_EDGE',
  'too-many-nodes': 'TOO_MANY_NODES',
  'too-many-edges': 'TOO_MANY_EDGES',
  'label-too-long': 'LABEL_TOO_LONG'
}

/** Translate a `canvas-core` refusal into the verb's code. */
export function canvasVerbCode(code: CanvasDenyCode): CanvasVerbCode {
  return CORE_CODE_TO_VERB[code]
}

export interface CanvasVerbErr {
  ok: false
  code: CanvasVerbCode
  error: string
}

function deny(code: CanvasVerbCode, error: string): CanvasVerbErr {
  return { ok: false, code, error }
}

// ---- rule 2: where an agent may write -------------------------------------

/**
 * The two directories §4.2 lets the VERB write to, relative to the folder root.
 * `.harnu/out/canvas/` is the gitignored per-worktree scratch board (the
 * default); `docs/canvas/` is the tracked home for a diagram that is itself a
 * deliverable. Anything else is `PATH_NOT_ALLOWED` — never clamped into one of
 * these, because silently redirecting a write is how an agent ends up believing
 * it drew somewhere it did not.
 */
export const CANVAS_WRITE_DIRS = [`${DATA_DIR}/out/canvas`, 'docs/canvas'] as const

/** Default canvas for a folder: `<folder>/.harnu/out/canvas/board.harnucanvas.json`. */
export function defaultCanvasPath(folder: string): string {
  return path.join(dataDir(folder), 'out', 'canvas', 'board.harnucanvas.json')
}

export type CanvasPathResult = { ok: true; path: string; name: string } | CanvasVerbErr

/**
 * Resolve + confine the verb's target path (§8.3 rule 2). It must resolve
 * INSIDE `folder`, end in `.harnucanvas.json` (or the legacy `.capycanvas.json`), and sit under one of
 * {@link CANVAS_WRITE_DIRS}. `name` is the file's basename without the double
 * extension — the stem the server generates asset filenames from (§4.6).
 *
 * A relative `rawPath` resolves against `folder`; the FINAL resolved path is
 * what gets confined, so neither a `..` chain nor an absolute re-root escapes.
 */
export function resolveCanvasWritePath(folder: string, rawPath?: string): CanvasPathResult {
  if (typeof folder !== 'string' || folder.length === 0) {
    return deny('BAD_ARGS', 'folder is required')
  }
  const root = path.resolve(folder)
  const target = rawPath === undefined ? defaultCanvasPath(root) : path.resolve(root, rawPath)

  if (!hasCanvasSuffix(target)) {
    return deny('PATH_NOT_ALLOWED', `path must end in ${CANVAS_SUFFIX}`)
  }
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return deny('PATH_NOT_ALLOWED', 'path must resolve inside the folder')
  }
  const relPosix = rel.split(path.sep).join('/')
  const allowed = CANVAS_WRITE_DIRS.some((dir) => relPosix.startsWith(`${dir}/`))
  if (!allowed) {
    return deny(
      'PATH_NOT_ALLOWED',
      `a canvas the agent writes must live under ${CANVAS_WRITE_DIRS.join('/ or ')}/ — got "${relPosix}"`
    )
  }
  const base = path.basename(target)
  return { ok: true, path: target, name: canvasStem(base) }
}

/** The `assets/` directory that belongs to `canvasPath` (§4.6). */
export function canvasAssetsDir(canvasPath: string): string {
  return path.join(path.dirname(canvasPath), 'assets')
}

// ---- rule 11: image sources ------------------------------------------------

export interface PlannedCanvasAsset {
  /** The validated absolute source to copy FROM. */
  source: string
  /** Lowercased extension, from the source. */
  ext: string
  /** Set when the source matched the Claude tmp images root — the shell must realpath-confirm it before reading. */
  tmpRoot?: string
  /** The raw string the caller supplied — echoed in refusals only. */
  raw: string
  /** First-choice server-generated filename; the shell retries the index on `EEXIST`. */
  filename: string
}
export type PlanCanvasAssetsResult = { ok: true; assets: PlannedCanvasAsset[] } | CanvasVerbErr

/**
 * Validate EVERY image source before the shell copies ANY of them (§4.6 — no
 * partial attach on disk), reusing the board's own source jail verbatim
 * (`resolveCardAssetSource`): a source must be under `~/.claude/image-cache/`,
 * exactly `<tmpRoot>/<slug>/<uuid>/images/<n>.png` (BUG-149), or inside the
 * folder, and must look like an image. The destination filename
 * is always server-generated (`<canvasName>-<n><ext>`), never the caller's
 * path — that asymmetry is what makes an unrestricted-read escape impossible
 * for an MCP-only session with no `Read` tool of its own.
 *
 * Existence and per-file size need `fs` and stay in the shell.
 */
export function planCanvasAssets(
  canvasName: string,
  rawImages: readonly unknown[],
  homeDir: string,
  folder: string,
  tmpRoot?: string | null
): PlanCanvasAssetsResult {
  if (rawImages.length > MAX_CANVAS_IMAGES_PER_CALL) {
    return deny('BAD_ARGS', `at most ${MAX_CANVAS_IMAGES_PER_CALL} images per call`)
  }
  const assets: PlannedCanvasAsset[] = []
  for (let i = 0; i < rawImages.length; i++) {
    const raw = rawImages[i]
    if (typeof raw !== 'string' || raw.length === 0) {
      return deny('BAD_ARGS', `images[${i}] must be a non-empty absolute path`)
    }
    const src = resolveCardAssetSource(raw, homeDir, folder, tmpRoot)
    if (!src.ok) {
      return src.code === 'SOURCE_NOT_IMAGE'
        ? deny(
            'SOURCE_NOT_IMAGE',
            `image "${raw}" is not a recognized image type (png/jpg/jpeg/gif/webp/bmp/svg/ico)`
          )
        : deny(
            'SOURCE_NOT_ALLOWED',
            `image "${raw}" must be under ~/.claude/image-cache/, a Claude <tmpdir>/claude-<uid>/<slug>/<session>/images/<n>.png, or inside this folder — a path elsewhere on the machine is refused`
          )
    }
    assets.push({
      source: src.path,
      ext: src.ext,
      raw,
      ...(src.tmpRoot ? { tmpRoot: src.tmpRoot } : {}),
      filename: buildCardAssetFilename(canvasName, i + 1, src.ext)
    })
  }
  return { ok: true, assets }
}

// ---- op application --------------------------------------------------------

/** What one applied op did — the ACK's `applied` array, in call order. */
export interface AppliedCanvasOp {
  op: CanvasOpName
  /** The id assigned by `add_node`/`add_edge`, or the id the op targeted. */
  id?: string
  /** Ids of edges removed as a CASCADE (never named by the caller). */
  cascadedEdges?: string[]
  /** `clear` only: how much of the agent's own drawing was removed. */
  removedNodes?: number
  removedEdges?: number
}

export type ApplyCanvasOpsResult =
  { ok: true; doc: CanvasDocument; applied: AppliedCanvasOp[] } | CanvasVerbErr

/** Mint a candidate id. `attempt` starts at 0 and rises only on a collision,
 *  so a deterministic test generator is a one-liner. */
export type CanvasIdMinter = (prefix: 'n' | 'e', attempt: number) => string

export interface ApplyCanvasOpsInput {
  /** The document as it stands on disk (or a fresh empty one). Never mutated. */
  doc: CanvasDocument
  /** The caller's raw, untrusted ops. */
  ops: unknown
  /** Assigns ids for `add_node`/`add_edge`. */
  mintId: CanvasIdMinter
  /** Overridable for tests; defaults to the real catalog. */
  shapes?: readonly CanvasShapeSpec[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The keys each op declares. Anything else on the op object is `BAD_ARGS` —
 *  a typo'd field must not be silently ignored, or the agent believes it set
 *  something it did not. */
const OP_KEYS: Record<CanvasOpName, readonly string[]> = {
  add_node: ['op', 'shape', 'x', 'y', 'width', 'height', 'label', 'props'],
  add_edge: ['op', 'source', 'target', 'label', 'router'],
  update_node: ['op', 'id', 'x', 'y', 'width', 'height', 'label', 'props'],
  update_edge: ['op', 'id', 'label', 'router'],
  remove_node: ['op', 'id'],
  remove_edge: ['op', 'id'],
  clear: ['op']
}

function isCanvasOpName(v: unknown): v is CanvasOpName {
  return typeof v === 'string' && (CANVAS_OP_NAMES as readonly string[]).includes(v)
}

/** §8.3 rule 7 — the SAME predicate `canvas-core` applies to a whole document,
 *  raised per-op so the refusal names which op is wrong. */
function checkGeometry(raw: Record<string, unknown>, at: string): CanvasVerbErr | undefined {
  for (const axis of ['x', 'y'] as const) {
    const v = raw[axis]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return deny('BAD_GEOMETRY', `${at}: "${axis}" must be a finite number`)
    }
  }
  for (const dim of ['width', 'height'] as const) {
    const v = raw[dim]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      return deny('BAD_GEOMETRY', `${at}: "${dim}" must be a finite number greater than 0`)
    }
  }
  return undefined
}

/** §8.3 rule 6 — only the keys the shape's manifest entry declares. */
function checkProps(
  spec: CanvasShapeSpec,
  props: unknown,
  at: string
): { props: Record<string, unknown> } | CanvasVerbErr {
  if (!isRecord(props)) return deny('BAD_PROPS', `${at}: "props" must be an object`)
  const undeclared = Object.keys(props).filter((k) => !spec.props.includes(k))
  if (undeclared.length > 0) {
    return deny(
      'BAD_PROPS',
      `${at}: shape "${spec.name}" does not declare prop${undeclared.length === 1 ? '' : 's'} ${undeclared
        .map((k) => JSON.stringify(k))
        .join(', ')} — it reads ${spec.props.length === 0 ? 'no props' : spec.props.join(', ')}`
    )
  }
  return { props }
}

function isErr(v: unknown): v is CanvasVerbErr {
  return isRecord(v) && v.ok === false
}

/**
 * Apply `ops` to `doc`, IN ORDER, all-or-nothing (§8.2, §8.3).
 *
 * Everything the verb creates is stamped `origin: "agent"` SERVER-SIDE, and a
 * caller-supplied `origin` is refused rather than overwritten (§4.4, rule 9):
 * an agent that can claim `"operator"` can launder its own output as human
 * feedback, and that distinction is the entire review loop.
 *
 * Referential integrity (rule 8) is checked against the document AS IT STANDS
 * after the preceding ops in the same call — so `add_node` then `add_edge` to
 * the id it just minted works, and `remove_node` then `update_node` on the same
 * id is `UNKNOWN_ID`.
 */
export function applyCanvasOps(input: ApplyCanvasOpsInput): ApplyCanvasOpsResult {
  const { doc, ops: rawOps, mintId } = input
  const shapes = input.shapes ?? CANVAS_SHAPE_CATALOG
  const shapeNames = shapes.map((s) => s.name)
  const specFor = (name: string): CanvasShapeSpec | undefined =>
    input.shapes ? input.shapes.find((s) => s.name === name) : canvasShapeSpec(name)

  if (!Array.isArray(rawOps)) return deny('BAD_ARGS', 'ops must be an array')
  if (rawOps.length === 0) return deny('BAD_ARGS', 'ops must contain at least one op')
  if (rawOps.length > MAX_CANVAS_OPS_PER_CALL) {
    return deny(
      'BAD_ARGS',
      `${rawOps.length} ops exceeds the cap of ${MAX_CANVAS_OPS_PER_CALL} per call`
    )
  }

  // The CLONE is what makes "no partial apply" structural rather than a
  // discipline: every mutation below lands here, and a refusal drops it.
  const nodes: CanvasNode[] = doc.nodes.map((n) => ({ ...n }))
  const edges: CanvasEdge[] = doc.edges.map((e) => ({ ...e }))
  const usedIds = new Set<string>([...nodes.map((n) => n.id), ...edges.map((e) => e.id)])

  const nextId = (prefix: 'n' | 'e'): string | CanvasVerbErr => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const candidate = mintId(prefix, attempt)
      if (typeof candidate === 'string' && candidate.length > 0 && !usedIds.has(candidate)) {
        usedIds.add(candidate)
        return candidate
      }
    }
    return deny('ID_MINT_FAILED', 'could not mint a unique id')
  }

  const applied: AppliedCanvasOp[] = []

  for (let i = 0; i < rawOps.length; i++) {
    const raw = rawOps[i]
    const at = `ops[${i}]`
    if (!isRecord(raw)) return deny('BAD_ARGS', `${at} must be an object`)
    const name = raw.op
    if (!isCanvasOpName(name)) {
      return deny(
        'BAD_ARGS',
        `${at}: unknown op ${JSON.stringify(name)} — expected one of ${CANVAS_OP_NAMES.join(', ')}`
      )
    }
    // Rule 9 FIRST, and on every op: the refusal must name the real reason
    // rather than the generic "undeclared key" one it would otherwise hit.
    if ('origin' in raw) {
      return deny(
        'ORIGIN_NOT_ALLOWED',
        `${at}: "origin" is stamped by the server — this verb always writes origin "agent", and a caller-supplied origin is refused rather than overwritten`
      )
    }
    const declared = OP_KEYS[name]
    const stray = Object.keys(raw).filter((k) => !declared.includes(k))
    if (stray.length > 0) {
      return deny(
        'BAD_ARGS',
        `${at}: ${name} does not take ${stray.map((k) => JSON.stringify(k)).join(', ')} — it takes ${declared.join(', ')}`
      )
    }

    switch (name) {
      case 'add_node': {
        const shape = raw.shape
        if (typeof shape !== 'string' || shape.length === 0) {
          return deny('BAD_ARGS', `${at}: add_node requires a "shape"`)
        }
        const spec = specFor(shape)
        if (!spec) {
          // Rule 5: refused BY NAME, LISTING the valid set — a self-correcting
          // failure rather than a silent one.
          return deny(
            'UNKNOWN_SHAPE',
            `${at}: unknown shape ${JSON.stringify(shape)} — valid shapes are ${shapeNames.join(', ')}`
          )
        }
        for (const axis of ['x', 'y'] as const) {
          if (raw[axis] === undefined) {
            return deny('BAD_ARGS', `${at}: add_node requires "${axis}"`)
          }
        }
        const geo = checkGeometry(raw, at)
        if (geo) return geo
        if (raw.label !== undefined && typeof raw.label !== 'string') {
          return deny('BAD_ARGS', `${at}: "label" must be a string`)
        }
        let props: Record<string, unknown> | undefined
        if (raw.props !== undefined) {
          const checked = checkProps(spec, raw.props, at)
          if (isErr(checked)) return checked
          props = checked.props
        }
        const id = nextId('n')
        if (isErr(id)) return id
        nodes.push({
          id,
          shape,
          x: raw.x as number,
          y: raw.y as number,
          width: (raw.width as number | undefined) ?? spec.defaultSize.width,
          height: (raw.height as number | undefined) ?? spec.defaultSize.height,
          ...(raw.label === undefined ? {} : { label: raw.label as string }),
          origin: 'agent',
          ...(props === undefined ? {} : { props })
        })
        applied.push({ op: name, id })
        break
      }

      case 'add_edge': {
        for (const end of ['source', 'target'] as const) {
          const v = raw[end]
          if (typeof v !== 'string' || v.length === 0) {
            return deny('BAD_ARGS', `${at}: add_edge requires a "${end}"`)
          }
          // Rule 8, against the document AS IT STANDS after the preceding ops.
          if (!nodes.some((n) => n.id === v)) {
            return deny('UNKNOWN_ID', `${at}: ${end} ${JSON.stringify(v)} is not a node right now`)
          }
        }
        if (raw.label !== undefined && typeof raw.label !== 'string') {
          return deny('BAD_ARGS', `${at}: "label" must be a string`)
        }
        if (raw.router !== undefined && typeof raw.router !== 'string') {
          return deny('BAD_ARGS', `${at}: "router" must be a string`)
        }
        const id = nextId('e')
        if (isErr(id)) return id
        edges.push({
          id,
          source: raw.source as string,
          target: raw.target as string,
          ...(raw.label === undefined ? {} : { label: raw.label as string }),
          origin: 'agent',
          ...(raw.router === undefined ? {} : { router: raw.router as string })
        })
        applied.push({ op: name, id })
        break
      }

      case 'update_node': {
        const id = raw.id
        if (typeof id !== 'string' || id.length === 0) {
          return deny('BAD_ARGS', `${at}: update_node requires an "id"`)
        }
        const idx = nodes.findIndex((n) => n.id === id)
        if (idx < 0) return deny('UNKNOWN_ID', `${at}: no node ${JSON.stringify(id)}`)
        const touched = ['x', 'y', 'width', 'height', 'label', 'props'].filter(
          (k) => raw[k] !== undefined
        )
        if (touched.length === 0) {
          return deny('BAD_ARGS', `${at}: update_node needs at least one field to change`)
        }
        const geo = checkGeometry(raw, at)
        if (geo) return geo
        if (raw.label !== undefined && typeof raw.label !== 'string') {
          return deny('BAD_ARGS', `${at}: "label" must be a string`)
        }
        const node = nodes[idx]
        let props: Record<string, unknown> | undefined
        if (raw.props !== undefined) {
          // Validated against the node's OWN shape — a node keeps its shape for
          // life; there is no `shape` field on `update_node` by design (§8.2).
          const spec = specFor(node.shape)
          if (!spec) {
            return deny(
              'UNKNOWN_SHAPE',
              `${at}: node ${JSON.stringify(id)} has unknown shape ${JSON.stringify(node.shape)} — valid shapes are ${shapeNames.join(', ')}`
            )
          }
          const checked = checkProps(spec, raw.props, at)
          if (isErr(checked)) return checked
          props = checked.props
        }
        // `props` REPLACES rather than merges: a merge has no way to express
        // "remove this key", and a silent merge is how stale props outlive the
        // shape that read them.
        nodes[idx] = {
          ...node,
          ...(raw.x === undefined ? {} : { x: raw.x as number }),
          ...(raw.y === undefined ? {} : { y: raw.y as number }),
          ...(raw.width === undefined ? {} : { width: raw.width as number }),
          ...(raw.height === undefined ? {} : { height: raw.height as number }),
          ...(raw.label === undefined ? {} : { label: raw.label as string }),
          ...(props === undefined ? {} : { props })
        }
        applied.push({ op: name, id })
        break
      }

      case 'update_edge': {
        const id = raw.id
        if (typeof id !== 'string' || id.length === 0) {
          return deny('BAD_ARGS', `${at}: update_edge requires an "id"`)
        }
        const idx = edges.findIndex((e) => e.id === id)
        if (idx < 0) return deny('UNKNOWN_ID', `${at}: no edge ${JSON.stringify(id)}`)
        const touched = ['label', 'router'].filter((k) => raw[k] !== undefined)
        if (touched.length === 0) {
          return deny('BAD_ARGS', `${at}: update_edge needs at least one field to change`)
        }
        for (const key of ['label', 'router'] as const) {
          if (raw[key] !== undefined && typeof raw[key] !== 'string') {
            return deny('BAD_ARGS', `${at}: "${key}" must be a string`)
          }
        }
        edges[idx] = {
          ...edges[idx],
          ...(raw.label === undefined ? {} : { label: raw.label as string }),
          ...(raw.router === undefined ? {} : { router: raw.router as string })
        }
        applied.push({ op: name, id })
        break
      }

      case 'remove_node': {
        const id = raw.id
        if (typeof id !== 'string' || id.length === 0) {
          return deny('BAD_ARGS', `${at}: remove_node requires an "id"`)
        }
        const idx = nodes.findIndex((n) => n.id === id)
        if (idx < 0) return deny('UNKNOWN_ID', `${at}: no node ${JSON.stringify(id)}`)
        nodes.splice(idx, 1)
        // CASCADE (§8.2): every edge touching the node goes with it, whatever
        // its origin. An edge cannot outlive its endpoint — a dangling edge is
        // a validation failure (§4.3), so "keep the operator's edge" is not an
        // option the schema offers.
        const cascadedEdges: string[] = []
        for (let e = edges.length - 1; e >= 0; e--) {
          if (edges[e].source === id || edges[e].target === id) {
            cascadedEdges.unshift(edges[e].id)
            edges.splice(e, 1)
          }
        }
        applied.push({ op: name, id, cascadedEdges })
        break
      }

      case 'remove_edge': {
        const id = raw.id
        if (typeof id !== 'string' || id.length === 0) {
          return deny('BAD_ARGS', `${at}: remove_edge requires an "id"`)
        }
        const idx = edges.findIndex((e) => e.id === id)
        if (idx < 0) return deny('UNKNOWN_ID', `${at}: no edge ${JSON.stringify(id)}`)
        edges.splice(idx, 1)
        applied.push({ op: name, id })
        break
      }

      case 'clear': {
        // Scoped to `origin: "agent"` DELIBERATELY (§8.2): "redraw my diagram"
        // is a real and common intent, and it must not be a foot-gun that takes
        // the human's annotations with it. An agent that genuinely wants an
        // empty canvas writes to a new `path`.
        const beforeNodes = nodes.length
        const beforeEdges = edges.length
        const kept = nodes.filter((n) => n.origin !== 'agent')
        const keptIds = new Set(kept.map((n) => n.id))
        nodes.splice(0, nodes.length, ...kept)
        // An operator edge whose endpoint was one of the agent's nodes cannot
        // survive it — same cascade reason as `remove_node` above.
        const keptEdges = edges.filter(
          (e) => e.origin !== 'agent' && keptIds.has(e.source) && keptIds.has(e.target)
        )
        edges.splice(0, edges.length, ...keptEdges)
        applied.push({
          op: name,
          removedNodes: beforeNodes - nodes.length,
          removedEdges: beforeEdges - edges.length
        })
        break
      }
    }
  }

  // FINAL GATE: U1's validator is the authority on what a document is (origin,
  // duplicate ids, dangling edges, label length, node/edge caps). Running it
  // here — rather than re-deriving those rules above — is what guarantees the
  // verb and the pane can never disagree about a document.
  const validated = validateCanvasDocument({ ...doc, nodes, edges })
  if (!validated.ok) return deny(canvasVerbCode(validated.code), validated.error)
  return { ok: true, doc: validated.doc, applied }
}

/** The catalog exactly as the ACK carries it (§8.1) — names, one-line
 *  descriptions and default sizes, so one call teaches the vocabulary. */
export function canvasShapeCatalogAck(): {
  name: string
  description: string
  defaultSize: { width: number; height: number }
}[] {
  return CANVAS_SHAPE_CATALOG.map((s) => ({
    name: s.name,
    description: s.description,
    defaultSize: s.defaultSize
  }))
}

export { canvasShapeNames }
