/**
 * Missions v4 S-16b (AC-40) — the hand-off: the one thing that changes who leads a mission.
 *
 * **Only the operator hands off** (spec amendment C3-32, R-11). Nothing else starts a session or moves
 * `leads`: a session never asks to lead, an attach joins as `worked`, and high context only produces an
 * OFFER ({@link handoffOffer}, a pure function of two numbers that is given no way to start anything).
 * The door ({@link handOff}) is reached from the pane's confirm dialog and writes as the operator: a
 * session that calls it is refused `OPERATOR_ONLY` before anything starts, and the channel's wrapper
 * ({@link runHandOff}) never reads a caller out of its arguments.
 *
 * **The order is fixed.**
 *
 * 1. Judge the caller, the mission and whether it is open. Nothing has started.
 * 2. Build the first prompt: the mission summary under one instruction line. No resume prompt for the
 *    operator to paste.
 * 3. Start a NORMAL session through the injected starter ({@link bridgeStarter}: `session.dispatchCard`
 *    over the command bridge, which is the operator's way of starting a session, never the
 *    agent-controlled `session.create`) and wait for its REAL id. Nothing is written yet.
 * 4. Write ONCE through the v4 write path: the old leader's entry gets `to`, `stoppedAt` and role
 *    `worked`, the new session is appended as `leads`, one Log entry. The record never has zero or two
 *    leaders, and a start that failed or timed out has changed nothing.
 *
 * Releasing the old session is a change to the record and nothing else: it is not killed, closed or
 * messaged, and no process event releases anyone (Harnu ends every terminal at quit; every leader would
 * be released at each restart). The first v4 write of a mission born in v3 copies it and never modifies
 * the v3 file. Electron-free.
 */

import { repoRoot } from '../data-dir'
import { guardMission, leaderOf, openEntry, type Actor } from './guard'
import type { MissionV4, StoppedAt } from './model'
import { readMissionRecord } from './record-store'
import { applyChange, logEntry, releaseEntry } from './sessions'
import type { StepInput } from './state'
import { buildMissionSummary } from './summary'
import { deriveStepResults, waitingListV4 } from './waiting'
import type { MissionSummaryInput } from './summary'

// ---- The offer ----------------------------------------------------------------------------

/** The context percentage at which Harnu offers "Continue in a new session…" (D-32). */
export const HANDOFF_OFFER_AT = 80
/** "Not now" keeps the offer quiet until the context grows by this many points (D-32). */
export const HANDOFF_QUIET_POINTS = 5

export interface HandoffOffer {
  offer: boolean
  /** The reading the answer was made from, or `null` when there was none. */
  percent: number | null
}

const isReading = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

/**
 * Whether to offer a hand-off. `reading` is the leader's context percentage from a LIVE status-line
 * reading, or `null`/`undefined` when Harnu has none (no session, a stale record, early in a session):
 * with no reading there is no offer. `dismissedAt` is the percentage the operator last said "Not now"
 * at, or `null`. It offers at 80 or more, and after a dismissal only once the context has grown by five
 * points. It returns a value: it is given no way to start a session or write anything.
 */
export function handoffOffer(
  reading: number | null | undefined,
  dismissedAt: number | null | undefined = null
): HandoffOffer {
  if (!isReading(reading)) return { offer: false, percent: null }
  const quiet = isReading(dismissedAt) && reading < dismissedAt + HANDOFF_QUIET_POINTS
  return { offer: reading >= HANDOFF_OFFER_AT && !quiet, percent: reading }
}

/** One live status-line reading: the session and its context percentage (`null` when it has none). */
export interface ContextReading {
  sessionId: string
  contextPercent: number | null
}

/**
 * The leader's context percentage from the LIVE readings only (`getTelemetryPayload().perSession`).
 * `null` when there is no leader, the leader has no live record, or its record holds no percentage:
 * the stale last-known readings are never passed here, so a session that is not running cannot
 * produce an offer.
 */
