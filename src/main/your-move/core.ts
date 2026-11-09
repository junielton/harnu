/**
 * Your move: card state (pure core).
 *
 * A card is one item only the operator can unblock. Every function here is a pure
 * reducer over {@link YourMoveState}: it returns a new state and never mutates its input,
 * so the store can commit-then-swap and a failed write leaves memory untouched.
 *
 * No `node:` import on purpose: this file runs in the plain `node` vitest env and in any
 * future renderer view alike.
 */

import type { MissionYouItem } from '../mcp/tool-handlers'

export const CARD_KINDS = ['decide', 'go_no_go', 'provide', 'do', 'check'] as const
export type CardKind = (typeof CARD_KINDS)[number]
export type CardSource = 'judge' | 'verb' | 'mission' | 'human-gate' | 'death' | 'judge-failure'
/** Which stream of inspections filed the card: what the queue may show is decided per lane. */
export type CardLane = 'live' | 'observe' | 'mid-turn'
/** The one setting: Off judges nothing, Observe stores cards for the debug view, Live feeds the queue. */
export type YourMoveMode = 'off' | 'observe' | 'live'
export type CloseReason =
  | 'answered'
  | 'judge'
  | 'not-for-me'
  | 'already-handled'
  | 'source-resolved'
  | 'archived'
  | 'folder-removed'
export type DeliveryFailure = 'wake-timeout' | 'process-gone' | 'not-confirmed' | 'refused'

export interface CardDelivery {
  state: 'queued' | 'sent' | 'failed'
  text: string
  at: number
  failure?: DeliveryFailure
}

export interface MissionPointer {
  missionId: string
  root: string
  item: MissionYouItem
}

export interface YourMoveCard {
  id: string
  sessionId: string
  folder: string
  kind: CardKind
  ask: string
  /** System cards render their text through `$t`; `ask` keeps the English fallback. */
  askKey?: { key: string; params: Record<string, string> }
  context?: string
  blocks?: string
  options?: string[]
  recommended?: string
  link?: string
  confidence?: 'high' | 'low'
  evidence?: string
  source: CardSource
  sourceKey?: string
  lane: CardLane
  mission?: MissionPointer
  openedAt: number
  updatedAt: number
  closedAt?: number
  closedBy?: CloseReason
  delivery?: CardDelivery
  cue?: { lastCuedAt: number; nudges: number }
}

/** What the renderer is handed for one card: the card plus what the queue may offer on it. */
export type CardView = YourMoveCard & { answerable: boolean; optionDeliverable: boolean[] }

export interface SessionCursor {
  offset: number
  shadowOffset?: number
  lastInspectedAt: number
}

export interface YourMoveState {
  version: 1
  cards: YourMoveCard[]
  cursors: Record<string, SessionCursor>
}

export interface JudgeNew {
  kind: CardKind
  ask: string
  context?: string
  blocks?: string
  options?: string[]
  recommended?: string
  link?: string
  confidence?: 'high' | 'low'
  evidence?: string
}

export interface Verdict {
  new: JudgeNew[]
  /** Gate v1 sends bare ids: a judge update bumps `updatedAt` and keeps `ask`, unless one is given. */
  update: { id: string; ask?: string }[]
  close: string[]
}

export interface StructuredDraft extends Omit<JudgeNew, 'confidence' | 'evidence'> {
  sessionId: string
  folder: string
  source: CardSource
  sourceKey: string
  lane: CardLane
  askKey?: YourMoveCard['askKey']
  mission?: MissionPointer
}

const DAY_MS = 86_400_000
const PRUNE_AFTER_MS = 30 * DAY_MS
const MAX_CLOSED = 1000

export function emptyState(): YourMoveState {
  return { version: 1, cards: [], cursors: {} }
}

const isOpen = (c: YourMoveCard): boolean => c.closedAt === undefined

/** Sources the judge sees and may update or close; the rest are pointers owned by their source. */
const isJudgeOwned = (c: YourMoveCard): boolean => c.source === 'judge' || c.source === 'verb'

/** The open cards the judge is shown for one session and lane. */
export function openCardsFor(s: YourMoveState, sessionId: string, lane: CardLane): YourMoveCard[] {
  return s.cards.filter(
    (c) => isOpen(c) && c.sessionId === sessionId && c.lane === lane && isJudgeOwned(c)
  )
}

