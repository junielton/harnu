/**
 * The live word of the agent connection chip (T474 U1, spec §7.3): `reading` or `typing`, or
 * nothing. Main sends one coalesced `terminal:activity` per 250 ms; this turns that stream into
 * a word that does not flicker.
 *
 * The rules, all from the spec:
 *  - a word clears {@link CLEAR_AFTER_MS} after the LAST event;
 *  - `write` outranks `read`: a word of `typing` is held for at least {@link MIN_HOLD_MS} after
 *    the last write even if reads keep arriving, so a burst of `send` + `read` polling reads as
 *    "typing", not as a strobe between the two.
 *
 * Pure (ADR-0001 spirit): the clock and the timer are injected, so the timing is deterministic
 * under fake timers and the store only wraps the result in a ref.
 */

export type ActivityKind = 'read' | 'write'
export type LiveWord = 'reading' | 'typing' | null

/** `typing` is held at least this long after the last write. */
export const MIN_HOLD_MS = 1200
/** The word clears this long after the last event. */
export const CLEAR_AFTER_MS = 3000

interface Slot {
  lastEventAt: number
  lastWriteAt: number | null
  lastKind: ActivityKind
  word: LiveWord
  cancel: (() => void) | null
}

export interface TrackerDeps {
  now: () => number
  /** `setTimeout` look-alike; returns a cancel function. */
  startTimer: (fn: () => void, ms: number) => () => void
}

const realDeps: TrackerDeps = {
  now: () => Date.now(),
  startTimer: (fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  }
}

/** The word a slot shows at `now`. */
export function wordAt(
  slot: Pick<Slot, 'lastEventAt' | 'lastWriteAt' | 'lastKind'>,
  now: number
): LiveWord {
  if (now - slot.lastEventAt >= CLEAR_AFTER_MS) return null
  if (
    slot.lastWriteAt !== null &&
    (slot.lastKind === 'write' || now - slot.lastWriteAt < MIN_HOLD_MS)
  ) {
    return 'typing'
  }
  return 'reading'
}

export class LiveWordTracker {
  private readonly slots = new Map<string, Slot>()

  constructor(
    private readonly onChange: (terminalId: string, word: LiveWord) => void,
    private readonly deps: TrackerDeps = realDeps
  ) {}

  /** An agent read or typed into `terminalId`. */
  note(terminalId: string, kind: ActivityKind): void {
    const now = this.deps.now()
    const prev = this.slots.get(terminalId)
    const slot: Slot = prev ?? {
      lastEventAt: now,
      lastWriteAt: null,
      lastKind: kind,
      word: null,
      cancel: null
    }
    slot.lastEventAt = now
    slot.lastKind = kind
    if (kind === 'write') slot.lastWriteAt = now
    this.slots.set(terminalId, slot)
    this.refresh(terminalId, slot)
  }

  /** The word `terminalId` shows right now. */
  word(terminalId: string): LiveWord {
    const slot = this.slots.get(terminalId)
    return slot ? wordAt(slot, this.deps.now()) : null
  }

  /** Forget a terminal (its pane is gone, or it was disconnected). */
  forget(terminalId: string): void {
    const slot = this.slots.get(terminalId)
    slot?.cancel?.()
    this.slots.delete(terminalId)
    if (slot && slot.word !== null) this.onChange(terminalId, null)
  }

  dispose(): void {
    for (const slot of this.slots.values()) slot.cancel?.()
    this.slots.clear()
  }

  /** Recompute the word, tell the store if it changed, and arm the next boundary. */
  private refresh(terminalId: string, slot: Slot): void {
    slot.cancel?.()
    slot.cancel = null
    const now = this.deps.now()
    const word = wordAt(slot, now)
    if (word !== slot.word) {
      slot.word = word
      this.onChange(terminalId, word)
    }
    if (word === null) {
      this.slots.delete(terminalId)
      return
    }
    // The next moment the word can change: the typing hold ending, or the clear.
    const untilClear = slot.lastEventAt + CLEAR_AFTER_MS - now
    const untilHoldEnds =
      word === 'typing' && slot.lastWriteAt !== null && slot.lastKind !== 'write'
        ? slot.lastWriteAt + MIN_HOLD_MS - now
        : Infinity
    const wait = Math.max(1, Math.min(untilClear, untilHoldEnds))
    slot.cancel = this.deps.startTimer(() => {
      slot.cancel = null
      this.refresh(terminalId, slot)
    }, wait)
  }
}
