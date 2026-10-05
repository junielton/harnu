/**
 * Renderer-side command router for the Harnu MCP server (T17).
 *
 * A validated MCP op + payload arrives here (over IPC, after the main-process
 * approval gate) and is turned into a concrete store mutation. This is the ONE
 * dispatch surface the renderer exposes to the fleet: the `switch` it builds is
 * the drift-valve target referenced by T5 — every op the catalog can emit must
 * have a `case` here, or the call falls through to `BAD_ARGS`.
 *
 * Pure factory (ADR-0001 pure-core / thin-shell): no electron / node / Pinia
 * import. Every side-effecting store action is INJECTED via
 * {@link CommandRouterActions}, so the dispatcher unit-tests with zero Pinia and
 * stays deterministic (the only non-determinism — id minting — is the injectable
 * `genId` threaded into {@link makeAgentSession}).
 *
 * Result contract (discriminated by key presence):
 *   - success carries its data directly (`{ syntheticId, correlationId }` or
 *     `{ paneId }`);
 *   - a recognized validation failure returns `{ error: <CODE> }`
 *     (`'BAD_ARGS'` | `'FOLDER_NOT_FOUND'`);
 *   - an UNEXPECTED failure (an injected action threw) is caught and surfaced as
 *     `{ ok: false, error }` — distinct from a validation code so the shell can
 *     tell "you asked wrong" from "something blew up".
 */

import { makeAgentSession, type AgentSession, type IdGen } from './agent-create-core'
import { hasCanvasSuffix } from '../lib/canvas-suffix'
// The focus rule ONLY — deliberately not `lib/speech`, which constructs the
// engine singleton at module scope and would break this module's pure-factory
// contract for every consumer that loads the router.
import { shouldSpeak, type SpeechFocus } from '../lib/speech-focus'

/**
 * The renderer dispatch ops the router services. The router builds its `switch`
 * from this union so the catalog (T5) and dispatcher can't silently diverge — a
 * command outside this set falls through to `BAD_ARGS`.
 */
export const COMMAND_OPS = [
  'session.create',
  'session.dispatchCard',
  'pane.split',
  'pane.openMarkdown',
  'pane.closeFile',
  'pane.closePane',
  'roadmap.bootLabels',
  'notify.push',
  // T238: say one line out loud through the voice engine. EPHEMERAL by design —
  // it deliberately does NOT go anywhere near `notify.push`: a read-aloud that
  // also filed an Activity row would fill the history with sentences the
  // operator already heard.
  'speech.say',
  // T215: un-park a session Harnu itself parked, so a brokered peer message has
  // a live process to reach. HEADLESS — it must never select the session, for
  // the same reason `pane.split`/`pane.openMarkdown` never do: an agent's
  // message cannot yank an operator who is looking somewhere else.
  'session.wake'
] as const

/** A router-dispatchable command op — one of {@link COMMAND_OPS}. */
export type CommandOp = (typeof COMMAND_OPS)[number]

/** Mirrors `NotificationKind` (`stores/notifications.ts`) — kept a local literal so
 *  this pure router stays free of a Pinia-store value import. */
export type NotifyKind = 'info' | 'success' | 'warning' | 'danger'

const COMMAND_OP_SET: ReadonlySet<string> = new Set(COMMAND_OPS)

/** Runtime guard: is `value` one of the router's known {@link COMMAND_OPS}? */
export function isCommandOp(value: unknown): value is CommandOp {
  return typeof value === 'string' && COMMAND_OP_SET.has(value)
}

/**
 * BUG-63: the folder-adoption fields the background drain's `session.dispatchCard`
 * optionally carries when it just cut a worktree for this dispatch — the router
 * hands this to {@link CommandRouterActions.registerFolder} BEFORE dispatching.
 * Mirrors `FolderAdoptedPayload` (`command-dispatch.ts`) minus the CLI-only
 * `select` reveal flag, which the drain never sets.
 */
export interface AdoptedFolderInput {
  path: string
  gitBranch?: string
  repoId?: string
  isMainWorktree?: boolean
}

