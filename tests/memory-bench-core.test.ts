import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  computeScorecard,
  concurrencyLimit,
  findSection,
  grepMemory,
  isOperatorTurn,
  listPageIds,
  mapLimit,
  memoryReadDefaultBytes,
  parseBlocks,
  parseDigestName,
  parsePathMaps,
  mapPath,
  recallHit,
  renderMarkdown,
  summarizeTranscript,
  validateQuestions
} from '../scripts/memory-bench-core.mjs'
import { queryMemory, readMemoryOverview } from '../src/main/mcp/memory-store'

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
const MEM = join(FX, 'memory')

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
const repoArgs = [
  '--repo',
  `${FX}/repo`,
  '--kind',
  'git',
  '--memory',
  MEM,
  ...fixtureArgs,
  '--questions',
  `${FX}/questions.fixture.json`
]

type Card = {
  repo: { name: string; kind: string; memory: string }
  metrics: Record<string, number>
  detail: {
    capture_by_folder: { folder: string; sessions: number; captured: number }[]
    recall_misses: string[]
    recall_unresolved_gold: string[]
    boot: Record<string, number>
  }
}

function runJson(args: string[]): Card {
  const run = bench([...args, '--json'])
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as Card
}

/** The fixture memory as the shell would hand it to the core. */
function fixtureMemory(dir = MEM) {
  const md = (d: string): string[] => {
    try {
      return readdirSync(d)
        .filter((n) => n.endsWith('.md'))
        .sort()
    } catch {
      return []
    }
  }
  const names = {
    root: md(dir),
    roadmap: md(join(dir, 'roadmap')),
    sessions: md(join(dir, 'sessions')),
    archive: md(join(dir, 'archive')),
    learning: md(join(dir, 'learning'))
  }
  const files = listPageIds(names).map((page: string) => ({
    page,
    content: readFileSync(join(dir, `${page}.md`), 'utf8')
  }))
  return {
    hot: readFileSync(join(dir, 'hot.md'), 'utf8'),
    hotMtimeMs: 0,
    index: readFileSync(join(dir, 'index.md'), 'utf8'),
    decisions: readFileSync(join(dir, 'decisions.md'), 'utf8'),
    names,
    files
  }
}

const T = (iso: string): number => Date.parse(iso)

