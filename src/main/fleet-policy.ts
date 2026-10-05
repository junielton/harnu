/**
 * The hibernation decision — which live sessions (if any) to park.
 *
 * PURE: no electron, no node-pty, no clock. `now` is injected, so a test travels through
 * time by passing a different integer — no fake timers, no sleeps, no flake. Same posture
 * (and for the same reason) as `PtySessionIndex`.
 *
 * Spec: docs/specs/T119-session-hibernation.md §3.
 */

/** Mirrors `PtyKind` in pty.ts. Duplicated rather than imported to keep this module a leaf. */
export type FleetKind = 'shell' | 'claude-new' | 'claude-resume' | 'claude-fork'

/** Mirrors `TaskState` in hook-state.ts, plus `null` for "no hook has arrived yet". */
export type FleetTaskState =
  'working' | 'needs-input' | 'idle' | 'completed' | 'failed' | 'stopped' | null

export interface LiveSession {
  sessionKey: string
  kind: FleetKind
  taskState: FleetTaskState
  /** Epoch ms the operator last selected this session. */
  lastFocusedAt: number
  /** Epoch ms of the session's last pulse — a PTY byte flush OR a hook-bridge event. */
  lastActivityAt: number
  isSelected: boolean
  hasPendingApproval: boolean
  /**
   * T363: owns an `active` Mission with a `session` step link to a currently-live session
   * (`hibernation.ts#missionOwnersWithLiveChildren`). Optional — an absent flag reads as
   * "no", so every caller that predates missions keeps its exact behavior.
   */
  ownsLiveMission?: boolean
}

export interface Policy {
  /** Max concurrent live sessions before the cap trigger evicts. */
  maxLive: number
  /** Coldness required to be a candidate under the `cap` trigger. */
  lruIdleMs: number
  /** Coldness required under the `sweep` trigger — the "this is a real zombie" ceiling. */
  hardIdleMs: number
}

/**
 * `cap`   — the fleet is GROWING (`pty:create` at the ceiling). Free just enough slots for
 *           the newcomer, using the lenient `lruIdleMs` threshold.
 * `sweep` — the fleet is ROTTING (the 60 s interval). Park EVERY session past the strict
 *           `hardIdleMs` threshold, regardless of the count.
 */
export type Trigger = 'cap' | 'sweep'

/**
 * `maxLive: 5` is the 4–5 concurrent-agent ceiling from the supervisor-cognition research,
 * not a round number. `hardIdleMs` is deliberately generous: the sweep exists to kill real
 * zombies, not to prune a merely lukewarm session.
 */
export const DEFAULT_POLICY: Policy = {
  maxLive: 5,
  lruIdleMs: 15 * 60_000,
  hardIdleMs: 60 * 60_000
}

/**
 * Only a session resumable from an on-disk JSONL can be parked.
 *
 * A synthetic (`claude-new` / `claude-fork` before its synth→real migration) has NO
 * transcript yet: `claude --resume` cannot bring it back, and `resolveSpawnSpec` tests
 * `synthetic === true` BEFORE its resume branch, so waking it would spawn a fresh `claude`
 * and orphan the conversation (spec §5.2). A `shell` has nothing to resume.
 */
function isParkable(kind: FleetKind): boolean {
  return kind === 'claude-resume'
}

/**
 * How long this session has been cold, by the WARMER of the two sources. Focus and pulse are
 * independent: an unattended session that is still emitting bytes is not cold, and neither is
 * a silent session the operator just opened.
 */
function idleMs(s: LiveSession, now: number): number {
  return Math.min(now - s.lastFocusedAt, now - s.lastActivityAt)
}

function isEligible(s: LiveSession, now: number, policy: Policy, thresholdMs: number): boolean {
  if (!isParkable(s.kind)) return false
  if (s.isSelected) return false
  // Parking would strand the confirm in the Approval Inbox.
  if (s.hasPendingApproval) return false
  // T363: parking a mission owner strands its children's reports on a dead process. Unlike
  // the `working` claim below, this is not a hook-FSM guess that can latch forever: it is
  // an on-disk `active` mission plus a child with a live PTY, and it releases on its own
  // once every child is parked or gone — so an absolute veto cannot leak a slot for good.
  if (s.ownsLiveMission) return false

  // A `working` claim is CORROBORATED, not trusted.
  //
  // The hook FSM over-reports (BUG-1 — "the board lies upward"). Measured against a real
  // resumed session: `taskState: 'working'` latched permanently while the PTY emitted ZERO
  // bytes for 108s+. `claude --resume` appears to replay the transcript's tool-call hooks,
  // and with no `Stop` to follow, the state never relaxes.
  //
  // An absolute `working` veto would therefore make hibernation INERT — and worse, one
  // stuck session would hold a slot in the cap forever, which is precisely the leak this
  // feature exists to close.
  //
  // So a session that claims to be working gets the STRICT threshold (`hardIdleMs`) instead
  // of immunity, even under the lenient `cap` trigger. The claim we lean on is weak and
  // defensible: real work is never SILENT for a full hour — any turn, tool call, or spinner
  // tick writes bytes. A `working` session that has emitted nothing for an hour is a stale
  // FSM or a stall, and parking it is safe: `--resume` restores the conversation regardless.
  //
  // We deliberately do NOT claim "work is never silent for 15 minutes" — that was spiked and
  // came back inconclusive. The one-hour bar is the one the evidence actually supports.
  const effectiveThreshold = s.taskState === 'working' ? policy.hardIdleMs : thresholdMs
  return idleMs(s, now) > effectiveThreshold
}

