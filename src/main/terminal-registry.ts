/**
 * Terminal registry (T474 unit B1): the main-process record of every shell PTY an agent
 * may address as a "terminal". Pure core (ADR-0001): no electron, no node-pty, no fs — the
 * clock is injected, so tombstone expiry is deterministic under fake timers.
 *
 * A terminal is a helper-stack shell pane; its identity (`terminalId`) is the pane id
 * (`h-<uuid>`). The registry is deliberately NOT attached to `PtySessionIndex` and a
 * terminal PTY gets no `sessionKey`: hibernation, `pty:list` and `livePtyDescriptors()` stay
 * blind to it (spec §3.2, F3).
 *
 * A record is created when the PTY is created and outlives it for a {@link TOMBSTONE_MS}
 * tombstone, so an agent can still collect the last output of a script that ended the shell.
 *
 * `ownerSessionId` is attribution, never authorization (spec §3.3): the only writer is
 * {@link TerminalRegistry.rekeyOwner}, driven by the synth→real session migration.
 */

/** How long an exited terminal's record stays addressable (spec §8 case 4). */
export const TOMBSTONE_MS = 10 * 60_000

/** Live agent-origin terminals allowed per folder (spec D7). */
export const MAX_AGENT_TERMINALS_PER_FOLDER = 4

/** Size an agent terminal is spawned at (spec §4.1 step 4). */
export const AGENT_TERMINAL_SIZE = { cols: 120, rows: 30 } as const

/** Longest program-set title kept; anything past it is cut. */
const TITLE_MAX_CHARS = 200

/** Unterminated-OSC carry kept between chunks so a title split across two reads survives. */
const OSC_CARRY_MAX = 512

export type TerminalOrigin = 'agent' | 'operator'
export type TerminalState = 'running' | 'exited'
export type TerminalExitReason = 'natural' | 'closed'

export interface TerminalExit {
  code: number | null
  at: number
  reason: TerminalExitReason
}

export interface TerminalRecord {
  /** Equal to the pane id. */
  terminalId: string
  /** Internal only — never exposed to agents. */
  ptyId: string
  /** Canonical folder path: the gate anchor. */
  folder: string
  /** Who opened it; fail closed to `'operator'`. */
  origin: TerminalOrigin
  /** Attribution only (spec §3.3). */
  ownerSessionId: string | null
  /** The operator pressed Disconnect — permanent (spec §6.4). Set by unit B7; read from B1. */
  disconnected: boolean
  state: TerminalState
  exit?: TerminalExit
  size: { cols: number; rows: number }
  /** Whatever the program set with an OSC 0/2 escape. UNTRUSTED. */
  title: string | null
  createdAt: number
  lastOutputAt: number
  /** Epoch ms of the operator's last real keystroke (terminal replies do not count). */
  lastOperatorWriteAt: number | null
}

export interface RegisterTerminalInput {
  terminalId: string
  ptyId: string
  folder: string
  origin: TerminalOrigin
  ownerSessionId?: string | null
  size: { cols: number; rows: number }
}

/** What the caller may do with a terminal right now (spec §6.1). */
export interface TerminalAccess {
  readable: boolean
  /**
   * `free` — send without asking. `confirm` — send after one operator confirm (unit B6).
   * `revoked` — the operator disconnected it. `off` — writing is not available: the
   * kill-switch is off, the terminal has exited, or it is an operator-opened terminal the
   * folder has not opted in to.
   */
  writable: 'free' | 'confirm' | 'revoked' | 'off'
}

/**
 * Per-terminal access, from the registry record plus the two operator prefs that live outside
 * it. `readOptIn` is the folder's `agentTerminalRead` (unit B4); `writesEnabled` is the global
 * kill-switch `agentTerminalWrites` (unit B7). Until those land the caller passes `false` /
 * `true`, which is exactly their defaults.
 */
export function terminalAccess(
  rec: Pick<TerminalRecord, 'origin' | 'disconnected' | 'state'>,
  prefs: { readOptIn: boolean; writesEnabled: boolean }
): TerminalAccess {
  if (rec.disconnected) return { readable: false, writable: 'revoked' }
  const readable = rec.origin === 'agent' || prefs.readOptIn
  if (!readable) return { readable: false, writable: 'off' }
  if (rec.state === 'exited' || !prefs.writesEnabled) return { readable, writable: 'off' }
  return { readable, writable: rec.origin === 'agent' ? 'free' : 'confirm' }
}

