/**
 * T676 S-6 — the reporter and the acceptance rule: `report`, `compare` and `list` driven as the CLI
 * is, against a throwaway git repository holding a copy of the harness (so `.harnu/eval/` and the
 * corpus land in a sandbox) and the fake `claude`. No model is called and nothing reaches the network.
 *
 * Whole rounds run through the fake where the claim is about what a round leaves behind; the
 * arithmetic is proved on hand-written round files, whose numbers are known exactly.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assignLabels } from '../scripts/eval/bakeoff/anonymize.mjs'
import { contentHash } from '../scripts/eval/bakeoff/corpus.mjs'

const REAL_ROOT = resolve(__dirname, '..')
const REAL_HARNESS = join(REAL_ROOT, 'scripts/eval/bakeoff')
const DRY_RUN_PROBLEM = join(REAL_HARNESS, 'fixtures/dry-run/slugify-basic')
const FAKE = resolve(__dirname, 'fixtures/eval-bakeoff/fake-claude.mjs')
const SUPERPOWERS_PIN = 'bb92a77741419a4ab5f06e711a283343f1ada0c3'
const SLOW_TEST_MS = 300_000
const SETUP_MS = 300_000
const SEED = 's6-seed'
const SENTINEL = 'zq_holdout_sentinel_7f3a9c'
const SECRET_PROBLEM = 'secret-problem'
const FULL_IDS = [
  '--model',
  'fake-opus',
  '--operator-model',
  'fake-sonnet',
  '--judge-model',
  'fake-judge'
]
const ONE_RUN = ['--repeats', '1', '--judges', '1', '--jobs', '1', '--seed', SEED]
const CONTESTANTS = ['harnu-spec', 'superpowers']
const MEASURE_KEYS = [
  'assumptions',
  'builderGuesses',
  'contradictions',
  'coverage',
  'decisionsLeft',
  'executableShare',
  'hiddenPassRate',
  'operatorTurns',
  'specLines',
  'specWords',
  'subAgents',
  'tokensOutput',
  'tokensTotal',
  'wallMs'
]
const REPORT_KEYS = [
  'budget',
  'confounds',
  'details',
  'dryRun',
  'judges',
  'measures',
  'models',
  'pins',
  'repeats',
  'roundId',
  'runs',
  'split',
  'status'
]

/** Parsed JSON: the shapes under test are asserted field by field below. */
type Json = ReturnType<typeof JSON.parse>

interface Entry {
  reply?: string
  writes?: { path: string; content: string }[]
  noResult?: boolean
}
interface Cli {
  code: number | null
  output: string
}

let template: string
let tmp: string
let repo: string
let cache: string
let work: string
let holdout: string
let projects: string
let scenarioPath: string

const read = (path: string): string => readFileSync(path, 'utf8')
const readJson = (path: string): Json => JSON.parse(read(path))
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=s6',
      '-c',
      'user.email=s6@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args
    ],
    { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

/** A corpus problem: the dry-run fixture under another id and split. */
function addProblem(root: string, id: string, split: 'dev' | 'holdout'): void {
  const dir = join(root, id)
  mkdirSync(root, { recursive: true })
  cpSync(DRY_RUN_PROBLEM, dir, { recursive: true })
  const parsed = readJson(join(dir, 'problem.json'))
  writeJson(join(dir, 'problem.json'), {
    ...parsed,
    id,
    split,
    setup: [],
    provenance: { ...parsed.provenance, sandbox: true }
  })
}

/** A holdout problem whose every text carries the sentinel, test names included. */
function addSentinelProblem(root: string, id: string): void {
  addProblem(root, id, 'holdout')
  const dir = join(root, id)
  writeFileSync(join(dir, 'request.md'), `${read(join(dir, 'request.md'))}\n${SENTINEL}\n`)
  writeFileSync(
    join(dir, 'answer-sheet.md'),
    `${read(join(dir, 'answer-sheet.md'))}\n${SENTINEL}\n`
  )
  const atoms = join(dir, 'hidden/atoms.md')
  writeFileSync(atoms, read(atoms).replace('lowercases the text', `lowercases ${SENTINEL}`))
  const hidden = join(dir, 'hidden/slugify.hidden.test.js')
  writeFileSync(hidden, read(hidden).replaceAll("test('A-", `test('${SENTINEL} A-`))
}

function baseEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) {
    if (k.startsWith('HARNU_BAKEOFF_') || k.startsWith('GIT_') || k.startsWith('FAKE_CLAUDE_')) {
      delete env[k]
    }
  }
  return {
    ...env,
    HARNU_BAKEOFF_CACHE: join(root, 'cache'),
    HARNU_BAKEOFF_WORK: join(root, 'work'),
    HARNU_BAKEOFF_HOLDOUT: join(root, 'holdout'),
    HARNU_BAKEOFF_CLAUDE_BIN: FAKE,
    HARNU_BAKEOFF_CLAUDE_PROJECTS: join(root, 'projects'),
    FAKE_CLAUDE_SCENARIO: join(root, 'scenario.json')
  }
}

