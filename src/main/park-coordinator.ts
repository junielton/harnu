/**
 * T456 — the park coordinator: every park goes through {@link ParkCoordinator.requestPark}
 * (spec §5.1). It decides with the pure bounds core (`park-negotiation-core.ts`), consults the
 * session where it can, revalidates right before the kill (§5.6), and only then calls the one
 * killer, `pty.ts#hibernateSession`. P4W4's capture plugs in later as the stage between the
 * revalidation and the kill.
 *
 * The session is consulted through `park.query` (W2, {@link createParkQuery}) when the key `park`
 * is `ask`. The command needs the feature `act.park`, which the host enables only under
 * `channel: active` (§5.2), so on a default install (`channel: shadow`) the enqueue is refused and
 * the answer is `silent`. A `silent` answer falls back to the LEGACY facts: the background-task
 * and cron counts of the last main `Stop` the hook bridge saw (§5.5).
 *
 * Every failure ends at today's behavior, which is parking (§9.2): a throw while consulting reads
 * as `silent`, a missing answer reads as `silent`, and `silent` with no legacy fact parks.
 *
 * Electron-free and clock-free (all injected), so the whole thing is unit-tested without a PTY.
 */

import {
  NEG_QUERY_WAIT_MS,
  applyAnswer,
  decide,
  resetEpisode,
  revalidate,
  type Answer,
  type Episode,
  type NegotiationSettings,
  type ParkCause,
  type ParkSnapshot,
  type ResetEdge,
  type Revalidation
} from './park-negotiation-core'
import { parkCandidates, type LiveSession, type Policy, type Trigger } from './fleet-policy'
import type { ParkNegotiation } from './hibernation'
import { getCompanionPrefs, prefsKey, registerPrefsKey } from './companion/companion-prefs'
import { enqueue, type EnqueueRequest, type EnqueueResult } from './companion/command-channel'
import { registerGateRow, type ChannelMode } from './companion/command-gate-core'
import type { CommandOutcome } from './companion/command-types'
import { PARK_QUERY_TTL_MS } from './companion/contract'
import { registerFeaturePolicy } from './companion/feature-policy'

export type { ParkNegotiation } from './hibernation'

// ---- the `park` key (spec §9.1) -------------------------------------------------------------

/**
 * `ask` — negotiate through the mod where the channel can carry it (`channel: active`), legacy
 *   facts elsewhere.
 * `facts` — legacy Stop facts only, for every session; no command is sent.
 * `off` — today's behavior exactly; the facts are not read either.
 */
export type ParkMode = 'off' | 'facts' | 'ask'

export const PARK_MODES: readonly ParkMode[] = ['off', 'facts', 'ask']

/**
 * Registered with `observeCap: 'facts'`, so ARB-7b's "every feature key capped at its observe
 * level" caps it above the tested CLI ceiling with no special case. Idempotent.
 */
export function registerParkPrefsKey(): void {
  registerPrefsKey<ParkMode>('park', {
    default: 'ask',
    observeCap: 'facts',
    parse: (raw) => (PARK_MODES.includes(raw as ParkMode) ? (raw as ParkMode) : 'ask')
  })
}
registerParkPrefsKey()

/**
 * The effective mode. `prefsKey` returns the observe cap (`facts`) above the tested CLI ceiling
 * whatever the file holds, which would make an operator's `off` unreachable there; the cap exists
 * to LOWER a mode, never to raise one, so a stored `off` stays `off` (T456 W3).
 */
export function parkModeNow(): ParkMode {
  const capped = prefsKey<ParkMode>('park')
  const stored = getCompanionPrefs().keys['park']
  return stored === 'off' ? 'off' : capped
}

// ---- `park.query`: the gate row, the feature and the question (spec §5.2, §5.4) ------------

/** The one cause that may queue `park.query`: this coordinator (SEC-5c). */
export const PARK_QUERY_SUBSYSTEM = 'park'

/**
 * The command's own TTL (contract §7.2), the same as the coordinator's wait (§5.4, pinned by a
 * test): a late answer is refused `CMD_EXPIRED` by the mod and never acted on.
 */
export { PARK_QUERY_TTL_MS }

const PARK_CAUSES: readonly ParkCause[] = ['cap', 'sweep', 'manual']

