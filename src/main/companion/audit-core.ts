/**
 * The companion audit record shapes and their serialisation (T389 P1W1 §7.8a, SEC-6). Pure: the
 * file I/O lives in `audit-log.ts`.
 *
 * The MCP audit ring is verb-centric and holds 200 records, so the companion keeps its own log.
 * No record may carry `conn`, a spawn token, the endpoint token or message text (SEC-8):
 * `serializeAudit` refuses a record that does, so a later record kind cannot leak one by accident.
 */

import type { Sid } from './contract'
import type { BindingView, TrustClass } from './session-table'

export const AUDIT_MAX_BYTES = 1024 * 1024

export type BindingChange = 'bound' | 'rebound' | 'lease-lost' | 'ended' | 'revoked'

export interface BindingAuditRecord {
  kind: 'binding'
  ts: number
  change: BindingChange
  sessionKey: string | null
  sid: Sid
  prevSid?: Sid
  profile: 'interactive' | 'headless' | 'external'
  trust: TrustClass
}

/**
 * P4W3: the host refused to hand a command to an outside session. The command NAME only: never
 * its arguments, never any text (SEC-8).
 */
export interface CommandRefusedAuditRecord {
  kind: 'command-refused'
  ts: number
  command: string
  sid: Sid
  sessionKey: string | null
  /** Outside facts are attributable, not authenticated (P4W3-S7). */
  profile: 'external'
}

/** Later waves add `command` (P2W1), `native-message` (P2W3), `ask` (P3W1) and `focus` (P4W2). */
export type AuditRecord = BindingAuditRecord | CommandRefusedAuditRecord

export class AuditForbiddenError extends Error {
  constructor(key: string) {
    super(`audit record carries a forbidden key: ${key}`)
    this.name = 'AuditForbiddenError'
  }
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'conn',
  'prevConn',
  'spawn',
  'spawnToken',
  'token',
  'endpointToken',
  'bearer',
  'text',
  'message'
])

export function bindingAuditRecord(
  change: BindingChange,
  view: Pick<BindingView, 'sessionKey' | 'sid' | 'profile' | 'trust'>,
  ts: number,
  prevSid?: Sid
): BindingAuditRecord {
  const rec: BindingAuditRecord = {
    kind: 'binding',
    ts,
    change,
    sessionKey: view.sessionKey,
    sid: view.sid,
    profile: view.profile,
    trust: view.trust
  }
  if (prevSid !== undefined) rec.prevSid = prevSid
  return rec
}

/** One ndjson line, newline included. Throws when the record carries a secret-shaped key. */
export function serializeAudit(rec: AuditRecord): string {
  for (const key of Object.keys(rec)) {
    if (FORBIDDEN_KEYS.has(key)) throw new AuditForbiddenError(key)
  }
  return `${JSON.stringify(rec)}\n`
}

/** Rotate to `audit.1.ndjson` before the append that would cross the cap. */
export function shouldRotate(currentBytes: number, nextLineBytes: number): boolean {
  return currentBytes + nextLineBytes > AUDIT_MAX_BYTES
}