export function leaderContextPercent(
  live: readonly ContextReading[],
  leaderId: string | null
): number | null {
  if (leaderId === null) return null
  const reading = live.find((r) => r.sessionId === leaderId)?.contextPercent
  return isReading(reading) ? reading : null
}

// ---- The first prompt -------------------------------------------------------------------------

/**
 * The one line that goes above the summary. The new session is attached as the leader as it starts, so
 * its first mission call can land a moment before the record names it: it waits and tries once more.
 */
export const HANDOFF_INSTRUCTION =
  'You are taking over this mission from another session. Harnu attaches you as its leader as this session starts; if a mission tool answers NOT_ATTACHED, wait a moment and try once more. Work from the summary below.'

/**
 * The first prompt of a hand-off session: the instruction, a blank line, the mission summary
 * (at most 8,000 characters, so the whole stays well under the 24,000 an argv token carries).
 */
export function handoffPrompt(
  record: MissionV4,
  log: string,
  opts: MissionSummaryInput = {}
): string {
  return `${HANDOFF_INSTRUCTION}\n\n${buildMissionSummary(record, log, opts).text}`
}

// ---- Starting the session ---------------------------------------------------------------------

export type HandoffStartResult = { ok: true; sessionId: string } | { ok: false; reason: string }

/** Starts a normal session in `folder` with `prompt` and resolves with its REAL id. It may not throw. */
export type HandoffStart = (args: { folder: string; prompt: string }) => Promise<HandoffStartResult>

/** The two things of the command bridge the starter uses. */
export interface HandoffBridge {
  dispatch(command: string, payload: unknown): Promise<unknown>
  awaitMaterialization(
    syntheticId: string,
    timeoutMs: number
  ): Promise<{ sessionId: string } | null>
}

/** How long the door waits for the new session to appear on disk with its real id. */
export const HANDOFF_START_TIMEOUT_MS = 90_000

const LINE_BREAKS = new RegExp('[\\r\\n\\v\\f\\u0085\\u2028\\u2029]+', 'g')
const oneLine = (s: string): string => s.replace(LINE_BREAKS, ' ').slice(0, 120)

/**
 * The starter the app uses: `session.dispatchCard` over the command bridge (the way Harnu starts a
 * normal session for the operator: full permissions, the normal config, no board card and no board
 * state), then the bridge's wait for the real session id. Never `session.create`, which starts an
 * agent-controlled session. Both a refusal and a throw are an answer, never an exception.
 */
export function bridgeStarter(
  bridge: HandoffBridge,
  opts: { timeoutMs?: number } = {}
): HandoffStart {
  const timeoutMs = opts.timeoutMs ?? HANDOFF_START_TIMEOUT_MS
  return async ({ folder, prompt }) => {
    try {
      const ack = (await bridge.dispatch('session.dispatchCard', {
        folderPath: folder,
        prompt
      })) as { sessionId?: unknown; error?: unknown } | null | undefined
      const synthetic = typeof ack?.sessionId === 'string' ? ack.sessionId : ''
      if (synthetic === '') {
        const why = typeof ack?.error === 'string' && ack.error !== '' ? ack.error : 'no session id'
        return { ok: false, reason: oneLine(why) }
      }
      const real = await bridge.awaitMaterialization(synthetic, timeoutMs)
      if (real === null) return { ok: false, reason: 'timeout' }
      if (typeof real.sessionId !== 'string' || real.sessionId === '') {
        return { ok: false, reason: 'no real session id' }
      }
      return { ok: true, sessionId: real.sessionId }
    } catch (err) {
      return { ok: false, reason: oneLine(err instanceof Error ? err.message : String(err)) }
    }
  }
}

// ---- The door -----------------------------------------------------------------------------------

export interface HandoffDeps {
  start: HandoffStart
  /**
   * The facts of each step (card, pull request, worker), so the summary and where the old leader stopped
   * read what Harnu knows. Optional, and best effort: a failure reads as no facts.
   */
  inputs?: (root: string, record: MissionV4) => Promise<Readonly<Record<string, StepInput>>>
}