const validParkQueryArgs = (a: unknown): boolean =>
  isObject(a) && Object.keys(a).length === 1 && PARK_CAUSES.includes(a.cause as ParkCause)

/**
 * The gate row and the feature rule of `park.query`. `act.park` is an actuator (its answer can
 * delay an actuation, the park), so it follows the actuator rule as `act.plan` does: its own key
 * on (`park` = `ask`) AND `channel` = `active`. It is NOT observe-only, so `shadow` refuses it
 * (`shadowRefusal`). Above the tested CLI ceiling `prefsKey` caps `park` at `facts` and `channel`
 * at `shadow` (ARB-7b), so the rule fails with no special case. Idempotent.
 */
export function registerParkQueryPolicies(): void {
  registerGateRow('park.query', {
    feature: 'act.park',
    internal: [PARK_QUERY_SUBSYSTEM],
    validate: validParkQueryArgs
  })
  registerFeaturePolicy(
    'act.park',
    () => prefsKey<ParkMode>('park') === 'ask' && prefsKey<ChannelMode>('channel') === 'active'
  )
}
registerParkQueryPolicies()

const BUSY_KINDS: ReadonlySet<string> = new Set([
  'turn',
  'permission',
  'background-task',
  'background-subagent',
  'scheduled-wakeup',
  'remote-surface'
])
/** More reasons than the six kinds can produce is not an answer. */
const BUSY_MAX = 16

/**
 * A settled `park.query`, read as untrusted input (SEC-3b): `busy` with its reason kinds and a
 * finite hint, `free` for `busy: []`, and `silent` for everything else — a refusal (`CMD_*`,
 * `FEATURE_DISABLED`), an expiry, a loss, a drop (`revoked`), no data or a malformed one. The hint
 * is clamped by the core, not here. A reason kind this host does not know is dropped (a newer mod,
 * contract §14), which errs toward parking.
 */
export function parkQueryAnswer(outcome: CommandOutcome | null | undefined): Answer {
  const silent: Answer = { kind: 'silent' }
  if (!outcome || outcome.state !== 'resulted' || !outcome.ok) return silent
  const data = outcome.data
  if (!isObject(data) || !Array.isArray(data.busy) || data.busy.length > BUSY_MAX) return silent
  const reasons: string[] = []
  for (const r of data.busy) {
    if (!isObject(r) || typeof r.kind !== 'string') return silent
    if (BUSY_KINDS.has(r.kind) && !reasons.includes(r.kind)) reasons.push(r.kind)
  }
  if (reasons.length === 0) return { kind: 'free' }
  const hint = data.retryAfterMs
  return typeof hint === 'number' && Number.isFinite(hint) && hint >= 0
    ? { kind: 'busy', reasons, retryAfterMs: hint }
    : { kind: 'busy', reasons }
}

type SendParkQuery = (req: EnqueueRequest<'park.query'>) => EnqueueResult

/**
 * The coordinator's `ask`: enqueue `park.query` through the one `enqueue()` (audited, gated) and
 * read its settlement. A refusal (`NO_BINDING`, `FEATURE_OFF`, `MODE_SHADOW`, …) or a throw is
 * `silent` at once; the wait itself is bounded by the coordinator (`NEG_QUERY_WAIT_MS`). Never
 * rejects.
 */
export function createParkQuery(
  send: SendParkQuery = enqueue
): (sessionKey: string, cause: ParkCause) => Promise<Answer> {
  return async (sessionKey, cause) => {
    try {
      const out = send({
        sessionKey,
        name: 'park.query',
        args: { cause },
        cause: { kind: 'internal', subsystem: PARK_QUERY_SUBSYSTEM },
        ttlMs: PARK_QUERY_TTL_MS
      })
      if (!out.ok) return { kind: 'silent' }
      return parkQueryAnswer(await out.settled)
    } catch {
      return { kind: 'silent' }
    }
  }
}

// ---- legacy facts, kept from the hook bridge's request handler (spec §5.5) ------------------

/** A background task that finished does not hold (mirrors the companion sensor's FINISHED set). */
const FINISHED = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'error'])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The two counts T456 keeps from a main `Stop` body: in-flight background tasks (subagents
 * included) and session-scoped crons. Counts only — a task's `command` and a cron's `prompt` may
 * hold secrets and are never read (§5.3). Absent fields (an older CLI) read zero: less busy.
 */
