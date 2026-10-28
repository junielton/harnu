/**
 * The mission state the host pushes to the mod, and the tick card built from it (T589). Pure and
 * `$`-free (MOD-1): the host's gate and the mod both use {@link parseMissionState}, and the
 * `UserMessage` hook draws {@link tickCard}. Display only: nothing here changes what the model reads.
 *
 * A tick row carries no id of its own, so the mod remembers a {@link TickSnap} per row (keyed by the
 * row's `requestId`) the first time it draws it: `#N` is the order rows were first drawn, and "no
 * change since #N" is a comparison of two snapshots, never of the prompt text.
 */

import {
  MISSION_STATE_MAX_BLOCKERS,
  MISSION_STATE_MAX_CHILDREN,
  MISSION_STATE_MAX_MISSIONS,
  MISSION_STATE_MAX_PRS,
  MISSION_STATE_MAX_STEPS,
  MISSION_STATE_MAX_YOU,
  MISSION_STATE_TEXT_MAX,
  type MissionStateArgs,
  type MissionStateEntry,
  type MissionStepStatus
} from '../contract'

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const onlyKeys = (r: Rec, keys: readonly string[]): boolean =>
  Object.keys(r).every((k) => keys.includes(k))
const isInt = (v: unknown, min = 0): v is number => Number.isInteger(v) && (v as number) >= min

const STEP_STATES: readonly string[] = ['verified', 'done', 'running', 'waiting', 'blocked', 'todo']
const MISSION_ID = new RegExp('^mnt-[0-9a-f]{8}$')
// C0 controls except none, DEL and C1: a pushed string is one printable line.
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]')

/** A printable one-line string of 1 to `max` characters (`allowEmpty`: 0 to `max`). */
const text = (v: unknown, max = MISSION_STATE_TEXT_MAX, allowEmpty = false): v is string =>
  typeof v === 'string' && (allowEmpty || v.length > 0) && v.length <= max && !CONTROL.test(v)

function validEntry(e: unknown): e is MissionStateEntry {
  if (!isRec(e)) return false
  if (!onlyKeys(e, ['id', 'title', 'card', 'role', 'progress', 'steps', 'blockers', 'you'])) {
    return false
  }
  if (typeof e.id !== 'string' || !MISSION_ID.test(e.id)) return false
  if (!text(e.title) || (e.card !== undefined && !text(e.card, 60))) return false
  if (e.role !== 'owner' && e.role !== 'child') return false
  const p = e.progress
  if (!isRec(p) || !onlyKeys(p, ['total', 'current', 'done', 'verified', 'allDone'])) return false
  if (!isInt(p.total) || !isInt(p.done) || !isInt(p.verified) || typeof p.allDone !== 'boolean') {
    return false
  }
  if (p.current !== null) {
    const c = p.current
    if (!isRec(c) || !onlyKeys(c, ['from', 'to']) || !isInt(c.from, 1) || !isInt(c.to, 1)) {
      return false
    }
    if (c.from > c.to) return false
  }
  if (!Array.isArray(e.steps) || e.steps.length > MISSION_STATE_MAX_STEPS) return false
  for (const s of e.steps as unknown[]) {
    if (!isRec(s) || !onlyKeys(s, ['id', 'title', 'state', 'card', 'children', 'prs'])) return false
    if (!text(s.id, 40) || !text(s.title) || !STEP_STATES.includes(String(s.state))) return false
    if (s.card !== undefined && !text(s.card, 60)) return false
    if (!Array.isArray(s.children) || s.children.length > MISSION_STATE_MAX_CHILDREN) return false
    for (const c of s.children as unknown[]) {
      if (!isRec(c) || !onlyKeys(c, ['taskState', 'lastTransitionAt'])) return false
      if (!text(c.taskState, 24)) return false
      if (c.lastTransitionAt !== null && !isInt(c.lastTransitionAt)) return false
    }
    if (!Array.isArray(s.prs) || s.prs.length > MISSION_STATE_MAX_PRS) return false
    for (const r of s.prs as unknown[]) {
      if (!isRec(r) || !onlyKeys(r, ['number', 'state'])) return false
      if (!isInt(r.number, 1) || !text(r.state, 16)) return false
    }
  }
  if (!Array.isArray(e.blockers) || e.blockers.length > MISSION_STATE_MAX_BLOCKERS) return false
  for (const b of e.blockers as unknown[]) {
    if (!isRec(b) || !onlyKeys(b, ['reason', 'owner', 'stepId'])) return false
    if (!text(b.reason) || (b.owner !== 'agent' && b.owner !== 'operator')) return false
    if (b.stepId !== undefined && !text(b.stepId, 40)) return false
  }
  if (!Array.isArray(e.you) || e.you.length > MISSION_STATE_MAX_YOU) return false
  for (const y of e.you as unknown[]) {
    if (!isRec(y) || !onlyKeys(y, ['kind', 'text']) || !text(y.kind, 24) || !text(y.text)) {
      return false
    }
  }
  return true
}

