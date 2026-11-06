/**
 * Which compose stacks Cleanup pauses on its own, and when (autonomous cleanup U3.5, design §4 U3
 * "Park", C7, AC-U3b, risks 10 and 11). Pure: every fact a shell read comes in as an argument, so
 * each rule is table-testable (ADR-0001). The action itself is U3.4's `pauseStack`; this file only
 * decides.
 *
 * Every rule fails closed: a fact that is missing (activity, connections, a clock) is a refusal,
 * never a pass. "Park" is the code word for what the UI calls "Paused".
 */

import type { PauseDecision } from '../containers/park-core'
import { isPausableVerdict } from '../containers/park-core'
import type { StackActivity } from '../containers/docker-activity-core'
import type { StackRow, Tombstone } from '../containers/containers-wire'
import type { SessionPresence } from './bundle-core'

const MIN_MS = 60_000
const HOUR_MS = 3_600_000
const NOTICE_TITLE = 'Workspace cleanup'

export type ParkRefusal =
  | 'not-pausable'
  | 'session-busy'
  | 'protected'
  | 'activity-unknown'
  | 'active'
  | 'browser-pane'
  | 'connections-unknown'
  | 'connection'
  | 'unknown-age'
  | 'too-young'
  | 'too-recent'

/**
 * What the shell read about one stack. There is deliberately no pull-request field: an open PR does
 * not protect a stack (design C7), only an explicit `keep` / `neverClean` mark does.
 */
export interface ParkFacts {
  stack: StackRow
  /** Presence of every Harnu session attached to a worktree that runs this stack. */
  sessions: readonly SessionPresence[]
  /** The worktree carries a `keep` or `neverClean` mark (C7: protects under pressure too). */
  protectedMark: boolean
  /** U3.2's CPU/IO read of the stack; null when it could not be read. */
  activity: StackActivity | null
  /** URLs of the Harnu browser panes that are open. */
  paneUrls: readonly string[]
  /** Established host connections to the stack's published ports; null when they could not be read. */
  established: number | null
}

export type ParkVerdict =
  { eligible: true; idleMs: number; since: number } | { eligible: false; reason: ParkRefusal }

export interface ParkContext {
  now: number
  idleHours: number
  minAgeMinutes: number
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

/**
 * True when `url` is a web page on this machine's loopback at one of `ports`. A pane that shows
 * the stack is a person looking at it, whatever its containers are doing.
 */
export function paneTargetsPort(url: string, ports: readonly number[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return false
  const port = parsed.port !== '' ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  return ports.includes(port)
}

const known = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0

/**
 * The full decision for one stack. Order: the verdict, the sessions, the protection marks, then
 * the idle signals (CPU/IO, a browser pane, a host connection), then the clocks.
 */
export function parkVerdict(f: ParkFacts, ctx: ParkContext): ParkVerdict {
  const no = (reason: ParkRefusal): ParkVerdict => ({ eligible: false, reason })
  const { stack } = f
  if (!isPausableVerdict(stack.verdict)) return no('not-pausable')
  if (f.sessions.some((s) => s === 'working' || s === 'needs-input')) return no('session-busy')
  if (f.protectedMark) return no('protected')
  if (f.activity === null) return no('activity-unknown')
  if (f.activity.active) return no('active')
  if (f.paneUrls.some((u) => paneTargetsPort(u, stack.ports))) return no('browser-pane')
  if (f.established === null) return no('connections-unknown')
  if (f.established > 0) return no('connection')

  const clocks = [stack.lastSessionActivityAt, stack.lastContainerEventAt].filter(known)
  const starts = stack.containers.map((c) => c.startedAt).filter(known)
  if (clocks.length === 0 || starts.length === 0 || !known(ctx.now)) return no('unknown-age')

  if (ctx.now - Math.max(...starts) < ctx.minAgeMinutes * MIN_MS) return no('too-young')
  const since = Math.max(...clocks)
  const idleMs = ctx.now - since
  if (idleMs < ctx.idleHours * HOUR_MS) return no('too-recent')
  return { eligible: true, idleMs, since }
}

/**
 * Pauses the autopilot made in the last hour, counted from the journal so the count survives a
 * restart. One per paused stack: a `compose down` entry carries a {@link PausedRecord}.
 */
export function pausesInLastHour(journal: readonly Tombstone[], now: number): number {
  let count = 0
  for (const t of journal) {
    if (t.actor !== 'autopilot' || t.verb !== 'stop' || t.at <= now - HOUR_MS) continue
    count += t.stacks.filter((s) => s.paused !== undefined).length
  }
  return count
}

export interface ParkCandidate extends ParkFacts {
  /** What `pauseStack` will be bound to: the stack, its exact containers and the verdict seen. */
  decision: PauseDecision
}

export interface PlannedPause {
  decision: PauseDecision
  idleMs: number
  reason: string
}

export interface ParkPlan {
  /** Longest-idle first, already cut to what the hourly cap leaves. */
  pauses: PlannedPause[]
  skipped: Array<{ stack: string; reason: ParkRefusal | 'hourly-cap' }>
}

/** `idle 3 h` from an hour up, `idle 40 min` below it. */
export function idleText(idleMs: number): string {
  return idleMs >= HOUR_MS
    ? `idle ${Math.floor(idleMs / HOUR_MS)} h`
    : `idle ${Math.floor(idleMs / MIN_MS)} min`
}

export function planPauses(input: {
  candidates: readonly ParkCandidate[]
  journal: readonly Tombstone[]
  now: number
  idleHours: number
  minAgeMinutes: number
  maxParksPerHour: number
}): ParkPlan {
  const ctx: ParkContext = {
    now: input.now,
    idleHours: input.idleHours,
    minAgeMinutes: input.minAgeMinutes
  }
  const eligible: PlannedPause[] = []
  const skipped: ParkPlan['skipped'] = []
  for (const c of input.candidates) {
    const v = parkVerdict(c, ctx)
    if (v.eligible) {
      eligible.push({ decision: c.decision, idleMs: v.idleMs, reason: idleText(v.idleMs) })
    } else {
      skipped.push({ stack: c.decision.stack, reason: v.reason })
    }
  }
  // Longest idle first: the stack least likely to be wanted back goes first when the cap bites.
  eligible.sort((a, b) => b.idleMs - a.idleMs || (a.decision.stack < b.decision.stack ? -1 : 1))
  const budget = Math.max(0, input.maxParksPerHour - pausesInLastHour(input.journal, input.now))
  for (const p of eligible.slice(budget)) {
    skipped.push({ stack: p.decision.stack, reason: 'hourly-cap' })
  }
  return { pauses: eligible.slice(0, budget), skipped }
}

/** The Activity line one pause writes: what was paused, why, and the command that undoes it. */
export function pauseActivityLine(args: { name: string; idleMs: number; restoreCommand: string }): {
  title: string
  body: string
} {
  return {
    title: NOTICE_TITLE,
    body: `Paused \`${args.name}\` — ${idleText(args.idleMs)} · bring back: \`${args.restoreCommand}\``
  }
}
