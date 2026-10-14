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

/** Lines of raw output a tombstone keeps (spec §8 case 4). */
export const TOMBSTONE_SNAPSHOT_LINES = 200

/** Byte ceiling on the snapshot, so a program that printed one enormous line cannot bloat it. */
const TOMBSTONE_SNAPSHOT_MAX_CHARS = 64 * 1024

/**
 * The last {@link TOMBSTONE_SNAPSHOT_LINES} lines of `raw`, capped in size. Cuts on a line
 * boundary where it can; an over-long single line keeps its tail.
 */
export function tailSnapshot(raw: string): string {
  let text = raw
  let nl = text.length
  for (let i = 0; i < TOMBSTONE_SNAPSHOT_LINES; i++) {
    nl = nl > 0 ? text.lastIndexOf('\n', nl - 1) : -1
    if (nl < 0) break
  }
  if (nl >= 0) text = text.slice(nl + 1)
  return text.length > TOMBSTONE_SNAPSHOT_MAX_CHARS
    ? text.slice(text.length - TOMBSTONE_SNAPSHOT_MAX_CHARS)
    : text
}

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
  /** The operator pressed Disconnect — permanent (spec §6.4). Only {@link TerminalRegistry.disconnect} sets it. */
  disconnected: boolean
  state: TerminalState
  exit?: TerminalExit
  size: { cols: number; rows: number }
  /** Whatever the program set with an OSC 0/2 escape. UNTRUSTED. */
  title: string | null
  createdAt: number
  lastOutputAt: number
  /** Epoch ms of the last `read_terminal` by an agent (spec §4.3); the live signal reads it. */
  lastAgentReadAt: number | null
  /** Epoch ms of the last `send_terminal` that wrote to this terminal (spec §3.2). */
  lastAgentWriteAt: number | null
  /** Epoch ms of the operator's last real keystroke (terminal replies do not count). */
  lastOperatorWriteAt: number | null
  /**
   * A renderer xterm exists for this terminal (spec §5.4). Starts false and flips back to
   * false on `terminal:xtermGone`; unit B3 sets it at the replay handover.
   */
  rendererAttached: boolean
  /**
   * The tail of the raw output, kept once the PTY ends so a pane that mounts after the exit
   * (and a short-lived script's last words) still has something to paint (spec §8 cases 4, 5).
   * Raw stream, not a resolved screen: unit B3 replaces it with the headless model's snapshot.
   */
  finalSnapshot?: string
}

export interface RegisterTerminalInput {
  terminalId: string
  ptyId: string
  folder: string
  origin: TerminalOrigin
  ownerSessionId?: string | null
  size: { cols: number; rows: number }
}

/** Why `writable` is `'off'` (spec §4.2). Present exactly when it is. */
export type WritableReason = 'exited' | 'read-not-enabled' | 'kill-switch'

/** What the caller may do with a terminal right now (spec §6.1). */
export type TerminalAccess =
  | { readable: boolean; writable: 'free' | 'confirm' | 'revoked'; writableReason?: undefined }
  | { readable: boolean; writable: 'off'; writableReason: WritableReason }

/**
 * Per-terminal access, from the registry record plus the two operator prefs that live outside
 * it. `readOptIn` is the folder's `agentTerminalRead` (unit B4); `writesEnabled` is the global
 * kill-switch `agentTerminalWrites` (unit B7). `leaseActive` is whether the operator's write
 * lease on this terminal is live (unit B6): an operator-opened terminal under a lease takes sends
 * with no prompt, so it reads `free` rather than `confirm` (spec §6.1).
 *
 * `free` — a send runs with no prompt. `confirm` — a send raises the operator confirm (unit B6).
 * `revoked` — the operator disconnected it. `off` — writes are not possible right now, and
 * `writableReason` says why.
 */
