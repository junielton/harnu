/**
 * `send_terminal`'s `waitFor`, pure (T489 unit B8, spec §4.4): decides WHEN a send returns, and
 * what text a pattern is allowed to match.
 *
 * The first of these to fire wins and is reported as `wait.reason`:
 * `pattern` (the regex matched the {@link matchSurface}), `idle` (no output for `idleMs`, counted
 * from the last byte of the send), `timeout` (a hard stop, not an error), `exited`, `disconnected`
 * (the operator pressed Disconnect, spec §6.4).
 *
 * What keeps it honest:
 *  - **No echo match.** The shell echoes what was typed, so `grep failed log` + `pattern: "failed"`
 *    would match at once. {@link matchSurface} starts at the cursor's column when the send was
 *    made and skips a leading verbatim echo of `input`; the returned `output` keeps the echo.
 *  - **Bounded matching.** The pattern is ≤ {@link PATTERN_MAX_CHARS} chars with flags fixed to
 *    `m`, the matcher sees at most {@link MATCH_MAX_BYTES} of text and runs at most every
 *    {@link MATCH_INTERVAL_MS}. Catastrophic backtracking is bounded by a per-run time budget
 *    ({@link MATCH_BUDGET_MS}, `node:vm` terminates a run that exceeds it), not by guessing at
 *    which patterns are dangerous; a pattern that blows the budget is switched off for the call
 *    (`wait.patternDisabled`) and the wait carries on with idle / timeout.
 *  - **Never ahead of the data.** `idle` and `exited` are only declared after the matcher has run
 *    on a surface read at or after the last output, so a match in the final bytes is never lost
 *    to an `idle`.
 *
 * Pure of electron and node-pty (ADR-0001): the clock, the timer and the screen are injected.
 */
import * as vm from 'node:vm'

/** Longest regex source accepted (spec §4.4). */
export const PATTERN_MAX_CHARS = 200
/** The matcher never sees more text than this (spec §4.4). */
export const MATCH_MAX_BYTES = 64 * 1024
/** The matcher never runs more often than this (spec §4.4). */
export const MATCH_INTERVAL_MS = 100
/** Longest one matcher run may take before the pattern is switched off (ReDoS guard). */
export const MATCH_BUDGET_MS = 50
/** Wait bounds (spec §4.4). */
export const IDLE_MIN_MS = 50
export const IDLE_MAX_MS = 30_000
export const TIMEOUT_MIN_MS = 100
export const TIMEOUT_MAX_MS = 90_000
export const TIMEOUT_DEFAULT_MS = 15_000
/** `wait.match` is cut to this many characters (a `.*` could otherwise echo a whole screen). */
export const MATCH_TEXT_MAX_CHARS = 2000

/** The longest the loop sleeps between looks. */
const TICK_MS = 50

export type WaitReason = 'pattern' | 'idle' | 'timeout' | 'exited' | 'disconnected'

export interface WaitSpec {
  pattern?: string
  idleMs?: number
  timeoutMs?: number
}

export interface WaitResult {
  reason: WaitReason
  waitedMs: number
  /** The matched text, UNSCRUBBED — the caller scrubs it on the way out. `pattern` only. */
  match?: string
  /** The pattern blew the per-run budget and was switched off; the wait ended on something else. */
  patternDisabled?: true
}

export type WaitPatternError = { ok: false; detail: string }

/**
 * Compile a `waitFor.pattern`: ≤ 200 chars, flags fixed to `m`, and not one that matches the empty
 * string (it would fire on the first look, whatever the program printed).
 */
