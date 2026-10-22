/**
 * Everything one pane keeps for the reading verbs (T564 U3): the console ring, the network capture and idle
 * counter, and the ref table. The view host creates one per pane and feeds it every CDP event of that pane's
 * debugger session; the verbs read from it. Electron-free (ADR-0001): the clock, the timer and the CDP sender
 * are injected, so the whole lifecycle (capture expiry included) is unit-tested.
 */
import { createConsoleBuffer, type ConsoleBuffer } from './console-buffer'
import {
  DEFAULT_CAPTURE_MINUTES,
  createNetworkCapture,
  createNetworkIdleTracker,
  networkEnableParams,
  type CaptureOptions,
  type CaptureStatus,
  type NetworkCapture,
  type NetworkIdleTracker
} from './network-capture'
import { createRefStore, type RefStore } from './snapshot'

export type CaptureEndReason = 'stopped' | 'expired' | 'closed' | 'disconnected' | 'kill-switch'

export interface PaneReadersDeps {
  now(): number
  /** Send one CDP command to this pane; rejects on failure. */
  send(method: string, params?: object): Promise<unknown>
  scrub(text: string): string
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** Capture started or ended: the host pushes the pane's state so the header counter follows. */
  onCaptureChange(status: CaptureStatus, reason: CaptureEndReason | 'started'): void
}

export interface PaneReaders {
  readonly console: ConsoleBuffer
  readonly capture: NetworkCapture
  readonly idle: NetworkIdleTracker
  readonly refs: RefStore
  /** Every CDP event of the pane's session. */
  ingest(method: string, params: unknown): void
  startCapture(opts: Partial<CaptureOptions>): CaptureStatus
  stopCapture(reason?: CaptureEndReason): CaptureStatus
  /** The pane is going away: end capture and drop the timer. */
  dispose(): void
}

export function createPaneReaders(deps: PaneReadersDeps): PaneReaders {
  const consoleBuffer = createConsoleBuffer(deps.now)
  const idle = createNetworkIdleTracker(deps.now)
  const refs = createRefStore()
  const capture = createNetworkCapture({
    now: deps.now,
    scrub: deps.scrub,
    fetchBody: async (requestId) => {
      try {
        const res = (await deps.send('Network.getResponseBody', { requestId })) as
          { body?: string; base64Encoded?: boolean } | undefined
        return res && typeof res.body === 'string'
          ? { body: res.body, base64Encoded: res.base64Encoded === true }
          : undefined
      } catch {
        return undefined
      }
    }
  })
  let timer: unknown = null
  /** Capture was started and has not been ended by us: the lazy expiry inside `capture` cannot tell us. */
  let capturing = false
  /** The Network buffers are sized up for a `bodies: true` capture (see `networkEnableParams`). */
  let bodyBuffers = false
  const setBodyBuffers = (on: boolean): void => {
    if (bodyBuffers === on) return
    bodyBuffers = on
    void deps.send('Network.enable', networkEnableParams(on)).catch(() => undefined)
  }

  function clearExpiry(): void {
    if (timer !== null) deps.clearTimer(timer)
    timer = null
  }

  function stop(reason: CaptureEndReason): CaptureStatus {
    const wasActive = capturing
    capturing = false
    setBodyBuffers(false)
    clearExpiry()
    const status = capture.stop()
    if (wasActive) deps.onCaptureChange(status, reason)
    return status
  }

  return {
    console: consoleBuffer,
    capture,
    idle,
    refs,
    ingest(method, params) {
      if (method.startsWith('Network.')) {
        idle.ingest(method, params)
        capture.ingest(method, params)
      } else if (method === 'Page.frameNavigated') {
        // A top-level navigation kills every ref made on the old page (spec §6.2 `REF_STALE`).
        const frame = (params as { frame?: { parentId?: string } } | undefined)?.frame
        if (frame && frame.parentId === undefined) {
          refs.invalidate()
          // The old page's requests are gone with it; keep none of their ids to wait on.
          idle.reset()
        }
      } else {
        consoleBuffer.ingest(method, params)
      }
    },
    startCapture(opts) {
      clearExpiry()
      capturing = true
      const status = capture.start({ maxMinutes: DEFAULT_CAPTURE_MINUTES, ...opts })
      if (status.expiresAt !== null) {
        timer = deps.setTimer(
          () => {
            timer = null
            stop('expired')
          },
          Math.max(0, status.expiresAt - deps.now())
        )
      }
      // Bodies are fetched from the browser's own buffers, so they are sized up before the first request.
      setBodyBuffers(status.bodies)
      deps.onCaptureChange(status, 'started')
      return status
    },
    stopCapture: (reason = 'stopped') => stop(reason),
    dispose() {
      stop('closed')
    }
  }
}
