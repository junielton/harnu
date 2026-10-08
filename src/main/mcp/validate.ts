/**
 * Pure input validators for every MCP tool the router dispatches (T10).
 *
 * Each tool's raw arguments are UNTRUSTED MCP input. These zod 4 backed parsers
 * are the structural gate that sits in front of the router: they pin shapes,
 * require absolute paths (and refuse `..` traversal), resolve documented
 * defaults, and — for `create_session` — delegate the `bootOverride` to the T9
 * RCE sanitizer so a forbidden boot field is rejected here too.
 *
 * Framework-free + side-effect-free per ADR-0001 (pure-core / thin-shell): the
 * only import is `node:path` for `isAbsolute`, so the accept/reject decision is
 * deterministic and lands in the coverage surface. The shell (the MCP router)
 * feeds raw args in and acts on the verdict.
 *
 * The uniform contract is {@link ParseResult}: `{ ok: true, value }` with
 * defaults resolved, or `{ ok: false, error: 'BAD_ARGS', detail }` on any
 * malformed input — `detail` is a human-readable summary of the zod issues (or
 * the sanitizer's rejection message), never raw input echoed back.
 */

import * as path from 'node:path'
import { z } from 'zod'
import { sanitizeAgentBootOverride, type AgentBootOverride } from './agent-boot'
import { SAFE_GRANT_VERBS, toolByName, type McpOp } from './tool-catalog'
import { MESSAGE_MAX_CHARS } from '../messaging-socket'
import { SPEAK_MAX_CHARS } from '../speech-text'
import { MEMORY_ENTRY_MAX_CHARS, parseMemoryPage, validateEntry } from './memory-core'
import { MAX_CANVAS_IMAGES_PER_CALL, MAX_CANVAS_OPS_PER_CALL } from './canvas-ops'
import {
  CARD_BODY_MAX_CHARS,
  CARD_COMPLEXITIES,
  CARD_KINDS,
  CARD_SUBSTRATES,
  isCardMoveTarget,
  type CardComplexity,
  type CardKind,
  type CardMoveTarget,
  type CardSubstrate
} from '../roadmap-core'

/** Uniform parse outcome: a typed value on success, a `BAD_ARGS` reason on failure. */
export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; error: 'BAD_ARGS'; detail: string }

/** Validated args for the `create_session` tool. */
export interface CreateSessionArgs {
  /** Absolute path of the folder to launch in. */
  folder: string
  /** Whether to start fresh (`new`) or fork an existing session (`fork`). */
  kind: 'new' | 'fork'
  /** Required when `kind === 'fork'`: the source session to fork from. */
  forkSourceId?: string
  /** Capacity knobs only — already passed through the T9 RCE sanitizer. */
  bootOverride?: AgentBootOverride
}

/** Validated args for the `spawn_terminal` tool (defaults resolved). */
export interface SpawnTerminalArgs {
  /** Absolute path of the worktree the terminal belongs to. */
  worktreePath: string
  /** Where to mount the terminal; defaults to `split`. */
  target: 'tab' | 'split'
  /** Absolute working directory; defaults to `worktreePath`. */
  cwd: string
  /** Terminal kind; defaults to `shell`. `claude` requires a `sessionId`. */
  kind: 'shell' | 'claude'
  /** Required when `kind === 'claude'`: the Claude session to attach. */
  sessionId?: string
}

/** Validated args for the `create_worktree` tool. */
export interface CreateWorktreeArgs {
  /** Absolute path inside the repo to branch from. */
  repoPath: string
  /** Name of the branch/worktree to create. */
  branch: string
  /** Optional base ref to branch from (defaults to the repo's current HEAD). */
  baseRef?: string
}

/** Validated args for the `list_worktrees` read tool. */
export interface ListWorktreesArgs {
  /** Absolute path of the repo to list worktrees for. */
  repoPath: string
}

/** Validated args for the `get_session` read tool. */
export interface GetSessionArgs {
  /** The Harnu session id to read. */
  id: string
}

/** Validated args for the `adopt_folder` mutation tool. */
export interface AdoptFolderArgs {
  /** Absolute path of the existing folder to pin into the sidebar. */
  folder: string
}

/** Validated args for the `plan_mission` tool (T44 S5 — bounded capability grant). */
export interface PlanMissionArgs {
  goal: string
  /** Absolute, traversal-free folder paths (containment vs known roots is checked in the shell). */
  folders: string[]
  /** Grantable verbs (⊂ SAFE_GRANT_VERBS). */
  verbs: McpOp[]
  /** Max auto-allowed mutations (bounded). */
  budget: number
  /** Minutes until the grant expires (bounded). */
  ttlMinutes: number
}

/**
 * Whether `p` contains a `..` traversal segment (split on either separator).
 * `/repo/../etc` traverses; `/repo/..foo` does not.
 */
function hasTraversal(p: string): boolean {
  return p.split(/[\\/]/).includes('..')
}

/**
 * A non-empty, absolute, traversal-free path. Used for every path-shaped MCP
 * argument so a relative path or a `..` escape can never reach the shell.
 */
const absolutePathSchema = z
  .string()
  .min(1, 'must be a non-empty string')
  .refine((p) => path.isAbsolute(p), 'must be an absolute path')
  .refine((p) => !hasTraversal(p), 'must not contain a ".." traversal segment')

/** Render a {@link z.ZodError} as a single human-readable `detail` line. */
function fromZod(error: z.ZodError): ParseResult<never> {
  const detail = error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
      return `${where}${issue.message}`
    })
    .join('; ')
  return { ok: false, error: 'BAD_ARGS', detail }
}

const CreateSessionSchema = z
  .object({
    folder: absolutePathSchema,
    kind: z.enum(['new', 'fork']),
    forkSourceId: z.string().min(1).optional(),
    bootOverride: z.unknown().optional()
  })
  .refine((v) => v.kind !== 'fork' || (v.forkSourceId !== undefined && v.forkSourceId.length > 0), {
    message: 'fork requires a forkSourceId',
    path: ['forkSourceId']
  })

