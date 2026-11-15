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
import { sessionTitle, type SessionLike } from './session-label'

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

// ---- Missions v4 · S-18 — the glance: the bar, the next step and the tree ---------------------------
//
// Pure like the rest of this module. The tree READS the view: a step's state, a milestone's state, the
// progress and the waiting list are the server's. What it adds is order and fold (which steps show
// first, which fold behind "N more"), not state. It counts steps only by the state the server gave
// them, for the "{done}/{total}" a milestone row carries (the view has no per-milestone total).

type Detail = MissionV4Reply['detail']
type StepView = Detail['steps'][number]
type CriterionView = StepView['criteria'][number]
type WaitingItem = Detail['waiting']['items'][number]

/** The width of the progress bar's fill, as a percentage of the server's `done` over its `total`. */
export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, (done / total) * 100))
}

/** The one step a waiting item names, or `null` when it names none (or several). */
export function waitingStepId(item: WaitingItem): string | null {
  switch (item.kind) {
    case 'main-failing':
    case 'settle':
      return item.stepId
    case 'unblock':
      return item.stepId
    case 'review':
      return item.stepIds.length === 1 ? item.stepIds[0] : null
    default:
      return null
  }
}

/** Every step id the waiting list names: the steps the operator owes something on. */
function owedStepIds(detail: Detail): Set<string> {
  const ids = new Set<string>()
  for (const item of detail.waiting.items) {
    if (item.kind === 'review') item.stepIds.forEach((id) => ids.add(id))
    else if ('stepId' in item && item.stepId) ids.add(item.stepId)
  }
  return ids
}

/** The pull request number of a step's `pr` link ("256", "#256" or a pull request URL), or `null`. */
function prNumberOf(links: StepView['links']): string | null {
  const link = links.find((l) => l.kind === 'pr')
  if (!link) return null
  const m = /(\d+)\s*$/.exec(link.ref.replace(/\/+$/, ''))
  return m ? m[1] : null
}

// ---- Missions v4 · S-19 — an open step: who settles each criterion, the blocker and the links ----------
//
// Still pure. The server says which criteria are settled and by what (`by`, `settled`); this only splits
// them (verified ones fold into a count, open ones are listed), names who settles each and works out
// what a link opens. A blocker is the server's `reason`, `ask` and `unblocks`, shown as written.

/** What settles a criterion: a fact Harnu reads, a second session, the operator, or another person. */
export type Settler = CriterionView['by']

/** One OPEN criterion of an open step. */
export interface CriterionRow {
  id: string
  text: string
  settler: Settler
  /** The person a `person` criterion waits for, or `null` (a `person` criterion that names none). */
  person: string | null
  /** A builder's own check: labelled, and never proof, so the criterion stays open. */
  selfCheck: boolean
  /** The operator has a button for it: their own criterion, or another person's approval. */
  canMark: boolean
}

/** A blocker that still shows on a step. */
export interface BlockerRow {
  id: string
  reason: string
  ask: string | null
  unblocks: string | null
  owner: 'agent' | 'operator'
  /** Milliseconds since the blocker was raised, or `null` when the record has no time. */
  waitedMs: number | null
}

/**
 * One link of an open step: a pull request, the finished page, a report. `url` is `null` when there is
 * nothing to open. A `page` row's `label` is the bare `host/path`: the renderer words it ("Page · …").
 */
export interface StepLinkRow {
  key: string
  kind: 'pr' | 'page' | 'figma' | 'doc' | 'file' | 'link'
  label: string
  url: string | null
}

/** The part of a link the footer's Links shelf collects (`sessionLinksList`) that this view reads. */
export interface SessionLinkLike {
  url: string
  kind: 'pr' | 'issue' | 'task' | 'figma' | 'doc' | 'web'
  label: string
  /** `agent` for a link the session wrote, `user` for one the operator did. Only the session's are shown. */
  source: 'user' | 'agent'
  /** ISO time of the link's latest occurrence in the transcript. */
  at?: string
}

/** What a step draws beyond the server's own fields. `now` is the clock of the caller (a pure module never reads it). */
export interface StepContext {
  sessionLinks?: readonly SessionLinkLike[]
  now?: number
}

