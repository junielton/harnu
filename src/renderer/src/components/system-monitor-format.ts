/**
 * Pure presentational helpers for the System Monitor takeover (design.md
 * "System Monitor (takeover, T127 S2)"). Framework-free, so it's unit-testable in
 * the `node` vitest env — the `.vue` components are thin templates over these,
 * same convention as `usage-dashboard-format.ts`.
 */

import type { HeapSample, ProcSample, SessionSample } from '../../../preload'
import type { FolderHue } from '../lib/folder-hue'

/** `1.20 GB` / `410 MB` / `40 KB` — `null` (unmeasured/parked) renders as an em-dash. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  const abs = Math.abs(bytes)
  if (abs >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB'
  if (abs >= 1e6) return Math.round(bytes / 1e6) + ' MB'
  if (abs >= 1e3) return Math.round(bytes / 1e3) + ' KB'
  return Math.round(bytes) + ' B'
}

/** `12%` — `null` (unmeasured/parked) renders as an em-dash. */
export function formatPct(pct: number | null): string {
  if (pct === null) return '—'
  return Math.round(pct) + '%'
}

/** `22 min` / `1h 3min` — floors below a minute to `<1 min` rather than `0 min`. */
export function formatIdle(idleMs: number): string {
  const totalMin = Math.floor(idleMs / 60_000)
  if (totalMin < 1) return '<1 min'
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m > 0 ? `${h}h ${m}min` : `${h}h`
}

/**
 * Sort by RSS descending — the takeover's default sort (spec §7). `null` (an
 * unmeasured/parked cost) sorts to the bottom, never mixed in with real numbers.
 */
export function sortByRssDesc<T extends { rssBytes: number | null }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (b.rssBytes ?? -1) - (a.rssBytes ?? -1))
}

/** Total RSS across a process list; `null` entries contribute 0 (a partial-unknown total still means something). */
export function sumRssBytes(procs: readonly ProcSample[]): number {
  return procs.reduce((sum, p) => sum + (p.rssBytes ?? 0), 0)
}

export interface SubtreeSample {
  cpuPct: number | null
  rssBytes: number | null
}

/**
 * A session's own cost — the subtree total minus every descendant `procs` already
 * lists. `sampler.ts`'s `childProcSamples` deliberately excludes the root pid ("its
 * own cost rolls into the row's aggregate total"), which makes the expanded child
 * rows sum to less than the parent row and reads as missing memory. This is the one
 * place that gap becomes a visible number, so the System Monitor table can render it
 * as its own row instead of leaving it unexplained. `null` when the total or any one
 * descendant's own reading is unknown — a partial sum would misattribute an
 * unmeasured child's cost to the root.
 */
export function selfSample(total: SubtreeSample, procs: readonly ProcSample[]): SubtreeSample {
  const rssKnown = total.rssBytes !== null && procs.every((p) => p.rssBytes !== null)
  const cpuKnown = total.cpuPct !== null && procs.every((p) => p.cpuPct !== null)
  return {
    rssBytes: rssKnown ? (total.rssBytes as number) - sumRssBytes(procs) : null,
    cpuPct: cpuKnown
      ? (total.cpuPct as number) - procs.reduce((sum, p) => sum + (p.cpuPct as number), 0)
      : null
  }
}

export interface SessionCounts {
  live: number
  parked: number
}

export function countSessions(sessions: readonly SessionSample[]): SessionCounts {
  let live = 0
  let parked = 0
  for (const s of sessions) {
    if (s.state === 'live') live++
    else parked++
  }
  return { live, parked }
}

/**
 * Whether a live session's `reason` is worth a visible chip next to its state
 * pip — `'active'`/`'selected'`/`'not-parkable'`/`'pending-approval'` are the
 * unremarkable steady states; `'lru'`/`'hard-idle'` mean "this session is a
 * hibernation candidate right now", which is the whole point of "Explain".
 */
export function isNoteworthyLiveReason(reason: string): boolean {
  return reason === 'lru' || reason === 'hard-idle'
}

/** 0-100 fill percentage for a heap gauge — shared by the titlebar and the `main` row's inline gauge. */
export function heapPercent(heap: HeapSample | null): number {
  if (!heap || heap.limitBytes <= 0) return 0
  return Math.min(100, (heap.usedBytes / heap.limitBytes) * 100)
}

/** Fill color for a heap gauge, by `HeapSample.status` (thresholds.ts: warn 70%, critical 85%). */
export function heapBarClass(status: HeapSample['status'] | undefined): string {
  switch (status) {
    case 'critical':
      return 'bg-red'
    case 'warn':
      return 'bg-warning'
    default:
      return 'bg-green'
  }
}