/**
 * Validate `create_session` args. Requires an absolute `folder` and a `kind` of
 * `new` | `fork` (fork additionally requires `forkSourceId`). Any `bootOverride`
 * is routed through {@link sanitizeAgentBootOverride} (T9), so a forbidden boot
 * field (e.g. `dangerouslySkipPermissions`, `extraArgs`, `agent`) is rejected
 * here as `BAD_ARGS`.
 *
 * @param input - the untrusted tool arguments.
 * @returns a {@link ParseResult} of {@link CreateSessionArgs}.
 */
export function parseCreateSession(input: unknown): ParseResult<CreateSessionArgs> {
  const parsed = CreateSessionSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { folder, kind, forkSourceId, bootOverride: rawOverride } = parsed.data

  let bootOverride: AgentBootOverride | undefined
  if (rawOverride !== undefined) {
    try {
      bootOverride = sanitizeAgentBootOverride(rawOverride)
    } catch (err) {
      return { ok: false, error: 'BAD_ARGS', detail: (err as Error).message }
    }
  }

  const value: CreateSessionArgs = { folder, kind }
  if (forkSourceId !== undefined) value.forkSourceId = forkSourceId
  if (bootOverride !== undefined) value.bootOverride = bootOverride
  return { ok: true, value }
}

const SpawnTerminalSchema = z
  .object({
    worktreePath: absolutePathSchema,
    target: z.enum(['tab', 'split']).default('split'),
    cwd: absolutePathSchema.optional(),
    kind: z.enum(['shell', 'claude']).default('shell'),
    sessionId: z.string().min(1).optional()
  })
  .refine((v) => v.kind !== 'claude' || (v.sessionId !== undefined && v.sessionId.length > 0), {
    message: "kind 'claude' requires a sessionId",
    path: ['sessionId']
  })

/**
 * Validate `spawn_terminal` args. Requires an absolute `worktreePath`; resolves
 * `target` (default `split`), `cwd` (default `worktreePath`), and `kind`
 * (default `shell`). A `kind` of `claude` requires a `sessionId`.
 *
 * @param input - the untrusted tool arguments.
 * @returns a {@link ParseResult} of {@link SpawnTerminalArgs}.
 */
export function parseSpawnTerminal(input: unknown): ParseResult<SpawnTerminalArgs> {
  const parsed = SpawnTerminalSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { worktreePath, target, cwd, kind, sessionId } = parsed.data

  const value: SpawnTerminalArgs = {
    worktreePath,
    target,
    cwd: cwd ?? worktreePath,
    kind
  }
  if (sessionId !== undefined) value.sessionId = sessionId
  return { ok: true, value }
}

const CreateWorktreeSchema = z.object({
  repoPath: absolutePathSchema,
  branch: z.string().min(1),
  baseRef: z.string().min(1).optional()
})

/**
 * Validate `create_worktree` args. Requires an absolute `repoPath` and a
 * non-empty `branch`; `baseRef` is optional.
 *
 * @param input - the untrusted tool arguments.
 * @returns a {@link ParseResult} of {@link CreateWorktreeArgs}.
 */
export function parseCreateWorktree(input: unknown): ParseResult<CreateWorktreeArgs> {
  const parsed = CreateWorktreeSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { repoPath, branch, baseRef } = parsed.data

  const value: CreateWorktreeArgs = { repoPath, branch }
  if (baseRef !== undefined) value.baseRef = baseRef
  return { ok: true, value }
}

/** Hard caps on a mission grant (T44 S5 invariant 2 — bounded, no unbounded path). */
export const MAX_GRANT_BUDGET = 100
export const MAX_GRANT_TTL_MIN = 480 // 8h

const PlanMissionSchema = z.object({
  goal: z.string().min(1).max(500),
  folders: z.array(absolutePathSchema).min(1).max(32),
  verbs: z.array(z.enum(SAFE_GRANT_VERBS)).min(1),
  budget: z.number().int().min(1).max(MAX_GRANT_BUDGET),
  ttlMinutes: z.number().int().min(1).max(MAX_GRANT_TTL_MIN)
})

/**
 * Validate `plan_mission` args (T44 S5). Enforces the SCOPED + BOUNDED invariants
 * structurally: explicit non-empty folders (absolute, `..`-free — 1..32) + verbs
 * (⊂ SAFE_GRANT_VERBS, so reads and `plan_mission` itself are rejected), and a
 * budget/TTL capped to sane maxima (no unbounded / no wildcard). Folder
 * containment vs the live known roots is enforced in the shell (needs the policy).
 */
export function parsePlanMission(input: unknown): ParseResult<PlanMissionArgs> {
  const parsed = PlanMissionSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { goal, folders, verbs, budget, ttlMinutes } = parsed.data
  return { ok: true, value: { goal, folders: [...folders], verbs: [...verbs], budget, ttlMinutes } }
}

const ListWorktreesSchema = z.object({ repoPath: absolutePathSchema })

/**
 * Validate `list_worktrees` read args. Requires an absolute, traversal-free
 * `repoPath`.
 *
 * @param input - the untrusted tool arguments.
 * @returns a {@link ParseResult} of {@link ListWorktreesArgs}.
 */
export function parseListWorktrees(input: unknown): ParseResult<ListWorktreesArgs> {
  const parsed = ListWorktreesSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  return { ok: true, value: { repoPath: parsed.data.repoPath } }
}

const AdoptFolderSchema = z.object({ folder: absolutePathSchema })

/**
 * Validate `adopt_folder` mutation args. Requires an absolute, traversal-free
 * `folder` (the containment gate re-checks it against the known roots).
 *
 * @param input - the untrusted tool arguments.
 * @returns a {@link ParseResult} of {@link AdoptFolderArgs}.
 */
export function parseAdoptFolder(input: unknown): ParseResult<AdoptFolderArgs> {
  const parsed = AdoptFolderSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  return { ok: true, value: { folder: parsed.data.folder } }
}

const GetSessionSchema = z.object({ id: z.string().min(1) })