/** The args of a `mission.state` command, or `null` when anything is out of shape or over a cap (never partial). */
export function parseMissionState(raw: unknown): MissionStateArgs | null {
  if (!isRec(raw) || !onlyKeys(raw, ['missions']) || !Array.isArray(raw.missions)) return null
  if (raw.missions.length > MISSION_STATE_MAX_MISSIONS) return null
  const ids = new Set<string>()
  for (const m of raw.missions as unknown[]) {
    if (!validEntry(m) || ids.has(m.id)) return null
    ids.add(m.id)
  }
  return raw as unknown as MissionStateArgs
}

/** What `$.state.missions` holds: the last push, with the `n` of the command that carried it. */
export interface StoredMissions {
  v: 1
  n: number
  at: number
  missions: MissionStateEntry[]
}

/** A stored push, or `null` when it is not one (never trusted: it is checked again on every read). */
export function parseStored(raw: unknown): StoredMissions | null {
  if (!isRec(raw) || raw.v !== 1 || !isInt(raw.n) || !isInt(raw.at)) return null
  const parsed = parseMissionState({ missions: raw.missions })
  return parsed === null ? null : { v: 1, n: raw.n, at: raw.at, missions: parsed.missions }
}

// ---- what is stored for a tick row ---------------------------------------------------------------

/** What one drawn tick remembers of its mission: enough to compare the next tick with it. No clock. */
export interface TickSnap {
  /** Epoch ms of the mod's clock when the row was first drawn. */
  at: number
  total: number
  done: number
  verified: number
  steps: [id: string, state: MissionStepStatus][]
  prs: [number: number, state: string][]
  blockers: string[]
  you: string[]
  /** The executor state of the current step (`working`, `idle`, …), or `''`. */
  exec: string
}

/** The current step: the first of `progress.current`, or `null` when none is running or all are done. */
function currentStep(e: MissionStateEntry): MissionStateEntry['steps'][number] | null {
  const c = e.progress.current
  return c === null ? null : (e.steps[c.from - 1] ?? null)
}

/** The child that stands for a step's executor: a working one first, else the first. */
function executorOf(step: MissionStateEntry['steps'][number] | null) {
  if (step === null) return null
  return step.children.find((c) => c.taskState === 'working') ?? step.children[0] ?? null
}

export function snapOf(e: MissionStateEntry, at: number): TickSnap {
  return {
    at,
    total: e.progress.total,
    done: e.progress.done,
    verified: e.progress.verified,
    steps: e.steps.map((s) => [s.id, s.state]),
    prs: e.steps.flatMap((s) => s.prs.map((p): [number, string] => [p.number, p.state])),
    blockers: e.blockers.map((b) => b.reason),
    you: e.you.map((y) => y.text),
    exec: executorOf(currentStep(e))?.taskState ?? ''
  }
}

/** True when two snapshots say the same thing (the clock is not part of what changed). */
export function sameSnap(a: TickSnap, b: TickSnap): boolean {
  return JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 })
}

/** A stored snapshot, or `null` when it is not one (an old shape after an update reads as nothing). */
export function parseSnap(raw: unknown): TickSnap | null {
  if (!isRec(raw)) return null
  const ok =
    isInt(raw.at) &&
    isInt(raw.total) &&
    isInt(raw.done) &&
    isInt(raw.verified) &&
    Array.isArray(raw.steps) &&
    Array.isArray(raw.prs) &&
    Array.isArray(raw.blockers) &&
    Array.isArray(raw.you) &&
    typeof raw.exec === 'string'
  return ok ? (raw as unknown as TickSnap) : null
}

