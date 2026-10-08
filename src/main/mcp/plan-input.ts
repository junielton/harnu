/**
 * Pure translation of agent-facing CATALOG tool args into the VALIDATE-shaped
 * input `planToolCall` re-parses (T10 structural gate). Extracted from the
 * server shell (BUG-14) so the seam catalog-shape → gate-shape is testable:
 * the shell is env-bound (electron) and e2e-only per ADR-0001, which is
 * exactly how the plan_mission drop shipped unseen behind 1651 green tests.
 *
 * CONTRACT (pinned by `tests/mcp-plan-input-seam.test.ts`): for EVERY op, a
 * well-formed catalog-shaped call MUST survive this translation and parse OK
 * in `parseToolInput` — a field this function drops is structurally denied
 * (`BAD_ARGS`) before the gate ever sees the call, killing the verb for every
 * agent, every time.
 *
 * BUG-14: `plan_mission` returned `{}` here ("no single gate folder"), which
 * was true for the FOLDER but silently discarded the five grant args — so the
 * T10 gate saw an empty object and the ONE-approval mission-grant flow died at
 * the front door. It now passes the grant fields through untouched (catalog
 * names = validator names) while still omitting `folder`: the base gate then
 * resolves FOLDER_NOT_ALLOWED and the plan_mission exemption in
 * `planToolCall` converts that into the single human confirm — the designed
 * path. Per-folder containment stays in the shell's `runMutation`.
 */

import type { McpOp } from './tool-catalog'
import { clampSpokenText } from '../speech-text'

/** Read a string field, or `undefined` when absent/non-string. */
export function strField(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** The `plan_mission` grant fields carried through to the T10 gate verbatim. */
const PLAN_MISSION_FIELDS = ['goal', 'folders', 'verbs', 'budget', 'ttlMinutes'] as const

/** A per-op catalog→validate translator: `(args, gateFolder) => the T10 input`. */
type Translator = (
  args: Record<string, unknown>,
  gateFolder: string | undefined
) => Record<string, unknown>

// a global read (no folder) — passes the gate when the server is enabled
const translateGetFleet: Translator = () => ({})
const translateGetApproval: Translator = () => ({})

// BUG-14: pass the grant args through so the T10 gate validates the real input.
// Deliberately NO `folder` key — there is no single gate folder; the
// FOLDER_NOT_ALLOWED → confirm exemption yields the ONE approval, and
// per-folder containment is checked in runMutation.
const translatePlanMission: Translator = (args) => {
  const input: Record<string, unknown> = {}
  for (const key of PLAN_MISSION_FIELDS) {
    if (args[key] !== undefined) input[key] = args[key]
  }
  return input
}

const translateGetSession: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = { id: strField(args, 'sessionId') ?? '' }
  if (gateFolder) input.folder = gateFolder
  return input
}

const translateListWorktrees: Translator = (_args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) {
    input.repoPath = gateFolder
    input.folder = gateFolder
  }
  return input
}

const translateCreateSession: Translator = (_args, gateFolder) => {
  const input: Record<string, unknown> = { kind: 'new' }
  if (gateFolder) input.folder = gateFolder
  return input
}

const translateCreateWorktree: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) {
    input.repoPath = gateFolder
    input.folder = gateFolder
  }
  const branch = strField(args, 'branch')
  if (branch) input.branch = branch
  return input
}

const translateSpawnTerminal: Translator = (_args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) {
    input.worktreePath = gateFolder
    input.folder = gateFolder
  }
  return input
}

const translateAdoptFolder: Translator = (_args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  return input
}

// T79 memory verbs: the gate folder IS the catalog `folder` arg (like
// adopt_folder — no resolution). Page/entry/query pass through so the gate
// validator (parseMemory*) can do the FULL structural check — a bad page or a
// secret-bearing entry is BAD_ARGS-denied before any confirm/disclosure.
const translateMemoryRead: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  const page = strField(args, 'page')
  if (page) input.page = page
  return input
}

const translateMemoryAppend: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  const page = strField(args, 'page')
  if (page) input.page = page
  if (args.entry !== undefined) input.entry = args.entry
  return input
}

