/**
 * What the host tells the mod about the missions of one session (T589). Pure: the missions are read
 * by the shell (`mission-state.ts`), this file only picks the ones that are a session's and projects
 * them into the closed shape the mod draws a loop tick from.
 *
 * A mission is a session's when it owns it, or when one of its steps links the session as a child.
 * The projection carries the server's own `derived.progress` (never a recount), the executors of the
 * current step only, and the operator's `you` list worded in English: the mod keeps no vocabulary of
 * Harnu's, it draws what it is told. Every string is stripped of control characters and cut to the
 * mod's cap, so the mod's own check (the second lock) never refuses what the host sent.
 *
 * Types only are imported from the mission modules: this file runs in a test with no Electron.
 */

import {
  MISSION_STATE_MAX_BLOCKERS,
  MISSION_STATE_MAX_CHILDREN,
  MISSION_STATE_MAX_MISSIONS,
  MISSION_STATE_MAX_PRS,
  MISSION_STATE_MAX_STEPS,
  MISSION_STATE_MAX_YOU,
  MISSION_STATE_TEXT_MAX,
  type MissionStateEntry,
  type MissionStepStatus
} from './contract'
import type { MissionDetail } from '../missions/verbs-read'
import type { WaitingItemV4 } from '../missions/waiting'

/** The cause `mission.state` is sent under; the gate row accepts nothing else. */
export const MISSION_STATE_SUBSYSTEM = 'missionState'

/** One step of a mission as the projection reads it. */
interface StepIn {
  id: string
  title: string
  kind: 'custom' | 'fixed-start'
  links: { kind: string; ref: string }[]
  blockers: { reason: string; owner: 'agent' | 'operator' }[]
}

/** What the progress of a mission says, as the projection reads it. */
interface ProgressIn {
  total: number
  current: { from: number; to: number } | null
  done: number
  verified: number
  allDone: boolean
  states: Record<string, string>
}

/** The slice of a mission the projection reads: the v4 detail of one record, reshaped by {@link missionViewInOf}. */
export interface MissionViewIn {
  mission: {
    id: string
    linkedCard?: string
    blockers: { reason: string; owner: 'agent' | 'operator' }[]
    owner: { sessionId: string }
    steps: StepIn[]
  }
  /** Session ids attached to the mission as workers (v4 keeps them on the mission, not on a step). */
  workers?: readonly string[]
  title: string
  progress: ProgressIn
  derived: {
    steps: {
      stepId: string
      children: { sessionId: string; taskState?: string; lastTransitionAt?: string }[]
      links: ({ kind: string; prs?: { number: number; state: string }[] } & Record<
        string,
        unknown
      >)[]
    }[]
  }
  you: readonly WaitingItemV4[]
}

// A pushed string is one printable line: C0 controls, DEL, C1 and the Unicode line separators go.
// eslint-disable-next-line no-control-regex -- the point is to strip control characters
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g')

