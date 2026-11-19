/**
 * What starts an inspection: the hook edges the task-state hub already folds.
 *
 * Nothing here delays or blocks a hook. The observer returns at once; the work runs after a
 * settle delay, long after the bridge answered `200 {}`. With the mode Off, nothing is read:
 * not a transcript, not a directory. Every dependency failure is swallowed here, because an
 * observer that throws would be logged by the hub but a rejected promise would not be.
 */

import type { HookTaskEvent } from '../detect/task-state-hub'
import type { FailureReason, TaskState } from '../hook-state'
import type { PtyExitFact } from '../pty'
import {
  advanceCursor,
  followLive,
  reconcileSource,
  upsertStructured,
  type CardLane,
  type StructuredDraft,
  type YourMoveMode
} from './core'
import type { InspectOutcome, InspectRequest } from './inspector'
import { buildSegment, hasAssistantText } from './segment'
import type { YourMoveStore } from './store'
import type { readFrom } from './transcript'

/** The CLI writes the last reply to the transcript a moment after it fires `Stop`. */
export const STOP_SETTLE_MS = 2_000
/** How many times the transcript is re-read for a reply the hook carried but the file lacks. */
const REREADS = 3
const REREAD_DELAY_MS = 500
/** A working session that was last inspected longer ago than this is looked at again. */
export const MID_TURN_AFTER_MS = 5 * 60_000
/** How often the sweep looks at the working sessions. */
export const SWEEP_MS = 60_000
/** First sight classifies the session from the newest 256 KiB: small files are read whole. */
const CLASSIFY_TAIL_BYTES = 256 * 1024

export interface TriggerDeps {
  inspector: { request(r: InspectRequest): Promise<InspectOutcome> }
  store: Pick<YourMoveStore, 'state'>
  mode(): YourMoveMode
  /** False for a blocked folder, an archived session or a folder switched off. */
  eligible(sessionId: string, folder: string): Promise<boolean>
  /** `~/.claude/projects/*\/<id>.jsonl`, for a companion event that named no path. */
  locate(sessionId: string): Promise<string | null>
  /** The hook's `cwd`, else wherever the transcript says the session runs. */
  resolveFolder(
    sessionId: string,
    cwd: string | undefined,
    transcriptPath: string
  ): Promise<string | null>
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  ensureCursor(sessionId: string, path: string): Promise<void>
  /** Does the transcript already hold this reply? */
  transcriptHas(path: string, text: string): Promise<boolean>
  delay(ms: number): Promise<void>
}

/**
 * Put the cursor of a session never seen before at the end of its transcript, so install does
 * not judge history and the first turn is judged from its start. Harnu's own headless runs
 * (the auto-namer, the usage poller) fire the same global hooks: they get no cursor at all.
 */
export function createEnsureCursor(deps: {
  store: YourMoveStore
  read: typeof readFrom
  classify(lines: readonly unknown[]): 'interactive' | 'programmatic' | null
  now(): number
}): (sessionId: string, path: string) => Promise<void> {
  return async (sessionId, path) => {
    // Only a session never seen gets a cursor from a hook: a compaction or a prompt must never
    // create or move the live offset of one already seen (that would skip text a Stop must judge).
    if (deps.store.state().cursors[sessionId] !== undefined) return
    const res = await deps.read(path, { tail: CLASSIFY_TAIL_BYTES })
    if (deps.classify(res.lines) === 'programmatic') return
    const end = res.nextOffset
    await deps.store.transact((s) =>
      s.cursors[sessionId] !== undefined
        ? { next: s, result: undefined }
        : {
            next: followLive(
              advanceCursor(s, sessionId, 'offset', end, deps.now()),
              sessionId,
              end
            ),
            result: undefined
          }
    )
  }
}