describe('memory-bench CLI', () => {
  it('AC-1: exits 0 on this repo and prints every metric as a finite number', () => {
    const run = bench(['--repo', '.', ...fixtureArgs, '--json'])
    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
    const card = JSON.parse(run.stdout) as { metrics: Record<string, unknown> }
    for (const name of Object.keys(card.metrics).concat(METRICS)) {
      expect(typeof card.metrics[name], name).toBe('number')
      expect(Number.isFinite(card.metrics[name]), name).toBe(true)
    }
  })

  it('AC-2: two fixture runs print byte-identical JSON with no absolute path', () => {
    const a = bench([...repoArgs, '--json'])
    const b = bench([...repoArgs, '--json'])
    expect(a.code).toBe(0)
    expect(a.stdout).toBe(b.stdout)
    expect(a.stdout).not.toContain(FX)
    expect(a.stdout).not.toContain(ROOT)
    const md = bench(repoArgs)
    expect(md.stdout).toBe(bench(repoArgs).stdout)
    expect(md.stdout).not.toContain(ROOT)
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

  it('scores the fixture repo with every metric at its hand-computed value', () => {
    const card = runJson(repoArgs)
    expect(card.repo).toEqual({ name: 'repo', kind: 'git', memory: 'present' })
    expect(card.metrics).toMatchObject({
      capture_coverage: 0.6,
      capture_coverage_git: 0.6,
      capture_coverage_nongit: 0,
      capture_sessions: 5,
      captured_sessions: 3,
      sessions_total: 6,
      decision_yield: 0.4,
      decision_yield_agent: 0.2,
      decision_yield_human: 0.2,
      decision_entries: 2,
      session_days: 5,
      decision_blocks: 3,
      decision_blocks_human: 1,
      recall_hit_at_5: 0.8571,
      recall_hit_at_5_strict: 0.7143,
      recall_hit_at_5_verbatim: 0,
      recall_questions: 7,
      boot_handoff_chars: 0,
      boot_handoff_measured: 0,
      digest_count: 4,
      digests_per_day: 0.8,
      orphan_loss: 0.5,
      orphan_transcripts: 2
    })
    expect(card.detail.capture_by_folder).toEqual([
      { folder: '.', sessions: 2, captured: 1 },
      { folder: '.claude/worktrees/gone-wt (gone)', sessions: 2, captured: 1 },
      { folder: 'packages/app', sessions: 1, captured: 1 }
    ])
    expect(card.detail.recall_unresolved_gold).toEqual([])
  })

  it('narrows every flow metric to the --since/--until window', () => {
    const card = runJson([...repoArgs, '--since', '2026-10-02', '--until', '2026-10-04'])
    expect(card.metrics.sessions_total).toBe(3) // bbbb, cccc (10-02), dddd (10-03)
    expect(card.metrics.capture_sessions).toBe(2)
    expect(card.metrics.decision_entries).toBe(1) // the human entry of 10-03
    expect(card.metrics.digest_count).toBe(1)
    expect(card.metrics.digests_per_day).toBe(0.5)
    expect(card.metrics.orphan_transcripts).toBe(0)
  })

  it('reads boot captures for boot_handoff_chars', () => {
    const card = runJson([...repoArgs, '--boot', `${FX}/boot`])
    expect(card.metrics.boot_handoff_measured).toBe(1)
    expect(card.detail.boot.startup).toBeGreaterThan(0)
    expect(card.metrics.boot_handoff_chars).toBe(
      Math.max(card.detail.boot.startup, card.detail.boot.resume, card.detail.boot.compact)
    )
    expect(card.metrics.boot_handoff_tokens).toBe(Math.ceil(card.metrics.boot_handoff_chars / 4))
  })

  it('refuses bad arguments with exit 2', () => {
    expect(bench(['--since', 'yesterday']).code).toBe(2)
    expect(bench(['--kind', 'svn']).code).toBe(2)
    expect(bench(['--path-map', 'nothing']).code).toBe(2)
    expect(bench(['--bogus']).code).toBe(2)
    expect(bench(['--repo', `${FX}/does-not-exist`]).code).toBe(2)
    expect(bench([...repoArgs.slice(0, -2), '--questions', `${FX}/repo/README.md`]).code).toBe(2)
  })

  it('AC-5: never writes into a read-only memory dir and caps concurrency at half the CPUs', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'memory-bench-ro-'))
    const dir = join(tmp, 'memory')
    cpSync(MEM, dir, { recursive: true })
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? [join(d, e.name), ...walk(join(d, e.name))] : [join(d, e.name)]
      )
    const snapshot = (): string[] =>
      walk(dir)
        .sort()
        .map((p) => {
          const s = statSync(p)
          const hash = s.isFile()
            ? createHash('sha256').update(readFileSync(p)).digest('hex')
            : 'dir'
          return `${p} ${s.mode} ${s.mtimeMs} ${hash}`
        })
    const paths = walk(dir)
    try {
      for (const p of paths) chmodSync(p, statSync(p).isDirectory() ? 0o555 : 0o444)
      chmodSync(dir, 0o555)
      const before = snapshot()
      const args = repoArgs.map((a) => (a === MEM ? dir : a))
      const card = runJson(args)
      expect(card.repo.memory).toBe('present')
      expect(snapshot()).toEqual(before)
    } finally {
      chmodSync(dir, 0o755)
      for (const p of paths) chmodSync(p, statSync(p).isDirectory() ? 0o755 : 0o644)
      rmSync(tmp, { recursive: true, force: true })
    }

    for (let cpus = 1; cpus <= 64; cpus++) {
      expect(concurrencyLimit(cpus)).toBeLessThanOrEqual(Math.max(1, Math.floor(cpus / 2)))
      expect(concurrencyLimit(cpus)).toBeGreaterThanOrEqual(1)
    }
    let active = 0
    let peak = 0
    const out = await mapLimit([...Array(40).keys()], concurrencyLimit(8), async (i: number) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 1))
      active--
      return i * 2
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(out[39]).toBe(78)
  })
})

