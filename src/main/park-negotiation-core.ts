/**
 * T456 — the bounds of a negotiated park (spec §6.1). Ported from
 * `docs/specs/T456-negotiated-hibernation/01-prototype.md` §P2; its suite is
 * `tests/park-negotiation-core.test.ts`.
 *
 * PURE: no electron, no clock; `now` is injected, in the style of `fleet-policy.ts`. The
 * coordinator around it (the question, the wait, the ledger write) is `park-coordinator.ts`.
 *
 * The four guards the suite pins — `maxDeclines`, `maxDeferMs`, the memory floor and the
 * operator's override — are why no answer can hold a session's RAM for good: removing any one of
 * them fails a test (spec §6.6).
 */

export type ParkCause = 'cap' | 'sweep' | 'manual'

/** What the session said, or that it said nothing. */
export type Answer =
  { kind: 'busy'; reasons: string[]; retryAfterMs?: number } | { kind: 'free' } | { kind: 'silent' } // timeout, NO_BINDING, MODE_SHADOW, CMD_* — anything but a result

/** One cold episode of one session: opened by the first decline, closed by a reset edge. */
export interface Episode {
  firstDeclineAt: number
  declines: number
  /** No question and no park before this. */
  until: number
  reasons: string[]
}

export interface NegotiationSettings {
  enabled: boolean
  maxDeclines: number
  maxDeferMs: number
  pressureFloorMb: number
}

export interface DecideInput {
  now: number
  cause: ParkCause
  episode: Episode | null
  settings: NegotiationSettings
  memAvailableMb: number | null
}

export type Decision =
  | { action: 'park'; why: 'operator' | 'disabled' | 'memory-pressure' | 'limit' }
  | { action: 'defer'; why: 'deferred' }
  | { action: 'ask' }

export const NEG_QUERY_WAIT_MS = 5_000
export const NEG_RETRY_MIN_MS = 60_000
export const NEG_RETRY_MAX_MS = 1_800_000
export const NEG_RETRY_DEFAULT_MS = 600_000

export const DEFAULT_NEGOTIATION: NegotiationSettings = {
  enabled: true,
  maxDeclines: 8,
  maxDeferMs: 2 * 60 * 60_000,
  pressureFloorMb: 1_536
}

function exhausted(ep: Episode, now: number, s: NegotiationSettings): boolean {
  return ep.declines >= s.maxDeclines || now - ep.firstDeclineAt >= s.maxDeferMs
}

/**
 * Before the question: must we park, are we inside a granted delay, or do we consult the session?
 * `ask` means "consult": `park.query` where the channel can carry it, else the answer is `silent`
 * and the legacy Stop facts stand in (`applyAnswer`). Either way a busy answer opens or advances the
 * episode.
 */
export function decide(i: DecideInput): Decision {
  if (i.cause === 'manual') return { action: 'park', why: 'operator' }
  if (!i.settings.enabled) return { action: 'park', why: 'disabled' }
  if (i.memAvailableMb !== null && i.memAvailableMb < i.settings.pressureFloorMb) {
    return { action: 'park', why: 'memory-pressure' }
  }
  if (i.episode && exhausted(i.episode, i.now, i.settings)) return { action: 'park', why: 'limit' }
  if (i.episode && i.now < i.episode.until) return { action: 'defer', why: 'deferred' }
  return { action: 'ask' }
}

/** After the question (or the legacy facts standing in for it): the next episode, or null to park. */
export function applyAnswer(
  ep: Episode | null,
  answer: Answer,
  legacyBusy: string[],
  now: number,
  s: NegotiationSettings
): Episode | null {
  const busy = answer.kind === 'busy' ? answer.reasons : answer.kind === 'silent' ? legacyBusy : []
  if (busy.length === 0) return null
  const firstDeclineAt = ep?.firstDeclineAt ?? now
  const hint = answer.kind === 'busy' ? answer.retryAfterMs : undefined
  const wait = Math.min(NEG_RETRY_MAX_MS, Math.max(NEG_RETRY_MIN_MS, hint ?? NEG_RETRY_DEFAULT_MS))
  return {
    firstDeclineAt,
    declines: (ep?.declines ?? 0) + 1,
    // Never past the episode's ceiling: the bound is exact, not "ceiling plus one retry".
    until: Math.min(now + wait, firstDeclineAt + s.maxDeferMs),
    reasons: busy
  }
}

/**
 * The edges that may close an episode. Both come from Harnu's own side, never from the mod's
 * sensor traffic: the renderer's focus push, and the legacy `UserPromptSubmit` hook, which is always
 * installed (ARB-1) and carries `source` (types 14661-14667; may be absent while it rolls out).
 */
export type ResetEdge =
  | { kind: 'focus' }
  | {
      kind: 'prompt'
      source?: 'user' | 'sdk' | 'system' | 'loop_wakeup' | 'schedule_wakeup' | 'poll_event'
    }

/**
 * Only a person ends an episode: selecting the session, or typing into it. A wakeup, a task
 * notification or an unlabelled prompt keeps the budget running, so a session whose own crons keep
 * waking it cannot renew its hold for ever.
 */
export function resetEpisode(ep: Episode | null, edge: ResetEdge): Episode | null {
  if (ep === null) return null
  if (edge.kind === 'focus') return null
  return edge.source === 'user' ? null : ep
}

/** What the coordinator reads about the session right before the kill. */
export interface ParkSnapshot {
  ptyId: string
  isSelected: boolean
  lastFocusedAt: number
  /** PTY bytes (`pty.ts` flushNow). */
  lastActivityAt: number
  /** The last legacy `UserPromptSubmit` edge, of any source; null when none was seen. */
  lastPromptAt: number | null
}

export type Revalidation =
  | { ok: true }
  | { ok: false; why: 'gone' | 'respawned' | 'prompted' | 'selected' | 'focused' | 'active' }

/**
 * The check between the answer and `hibernateSession` (spec §5.6). The question opened an async
 * gap of up to `NEG_QUERY_WAIT_MS`; anything that would have kept the session off the victim list
 * then cancels the park now. Manual parks only check that it is the same process.
 */
export function revalidate(
  cause: ParkCause,
  requestedAt: number,
  before: ParkSnapshot,
  now: ParkSnapshot | null
): Revalidation {
  if (now === null) return { ok: false, why: 'gone' }
  if (now.ptyId !== before.ptyId) return { ok: false, why: 'respawned' }
  if (cause === 'manual') return { ok: true }
  if (now.lastPromptAt !== null && now.lastPromptAt > requestedAt) {
    return { ok: false, why: 'prompted' }
  }
  if (now.isSelected) return { ok: false, why: 'selected' }
  if (now.lastFocusedAt > requestedAt) return { ok: false, why: 'focused' }
  if (now.lastActivityAt > requestedAt) return { ok: false, why: 'active' }
  return { ok: true }
}
