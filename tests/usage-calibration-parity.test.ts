import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  measuredUsdByDay,
  summarizeLedger,
  type TurnLedgerRecord
} from '../src/main/companion/ingest/turn-ledger-core'
import {
  createTurnLedger,
  readMeasuredLedger,
  turnLedgerDir
} from '../src/main/companion/turn-ledger'
import type { CalibrationSkip } from '../src/main/usage-cost-core'

// The calibrated totals did not change when the ledger moved off the main thread: the same transcripts
// and the same ledger, priced by the previous code and by this one.

const h = vi.hoisted(() => ({ home: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
vi.mock('node:os', async (orig) => ({
  ...(await orig<typeof import('node:os')>()),
  homedir: () => h.home
}))

type Mod = typeof import('../src/main/usage-cost')

let mod: Mod
let cleanupWorker: (() => void) | null = null
let userData = ''

const DAY = 24 * 3600_000
const NOW = Date.now() - 3600_000
const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5-20260101', 'claude-opus-4-8']
const PROJECTS = ['/tmp/example-web', '/tmp/api-gateway', '/tmp/portal', '/tmp/web-api']
const isActive = (p: string): boolean => p !== '/tmp/portal'

beforeEach(async () => {
  h.home = mkdtempSync(join(tmpdir(), 'harnu-par-'))
  userData = mkdtempSync(join(tmpdir(), 'harnu-par-ud-'))
  mkdirSync(turnLedgerDir(userData), { recursive: true })
  vi.resetModules()
  mod = await import('../src/main/usage-cost')
})

afterEach(async () => {
  mod.setUsageCostCalibration(null)
  await mod.stopUsageScanWorker()
  cleanupWorker?.()
  cleanupWorker = null
  rmSync(h.home, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

/** What `calibrationTotals` computed before: the whole ledger read here, each session summed over it. */
function previousTotals(): Map<string, number> {
  const dir = turnLedgerDir(userData)
  const records: TurnLedgerRecord[] = []
  for (const f of readdirSync(dir)
    .filter((n) => /^\d{4}-\d{2}\.ndjson$/.test(n))
    .sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line) continue
      try {
        const r = JSON.parse(line) as TurnLedgerRecord
        if (r && r.v === 1 && typeof r.sessionId === 'string') records.push(r)
      } catch {
        // torn
      }
    }
  }
  const out = new Map<string, number>()
  for (const [sid, s] of summarizeLedger(records)) {
    if (!s.covered || !isActive(s.projectPath)) continue
    for (const [day, usd] of measuredUsdByDay(records, sid)) out.set(`${sid} ${day}`, usd)
  }
  return out
}

/** A seeded generator, so the fixture is the same on every run. */
function random(seed: number): () => number {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
}

const sid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`

function line(t: number, record: object): void {
  const file = join(turnLedgerDir(userData), `${new Date(t).toISOString().slice(0, 7)}.ndjson`)
  appendFileSync(file, JSON.stringify(record) + '\n')
}

function transcript(sessionId: string, project: string, requests: [number, string][]): void {
  const file = join(
    h.home,
    '.claude',
    'projects',
    project.replace(/\//g, '-'),
    `${sessionId}.jsonl`
  )
  mkdirSync(dirname(file), { recursive: true })
  requests.forEach(([t, model], n) =>
    appendFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        requestId: `req_${sessionId}_${n}`,
        timestamp: new Date(t).toISOString(),
        sessionId,
        cwd: project,
        message: {
          id: `msg_${sessionId}_${n}`,
          model,
          usage: {
            input_tokens: 1000 + n * 100,
            output_tokens: 1000,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 100
          }
        }
      }) + '\n'
    )
  )
}

/**
 * Sixty sessions over two ledger months: covered and not (resumed, gap), active and inactive projects,
 * a project that changes mid-session, costs that sum with float error, factors in and out of range,
 * and lines no reader may count.
 */
function writeFixture(): void {
  const rnd = random(7)
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!
  for (let n = 1; n <= 60; n++) {
    const sessionId = sid(n)
    const project = PROJECTS[n % PROJECTS.length]!
    const start = n % 3 === 0 ? NOW - 40 * DAY : NOW - 2 * DAY
    transcript(
      sessionId,
      project,
      Array.from({ length: 4 }, (_, i): [number, string] => [
        start + i * (n % 5 === 0 ? DAY : 60_000),
        pick(MODELS)
      ])
    )
    line(start, {
      v: 1,
      k: 'open',
      t: start,
      sessionId,
      projectPath: project,
      costAtOpen: 0,
      fresh: n % 7 !== 0
    })
    for (let i = 0; i < 5; i++) {
      const t = start + i * (n % 5 === 0 ? DAY : 60_000)
      const costUsd = i === 4 && n % 11 === 0 ? 50 : rnd() / 100
      line(
        t,
        i % 3 === 2
          ? { v: 1, k: 'other', t, sessionId, costUsd }
          : { v: 1, k: 'turn', t, sessionId, turnId: `t${i}`, costUsd: i === 1 ? null : costUsd }
      )
    }
    if (n % 13 === 0) line(start, { v: 1, k: 'gap', t: start, sessionId, why: 'dropped' })
    if (n % 9 === 0) {
      const t = start + 5000
      line(t, {
        v: 1,
        k: 'open',
        t,
        sessionId,
        projectPath: PROJECTS[(n + 1) % PROJECTS.length],
        costAtOpen: 1,
        fresh: false
      })
    }
    line(start, { v: 1, k: 'aux', t: start, sessionId, kind: 'fork', tokens: {} })
    line(start, { v: 1, k: 'close', t: start, sessionId, costAtClose: 1 })
    line(start, { v: 2, k: 'turn', t: start, sessionId, costUsd: 9 })
  }
  const month = join(turnLedgerDir(userData), `${new Date(NOW).toISOString().slice(0, 7)}.ndjson`)
  appendFileSync(month, 'not json\n\nnull\n{"v":1,"k":"turn","sessionId":"' + sid(1))
}

describe('usage calibration parity', () => {
  it('prices every day, model, project and session as the previous code did', async () => {
    writeFixture()
    const { buildUsageScanWorker } = await import('./support/usage-scan-worker-build')
    const built = await buildUsageScanWorker()
    cleanupWorker = built.cleanup
    mod.startUsageScanWorker(built.factory)
    const ledger = createTurnLedger({
      userData,
      now: () => Date.now(),
      policy: async () => ({ enabled: true, retentionDays: 'forever' })
    })

    async function dashboard(totals: (() => Promise<ReadonlyMap<string, number>>) | null): Promise<{
      rollups: unknown
      buckets: unknown
      skips: CalibrationSkip[]
    }> {
      const skips: CalibrationSkip[] = []
      mod.setUsageCostCalibration(totals && { totals, onSkip: (s) => void skips.push(s) })
      const s = await mod.buildUsageCostSummary()
      const bi = await mod.buildUsageBiRawData()
      return {
        rollups: {
          day: s.dailyRollup,
          model: s.modelRollup,
          project: s.projectRollup,
          topSessions: s.topSessions
        },
        buckets: bi.mergedBuckets,
        skips
      }
    }

    // Warm the scan first, so all three loads fold the same cache in the same order.
    await mod.buildUsageCostSummary()
    const scanned = await dashboard(null)
    const before = await dashboard(async () => previousTotals())
    const after = await dashboard(() =>
      ledger.calibrationTotals(isActive, mod.readUsageLedgerTotals)
    )

    const expected = previousTotals()
    expect(expected.size).toBeGreaterThan(20)
    expect(await ledger.calibrationTotals(isActive, readMeasuredLedger)).toEqual(expected)
    expect(await ledger.calibrationTotals(isActive, mod.readUsageLedgerTotals)).toEqual(expected)
    // Not vacuous: calibration moved the price, and refused some of it.
    expect(before.rollups).not.toEqual(scanned.rollups)
    expect(before.skips.length).toBeGreaterThan(0)
    expect(after).toEqual(before)
  })
})
