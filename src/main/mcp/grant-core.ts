/**
 * Pure core for T44 S5 — mission grants. A grant is a bounded, disclosed,
 * revocable capability: within its named folders + verbs, and until its budget
 * or TTL runs out, an agent mutation AUTO-ALLOWS (no per-action confirm) — the
 * one path in the whole system where that happens. Everything security-relevant
 * lives here as a pure decision (ADR-0001) so it is exhaustively unit-tested and
 * cannot drift; the registry shell only owns the mutable Map + timers.
 *
 * The 6 §0 invariants this core enforces: SCOPED (explicit folders+verbs, no
 * wildcard), BOUNDED (budget + TTL → escalate on exhaustion, never extend),
 * DISCLOSED (see `buildGrantDisclosureText`), REVOCABLE (`revoked` flag),
 * ESCALATION-not-denial (an in-ambit non-grantable call returns `escalate`, which
 * the gate maps to a park, never a dry deny). AUDITED is the shell's job.
 *
 * CRITICAL: this NEVER overrides the base gate's hard denies. The caller consults
 * `grantDecision` ONLY when the base verdict is a mutation's `confirm` or
 * `FOLDER_NOT_ALLOWED` — SERVER_DISABLED and PATH_ESCAPE are decided before a
 * grant is ever consulted, so a grant can never reach outside a known root or
 * past the kill switch.
 */

import { isWithinRoot, normalizePath } from './permission-core'
import type { McpOp } from './tool-catalog'

/** One active mission grant. `spent` is mutated only by the registry shell. */
export interface MissionGrant {
  id: string
  goal: string
  /** Normalized absolute folder paths approved at grant time (static scope). */
  folders: string[]
  /** Worktrees created BY an in-grant `create_worktree` — the only runtime growth (D3). */
  dynamicFolders: string[]
  /** Grantable verbs (⊂ SAFE_GRANT_VERBS), frozen at approval. */
  verbs: McpOp[]
  /** Max committed mutations. */
  budget: number
  /** Committed + reserved mutations. */
  spent: number
  /** Epoch ms after which the grant is dead. */
  expiresAt: number
  createdAt: number
  revoked: boolean
}

/** Why an in-ambit call can't be auto-allowed (→ escalate/park, never deny). */
export type EscalateReason = 'expired' | 'exhausted' | 'revoked' | 'out-of-scope'

/** The decision for one (folder, verb) against the live grants. */
export type GrantDecision =
  | { outcome: 'allow'; grantId: string }
  | { outcome: 'escalate'; reason: EscalateReason }
  | { outcome: 'none' }

/** Whether a grant can still auto-allow at `now`: not revoked, unexpired, budget left. */
export function isLive(g: MissionGrant, now: number): boolean {
  return !g.revoked && now < g.expiresAt && g.spent < g.budget
}

/** Remaining budget (never negative). */
export function remaining(g: MissionGrant): number {
  return Math.max(0, g.budget - g.spent)
}

/**
 * Merge a mission-grant's live proprioception (`grantId` + `grantBudgetRemaining`)
 * into a SUCCESS ACK payload (T77c), so an agent acting under a grant learns how
 * much of the mission's budget is left after this action — no separate read. Pure +
 * conservative: only a plain-object payload that is a success ACK (`ok === true`)
 * is augmented; an error result, a non-object, an array, or an `ok:false` payload
 * passes through BY REFERENCE untouched (the caller uses `===` to detect "changed"
 * and re-wrap only then). This fn does no time/registry math — the caller snapshots
 * `grantBudgetRemaining` synchronously right after `reserve` so it stays race-free.
 */
export function augmentAckWithGrant(
  payload: unknown,
  info: { grantId: string; grantBudgetRemaining: number }
): unknown {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).ok === true
  ) {
    return {
      ...(payload as Record<string, unknown>),
      grantId: info.grantId,
      grantBudgetRemaining: info.grantBudgetRemaining
    }
  }
  return payload
}

