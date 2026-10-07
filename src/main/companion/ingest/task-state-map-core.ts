/**
 * The map from the Harnu mod's fleet events to the hook vocabulary (T389 P1W5 §7.2). Pure: no
 * I/O, no clock, no Electron. `reduceTaskState` (hook-state.ts) is the one reducer; this file
 * only says which legacy hook each wire event stands for, so the companion and the legacy bridge
 * fold the same shape and every consumer (`claude:hook`, `getTaskStates`, the in-main observers)
 * keeps reading one thing.
 *
 * What the CLI never says, and the map therefore decides (spec §7.2 rules):
 *  - a user "No" and Esc end a turn with no stop hook: `turn.completed` stands for `Stop`;
 *  - only a running SUBAGENT holds a finished main turn; background shells and monitors do not
 *    (no edge ends them, a held `working` would age into a false `stuck`);
 *  - `attention.raised` with `source: 'check'` is record-only (under `dontAsk` and `-p` no dialog
 *    follows, smoke B1.6).
 */

import { classifyFailure, type FailureReason, type TaskState } from '../../hook-state'

/** One wire event as the adapter hands it over (`WireEvent` without the transport fields). */
export interface WireIn {
  t: string
  d: Record<string, unknown>
  agentId?: string
}

export interface MapState {
  /** A main turn started and has not completed. */
  turnActive: boolean
  /** Running subagents, as reported by the mod; untrusted, clamped to [0, COUNT_MAX]. */
  runningSubagents: number
  /** A main turn ended while a subagent ran: the state stays `working` until it does not. */
  heldIdle: boolean
  /** `session.end` was seen: nothing after it is mapped. */
  ended: boolean
}

export interface MappedEvent {
  event: string
  matcher?: string
  /** Only on `StopFailure`. `resetsAt` is left undefined on this path (Q29). */
  failureReason?: FailureReason
  /** Which session the event is for: `prev` only for the old half of a `/clear` pair. */
  sid?: 'prev' | 'cur'
}

export interface MapContext {
  /** The folded task state now, or undefined when none is recorded. */
  current?: TaskState
}

/** The host treats counters as untrusted (§9). */
export const COUNT_MAX = 256

export const initialMapState = (): MapState => ({
  turnActive: false,
  runningSubagents: 0,
  heldIdle: false,
  ended: false
})

export function clampCount(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  return Math.min(COUNT_MAX, Math.max(0, Math.trunc(n)))
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function mapWire(
  state: MapState,
  ev: WireIn,
  ctx: MapContext
): { state: MapState; out: MappedEvent[] } {
  if (state.ended) return { state, out: [] }
  const out: MappedEvent[] = []
  const next: MapState = { ...state }
  const d = ev.d ?? {}

  switch (ev.t) {
    case 'turn.started': {
      if (ev.agentId !== undefined) break
      out.push({ event: 'UserPromptSubmit' })
      next.turnActive = true
      next.heldIdle = false // the next turn clears the hold (D12)
      break
    }
    case 'attention.raised': {
      const kind = str(d.kind)
      const source = str(d.source)
      if (source === 'check') break // record-only (rule 1)
      if (kind === 'permission' && source === 'request') out.push({ event: 'PermissionRequest' })
      else if (kind === 'permission') {
        out.push({ event: 'Notification', matcher: 'permission_prompt' })
      } else if (kind === 'input')
        out.push({ event: 'Notification', matcher: 'elicitation_dialog' })
      else if (kind === 'idle') {
        // `idle_prompt` must not end a hold: the session is not idle while a subagent runs (OQ-a)
        if (!state.heldIdle) out.push({ event: 'Notification', matcher: 'idle_prompt' })
      }
      break
    }
    case 'attention.cleared': {
      const cause = str(d.cause)
      if (cause === 'tool-settled' || cause === 'ask-resolved') out.push({ event: 'PostToolUse' })
      break // `turn-completed` and `prompt`: the turn edge that follows decides
    }
    case 'turn.completed': {
      if (ev.agentId !== undefined) break // a subagent's own completion: P1W6's, not a state edge
      next.turnActive = false
      const held = clampCount(d.backgroundSubagents)
      if (d.reason === 'error') {
        const failure = d.failure as { type?: unknown } | undefined
        out.push({ event: 'StopFailure', failureReason: classifyFailure(failure?.type) })
        next.heldIdle = false
        next.runningSubagents = held
      } else if (held > 0) {
        next.heldIdle = true
        next.runningSubagents = held
      } else {
        out.push({ event: 'Stop' })
        next.heldIdle = false
        next.runningSubagents = 0
      }
      break
    }
    case 'subagent.started': {
      next.runningSubagents = Math.min(COUNT_MAX, state.runningSubagents + 1)
      break
    }
    case 'subagent.stopped': {
      next.runningSubagents = Math.max(0, state.runningSubagents - 1)
      if (next.runningSubagents === 0 && state.heldIdle && !state.turnActive) {
        out.push({ event: 'Stop' })
        next.heldIdle = false
      }
      break
    }
    case 'session.rebound': {
      const cause = str(d.cause)
      if (cause === 'clear') {
        out.push(
          { event: 'SessionEnd', matcher: 'clear', sid: 'prev' },
          { event: 'SessionStart', matcher: 'clear', sid: 'cur' }
        )
      } else if (cause === 'resume') {
        out.push({ event: 'SessionStart', matcher: 'resume', sid: 'cur' })
      } else break // `unknown`: a drift the mod saw; the legacy hooks have no such edge
      next.turnActive = false
      next.runningSubagents = 0
      next.heldIdle = false
      break
    }
    case 'session.end': {
      out.push({ event: 'SessionEnd', matcher: str(d.reason) })
      next.ended = true
      break
    }
    case 'session.snapshot': {
      const active = typeof d.activeTurnId === 'string'
      next.turnActive = active
      next.runningSubagents = clampCount(d.runningSubagents)
      const cur = ctx.current
      if (active) {
        if (cur !== 'working' && cur !== 'needs-input') out.push({ event: 'UserPromptSubmit' })
        next.heldIdle = false
      } else if (next.runningSubagents > 0) {
        // no turn, a subagent running: the main turn ended while it ran, whether or not its
        // completion reached us. Working stays; the last `subagent.stopped` releases it
        if (cur === 'working' || state.heldIdle) next.heldIdle = true
      } else if (state.heldIdle) {
        out.push({ event: 'Stop' })
        next.heldIdle = false
      } else if (cur === 'working') {
        out.push({ event: 'Stop' })
      }
      break
    }
    default:
      break
  }
  return { state: next, out }
}
