/**
 * Pure parser + transition logic for the Claude service-status widget
 * (issue #17). Kept free of Electron/Node side effects so it is unit-testable
 * in the `node` vitest env (`tests/claude-status-parse.test.ts`). The imperative
 * poll + Notification + IPC shell lives in `claude-status.ts`; this module only
 * turns Atlassian Statuspage JSON into a snapshot and decides which transitions
 * deserve a native notification.
 *
 * Data source: `https://status.claude.com/api/v2/summary.json` — overall status
 * + every component + active incidents + scheduled maintenances in one GET.
 */

/**
 * Normalized severity, mapped to a design token by the renderer (no new tokens):
 * operational→`--color-green`, degraded→`--color-warning`, outage→`--color-red`,
 * maintenance→`--color-accent`, unknown→`--color-text-3`.
 */
export type Severity = 'operational' | 'degraded' | 'outage' | 'maintenance' | 'unknown'

/** One Statuspage component row (a group container is dropped, not surfaced). */
export interface StatusComponent {
  id: string
  name: string
  severity: Severity
  /** Raw Statuspage status, e.g. `degraded_performance`, for the title tooltip. */
  statusText: string
}

/** One active (unresolved) incident. Resolved incidents drop off the summary. */
export interface StatusIncident {
  id: string
  name: string
  /** `investigating` | `identified` | `monitoring` | (rarely) `resolved`. */
  status: string
  /** Mapped from the incident `impact` field. */
  severity: Severity
  /** Public short URL to the incident page. */
  shortlink: string
  startedAtMs: number | null
  updatedAtMs: number | null
}

/** One scheduled maintenance window (shown in the panel only — no alerts in v1). */
export interface StatusMaintenance {
  id: string
  name: string
  /** `scheduled` | `in_progress` | `verifying` | `completed`. */
  status: string
  scheduledForMs: number | null
  scheduledUntilMs: number | null
}

/**
 * Renderer-facing snapshot. `severity` is the headline (the footer dot color);
 * `description` is the page's own one-liner ("All Systems Operational"). On a
 * fetch failure we keep the last-good components/incidents and flip `severity`
 * to `unknown` + `stale` — never a false red.
 */
export interface ClaudeStatusSnapshot {
  severity: Severity
  /** Raw Statuspage indicator (`none`/`minor`/`major`/`critical`/`maintenance`). */
  indicator: string
  description: string
  components: StatusComponent[]
  incidents: StatusIncident[]
  maintenances: StatusMaintenance[]
  /** Epoch ms the displayed data was fetched (stays put while `stale`). */
  fetchedAtMs: number
  stale: boolean
}

/** Outcome of one summary.json GET. `json` is parsed-but-untrusted. */
export type StatusRunOutcome = { ok: true; json: unknown } | { ok: false }

/** Notification preferences pushed from the renderer (localStorage-backed). */
export interface StatusNotifyPrefs {
  /** Master mute for service-status notifications (`om2tab.claudeStatusNotify`). */
  notify: boolean
}

/** A transition the poller decided is worth a native toast. */
export interface StatusNotification {
  kind: 'incident-open' | 'incident-resolved' | 'worsened' | 'recovered'
  /** Incident id for open/resolved; '' for whole-page severity transitions. */
  id: string
  title: string
  body: string
}

// ── severity maps ────────────────────────────────────────────────────────────

/** Map the page-level `status.indicator` to our severity. */
export function severityOfIndicator(indicator: unknown): Severity {
  switch (indicator) {
    case 'none':
      return 'operational'
    case 'minor':
      return 'degraded'
    case 'major':
    case 'critical':
      return 'outage'
    case 'maintenance':
      return 'maintenance'
    default:
      return 'unknown'
  }
}

/** Map a component-level `status` to our severity. */
export function severityOfComponent(status: unknown): Severity {
  switch (status) {
    case 'operational':
      return 'operational'
    case 'degraded_performance':
    case 'partial_outage':
      return 'degraded'
    case 'major_outage':
      return 'outage'
    case 'under_maintenance':
      return 'maintenance'
    default:
      return 'unknown'
  }
}

/** Map an incident `impact` to our severity. */
export function severityOfImpact(impact: unknown): Severity {
  switch (impact) {
    case 'none':
      return 'operational'
    case 'minor':
      return 'degraded'
    case 'major':
    case 'critical':
      return 'outage'
    case 'maintenance':
      return 'maintenance'
    default:
      return 'unknown'
  }
}

/**
 * Ordinal for "worsened vs recovered" comparisons. `unknown` is intentionally
 * excluded — callers guard on it so a network blip (→ unknown) never reads as a
 * recovery or a worsening.
 */
export function severityRank(s: Severity): number {
  switch (s) {
    case 'operational':
      return 0
    case 'maintenance':
      return 1
    case 'degraded':
      return 2
    case 'outage':
      return 3
    default:
      return -1
  }
}