/** Matches one complete terminal-generated reply (see {@link isTerminalReply}). */
const REPLY_UNIT = [
  // CPR `ESC [ r ; c R`, and the DEC-private variant `ESC [ ? r ; c R`.
  String.raw`\x1b\[\??\d+;\d+R`,
  // DSR status reports `ESC [ 0 n` / `ESC [ ? n ; … n`.
  String.raw`\x1b\[\??\d+(?:;\d+)*n`,
  // DA1 / DA2 / DA3 replies.
  String.raw`\x1b\[[?>=][\d;]*c`,
  // DECRPM `ESC [ ? Ps ; Pm $ y` (and the ANSI-mode form without `?`).
  String.raw`\x1b\[\??\d+;\d+\$y`,
  // XTWINOPS size/position reports `ESC [ 8 ; r ; c t`.
  String.raw`\x1b\[\d+(?:;\d+)+t`,
  // Focus in / out.
  String.raw`\x1b\[[IO]`,
  // DCS reply, terminated by ST (`ESC \`).
  String.raw`\x1bP[^\x1b\x07]*\x1b\\`,
  // OSC reply, terminated by BEL or ST.
  String.raw`\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)`
].join('|')

// eslint-disable-next-line no-control-regex
const WHOLLY_REPLY_RE = new RegExp(`^(?:${REPLY_UNIT})+$`)

/**
 * True when `data` is wholly one or more terminal-generated replies (CPR, DSR, DA1/DA2,
 * DECRPM, focus, DCS/OSC reply) — what an xterm writes back to the PTY by itself when the
 * program asks a question. Such a write is not the operator typing and must not stamp
 * `lastOperatorWriteAt`. A mixed payload (a reply glued to a real key) counts as typing.
 */
export function isTerminalReply(data: string): boolean {
  return data.length > 0 && WHOLLY_REPLY_RE.test(data)
}

// eslint-disable-next-line no-control-regex
const OSC_TITLE_RE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const OSC_OPEN_RE = /\x1b\][02];[^\x07\x1b]*$/

/** The last OSC 0/2 title in `text`, plus any unterminated tail worth carrying forward. */
function scanTitle(text: string): { title: string | null; carry: string } {
  let title: string | null = null
  for (const m of text.matchAll(OSC_TITLE_RE)) title = m[1] ?? ''
  const open = OSC_OPEN_RE.exec(text)
  const carry = open && open[0].length <= OSC_CARRY_MAX ? open[0] : ''
  return { title, carry }
}

export class TerminalRegistry {
  private readonly byId = new Map<string, TerminalRecord>()
  private readonly byPty = new Map<string, string>()
  /** `destroy` was requested for these ptyIds before the kill (spec §3.2, R19). */
  private readonly closing = new Set<string>()
  private readonly oscCarry = new Map<string, string>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Insert a record for a freshly created PTY. */
  register(input: RegisterTerminalInput): TerminalRecord {
    const at = this.now()
    const rec: TerminalRecord = {
      terminalId: input.terminalId,
      ptyId: input.ptyId,
      folder: input.folder,
      origin: input.origin === 'agent' ? 'agent' : 'operator',
      ownerSessionId: input.ownerSessionId ?? null,
      disconnected: false,
      state: 'running',
      size: { ...input.size },
      title: null,
      createdAt: at,
      lastOutputAt: at,
      lastOperatorWriteAt: null
    }
    this.byId.set(rec.terminalId, rec)
    this.byPty.set(rec.ptyId, rec.terminalId)
    return rec
  }

  /** Drop a record outright — the rollback path, no tombstone. */
  forget(terminalId: string): void {
    const rec = this.byId.get(terminalId)
    if (!rec) return
    this.byId.delete(terminalId)
    this.byPty.delete(rec.ptyId)
    this.closing.delete(rec.ptyId)
    this.oscCarry.delete(rec.ptyId)
  }

