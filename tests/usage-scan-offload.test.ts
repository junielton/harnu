import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The usage scan must not run on the thread that carries keystrokes: a stale multi-hundred-MB corpus used
// to freeze the whole app while the dashboard loaded.

const h = vi.hoisted(() => ({ home: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
vi.mock('node:os', async (orig) => ({
  ...(await orig<typeof import('node:os')>()),
  homedir: () => h.home
}))

type Mod = typeof import('../src/main/usage-cost')

let mod: Mod
let cleanupWorker: (() => void) | null = null

const projects = (): string => join(h.home, '.claude', 'projects')
const cacheDir = (): string => join(h.home, '.claude', 'om2tab', 'usage-history')

beforeEach(async () => {
  h.home = mkdtempSync(join(tmpdir(), 'harnu-scan-'))
  mkdirSync(projects(), { recursive: true })
  vi.resetModules()
  mod = await import('../src/main/usage-cost')
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await mod.stopUsageScanWorker()
  cleanupWorker?.()
  cleanupWorker = null
  rmSync(h.home, { recursive: true, force: true })
})

/** Route the scan through a real worker thread, exactly as the app does at boot. */
async function useWorker(): Promise<void> {
  const { buildUsageScanWorker } = await import('./support/usage-scan-worker-build')
  const built = await buildUsageScanWorker()
  cleanupWorker = built.cleanup
  mod.startUsageScanWorker(built.factory)
}

interface Req {
  sid: string
  n: number
  at: string
  model?: string
  cwd?: string
  input?: number
}

function assistant(r: Req): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: `req_${r.sid}_${r.n}`,
    timestamp: r.at,
    sessionId: r.sid,
    ...(r.cwd ? { cwd: r.cwd } : {}),
    message: {
      id: `msg_${r.sid}_${r.n}`,
      model: r.model ?? 'claude-haiku-4-5-20251001',
      usage: {
        input_tokens: r.input ?? 1000,
        output_tokens: 500,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 300
      }
    }
  })
}

const user = (text: string, at: string): string =>
  JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: text } })

function write(slug: string, name: string, lines: string[]): void {
  const file = join(projects(), slug, name)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, lines.join('\n') + '\n')
}

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

/** Main + subagent transcript, two models, a duplicated request, a torn line, a slug-only project. */
function writeFixture(at: (minute: number) => string): void {
  const cwd = '/tmp/example-web'
  write('-tmp-example-web', `${A}.jsonl`, [
    user('add the search box', at(0)),
    assistant({ sid: A, n: 1, at: at(1), cwd }),
    assistant({ sid: A, n: 1, at: at(1), cwd }),
    assistant({ sid: A, n: 2, at: at(2), cwd, model: 'claude-sonnet-5-20260101', input: 9000 }),
    '{"type":"assistant","requestId":"torn'
  ])
  write('-tmp-example-web', `${A}/subagents/agent-1.jsonl`, [
    assistant({ sid: A, n: 3, at: at(3), cwd })
  ])
  write('-tmp-api-gateway', `${B}.jsonl`, [
    user('why is the build red', at(4)),
    assistant({ sid: B, n: 4, at: at(5), model: 'claude-opus-4-8' })
  ])
}

const by = <T>(list: readonly T[], key: (x: T) => string): T[] =>
  [...list].sort((x, y) => key(x).localeCompare(key(y)))

/** The scan sums floats in file-completion order, so the last bit can differ between two correct runs. */
const rounded = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v))
  ) as T

/** Everything the two consumers get, minus timings, in a stable order. */
async function snapshot(): Promise<unknown> {
  const s = await mod.buildUsageCostSummary()
  const bi = await mod.buildUsageBiRawData()
  return rounded({
    summary: {
      dailyRollup: s.dailyRollup,
      modelRollup: s.modelRollup,
      projectRollup: s.projectRollup,
      topSessions: s.topSessions,
      hasEstimated: s.hasEstimated,
      fileCount: s.fileCount
    },
    bi: {
      fileCount: bi.fileCount,
      mergedBuckets: by(bi.mergedBuckets, (b) => `${b.sessionId}${b.day}${b.model}${b.isSubagent}`),
      sessionAnatomies: by(bi.sessionAnatomies, (a) => a.sessionId),
      hourlyPoints: by(bi.hourlyPoints, (p) => `${p.sessionId}${p.hourStartMs}${p.model}`)
    }
  })
}

