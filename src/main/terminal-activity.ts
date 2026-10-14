/**
 * Terminal activity events, pure core (T474 unit B7, spec §7.3): the live signal behind the pane
 * chip's "reading" / "typing".
 *
 * Every agent read or write of a terminal is reported, but a `send_terminal` stamps the registry
 * once per `pty.write` and an agent can poll a screen several times a second, so the stream is
 * COALESCED: at most one event per terminal per {@link ACTIVITY_WINDOW_MS}. The first call goes
 * out at once (the chip lights up without delay); calls inside the window are folded into ONE
 * trailing event at the window's end, so the last thing that happened is never lost. A write
 * outranks a read within a window.
 *
 * Pure (ADR-0001): the clock and the timer are injected, so the window is deterministic under
 * fake timers. `terminal-ipc.ts` binds the sink to the renderer windows.
 */

/** Minimum gap between two events for one terminal (spec §7.3). */
export const ACTIVITY_WINDOW_MS = 250

export type TerminalActivityKind = 'read' | 'write'

/** What the renderer receives on `terminal:activity`. */
export interface TerminalActivityEvent {
  terminalId: string
  kind: TerminalActivityKind
  /** Epoch ms the event was emitted. */
  at: number
}

export interface ActivityDeps {
  now: () => number
  /** `setTimeout` look-alike; returns a cancel function. */
  startTimer: (fn: () => void, ms: number) => () => void
}

const realDeps: ActivityDeps = {
  now: () => Date.now(),
  startTimer: (fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  }
}

interface Slot {
  /** Epoch ms of the last emitted event. */
  lastEmitAt: number
  /** What is waiting for the window to end, if anything. */
  pending: TerminalActivityKind | null
  cancel: (() => void) | null
}

export class TerminalActivityCoalescer {
  private readonly slots = new Map<string, Slot>()

  constructor(
    private readonly emit: (event: TerminalActivityEvent) => void,
    private readonly deps: ActivityDeps = realDeps
  ) {}

  /** An agent read (or typed into) `terminalId`. */
  note(terminalId: string, kind: TerminalActivityKind): void {
    const now = this.deps.now()
    const slot = this.slots.get(terminalId)
    if (!slot || now - slot.lastEmitAt >= ACTIVITY_WINDOW_MS) {
      // Outside any window: emit now and open one. A trailing event the timer has not delivered
      // yet is superseded by this one.
      slot?.cancel?.()
      this.slots.set(terminalId, { lastEmitAt: now, pending: null, cancel: null })
      this.emit({ terminalId, kind, at: now })
      return
    }
    // Inside the window: fold into the trailing event. A write outranks a read.
    slot.pending = slot.pending === 'write' || kind === 'write' ? 'write' : 'read'
    if (slot.cancel) return
    slot.cancel = this.deps.startTimer(
      () => {
        const at = this.deps.now()
        const kindOut = slot.pending
        slot.cancel = null
        slot.pending = null
        if (kindOut === null) return
        slot.lastEmitAt = at
        this.emit({ terminalId, kind: kindOut, at })
      },
      ACTIVITY_WINDOW_MS - (now - slot.lastEmitAt)
    )
  }

  /** Forget a terminal (it was swept) and cancel its pending event. */
  forget(terminalId: string): void {
    this.slots.get(terminalId)?.cancel?.()
    this.slots.delete(terminalId)
  }

  /** Cancel everything (app shutdown, tests). */
  dispose(): void {
    for (const slot of this.slots.values()) slot.cancel?.()
    this.slots.clear()
  }
}