/**
 * Validate `get_session` read args. Requires a non-empty `id`.
 *
 * @param input - the untrusted tool arguments.
 * @returns a {@link ParseResult} of {@link GetSessionArgs}.
 */
export function parseGetSession(input: unknown): ParseResult<GetSessionArgs> {
  const parsed = GetSessionSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  return { ok: true, value: { id: parsed.data.id } }
}

/** Validated args for the `memory_read` tool. */
export interface MemoryReadArgs {
  /** Absolute path of the folder/worktree whose repo memory to read. */
  folder: string
  /** Optional page id (in-layout, traversal-safe). Omitted → the tiered top. */
  page?: string
}

/** Validated args for the `memory_append` mutation tool. */
export interface MemoryAppendArgs {
  /** Absolute path of the folder/worktree whose repo memory to write. */
  folder: string
  /** Target page id (in-layout, appendable). */
  page: string
  /** Markdown body to append (or, for `hot`, the full replacement snapshot). */
  entry: string
}

/** Validated args for the `memory_query` read tool. */
export interface MemoryQueryArgs {
  /** Absolute path of the folder/worktree whose repo memory to search. */
  folder: string
  /** Case-insensitive substring to grep for. */
  query: string
}

const MemoryReadSchema = z.object({
  folder: absolutePathSchema,
  page: z.string().min(1).optional()
})

/**
 * Validate `memory_read` args. Requires an absolute `folder`; a `page`, when
 * present, must name an in-layout memory page ({@link parseMemoryPage} refuses
 * `..`/absolute/foreign-dir traversal at the gate).
 */
export function parseMemoryRead(input: unknown): ParseResult<MemoryReadArgs> {
  const parsed = MemoryReadSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { folder, page } = parsed.data
  if (page !== undefined) {
    const pageResult = parseMemoryPage(page)
    if (!pageResult.ok) return { ok: false, error: 'BAD_ARGS', detail: pageResult.detail }
  }
  const value: MemoryReadArgs = { folder }
  if (page !== undefined) value.page = page
  return { ok: true, value }
}

const MemoryAppendSchema = z.object({
  folder: absolutePathSchema,
  page: z.string().min(1),
  entry: z.string().min(1).max(MEMORY_ENTRY_MAX_CHARS)
})

/**
 * Validate `memory_append` args. Requires an absolute `folder`, an in-layout
 * appendable `page`, and an `entry` that passes the caps + anti-secret lint —
 * ALL at the structural gate, so a malformed page or a secret-bearing entry is
 * `BAD_ARGS`-denied BEFORE any disclosure, park, or write (the detail names the
 * secret KIND, never the value). The provenance author is stamped server-side,
 * so it is deliberately not an input field.
 */
export function parseMemoryAppend(input: unknown): ParseResult<MemoryAppendArgs> {
  const parsed = MemoryAppendSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { folder, page, entry } = parsed.data
  const pageResult = parseMemoryPage(page)
  if (!pageResult.ok) return { ok: false, error: 'BAD_ARGS', detail: pageResult.detail }
  const entryCheck = validateEntry(pageResult.value, entry)
  if (!entryCheck.ok) return { ok: false, error: 'BAD_ARGS', detail: entryCheck.detail }
  return { ok: true, value: { folder, page, entry } }
}

const MemoryQuerySchema = z.object({
  folder: absolutePathSchema,
  query: z.string().min(1).max(500)
})

/** Validate `memory_query` args. Requires an absolute `folder` and a non-empty query. */
export function parseMemoryQuery(input: unknown): ParseResult<MemoryQueryArgs> {
  const parsed = MemoryQuerySchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  return { ok: true, value: { folder: parsed.data.folder, query: parsed.data.query } }
}

/** Validated args for the `open_file` mutation tool (T74 S4; broadened by
 * Cluster G to any text file, not just markdown). */
export interface OpenFileArgs {
  /** Absolute path of the known folder the file belongs to (gate anchor). */
  folder: string
  /** Absolute path of the file to open (containment-gated; binary/oversized
   * files are refused when the pane actually reads them, not here). */
  path: string
}

const OpenFileSchema = z.object({
  folder: absolutePathSchema,
  path: absolutePathSchema
})

/**
 * Validate `open_file` args (T74 S4). Requires an absolute, traversal-free
 * `folder` (the gate anchor the allowlist re-checks) AND an absolute,
 * traversal-free `path`. Cluster G retired the markdown-extension refine that
 * used to live here — ANY file can be named now; root-containment of `path` vs
 * the live known roots is still enforced in the shell's `runMutation` (needs
 * the live folder set), and a binary/oversized file is refused when the
 * viewer pane actually reads it (the same refusal a human's eye-icon click
 * would hit), not at this structural layer.
 */
export function parseOpenFile(input: unknown): ParseResult<OpenFileArgs> {
  const parsed = OpenFileSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  return { ok: true, value: { folder: parsed.data.folder, path: parsed.data.path } }
}

/** Validated args for the `draw_canvas` mutation tool (T218 U5, spec §8.1). */
export interface DrawCanvasArgs {
  /** Absolute path of the known folder the canvas belongs to (gate anchor). */
  folder: string
  /** Canvas file; absent means the folder's default board (§4.2). */
  path?: string
  /**
   * 1..{@link MAX_CANVAS_OPS_PER_CALL} incremental ops, applied IN ORDER,
   * all-or-nothing. Passed through as raw `unknown[]`: the per-op shape,
   * shape-name, geometry, props and referential rules are the PURE applier's
   * (`canvas-ops.ts`), which needs the document to decide them and returns a
   * per-op, machine-readable refusal — a zod union here would answer the same
   * questions worse and in a second place.
   */
  ops: unknown[]
  /** 0..{@link MAX_CANVAS_IMAGES_PER_CALL} absolute image sources to externalise (§4.6). */
  images?: string[]
  /** Open/reveal the pane so the operator sees the drawing; defaults to true. */
  open: boolean
}

