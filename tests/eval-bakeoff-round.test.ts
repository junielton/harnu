/**
 * T676 S-5 — the bake-off round: `scripts/eval/bakeoff/{run,round,budget}.mjs` driven as the CLI
 * is, against a throwaway git repository holding a copy of the harness (so `.harnu/eval/` and the
 * corpus land in a sandbox) and the fake `claude`. No model is called and nothing reaches the network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { assignLabels } from '../scripts/eval/bakeoff/anonymize.mjs'
import { loadCorpus } from '../scripts/eval/bakeoff/corpus.mjs'

const REAL_ROOT = resolve(__dirname, '..')
const REAL_HARNESS = join(REAL_ROOT, 'scripts/eval/bakeoff')
const DRY_RUN_PROBLEM = join(REAL_HARNESS, 'fixtures/dry-run/slugify-basic')
const FAKE = resolve(__dirname, 'fixtures/eval-bakeoff/fake-claude.mjs')
const OBSERVE = resolve(__dirname, 'fixtures/eval-bakeoff/s5/observe-claude.mjs')
const SUPERPOWERS_PIN = 'bb92a77741419a4ab5f06e711a283343f1ada0c3'
const SLOW_TEST_MS = 240_000
const SETUP_MS = 300_000
const SEED = 's5-seed'
/** Full ids skip the alias probes, so a scenario's first entry is the first unit's. */
const FULL_IDS = [
  '--model',
  'fake-opus',
  '--operator-model',
  'fake-sonnet',
  '--judge-model',
  'fake-judge'
]
const JOBS_CEILING = Math.max(1, Math.floor(availableParallelism() / 2))
const ABSENT_MODULES = ['report', 'compare', 'list', 'author', 'usage-rollup']
const COMMANDS_TABLE = {
  run: ['round.mjs', 'runCommand'],
  resume: ['round.mjs', 'resumeCommand'],
  report: ['report.mjs', 'reportCommand'],
  compare: ['compare.mjs', 'compareCommand'],
  validate: ['validate.mjs', 'validateCommand'],
  list: ['list.mjs', 'listCommand'],
  'author-sandbox': ['author.mjs', 'authorSandboxCommand'],
  'author-import': ['author.mjs', 'authorImportCommand'],
  review: ['author.mjs', 'reviewCommand']
}

/** Parsed JSON: the shapes under test are asserted field by field below. */
type Json = ReturnType<typeof JSON.parse>

interface Entry {
  reply?: string
  writes?: { path: string; content: string }[]
  noResult?: boolean
}
interface Invocation {
  cwd: string
  argv: string[]
}
interface Observed extends Invocation {
  event: 'start' | 'end'
  pid: number
  files: string[]
  t: number
  nice?: number
  env?: Record<string, string | undefined>
  barrierMet?: boolean | null
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
let fakeLog: string
let observeLog: string
let commandLog: string
let scenarioPath: string

const read = (path: string): string => readFileSync(path, 'utf8')
const readJson = (path: string): Json => JSON.parse(read(path))
const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=s5',
      '-c',
      'user.email=s5@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args
    ],
    { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

const COMMAND_PROBE =
  'printf \'%s|%s|%s|%s\\n\' "$(nice)" "$GOMAXPROCS" "$PYTEST_ADDOPTS" "$npm_config_jobs" >> "${S5_COMMAND_LOG:-/dev/null}"'

/** A corpus problem: the dry-run fixture under another id and split. */
function addProblem(
  root: string,
  id: string,
  split: 'dev' | 'holdout',
  setup: string[] = []
): void {
  const dir = join(root, id)
  mkdirSync(root, { recursive: true })
  cpSync(DRY_RUN_PROBLEM, dir, { recursive: true })
  const parsed = readJson(join(dir, 'problem.json'))
  writeJson(join(dir, 'problem.json'), {
    ...parsed,
    id,
    split,
    setup,
    provenance: { ...parsed.provenance, sandbox: true }
  })
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
    FAKE_CLAUDE_SCENARIO: join(root, 'scenario.json'),
    FAKE_CLAUDE_LOG: join(root, 'invocations.jsonl'),
    S5_OBSERVE_LOG: join(root, 'observed.jsonl'),
    S5_FAKE_CLAUDE: FAKE,
    S5_COMMAND_LOG: join(root, 'commands.log')
  }
}

