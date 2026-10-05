/**
 * The companion audit log (T389 P1W1 §7.8a): `<userData>/companion/audit.ndjson`, mode 0600,
 * append-only, rotated to `audit.1.ndjson` at 1 MiB. One writer, exported for every record kind.
 * The decisions (shape, forbidden keys, when to rotate) are pure in `audit-core.ts`.
 */

import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { serializeAudit, shouldRotate, type AuditRecord } from './audit-core'

let auditDir: string | null = null

/** The `<userData>/companion` directory; it must already exist (the host creates it). */
export function configureAuditDir(dir: string | null): void {
  auditDir = dir
}

/** Appends one record. Throws when the append fails, so a caller can degrade visibly. */
export function appendAudit(rec: AuditRecord): void {
  if (auditDir === null) throw new Error('companion audit log is not configured')
  const line = serializeAudit(rec)
  const file = join(auditDir, 'audit.ndjson')
  const existed = existsSync(file)
  if (existed && shouldRotate(statSync(file).size, Buffer.byteLength(line))) {
    renameSync(file, join(auditDir, 'audit.1.ndjson'))
  }
  const fresh = !existed || !existsSync(file)
  appendFileSync(file, line, { mode: 0o600 })
  if (fresh) chmodSync(file, 0o600) // the create mode is masked by the umask
}
