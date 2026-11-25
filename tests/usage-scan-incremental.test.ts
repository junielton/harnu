import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUsageScanner, type UsageScanner } from '../src/main/usage-scan-worker'

// Transcripts are append-only JSONL. A file that only grew must be parsed from where the last scan
// stopped, and the numbers must be the ones a scan from scratch would give.

const NOW = new Date('2026-10-10T12:00:00.000Z')
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

let root = ''
let scratch = 0

const projects = (): string => join(root, 'projects')
const pathOf = (rel: string): string => join(projects(), rel)

beforeEach(() => {
  vi.setSystemTime(NOW)
  root = mkdtempSync(join(tmpdir(), 'harnu-incr-'))
  mkdirSync(projects(), { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

interface Req {
  id: string
  at: string
  model?: string
  cwd?: string
  input?: number
  text?: string
}

function assistant(r: Req): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: `req_${r.id}`,
    timestamp: r.at,
    ...(r.cwd ? { cwd: r.cwd } : {}),
    message: {
      id: `msg_${r.id}`,
      model: r.model ?? 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: r.text ?? 'ok' }],
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

const lines = (...l: string[]): string => l.join('\n') + '\n'

function put(rel: string, content: string | Buffer): void {
  mkdirSync(join(pathOf(rel), '..'), { recursive: true })
  writeFileSync(pathOf(rel), content)
}

/** A scanner over the test's files, with its own cache directory. */
function scanner(name: string): UsageScanner {
  return createUsageScanner({ projectsRoot: projects(), cacheDir: join(root, 'cache', name) })
}

/** The per-file state a scanner holds, as it would persist it. */
async function cached(s: UsageScanner, name: string): Promise<Record<string, unknown>> {
  await s.flush()
  return JSON.parse(readFileSync(join(root, 'cache', name, 'cost-cache.json'), 'utf8')).files
}

const by = <T>(list: readonly T[], key: (x: T) => string): T[] =>
  [...list].sort((x, y) => key(x).localeCompare(key(y)))

/** Totals across FILES are summed in completion order, so the last bit may differ between two scans. */
const rounded = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v))
  ) as T

async function totals(s: UsageScanner): Promise<unknown> {
  const bi = await s.bi()
  return rounded({
    fileCount: bi.fileCount,
    mergedBuckets: by(
      bi.mergedBuckets,
      (b) => `${b.sessionId}${b.day}${b.model}${b.isSubagent}${b.projectPath}`
    ),
    sessionAnatomies: by(bi.sessionAnatomies, (a) => a.sessionId),
    hourlyPoints: by(bi.hourlyPoints, (p) => `${p.sessionId}${p.hourStartMs}${p.model}`)
  })
}

/**
 * The incremental scanner against one that has never seen the files: each file's state must be equal to
 * the last bit, and so must the totals folded from it.
 */
async function expectSameAsFullRescan(s: UsageScanner, name: string): Promise<void> {
  const freshName = `fresh-${scratch++}`
  const fresh = scanner(freshName)
  const got = await totals(s)
  expect(got).toEqual(await totals(fresh))
  expect(await cached(s, name)).toEqual(await cached(fresh, freshName))
}

/** Transcript lines handed to JSON.parse while `run` runs. */
async function parsedDuring(run: () => Promise<unknown>): Promise<string[]> {
  const parse = JSON.parse
  const seen: string[] = []
  const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    if (typeof text === 'string' && /"type":"(assistant|user)"/.test(text.slice(0, 40))) {
      seen.push(text)
    }
    return parse(text, reviver)
  })
  try {
    await run()
  } finally {
    spy.mockRestore()
  }
  return seen
}

const MAIN = `-tmp-example-web/${A}.jsonl`

const old = (n: number): string =>
  assistant({ id: `old${n}`, at: '2026-10-02T10:00:00.000Z', cwd: '/tmp/example-web' })
const fresh = (n: number): string =>
  assistant({ id: `new${n}`, at: '2026-10-02T11:00:00.000Z', cwd: '/tmp/example-web' })

