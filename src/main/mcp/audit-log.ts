/**
 * Pure audit-log ring for the Harnu MCP server (T4). Every gated tool call lands
 * here as an {@link AuditRecord}; the ring caps at {@link AUDIT_MAX}, dropping the
 * oldest — the same bounded-buffer pattern as the responder-registry shadow ring.
 *
 * This module is intentionally PURE (no `fs`/`electron` import): a thin shell owns
 * the userData file and uses {@link serializeForPersist} / {@link parseFromPersist}
 * to write/restore the ring across restarts. Keeping it pure lands it in the
 * pure-core coverage surface (ADR-0001) and keeps the unit tests deterministic.
 */

/** One audited MCP tool call: the decision, what was disclosed, and the outcome. */
export interface AuditRecord {
  /** Epoch milliseconds when the call was decided. */
  ts: number
  /** The MCP tool name that was invoked (e.g. `harnu_fleet_status`). */
  tool: string
  /** Absolute path of the folder/cwd the call targeted. */
  folder: string
  /** The gate decision (e.g. `allow` / `deny`). */
  verdict: string
  /** Human-readable summary of the payload disclosed to the caller (already redacted). */
  disclosedPayloadSummary: string
  /** Outcome of the call (e.g. `ok` / `blocked` / an error class). */
  result: string
  /**
   * BUG-33 AC2: the derived idempotency call id (`idempotency-registry.ts`),
   * present only on a mutating call. Lets the synthetic `TOOL_TIMEOUT` record
   * and its handler's eventual `late-completion` record be read back as ONE
   * intent instead of two unrelated actions. Omitted on every other record
   * (reads, denials, non-timed-out mutations) — not every call derives one.
   */
  callId?: string
}

/** Maximum records retained in the ring; older entries are evicted on append. */
export const AUDIT_MAX = 200

/** Schema version stamped into the persisted envelope for forward-compat. */
const PERSIST_VERSION = 1

let ring: AuditRecord[] = []

/** Append a record; drops the oldest once over {@link AUDIT_MAX}. */
export function appendAudit(record: AuditRecord): void {
  ring.push(record)
  if (ring.length > AUDIT_MAX) ring.shift()
}

/** A defensive copy of the ring, most recent last. */
export function getAuditLog(): readonly AuditRecord[] {
  return ring.slice()
}

/** Empty the ring. */
export function clearAuditLog(): void {
  ring = []
}

/** Runtime guard: a fully-formed {@link AuditRecord} with the expected field types. */
function isAuditRecord(value: unknown): value is AuditRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  // `callId` is deliberately NOT part of this check — an invalid/malformed
  // callId must not sink an otherwise-valid record; `pick()` sanitizes it.
  return (
    typeof r.ts === 'number' &&
    typeof r.tool === 'string' &&
    typeof r.folder === 'string' &&
    typeof r.verdict === 'string' &&
    typeof r.disclosedPayloadSummary === 'string' &&
    typeof r.result === 'string'
  )
}

/** Normalize to exactly the record shape (drops any extra persisted keys). */
function pick(r: AuditRecord): AuditRecord {
  return {
    ts: r.ts,
    tool: r.tool,
    folder: r.folder,
    verdict: r.verdict,
    disclosedPayloadSummary: r.disclosedPayloadSummary,
    result: r.result,
    ...(typeof r.callId === 'string' ? { callId: r.callId } : {})
  }
}

/** Serialize the current ring to a versioned JSON string for a shell to persist. */
export function serializeForPersist(): string {
  return JSON.stringify({ version: PERSIST_VERSION, records: ring.map(pick) })
}

/**
 * Replace the ring from a persisted string. Resilient: invalid JSON, a missing
 * `records` array, or malformed entries are dropped rather than thrown, and the
 * result is capped at {@link AUDIT_MAX} (most recent kept). Mirrors `readMode`'s
 * never-throws contract in responder-registry.
 */
export function parseFromPersist(raw: string): void {
  let records: AuditRecord[] = []
  try {
    const parsed: unknown = JSON.parse(raw)
    const candidates = (parsed as { records?: unknown })?.records
    if (Array.isArray(candidates)) {
      records = candidates.filter(isAuditRecord).map(pick)
    }
  } catch {
    records = []
  }
  ring = records.length > AUDIT_MAX ? records.slice(records.length - AUDIT_MAX) : records
}