function spawnCli(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const entry = join(root, 'repo/scripts/eval/bakeoff/run.mjs')
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

const cli = (args: string[], env: NodeJS.ProcessEnv = {}): Promise<Cli> =>
  finished(spawnCli(tmp, args, env))

beforeAll(async () => {
  template = realpathSync(mkdtempSync(join(tmpdir(), 'bakeoff-s5-template-')))
  const root = join(template, 'repo')
  const harness = join(root, 'scripts/eval/bakeoff')
  cpSync(REAL_HARNESS, harness, { recursive: true })
  for (const name of ABSENT_MODULES) rmSync(join(harness, `${name}.mjs`), { force: true })
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
  addProblem(corpus, 'alpha', 'dev', [COMMAND_PROBE])
  addProblem(corpus, 'beta', 'dev')
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, '.git/info/exclude'), '/node_modules\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'harness')

  addProblem(join(template, 'holdout'), 'zeta', 'holdout')
  addProblem(join(template, 'holdout'), 'yak', 'holdout')
  const tool = join(template, 'cache/tools', `superpowers@${SUPERPOWERS_PIN}`)
  mkdirSync(join(tool, 'brainstorming'), { recursive: true })
  writeFileSync(join(tool, 'brainstorming/SKILL.md'), '# Tool\n')

  // Validation is S-4's and its result is cached by content, so every test starts from these keys.
  const dev = await finished(spawnCli(template, ['validate']))
  expect(dev.output).toContain('2 of 2 dev problems validated')
  const held = await finished(spawnCli(template, ['validate', '--split', 'holdout']))
  expect(held.output).toContain('2 of 2 holdout problems validated')
}, SETUP_MS)

afterAll(() => {
  rmSync(template, { recursive: true, force: true })
})

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bakeoff-s5-')))
  for (const name of ['repo', 'cache', 'work', 'holdout']) {
    cpSync(join(template, name), join(tmp, name), { recursive: true, verbatimSymlinks: true })
  }
  repo = join(tmp, 'repo')
  cache = join(tmp, 'cache')
  work = join(tmp, 'work')
  holdout = join(tmp, 'holdout')
  projects = join(tmp, 'projects')
  fakeLog = join(tmp, 'invocations.jsonl')
  observeLog = join(tmp, 'observed.jsonl')
  commandLog = join(tmp, 'commands.log')
  scenarioPath = join(tmp, 'scenario.json')
  writeJson(scenarioPath, [])
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const SPEC_FILE = { path: 'docs/spec.md', content: '# The spec\n' }
const contestantDone: Entry = { reply: 'ARTIFACT DONE: docs/spec.md', writes: [SPEC_FILE] }
const askOperator: Entry = { reply: 'QUESTION TO OPERATOR: Which one?' }
const operatorAnswer: Entry = { reply: 'ENTRIES: G-2\nANSWER: No preference.' }
const IMPLEMENTATION = `export function identity(x) {
  return x
}

export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
`
const builderDone: Entry = {
  reply: 'Built.',
  writes: [
    { path: 'index.js', content: IMPLEMENTATION },
    { path: 'ASSUMPTIONS.md', content: '1. nothing\n' }
  ]
}

function judgeEntry(label: string): Entry {
  const body = {
    spec: label,
    atoms: { 'A-1': 'covered', 'A-2': 'partial', 'A-3': 'missing' },
    decisions_left: [],
    contradictions: [],
    acceptance_criteria: { total: 1, executable: 1 },
    builder_guesses: [],
    notes: 'ok'
  }
  return { reply: '```json\n' + JSON.stringify(body) + '\n```' }
}

function labelOf(problem: string, repeat: number, contestant: string, ids: string[]): string {
  const labels = assignLabels(SEED, problem, repeat, ids)
  return Object.keys(labels).find((k) => labels[k] === contestant) as string
}

/** A reply every role accepts, for rounds whose order of invocations is not fixed. */
const universal: Entry = {
  reply: 'ARTIFACT DONE: docs/spec.md',
  writes: [SPEC_FILE, ...(builderDone.writes ?? [])]
}
const setScenario = (entries: Entry[]): void => writeJson(scenarioPath, entries)
const universalScenario = (n = 60): void => setScenario(Array.from({ length: n }, () => universal))

function resetCursor(): void {
  rmSync(join(projects, '.fake-claude-cursor'), { force: true })
}

const invocations = (): Invocation[] =>
  existsSync(fakeLog)
    ? read(fakeLog)
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
const observed = (): Observed[] =>
  existsSync(observeLog)
    ? read(observeLog)
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

const isProbe = (i: Invocation): boolean => i.argv[i.argv.indexOf('--max-turns') + 1] === '1'
function flagValues(argv: string[], name: string): string[] {
  return argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []))
}

const roundsDir = (): string => join(repo, '.harnu/eval/bakeoff')
function onlyRoundId(): string {
  const ids = readdirSync(roundsDir())
  expect(ids).toHaveLength(1)
  return ids[0]
}
const roundFile = (id: string): Json => readJson(join(roundsDir(), id, 'round.json'))

/** Every path under `dir`, relative, without `.git`, `node_modules` or the clones' contents. */
function listTree(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git' || entry.name === 'node_modules') return []
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return listTree(full, base)
    return [relative(base, full)]
  })
}

