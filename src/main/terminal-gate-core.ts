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
 * B4 owns the READ half. B5 added `TERMINAL_EXITED`. B6 adds `TERMINAL_WRITE_DENIED` (the
 * operator's Deny cooldown) and carries the lease in the state: whether a send needs a confirm is
 * NOT decided here — `planToolCall` promotes or narrows the verdict from `origin` and
 * `leaseActive`. B7 adds `TERMINAL_WRITES_DISABLED`, the global kill-switch, which refuses every
 * send before any confirm, in every mode, for every origin.
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
  | 'TERMINAL_WRITES_DISABLED'
  | 'TERMINAL_READ_NOT_ENABLED'
  | 'TERMINAL_WRITE_DENIED'

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
  /**
   * The operator allowed typing here and the lease has not ended (spec §6.3). Already false for
   * an exited or disconnected terminal: the shell resolves it from the registry state too.
   */
  leaseActive: boolean
  /** The operator denied typing here less than 5 minutes ago (spec §6.3). */
  writeDenied: boolean
  /** The global kill-switch `agentTerminalWrites` (spec §6.5): false refuses every send. */
  writesEnabled: boolean
}

/** What an id the registry does not know resolves to: the gate fails closed on it. */
export const UNKNOWN_TERMINAL: TerminalGateState = {
  known: false,
  isTerminal: false,
  origin: 'operator',
  disconnected: false,
  state: 'running',
  readable: false,
  ownerSessionId: null,
  leaseActive: false,
  writeDenied: false,
  writesEnabled: true
}

/**
 * Resolve the gate state of one terminal from its record and the operator's prefs.
 * `readOptIn` is the folder's `agentTerminalRead`; `writesEnabled` is the global kill-switch
 * `agentTerminalWrites` (spec §6.5). `lease` is what the shell read from the lease table; a lease
 * on a terminal that has exited or been disconnected, or while the kill-switch is off, does not
 * count.
 */
export function resolveTerminalGateState(
  rec: Pick<TerminalRecord, 'origin' | 'disconnected' | 'state' | 'ownerSessionId'> | undefined,
  prefs: { readOptIn: boolean; writesEnabled: boolean },
  lease: { active: boolean; denied: boolean } = { active: false, denied: false }
): TerminalGateState {
  if (!rec) return UNKNOWN_TERMINAL
  return {
    known: true,
    isTerminal: true,
    origin: rec.origin,
    disconnected: rec.disconnected,
    state: rec.state,
    readable: terminalAccess(rec, prefs).readable,
    ownerSessionId: rec.ownerSessionId,
    leaseActive:
      lease.active && !rec.disconnected && rec.state === 'running' && prefs.writesEnabled,
    writeDenied: lease.denied,
    writesEnabled: prefs.writesEnabled
  }
}

/** Why a send stopped before one of its writes: a gate refusal, or one of two live conditions. */
export type WriteStopReason =
  TerminalDenyReason | 'FOLDER_NOT_ALLOWED' | 'DEADLINE_FIRED' | 'TERMINAL_LEASE_ENDED'

/**
 * The one question asked right before EVERY `pty.write` of a send, never earlier and never once
 * per call: can this send still type into the terminal? The plan, the queue wait, the screen
 * barrier and the 50 ms gap after an `Esc` are all real time in which the operator can end,
 * disconnect or block the terminal, or the tool deadline can fire. `null` means go ahead.
 *
 * `rec` is the registry record read just now (`undefined`: it was swept). `ctx` carries what a
 * record cannot say: whether the terminal's folder is blocked right now, whether the tool
 * deadline fired, and the folder's read opt-in. Any further condition on writing (the operator-
 * terminal lease, the kill-switch, Disconnect) belongs HERE, so every write is judged by the same rules.
 * Order: deadline → not found → blocked folder → the gate's own order.
 */
export function canStillWrite(
  rec: Pick<TerminalRecord, 'origin' | 'disconnected' | 'state' | 'ownerSessionId'> | undefined,
  ctx: {
    folderBlocked: boolean
    deadlineFired: boolean
    readOptIn: boolean
    /**
     * The global kill-switch `agentTerminalWrites`, read just now. Judged before EVERY write, so
     * switching typing off stops the next piece of a multi-piece send (an `Esc` and what follows
     * it); a piece already handed to the PTY stays written.
     */
    writesEnabled: boolean
    /**
     * The send rides on the operator's write lease (an operator-opened terminal, or any terminal
     * the plan let through on a lease), and whether that lease is active right now for the PTY
     * that runs this terminal. The lease can end inside the barrier or the Esc gap: a folder
     * block, a read opt-out, the app quitting.
     */
    leaseNeeded: boolean
    leaseActive: boolean
  }
): WriteStopReason | null {
  if (ctx.deadlineFired) return 'DEADLINE_FIRED'
  if (!rec) return 'TERMINAL_NOT_FOUND'
  if (ctx.folderBlocked) return 'FOLDER_NOT_ALLOWED'
  const refusal = gateTerminalOp(
    'send_terminal',
    resolveTerminalGateState(rec, { readOptIn: ctx.readOptIn, writesEnabled: ctx.writesEnabled })
  )
  if (refusal) return refusal
  return ctx.leaseNeeded && !ctx.leaseActive ? 'TERMINAL_LEASE_ENDED' : null
}

/**
 * The flat refusal for `op` against `state`, or `null` to continue. Order (spec §6.2):
 * `TERMINAL_NOT_FOUND` → `NOT_A_TERMINAL` → `TERMINAL_DISCONNECTED` → (writes only)
 * `TERMINAL_EXITED` → (writes only) `TERMINAL_WRITES_DISABLED` → `TERMINAL_READ_NOT_ENABLED` →
 * (writes only) `TERMINAL_WRITE_DENIED`.
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
  // The operator's global switch: a send is refused here, before any confirm, whoever opened the
  // terminal. Reads are unaffected.
  if (writes && !state.writesEnabled) return 'TERMINAL_WRITES_DISABLED'
  if (!state.readable) return 'TERMINAL_READ_NOT_ENABLED'
  // The operator's Deny cooldown (spec §6.3): refused outright, so no new prompt is raised.
  if (writes && state.writeDenied) return 'TERMINAL_WRITE_DENIED'
  return null
}
