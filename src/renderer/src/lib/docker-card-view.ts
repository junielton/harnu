// The Cleanup Docker card's view model (autonomous cleanup U3.7), pure: U3.6's wire records and the
// Containers snapshot go in, what the card draws comes out. No Vue, no i18n, no clock: the
// components word the result, so every sentence stays translatable.

import type {
  DockerCapacityView,
  DockerReportItem,
  DockerReportKind,
  DockerWatchRecord
} from '../../../main/gc/gc-wire'
import type { PausedStack, Tombstone } from '../../../main/containers/containers-wire'

/** The newest automatic actions the card lists before "Show all in Activity". */
export const ACTION_ROWS_MAX = 5
/** The Paused stacks the card lists before "+ n more in Inspect stacks". */
export const PAUSED_ROWS_MAX = 3

// ---------------------------------------------------------------------------------------------
// Network slots

export type SlotsState =
  | {
      kind: 'known'
      /** `low`: at or below the mark; `zero`: nothing free. */
      level: 'ok' | 'low' | 'zero'
      free: number
      total: number
      source: 'daemon.json' | 'default'
      /** `off`/`paused`: Cleanup is not acting, so a low state says nothing will be freed. */
      autonomy: 'on' | 'off' | 'paused'
    }
  | { kind: 'unknown'; reason: string | null }

/** What the capacity block shows, from the watcher's last pass (null before it has read anything). */
export function slotsState(watch: DockerWatchRecord | null, mark: number): SlotsState {
  const c = watch?.capacity ?? null
  if (!watch || !c) return { kind: 'unknown', reason: null }
  if (!c.known) return { kind: 'unknown', reason: c.reason }
  return {
    kind: 'known',
    level: c.free <= 0 ? 'zero' : c.free <= mark ? 'low' : 'ok',
    free: c.free,
    total: c.total,
    source: c.source,
    autonomy: watch.mode === 'off' ? 'off' : watch.mode === 'paused' ? 'paused' : 'on'
  }
}

// ---------------------------------------------------------------------------------------------
// Automatic actions

/** What an automatic action did, structured so the card can word it in the app's language. */
export type ActionFacts =
  | { kind: 'network'; target: string }
  | { kind: 'orphan'; target: string; volumes: string[] }
  | { kind: 'pause'; target: string; idle: string | null }
  | { kind: null; raw: string }

export type ActionRow = ActionFacts & {
  /** Stable key for the list. */
  id: string
  /** Epoch ms of the journal line; null for a would-have row (nothing happened yet). */
  at: number | null
  /** A report-only row: the verb is future ("would have"), nothing was changed. */
  would: boolean
}

