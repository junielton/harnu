/**
 * Delivering a page event to a session (T564 U2, spec §5.4 and §8.7), pure over injected seams (ADR-0001).
 *
 * The door is the USER-TURN path, not `message_session`: an event is data a page produced because the operator
 * clicked it, and `message_session` refuses operator-owned sessions by design. The renderer resolves the PTY and
 * calls `pasteAndSubmit` (the function `MarkdownPane.deliver()` uses for `[harnu-lesson]`); main only picks the
 * destination, wakes a parked recipient headlessly when it must, and holds the event when there is nowhere to
 * send it.
 */
import { MAX_HELD_EVENTS } from './emit-gate'

/** What the renderer's `session.userTurn` handler answers. */
export type UserTurnAck =
  | { delivered: true; sessionId: string }
  /** The destination exists but has no live PTY (a parked session): wake it, then ask again. */
  | { parked: true; sessionId: string }
  /** Neither the owner nor a selected session of the folder: nothing to send to. */
  | { held: true }

export interface UserTurnPayload {
  /** The owner session (attribution), or `null` for "the folder's selected session". */
  sessionId: string | null
  folder: string
  text: string
  source: 'page-event' | 'overlay'
}

export interface DeliveryDeps {
  dispatch(command: string, payload: unknown): Promise<unknown>
  waitForSessionReady(sessionId: string, timeoutMs: number): Promise<boolean>
  /** Wait `ms` (injected so the retry is testable); defaults to a real timer. */
  delay?(ms: number): Promise<void>
}

/**
 * After a wake, `pty:sessionReady` can land a beat BEFORE the renderer's terminal cache holds the new PTY (found
 * in the T569 live run), so the first re-ask may still answer `parked`. Ask again for a bounded time.
 */
export const AFTER_WAKE_RETRIES = 12
export const AFTER_WAKE_RETRY_MS = 250

/** A headless wake plus the CLI's own readiness; a long transcript's resume outlives the bridge deadline. */
export const WAKE_READY_TIMEOUT_MS = 40_000

export type DeliveryOutcome =
  | { status: 'delivered'; sessionId: string; woke: boolean }
  | { status: 'held' }
  | { status: 'failed'; reason: string }

function asAck(value: unknown): UserTurnAck | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (v.delivered === true && typeof v.sessionId === 'string') {
    return { delivered: true, sessionId: v.sessionId }
  }
  if (v.parked === true && typeof v.sessionId === 'string') {
    return { parked: true, sessionId: v.sessionId }
  }
  if (v.held === true) return { held: true }
  return null
}

export async function deliverUserTurn(
  deps: DeliveryDeps,
  turn: UserTurnPayload
): Promise<DeliveryOutcome> {
  const ack = asAck(await deps.dispatch('session.userTurn', turn).catch(() => null))
  if (ack === null) return { status: 'failed', reason: 'the renderer did not answer' }
  if ('parked' in ack) {
    // Headless wake (spec §8.7 step 6): it never selects the session, so it cannot move the operator's view.
    const woke = await deps.dispatch('session.wake', { sessionId: ack.sessionId }).catch(() => null)
    if (woke === null || (typeof woke === 'object' && 'error' in (woke as object))) {
      return { status: 'failed', reason: 'the parked session could not be woken' }
    }
    if (!(await deps.waitForSessionReady(ack.sessionId, WAKE_READY_TIMEOUT_MS))) {
      return { status: 'failed', reason: 'the parked session did not come up in time' }
    }
    const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const sessionId = ack.sessionId
    for (let attempt = 0; attempt < AFTER_WAKE_RETRIES; attempt++) {
      const again = asAck(
        await deps.dispatch('session.userTurn', { ...turn, sessionId }).catch(() => null)
      )
      if (again !== null && 'delivered' in again) {
        return { status: 'delivered', sessionId: again.sessionId, woke: true }
      }
      if (again === null || 'held' in again) break
      await delay(AFTER_WAKE_RETRY_MS)
    }
    return { status: 'failed', reason: 'the woken session did not take the message' }
  }
  if ('held' in ack) return { status: 'held' }
  return { status: 'delivered', sessionId: ack.sessionId, woke: false }
}

/** Events no session could take, kept per pane (bounded; the pin tray proper arrives with the overlay unit). */
export interface HeldEvents {
  hold(paneId: string, text: string): number
  count(paneId: string): number
  take(paneId: string): string[]
  forget(paneId: string): void
}

export function createHeldEvents(max = MAX_HELD_EVENTS): HeldEvents {
  const held = new Map<string, string[]>()
  return {
    hold(paneId, text) {
      const list = held.get(paneId) ?? []
      list.push(text)
      while (list.length > max) list.shift()
      held.set(paneId, list)
      return list.length
    },
    count: (paneId) => held.get(paneId)?.length ?? 0,
    take(paneId) {
      const list = held.get(paneId) ?? []
      held.delete(paneId)
      return list
    },
    forget: (paneId) => void held.delete(paneId)
  }
}
