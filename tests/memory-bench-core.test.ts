import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * The memory efficiency benchmark (T620, spec docs/specs/2026-11-04-memory-benchmark/spec.md).
 * `scripts/memory-bench-core.mjs` holds the pure metric functions; `scripts/memory-bench.mjs`
 * is the read-only CLI shell. The fixtures under tests/fixtures/memory-bench/ are a fake home
 * (`home/projects/<slug>/*.jsonl`), a fake repo, a fake memory dir and a plain non-git folder.
 * Transcripts name their folders as `/fixture/...`; `--path-map` points that prefix at the
 * fixture directory, so the same files work on any machine.
 */

const ROOT = resolve(__dirname, '..')
const FX = resolve(ROOT, 'tests/fixtures/memory-bench')
const CLI = resolve(ROOT, 'scripts/memory-bench.mjs')

/** Every metric name the spec makes a contract. */
const METRICS = [
  'capture_coverage',
  'decision_yield',
  'recall_hit_at_5',
  'boot_handoff_chars',
  'memory_read_default_bytes',
  'hot_freshness_hours',
  'index_bytes',
  'digest_count',
  'digests_per_day',
  'orphan_loss'
]

function bench(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

const fixtureArgs = ['--home', `${FX}/home`, '--path-map', `/fixture=${FX}`]

describe('memory-bench CLI', () => {
  it('AC-1: exits 0 on this repo and prints every metric as a finite number', () => {
    const run = bench(['--repo', '.', ...fixtureArgs, '--json'])
    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
    const card = JSON.parse(run.stdout) as { metrics: Record<string, unknown> }
    for (const name of METRICS) {
      expect(typeof card.metrics[name], name).toBe('number')
      expect(Number.isFinite(card.metrics[name]), name).toBe(true)
    }
  })

  it('AC-3: the non-git folder with sessions and no memory scores capture 0 without throwing', () => {
    const run = bench(['--repo', `${FX}/plain`, ...fixtureArgs, '--json'])
    expect(run.code).toBe(0)
    const card = JSON.parse(run.stdout) as {
      repo: { kind: string }
      metrics: Record<string, number>
    }
    expect(card.repo.kind).toBe('non-git')
    expect(card.metrics.capture_sessions).toBe(3)
    expect(card.metrics.capture_coverage).toBe(0)
    expect(card.metrics.capture_coverage_nongit).toBe(0)
    expect(card.metrics.orphan_loss).toBeGreaterThanOrEqual(0)
    expect(card.metrics.memory_read_default_bytes).toBeGreaterThan(0)
  })
})