/** The whole round's tokens, summed from the files without the harness's own code. */
function sumFromFiles(unitsRoot: string): number {
  let sum = 0
  const add = (path: string, pick: (j: Json) => number): void => {
    if (existsSync(path)) sum += pick(readJson(path))
  }
  const discarded = (path: string): void => {
    add(path, (entries) => entries.reduce((n: number, e: Json) => n + e.usage.total, 0))
  }
  discarded(join(unitsRoot, '_round/discarded.json'))
  for (const problem of readdirSync(unitsRoot).filter((n) => n !== '_round')) {
    for (const contestant of readdirSync(join(unitsRoot, problem))) {
      if (contestant.startsWith('labels-')) continue
      for (const r of readdirSync(join(unitsRoot, problem, contestant))) {
        const unit = join(unitsRoot, problem, contestant, r)
        add(join(unit, 'contestant.json'), (j) => j.usage.contestant.total + j.usage.operator.total)
        add(join(unit, 'build.json'), (j) => j.usage.total)
        discarded(join(unit, 'contestant/discarded.json'))
        discarded(join(unit, 'build/discarded.json'))
        for (const name of readdirSync(unit)) {
          if (/^judge-\d+\.json$/.test(name)) add(join(unit, name), (j) => j.usage.total)
          if (/^judge-\d+$/.test(name)) discarded(join(unit, name, 'discarded.json'))
        }
      }
    }
  }
  return sum
}

const devUnits = (id: string): string => join(cache, 'rounds', id, 'units')
const holdoutUnits = (id: string): string => join(work, 'rounds', id, 'units')

function writeCompare(id: string, fields: Json): void {
  mkdirSync(join(roundsDir(), id), { recursive: true })
  writeJson(join(roundsDir(), id, 'compare.json'), fields)
}
const skillHead = (): string => git(repo, 'rev-parse', 'HEAD')

function acceptedDevRound(id: string): void {
  writeCompare(id, {
    split: 'dev',
    verdict: 'accepted',
    baseline: 'baseline-round',
    candidate: id,
    baselineSkillSha: '0'.repeat(40),
    candidateSkillSha: skillHead()
  })
}