const DrawCanvasSchema = z.object({
  folder: absolutePathSchema,
  // NOT `absolutePathSchema`: §8.1 documents `path` as the canvas file, which a
  // caller may legitimately give relative to `folder`. Containment (rule 2 —
  // inside the folder, `.capycanvas.json`, under an allowed directory) is
  // decided on the RESOLVED path by `resolveCanvasWritePath`, so a `..` here is
  // refused there with `PATH_NOT_ALLOWED` rather than a structural BAD_ARGS
  // that could not explain which of the two directories it needed.
  path: z.string().min(1).optional(),
  ops: z.array(z.unknown()).min(1).max(MAX_CANVAS_OPS_PER_CALL),
  images: z.array(absolutePathSchema).max(MAX_CANVAS_IMAGES_PER_CALL).optional(),
  open: z.boolean().optional()
})

/**
 * Validate `draw_canvas` args (T218 U5). Requires an absolute, traversal-free
 * `folder` (the gate anchor) and a non-empty, capped `ops` array; `open`
 * defaults to TRUE (§8.1 — the drawing should be visible without a second
 * call). Every image source must be absolute and traversal-free here; the
 * source jail itself (`~/.claude/image-cache/` or inside the folder) is
 * `planCanvasAssets`, which needs the folder to decide it.
 */
export function parseDrawCanvas(input: unknown): ParseResult<DrawCanvasArgs> {
  const parsed = DrawCanvasSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { folder, path: canvasPath, ops, images, open } = parsed.data
  const value: DrawCanvasArgs = { folder, ops: [...ops], open: open ?? true }
  if (canvasPath !== undefined) value.path = canvasPath
  if (images !== undefined) value.images = [...images]
  return { ok: true, value }
}

/** Validated args for the `notify` mutation tool (T116). */
export interface NotifyArgs {
  /** Absolute path of the known folder this notice is about (gate anchor). */
  folder: string
  title: string
  description?: string
  kind?: 'info' | 'success' | 'warning' | 'danger'
  /** The calling session's own id, if known — enables the deep-link back to it. */
  sessionId?: string
}

const NotifySchema = z.object({
  folder: absolutePathSchema,
  title: z
    .string()
    .min(1)
    .max(200)
    .refine((v) => !v.includes('\n'), 'title must be a single line'),
  description: z.string().max(2_000).optional(),
  kind: z.enum(['info', 'success', 'warning', 'danger']).optional(),
  sessionId: z.string().min(1).optional()
})

/**
 * Validate `notify` args (T116). Requires an absolute `folder` and a
 * single-line `title` (1..200 chars); `description`/`kind`/`sessionId` are
 * optional and, when present, structurally validated.
 */
export function parseNotify(input: unknown): ParseResult<NotifyArgs> {
  const parsed = NotifySchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { folder, title, description, kind, sessionId } = parsed.data
  const value: NotifyArgs = { folder, title }
  if (description !== undefined) value.description = description
  if (kind !== undefined) value.kind = kind
  if (sessionId !== undefined) value.sessionId = sessionId
  return { ok: true, value }
}

/** Validated args for the `create_card` mutation tool (T96 §1.1). */
export interface CreateCardArgs {
  folder: string
  title: string
  body?: string
  kind?: CardKind
  complexity?: CardComplexity
  parent?: string
  deps?: string[]
  substrate?: CardSubstrate
  priority?: string
  spec?: string
}

const CreateCardSchema = z.object({
  folder: absolutePathSchema,
  title: z
    .string()
    .min(1)
    .max(200)
    .refine((v) => !v.includes('\n'), 'title must be a single line'),
  body: z.string().max(CARD_BODY_MAX_CHARS).optional(),
  kind: z.enum(CARD_KINDS).optional(),
  complexity: z.enum(CARD_COMPLEXITIES).optional(),
  parent: z.string().min(1).optional(),
  deps: z.array(z.string().min(1)).optional(),
  substrate: z.enum(CARD_SUBSTRATES).optional(),
  priority: z.string().min(1).optional(),
  spec: z.string().min(1).optional()
})

/**
 * Validate `create_card` args (T96 §1.1). Requires an absolute `folder` and a
 * single-line `title` (1..200 chars); every other field is optional and, when
 * present, structurally validated (kind/complexity/substrate against their
 * enums, body against the 16 KiB cap). `status` is deliberately NOT a field —
 * a card is always born `backlog`. Parent existence / one-level-deep and slug
 * collision are disk-dependent and checked by the shell, not here.
 */
export function parseCreateCard(input: unknown): ParseResult<CreateCardArgs> {
  const parsed = CreateCardSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { folder, title, body, kind, complexity, parent, deps, substrate, priority, spec } =
    parsed.data
  const value: CreateCardArgs = { folder, title }
  if (body !== undefined) value.body = body
  if (kind !== undefined) value.kind = kind
  if (complexity !== undefined) value.complexity = complexity
  if (parent !== undefined) value.parent = parent
  if (deps !== undefined) value.deps = [...deps]
  if (substrate !== undefined) value.substrate = substrate
  if (priority !== undefined) value.priority = priority
  if (spec !== undefined) value.spec = spec
  return { ok: true, value }
}

/** Validated args for the `update_card` mutation tool (T96 §1.2, +S2 `replaceBody`). */
export interface UpdateCardArgs {
  folder: string
  slug: string
  set?: Record<string, unknown>
  appendBody?: string
  replaceBody?: string
}

const UpdateCardSchema = z
  .object({
    folder: absolutePathSchema,
    slug: z.string().min(1),
    set: z.record(z.string(), z.unknown()).optional(),
    appendBody: z.string().min(1).max(MEMORY_ENTRY_MAX_CHARS).optional(),
    // S2 (card-detail edit engine): full-body replace, capped like create_card's
    // initial body (16 KiB) since it can carry the whole document, not just one
    // appended entry (appendBody's smaller MEMORY_ENTRY_MAX_CHARS cap).
    replaceBody: z.string().max(CARD_BODY_MAX_CHARS).optional()
  })
  .refine((v) => v.set !== undefined || v.appendBody !== undefined || v.replaceBody !== undefined, {
    message: 'at least one of set/appendBody/replaceBody is required'
  })