describe('AC-4: the mirrors agree with the real memory_read and memory_query', () => {
  it('memory_read_default_bytes equals the real page-less memory_read payload', async () => {
    const overview = await readMemoryOverview(MEM)
    expect(overview).not.toBeNull()
    const real = Buffer.byteLength(JSON.stringify({ ok: true, memory: overview }), 'utf8')
    const mem = fixtureMemory()
    expect(listPageIds(mem.names)).toEqual(overview?.pages)
    expect(memoryReadDefaultBytes({ hot: mem.hot, index: mem.index, pages: overview!.pages })).toBe(
      real
    )
  })

  it('an absent memory dir costs exactly the real "no memory yet" payload', async () => {
    expect(await readMemoryOverview(join(FX, 'no-such-memory'))).toBeNull()
    const real = Buffer.byteLength(
      JSON.stringify({
        ok: true,
        memory: null,
        message:
          'No project memory yet for this repo. The first memory_append (e.g. page:decisions or page:hot) scaffolds `.harnu/memory/`.'
      }),
      'utf8'
    )
    expect(memoryReadDefaultBytes({ hot: null, index: null, pages: [] })).toBe(real)
  })

  it('the grep mirror returns the same pages and lines as memory_query', async () => {
    const mem = fixtureMemory()
    const queries = [
      'health',
      'Why',
      'session',
      'provenance',
      'cache layer',
      'nothing-matches',
      'E'
    ]
    for (const q of queries) {
      const real = (await queryMemory(MEM, q)).matches.map((m) => `${m.page}:${m.line}`)
      const mirror = grepMemory(mem.files, q).map(
        (m: { page: string; line: number }) => `${m.page}:${m.line}`
      )
      expect(mirror, q).toEqual(real)
    }
  })

  it('the frozen question set has at least 40 valid questions whose queries are spans of the question', () => {
    const raw = JSON.parse(readFileSync(join(FX, 'questions.harnu.json'), 'utf8'))
    const qs = validateQuestions(raw)
    expect(qs.length).toBeGreaterThanOrEqual(40)
    expect(() =>
      validateQuestions([{ question: 'Why is X slow?', query: 'latency', expect: ['decisions'] }])
    ).toThrow(/not a span/)
  })
})