const MAX_CHANGES = 3
const brief = (s: string, n = 40): string => (s.length <= n ? s : s.slice(0, n - 1) + '…')
const PR_WORD: Record<string, string> = { MERGED: 'merged', CLOSED: 'closed', OPEN: 'opened' }

/** What changed between two ticks, in words (mock 02 `changed`): at most three items, then `+N`. */
export function changesBetween(prev: TickSnap, cur: TickSnap): string[] {
  const out: string[] = []
  const before = new Map(prev.steps)
  for (const [id, state] of cur.steps) {
    const was = before.get(id)
    if (was === state || was === undefined) continue
    if (state === 'verified' || state === 'done' || state === 'blocked' || state === 'running') {
      out.push(id + ' ' + state)
    }
  }
  const prsBefore = new Map(prev.prs)
  for (const [n, state] of cur.prs) {
    if (prsBefore.get(n) !== state)
      out.push('PR #' + n + ' ' + (PR_WORD[state] ?? state.toLowerCase()))
  }
  for (const b of cur.blockers) if (!prev.blockers.includes(b)) out.push('blocked: ' + brief(b))
  for (const b of prev.blockers) if (!cur.blockers.includes(b)) out.push('unblocked: ' + brief(b))
  for (const y of cur.you) if (!prev.you.includes(y)) out.push('⚑ ' + brief(y))
  if (out.length === 0 && prev.exec !== cur.exec) {
    out.push('executor ' + (prev.exec || 'none') + ' → ' + (cur.exec || 'none'))
  }
  if (out.length === 0) out.push('progress moved')
  return out.length > MAX_CHANGES
    ? [...out.slice(0, MAX_CHANGES), '+' + (out.length - MAX_CHANGES)]
    : out
}

// ---- the card ------------------------------------------------------------------------------------

export interface CardRow {
  label: 'now' | 'waits' | 'changed'
  text: string
}
export interface TickCard {
  /** `nochange`: one dim line; `card`: the bordered card. */
  kind: 'card' | 'nochange'
  /** The tick's number, or `null` for a row the mod never saw arrive (it says what is true now, no more). */
  n: number | null
  title: string
  /** Filled cells of the bar and its length: position, like the pill (`Step 3 of 5` fills 3 of 5). */
  bar: { filled: number; total: number }
  /** `Step 3 of 5 · 1 verified`. */
  detail: string
  tone: 'claude' | 'success'
  rows: CardRow[]
  you: string[]
  /** `nochange` only: the tick it is the same as. */
  sinceN: number | null
}

const BAR_MAX = 12

function barOf(e: MissionStateEntry): TickCard['bar'] {
  const total = Math.max(0, e.progress.total)
  const filled = e.progress.allDone ? total : (e.progress.current?.from ?? 0)
  if (total <= BAR_MAX) return { filled: Math.min(filled, total), total }
  return { filled: Math.round((filled / total) * BAR_MAX), total: BAR_MAX }
}

/** `Step 3 of 5 · 1 verified`, `Steps 2–3 of 5 · …`, `Step 5 of 5 ✓ · …`. */
export function progressDetail(e: MissionStateEntry): string {
  const { total, current, allDone, verified } = e.progress
  const where = allDone
    ? 'Step ' + total + ' of ' + total + ' ✓'
    : current === null
      ? total + ' steps'
      : current.from === current.to
        ? 'Step ' + current.from + ' of ' + total
        : 'Steps ' + current.from + '–' + current.to + ' of ' + total
  return where + ' · ' + verified + ' verified'
}

/** `now`, `12 min`, `3 h`, `1 h 5 min`. */
export function elapsed(fromMs: number | null, nowMs: number): string {
  if (fromMs === null || nowMs < fromMs) return ''
  const min = Math.floor((nowMs - fromMs) / 60_000)
  if (min < 1) return '<1 min'
  if (min < 60) return min + ' min'
  const h = Math.floor(min / 60)
  return min % 60 === 0 ? h + ' h' : h + ' h ' + (min % 60) + ' min'
}