  /** Drop tombstones past their window. Called by every read so no timer is needed. */
  private sweep(): void {
    const cutoff = this.now() - TOMBSTONE_MS
    for (const rec of [...this.byId.values()]) {
      if (rec.state === 'exited' && rec.exit && rec.exit.at <= cutoff) this.forget(rec.terminalId)
    }
  }

  get(terminalId: string): TerminalRecord | undefined {
    this.sweep()
    return this.byId.get(terminalId)
  }

  getByPtyId(ptyId: string): TerminalRecord | undefined {
    const id = this.byPty.get(ptyId)
    return id === undefined ? undefined : this.get(id)
  }

  /** Cheap membership test for the `pty:write` hot path (no sweep, no allocation). */
  hasPty(ptyId: string): boolean {
    return this.byPty.has(ptyId)
  }

  list(): TerminalRecord[] {
    this.sweep()
    return [...this.byId.values()]
  }

  /** Live (not exited) agent-origin terminals in `folder` — what `TERMINAL_LIMIT` counts. */
  liveAgentCount(folder: string): number {
    this.sweep()
    let n = 0
    for (const r of this.byId.values()) {
      if (r.origin === 'agent' && r.state === 'running' && r.folder === folder) n++
    }
    return n
  }

  /** Every terminal a session owns, in creation order. */
  ownedBy(sessionId: string): TerminalRecord[] {
    return this.list().filter((r) => r.ownerSessionId === sessionId)
  }

  /**
   * `pty:destroy` is about to kill this PTY: the exit that follows is `closed`, not
   * `natural`. Must run BEFORE `kill()`.
   */
  markClosing(ptyId: string): void {
    if (this.byPty.has(ptyId)) this.closing.add(ptyId)
  }

  /** The PTY ended. Keeps the record as a tombstone. */
  markExited(ptyId: string, code: number | null): TerminalRecord | undefined {
    const rec = this.getByPtyId(ptyId)
    if (!rec || rec.state === 'exited') return rec
    rec.state = 'exited'
    rec.exit = {
      code,
      at: this.now(),
      reason: this.closing.has(ptyId) ? 'closed' : 'natural'
    }
    this.closing.delete(ptyId)
    this.oscCarry.delete(ptyId)
    return rec
  }

  /** Bytes came out of the PTY: stamps `lastOutputAt` and tracks the program's title. */
  noteOutput(ptyId: string, data: string): void {
    const id = this.byPty.get(ptyId)
    const rec = id === undefined ? undefined : this.byId.get(id)
    if (!rec) return
    rec.lastOutputAt = this.now()
    // Cheap exit: no escape introducer in the chunk and nothing pending.
    const carry = this.oscCarry.get(ptyId) ?? ''
    if (!carry && !data.includes('\x1b]')) return
    const { title, carry: nextCarry } = scanTitle(carry + data)
    if (title !== null) rec.title = title.slice(0, TITLE_MAX_CHARS)
    if (nextCarry) this.oscCarry.set(ptyId, nextCarry)
    else this.oscCarry.delete(ptyId)
  }

  noteResize(ptyId: string, cols: number, rows: number): void {
    const rec = this.getByPtyId(ptyId)
    if (rec) rec.size = { cols, rows }
  }

  /**
   * The operator's keystrokes reached this PTY. Stamps `lastOperatorWriteAt` unless the
   * payload is wholly a terminal reply (the pane's xterm answering a query is not the
   * operator typing). Returns whether it stamped. A no-op for an unregistered PTY.
   */
  noteOperatorWrite(ptyId: string, data: string): boolean {
    const rec = this.getByPtyId(ptyId)
    if (!rec || isTerminalReply(data)) return false
    rec.lastOperatorWriteAt = this.now()
    return true
  }

  /**
   * A session key migrated from synthetic to real: every terminal that named the synthetic id
   * now names the real one, so the chip does not turn into "closed session" once the
   * transcript lands. The ONLY writer of `ownerSessionId` after register (spec §3.3).
   */
  rekeyOwner(fromSessionId: string, toSessionId: string): number {
    let n = 0
    for (const rec of this.byId.values()) {
      if (rec.ownerSessionId === fromSessionId) {
        rec.ownerSessionId = toSessionId
        n++
      }
    }
    return n
  }
}

/** The app-wide registry. */
export const terminalRegistry = new TerminalRegistry()
