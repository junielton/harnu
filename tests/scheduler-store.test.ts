import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseWorkers,
  serializeWorkers,
  parseRuns,
  appendRunLine,
  trimRuns,
  RUN_RETENTION
} from '../src/main/scheduler-store'
import type { Run, Worker } from '../src/main/scheduler-core'

const W: Worker = {
  id: 'w1',
  name: 'PR watcher',
  enabled: true,
  prompt: 'p',
  folder: '/repo',
  everyMinutes: 5,
  runOnBoot: true,
  model: 'haiku',
  effort: 'low',
  mode: 'observe',
  timeoutSeconds: 300,
  carryLastResult: false,
  notifyOn: 'silent',
  failureStreak: 0
}

function run(over: Partial<Run> = {}): Run {
  return {
    workerId: 'w1',
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    status: 'ok',
    result: 'fine',
    terminalReason: 'completed',
    numTurns: 1,
    costUsd: 0.01,
    tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 },
    denials: [],
    ...over
  }
}

describe('workers.json', () => {
  it('round-trips', () => {
    expect(parseWorkers(serializeWorkers([W]))).toEqual([W])
  })

  it('returns an empty list for a missing or corrupt file rather than throwing', () => {
    expect(parseWorkers('')).toEqual([])
    expect(parseWorkers('{ not json')).toEqual([])
    expect(parseWorkers('{"version":1}')).toEqual([])
  })

  it('drops a worker with no folder — it could never run', () => {
    const text = JSON.stringify({ version: 1, workers: [{ ...W, folder: '' }] })
    expect(parseWorkers(text)).toEqual([])
  })
})

describe('run history (JSONL)', () => {
  it('round-trips one line per run', () => {
    const text = [appendRunLine(run()), appendRunLine(run({ status: 'error' }))].join('')
    expect(parseRuns(text).map((r) => r.status)).toEqual(['ok', 'error'])
  })

  it('skips a corrupt line instead of losing the whole history', () => {
    const text = appendRunLine(run()) + 'garbage\n' + appendRunLine(run({ status: 'timeout' }))
    expect(parseRuns(text).map((r) => r.status)).toEqual(['ok', 'timeout'])
  })

  it('keeps the newest RUN_RETENTION runs', () => {
    const many = Array.from({ length: RUN_RETENTION + 40 }, (_, i) => run({ startedAt: i }))
    const kept = trimRuns(many, RUN_RETENTION)
    expect(kept).toHaveLength(RUN_RETENTION)
    expect(kept[kept.length - 1].startedAt).toBe(RUN_RETENTION + 39)
  })
})

// ── BUG-114 / BUG-115 / T304: a definitions file written by an older Harnu ────

describe('a schedulers.json written before these fields changed', () => {
  /** Verbatim shape of a pre-T303 file: two dead fields, no `notifyOn`. */
  const LEGACY = JSON.stringify({
    version: 1,
    workers: [
      {
        id: 'w1',
        name: 'PR watcher',
        enabled: true,
        prompt: 'p',
        folder: '/repo',
        everyMinutes: 5,
        runOnBoot: true,
        model: 'haiku',
        effort: 'low',
        mode: 'observe',
        provider: 'lm-studio-1',
        timeoutSeconds: 300,
        carryLastResult: false,
        keepTranscript: true,
        failureStreak: 0
      }
    ]
  })

  it('loads without error', () => {
    expect(parseWorkers(LEGACY)).toHaveLength(1)
    expect(parseWorkers(LEGACY)[0].name).toBe('PR watcher')
  })

  it('drops the two removed fields rather than carrying them forward', () => {
    const w = parseWorkers(LEGACY)[0] as Worker & Record<string, unknown>
    expect(w.keepTranscript).toBeUndefined()
    expect(w.provider).toBeUndefined()
    // And they stop being written back out: an old file loads, and heals.
    expect(serializeWorkers(parseWorkers(LEGACY))).not.toContain('keepTranscript')
    expect(serializeWorkers(parseWorkers(LEGACY))).not.toContain('provider')
  })

  it('resolves the worker to Silent — no behaviour change for anyone', () => {
    expect(parseWorkers(LEGACY)[0].notifyOn).toBe('silent')
  })

  it('keeps the optional fields it still has', () => {
    const text = JSON.stringify({
      version: 1,
      workers: [{ ...W, extraReadCommands: ['Bash(jj log:*)'], systemPrompt: 'be terse' }]
    })
    const w = parseWorkers(text)[0]
    expect(w.extraReadCommands).toEqual(['Bash(jj log:*)'])
    expect(w.systemPrompt).toBe('be terse')
  })
})

