/**
 * The condition engine behind `browser_wait_for` (T564 U3, spec §6.1 row 15 and §6.2): wait for the FIRST of a
 * selector appearing, text appearing or disappearing, the URL matching a pattern, or the network going idle,
 * bounded by a timeout, the pane closing and the operator disconnecting the agent. Reaching the timeout is not
 * an error. It only observes, so it never holds the pane's write queue.
 *
 * Pure (ADR-0001): clock, sleep and every page probe are injected.
 */

export const DEFAULT_WAIT_TIMEOUT_MS = 15_000
export const MAX_WAIT_TIMEOUT_MS = 90_000
export const MAX_URL_PATTERN_CHARS = 200
/** How often the conditions are re-checked while nothing has changed. */
export const WAIT_POLL_MS = 100
/**
 * Only the first this-many characters of the URL are matched against a `url` pattern. The URL is written by the
 * page and the pattern by the agent, and the match runs in Harnu's main process, so the work is bounded here and
 * the pattern's shape is bounded in {@link compileUrlPattern}.
 */
export const MAX_URL_MATCH_CHARS = 2_048
/** A pattern may use at most this many repetition operators (`*`, `+`, `{n,m}`): matching is polynomial in them. */
export const MAX_PATTERN_QUANTIFIERS = 3

export interface WaitConditions {
  selector?: string
  text?: string
  textGone?: string
  /** A compiled regex source (≤ 200 characters). */
  url?: RegExp
  networkIdleMs?: number
}

export type WaitReason =
  'selector' | 'text' | 'textGone' | 'url' | 'networkIdle' | 'timeout' | 'closed' | 'disconnected'

export interface WaitProbes {
  selectorPresent(selector: string): Promise<boolean>
  /** The visible text of the page (`document.body.innerText`). */
  pageText(): Promise<string>
  currentUrl(): string
  networkIdle(idleMs: number): boolean
  /** The pane still exists. */
  paneOpen(): boolean
  disconnected(): boolean
}

export interface WaitDeps {
  now(): number
  sleep(ms: number): Promise<void>
  probes: WaitProbes
}

export interface WaitOutcome {
  reason: WaitReason
  waitedMs: number
  match?: string
}

/** The length of a `{n}`, `{n,}` or `{n,m}` repetition starting at `i`, or 0 when `source[i]` is not one. */
function braceQuantifierLength(source: string, i: number): number {
  const m = /^\{\d+(?:,\d*)?\}/.exec(source.slice(i, i + 24))
  return m ? m[0].length : 0
}

/**
 * Whether a pattern could backtrack catastrophically or is heavier than a URL check needs: a repetition inside a
 * group that is itself repeated (`(a+)+`, `(\w+\s?)*`), an alternation inside a repeated group (`(a|aa)+`, which
 * overlapping branches turn exponential), or more than {@link MAX_PATTERN_QUANTIFIERS} repetition operators.
 * A conservative scan, not a proof: it refuses some harmless patterns on purpose, and says so to the caller.
 */
export function isHeavyPattern(source: string): boolean {
  const groups: Array<{ repeats: boolean; alternates: boolean }> = []
  let inClass = false
  let quantifiers = 0
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (ch === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
      continue
    }
    if (ch === '(') {
      groups.push({ repeats: false, alternates: false })
      continue
    }
    if (ch === '|') {
      const top = groups[groups.length - 1]
      if (top) top.alternates = true
      continue
    }
    const brace = ch === '{' ? braceQuantifierLength(source, i) : 0
    if (ch === '*' || ch === '+' || brace > 0) {
      quantifiers++
      const top = groups[groups.length - 1]
      if (top) top.repeats = true
      i += brace > 0 ? brace - 1 : 0
      continue
    }
    if (ch === ')') {
      const closed = groups.pop()
      if (!closed) continue
      const next = source[i + 1]
      const repeated =
        next === '*' || next === '+' || (next === '{' && braceQuantifierLength(source, i + 1) > 0)
      if (repeated && (closed.repeats || closed.alternates)) return true
      // A group that repeats something inside also makes its parent "repeat something inside".
      const parent = groups[groups.length - 1]
      if (parent && closed.repeats) parent.repeats = true
    }
  }
  return quantifiers > MAX_PATTERN_QUANTIFIERS
}

/** Compile a `url` condition; `null` if it is too long, not a valid pattern, or too heavy to run safely. */
export function compileUrlPattern(source: string): RegExp | null {
  if (source.length === 0 || source.length > MAX_URL_PATTERN_CHARS) return null
  if (isHeavyPattern(source)) return null
  try {
    return new RegExp(source)
  } catch {
    return null
  }
}

/** Run one probe; a page that is mid-navigation answers with an error, which only means "not yet". */
async function attempt<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

export async function runWait(
  conds: WaitConditions,
  timeoutMs: number,
  deps: WaitDeps
): Promise<WaitOutcome> {
  const startedAt = deps.now()
  const deadline = startedAt + timeoutMs
  const done = (reason: WaitReason, match?: string): WaitOutcome => ({
    reason,
    waitedMs: Math.max(0, deps.now() - startedAt),
    ...(match !== undefined ? { match } : {})
  })

  for (;;) {
    if (!deps.probes.paneOpen()) return done('closed')
    if (deps.probes.disconnected()) return done('disconnected')

    if (conds.selector !== undefined) {
      if ((await attempt(() => deps.probes.selectorPresent(conds.selector!))) === true) {
        return done('selector', conds.selector)
      }
    }
    if (conds.text !== undefined || conds.textGone !== undefined) {
      const page = await attempt(() => deps.probes.pageText())
      if (page !== undefined) {
        if (conds.text !== undefined && page.includes(conds.text)) return done('text', conds.text)
        if (conds.textGone !== undefined && !page.includes(conds.textGone)) {
          return done('textGone', conds.textGone)
        }
      }
    }
    if (conds.url !== undefined) {
      const m = conds.url.exec(deps.probes.currentUrl().slice(0, MAX_URL_MATCH_CHARS))
      if (m) return done('url', m[0])
    }
    if (conds.networkIdleMs !== undefined && deps.probes.networkIdle(conds.networkIdleMs)) {
      return done('networkIdle')
    }

    const left = deadline - deps.now()
    if (left <= 0) return done('timeout')
    await deps.sleep(Math.min(WAIT_POLL_MS, left))
  }
}