export type HandoffCode =
  | 'OPERATOR_ONLY'
  | 'READ_ONLY'
  | 'NOT_ATTACHED'
  | 'NOT_LEADER'
  | 'MISSION_CLOSED'
  | 'MISSION_NOT_FOUND'
  | 'MISSION_UNREADABLE'
  | 'WRITE_REFUSED'
  | 'WRITE_CONFLICT'
  | 'TWO_LEADERS'
  | 'BAD_ARGS'
  | 'HANDOFF_START_FAILED'
  | 'HANDOFF_IN_PROGRESS'
  | 'HANDOFF_UNAVAILABLE'
  | 'LEADER_CHANGED'

export interface HandoffRefusal {
  ok: false
  code: HandoffCode | (string & {})
  /** `CODE: what to do`; never the record or a path. */
  error: string
}

export type HandoffResult =
  | {
      ok: true
      changed: true
      /** The new leader: the REAL id the new session has. */
      sessionId: string
      /** The session that led until now, or `null` when the mission had no open leader. */
      previousLeader: string | null
      record: MissionV4
      file: string
    }
  | HandoffRefusal

const refusal = (code: HandoffCode, message: string): HandoffRefusal => ({
  ok: false,
  code,
  error: `${code}: ${message}`
})

/** A real Claude session id. A `synthetic-…` id, or any other text, is never written to a record. */
const REAL_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The hand-offs under way, one per mission: a second press while one runs starts nothing. */
const inFlight = new Set<string>()

/**
 * Where the leader stopped: the first step that is neither to do nor done, in plan order, and the first
 * thing that waits on the operator. A key with no answer is left out.
 */
function stoppedAtFor(record: MissionV4, inputs: Readonly<Record<string, StepInput>>): StoppedAt {
  const results = deriveStepResults(record, inputs)
  const step = record.steps.find((s) => {
    const state = results[s.id]?.state
    return state !== undefined && state !== 'todo' && state !== 'done'
  })
  const ask = waitingListV4(record, { inputs, results }).next?.ask
  return {
    ...(step !== undefined ? { step: step.id } : {}),
    ...(ask !== undefined && ask !== '' ? { waitingFor: ask } : {})
  }
}

/**
 * The hand-off. `caller` is who asks: only the operator (the app's own interface) hands off; a session
 * or a Harnu worker is refused before anything starts. `opts.at` is the clock of a test; the channel
 * never forwards one.
 */