/**
 * Validate `update_card` args (T96 §1.2, +S2 `replaceBody`). Requires an
 * absolute `folder` and a `slug`, plus at least one of
 * `set`/`appendBody`/`replaceBody`. `set`'s field-level shape (editable vs
 * controlled, per-field value shape, the `substrate`-lock) is disk-dependent
 * (needs the on-disk card) and is decided by the pure `planCardSet` in the
 * shell, NOT here — this gate only pins the outer shape.
 */
export function parseUpdateCard(input: unknown): ParseResult<UpdateCardArgs> {
  const parsed = UpdateCardSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { folder, slug, set, appendBody, replaceBody } = parsed.data
  const value: UpdateCardArgs = { folder, slug }
  if (set !== undefined) value.set = set
  if (appendBody !== undefined) value.appendBody = appendBody
  if (replaceBody !== undefined) value.replaceBody = replaceBody
  return { ok: true, value }
}

/** Validated args for the `move_card` mutation tool (T96 §1.3). */
export interface MoveCardArgs {
  folder: string
  slug: string
  to: CardMoveTarget
}

const MoveCardSchema = z.object({
  folder: absolutePathSchema,
  slug: z.string().min(1),
  // Deliberately a loose string (not `z.enum(CARD_MOVE_TARGETS)`): `done` and
  // `in-progress` need their OWN steering message (DONE_IS_HUMAN /
  // IN_PROGRESS_IS_BOUND) instead of a generic "invalid enum" — see below.
  to: z.string().min(1)
})

/**
 * Validate `move_card` args (T96 §1.3). `to` is checked against
 * {@link CARD_MOVE_TARGETS} with a DIFFERENTIATED message for the two
 * structurally-forbidden values so the agent learns the right channel instead
 * of a bare "invalid enum": `done` steers to the operator's Close action,
 * `in-progress` steers to the fact that it only exists via a real dispatch
 * bind. Any other unrecognized value gets the plain enum-mismatch detail.
 */
export function parseMoveCard(input: unknown): ParseResult<MoveCardArgs> {
  const parsed = MoveCardSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { folder, slug, to } = parsed.data
  if (to === 'done') {
    return {
      ok: false,
      error: 'BAD_ARGS',
      detail:
        'DONE_IS_HUMAN: move_card cannot target "done" — Review→Done is the operator\'s Close action on the board, never a verb write.'
    }
  }
  if (to === 'in-progress') {
    return {
      ok: false,
      error: 'BAD_ARGS',
      detail:
        'IN_PROGRESS_IS_BOUND: move_card cannot target "in-progress" — that column only exists via a real dispatch bind (a session attached to the card), never a direct write.'
    }
  }
  if (!isCardMoveTarget(to)) {
    return { ok: false, error: 'BAD_ARGS', detail: 'to must be one of backlog|ready|review' }
  }
  return { ok: true, value: { folder, slug, to } }
}

/** Validated args for `archive_card`/`delete_card` (T148) — folder+slug only. */
export interface CardSlugArgs {
  folder: string
  slug: string
}

const CardSlugSchema = z.object({
  folder: absolutePathSchema,
  slug: z.string().min(1)
})

/** Validate `archive_card` args (T148). */
export function parseArchiveCard(input: unknown): ParseResult<CardSlugArgs> {
  const parsed = CardSlugSchema.safeParse(input)
  return parsed.success ? { ok: true, value: parsed.data } : fromZod(parsed.error)
}

/** Validate `delete_card` args (T148) — same shape as `archive_card`. */
export function parseDeleteCard(input: unknown): ParseResult<CardSlugArgs> {
  return parseArchiveCard(input)
}

/** One card entry in a `submit_manifest` request (T104 §2.1). */
export interface ManifestCardArgs {
  slug: string
  substrate?: CardSubstrate
  model?: string
  effort?: string
}

/** Validated args for the `submit_manifest` mutation tool (T104 §2.1). */
export interface SubmitManifestArgs {
  folder: string
  cards: ManifestCardArgs[]
  note?: string
}

/** Bound on how many cards one manifest may declare (a lot, but not unbounded — no wildcard). */
export const MAX_MANIFEST_CARDS = 50

const ManifestCardSchema = z.object({
  slug: z.string().min(1),
  substrate: z.enum(CARD_SUBSTRATES).optional(),
  model: z.string().min(1).max(64).optional(),
  effort: z.string().min(1).max(32).optional()
})

const SubmitManifestSchema = z.object({
  folder: absolutePathSchema,
  cards: z.array(ManifestCardSchema).min(1).max(MAX_MANIFEST_CARDS),
  note: z.string().max(2_000).optional()
})

/**
 * Validate `submit_manifest` args (T104 §2.1). Requires an absolute `folder`
 * and a non-empty, bounded (≤{@link MAX_MANIFEST_CARDS}) `cards` list — DECLARED
 * ORDER is preserved (the array order IS the drain order, §2.5), never
 * re-sorted here or downstream. Per-card `substrate`/`model`/`effort` are
 * OVERRIDES only (the shell resolves the routing-table default when absent);
 * `slug` existence / status / readiness are disk-dependent and checked by the
 * shell, not here.
 */
export function parseSubmitManifest(input: unknown): ParseResult<SubmitManifestArgs> {
  const parsed = SubmitManifestSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { folder, cards, note } = parsed.data
  const value: SubmitManifestArgs = { folder, cards: cards.map((c) => ({ ...c })) }
  if (note !== undefined) value.note = note
  return { ok: true, value }
}

const GetFleetSchema = z.object({})

/** `get_fleet` takes no args; validated as an empty object. */
function parseGetFleet(input: unknown): ParseResult<unknown> {
  const parsed = GetFleetSchema.safeParse(input)
  return parsed.success ? { ok: true, value: {} } : fromZod(parsed.error)
}

/**
 * A global read: `buildPlanInput` passes `{}` to the gate for `get_approval`
 * (the approvalId is read from args in the shell, not gated by the folder
 * allowlist) — same empty-object shape as `get_fleet`.
 */