/** The newest session links one step lists: a session that wrote a lot of links does not bury the step. */
export const SESSION_LINK_CAP = 8

/** `https://…` or `http://…` as a normalised address, or `null`: nothing else is ever opened. */
export function httpAddress(ref: string): string | null {
  try {
    const u = new URL(ref.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? ref.trim() : null
  } catch {
    return null
  }
}

/** A host that is this machine's: the address of a page the session is serving, not a site on the internet. */
function isLocalHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.test')
  )
}

/** `host/path` of an address, without the scheme, a trailing slash or the query. */
function hostAndPath(address: string): string {
  const u = new URL(address)
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')
  return `${u.host}${path}`
}

const PULL_NUMBER_RE = /\/pull\/(\d+)(?:[/?#]|$)/

/** The address of a step's pull request: its own link when that is an address, else the session's matching one. */
function prAddress(
  number: string,
  ref: string,
  sessionLinks: readonly SessionLinkLike[]
): string | null {
  const own = httpAddress(ref)
  if (own && PULL_NUMBER_RE.exec(own)?.[1] === number) return own
  const found = sessionLinks.find(
    (l) => l.kind === 'pr' && PULL_NUMBER_RE.exec(l.url)?.[1] === number
  )
  return found ? (httpAddress(found.url) ?? null) : null
}

const LINK_RANK: Record<StepLinkRow['kind'], number> = {
  pr: 0,
  page: 1,
  figma: 2,
  doc: 2,
  file: 2,
  link: 2
}

/**
 * What an open step lists under "Links from the session": its pull request, the finished page and the
 * reports. They come from the step's own links (the pull request Harnu found, what the agent added with
 * mission_link) and — for a step the session is working now — from the links Harnu collected from that
 * session's transcript, the ones the session wrote. The pull request comes first, then pages, then the
 * rest in the order they were written; a link in both places is listed once.
 */
export function stepLinkRows(
  links: StepView['links'],
  sessionLinks: readonly SessionLinkLike[],
  opts: {
    /** The links an address is looked up in; the ones listed are `sessionLinks`. All of them by default. */
    resolveIn?: readonly SessionLinkLike[]
    /** When the step started (ms): a session link written before it belongs to an earlier step. */
    since?: number | null
    /** When the next step the session works started (ms): a link written from then on is that step's. */
    until?: number | null
    /** Pull request numbers that are another step's: the session's link to one is that step's, not this one's. */
    otherPrs?: ReadonlySet<string>
  } = {}
): StepLinkRow[] {
  const resolveIn = opts.resolveIn ?? sessionLinks
  const rows: StepLinkRow[] = []
  const seen = new Set<string>()
  const add = (row: StepLinkRow, dedupe: string): void => {
    if (seen.has(dedupe)) return
    seen.add(dedupe)
    rows.push(row)
  }

  for (const l of links) {
    if (l.kind === 'session') continue
    if (l.kind === 'pr') {
      const number = /(\d+)\s*$/.exec(l.ref.replace(/\/+$/, ''))?.[1]
      if (!number) continue
      add(
        {
          key: `pr:${number}`,
          kind: 'pr',
          label: `#${number}`,
          url: prAddress(number, l.ref, resolveIn)
        },
        `pr:${number}`
      )
      continue
    }
    const address = httpAddress(l.ref)
    if (address === null) {
      // A repo path (or anything else a record holds): shown, never opened.
      add({ key: `${l.kind}:${l.ref}`, kind: 'file', label: l.ref, url: null }, l.ref)
      continue
    }
    const local = isLocalHost(new URL(address).hostname)
    add(
      {
        key: `${l.kind}:${address}`,
        kind: local ? 'page' : l.kind === 'doc' ? 'doc' : 'link',
        label: hostAndPath(address),
        url: address
      },
      address
    )
  }

  let extra = 0
  for (const l of sessionLinks) {
    if (l.source !== 'agent' || extra >= SESSION_LINK_CAP) continue
    const address = httpAddress(l.url)
    if (address === null) continue
    if (opts.since != null && l.at !== undefined) {
      const at = Date.parse(l.at)
      if (Number.isFinite(at) && at < opts.since) continue
    }
    if (opts.until != null && l.at !== undefined) {
      const at = Date.parse(l.at)
      if (Number.isFinite(at) && at >= opts.until) continue
    }
    const number = l.kind === 'pr' ? PULL_NUMBER_RE.exec(address)?.[1] : undefined
    if (number && opts.otherPrs?.has(number) && !seen.has(`pr:${number}`)) continue
    if (number && seen.has(`pr:${number}`)) continue
    if (seen.has(address)) continue
    const local = isLocalHost(new URL(address).hostname)
    const kind: StepLinkRow['kind'] = number
      ? 'pr'
      : local
        ? 'page'
        : l.kind === 'figma'
          ? 'figma'
          : l.kind === 'doc'
            ? 'doc'
            : 'link'
    extra++
    add(
      {
        key: number ? `pr:${number}` : address,
        kind,
        label: number ? `#${number}` : local ? hostAndPath(address) : l.label,
        url: address
      },
      number ? `pr:${number}` : address
    )
  }

  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => LINK_RANK[a.row.kind] - LINK_RANK[b.row.kind] || a.i - b.i)
    .map((x) => x.row)
}

/** The codes a door can answer that the pane words one by one; any other code reads as `other`. */
const DOOR_CODES = ['NOT_FOUND', 'WRITE_CONFLICT', 'MISSION_CLOSED', 'SETTLES_ITSELF'] as const

/** The i18n key (under `missionPane.step.error`) that says what to do after a door was refused with `code`. */
export function doorErrorKey(code: string): (typeof DOOR_CODES)[number] | 'other' {
  return (DOOR_CODES as readonly string[]).includes(code)
    ? (code as (typeof DOOR_CODES)[number])
    : 'other'
}

/** How long something has waited, from a duration: "<1m", "40m", "1h 50m", "3d". */
export function formatWaited(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
  }
  return `${Math.floor(hours / 24)}d`
}

