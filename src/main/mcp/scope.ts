/**
 * Missions v4 S-25 (AC-64, AC-65) — the scoped credential of the sessions Harnu spawns (BUG-253).
 *
 * Until now a session Harnu spawned for an agent held no `mcp__harnu__` verb at all (the MCP config is
 * withheld from an agent-controlled spawn so an agent cannot start a recursive Conductor). That left a
 * dispatched worker, a verifier and the Scheduler's observe worker with no way to read their mission,
 * link their pull request, say they are blocked or settle a criterion. This module gives each of them a
 * credential of its own, in the shape of the retired steward's bearer: derived from the
 * server secret, never the secret itself, never shown to the model (it lives in a 0600 config file the
 * `claude` process reads; argv carries only the file's path).
 *
 * Three roles, and no role can lead, attach itself or touch another mission (spec "Sessions Harnu
 * spawns"):
 *
 * | role       | verbs                                                                    | bound to                   |
 * | ---------- | ------------------------------------------------------------------------ | -------------------------- |
 * | `worker`   | `mission_get`, `mission_link`, `mission_log`, `mission_set_blocker`,     | one session, mission, step |
 * |            | `mission_settle_ac` (a claim only: it built the step, it never settles)  |                            |
 * | `verifier` | the same; its `mission_settle_ac` settles a step it did not build        | one session, mission, step |
 * | `observer` | the observe allowlist's read verbs (`OBSERVE_MCP_ALLOW`), `mission_get`, `mission_list` | one folder |
 *
 * **The session id comes from the credential, never from the call** (AC-65): a worker or verifier is the
 * session id minted into its bearer, so a verifier that built its step is a builder (its check reads as
 * a self-check) whatever `sessionId` an argument says. An ordinary session (one the operator started)
 * has no credential and still declares its own id, as S-24 built it.
 *
 * **A worker writes only its own step** (C3-60): a step it names must be its own, one it leaves out
 * defaults to its own, and a mission or folder that is not the one in its credential is refused. Every
 * refusal is `CODE: what to do next`.
 *
 * Pure apart from the pending-spawn registry at the bottom (an in-memory list). The server recognises a
 * bearer (`mcp/server.ts`), the argv injection is `pty.ts`'s, and the files a config lives in are the
 * server's; this module only says who a credential is and what that caller may do.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import * as path from 'node:path'
import { mcpToolName } from './config-file'
import { OBSERVE_MCP_ALLOW } from '../scheduler-core'
import { MCP_TOOLS } from './tool-catalog'

// ---- Roles and what each holds ---------------------------------------------------------

export type ScopedRole = 'worker' | 'verifier' | 'observer'

/** What a credential proves: who the caller is and the one thing it is bound to. */
export type Scope =
  | {
      role: 'worker' | 'verifier'
      /** The Claude session this credential was minted for: the caller's id, whatever a call says. */
      sessionId: string
      /** The folder the session was spawned in. */
      folder: string
      missionId: string
      stepId: string
    }
  | { role: 'observer'; folder: string }

/**
 * What an observe tick may call, by name: the allowlist the Scheduler's tick already uses
 * (`OBSERVE_MCP_ALLOW`, the one source), with the server-name prefix taken off. A verb added to that
 * allowlist is allowed to the observer in the same edit, and one that is not on it is refused to both.
 */
const OBSERVER_VERBS: readonly string[] = OBSERVE_MCP_ALLOW.filter((n) =>
  n.startsWith(mcpToolName(''))
).map((n) => n.slice(mcpToolName('').length))

/**
 * What a session bound to one step may call. Both step roles hold the same verbs; what differs is what
 * `mission_settle_ac` does for each ({@link claimsOnly}).
 */
const STEP_ROLE_VERBS: readonly string[] = [
  'mission_get',
  'mission_link',
  'mission_log',
  'mission_set_blocker',
  'mission_settle_ac'
]

/** The verbs each role may call, by name. Everything else is refused, and is not even listed. */
export const SCOPED_VERBS: Readonly<Record<ScopedRole, readonly string[]>> = {
  worker: STEP_ROLE_VERBS,
  verifier: STEP_ROLE_VERBS,
  observer: OBSERVER_VERBS
}

/**
 * A worker built its step by definition, so its `mission_settle_ac` records a claim and never settles,
 * whether or not the dispatch managed to put a `session` link on the step.
 */
export const claimsOnly = (scope: Scope): boolean => scope.role === 'worker'