function parseGetApproval(input: unknown): ParseResult<unknown> {
  return parseGetFleet(input)
}

/** Validated args for the `speak` mutation tool (T238). */
export interface SpeakArgs {
  /** Absolute path of the known folder this utterance is about (gate anchor). */
  folder: string
  /** The utterance, ALREADY clamped by `translateSpeak` — see the schema below. */
  text: string
  /** The calling session's own id, if it gave one — drives the focus rule. */
  sessionId?: string
}

const SpeakSchema = z.object({
  folder: absolutePathSchema,
  // The cap is `.max`, i.e. STRUCTURAL — but it can never refuse a real call,
  // because `translateSpeak` clamps before this runs. That ordering is what makes
  // "truncate, never reject" true while still keeping an unbounded agent string
  // out of the audit ring and the confirm disclosure.
  text: z.string().min(1).max(SPEAK_MAX_CHARS),
  sessionId: z.string().min(1).optional()
})

/**
 * Validate `speak` args (T238). Requires an absolute `folder` and a non-empty
 * `text` within {@link SPEAK_MAX_CHARS}. An utterance that is empty once
 * normalised (whitespace, or a bare `-`) is `BAD_ARGS` — "say nothing" is a
 * malformed call, not a truncation.
 */
export function parseSpeak(input: unknown): ParseResult<SpeakArgs> {
  const parsed = SpeakSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { folder, text, sessionId } = parsed.data
  const value: SpeakArgs = { folder, text }
  if (sessionId !== undefined) value.sessionId = sessionId
  return { ok: true, value }
}

/** Validated args for the `message_session` mutation tool (T215). */
export interface MessageSessionArgs {
  /** The Harnu session id of the recipient. */
  sessionId: string
  /** The message body (1..{@link MESSAGE_MAX_CHARS} chars). */
  message: string
  /**
   * The RECIPIENT's owning folder — the gate anchor, resolved upstream from
   * `sessionId`. Absent when the id resolved to no known folder, in which case
   * the base gate denies with `FOLDER_NOT_ALLOWED` before the handler runs.
   */
  folder?: string
}

const MessageSessionSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1).max(MESSAGE_MAX_CHARS),
  folder: absolutePathSchema.optional()
})

/**
 * Validate `message_session` args (T215). Requires a non-empty `sessionId` and
 * a non-empty `message` within the {@link MESSAGE_MAX_CHARS} cap — the cap is
 * enforced HERE, structurally, so an over-cap body is `BAD_ARGS` before it can
 * reach the audit ring or a peer's inbox.
 */
export function parseMessageSession(input: unknown): ParseResult<MessageSessionArgs> {
  const parsed = MessageSessionSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { sessionId, message, folder } = parsed.data
  const value: MessageSessionArgs = { sessionId, message }
  if (folder !== undefined) value.folder = folder
  return { ok: true, value }
}

/** Scheduler worker mode — mirrors `scheduler-core.ts`'s `WorkerMode`. */
export type WorkerModeArg = 'observe' | 'act'

/** Scheduler worker effort — mirrors `scheduler-core.ts`'s `Effort`. */
export type WorkerEffortArg = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Validated args for the `create_worker` mutation tool (T308). */
export interface CreateWorkerArgs {
  folder: string
  name: string
  prompt: string
  everyMinutes: number
  /** Resolved default: `observe` when the caller omitted `mode`. */
  mode: WorkerModeArg
  model?: string
  effort?: WorkerEffortArg
  /** T316 AC-5: seconds before a tick is killed. Left undefined ⇒ the shell's 300s default. */
  timeoutSeconds?: number
}

const CreateWorkerSchema = z.object({
  folder: absolutePathSchema,
  name: z.string().min(1).max(200),
  prompt: z.string().min(1).max(8_000),
  everyMinutes: z.number().int().positive(),
  mode: z.enum(['observe', 'act']).optional(),
  model: z.string().min(1).max(64).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  timeoutSeconds: z.number().int().positive().optional()
})

/**
 * Validate `create_worker` args (T308). Requires an absolute `folder`, a
 * `name`, a `prompt` (≤8000 chars — the same order of magnitude as a memory
 * entry), and a positive integer `everyMinutes`. `mode` defaults to `observe`
 * HERE (not left `undefined`) so both `forceConfirmFor` (tool-catalog.ts) and
 * the handler read the same resolved value the caller may have omitted.
 */
export function parseCreateWorker(input: unknown): ParseResult<CreateWorkerArgs> {
  const parsed = CreateWorkerSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { folder, name, prompt, everyMinutes, mode, model, effort, timeoutSeconds } = parsed.data
  const value: CreateWorkerArgs = { folder, name, prompt, everyMinutes, mode: mode ?? 'observe' }
  if (model !== undefined) value.model = model
  if (effort !== undefined) value.effort = effort
  if (timeoutSeconds !== undefined) value.timeoutSeconds = timeoutSeconds
  return { ok: true, value }
}

/** Validated args for the `list_workers` read tool (T308). */
export interface ListWorkersArgs {
  folder?: string
}

const ListWorkersSchema = z.object({ folder: absolutePathSchema.optional() })

/** Validate `list_workers` args (T308). `folder` is optional (an unscoped global list). */
export function parseListWorkers(input: unknown): ParseResult<ListWorkersArgs> {
  const parsed = ListWorkersSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const value: ListWorkersArgs = {}
  if (parsed.data.folder !== undefined) value.folder = parsed.data.folder
  return { ok: true, value }
}

/** Validated args for the `list_containers` read tool (T328). */
export type ListContainersArgs = ListWorkersArgs

/** Validate `list_containers` args (T328) — the same optional `{ folder }` shape as `list_workers`. */
export function parseListContainers(input: unknown): ParseResult<ListContainersArgs> {
  return parseListWorkers(input)
}

/** Validated args for the `list_cleanup` read tool (T445). */
export type ListCleanupArgs = ListWorkersArgs

/** Validate `list_cleanup` args (T445) — the same optional `{ folder }` shape as `list_workers`. */
export function parseListCleanup(input: unknown): ParseResult<ListCleanupArgs> {
  return parseListWorkers(input)
}