function spawnCli(root: string, checkout: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const entry = join(checkout, 'scripts/eval/bakeoff/run.mjs')
  // stdin closed: a round needs no human, and a command that read it would see end of file.
  return spawn(process.execPath, [entry, ...args], {
    cwd: root,
    env: { ...baseEnv(root), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function finished(child: ReturnType<typeof spawnCli>): Promise<Cli> {
  return new Promise((done) => {
    let output = ''
    child.stdout?.on('data', (d) => (output += d))
    child.stderr?.on('data', (d) => (output += d))
    child.on('close', (code) => done({ code, output }))
  })
}

const cli = (args: string[], env: NodeJS.ProcessEnv = {}, checkout = repo): Promise<Cli> =>
  finished(spawnCli(tmp, checkout, args, env))

beforeAll(async () => {
  template = realpathSync(mkdtempSync(join(tmpdir(), 'bakeoff-s6-template-')))
  const root = join(template, 'repo')
  const harness = join(root, 'scripts/eval/bakeoff')
  cpSync(REAL_HARNESS, harness, { recursive: true })
  rmSync(join(harness, 'corpus'), { recursive: true, force: true })
  mkdirSync(join(root, 'scripts/eval/mission-behavior'), { recursive: true })
  for (const name of ['harnu.mjs', 'procs.mjs']) {
    cpSync(
      join(REAL_ROOT, 'scripts/eval/mission-behavior', name),
      join(root, 'scripts/eval/mission-behavior', name)
    )
  }
  mkdirSync(join(root, 'resources/skills/skills/spec'), { recursive: true })
  writeFileSync(join(root, 'resources/skills/skills/spec/SKILL.md'), '# Spec skill\n')
  mkdirSync(join(root, 'docs/specs'), { recursive: true })
  writeFileSync(join(root, 'docs/specs/TEMPLATE.md'), '# Template\n')
  symlinkSync(join(REAL_ROOT, 'node_modules'), join(root, 'node_modules'))
  const corpus = join(harness, 'corpus/dev')
  addProblem(corpus, 'alpha', 'dev')
  addProblem(corpus, 'beta', 'dev')
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, '.git/info/exclude'), '/node_modules\n/.harnu\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'harness')

  addSentinelProblem(join(template, 'holdout'), SECRET_PROBLEM)
  const tool = join(template, 'cache/tools', `superpowers@${SUPERPOWERS_PIN}`)
  mkdirSync(join(tool, 'brainstorming'), { recursive: true })
  writeFileSync(join(tool, 'brainstorming/SKILL.md'), '# Tool\n')

  // Validation is S-4's and its result is cached by content, so every test starts from these keys.
  const dev = await finished(spawnCli(template, root, ['validate']))
  expect(dev.output).toContain('2 of 2 dev problems validated')
  const held = await finished(spawnCli(template, root, ['validate', '--split', 'holdout']))
  expect(held.output).toContain('1 of 1 holdout problems validated')
}, SETUP_MS)

afterAll(() => {
  rmSync(template, { recursive: true, force: true })
})

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bakeoff-s6-')))
  for (const name of ['repo', 'cache', 'work', 'holdout']) {
    cpSync(join(template, name), join(tmp, name), { recursive: true, verbatimSymlinks: true })
  }
  repo = join(tmp, 'repo')
  cache = join(tmp, 'cache')
  work = join(tmp, 'work')
  holdout = join(tmp, 'holdout')
  projects = join(tmp, 'projects')
  scenarioPath = join(tmp, 'scenario.json')
  writeJson(scenarioPath, [])
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const SPEC_FILE = { path: 'docs/spec.md', content: '# The spec\n' }
const IDENTITY = 'export function identity(x) {\n  return x\n}\n'
const FULL_SLUGIFY = `${IDENTITY}
export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
`
/** Two of the three hidden tests pass: nothing trims the hyphens. */
const NO_TRIM_SLUGIFY = `${IDENTITY}
export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}
`
const contestantDone: Entry = { reply: 'ARTIFACT DONE: docs/spec.md', writes: [SPEC_FILE] }

function builderEntry(source: string, prefix = ''): Entry {
  return {
    reply: `${prefix}Built.`,
    writes: [
      { path: 'index.js', content: source },
      { path: 'ASSUMPTIONS.md', content: '1. nothing\n' }
    ]
  }
}

function judgeEntry(label: string, notes = 'ok'): Entry {
  const body = {
    spec: label,
    atoms: { 'A-1': 'covered', 'A-2': 'partial', 'A-3': 'missing' },
    decisions_left: [],
    contradictions: [],
    acceptance_criteria: { total: 1, executable: 1 },
    builder_guesses: [],
    notes
  }
  return { reply: '```json\n' + JSON.stringify(body) + '\n```' }
}

function labelOf(problem: string, repeat: number, contestant: string): string {
  const labels = assignLabels(SEED, problem, repeat, CONTESTANTS)
  return Object.keys(labels).find((k) => labels[k] === contestant) as string
}

/** One entry per session, in the order `--jobs 1` runs them. */
function roundScenario(
  problems: string[],
  options: { source?: string; repeats?: number; judges?: number } = {}
): Entry[] {
  const { source = FULL_SLUGIFY, repeats = 1, judges = 1 } = options
  return problems.flatMap((problem) =>
    CONTESTANTS.flatMap((contestant) =>
      Array.from({ length: repeats }, (_, r) => [
        contestantDone,
        ...Array.from({ length: judges }, () => judgeEntry(labelOf(problem, r + 1, contestant))),
        builderEntry(source)
      ]).flat()
    )
  )
}

const setScenario = (entries: Entry[]): void => {
  writeJson(scenarioPath, entries)
  rmSync(join(projects, '.fake-claude-cursor'), { force: true })
}

const roundsDir = (): string => join(repo, '.harnu/eval/bakeoff')
const roundIds = (): string[] => (existsSync(roundsDir()) ? readdirSync(roundsDir()).sort() : [])
const roundDir = (id: string): string => join(roundsDir(), id)
const roundFile = (id: string): Json => readJson(join(roundDir(id), 'round.json'))
const reportJson = (id: string): Json => readJson(join(roundDir(id), 'report.json'))
const reportMd = (id: string): string => read(join(roundDir(id), 'report.md'))
const devUnits = (id: string): string => join(cache, 'rounds', id, 'units')
const holdoutUnits = (id: string): string => join(work, 'rounds', id, 'units')
const privateDir = (id: string): string => join(holdout, '.rounds', id)
const usageFile = (): string => join(holdout, '.rounds/usage.json')

/** Runs a round and returns its id, the one directory this call added. */
async function runRound(args: string[], checkout = repo): Promise<{ id: string; result: Cli }> {
  const before = roundIds()
  const result = await cli(['run', ...args], {}, checkout)
  const added = roundIds().filter((id) => !before.includes(id))
  expect(added, result.output).toHaveLength(1)
  return { id: added[0], result }
}

function acceptDevRound(id: string): void {
  writeJson(join(roundDir(id), 'compare.json'), {
    split: 'dev',
    verdict: 'accepted',
    baseline: 'baseline-round',
    candidate: id,
    baselineSkillSha: '0'.repeat(40),
    candidateSkillSha: git(repo, 'rev-parse', 'HEAD')
  })
}

/** Every file under `dir` holding `needle`: symlinks are not followed. */
function filesContaining(dir: string, needle: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) return []
    if (stat.isDirectory()) return filesContaining(full, needle)
    return readFileSync(full).includes(needle) ? [full] : []
  })
}