const translateMemoryQuery: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  const query = strField(args, 'query')
  if (query) input.query = query
  return input
}

// T74 S4: the gate folder IS the catalog `folder` arg (like adopt_folder — no
// resolution). `path` passes through so the gate validator (parseOpenFile) does
// the full structural check (absolute, no `..`, markdown ext). Root-containment
// of the path vs the live known roots is enforced in the shell's runMutation.
const translateOpenFile: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  const p = strField(args, 'path')
  if (p) input.path = p
  return input
}

// T218 U5: the gate folder IS the catalog `folder` arg (like open_file/memory_*
// — no resolution). `path`/`ops`/`images`/`open` pass through untouched so the
// gate validator (parseDrawCanvas) does the full structural check, and the
// per-op semantic rules stay with the pure applier that owns them.
const translateDrawCanvas: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  const p = strField(args, 'path')
  if (p) input.path = p
  if (Array.isArray(args.ops)) input.ops = args.ops
  if (Array.isArray(args.images)) input.images = args.images
  if (typeof args.open === 'boolean') input.open = args.open
  return input
}

// T116: the gate folder IS the catalog `folder` arg (like open_file/memory_* —
// no resolution). Every other field passes through untouched so the gate
// validator (parseNotify) does the full structural check.
const translateNotify: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  const title = strField(args, 'title')
  if (title) input.title = title
  const description = strField(args, 'description')
  if (description !== undefined) input.description = description
  const kind = strField(args, 'kind')
  if (kind !== undefined) input.kind = kind
  const sessionId = strField(args, 'sessionId')
  if (sessionId !== undefined) input.sessionId = sessionId
  return input
}

// T238 `speak`: the gate folder IS the catalog `folder` arg (like notify). The
// utterance is CLAMPED here, at the very edge, so the bounded string is what the
// audit ring, the confirm disclosure and the gate validator all see — and so the
// "truncate, never reject" rule is applied BEFORE `parseSpeak`'s structural
// `.max`, which is what keeps that `.max` from ever refusing a real call.
const translateSpeak: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  const text = clampSpokenText(args.text)
  if (text) input.text = text
  const sessionId = strField(args, 'sessionId')
  if (sessionId !== undefined) input.sessionId = sessionId
  return input
}

// T96 board verbs: the gate folder IS the catalog `folder` arg (like
// adopt_folder/memory_* — no resolution). Every other field passes through
// untouched so the gate validator (parseCreateCard/parseUpdateCard/
// parseMoveCard) does the full structural check.
const translateCreateCard: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  const title = strField(args, 'title')
  if (title) input.title = title
  for (const key of ['body', 'kind', 'complexity', 'parent', 'substrate', 'priority', 'spec']) {
    const v = strField(args, key)
    if (v !== undefined) input[key] = v
  }
  if (Array.isArray(args.deps)) input.deps = args.deps
  return input
}

// BUG-79: this translator dropped `replaceBody` — every catalog call using
// ONLY that field translated to a T10 gate input with none of
// set/appendBody/replaceBody present, so `parseUpdateCard`'s refine denied it
// with BAD_ARGS before `update_card`'s handler ever ran. `replaceBody` is
// read with a raw `typeof` check (not `strField`) because its schema
// deliberately allows an empty string (clearing the body) — `strField` would
// fold `''` back into "absent" and reintroduce the same drop for that case.
const translateUpdateCard: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  const slug = strField(args, 'slug')
  if (slug) input.slug = slug
  if (args.set !== undefined) input.set = args.set
  const appendBody = strField(args, 'appendBody')
  if (appendBody !== undefined) input.appendBody = appendBody
  if (typeof args.replaceBody === 'string') input.replaceBody = args.replaceBody
  return input
}

const translateMoveCard: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  const slug = strField(args, 'slug')
  if (slug) input.slug = slug
  const to = strField(args, 'to')
  if (to) input.to = to
  return input
}

// T148: same shape as translateMoveCard, minus `to` — both archive_card and
// delete_card take only folder+slug.
const translateArchiveCard: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  const slug = strField(args, 'slug')
  if (slug) input.slug = slug
  return input
}

const translateDeleteCard: Translator = translateArchiveCard

