/**
 * Pure presentational helpers for the System Monitor takeover (design.md
 * "System Monitor (takeover, T127 S2)"). Framework-free, so it's unit-testable in
 * the `node` vitest env — the `.vue` components are thin templates over these,
 * same convention as `usage-dashboard-format.ts`.
 */

import type {
  DeclinedView,
  HeapSample,
  ParkNegotiation,
  ProcSample,
  SessionSample
} from '../../../preload'

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
  return reason === 'lru' || reason === 'hard-idle' || reason === 'declined'
}

// ---- T456: "Asked to stay" chip, its tooltip and the parked-row explanation (spec §6.5) --------

/** The slice of vue-i18n's `t` these formatters use (named params only). */
type Translate = (key: string, params?: Record<string, unknown>) => string

/** `ParkBusyReason` kind → i18n key segment (`systemMonitor.reasonPlain.*` / `declined.reason.*`). */
const REASON_KEY: Record<string, string> = {
  'background-task': 'backgroundTask',
  'background-subagent': 'backgroundSubagent',
  'scheduled-wakeup': 'scheduledWakeup',
  permission: 'permission',
  turn: 'turn',
  'remote-surface': 'remoteSurface'
}
/** The kinds that have a counted (singular/plural) form. */
const COUNTED_REASONS = new Set([
  'backgroundTask',
  'backgroundSubagent',
  'scheduledWakeup',
  'permission'
])

/** `…one` for exactly 1, `…other` otherwise — the app's plural convention, kept out of vue-i18n's pipes. */
function plural(
  t: Translate,
  base: string,
  count: number,
  params: Record<string, unknown> = {}
): string {
  return t(`${base}.${count === 1 ? 'one' : 'other'}`, { ...params, count })
}

/** A reason in plain words, no number: `background task`. An unknown kind shows as itself. */
function plainReason(kind: string, t: Translate): string {
  const key = REASON_KEY[kind]
  return key ? t(`systemMonitor.reasonPlain.${key}`) : kind
}

/** A reason with its count when the session reported one: `2 background tasks`. */
function countedReason(kind: string, count: number | undefined, t: Translate): string {
  const key = REASON_KEY[kind]
  if (key && COUNTED_REASONS.has(key) && count !== undefined && count > 0) {
    return plural(t, `systemMonitor.declined.reason.${key}`, count)
  }
  return plainReason(kind, t)
}

const CHIP_REASONS_SHOWN = 2

/** The chip text: `Asked to stay · 2 background tasks`. At most two reasons, then `+N`. */
export function declinedChipText(d: DeclinedView, t: Translate): string {
  const shown = d.reasons
    .slice(0, CHIP_REASONS_SHOWN)
    .map((kind) => countedReason(kind, d.counts[kind], t))
    .join(', ')
  const rest = d.reasons.length - CHIP_REASONS_SHOWN
  const reasons = rest > 0 ? `${shown} ${t('systemMonitor.declined.more', { count: rest })}` : shown
  return t('systemMonitor.declined.chip', { reasons })
}

/** The chip's tooltip, one line each: every reason, `3 of 8`, and when it asks again. */
export function declinedTooltip(d: DeclinedView, t: Translate): string {
  return [
    t('systemMonitor.declined.tooltipTitle'),
    ...d.reasons.map((kind) => `• ${countedReason(kind, d.counts[kind], t)}`),
    t('systemMonitor.declined.attempts', { count: d.declines, max: d.max }),
    t('systemMonitor.declined.retry', { duration: formatIdle(Math.max(0, d.retryInMs)) })
  ].join('\n')
}

/**
 * The parked row's explanation clause from the park ledger's `negotiation`: one per `why`.
 * `Parked after 8 declines (background task)`, `Parked under memory pressure; the session said busy`.
 */
export function parkedExplanation(n: ParkNegotiation, t: Translate): string {
  const reasons = n.reasons.length
    ? n.reasons.map((kind) => plainReason(kind, t)).join(', ')
    : t('systemMonitor.reasonPlain.unknown')
  const declined = n.declines > 0 || n.reasons.length > 0
  switch (n.why) {
    case 'limit':
      return plural(t, 'systemMonitor.parked.limit', n.declines, { reasons })
    case 'memory-pressure':
      return t(`systemMonitor.parked.memoryPressure.${declined ? 'busy' : 'none'}`)
    case 'operator':
      return declined || n.override
        ? t('systemMonitor.parked.operator.override', { reasons })
        : t('systemMonitor.parked.operator.none')
    case 'free':
    case 'silent':
      return declined
        ? plural(t, `systemMonitor.parked.${n.why}.after`, n.declines, { reasons })
        : t(`systemMonitor.parked.${n.why}.none`)
  }
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