// ── T306: the whitelist cannot silently fall behind the interface ────────────

/**
 * `normalizeWorker` rebuilds a persisted worker key by key, which is what makes
 * a removed field stop being written back out (BUG-114/BUG-115 above). The cost
 * of that shape is asymmetric:
 *
 * - a forgotten **required** field is a compile error — the function's `Worker`
 *   return type catches it before anything runs;
 * - a forgotten **optional** field is silent. It vanishes on the next
 *   load→save, with no error, no type failure, and no failing test. A worker
 *   would simply lose the setting the next time Harnu read its definitions.
 *
 * So the optional half needs a guard the type system cannot give it. This reads
 * both sources and asserts the two lists agree: add an optional field to
 * `Worker` without enumerating it in `normalizeWorker` and this goes red, which
 * is the only moment anyone would otherwise find out.
 */
describe('normalizeWorker enumerates every optional field on Worker', () => {
  const CORE = readFileSync(join(__dirname, '../src/main/scheduler-core.ts'), 'utf8')
  const STORE = readFileSync(join(__dirname, '../src/main/scheduler-store.ts'), 'utf8')

  /** Every `name?:` declared at the top level of `interface Worker`. */
  function optionalWorkerKeys(source: string): string[] {
    const body = /export interface Worker \{\n([\s\S]*?)\n\}/.exec(source)
    if (!body) throw new Error('interface Worker not found in scheduler-core.ts')
    return [...body[1].matchAll(/^ {2}([A-Za-z0-9_]+)\?:/gm)].map((m) => m[1])
  }

  function normalizeWorkerBody(source: string): string {
    const fn = /function normalizeWorker\(w: Worker\): Worker \{\n([\s\S]*?)\n\}/.exec(source)
    if (!fn) throw new Error('normalizeWorker not found in scheduler-store.ts')
    return fn[1]
  }

  it('finds the optional fields it is meant to be checking', () => {
    // A guard whose parser silently matched nothing would pass forever.
    expect(optionalWorkerKeys(CORE).length).toBeGreaterThan(0)
    expect(optionalWorkerKeys(CORE)).toEqual(
      expect.arrayContaining(['notifyOn', 'extraReadCommands', 'systemPrompt'])
    )
  })

  it('names each one, so none can be dropped on the next load→save', () => {
    const body = normalizeWorkerBody(STORE)
    const missing = optionalWorkerKeys(CORE).filter((key) => !new RegExp(`\\b${key}\\b`).test(body))
    expect(missing).toEqual([])
  })

  it('actually preserves each one through a full round-trip', () => {
    // The list check above is structural; this is the behaviour it stands for.
    const stored: Record<string, unknown> = {
      ...W,
      extraReadCommands: ['Bash(jj log:*)'],
      systemPrompt: 'be terse',
      notifyOn: 'every'
    }
    const loaded = parseWorkers(JSON.stringify({ version: 1, workers: [stored] }))[0] as Record<
      string,
      unknown
    >
    for (const key of optionalWorkerKeys(CORE)) {
      expect({ key, value: loaded[key] }).toEqual({ key, value: stored[key] })
    }
  })
})
