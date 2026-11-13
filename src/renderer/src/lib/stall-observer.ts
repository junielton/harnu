/**
 * Renderer-side stall monitor (T697, performance contract P1/P9): the long-task observer of the
 * main window, with the owner of each task where it can be known.
 *
 * Two detectors feed it. The browser reports tasks over 50 ms (`PerformanceObserver` `longtask`, exact),
 * but NOT the ones Electron starts from an IPC message (verified live: a 300 ms block inside an
 * `ipcRenderer` callback never appears), and those are exactly the fleet updates pushed by main. So a slow
 * heartbeat (`setInterval`, 25 ms) also watches for late ticks (an estimate, ±25 ms) and reports a late
 * tick no observer entry accounts for, after a short wait for the entry to arrive.
 *
 * Owners come from instruments installed once at startup: every Pinia action's synchronous part
 * (`store:<id>.<action>`), every component's render function (`component:<Name>`, which is where a
 * computed that reads the whole fleet is evaluated), `withRendererOwner` for anything else, and the
 * preload's IPC event spans (`event:<channel>`, asked through `monitorOwnerHint`). A task asks the span
 * ring which owner overlapped it the most; unowned tasks are reported as such. Reports go to main,
 * which keeps the one aggregate and the one log (`monitor:stallReport`).
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
  /** One long task as the browser reports it: `startTime` on the `performance.now()` clock. Exact. */
  onLongTask(startTime: number, duration: number): void
  /** A late heartbeat tick: the thread was busy over `[startMs, endMs]` (an estimate). */
  onLateTick(startMs: number, endMs: number): void
  /** Sends everything that is ready; with `force`, parked heartbeat reports go too. */
  flush(force?: boolean): void
}

const FLUSH_MS = 1_000
/** How long a heartbeat report waits for an observer entry that would replace it. */
const DEDUPE_MS = 400

interface Interval {
  startMs: number
  endMs: number
}

const overlapMs = (a: Interval, b: Interval): number =>
  Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)

export function createStallReporter(deps: {
  send(batch: StallRecord[]): void
  /** Epoch ms of `performance.now() === 0`. */
  timeOrigin: number
  spans?: ReturnType<typeof createSpanRing>
  /** Another source of owners (the preload's IPC event spans), asked when the ring has none. */
  hint?(startMs: number, endMs: number): { owner: string; kind: OwnerKind } | null | undefined
  now?(): number
  setTimer?(fn: () => void, ms: number): unknown
}): StallReporter {
  const spans = deps.spans ?? rendererSpans
  const now = deps.now ?? ((): number => performance.now())
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  let pending: StallRecord[] = []
  let parked: Array<Interval & { due: number }> = []
  let exact: Interval[] = []
  let scheduled = false

  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    setTimer(() => flush(false), FLUSH_MS)
  }

  const push = (run: Interval): void => {
    const durationMs = run.endMs - run.startMs
    const named = attribute({ ...run, durationMs }, spans, null)
    if (named.ownerKind === 'unattributed') {
      const h = deps.hint?.(run.startMs, run.endMs)
      if (h) {
        named.owner = h.owner
        named.ownerKind = h.kind
      }
    }
    pending.push({
      atMs: Math.round(deps.timeOrigin + run.endMs),
      thread: 'renderer',
      durationMs: Math.round(durationMs),
      ...named
    })
  }

  function flush(force = false): void {
    scheduled = false
    const t = now()
    const due = parked.filter((p) => force || p.due <= t)
    parked = parked.filter((p) => !due.includes(p))
    for (const p of due) push(p)
    exact = exact.filter((e) => e.endMs > t - 10_000)
    if (pending.length > 0) {
      const batch = pending
      pending = []
      deps.send(batch)
    }
    if (parked.length > 0) schedule()
  }

  return {
    onLongTask(startTime, duration) {
      if (duration < STALL_THRESHOLD_MS) return
      const run = { startMs: startTime, endMs: startTime + duration }
      exact.push(run)
      // The exact entry replaces any heartbeat estimate of the same stall.
      parked = parked.filter(
        (p) => overlapMs(p, run) < Math.min(duration, p.endMs - p.startMs) * 0.5
      )
      push(run)
      schedule()
    },
    onLateTick(startMs, endMs) {
      if (endMs - startMs < STALL_THRESHOLD_MS) return
      const run = { startMs, endMs }
      if (exact.some((e) => overlapMs(e, run) >= (endMs - startMs) * 0.5)) return
      parked.push({ ...run, due: now() + DEDUPE_MS })
      schedule()
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

/**
 * The observer is held here for the life of the window, so nothing can collect it while it still has a
 * callback to deliver.
 */
let activeObserver: PerformanceObserver | null = null

export interface StallApi {
  monitorStallEnabled(): Promise<boolean>
  monitorStallReport(batch: StallRecord[]): void
  onMonitorInjectStall(cb: (ms: number) => void): () => void
  /** The preload's record of IPC event callbacks (`event:<channel>`) that overlapped `[startMs, endMs]`. */
  monitorOwnerHint(startMs: number, endMs: number): { owner: string; kind: OwnerKind } | null
}

/** Heartbeat period: a wake-up costs real CPU, so it is slow; see the file header for the precision. */
export const HEARTBEAT_MS = 25
/** A gap this long is the machine sleeping, not a stall. */
const SUSPEND_GAP_MS = 120_000

/**
 * A late tick is a thread that was busy: the heartbeat should have fired `HEARTBEAT_MS` after the last
 * one, and the task that delayed it started somewhere inside that period, so its length is about
 * `gap - HEARTBEAT_MS / 2`. A hidden window throttles timers to once a second, which looks like a stall
 * and is not one, so those gaps are skipped.
 */
export function startHeartbeat(reporter: StallReporter): () => void {
  let last = performance.now()
  let lastVisible = document.visibilityState === 'visible'
  const timer = setInterval(() => {
    const now = performance.now()
    const visible = document.visibilityState === 'visible'
    const gap = now - last
    if (visible && lastVisible && gap <= SUSPEND_GAP_MS) {
      const busy = gap - HEARTBEAT_MS / 2
      if (busy >= STALL_THRESHOLD_MS) reporter.onLateTick(now - busy, now)
    }
    last = now
    lastVisible = visible
  }, HEARTBEAT_MS)
  return () => clearInterval(timer)
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
    timeOrigin: performance.timeOrigin,
    hint: (s, e) => api.monitorOwnerHint(s, e)
  })
  const stopHeartbeat = startHeartbeat(reporter)
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) reporter.onLongTask(e.startTime, e.duration)
    })
    observer.observe({ type: 'longtask', buffered: true })
    activeObserver = observer
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
    activeObserver?.disconnect()
    activeObserver = null
    stopHeartbeat()
    offInject()
    reporter.flush(true)
  }
}
