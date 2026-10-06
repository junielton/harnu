/**
 * Wire → store mapping for `usage.measured` (T389 P1W6 §7.3), pure. The payload is untrusted: a
 * forged reading can misreport a percentage, never grant anything, so every number is checked
 * here (finite, in range) before it reaches the store or a ledger (SEC-3c). Freshness is the host
 * receive time `atMs`, never the mod's clock.
 *
 * Absent is "no new figure": a reading without windows, without a cost or with a window-only
 * context produces a part without that group, and the merge keeps the last value.
 */

import type { RateWindow } from '../../statusline-parse'
import type { CompanionPart } from '../../telemetry-compose-core'

export interface MappedUsage {
  source: 'measure' | 'read'
  part: CompanionPart
  /** `context.tokens`, kept for `lastContextTokens` even when no percent came with it. */
  tokens: number | null
  /** `spend_limit` has no slot in `SessionTelemetry` (OQ-b): recorded in the ledger only. */
  spendLimit?: { percentUsed: number; resetsAtMs: number | null }
  startedAt?: number
  /** Evidence for Q13 only; it feeds no store field. */
  model?: string
  changed: string[]
}

const PERCENT_USED_MAX = 1000

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function windowOf(r: Record<string, unknown>): { usedPercent: number; resetsAtMs: number | null } {
  const at = typeof r.resetsAt === 'string' ? Date.parse(r.resetsAt) : Number.NaN
  return {
    usedPercent: clamp(r.percentUsed as number, 0, PERCENT_USED_MAX),
    resetsAtMs: Number.isFinite(at) ? at : null
  }
}

export function mapUsageMeasured(d: unknown, atMs: number, cwd: string | null): MappedUsage | null {
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return null
  const w = d as Record<string, unknown>
  const part: CompanionPart = { cwd }
  const out: MappedUsage = {
    source: w.source === 'read' ? 'read' : 'measure',
    part,
    tokens: null,
    changed: Array.isArray(w.changed) ? w.changed.filter((u) => typeof u === 'string') : []
  }

  if (finite(w.costUsd) && w.costUsd >= 0) part.cost = { usd: w.costUsd, atMs }

  const c = w.context
  if (typeof c === 'object' && c !== null) {
    const ctx = c as Record<string, unknown>
    if (finite(ctx.tokens) && ctx.tokens >= 0) out.tokens = ctx.tokens
    // Before the first response the context is `{ window }` only (smoke A3): no percent, no
    // reading of the group, so the statusLine keeps writing it.
    if (finite(ctx.window) && ctx.window > 0 && finite(ctx.percent)) {
      part.context = {
        percent: clamp(ctx.percent, 0, 100),
        window: ctx.window,
        ...(out.tokens !== null ? { tokens: out.tokens } : {}),
        atMs
      }
    }
  }

  let fiveHour: RateWindow | null = null
  let sevenDay: RateWindow | null = null
  let known = false
  if (Array.isArray(w.rateLimits)) {
    for (const r of w.rateLimits as Record<string, unknown>[]) {
      if (typeof r !== 'object' || r === null || !finite(r.percentUsed)) continue
      if (r.kind === 'five_hour') {
        fiveHour = windowOf(r)
        known = true
      } else if (r.kind === 'seven_day') {
        sevenDay = windowOf(r)
        known = true
      } else if (r.kind === 'spend_limit') {
        const s = windowOf(r)
        out.spendLimit = { percentUsed: s.usedPercent, resetsAtMs: s.resetsAtMs }
      }
    }
  }
  // `rateLimits: []` is the resume handshake (smoke A2), not a reading: it never clears a window.
  if (known) part.rateLimits = { fiveHour, sevenDay, atMs }

  if (finite(w.startedAt)) out.startedAt = w.startedAt
  if (typeof w.model === 'string' && w.model !== '') out.model = w.model.slice(0, 128)
  return out
}
