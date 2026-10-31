/**
 * Campaign ch.5a (T597, spec §3.4) — the Steward: a Harnu-owned system worker bound to ONE mission.
 *
 * This module is the pure core (ADR-0001): the allowlist as data, the per-steward bearer the MCP
 * server recognises, the server-side refusals, the kill-switch gate and the worker's shape. The
 * env-bound halves live in `scheduler-shell.ts` (the ticks), `steward-shell.ts` (lifecycle +
 * hooks on disk) and `mcp/server.ts` (the bearer and the refusals on the wire).
 *
 * Why a bearer per steward. The MCP transport has no per-session identity, and a CLI-level
 * `--allowedTools` cannot constrain a verb's ARGUMENTS ("create_session, but only as a
 * verifier"). So each steward tick gets its own MCP config whose bearer is derived from the
 * server secret and the worker id: the server recognises the caller, and enforces the allowlist
 * and the argument rules itself, so the closed scope does not depend on the model obeying argv.
 * Deleting the worker kills its bearer.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { MCP_TOOLS } from './mcp/tool-catalog'
import { MCP_SERVER_NAMES, mcpToolName } from './mcp/config-file'
import type { Worker } from './scheduler-core'

/** The 20-minute fallback beat (spec §3.4): events wake a steward sooner, this bounds the silence. */
export const STEWARD_EVERY_MINUTES = 20

/** Built-in tools a steward tick loads: read-only. No shell, no write, no network. */
export const STEWARD_NATIVE_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'Skill']

const CATALOG_VERBS: readonly string[] = MCP_TOOLS.map((t) => t.name)

/**
 * Verbs a steward may call, by name (spec §3.4): every `mission_*`, `campaign_get`,
 * `message_session`, `notify`, `create_session` (verifier sessions only — see
 * {@link stewardCallRefusal}) and `rebase_stack`. The `mission_*` set is read from the catalog,
 * so a mission verb added later joins it; everything else is a closed list.
 */
export const STEWARD_ALLOW_VERBS: readonly string[] = [
  ...CATALOG_VERBS.filter((v) => v.startsWith('mission_')),
  'campaign_get',
  'message_session',
  'notify',
  'create_session',
  'rebase_stack'
]

function underAllServerNames(verbs: readonly string[]): readonly string[] {
  return MCP_SERVER_NAMES.flatMap((server) => verbs.map((verb) => mcpToolName(verb, server)))
}

/** `mcp__<server>__<verb>` for every allowed verb, under both server names. */
export const STEWARD_MCP_ALLOW: readonly string[] = underAllServerNames(STEWARD_ALLOW_VERBS)

/**
 * Every catalog verb that is NOT allowed, under both prefixes — derived, never hand-curated (the
 * same mechanism and reason as `OBSERVE_MCP_DENY`): a verb added tomorrow is denied to a steward
 * until someone allows it by name.
 */
export const STEWARD_MCP_DENY: readonly string[] = underAllServerNames(
  CATALOG_VERBS.filter((v) => !STEWARD_ALLOW_VERBS.includes(v))
)

// ── the per-steward bearer ───────────────────────────────────────────────────

const BEARER_PREFIX = 'stw_'

function mac(secret: string, workerId: string): string {
  return createHmac('sha256', secret).update(`steward:${workerId}`).digest('hex')
}

/** The bearer a steward tick presents: `stw_<workerId>_<hmac>`. Not the server secret. */
export function stewardBearer(secret: string, workerId: string): string {
  return `${BEARER_PREFIX}${workerId}_${mac(secret, workerId)}`
}

/** The worker id a steward bearer was minted for, or `null` for anything else (including the main secret). */
export function verifyStewardBearer(secret: string, presented: string): string | null {
  if (!presented.startsWith(BEARER_PREFIX)) return null
  const body = presented.slice(BEARER_PREFIX.length)
  const cut = body.lastIndexOf('_')
  if (cut <= 0) return null
  const workerId = body.slice(0, cut)
  const given = Buffer.from(body.slice(cut + 1), 'utf8')
  const want = Buffer.from(mac(secret, workerId), 'utf8')
  if (given.length !== want.length) return null
  return timingSafeEqual(given, want) ? workerId : null
}

// ── server-side refusals ─────────────────────────────────────────────────────

/** Mission verbs that name no mission to scope: a steward never mints or imports one. */
const UNSCOPED_MISSION_WRITES: ReadonlySet<string> = new Set([
  'mission_create',
  'mission_import_legacy'
])

/**
 * The refusal (or `null`) for one verb call made by the steward bound to `missionId`. Enforced on
 * the server for a recognised steward caller, in addition to the argv allowlist.
 */
