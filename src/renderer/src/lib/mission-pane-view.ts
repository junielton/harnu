/**
 * Missions v4 · S-17 — what the Mission dropdown and the Topbar pill read out of the view channel
 * (design.md §6 "Mission dropdown"). Pure: no store, no `window.api`.
 *
 * The channel answers `{ state: 'mission' | 'none' | 'refused' }` (`mission:v4View`). This module
 * decides what a reply MEANS for one session — a mission to draw, no mission or a refusal — and words the numbers the server already counted. It never recounts:
 * the pill's "4/21 · 3 for you" is `progress.done`, `progress.total` and the length of the waiting list,
 * and the state is the identifier translated through i18n, never the English words in the reply.
 */
import type { MissionV4ViewReply } from '../../../main/mission-ipc'
import { buildBracketedPaste } from './composer-core'
import { sessionTitle, type SessionLike } from './session-label'

type Translate = (key: string, values?: Record<string, unknown>, plural?: number) => string

/** The `state: 'mission'` branch of the view's reply. */
export type MissionV4Reply = Extract<MissionV4ViewReply, { state: 'mission' }>

/** What the pane draws: a state of its own, not a gap. */
export type PaneKind = 'loading' | 'mission' | 'none' | 'refused'

/**
 * What a reply means for `sessionId`.
 *
 * - `null` (no answer yet) is `loading`.
 * - A mission the session is not an OPEN row of is `none`: a named read of a record the session left
 *   (a hand-off closed its row) must never show another session's mission here.
 * - A mission the operator closed is `none` too: it leaves the pane and the session shows the
 *   no-mission state.
 * - Every other record is a `mission`, whatever file it came from (S-35): a v3 record is read as v4 by the view
 *   channel, so the pane draws it like any other. The first door use on it creates its v4 copy.
 */
export function classifyReply(reply: MissionV4ViewReply | null, sessionId: string): PaneKind {
  if (reply === null) return 'loading'
  if (reply.state === 'refused') return 'refused'
  if (reply.state === 'none') return 'none'
  if (!reply.sessions.some((row) => row.id === sessionId && row.open)) return 'none'
  if (reply.detail.status === 'closed') return 'none'
  return 'mission'
}

/** The mission this reply holds for `sessionId`, or `null` (anything else the pane or pill shows). */
export function v4MissionOf(
  reply: MissionV4ViewReply | null,
  sessionId: string
): MissionV4Reply | null {
  return classifyReply(reply, sessionId) === 'mission' ? (reply as MissionV4Reply) : null
}

/** Whether a NAMED read should be dropped and asked again by session: it is not a mission of this session. */
export function isStaleNamedRead(reply: MissionV4ViewReply | null, sessionId: string): boolean {
  const kind = classifyReply(reply, sessionId)
  return kind === 'none' || kind === 'refused'
}

