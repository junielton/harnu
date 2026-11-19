/**
 * Stall monitor, pure core (T697, performance contract P1/P9).
 *
 * A keystroke and its echo cross two JavaScript threads (the renderer main thread and the
 * Electron main thread). A *stall* is one uninterrupted run of busy event loop longer than
 * {@link STALL_THRESHOLD_MS}: a single long task, or a flood of back-to-back short ones that
 * never lets the loop go idle (the shape of BUG-261: tens of thousands of tiny `fs.access`
 * completions). This module holds every decision; the timers, the inspector and the files live
 * in the shells beside it (`loop-probe.ts`, `stall-watchdog.ts`, `stall-log.ts`,
 * `stall-monitor.ts`) and in the renderer (`lib/stall-observer.ts`), so all of it is unit-tested
 * without electron.
 *
 * No clock, no I/O, no electron import: callers pass times in.
 */

/** Tasks at or over this are stalls (the contract's hard limit per task). */
export const STALL_THRESHOLD_MS = 50
/** The nested buckets the System Monitor shows: a 300 ms task counts in all three. */
export const STALL_BUCKETS_MS = [50, 100, 250] as const
/** How long a stall stays in the summary. */
export const SUMMARY_WINDOW_MS = 60 * 60 * 1000
/** A loop slice counts as busy at or above this utilisation (a 50 ms task in a 55 ms slice is 0.91). */
export const BUSY_RATIO = 0.85
/** A slice that is at least this busy and holds a task over the threshold is a stall on its own. */
export const SOLO_RATIO = 0.5
/** An unbroken busy run is reported in chunks of at most this long. */
export const MAX_RUN_MS = 5_000

export type Thread = 'main' | 'renderer'

/**
 * Who was running. `ipc` (a main-process handler), `event` (a renderer IPC event callback), `timer`, `job`, `action` and `component` are known owners (a wrapper saw
 * them start); `sampled` is the top application frame of a stack sampled while the stall was in
 * progress; `unattributed` is a stall nobody could name.
 */
export type OwnerKind =
  'ipc' | 'event' | 'timer' | 'job' | 'action' | 'component' | 'sampled' | 'unattributed'

export const UNATTRIBUTED = 'unattributed'

/** One recorded stall. `atMs` is the wall-clock end of the stall. */
export interface StallRecord {
  atMs: number
  thread: Thread
  durationMs: number
  owner: string
  ownerKind: OwnerKind
  /** A short sampled stack (innermost first); only when the owner was not known. */
  frames?: string[]
}

export interface Offender {
  owner: string
  ownerKind: OwnerKind
  count: number
  totalMs: number
  worstMs: number
  /** The frames of the worst occurrence, when it had any. */
  frames?: string[]
}

export interface ThreadSummary {
  /** Stalls in the window at or over 50, 100 and 250 ms. */
  over50: number
  over100: number
  over250: number
  /** Top offenders by total stalled time, at most {@link TOP_OFFENDERS}. */
  offenders: Offender[]
}

export const TOP_OFFENDERS = 5

export interface StallSummary {
  main: ThreadSummary
  renderer: ThreadSummary
}

export const emptyThreadSummary = (): ThreadSummary => ({
  over50: 0,
  over100: 0,
  over250: 0,
  offenders: []
})

// ---- Busy runs -----------------------------------------------------------------------------

/** One heartbeat interval: wall time between two ticks and how much of it the loop spent running JS. */
export interface LoopSlice {
  startMs: number
  endMs: number
  /** Busy time inside the slice (event-loop utilisation `active`, or the heartbeat's lateness). */
  activeMs: number
}

export interface BusyRun {
  startMs: number
  endMs: number
  durationMs: number
}

/**
 * Folds heartbeat slices into busy runs: consecutive busy slices extend the run, an idle slice
 * closes it. A closed run at or over `thresholdMs` is reported once. A stall is only ever
 * reported after it ends (the loop that is stuck cannot tell anyone), so a 20 s stall arrives 20 s late.
 */