export function createTriggers(deps: TriggerDeps): {
  onTaskEvent(ev: HookTaskEvent): void
  dispose(): void
} {
  let disposed = false
  /** A Stop already waiting out its settle window, per session. */
  const pendingStop = new Map<
    string,
    { lastAssistantMessage?: string; cwd?: string; path?: string }
  >()

  const swallow = (what: string) => (e: unknown) => {
    console.error(`[your-move] ${what} failed: ${(e as Error)?.message ?? e}`)
  }

  async function pathFor(sessionId: string, path: string | undefined): Promise<string | null> {
    return path ?? (await deps.locate(sessionId))
  }

  async function firstSight(ev: HookTaskEvent): Promise<void> {
    if (deps.store.state().cursors[ev.sessionId] !== undefined) return
    const path = await pathFor(ev.sessionId, ev.payload?.transcriptPath)
    if (!path || disposed) return
    const folder = await deps.resolveFolder(ev.sessionId, ev.payload?.cwd, path)
    if (!folder || !(await deps.eligible(ev.sessionId, folder)) || disposed) return
    await deps.ensureCursor(ev.sessionId, path)
  }

  async function runStop(sessionId: string): Promise<void> {
    const pending = pendingStop.get(sessionId)
    pendingStop.delete(sessionId)
    if (!pending || disposed || deps.mode() === 'off') return
    const path = await pathFor(sessionId, pending.path)
    if (!path) return
    const folder = await deps.resolveFolder(sessionId, pending.cwd, path)
    if (!folder || !(await deps.eligible(sessionId, folder)) || disposed) return
    const last = pending.lastAssistantMessage
    if (last) {
      for (let i = 0; i < REREADS && !(await deps.transcriptHas(path, last)); i++) {
        await deps.delay(REREAD_DELAY_MS)
      }
    }
    if (disposed) return
    await deps.inspector.request({
      sessionId,
      folder,
      transcriptPath: path,
      trigger: 'stop',
      ...(last ? { lastAssistantMessage: last } : {})
    })
  }

  return {
    onTaskEvent(ev) {
      if (disposed || deps.mode() === 'off' || ev.agentId !== undefined) return
      if (ev.event === 'SessionStart' || ev.event === 'UserPromptSubmit') {
        firstSight(ev).catch(swallow('first sight'))
        return
      }
      if (ev.event !== 'Stop') return
      const waiting = pendingStop.get(ev.sessionId)
      if (waiting) {
        // A second Stop inside the window: one inspection, with the newest reply.
        waiting.lastAssistantMessage =
          ev.payload?.lastAssistantMessage ?? waiting.lastAssistantMessage
        waiting.cwd = ev.payload?.cwd ?? waiting.cwd
        waiting.path = ev.payload?.transcriptPath ?? waiting.path
        return
      }
      pendingStop.set(ev.sessionId, {
        lastAssistantMessage: ev.payload?.lastAssistantMessage,
        cwd: ev.payload?.cwd,
        path: ev.payload?.transcriptPath
      })
      deps.setTimer(() => {
        runStop(ev.sessionId).catch(swallow('stop inspection'))
      }, STOP_SETTLE_MS)
    },
    dispose() {
      disposed = true
      pendingStop.clear()
    }
  }
}

export interface MidTurnDeps {
  inspector: { request(r: InspectRequest): Promise<InspectOutcome> }
  store: Pick<YourMoveStore, 'state'>
  mode(): YourMoveMode
  eligible(sessionId: string, folder: string): Promise<boolean>
  locate(sessionId: string): Promise<string | null>
  resolveFolder(
    sessionId: string,
    cwd: string | undefined,
    transcriptPath: string
  ): Promise<string | null>
  read: typeof readFrom
  /** The folded task state of every live session. */
  states(): ReadonlyMap<string, TaskState>
  now(): number
}

/**
 * Long turns that never reach a Stop: a working session with no inspection for five minutes
 * and new assistant text since is inspected as `mid-turn`. That run moves only the shadow
 * cursor, so the text it judged is judged again, on the live cursor, at the Stop.
 */
