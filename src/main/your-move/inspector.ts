/**
 * The inspector: reads what a session wrote since its cursor, asks the judge, and stores
 * the verdict and the new cursor in ONE transaction.
 *
 * Invariants (plan "Global Constraints"):
 * - the cursor advances only when a verdict is stored, in the same atomic write; a judge or
 *   store failure leaves it where it was, so a crash re-inspects instead of skipping;
 * - never two judges for one session: a request during a run coalesces into one rerun;
 * - a session first seen at its Stop has its recent tail judged (recall over noise);
 * - mid-turn inspection moves only `shadowOffset`, so a later Stop judges the same text.
 *
 * The transcript text never leaves this module except to the judge calls: the inspection log
 * rows carry counts and outcomes only.
 */

import {
  advanceCursor,
  applyVerdict,
  openCardsFor,
  type CardLane,
  type Verdict,
  type YourMoveMode
} from './core'
import type { JudgeRunner } from './judge'
import { judgeSegment } from './pipeline'
import {
  buildSegment,
  hasOperatorEntry,
  isJudgeable,
  splitSegment,
  type SegmentEntry
} from './segment'
import type { YourMoveStore } from './store'
import type { readFrom, ReadResult } from './transcript'

export type Trigger = 'stop' | 'mid-turn' | 'manual'

export interface InspectRequest {
  sessionId: string
  folder: string
  transcriptPath: string
  trigger: Trigger
  /** The hook's own copy of the last reply, for when the transcript has not caught up yet. */
  lastAssistantMessage?: string
}

export type InspectOutcome = 'first-sight' | 'skipped' | 'empty' | 'judged' | 'failed'

export interface InspectorDeps {
  store: YourMoveStore
  read: typeof readFrom
  detect: JudgeRunner['detect']
  enrich: JudgeRunner['enrich']
  now(): number
  mintId(): string
  isBlocked(folder: string): boolean
  isArchived(id: string): boolean
  isFolderOff(folder: string): boolean
  mode(): YourMoveMode
  midTurnLive(): boolean
  classify(lines: readonly unknown[]): 'interactive' | 'programmatic' | null
  onFailure?(req: InspectRequest, reason: string): void
  onSuccess?(req: InspectRequest): void
  appendInspection?(row: Record<string, unknown>): void
}

export const MAX_SEGMENT_CHARS = 300_000
/** How far back a session first seen at its Stop is read. */
const FIRST_SIGHT_TAIL_BYTES = 256 * 1024

export function laneFor(mode: YourMoveMode, trigger: Trigger, midTurnLive: boolean): CardLane {
  if (mode !== 'live') return 'observe'
  if (trigger === 'mid-turn') return midTurnLive ? 'live' : 'mid-turn'
  return 'live'
}

interface Fold {
  verdict: Verdict
  newIds: string[]
  hasOperatorEntry: boolean
}

const TRIGGER_RANK: Record<Trigger, number> = { stop: 3, manual: 2, 'mid-turn': 1 }

function merge(a: InspectRequest, b: InspectRequest): InspectRequest {
  const stronger = TRIGGER_RANK[b.trigger] > TRIGGER_RANK[a.trigger] ? b : a
  return {
    ...b,
    trigger: stronger.trigger,
    lastAssistantMessage: b.lastAssistantMessage ?? a.lastAssistantMessage
  }
}