export function compileWaitPattern(source: string): { ok: true; re: RegExp } | WaitPatternError {
  if (source.length === 0) {
    return { ok: false, detail: 'pattern is empty; give the text you expect the program to print.' }
  }
  if (source.length > PATTERN_MAX_CHARS) {
    return {
      ok: false,
      detail: `pattern is ${source.length} characters; the limit is ${PATTERN_MAX_CHARS}. Match a shorter, distinctive part of the line.`
    }
  }
  let re: RegExp
  try {
    re = new RegExp(source, 'm')
  } catch (err) {
    return {
      ok: false,
      detail: `pattern does not compile as a JavaScript regular expression: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (re.test('')) {
    return {
      ok: false,
      detail:
        'pattern matches the empty string, so it would fire at once. Anchor it on text the program prints.'
    }
  }
  return { ok: true, re }
}

/** The shape a caller validates a whole `waitFor` against, before anything is typed. */
export function checkWaitFor(waitFor: WaitSpec | undefined): WaitPatternError | null {
  if (waitFor?.pattern === undefined) return null
  const compiled = compileWaitPattern(waitFor.pattern)
  return compiled.ok ? null : compiled
}

/** One regex run under a wall-clock budget. `null` = no match, `'timeout'` = budget blown. */
export type MatchExec = (re: RegExp, text: string) => RegExpExecArray | null | 'timeout'

let sandbox: vm.Context | undefined
let execScript: vm.Script | undefined

/**
 * The real matcher: `re.exec(text)` inside a `node:vm` run with a {@link MATCH_BUDGET_MS} timeout.
 * V8 checks for the termination request while backtracking, so a catastrophic pattern is cut
 * instead of freezing main. The regex and the text are only DATA to a fixed script.
 */
export const vmExec: MatchExec = (re, text) => {
  sandbox ??= vm.createContext({ re: null, text: '' })
  execScript ??= new vm.Script('re.exec(text)')
  const ctx = sandbox as { re: RegExp | null; text: string }
  ctx.re = re
  ctx.text = text
  re.lastIndex = 0
  try {
    return execScript.runInContext(sandbox, { timeout: MATCH_BUDGET_MS }) as RegExpExecArray | null
  } catch {
    return 'timeout'
  } finally {
    ctx.re = null
    ctx.text = ''
  }
}

/**
 * What the pattern is matched against (spec §4.4, steps 2–4). `text` is the resolved text from the
 * row the send started on; `offset` is how far into its first line the cursor was (so the prompt,
 * which the shell printed BEFORE the send, is not matched; 0 when the text does not start on the
 * cursor row); `input` is what was typed. The echo of `input` is skipped (see {@link skipEcho}) and
 * the result is cut to its last {@link MATCH_MAX_BYTES}.
 */
export function matchSurface(text: string, offset: number, input: string | undefined): string {
  const surface = input
    ? skipEcho(text, offset, input)
    : text.slice(Math.min(Math.max(0, offset), text.length))
  return tailBytes(surface)
}

/** The last {@link MATCH_MAX_BYTES} of `text` (the newest output); a cut inside a character yields U+FFFD. */
export function tailBytes(text: string): string {
  if (text.length * 3 <= MATCH_MAX_BYTES || Buffer.byteLength(text, 'utf8') <= MATCH_MAX_BYTES) {
    return text
  }
  return Buffer.from(text, 'utf8').subarray(-MATCH_MAX_BYTES).toString('utf8')
}

/** A line prefix (a prompt) beyond the cursor offset that is still read as "the prompt". */
const PROMPT_SLACK_CHARS = 8

/**
 * Drop the shell's echo of `input` from the front of `text`.
 *
 * A shell does not echo verbatim at one fixed place: with a plain prompt the typed line is
 * `prompt + input`; with a transient prompt (powerlevel10k, fish) the prompt block is erased and
 * the command is printed again — on the row the block started on, and sometimes twice. So the echo
 * is recognised by its SHAPE: leading lines that are blank, or that are `<short prompt><a typed
 * line>`, are all echo. The first line that is neither is the program's. If no line looks like an
 * echo (a password typed with echo off, or an echo that has not arrived yet) the prompt in front of
 * the cursor is cut instead, and a first line that is still an unfinished echo gives nothing yet.
 */
export function skipEcho(text: string, offset: number, input: string): string {
  const typed = [
    ...new Set(
      input
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
    )
  ]
  const lines = text.split('\n')
  const maxPrompt = Math.max(0, offset) + PROMPT_SLACK_CHARS
  let i = 0
  let sawEcho = false
  for (; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    if (typed.some((t) => isEchoLine(line, t, maxPrompt))) {
      sawEcho = true
      continue
    }
    break
  }
  if (sawEcho) {
    // An unfinished echo on the last line (still arriving) is echo too.
    if (i === lines.length - 1 && typed.some((t) => isPartialEcho(lines[i]!, t, maxPrompt))) {
      return ''
    }
    return lines.slice(i).join('\n')
  }
  // No echo line. The first line is either the prompt waiting for its echo, or output with the
  // prompt in front of the cursor to cut away.
  const first = lines[0] ?? ''
  const rest = first.slice(Math.min(Math.max(0, offset), first.length))
  if (lines.length === 1 && typed.some((t) => isPartialEcho(rest, t, 0))) return ''
  return [rest, ...lines.slice(1)].join('\n')
}

/** `<a short prompt>` + `typed` and nothing after it. */
function isEchoLine(line: string, typed: string, maxPrompt: number): boolean {
  const body = line.trimEnd()
  return body.endsWith(typed) && body.length - typed.length <= maxPrompt
}

/** The unterminated last line holds a prompt and the first part of `typed`. */
function isPartialEcho(line: string, typed: string, maxPrompt: number): boolean {
  const body = line.trimEnd()
  if (body === '') return true
  for (let k = 0; k <= Math.min(maxPrompt, body.length - 1); k++) {
    if (typed.startsWith(body.slice(k))) return true
  }
  return false
}

export interface WaitIo {
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Epoch ms of the last byte written to the PTY by this send. */
  sentAt: number
  /** Epoch ms of the last output byte the PTY produced (the registry stamps it on arrival). */
  lastOutputAt: () => number
  /** The PTY ended. */
  hasExited: () => boolean
  /**
   * The match surface, UNSCRUBBED, read after the §5.1 barrier. `budgetMs` is how long the barrier
   * may wait, so a stalled model cannot push the call past its deadline.
   */
  surface: (budgetMs: number) => Promise<string>
  /** The operator pressed Disconnect: `is()` is polled, `wake()` cuts a sleep short. */
  abort?: { is: () => boolean; wake: () => Promise<void> }
  /** Test seam: the matcher. */
  exec?: MatchExec
}

/**
 * Wait for the first of pattern / idle / timeout / exit / disconnect (spec §4.4). `spec.pattern`
 * must already have passed {@link compileWaitPattern}.
 */
export async function waitForOutput(io: WaitIo, spec: WaitSpec): Promise<WaitResult> {
  const started = io.now()
  const timeoutMs = spec.timeoutMs ?? TIMEOUT_DEFAULT_MS
  const deadline = started + timeoutMs
  const exec = io.exec ?? vmExec
  const compiled = spec.pattern === undefined ? null : compileWaitPattern(spec.pattern)
  const re = compiled?.ok ? compiled.re : null
  let disabled = false
  // When the matcher last STARTED a run (its surface was read after this), and the output stamp
  // it has seen. `null` = it has not run yet.
  let lastRunAt: number | null = null
  const finish = (r: Omit<WaitResult, 'waitedMs'>): WaitResult => ({
    ...r,
    waitedMs: io.now() - started,
    ...(disabled ? { patternDisabled: true as const } : {})
  })

  /** Run the matcher if it is allowed to. Returns the match, or null. */
  const tryMatch = async (): Promise<string | null> => {
    if (!re || disabled) return null
    lastRunAt = io.now()
    const text = tailBytes(await io.surface(Math.max(50, deadline - io.now())))
    const m = exec(re, text)
    if (m === 'timeout') {
      disabled = true
      return null
    }
    return m === null ? null : m[0].slice(0, MATCH_TEXT_MAX_CHARS)
  }
  const dueToRun = (): boolean => {
    if (!re || disabled) return false
    if (lastRunAt === null) return true
    return io.now() - lastRunAt >= MATCH_INTERVAL_MS && io.lastOutputAt() >= lastRunAt
  }
  /** The matcher has looked at everything the program has printed so far. */
  const current = (): boolean =>
    !re || disabled || (lastRunAt !== null && io.lastOutputAt() < lastRunAt)

  for (;;) {
    if (io.abort?.is()) return finish({ reason: 'disconnected' })
    if (dueToRun()) {
      const raced = io.abort
        ? await Promise.race([tryMatch(), io.abort.wake().then(() => 'abort' as const)])
        : await tryMatch()
      if (raced === 'abort') return finish({ reason: 'disconnected' })
      if (raced !== null) return finish({ reason: 'pattern', match: raced })
    }
    const now = io.now()
    if (io.abort?.is()) return finish({ reason: 'disconnected' })
    // The final lines are in once the matcher has looked at them (never ahead of its interval).
    if (io.hasExited() && current()) return finish({ reason: 'exited' })
    if (now >= deadline) return finish({ reason: 'timeout' })
    if (spec.idleMs !== undefined) {
      const quiet = now - Math.max(io.lastOutputAt(), io.sentAt)
      if (quiet >= spec.idleMs && current()) return finish({ reason: 'idle' })
    }
    const nap = io.sleep(Math.max(1, Math.min(TICK_MS, deadline - now)))
    await (io.abort ? Promise.race([nap, io.abort.wake()]) : nap)
  }
}