it(
  'a round schedules every unit and writes outside the repo',
  async () => {
    universalScenario()
    const dev = await cli(
      [
        'run',
        '--problems',
        'alpha',
        '--repeats',
        '2',
        '--judges',
        '2',
        '--jobs',
        '2',
        '--seed',
        SEED,
        ...FULL_IDS
      ],
      {
        HARNU_BAKEOFF_CLAUDE_BIN: OBSERVE,
        S5_BARRIER_DIR: join(tmp, 'barrier'),
        S5_BARRIER_COUNT: '2'
      }
    )
    expect(dev.output, dev.output).not.toContain('fake-claude: no scenario entry')
    expect(dev.code).toBe(0)
    const id = onlyRoundId()
    expect(id).toMatch(/^\d{8}-\d{6}$/)

    const round = roundFile(id)
    expect(Object.keys(round).sort()).toEqual(
      [
        'args',
        'budget',
        'dryRun',
        'finishedAt',
        'judges',
        'models',
        'pins',
        'problems',
        'repeats',
        'roundId',
        'seed',
        'split',
        'startedAt',
        'status',
        'units'
      ].sort()
    )
    expect(round).toMatchObject({
      roundId: id,
      split: 'dev',
      status: 'done',
      dryRun: false,
      seed: SEED,
      repeats: 2,
      judges: 2,
      models: { contestant: 'fake-opus', operator: 'fake-sonnet', judge: 'fake-judge' },
      pins: { 'harnu-spec': skillHead(), superpowers: SUPERPOWERS_PIN }
    })
    expect(round.finishedAt).toEqual(expect.any(String))
    expect(round.args).toEqual({
      problems: ['alpha'],
      withTlc: false,
      skillRef: 'HEAD',
      repeats: 2,
      judges: 2,
      model: 'fake-opus',
      operatorModel: 'fake-sonnet',
      judgeModel: 'fake-judge',
      budget: 400000000,
      jobs: 2,
      seed: SEED,
      dryRun: false,
      after: null
    })
    expect(round.budget).toEqual({ cap: 400000000, spent: sumFromFiles(devUnits(id)) })
    expect(round.budget.spent).toBeGreaterThan(0)
    expect(round.problems).toEqual([
      { id: 'alpha', contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) }
    ])

    const expected: string[] = []
    for (const contestant of ['harnu-spec', 'superpowers']) {
      for (const r of ['r1', 'r2']) {
        for (const step of ['contestant', 'judge-1', 'judge-2', 'build']) {
          expected.push(`alpha/${contestant}/${r}/${step}`)
        }
      }
    }
    expect(round.units.map((u: Json) => u.unit).sort()).toEqual([...expected].sort())
    expect(round.units.every((u: Json) => u.state === 'done')).toBe(true)
    for (const contestant of ['harnu-spec', 'superpowers']) {
      for (const r of ['r1', 'r2']) {
        const unit = join(devUnits(id), 'alpha', contestant, r)
        for (const file of ['contestant.json', 'judge-1.json', 'judge-2.json', 'build.json']) {
          expect(existsSync(join(unit, file)), `${unit}/${file}`).toBe(true)
        }
      }
    }

    // Everything but the round directory stays out of the repo.
    const dirty = git(repo, 'status', '--porcelain', '--untracked-files=all')
      .split('\n')
      .filter((l) => l && !l.slice(3).startsWith('.harnu/eval/bakeoff/'))
    expect(dirty).toEqual([])
    expect(readdirSync(join(roundsDir(), id)).sort()).toEqual(['round.json'])

    // At most --jobs at once, and truly in parallel.
    const events = observed().sort((a, b) => a.t - b.t || (a.event === 'end' ? -1 : 1))
    let live = 0
    let peak = 0
    for (const e of events) {
      live += e.event === 'start' ? 1 : -1
      peak = Math.max(peak, live)
    }
    expect(peak).toBe(2)
    expect(events.some((e) => e.barrierMet === true)).toBe(true)

    // Each session runs niced with the single-thread variables.
    const starts = events.filter((e) => e.event === 'start')
    for (const e of starts) {
      expect(e.nice).toBe(19)
      expect(e.env).toEqual({
        GOMAXPROCS: '1',
        PYTEST_ADDOPTS: '-p no:xdist',
        npm_config_jobs: '1'
      })
    }
    const commandLines = read(commandLog).split('\n').filter(Boolean)
    expect(commandLines.length).toBeGreaterThan(0)
    for (const line of commandLines) expect(line).toBe('19|1|-p no:xdist|1')

    // The contestant run, then its judges, then its build, per tuple.
    for (const contestant of ['harnu-spec', 'superpowers']) {
      for (const r of ['r1', 'r2']) {
        const unit = join(devUnits(id), 'alpha', contestant, r)
        const of = (suffix: string, event: 'start' | 'end'): Observed[] =>
          events.filter((e) => e.event === event && e.cwd === join(unit, suffix))
        const contestantEnd = Math.max(...of('clone', 'end').map((e) => e.t))
        const judgeStarts = [...of('judge-1', 'start'), ...of('judge-2', 'start')].map((e) => e.t)
        const judgeEnds = [...of('judge-1', 'end'), ...of('judge-2', 'end')].map((e) => e.t)
        const buildStart = Math.min(...of('build-clone', 'start').map((e) => e.t))
        expect(Math.min(...judgeStarts)).toBeGreaterThanOrEqual(contestantEnd)
        expect(buildStart).toBeGreaterThanOrEqual(Math.max(...judgeEnds))
      }
    }

    // A holdout round leaves no per-problem field in the repo.
    resetCursor()
    universalScenario()
    acceptedDevRound(id)
    const beforeRounds = new Set(readdirSync(roundsDir()))
    const held = await cli([
      'run',
      '--split',
      'holdout',
      '--after',
      id,
      '--repeats',
      '1',
      '--judges',
      '1',
      '--jobs',
      '999',
      '--seed',
      SEED,
      ...FULL_IDS
    ])
    expect(held.code, held.output).toBe(0)
    expect(held.output).toMatch(/jobs/i)
    for (const name of ['zeta', 'yak', 'H-1', 'H-2']) expect(held.output).not.toContain(name)

    const holdoutId = readdirSync(roundsDir()).find((n) => !beforeRounds.has(n)) as string
    const heldRound = roundFile(holdoutId)
    expect(heldRound.args).toBe('redacted')
    expect(heldRound.problems).toEqual([])
    expect(heldRound.units).toEqual([])
    expect(heldRound.status).toBe('done')
    const repoSide = read(join(roundsDir(), holdoutId, 'round.json'))
    for (const name of ['zeta', 'yak']) expect(repoSide).not.toContain(name)

    const privateDir = join(holdout, '.rounds', holdoutId)
    expect(readJson(join(privateDir, 'labels.json'))).toEqual({ 'H-1': 'yak', 'H-2': 'zeta' })
    const problems = readJson(join(privateDir, 'problems.json'))
    expect(Object.keys(problems).sort()).toEqual(['args', 'problems', 'roundId', 'units'])
    expect(problems.roundId).toBe(holdoutId)
    expect(problems.args.jobs).toBe(JOBS_CEILING)
    expect(problems.args.after).toBe(id)
    expect(problems.problems).toEqual([
      {
        id: 'yak',
        label: 'H-1',
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        contestants: { 'harnu-spec': {}, superpowers: {} }
      },
      {
        id: 'zeta',
        label: 'H-2',
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        contestants: { 'harnu-spec': {}, superpowers: {} }
      }
    ])
    expect(problems.units).toHaveLength(12)
    expect(problems.units.every((u: Json) => u.state === 'done')).toBe(true)
    expect(existsSync(join(holdoutUnits(holdoutId), 'yak/harnu-spec/r1/contestant.json'))).toBe(
      true
    )
    expect(existsSync(join(cache, 'rounds', holdoutId))).toBe(false)
  },
  SLOW_TEST_MS
)