/** Model text is untrusted: only plain http(s) links survive. */
function safeLink(link: string | undefined): string | undefined {
  if (!link) return undefined
  try {
    const u = new URL(link)
    return u.protocol === 'http:' || u.protocol === 'https:' ? link : undefined
  } catch {
    return undefined
  }
}

function cleanOptions(options: string[] | undefined): string[] | undefined {
  if (!options) return undefined
  const out = options.filter((o) => typeof o === 'string' && o.trim().length > 0)
  return out.length > 0 ? out : undefined
}

function fromJudgeNew(
  n: JudgeNew,
  id: string,
  input: { sessionId: string; folder: string; lane: CardLane; now: number }
): YourMoveCard {
  const options = cleanOptions(n.options)
  return {
    id,
    sessionId: input.sessionId,
    folder: input.folder,
    kind: n.kind,
    ask: n.ask.trim(),
    context: n.context?.trim() || undefined,
    blocks: n.blocks?.trim() || undefined,
    options,
    recommended:
      options && n.recommended && options.includes(n.recommended) ? n.recommended : undefined,
    link: safeLink(n.link),
    confidence: n.confidence,
    evidence: n.evidence,
    source: 'judge',
    lane: input.lane,
    openedAt: input.now,
    updatedAt: input.now
  }
}

/**
 * Fold one judge verdict into the state.
 *
 * `update` refreshes `ask` and `updatedAt` only: `openedAt` is the operator's clock and never
 * moves. `close` is honoured only when the segment held an `[OPERATOR]` entry: a model
 * alone can never decide the operator dealt with something. `newIds` are minted by the
 * caller so a re-fold of the same verdict (a multi-part run committed again) reuses them,
 * and a card already present under that id, closed by the operator meanwhile, stays closed.
 */
export function applyVerdict(
  s: YourMoveState,
  input: {
    sessionId: string
    folder: string
    verdict: Verdict
    newIds: string[]
    hasOperatorEntry: boolean
    lane: CardLane
    now: number
  }
): YourMoveState {
  const { sessionId, verdict, now } = input
  const updates = new Map(verdict.update.map((u) => [u.id, u.ask]))
  const closes = new Set(input.hasOperatorEntry ? verdict.close : [])
  const cards = s.cards.map((c) => {
    if (!isOpen(c) || c.sessionId !== sessionId || !isJudgeOwned(c)) return c
    if (closes.has(c.id)) return { ...c, closedAt: now, closedBy: 'judge' as const }
    if (!updates.has(c.id)) return c
    const ask = updates.get(c.id)?.trim()
    return { ...c, ask: ask ? ask : c.ask, updatedAt: now }
  })
  const known = new Set(cards.map((c) => c.id))
  verdict.new.forEach((n, i) => {
    const id = input.newIds[i]
    if (!id || known.has(id)) return
    if (!CARD_KINDS.includes(n.kind) || typeof n.ask !== 'string' || n.ask.trim() === '') return
    known.add(id)
    cards.push(fromJudgeNew(n, id, input))
  })
  return { ...s, cards }
}

/** Move one cursor field. A session never seen before starts both fields at `to`. */
export function advanceCursor(
  s: YourMoveState,
  sessionId: string,
  field: 'offset' | 'shadowOffset',
  to: number,
  now: number
): YourMoveState {
  const prev = s.cursors[sessionId]
  const next: SessionCursor = { ...(prev ?? { offset: to }), [field]: to, lastInspectedAt: now }
  return { ...s, cursors: { ...s.cursors, [sessionId]: next } }
}

export function closeCard(
  s: YourMoveState,
  cardId: string,
  reason: CloseReason,
  now: number
): YourMoveState {
  return closeWhere(s, (c) => c.id === cardId, reason, now)
}

function closeWhere(
  s: YourMoveState,
  pick: (c: YourMoveCard) => boolean,
  reason: CloseReason,
  now: number
): YourMoveState {
  let changed = false
  const cards = s.cards.map((c) => {
    if (!isOpen(c) || !pick(c)) return c
    changed = true
    return { ...c, closedAt: now, closedBy: reason }
  })
  return changed ? { ...s, cards } : s
}