export async function handOff(
  folder: string,
  missionId: string,
  caller: Actor,
  deps: HandoffDeps,
  opts: { at?: string } = {}
): Promise<HandoffResult> {
  const root = repoRoot(folder)
  const read = await readMissionRecord(root, missionId)
  if (!read.ok) return { ok: false, code: read.code, error: read.error }
  const { record } = read

  const access = guardMission(record, caller, 'operator')
  if (!access.ok) return access
  if (record.status === 'closed') {
    return refusal('MISSION_CLOSED', `${record.id} is closed; there is nothing to hand off.`)
  }

  const key = `${root}\u0000${record.id}`
  if (inFlight.has(key)) {
    return refusal(
      'HANDOFF_IN_PROGRESS',
      `a hand-off of ${record.id} is already starting a session; wait for it.`
    )
  }
  inFlight.add(key)
  try {
    const expectedLeader = leaderOf(record)
    let facts: Readonly<Record<string, StepInput>> = {}
    try {
      facts = (await deps.inputs?.(root, record)) ?? {}
    } catch {
      facts = {}
    }

    // 2 and 3: the first prompt, and the session. Nothing is written until the real id is known.
    let started: HandoffStartResult
    try {
      started = await deps.start({
        folder,
        prompt: handoffPrompt(record, read.log, { inputs: facts })
      })
    } catch (err) {
      started = { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    if (!started.ok) {
      return refusal(
        'HANDOFF_START_FAILED',
        `the new session did not start (${oneLine(started.reason)}). Nothing changed: ${expectedLeader ?? 'no session'} still leads. Try again, or attach the session from the picker if it appears.`
      )
    }
    const newId = started.sessionId
    if (!REAL_SESSION_ID.test(newId)) {
      return refusal(
        'BAD_ARGS',
        'the new session has no real id yet. Nothing changed; try the hand-off again.'
      )
    }

    // 4: one write.
    const at = opts.at ?? new Date().toISOString()
    const written = await applyChange(
      folder,
      record.id,
      { kind: 'operator' },
      'operator',
      (rec, log) => {
        if (rec.status === 'closed') {
          throw Object.assign(
            new Error(`MISSION_CLOSED: ${rec.id} was closed while the session started.`),
            {
              code: 'MISSION_CLOSED'
            }
          )
        }
        if (leaderOf(rec) !== expectedLeader) {
          throw Object.assign(
            new Error(
              `LEADER_CHANGED: the leader of ${rec.id} changed while the new session started. Nothing was changed; look at the Sessions row and decide again.`
            ),
            { code: 'LEADER_CHANGED' }
          )
        }
        if (openEntry(rec, newId)) {
          throw Object.assign(
            new Error(`BAD_ARGS: session ${newId} is already attached to ${rec.id}.`),
            {
              code: 'BAD_ARGS'
            }
          )
        }
        const index = rec.sessions.findIndex((s) => s.role === 'leads' && s.to === null)
        const released =
          index < 0
            ? [...rec.sessions]
            : releaseEntry(rec.sessions, rec.sessions[index].id, at, stoppedAtFor(rec, facts)).map(
                (s, i) => (i === index ? { ...s, role: 'worked' as const } : s)
              )
        return {
          record: {
            ...rec,
            sessions: [
              ...released,
              { id: newId, role: 'leads', from: at, to: null, stoppedAt: null }
            ]
          },
          log: logEntry(
            log,
            at,
            index < 0
              ? `operator handed the mission to session ${newId}`
              : `operator handed the mission to session ${newId}; session ${rec.sessions[index].id} now worked`
          )
        }
      }
    )
    if (!written.ok) return { ok: false, code: written.code, error: written.error }
    return {
      ok: true,
      changed: true,
      sessionId: newId,
      previousLeader: expectedLeader,
      record: written.record,
      file: written.file
    }
  } finally {
    inFlight.delete(key)
  }
}

// ---- The channel's wrapper -------------------------------------------------------------------------

/** What the renderer gets back: the outcome and the new session id, never the record or a file path. */
export type HandOffReply =
  | { ok: true; changed: true; sessionId: string; previousLeader: string | null }
  | { ok: false; code: string; error: string }

export function handOffReply(result: HandoffResult): HandOffReply {
  if (!result.ok) return { ok: false, code: result.code, error: result.error }
  const { record: _record, file: _file, ...rest } = result
  return rest
}

/**
 * `mission:handOff`: `{ folder, missionId }` and nothing else is read. The caller is ALWAYS the
 * operator's: the channel is the app's own interface (a renderer click on the pane's confirm dialog),
 * so no session id, actor or time in the arguments is looked at. With no starter wired the door says so.
 */
export async function runHandOff(raw: unknown, deps: HandoffDeps | null): Promise<HandOffReply> {
  const a = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (
    typeof a.folder !== 'string' ||
    a.folder === '' ||
    typeof a.missionId !== 'string' ||
    a.missionId === ''
  ) {
    return handOffReply(refusal('BAD_ARGS', 'a hand-off needs a folder and a mission.'))
  }
  if (deps === null) {
    return handOffReply(
      refusal('HANDOFF_UNAVAILABLE', 'Harnu cannot start a session right now. Nothing changed.')
    )
  }
  return handOffReply(await handOff(a.folder, a.missionId, { kind: 'operator' }, deps))
}