/* ---- hand-written round files: compare's inputs, with exact numbers ---- */

const MODELS = { contestant: 'fake-opus', operator: 'fake-sonnet', judge: 'fake-judge' }
const PINS = { 'harnu-spec': 'a'.repeat(40), superpowers: 'b'.repeat(40) }
/** The control contestant swings wildly, so a verdict that read its scores would flip. */
const CONTROL: [number, number] = [11, 77]

interface RoundFixture {
  split?: 'dev' | 'holdout'
  /** problem id -> [mean, spread] of harnu-spec's hidden pass rate */
  scores: Record<string, [number, number]>
  status?: string
  dryRun?: boolean
  models?: Record<string, string>
  pins?: Record<string, string>
  repeats?: number
  judges?: number
  seed?: string
  hashes?: Record<string, string>
}

function fixtureRound(id: string, f: RoundFixture): void {
  const split = f.split ?? 'dev'
  const status = f.status ?? 'done'
  const problemIds = Object.keys(f.scores)
  const hashOf = (problem: string): string => f.hashes?.[problem] ?? `hash-of-${problem}`
  const rows = problemIds.flatMap((problem) => [
    {
      problem,
      contestant: 'harnu-spec',
      values: [],
      mean: f.scores[problem][0],
      spread: f.scores[problem][1]
    },
    { problem, contestant: 'superpowers', values: [], mean: CONTROL[0], spread: CONTROL[1] }
  ])
  const isHoldout = split === 'holdout'
  const shared = {
    roundId: id,
    split,
    status,
    dryRun: f.dryRun ?? false,
    models: f.models ?? MODELS,
    pins: f.pins ?? PINS,
    repeats: f.repeats ?? 2,
    judges: f.judges ?? 3
  }
  writeJson(join(roundDir(id), 'round.json'), {
    ...shared,
    args: isHoldout ? 'redacted' : { seed: f.seed ?? null },
    seed: f.seed ?? 'a-seed',
    budget: { cap: 1000, spent: 10 },
    problems: isHoldout ? [] : problemIds.map((p) => ({ id: p, contentHash: hashOf(p) })),
    units: [],
    startedAt: '2026-11-09T00:00:00.000Z',
    finishedAt: '2026-11-09T00:10:00.000Z'
  })
  writeJson(join(roundDir(id), 'report.json'), {
    ...shared,
    measures: { hiddenPassRate: { ...(isHoldout ? {} : { rows }), summary: [] } },
    runs: [],
    budget: {},
    confounds: []
  })
  if (isHoldout) {
    writeJson(join(privateDir(id), 'problems.json'), {
      roundId: id,
      args: {},
      problems: problemIds.map((p, i) => {
        const hiddenPassRate = { values: [], mean: f.scores[p][0], spread: f.scores[p][1] }
        const control = { values: [], mean: CONTROL[0], spread: CONTROL[1] }
        return {
          id: p,
          label: `H-${i + 1}`,
          contentHash: hashOf(p),
          contestants: {
            'harnu-spec': { measures: { hiddenPassRate } },
            superpowers: { measures: { hiddenPassRate: control } }
          }
        }
      }),
      units: []
    })
  }
}

const compare = (baseline: string, candidate: string, env: NodeJS.ProcessEnv = {}): Promise<Cli> =>
  cli(['compare', baseline, candidate], env)

async function verdictOf(base: RoundFixture, candidate: RoundFixture): Promise<Cli> {
  const stamp = `${roundIds().length + 1}`
  fixtureRound(`base-${stamp}`, base)
  fixtureRound(`cand-${stamp}`, candidate)
  return compare(`base-${stamp}`, `cand-${stamp}`)
}

/* ---- hand-written unit files: the reporter's inputs, with exact numbers ---- */

const usage = (input: number, output: number): Json => ({
  input,
  cacheWrite: 0,
  cacheRead: 0,
  output,
  total: input + output
})

interface JudgeFixture {
  status?: string
  reason?: string | null
  scores?: Json
  notes?: string
}

interface RunFixture {
  passed: number
  total?: number
  judges: JudgeFixture[]
  failed?: string[]
  flaky?: string[]
  status?: string
}

const scores = (coverage: number, acTotal: number, acExecutable: number): Json => ({
  coverage,
  coverageMax: 4,
  decisionsLeft: 1,
  contradictions: 2,
  acTotal,
  acExecutable,
  builderGuesses: 3
})

function writeRunFiles(unitDir: string, run: RunFixture): void {
  writeJson(join(unitDir, 'contestant.json'), {
    status: run.status ?? 'done',
    sessionId: 's',
    operatorSessionId: 'o',
    contestantTurns: 1,
    operatorTurns: 2,
    strayReplies: 0,
    subAgents: 1,
    wallMs: 1000,
    usage: { contestant: usage(100, 10), operator: usage(50, 5) },
    artifact: ['docs/spec.md'],
    specLines: 10,
    specWords: 50
  })
  run.judges.forEach((judge, i) => {
    writeJson(join(unitDir, `judge-${i + 1}.json`), {
      status: judge.status ?? 'done',
      reason: judge.reason ?? null,
      label: 'P',
      raw: '',
      parsed: judge.status === 'not-run' ? null : { notes: judge.notes ?? `note ${i + 1}` },
      scores: judge.scores ?? null,
      usage: usage(20, 2)
    })
  })
  writeJson(join(unitDir, 'build.json'), {
    status: 'done',
    reason: null,
    hidden: {
      passed: run.passed,
      total: run.total ?? 100,
      flaky: run.flaky ?? [],
      failed: run.failed ?? []
    },
    existing: { exitCode: 0 },
    assumptions: 4,
    diffstat: '',
    usage: usage(30, 3),
    wallMs: 1
  })
}

