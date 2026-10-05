import { describe, expect, it } from 'vitest'
import {
  AUDIT_MAX_BYTES,
  AuditForbiddenError,
  bindingAuditRecord,
  serializeAudit,
  shouldRotate,
  type BindingChange
} from '../../src/main/companion/audit-core'
import { SessionTable, type EnablePolicy } from '../../src/main/companion/session-table'
import type { Conn } from '../../src/main/companion/contract'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'

describe('companion audit records (SEC-6, SEC-8)', () => {
  const secrets: string[] = []
  const table = new SessionTable({
    now: () => 1,
    mintConn: () => {
      const c = 'c_0123456789abcdef0123456789abcdef' as Conn
      secrets.push(c)
      return c
    },
    mintToken: () => {
      const tok = 'sp_11111111-2222-4333-8444-555555555555' as const
      secrets.push(tok)
      return tok
    }
  })
  const token = table.mint({
    owner: { kind: 'pty', ptyId: 'pty-1' },
    trust: 'operator',
    cwd: '/tmp/example-project'
  })
  const enable: EnablePolicy = () => ['sense.identity']
  const out = table.hello({ ...helloSpawnRequest, spawn: token }, enable)
  if (!out.ok) throw new Error('hello')
  const view = table.viewOf(out.binding)
  const endpointToken = '99999999-aaaa-4bbb-8ccc-dddddddddddd'

  it('one row per binding change', () => {
    const changes: BindingChange[] = ['bound', 'rebound', 'lease-lost', 'ended', 'revoked']
    const rows = changes.map((change) =>
      bindingAuditRecord(
        change,
        view,
        1_790_000_000_000,
        change === 'rebound' ? 'old-sid' : undefined
      )
    )
    expect(rows.map((r) => r.change)).toEqual(changes)
    for (const r of rows) {
      expect(r.kind).toBe('binding')
      expect(r.ts).toBe(1_790_000_000_000)
      expect(r.sid).toBe(view.sid)
      expect(r.profile).toBe('interactive')
      expect(r.trust).toBe('operator')
      expect(r.sessionKey).toBe(view.sessionKey)
      const line = serializeAudit(r)
      expect(line.endsWith('\n')).toBe(true)
      expect(line.trimEnd()).not.toContain('\n') // ndjson: exactly one line
      expect(JSON.parse(line)).toEqual(r)
      // it contains no conn, token or endpoint token
      for (const s of [...secrets, token, endpointToken]) expect(line).not.toContain(s)
      expect(Object.keys(r).sort()).toEqual(
        (r.change === 'rebound'
          ? ['change', 'kind', 'prevSid', 'profile', 'sessionKey', 'sid', 'trust', 'ts']
          : ['change', 'kind', 'profile', 'sessionKey', 'sid', 'trust', 'ts']
        ).sort()
      )
    }
    expect(rows[1].prevSid).toBe('old-sid')
    expect(rows[0]).not.toHaveProperty('prevSid')
  })

  it('refuses to serialise a record that carries a secret-shaped key', () => {
    const rec = { ...bindingAuditRecord('bound', view, 1), conn: 'c_x' } as never
    expect(() => serializeAudit(rec)).toThrow(AuditForbiddenError)
    for (const key of ['spawn', 'spawnToken', 'token', 'endpointToken', 'text', 'message']) {
      const r = { ...bindingAuditRecord('bound', view, 1), [key]: 'x' } as never
      expect(() => serializeAudit(r)).toThrow(AuditForbiddenError)
    }
  })

  it('rotates to audit.1 once the next line would cross 1 MiB', () => {
    expect(AUDIT_MAX_BYTES).toBe(1024 * 1024)
    expect(shouldRotate(0, 200)).toBe(false)
    expect(shouldRotate(AUDIT_MAX_BYTES - 200, 200)).toBe(false)
    expect(shouldRotate(AUDIT_MAX_BYTES - 199, 200)).toBe(true)
    expect(shouldRotate(AUDIT_MAX_BYTES, 1)).toBe(true)
  })
})
