/**
 * The System Monitor payload — the contract between S1 (this slice) and every
 * UI slice (S2/S3/S4). Pinned exactly per spec §6.4: S1 owns and exports these
 * types; downstream slices consume them and must not redefine them.
 *
 * Every cost field is `number | null`, never `0`. A `NullSampler` platform (macOS/
 * Windows — no `/proc`) and a genuinely-idle process must not render the same, and a
 * parked session's cost is UNKNOWN, not ZERO. The UI renders `null` as an em-dash.
 *
 * Spec: docs/specs/T127-system-monitor.md §6.4.
 */

/** Pushed on `monitor:heap` every 30s, always — the cheap always-on heartbeat. */
export interface HeapSample {
  atMs: number
  usedBytes: number
  limitBytes: number
  /** From thresholds.ts: warn at 70%, critical at 85% of `limitBytes`. */
  status: 'ok' | 'warn' | 'critical'
}

/** One OS process — an Electron process (the Harnu group) or a session's child. */
export interface ProcSample {
  pid: number
  /** `'main' | 'renderer' | 'GPU' | ...` for Electron; the `/proc` `comm` for a session child. */
  name: string
  /** `null` when the platform sampler cannot measure (macOS/Windows — no `/proc`). */
  cpuPct: number | null
  rssBytes: number | null
}

/** One session row. `procs` is empty and costs are `null` when parked. */
export interface SessionSample {
  sessionKey: string
  /** Mirrors `PtyKind` in pty.ts. */
  kind: string
  state: 'live' | 'parked'
  /** Subtree total (root + descendants), from aggregate.ts. */
  cpuPct: number | null
  rssBytes: number | null
  procs: ProcSample[]
  /** From explainFleet — why this row is in the state it is in. */
  idleMs: number
  parkable: boolean
  /** e.g. `'lru' | 'hard-idle' | 'selected' | 'not-parkable' | 'active' | 'parked'`. */
  reason: string
  /** 1 = next to be swept; `null` = not a sweep candidate. */
  sweepRank: number | null
  /** RSS reclaimed by parking, if known. `null` when never observed live this run. */
  savedBytes: number | null
}

/**
 * Placeholder for the T123 §11 observability counters (`fleet`, `scanner`, `window`,
 * `deadline`). NONE of these exist today — S1 deliberately does not build them (spec
 * §6.5); the shape here is a slot only, never populated by this feature. Wire the
 * real fields when T123 S2/S3/S4 land them.
 */
export interface FleetCounters {
  fleet?: unknown
  scanner?: unknown
  window?: unknown
  deadline?: unknown
}

/** Pushed on `monitor:sample` every 1–2s, only while the takeover is visible. */
export interface MonitorSample {
  atMs: number
  heap: HeapSample
  /** The 'Harnu' group — from `app.getAppMetrics()`. */
  harnu: ProcSample[]
  /** The 'Sessions' group. */
  sessions: SessionSample[]
  /** Absent today — see {@link FleetCounters}. */
  counters?: FleetCounters
}