// ── T591: redesign helpers (design.md "System Monitor (takeover)") ──────────

/** The sampler's heap thresholds (thresholds.ts) — the sidebar gauge draws its tick marks here. */
export const HEAP_WARN_PCT = 70
export const HEAP_CRIT_PCT = 85

/** `{ value: '940', unit: 'MB' }` — for a big number with a small unit. `null` stays `null`. */
export function splitBytes(bytes: number | null): { value: string; unit: string } | null {
  if (bytes === null) return null
  const [value, unit] = formatBytes(bytes).split(' ')
  return { value, unit }
}

/** Session-surface CPU: `3.2%` under 10, `12%` from 10 up, `—` when unknown. */
export function formatCpu(pct: number | null): string {
  if (pct === null) return '—'
  return pct < 10 ? pct.toFixed(1) + '%' : Math.round(pct) + '%'
}

/** `18.4%` — totals, KPI and the sidebar rows always keep one decimal. */
export function formatPct1(pct: number | null): string {
  return pct === null ? '—' : pct.toFixed(1) + '%'
}

/** `value / max` as 0–100, clamped; unknown or empty reads as 0 so a bar simply doesn't draw. */
export function relativePct(value: number | null, max: number): number {
  if (value === null || max <= 0) return 0
  return Math.min(100, Math.max(0, (value / max) * 100))
}

/** Sum of the readings that exist, or `null` when none does (a total of nothing is not 0). */
function sumKnown(values: readonly (number | null)[]): number | null {
  let sum = 0
  let any = false
  for (const v of values) {
    if (v === null) continue
    sum += v
    any = true
  }
  return any ? sum : null
}

export interface MonitorTotals {
  harnuBytes: number
  sessionsBytes: number
  totalBytes: number
  /** Harnu's share of {@link totalBytes}, 0–100, for the KPI split bar. */
  harnuSharePct: number
  /** Harnu + live sessions; `null` when no process reports a CPU reading. */
  cpuPct: number | null
  /** Harnu processes plus every live session's listed `/proc` children. */
  processCount: number
  live: number
  parked: number
  /** Sum of the known `savedBytes`; `null` when none is known. */
  reclaimedBytes: number | null
}

/**
 * The numbers behind the KPI strip, the sidebar totals line and the header summary.
 * Only LIVE sessions count towards RAM/CPU — a parked session costs nothing.
 */
export function monitorTotals(
  harnu: readonly ProcSample[],
  sessions: readonly SessionSample[]
): MonitorTotals {
  const liveSessions = sessions.filter((s) => s.state === 'live')
  const harnuBytes = sumKnown(harnu.map((p) => p.rssBytes)) ?? 0
  const sessionsBytes = sumKnown(liveSessions.map((s) => s.rssBytes)) ?? 0
  const totalBytes = harnuBytes + sessionsBytes
  const { live, parked } = countSessions(sessions)
  return {
    harnuBytes,
    sessionsBytes,
    totalBytes,
    harnuSharePct: totalBytes > 0 ? (harnuBytes / totalBytes) * 100 : 0,
    cpuPct: sumKnown([...harnu.map((p) => p.cpuPct), ...liveSessions.map((s) => s.cpuPct)]),
    processCount: harnu.length + liveSessions.reduce((n, s) => n + s.procs.length, 0),
    live,
    parked,
    reclaimedBytes: sumKnown(sessions.map((s) => s.savedBytes))
  }
}

export interface CompositionSegment {
  key: string
  label: string
  bytes: number
  /** Share of the session's total RSS, 0–100. */
  pct: number
  /** Index into the five `--fh` shades (0..4). */
  shade: number
  isSelf: boolean
  isOther: boolean
}

/** Own + four largest children; anything beyond that folds into one `other` entry. */
const MAX_COMPOSITION_SEGMENTS = 5

/**
 * A session's memory split for the card's composition bar: its own cost first, then
 * its children biggest-first. Unknown readings are omitted, never drawn as 0.
 */
