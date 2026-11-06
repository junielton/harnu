/**
 * When the capacity watcher (U3.6) runs a pass: at boot, on a Docker network event (debounced, so
 * a `compose up` that makes five networks is one pass), and on a fallback interval so a dead event
 * stream or a missed event costs at most one interval. Passes never overlap; a request that
 * arrives during one schedules exactly one trailing pass. What a pass does is `capacity-watcher-core`.
 */

export type WatchTrigger = 'boot' | 'event' | 'timer'

export interface CapacityWatcherDeps {
  pass(trigger: WatchTrigger): Promise<void>
  /** Subscribes to network create/destroy; the listener takes no argument. */
  subscribe(onEvent: () => void): { stop(): void }
  /** Fallback interval; at most 60 s by the card's AC-1. */
  intervalMs: number
  debounceMs: number
}

export const CAPACITY_INTERVAL_MS = 30_000
export const CAPACITY_DEBOUNCE_MS = 1_500

export interface CapacityWatcher {
  start(): void
  stop(): void
  /** Requests a pass now (queued behind a running one). */
  poke(trigger?: WatchTrigger): void
}

export function createCapacityWatcher(deps: CapacityWatcherDeps): CapacityWatcher {
  let started = false
  let running = false
  let pending: WatchTrigger | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  let interval: ReturnType<typeof setInterval> | null = null
  let sub: { stop(): void } | null = null

  const run = async (trigger: WatchTrigger): Promise<void> => {
    running = true
    try {
      await deps.pass(trigger)
    } catch (err) {
      console.warn('[gc] capacity watcher pass failed', err instanceof Error ? err.message : err)
    } finally {
      running = false
    }
    if (started && pending) {
      const next = pending
      pending = null
      void run(next)
    }
  }

  const poke = (trigger: WatchTrigger = 'timer'): void => {
    if (!started) return
    if (running) {
      pending = trigger
      return
    }
    void run(trigger)
  }

  return {
    start(): void {
      if (started) return
      started = true
      sub = deps.subscribe(() => {
        if (debounce) return
        debounce = setTimeout(() => {
          debounce = null
          poke('event')
        }, deps.debounceMs)
      })
      interval = setInterval(() => poke('timer'), deps.intervalMs)
      poke('boot')
    },
    stop(): void {
      started = false
      pending = null
      if (debounce) clearTimeout(debounce)
      if (interval) clearInterval(interval)
      debounce = null
      interval = null
      sub?.stop()
      sub = null
    },
    poke
  }
}
