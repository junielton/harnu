import { describe, it, expect, beforeEach } from 'vitest'

/**
 * T4: pure audit-log ring + persist (de)serialize. Mirrors the responder-registry
 * shadow-ring tests — no fs/electron here. The ring caps at AUDIT_MAX (oldest
 * dropped), `getAuditLog()` returns a defensive copy, and serialize/parse
 * round-trip so a thin shell can persist to a userData file.
 */
import { messageAuditSummary } from '../src/main/messaging-socket'
import {
  appendAudit,
  getAuditLog,
  clearAuditLog,
  serializeForPersist,
  parseFromPersist,
  AUDIT_MAX,
  type AuditRecord
} from '../src/main/mcp/audit-log'

/** Factory for an audit record; `over` wins over the defaults. */
const rec = (i: number, over: Partial<AuditRecord> = {}): AuditRecord => ({
  ts: i,
  tool: 'harnu_fleet_status',
  folder: '/home/u/repo',
  verdict: 'allow',
  disclosedPayloadSummary: `summary #${i}`,
  result: 'ok',
  ...over
})

beforeEach(() => {
  clearAuditLog()
})

describe('audit ring', () => {
  it('appends in insertion order (most recent last)', () => {
    appendAudit(rec(1))
    appendAudit(rec(2))
    expect(getAuditLog().map((e) => e.ts)).toEqual([1, 2])
  })

  it('caps at AUDIT_MAX, discarding the oldest', () => {
    for (let i = 0; i < AUDIT_MAX + 5; i++) appendAudit(rec(i))
    const log = getAuditLog()
    expect(log).toHaveLength(AUDIT_MAX)
    // The first 5 pushed (0..4) were dropped; oldest survivor is #5.
    expect(log[0].ts).toBe(5)
    expect(log[log.length - 1].ts).toBe(AUDIT_MAX + 4)
  })

  it('getAuditLog returns a copy (mutating the result does not affect the ring)', () => {
    appendAudit(rec(1))
    const log = getAuditLog()
    ;(log as AuditRecord[]).push(rec(99))
    expect(getAuditLog()).toHaveLength(1)
  })

  it('clearAuditLog empties the ring', () => {
    appendAudit(rec(1))
    clearAuditLog()
    expect(getAuditLog()).toHaveLength(0)
  })

  it('a record carries {ts,tool,folder,verdict,disclosedPayloadSummary,result}', () => {
    const r = rec(7, {
      tool: 'harnu_session_send',
      folder: '/srv/app',
      verdict: 'deny',
      disclosedPayloadSummary: 'session=abc, text=<redacted 12b>',
      result: 'blocked'
    })
    appendAudit(r)
    expect(getAuditLog()[0]).toEqual({
      ts: 7,
      tool: 'harnu_session_send',
      folder: '/srv/app',
      verdict: 'deny',
      disclosedPayloadSummary: 'session=abc, text=<redacted 12b>',
      result: 'blocked'
    })
  })
})

describe('audit ring — callId correlation (BUG-33 AC2)', () => {
  it('an optional callId is preserved on the record', () => {
    appendAudit(
      rec(1, { verdict: 'timeout', result: 'TOOL_TIMEOUT', callId: 'create_session:abc' })
    )
    expect(getAuditLog()[0].callId).toBe('create_session:abc')
  })

  it('a record with no callId omits the field (backward compatible with existing callers)', () => {
    appendAudit(rec(1))
    expect(getAuditLog()[0].callId).toBeUndefined()
    expect('callId' in getAuditLog()[0]).toBe(false)
  })

  it('the synthetic timeout record and the late-completion record can share a callId', () => {
    appendAudit(
      rec(1, { verdict: 'timeout', result: 'TOOL_TIMEOUT', callId: 'create_worktree:xyz' })
    )
    appendAudit(rec(2, { verdict: 'late-completion', result: 'ok', callId: 'create_worktree:xyz' }))
    const [timeoutRec, lateRec] = getAuditLog()
    expect(timeoutRec.callId).toBe(lateRec.callId)
  })

  it('round-trips callId through serializeForPersist/parseFromPersist', () => {
    appendAudit(rec(1, { callId: 'submit_manifest:def' }))
    const raw = serializeForPersist()
    clearAuditLog()
    parseFromPersist(raw)
    expect(getAuditLog()[0].callId).toBe('submit_manifest:def')
  })

  it('drops a non-string callId on parse (defensive) but keeps the rest of the record', () => {
    const raw = JSON.stringify({
      version: 1,
      records: [{ ...rec(1), callId: 123 }]
    })
    parseFromPersist(raw)
    expect(getAuditLog()[0].callId).toBeUndefined()
  })
})