function nowRow(e: MissionStateEntry, nowMs: number): CardRow | null {
  const step = currentStep(e)
  if (step === null) return null
  const exec = executorOf(step)
  if (exec === null)
    return { label: 'now', text: step.id + ' · ' + step.title + ' · ' + step.state }
  const who = step.card ? 'executor ' + step.card : 'executor'
  const age = elapsed(exec.lastTransitionAt, nowMs)
  return {
    label: 'now',
    text: step.id + ' · ' + who + ' ' + exec.taskState + (age ? ' ' + age : '')
  }
}

function waitsRow(e: MissionStateEntry): CardRow | null {
  const step = currentStep(e)
  const parts: string[] = e.blockers.filter((b) => b.owner === 'agent').map((b) => b.reason)
  const open = (step?.prs ?? []).filter((p) => p.state === 'OPEN')
  if (open.length > 0) parts.push('PRs ' + open.map((p) => '#' + p.number).join(' '))
  return parts.length === 0 ? null : { label: 'waits', text: parts.join(' · ') }
}

/**
 * The tick card for the `n`th tick of a mission (mock 02). `prev` is the snapshot of the tick before
 * it, with its number: none draws the card with its `now` and `waits` rows; equal draws one line;
 * different draws a `changed` row in their place. The `⚑ you` rows always close the card.
 */
export function tickCard(
  e: MissionStateEntry,
  n: number | null,
  prev: { n: number; snap: TickSnap } | null,
  nowMs: number
): TickCard {
  const base = {
    n,
    title: e.title,
    bar: barOf(e),
    detail: progressDetail(e),
    tone: e.progress.allDone ? ('success' as const) : ('claude' as const),
    you: e.you.map((y) => y.text)
  }
  if (prev === null) {
    const rows = [nowRow(e, nowMs), waitsRow(e)].filter((r): r is CardRow => r !== null)
    return { kind: 'card', ...base, rows, sinceN: null }
  }
  const cur = snapOf(e, nowMs)
  if (sameSnap(prev.snap, cur)) return { kind: 'nochange', ...base, rows: [], sinceN: prev.n }
  return {
    kind: 'card',
    ...base,
    rows: [{ label: 'changed', text: changesBetween(prev.snap, cur).join(' · ') }],
    sinceN: null
  }
}

// ---- the ledger of drawn ticks -------------------------------------------------------------------

/** The newest this many rows of one mission are kept; an older row, drawn again, is simply numbered anew. */
export const TICK_ROWS_MAX = 50

/** One tick row as it was first drawn: its number, what the mission looked like, and the card it got. */
export interface TickRow {
  /** The row's `requestId` (the message id): two drawings of one row are one tick. */
  rid: string
  n: number
  snap: TickSnap
  card: TickCard
}

/** Kept under `$.state.tickRows`: per mission, the next number and the newest rows. */
export interface TickLedger {
  v: 1
  byMission: Record<string, { next: number; rows: TickRow[] }>
}

export const emptyLedger = (): TickLedger => ({ v: 1, byMission: {} })

function validCard(c: unknown): c is TickCard {
  return (
    isRec(c) &&
    (c.kind === 'card' || c.kind === 'nochange') &&
    isInt(c.n) &&
    typeof c.title === 'string' &&
    typeof c.detail === 'string' &&
    isRec(c.bar) &&
    Array.isArray(c.rows) &&
    Array.isArray(c.you)
  )
}

/** A stored ledger, or an empty one when it is not one (a changed shape, a hand edit: nothing is drawn from it). */
export function parseLedger(raw: unknown): TickLedger {
  if (!isRec(raw) || raw.v !== 1 || !isRec(raw.byMission)) return emptyLedger()
  for (const m of Object.values(raw.byMission)) {
    if (!isRec(m) || !isInt(m.next, 1) || !Array.isArray(m.rows)) return emptyLedger()
    for (const r of m.rows as unknown[]) {
      if (!isRec(r) || typeof r.rid !== 'string' || !isInt(r.n, 1)) return emptyLedger()
      if (parseSnap(r.snap) === null || !validCard(r.card)) return emptyLedger()
    }
  }
  return raw as unknown as TickLedger
}