/** The criteria of a step, split: how many the server says are settled, and the ones still open. */
export function splitCriteria(criteria: readonly CriterionView[]): {
  verified: number
  open: CriterionRow[]
} {
  const open = criteria
    .filter((c) => !c.settled)
    .map((c): CriterionRow => ({
      id: c.id,
      text: c.text,
      settler: c.by,
      person: c.person ?? null,
      selfCheck: c.selfCheck !== undefined,
      canMark: c.by === 'operator' || c.by === 'person'
    }))
  return { verified: criteria.length - open.length, open }
}

function blockerRows(blockers: StepView['blockers'], now: number | undefined): BlockerRow[] {
  return blockers.map((b) => {
    const raised = b.raisedAt !== undefined ? Date.parse(b.raisedAt) : Number.NaN
    return {
      id: b.id,
      reason: b.reason,
      ask: b.ask !== undefined && b.ask !== '' && b.ask !== b.reason ? b.ask : null,
      unblocks: b.unblocks !== undefined && b.unblocks !== '' ? b.unblocks : null,
      owner: b.owner,
      waitedMs: now !== undefined && Number.isFinite(raised) ? Math.max(0, now - raised) : null
    }
  })
}

/** One step row of the tree. */
export interface PaneStepRow {
  id: string
  title: string
  /** The server's identifier: `todo`, `running`, `waiting-review` or `done`. */
  state: string
  blocked: boolean
  /** The waiting list names this step: the operator owes it something. */
  needsYou: boolean
  pr: string | null
  criteria: CriterionView[]
  /** S-19: where the pull request number opens, or `null` when Harnu has no address for it. */
  prUrl: string | null
  /** S-19: how many criteria the server says are settled, and the ones still open. */
  verified: number
  open: CriterionRow[]
  /** S-19: the blockers that still show. */
  blockers: BlockerRow[]
  /** S-19: the links an open step lists (see {@link stepLinkRows}). */
  links: StepLinkRow[]
}