const NETWORK_RE = /^Removed empty network `([^`]+)` — no containers$/
const ORPHAN_RE = /^Removed orphan stack `([^`]+)` — worktree gone, volumes kept(?:: (.+))?$/
const PAUSE_RE = /^Paused `([^`]+)` — idle ([^·]+?)(?: · bring back: .*)?$/
const IDLE_RE = /^idle (.+)$/

/** Whether `reason` is one of the sentences the journal and the first-report list are known to carry. */
export function reasonIsKnown(reason: string): boolean {
  return (
    NETWORK_RE.test(reason) ||
    ORPHAN_RE.test(reason) ||
    PAUSE_RE.test(reason) ||
    IDLE_RE.test(reason)
  )
}

/**
 * Reads one of the English sentences the journal and the first-report list carry. A report item
 * names its own kind and target, so a sentence it does not recognise still gets a row; a bare
 * sentence it does not recognise comes back as `raw` (never a throw, never a blank row).
 */
export function describeAction(item: {
  kind?: DockerReportKind
  target?: string
  reason: string
}): ActionFacts {
  const r = item.reason
  const network = NETWORK_RE.exec(r)
  if (network) return { kind: 'network', target: network[1]! }
  const orphan = ORPHAN_RE.exec(r)
  if (orphan) {
    return {
      kind: 'orphan',
      target: orphan[1]!,
      volumes: orphan[2] ? orphan[2].split(', ') : []
    }
  }
  const pause = PAUSE_RE.exec(r)
  if (pause) return { kind: 'pause', target: pause[1]!, idle: pause[2]!.trim() }
  if (item.kind && item.target) {
    if (item.kind === 'network') return { kind: 'network', target: item.target }
    if (item.kind === 'orphan') return { kind: 'orphan', target: item.target, volumes: [] }
    return { kind: 'pause', target: item.target, idle: IDLE_RE.exec(r)?.[1]?.trim() ?? null }
  }
  return { kind: null, raw: r }
}

/** The journal line's own structure, for a sentence the parser does not know. */
function structuralKind(t: Tombstone): DockerReportKind | null {
  if (t.stacks.some((s) => s.paused)) return 'pause'
  if (t.stacks.some((s) => s.keptVolumeOwner)) return 'orphan'
  if (t.verb === 'remove' && t.stacks.length === 0) return 'network'
  return null
}

/**
 * The newest automatic Docker actions: the autopilot's pauses, orphan-stack removals and empty-network
 * removals, newest first. The stop that precedes an orphan removal, operator lines and lines written
 * before reasons existed are not actions to show.
 */
export function automaticActions(
  recent: readonly Tombstone[],
  limit = ACTION_ROWS_MAX
): ActionRow[] {
  const rows: ActionRow[] = []
  for (const t of [...recent].sort((a, b) => b.at - a.at)) {
    if (rows.length >= limit) break
    if (t.actor !== 'autopilot' || !t.reason) continue
    const kind = structuralKind(t)
    if (!kind) continue
    const target = t.stacks[0]?.name
    const facts = describeAction({ kind, target, reason: t.reason })
    rows.push({ ...facts, id: `${t.at}:${t.stacks[0]?.stack ?? kind}`, at: t.at, would: false })
  }
  return rows
}

/** The report-only list as "would have" rows (the first cycle changed nothing). */
export function wouldHaveRows(
  report: { items: readonly DockerReportItem[]; found: number } | null,
  limit = ACTION_ROWS_MAX
): ActionRow[] {
  if (!report) return []
  return report.items.slice(0, limit).map((item, i) => ({
    ...describeAction(item),
    id: `would:${i}:${item.kind}:${item.target}`,
    at: null,
    would: true
  }))
}

// ---------------------------------------------------------------------------------------------
// Folded rows: one per pass and kind (the approved mockup's list)

/**
 * The journal has no pass id, so a pass is a run of actions with no gap longer than this between
 * neighbours: a cycle or a watcher pass does its work back to back, minutes apart at the very most.
 */
export const PASS_GAP_MS = 3 * 60_000

/** One row of "Automatic actions": the actions of one pass that share a kind. */
export interface ActionGroup {
  id: string
  /** Null only for a line the card cannot classify; such a line is its own row. */
  kind: DockerReportKind | null
  count: number
  /** Volumes the removed orphan stacks kept (orphan rows only, else 0). */
  volumes: number
  /** The networks or stacks touched, newest first. */
  names: string[]
  /** Epoch ms of the newest action; null for a would-have row (nothing happened yet). */
  at: number | null
  would: boolean
  /** Shortest idle time among the paused stacks, in minutes (pause rows only). */
  idleMinutes: number | null
  /** The per-item lines, with their reasons, newest first. */
  items: ActionRow[]
}

const IDLE_UNIT_MINUTES = { min: 1, h: 60, d: 1440 } as const

/** `3 h` → 180, `40 min` → 40; null for anything else. */
function idleToMinutes(idle: string | null | undefined): number | null {
  const m = /^(\d+)\s*(min|h|d)$/.exec((idle ?? '').trim())
  return m ? Number(m[1]) * IDLE_UNIT_MINUTES[m[2] as keyof typeof IDLE_UNIT_MINUTES] : null
}

function foldRows(rows: readonly ActionRow[], idPrefix: string): ActionGroup[] {
  const groups: ActionGroup[] = []
  const byKind = new Map<string, ActionGroup>()
  const flushPass = (): void => byKind.clear()
  let prev: ActionRow | null = null
  for (const row of rows) {
    if (prev && prev.at !== null && row.at !== null && prev.at - row.at > PASS_GAP_MS) flushPass()
    prev = row
    const existing = row.kind === null ? undefined : byKind.get(row.kind)
    const g: ActionGroup =
      existing ??
      ({
        id: `${idPrefix}:${row.at ?? 'plan'}:${row.kind ?? row.id}`,
        kind: row.kind,
        count: 0,
        volumes: 0,
        names: [],
        at: row.at,
        would: row.would,
        idleMinutes: null,
        items: []
      } satisfies ActionGroup)
    if (!existing) {
      groups.push(g)
      if (row.kind !== null) byKind.set(row.kind, g)
    }
    g.count += 1
    g.items.push(row)
    if (row.kind === null) continue
    g.names.push(row.target)
    if (row.kind === 'orphan') g.volumes += row.volumes.length
    if (row.kind === 'pause') {
      const m = idleToMinutes(row.idle)
      if (m !== null) g.idleMinutes = g.idleMinutes === null ? m : Math.min(g.idleMinutes, m)
    }
  }
  return groups
}

/** The newest automatic actions folded one row per pass and kind; "newest N" counts folded rows. */
export function automaticActionGroups(
  recent: readonly Tombstone[],
  limit = ACTION_ROWS_MAX
): ActionGroup[] {
  return foldRows(automaticActions(recent, Number.POSITIVE_INFINITY), 'done').slice(0, limit)
}

/** The first-report plan folded by kind (a plan is one pass, so time plays no part). */
export function wouldHaveGroups(
  report: { items: readonly DockerReportItem[]; found: number } | null,
  limit = ACTION_ROWS_MAX
): ActionGroup[] {
  if (!report) return []
  const rows = wouldHaveRows(report, Number.POSITIVE_INFINITY)
  const byKind = new Map<string, ActionRow[]>()
  const order: string[] = []
  for (const r of rows) {
    const k = r.kind ?? `raw:${r.id}`
    if (!byKind.has(k)) {
      byKind.set(k, [])
      order.push(k)
    }
    byKind.get(k)!.push(r)
  }
  return order.flatMap((k) => foldRows(byKind.get(k)!, 'would')).slice(0, limit)
}

// ---------------------------------------------------------------------------------------------
// Paused stacks

export interface PausedRow {
  name: string
  /** Milliseconds since the pause. */
  ageMs: number
  restoreCommand: string
}

/** The Paused rows (newest first, three) and how many more there are. */
export function pausedRows(
  paused: readonly PausedStack[],
  now: number
): { rows: PausedRow[]; more: number; total: number } {
  const sorted = [...paused].sort((a, b) => b.pausedAt - a.pausedAt)
  return {
    rows: sorted.slice(0, PAUSED_ROWS_MAX).map((p) => ({
      name: p.name,
      ageMs: Math.max(0, now - p.pausedAt),
      restoreCommand: p.restoreCommand
    })),
    more: Math.max(0, sorted.length - PAUSED_ROWS_MAX),
    total: sorted.length
  }
}

// ---------------------------------------------------------------------------------------------
// Address-pool advice

/** Shown in the advice dialog and copied verbatim; a 256-network pool of /24s. Harnu never writes it. */
export const POOL_ADVICE_SNIPPET = `{
  "default-address-pools": [
    { "base": "10.200.0.0/16", "size": 24 }
  ]
}`

/** What the operator was shown: a squeeze seen, and the advice dismissed, each for a set of pools. */
export interface PoolAdviceState {
  squeezeSeenFor: string | null
  dismissedFor: string | null
}

/** The engine's pools as one key: advice is per pools, so it returns when they change. */
export function poolsKey(c: { total: number; source: 'daemon.json' | 'default' }): string {
  return `${c.source}:${c.total}`
}

/**
 * Whether the one-time callout shows: the engine uses Docker's default pools, a squeeze was seen on
 * THESE pools, and the advice was not dismissed for them.
 */
export function adviceOffer(args: {
  capacity: DockerCapacityView | null
  state: PoolAdviceState
}): boolean {
  const c = args.capacity
  if (!c || !c.known || c.source !== 'default') return false
  const key = poolsKey(c)
  return args.state.squeezeSeenFor === key && args.state.dismissedFor !== key
}