/**
 * Sessions filtered to {@link isEligible} against a single threshold, coldest first.
 * Shared by {@link explainFleet} (called once per threshold) and, transitively,
 * {@link evaluateFleet} — the one place this filter+sort actually runs.
 */
function eligibleSorted(
  sessions: readonly LiveSession[],
  now: number,
  policy: Policy,
  thresholdMs: number
): LiveSession[] {
  return sessions
    .filter((s) => isEligible(s, now, policy, thresholdMs))
    .sort((a, b) => idleMs(b, now) - idleMs(a, now)) // coldest first — LRU, never FIFO
}

/**
 * `explainFleet` (T127) — per-session WHY, on top of which {@link evaluateFleet} is
 * reimplemented so there is exactly one source of truth for the policy (spec §6.1).
 *
 * `evaluateFleet` returns only a `string[]` of victims — no reason, no candidate
 * ranking. The System Monitor needs to show *why* a session is live or parked, and
 * who the next sweep candidate is; that's not a free read of the same data, so this
 * richer shape exists alongside it rather than replacing it (pty.ts:529 depends on
 * the `string[]` contract, untouched).
 */
export interface FleetExplanation {
  sessionKey: string
  /** Whether this session's `kind` can ever be a hibernation candidate at all. */
  parkable: boolean
  /** How long this session has been cold, by the warmer of focus/pulse (see `idleMs`). */
  idleMs: number
  /**
   * `'not-parkable'` — wrong kind (synthetic/shell).
   * `'selected'` — the one session the operator has open.
   * `'pending-approval'` — parking would strand a confirm in the Approval Inbox.
   * `'mission-owner'` — owns an active mission with a live child (T363); never parked.
   * `'hard-idle'` — cold enough to be swept under the strict threshold.
   * `'lru'` — cold enough to be evicted under the cap's lenient threshold, not yet hard-idle.
   * `'active'` — parkable, but not cold enough for either threshold.
   */
  reason:
    | 'not-parkable'
    | 'selected'
    | 'pending-approval'
    | 'mission-owner'
    | 'hard-idle'
    | 'lru'
    | 'active'
  /** 1 = next to be swept (coldest hard-idle candidate); `null` = not a sweep candidate. */
  sweepRank: number | null
}

export function explainFleet(
  sessions: readonly LiveSession[],
  now: number,
  policy: Policy
): FleetExplanation[] {
  const lruEligible = new Set(
    eligibleSorted(sessions, now, policy, policy.lruIdleMs).map((s) => s.sessionKey)
  )
  const hardSorted = eligibleSorted(sessions, now, policy, policy.hardIdleMs)
  const hardEligible = new Set(hardSorted.map((s) => s.sessionKey))
  const sweepRankBySessionKey = new Map(hardSorted.map((s, i) => [s.sessionKey, i + 1]))

  return sessions.map((s) => {
    const parkable = isParkable(s.kind)
    let reason: FleetExplanation['reason']
    if (!parkable) reason = 'not-parkable'
    else if (s.isSelected) reason = 'selected'
    else if (s.hasPendingApproval) reason = 'pending-approval'
    else if (s.ownsLiveMission) reason = 'mission-owner'
    else if (hardEligible.has(s.sessionKey)) reason = 'hard-idle'
    else if (lruEligible.has(s.sessionKey)) reason = 'lru'
    else reason = 'active'
    return {
      sessionKey: s.sessionKey,
      parkable,
      idleMs: idleMs(s, now),
      reason,
      sweepRank: sweepRankBySessionKey.get(s.sessionKey) ?? null
    }
  })
}

export function evaluateFleet(
  sessions: readonly LiveSession[],
  now: number,
  policy: Policy,
  trigger: Trigger
): string[] {
  const explained = explainFleet(sessions, now, policy)

  if (trigger === 'sweep') {
    // Every hard-idle candidate, coldest first — `sweepRank` was assigned in that
    // exact order, so sorting by it reproduces the LRU ordering without re-deriving it.
    return explained
      .filter((e): e is FleetExplanation & { sweepRank: number } => e.sweepRank !== null)
      .sort((a, b) => a.sweepRank - b.sweepRank)
      .map((e) => e.sessionKey)
  }

  // `cap` runs from `pty:create`, so one MORE session is about to exist: free
  // `live - maxLive + 1` slots to land at `maxLive` after the spawn. When nothing is
  // eligible this yields [] and the caller spawns anyway — a ceiling that blocks the
  // operator's work is worse than the problem it solves (spec §3.5).
  //
  // `'hard-idle'` sessions are folded into the cap candidate pool too: `hardIdleMs` is
  // by construction the stricter (larger) of the two thresholds, so a hard-idle
  // session was always also lru-eligible — this is the same union `evaluateFleet`
  // computed before `explainFleet` existed, just read off the `reason` label instead
  // of re-filtering.
  const capCandidates = explained
    .filter((e) => e.reason === 'lru' || e.reason === 'hard-idle')
    .sort((a, b) => b.idleMs - a.idleMs)
  const slotsToFree = sessions.length - policy.maxLive + 1
  if (slotsToFree <= 0) return []
  return capCandidates.slice(0, slotsToFree).map((e) => e.sessionKey)
}