/** The steps a milestone (or a mission with no milestones) draws, and the ones folded behind "N more". */
export interface StepGroups {
  shown: PaneStepRow[]
  folded: PaneStepRow[]
}

/**
 * The order inside a milestone: the steps the operator owes first, then the running ones, each in plan
 * order; every other step is folded behind "N more", in plan order. A step is in exactly one place.
 */
export function orderSteps(rows: PaneStepRow[]): StepGroups {
  const owed = rows.filter((r) => r.needsYou)
  const running = rows.filter((r) => !r.needsYou && r.state === 'running')
  const folded = rows.filter((r) => !r.needsYou && r.state !== 'running')
  return { shown: [...owed, ...running], folded }
}

/** One milestone row of the tree. */
export interface PaneMilestoneRow extends StepGroups {
  id: string
  title: string
  optional: boolean
  /** The server's identifier: `not-started`, `in-progress`, `waiting-review` or `done`. */
  state: string
  /** The server's current milestone: the first in plan order that is neither done nor optional. */
  current: boolean
  /** Only the current milestone opens by itself. */
  openByDefault: boolean
  /** Steps the server says are done, over the milestone's counted steps (all of them when none count). */
  done: number
  total: number
  /** The server's counts: running, waiting for review and blocked. To do is never counted. */
  counts: { running: number; waitingReview: number; blocked: number }
  /** The milestone it waits for, only when that is not the previous one and is not done yet. */
  waitsFor: { id: string; title: string } | null
}

export interface PaneTree {
  /** The required milestones, in plan order. */
  milestones: PaneMilestoneRow[]
  /** The optional ones, in plan order: they sit under one collapsed line. */
  optional: PaneMilestoneRow[]
  /** A mission with no milestones draws its steps directly; `null` when it has milestones. */
  loose: StepGroups | null
}