/**
 * The side-effecting store actions the router needs, injected so the core stays
 * Pinia-free and deterministic. The real shell wires these to the sessions /
 * helpers Pinia stores; tests pass spies.
 */
export interface CommandRouterActions {
  /** True iff `path` is a folder Harnu already knows about (pinned or active). */
  folderExists(path: string): boolean
  /**
   * Persist a freshly-minted agent synthetic into the store (insert into the
   * folder's session list, register the correlation token). `prePrompt` is the
   * optional initial prompt to send on launch; `bootOverride` carries the
   * allowlisted capacity knobs (model/effort — T33-A′) applied at spawn.
   */
  insertAgentSession(
    session: AgentSession,
    prePrompt?: string,
    bootOverride?: { model?: string; effort?: string }
  ): void
  /** Headless: append a shell helper to a worktree's stack; returns the pane id. */
  addShellHelper(worktreePath: string, cwd: string): string
  /** Headless: append a `claude --resume` helper to a worktree; returns the pane id. */
  addResumeHelper(worktreePath: string, sessionId: string, cwd: string): string
  /**
   * Headless: open a file-backed markdown viewer pane in a worktree's stack (T74
   * `open_file`). NON-PTY and BACKGROUND — like the other helper appends it never
   * selects the session/worktree, so an agent's open never yanks the operator's
   * focus (T78). dedup-by-filePath + a per-worktree cap live in the store action.
   * Returns the pane id (new, or the existing one on a dedup hit).
   */
  addMarkdownHelper(worktreePath: string, filePath: string, cwd: string): string
  /**
   * Headless: open a file-backed CANVAS viewer pane (T218) in a worktree's
   * stack — the `*.capycanvas.json` arm of `open_file`, with the same
   * background/no-focus-steal contract as {@link addMarkdownHelper} and the
   * same dedup-by-filePath + per-worktree cap in the store action. Returns the
   * pane id (new, or the existing one on a dedup hit).
   */
  addCanvasHelper(worktreePath: string, filePath: string, cwd: string): string
  /**
   * T171 `close_file`: close the non-PTY, file/folder-backed pane (markdown /
   * memory / explorer) matching `path` in the TARGET worktree's stack.
   * Returns the closed pane's id, or `undefined` if nothing matched.
   */
  closeHelperByPath(worktreePath: string, path: string): string | undefined
  /**
   * T171 `close_pane`: close ANY pane by id in the TARGET worktree's stack,
   * including PTY-backed ones. Returns whether a pane was actually found.
   */
  closeHelperById(worktreePath: string, paneId: string): boolean
  /**
   * T113 (background drain): mint a board-dispatch synthetic in `folderPath`
   * WITHOUT selecting it, and queue its background boot — the drain must never
   * steal the operator's focus. Returns the synthetic id, or `null` when the
   * folder is unknown. OPTIONAL (staged rollout, same shape as `notifyAgent`):
   * un-wired ⇒ the op surfaces `{ ok: false, error }`.
   */
  dispatchCardSession?(
    folderPath: string,
    prompt: string,
    bootOverride?: { model?: string; effort?: string }
  ): string | null
  /**
   * BUG-63: register a just-created worktree's folder into the live model
   * SYNCHRONOUSLY — the same `registerFolderImmediate` (BUG-40) the manual board
   * dispatch (`RoadmapBoard.vue`'s `spawnAndBind`) calls right after
   * `worktreeCreate`. `handleSessionDispatchCard` calls this BEFORE
   * `dispatchCardSession` whenever the drain's payload carries an `adopted`
   * folder — closing the same race for the background drain path, without the
   * caller waiting on the 250ms `onFolderAdopted` debounce. OPTIONAL (staged
   * rollout, same shape as `dispatchCardSession`/`bootPromptLabels`).
   */
  registerFolder?(payload: AdoptedFolderInput): void
  /**
   * T113: the localized boot-prompt labels (`roadmap.boot.*`) the main-process
   * drain needs to build a dispatch prompt — i18n lives in the renderer, so the
   * drain asks over the bridge. OPTIONAL like the above.
   */
  bootPromptLabels?(): Record<string, string>
  /**
   * T116 `notify`: append an agent-authored record ("Session says") to the
   * notification history (`stores/notifications.ts`) — persisted, cross-session,
   * read-only until the operator marks it read or follows its `sessionId`
   * deep-link. Returns the minted record id. OPTIONAL (staged rollout, same
   * shape as `dispatchCardSession` above): un-wired ⇒ the
   * op surfaces `{ ok: false, error }`, never a silent no-op.
   */
  notifyAgent?(input: {
    folderPath: string
    title: string
    description?: string
    kind: NotifyKind
    sessionId?: string
  }): string
  /**
   * T215 `session.wake`: queue a BACKGROUND resume of a parked session — the
   * same `claude --resume` path a selection would take, minus the selection.
   * Returns `false` when the id names no session in the model (the model can
   * move between the gate and this actuation), so an unknown id surfaces as
   * `FOLDER_NOT_FOUND` rather than a silent success. OPTIONAL (staged rollout,
   * same shape as `notifyAgent`): un-wired ⇒ the op surfaces
   * `{ ok: false, error }`, never a silent no-op.
   */
  wakeSession?(sessionId: string): boolean
  /**
   * T238 `speech.say`: the live voice-engine + attention state the focus rule
   * reads. A GETTER rather than fields so the router always sees the state at
   * dispatch time — an utterance queued behind a slow bridge round-trip must be
   * judged against where the operator is NOW, not where they were when main
   * started the call. OPTIONAL (same staged-rollout shape as `notifyAgent`).
   */
  speechContext?(): {
    enabled: boolean
    muted: boolean
    windowFocused: boolean
    selectedId: string | null
  }
  /**
   * T238 `speech.say`: hand a GATED utterance to the engine. Fire-and-forget —
   * the engine's queue owns ordering and the ACK must not wait on audio, which
   * can run for tens of seconds. Never called for an utterance the focus rule
   * or the mute already dropped; the decision lives in the router so it is
   * testable, not in the shell.
   */
  speakUtterance?(input: { text: string; sessionId?: string; focus: SpeechFocus }): void
  /** Injectable id source threaded into {@link makeAgentSession} (default `crypto.randomUUID`). */
  genId?: IdGen
}