export function createBusyRunTracker(opts: {
  thresholdMs?: number
  busyRatio?: number
  /**
   * A run still open after this long is reported and a new one starts, so a loop that never goes idle
   * (a flood of short tasks) is visible while it is happening, in chunks of this size.
   */
  maxRunMs?: number
  onRun(run: BusyRun): void
}): { push(slice: LoopSlice): void; flush(): void } {
  const threshold = opts.thresholdMs ?? STALL_THRESHOLD_MS
  const maxRun = opts.maxRunMs ?? MAX_RUN_MS
  const ratio = opts.busyRatio ?? BUSY_RATIO
  let runStart: number | null = null
  let runEnd = 0

  const close = (): void => {
    if (runStart === null) return
    const durationMs = runEnd - runStart
    if (durationMs >= threshold) opts.onRun({ startMs: runStart, endMs: runEnd, durationMs })
    runStart = null
  }

  return {
    push(slice) {
      const wall = slice.endMs - slice.startMs
      if (wall <= 0) return
      if (slice.activeMs / wall >= ratio) {
        if (runStart === null) runStart = slice.startMs
        runEnd = slice.endMs
        if (runEnd - runStart >= maxRun) close()
        return
      }
      close()
      // One task long enough to be a stall on its own, whose slice also holds the idle gap that came
      // before it (the heartbeat could not tick while the task ran, so the slice spans both): its busy
      // time is exact, the idle part is not part of the stall.
      if (slice.activeMs >= threshold && slice.activeMs / wall >= SOLO_RATIO) {
        opts.onRun({
          startMs: slice.endMs - slice.activeMs,
          endMs: slice.endMs,
          durationMs: slice.activeMs
        })
      }
    },
    flush: close
  }
}

// ---- Owner spans ---------------------------------------------------------------------------

export interface OwnerSpan {
  owner: string
  kind: OwnerKind
  startMs: number
  endMs: number
  /** The part of the span not spent inside a nested owner (defaults to the whole span). */
  selfMs?: number
}

/** Spans shorter than this are not kept: a stall is made of the long ones. */
export const MIN_SPAN_MS = 1
const SPAN_RING_SIZE = 512

/**
 * The last few hundred owned spans (a wrapped IPC handler, timer callback or store action that ran
 * at least {@link MIN_SPAN_MS}). A stall asks which owner overlapped it the most.
 */
export function createSpanRing(max = SPAN_RING_SIZE): {
  record(owner: string, kind: OwnerKind, startMs: number, endMs: number, selfMs?: number): void
  best(startMs: number, endMs: number): { owner: string; kind: OwnerKind } | null
  size(): number
} {
  const ring: OwnerSpan[] = []
  let head = 0
  return {
    record(owner, kind, startMs, endMs, selfMs) {
      if (endMs - startMs < MIN_SPAN_MS) return
      const span: OwnerSpan = { owner, kind, startMs, endMs, selfMs }
      if (ring.length < max) ring.push(span)
      else {
        ring[head] = span
        head = (head + 1) % max
      }
    },
    best(startMs, endMs) {
      const overlapBy = new Map<string, { kind: OwnerKind; ms: number }>()
      for (const s of ring) {
        const overlap = Math.min(s.endMs, endMs) - Math.max(s.startMs, startMs)
        if (overlap <= 0) continue
        // A span that wraps another owner counts only for its own share: the inner owner is the better name.
        const ms = s.selfMs === undefined ? overlap : overlap * (s.selfMs / (s.endMs - s.startMs))
        if (ms <= 0) continue
        const prev = overlapBy.get(s.owner)
        if (prev) prev.ms += ms
        else overlapBy.set(s.owner, { kind: s.kind, ms })
      }
      let best: { owner: string; kind: OwnerKind; ms: number } | null = null
      for (const [owner, v] of overlapBy) if (!best || v.ms > best.ms) best = { owner, ...v }
      // An owner must explain a real part of the stall, or it is a coincidence.
      const needed = Math.min(25, (endMs - startMs) * 0.3)
      return best && best.ms >= needed ? { owner: best.owner, kind: best.kind } : null
    },
    size: () => ring.length
  }
}

