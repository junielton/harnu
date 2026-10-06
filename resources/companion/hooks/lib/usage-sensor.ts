import type { EventPayloads } from '../contract'

/**
 * The `sense.usage` sensor, pure and `$`-free (spec P1W6 §7.1): it normalizes what
 * `session.measure` and `$.session.usage()` carry into the `usage.measured` payload. Figures and
 * nothing else leave this file: no prompt text, no answer text, no `context.breakdown` (it is
 * never requested). Numbers are passed through as the CLI gave them; the host validates ranges.
 */

type Units = EventPayloads['usage.measured']['changed']
export type UsagePayload = EventPayloads['usage.measured']

/** The part of `SessionContextUsage` the sensor reads. */
interface ContextShape {
  window?: unknown
  tokens?: unknown
  percent?: unknown
}

/** The part of `SessionMeasureInput` / `SessionUsage` the sensor reads. */
export interface UsageShape {
  context?: ContextShape | null
  rateLimits?: unknown
  cost?: { usd?: unknown } | null
  changed?: unknown
  startedAt?: unknown
}

const UNITS: readonly string[] = ['context', 'rateLimits', 'cost']

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function contextOf(c: ContextShape | null | undefined): UsagePayload['context'] {
  if (!c || typeof c !== 'object' || !isNum(c.window)) return undefined
  return {
    window: c.window,
    ...(isNum(c.tokens) ? { tokens: c.tokens } : {}),
    ...(isNum(c.percent) ? { percent: c.percent } : {})
  }
}

/** `{ kind, percentUsed, resetsAt? }` per window; an entry that is not that shape is dropped. */
function limitsOf(raw: unknown): UsagePayload['rateLimits'] {
  if (!Array.isArray(raw)) return []
  const out: UsagePayload['rateLimits'] = []
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r.kind !== 'string' || !isNum(r.percentUsed)) continue
    out.push({
      kind: r.kind,
      percentUsed: r.percentUsed,
      ...(typeof r.resetsAt === 'string' ? { resetsAt: r.resetsAt } : {})
    })
  }
  return out
}

function unitsIn(raw: unknown): Units {
  if (!Array.isArray(raw)) return []
  return raw.filter((u): u is Units[number] => typeof u === 'string' && UNITS.includes(u))
}

function body(u: UsageShape): Omit<UsagePayload, 'source' | 'changed'> {
  const context = contextOf(u.context)
  return {
    ...(context !== undefined ? { context } : {}),
    rateLimits: limitsOf(u.rateLimits),
    ...(u.cost && isNum(u.cost.usd) ? { costUsd: u.cost.usd } : {})
  }
}

/** A `session.measure` event: the figures and the units the CLI says moved. */
export function measurePayload(e: UsageShape): UsagePayload {
  return { source: 'measure', ...body(e), changed: unitsIn(e.changed) }
}

/**
 * The answer of `$.session.usage()` (and `$.session.model()`), sent after a hello, a resync or a
 * flush. A re-send of state, not a moved unit: `changed` names every unit that has a figure so a
 * host that lost the earlier readings can rebuild its picture.
 */
export function readPayload(u: UsageShape, model: unknown): UsagePayload {
  const b = body(u)
  const changed: Units = []
  if (b.context !== undefined) changed.push('context')
  if (b.rateLimits.length > 0) changed.push('rateLimits')
  if (b.costUsd !== undefined) changed.push('cost')
  return {
    source: 'read',
    ...b,
    changed,
    ...(isNum(u.startedAt) ? { startedAt: u.startedAt } : {}),
    ...(typeof model === 'string' && model !== '' ? { model } : {})
  }
}