/** Success of `session.create`: the fresh synthetic + its correlation token. */
export interface SessionCreatedResult {
  syntheticId: string
  correlationId: string
}

/** Success of `pane.split`: the appended helper pane's id. */
export interface PaneSplitResult {
  paneId: string
}

/** Success of `session.dispatchCard` (T113): the drain-spawned synthetic's id. */
export interface DispatchCardResult {
  sessionId: string
}

/** Success of `roadmap.bootLabels` (T113): the renderer-localized labels. */
export interface BootLabelsResult {
  labels: Record<string, string>
}

/** Success of `notify.push` (T116): the minted notification record id. */
export interface NotifyPushResult {
  id: string
}

/**
 * Success of `session.wake` (T215): the resume was QUEUED, not completed.
 * Main does not treat this ack as the wake — it waits for the session's real
 * `pty:sessionReady`, because a `claude --resume` of a long transcript can take
 * far longer than the bridge would ever hold a request open.
 */
export interface SessionWakeResult {
  queued: true
}

/**
 * Success of `speech.say` (T238). `spoken:false` is a SUCCESS, not a failure —
 * the utterance was correctly dropped, and `reason` says by which rule, so the
 * verb's ACK can tell the agent that rather than leaving it to retry.
 */
export interface SpeechSayResult {
  spoken: boolean
  reason?: 'engine-off' | 'muted' | 'focused'
}

/** Success of `pane.closeFile`: the closed pane's id, or a no-op marker. */
export type CloseFileResult = { paneId: string } | { closed: false }
/** Success of `pane.closePane`: whether a pane was actually found and closed. */
export type ClosePaneResult = { closed: boolean }