export function legacyStopCounts(body: Record<string, unknown>): { tasks: number; crons: number } {
  const tasks = Array.isArray(body.background_tasks)
    ? body.background_tasks.filter((t) => isObject(t) && !FINISHED.has(String(t.status))).length
    : 0
  const crons = Array.isArray(body.session_crons) ? body.session_crons.length : 0
  return { tasks, crons }
}

const PROMPT_SOURCES = new Set([
  'user',
  'sdk',
  'system',
  'loop_wakeup',
  'schedule_wakeup',
  'poll_event'
])

type PromptSource = Extract<ResetEdge, { kind: 'prompt' }>['source']

export interface LegacyParkFacts {
  /**
   * Called by the hook bridge with the parsed body of every hook POST, BEFORE the event reaches
   * the task-state hub, which drops a parked session's events and a companion-owned family's
   * legacy events (§5.5). Not a second writer under ARB-2a: nothing here feeds `taskState`.
   */
  noteHookBody(sessionKey: string, event: string, body: Record<string, unknown>, now: number): void
  /** The busy reasons the last main `Stop` implies, as `ParkBusyReason` kinds. */
  busy(sessionKey: string): string[]
  /** How many of each busy reason that `Stop` reported (only the non-zero ones). T456 W3. */
  counts(sessionKey: string): Record<string, number>
  /** The last main `UserPromptSubmit` edge of any source; `null` when none was seen. */
  lastPromptAt(sessionKey: string): number | null
  /** Every main `UserPromptSubmit`, with its `source` when it is a known label. */
  onPrompt(fn: (sessionKey: string, source: PromptSource) => void): () => void
  forget(sessionKey: string): void
}

export function createLegacyParkFacts(): LegacyParkFacts {
  const stops = new Map<string, { tasks: number; crons: number }>()
  const prompts = new Map<string, number>()
  const listeners = new Set<(sessionKey: string, source: PromptSource) => void>()
  const counts = (sessionKey: string): Record<string, number> => {
    const s = stops.get(sessionKey)
    const out: Record<string, number> = {}
    if (!s) return out
    if (s.tasks > 0) out['background-task'] = s.tasks
    if (s.crons > 0) out['scheduled-wakeup'] = s.crons
    return out
  }
  return {
    noteHookBody(sessionKey, event, body, now) {
      if (!sessionKey) return
      // A subagent's own event is not the main thread's (`agent_id` is only on those).
      if (typeof body.agent_id === 'string' && body.agent_id !== '') return
      if (event === 'Stop') {
        stops.set(sessionKey, legacyStopCounts(body))
      } else if (event === 'UserPromptSubmit') {
        prompts.set(sessionKey, now)
        const source =
          typeof body.source === 'string' && PROMPT_SOURCES.has(body.source)
            ? (body.source as PromptSource)
            : undefined
        for (const fn of [...listeners]) {
          try {
            fn(sessionKey, source)
          } catch {
            // one listener's failure never stops the others, nor the hook
          }
        }
      }
    },
    busy: (sessionKey) => Object.keys(counts(sessionKey)),
    counts,
    lastPromptAt(sessionKey) {
      return prompts.get(sessionKey) ?? null
    },
    onPrompt(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    forget(sessionKey) {
      stops.delete(sessionKey)
      prompts.delete(sessionKey)
    }
  }
}

/** The process-wide store the hook bridge writes and `pty.ts`'s coordinator reads. */
export const legacyParkFacts: LegacyParkFacts = createLegacyParkFacts()

// ---- the coordinator ------------------------------------------------------------------------

export interface ParkCoordinatorDeps {
  now(): number
  /** The session's PTY as `revalidate` reads it; `null` when it has no live PTY. */
  snapshot(sessionKey: string): ParkSnapshot | null
  /** The one killer. `negotiation` is `null` when negotiation did not run (key `off`). */
  hibernate(sessionKey: string, negotiation: ParkNegotiation | null): void
  parkMode(): ParkMode
  bounds(): Omit<NegotiationSettings, 'enabled'>
  /** MemAvailable in MB; `null` where it cannot be read (the floor is then off). */
  memAvailableMb(): number | null
  facts: LegacyParkFacts
  /** `park.query` ({@link createParkQuery}). Absent: every consultation is `silent`. */
  ask?: (sessionKey: string, cause: ParkCause) => Promise<Answer>
}

export type ParkOutcome =
  | { kind: 'parked'; negotiation: ParkNegotiation | null }
  | { kind: 'declined'; episode: Episode }
  | { kind: 'deferred'; until: number }
  | { kind: 'cancelled'; why: Extract<Revalidation, { ok: false }>['why'] }
  | { kind: 'in-flight' }

export interface ParkCoordinator {
  /**
   * Decide, consult, revalidate, park. Returns at once to a caller that does not await it; the
   * decide → park path (operator, disabled, memory pressure, limit) and the `facts` path run
   * synchronously, so "Park now" has killed the process before the promise settles.
   */
  requestPark(sessionKey: string, cause: ParkCause): Promise<ParkOutcome>
  /**
   * The `cap` walk: ask the candidates coldest first until `slots` of them are parked. A
   * candidate that declines (or is cancelled) passes its slot to the next one; when every one
   * declines the fleet stays over the ceiling (T119 §3.5). Never awaited by `pty:create`.
   */
  requestCapParks(candidates: readonly string[], slots: number): Promise<string[]>
  /** The session's open episode, or `null`. */
  episodeFor(sessionKey: string): Episode | null
  /**
   * The episodes the policy should honour: all of them, or none under memory pressure, so a
   * deferred session is a candidate again and `decide` parks it without a question (§6.3).
   */
  policyEpisodes(): ReadonlyMap<string, Episode>
  /** The operator selected the session: it ends the episode (§6.1). */
  onFocus(sessionKey: string): void
  /** The session's PTY is gone (parked, closed or exited): drop its episode. */
  forget(sessionKey: string): void
  dispose(): void
}

function settingsFor(deps: ParkCoordinatorDeps, mode: ParkMode): NegotiationSettings {
  return { ...deps.bounds(), enabled: mode !== 'off' }
}

/** `deps.ask`, raced against `NEG_QUERY_WAIT_MS`; anything but an answer reads `silent`. */
function consult(deps: ParkCoordinatorDeps, sessionKey: string, cause: ParkCause): Promise<Answer> {
  const ask = deps.ask
  if (!ask) return Promise.resolve({ kind: 'silent' })
  return new Promise<Answer>((resolve) => {
    let done = false
    const finish = (a: Answer): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(a)
    }
    const timer = setTimeout(() => finish({ kind: 'silent' }), NEG_QUERY_WAIT_MS)
    let pending: Promise<Answer>
    try {
      pending = ask(sessionKey, cause)
    } catch {
      finish({ kind: 'silent' })
      return
    }
    pending.then(finish, () => finish({ kind: 'silent' }))
  })
}