/**
 * Whether `folder` is one of, or nested under, any of the grant's static or
 * dynamic folders — normalized both sides with the SAME normalizer the gate uses
 * (`homeDir` injected for purity/testability).
 */
export function inFolderScope(folder: string, g: MissionGrant, homeDir: string): boolean {
  const target = normalizePath(folder, homeDir)
  const roots = g.folders.concat(g.dynamicFolders)
  return roots.some((r) => isWithinRoot(target, normalizePath(r, homeDir)))
}

/**
 * Decide how the given mutation should be treated against the live grants (S5).
 *
 *  - `allow` (+ grantId) — a LIVE grant covers this (folder, verb) and has budget.
 *  - `escalate` (+ reason) — a grant's AMBIT covers this folder but it can't be
 *    granted right now (verb not in scope / expired / exhausted / revoked). The
 *    gate maps this to a park (invariant 6 — escalation, not denial).
 *  - `none` — no mission touches this folder; the caller keeps its base verdict.
 *
 * Order matters: a live match wins over any escalate; among live matches the
 * soonest-to-expire is drained first (deterministic). `now`/`homeDir` injected.
 */
export function grantDecision(
  call: { folder: string; verb: McpOp },
  grants: readonly MissionGrant[],
  now: number,
  homeDir: string
): GrantDecision {
  // Grants whose ambit (folder scope) covers this call, regardless of verb/liveness.
  const inAmbit = grants.filter((g) => inFolderScope(call.folder, g, homeDir))
  if (inAmbit.length === 0) return { outcome: 'none' }

  // A live grant that also covers the verb → allow (drain soonest-expiry first).
  const grantable = inAmbit
    .filter((g) => g.verbs.includes(call.verb) && isLive(g, now))
    .sort((a, b) => a.expiresAt - b.expiresAt)
  if (grantable.length > 0) return { outcome: 'allow', grantId: grantable[0].id }

  // In ambit but not grantable → escalate with the least-blocking reason. A grant
  // that covers the verb but is dead names WHY it died; else the verb is out of scope.
  const verbMatches = inAmbit.filter((g) => g.verbs.includes(call.verb))
  if (verbMatches.length === 0) return { outcome: 'escalate', reason: 'out-of-scope' }
  return { outcome: 'escalate', reason: deadReason(verbMatches, now) }
}

/**
 * The verbatim disclosure body for the SINGLE mission-grant approval (invariant 3
 * — DISCLOSED, the T08 pattern). Shows the real goal, EVERY real folder path,
 * EVERY real verb, and the exact budget + TTL — no summarization, no "requests
 * access to your repos". Pure.
 */
export function buildGrantDisclosureText(g: {
  goal: string
  folders: readonly string[]
  verbs: readonly string[]
  budget: number
  ttlMinutes: number
}): string {
  return [
    `Mission: ${g.goal}`,
    '',
    'Grants the agent AUTO-APPROVAL (no per-action confirm) for:',
    `  Verbs: ${g.verbs.join(', ')}`,
    '  Folders:',
    ...g.folders.map((f) => `    ${f}`),
    '',
    `Bounded: up to ${g.budget} action${g.budget === 1 ? '' : 's'}, expires in ${g.ttlMinutes} min.`,
    'Out-of-scope calls still ask you. Revocable anytime.'
  ].join('\n')
}

/** The least-blocking death reason across verb-matching grants (revoked>exhausted>expired). */
function deadReason(grants: readonly MissionGrant[], now: number): EscalateReason {
  // A revoked grant is the most deliberate signal; then exhausted; then expired.
  if (grants.some((g) => g.revoked)) return 'revoked'
  if (grants.some((g) => g.spent >= g.budget)) return 'exhausted'
  if (grants.some((g) => now >= g.expiresAt)) return 'expired'
  return 'out-of-scope'
}
