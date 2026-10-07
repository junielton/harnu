import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompanionMode } from '../../src/main/companion/mode'
import { createParityLedger, type LedgerDeps } from '../../src/main/companion/parity-ledger'

let dir: string
let mode: CompanionMode
let owner: 'legacy' | 'companion'

function deps(over: Partial<LedgerDeps> = {}): LedgerDeps {
  return {
    dir,
    now: () => 1_790_000_000_000,
    cli: () => '2.1.290',
    modVersion: () => '0.1.0',
    context: () => ({ owner, reason: owner === 'companion' ? 'owned' : 'mode-shadow', mode }),
    ...over
  }
}

const SID = '11111111-1111-4111-8111-111111111111'
const file = (stream: string, gen = ''): string =>
  join(dir, 'parity', `${stream}${gen ? `.${gen}` : ''}.ndjson`)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hc-pl-'))
  mode = 'shadow'
  owner = 'legacy'
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('parity ledger shell', () => {
  it('writes nothing while the stream is off', () => {
    mode = 'off'
    const l = createParityLedger(deps())
    l.recordFact('taskState', 'companion', SID, 'state:working')
    l.flush()
    expect(existsSync(join(dir, 'parity'))).toBe(false)
    expect(l.stats()).toEqual({ written: 0, dropped: 0 })
  })

  it('buffers 64 records or 2 s, writes mode 0600 and survives a quit flush', () => {
    vi.useFakeTimers()
    const l = createParityLedger(deps())
    l.recordFact('taskState', 'companion', SID, 'state:working', { n: 1 })
    expect(existsSync(file('taskState'))).toBe(false) // buffered
    vi.advanceTimersByTime(2_100)
    expect(existsSync(file('taskState'))).toBe(true)
    expect(statSync(file('taskState')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'parity')).mode & 0o777).toBe(0o700)
    for (let i = 0; i < 64; i++) l.recordFact('taskState', 'legacy', SID, `state:${i}`)
    const lines = () => readFileSync(file('taskState'), 'utf8').split('\n').filter(Boolean)
    expect(lines()).toHaveLength(65) // the 64th record flushed at once
    l.recordFact('taskState', 'legacy', SID, 'state:tail')
    expect(lines()).toHaveLength(65)
    l.flush() // before-quit
    expect(lines()).toHaveLength(66)
    l.dispose()
  })

  it('records are scrubbed on the way in and never carry the session id', () => {
    const l = createParityLedger(deps())
    l.recordFact('taskState', 'companion', SID, 'state:working', {
      path: '/home/someone/x',
      prompt: 'hello',
      conn: 'c_0123456789abcdef0123456789abcdef',
      ms: 3
    })
    l.flush()
    const text = readFileSync(file('taskState'), 'utf8')
    for (const banned of ['/home/', 'hello', 'c_0123', '11111111-1111']) {
      expect(text).not.toContain(banned)
    }
    expect(JSON.parse(text).d).toEqual({ ms: 3 })
  })

  it('derives the disposition and carries owner and reason', () => {
    const l = createParityLedger(deps())
    l.recordFact('taskState', 'companion', SID, 'a') // legacy owner, companion source
    owner = 'companion'
    l.recordFact('taskState', 'legacy', SID, 'b') // companion owner, legacy source
    l.recordFact('taskState', 'companion', SID, 'c')
    l.recordFact('taskState', 'legacy', SID, 'd', undefined, { disposition: 'applied' })
    l.flush()
    const rows = l.read('taskState')
    expect(rows.map((r) => r.disposition)).toEqual(['record-only', 'dropped', 'applied', 'applied'])
    expect(rows[1]).toMatchObject({
      owner: 'companion',
      reason: 'owned',
      cli: '2.1.290',
      mod: '0.1.0'
    })
  })

  it('one salt per install: the same sid keeps its label across restarts', () => {
    const a = createParityLedger(deps())
    a.recordFact('taskState', 'companion', SID, 'x')
    a.flush()
    const b = createParityLedger(deps())
    b.recordFact('taskState', 'companion', SID, 'y')
    b.flush()
    const rows = b.read('taskState')
    expect(rows).toHaveLength(2)
    expect(rows[0].sk).toBe(rows[1].sk)
    expect(statSync(join(dir, 'install-salt')).mode & 0o777).toBe(0o600)
  })

  it('rotates by size and keeps three generations', () => {
    const l = createParityLedger(deps({ rotateBytes: 600 }))
    for (let i = 0; i < 40; i++) {
      l.recordFact('taskState', 'legacy', SID, `state:${i}`)
      l.flush()
    }
    const names = readdirSync(join(dir, 'parity')).sort()
    expect(names).toEqual(['taskState.1.ndjson', 'taskState.2.ndjson', 'taskState.ndjson'])
    for (const n of names) expect(statSync(join(dir, 'parity', n)).size).toBeLessThanOrEqual(900)
    // newest last: reading returns the oldest kept generation first
    const rows = l.read('taskState')
    expect(rows.at(-1)?.k).toBe('state:39')
  })

  it('removes generations older than 14 days', () => {
    const l0 = createParityLedger(deps())
    l0.recordFact('taskState', 'legacy', SID, 'x')
    l0.flush()
    const old = file('taskState', '1')
    writeFileSync(old, '{"v":1}\n')
    const past = new Date(1_790_000_000_000 - 15 * 86_400_000)
    utimesSync(old, past, past)
    const l = createParityLedger(deps())
    l.recordFact('taskState', 'legacy', SID, 'y')
    l.flush()
    expect(existsSync(old)).toBe(false)
    expect(existsSync(file('taskState'))).toBe(true)
  })

  it('an unwritable directory drops and counts, and arbitration is unaffected', () => {
    writeFileSync(join(dir, 'parity'), 'a file where the directory should be')
    const l = createParityLedger(deps())
    expect(() => {
      l.recordFact('taskState', 'legacy', SID, 'x')
      l.flush()
    }).not.toThrow()
    expect(l.stats()).toEqual({ written: 0, dropped: 1 })
  })

  it('a throwing context provider drops the record, never throws', () => {
    const l = createParityLedger(
      deps({
        context: () => {
          throw new Error('arbiter down')
        }
      })
    )
    expect(() => l.recordFact('taskState', 'legacy', SID, 'x')).not.toThrow()
    l.flush()
    expect(l.stats().written).toBe(0)
  })

  it('reads a stream across generations and ignores a missing one', () => {
    const l = createParityLedger(deps())
    expect(l.read('guard')).toEqual([])
    l.recordFact('taskState', 'legacy', SID, 'x')
    expect(l.read('taskState')).toHaveLength(1) // read flushes first
  })
})