describe('a transcript that only grew', () => {
  const history = lines(...Array.from({ length: 200 }, (_, n) => old(n)))

  it('parses only the appended lines', async () => {
    put(MAIN, history)
    const s = scanner('inc')
    await s.bi()
    appendFileSync(pathOf(MAIN), lines(fresh(1), fresh(2)))

    const parsed = await parsedDuring(() => s.bi())

    expect(parsed.filter((t) => t.includes('req_old'))).toEqual([])
    expect(parsed.filter((t) => t.includes('req_new')).length).toBeGreaterThan(0)
    expect((await s.merged()).mergedBuckets[0].requestCount).toBe(202)
  })

  it('still parses only the appended lines after a restart', async () => {
    put(MAIN, history)
    const before = scanner('inc')
    await before.bi()
    await before.flush()
    appendFileSync(pathOf(MAIN), lines(fresh(1)))

    const parsed = await parsedDuring(() => scanner('inc').bi())

    expect(parsed.filter((t) => t.includes('req_old'))).toEqual([])
    expect(parsed.filter((t) => t.includes('req_new')).length).toBeGreaterThan(0)
  })

  it('finishes a line that was cut in half at the last scan', async () => {
    const next = fresh(1) + '\n'
    put(MAIN, history + next.slice(0, 40))
    const s = scanner('inc')
    await expectSameAsFullRescan(s, 'inc')
    appendFileSync(pathOf(MAIN), next.slice(40))
    await expectSameAsFullRescan(s, 'inc')
    expect((await s.merged()).mergedBuckets[0].requestCount).toBe(201)
  })

  it('counts a last line with no newline once, before and after the newline arrives', async () => {
    put(MAIN, history + fresh(1))
    const s = scanner('inc')
    expect((await s.merged()).mergedBuckets[0].requestCount).toBe(201)
    appendFileSync(pathOf(MAIN), '\n' + lines(fresh(2)))
    await expectSameAsFullRescan(s, 'inc')
    expect((await s.merged()).mergedBuckets[0].requestCount).toBe(202)
  })

  it('counts a request once when its blocks straddle two scans', async () => {
    put(MAIN, lines(old(1), old(2)))
    const s = scanner('inc')
    await s.bi()
    appendFileSync(pathOf(MAIN), lines(old(2), old(1), fresh(1)))
    await expectSameAsFullRescan(s, 'inc')
    expect((await s.merged()).mergedBuckets[0].requestCount).toBe(3)
  })

  it('relabels the earlier numbers when the first cwd arrives later', async () => {
    const at = '2026-10-02T10:00:00.000Z'
    put(MAIN, lines(assistant({ id: 'a', at })))
    const s = scanner('inc')
    await s.bi()
    appendFileSync(pathOf(MAIN), lines(assistant({ id: 'b', at, cwd: '/tmp/example-web' })))
    await expectSameAsFullRescan(s, 'inc')
    expect((await s.merged()).mergedBuckets.map((b) => b.projectPath)).toEqual(['/tmp/example-web'])
  })

  it('drops hourly points that aged out of retention, as a full rescan would', async () => {
    const day = 24 * 3600_000
    const at = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString()
    put(
      MAIN,
      lines(
        assistant({ id: 'edge', at: at(89 * day) }),
        // Two requests in one clock hour that the cutoff will later fall between.
        assistant({ id: 'h1', at: at(88 * day - 60_000) }),
        assistant({ id: 'h2', at: at(88 * day - 40 * 60_000) })
      )
    )
    const s = scanner('inc')
    await s.bi()

    vi.setSystemTime(new Date(NOW.getTime() + 1.5 * day))
    appendFileSync(pathOf(MAIN), lines(assistant({ id: 'now', at: at(0) })))
    await expectSameAsFullRescan(s, 'inc')

    vi.setSystemTime(new Date(NOW.getTime() + 2 * day + 20 * 60_000))
    appendFileSync(pathOf(MAIN), lines(assistant({ id: 'later', at: at(0) })))
    await expectSameAsFullRescan(s, 'inc')
  })
})

/** Small seeded generator, so a failing sequence replays. */
function random(seed: number): (max: number) => number {
  let x = seed
  return (max) => {
    x = (x * 48271) % 2147483647
    return x % max
  }
}

const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5-20260101', 'claude-opus-4-8']

/** One whole transcript with everything the folds keep state about. */
function transcript(rand: (max: number) => number, tag: string, cwdFrom: number): string {
  const out: string[] = []
  const at = (i: number): string =>
    new Date(Date.parse('2026-10-01T20:00:00.000Z') + i * 17 * 60_000).toISOString()
  for (let i = 0; i < 40; i++) {
    const cwd = i >= cwdFrom ? '/tmp/example-web' : undefined
    const kind = rand(10)
    if (kind === 0) out.push(user(i % 2 ? `ajuste a busca é ${i} 🔎` : `fix the build ${i}`, at(i)))
    else if (kind === 1) {
      out.push(
        JSON.stringify({ type: 'custom-title', customTitle: `title ${i}`, timestamp: at(i) })
      )
    } else if (kind === 2) {
      out.push(JSON.stringify({ type: 'ai-title', aiTitle: `auto ${i}` }))
    } else if (kind === 3) out.push('{"type":"assistant","requestId":"torn')
    else if (kind === 4 && out.length) out.push(out[rand(out.length)])
    else {
      out.push(
        assistant({
          id: `${tag}${i}`,
          at: at(i),
          cwd,
          model: MODELS[rand(MODELS.length)],
          input: 1 + rand(90_000),
          text: 'é ✓ 🔎 '.repeat(rand(20))
        })
      )
    }
  }
  return lines(...out)
}