type RunsFixture = Record<string, Record<string, RunFixture[]>>

const plainRun = (passed: number): RunFixture => ({
  passed,
  judges: [{ scores: scores(4, 2, 1) }]
})

/** Round files plus unit files for `report`; `runs` is problem -> contestant -> one run per repeat. */
function fixtureUnits(id: string, split: 'dev' | 'holdout', runs: RunsFixture): void {
  const isHoldout = split === 'holdout'
  const root = isHoldout ? holdoutUnits(id) : devUnits(id)
  const problems = Object.keys(runs).sort()
  for (const problem of problems) {
    for (const contestant of Object.keys(runs[problem])) {
      runs[problem][contestant].forEach((run, r) => {
        writeRunFiles(join(root, problem, contestant, `r${r + 1}`), run)
      })
    }
  }
  writeJson(join(roundDir(id), 'round.json'), {
    roundId: id,
    split,
    status: 'done',
    dryRun: false,
    args: isHoldout ? 'redacted' : { seed: null },
    seed: 'a-seed',
    repeats: 2,
    judges: 2,
    models: MODELS,
    pins: PINS,
    budget: { cap: 100000, spent: 1234 },
    problems: isHoldout ? [] : problems.map((p) => ({ id: p, contentHash: `hash-${p}` })),
    units: [],
    startedAt: '2026-11-09T00:00:00.000Z',
    finishedAt: '2026-11-09T00:10:00.000Z'
  })
  if (isHoldout) {
    writeJson(join(privateDir(id), 'problems.json'), {
      roundId: id,
      args: {},
      problems: problems.map((p, i) => ({
        id: p,
        label: `H-${i + 1}`,
        contentHash: `hash-${p}`,
        contestants: { 'harnu-spec': {}, superpowers: {} }
      })),
      units: []
    })
  }
}

const ROW = (json: Json, measure: string, problem: string, contestant: string): Json =>
  json.measures[measure].rows.find(
    (r: Json) => r.problem === problem && r.contestant === contestant
  )
const SUMMARY = (json: Json, measure: string, contestant: string): Json =>
  json.measures[measure].summary.find((r: Json) => r.contestant === contestant)

it(
  'one command runs a corpus end to end with no human input',
  async () => {
    setScenario(roundScenario(['alpha', 'beta']))
    const { id, result } = await runRound([...ONE_RUN, ...FULL_IDS])
    expect(result.code, result.output).toBe(0)

    expect(existsSync(join(roundDir(id), 'report.md'))).toBe(true)
    const report = reportJson(id)
    expect(Object.keys(report).sort()).toEqual(REPORT_KEYS)
    expect(report.status).toBe('done')
    expect(report.split).toBe('dev')
    expect(report.runs).toEqual(
      CONTESTANTS.map((contestant) => ({
        contestant,
        done: 2,
        incomplete: 0,
        failed: 0,
        judgesInvalidReply: 0,
        flakyHiddenTests: 0
      }))
    )
    // Every run, judgment and build of the round: 2 problems x 2 contestants, one of each.
    expect(report.details).toHaveLength(4)
    for (const detail of report.details) {
      expect(detail.judgeNotes).toEqual(['ok'])
      expect(detail.failedHiddenTests).toEqual([])
    }
    const pass = report.measures.hiddenPassRate.rows
    expect(pass).toHaveLength(4)
    for (const row of pass) expect(row.values).toEqual([100])
    for (const problem of ['alpha', 'beta']) {
      for (const contestant of CONTESTANTS) {
        expect(ROW(report, 'coverage', problem, contestant).values).toEqual([50])
        expect(ROW(report, 'assumptions', problem, contestant).values).toEqual([1])
      }
    }
    expect(Object.keys(report.measures).sort()).toEqual(MEASURE_KEYS)
  },
  SLOW_TEST_MS
)