it(
  'a round stops at its token cap and resumes the rest',
  async () => {
    setScenario([{ noResult: true }, ...Array.from({ length: 40 }, () => universal)])
    const first = await cli([
      'run',
      '--problems',
      'alpha',
      '--repeats',
      '1',
      '--judges',
      '1',
      '--jobs',
      '2',
      '--budget',
      '1',
      '--seed',
      SEED,
      ...FULL_IDS
    ])
    expect(first.code, first.output).toBe(3)
    const id = onlyRoundId()
    const units = devUnits(id)
    const unitOf = (c: string): string => join(units, 'alpha', c, 'r1')
    const contestants = ['harnu-spec', 'superpowers']

    let round = roundFile(id)
    expect(round.status).toBe('aborted-budget')
    expect(round.budget.spent).toBe(sumFromFiles(units))
    expect(round.budget.spent).toBeGreaterThanOrEqual(1)
    for (const c of contestants) {
      // Both were in flight when the cap was reached, and both finished.
      expect(existsSync(join(unitOf(c), 'contestant.json'))).toBe(true)
      expect(existsSync(join(unitOf(c), 'judge-1.json'))).toBe(false)
      expect(existsSync(join(unitOf(c), 'build.json'))).toBe(false)
    }
    expect(round.units.filter((u: Json) => u.state === 'done')).toHaveLength(2)
    // The attempt with no result event was retried, and it counted.
    const discardedFiles = contestants
      .map((c) => join(unitOf(c), 'contestant/discarded.json'))
      .filter((f) => existsSync(f))
    expect(discardedFiles).toHaveLength(1)
    expect(readJson(discardedFiles[0])[0].usage.total).toBeGreaterThan(0)

    // Without a raised cap nothing runs.
    const before = invocations().length
    const held = await cli(['resume', id])
    expect(held.code, held.output).toBe(3)
    expect(invocations()).toHaveLength(before)
    expect(roundFile(id).budget.cap).toBe(1)

    const resumed = await cli(['resume', id, '--budget', '100000000'])
    expect(resumed.code, resumed.output).toBe(0)
    round = roundFile(id)
    expect(round.status).toBe('done')
    expect(round.budget.cap).toBe(100000000)
    expect(round.units.every((u: Json) => u.state === 'done')).toBe(true)
    for (const c of contestants) expect(existsSync(join(unitOf(c), 'build.json'))).toBe(true)
    const contestantClones = contestants.map((c) => join(unitOf(c), 'clone'))
    const afterResume = invocations().slice(before)
    expect(afterResume.length).toBeGreaterThan(0)
    expect(afterResume.filter((i) => contestantClones.includes(i.cwd))).toEqual([])
    expect(round.budget.spent).toBe(sumFromFiles(units))
  },
  SLOW_TEST_MS
)

it('the harness is a dependency-free script under scripts/eval', () => {
  const pkg = readJson(join(REAL_ROOT, 'package.json'))
  expect(pkg.scripts['eval:bakeoff']).toBe('vite-node scripts/eval/bakeoff/run.mjs --')

  const modules: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const rel = relative(REAL_HARNESS, full)
        if (rel === 'fixtures' || rel === 'corpus') continue
        walk(full)
      } else if (entry.name.endsWith('.mjs')) {
        modules.push(full)
      }
    }
  }
  walk(REAL_HARNESS)
  expect(modules.map((m) => relative(REAL_HARNESS, m))).toEqual(
    expect.arrayContaining(['run.mjs', 'round.mjs', 'budget.mjs'])
  )

  const specifier =
    /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/gm
  for (const file of modules) {
    for (const match of read(file).matchAll(specifier)) {
      const spec = match[1] ?? match[2] ?? match[3]
      const allowed =
        spec.startsWith('node:') ||
        /^\.\/[^/]+\.mjs$/.test(spec) ||
        spec === '../mission-behavior/harnu.mjs' ||
        spec === '../mission-behavior/procs.mjs'
      expect(allowed, `${relative(REAL_ROOT, file)} imports ${spec}`).toBe(true)
    }
  }

  // The dispatcher imports its modules from a table of literal names, all of them siblings.
  const baseline = (() => {
    try {
      return JSON.parse(
        execFileSync('git', ['show', 'origin/main:package.json'], {
          cwd: REAL_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        })
      )
    } catch {
      return null
    }
  })()
  if (baseline !== null) {
    expect(pkg.dependencies).toEqual(baseline.dependencies)
    expect(pkg.devDependencies).toEqual(baseline.devDependencies)
  }
})

