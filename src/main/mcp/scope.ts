/**
 * Missions v4 S-25 (AC-64, AC-65) — the scoped credential of the sessions Harnu spawns (BUG-253).
 *
 * Until now a session Harnu spawned for an agent held no `mcp__harnu__` verb at all (the MCP config is
 * withheld from an agent-controlled spawn so an agent cannot start a recursive Conductor). That left a
 * dispatched worker, a verifier and the Scheduler's observe worker with no way to read their mission,
 * link their pull request, say they are blocked or settle a criterion. This module gives each of them a
 * credential of its own, a generalization of the steward's bearer (`steward-core.ts`): derived from the
 * server secret, never the secret itself, never shown to the model (it lives in a 0600 config file the
 * `claude` process reads; argv carries only the file's path).
 *
 * Three roles, and no role can lead, attach itself or touch another mission (spec "Sessions Harnu
 * spawns"):
 *
 * | role       | verbs                                                                    | bound to                   |
 * | ---------- | ------------------------------------------------------------------------ | -------------------------- |
 * | `worker`   | `mission_get`, `mission_link`, `mission_log`, `mission_set_blocker`      | one session, mission, step |
 * | `verifier` | the worker's, plus `mission_settle_ac`                                   | one session, mission, step |
 * | `observer` | `mission_get`, `mission_list`                                            | one folder                 |
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
 * Pure apart from the pending-spawn registry at the bottom (an in-memory map). The server recognises a
 * bearer (`mcp/server.ts`), the argv injection is `pty.ts`'s, and the files a config lives in are the
 * server's; this module only says who a credential is and what that caller may do.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import * as path from 'node:path'
import { mcpToolName } from './config-file'

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

/** The verbs each role may call, by name. Everything else is refused, and is not even listed. */
export const SCOPED_VERBS: Readonly<Record<ScopedRole, readonly string[]>> = {
  worker: ['mission_get', 'mission_link', 'mission_log', 'mission_set_blocker'],
  verifier: [
    'mission_get',
    'mission_link',
    'mission_log',
    'mission_set_blocker',
    'mission_settle_ac'
  ],
  observer: ['mission_get', 'mission_list']
}

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
}): ScopeCall {
  const { op, scope } = input
  const args = { ...input.args }
  const allowed = SCOPED_VERBS[scope.role]
  if (!allowed.includes(op)) {
    return refuse(
      'SCOPE_VERB_NOT_ALLOWED',
      scope.role === 'observer'
        ? `this session may only read the missions of its folder (${allowed.join(', ')}); ${op} is outside that.`
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
  args.folder = scope.folder
  if (scope.role === 'observer') return { ok: true, args }

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
const pending = new Map<string, { spawn: PendingSpawn; expires: number }>()
const keyOf = (folder: string): string => path.resolve(folder)

/**
 * Remember that the next agent-controlled spawn in `folder` is a worker or a verifier. One create_session
 * is in flight per folder (the single-occupancy reservation), so the folder is a sound key, and a later
 * call for the same folder replaces an earlier one that never spawned.
 */
export function registerPendingSpawn(folder: string, spawn: PendingSpawn, now = Date.now()): void {
  pending.set(keyOf(folder), { spawn, expires: now + PENDING_TTL_MS })
}

/** Take (and forget) the pending spawn of `folder`, or `undefined` when none is waiting or it expired. */
export function takePendingSpawn(folder: string, now = Date.now()): PendingSpawn | undefined {
  const key = keyOf(folder)
  const found = pending.get(key)
  pending.delete(key)
  return found && found.expires > now ? found.spawn : undefined
}

/** Forget the pending spawn of `folder` (a create_session that failed before it spawned). */
export function dropPendingSpawn(folder: string): void {
  pending.delete(keyOf(folder))
}

/** What the spawned session is told about itself: one line, in its system prompt, never a user turn. */
export function scopedSpawnLine(spawn: PendingSpawn): string {
  const verbs = SCOPED_VERBS[spawn.role].join(', ')
  const own =
    spawn.role === 'verifier'
      ? 'You may settle a criterion of that step you did not build'
      : 'You write only that step'
  return `Harnu started this session as the ${spawn.role} of step ${spawn.stepId} of mission ${spawn.missionId}. Your only Harnu verbs are ${verbs}. ${own}; the leader and the operator do everything else, so when you need something from them, say it with mission_log or mission_set_blocker on your step. Your session id is part of your credential: you never pass one.`
}
