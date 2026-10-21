/**
 * Waiting for a navigation to reach `waitUntil` (T564 U1, spec §6.2 `browser_navigate`): the first of the
 * target milestone, a failed load, or the timeout. Hitting the timeout is NOT an error (`reason: 'timeout'`):
 * the page may still be loading. A network failure resolves with `netError` so the agent can read the error
 * page. Pure over a minimal emitter and an injected timer (ADR-0001).
 */
import type { NavigateOutcome } from './verbs-core'

/** The subset of the guest `webContents` the waiter listens to. */
export interface NavEmitter {
  on(event: string, listener: (...args: any[]) => void): unknown
  off(event: string, listener: (...args: any[]) => void): unknown
}

export interface NavTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type WaitUntil = 'commit' | 'domcontentloaded' | 'load'

/** Electron reports failures as `ERR_NAME_NOT_RESOLVED`; some builds report the numeric text. Normalize. */
export function normalizeNetError(description: string): string {
  const d = description.trim()
  if (/^ERR_[A-Z0-9_]+$/.test(d)) return d
  return d === '' ? 'ERR_FAILED' : `ERR_${d.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`
}

/**
 * Subscribe BEFORE starting the navigation, then call `start()`; the returned promise settles with the outcome.
 * `info()` reads the page's title at settle time.
 */
export function waitForNavigation(
  emitter: NavEmitter,
  opts: {
    waitUntil: WaitUntil
    timeoutMs: number
    navigationId: string
    timers: NavTimers
    title: () => string
  }
): { settled: Promise<NavigateOutcome>; cancel: () => void } {
  let status: number | null = null
  let netError: string | undefined
  let finish!: (reason: 'load' | 'timeout') => void
  const settled = new Promise<NavigateOutcome>((resolve) => {
    let done = false
    let timer: unknown
    const cleanup = (): void => {
      done = true
      opts.timers.clearTimeout(timer)
      emitter.off('did-navigate', onNavigate)
      emitter.off('dom-ready', onDomReady)
      emitter.off('did-stop-loading', onStop)
      emitter.off('did-fail-load', onFail)
    }
    finish = (reason) => {
      if (done) return
      cleanup()
      resolve({
        title: opts.title(),
        status,
        navigationId: opts.navigationId,
        ...(netError !== undefined ? { netError } : {}),
        reason
      })
    }
    const onNavigate = (_e: unknown, _url: string, code?: number): void => {
      if (typeof code === 'number' && code > 0) status = code
      if (opts.waitUntil === 'commit') finish('load')
    }
    const onDomReady = (): void => {
      if (opts.waitUntil === 'domcontentloaded') finish('load')
    }
    const onStop = (): void => {
      if (opts.waitUntil === 'load') finish('load')
    }
    const onFail = (
      _e: unknown,
      _errorCode: number,
      description: string,
      _url: string,
      isMainFrame: boolean
    ): void => {
      // A subframe failure does not fail the navigation; ERR_ABORTED (-3) is a superseded load.
      if (!isMainFrame || _errorCode === -3) return
      netError = normalizeNetError(description)
      finish('load')
    }
    emitter.on('did-navigate', onNavigate)
    emitter.on('dom-ready', onDomReady)
    emitter.on('did-stop-loading', onStop)
    emitter.on('did-fail-load', onFail)
    timer = opts.timers.setTimeout(() => finish('timeout'), opts.timeoutMs)
  })
  return { settled, cancel: () => finish('timeout') }
}