describe('usage scan totals', () => {
  it('pins what the summary and the BI raw data report for a fixed set of files', async () => {
    vi.setSystemTime(new Date('2026-10-10T12:00:00.000Z'))
    writeFixture((m) => `2026-10-02T12:0${m}:00.000Z`)
    expect(await snapshot()).toMatchSnapshot()
  })

  it('reports the same numbers from the worker as from this thread', async () => {
    const base = Date.now() - 24 * 3600_000
    const at = (m: number): string => new Date(base + m * 60_000).toISOString()
    writeFixture(at)
    const here = await snapshot()
    // The same files in a second home, so the worker scans from nothing instead of this thread's cache.
    const first = h.home
    h.home = mkdtempSync(join(tmpdir(), 'harnu-scan-'))
    rmSync(first, { recursive: true, force: true, maxRetries: 5 })
    writeFixture(at)
    vi.resetModules()
    mod = await import('../src/main/usage-cost')
    await useWorker()
    expect(await snapshot()).toEqual(here)
  })
})

describe('usage scan off the calling thread', () => {
  /** One big transcript: parsing it in one piece takes far longer than the 100 ms budget. */
  function writeBig(megabytes: number): void {
    const dir = join(projects(), '-tmp-example-web')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${A}.jsonl`)
    const at = new Date(Date.now() - 3600_000).toISOString()
    const pad = 'x'.repeat(600)
    let n = 0
    for (let mb = 0; mb < megabytes; mb++) {
      const chunk: string[] = []
      let size = 0
      while (size < 1 << 20) {
        const line = assistant({ sid: A, n: n++, at, cwd: `/tmp/example-web-${pad}` })
        chunk.push(line)
        size += line.length + 1
      }
      appendFileSync(file, chunk.join('\n') + '\n')
    }
  }

  it('never stalls the calling thread over 100 ms while transcripts are parsed', async () => {
    writeBig(60)
    await useWorker()

    let parsedHere = 0
    const parse = JSON.parse
    vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (typeof text === 'string' && text.includes('"requestId"')) parsedHere++
      return parse(text, reviver)
    })
    let last = performance.now()
    let maxStall = 0
    const probe = setInterval(() => {
      const now = performance.now()
      maxStall = Math.max(maxStall, now - last - 5)
      last = now
    }, 5)

    const bi = await mod.buildUsageBiRawData()
    await new Promise((resolve) => setTimeout(resolve, 20))
    clearInterval(probe)

    expect(bi.fileCount).toBe(1)
    expect(bi.mergedBuckets.length).toBeGreaterThan(0)
    expect(parsedHere).toBe(0)
    expect(maxStall).toBeLessThan(100)
  }, 60_000)
})

describe('usage scan worker failure', () => {
  it('degrades to empty when the worker dies, and starts a new one on the next request', async () => {
    writeFixture((m) => new Date(Date.now() - 3600_000 + m * 60_000).toISOString())
    const { Worker } = await import('node:worker_threads')
    const { buildUsageScanWorker } = await import('./support/usage-scan-worker-build')
    const built = await buildUsageScanWorker()
    cleanupWorker = built.cleanup
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let started = 0
    mod.startUsageScanWorker((data) =>
      ++started === 1 ? new Worker('throw new Error("boom")', { eval: true }) : built.factory(data)
    )

    const failed = await mod.buildUsageCostSummary()
    expect(failed.fileCount).toBe(0)
    expect(failed.dailyRollup).toEqual([])

    expect((await mod.buildUsageCostSummary()).fileCount).toBe(3)
    expect(started).toBe(2)
  }, 30_000)
})

describe('usage cost cache', () => {
  it('removes the tmp files an interrupted save left behind', async () => {
    mkdirSync(cacheDir(), { recursive: true })
    const leftovers = ['cost-cache.json.2.tmp', 'cost-cache.json.10.tmp']
    for (const f of leftovers) writeFileSync(join(cacheDir(), f), '{"version":5,"files":{')
    const others = ['prefs.json', 'windows.jsonl', 'state.json.1.tmp']
    for (const f of others) writeFileSync(join(cacheDir(), f), '{}')

    await mod.buildUsageCostSummary()

    expect(leftovers.filter((f) => existsSync(join(cacheDir(), f)))).toEqual([])
    expect(others.filter((f) => existsSync(join(cacheDir(), f)))).toEqual(others)
  })
})
