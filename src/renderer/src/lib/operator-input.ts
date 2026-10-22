/**
 * "The operator is typing in that terminal" (T564 U6, spec §8.7 step 5, Q7), pure over injected seams.
 *
 * A user turn delivered to a session (a `[harnu-comment]`, a `[harnu-page-event]`) is pasted into its terminal.
 * If the operator typed into the SAME terminal within the last 1500 ms, the paste would interleave with their
 * own keystrokes, so the paste waits until they have been quiet that long — capped, so a terminal the operator
 * leans on forever still gets the message.
 */
export const OPERATOR_TYPING_WINDOW_MS = 1500
export const OPERATOR_QUIET_CAP_MS = 20_000

/**
 * Whether bytes `xterm` handed to `onData` are the operator's keystrokes. The terminal also answers the
 * program's queries through the same callback (focus reports, cursor-position and device-attribute replies),
 * and those are not the operator typing.
 */
export function isOperatorKeystroke(data: string): boolean {
  if (data === '') return false
  /* eslint-disable no-control-regex */
  // Focus in/out reports, cursor position reports, device attributes / status replies, OSC replies.
  if (/^\x1b\[(?:[IO]|\d+;\d+R|[?>=][\d;]*c|\d+(?:;\d+)*c|[?]?\d+(?:;\d+)*n)$/.test(data))
    return false
  if (/^\x1b\](?:.|\n)*?(?:\x07|\x1b\\)$/.test(data)) return false
  if (/^\x1bP(?:.|\n)*?\x1b\\$/.test(data)) return false
  // Mouse reports (xterm mouse tracking): SGR `ESC [ < b ; x ; y M|m` and the legacy `ESC [ M b x y`. Moving or
  // scrolling the pointer over a terminal that asked for them is not typing.
  if (/^(?:\x1b\[<\d+;\d+;\d+[Mm])+$/.test(data)) return false
  if (/^(?:\x1b\[M[\s\S]{3})+$/.test(data)) return false
  /* eslint-enable no-control-regex */
  return true
}

/** How long to wait before pasting: `0` when the operator has been quiet for the whole window. */
export function quietDelayMs(
  lastInputAt: number | null,
  now: number,
  windowMs = OPERATOR_TYPING_WINDOW_MS
): number {
  if (lastInputAt === null) return 0
  return Math.max(0, windowMs - (now - lastInputAt))
}

export interface OperatorInputTracker {
  note(ptyId: string, data: string): void
  lastAt(ptyId: string): number | null
  forget(ptyId: string): void
}

export function createOperatorInputTracker(now: () => number): OperatorInputTracker {
  const last = new Map<string, number>()
  return {
    note(ptyId, data) {
      if (isOperatorKeystroke(data)) last.set(ptyId, now())
    },
    lastAt: (ptyId) => last.get(ptyId) ?? null,
    forget: (ptyId) => void last.delete(ptyId)
  }
}

export interface QuietPasteDeps {
  tracker: OperatorInputTracker
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  /** Paste into the terminal. `false` = the terminal is gone (it died or was parked during the wait). */
  paste(ptyId: string, text: string): boolean
}

/**
 * Paste `text` into `ptyId` once the operator has been quiet in it for the whole window (or the cap hits).
 * Resolves with what `paste` answered, AFTER it ran: a caller that must not claim delivery before the text really
 * went in (a comment is kept as a draft until then) waits for this. A terminal that died during the wait
 * resolves `false`, so nothing is lost.
 */
export function pasteWhenOperatorQuiet(
  deps: QuietPasteDeps,
  ptyId: string,
  text: string
): Promise<boolean> {
  const startedAt = deps.now()
  return new Promise<boolean>((resolve) => {
    const attempt = (): void => {
      const wait = quietDelayMs(deps.tracker.lastAt(ptyId), deps.now())
      if (wait === 0 || deps.now() - startedAt >= OPERATOR_QUIET_CAP_MS) {
        resolve(deps.paste(ptyId, text))
        return
      }
      // +10 ms so the re-check lands just AFTER the window ends rather than on its edge.
      deps.setTimer(attempt, wait + 10)
    }
    attempt()
  })
}

/** The app-wide tracker `TerminalPane` feeds and `command-dispatch` reads. */
export const operatorInput = createOperatorInputTracker(() => Date.now())