describe('serializeForPersist / parseFromPersist', () => {
  it('round-trips the ring through a string', () => {
    appendAudit(rec(1))
    appendAudit(rec(2))
    const raw = serializeForPersist()
    expect(typeof raw).toBe('string')
    clearAuditLog()
    expect(getAuditLog()).toHaveLength(0)
    parseFromPersist(raw)
    expect(getAuditLog()).toEqual([rec(1), rec(2)])
  })

  it('never throws on invalid JSON; the ring stays empty', () => {
    parseFromPersist('{not json')
    expect(getAuditLog()).toHaveLength(0)
  })

  it('drops malformed records on parse (resilient restore)', () => {
    const raw = JSON.stringify({ version: 1, records: [rec(1), { bogus: true }, rec(2)] })
    parseFromPersist(raw)
    expect(getAuditLog()).toEqual([rec(1), rec(2)])
  })

  it('parse replaces the ring and caps at AUDIT_MAX (most recent kept)', () => {
    appendAudit(rec(900))
    const many = Array.from({ length: AUDIT_MAX + 3 }, (_, i) => rec(i))
    parseFromPersist(JSON.stringify({ version: 1, records: many }))
    const log = getAuditLog()
    expect(log).toHaveLength(AUDIT_MAX)
    expect(log[0].ts).toBe(3)
    expect(log[log.length - 1].ts).toBe(AUDIT_MAX + 2)
  })
})

describe('T215 — a brokered peer message lands in the ring WITHOUT its body', () => {
  beforeEach(() => clearAuditLog())

  it('the row names the recipient, the pid, the length and a HASH', () => {
    const body = 'ship it, the deploy token is hunter2'
    appendAudit({
      ts: 1,
      tool: 'message_session',
      folder: '/home/u/repo',
      verdict: 'allow',
      disclosedPayloadSummary: messageAuditSummary({
        sessionId: 'sess-1',
        pid: 758734,
        chars: body.length,
        bytes: 512,
        body
      }),
      result: 'ok'
    })
    const [row] = getAuditLog()
    expect(row.tool).toBe('message_session')
    expect(row.folder).toBe('/home/u/repo')
    expect(row.disclosedPayloadSummary).toContain('sess-1')
    expect(row.disclosedPayloadSummary).toContain('pid 758734')
    expect(row.disclosedPayloadSummary).toMatch(/sha256:[0-9a-f]{12}/)
  })

  it('the BODY is never persisted — the ring is not a transcript of inter-agent traffic', () => {
    // 200 entries x 4 KiB of plaintext in <userData>/mcp-audit.json is a
    // disclosure liability, not an audit. The hash pins WHAT was said; the row
    // proves THAT it was said, to whom, and when.
    const body = 'the deploy token is hunter2'
    appendAudit({
      ts: 1,
      tool: 'message_session',
      folder: '/home/u/repo',
      verdict: 'allow',
      disclosedPayloadSummary: messageAuditSummary({
        sessionId: 'sess-1',
        pid: 1,
        chars: body.length,
        bytes: 512,
        body
      }),
      result: 'ok'
    })
    expect(serializeForPersist()).not.toContain('hunter2')
    expect(serializeForPersist()).not.toContain(body)
  })
})