/** Validated args for the `release_worktree` mutation tool (T445): a folder or a listed id. */
export interface ReleaseWorktreeArgs {
  folder?: string
  id?: string
}

const ReleaseWorktreeSchema = z
  .object({ folder: absolutePathSchema.optional(), id: z.string().min(1).optional() })
  .refine((v) => (v.folder === undefined) !== (v.id === undefined), {
    message: 'pass exactly one of folder / id'
  })

/** Validate `release_worktree` args (T445). */
export function parseReleaseWorktree(input: unknown): ParseResult<ReleaseWorktreeArgs> {
  const parsed = ReleaseWorktreeSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const value: ReleaseWorktreeArgs = {}
  if (parsed.data.folder !== undefined) value.folder = parsed.data.folder
  if (parsed.data.id !== undefined) value.id = parsed.data.id
  return { ok: true, value }
}

/** Stack ids from `list_containers`: a non-empty list of non-empty strings. */
const StackIdsSchema = z.array(z.string().min(1)).min(1)

/** Validated args for the `stop_containers` mutation tool (T329). */
export interface StopContainersArgs {
  stacks: string[]
  /** Kept when given, so `forceConfirmFor` reads the value the caller sent. */
  force?: boolean
}

const StopContainersSchema = z.object({
  stacks: StackIdsSchema,
  force: z.boolean().optional()
})

/** Validate `stop_containers` args (T329). */
export function parseStopContainers(input: unknown): ParseResult<StopContainersArgs> {
  const parsed = StopContainersSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const value: StopContainersArgs = { stacks: parsed.data.stacks }
  if (parsed.data.force !== undefined) value.force = parsed.data.force
  return { ok: true, value }
}

/** Validated args for the `start_containers` mutation tool (T329). */
export interface StartContainersArgs {
  stacks: string[]
}

const StartContainersSchema = z.object({ stacks: StackIdsSchema })

/** Validate `start_containers` args (T329). */
export function parseStartContainers(input: unknown): ParseResult<StartContainersArgs> {
  const parsed = StartContainersSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  return { ok: true, value: { stacks: parsed.data.stacks } }
}

/** Validated args for the `remove_containers` mutation tool (T329). */
export interface RemoveContainersArgs {
  stack: string
  removeVolumes?: boolean
}

// Strict: removal takes exactly one stack, so a `stacks` list is refused
// outright instead of being stripped while one stack is quietly removed.
const RemoveContainersSchema = z.strictObject({
  stack: z.string().min(1),
  removeVolumes: z.boolean().optional()
})

/** Validate `remove_containers` args (T329). One stack; never a list. */
export function parseRemoveContainers(input: unknown): ParseResult<RemoveContainersArgs> {
  const parsed = RemoveContainersSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const value: RemoveContainersArgs = { stack: parsed.data.stack }
  if (parsed.data.removeVolumes !== undefined) value.removeVolumes = parsed.data.removeVolumes
  return { ok: true, value }
}

/** Validated `set` fields for the `update_worker` mutation tool (T316). */
export interface UpdateWorkerSet {
  name?: string
  prompt?: string
  everyMinutes?: number
  mode?: WorkerModeArg
  model?: string
  effort?: WorkerEffortArg
  timeoutSeconds?: number
  enabled?: boolean
  runOnBoot?: boolean
  carryLastResult?: boolean
  notifyOn?: 'silent' | 'failure' | 'every'
  extraReadCommands?: string[]
  systemPrompt?: string
}

/** Validated args for the `update_worker` mutation tool (T316). */
export interface UpdateWorkerArgs {
  id: string
  set: UpdateWorkerSet
  /**
   * The worker's owning folder — the gate anchor, resolved upstream from `id`
   * (same mechanism as `message_session`'s recipient folder). Absent when the
   * id resolved to no known worker, in which case the base gate denies with
   * FOLDER_NOT_ALLOWED before the handler runs.
   */
  folder?: string
}

const UpdateWorkerSetSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(8_000).optional(),
    everyMinutes: z.number().int().positive().optional(),
    mode: z.enum(['observe', 'act']).optional(),
    model: z.string().min(1).max(64).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
    runOnBoot: z.boolean().optional(),
    carryLastResult: z.boolean().optional(),
    notifyOn: z.enum(['silent', 'failure', 'every']).optional(),
    extraReadCommands: z.array(z.string()).optional(),
    systemPrompt: z.string().optional()
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'set must include at least one field' })

const UpdateWorkerSchema = z.object({
  id: z.string().min(1),
  set: UpdateWorkerSetSchema,
  folder: absolutePathSchema.optional()
})

/**
 * Validate `update_worker` args (T316). Requires a non-empty `id` and a `set`
 * with at least one editable field — field-level EXISTENCE is checked here;
 * whether `id` actually names a worker is disk-dependent and decided by the
 * shell (`updateWorkerForAgent`), not this pure gate.
 */
export function parseUpdateWorker(input: unknown): ParseResult<UpdateWorkerArgs> {
  const parsed = UpdateWorkerSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { id, set, folder } = parsed.data
  const value: UpdateWorkerArgs = { id, set }
  if (folder !== undefined) value.folder = folder
  return { ok: true, value }
}

/** Validated args for the `delete_worker` mutation tool (T316). */
export interface DeleteWorkerArgs {
  id: string
  /** Same resolved-anchor convention as {@link UpdateWorkerArgs.folder}. */
  folder?: string
}

const DeleteWorkerSchema = z.object({
  id: z.string().min(1),
  folder: absolutePathSchema.optional()
})

/** Validate `delete_worker` args (T316). Requires a non-empty `id`. */
export function parseDeleteWorker(input: unknown): ParseResult<DeleteWorkerArgs> {
  const parsed = DeleteWorkerSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { id, folder } = parsed.data
  const value: DeleteWorkerArgs = { id }
  if (folder !== undefined) value.folder = folder
  return { ok: true, value }
}

