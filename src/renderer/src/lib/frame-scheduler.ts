/**
 * A "run once soon" scheduler that does not depend on `requestAnimationFrame` alone (T564 U1 delta 3).
 *
 * With the app window occluded or minimized, rAF stops firing, so a rect report driven only by rAF is never
 * sent: a browser pane stays parked at 1×1 and an overlay freezes it into a squashed frame. This runs the work
 * on the next animation frame when the document is visible, and ALSO arms a timer: if the frame has not fired
 * within `fallbackMs` (or the document is not visible at all) the timer runs it instead. Whichever comes first
 * wins and the other is cancelled, so the work still runs once per `schedule`. Pure over injected timers.
 */
export interface FrameSchedulerDeps {
  requestFrame(cb: () => void): number
  cancelFrame(id: number): void
  setTimer(cb: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** `document.visibilityState === 'visible'`. */
  isVisible(): boolean
  /** How long a pending change may wait for a frame before the timer runs it. Default 100 ms. */
  fallbackMs?: number
}

export interface FrameScheduler {
  /** Ask for `run` soon. A no-op while one is already pending. */
  schedule(): void
  /** Drop a pending run. */
  cancel(): void
  /** Whether a run is pending. */
  pending(): boolean
}

export const FRAME_FALLBACK_MS = 100

export function createFrameScheduler(deps: FrameSchedulerDeps, run: () => void): FrameScheduler {
  const fallbackMs = deps.fallbackMs ?? FRAME_FALLBACK_MS
  let isPending = false
  let frameId: number | null = null
  let timer: unknown = null

  function clearArmed(): void {
    if (frameId !== null) deps.cancelFrame(frameId)
    if (timer !== null) deps.clearTimer(timer)
    frameId = null
    timer = null
  }

  function fire(): void {
    if (!isPending) return
    isPending = false
    clearArmed()
    run()
  }

  return {
    schedule(): void {
      if (isPending) return
      isPending = true
      // A hidden document never gets frames: go straight to the timer.
      if (deps.isVisible()) frameId = deps.requestFrame(fire)
      timer = deps.setTimer(fire, fallbackMs)
    },
    cancel(): void {
      isPending = false
      clearArmed()
    },
    pending: () => isPending
  }
}