describe('random appends against a full rescan', () => {
  it.each([1, 7, 42, 1234, 99991])('seed %i', async (seed) => {
    const rand = random(seed)
    const files = [
      { rel: MAIN, tag: 'main', cwdFrom: 0 },
      { rel: `-tmp-example-web/${A}/subagents/agent-1.jsonl`, tag: 'sub', cwdFrom: 0 },
      { rel: `-tmp-api-gateway/${B}.jsonl`, tag: 'late', cwdFrom: 25 }
    ].map((f) => ({ ...f, bytes: Buffer.from(transcript(rand, f.tag, f.cwdFrom)), at: 0 }))
    for (const f of files) put(f.rel, '')

    const s = scanner('inc')
    while (files.some((f) => f.at < f.bytes.length)) {
      for (const f of files) {
        if (rand(3) === 0) continue
        // Byte chunks: they end in the middle of a line, and of a multi-byte character.
        const end = Math.min(f.bytes.length, f.at + 1 + rand(f.bytes.length / 4))
        appendFileSync(pathOf(f.rel), f.bytes.subarray(f.at, end))
        f.at = end
      }
      await expectSameAsFullRescan(s, 'inc')
    }
  })
})

describe('a transcript that did not only grow', () => {
  const at = '2026-10-02T10:00:00.000Z'
  const req = (id: string, input = 1000): string => assistant({ id, at, input })

  async function rewritten(before: string, after: string): Promise<void> {
    put(MAIN, before)
    const s = scanner('inc')
    await s.bi()
    put(MAIN, after)
    // A rewrite can land inside the same filesystem timestamp tick as the first write.
    const later = new Date(statSync(pathOf(MAIN)).mtimeMs + 5_000)
    utimesSync(pathOf(MAIN), later, later)
    await expectSameAsFullRescan(s, 'inc')
  }

  it('re-parses a truncated file', async () => {
    put(MAIN, lines(req('a'), req('b'), req('c')))
    const s = scanner('inc')
    await s.bi()
    truncateSync(pathOf(MAIN), Buffer.byteLength(lines(req('a'))))
    await expectSameAsFullRescan(s, 'inc')
    expect((await s.merged()).mergedBuckets[0].requestCount).toBe(1)
  })

  it('re-parses a smaller rewrite', async () => {
    await rewritten(lines(req('a'), req('b'), req('c')), lines(req('z')))
  })

  it('re-parses a larger file whose start changed', async () => {
    await rewritten(lines(req('a'), req('b')), lines(req('x'), req('b'), req('c')))
  })

  it('re-parses a larger file changed just before where the last scan stopped', async () => {
    const head = Array.from({ length: 40 }, (_, n) => req(`h${n}`))
    await rewritten(lines(...head, req('a')), lines(...head, req('z'), req('b')))
  })

  it('re-parses a rewrite of the same size', async () => {
    await rewritten(lines(req('a', 1000)), lines(req('a', 9000)))
  })
})

describe('two scans at once', () => {
  it('counts appended requests once', async () => {
    put(MAIN, lines(old(1), old(2)))
    const s = scanner('inc')
    await s.bi()
    appendFileSync(pathOf(MAIN), lines(fresh(1)))
    await Promise.all([s.merged(), s.bi()])
    await expectSameAsFullRescan(s, 'inc')
    expect((await s.merged()).mergedBuckets[0].requestCount).toBe(3)
  })
})

describe('a same-size rewrite away from both ends', () => {
  it('is re-parsed, though the fingerprint cannot see it', async () => {
    const at = '2026-10-02T10:00:00.000Z'
    const pad = Array.from({ length: 30 }, (_, n) => assistant({ id: `p${100 + n}`, at }))
    const file = (input: number): string =>
      lines(
        ...pad,
        assistant({ id: 'mid', at, input }),
        ...pad.map((l) => l.replace(/_p1/g, '_q1'))
      )
    put(MAIN, file(1000))
    const s = scanner('inc')
    await s.bi()
    put(MAIN, file(9000))
    const later = new Date(statSync(pathOf(MAIN)).mtimeMs + 5_000)
    utimesSync(pathOf(MAIN), later, later)
    await expectSameAsFullRescan(s, 'inc')
  })
})