export function createInspector(deps: InspectorDeps): {
  request(r: InspectRequest): Promise<InspectOutcome>
  idle(): Promise<void>
} {
  interface Slot {
    next?: {
      req: InspectRequest
      promise: Promise<InspectOutcome>
      resolve(o: InspectOutcome): void
    }
  }
  const slots = new Map<string, Slot>()
  const inflight = new Set<Promise<unknown>>()

  const log = (
    req: InspectRequest,
    outcome: InspectOutcome,
    extra: Record<string, unknown> = {}
  ): void => {
    try {
      deps.appendInspection?.({
        at: deps.now(),
        sessionId: req.sessionId,
        trigger: req.trigger,
        outcome,
        ...extra
      })
    } catch {
      /* the log is best effort */
    }
  }

  const fail = (req: InspectRequest, reason: string): InspectOutcome => {
    log(req, 'failed', { reason })
    try {
      deps.onFailure?.(req, reason)
    } catch {
      /* a broken listener must not turn a failure into a crash */
    }
    return 'failed'
  }

  async function inspect(req: InspectRequest): Promise<InspectOutcome> {
    const mode = deps.mode()
    if (
      mode === 'off' ||
      deps.isBlocked(req.folder) ||
      deps.isArchived(req.sessionId) ||
      deps.isFolderOff(req.folder)
    ) {
      return 'skipped'
    }
    const field = req.trigger === 'mid-turn' ? 'shadowOffset' : 'offset'
    const cursor = deps.store.state().cursors[req.sessionId]
    const from = cursor
      ? field === 'shadowOffset'
        ? (cursor.shadowOffset ?? cursor.offset)
        : cursor.offset
      : null

    let res: ReadResult
    try {
      res = await deps.read(
        req.transcriptPath,
        from === null ? { tail: FIRST_SIGHT_TAIL_BYTES } : from
      )
    } catch (e) {
      return fail(req, `transcript unreadable: ${(e as Error).message}`)
    }
    if (deps.classify(res.lines) === 'programmatic') return 'skipped'

    const sync = async (
      apply: Parameters<typeof deps.store.transact<void>>[0]
    ): Promise<boolean> => {
      try {
        await deps.store.transact(apply)
        return true
      } catch (e) {
        fail(req, `store write failed: ${(e as Error).message}`)
        return false
      }
    }

    if (res.shrunk || (from === null && req.trigger === 'mid-turn')) {
      // A file that shrank was rewritten, and a long turn first seen mid-way is not judged
      // from its middle: start at the end, the Stop will read the recent tail.
      const end = res.nextOffset
      const ok = await sync((s) => ({
        next: advanceCursor(
          advanceCursor(s, req.sessionId, 'offset', end, deps.now()),
          req.sessionId,
          'shadowOffset',
          end,
          deps.now()
        ),
        result: undefined
      }))
      if (!ok) return 'failed'
      log(req, 'first-sight', res.shrunk ? { reason: 'shrunk' } : {})
      return 'first-sight'
    }

    let entries = buildSegment(res.lines)
    const hook = req.lastAssistantMessage?.trim()
    if (hook && !entries.some((e) => e.tag === 'ASSISTANT' && e.text.includes(hook))) {
      entries = [...entries, { tag: 'ASSISTANT', text: hook }]
    }

    if (!isJudgeable(entries)) {
      if (from !== null && res.nextOffset === from) {
        log(req, 'empty')
        return 'empty'
      }
      const ok = await sync((s) => ({
        next: advanceCursor(s, req.sessionId, field, res.nextOffset, deps.now()),
        result: undefined
      }))
      if (!ok) return 'failed'
      log(req, 'empty')
      return 'empty'
    }

    const lane = laneFor(mode, req.trigger, deps.midTurnLive())
    const parts: SegmentEntry[][] = splitSegment(entries, MAX_SEGMENT_CHARS)
    const folds: Fold[] = []
    let working = deps.store.state()
    let cost = 0
    let filed = 0
    let detectorFailures = 0
    let fallbacks = 0
    for (const part of parts) {
      const open = openCardsFor(working, req.sessionId, lane).map((c) => ({ id: c.id, ask: c.ask }))
      const outcome = await judgeSegment({ detect: deps.detect, enrich: deps.enrich }, open, part)
      if (!outcome.ok) return fail(req, outcome.reason)
      cost += outcome.costUsd
      detectorFailures += outcome.detectorFailures
      if (outcome.enrichment === 'fallback') fallbacks++
      // Ids are minted once per part so a re-fold at commit reuses them.
      const fold: Fold = {
        verdict: outcome.verdict,
        newIds: outcome.verdict.new.map(() => deps.mintId()),
        hasOperatorEntry: hasOperatorEntry(part)
      }
      folds.push(fold)
      filed += fold.verdict.new.length
      working = applyVerdict(working, {
        sessionId: req.sessionId,
        folder: req.folder,
        lane,
        now: deps.now(),
        ...fold
      })
    }

    // One write: every part's verdict, then the cursor. Folded again on the state as it is
    // now, so a card the operator closed while the judge ran stays closed.
    const now = deps.now()
    const ok = await sync((s) => {
      let next = s
      for (const f of folds) {
        next = applyVerdict(next, {
          sessionId: req.sessionId,
          folder: req.folder,
          lane,
          now,
          ...f
        })
      }
      return {
        next: advanceCursor(next, req.sessionId, field, res.nextOffset, now),
        result: undefined
      }
    })
    if (!ok) return 'failed'
    log(req, 'judged', {
      parts: parts.length,
      filed,
      costUsd: cost,
      detectorFailures,
      enrichFallbacks: fallbacks
    })
    try {
      deps.onSuccess?.(req)
    } catch {
      /* ignore */
    }
    return 'judged'
  }

  function start(slot: Slot, req: InspectRequest): Promise<InspectOutcome> {
    const run = inspect(req)
      .catch((e): InspectOutcome => fail(req, `inspection crashed: ${(e as Error).message}`))
      .then((outcome) => {
        const next = slot.next
        slot.next = undefined
        if (!next) {
          slots.delete(req.sessionId)
        } else {
          const rerun = start(slot, next.req)
          void rerun.then(next.resolve)
        }
        return outcome
      })
    inflight.add(run)
    void run.finally(() => inflight.delete(run))
    return run
  }

  return {
    request(req) {
      const slot = slots.get(req.sessionId)
      if (!slot) {
        const fresh: Slot = {}
        slots.set(req.sessionId, fresh)
        return start(fresh, req)
      }
      if (slot.next) {
        slot.next.req = merge(slot.next.req, req)
        return slot.next.promise
      }
      let resolve!: (o: InspectOutcome) => void
      const promise = new Promise<InspectOutcome>((r) => (resolve = r))
      slot.next = { req, promise, resolve }
      inflight.add(promise)
      void promise.finally(() => inflight.delete(promise))
      return promise
    },
    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    }
  }
}
