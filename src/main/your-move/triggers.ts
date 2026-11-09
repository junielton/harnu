/**
 * What starts an inspection: the hook edges the task-state hub already folds.
 *
 * Nothing here delays or blocks a hook. The observer returns at once; the work runs after a
 * settle delay, long after the bridge answered `200 {}`. With the mode Off, nothing is read:
 * not a transcript, not a directory. Every dependency failure is swallowed here, because an
 * observer that throws would be logged by the hub but a rejected promise would not be.
 */

import type { HookTaskEvent } from '../detect/task-state-hub'
import { advanceCursor, type YourMoveMode } from './core'
import type { InspectOutcome, InspectRequest } from './inspector'
import type { YourMoveStore } from './store'
import type { readFrom } from './transcript'

/** The CLI writes the last reply to the transcript a moment after it fires `Stop`. */
export const STOP_SETTLE_MS = 2_000
/** How many times the transcript is re-read for a reply the hook carried but the file lacks. */
const REREADS = 3
const REREAD_DELAY_MS = 500
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
    if (deps.store.state().cursors[sessionId]) return
    const res = await deps.read(path, { tail: CLASSIFY_TAIL_BYTES })
    if (deps.classify(res.lines) === 'programmatic') return
    const end = res.nextOffset
    await deps.store.transact((s) =>
      s.cursors[sessionId]
        ? { next: s, result: undefined }
        : {
            next: advanceCursor(
              advanceCursor(s, sessionId, 'offset', end, deps.now()),
              sessionId,
              'shadowOffset',
              end,
              deps.now()
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
    if (deps.store.state().cursors[ev.sessionId]) return
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
