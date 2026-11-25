import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTurnLedger, turnLedgerDir } from '../src/main/companion/turn-ledger'

// A dashboard load calibrates the scanned cost with the companion turn ledger. A real ledger is tens of
// megabytes, and reading it on the thread that carries keystrokes froze the app.

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

const SID = '11111111-1111-4111-8111-111111111111'
const PROJECT = '/tmp/example-web'
/** Two requests of this model and size price at a few thousandths of a dollar. */
const MODEL = 'claude-haiku-4-5-20251001'

beforeEach(async () => {
  h.home = mkdtempSync(join(tmpdir(), 'harnu-cal-'))
  userData = mkdtempSync(join(tmpdir(), 'harnu-cal-ud-'))
  mkdirSync(join(h.home, '.claude', 'projects', '-tmp-example-web'), { recursive: true })
  mkdirSync(turnLedgerDir(userData), { recursive: true })
  vi.resetModules()
  mod = await import('../src/main/usage-cost')
})

afterEach(async () => {
  vi.restoreAllMocks()
  mod.setUsageCostCalibration(null)
  await mod.stopUsageScanWorker()
  cleanupWorker?.()
  cleanupWorker = null
  rmSync(h.home, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

const transcript = (): string =>
  join(h.home, '.claude', 'projects', '-tmp-example-web', `${SID}.jsonl`)

function request(n: number, at: number): string {
  return (
    JSON.stringify({
      type: 'assistant',
      requestId: `req_${n}`,
      timestamp: new Date(at).toISOString(),
      sessionId: SID,
      cwd: PROJECT,
      message: {
        id: `msg_${n}`,
        model: MODEL,
        usage: {
          input_tokens: 1000,
          output_tokens: 1000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        }
      }
    }) + '\n'
  )
}

const sid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`

const open = (t: number, sessionId: string, projectPath: string): string =>
  JSON.stringify({
    v: 1,
    k: 'open',
    t,
    sessionId,
    projectPath,
    costAtOpen: 0,
    fresh: true,
    startedAt: t
  }) + '\n'

const turn = (t: number, sessionId: string, n: number, costUsd: number): string =>
  JSON.stringify({
    v: 1,
    k: 'turn',
    t,
    sessionId,
    turnId: `turn-${n}-0000-4000-8000-000000000000`,
    model: MODEL,
    tokens: { input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 },
    durationMs: 1234,
    wallMs: 1300,
    reason: 'answer',
    costUsd,
    costBasis: 'measured'
  }) + '\n'

const close = (t: number, sessionId: string): string =>
  JSON.stringify({ v: 1, k: 'close', t, sessionId, costAtClose: 0.01 }) + '\n'

/**
 * A ledger the size and shape of a heavy user's: about 35 MB over two months, tens of thousands of short
 * covered sessions spread over a thousand projects.
 */
function writeBigLedger(now: number): number {
  const months = [now - 40 * 24 * 3600_000, now - 3600_000]
  let session = 0
  let bytes = 0
  for (const t of months) {
    const file = join(turnLedgerDir(userData), `${new Date(t).toISOString().slice(0, 7)}.ndjson`)
    let size = 0
    while (size < 17.5 * (1 << 20)) {
      let chunk = ''
      for (let i = 0; i < 500; i++, session++) {
        const id = sid(session + 1)
        chunk += open(t, id, `/tmp/project-${session % 1000}`)
        chunk += turn(t + 1000, id, 1, 0.01) + turn(t + 2000, id, 2, 0.02)
        chunk += close(t + 3000, id)
      }
      appendFileSync(file, chunk)
      size += chunk.length
    }
    bytes += statSync(file).size
  }
  return bytes
}

describe('usage calibration off the calling thread', () => {
  it('never stalls over 100 ms with a 35 MB turn ledger: cold, stale and warm', async () => {
    const now = Date.now() - 3600_000
    writeFileSync(transcript(), request(1, now) + request(2, now + 1000))
    expect(writeBigLedger(now)).toBeGreaterThan(34 * (1 << 20))
    const monthFile = join(
      turnLedgerDir(userData),
      `${new Date(now).toISOString().slice(0, 7)}.ndjson`
    )
    appendFileSync(monthFile, open(now, SID, PROJECT) + turn(now + 1000, SID, 1, 0.013))

    const { buildUsageScanWorker } = await import('./support/usage-scan-worker-build')
    const built = await buildUsageScanWorker()
    cleanupWorker = built.cleanup
    mod.startUsageScanWorker(built.factory)

    const ledger = createTurnLedger({
      userData,
      now: () => Date.now(),
      policy: async () => ({ enabled: true, retentionDays: 'forever' })
    })
    // The app wires it this way: the ledger is read where the transcripts are.
    const active = new Set([PROJECT, ...Array.from({ length: 20 }, (_, i) => `/tmp/project-${i}`)])
    mod.setUsageCostCalibration({
      totals: () => ledger.calibrationTotals((p) => active.has(p), mod.readUsageLedgerTotals)
    })

    let parsedHere = 0
    const parse = JSON.parse
    vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (typeof text === 'string' && text.startsWith('{"v":1,')) parsedHere++
      return parse(text, reviver)
    })

    async function load(): Promise<{ maxStall: number; costUsd: number }> {
      let last = performance.now()
      let maxStall = 0
      const probe = setInterval(() => {
        const t = performance.now()
        maxStall = Math.max(maxStall, t - last - 5)
        last = t
      }, 5)
      const bi = await mod.buildUsageBiRawData()
      await new Promise((resolve) => setTimeout(resolve, 20))
      clearInterval(probe)
      return { maxStall, costUsd: bi.mergedBuckets.reduce((a, b) => a + b.costUsd, 0) }
    }

    const cold = await load()
    // Stale: the transcript and the ledger both grew since the last load.
    appendFileSync(transcript(), request(3, now + 2000))
    appendFileSync(monthFile, turn(now + 2000, SID, 2, 0.007))
    const stale = await load()
    const warm = await load()

    // Calibration really ran: the covered session costs what the ledger measured.
    expect(cold.costUsd).toBeCloseTo(0.013, 9)
    expect(stale.costUsd).toBeCloseTo(0.02, 9)
    expect(warm.costUsd).toBeCloseTo(0.02, 9)
    // Soft, so a failure reports all four at once.
    expect.soft(parsedHere, 'ledger lines parsed on the calling thread').toBe(0)
    expect.soft(cold.maxStall, 'cold stall (ms)').toBeLessThan(100)
    expect.soft(stale.maxStall, 'stale stall (ms)').toBeLessThan(100)
    expect.soft(warm.maxStall, 'warm stall (ms)').toBeLessThan(100)
  }, 120_000)

  // The most this thread can be handed: every project active, so every covered session-day comes back.
  it('stays under 100 ms when every project in the ledger is active', async () => {
    const now = Date.now() - 3600_000
    writeFileSync(transcript(), request(1, now) + request(2, now + 1000))
    writeBigLedger(now)

    const { buildUsageScanWorker } = await import('./support/usage-scan-worker-build')
    const built = await buildUsageScanWorker()
    cleanupWorker = built.cleanup
    mod.startUsageScanWorker(built.factory)
    const ledger = createTurnLedger({
      userData,
      now: () => Date.now(),
      policy: async () => ({ enabled: true, retentionDays: 'forever' })
    })
    let entries = 0
    mod.setUsageCostCalibration({
      totals: async () => {
        const totals = await ledger.calibrationTotals(() => true, mod.readUsageLedgerTotals)
        entries = totals.size
        return totals
      }
    })

    let last = performance.now()
    let maxStall = 0
    const probe = setInterval(() => {
      const t = performance.now()
      maxStall = Math.max(maxStall, t - last - 5)
      last = t
    }, 5)
    await mod.buildUsageBiRawData()
    await new Promise((resolve) => setTimeout(resolve, 20))
    clearInterval(probe)

    expect(entries).toBeGreaterThan(30_000)
    expect(maxStall).toBeLessThan(100)
  }, 120_000)
})
