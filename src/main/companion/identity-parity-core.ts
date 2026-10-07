/**
 * The identity parity record (T389 P1W3 §7.9, §13). Pure: no I/O, no clock, no Electron.
 *
 * For every Harnu-spawned session the host records ONE comparison between what the companion
 * claimed (hello, rebound) and what the legacy binders did (`fireMigrate`'s outcome). In
 * `shadow` this is the evidence for the `identity` family's gate (ARB-6c); P1W4's ledger rule
 * consumes these records. Everything that derives from an id is a hash, and no record carries a
 * path or text (QA-9, SEC-8).
 */

import { createHash } from 'node:crypto'

export type IdentityShape =
  'new' | 'fork' | 'resume' | 'agent' | 'clear' | 'in-session-resume' | 'tick'

export type LegacyVia = 'agent-correlation' | 'collapse' | 'resolved-window'

export type IdentityVerdict = 'match' | 'mismatch' | 'companion-only' | 'legacy-only' | 'conflict'

export interface IdentityParityRecord {
  family: 'identity'
  at: number
  shape: IdentityShape
  companion: { keyHash: string; sidHash: string; helloAfterSpawnMs: number } | null
  legacy: { keyHash: string; via: LegacyVia; afterSpawnMs: number } | null
  verdict: IdentityVerdict
}

/** The unscrubbed facts of one comparison. Never stored: `compareIdentity` hashes them. */
export interface ParityInput {
  shape: IdentityShape
  companion: { key: string; sid: string; helloAfterSpawnMs: number } | null
  legacy: { key: string; sid: string; via: LegacyVia; afterSpawnMs: number } | null
  /** The companion's sid is live under another row: it made no claim. */
  conflict?: boolean
}

/** A stable, short, one-way label: equal ids hash equal, so records stay comparable. */
export function hashId(id: string): string {
  return createHash('sha256').update(`harnu-parity\n${id}`).digest('hex').slice(0, 12)
}

export function compareIdentity(input: ParityInput, at: number): IdentityParityRecord {
  const { companion, legacy } = input
  let verdict: IdentityVerdict
  if (input.conflict) verdict = 'conflict'
  else if (companion && legacy) {
    verdict = companion.key === legacy.key && companion.sid === legacy.sid ? 'match' : 'mismatch'
  } else if (companion) verdict = 'companion-only'
  else verdict = 'legacy-only'
  return {
    family: 'identity',
    at,
    shape: input.shape,
    companion: companion
      ? {
          keyHash: hashId(companion.key),
          sidHash: hashId(companion.sid),
          helloAfterSpawnMs: companion.helloAfterSpawnMs
        }
      : null,
    legacy: legacy
      ? { keyHash: hashId(legacy.key), via: legacy.via, afterSpawnMs: legacy.afterSpawnMs }
      : null,
    verdict
  }
}

export interface ParitySink {
  add(rec: IdentityParityRecord): void
  list(): IdentityParityRecord[]
  summary(): { total: number; byVerdict: Partial<Record<IdentityVerdict, number>> }
}

/** An in-memory ring of the newest `max` records, plus counters that never roll off. */
export function createParitySink(max: number): ParitySink {
  let records: IdentityParityRecord[] = []
  let total = 0
  const byVerdict: Partial<Record<IdentityVerdict, number>> = {}
  return {
    add(rec) {
      records.push(rec)
      if (records.length > max) records = records.slice(records.length - max)
      total++
      byVerdict[rec.verdict] = (byVerdict[rec.verdict] ?? 0) + 1
    },
    list: () => records.map((r) => ({ ...r })),
    summary: () => ({ total, byVerdict: { ...byVerdict } })
  }
}