it(
  'every role runs in its contained directory',
  async () => {
    const ids = ['harnu-spec', 'superpowers']
    const scenarioFor = (problem: string): Entry[] => [
      askOperator,
      operatorAnswer,
      contestantDone,
      judgeEntry(labelOf(problem, 1, 'harnu-spec', ids)),
      builderDone,
      contestantDone,
      { reply: 'not json' },
      judgeEntry(labelOf(problem, 1, 'superpowers', ids)),
      builderDone
    ]
    const observeEnv = { HARNU_BAKEOFF_CLAUDE_BIN: OBSERVE }
    const common = ['--repeats', '1', '--judges', '1', '--jobs', '1', '--seed', SEED, ...FULL_IDS]

    setScenario(scenarioFor('alpha'))
    const dev = await cli(['run', '--problems', 'alpha', ...common], observeEnv)
    expect(dev.code, dev.output).toBe(0)
    const devId = onlyRoundId()

    acceptedDevRound(devId)
    resetCursor()
    setScenario([...scenarioFor('yak'), ...scenarioFor('zeta')])
    const before = new Set(readdirSync(roundsDir()))
    const held = await cli(['run', '--split', 'holdout', '--after', devId, ...common], observeEnv)
    expect(held.code, held.output).toBe(0)
    const holdoutId = readdirSync(roundsDir()).find((n) => !before.has(n)) as string

    const rounds = [
      { problems: ['alpha'], units: devUnits(devId) },
      { problems: ['yak', 'zeta'], units: holdoutUnits(holdoutId) }
    ]
    const forbidden = [repo, join(repo, 'scripts/eval/bakeoff/corpus'), holdout]
    const inside = (path: string, root: string): boolean =>
      path === root || path.startsWith(root + sep)

    const events = observed()
    for (const { problems, units } of rounds) {
      for (const problem of problems) {
        for (const contestant of ids) {
          const unit = join(units, problem, contestant, 'r1')
          const at = (dir: string): Observed[] => events.filter((e) => e.cwd === join(unit, dir))

          const contestantRuns = at('clone')
          expect(contestantRuns.length).toBeGreaterThan(0)
          for (const e of contestantRuns) {
            expect(flagValues(e.argv, '--add-dir')).toEqual([join(unit, 'tool')])
          }

          const operatorRuns = at('operator')
          if (contestant === 'harnu-spec') expect(operatorRuns.length).toBeGreaterThan(0)
          for (const e of operatorRuns) {
            expect(flagValues(e.argv, '--add-dir')).toEqual([])
            expect(e.files).toEqual(['answer-sheet.md'])
          }

          const builderRuns = at('build-clone')
          expect(builderRuns.length).toBeGreaterThan(0)
          for (const e of builderRuns) {
            expect(flagValues(e.argv, '--add-dir')).toEqual([])
            // While the session lives, the hidden file does not exist.
            expect(e.files).not.toContain('test/slugify.hidden.test.js')
          }
          const junit = read(join(unit, 'build/hidden-1.xml'))
          expect(junit).toContain('A-1 lowercases the text')
        }
      }
    }

    // A judge runs in a neutral directory that names no contestant, so it is matched by its place,
    // not by its unit. Each unit has one judge, and each problem's invalid reply costs one retry.
    const judgeStarts = events.filter(
      (e) => e.event === 'start' && /[\\/]judge-cwd[\\/][0-9a-f-]{36}$/.test(e.cwd)
    )
    const unitCount = rounds.reduce((sum, r) => sum + r.problems.length * ids.length, 0)
    expect(judgeStarts.length).toBeGreaterThan(unitCount)
    for (const e of judgeStarts) {
      expect(flagValues(e.argv, '--add-dir')).toEqual([])
      expect(e.files).toEqual(['bundle.md'])
    }

    for (const e of events.filter((x) => x.event === 'start' && !isProbe(x))) {
      for (const root of forbidden) {
        expect(inside(e.cwd, root), `${e.cwd} under ${root}`).toBe(false)
        for (const dir of flagValues(e.argv, '--add-dir')) {
          expect(inside(dir, root), `${dir} under ${root}`).toBe(false)
        }
      }
    }
    // Nothing a session could write ever reached the holdout clone or the repo.
    expect(
      listTree(holdout).filter((p) => !p.startsWith('.rounds/') && !/^(yak|zeta)\//.test(p))
    ).toEqual([])
  },
  SLOW_TEST_MS
)

it(
  'a holdout round requires an accepted dev compare',
  async () => {
    const common = ['--split', 'holdout', ...FULL_IDS]

    const noAfter = await cli(['run', ...common])
    expect(noAfter.code).toBe(2)
    expect(noAfter.output).toContain('DEV_NOT_ACCEPTED')

    const missing = await cli(['run', ...common, '--after', 'no-such-round'])
    expect(missing.code).toBe(2)
    expect(missing.output).toContain('DEV_NOT_ACCEPTED')

    const good = { split: 'dev', verdict: 'accepted', baseline: 'b', candidate: 'c' }
    const shas = { baselineSkillSha: '0'.repeat(40), candidateSkillSha: skillHead() }

    writeCompare('wrong-split', { ...good, split: 'holdout', ...shas })
    writeCompare('rejected', { ...good, verdict: 'rejected', ...shas })
    writeCompare('other-skill', {
      ...good,
      baselineSkillSha: '0'.repeat(40),
      candidateSkillSha: '1'.repeat(40)
    })
    for (const after of ['wrong-split', 'rejected', 'other-skill']) {
      const result = await cli(['run', ...common, '--after', after])
      expect(result.code, after).toBe(2)
      expect(result.output, after).toContain('DEV_NOT_ACCEPTED')
    }
    expect(invocations()).toEqual([])

    for (const command of ['run', 'validate', 'list']) {
      const bad = await cli([command, '--split', 'nonsense'])
      expect(bad.code, command).toBe(2)
      expect(bad.output, command).toContain('SPLIT_REQUIRED')
    }
    const onHoldout = await cli(['run', ...common, '--after', 'rejected', '--problems', 'zeta'])
    expect(onHoldout.code).toBe(2)
    expect(onHoldout.output).toContain('PROBLEMS_ON_HOLDOUT')
    expect(invocations()).toEqual([])
  },
  SLOW_TEST_MS
)

it(
  'a ctrl-c discards the attempt and resume continues',
  async () => {
    universalScenario()
    const child = spawnCli(
      tmp,
      [
        'run',
        '--problems',
        'alpha',
        '--repeats',
        '1',
        '--judges',
        '1',
        '--jobs',
        '2',
        '--seed',
        SEED,
        ...FULL_IDS
      ],
      { FAKE_CLAUDE_DELAY_MS: '600000' }
    )
    const ended = finished(child)
    const deadline = Date.now() + SLOW_TEST_MS / 2
    while (invocations().length < 2) {
      expect(Date.now()).toBeLessThan(deadline)
      await new Promise((done) => setTimeout(done, 50))
    }
    child.kill('SIGINT')
    const run = await ended
    expect(run.code, run.output).toBe(130)

    const id = onlyRoundId()
    const unitOf = (c: string): string => join(devUnits(id), 'alpha', c, 'r1')
    expect(roundFile(id).status).toBe('interrupted')
    expect(roundFile(id).budget.spent).toBe(sumFromFiles(devUnits(id)))
    for (const c of ['harnu-spec', 'superpowers']) {
      expect(existsSync(join(unitOf(c), 'contestant.json'))).toBe(false)
      const entries = readJson(join(unitOf(c), 'contestant/discarded.json'))
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ phase: 'contestant', contestant: c })
      expect(entries[0].usage.total).toBeGreaterThan(0)
    }
    expect(listTree(projects).filter((p) => p.endsWith('.jsonl'))).toEqual([])
    expect(roundFile(id).units.every((u: Json) => u.state === 'pending')).toBe(true)

    const before = invocations().length
    const resumed = await cli(['resume', id])
    expect(resumed.code, resumed.output).toBe(0)
    expect(roundFile(id).status).toBe('done')
    for (const c of ['harnu-spec', 'superpowers']) {
      expect(existsSync(join(unitOf(c), 'contestant.json'))).toBe(true)
      expect(existsSync(join(unitOf(c), 'build.json'))).toBe(true)
      expect(readJson(join(unitOf(c), 'contestant/discarded.json'))).toHaveLength(1)
    }

    // A finished round has nothing left to run.
    const afterResume = invocations().length
    expect(afterResume).toBeGreaterThan(before)
    const again = await cli(['resume', id])
    expect(again.code, again.output).toBe(0)
    expect(invocations()).toHaveLength(afterResume)
  },
  SLOW_TEST_MS
)