export function createMidTurnSweep(deps: MidTurnDeps): { tick(): Promise<void>; dispose(): void } {
  let disposed = false
  /** Sessions with a sweep request still running: never asked twice. */
  const running = new Set<string>()
  /** Where each swept session lives, found once. */
  const where = new Map<string, { path: string; folder: string }>()
  /**
   * When each session was last asked for, whether or not it worked. A failed inspection moves no
   * cursor and no `lastInspectedAt`, so without this a failing judge would be asked again on
   * every tick, two detector runs each.
   */
  const lastAttempt = new Map<string, number>()

  async function look(sessionId: string): Promise<void> {
    const cursor = deps.store.state().cursors[sessionId]
    const last = Math.max(cursor?.lastInspectedAt ?? 0, lastAttempt.get(sessionId) ?? 0)
    if (last > 0 && deps.now() - last < MID_TURN_AFTER_MS) return
    let spot = where.get(sessionId)
    if (!spot) {
      const path = await deps.locate(sessionId)
      if (!path) return
      const folder = await deps.resolveFolder(sessionId, undefined, path)
      if (!folder) return
      spot = { path, folder }
      where.set(sessionId, spot)
    }
    if (!(await deps.eligible(sessionId, spot.folder)) || disposed) return
    const from = cursor?.shadowOffset ?? cursor?.offset
    if (from !== undefined) {
      // Tool-only progress is not worth a judge call, and moving the shadow cursor over it
      // would hide nothing: it is left to be read together with the next text.
      const res = await deps.read(spot.path, from)
      if (res.shrunk) {
        // a rewritten file: the inspector resets the cursors
      } else if (!hasAssistantText(buildSegment(res.lines))) {
        return
      }
    }
    running.add(sessionId)
    lastAttempt.set(sessionId, deps.now())
    void deps.inspector
      .request({
        sessionId,
        folder: spot.folder,
        transcriptPath: spot.path,
        trigger: 'mid-turn'
      })
      .catch((e) =>
        console.error(`[your-move] mid-turn inspection failed: ${(e as Error).message}`)
      )
      .finally(() => running.delete(sessionId))
  }

  return {
    async tick() {
      if (disposed || deps.mode() === 'off') return
      const working: string[] = []
      for (const [id, state] of deps.states()) if (state === 'working') working.push(id)
      for (const id of [...where.keys()]) if (!working.includes(id)) where.delete(id)
      for (const id of [...lastAttempt.keys()]) if (!working.includes(id)) lastAttempt.delete(id)
      for (const id of working) {
        if (disposed || running.has(id)) continue
        try {
          await look(id)
        } catch (e) {
          console.error(`[your-move] sweep skipped a session: ${(e as Error).message}`)
        }
      }
    },
    dispose() {
      disposed = true
      running.clear()
      where.clear()
      lastAttempt.clear()
    }
  }
}

// ─── Death and judge-failure cards ────────────────────────────────────────────

/** A Ctrl+C this recent before the exit means the operator ended the session on purpose. */
export const CTRL_C_GRACE_MS = 5_000

/**
 * Did a session's process die on the operator without them choosing it? Counts a natural exit
 * while the session was working or waiting, or whose state is unknown (nothing proves it idle:
 * a false alarm costs one click, a session dying unnoticed costs the work). Does not count
 * Harnu's own quit or the operator's close (the record was removed first), a hibernation, a
 * Ctrl+C just before, or an exit while the session sat idle or already finished.
 */
export function isDeathExit(x: PtyExitFact): boolean {
  if (x.removedFirst || x.reason !== 'natural') return false
  if (x.lastCtrlCAt !== undefined && x.now - x.lastCtrlCAt <= CTRL_C_GRACE_MS) return false
  return x.taskState === undefined || x.taskState === 'working' || x.taskState === 'needs-input'
}

const humanReason = (r: string): string => r.replace(/_/g, ' ')

