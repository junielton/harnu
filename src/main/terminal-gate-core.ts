/**
 * Terminal gate, pure core (T474 unit B4): what an agent may do with a terminal, decided at
 * PLAN level, before any confirm is raised (spec §6.2).
 *
 * The rules cannot live in the verb handler. In `ask` mode a mutating call raises its confirm
 * before the handler runs, so a refusal there would first prompt the operator and only then
 * refuse. This module is called by `planToolCall` with a {@link TerminalGateState} that
 * `server.ts` resolved from the registry and the operator's prefs; it returns either a flat
 * refusal or `null` (continue). The explicit folder block and `SERVER_DISABLED` outrank it —
 * `planToolCall` only asks once those have passed.
 *
 * B4 owns the READ half. B5 adds the first write refusals: `TERMINAL_EXITED`, and — for now —
 * `TERMINAL_WRITE_NOT_ENABLED` on every terminal an agent did not open itself. The operator-
 * terminal path (confirm once → lease, `TERMINAL_WRITE_DENIED`) is unit B6, which retires that
 * transitional code; `TERMINAL_WRITES_DISABLED` is the kill-switch of unit B7.
 *
 * Pure (ADR-0001): no electron, no fs, no clock.
 */
import { terminalAccess, type TerminalRecord } from './terminal-registry'

/** The refusals this core can return, in the order it checks them. */
export type TerminalDenyReason =
  | 'TERMINAL_NOT_FOUND'
  | 'NOT_A_TERMINAL'
  | 'TERMINAL_DISCONNECTED'
  | 'TERMINAL_EXITED'
  | 'TERMINAL_READ_NOT_ENABLED'
  | 'TERMINAL_WRITE_NOT_ENABLED'

/** Verbs that address one terminal by id and therefore pass this gate. */
const GATED_OPS: ReadonlySet<string> = new Set(['read_terminal', 'send_terminal'])

/** The gated verbs that type into the terminal (the rest only look). */
const WRITE_OPS: ReadonlySet<string> = new Set(['send_terminal'])

/** Whether `op` is a verb this gate speaks for. */
export function isTerminalGatedOp(op: string): boolean {
  return GATED_OPS.has(op)
}

/**
 * The slice of terminal state the gate decides from. Resolved by the shell BEFORE planning, so
 * the plan stays a pure function of its input.
 */
export interface TerminalGateState {
  /** The registry has a record for the id. */
  known: boolean
  /** That record is a terminal (not some other pane). The registry only holds terminals. */
  isTerminal: boolean
  origin: TerminalRecord['origin']
  disconnected: boolean
  state: TerminalRecord['state']
  /** `terminalAccess(...).readable`: agent-spawned, or operator-opened in an opted-in folder. */
  readable: boolean
  /** Who the terminal is connected to — attribution for the audit line, never authority. */
  ownerSessionId: string | null
}

/** What an id the registry does not know resolves to: the gate fails closed on it. */
export const UNKNOWN_TERMINAL: TerminalGateState = {
  known: false,
  isTerminal: false,
  origin: 'operator',
  disconnected: false,
  state: 'running',
  readable: false,
  ownerSessionId: null
}

/**
 * Resolve the gate state of one terminal from its record and the operator's prefs.
 * `readOptIn` is the folder's `agentTerminalRead`; `writesEnabled` is the global kill-switch
 * (unit B7 — until it lands the caller passes `true`, its default).
 */
export function resolveTerminalGateState(
  rec: Pick<TerminalRecord, 'origin' | 'disconnected' | 'state' | 'ownerSessionId'> | undefined,
  prefs: { readOptIn: boolean; writesEnabled: boolean }
): TerminalGateState {
  if (!rec) return UNKNOWN_TERMINAL
  return {
    known: true,
    isTerminal: true,
    origin: rec.origin,
    disconnected: rec.disconnected,
    state: rec.state,
    readable: terminalAccess(rec, prefs).readable,
    ownerSessionId: rec.ownerSessionId
  }
}

/**
 * The flat refusal for `op` against `state`, or `null` to continue. Order (spec §6.2):
 * `TERMINAL_NOT_FOUND` → `NOT_A_TERMINAL` → `TERMINAL_DISCONNECTED` → (writes only)
 * `TERMINAL_EXITED` → `TERMINAL_READ_NOT_ENABLED` → (writes only) `TERMINAL_WRITE_NOT_ENABLED`.
 * A disconnected terminal is refused as disconnected even when its folder opt-in is off: the
 * operator's Disconnect is the more specific fact. An exited terminal stays readable for its
 * tombstone window but nothing can be typed into it.
 */
export function gateTerminalOp(op: string, state: TerminalGateState): TerminalDenyReason | null {
  if (!isTerminalGatedOp(op)) return null
  if (!state.known) return 'TERMINAL_NOT_FOUND'
  if (!state.isTerminal) return 'NOT_A_TERMINAL'
  if (state.disconnected) return 'TERMINAL_DISCONNECTED'
  const writes = WRITE_OPS.has(op)
  if (writes && state.state === 'exited') return 'TERMINAL_EXITED'
  if (!state.readable) return 'TERMINAL_READ_NOT_ENABLED'
  // B5: only a terminal the agent opened itself can be typed into. B6 opens the rest.
  if (writes && state.origin !== 'agent') return 'TERMINAL_WRITE_NOT_ENABLED'
  return null
}
