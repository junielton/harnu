import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendAudit, configureAuditDir } from '../../src/main/companion/audit-log'
import { AUDIT_MAX_BYTES, type BindingAuditRecord } from '../../src/main/companion/audit-core'

let dir: string
const rec = (n: number): BindingAuditRecord => ({
  kind: 'binding',
  ts: n,
  change: 'bound',
  sessionKey: null,
  sid: 's',
  profile: 'interactive',
  trust: 'operator'
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hc-audit-'))
  configureAuditDir(dir)
})
afterEach(() => {
  configureAuditDir(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('audit log shell', () => {
  it('appends ndjson at mode 0600', () => {
    appendAudit(rec(1))
    appendAudit(rec(2))
    const file = join(dir, 'audit.ndjson')
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
    expect(lines.map((l) => JSON.parse(l).ts)).toEqual([1, 2])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('rotates to audit.1.ndjson at 1 MiB', () => {
    writeFileSync(join(dir, 'audit.ndjson'), 'x'.repeat(AUDIT_MAX_BYTES - 10))
    appendAudit(rec(3))
    expect(readFileSync(join(dir, 'audit.1.ndjson'), 'utf8').length).toBe(AUDIT_MAX_BYTES - 10)
    expect(JSON.parse(readFileSync(join(dir, 'audit.ndjson'), 'utf8')).ts).toBe(3)
  })

  it('throws when the append fails, and when no directory is configured', () => {
    configureAuditDir(join(dir, 'missing', 'deeper'))
    expect(() => appendAudit(rec(4))).toThrow()
    configureAuditDir(null)
    expect(() => appendAudit(rec(5))).toThrow(/not configured/)
    expect(existsSync(join(dir, 'audit.ndjson'))).toBe(false)
  })
})
