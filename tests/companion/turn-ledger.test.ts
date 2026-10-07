import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
  readdirSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureTurnLedger,
  createTurnLedger,
  recordAuxSpend,
  turnLedgerDir,
  turnLedgerFile
} from '../../src/main/companion/turn-ledger'

const SID = '11111111-1111-4111-8111-111111111111'
const T = Date.UTC(2026, 9, 6, 12, 0, 0)
const dirs: string[] = []
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'harnu-tl-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  configureTurnLedger(null)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const policy =
  (over: { enabled?: boolean; retentionDays?: number | 'forever' } = {}) =>
  async () => ({
    enabled: over.enabled ?? true,
    retentionDays: over.retentionDays ?? 90
  })

const tok = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 }

describe('turn ledger shell (spec P1W6 §7.5)', () => {
  it('ledger is per instance (AC-P1W6-30)', () => {
    const userData = '/home/someone/.config/Harnu'
    const dir = turnLedgerDir(userData)
    expect(dir).toBe(join(userData, 'companion', 'turns'))
    // never the directory every Harnu instance shares (`~/.claude/om2tab/usage-history`)
    expect(dir.startsWith(join(homedir(), '.claude'))).toBe(false)
    expect(turnLedgerFile(userData, T)).toBe(join(dir, '2026-10.ndjson'))
    // two instances with two userData directories never share a file
    expect(turnLedgerDir('/tmp/hv1')).not.toBe(turnLedgerDir('/tmp/hv2'))
  })

  it('appends one NDJSON line per record, mode 0600, and reads them back', async () => {
    const userData = mk()
    const l = createTurnLedger({ userData, now: () => T, policy: policy(), settleMs: 10 })
    l.usage(SID, T, { costUsd: 0, projectPath: '/tmp/example-project' })
    l.usage(SID, T + 5, { costUsd: 0.04, projectPath: '/tmp/example-project' })
    await l.flush()
    const file = turnLedgerFile(userData, T)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x))
    expect(lines.map((r) => r.k)).toEqual(['open', 'other'])
    expect((await l.read()).length).toBe(2)
  })

  it('honours usage history: opted out writes nothing', async () => {
    const userData = mk()
    const l = createTurnLedger({ userData, now: () => T, policy: policy({ enabled: false }) })
    l.usage(SID, T, { costUsd: 0, projectPath: '/tmp/x' })
    await l.flush()
    expect(existsSync(turnLedgerDir(userData))).toBe(false)
  })

  it('honours usage history: months past the retention window are deleted, forever keeps all', async () => {
    const userData = mk()
    const dir = turnLedgerDir(userData)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2025-01.ndjson'), '')
    writeFileSync(join(dir, '2026-09.ndjson'), '')
    const keep = createTurnLedger({
      userData,
      now: () => T,
      policy: policy({ retentionDays: 'forever' })
    })
    await keep.sweep()
    expect(readdirSync(dir).sort()).toEqual(['2025-01.ndjson', '2026-09.ndjson'])
    const l = createTurnLedger({ userData, now: () => T, policy: policy({ retentionDays: 90 }) })
    await l.sweep()
    expect(readdirSync(dir).sort()).toEqual(['2026-09.ndjson'])
  })

  it('a session a previous boot ledgered starts with a host-restart gap', async () => {
    const userData = mk()
    const a = createTurnLedger({ userData, now: () => T, policy: policy() })
    a.usage(SID, T, { costUsd: 0, projectPath: '/tmp/x' })
    await a.flush()
    const b = createTurnLedger({ userData, now: () => T + 60_000, policy: policy() })
    b.usage(SID, T + 60_000, { costUsd: 0.5, projectPath: '/tmp/x' })
    await b.flush()
    const recs = await b.read()
    expect(recs.map((r) => (r.k === 'gap' ? `gap:${r.why}` : r.k))).toEqual([
      'open',
      'gap:host-restart',
      'open'
    ])
  })

  it('settles a turn on its own clock tick and writes it', async () => {
    const userData = mk()
    let now = T
    const l = createTurnLedger({ userData, now: () => now, policy: policy(), settleMs: 100 })
    l.usage(SID, T, { costUsd: 0, projectPath: '/tmp/x' })
    l.turnStarted(SID, T + 1, 'a')
    l.turnCompleted(SID, T + 50, { turnId: 'a', durationMs: 49, reason: 'answer' })
    now = T + 500
    l.tick()
    await l.flush()
    expect((await l.read()).map((r) => r.k)).toEqual(['open', 'turn'])
  })

  it('a write that fails never throws into the caller', async () => {
    const userData = mk()
    writeFileSync(join(userData, 'companion'), 'a file where the directory should be')
    const l = createTurnLedger({ userData, now: () => T, policy: policy() })
    expect(() => l.usage(SID, T, { costUsd: 0, projectPath: '/tmp/x' })).not.toThrow()
    await expect(l.flush()).resolves.toBeUndefined()
  })

  it('totals for calibration: covered sessions of an active project only', async () => {
    const userData = mk()
    const l = createTurnLedger({ userData, now: () => T, policy: policy() })
    l.usage(SID, T, { costUsd: 0, projectPath: '/tmp/active-project' })
    l.usage(SID, T + 5, { costUsd: 0.5, projectPath: '/tmp/active-project' })
    l.usage('resumed', T, { costUsd: 0.2, projectPath: '/tmp/active-project' })
    l.usage('resumed', T + 5, { costUsd: 0.7, projectPath: '/tmp/active-project' })
    l.usage('shadowed', T, { costUsd: 0, projectPath: '/tmp/shadow-project' })
    l.usage('shadowed', T + 5, { costUsd: 0.9, projectPath: '/tmp/shadow-project' })
    await l.flush()
    const totals = await l.calibrationTotals((p) => p === '/tmp/active-project')
    const day = new Date(T + 5)
    const key = `${SID} ${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    expect([...totals.keys()]).toEqual([key])
    expect(totals.get(key)).toBeCloseTo(0.5, 9)
  })

  it('recordAuxSpend writes an aux record, and is a no-op until a ledger is configured', async () => {
    recordAuxSpend({ kind: 'fork', sid: SID, usage: tok, ts: T }) // nothing configured: no throw
    const userData = mk()
    const l = createTurnLedger({ userData, now: () => T, policy: policy() })
    configureTurnLedger(l)
    recordAuxSpend({ kind: 'fork', sid: SID, usage: tok, ts: T })
    await l.flush()
    expect(await l.read()).toEqual([
      {
        v: 1,
        k: 'aux',
        t: T,
        sessionId: SID,
        kind: 'fork',
        tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }
      }
    ])
  })
})