/** The verbs that write a step: a worker's own step is theirs, and only theirs. */
const STEP_VERBS: ReadonlySet<string> = new Set([
  'mission_link',
  'mission_log',
  'mission_set_blocker',
  'mission_settle_ac'
])

/** `mcp__harnu__<verb>` for each verb of the role: the `--allowedTools` rules of the spawned session. */
export function scopedAllowedTools(scope: Scope): string[] {
  return SCOPED_VERBS[scope.role].map((verb) => mcpToolName(verb))
}

// ---- The credential --------------------------------------------------------------------

const PREFIX = 'scp_'
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function canonical(scope: Scope): string {
  return JSON.stringify(
    scope.role === 'observer'
      ? { role: scope.role, folder: scope.folder }
      : {
          role: scope.role,
          sessionId: scope.sessionId,
          folder: scope.folder,
          missionId: scope.missionId,
          stepId: scope.stepId
        }
  )
}

const macOf = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(`scoped:${payload}`).digest('hex')

/** The bearer a spawned session presents: `scp_<payload>.<hmac>`. Derived from the secret; not the secret. */
export function mintScopedBearer(secret: string, scope: Scope): string {
  const payload = Buffer.from(canonical(scope), 'utf8').toString('base64url')
  return `${PREFIX}${payload}.${macOf(secret, payload)}`
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** The scope a bearer was minted for, or `null` for anything else (the main secret, a forgery, garbage). */
export function verifyScopedBearer(secret: string, presented: string): Scope | null {
  if (!presented.startsWith(PREFIX)) return null
  const body = presented.slice(PREFIX.length)
  const cut = body.lastIndexOf('.')
  if (cut <= 0) return null
  const payload = body.slice(0, cut)
  const given = Buffer.from(body.slice(cut + 1), 'utf8')
  const want = Buffer.from(macOf(secret, payload), 'utf8')
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  const folder = str(raw.folder)
  if (!folder) return null
  if (raw.role === 'observer') return { role: 'observer', folder }
  const sessionId = str(raw.sessionId)
  const missionId = str(raw.missionId)
  const stepId = str(raw.stepId)
  if ((raw.role !== 'worker' && raw.role !== 'verifier') || !sessionId || !missionId || !stepId) {
    return null
  }
  if (!SESSION_UUID.test(sessionId)) return null
  return { role: raw.role, sessionId, folder, missionId, stepId }
}

/** A short, non-reversible handle on a credential: what the server keys an MCP session by. */
export function scopeKey(scope: Scope): string {
  return scope.role === 'observer'
    ? `scoped:observer:${scope.folder}`
    : `scoped:${scope.role}:${scope.sessionId}:${scope.missionId}:${scope.stepId}`
}

// ---- What a caller may do --------------------------------------------------------------

const samePath = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b)

/**
 * Which folder a pane or a terminal belongs to, as the registries know it (the server supplies them: this
 * module stays free of electron). `undefined` is "no such pane": the verb answers that itself.
 */
export interface ScopeLookups {
  paneFolder?: (paneId: string) => string | undefined
  terminalFolder?: (terminalId: string) => string | undefined
}

/** The keys a verb's catalog schema takes (looking through a refine), so "addresses a pane" is read, not listed. */
function schemaKeys(op: string): Set<string> {
  let schema = MCP_TOOLS.find((t) => t.name === op)?.inputSchema as unknown as
    { _def?: { schema?: unknown }; shape?: Record<string, unknown> } | undefined
  while (schema?._def?.schema) schema = schema._def.schema as typeof schema
  return new Set(Object.keys(schema?.shape ?? {}))
}

/** The list verbs that take an optional `folder`: left out, it is the observer's own, never "every folder". */
const OBSERVER_DEFAULT_FOLDER: ReadonlySet<string> = new Set([
  'browser_list',
  'list_terminals',
  'list_worktrees',
  'list_containers',
  'list_cleanup'
])

export type ScopeCall = { ok: true; args: Record<string, unknown> } | { ok: false; error: string }

const refuse = (code: string, message: string): ScopeCall => ({
  ok: false,
  error: `${code}: ${message}`
})

/**
 * Judge one verb call made on a scoped credential: the refusal, or the arguments to run with. A verb
 * outside the role is refused; a `folder` other than the credential's is refused; for a worker or a
 * verifier a `missionId` other than its own is refused and a `stepId` other than its own is refused (a
 * `stepId` it leaves out is its own, so a link or a log lands on the step and never on the mission).
 * Never reads a session id from the call: the caller's is in the credential.
 */
