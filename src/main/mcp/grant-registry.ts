/**
 * In-memory mission-grant registry (T44 S5 env shell). Holds the live grants the
 * pure {@link grantDecision} reads. IN-MEMORY ONLY — a capability surviving a
 * restart is a security smell, so grants die with the process (like the confirm
 * stash + shadow ring). All security math lives in `grant-core.ts`; this owns the
 * mutable Map, the TTL timers, and change broadcasts.
 *
 * The one subtlety that matters: `reserve` is ATOMIC + SYNCHRONOUS (Node is
 * single-threaded, and the gate→reserve→actuate path never yields before the
 * increment), which closes the concurrent-over-budget hole. Spend is committed at
 * reserve and refunded via `release` on a failed actuation, so budget is charged
 * only for a successful mutation.
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { normalizePath } from './permission-core'
import { isLive, remaining, type MissionGrant } from './grant-core'
import type { McpOp } from './tool-catalog'

/** Max concurrent grants; a create over this evicts the oldest. */
export const GRANT_CAP = 16

const grants = new Map<string, MissionGrant>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
let onChange: (() => void) | null = null
let seq = 0

/** The redacted grant row the UI/IPC sees (folders aliased to basenames). */
export interface GrantView {
  id: string
  goal: string
  folders: string[]
  dynamicFolders: string[]
  verbs: McpOp[]
  budget: number
  spent: number
  remaining: number
  expiresAt: number
  revoked: boolean
  live: boolean
}

/** Register a listener fired on every create/spend/revoke/expire (→ broadcast to the UI). */
export function setGrantChangeListener(fn: (() => void) | null): void {
  onChange = fn
}

function emitChange(): void {
  try {
    onChange?.()
  } catch {
    /* a listener fault must never break a grant mutation */
  }
}

function clearTimer(id: string): void {
  const t = timers.get(id)
  if (t) {
    clearTimeout(t)
    timers.delete(id)
  }
}

export interface CreateGrantInput {
  goal: string
  folders: readonly string[]
  verbs: readonly McpOp[]
  budget: number
  ttlMinutes: number
  homeDir?: string
  now?: number
}

/** Mint + register a grant. Folders are normalized so scope-matching is consistent. */
export function createGrant(input: CreateGrantInput): MissionGrant {
  const now = input.now ?? Date.now()
  const home = input.homeDir ?? homedir()
  if (grants.size >= GRANT_CAP) {
    const oldest = grants.keys().next().value
    if (oldest !== undefined) {
      grants.delete(oldest)
      clearTimer(oldest)
    }
  }
  const g: MissionGrant = {
    id: `grant-${++seq}-${randomUUID().slice(0, 8)}`,
    goal: input.goal,
    folders: input.folders.map((f) => normalizePath(f, home)),
    dynamicFolders: [],
    verbs: [...input.verbs],
    budget: input.budget,
    spent: 0,
    expiresAt: now + input.ttlMinutes * 60_000,
    createdAt: now,
    revoked: false
  }
  grants.set(g.id, g)
  // Lazy expiry: `isLive` already denies past `expiresAt`; the timer only nudges
  // the UI (and cleans itself). The grant lingers (escalating in-ambit calls)
  // until cap-evicted — not removed on expiry, so an in-scope call still parks.
  timers.set(
    g.id,
    setTimeout(
      () => {
        clearTimer(g.id)
        emitChange()
      },
      Math.max(0, g.expiresAt - now)
    )
  )
  emitChange()
  return g
}

/**
 * ATOMIC reserve of one unit of budget: if the grant is live, increment `spent`
 * and return true; else false (caller escalates instead of over-spending). Must
 * be called synchronously at the gate, before actuation.
 */
export function reserve(id: string, now: number = Date.now()): boolean {
  const g = grants.get(id)
  if (!g || !isLive(g, now)) return false
  g.spent++
  emitChange()
  return true
}

/**
 * Remaining budget for a grant, read straight off the live registry — the
 * race-free proprioception the server echoes in a grant-allowed ACK (T77c). Meant
 * to be called SYNCHRONOUSLY right after {@link reserve} (before any await), so the
 * figure reflects this action's just-committed spend and no concurrent reserve can
 * shift it under us. Returns 0 for an unknown/absent grant.
 */
export function remainingFor(id: string): number {
  const g = grants.get(id)
  return g ? remaining(g) : 0
}

/** Refund a reserved unit when the actuation failed (commit only on success). */
export function release(id: string): void {
  const g = grants.get(id)
  if (g && g.spent > 0) {
    g.spent--
    emitChange()
  }
}

/** Revoke a grant immediately; in-flight (already-reserved) calls finish, new ones escalate. */
export function revokeGrant(id: string): boolean {
  const g = grants.get(id)
  if (!g || g.revoked) return false
  g.revoked = true
  emitChange()
  return true
}

/** Extend a grant's scope to a worktree it created (D3 — the only runtime growth). */
export function addDynamicFolder(id: string, path: string, homeDir?: string): void {
  const g = grants.get(id)
  if (!g) return
  const n = normalizePath(path, homeDir ?? homedir())
  if (!g.dynamicFolders.includes(n)) {
    g.dynamicFolders.push(n)
    emitChange()
  }
}

/** Live grant objects for the pure {@link grantDecision} (same refs — read-only use). */
export function snapshotGrants(): MissionGrant[] {
  return [...grants.values()]
}

/** Redacted rows for the UI/IPC (folders → basenames). */
export function listGrants(now: number = Date.now()): GrantView[] {
  return [...grants.values()].map((g) => ({
    id: g.id,
    goal: g.goal,
    folders: g.folders.map((f) => basename(f)),
    dynamicFolders: g.dynamicFolders.map((f) => basename(f)),
    verbs: [...g.verbs],
    budget: g.budget,
    spent: g.spent,
    remaining: remaining(g),
    expiresAt: g.expiresAt,
    revoked: g.revoked,
    live: isLive(g, now)
  }))
}

/** Deny + clear every grant on server/window teardown (a grant never outlives the server). */
export function closeGrants(): void {
  for (const id of [...timers.keys()]) clearTimer(id)
  grants.clear()
  onChange = null
}

/** Test-only reset. */
export function _resetGrants(): void {
  for (const id of [...timers.keys()]) clearTimer(id)
  grants.clear()
  seq = 0
  onChange = null
}