/** The numbers the pill and the pane read, all from the server. */
interface MissionNumbers {
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
type V4PillTone = 'accent' | 'warning' | 'success'

export function missionPillTone(detail: MissionV4Reply['detail']): V4PillTone {
  const n = missionNumbers(detail)
  if (n.readyToClose) return 'success'
  return n.forYou > 0 ? 'warning' : 'accent'
}

/**
 * The pill's classes per tone (design.md §6 "Mission dropdown" → The Topbar pill): the mockup's tinted
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
    case 'accept':
      return item.stepIds.length === 1 ? item.stepIds[0] : null
    default:
      return null
  }
}

/** Every step id the waiting list names: the steps the operator owes something on. */
function owedStepIds(detail: Detail): Set<string> {
  const ids = new Set<string>()
  for (const item of detail.waiting.items) {
    if (item.kind === 'review' || item.kind === 'accept') item.stepIds.forEach((id) => ids.add(id))
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
type Settler = CriterionView['by']

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
interface BlockerRow {
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
interface StepContext {
  sessionLinks?: readonly SessionLinkLike[]
  now?: number
}

/** The newest session links one step lists: a session that wrote a lot of links does not bury the step. */
const SESSION_LINK_CAP = 8

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

/** The i18n key (under `missionDropdown.step.error`) that says what to do after a door was refused with `code`. */
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
interface StepGroups {
  shown: PaneStepRow[]
  folded: PaneStepRow[]
}

/**
 * The order inside a milestone: the steps the operator owes first, then the running ones, each in plan
 * order; every other step is folded behind "N more", in plan order. A step is in exactly one place.
 */
function orderSteps(rows: PaneStepRow[]): StepGroups {
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
  /** The first milestone it waits for, only when that is not the previous one and is not done yet. */
  waitsFor: { id: string; title: string } | null
  /**
   * The others, when it waits on two or more (BUG-283 OI-4): the server joins their ids with `, `. Same rule
   * for each: not the previous milestone, not done. Empty when it waits on at most one.
   */
  waitsForMore: Array<{ id: string; title: string }>
}

export interface PaneTree {
  /** The required milestones, in plan order. */
  milestones: PaneMilestoneRow[]
  /** The optional ones, in plan order: they sit under one collapsed line. */
  optional: PaneMilestoneRow[]
  /** A mission with no milestones draws its steps directly; `null` when it has milestones. */
  loose: StepGroups | null
}

/** A mission with no milestones and at most this many steps shows all of them (Missions v4 S-22). */
const LOOSE_ALL_SHOWN = 8

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
    const rows = detail.steps.map(rowOf)
    // A small task IS its timeline (R-19): every step shows, in plan order. The fold behind "N more" is for a
    // long list, where the steps nobody waits on would bury the ones that matter.
    const loose = rows.length <= LOOSE_ALL_SHOWN ? { shown: rows, folded: [] } : orderSteps(rows)
    return { milestones: [], optional: [], loose }
  }

  const byMilestone = detail.progress.unit === 'milestones'
  const rows = detail.milestones.map((m, i): PaneMilestoneRow => {
    const own = detail.steps.filter((s) => s.milestone === m.id)
    // The server's rule: the required steps decide; a milestone of optional steps reads from all of them.
    const required = own.filter((s) => !s.optional)
    const counted = required.length > 0 ? required : own
    const previous = i > 0 ? detail.milestones[i - 1] : undefined
    // The server joins several ids with `, ` (the conversion of a v3 campaign does): name each one.
    const waited = (m.waitsFor ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '')
      .flatMap((id) => {
        const target = detail.milestones.find((x) => x.id === id)
        return target && target.id !== previous?.id && target.state !== 'done'
          ? [{ id: target.id, title: target.title }]
          : []
      })
    const waitsFor = waited[0] ?? null
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
      waitsForMore: waited.slice(1),
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
type NextLook = 'you' | 'ok' | 'calm'

/**
 * `staged` is a Done when a session proposed (an older mission's re-scope reads the same way): it waits on the
 * operator, so when the waiting list names nothing else the box is not calm.
 */
export function nextLook(detail: Detail, staged = false): NextLook {
  const next = detail.waiting.next
  if (next === null) return staged ? 'you' : 'calm'
  return next.kind === 'close' ? 'ok' : 'you'
}

// ---- Mission dropdown (S-2): the head, the next-step card and the switch --------------------------------

/**
 * The dropdown body's width, from which a card's compact button sits at the RIGHT of its text and under it
 * below (design.md §6 "Mission dropdown" → "What it draws" 2). The rule itself is a container query in the
 * markup (`@min-[380px]:`); this is the number it spells, so a test can hold the two together.
 */
export const NEXT_WIDE_MIN = 380

/** The count under the head's bar: "1 of 3 milestones done", from the server's numbers (the unit agrees with the total). */
export function dropdownProgressLine(t: Translate, detail: Detail): string {
  const n = missionNumbers(detail)
  return t(
    n.unit === 'milestones'
      ? 'missionDropdown.head.count.milestones'
      : 'missionDropdown.head.count.steps',
    { done: n.done, total: n.total },
    n.total
  )
}

/** One mission this session leads, as the switch lists it: the server's numbers for it, nothing recounted. */
export interface LedMissionRow {
  /** The id a named read of the mission uses. */
  id: string
  title: string
  done: number
  total: number
  unit: 'milestones' | 'steps'
  /** How many things wait on the operator in it (its waiting list's length). */
  forYou: number
}

/** What a reader of the store holds of one mission that the switch needs. */
interface LedReader {
  title: string
  lookupId?: string
  mission: { id: string }
  detail: Detail
}

/** The missions `sessionId` leads, in the readers' order (newest written first), as the switch lists them. */
export function ledMissionRows(
  readers: readonly LedReader[] | null | undefined,
  sessionId: string | null | undefined
): LedMissionRow[] {
  if (!readers || !sessionId) return []
  return readers
    .filter((r) => r.detail.leads === sessionId)
    .map((r) => {
      const n = missionNumbers(r.detail)
      return {
        id: r.lookupId ?? r.mission.id,
        title: r.title,
        done: n.done,
        total: n.total,
        unit: n.unit,
        forYou: n.forYou
      }
    })
}

/** One thing the one card (or a row of "more waiting") holds: a waiting item, or the staged Done when. */
export type NextEntry = { kind: 'item'; item: WaitingItem } | { kind: 'staged'; text: string }

/** The one card and what waits behind it. `primary` is `null` when nothing is owed. */
interface NextCard {
  primary: NextEntry | null
  more: NextEntry[]
}

/** The server's ranking of what the operator owes (`waiting`); the staged Done when takes a re-scope's place. */
export const OWED_RANK = [
  'main-failing',
  'unblock',
  'accept',
  'rescope',
  'settle',
  'review',
  'close',
  'attach'
]
const rankOf = (kind: string): number => {
  const i = OWED_RANK.indexOf(kind)
  return i === -1 ? OWED_RANK.length : i
}

/**
 * What the dropdown's one card holds, from the reply alone. The waiting list is the server's, in its order; a
 * staged Done when (the mission's `pendingDoneWhen`) is the same thing as the re-scope item an older mission
 * stages, so it REPLACES that item and is never a second card. A Done when the list does not name is placed by
 * rank (before the first thing that ranks after a re-scope), so it is never hidden behind a fold with no count.
 */
export function nextCardOf(mission: MissionV4Reply): NextCard {
  const { next, more } = mission.detail.waiting
  const items: WaitingItem[] = next ? [next, ...more] : [...more]
  const staged = mission.pendingDoneWhen
  const entries: NextEntry[] = items.map((item) => ({ kind: 'item', item }))
  if (staged) {
    const entry: NextEntry = { kind: 'staged', text: staged.text }
    const at = items.findIndex((i) => i.kind === 'rescope')
    const rest = entries.filter((e) => !(e.kind === 'item' && e.item.kind === 'rescope'))
    if (at !== -1) rest.splice(at, 0, entry)
    else {
      const first = rest.findIndex(
        (e) => e.kind === 'item' && rankOf(e.item.kind) > rankOf('rescope')
      )
      rest.splice(first === -1 ? rest.length : first, 0, entry)
    }
    return { primary: rest[0] ?? null, more: rest.slice(1) }
  }
  return { primary: entries[0] ?? null, more: entries.slice(1) }
}

/** The card's look: the operator owes the close (`ok`), a decision of theirs (`accent`), or a step (`you`); `calm` is nothing. */
export type NextCardLook = NextLook | 'accent'

export function nextEntryLook(entry: NextEntry | null): NextCardLook {
  if (entry === null) return 'calm'
  if (entry.kind === 'staged') return 'accent'
  if (entry.item.kind === 'attach') return 'accent'
  return entry.item.kind === 'close' ? 'ok' : 'you'
}

/**
 * What a session started by a hand-off is named after by default: its first prompt, which opens with the
 * hand-off's instruction line (`HANDOFF_INSTRUCTION`, `src/main/missions/handoff.ts`; a test pins the two).
 */
const HANDOFF_NAME_PREFIX = 'You are taking over this mission'

/**
 * The name a session shows in the Ask box, the Next card and the attach picker: the one name every surface shows
 * (`sessionTitle`), else "Session" and the first eight characters of its id, so a session that is not
 * loaded any more is never a blank. A session a hand-off started has its first prompt for a name, which is
 * the instruction line; given the mission's title it is named after the mission instead, plainly (stp-21:
 * the leader a hand-off creates is the mission's, not "You are taking over this mission…").
 */
export function sessionNameOf(
  id: string,
  all: readonly (SessionLike & { sessionId: string })[],
  t: Translate,
  missionTitle?: string
): string {
  const found = all.find((s) => s.sessionId === id)
  const own = found ? sessionTitle(found, all, t) : ''
  if (own.startsWith(HANDOFF_NAME_PREFIX) && missionTitle) return missionTitle
  return own || t('missionPane.sessions.unnamed', { id: id.slice(0, 8) })
}

// ---- Attach, the attach request and Ask (Missions v4, S-21) ------------------------------------------

/** One open mission of the folder, as the attach picker lists it: the server's row, with who leads. */
export interface PickerRow {
  id: string
  title: string
  /** The server's count line ("4 of 21 steps done"), shown as written. */
  headline: string
  /** The session that leads it, or `null` when nobody does. */
  leaderId: string | null
}

type NoneReply = Extract<MissionV4ViewReply, { state: 'none' }>

/** The picker's rows, in the server's order. */
export function pickerRows(missions: NoneReply['missions']): PickerRow[] {
  return missions.map((m) => ({
    id: m.id,
    title: m.title,
    headline: m.headline,
    leaderId: m.leads ?? null
  }))
}

/** A session's request to join, as the waiting list holds it: the id the door takes and who asked. */
interface AttachRequestRow {
  id: string
  sessionId: string
}

/** Every undecided request of the waiting list (not only the next item): the session ids are the door's targets. */
export function attachRequestsOf(detail: Detail): AttachRequestRow[] {
  const out: AttachRequestRow[] = []
  for (const item of detail.waiting.items) {
    if (item.kind === 'attach') out.push({ id: item.requestId, sessionId: item.sessionId })
  }
  return out
}

/** The codes the attach and decide-attach doors answer that the pane words one by one; any other reads as `other`. */
const ATTACH_CODES = ['NOT_FOUND', 'MISSION_NOT_FOUND', 'MISSION_CLOSED', 'WRITE_CONFLICT'] as const

/** The i18n key (under `missionDropdown.empty.error`) that says what to do after a door answered `code`. */
export function attachErrorKey(code: string): (typeof ATTACH_CODES)[number] | 'other' {
  return (ATTACH_CODES as readonly string[]).includes(code)
    ? (code as (typeof ATTACH_CODES)[number])
    : 'other'
}

/**
 * What "Start a new mission" puts into the session's prompt. It writes no record: the session makes the
 * mission once the operator agrees what done means. One line, so it needs no fencing of its own.
 */
export const NEW_MISSION_INSTRUCTION =
  'Please start a new Harnu mission for the work in this session. First tell me in one sentence what done will look like, and wait for my answer before you create it.'

/** What Ask sends: the milestone named by its title, then the question as the operator wrote it. */
export function askMessage(milestoneTitle: string, question: string): string {
  return `About the milestone \u201c${milestoneTitle}\u201d: ${question.trim()}`
}

/** How a write into another session ended: it went in, or the session has no running terminal. */
type IntoSession = 'sent' | 'not-running'

/**
 * Put text into a session's prompt the way "Reference in session" does: through the writer bus, to a live
 * session only, and with NO Enter (the operator reviews the line and sends it: a session may be waiting at
 * a permission prompt, and an Enter there would answer it). The text is fenced as one bracketed paste so a
 * multi-line question lands as one block. Writes nothing for a session that is not running.
 */
export function writeIntoSession(
  deps: {
    isLive: (sessionId: string) => boolean
    write: (sessionId: string, data: string) => boolean
  },
  sessionId: string,
  text: string
): IntoSession {
  if (!deps.isLive(sessionId)) return 'not-running'
  return deps.write(sessionId, buildBracketedPaste(text)) ? 'sent' : 'not-running'
}

/** The session that leads the mission now, or `null`: the one Ask goes to. */
export function askLeaderOf(mission: MissionV4Reply): string | null {
  return mission.sessions.find((s) => s.open && s.role === 'leads')?.id ?? null
}

// ---- Close (Missions v4, S-22) -------------------------------------------------------------------------------
//
// The operator's one end door. Pure: what the dialog lists, in words of its own. The server's `text` for an open
// matter is English and is never the copy (the renderer translates identifiers); the count is the server's.

/** The open matters the close door counts, by identifier. */
const CLOSE_MATTER_KINDS = [
  'unfinished-steps',
  'open-blockers',
  'staged-done-when',
  'attach-requests'
] as const

export interface CloseMatter {
  /** An identifier the dialog translates; a kind this build does not know reads as `other`. */
  kind: (typeof CLOSE_MATTER_KINDS)[number] | 'other'
  /** The server's count. */
  count: number
}

/**
 * The view's `closeWarnings` (counted with the facts) as the dialog's rows, in the server's order. A warning
 * never stops the close: this only says what is open.
 */
export function closeMatters(
  warnings: ReadonlyArray<{ kind: string; count: number }>
): CloseMatter[] {
  return warnings.map((w) => ({
    kind: (CLOSE_MATTER_KINDS as readonly string[]).includes(w.kind)
      ? (w.kind as CloseMatter['kind'])
      : 'other',
    count: w.count
  }))
}

/** The codes the close door answers that the dialog words one by one; any other code reads as `other`. */
const CLOSE_CODES = ['NOT_FOUND', 'WRITE_CONFLICT', 'MISSION_CLOSED'] as const

/** The i18n key (under `missionPane.close.error`) that says what to do after the door answered `code`. */
export function closeErrorKey(code: string): (typeof CLOSE_CODES)[number] | 'other' {
  return (CLOSE_CODES as readonly string[]).includes(code)
    ? (code as (typeof CLOSE_CODES)[number])
    : 'other'
}

/** Whether the server says every required step is done: the mission is ready to close as delivered. */
export function isReadyToClose(detail: Detail): boolean {
  return detail.status === 'open' && detail.state === 'ready-to-close'
}

/**
 * A link's label cut into the parts a line may break between: after a separator (`/ . - _ ? & = # : @`) or a
 * space, never inside a word. The renderer puts a `<wbr>` between the parts, so a long path or address wraps
 * at its slashes and dots and a short word is never split.
 */
export function linkLabelParts(label: string): string[] {
  return label.match(/[^/.\-_?&=#:@ ]*[/.\-_?&=#:@ ]|[^/.\-_?&=#:@ ]+$/g) ?? []
}

// ---- Words the pane writes itself (no English from the server reaches a Portuguese pane) -------------------------

/** What the Next box and its rows say for one waiting item: the ask and the why. */
interface WaitingWords {
  ask: string
  why: string
}

const nonEmpty = (s: string | undefined | null): s is string => typeof s === 'string' && s !== ''

/**
 * The ask and the why of a waiting item, worded here from its KIND and the record, in the reader's language.
 * The server's own `ask` and `why` are English; they stay the contract of the verbs and of the text a session
 * reads, and the pane never shows them for a kind it knows. What an agent wrote (a blocker's reason, ask and
 * `unblocks`, a criterion's text, a step's title) is shown as written. An item this build does not know, or
 * one whose record is gone, is shown with the server's words.
 */
export function waitingText(t: Translate, detail: Detail, item: WaitingItem): WaitingWords {
  const raw: WaitingWords = { ask: item.ask, why: item.why }
  const titleOf = (id: string | null | undefined): string | undefined =>
    detail.steps.find((s) => s.id === id)?.title
  switch (item.kind) {
    case 'main-failing': {
      const title = titleOf(item.stepId)
      return title === undefined
        ? raw
        : {
            ask: t('missionPane.next.text.mainFailing.ask', { title }),
            why: t('missionPane.next.text.mainFailing.why')
          }
    }
    case 'unblock': {
      const step = detail.steps.find((s) => s.id === item.stepId)
      const blocker = (step ? step.blockers : detail.blockers).find((b) => b.id === item.blockerId)
      if (!blocker) return raw
      return {
        ask: nonEmpty(blocker.ask) ? blocker.ask : blocker.reason,
        why: nonEmpty(blocker.unblocks)
          ? blocker.unblocks
          : t(
              step
                ? 'missionPane.next.text.unblock.whyStep'
                : 'missionPane.next.text.unblock.whyMission'
            )
      }
    }
    case 'settle': {
      const step = detail.steps.find((s) => s.id === item.stepId)
      const criterion = step?.criteria.find((c) => c.id === item.criterionId)
      if (!step || !criterion) return raw
      const open = step.criteria.filter((c) => !c.settled).length
      return {
        ask: t('missionPane.next.text.settle.ask', { text: criterion.text }),
        why:
          open <= 1
            ? t('missionPane.next.text.settle.whyLast')
            : t('missionPane.next.text.settle.whyMore', { n: open - 1 }, open - 1)
      }
    }
    case 'review': {
      const n = item.stepIds.length
      if (n === 1) {
        const title = titleOf(item.stepIds[0])
        if (title === undefined) return raw
        return {
          ask: t('missionPane.next.text.review.askOne', { title }),
          why: t('missionPane.next.text.review.whyOne')
        }
      }
      return {
        ask: t('missionPane.next.text.review.askMany', { n }),
        why: t('missionPane.next.text.review.whyMany', { n })
      }
    }
    case 'close':
      return {
        ask: t(
          item.requested
            ? 'missionPane.next.text.close.askRequested'
            : 'missionPane.next.text.close.askReady'
        ),
        why: t('missionPane.next.text.close.why')
      }
    case 'rescope':
      // An older mission's staged re-scope is the staged Done when: the same words, the same box.
      return {
        ask: t('missionPane.next.text.doneWhen.ask'),
        why: t('missionPane.next.text.doneWhen.why')
      }
    case 'attach':
      return {
        ask: t('missionPane.next.text.attach.ask'),
        why: t('missionPane.next.text.attach.why')
      }
    default:
      return raw
  }
}

/**
 * The picker's count line ("4 of 21 steps done") in the reader's language, built from its numbers. The server
 * writes it in English; a line of any other shape is shown as written.
 */
export function translateHeadline(t: Translate, headline: string): string {
  const m = /^(\d+) of (\d+) (step|milestone)s? done$/.exec(headline.trim())
  if (!m) return headline
  const [done, total] = [Number(m[1]), Number(m[2])]
  return t(
    m[3] === 'milestone' ? 'missionPane.progress.milestones' : 'missionPane.progress.steps',
    { done, total },
    total
  )
}
