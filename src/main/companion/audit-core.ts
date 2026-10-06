/**
 * The companion audit record shapes and their serialisation (T389 P1W1 §7.8a, SEC-6). Pure: the
 * file I/O lives in `audit-log.ts`.
 *
 * The MCP audit ring is verb-centric and holds 200 records, so the companion keeps its own log.
 * No record may carry `conn`, a spawn token, the endpoint token or message text (SEC-8):
 * `serializeAudit` refuses a record that does, so a later record kind cannot leak one by accident.
 */

import { createHash } from 'node:crypto'
import type { CmdId, CommandName, Sid } from './contract'
import type { CommandCause, CommandOutcome, EnqueueRefusal } from './command-types'
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

/** Closed, short values; never text. `serializeAudit` refuses a string over `AUDIT_META_MAX`. */
export type AuditMeta = Record<string, string | number | boolean>
export const AUDIT_META_MAX = 64

/** What an outcome keeps in the log: the mod's message and data can carry text, so they stay out. */
export type AuditOutcome =
  { state: 'resulted'; ok: boolean; code?: string } | Exclude<CommandOutcome, { state: 'resulted' }>

/** Two rows share `cmd`: the decision (before the command is queued) and its outcome. */
export interface CommandAuditRecord {
  kind: 'command'
  phase: 'decision' | 'outcome'
  ts: number
  cmd?: CmdId // absent on a refusal
  n?: number
  sessionKey: string | null
  sid?: Sid
  folder: string
  name: CommandName
  cause: CommandCause
  args: { keys: string[]; chars?: number; sha256?: string } // 12 hex chars; never the text
  meta?: AuditMeta // what the enqueuing wave records beside args
  decision?: 'queued' | EnqueueRefusal // phase 'decision'
  outcome?: AuditOutcome // phase 'outcome'
}

/** Later waves add `native-message` (P2W3), `ask` (P3W1) and `focus` (P4W2). */
export type AuditRecord = BindingAuditRecord | CommandAuditRecord

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

/** The shape of an argument object, never its text: key names, serialised length, 12 hex of sha256. */
export function argsDigest(args: unknown): CommandAuditRecord['args'] {
  const keys =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? Object.keys(args).sort()
      : []
  if (keys.length === 0) return { keys }
  const json = JSON.stringify(args)
  return {
    keys,
    chars: json.length,
    sha256: createHash('sha256').update(json).digest('hex').slice(0, 12)
  }
}

export function auditOutcome(o: CommandOutcome): AuditOutcome {
  if (o.state !== 'resulted') return o
  return { state: 'resulted', ok: o.ok, ...(o.code !== undefined ? { code: o.code } : {}) }
}

export type CommandAuditInput = Omit<CommandAuditRecord, 'kind' | 'args'> & { args: unknown }

export function commandAuditRecord(input: CommandAuditInput): CommandAuditRecord {
  const { args, ...rest } = input
  return { kind: 'command', ...rest, args: argsDigest(args) }
}

function scan(value: unknown, depth: number): void {
  if (depth > 6 || typeof value !== 'object' || value === null) return
  for (const [key, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new AuditForbiddenError(key)
    scan(v, depth + 1)
  }
}

/** One ndjson line, newline included. Throws when the record carries a secret-shaped key. */
export function serializeAudit(rec: AuditRecord): string {
  scan(rec, 0)
  if (rec.kind === 'command' && rec.meta) {
    for (const [key, v] of Object.entries(rec.meta)) {
      if (typeof v === 'string' && v.length > AUDIT_META_MAX)
        throw new AuditForbiddenError(`meta.${key}`)
    }
  }
  return `${JSON.stringify(rec)}\n`
}

/** Rotate to `audit.1.ndjson` before the append that would cross the cap. */
export function shouldRotate(currentBytes: number, nextLineBytes: number): boolean {
  return currentBytes + nextLineBytes > AUDIT_MAX_BYTES
}