export function createParkCoordinator(deps: ParkCoordinatorDeps): ParkCoordinator {
  const episodes = new Map<string, Episode>()
  const inFlight = new Set<string>()

  const offPrompt = deps.facts.onPrompt((sessionKey, source) => {
    const ep = episodes.get(sessionKey)
    if (!ep) return
    const next = resetEpisode(ep, { kind: 'prompt', source })
    if (next === null) episodes.delete(sessionKey)
  })

  function underPressure(): boolean {
    if (deps.parkMode() === 'off') return false
    const mem = deps.memAvailableMb()
    return mem !== null && mem < deps.bounds().pressureFloorMb
  }

  /** Revalidate, then hand the session to the killer. */
  function finish(
    sessionKey: string,
    cause: ParkCause,
    requestedAt: number,
    before: ParkSnapshot,
    negotiation: ParkNegotiation | null
  ): ParkOutcome {
    const check = revalidate(cause, requestedAt, before, deps.snapshot(sessionKey))
    if (!check.ok) return { kind: 'cancelled', why: check.why }
    // [P4W4 capture stage goes here: after the revalidation, before the kill.]
    episodes.delete(sessionKey)
    deps.hibernate(sessionKey, negotiation)
    return { kind: 'parked', negotiation }
  }

  function ledger(
    ep: Episode | null,
    why: ParkNegotiation['why'],
    override = false
  ): ParkNegotiation {
    return {
      declines: ep?.declines ?? 0,
      reasons: ep ? [...ep.reasons] : [],
      why,
      ...(override ? { override: true as const } : {})
    }
  }

  async function requestPark(sessionKey: string, cause: ParkCause): Promise<ParkOutcome> {
    if (inFlight.has(sessionKey)) return { kind: 'in-flight' }
    const before = deps.snapshot(sessionKey)
    if (!before) return { kind: 'cancelled', why: 'gone' }
    const requestedAt = deps.now()
    const mode = deps.parkMode()
    const settings = settingsFor(deps, mode)
    const ep = episodes.get(sessionKey) ?? null
    const d = decide({
      now: requestedAt,
      cause,
      episode: ep,
      settings,
      memAvailableMb: mode === 'off' ? null : deps.memAvailableMb()
    })

    if (d.action === 'defer') return { kind: 'deferred', until: ep?.until ?? requestedAt }
    if (d.action === 'park') {
      if (d.why === 'disabled') return finish(sessionKey, cause, requestedAt, before, null)
      return finish(
        sessionKey,
        cause,
        requestedAt,
        before,
        // "Park now" on a session that was declining at that moment overrides it (§6.4).
        ledger(ep, d.why, d.why === 'operator' && ep !== null)
      )
    }

    // `ask`: consult the session (`park.query`) or, failing that, the legacy facts.
    let answer: Answer = { kind: 'silent' }
    if (mode === 'ask' && deps.ask) {
      inFlight.add(sessionKey)
      try {
        answer = await consult(deps, sessionKey, cause)
      } catch {
        answer = { kind: 'silent' }
      } finally {
        inFlight.delete(sessionKey)
      }
    }

    let next: Episode | null
    try {
      next = applyAnswer(ep, answer, deps.facts.busy(sessionKey), deps.now(), settings)
    } catch {
      // The coordinator itself threw: revalidate, then park; the ledger reads `silent` (§9.2).
      return finish(sessionKey, cause, requestedAt, before, ledger(ep, 'silent'))
    }
    if (next === null) {
      return finish(
        sessionKey,
        cause,
        requestedAt,
        before,
        ledger(ep, answer.kind === 'free' ? 'free' : 'silent')
      )
    }
    // A busy answer is a decline only if the session is still the victim it was: a person
    // coming back during the wait cancels it, and no decline is counted (§5.6).
    const check = revalidate(cause, requestedAt, before, deps.snapshot(sessionKey))
    if (!check.ok) return { kind: 'cancelled', why: check.why }
    // The counts are display-only and come from the same legacy Stop as the labels; a mod answer
    // (W2) will fill them from its own. Frozen here: a later Stop does not rewrite this decline.
    const declined: Episode = { ...next, counts: deps.facts.counts(sessionKey) }
    episodes.set(sessionKey, declined)
    return { kind: 'declined', episode: declined }
  }

  async function requestCapParks(candidates: readonly string[], slots: number): Promise<string[]> {
    const parked: string[] = []
    for (const key of candidates) {
      if (parked.length >= slots) break
      const out = await requestPark(key, 'cap')
      if (out.kind === 'parked') parked.push(key)
    }
    return parked
  }

  return {
    requestPark,
    requestCapParks,
    episodeFor: (sessionKey) => episodes.get(sessionKey) ?? null,
    // Key `off` is today's behavior exactly: an episode opened before the switch must not keep
    // a session out of the candidate list.
    policyEpisodes: () =>
      underPressure() || deps.parkMode() === 'off' ? new Map() : new Map(episodes),
    onFocus(sessionKey) {
      const ep = episodes.get(sessionKey)
      if (ep && resetEpisode(ep, { kind: 'focus' }) === null) episodes.delete(sessionKey)
    },
    forget(sessionKey) {
      episodes.delete(sessionKey)
    },
    dispose() {
      offPrompt()
      episodes.clear()
    }
  }
}

/**
 * `pty.ts`'s `runPolicy`: pick the candidates for a trigger and hand them to the coordinator.
 * Returns nothing, synchronously — `pty:create` calls it and goes on to spawn without waiting for
 * any answer (spec §5.1), so the newcomer is never delayed.
 */
export function runParkPolicy(
  coordinator: ParkCoordinator,
  sessions: readonly LiveSession[],
  now: number,
  policy: Policy,
  trigger: Trigger
): void {
  const { candidates, slots } = parkCandidates(sessions, now, policy, trigger)
  if (candidates.length === 0) return
  if (trigger === 'cap') {
    void coordinator.requestCapParks(candidates, slots)
    return
  }
  for (const key of candidates) void coordinator.requestPark(key, 'sweep')
}