/** A recognized validation failure with a stable code. */
export interface CommandError {
  error: string
}

/** An unexpected failure: an injected action threw. */
export interface ThrownError {
  ok: false
  error: string
}

/** Every shape `dispatch` can return; discriminated by key presence. */
export type DispatchResult =
  | SessionCreatedResult
  | PaneSplitResult
  | DispatchCardResult
  | BootLabelsResult
  | NotifyPushResult
  | SpeechSayResult
  | SessionWakeResult
  | CloseFileResult
  | ClosePaneResult
  | CommandError
  | ThrownError

/** A bound dispatcher: maps `(command, payload)` to a {@link DispatchResult}. */
export type CommandRouter = (command: string, payload: unknown) => DispatchResult

const BAD_ARGS: CommandError = { error: 'BAD_ARGS' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * `session.create`: mint a fresh, non-deduped agent synthetic in a KNOWN folder
 * (via {@link makeAgentSession}, T16) and hand it to the store. Validates the
 * folder shape FIRST (`BAD_ARGS`), then existence (`FOLDER_NOT_FOUND`), so a
 * malformed call never reaches the store.
 */
function handleSessionCreate(actions: CommandRouterActions, payload: unknown): DispatchResult {
  if (!isRecord(payload) || !isNonEmptyString(payload.folder)) return BAD_ARGS
  if (payload.prePrompt !== undefined && typeof payload.prePrompt !== 'string') return BAD_ARGS

  const folder = payload.folder
  if (!actions.folderExists(folder)) return { error: 'FOLDER_NOT_FOUND' }

  // T33-A′: forward the allowlisted capacity knobs (main already extracted only
  // model/effort into `bootOverride`), so a mission can pick the session's model.
  const boot = isRecord(payload.bootOverride) ? payload.bootOverride : undefined
  const bootOverride = boot
    ? {
        ...(isNonEmptyString(boot.model) ? { model: boot.model } : {}),
        ...(isNonEmptyString(boot.effort) ? { effort: boot.effort } : {})
      }
    : undefined

  const agent = makeAgentSession(folder, actions.genId)
  actions.insertAgentSession(agent, payload.prePrompt, bootOverride)
  return { syntheticId: agent.syntheticId, correlationId: agent.correlationId }
}

/**
 * `pane.split`: append a helper to the TARGET worktree's stack HEADLESSLY — the
 * worktree need not be (and usually isn't) the selected one; the router calls
 * the helper action directly and never selects it first. `kind:'claude'`
 * requires a `sessionId` (it resumes an on-disk uuid); `kind:'shell'` does not.
 * `cwd` defaults to `worktreePath` when omitted.
 */
function handlePaneSplit(actions: CommandRouterActions, payload: unknown): DispatchResult {
  if (!isRecord(payload)) return BAD_ARGS
  if (payload.target !== 'split') return BAD_ARGS
  if (!isNonEmptyString(payload.worktreePath)) return BAD_ARGS

  const worktreePath = payload.worktreePath
  const cwd = isNonEmptyString(payload.cwd) ? payload.cwd : worktreePath

  if (payload.kind === 'shell') {
    return { paneId: actions.addShellHelper(worktreePath, cwd) }
  }
  if (payload.kind === 'claude') {
    if (!isNonEmptyString(payload.sessionId)) return BAD_ARGS
    return { paneId: actions.addResumeHelper(worktreePath, payload.sessionId, cwd) }
  }
  return BAD_ARGS
}

/**
 * `pane.openMarkdown`: open a file-backed viewer in the TARGET worktree's split
 * stack HEADLESSLY (T74 `open_file`) — same background contract as `pane.split`
 * (never selects the worktree first, so an agent open can't steal the operator's
 * focus, T78). Validates the routing fields before touching the store; `cwd`
 * defaults to `worktreePath`. The pane id (new, or the dedup hit) is the
 * action's return, not the input echoed back.
 *
 * **Which viewer (T218 U4).** A `*.capycanvas.json` routes to the canvas pane,
 * everything else to the markdown/text pane. The op name stays `openMarkdown`
 * on purpose: it is the wire contract main already speaks (`tool-handlers.ts`
 * dispatches it, and U5's verb reuses it), and renaming it would be a
 * cross-process break for a routing detail that belongs on this side.
 *
 * The match is on the full SUFFIX and never `extname()` — which yields a bare
 * `.json` for a canvas document and would therefore route every ordinary JSON
 * file an agent opens into the canvas pane (spec §4.1; U4 AC-2). Admission
 * stays with the confined `canvas:read` gate inside the pane, so a MALFORMED
 * board still opens the canvas pane and shows its refusal there rather than
 * silently falling back to the text viewer (U4 AC-4).
 */
function handlePaneOpenMarkdown(actions: CommandRouterActions, payload: unknown): DispatchResult {
  if (!isRecord(payload)) return BAD_ARGS
  if (!isNonEmptyString(payload.worktreePath)) return BAD_ARGS
  if (!isNonEmptyString(payload.filePath)) return BAD_ARGS

  const worktreePath = payload.worktreePath
  const filePath = payload.filePath
  const cwd = isNonEmptyString(payload.cwd) ? payload.cwd : worktreePath
  const open = hasCanvasSuffix(filePath) ? actions.addCanvasHelper : actions.addMarkdownHelper
  return { paneId: open(worktreePath, filePath, cwd) }
}

/**
 * `pane.closeFile`: close a file/folder-backed pane by `path` in the TARGET
 * worktree's stack. Mirrors `handlePaneOpenMarkdown`'s validation shape.
 */
function handlePaneCloseFile(actions: CommandRouterActions, payload: unknown): DispatchResult {
  if (!isRecord(payload)) return BAD_ARGS
  if (!isNonEmptyString(payload.worktreePath)) return BAD_ARGS
  if (!isNonEmptyString(payload.path)) return BAD_ARGS
  const paneId = actions.closeHelperByPath(payload.worktreePath, payload.path)
  return paneId ? { paneId } : { closed: false }
}

/**
 * `pane.closePane`: close ANY pane by id in the TARGET worktree's stack.
 */
function handlePaneClosePane(actions: CommandRouterActions, payload: unknown): DispatchResult {
  if (!isRecord(payload)) return BAD_ARGS
  if (!isNonEmptyString(payload.worktreePath)) return BAD_ARGS
  if (!isNonEmptyString(payload.paneId)) return BAD_ARGS
  return { closed: actions.closeHelperById(payload.worktreePath, payload.paneId) }
}

/**
 * Parse the optional `adopted` field of a `session.dispatchCard` payload
 * (BUG-63). Absent ⇒ a valid no-op (`{ ok: true }`, no `adopted`); present but
 * missing a non-empty `path` ⇒ malformed (`{ ok: false }`) — a caller that
 * bothered to attach the field must have a real folder to register. Unknown/
 * mistyped optional fields are dropped rather than rejected, mirroring the
 * `bootOverride` allowlist above.
 */
function readAdoptedFolder(
  value: unknown
): { ok: true; adopted?: AdoptedFolderInput } | { ok: false } {
  if (value === undefined) return { ok: true }
  if (!isRecord(value) || !isNonEmptyString(value.path)) return { ok: false }
  const adopted: AdoptedFolderInput = { path: value.path }
  if (isNonEmptyString(value.gitBranch)) adopted.gitBranch = value.gitBranch
  if (isNonEmptyString(value.repoId)) adopted.repoId = value.repoId
  if (typeof value.isMainWorktree === 'boolean') adopted.isMainWorktree = value.isMainWorktree
  return { ok: true, adopted }
}

/**
 * `session.dispatchCard` (T113): the background drain's spawn — a board-dispatch
 * synthetic minted WITHOUT selection, boot queued in the background (BUG-23
 * runner). Validates folder + prompt shape first; a `null` from the action
 * (unknown folder — the model can move between the drain's read and this
 * actuation) surfaces as `FOLDER_NOT_FOUND`, never a silent success.
 *
 * BUG-63: an optional `adopted` field carries a just-cut worktree's folder-
 * adoption payload. When present, {@link CommandRouterActions.registerFolder}
 * runs FIRST — synchronously, in this same command — so `dispatchCardSession`'s
 * own folder lookup can never miss the worktree this command is dispatching
 * into, independent of the renderer's 250ms `onFolderAdopted` debounce.
 */
function handleSessionDispatchCard(
  actions: CommandRouterActions,
  payload: unknown
): DispatchResult {
  if (!actions.dispatchCardSession) return { ok: false, error: 'dispatchCardSession not wired' }
  if (!isRecord(payload)) return BAD_ARGS
  if (!isNonEmptyString(payload.folderPath)) return BAD_ARGS
  if (!isNonEmptyString(payload.prompt)) return BAD_ARGS
  const boot = isRecord(payload.bootOverride) ? payload.bootOverride : undefined
  const bootOverride = boot
    ? {
        ...(isNonEmptyString(boot.model) ? { model: boot.model } : {}),
        ...(isNonEmptyString(boot.effort) ? { effort: boot.effort } : {})
      }
    : undefined
  const adoptedResult = readAdoptedFolder(payload.adopted)
  if (!adoptedResult.ok) return BAD_ARGS
  if (adoptedResult.adopted) actions.registerFolder?.(adoptedResult.adopted)
  const sessionId = actions.dispatchCardSession(payload.folderPath, payload.prompt, bootOverride)
  if (!sessionId) return { error: 'FOLDER_NOT_FOUND' }
  return { sessionId }
}

/** `roadmap.bootLabels` (T113): hand main the renderer-localized boot-prompt labels. */
function handleBootLabels(actions: CommandRouterActions): DispatchResult {
  if (!actions.bootPromptLabels) return { ok: false, error: 'bootPromptLabels not wired' }
  return { labels: actions.bootPromptLabels() }
}

const NOTIFY_KINDS: ReadonlySet<string> = new Set(['info', 'success', 'warning', 'danger'])

/**
 * `notify.push` (T116): append an agent-authored "Session says" record.
 * `kind` falls back to `'info'` for anything unrecognized rather than
 * rejecting the call — a cosmetic default, not a validation boundary.
 */
function handleNotifyPush(actions: CommandRouterActions, payload: unknown): DispatchResult {
  if (!actions.notifyAgent) return { ok: false, error: 'notifyAgent not wired' }
  if (!isRecord(payload)) return BAD_ARGS
  if (!isNonEmptyString(payload.folderPath)) return BAD_ARGS
  if (!isNonEmptyString(payload.title)) return BAD_ARGS
  if (payload.description !== undefined && typeof payload.description !== 'string') return BAD_ARGS
  if (payload.sessionId !== undefined && !isNonEmptyString(payload.sessionId)) return BAD_ARGS

  const kind: NotifyKind =
    isNonEmptyString(payload.kind) && NOTIFY_KINDS.has(payload.kind)
      ? (payload.kind as NotifyKind)
      : 'info'

  const id = actions.notifyAgent({
    folderPath: payload.folderPath,
    title: payload.title,
    ...(isNonEmptyString(payload.description) ? { description: payload.description } : {}),
    kind,
    ...(isNonEmptyString(payload.sessionId) ? { sessionId: payload.sessionId } : {})
  })
  return { id }
}

/**
 * `speech.say` (T238): speak one line, and leave NOTHING behind.
 *
 * The focus rule is applied here because this is the only side that knows where
 * the operator is looking: an AGENT-initiated utterance is dropped for the
 * session they are already staring at (window focused AND that session selected)
 * — they can read it. `shouldSpeak` is the engine's own pure rule (`lib/speech-focus.ts`),
 * reused rather than restated, so voice has one definition of "only speak what
 * you cannot see".
 *
 * A dropped utterance acks `{ spoken: false, reason }`, never an error: nothing
 * went wrong, and an agent that read a refusal here would retry a line the
 * operator can already see.
 */
function handleSpeechSay(actions: CommandRouterActions, payload: unknown): DispatchResult {
  if (!actions.speechContext || !actions.speakUtterance) {
    return { ok: false, error: 'speakUtterance not wired' }
  }
  if (!isRecord(payload)) return BAD_ARGS
  if (!isNonEmptyString(payload.folderPath)) return BAD_ARGS
  if (!isNonEmptyString(payload.text)) return BAD_ARGS
  if (payload.sessionId !== undefined && !isNonEmptyString(payload.sessionId)) return BAD_ARGS
  const sessionId = isNonEmptyString(payload.sessionId) ? payload.sessionId : undefined

  const ctx = actions.speechContext()
  const focus: SpeechFocus = {
    windowFocused: ctx.windowFocused,
    // No sessionId means the caller did not identify itself, so it can never BE
    // the selected session — the focus rule cannot suppress what it cannot match.
    isSelected: sessionId !== undefined && ctx.selectedId === sessionId
  }
  if (!shouldSpeak({ source: 'agent', enabled: ctx.enabled, muted: ctx.muted, ...focus })) {
    return {
      spoken: false,
      reason: !ctx.enabled ? 'engine-off' : ctx.muted ? 'muted' : 'focused'
    }
  }

  actions.speakUtterance({ text: payload.text, ...(sessionId ? { sessionId } : {}), focus })
  return { spoken: true }
}

/**
 * `session.wake` (T215): queue a headless background resume of `sessionId`.
 *
 * Deliberately does NOT select the session. The whole point of routing the
 * wake through the renderer is to reuse the ordinary `activate()`/resume
 * machinery without inheriting selection's side effects — an agent messaging a
 * parked peer must not move the operator's view.
 *
 * Acks `{ queued: true }` as soon as the resume is enqueued. The real
 * completion signal is `pty:sessionReady`, which main awaits on its own side.
 */
function handleSessionWake(actions: CommandRouterActions, payload: unknown): DispatchResult {
  if (!actions.wakeSession) return { ok: false, error: 'wakeSession not wired' }
  if (!isRecord(payload)) return BAD_ARGS
  if (!isNonEmptyString(payload.sessionId)) return BAD_ARGS
  if (!actions.wakeSession(payload.sessionId)) return { error: 'FOLDER_NOT_FOUND' }
  return { queued: true }
}

/**
 * Build a pure command dispatcher over injected store actions.
 *
 * The returned `dispatch(command, payload)` validates `payload` per op, performs
 * the matching store mutation, and returns a {@link DispatchResult}. Validation
 * failures return a `{ error: <CODE> }`; any thrown action is caught and reported
 * as `{ ok: false, error }` so an unexpected blow-up never escapes the router.
 *
 * @param actions - the injected, side-effecting store collaborators.
 * @returns a bound {@link CommandRouter}.
 */
export function makeCommandRouter(actions: CommandRouterActions): CommandRouter {
  return function dispatch(command: string, payload: unknown): DispatchResult {
    try {
      switch (command) {
        case 'session.create':
          return handleSessionCreate(actions, payload)
        case 'session.dispatchCard':
          return handleSessionDispatchCard(actions, payload)
        case 'pane.split':
          return handlePaneSplit(actions, payload)
        case 'pane.openMarkdown':
          return handlePaneOpenMarkdown(actions, payload)
        case 'pane.closeFile':
          return handlePaneCloseFile(actions, payload)
        case 'pane.closePane':
          return handlePaneClosePane(actions, payload)
        case 'roadmap.bootLabels':
          return handleBootLabels(actions)
        case 'notify.push':
          return handleNotifyPush(actions, payload)
        case 'speech.say':
          return handleSpeechSay(actions, payload)
        case 'session.wake':
          return handleSessionWake(actions, payload)
        default:
          return BAD_ARGS
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