export function deathDraft(input: {
  sessionId: string
  folder: string
  failureReason?: FailureReason
  lane: CardLane
}): StructuredDraft {
  const reason = input.failureReason
    ? humanReason(input.failureReason)
    : 'the process ended while it was working'
  return {
    sessionId: input.sessionId,
    folder: input.folder,
    kind: 'do',
    ask: `Session stopped: ${reason}`,
    askKey: { key: 'yourMove.system.stopped', params: { reason } },
    source: 'death',
    sourceKey: `death:${input.sessionId}`,
    lane: input.lane
  }
}

export function failureDraft(input: {
  sessionId: string
  folder: string
  reason: string
  lane: CardLane
}): StructuredDraft {
  return {
    sessionId: input.sessionId,
    folder: input.folder,
    kind: 'do',
    ask: `Could not check this session: ${input.reason}`,
    askKey: { key: 'yourMove.system.couldNotCheck', params: { reason: input.reason } },
    source: 'judge-failure',
    sourceKey: `judge-failure:${input.sessionId}`,
    lane: input.lane
  }
}

export interface SystemCardDeps {
  store: YourMoveStore
  mode(): YourMoveMode
  /** The lane a Stop-driven card lands in right now. */
  lane(): CardLane
  eligible(sessionId: string, folder: string): Promise<boolean>
  locate(sessionId: string): Promise<string | null>
  resolveFolder(
    sessionId: string,
    cwd: string | undefined,
    transcriptPath: string
  ): Promise<string | null>
  /** Reads a transcript, to tell Harnu's own headless runs from a session. */
  read: typeof readFrom
  mintId(): string
  now(): number
}

/**
 * Cards that come from no judge: a session that stopped on an error or died, and a session
 * Harnu could not check. Both are one card per session (the source key), and neither retries
 * anything: the next trigger tries again.
 */