// ---- Sampled stacks ------------------------------------------------------------------------

/** A frame as the inspector gives it: function name, script url, 0-based line. */
export interface RawFrame {
  functionName: string
  url: string
  lineNumber: number
}

/** `fn file.ts:12`, with the directory stripped (the log is local, but paths are noise). */
export function formatFrame(f: RawFrame): string {
  const file = f.url.split(/[\\/]/).pop() || f.url || '(native)'
  return `${f.functionName || '(anonymous)'} ${file}:${f.lineNumber + 1}`
}

const isAppFrame = (f: RawFrame): boolean =>
  f.url !== '' &&
  !f.url.startsWith('node:') &&
  !f.url.includes('node_modules/electron/') &&
  !f.url.startsWith('electron/')

/**
 * The owner a stack names: its innermost application frame (skipping node and electron internals),
 * or `null` when every frame is internal.
 */
export function ownerFromFrames(frames: readonly RawFrame[]): string | null {
  const f = frames.find(isAppFrame)
  return f ? formatFrame(f) : null
}

/** At most 5 frames, application ones first, as short strings. */
export function shortStack(frames: readonly RawFrame[]): string[] {
  const app = frames.filter(isAppFrame)
  return (app.length > 0 ? app : [...frames]).slice(0, 5).map(formatFrame)
}

// ---- Aggregation ---------------------------------------------------------------------------

/**
 * Keeps the last hour of stalls (bounded) and answers the summary the System Monitor shows.
 * `max` caps memory: past it the oldest record goes first.
 */
export function createStallAggregator(opts: { windowMs?: number; max?: number } = {}): {
  add(record: StallRecord): void
  summary(nowMs: number): StallSummary
  records(thread?: Thread): readonly StallRecord[]
  /** Time spent stalled on `thread` in the last `spanMs` (the long-task share fallback). */
  stalledMs(thread: Thread, nowMs: number, spanMs: number): number
} {
  const windowMs = opts.windowMs ?? SUMMARY_WINDOW_MS
  const max = opts.max ?? 4096
  const all: StallRecord[] = []

  const prune = (nowMs: number): void => {
    let drop = 0
    while (drop < all.length && all[drop].atMs < nowMs - windowMs) drop++
    if (drop > 0) all.splice(0, drop)
    if (all.length > max) all.splice(0, all.length - max)
  }

  const summarize = (thread: Thread, nowMs: number): ThreadSummary => {
    const out = emptyThreadSummary()
    const by = new Map<string, Offender>()
    for (const r of all) {
      if (r.thread !== thread || r.atMs < nowMs - windowMs) continue
      if (r.durationMs >= STALL_BUCKETS_MS[0]) out.over50++
      if (r.durationMs >= STALL_BUCKETS_MS[1]) out.over100++
      if (r.durationMs >= STALL_BUCKETS_MS[2]) out.over250++
      const o = by.get(r.owner)
      if (!o) {
        by.set(r.owner, {
          owner: r.owner,
          ownerKind: r.ownerKind,
          count: 1,
          totalMs: r.durationMs,
          worstMs: r.durationMs,
          ...(r.frames ? { frames: r.frames } : {})
        })
      } else {
        o.count++
        o.totalMs += r.durationMs
        if (r.durationMs > o.worstMs) {
          o.worstMs = r.durationMs
          if (r.frames) o.frames = r.frames
        }
      }
    }
    out.offenders = [...by.values()]
      .sort((a, b) => b.totalMs - a.totalMs || b.worstMs - a.worstMs)
      .slice(0, TOP_OFFENDERS)
      .map((o) => ({ ...o, totalMs: Math.round(o.totalMs), worstMs: Math.round(o.worstMs) }))
    return out
  }

  return {
    add(record) {
      all.push(record)
      prune(record.atMs)
    },
    summary(nowMs) {
      prune(nowMs)
      return { main: summarize('main', nowMs), renderer: summarize('renderer', nowMs) }
    },
    records: (thread) => (thread ? all.filter((r) => r.thread === thread) : all),
    stalledMs(thread, nowMs, spanMs) {
      let total = 0
      for (const r of all)
        if (r.thread === thread && r.atMs >= nowMs - spanMs) total += r.durationMs
      return total
    }
  }
}

