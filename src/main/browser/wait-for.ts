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
/** A URL longer than this is not matched against a pattern (bounds a hostile pattern's work). */
const MAX_URL_MATCH_CHARS = 4_096

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

/** Compile a `url` condition; `null` if it is too long or not a valid pattern. */
export function compileUrlPattern(source: string): RegExp | null {
  if (source.length === 0 || source.length > MAX_URL_PATTERN_CHARS) return null
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
      const url = deps.probes.currentUrl()
      if (url.length <= MAX_URL_MATCH_CHARS) {
        const m = conds.url.exec(url)
        if (m) return done('url', m[0])
      }
    }
    if (conds.networkIdleMs !== undefined && deps.probes.networkIdle(conds.networkIdleMs)) {
      return done('networkIdle')
    }

    const left = deadline - deps.now()
    if (left <= 0) return done('timeout')
    await deps.sleep(Math.min(WAIT_POLL_MS, left))
  }
}
