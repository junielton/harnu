/**
 * The load error page's main-process logic, pure (browser-tabs spec S-3, "Load error"): which `did-fail-load` counts,
 * the record the renderer draws from, and "Reload when it is up", a TCP poll of a `local` origin that reloads the tab
 * on the first success. No electron and no clock of its own (ADR-0001): the view host injects the timer and the probe.
 */
import * as net from 'node:net'
import { scrubUrl } from './origin-class'
import {
  RELOAD_WHEN_UP_MAX_MS,
  RELOAD_WHEN_UP_POLL_MS,
  type BrowserTabLoadError
} from '../../shared/browser-tabs'

export { RELOAD_WHEN_UP_MAX_MS, RELOAD_WHEN_UP_POLL_MS }

/** Chromium's code for "the navigation was replaced or cancelled" (`ERR_ABORTED`): never an error page. */
const ERR_ABORTED = -3

/**
 * Whether a `did-fail-load` shows the load error page: a MAIN-frame failure with any code but `ERR_ABORTED`. A
 * subframe failure (an ad, an iframe) never does.
 */
export function isMainFrameFailure(errorCode: number, isMainFrame: boolean): boolean {
  return isMainFrame && errorCode !== ERR_ABORTED
}

/**
 * An address Chromium's own error page commits under. The error page is what the hidden view shows, so its commit is
 * not "the next commit" that clears the error.
 */
export function isErrorPageUrl(url: string): boolean {
  return url.startsWith('chrome-error:')
}

/**
 * The record the error page is drawn from: the host label, the port (the scheme's default when the address has none)
 * and whether the origin is local. The address is scrubbed (no query, no fragment): it reaches the renderer and the
 * agent verbs, and a query can carry a token.
 */
export function buildLoadError(code: string, url: string, local: boolean): BrowserTabLoadError {
  try {
    const u = new URL(url)
    const port =
      u.port !== ''
        ? Number(u.port)
        : u.protocol === 'https:'
          ? 443
          : u.protocol === 'http:'
            ? 80
            : null
    return { code, url: scrubUrl(url), host: u.host, port, local }
  } catch {
    return { code, url: '', host: '', port: null, local }
  }
}

/* ---- Reload when it is up ------------------------------------------------------------------------ */

export interface ReloadWhenUpDeps {
  /** One TCP connect attempt: true when something accepted. */
  probe(host: string, port: number): Promise<boolean>
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  now(): number
}

export interface ReloadWhenUpCallbacks {
  /** The first probe that connected: reload the tab. The wait has already ended. */
  onUp(): void
  /** The wait ended without a reload (cancelled, or it ran 10 min): the tab's `waitingForUp` is false now. */
  onStop(): void
}

export interface ReloadWhenUp {
  /** Start polling for `key` (a tab id). A second call while it polls is a second click: it cancels and returns false. */
  start(key: string, target: { host: string; port: number }, cb: ReloadWhenUpCallbacks): boolean
  /** Stop `key`'s poll (navigation, close, a second click). No-op when it is not polling. */
  cancel(key: string): void
  isWaiting(key: string): boolean
}

export function createReloadWhenUp(deps: ReloadWhenUpDeps): ReloadWhenUp {
  interface Run {
    handle: unknown
    startedAt: number
    cb: ReloadWhenUpCallbacks
  }
  const runs = new Map<string, Run>()

  const end = (key: string, run: Run): void => {
    if (runs.get(key) !== run) return
    runs.delete(key)
    deps.clearTimer(run.handle)
  }
  const cancel = (key: string): void => {
    const run = runs.get(key)
    if (!run) return
    end(key, run)
    run.cb.onStop()
  }
  const schedule = (key: string, run: Run, target: { host: string; port: number }): void => {
    run.handle = deps.setTimer(() => {
      if (runs.get(key) !== run) return
      if (deps.now() - run.startedAt >= RELOAD_WHEN_UP_MAX_MS) return cancel(key)
      void deps.probe(target.host, target.port).then(
        (up) => {
          if (runs.get(key) !== run) return
          if (up) {
            end(key, run)
            run.cb.onUp()
          } else schedule(key, run, target)
        },
        () => {
          if (runs.get(key) === run) schedule(key, run, target)
        }
      )
    }, RELOAD_WHEN_UP_POLL_MS)
  }
  return {
    start(key, target, cb) {
      if (runs.has(key)) {
        cancel(key)
        return false
      }
      const run: Run = { handle: undefined, startedAt: deps.now(), cb }
      runs.set(key, run)
      schedule(key, run, target)
      return true
    },
    cancel,
    isWaiting: (key) => runs.has(key)
  }
}

/** One TCP connect attempt with a short timeout: whether `host:port` accepted. */
export function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let done = false
    const finish = (up: boolean): void => {
      if (done) return
      done = true
      socket.destroy()
      resolve(up)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}