// ── parsing ──────────────────────────────────────────────────────────────────

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function toMs(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/**
 * Parse a Statuspage `summary.json` body into a snapshot. Defensive over
 * `unknown` — any missing/odd field degrades to empty rather than throwing, so a
 * schema drift can't crash the poller.
 */
export function parseSummary(json: unknown, nowMs: number): ClaudeStatusSnapshot {
  const root = asObject(json)
  const status = asObject(root.status)
  const indicator = asString(status.indicator)

  const rawComponents = Array.isArray(root.components) ? root.components : []
  const components: StatusComponent[] = rawComponents
    // Group rows (`group: true`) are container headers, not real components.
    .filter((c) => asObject(c).group !== true)
    .map((c) => {
      const o = asObject(c)
      return {
        id: asString(o.id),
        name: asString(o.name),
        severity: severityOfComponent(o.status),
        statusText: asString(o.status)
      }
    })

  const rawIncidents = Array.isArray(root.incidents) ? root.incidents : []
  const incidents: StatusIncident[] = rawIncidents
    .map((i) => {
      const o = asObject(i)
      return {
        id: asString(o.id),
        name: asString(o.name),
        status: asString(o.status),
        severity: severityOfImpact(o.impact),
        shortlink: asString(o.shortlink),
        startedAtMs: toMs(o.started_at),
        updatedAtMs: toMs(o.updated_at)
      }
    })
    // Defensive: only surface unresolved incidents (the summary already filters,
    // but a stray `resolved` must not count as active for the diff).
    .filter((i) => i.id !== '' && i.status !== 'resolved')

  const rawMaint = Array.isArray(root.scheduled_maintenances) ? root.scheduled_maintenances : []
  const maintenances: StatusMaintenance[] = rawMaint
    .map((m) => {
      const o = asObject(m)
      return {
        id: asString(o.id),
        name: asString(o.name),
        status: asString(o.status),
        scheduledForMs: toMs(o.scheduled_for),
        scheduledUntilMs: toMs(o.scheduled_until)
      }
    })
    .filter((m) => m.id !== '' && m.status !== 'completed')

  return {
    severity: severityOfIndicator(indicator),
    indicator,
    description: asString(status.description),
    components,
    incidents,
    maintenances,
    fetchedAtMs: nowMs,
    stale: false
  }
}

/**
 * Fold one run outcome into a snapshot.
 *
 * - **Success** → authoritative parse.
 * - **Failure with prior data** → keep the last-good components/incidents but
 *   flip `severity` to `unknown` + `stale` (offline ≠ Anthropic down → neutral
 *   grey dot, never a false red). `fetchedAtMs` stays put.
 * - **Failure with no prior data** (cold offline start) → an empty `unknown`
 *   snapshot.
 */
export function buildSnapshot(
  prev: ClaudeStatusSnapshot | null,
  outcome: StatusRunOutcome,
  nowMs: number
): ClaudeStatusSnapshot {
  if (outcome.ok) return parseSummary(outcome.json, nowMs)
  if (prev) return { ...prev, severity: 'unknown', stale: true }
  return {
    severity: 'unknown',
    indicator: '',
    description: '',
    components: [],
    incidents: [],
    maintenances: [],
    fetchedAtMs: nowMs,
    stale: false
  }
}

// ── transition decision ──────────────────────────────────────────────────────

/**
 * Decide which native notifications a `prev → next` transition warrants. Pure +
 * unit-tested — the imperative shell only renders the returned descriptors.
 *
 * Rules (issue #17 "Notification model"):
 * - **baseline** (`prev === null`) → nothing (cold start only paints the dot, so
 *   we never re-alert about an already-known incident on every launch).
 * - **mute** (`!prefs.notify`) → nothing.
 * - **incident opened / resolved** — deduped by `id`; a status change on the
 *   same incident does NOT re-fire. Open = id newly active; resolved = an id that
 *   was active in `prev` is gone from `next`.
 * - **overall severity worsened / recovered** — only when no incident-level
 *   notification fired (those are more specific), and only between two *known*
 *   severities (an `unknown` on either side — a network blip — is never an alert).
 */
export function diffStatus(
  prev: ClaudeStatusSnapshot | null,
  next: ClaudeStatusSnapshot,
  prefs: StatusNotifyPrefs
): StatusNotification[] {
  if (prev === null) return []
  if (!prefs.notify) return []

  const out: StatusNotification[] = []
  const prevActive = new Map(prev.incidents.map((i) => [i.id, i]))
  const nextActive = new Map(next.incidents.map((i) => [i.id, i]))

  for (const [id, inc] of nextActive) {
    if (!prevActive.has(id)) {
      out.push({
        kind: 'incident-open',
        id,
        title: 'Claude service incident',
        body: inc.name
      })
    }
  }
  for (const [id, inc] of prevActive) {
    if (!nextActive.has(id)) {
      out.push({
        kind: 'incident-resolved',
        id,
        title: 'Claude service recovered',
        body: `${inc.name} — resolved`
      })
    }
  }
  // Incident-level notifications are more specific; don't double-toast with a
  // whole-page severity change for the same event.
  if (out.length > 0) return out

  // Severity transitions only between two known states.
  if (prev.severity === 'unknown' || next.severity === 'unknown') return []
  const dp = severityRank(prev.severity)
  const dn = severityRank(next.severity)
  if (dn > dp) {
    return [
      {
        kind: 'worsened',
        id: '',
        title: 'Claude service degraded',
        body: next.description || next.severity
      }
    ]
  }
  if (dn < dp) {
    return [
      {
        kind: 'recovered',
        id: '',
        title: 'Claude service operational',
        body: next.description || next.severity
      }
    ]
  }
  return []
}