it(
  'dev and holdout are reported apart with spread per measure',
  async () => {
    const runs: RunsFixture = {
      'prob-a': {
        'harnu-spec': [
          { passed: 90, judges: [{ scores: scores(2, 4, 2) }, { scores: scores(4, 2, 2) }] },
          { passed: 100, judges: [{ scores: scores(3, 4, 4) }, { scores: scores(3, 4, 4) }] }
        ],
        superpowers: [
          // One judge counted no acceptance criterion: left out of the share's mean.
          { passed: 80, judges: [{ scores: scores(4, 0, 0) }, { scores: scores(4, 4, 1) }] },
          // No judge counted one: the run has no share at all.
          { passed: 70, judges: [{ scores: scores(4, 0, 0) }, { scores: scores(4, 0, 0) }] }
        ]
      },
      'prob-b': {
        'harnu-spec': [plainRun(60), plainRun(64)],
        superpowers: [
          {
            passed: 50,
            // An invalid reply has no scores, so it is counted in runs and in no mean.
            judges: [{ scores: scores(2, 2, 2) }, { status: 'not-run', reason: 'invalid-reply' }],
            flaky: ['flaky::one'],
            failed: ['pkg::failing-test', 'flaky::one']
          },
          plainRun(50)
        ]
      }
    }

    fixtureUnits('dev-round', 'dev', runs)
    const dev = await cli(['report', 'dev-round'])
    expect(dev.code, dev.output).toBe(0)
    const devReport = reportJson('dev-round')
    expect(devReport.split).toBe('dev')

    // Per run, the mean and the spread (max - min across repeats) of one problem and contestant.
    expect(ROW(devReport, 'hiddenPassRate', 'prob-a', 'harnu-spec')).toEqual({
      problem: 'prob-a',
      contestant: 'harnu-spec',
      values: [90, 100],
      mean: 95,
      spread: 10
    })
    // The judge mean per run: coverage is a percentage of the atoms.
    expect(ROW(devReport, 'coverage', 'prob-a', 'harnu-spec').values).toEqual([75, 75])
    expect(ROW(devReport, 'executableShare', 'prob-a', 'harnu-spec').values).toEqual([0.75, 1])
    expect(ROW(devReport, 'executableShare', 'prob-a', 'superpowers')).toEqual({
      problem: 'prob-a',
      contestant: 'superpowers',
      values: [0.25, null],
      mean: 0.25,
      spread: 0
    })
    // Mean of the problem means, mean of the problem spreads.
    expect(SUMMARY(devReport, 'hiddenPassRate', 'harnu-spec')).toEqual({
      contestant: 'harnu-spec',
      mean: (95 + 62) / 2,
      spread: (10 + 4) / 2,
      n: 2
    })
    expect(devReport.runs.find((r: Json) => r.contestant === 'superpowers')).toEqual({
      contestant: 'superpowers',
      done: 4,
      incomplete: 0,
      failed: 0,
      judgesInvalidReply: 1,
      flakyHiddenTests: 1
    })
    const detail = devReport.details.find(
      (d: Json) => d.problem === 'prob-b' && d.contestant === 'superpowers' && d.repeat === 1
    )
    expect(detail.failedHiddenTests).toEqual(['pkg::failing-test', 'flaky::one'])
    expect(detail.judgeNotes).toEqual(['note 1'])

    const devMd = reportMd('dev-round')
    expect(devMd).toContain('| prob-a | harnu-spec | 90.00 | 100.00 | 95.00 | 10.00 |')
    expect(devMd).toContain('| (summary) | harnu-spec |  |  | 78.50 | 7.00 |')
    expect(devMd).toContain('| prob-a | superpowers | 0.25 | n/a | 0.25 | 0.00 |')
    expect(devMd).toContain('pkg::failing-test')
    expect(devMd).toContain('note 1')
    expect(devMd).toContain('## Budget')
    expect(devMd).toContain('## Confounds')
    expect(devMd).toMatch(/structur/i)

    fixtureUnits('held-round', 'holdout', runs)
    const held = await cli(['report', 'held-round'])
    expect(held.code, held.output).toBe(0)
    const heldReport = reportJson('held-round')
    expect(heldReport.split).toBe('holdout')
    expect(heldReport.details).toBeUndefined()
    for (const measure of Object.keys(heldReport.measures)) {
      expect(heldReport.measures[measure].rows).toBeUndefined()
    }
    expect(SUMMARY(heldReport, 'hiddenPassRate', 'harnu-spec')).toEqual({
      contestant: 'harnu-spec',
      mean: (95 + 62) / 2,
      spread: (10 + 4) / 2,
      n: 2
    })
    expect(heldReport.confounds.join(' ')).toMatch(/structur/i)

    const heldMd = reportMd('held-round')
    expect(heldMd).toContain('| harnu-spec | 78.50 | 7.00 | 2.00 |')
    expect(heldMd).toContain('## Budget')
    expect(heldMd).toContain('## Confounds')
    expect(heldMd).toMatch(/structur/i)
    for (const secret of ['prob-a', 'prob-b', 'pkg::failing-test', 'note 1', 'H-1', 'H-2']) {
      expect(heldMd).not.toContain(secret)
      expect(JSON.stringify(heldReport)).not.toContain(secret)
    }
  },
  SLOW_TEST_MS
)

it(
  'no holdout text reaches the repo or the report',
  async () => {
    // The harness runs from a linked worktree, so both repo roots of the containment rule exist.
    const worktree = join(tmp, 'linked-worktree')
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'linked')
    symlinkSync(join(REAL_ROOT, 'node_modules'), join(worktree, 'node_modules'))

    setScenario(roundScenario(['alpha']))
    const dev = await runRound(['--problems', 'alpha', ...ONE_RUN, ...FULL_IDS], worktree)
    expect(dev.result.code, dev.result.output).toBe(0)
    acceptDevRound(dev.id)

    const script: Entry[] = CONTESTANTS.flatMap((contestant) => [
      {
        reply: `${SENTINEL}\nARTIFACT DONE: docs/spec.md`,
        writes: [{ path: 'docs/spec.md', content: `# ${SENTINEL}\n` }]
      },
      judgeEntry(labelOf(SECRET_PROBLEM, 1, contestant), `${SENTINEL} judge note`),
      builderEntry(NO_TRIM_SLUGIFY, `${SENTINEL} `)
    ])
    const holdoutFlags = ['--split', 'holdout', '--after', dev.id, ...ONE_RUN, ...FULL_IDS]

    setScenario(script)
    const baseline = await runRound(holdoutFlags, worktree)
    expect(baseline.result.code, baseline.result.output).toBe(0)
    setScenario(script)
    const candidate = await runRound(holdoutFlags, worktree)
    expect(candidate.result.code, candidate.result.output).toBe(0)

    const compared = await cli(['compare', baseline.id, candidate.id], {}, worktree)
    expect(compared.code, compared.output).toBe(0)

    for (const root of [repo, worktree]) expect(filesContaining(root, SENTINEL)).toEqual([])

    const texts = [
      compared.output,
      baseline.result.output,
      candidate.result.output,
      reportMd(baseline.id),
      read(join(roundDir(baseline.id), 'report.json'))
    ]
    for (const text of texts) {
      expect(text).not.toContain(SENTINEL)
      expect(text).not.toContain(SECRET_PROBLEM)
      expect(text).not.toMatch(/\bH-\d+\b/)
      expect(text).not.toContain('trims hyphens')
      expect(text).not.toContain('judge note')
    }

    // The round's terminal output is counters and nothing else.
    for (const line of baseline.result.output.split('\n').filter(Boolean)) {
      expect(line).toMatch(/^unit \d+\/\d+ done$/)
    }
    expect(compared.output).toMatch(/mean \d+\.\d\d spread \d+\.\d\d n 1\b/)

    const repoRound = roundFile(baseline.id)
    expect(repoRound.args).toBe('redacted')
    expect(repoRound.problems).toEqual([])
    expect(repoRound.units).toEqual([])

    const refused = await cli(
      ['run', '--split', 'holdout', '--after', dev.id, '--problems', SECRET_PROBLEM, ...FULL_IDS],
      {},
      worktree
    )
    expect(refused.code).toBe(2)
    expect(refused.output).toContain('PROBLEMS_ON_HOLDOUT')
  },
  SLOW_TEST_MS
)

