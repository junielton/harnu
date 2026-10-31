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
import type { Mission, MissionStep } from '../mission-core'
import type { MissionProgress } from '../mission-progress'
import type { MissionYouItem } from '../mcp/tool-handlers'

/** The cause `mission.state` is sent under; the gate row accepts nothing else. */
export const MISSION_STATE_SUBSYSTEM = 'missionState'

/** The slice of a `MissionView` (mission-ipc) the projection reads. */
export interface MissionViewIn {
  mission: Pick<Mission, 'id' | 'owner' | 'linkedCard' | 'blockers'> & {
    steps: Pick<MissionStep, 'id' | 'title' | 'kind' | 'links' | 'blockers'>[]
  }
  title: string
  progress: MissionProgress
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
  you: MissionYouItem[]
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

/** `owner`, `child` (a step links the session) or `null`. */
export function relationOf(v: MissionViewIn, sid: string): 'owner' | 'child' | null {
  if (v.mission.owner.sessionId === sid) return 'owner'
  const linked = v.mission.steps.some((s) =>
    s.links.some((l) => l.kind === 'session' && l.ref === sid)
  )
  return linked ? 'child' : null
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** What the operator owes, in the host's words. The mod draws them as the `⚑` rows. */
function youText(y: MissionYouItem): { kind: string; text: string } {
  switch (y.kind) {
    case 'rescope':
      return { kind: y.kind, text: 'approve the re-scope' }
    case 'close':
      return { kind: y.kind, text: 'close the mission' }
    case 'blocker':
      return { kind: y.kind, text: line(y.reason) }
    case 'checks':
      return {
        kind: y.kind,
        text: line(`${plural(y.count, 'due check')} on ${y.stepIds.join(', ')}`)
      }
    case 'human-steps':
      return { kind: y.kind, text: line(`tick ${y.stepIds.join(', ')}`) }
    case 'review-import':
      return { kind: y.kind, text: 'review the imported end' }
    case 'main-red':
      return { kind: y.kind, text: `main is red after #${y.pr}` }
    case 'approvals':
      return { kind: y.kind, text: `${plural(y.count, 'approval')} parked` }
    case 'needs-input':
      return { kind: y.kind, text: 'a child needs input' }
  }
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
    you: v.you.slice(0, MISSION_STATE_MAX_YOU).map(youText)
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