describe('memory-bench core', () => {
  it('metric capture_coverage: counts only sessions with three operator turns', () => {
    const turn = (content: unknown, extra: Record<string, unknown> = {}): string =>
      JSON.stringify({
        type: 'user',
        cwd: '/r',
        timestamp: '2026-10-01T00:00:00Z',
        message: { content },
        ...extra
      })
    expect(isOperatorTurn(JSON.parse(turn('Hello')))).toBe(true)
    expect(isOperatorTurn(JSON.parse(turn('<command-name>/status</command-name>')))).toBe(true)
    // An image-only line has no operator text, so it is not a turn (benchmark spec "Operator
    // turn"; memory U1 AC-2). A line with text beside the image is one.
    expect(isOperatorTurn(JSON.parse(turn([{ type: 'image' }])))).toBe(false)
    expect(
      isOperatorTurn(JSON.parse(turn([{ type: 'text', text: 'look at this' }, { type: 'image' }])))
    ).toBe(true)
    expect(isOperatorTurn(JSON.parse(turn([{ type: 'tool_result', content: 'x' }])))).toBe(false)
    expect(isOperatorTurn(JSON.parse(turn('Hello', { isMeta: true })))).toBe(false)
    expect(isOperatorTurn(JSON.parse(turn('Hello', { isSidechain: true })))).toBe(false)
    expect(isOperatorTurn(JSON.parse(turn('Summary', { isCompactSummary: true })))).toBe(false)
    expect(
      isOperatorTurn(JSON.parse(turn('<local-command-stdout>ok</local-command-stdout>')))
    ).toBe(false)
    expect(isOperatorTurn(JSON.parse(turn('<task-notification>done</task-notification>')))).toBe(
      false
    )
    expect(isOperatorTurn(JSON.parse(turn('[Request interrupted by user]')))).toBe(false)
    const fold = summarizeTranscript([
      '{"type":"permission-mode"}',
      turn('one'),
      'not json',
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T00:05:00Z' }),
      turn('two', { timestamp: '2026-10-01T00:09:00Z' }),
      ''
    ])
    expect(fold).toEqual({
      cwd: '/r',
      startMs: T('2026-10-01T00:00:00Z'),
      endMs: T('2026-10-01T00:09:00Z'),
      operatorTurns: 2
    })
    expect(parseDigestName('2026-10-01-AAAA1111.md')).toEqual({
      date: '2026-10-01',
      short: 'aaaa1111'
    })
    expect(parseDigestName('notes.md')).toBeNull()
  })

  const base = {
    repo: { name: 'r', kind: 'git' },
    roots: ['/r'],
    window: { since: null, until: null },
    questions: null,
    boot: null
  }
  const session = (id: string, over: Record<string, unknown> = {}) => ({
    sessionId: id,
    cwd: '/r',
    startMs: T('2026-10-01T09:00:00Z'),
    endMs: T('2026-10-01T10:00:00Z'),
    operatorTurns: 3,
    bytes: 100,
    cwdExists: true,
    ...over
  })
  const memory = (over: Record<string, unknown> = {}) => ({
    hot: '# Hot',
    hotMtimeMs: T('2026-10-01T10:00:00Z'),
    index: '',
    decisions: null,
    names: { root: ['hot.md'], sessions: [] },
    files: [],
    ...over
  })

  it('metric decision_yield: entries over session-days, split by author', () => {
    const decisions = [
      '# Decisions',
      '> guidance',
      '',
      '## A',
      '> entry: e-00000001 · valid_from=2026-10-01',
      '> provenance: author=agent · at=2026-10-01',
      '',
      '## B (no entry line, context only)',
      '> provenance: author=human · at=2026-10-01',
      '## C',
      '> entry: e-00000002 · valid_from=2026-10-02',
      '> provenance: author=worker · at=2026-10-02'
    ].join('\n')
    const blocks = parseBlocks(decisions)
    expect(blocks.map((b: { entryId: string | null }) => b.entryId)).toEqual([
      'e-00000001',
      null,
      'e-00000002'
    ])
    expect(blocks[0].startLine).toBe(4)
    const card = computeScorecard({
      ...base,
      memory: memory({ decisions }),
      sessions: [
        session('s1'),
        session('s2'),
        session('s3', { startMs: T('2026-10-02T09:00:00Z') })
      ]
    })
    expect(card.metrics.session_days).toBe(2)
    expect(card.metrics.decision_yield).toBe(1)
    expect(card.metrics.decision_yield_agent).toBe(0.5)
    expect(card.metrics.decision_yield_worker).toBe(0.5)
    expect(card.metrics.decision_yield_human).toBe(0)
    expect(card.metrics.decision_blocks_human).toBe(1)
  })

  it('metric recall_hit_at_5: page-level and strict hits over the first five distinct pages', () => {
    const files = [
      { page: 'decisions', content: '## One\nalpha\n## Two\nbeta alpha' },
      { page: 'hot', content: 'gamma' },
      ...['a', 'b', 'c', 'd', 'e'].map((p) => ({ page: `sessions/${p}`, content: 'delta' }))
    ]
    const blocks = new Map(files.map((f) => [f.page, parseBlocks(f.content)]))
    expect(findSection(files[0].content, 'two')).toEqual({ startLine: 3, endLine: 4 })
    expect(recallHit(files, blocks, 'alpha', ['decisions#Two'])).toEqual({
      page: true,
      strict: true
    })
    expect(recallHit(files, blocks, 'One', ['decisions#Two'])).toEqual({
      page: true,
      strict: false
    })
    expect(recallHit(files, blocks, 'delta', ['sessions/e'])).toEqual({ page: true, strict: true })
    expect(recallHit(files, blocks, 'delta', ['hot'])).toEqual({ page: false, strict: false })
    expect(recallHit(files, blocks, 'gamma', ['decisions#Missing'])).toEqual({
      page: false,
      strict: false
    })
    // The 50-match cap: the page past the cap is never returned.
    const flood = [
      { page: 'a', content: Array(60).fill('x').join('\n') },
      { page: 'b', content: 'x' }
    ]
    expect(grepMemory(flood, 'X')).toHaveLength(50)
    expect(recallHit(flood, new Map(), 'x', ['b'])).toEqual({ page: false, strict: false })
  })

  it('metric boot_handoff_chars: the largest start source, in code points', () => {
    const card = computeScorecard({
      ...base,
      memory: null,
      sessions: [],
      boot: { startup: 'ab', resume: '😀😀😀', compact: undefined }
    })
    expect(card.metrics.boot_handoff_chars).toBe(3)
    expect(card.metrics.boot_handoff_tokens).toBe(1)
    expect(card.metrics.boot_handoff_measured).toBe(1)
  })

  it('metric memory_read_default_bytes: UTF-8 bytes of the payload', () => {
    const small = memoryReadDefaultBytes({ hot: 'é', index: '', pages: ['hot'] })
    expect(small).toBe(
      Buffer.byteLength(
        JSON.stringify({ ok: true, memory: { hot: 'é', index: '', pages: ['hot'] } })
      )
    )
    expect(
      listPageIds({ root: ['z.md', 'a.md', 'x.txt'], sessions: ['s.md'], learning: ['l.md'] })
    ).toEqual(['a', 'z', 'sessions/s', 'learning/l'])
  })

  it('metric hot_freshness_hours: median lag of the last 30 session ends behind hot.md', () => {
    const hot = T('2026-10-01T10:00:00Z')
    const ends = [
      '2026-10-01T09:00:00Z',
      '2026-10-01T10:00:00Z',
      '2026-10-01T10:30:00Z',
      '2026-10-01T11:30:00Z'
    ]
    const sessions = ends.map((e, i) => session(`s${i}`, { endMs: T(e) }))
    const card = computeScorecard({ ...base, memory: memory({ hotMtimeMs: hot }), sessions })
    expect(card.metrics.hot_freshness_minutes).toBe(15) // lags 0, 0, 30, 90
    expect(card.metrics.hot_freshness_hours).toBe(0.25)
    const old = Array.from({ length: 40 }, (_, i) =>
      session(`o${String(i).padStart(2, '0')}`, { endMs: hot + (i < 30 ? 60 : 0) * 60_000 })
    )
    expect(
      computeScorecard({ ...base, memory: memory({ hotMtimeMs: hot }), sessions: old }).metrics
        .hot_freshness_hours
    ).toBe(1)
    expect(
      computeScorecard({ ...base, memory: memory({ hot: null }), sessions }).metrics
        .hot_freshness_hours
    ).toBe(-1)
    expect(
      computeScorecard({ ...base, memory: memory(), sessions: [] }).metrics.hot_freshness_hours
    ).toBe(0)
  })

  it('metrics index_bytes, digest_count and digests_per_day', () => {
    const card = computeScorecard({
      ...base,
      memory: memory({
        index: 'ü',
        names: {
          root: ['index.md'],
          sessions: ['2026-10-01-aaaaaaaa.md', '2026-10-10-bbbbbbbb.md', 'readme.md']
        }
      }),
      sessions: []
    })
    expect(card.metrics.index_bytes).toBe(2)
    expect(card.metrics.digest_count).toBe(2)
    expect(card.metrics.digests_per_day).toBe(0.2)
  })

  it('metric orphan_loss: sessions of missing folders with no digest, by count and bytes', () => {
    const card = computeScorecard({
      ...base,
      memory: memory({ names: { root: [], sessions: ['2026-10-01-gone0001.md'] } }),
      sessions: [
        session('gone0001-x', { cwdExists: false, bytes: 300, operatorTurns: 0 }),
        session('gone0002-x', { cwdExists: false, bytes: 100 }),
        session('live0003-x')
      ]
    })
    expect(card.metrics.orphan_transcripts).toBe(2)
    expect(card.metrics.orphan_loss).toBe(0.5)
    expect(card.metrics.orphan_loss_bytes).toBe(0.25)
  })

  it('maps transcript paths and renders markdown for an empty folder', () => {
    const maps = parsePathMaps(['/fixture=/tmp/x'])
    expect(mapPath('/fixture/repo', maps)).toBe('/tmp/x/repo')
    expect(mapPath('/fixtures/repo', maps)).toBe('/fixtures/repo')
    const card = computeScorecard({ ...base, memory: null, sessions: [] })
    expect(card.metrics.capture_coverage).toBe(0)
    expect(card.metrics.memory_read_default_bytes).toBeGreaterThan(0)
    const md = renderMarkdown(card)
    expect(md).toContain('| `capture_coverage` | M1 | 0 |')
    expect(md).toContain('No counted sessions in the window.')
  })
})