export function scopeCallRefusal(input: {
  op: string
  args: Record<string, unknown>
  scope: Scope
  lookups: ScopeLookups
}): ScopeCall {
  const { op, scope } = input
  const args = { ...input.args }
  const allowed = SCOPED_VERBS[scope.role]
  if (!allowed.includes(op)) {
    return refuse(
      'SCOPE_VERB_NOT_ALLOWED',
      scope.role === 'observer'
        ? `this is an observe tick, so it may call only the read verbs of the observe list; ${op} is outside it. It never writes: say what you found in your result.`
        : `this session was started for one step of ${scope.missionId}, so it may call only ${allowed.join(', ')}; ${op} is outside that. Leading, attaching and planning are the leader's and the operator's: say what you need in mission_log or mission_set_blocker.`
    )
  }
  const folder = args.folder
  if (typeof folder === 'string' && folder !== '' && !samePath(folder, scope.folder)) {
    return refuse(
      'SCOPE_FOLDER',
      `this session is bound to ${scope.folder}; ${folder} is another folder. Pass folder: ${scope.folder}.`
    )
  }
  // A mission verb reads the repo of the folder it is given, so a folder left out is the worker's own and
  // never "every repo"; any other verb keeps what it was given (a folder it names must be its own).
  if (
    op.startsWith('mission_') ||
    op.startsWith('campaign_') ||
    scope.role !== 'observer' ||
    OBSERVER_DEFAULT_FOLDER.has(op)
  ) {
    args.folder = scope.folder
  }
  if (scope.role === 'observer') {
    // A pane or a terminal is addressed by id and carries its own folder: the observer reaches only those of
    // its folder (readers too), whatever `folder` it passes. An id the registry does not know is the
    // verb's own PANE_NOT_FOUND / TERMINAL_NOT_FOUND.
    const keys = schemaKeys(op)
    for (const [key, lookup, noun] of [
      ['paneId', input.lookups.paneFolder, 'pane'],
      ['terminalId', input.lookups.terminalFolder, 'terminal']
    ] as const) {
      const id = args[key]
      if (!keys.has(key) || typeof id !== 'string' || id === '') continue
      const owner = lookup ? lookup(id) : scope.folder
      if (lookup === undefined) {
        return refuse(
          'SCOPE_FOLDER',
          `this session cannot tell which folder ${noun} ${id} belongs to, so it does not reach it.`
        )
      }
      if (owner !== undefined && !samePath(owner, scope.folder)) {
        return refuse(
          'SCOPE_FOLDER',
          `${noun} ${id} belongs to another folder; this session reaches only the ${noun}s of ${scope.folder}.`
        )
      }
    }
    return { ok: true, args }
  }

  const missionId = args.missionId
  if (typeof missionId === 'string' && missionId !== '' && missionId !== scope.missionId) {
    return refuse(
      'SCOPE_MISSION',
      `this session works on ${scope.missionId} only; ${missionId} is another mission. Pass missionId: ${scope.missionId}.`
    )
  }
  args.missionId = scope.missionId

  if (STEP_VERBS.has(op)) {
    const stepId = args.stepId
    if (typeof stepId === 'string' && stepId !== '' && stepId !== scope.stepId) {
      return refuse(
        'SCOPE_STEP',
        `this session writes its own step (${scope.stepId}) only; ${stepId} is another step. Pass stepId: ${scope.stepId}, or tell the leader in mission_log.`
      )
    }
    args.stepId = scope.stepId
  }
  return { ok: true, args }
}

// ---- A spawn waiting for its credential ------------------------------------------------

/** What `create_session` asks for, held until the spawn it describes reaches `pty:create`. */
export interface PendingSpawn {
  role: 'worker' | 'verifier'
  missionId: string
  stepId: string
}

const PENDING_TTL_MS = 120_000
/** A card's note is matched by its exact boot prompt, so it can outlast the operator's confirm. */
const CARD_TTL_MS = 30 * 60_000

interface Note {
  spawn: PendingSpawn
  expires: number
  /** The folder it spawns in; absent for a card whose worktree does not exist yet. */
  folder?: string
  /** A card's boot prompt, trimmed: the one thing that tells two cards of a folder apart. */
  prompt?: string
  /** `create_session`'s: only the agent-controlled spawn it asked for may take it. */
  agentOnly?: boolean
}