// ---- Log -----------------------------------------------------------------------------------

export const LOG_MAX_BYTES = 1024 * 1024
export const LOG_RETENTION_MS = 24 * 60 * 60 * 1000

export const encodeRecord = (r: StallRecord): string => JSON.stringify(r) + '\n'

const KINDS: ReadonlySet<string> = new Set([
  'ipc',
  'event',
  'timer',
  'job',
  'action',
  'component',
  'sampled',
  'unattributed'
])

/** A record from untrusted input (a log line, or a renderer report): clamped, or `null`. */
export function sanitizeRecord(raw: unknown, nowMs: number): StallRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.thread !== 'main' && r.thread !== 'renderer') return null
  const durationMs = Number(r.durationMs)
  if (!Number.isFinite(durationMs) || durationMs < STALL_THRESHOLD_MS || durationMs > 3_600_000)
    return null
  const atMs = Number(r.atMs)
  if (!Number.isFinite(atMs) || atMs > nowMs + 60_000 || atMs < 0) return null
  const ownerKind =
    typeof r.ownerKind === 'string' && KINDS.has(r.ownerKind) ? r.ownerKind : UNATTRIBUTED
  const owner = typeof r.owner === 'string' && r.owner !== '' ? r.owner.slice(0, 160) : UNATTRIBUTED
  const frames = Array.isArray(r.frames)
    ? r.frames
        .filter((f): f is string => typeof f === 'string')
        .slice(0, 5)
        .map((f) => f.slice(0, 160))
    : undefined
  return {
    atMs,
    thread: r.thread,
    durationMs: Math.round(durationMs),
    owner,
    ownerKind: ownerKind as OwnerKind,
    ...(frames && frames.length > 0 ? { frames } : {})
  }
}

/** The records a log file's text still holds after retention: `nowMs - 24 h` onwards, oldest first. */
export function parseLog(text: string, nowMs: number): StallRecord[] {
  const out: StallRecord[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const rec = sanitizeRecord(JSON.parse(line), nowMs)
      if (rec && rec.atMs >= nowMs - LOG_RETENTION_MS) out.push(rec)
    } catch {
      /* a torn last line after a crash */
    }
  }
  return out
}

/** Rotate when the live file would pass the cap: the old file becomes `.1`, replacing any older one. */
export const shouldRotate = (currentBytes: number, incomingBytes: number): boolean =>
  currentBytes + incomingBytes > LOG_MAX_BYTES

// ---- A stall's owner -----------------------------------------------------------------------

/**
 * Names a finished busy run. A wrapper-recorded owner wins; otherwise the sampled stack names it;
 * otherwise nobody can.
 */
export function attribute(
  run: BusyRun,
  spans: ReturnType<typeof createSpanRing>,
  sampled: { owner: string; frames: string[] } | null
): Pick<StallRecord, 'owner' | 'ownerKind' | 'frames'> {
  const known = spans.best(run.startMs, run.endMs)
  if (known) return { owner: known.owner, ownerKind: known.kind }
  if (sampled) return { owner: sampled.owner, ownerKind: 'sampled', frames: sampled.frames }
  return { owner: UNATTRIBUTED, ownerKind: 'unattributed' }
}