// T104: the gate folder IS the catalog `folder` arg (like the board verbs
// above). `cards` (an array, not a string field) and `note` pass through
// untouched so the gate validator (parseSubmitManifest) does the full
// structural check.
const translateSubmitManifest: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  if (Array.isArray(args.cards)) input.cards = args.cards
  const note = strField(args, 'note')
  if (note !== undefined) input.note = note
  return input
}

// T215: the gate folder is the RECIPIENT's owning folder, resolved upstream in
// `server.ts` from the `sessionId` (the same widening `get_session` needed, but
// consulting the in-flight registries too — a live born-synthetic id has no
// scan row). That is the correct anchor: the risk is what a message causes in
// the RECIPIENT's working tree, not where the (unidentifiable) sender sits.
// `message` passes through so `parseMessageSession` does the full structural
// check — an over-cap body is BAD_ARGS before any confirm or socket work.
const translateMessageSession: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = { sessionId: strField(args, 'sessionId') ?? '' }
  if (gateFolder) input.folder = gateFolder
  const message = strField(args, 'message')
  if (message !== undefined) input.message = message
  return input
}

// T308: the gate folder IS the catalog `folder` arg (like adopt_folder/notify —
// no resolution). Every other field passes through untouched so the gate
// validator (parseCreateWorker) does the full structural check, including
// resolving `mode`'s default.
const translateCreateWorker: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  const name = strField(args, 'name')
  if (name !== undefined) input.name = name
  const prompt = strField(args, 'prompt')
  if (prompt !== undefined) input.prompt = prompt
  if (typeof args.everyMinutes === 'number') input.everyMinutes = args.everyMinutes
  const mode = strField(args, 'mode')
  if (mode !== undefined) input.mode = mode
  const model = strField(args, 'model')
  if (model !== undefined) input.model = model
  const effort = strField(args, 'effort')
  if (effort !== undefined) input.effort = effort
  if (typeof args.timeoutSeconds === 'number') input.timeoutSeconds = args.timeoutSeconds
  return input
}

// T308: same shape as list_worktrees/adopt_folder — `folder` only, and here
// it's optional (an unscoped call lists every worker).
const translateListWorkers: Translator = (_args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  return input
}

// T445: a worktree is named by its folder (the gate anchor) or by the id list_cleanup listed;
// an id carries no folder, and the handler refuses a blocked repo itself.
const translateReleaseWorktree: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = {}
  if (gateFolder) input.folder = gateFolder
  if (args.id !== undefined) input.id = args.id
  return input
}

// T329: the Containers actions address stacks by id, never a folder, so there
// is no gate folder to carry; a blocked folder's stack is refused per stack by
// the handler. Fields pass through untouched so the validator does the
// structural check.
const translateStopContainers: Translator = (args) => {
  const input: Record<string, unknown> = {}
  if (args.stacks !== undefined) input.stacks = args.stacks
  if (args.force !== undefined) input.force = args.force
  return input
}

const translateStartContainers: Translator = (args) => {
  const input: Record<string, unknown> = {}
  if (args.stacks !== undefined) input.stacks = args.stacks
  return input
}

// `stacks` is carried through on purpose: the strict validator refuses it, so
// a list sent to the one-stack verb is denied instead of silently narrowed.
const translateRemoveContainers: Translator = (args) => {
  const input: Record<string, unknown> = {}
  for (const key of ['stack', 'removeVolumes', 'stacks'] as const) {
    if (args[key] !== undefined) input[key] = args[key]
  }
  return input
}

// T316: `id` addresses the worker; the gate folder is resolved server-side
// from it (server.ts's `folderForWorkerId`) — the same pattern
// `translateMessageSession`/`translateOrchestratorArm` use for a session
// target, applied to a worker instead. `set` passes through untouched so
// `parseUpdateWorker` does the full structural check.
const translateUpdateWorker: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = { id: strField(args, 'id') ?? '' }
  if (gateFolder) input.folder = gateFolder
  if (args.set !== undefined) input.set = args.set
  return input
}

// T316: same shape as `translateOrchestratorArm` — `{ id }` only, folder
// resolved server-side from the worker itself.
const translateDeleteWorker: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = { id: strField(args, 'id') ?? '' }
  if (gateFolder) input.folder = gateFolder
  return input
}