export function createSystemCards(deps: SystemCardDeps): {
  onTaskEvent(ev: HookTaskEvent): void
  onPtyExit(x: PtyExitFact): void
  onInspectFailure(req: InspectRequest, reason: string): void
  onInspectSuccess(req: InspectRequest): void
  /** Resolves when every write started so far has settled. */
  idle(): Promise<void>
} {
  const pending = new Set<Promise<unknown>>()
  const track = (what: string, work: () => Promise<void>): void => {
    const p = work()
      .catch((e) => console.error(`[your-move] ${what} failed: ${(e as Error)?.message ?? e}`))
      .finally(() => pending.delete(p))
    pending.add(p)
  }

  /** Files the card, or refreshes the open one for this session: the clock keeps running. */
  const file = (draft: StructuredDraft): Promise<void> =>
    deps.store.transact((s) => ({
      next: upsertStructured(s, draft, deps.mintId, deps.now()),
      result: undefined
    }))

  const resolve = (source: 'death' | 'judge-failure', sessionId: string): Promise<void> =>
    deps.store.transact((s) => ({
      next: reconcileSource(s, { source, sessionId }, [], deps.mintId, deps.now()),
      result: undefined
    }))

  /**
   * Whether each session's current turn has not ended: set by a prompt, cleared by a Stop or a
   * StopFailure. SessionEnd folds `working` to `completed` before the process exits, so a CLI
   * that shuts down gracefully mid-turn would otherwise read as finished.
   */
  const turnOpen = new Map<string, boolean>()
  /** The newest working directory a hook reported for each session. */
  const lastCwd = new Map<string, string>()
  const MAX_TRACKED = 5_000
  const remember = <V>(map: Map<string, V>, id: string, value: V): void => {
    map.delete(id)
    map.set(id, value)
    if (map.size > MAX_TRACKED) map.delete(map.keys().next().value as string)
  }

  /** The best folder known: the hook's, the PTY's, then wherever the transcript says it runs. */
  async function folderFor(
    sessionId: string,
    ...known: (string | undefined)[]
  ): Promise<string | null> {
    for (const k of known) if (k) return k
    const path = await deps.locate(sessionId)
    return path ? await deps.resolveFolder(sessionId, undefined, path) : null
  }

  /**
   * Harnu's own headless runs (the auto-namer, the usage poller) are Agent SDK sessions: their
   * transcripts carry an `sdk-*` entrypoint. Any other entrypoint, an IDE's among them, is a
   * session of the operator, and one Harnu cannot place files the card: a false alarm beats a
   * silent death.
   */
  async function isProgrammatic(sessionId: string, hint: string | undefined): Promise<boolean> {
    try {
      const path = hint ?? (await deps.locate(sessionId))
      if (!path) return false
      const res = await deps.read(path, { tail: CLASSIFY_TAIL_BYTES })
      for (const line of res.lines) {
        const ep = (line as { entrypoint?: unknown }).entrypoint
        if (typeof ep === 'string' && ep !== '') return ep.startsWith('sdk')
      }
      return false
    } catch {
      return false // could not tell: file the card
    }
  }

  return {
    onTaskEvent(ev) {
      if (ev.agentId !== undefined) return
      // Tracked whatever the mode: an in-memory fact, no transcript read and nothing spent. A turn
      // opens with any event that moves the session to working or waiting (a prompt, a tool event,
      // a task notification) and only a Stop or a StopFailure closes it, so a mode switched on
      // mid-turn, or a turn whose prompt was never seen, still reads as running at a graceful end.
      if (ev.payload?.cwd) remember(lastCwd, ev.sessionId, ev.payload.cwd)
      if (ev.event === 'Stop' || ev.event === 'StopFailure') {
        remember(turnOpen, ev.sessionId, false)
      } else if (ev.taskState === 'working' || ev.taskState === 'needs-input') {
        remember(turnOpen, ev.sessionId, true)
      }
      if (deps.mode() === 'off') return
      if (ev.event === 'StopFailure') {
        track('death card', async () => {
          const folder = await folderFor(ev.sessionId, ev.payload?.cwd, lastCwd.get(ev.sessionId))
          if (!folder) {
            console.error(`[your-move] no folder known for ${ev.sessionId}: death card not filed`)
            return
          }
          if (!(await deps.eligible(ev.sessionId, folder))) return
          if (await isProgrammatic(ev.sessionId, ev.payload?.transcriptPath)) return
          await file(
            deathDraft({
              sessionId: ev.sessionId,
              folder,
              failureReason: ev.failureReason ?? 'unknown',
              lane: deps.lane()
            })
          )
        })
      } else if (ev.event === 'Stop') {
        // A turn that ended well closes the card a failed one opened.
        track('death card close', () => resolve('death', ev.sessionId))
      }
    },
    onPtyExit(x) {
      const open = turnOpen.get(x.sessionKey) === true
      const hookCwd = lastCwd.get(x.sessionKey)
      turnOpen.delete(x.sessionKey)
      lastCwd.delete(x.sessionKey)
      if (deps.mode() === 'off') return
      // No Stop for the current turn means the turn was still running, whatever SessionEnd made of the state.
      const fact: PtyExitFact = open ? { ...x, taskState: 'working' } : x
      if (!isDeathExit(fact)) return
      track('death card', async () => {
        const folder = await folderFor(x.sessionKey, hookCwd, x.cwd)
        if (!folder) {
          console.error(`[your-move] no folder known for ${x.sessionKey}: death card not filed`)
          return
        }
        if (!(await deps.eligible(x.sessionKey, folder))) return
        await file(deathDraft({ sessionId: x.sessionKey, folder, lane: deps.lane() }))
      })
    },
    onInspectFailure(req, reason) {
      // A mid-turn run is a hidden shadow of the Stop one, and a manual run answers to the
      // operator who pressed the button; only a Stop that could not be checked is a card.
      if (deps.mode() === 'off' || req.trigger !== 'stop') return
      track('failure card', async () => {
        if (!(await deps.eligible(req.sessionId, req.folder))) return
        await file(
          failureDraft({
            sessionId: req.sessionId,
            folder: req.folder,
            reason,
            lane: deps.lane()
          })
        )
      })
    },
    onInspectSuccess(req) {
      if (req.trigger === 'mid-turn') return
      track('failure card close', () => resolve('judge-failure', req.sessionId))
    },
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending])
    }
  }
}