export function buildPaneTree(detail: Detail, ctx: StepContext = {}): PaneTree {
  const owed = owedStepIds(detail)
  const sessionLinks = ctx.sessionLinks ?? []
  // When each step the session is working on started: the windows its links are shared out by.
  const workingStarts = detail.steps.flatMap((x) => {
    const t = x.startedAt !== null ? Date.parse(x.startedAt) : Number.NaN
    return (x.state === 'running' || x.state === 'waiting-review') && Number.isFinite(t) ? [t] : []
  })
  const prNumbers = detail.steps.flatMap((x) => {
    const number = prNumberOf(x.links)
    return number ? [{ step: x.id, number }] : []
  })
  const rowOf = (s: StepView): PaneStepRow => {
    const pr = prNumberOf(s.links)
    const split = splitCriteria(s.criteria)
    // The session's own links belong to the steps it is working on: a running one, or one waiting for review.
    const working = s.state === 'running' || s.state === 'waiting-review'
    const started = s.startedAt !== null ? Date.parse(s.startedAt) : Number.NaN
    const otherPrs = new Set(prNumbers.filter((p) => p.step !== s.id).map((p) => p.number))
    // The session works on one step after another: its links are the step's from the step's start until
    // the next working step starts.
    const next = Number.isFinite(started)
      ? Math.min(...workingStarts.filter((t) => t > started), Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY
    const links = stepLinkRows(s.links, working ? sessionLinks : [], {
      resolveIn: sessionLinks,
      since: Number.isFinite(started) ? started : null,
      until: Number.isFinite(next) ? next : null,
      otherPrs
    })
    return {
      id: s.id,
      title: s.title,
      state: s.state,
      blocked: s.blocked,
      needsYou: owed.has(s.id),
      pr,
      criteria: s.criteria,
      prUrl: pr ? (links.find((l) => l.key === `pr:${pr}`)?.url ?? null) : null,
      verified: split.verified,
      open: split.open,
      blockers: blockerRows(s.blockers, ctx.now),
      links
    }
  }

  if (detail.milestones.length === 0) {
    return { milestones: [], optional: [], loose: orderSteps(detail.steps.map(rowOf)) }
  }

  const byMilestone = detail.progress.unit === 'milestones'
  const rows = detail.milestones.map((m, i): PaneMilestoneRow => {
    const own = detail.steps.filter((s) => s.milestone === m.id)
    // The server's rule: the required steps decide; a milestone of optional steps reads from all of them.
    const required = own.filter((s) => !s.optional)
    const counted = required.length > 0 ? required : own
    const target = m.waitsFor ? detail.milestones.find((x) => x.id === m.waitsFor) : undefined
    const previous = i > 0 ? detail.milestones[i - 1] : undefined
    const waitsFor =
      target && target.id !== previous?.id && target.state !== 'done'
        ? { id: target.id, title: target.title }
        : null
    const current = byMilestone && detail.progress.current?.id === m.id
    return {
      id: m.id,
      title: m.title,
      optional: m.optional,
      state: m.state,
      current,
      openByDefault: current,
      done: counted.filter((s) => s.state === 'done').length,
      total: counted.length,
      counts: m.counts,
      waitsFor,
      ...orderSteps(own.map(rowOf))
    }
  })
  return {
    milestones: rows.filter((r) => !r.optional),
    optional: rows.filter((r) => r.optional),
    loose: null
  }
}

/** The milestone (or `null` for the loose list) that holds a step, so "Open step" can unfold it. */
export function milestoneOfStep(tree: PaneTree, stepId: string): string | null {
  for (const m of [...tree.milestones, ...tree.optional]) {
    if (m.shown.some((s) => s.id === stepId) || m.folded.some((s) => s.id === stepId)) return m.id
  }
  return null
}

/** One part of a milestone's summary line; the renderer translates each by its kind. */
export interface SummaryPart {
  kind: 'running' | 'waitingReview' | 'blocked' | 'nothingRunning' | 'allDone'
  n: number
}

/**
 * A milestone's summary line, as parts: how many steps run, wait for review and are blocked (a zero is
 * left out; to do is never counted). With nothing running it opens with "Nothing running"; with all three
 * at zero it reads "Nothing running", or "Every step is done" for a done milestone.
 */
export function milestoneSummary(m: Pick<PaneMilestoneRow, 'counts' | 'state'>): SummaryPart[] {
  const parts: SummaryPart[] = []
  if (m.counts.running > 0) parts.push({ kind: 'running', n: m.counts.running })
  if (m.counts.waitingReview > 0) parts.push({ kind: 'waitingReview', n: m.counts.waitingReview })
  if (m.counts.blocked > 0) parts.push({ kind: 'blocked', n: m.counts.blocked })
  if (parts.length === 0) {
    return [{ kind: m.state === 'done' ? 'allDone' : 'nothingRunning', n: 0 }]
  }
  if (m.counts.running === 0) parts.unshift({ kind: 'nothingRunning', n: 0 })
  return parts
}

/** The glyph a step or a milestone draws: its state, with the blocked mark in place of the state's glyph. */
export type GlyphKind = 'done' | 'running' | 'review' | 'todo' | 'blocked'

export function stepGlyph(state: string, blocked: boolean): GlyphKind {
  if (blocked) return 'blocked'
  if (state === 'done') return 'done'
  if (state === 'running') return 'running'
  if (state === 'waiting-review') return 'review'
  return 'todo'
}

export function milestoneGlyph(state: string): GlyphKind {
  if (state === 'done') return 'done'
  if (state === 'in-progress') return 'running'
  if (state === 'waiting-review') return 'review'
  return 'todo'
}

/** The next-step box's look: the operator owes something, owes the close, or nothing waits. */
export type NextLook = 'you' | 'ok' | 'calm'

export function nextLook(detail: Detail): NextLook {
  const next = detail.waiting.next
  if (next === null) return 'calm'
  return next.kind === 'close' ? 'ok' : 'you'
}

// ---- Sessions row and the hand-off (Missions v4, S-20) -----------------------------------------------

type HistoryRow = MissionV4Reply['sessions'][number]

/** One session of the mission, ready to draw: the server's history row with the step it stopped at named. */
export interface SessionRowView {
  id: string
  /** What the record says it is, or was: `leads` stays on a row the hand-off released (it led, it no longer does). */
  role: HistoryRow['role']
  /** Still attached: the hand-off or the end has not closed it. */
  open: boolean
  /** It is the one that leads the mission NOW: open and `leads`. At most one row has this. */
  leads: boolean
  /** It is the session the pane is following. */
  current: boolean
  from: string
  to: string | null
  /** The TITLE of the step it stopped at (never the id), or `null` when the record names none or it is gone. */
  stoppedStep: string | null
  /** What it was waiting for when it stopped, as the record says it, or `null`. */
  waitingFor: string | null
}

/**
 * The mission's sessions as rows, in the order the operator reads them: the one that leads first, then
 * the ones still attached (oldest first), then the closed ones, the latest to stop first. A closed
 * session says where it stopped: the step by its title, and what it waited for. The pane decides
 * nothing about who leads; this reads the server's history.
 */
export function buildSessionRows(
  history: readonly HistoryRow[],
  ctx: { steps: ReadonlyArray<{ id: string; title: string }>; selectedId: string | null }
): SessionRowView[] {
  const title = (id: string | undefined): string | null =>
    id === undefined ? null : (ctx.steps.find((s) => s.id === id)?.title ?? null)
  const rows = history.map((h, index) => {
    const row: SessionRowView = {
      id: h.id,
      role: h.role,
      open: h.open,
      leads: h.open && h.role === 'leads',
      current: h.id === ctx.selectedId,
      from: h.from,
      to: h.to,
      stoppedStep: title(h.stoppedAt?.step),
      waitingFor:
        typeof h.stoppedAt?.waitingFor === 'string' && h.stoppedAt.waitingFor.trim() !== ''
          ? h.stoppedAt.waitingFor.trim()
          : null
    }
    return { row, index }
  })
  const rank = (r: SessionRowView): number => (r.leads ? 0 : r.open ? 1 : 2)
  const stoppedAt = (r: SessionRowView): number => {
    const t = r.to === null ? NaN : Date.parse(r.to)
    return Number.isNaN(t) ? 0 : t
  }
  return rows
    .sort((a, b) => {
      const byRank = rank(a.row) - rank(b.row)
      if (byRank !== 0) return byRank
      if (rank(a.row) < 2) return a.index - b.index
      return stoppedAt(b.row) - stoppedAt(a.row) || b.index - a.index
    })
    .map((x) => x.row)
}

/** How many closed sessions the row lists before the rest fold behind "N more sessions". */
export const SESSIONS_CLOSED_SHOWN = 5

/** The rows to draw, and how many are folded away. Every session still attached always shows. */
export function foldSessionRows(
  rows: readonly SessionRowView[],
  expanded: boolean
): { shown: SessionRowView[]; hidden: number } {
  if (expanded) return { shown: [...rows], hidden: 0 }
  let closed = 0
  const shown = rows.filter((r) => r.open || ++closed <= SESSIONS_CLOSED_SHOWN)
  return { shown, hidden: rows.length - shown.length }
}

/** Who leads, as the header of the row says it: this session, another one, or nobody. */
export function sessionsLeader(
  rows: readonly SessionRowView[]
): { kind: 'this' } | { kind: 'other'; id: string } | { kind: 'none' } {
  const leader = rows.find((r) => r.leads)
  if (!leader) return { kind: 'none' }
  return leader.current ? { kind: 'this' } : { kind: 'other', id: leader.id }
}

/** When a session worked, in the parts the row words: a start, a day span, or one day with its hours. */
export type SessionWhen =
  | { kind: 'none' }
  | { kind: 'since'; day: string }
  | { kind: 'span'; from: string; to: string }
  | { kind: 'sameDay'; day: string; from: string; to: string }

/** `from` and `to` of a session row in the reader's locale: a month and day, and the time when both are one day. */
export function sessionWhen(from: string, to: string | null, locale: string): SessionWhen {
  const start = Date.parse(from)
  if (Number.isNaN(start)) return { kind: 'none' }
  const dayOf = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
  const timeOf = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
  if (to === null) return { kind: 'since', day: dayOf.format(start) }
  const end = Date.parse(to)
  if (Number.isNaN(end)) return { kind: 'since', day: dayOf.format(start) }
  const a = dayOf.format(start)
  const b = dayOf.format(end)
  return a === b
    ? { kind: 'sameDay', day: a, from: timeOf.format(start), to: timeOf.format(end) }
    : { kind: 'span', from: a, to: b }
}

/** The offer to continue in a new session, from the view: the context percentage and who it is about. */
export interface HandoffOfferView {
  /** The leader's context, rounded for the reader. */
  percent: number
  /** The leading session, or `null` when none leads. */
  leaderId: string | null
  /** The pane is following the leading session. */
  leaderIsCurrent: boolean
}

/**
 * The offer, or `null`. The view decides: it offers at 80 percent of the leader's context or more, stays
 * quiet after a "Not now" until the context grows five points, and offers nothing with no reading. This
 * only reads that answer; it never starts anything.
 */
export function handoffOfferView(
  mission: MissionV4Reply,
  selectedId: string | null
): HandoffOfferView | null {
  const offer = mission.handoff
  if (!offer || offer.offer !== true || typeof offer.percent !== 'number') return null
  const leader = mission.sessions.find((s) => s.open && s.role === 'leads')
  return {
    percent: Math.round(offer.percent),
    leaderId: leader?.id ?? null,
    leaderIsCurrent: leader !== undefined && leader.id === selectedId
  }
}

/** The text a new session starts from, split into the labelled sections the mission summary has. */
export interface ParsedSummary {
  /** The line above the first section, without its `#`. Not shown to the operator. */
  title: string
  sections: Array<{ heading: string; body: string }>
}

/**
 * The server's mission summary (`detail.summary`) as sections, so the confirmation can show it as a list
 * of "Goal", "Where it is"… instead of one block. A text with no `## ` headings has no sections: the
 * caller shows it whole.
 */
export function parseSummary(text: string): ParsedSummary {
  const lines = text.split(/\r?\n/)
  const sections: ParsedSummary['sections'] = []
  const head: string[] = []
  let current: { heading: string; lines: string[] } | null = null
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m) {
      if (current)
        sections.push({ heading: current.heading, body: current.lines.join('\n').trim() })
      current = { heading: m[1], lines: [] }
    } else if (current) {
      current.lines.push(line)
    } else {
      head.push(line)
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.lines.join('\n').trim() })
  return {
    title: head
      .join('\n')
      .trim()
      .replace(/^#+\s*/, ''),
    sections
  }
}