let notes: Note[] = []
const keyOf = (folder: string): string => path.resolve(folder)

const live = (now: number): Note[] => (notes = notes.filter((n) => n.expires > now))

/**
 * Remember that the next agent spawn in `folder` is a worker or a verifier. One create_session is in
 * flight per folder (the single-occupancy reservation), so the folder is a sound key, and a later
 * call for the same folder replaces an earlier one that never spawned.
 */
export function registerPendingSpawn(
  folder: string,
  spawn: PendingSpawn,
  now = Date.now(),
  opts: { agentOnly?: boolean } = {}
): void {
  const key = keyOf(folder)
  notes = live(now).filter((n) => n.folder !== key || n.prompt !== undefined)
  notes.push({
    spawn,
    folder: key,
    expires: now + PENDING_TTL_MS,
    ...(opts.agentOnly ? { agentOnly: true } : {})
  })
}

/**
 * Remember that the session a card's dispatch is about to spawn is a worker of the card's step. Cards
 * share a folder and boot one after another, so a note is told apart by the boot prompt (a later note
 * for the same prompt replaces the earlier one). `folder` is left out when the card is cut into a
 * worktree that does not exist yet. Returns the function that takes the note back.
 */
export function registerCardSpawn(
  note: { spawn: PendingSpawn; folder?: string; prompt?: string },
  now = Date.now()
): () => void {
  const prompt = note.prompt?.trim()
  const folder = note.folder === undefined ? undefined : keyOf(note.folder)
  notes = live(now).filter((n) =>
    prompt ? n.prompt !== prompt : n.folder !== folder || n.prompt !== undefined
  )
  const added: Note = {
    spawn: note.spawn,
    expires: now + (prompt ? CARD_TTL_MS : PENDING_TTL_MS),
    ...(folder !== undefined ? { folder } : {}),
    ...(prompt ? { prompt } : {})
  }
  notes.push(added)
  return () => {
    notes = notes.filter((n) => n !== added)
  }
}

/**
 * Take (and forget) the note of a spawn in `folder`, or `undefined` when none is for it or it expired.
 * `claim` is what the spawn says of itself. An agent-controlled spawn (`create_session`) takes only a
 * note of its folder that is not a card's. Any other agent spawn is a card's dispatch: it takes the
 * note of its boot prompt first, whatever folder it spawns in, and else a note of its folder that
 * names no prompt. With no `claim`, any note of the folder.
 */
export function takePendingSpawn(
  folder: string,
  now = Date.now(),
  claim?: { agentControlled?: boolean; prompt?: string }
): PendingSpawn | undefined {
  const key = keyOf(folder)
  const waiting = live(now)
  const inFolder = (n: Note): boolean => n.folder === key
  const unprompted = (n: Note): boolean => inFolder(n) && n.prompt === undefined
  const prompt = claim?.prompt?.trim()
  let found: Note | undefined
  if (!claim) found = waiting.find(inFolder)
  else if (claim.agentControlled) found = waiting.find(unprompted)
  else {
    const byPrompt = (n: Note): boolean => !!prompt && n.prompt === prompt
    found =
      waiting.find((n) => inFolder(n) && byPrompt(n)) ??
      waiting.find(byPrompt) ??
      waiting.find((n) => unprompted(n) && !n.agentOnly)
  }
  if (found) notes = notes.filter((n) => n !== found)
  return found?.spawn
}

/** Forget the notes of `folder` that are not a card's (a create_session that failed before it spawned). */
export function dropPendingSpawn(folder: string): void {
  const key = keyOf(folder)
  notes = notes.filter((n) => n.folder !== key || n.prompt !== undefined)
}

/** What the spawned session is told about itself: one line, in its system prompt, never a user turn. */
export function scopedSpawnLine(spawn: PendingSpawn): string {
  const verbs = SCOPED_VERBS[spawn.role].join(', ')
  const own =
    spawn.role === 'verifier'
      ? 'You may settle a criterion of that step you did not build'
      : 'You write only that step, and mission_settle_ac there records a claim the operator accepts'
  return `Harnu started this session as the ${spawn.role} of step ${spawn.stepId} of mission ${spawn.missionId}. Your only Harnu verbs are ${verbs}. ${own}; the leader and the operator do everything else, so when you need something from them, say it with mission_log or mission_set_blocker on your step. Your session id is part of your credential: you never pass one.`
}