export function stewardCallRefusal(input: {
  op: string
  args: Record<string, unknown>
  missionId: string
}): string | null {
  const { op, args, missionId } = input
  if (!STEWARD_ALLOW_VERBS.includes(op)) {
    return `STEWARD_VERB_NOT_ALLOWED: a steward may call only its mission verbs, campaign_get, message_session, notify, create_session (role: 'verifier') and rebase_stack — ${op} is outside that list.`
  }
  if (op === 'create_session' && args.role !== 'verifier') {
    return "STEWARD_ROLE_REQUIRED: a steward may create a session only to verify — pass role: 'verifier'."
  }
  if (UNSCOPED_MISSION_WRITES.has(op)) {
    return `STEWARD_SCOPE: a steward works on its own mission (${missionId}) only — it does not call ${op}.`
  }
  if (op.startsWith('mission_') || op === 'rebase_stack') {
    const named = args.missionId
    if (typeof named === 'string' && named !== missionId) {
      return `STEWARD_SCOPE: a steward works on its own mission (${missionId}) only — ${named} is not it.`
    }
  }
  return null
}

// ── kill-switches ────────────────────────────────────────────────────────────

/**
 * Why a steward must NOT tick right now, or `null`. The global switches apply to it exactly as
 * to every agent (spec §3.4): agent control off and a blocked folder both stop it. The category
 * prevents a mission's guarantees vanishing through a worker toggle — not the operator's
 * kill-switches.
 */
export function stewardBlockedReason(input: {
  serverEnabled: boolean
  folderDenied: boolean
}): string | null {
  if (!input.serverEnabled) {
    return 'SERVER_DISABLED: agent control is off — the steward does not tick.'
  }
  if (input.folderDenied) {
    return 'FOLDER_NOT_ALLOWED: the operator blocked this folder for agents — the steward does not tick.'
  }
  return null
}

// ── wake-ups ─────────────────────────────────────────────────────────────────

/** Why a steward was woken: a mission event, or the Scheduler's 20-minute beat. */
export type WakeReason = 'ledger' | 'ci' | 'child-idle' | 'blocker-cleared' | 'fallback'

/** Events closer together than this coalesce into one tick (one trailing start after the gap). */
export const STEWARD_WAKE_GAP_MS = 60_000

export type WakeDecision =
  { action: 'start' } | { action: 'defer'; inMs: number } | { action: 'skip'; reason: string }

/**
 * Start now, defer, or skip. A burst of events (a PR opening writes a ledger row, then CI writes
 * another) must not become a burst of `claude` processes, but it must not be dropped either: the
 * LAST event of a burst may be the one the running tick has not seen, so the answer is a single
 * trailing start at the end of the gap.
 */
export function wakeDecision(input: {
  enabled: boolean
  running: boolean
  blockedReason: string | null
  now: number
  lastStartedAt: number | undefined
  gapMs: number
}): WakeDecision {
  if (!input.enabled) return { action: 'skip', reason: 'the steward is disabled' }
  if (input.blockedReason) return { action: 'skip', reason: input.blockedReason }
  if (input.running) return { action: 'defer', inMs: input.gapMs }
  if (input.lastStartedAt !== undefined) {
    const wait = input.lastStartedAt + input.gapMs - input.now
    if (wait > 0) return { action: 'defer', inMs: wait }
  }
  return { action: 'start' }
}

// ── the worker ───────────────────────────────────────────────────────────────

/** The tick's standing instructions. The `delivery-watchdog` → steward-tick skill rewrite is T608. */
export function stewardPrompt(missionId: string): string {
  return [
    `You are the steward of mission ${missionId}. You were woken by a mission event or by the 20-minute fallback.`,
    'Your scope is this mission only. Read it with mission_get (it carries the gates, the ledger and the children), then do ONLY the routine moves below and stop:',
    '1. A step whose PR merged and whose stack is now stale: rebase_stack onto the new base. On REBASE_CONFLICT the verb already set the blocker — do not retry; notify the operator once.',
    "2. A step that is PR-ready with no verifier verdict: create_session with role: 'verifier', then mission_link_child the new session to that step.",
    '3. A linked child that has been idle or stalled: message_session it with the one thing it should do next.',
    '4. A duplicate notice: do not send it.',
    'You never merge, close, choose a decision, tick a check or mark a step verified — those are the operator\'s. Every action you take must be followed by mission_log with kind "steward" saying what you did and why. If nothing needs doing, do nothing and say so in one line.'
  ].join('\n')
}

/** The Scheduler worker a mission's steward is born as: enabled, category `steward`, bound to the mission. */
export function stewardWorkerFor(input: {
  id: string
  missionId: string
  folder: string
  title: string
}): Worker {
  const title = input.title.length > 60 ? `${input.title.slice(0, 59)}…` : input.title
  return {
    id: input.id,
    name: `Steward · ${title}`,
    enabled: true,
    prompt: stewardPrompt(input.missionId),
    folder: input.folder,
    everyMinutes: STEWARD_EVERY_MINUTES,
    runOnBoot: false,
    model: 'sonnet',
    effort: 'low',
    mode: 'steward',
    category: 'steward',
    missionId: input.missionId,
    timeoutSeconds: 600,
    carryLastResult: false,
    notifyOn: 'silent',
    allowNetwork: false,
    failureStreak: 0
  }
}