function draftToCard(d: StructuredDraft, id: string, now: number): YourMoveCard {
  const options = cleanOptions(d.options)
  return {
    id,
    sessionId: d.sessionId,
    folder: d.folder,
    kind: d.kind,
    ask: d.ask,
    askKey: d.askKey,
    context: d.context,
    blocks: d.blocks,
    options,
    recommended:
      options && d.recommended && options.includes(d.recommended) ? d.recommended : undefined,
    link: safeLink(d.link),
    source: d.source,
    sourceKey: d.sourceKey,
    lane: d.lane,
    mission: d.mission,
    openedAt: now,
    updatedAt: now
  }
}

/** File a structured card, or refresh the open one with the same source and key (clock kept). */
export function upsertStructured(
  s: YourMoveState,
  draft: StructuredDraft,
  mintId: () => string,
  now: number
): YourMoveState {
  const at = s.cards.findIndex(
    (c) => isOpen(c) && c.source === draft.source && c.sourceKey === draft.sourceKey
  )
  if (at === -1) return { ...s, cards: [...s.cards, draftToCard(draft, mintId(), now)] }
  const prev = s.cards[at]
  const fresh = draftToCard(draft, prev.id, prev.openedAt)
  const cards = s.cards.slice()
  cards[at] = {
    ...prev,
    ...fresh,
    openedAt: prev.openedAt,
    updatedAt: now,
    delivery: prev.delivery,
    cue: prev.cue
  }
  return { ...s, cards }
}

/**
 * Make the open cards of one source match what is owed right now: upsert every owed draft,
 * close the in-scope open cards whose key is no longer owed as `source-resolved`. A scope
 * with `sessionId` or `missionIds` never reaches cards outside it.
 */
export function reconcileSource(
  s: YourMoveState,
  scope: { source: CardSource; sessionId?: string; missionIds?: readonly string[] },
  owed: readonly StructuredDraft[],
  mintId: () => string,
  now: number
): YourMoveState {
  const owedKeys = new Set(owed.map((d) => d.sourceKey))
  const inScope = (c: YourMoveCard): boolean =>
    c.source === scope.source &&
    (scope.sessionId === undefined || c.sessionId === scope.sessionId) &&
    (scope.missionIds === undefined ||
      (c.mission !== undefined && scope.missionIds.includes(c.mission.missionId)))
  let next = closeWhere(
    s,
    (c) => inScope(c) && !(c.sourceKey !== undefined && owedKeys.has(c.sourceKey)),
    'source-resolved',
    now
  )
  for (const d of owed) next = upsertStructured(next, d, mintId, now)
  return next
}

export function closeForSessions(
  s: YourMoveState,
  ids: readonly string[],
  reason: CloseReason,
  now: number
): YourMoveState {
  const set = new Set(ids)
  return closeWhere(s, (c) => set.has(c.sessionId), reason, now)
}

/** Close every open card of a folder that is gone, including folders nested under it. */
export function closeForFolder(
  s: YourMoveState,
  folder: string,
  reason: CloseReason,
  now: number
): YourMoveState {
  const root = folder.replace(/\/+$/, '')
  return closeWhere(s, (c) => c.folder === root || c.folder.startsWith(root + '/'), reason, now)
}

/** Forget where every session was read up to: the next first sight starts at the end again. */
export function resetCursors(s: YourMoveState): YourMoveState {
  return { ...s, cursors: {} }
}

/** Closed cards older than 30 days go, and at most 1000 closed cards stay. Open cards never go. */
export function pruneClosed(s: YourMoveState, now: number): YourMoveState {
  const keep = s.cards.filter((c) => isOpen(c) || now - (c.closedAt ?? 0) <= PRUNE_AFTER_MS)
  const closed = keep.filter((c) => !isOpen(c))
  if (closed.length <= MAX_CLOSED && keep.length === s.cards.length) return s
  const drop = new Set(
    closed
      .slice()
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
      .slice(MAX_CLOSED)
      .map((c) => c.id)
  )
  return { ...s, cards: keep.filter((c) => !drop.has(c.id)) }
}