/** One printable line of at most `max` characters; an empty one is `fallback`. */
function line(s: unknown, max = MISSION_STATE_TEXT_MAX, fallback = '—'): string {
  const t = (typeof s === 'string' ? s : '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (t === '') return fallback
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** `owner`, `child` (a worker of the mission, or a step links the session) or `null`. */
export function relationOf(v: MissionViewIn, sid: string): 'owner' | 'child' | null {
  if (v.mission.owner.sessionId === sid) return 'owner'
  if (v.workers?.includes(sid)) return 'child'
  const linked = v.mission.steps.some((s) =>
    s.links.some((l) => l.kind === 'session' && l.ref === sid)
  )
  return linked ? 'child' : null
}

const PR_STATES = new Set(['OPEN', 'MERGED', 'CLOSED'])

function prsOf(
  links: {
    kind: string
    prs?: { number: number; state: string }[]
    number?: unknown
    state?: unknown
  }[]
): { number: number; state: string }[] {
  const seen = new Map<number, string>()
  const add = (n: unknown, state: unknown): void => {
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && typeof state === 'string') {
      if (!seen.has(n) && PR_STATES.has(state)) seen.set(n, state)
    }
  }
  for (const l of links) {
    if (l.kind === 'pr') add(l.number, l.state)
    for (const p of l.prs ?? []) add(p.number, p.state)
  }
  return [...seen]
    .sort((a, b) => a[0] - b[0])
    .slice(0, MISSION_STATE_MAX_PRS)
    .map(([number, state]) => ({ number, state }))
}

function project(v: MissionViewIn, role: 'owner' | 'child'): MissionStateEntry {
  const m = v.mission
  const p = v.progress
  const all = m.steps.filter((s) => s.kind !== 'fixed-start')
  // Past the cap, a window of steps around the current one, so the card still has its step: the
  // positions in `progress` are the mission's own, and `offset` says where the window starts.
  const start =
    all.length <= MISSION_STATE_MAX_STEPS
      ? 0
      : Math.max(
          0,
          Math.min(all.length - MISSION_STATE_MAX_STEPS, (p.current?.from ?? all.length) - 1 - 10)
        )
  const counted = all.slice(start, start + MISSION_STATE_MAX_STEPS)
  const signals = new Map(v.derived.steps.map((s) => [s.stepId, s]))
  const cur = p.current
  const steps = counted.map((s, i) => {
    const position = start + i + 1
    const sig = signals.get(s.id)
    const inRange = cur !== null && position >= cur.from && position <= cur.to
    const cardLink = s.links.find((l) => l.kind === 'card')
    const state = (p.states[s.id] ?? 'todo') as MissionStepStatus
    return {
      id: line(s.id, 40),
      title: line(s.title),
      state,
      ...(cardLink ? { card: line(cardLink.ref, 60) } : {}),
      children: inRange
        ? (sig?.children ?? [])
            // The owner is never a builder: its own link on a step does not make it an executor.
            .filter((c) => c.sessionId !== m.owner.sessionId)
            .slice(0, MISSION_STATE_MAX_CHILDREN)
            .map((c) => {
              const at = c.lastTransitionAt ? Date.parse(c.lastTransitionAt) : NaN
              return {
                taskState: line(c.taskState, 24, 'unknown'),
                lastTransitionAt: Number.isFinite(at) ? at : null
              }
            })
        : [],
      prs: prsOf((sig?.links ?? []) as never)
    }
  })
  const blockers = [
    ...m.blockers.map((b) => ({ reason: b.reason, owner: b.owner })),
    ...m.steps.flatMap((s) =>
      s.blockers.map((b) => ({ reason: b.reason, owner: b.owner, stepId: s.id }))
    )
  ]
    .slice(0, MISSION_STATE_MAX_BLOCKERS)
    .map((b) => ({
      reason: line(b.reason),
      owner: b.owner,
      ...('stepId' in b ? { stepId: line(b.stepId, 40) } : {})
    }))
  return {
    id: m.id,
    title: line(v.title),
    ...(m.linkedCard ? { card: line(m.linkedCard, 60) } : {}),
    ...(start > 0 ? { offset: start } : {}),
    role,
    progress: {
      total: p.total,
      current: p.current,
      done: p.done,
      verified: p.verified,
      allDone: p.allDone
    },
    steps,
    blockers,
    // The waiting list's own words (`ask`, written once in `missions/waiting.ts`): the mod keeps no
    // vocabulary of Harnu's.
    you: v.you.slice(0, MISSION_STATE_MAX_YOU).map((y) => ({ kind: y.kind, text: line(y.ask) }))
  }
}

/**
 * What the view gathered about the steps beyond the record (S-40, Decision 12): each step's pull request
 * state and whether a worker is working on it, and the live state of a session. Read on the server by the
 * view channel; a call never supplies it.
 */
export interface ViewFacts {
  steps?: Readonly<Record<string, { pr?: string; workerWorking?: boolean }>>
  /** The live `taskState` of a session, or `undefined` when it has none. */
  taskState?: (sessionId: string) => string | undefined
}

/** The number a `pr` link names: `owner/repo#123`, `#123`, `123` or a `/pull/123` URL. */
function prNumberOf(ref: string): number | null {
  const m = /(?:#|\/pull\/|^)(\d+)\/?\s*$/.exec(ref.trim())
  return m ? Number(m[1]) : null
}

const PR_STATE_OF: Record<string, 'OPEN' | 'MERGED' | 'CLOSED'> = {
  open: 'OPEN',
  merged: 'MERGED',
  closed: 'CLOSED'
}

/**
 * Missions v4 S-23, S-40 — the view the mod draws from, built from the v4 detail the record store serves
 * (`missionGet`) for a v3 and a v4 record alike. The mod's own vocabulary stays: a step waiting for
 * review reads `waiting`, a blocked mark reads `blocked`, and nothing reads `verified` (v4 has no such
 * state). The position is derived from the steps: the running and waiting ones, else the first to do.
 * With the view's facts a step carries its executors (the sessions its `session` links name, other than
 * the leader, with their live state) and its pull request badges (the `pr` links whose state was read);
 * without them it carries none, and the mod draws the step bare.
 */
export function missionViewInOf(detail: MissionDetail, facts: ViewFacts = {}): MissionViewIn {
  const status = (s: MissionDetail['steps'][number]): string =>
    s.blocked ? 'blocked' : s.state === 'waiting-review' ? 'waiting' : s.state
  const states = Object.fromEntries(detail.steps.map((s) => [s.id, status(s)]))
  const total = detail.steps.length
  const active = detail.steps
    .map((s, i) => (s.state === 'running' || s.state === 'waiting-review' ? i + 1 : 0))
    .filter((n) => n > 0)
  const firstTodo = detail.steps.findIndex((s) => s.state === 'todo') + 1
  const current =
    active.length > 0
      ? { from: Math.min(...active), to: Math.max(...active) }
      : firstTodo > 0
        ? { from: firstTodo, to: firstTodo }
        : null
  const done = detail.steps.filter((s) => s.state === 'done').length
  const blockerOf = (b: {
    reason: string
    owner: 'agent' | 'operator'
  }): { reason: string; owner: 'agent' | 'operator' } => ({
    reason: b.reason,
    owner: b.owner
  })
  return {
    mission: {
      id: detail.id,
      owner: { sessionId: detail.leads ?? '' },
      linkedCard: undefined as unknown as string,
      blockers: detail.blockers.map(blockerOf) as never,
      steps: detail.steps.map((s) => ({
        id: s.id,
        title: s.title,
        kind: 'custom',
        links: [
          ...s.links.map((l) => ({ kind: l.kind, ref: l.ref })),
          ...(s.card ? [{ kind: 'card', ref: s.card }] : [])
        ],
        blockers: s.blockers.map(blockerOf)
      })) as never
    },
    workers: detail.sessions.filter((e) => e.to === null && e.role === 'worked').map((e) => e.id),
    title: detail.title,
    progress: {
      total,
      current,
      done,
      verified: 0,
      allDone: total > 0 && done === total,
      states: states as never
    },
    derived: {
      steps: detail.steps.map((s) => {
        const fact = facts.steps?.[s.id]
        const prState = fact?.pr !== undefined ? PR_STATE_OF[fact.pr] : undefined
        const prLinks = s.links.filter((l) => l.kind === 'pr')
        return {
          stepId: s.id,
          children: s.links
            .filter((l) => l.kind === 'session' && l.ref !== detail.leads)
            .map((l) => ({ sessionId: l.ref, taskState: facts.taskState?.(l.ref) })),
          links:
            prState === undefined
              ? []
              : prLinks.flatMap((l) => {
                  const number = prNumberOf(l.ref)
                  return number === null ? [] : [{ kind: 'pr', number, state: prState }]
                })
        }
      })
    },
    you: detail.waiting.items
  }
}

/**
 * The missions that are `sid`'s, projected: the ones it owns first, then the ones it is a child of,
 * each group in the order given (newest first), at most {@link MISSION_STATE_MAX_MISSIONS}.
 */
export function projectMissions(views: readonly MissionViewIn[], sid: string): MissionStateEntry[] {
  const rows = views.flatMap((v) => {
    const role = relationOf(v, sid)
    return role === null ? [] : [{ v, role }]
  })
  const ordered = [
    ...rows.filter((r) => r.role === 'owner'),
    ...rows.filter((r) => r.role === 'child')
  ]
  return ordered.slice(0, MISSION_STATE_MAX_MISSIONS).map((r) => project(r.v, r.role))
}

/**
 * The key two projections are compared by: the whole projection. It carries the time an executor last
 * changed state (a fact that moves only when it does), never the time since, which the mod computes
 * itself, so a quiet mission is not re-sent every poll.
 */
export function missionStateKey(entries: readonly MissionStateEntry[]): string {
  return JSON.stringify(entries)
}