it(
  'the CLI dispatches its table and exits 2 on a bad configuration',
  async () => {
    const run = await import('../scripts/eval/bakeoff/run.mjs')
    const table = Object.fromEntries(
      Object.entries(run.COMMANDS as Record<string, { module: string; handler: string }>).map(
        ([name, row]) => [name, [row.module, row.handler]]
      )
    )
    expect(table).toEqual(COMMANDS_TABLE)
    expect(run.assertJudgeModel('m', 'm', { dryRun: false })).toMatchObject({
      code: 'JUDGE_MODEL_SAME'
    })
    expect(run.assertJudgeModel('m', 'm', { dryRun: true })).toBeNull()
    expect(run.assertJudgeModel('m', 'n', { dryRun: false })).toBeNull()

    // The real entry point, through the package script's own runner.
    const realEntry = await new Promise<Cli>((done) => {
      const child = spawn(
        process.execPath,
        [
          join(REAL_ROOT, 'node_modules/vite-node/vite-node.mjs'),
          'scripts/eval/bakeoff/run.mjs',
          '--',
          'validate',
          '--problems',
          'no-such-problem'
        ],
        { cwd: REAL_ROOT, env: baseEnv(tmp), stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let output = ''
      child.stdout.on('data', (d) => (output += d))
      child.stderr.on('data', (d) => (output += d))
      child.on('close', (code) => done({ code, output }))
    })
    expect(realEntry.output).toContain('PROBLEM_UNKNOWN')
    expect(realEntry.code).toBe(2)

    const absent = await cli(['report', 'whatever'])
    expect(absent.code).toBe(2)
    expect(absent.output).toContain('NOT_YET')

    writeFileSync(join(repo, 'scripts/eval/bakeoff/list.mjs'), 'export const nothing = 1\n')
    const noHandler = await cli(['list'])
    expect(noHandler.code).toBe(2)
    expect(noHandler.output).toContain('NOT_YET')

    const validated = await cli(['validate'])
    expect(validated.code, validated.output).toBe(0)
    expect(validated.output).toContain('2 of 2 dev problems validated')

    const badRoots: [string, NodeJS.ProcessEnv][] = [
      ['HOLDOUT_INSIDE_REPO', { HARNU_BAKEOFF_HOLDOUT: join(repo, 'holdout-here') }],
      ['CACHE_INSIDE_REPO', { HARNU_BAKEOFF_CACHE: join(repo, 'cache-here') }],
      ['WORK_NOT_CONTAINED', { HARNU_BAKEOFF_WORK: join(tmp, 'cache/work') }],
      ['HOLDOUT_UNSET', { HARNU_BAKEOFF_HOLDOUT: '' }]
    ]
    for (const [code, env] of badRoots) {
      const args =
        code === 'HOLDOUT_UNSET' ? ['run', '--split', 'holdout', ...FULL_IDS] : ['run', ...FULL_IDS]
      const refused = await cli(args, env)
      expect(refused.code, code).toBe(2)
      expect(refused.output, code).toContain(code)
    }
    expect(invocations()).toEqual([])

    // An alias and the full id it resolves to are the same model.
    setScenario([{ reply: 'ok' }])
    const sameModel = await cli([
      'run',
      '--model',
      'sonnet',
      '--judge-model',
      'fake-sonnet',
      '--operator-model',
      'fake-sonnet'
    ])
    expect(sameModel.code, sameModel.output).toBe(2)
    expect(sameModel.output).toContain('JUDGE_MODEL_SAME')
    expect(invocations().every(isProbe)).toBe(true)

    resetCursor()
    rmSync(fakeLog)
    setScenario([{ noResult: true }])
    const unresolved = await cli([
      'run',
      '--model',
      'opus',
      '--operator-model',
      'x',
      '--judge-model',
      'y'
    ])
    expect(unresolved.code, unresolved.output).toBe(2)
    expect(unresolved.output).toContain('MODEL_UNRESOLVED')
    expect(invocations().every(isProbe)).toBe(true)

    resetCursor()
    rmSync(fakeLog)
    const ids = ['harnu-spec', 'superpowers']
    setScenario([
      { reply: 'probe' },
      { reply: 'probe' },
      contestantDone,
      judgeEntry(labelOf('alpha', 1, 'harnu-spec', ids)),
      builderDone,
      contestantDone,
      judgeEntry(labelOf('alpha', 1, 'superpowers', ids)),
      builderDone
    ])
    // The operator and the judge share a model, which is allowed.
    const accepted = await cli([
      'run',
      '--problems',
      'alpha',
      '--repeats',
      '1',
      '--judges',
      '1',
      '--jobs',
      '1',
      '--seed',
      SEED,
      '--model',
      'opus',
      '--operator-model',
      'sonnet',
      '--judge-model',
      'sonnet'
    ])
    expect(accepted.code, accepted.output).toBe(0)
    const id = readdirSync(roundsDir()).find((n) => /^\d{8}-\d{6}$/.test(n)) as string
    const probes = readJson(join(devUnits(id), '_round/discarded.json'))
    expect(probes).toHaveLength(2)
    for (const entry of probes) {
      expect(entry).toMatchObject({ unit: null, phase: 'model-probe', contestant: null })
      expect(entry.usage.total).toBeGreaterThan(0)
    }
    expect(roundFile(id).models).toEqual({
      contestant: 'fake-opus',
      operator: 'fake-sonnet',
      judge: 'fake-sonnet'
    })
  },
  SLOW_TEST_MS
)

it(
  'a dry run applies its fixed overrides',
  async () => {
    const loaded = loadCorpus(join(REAL_HARNESS, 'fixtures/dry-run'), {
      split: 'dev',
      forRun: true
    })
    expect(loaded.errors).toEqual([])
    expect(loaded.problems.map((p: Json) => p.id)).toEqual(['slugify-basic'])
    expect(loaded.problems[0].provenance.reviewedAt).toEqual(expect.any(String))

    setScenario([{ reply: 'probe' }, contestantDone, judgeEntry('P'), builderDone])
    const result = await cli(
      [
        'run',
        '--dry-run',
        '--split',
        'holdout',
        '--model',
        'opus',
        '--with-tlc',
        '--repeats',
        '5',
        '--judges',
        '5',
        '--budget',
        '77'
      ],
      { HARNU_BAKEOFF_HOLDOUT: '' }
    )
    expect(result.code, result.output).toBe(0)
    const id = onlyRoundId()
    const round = roundFile(id)
    expect(round).toMatchObject({
      dryRun: true,
      split: 'dev',
      status: 'done',
      repeats: 1,
      judges: 1,
      models: { contestant: 'fake-haiku', operator: 'fake-haiku', judge: 'fake-haiku' },
      budget: { cap: 10000000 }
    })
    expect(Object.keys(round.pins)).toEqual(['harnu-spec'])
    expect(round.problems.map((p: Json) => p.id)).toEqual(['slugify-basic'])
    expect(round.units.map((u: Json) => u.unit).sort()).toEqual(
      [
        'slugify-basic/harnu-spec/r1/build',
        'slugify-basic/harnu-spec/r1/contestant',
        'slugify-basic/harnu-spec/r1/judge-1'
      ].sort()
    )
    const invoked = invocations()
    expect(invoked.filter(isProbe).map((i) => flagValues(i.argv, '--model')[0])).toEqual(['haiku'])
    const rest = invoked.filter((i) => !isProbe(i))
    expect(rest.length).toBeGreaterThan(0)
    for (const i of rest) expect(flagValues(i.argv, '--model')).toEqual(['fake-haiku'])
    expect(
      statSync(join(devUnits(id), 'slugify-basic/harnu-spec/r1/build.json')).size
    ).toBeGreaterThan(0)
    expect(dirname(devUnits(id))).toBe(join(cache, 'rounds', id))
  },
  SLOW_TEST_MS
)