export function terminalAccess(
  rec: Pick<TerminalRecord, 'origin' | 'disconnected' | 'state'>,
  prefs: { readOptIn: boolean; writesEnabled: boolean; leaseActive?: boolean }
): TerminalAccess {
  if (rec.disconnected) return { readable: false, writable: 'revoked' }
  const readable = rec.origin === 'agent' || prefs.readOptIn
  if (!readable) return { readable, writable: 'off', writableReason: 'read-not-enabled' }
  if (rec.state === 'exited') return { readable, writable: 'off', writableReason: 'exited' }
  if (!prefs.writesEnabled) return { readable, writable: 'off', writableReason: 'kill-switch' }
  return {
    readable,
    writable: rec.origin === 'agent' || prefs.leaseActive === true ? 'free' : 'confirm'
  }
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
  /** Agent-terminal slots promised to a spawn that has not registered yet, per folder. */
  private readonly pending = new Map<string, number>()
  /** Calls in flight that must learn of a Disconnect at once (spec §6.4). */
  private readonly disconnectListeners = new Map<string, Set<() => void>>()
  private readonly activityListeners = new Set<
    (terminalId: string, kind: 'read' | 'write') => void
  >()

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
      lastAgentReadAt: null,
      lastAgentWriteAt: null,
      lastOperatorWriteAt: null,
      rendererAttached: false
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
    this.disconnectListeners.delete(terminalId)
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

  /**
   * Claim one of `max` live-agent-terminal slots in `folder`, synchronously. Spawning a PTY is
   * asynchronous, so counting only registered terminals would let parallel calls all pass the
   * limit before any of them registers; a reservation closes that window. Every successful
   * reserve must be paired with exactly one {@link releaseSlot}.
   */
  reserveSlot(folder: string, max: number): boolean {
    if (this.liveAgentCount(folder) + (this.pending.get(folder) ?? 0) >= max) return false
    this.pending.set(folder, (this.pending.get(folder) ?? 0) + 1)
    return true
  }

  /** Give a reserved slot back (the terminal is now registered, or the spawn failed). */
  releaseSlot(folder: string): void {
    const n = (this.pending.get(folder) ?? 0) - 1
    if (n > 0) this.pending.set(folder, n)
    else this.pending.delete(folder)
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

  /** The PTY ended. Keeps the record as a tombstone, with `snapshot` as its last output. */
  markExited(ptyId: string, code: number | null, snapshot?: string): TerminalRecord | undefined {
    const rec = this.getByPtyId(ptyId)
    if (!rec || rec.state === 'exited') return rec
    rec.state = 'exited'
    if (snapshot !== undefined) rec.finalSnapshot = snapshot
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

  /** An agent read this terminal (spec §4.3). A no-op for an unknown id. */
  noteAgentRead(terminalId: string): void {
    const rec = this.get(terminalId)
    if (!rec) return
    rec.lastAgentReadAt = this.now()
    this.emitActivity(terminalId, 'read')
  }

  /** An agent typed into this terminal (spec §4.4). A no-op for an unknown id. */
  noteAgentWrite(terminalId: string): void {
    const rec = this.get(terminalId)
    if (!rec) return
    rec.lastAgentWriteAt = this.now()
    this.emitActivity(terminalId, 'write')
  }

  /**
   * The operator pressed Disconnect (spec §6.4): permanent, and it stops reads AND writes from
   * here on. Fires the listeners of any call in flight, so a wait ends at once. The PTY is not
   * touched. Returns false for an unknown id; disconnecting twice is a harmless no-op (true).
   */
  disconnect(terminalId: string): boolean {
    const rec = this.get(terminalId)
    if (!rec) return false
    if (rec.disconnected) return true
    rec.disconnected = true
    for (const cb of [...(this.disconnectListeners.get(terminalId) ?? [])]) {
      try {
        cb()
      } catch {
        // A listener that throws must not stop the others from learning of the disconnect.
      }
    }
    this.disconnectListeners.delete(terminalId)
    return true
  }

  /**
   * Call `cb` once when `terminalId` is disconnected. Fires at once if it already is. Returns an
   * unsubscribe, to be called when the call that listened is over.
   */
  onDisconnect(terminalId: string, cb: () => void): () => void {
    const rec = this.byId.get(terminalId)
    if (rec?.disconnected) {
      cb()
      return () => {}
    }
    let set = this.disconnectListeners.get(terminalId)
    if (!set) this.disconnectListeners.set(terminalId, (set = new Set()))
    set.add(cb)
    return () => {
      set.delete(cb)
      if (set.size === 0 && this.disconnectListeners.get(terminalId) === set) {
        this.disconnectListeners.delete(terminalId)
      }
    }
  }

  /** Call `cb` on every agent read or write (the chip's live signal, spec §7.3). */
  onAgentActivity(cb: (terminalId: string, kind: 'read' | 'write') => void): () => void {
    this.activityListeners.add(cb)
    return () => this.activityListeners.delete(cb)
  }

  private emitActivity(terminalId: string, kind: 'read' | 'write'): void {
    for (const cb of this.activityListeners) {
      try {
        cb(terminalId, kind)
      } catch {
        // Activity is a display signal; a broken listener must never fail a verb.
      }
    }
  }

  /** The renderer's xterm for this terminal was disposed (unload / explicit close). */
  setRendererAttached(terminalId: string, attached: boolean): void {
    const rec = this.get(terminalId)
    if (rec) rec.rendererAttached = attached
  }

  /** Live agent-origin terminals — what a reloaded renderer must be told about again. */
  liveAgentTerminals(): TerminalRecord[] {
    return this.list().filter((r) => r.origin === 'agent' && r.state === 'running')
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