it(
  'compare accepts only a dev gain above noise without a holdout regression',
  async () => {
    const dev = (scores_: Record<string, [number, number]>): RoundFixture => ({ scores: scores_ })
    const held = (scores_: Record<string, [number, number]>): RoundFixture => ({
      split: 'holdout',
      scores: scores_
    })
    const expectVerdict = (result: Cli, code: number, verdict: string): void => {
      expect(result.code, result.output).toBe(code)
      expect(result.output).toContain(verdict)
    }

    // Dev: a gain above the larger spread, then one equal to it.
    expectVerdict(await verdictOf(dev({ p: [90, 4] }), dev({ p: [95, 3] })), 0, 'accepted')
    expectVerdict(await verdictOf(dev({ p: [90, 4] }), dev({ p: [94, 3] })), 1, 'rejected')
    // Holdout: a drop within its spread, then a larger one.
    expectVerdict(await verdictOf(held({ p: [95, 5] }), held({ p: [91, 4] })), 0, 'accepted')
    expectVerdict(await verdictOf(held({ p: [95, 5] }), held({ p: [89, 4] })), 1, 'rejected')
    // The dev gain is a mean over the shared problems, and the spread the larger round's mean.
    expectVerdict(
      await verdictOf(dev({ p: [90, 6], q: [80, 2] }), dev({ p: [100, 1], q: [80, 1] })),
      0,
      'accepted'
    )

    // Incomplete, before any other verdict.
    expectVerdict(
      await verdictOf(dev({ p: [90, 0] }), { ...dev({ p: [99, 0] }), dryRun: true }),
      1,
      'incomplete'
    )
    expectVerdict(
      await verdictOf(dev({ p: [90, 0] }), { ...dev({ p: [99, 0] }), status: 'aborted-budget' }),
      1,
      'incomplete'
    )

    // The floors of D-13, every spread 0.
    expectVerdict(await verdictOf(dev({ p: [90, 0] }), dev({ p: [91, 0] })), 1, 'rejected')
    expectVerdict(await verdictOf(dev({ p: [90, 0] }), dev({ p: [92, 0] })), 1, 'rejected')
    expectVerdict(await verdictOf(dev({ p: [90, 0] }), dev({ p: [92.5, 0] })), 0, 'accepted')
    expectVerdict(await verdictOf(held({ p: [90, 0] }), held({ p: [88, 0] })), 0, 'accepted')
    expectVerdict(await verdictOf(held({ p: [90, 0] }), held({ p: [87.5, 0] })), 1, 'rejected')

    // Unrounded values: the reporter shows the candidate's 92.004 as 92.00, the verdict sees 2.004.
    const exact = (passed: number): RunFixture => ({
      passed,
      total: 1_000_000,
      judges: [{ scores: scores(4, 2, 1) }]
    })
    fixtureUnits('exact-base', 'dev', { p: { 'harnu-spec': [exact(900_000), exact(900_000)] } })
    fixtureUnits('exact-cand', 'dev', { p: { 'harnu-spec': [exact(920_040), exact(920_040)] } })
    for (const id of ['exact-base', 'exact-cand']) {
      const result = await cli(['report', id])
      expect(result.code, result.output).toBe(0)
    }
    expect(reportMd('exact-cand')).toContain('| p | harnu-spec | 92.00 | 92.00 | 92.00 | 0.00 |')
    expect(ROW(reportJson('exact-cand'), 'hiddenPassRate', 'p', 'harnu-spec').mean).toBeCloseTo(
      92.004,
      10
    )
    expectVerdict(await compare('exact-base', 'exact-cand'), 0, 'accepted')

    // An accepted dev compare authorizes the holdout round through its compare.json.
    const head = git(repo, 'rev-parse', 'HEAD')
    fixtureRound('gate-base', {
      scores: { p: [90, 0] },
      pins: { ...PINS, 'harnu-spec': 'c'.repeat(40) }
    })
    fixtureRound('gate-cand', { scores: { p: [99, 0] }, pins: { ...PINS, 'harnu-spec': head } })
    expectVerdict(await compare('gate-base', 'gate-cand'), 0, 'accepted')
    expect(readJson(join(roundDir('gate-cand'), 'compare.json'))).toEqual({
      split: 'dev',
      verdict: 'accepted',
      baseline: 'gate-base',
      candidate: 'gate-cand',
      baselineSkillSha: 'c'.repeat(40),
      candidateSkillSha: head
    })
    setScenario(roundScenario([SECRET_PROBLEM]))
    const authorized = await runRound([
      '--split',
      'holdout',
      '--after',
      'gate-cand',
      ...ONE_RUN,
      ...FULL_IDS
    ])
    expect(authorized.result.output).not.toContain('DEV_NOT_ACCEPTED')
    expect(authorized.result.code, authorized.result.output).toBe(0)
  },
  SLOW_TEST_MS
)

