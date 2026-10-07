import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildParityRecord,
  expiredGenerations,
  gateStatus,
  parityReport,
  parseParityLines,
  registerParityRule,
  resetParityRulesForTests,
  rotationNeeded,
  serializeParityRecord,
  type ParityRecord
} from '../../src/main/companion/parity-core'
import { registerIdentityParityRule } from '../../src/main/companion/parity-identity-rule'

const fixture = (name: string): ParityRecord[] =>
  parseParityLines(readFileSync(join(__dirname, '../fixtures/companion-parity', name), 'utf8'))

const base = {
  stream: 'taskState' as const,
  source: 'companion' as const,
  owner: 'legacy' as const,
  reason: 'mode-shadow' as const,
  disposition: 'record-only' as const,
  sid: '11111111-1111-4111-8111-111111111111',
  salt: 'install-salt',
  t: 1_790_000_000_000,
  k: 'state:working',
  cli: '2.1.290',
  mod: '0.1.0'
}

beforeEach(() => {
  resetParityRulesForTests()
  registerIdentityParityRule()
})

describe('records', () => {
  it('records are scrubbed', () => {
    const rec = buildParityRecord({
      ...base,
      d: {
        tool: 'Edit',
        path: '/home/someone/project/secret.ts',
        file_path: '/etc/passwd',
        prompt: 'please delete everything',
        conn: 'c_0123456789abcdef0123456789abcdef',
        cwd: '/work/example-web',
        note: '/work/example-web/src/a.ts',
        token: 'sp_00000000-0000-4000-8000-000000000001',
        spawn: 'sp_00000000-0000-4000-8000-000000000001',
        owner: 'c_0123456789abcdef0123456789abcdef',
        ms: 812,
        ok: true,
        none: null
      }
    })
    const line = serializeParityRecord(rec)
    for (const banned of [
      '/home/',
      '/etc/',
      '/work/',
      'please delete',
      'c_0123456789abcdef',
      'sp_00000000',
      'path',
      'prompt',
      'conn',
      'cwd',
      'token'
    ]) {
      expect(line).not.toContain(banned)
    }
    expect(JSON.parse(line).d).toEqual({ tool: 'Edit', ms: 812, ok: true, none: null })
  })

  it('never carries the session id: sk is a salted one-way label', () => {
    const a = buildParityRecord(base)
    const b = buildParityRecord({ ...base, salt: 'another install' })
    const line = serializeParityRecord(a)
    expect(line).not.toContain('11111111')
    expect(a.sk).toMatch(/^[0-9a-f]{12}$/)
    expect(a.sk).toBe(buildParityRecord(base).sk) // stable within an install
    expect(a.sk).not.toBe(b.sk) // different across installs
  })

  it('normalizes the fact key and bounds a long or hostile one', () => {
    expect(buildParityRecord({ ...base, k: 'state:working' }).k).toBe('state:working')
    expect(buildParityRecord({ ...base, k: '/home/someone/x' }).k).toBe('redacted')
    expect(buildParityRecord({ ...base, k: 'x'.repeat(200) }).k).toBe('redacted')
  })

  it('round-trips through the line format, one record per line', () => {
    const rec = buildParityRecord({ ...base, ts: 1_789_999_999_000, d: { n: 1 } })
    const text = serializeParityRecord(rec) + serializeParityRecord(rec)
    expect(text.split('\n').filter(Boolean)).toHaveLength(2)
    expect(parseParityLines(text)).toEqual([rec, rec])
    // a torn or foreign line is skipped, never thrown
    expect(parseParityLines('{"v":2}\nnot json\n' + serializeParityRecord(rec))).toEqual([rec])
  })

  it('rotates at 5 MiB and expires generations older than 14 days', () => {
    expect(rotationNeeded(5 * 1024 * 1024 - 10, 5)).toBe(false)
    expect(rotationNeeded(5 * 1024 * 1024 - 10, 20)).toBe(true)
    const day = 86_400_000
    const now = 100 * day
    expect(
      expiredGenerations(
        [
          { name: 'a.ndjson', mtimeMs: now - 1 * day },
          { name: 'a.1.ndjson', mtimeMs: now - 15 * day },
          { name: 'a.2.ndjson', mtimeMs: now - 30 * day }
        ],
        now
      )
    ).toEqual(['a.1.ndjson', 'a.2.ndjson'])
  })
})

describe('parity report', () => {
  it('identity rule: a duplicate row is unexplained, the rest is explained', () => {
    const records = fixture('identity/dup-row.ndjson')
    const report = parityReport('identity', records)
    expect(report.sessions).toBe(3)
    expect(report.facts).toBe(4)
    expect(report.unexplained).toHaveLength(1)
    expect(report.unexplained[0].class).toBeNull()
    expect(report.explained).toEqual({ 'legacy-unbound': 1 })
    expect(gateStatus(report, { minSessions: 3 }).pass).toBe(false)
  })

  it('identity rule: a clean trace passes the gate once it is big enough', () => {
    const clean = fixture('identity/dup-row.ndjson').slice(0, 3)
    const report = parityReport('identity', clean)
    expect(report.unexplained).toEqual([])
    expect(gateStatus(report, { minSessions: 3 })).toEqual({ pass: true, why: [] })
    const small = gateStatus(report, { minSessions: 200, minFacts: 500 })
    expect(small.pass).toBe(false)
    expect(small.why).toEqual([
      expect.stringContaining('sessions'),
      expect.stringContaining('facts')
    ])
  })

  it('identity rule: a mismatch is unexplained, a conflict is explained', () => {
    const row = (verdict: string, sk: string): ParityRecord =>
      buildParityRecord({
        ...base,
        stream: 'identity',
        sid: sk,
        k: `bind:${verdict}`,
        d: { shape: 'agent', verdict }
      })
    const report = parityReport('identity', [
      row('mismatch', 'one'),
      row('conflict', 'two'),
      row('legacy-only', 'three'),
      row('match', 'four')
    ])
    expect(report.unexplained).toHaveLength(1)
    expect(report.explained).toEqual({ conflict: 1, 'no-hello': 1 })
  })

  it('a stream with no registered rule reports no divergence, only counts', () => {
    const report = parityReport('taskState', [buildParityRecord(base)])
    expect(report).toEqual({ sessions: 1, facts: 1, explained: {}, unexplained: [] })
  })

  it('a rule that throws reports the session as unexplained instead of passing it', () => {
    registerParityRule({
      stream: 'telemetry',
      compare: () => {
        throw new Error('boom')
      }
    })
    const report = parityReport('telemetry', [buildParityRecord({ ...base, stream: 'telemetry' })])
    expect(report.unexplained).toHaveLength(1)
  })

  it('records of other streams are ignored', () => {
    const report = parityReport('identity', [buildParityRecord(base)])
    expect(report.facts).toBe(0)
  })
})
