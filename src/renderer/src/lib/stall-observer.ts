/**
 * Renderer-side stall monitor (T697, performance contract P1/P9): the long-task observer of the
 * main window, with the owner of each task where it can be known.
 *
 * The browser reports every task over 50 ms (`PerformanceObserver` `longtask`); it cannot say who ran.
 * Owners come from three instruments installed once at startup: every Pinia action's synchronous part
 * (`store:<id>.<action>`), every component's render function (`component:<Name>`, which is where a
 * computed that reads the whole fleet is evaluated), and `withRendererOwner` for anything else. A task
 * asks the span ring which owner overlapped it the most; unowned tasks are reported as such. Reports
 * go to main, which keeps the one aggregate and the one log (`monitor:stallReport`).
 *
 * The decisions are in `src/shared/stall-core.ts` (shared with main); this file is the browser shell.
 */

import type { App } from 'vue'
import type { Pinia } from 'pinia'
import {
  attribute,
  createSpanRing,
  STALL_THRESHOLD_MS,
  type OwnerKind,
  type StallRecord
} from '../../../shared/stall-core'

export const rendererSpans = createSpanRing()

/**
 * The instruments install synchronously at startup (a Pinia plugin only reaches stores created after it,
 * and the first ones are created at once) but only record while this is on, which main decides
 * (`HARNU_STALL_MONITOR=off`) a moment later.
 */
let recording = true
export const setRendererSpansRecording = (on: boolean): void => {
  recording = on
}

/** Runs `fn` and records its synchronous duration as `owner`. */
export function withRendererOwner<T>(owner: string, kind: OwnerKind, fn: () => T): T {
  if (!recording) return fn()
  const start = performance.now()
  try {
    return fn()
  } finally {
    rendererSpans.record(owner, kind, start, performance.now())
  }
}

// ---- reporting -----------------------------------------------------------------------------

export interface StallReporter {
  /** One long task as the browser reports it: `startTime` on the `performance.now()` clock. */
  onLongTask(startTime: number, duration: number): void
  flush(): void
}

const FLUSH_MS = 1_000

export function createStallReporter(deps: {
  send(batch: StallRecord[]): void
  /** Epoch ms of `performance.now() === 0`. */
  timeOrigin: number
  spans?: ReturnType<typeof createSpanRing>
  setTimer?(fn: () => void, ms: number): unknown
}): StallReporter {
  const spans = deps.spans ?? rendererSpans
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  let pending: StallRecord[] = []
  let scheduled = false

  const flush = (): void => {
    scheduled = false
    if (pending.length === 0) return
    const batch = pending
    pending = []
    deps.send(batch)
  }

  return {
    onLongTask(startTime, duration) {
      if (duration < STALL_THRESHOLD_MS) return
      const named = attribute(
        { startMs: startTime, endMs: startTime + duration, durationMs: duration },
        spans,
        null
      )
      pending.push({
        atMs: Math.round(deps.timeOrigin + startTime + duration),
        thread: 'renderer',
        durationMs: Math.round(duration),
        ...named
      })
      if (!scheduled) {
        scheduled = true
        setTimer(flush, FLUSH_MS)
      }
    },
    flush
  }
}

// ---- instruments ---------------------------------------------------------------------------

/** Wraps each Pinia store's actions so their synchronous part is an owned span. */
export function installStoreSpans(pinia: Pinia): void {
  pinia.use(({ store }) => {
    for (const key of Object.keys(store)) {
      const value = (store as unknown as Record<string, unknown>)[key]
      if (typeof value !== 'function' || key.startsWith('$') || key.startsWith('_')) continue
      const action = value as (...args: unknown[]) => unknown
      const owner = `store:${store.$id}.${key}`
      ;(store as unknown as Record<string, unknown>)[key] = function (
        this: unknown,
        ...args: unknown[]
      ) {
        if (!recording) return action.apply(this, args)
        const start = performance.now()
        try {
          return action.apply(this, args)
        } finally {
          rendererSpans.record(owner, 'action', start, performance.now())
        }
      }
    }
  })
}

interface InternalInstance {
  type: { name?: string; __name?: string }
  render: ((...args: unknown[]) => unknown) | null
}

/** Wraps each component's render function: a computed that reads the fleet is evaluated inside it. */
export function installComponentSpans(app: App): void {
  app.mixin({
    beforeCreate(this: { $: InternalInstance }) {
      const instance = this.$
      const render = instance.render
      if (typeof render !== 'function') return
      const owner = `component:${instance.type.name || instance.type.__name || 'Anonymous'}`
      instance.render = function (this: unknown, ...args: unknown[]) {
        if (!recording) return render.apply(this, args)
        const start = performance.now()
        try {
          return render.apply(this, args)
        } finally {
          rendererSpans.record(owner, 'component', start, performance.now())
        }
      }
    }
  })
}

// ---- shell ---------------------------------------------------------------------------------

export interface StallApi {
  monitorStallEnabled(): Promise<boolean>
  monitorStallReport(batch: StallRecord[]): void
  onMonitorInjectStall(cb: (ms: number) => void): () => void
}

/**
 * Installs the instruments now, then starts the observer once main has said whether the monitor is on
 * (`HARNU_STALL_MONITOR=off` turns it off: the instruments stay installed but record nothing).
 * Call it right after `app.use(pinia)` and before any store is created.
 */
export async function startRendererStallMonitor(
  api: StallApi,
  target: { app: App; pinia: Pinia }
): Promise<(() => void) | null> {
  installStoreSpans(target.pinia)
  installComponentSpans(target.app)
  if (typeof PerformanceObserver === 'undefined') return null
  if (!(await api.monitorStallEnabled().catch(() => false))) {
    setRendererSpansRecording(false)
    return null
  }

  const reporter = createStallReporter({
    send: (batch) => api.monitorStallReport(batch),
    timeOrigin: performance.timeOrigin
  })
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) reporter.onLongTask(e.startTime, e.duration)
    })
    observer.observe({ type: 'longtask', buffered: true })
  } catch {
    observer = null
  }

  // A diagnostic block, only reachable when main was started with HARNU_STALL_INJECT=1.
  const offInject = api.onMonitorInjectStall((ms) =>
    withRendererOwner('diagnostic:injected-stall', 'job', () => {
      const end = performance.now() + Math.min(Math.max(ms, 0), 5_000)
      while (performance.now() < end) {
        /* hold the thread */
      }
    })
  )

  return () => {
    observer?.disconnect()
    offInject()
    reporter.flush()
  }
}