it(
  'a holdout problem used in more than 3 accepted comparisons warns',
  async () => {
    const held = (mean: number, hash = 'shared-hash'): RoundFixture => ({
      split: 'holdout',
      scores: { 'used-problem': [mean, 0] },
      hashes: { 'used-problem': hash }
    })
    const WARNING = /warning: 1 holdout problem/

    fixtureRound('h-0', held(90))
    for (const [i, id] of ['h-1', 'h-2', 'h-3', 'h-4'].entries()) fixtureRound(id, held(90 + i))
    fixtureRound('h-rejected', held(10))

    for (const [i, candidate] of ['h-1', 'h-2', 'h-3'].entries()) {
      const result = await compare('h-0', candidate)
      expect(result.code, result.output).toBe(0)
      expect(result.output).not.toMatch(WARNING)
      expect(readJson(usageFile()).counts).toEqual({ 'shared-hash': i + 1 })
    }

    // The same pair twice is counted once, and a rejected comparison not at all.
    await compare('h-0', 'h-3')
    const rejected = await compare('h-0', 'h-rejected')
    expect(rejected.code).toBe(1)
    expect(readJson(usageFile())).toEqual({
      counts: { 'shared-hash': 3 },
      pairs: ['h-0:h-1', 'h-0:h-2', 'h-0:h-3']
    })

    const fourth = await compare('h-0', 'h-4')
    expect(fourth.code, fourth.output).toBe(0)
    expect(fourth.output).toMatch(WARNING)
    expect(fourth.output).not.toContain('used-problem')
    expect(fourth.output).not.toContain('shared-hash')
    expect(Object.keys(readJson(usageFile())).sort()).toEqual(['counts', 'pairs'])
    expect(readJson(usageFile()).counts).toEqual({ 'shared-hash': 4 })

    // Past 3, the same pair still warns and still counts nothing.
    const again = await compare('h-0', 'h-4')
    expect(again.output).toMatch(WARNING)
    expect(readJson(usageFile()).counts).toEqual({ 'shared-hash': 4 })

    // Dev keeps no such count and never warns.
    rmSync(usageFile())
    fixtureRound('d-0', { scores: { p: [80, 0] } })
    for (const n of [1, 2, 3, 4, 5]) {
      fixtureRound(`d-${n}`, { scores: { p: [90, 0] } })
      const result = await compare('d-0', `d-${n}`)
      expect(result.code, result.output).toBe(0)
      expect(result.output).not.toMatch(/warning/)
    }
    expect(existsSync(usageFile())).toBe(false)
  },
  SLOW_TEST_MS
)

it(
  'budget accounting adds up by phase and contestant',
  async () => {
    // Two alias probes, then a turn with no result event, so the first attempt is discarded.
    const probe: Entry = { reply: 'ok' }
    setScenario([
      probe,
      probe,
      { noResult: true, writes: [SPEC_FILE] },
      ...roundScenario(['alpha'])
    ])
    const { id, result } = await runRound([
      '--problems',
      'alpha',
      ...ONE_RUN,
      '--model',
      'opus',
      '--operator-model',
      'sonnet',
      '--judge-model',
      'sonnet'
    ])
    expect(result.code, result.output).toBe(0)

    const per = 110
    const round = roundFile(id)
    const { budget } = reportJson(id)
    expect(budget).toEqual({
      cap: round.budget.cap,
      spent: round.budget.spent,
      remaining: round.budget.cap - round.budget.spent,
      status: 'done',
      byPhase: {
        contestant: 2 * per,
        operator: 0,
        judge: 2 * per,
        build: 2 * per,
        discarded: 3 * per
      },
      byContestant: {
        'harnu-spec': 4 * per,
        superpowers: 3 * per,
        unattributed: 2 * per
      }
    })
    const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0)
    expect(sum(budget.byPhase)).toBe(round.budget.spent)
    expect(sum(budget.byContestant)).toBe(round.budget.spent)
    const { rollup } = await import('../scripts/eval/bakeoff/usage-rollup.mjs')
    expect(rollup(devUnits(id))).toEqual({
      byPhase: budget.byPhase,
      byContestant: budget.byContestant
    })

    const md = reportMd(id)
    expect(md).toContain('## Budget')
    expect(md).toContain(`${(9 * per).toFixed(2)}`)

    // A session can write a `discarded.json` in its clone; it never counts.
    writeJson(join(devUnits(id), 'alpha/harnu-spec/r1/clone/discarded.json'), [
      { unit: null, phase: 'x', contestant: 'harnu-spec', usage: usage(999, 999) }
    ])
    const rerun = await cli(['report', id])
    expect(rerun.code, rerun.output).toBe(0)
    expect(reportJson(id).budget).toEqual(budget)
  },
  SLOW_TEST_MS
)

