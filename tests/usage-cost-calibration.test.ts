import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The cost scan's shell with a temp HOME: a covered session-day's price becomes the CLI's own
// total, an uncovered one stays the scan's (spec P1W6 §7.5, ARB-8).

const h = vi.hoisted(() => ({ home: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
vi.mock('node:os', async (orig) => ({
  ...(await orig<typeof import('node:os')>()),
  homedir: () => h.home
}))

const SID = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const day = '2026-10-02'

function transcript(sid: string, cwd: string): string {
  const line = (n: number): string =>
    JSON.stringify({
      type: 'assistant',
      requestId: `req_${sid}_${n}`,
      timestamp: `${day}T12:0${n}:00.000Z`,
      sessionId: sid,
      cwd,
      message: {
        id: `msg_${sid}_${n}`,
        model: 'claude-haiku-4-5-20251001',
        usage: {
          input_tokens: 1000,
          output_tokens: 1000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        }
      }
    })
  return [line(1), line(2)].join('\n') + '\n'
}

let mod: typeof import('../src/main/usage-cost')

beforeEach(async () => {
  h.home = mkdtempSync(join(tmpdir(), 'harnu-uc-'))
  const dir = join(h.home, '.claude', 'projects', '-tmp-example-project')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${SID}.jsonl`), transcript(SID, '/tmp/example-project'))
  writeFileSync(join(dir, `${OTHER}.jsonl`), transcript(OTHER, '/tmp/example-project'))
  vi.resetModules()
  mod = await import('../src/main/usage-cost')
})
afterEach(() => {
  mod.setUsageCostCalibration(null)
  rmSync(h.home, { recursive: true, force: true })
})

const total = (s: { dailyRollup: { costUsd: number }[] }): number =>
  s.dailyRollup.reduce((a, d) => a + d.costUsd, 0)

describe('usage cost calibration (shell)', () => {
  it('without a source the scan stands', async () => {
    const s = await mod.buildUsageCostSummary()
    expect(total(s)).toBeGreaterThan(0)
  })

  it('a covered session-day takes the CLI total; the other session keeps the scan price', async () => {
    const base = total(await mod.buildUsageCostSummary())
    const one = base / 2 // two identical sessions
    mod.setUsageCostCalibration({ totals: async () => new Map([[`${SID} ${day}`, one * 1.2]]) })
    const s = await mod.buildUsageCostSummary()
    expect(total(s)).toBeCloseTo(one * 1.2 + one, 9)
    const bi = await mod.buildUsageBiRawData()
    expect(
      bi.mergedBuckets.filter((b) => b.sessionId === SID).reduce((a, b) => a + b.costUsd, 0)
    ).toBeCloseTo(one * 1.2, 9)
    expect(
      bi.mergedBuckets.filter((b) => b.sessionId === OTHER).reduce((a, b) => a + b.costUsd, 0)
    ).toBeCloseTo(one, 9)
  })

  it('an out-of-range factor is not applied and is reported', async () => {
    const base = total(await mod.buildUsageCostSummary())
    const skipped: unknown[] = []
    mod.setUsageCostCalibration({
      totals: async () => new Map([[`${SID} ${day}`, base * 10]]),
      onSkip: (x) => void skipped.push(x)
    })
    expect(total(await mod.buildUsageCostSummary())).toBeCloseTo(base, 9)
    expect(skipped).toEqual([
      expect.objectContaining({ sessionId: SID, reason: 'factor-out-of-range' })
    ])
  })

  it('a source that throws leaves the scan alone', async () => {
    const base = total(await mod.buildUsageCostSummary())
    mod.setUsageCostCalibration({
      totals: async () => {
        throw new Error('ledger unreadable')
      }
    })
    expect(total(await mod.buildUsageCostSummary())).toBeCloseTo(base, 9)
  })
})