/**
 * The card of a row the mod never saw arrive in this process (a resumed transcript, or a tick that
 * came before any state did). Its place among the ticks is unknown, since the engine draws rows in an
 * order of its own, so it carries no number and no comparison: the mission as it is now.
 */
export function looseCard(e: MissionStateEntry, nowMs: number): TickCard {
  return tickCard(e, null, null, nowMs)
}

export interface TickPlan {
  row: TickRow
  /** What to draw: the stored card, or for the newest row of its mission the card of the live state. */
  card: TickCard
  /** The ledger to write, or `null` when the row was already in it. */
  ledger: TickLedger | null
  /** True for the newest row of its mission. */
  latest: boolean
}

/**
 * The number and card of one tick row. A row seen before keeps its number and its card (the newest
 * of its mission is redrawn from the live state against the tick before it, so the card stays live);
 * a new row is numbered after the last one and compared with it.
 */
export function planTick(
  ledger: TickLedger,
  e: MissionStateEntry,
  rid: string,
  nowMs: number
): TickPlan {
  const mine = ledger.byMission[e.id] ?? { next: 1, rows: [] }
  const at = mine.rows.findIndex((r) => r.rid === rid)
  if (at >= 0) {
    const row = mine.rows[at]
    const latest = at === mine.rows.length - 1
    const before = mine.rows[at - 1]
    const card = latest
      ? tickCard(e, row.n, before ? { n: before.n, snap: before.snap } : null, nowMs)
      : row.card
    return { row, card, ledger: null, latest }
  }
  const last = mine.rows[mine.rows.length - 1]
  const n = mine.next
  const card = tickCard(e, n, last ? { n: last.n, snap: last.snap } : null, nowMs)
  const row: TickRow = { rid, n, snap: snapOf(e, nowMs), card }
  const rows = [...mine.rows, row].slice(-TICK_ROWS_MAX)
  return {
    row,
    card,
    ledger: { v: 1, byMission: { ...ledger.byMission, [e.id]: { next: n + 1, rows } } },
    latest: true
  }
}

// ---- the header, fitted to the width -------------------------------------------------------------

export interface FittedHeader {
  /** `⟳ tick #14 · title`, the title cut with `…` when it has to give way. */
  left: string
  /** The bar's cells, or `null` when there is no room for it. */
  bar: { filled: number; total: number } | null
  /** `Step 3 of 5 · 1 verified`, or just `Step 3 of 5`. */
  detail: string
}

/** The title is cut no shorter than this before anything else gives way. */
const TITLE_FLOOR = 10
/** The gap between the two halves of the header row. */
const HEADER_GAP = 2

const cells = (s: string): number => [...s].length

/**
 * What the header row draws in `inner` cells (the card's width less its border and padding). The title
 * gives way first, down to a floor; then `· V verified` goes; then the bar. One cell is always left
 * free. Below about 32 inner cells (a 36-column terminal) even the label and `Step N of M` cannot
 * both fit, and the result is best effort. A terminal font may draw `⟳` or a bar glyph wider than the layout counts, and a header that
 * fills its row to the last cell would push the border out by that one cell.
 */
export function fitHeader(card: TickCard, inner: number): FittedHeader {
  const prefix = '⟳ tick' + (card.n === null ? '' : ' #' + card.n) + ' · '
  const budget = inner - 1 - HEADER_GAP
  const short = card.detail.split(' · ')[0]
  const tries: [boolean, string][] = [
    [true, card.detail],
    [true, short],
    [false, short]
  ]
  for (const [barOn, detail] of tries) {
    const right = (barOn ? card.bar.total + 1 : 0) + cells(detail)
    const room = budget - right - cells(prefix)
    if (cells(card.title) <= room) {
      return { left: prefix + card.title, bar: barOn ? card.bar : null, detail }
    }
    if (room >= TITLE_FLOOR) {
      return {
        left: prefix + [...card.title].slice(0, room - 1).join('') + '…',
        bar: barOn ? card.bar : null,
        detail
      }
    }
  }
  // No room for a readable title beside the detail: keep the detail, cut the title to what is left.
  const room = Math.max(2, budget - cells(short) - cells(prefix))
  return {
    left: prefix + [...card.title].slice(0, room - 1).join('') + '…',
    bar: null,
    detail: short
  }
}