/** Validated args for the `orchestrator_arm` / `orchestrator_disarm` tools (T309). */
export interface OrchestratorArmArgs {
  /** The Harnu session id to arm/disarm. */
  sessionId: string
  /**
   * The TARGET's owning folder — the gate anchor, resolved upstream from
   * `sessionId` (same mechanism as `message_session`'s recipient folder, ADR-0013).
   * Absent when the id resolved to no known folder, in which case the base gate
   * denies with `FOLDER_NOT_ALLOWED` before the handler runs.
   */
  folder?: string
}

const OrchestratorArmSchema = z.object({
  sessionId: z.string().min(1),
  folder: absolutePathSchema.optional()
})

/**
 * Validate `orchestrator_arm` / `orchestrator_disarm` args (T309). Requires a
 * non-empty `sessionId` — the same `{ sessionId, folder? }` shape as
 * `message_session` (ADR-0013), since both resolve their gate anchor from the
 * TARGET session, never a caller-supplied one.
 */
export function parseOrchestratorArm(input: unknown): ParseResult<OrchestratorArmArgs> {
  const parsed = OrchestratorArmSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  const { sessionId, folder } = parsed.data
  const value: OrchestratorArmArgs = { sessionId }
  if (folder !== undefined) value.folder = folder
  return { ok: true, value }
}

/** Validate `orchestrator_disarm` args (T309) — identical shape to `orchestrator_arm`. */
export function parseOrchestratorDisarm(input: unknown): ParseResult<OrchestratorArmArgs> {
  return parseOrchestratorArm(input)
}

/**
 * T358 S3: validate a `mission_*` verb against its OWN catalog schema (one
 * source — the schema the MCP SDK already enforced on the way in), plus the
 * absolute, traversal-free `folder` rule every folder-anchored verb gets here.
 * Semantic refusals (an incomplete declared end, a controlled step field, an
 * owner id that is not a session UUID) are the handler's, where they can be
 * named instead of collapsing into a generic BAD_ARGS.
 */
function parseMissionVerb(op: McpOp): (input: unknown) => ParseResult<Record<string, unknown>> {
  return (input) => {
    const schema = toolByName(op)?.inputSchema
    if (!schema) return { ok: false, error: 'BAD_ARGS', detail: `unknown mission verb ${op}` }
    const parsed = schema.safeParse(input)
    if (!parsed.success) return fromZod(parsed.error)
    const value = parsed.data as Record<string, unknown>
    if (value.folder !== undefined) {
      const folder = absolutePathSchema.safeParse(value.folder)
      if (!folder.success) return fromZod(folder.error)
    }
    return { ok: true, value }
  }
}

/**
 * Router-side dispatch table: validate the args for a given {@link McpOp}.
 * Every op maps to exactly ONE parser — a `Record<McpOp, …>` rather than a
 * `switch`, so TypeScript enforces every op has an entry (no silent
 * fallthrough) and adding a verb here is one map entry, not a new `case`.
 */
const PARSERS: { [K in McpOp]: (input: unknown) => ParseResult<unknown> } = {
  get_fleet: parseGetFleet,
  get_approval: parseGetApproval,
  get_session: parseGetSession,
  list_worktrees: parseListWorktrees,
  create_session: parseCreateSession,
  create_worktree: parseCreateWorktree,
  spawn_terminal: parseSpawnTerminal,
  adopt_folder: parseAdoptFolder,
  // BUG-56: same `{ folder }` shape as adopt_folder.
  remove_folder: parseAdoptFolder,
  plan_mission: parsePlanMission,
  memory_read: parseMemoryRead,
  memory_append: parseMemoryAppend,
  memory_query: parseMemoryQuery,
  open_file: parseOpenFile,
  draw_canvas: parseDrawCanvas,
  notify: parseNotify,
  create_card: parseCreateCard,
  update_card: parseUpdateCard,
  move_card: parseMoveCard,
  archive_card: parseArchiveCard,
  delete_card: parseDeleteCard,
  submit_manifest: parseSubmitManifest,
  message_session: parseMessageSession,
  speak: parseSpeak,
  create_worker: parseCreateWorker,
  list_workers: parseListWorkers,
  list_containers: parseListContainers,
  // T445: list_cleanup takes the optional folder; release_worktree requires it.
  list_cleanup: parseListCleanup,
  release_worktree: parseReleaseWorktree,
  stop_containers: parseStopContainers,
  start_containers: parseStartContainers,
  remove_containers: parseRemoveContainers,
  update_worker: parseUpdateWorker,
  delete_worker: parseDeleteWorker,
  orchestrator_arm: parseOrchestratorArm,
  orchestrator_disarm: parseOrchestratorDisarm,
  mission_create: parseMissionVerb('mission_create'),
  mission_get: parseMissionVerb('mission_get'),
  mission_list: parseMissionVerb('mission_list'),
  mission_add_step: parseMissionVerb('mission_add_step'),
  mission_update_step: parseMissionVerb('mission_update_step'),
  mission_link_child: parseMissionVerb('mission_link_child'),
  mission_log: parseMissionVerb('mission_log'),
  mission_set_blocker: parseMissionVerb('mission_set_blocker'),
  mission_clear_blocker: parseMissionVerb('mission_clear_blocker'),
  mission_set_end: parseMissionVerb('mission_set_end'),
  mission_verify_step: parseMissionVerb('mission_verify_step'),
  mission_request_close: parseMissionVerb('mission_request_close'),
  mission_import_legacy: parseMissionVerb('mission_import_legacy'),
  mission_add_check: parseMissionVerb('mission_add_check')
}

/**
 * Validate the args for a given {@link McpOp} by dispatching through
 * {@link PARSERS}. Returns the same {@link ParseResult} contract so the router
 * can branch uniformly on `ok`.
 *
 * @param op - the router op the tool maps to (one of the catalog's `MCP_OPS`).
 * @param input - the untrusted tool arguments.
 * @returns a {@link ParseResult} whose `value` shape depends on `op`.
 */
export function parseToolInput(op: McpOp, input: unknown): ParseResult<unknown> {
  return PARSERS[op](input)
}