/** The codes the hand-off door answers that the dialog words one by one; any other code reads as `other`. */
export const HANDOFF_CODES = [
  'MISSION_CLOSED',
  'HANDOFF_START_FAILED',
  'HANDOFF_IN_PROGRESS',
  'HANDOFF_UNAVAILABLE',
  'LEADER_CHANGED'
] as const

/** The i18n key (under `missionPane.handoff.error`) that says what to do after the door answered `code`. */
export function handoffErrorKey(code: string): (typeof HANDOFF_CODES)[number] | 'other' {
  return (HANDOFF_CODES as readonly string[]).includes(code)
    ? (code as (typeof HANDOFF_CODES)[number])
    : 'other'
}

/**
 * The name a session shows in the Sessions row and the offer: the one name every surface shows
 * (`sessionTitle`), else "Session" and the first eight characters of its id, so a session that is not
 * loaded any more is never a blank.
 */
export function sessionNameOf(
  id: string,
  all: readonly (SessionLike & { sessionId: string })[],
  t: Translate
): string {
  const found = all.find((s) => s.sessionId === id)
  return (
    (found ? sessionTitle(found, all, t) : '') ||
    t('missionPane.sessions.unnamed', { id: id.slice(0, 8) })
  )
}

/**
 * The mission summary the view gave (what a new session starts from), or `undefined` with no mission. It is
 * the mission's text, never a session's name; it is read by destructuring so no surface looks like it
 * builds a session label by hand (`tests/session-label-guard.test.ts`).
 */
export function missionSummaryText(mission: MissionV4Reply | null): string | undefined {
  if (!mission) return undefined
  const { summary } = mission.detail
  return summary
}