// T309: same shape as `translateMessageSession` minus `message` — the gate
// folder is the TARGET's owning folder, resolved upstream in `server.ts` from
// `sessionId` (ADR-0013), never a caller-supplied one.
const translateOrchestratorArm: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = { sessionId: strField(args, 'sessionId') ?? '' }
  if (gateFolder) input.folder = gateFolder
  return input
}

// T358 S3: the mission_* verbs — the gate folder IS the catalog `folder` arg
// (like the board verbs, no resolution). Every other field passes through
// untouched so the gate validator re-checks the verb's own catalog schema.
const translateMission: Translator = (args, gateFolder) => {
  const input: Record<string, unknown> = { ...args }
  delete input.folder
  if (gateFolder) input.folder = gateFolder
  return input
}

/**
 * Router-side translator table: every {@link McpOp} maps to exactly ONE
 * translator — a `Record<McpOp, …>` rather than a `switch`, so TypeScript
 * enforces every op has an entry and adding a verb here is one map entry.
 */
const TRANSLATORS: { [K in McpOp]: Translator } = {
  get_fleet: translateGetFleet,
  get_approval: translateGetApproval,
  plan_mission: translatePlanMission,
  get_session: translateGetSession,
  list_worktrees: translateListWorktrees,
  create_session: translateCreateSession,
  create_worktree: translateCreateWorktree,
  spawn_terminal: translateSpawnTerminal,
  adopt_folder: translateAdoptFolder,
  // BUG-56: same shape as adopt_folder — `folder` only.
  remove_folder: translateAdoptFolder,
  memory_read: translateMemoryRead,
  memory_append: translateMemoryAppend,
  memory_query: translateMemoryQuery,
  open_file: translateOpenFile,
  draw_canvas: translateDrawCanvas,
  notify: translateNotify,
  create_card: translateCreateCard,
  update_card: translateUpdateCard,
  move_card: translateMoveCard,
  archive_card: translateArchiveCard,
  delete_card: translateDeleteCard,
  submit_manifest: translateSubmitManifest,
  message_session: translateMessageSession,
  speak: translateSpeak,
  create_worker: translateCreateWorker,
  list_workers: translateListWorkers,
  // T328: the same optional `{ folder }` shape as list_workers.
  list_containers: translateListWorkers,
  // T445: both gate on the `folder` arg, like list_containers / adopt_folder.
  list_cleanup: translateListWorkers,
  release_worktree: translateReleaseWorktree,
  stop_containers: translateStopContainers,
  start_containers: translateStartContainers,
  remove_containers: translateRemoveContainers,
  update_worker: translateUpdateWorker,
  delete_worker: translateDeleteWorker,
  // T309: both take the same `{ sessionId }` shape — one translator serves both ops.
  orchestrator_arm: translateOrchestratorArm,
  orchestrator_disarm: translateOrchestratorArm,
  mission_create: translateMission,
  mission_get: translateMission,
  mission_list: translateMission,
  mission_add_step: translateMission,
  mission_update_step: translateMission,
  mission_link_child: translateMission,
  mission_log: translateMission,
  mission_set_blocker: translateMission,
  mission_clear_blocker: translateMission,
  mission_set_end: translateMission,
  mission_verify_step: translateMission,
  mission_request_close: translateMission,
  mission_import_legacy: translateMission,
  mission_add_check: translateMission
}

/**
 * Translate the agent-facing CATALOG args (`folder`/`branch`/`sessionId`) into
 * the VALIDATE-shaped input `planToolCall` re-parses (`repoPath`/`worktreePath`/
 * `id`), carrying a `folder` key through for the gate's containment/allowlist
 * pluck. `gateFolder` is the resolved target folder (for `get_session` it is the
 * owning folder of the session id, resolved upstream). Dispatches through
 * {@link TRANSLATORS}.
 */
export function buildPlanInput(
  op: McpOp,
  args: Record<string, unknown>,
  gateFolder: string | undefined
): Record<string, unknown> {
  return TRANSLATORS[op](args, gateFolder)
}