it(
  'compare refuses rounds that differ in what it compares',
  async () => {
    const dev = (over: Partial<RoundFixture> = {}): RoundFixture => ({
      scores: { p: [90, 0] },
      ...over
    })
    const better = (over: Partial<RoundFixture> = {}): RoundFixture => ({
      scores: { p: [99, 0] },
      ...over
    })
    const expectRefused = (result: Cli, needle: string): void => {
      expect(result.code, result.output).toBe(2)
      expect(result.output).toContain(needle)
    }

    expectRefused(await verdictOf(dev(), { split: 'holdout', scores: { p: [99, 0] } }), 'split')
    expectRefused(
      await verdictOf(dev(), better({ models: { ...MODELS, contestant: 'other' } })),
      'models.contestant'
    )
    expectRefused(
      await verdictOf(dev(), better({ models: { ...MODELS, operator: 'other' } })),
      'models.operator'
    )
    expectRefused(
      await verdictOf(dev(), better({ models: { ...MODELS, judge: 'other' } })),
      'models.judge'
    )
    expectRefused(await verdictOf(dev(), better({ judges: 1 })), 'judges')
    expectRefused(await verdictOf(dev(), better({ repeats: 3 })), 'repeats')
    expectRefused(
      await verdictOf(dev(), better({ pins: { ...PINS, superpowers: 'd'.repeat(40) } })),
      'pins.superpowers'
    )

    // Different seeds and a different skill pin are what a comparison is for.
    const seeds = await verdictOf(
      dev({ seed: 'one' }),
      better({ seed: 'two', pins: { ...PINS, 'harnu-spec': 'e'.repeat(40) } })
    )
    expect(seeds.code, seeds.output).toBe(0)

    // Shared means the same real id and the same content hash: only `p` is scored here.
    const partly = await verdictOf(
      {
        scores: { p: [90, 0], gone: [0, 0], changed: [0, 0] },
        hashes: { changed: 'old' }
      },
      {
        scores: { p: [93, 0], added: [100, 0], changed: [100, 0] },
        hashes: { changed: 'new' }
      }
    )
    expect(partly.code, partly.output).toBe(0)
    expect(partly.output).toMatch(/gain 3\.00/)

    // A problem whose only change is its provenance keeps its hash, so it stays shared.
    const dir = join(tmp, 'corpus-copy/p')
    addProblem(join(tmp, 'corpus-copy'), 'p', 'dev')
    const before = contentHash(dir)
    const parsed = readJson(join(dir, 'problem.json'))
    writeJson(join(dir, 'problem.json'), {
      ...parsed,
      provenance: { ...parsed.provenance, reviewedBy: 'someone else' }
    })
    const after = contentHash(dir)
    const reviewed = await verdictOf(
      { scores: { p: [90, 0] }, hashes: { p: before } },
      { scores: { p: [93, 0] }, hashes: { p: after } }
    )
    expect(reviewed.code, reviewed.output).toBe(0)

    expectRefused(
      await verdictOf(
        { scores: { p: [90, 0] }, hashes: { p: 'one' } },
        { scores: { p: [93, 0] }, hashes: { p: 'two' } }
      ),
      'NO_SHARED_PROBLEMS'
    )
    expectRefused(
      await verdictOf({ scores: { p: [90, 0] } }, { scores: { q: [93, 0] } }),
      'NO_SHARED_PROBLEMS'
    )

    fixtureRound('held-a', { split: 'holdout', scores: { p: [90, 0] } })
    fixtureRound('held-b', { split: 'holdout', scores: { p: [93, 0] } })
    expectRefused(await compare('held-a', 'held-b', { HARNU_BAKEOFF_HOLDOUT: '' }), 'HOLDOUT_UNSET')

    expectRefused(await compare('held-a', 'no-such-round'), 'ROUND_NOT_FOUND')
    expectRefused(await cli(['compare', 'held-a']), 'USAGE')
    // A refusal leaves no verdict behind.
    expect(existsSync(join(roundDir('held-b'), 'compare.json'))).toBe(false)
  },
  SLOW_TEST_MS
)

it('list prints a count for the holdout', async () => {
  const dev = await cli(['list'])
  expect(dev.code, dev.output).toBe(0)
  expect(dev.output).toMatch(/alpha\s+feature\s+javascript/)
  expect(dev.output).toMatch(/beta\s+feature\s+javascript/)

  addProblem(holdout, 'other-secret', 'holdout')
  const held = await cli(['list', '--split', 'holdout'])
  expect(held.code, held.output).toBe(0)
  expect(held.output.trim()).toBe('2 holdout problems')
  expect(held.output).not.toContain(SECRET_PROBLEM)
  expect(held.output).not.toContain('feature')
  expect(held.output).not.toContain('javascript')

  const refused = await cli(['list', '--split', 'nope'])
  expect(refused.code).toBe(2)
  expect(refused.output).toContain('SPLIT_REQUIRED')
})

it(
  'report rewrites from the unit files',
  async () => {
    const rewrites = async (id: string): Promise<void> => {
      const paths = ['report.md', 'report.json'].map((name) => join(roundDir(id), name))
      const written = paths.map(read)
      for (const text of written) expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/)
      for (const path of paths) rmSync(path)
      const result = await cli(['report', id])
      expect(result.code, result.output).toBe(0)
      expect(paths.map(read)).toEqual(written)
    }

    setScenario(roundScenario(['alpha'], { source: NO_TRIM_SLUGIFY }))
    const dev = await runRound(['--problems', 'alpha', ...ONE_RUN, ...FULL_IDS])
    expect(dev.result.code, dev.result.output).toBe(0)
    await rewrites(dev.id)

    // Two of three hidden tests: the JSON keeps the fraction, the Markdown two decimals.
    const rate = (2 / 3) * 100
    const row = ROW(reportJson(dev.id), 'hiddenPassRate', 'alpha', 'harnu-spec')
    expect(row.values).toEqual([rate])
    expect(reportMd(dev.id)).toContain('| alpha | harnu-spec | 66.67 | 66.67 | 0.00 |')

    acceptDevRound(dev.id)
    setScenario(roundScenario([SECRET_PROBLEM], { source: NO_TRIM_SLUGIFY }))
    const held = await runRound(['--split', 'holdout', '--after', dev.id, ...ONE_RUN, ...FULL_IDS])
    expect(held.result.code, held.result.output).toBe(0)
    await rewrites(held.id)

    // writeReport owns only each contestant's `measures`: every other key survives it untouched.
    const file = join(privateDir(held.id), 'problems.json')
    const before = readJson(file)
    for (const problem of before.problems) {
      for (const contestant of Object.keys(problem.contestants)) {
        problem.contestants[contestant] = {}
      }
    }
    writeJson(file, before)
    const again = await cli(['report', held.id])
    expect(again.code, again.output).toBe(0)
    const after = readJson(file)
    const measures = after.problems[0].contestants['harnu-spec'].measures
    expect(Object.keys(measures).sort()).toEqual(MEASURE_KEYS)
    expect(measures.hiddenPassRate).toEqual({ values: [rate], mean: rate, spread: 0 })
    for (const problem of after.problems) {
      for (const contestant of Object.keys(problem.contestants)) {
        delete problem.contestants[contestant].measures
      }
    }
    expect(after).toEqual(before)
  },
  SLOW_TEST_MS
)
