/**
 * Missions v4 · S-17 — what the Mission pane and the Topbar pill read out of the view channel
 * (design.md §6 "Mission pane"). Pure: no store, no `window.api`.
 *
 * The channel answers `{ state: 'mission' | 'none' | 'refused' }` (`mission:v4View`). This module
 * decides what a reply MEANS for one session — a v4 mission to draw, no mission, a refusal, or a v3
 * record the popover still serves — and words the numbers the server already counted. It never recounts:
 * the pill's "4/21 · 3 for you" is `progress.done`, `progress.total` and the length of the waiting list,
 * and the state is the identifier translated through i18n, never the English words in the reply.
 */
import type { MissionV4ViewReply } from '../../../main/mission-ipc'

type Translate = (key: string, values?: Record<string, unknown>, plural?: number) => string

/** The `state: 'mission'` branch of the view's reply. */
export type MissionV4Reply = Extract<MissionV4ViewReply, { state: 'mission' }>

/** What the pane draws: a state of its own, not a gap. */
export type PaneKind = 'loading' | 'mission' | 'none' | 'refused' | 'v3'

/**
 * What a reply means for `sessionId`.
 *
 * - `null` (no answer yet) is `loading`.
 * - A mission the session is not an OPEN row of is `none`: a named read of a record the session left
 *   (a hand-off closed its row) must never show another session's mission here.
 * - A mission the operator closed is `none` too: it leaves the pane and the session shows the
 *   no-mission state.
 * - A v3 record (`source` other than `v4`) is `v3`: the v3 stack serves it, the pane does not draw it.
 */
export function classifyReply(reply: MissionV4ViewReply | null, sessionId: string): PaneKind {
  if (reply === null) return 'loading'
  if (reply.state === 'refused') return 'refused'
  if (reply.state === 'none') return 'none'
  if (!reply.sessions.some((row) => row.id === sessionId && row.open)) return 'none'
  if (reply.detail.status === 'closed') return 'none'
  return reply.source === 'v4' ? 'mission' : 'v3'
}

/** The v4 mission this reply holds for `sessionId`, or `null` (anything else the pane or pill shows). */
export function v4MissionOf(
  reply: MissionV4ViewReply | null,
  sessionId: string
): MissionV4Reply | null {
  return classifyReply(reply, sessionId) === 'mission' ? (reply as MissionV4Reply) : null
}

/** Whether a NAMED read should be dropped and asked again by session: it is neither a v4 nor a v3 mission of it. */
export function isStaleNamedRead(reply: MissionV4ViewReply | null, sessionId: string): boolean {
  const kind = classifyReply(reply, sessionId)
  return kind === 'none' || kind === 'refused'
}

/** The numbers the pill and the pane read, all from the server. */
export interface MissionNumbers {
  done: number
  total: number
  unit: 'milestones' | 'steps'
  /** How many things wait on the operator (the waiting list's length). */
  forYou: number
  readyToClose: boolean
}

export function missionNumbers(detail: MissionV4Reply['detail']): MissionNumbers {
  return {
    done: detail.progress.done,
    total: detail.progress.total,
    unit: detail.progress.unit,
    forYou: detail.waiting.items.length,
    readyToClose: detail.state === 'ready-to-close'
  }
}

/**
 * The pill's label: "4/21 · 3 for you", "4/21" when nothing waits, "21/21 · ready to close" when every
 * step is done. Milestones when the mission has them (`progress.unit` says so; the shape is the same).
 */
export function missionPillText(t: Translate, detail: MissionV4Reply['detail']): string {
  const n = missionNumbers(detail)
  const count = t('missionPane.pill.count', { done: n.done, total: n.total })
  const tail = n.readyToClose
    ? t('missionPane.pill.readyToClose')
    : n.forYou > 0
      ? t('missionPane.pill.forYou', { n: n.forYou })
      : ''
  return tail ? t('missionPane.pill.joined', { count, tail }) : count
}

/** The pill's tone: success when ready to close, warning while something waits on the operator, else accent. */
export type V4PillTone = 'accent' | 'warning' | 'success'

export function missionPillTone(detail: MissionV4Reply['detail']): V4PillTone {
  const n = missionNumbers(detail)
  if (n.readyToClose) return 'success'
  return n.forYou > 0 ? 'warning' : 'accent'
}

/**
 * The pill's classes per tone (design.md §6 "Mission pane" → Topbar pill — v4): the mockup's tinted
 * look — the tone's `-line` border, its `-soft` background and its text — and the `ring-2` of a pressed
 * pill (the pane is open).
 */
export const V4_PILL_TONE_CLASS: Record<V4PillTone, string> = {
  accent: 'border-accent-line bg-accent-soft text-accent',
  warning: 'border-warning-line bg-warning-soft text-warning',
  success: 'border-green-line bg-green-soft text-green'
}

export const V4_PILL_RING_CLASS: Record<V4PillTone, string> = {
  accent: 'ring-2 ring-accent-line',
  warning: 'ring-2 ring-warning-line',
  success: 'ring-2 ring-green-line'
}

/** The count line under the title: "4 of 21 steps done" / "1 of 10 milestones done", from the server's numbers. */
export function missionProgressLine(t: Translate, detail: MissionV4Reply['detail']): string {
  const n = missionNumbers(detail)
  // The unit agrees with the TOTAL ("0 of 1 step done", "4 of 21 steps done"): the plural form follows it.
  return t(
    n.unit === 'milestones' ? 'missionPane.progress.milestones' : 'missionPane.progress.steps',
    { done: n.done, total: n.total },
    n.total
  )
}

/** The state's identifier as the pane shows it: `open` shows nothing, the others are translated by identifier. */
export function missionStateKey(detail: MissionV4Reply['detail']): string | null {
  if (detail.state === 'open') return null
  if (detail.state === 'ready-to-close' || detail.state === 'closed') {
    return `missionPane.state.${detail.state}`
  }
  return null
}