export function compositionSegments(
  total: number | null,
  selfRss: number | null,
  procs: readonly ProcSample[]
): CompositionSegment[] {
  if (total === null || total <= 0) return []
  const entries: Omit<CompositionSegment, 'pct' | 'shade'>[] = []
  if (selfRss !== null && selfRss > 0) {
    entries.push({ key: 'self', label: 'own', bytes: selfRss, isSelf: true, isOther: false })
  }
  const children = procs
    .filter((p): p is ProcSample & { rssBytes: number } => p.rssBytes !== null && p.rssBytes > 0)
    .sort((a, b) => b.rssBytes - a.rssBytes)
  const room = MAX_COMPOSITION_SEGMENTS - entries.length
  const shown = children.length > room ? children.slice(0, room - 1) : children
  for (const p of shown) {
    entries.push({
      key: String(p.pid),
      label: p.name,
      bytes: p.rssBytes,
      isSelf: false,
      isOther: false
    })
  }
  if (children.length > room) {
    entries.push({
      key: 'other',
      label: 'other',
      bytes: children.slice(room - 1).reduce((n, p) => n + p.rssBytes, 0),
      isSelf: false,
      isOther: true
    })
  }
  return entries.map((e, shade) => ({ ...e, pct: (e.bytes / total) * 100, shade }))
}

export interface ChildEntry {
  key: string
  name: string
  cpuPct: number | null
  rssBytes: number | null
  /** The synthetic "own memory" entry — not a real `/proc` pid. */
  isSelf: boolean
}

/**
 * What an expanded session lists: the own-memory entry first (`selfSample` — `null`,
 * never a misleading 0, when any one reading is unknown), then the real `/proc`
 * children biggest-first. Empty when the session lists no children (nothing to expand).
 */
export function sessionChildren(row: SessionSample): ChildEntry[] {
  if (row.procs.length === 0) return []
  const own = selfSample({ cpuPct: row.cpuPct, rssBytes: row.rssBytes }, row.procs)
  return [
    { key: 'self', name: '', cpuPct: own.cpuPct, rssBytes: own.rssBytes, isSelf: true },
    ...sortByRssDesc(row.procs).map((p) => ({
      key: String(p.pid),
      name: p.name,
      cpuPct: p.cpuPct,
      rssBytes: p.rssBytes,
      isSelf: false
    }))
  ]
}

/**
 * `points` strings for an SVG `<polyline>`: the series scaled to its own min–max
 * inside a 1px inset, oldest left, newest right. A `null` reading breaks the line;
 * a run shorter than two readings draws nothing.
 */
export function sparklinePolylines(
  values: readonly (number | null)[],
  width: number,
  height: number
): string[] {
  const known = values.filter((v): v is number => v !== null)
  if (known.length < 2) return []
  const min = Math.min(...known)
  const max = Math.max(...known)
  const inset = 1
  const usable = height - inset * 2
  const stepX = values.length > 1 ? width / (values.length - 1) : 0
  const y = (v: number): number =>
    max === min ? height / 2 : inset + usable - ((v - min) / (max - min)) * usable
  const lines: string[] = []
  let run: string[] = []
  const flush = (): void => {
    if (run.length >= 2) lines.push(run.join(' '))
    run = []
  }
  values.forEach((v, i) => {
    if (v === null) flush()
    else run.push(`${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`)
  })
  flush()
  return lines
}

export type MonitorView = 'cards' | 'table'
/** localStorage key of the Cards / Table choice (the `om2tab.*` prefix is an invisible legacy namespace). */
export const MONITOR_VIEW_KEY = 'om2tab.systemMonitor.view'

export function parseMonitorView(raw: unknown): MonitorView {
  return raw === 'table' ? 'table' : 'cards'
}

/** The monitor's heap fill — a healthy heap is neutral, not green (the footer gauge keeps its own scale). */
export function monitorHeapFillClass(status: HeapSample['status'] | undefined): string {
  if (status === 'critical') return 'bg-red'
  if (status === 'warn') return 'bg-warning'
  return 'bg-text-3'
}

/** The big heap number's colour, moving with {@link monitorHeapFillClass}. */
export function monitorHeapTextClass(status: HeapSample['status'] | undefined): string {
  if (status === 'critical') return 'text-red'
  if (status === 'warn') return 'text-warning'
  return 'text-text'
}

/** A session row plus what the renderer resolves about its folder — what a card / table row draws. */
export interface SessionView {
  row: SessionSample
  /** The folder alias (or path basename); the raw key when the session is not known locally. */
  name: string
  branch: string | null
  hue: FolderHue
  initial: string
}

/**
 * The table's column template (design.md "Table view"). Shared by the header and every
 * row so the columns line up; below ~760px of table width (a container query on the
 * table) the Last-60s column drops out and so does its track. Kept as whole literal
 * class strings so Tailwind's source scan sees them.
 */
export const TABLE_GRID =
  'grid grid-cols-[minmax(150px,1fr)_150px_52px_76px_minmax(0,1.8fr)] @max-[760px]:grid-cols-[minmax(150px,1fr)_150px_52px_minmax(0,1.8fr)]'
