/**
 * T676 S-4 — the builder, the hidden-test runner and problem validation:
 * `scripts/eval/bakeoff/{build,junit,validate}.mjs` against the fake `claude` and a hidden suite
 * that follows a plan (`tests/fixtures/eval-bakeoff/s4/problem/hidden/emit-junit.mjs`). No model is
 * called and nothing reaches the network: every target is inline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const FAKE = resolve(__dirname, 'fixtures/eval-bakeoff/fake-claude.mjs')
const S4_PROBLEM = resolve(__dirname, 'fixtures/eval-bakeoff/s4/problem')
const BUILDER_TOOLS = 'Read,Write,Edit,Glob,Grep,Bash'
const SLOW_TEST_MS = 120_000
const TEST_SET = ['hidden::a', 'hidden::b', 'hidden::c']

/** Parsed JSON: the shapes under test are asserted field by field below. */
type Json = ReturnType<typeof JSON.parse>

/** One scripted invocation of the fake `claude`. */
interface Entry {
  reply?: string
  writes?: { path: string; content: string }[]
  noResult?: boolean
  hangMs?: number
}

/** One invocation of the hidden suite; see the header of `emit-junit.mjs`. */
interface HiddenRun {
  cases?: Record<string, 'pass' | 'fail' | 'skip' | 'error' | 'collect'>
  xml?: 'missing' | 'corrupt'
  exit?: number
  stdout?: string
}

interface ProblemOptions {
  id?: string
  split?: 'dev' | 'holdout'
  root?: string
  pristine: HiddenRun[]
  fixed?: HiddenRun[]
  setup?: string[]
  test?: string
  versions?: string
  compileErrorPattern?: string
}

let tmp: string
let projects: string
let log: string
let promptLog: string
let scenarioPath: string
let setupLog: string
let roots: Json

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bakeoff-s4-')))
  projects = join(tmp, 'projects')
  log = join(tmp, 'invocations.jsonl')
  promptLog = join(tmp, 'prompts.jsonl')
  scenarioPath = join(tmp, 'scenario.json')
  setupLog = join(tmp, 'setup.log')
  roots = {
    repo: join(tmp, 'repo'),
    mainCheckout: join(tmp, 'repo'),
    cache: join(tmp, 'cache'),
    work: join(tmp, 'work'),
    holdout: join(tmp, 'holdout')
  }
  vi.stubEnv('HARNU_BAKEOFF_CLAUDE_BIN', FAKE)
  vi.stubEnv('HARNU_BAKEOFF_CLAUDE_PROJECTS', projects)
  vi.stubEnv('FAKE_CLAUDE_SCENARIO', scenarioPath)
  vi.stubEnv('FAKE_CLAUDE_LOG', log)
  vi.stubEnv('FAKE_CLAUDE_PROMPT_LOG', promptLog)
  vi.stubEnv('FAKE_CLAUDE_DELAY_MS', '')
  vi.stubEnv('HARNU_BAKEOFF_TIMEOUT_SCALE', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  rmSync(tmp, { recursive: true, force: true })
})

const read = (path: string): string => readFileSync(path, 'utf8')
const readJson = (path: string): Json => JSON.parse(read(path))
const planPath = (id: string): string => join(tmp, `plan-${id}.json`)

/** Git with the hook-injected variables removed, so a pre-push run stays in its repo. */
function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

/** How many times the hidden suite ran in a stage. */
function hiddenRuns(id: string, stage: 'pristine' | 'fixed'): number {
  const counter = `${planPath(id)}.${stage}.count`
  return existsSync(counter) ? Number(read(counter)) : 0
}

const setupRuns = (): number =>
  existsSync(setupLog) ? read(setupLog).split('\n').filter(Boolean).length : 0

/** A copy of the fixture problem under `root`, its hidden command following the given plan. */
function makeProblem(options: ProblemOptions): Json {
  const id = options.id ?? 'demo'
  const split = options.split ?? 'dev'
  const dir = join(options.root ?? join(tmp, 'corpus'), id)
  mkdirSync(dirname(dir), { recursive: true })
  cpSync(S4_PROBLEM, dir, { recursive: true })
  writeFileSync(
    planPath(id),
    JSON.stringify({
      pristine: options.pristine,
      fixed: options.fixed ?? [{ cases: { a: 'pass', b: 'pass', c: 'pass' } }]
    })
  )
  const base = readJson(join(dir, 'problem.json'))
  const parsed = {
    ...base,
    id,
    split,
    setup: options.setup ?? ['touch setup-marker', `echo ran >> ${setupLog}`],
    test: options.test ?? 'echo existing suite ran',
    versions: options.versions ?? base.versions,
    hidden: {
      ...base.hidden,
      cmd: `node tests/emit-junit.mjs ${planPath(id)}`,
      compileErrorPattern: options.compileErrorPattern ?? base.hidden.compileErrorPattern
    }
  }
  writeFileSync(join(dir, 'problem.json'), `${JSON.stringify(parsed, null, 2)}\n`)
  return { ...parsed, dir }
}

/** A problem that validates: its suite fails on pristine and passes on the reference. */
const validPlan = (): Pick<ProblemOptions, 'pristine' | 'fixed'> => ({
  pristine: [{ cases: { a: 'fail', b: 'pass', c: 'pass' } }],
  fixed: [{ cases: { a: 'pass', b: 'pass', c: 'pass' } }]
})

function setScenario(entries: Entry[]): void {
  writeFileSync(scenarioPath, JSON.stringify(entries))
  rmSync(join(projects, '.fake-claude-cursor'), { force: true })
  rmSync(log, { force: true })
  rmSync(promptLog, { force: true })
}

const jsonl = (path: string): Json[] =>
  existsSync(path)
    ? read(path)
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

function makeArtifact(files: Record<string, string>): string {
  const dir = join(tmp, 'artifact')
  mkdirSync(dir, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

const unitDirOf = (name = 'r1'): string => join(tmp, 'units', 'demo', 'harnu-spec', name)

async function build(problem: Json, artifactDir: string, testSet = TEST_SET): Promise<Json> {
  const { runBuild } = await import('../scripts/eval/bakeoff/build.mjs')
  return runBuild({
    problem,
    unitDir: unitDirOf(),
    artifactDir,
    roots,
    model: 'fake-model',
    testSet
  })
}

const SPEC = { 'docs/spec.md': '# The spec\n', 'docs/z plan.md': '# A plan\n' }
const ALL_PASS: HiddenRun = { cases: { a: 'pass', b: 'pass', c: 'pass' } }

describe('runBuild (AC-10)', () => {
  it(
    'a flaky hidden test counts as failed and is listed',
    async () => {
      const problem = makeProblem({
        pristine: [
          { cases: { a: 'pass', b: 'pass', c: 'fail', extra: 'pass' } },
          { cases: { a: 'pass', b: 'fail', c: 'fail', extra: 'pass' } }
        ]
      })
      // A builder that plants its own hidden file: only a copy made after it ended overwrites it.
      const sabotage =
        "import { writeFileSync as w } from 'node:fs'\nw(process.env.BAKEOFF_JUNIT, '')\n"
      setScenario([
        {
          reply: 'Implemented.',
          writes: [
            { path: 'tests/emit-junit.mjs', content: sabotage },
            { path: 'impl.txt', content: 'the implementation\n' },
            {
              path: 'ASSUMPTIONS.md',
              content: '1. first\n2. second\nnot a numbered item\n12) no\n'
            }
          ]
        }
      ])

      const result = await build(problem, makeArtifact(SPEC))
      const unit = unitDirOf()
      const clone = join(unit, 'build-clone')

      expect(result).toMatchObject({
        status: 'done',
        reason: null,
        hidden: {
          passed: 1,
          total: 3,
          flaky: ['hidden::b'],
          failed: ['hidden::b', 'hidden::c']
        },
        existing: { exitCode: 0 },
        assumptions: 2,
        usage: { input: 100, output: 10, total: 110 }
      })
      expect(result.diffstat).toContain('impl.txt')
      expect(result.wallMs).toBeGreaterThan(0)
      expect(readJson(join(unit, 'build.json'))).toEqual(result)
      expect(hiddenRuns('demo', 'pristine')).toBe(2)

      // The scores above came from the real hidden file, so it overwrote the builder's plant
      // after its session ended; once the hidden runs are over the builder's own file is back.
      expect(read(join(clone, 'tests/emit-junit.mjs'))).toBe(sabotage)

      const [invocation] = jsonl(log)
      expect(jsonl(log)).toHaveLength(1)
      expect(invocation.cwd).toBe(clone)
      expect(flag(invocation.argv, '--tools')).toBe(BUILDER_TOOLS)
      expect(flag(invocation.argv, '--allowedTools')).toBe(BUILDER_TOOLS)
      expect(flag(invocation.argv, '--model')).toBe('fake-model')
      expect(flag(invocation.argv, '--max-turns')).toBe('300')
      expect(invocation.argv).not.toContain('--add-dir')
      expect(invocation.argv.join(' ')).not.toContain('Task')

      const [prompt] = jsonl(promptLog).map((p) => p.prompt)
      expect(prompt).toContain('committed in this repository at:\ndocs/spec.md\ndocs/z plan.md\n')
      expect(prompt).toContain(`Run the existing suite with: ${problem.test}`)
      expect(prompt).not.toContain('{{')

      expect(git(clone, 'log', '-1', '--format=%s')).toBe('spec bundle')
      expect(git(clone, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
        'docs/spec.md',
        'docs/z plan.md'
      ])

      // Setup ran in the build clone, and what it left is not part of the implementation.
      expect(existsSync(join(clone, 'setup-marker'))).toBe(true)
      const patch = read(join(unit, 'build/implementation.patch'))
      expect(patch).toContain('impl.txt')
      expect(patch).not.toContain('setup-marker')
      expect(patch).not.toContain('docs/spec.md')

      expect(read(join(unit, 'build/ASSUMPTIONS.md'))).toContain('1. first')
      expect(existsSync(join(unit, 'build/hidden-1.xml'))).toBe(true)
      expect(existsSync(join(unit, 'build/hidden-2.xml'))).toBe(true)
      expect(read(join(unit, 'build/existing-suite.txt'))).toContain('existing suite ran')
      expect(jsonl(join(unit, 'build/stream.jsonl')).some((e) => e.type === 'result')).toBe(true)
      expect(readdirSync(join(unit, 'transcripts/builder'))).toHaveLength(1)
    },
    SLOW_TEST_MS
  )

  it.each<[string, HiddenRun[]]>([
    ['missing', [{ xml: 'missing', exit: 1 }]],
    ['corrupt', [{ xml: 'corrupt', exit: 1 }]]
  ])(
    'a run whose JUnit XML is %s fails every test and none is flaky',
    async (_name, pristine) => {
      setScenario([{ reply: 'done' }])
      const result = await build(makeProblem({ pristine }), makeArtifact(SPEC))
      expect(result.hidden).toEqual({
        passed: 0,
        total: 3,
        flaky: [],
        failed: TEST_SET
      })
      expect(result.status).toBe('done')
    },
    SLOW_TEST_MS
  )

  it(
    'one unreadable run of two fails every test without calling any flaky',
    async () => {
      setScenario([{ reply: 'done' }])
      const result = await build(
        makeProblem({ pristine: [ALL_PASS, { xml: 'corrupt', exit: 1 }] }),
        makeArtifact(SPEC)
      )
      expect(result.hidden).toEqual({ passed: 0, total: 3, flaky: [], failed: TEST_SET })
    },
    SLOW_TEST_MS
  )

  it(
    'counts only the validated test set, and a validated test the run lost is failed',
    async () => {
      setScenario([{ reply: 'done' }])
      const result = await build(
        makeProblem({ pristine: [{ cases: { a: 'pass', b: 'pass', builderOwn: 'fail' } }] }),
        makeArtifact(SPEC)
      )
      expect(result.hidden).toEqual({
        passed: 2,
        total: 3,
        flaky: [],
        failed: ['hidden::c']
      })
    },
    SLOW_TEST_MS
  )

  it(
    'the existing suite never sees the hidden files, so a failing hidden test leaves it green',
    async () => {
      setScenario([{ reply: 'done' }])
      // Runs every file under `hidden.dest`: the copied hidden suite would make it exit 1.
      const collector =
        'for f in tests/*.mjs; do [ -e "$f" ] || continue; node "$f" || exit 1; done'
      const result = await build(
        makeProblem({
          pristine: [{ cases: { a: 'fail', b: 'pass', c: 'pass' } }],
          test: collector
        }),
        makeArtifact(SPEC)
      )
      expect(result.hidden).toMatchObject({ passed: 2, failed: ['hidden::a'] })
      expect(hiddenRuns('demo', 'pristine')).toBe(2)
      expect(result.existing).toEqual({ exitCode: 0 })
      expect(existsSync(join(unitDirOf(), 'build-clone/tests/emit-junit.mjs'))).toBe(false)
    },
    SLOW_TEST_MS
  )

  it(
    'records a failing existing suite and no assumptions when the file is absent',
    async () => {
      setScenario([{ reply: 'done' }])
      const result = await build(
        makeProblem({ pristine: [ALL_PASS], test: 'echo broken; exit 7' }),
        makeArtifact(SPEC)
      )
      expect(result.existing).toEqual({ exitCode: 7 })
      expect(result.assumptions).toBe(0)
      expect(existsSync(join(unitDirOf(), 'build/ASSUMPTIONS.md'))).toBe(false)
      expect(read(join(unitDirOf(), 'build/existing-suite.txt'))).toContain('broken')
    },
    SLOW_TEST_MS
  )

  it(
    'a builder session that errors still runs the hidden command, with status failed',
    async () => {
      setScenario([
        { noResult: true, writes: [{ path: 'ASSUMPTIONS.md', content: '1. partial\n' }] }
      ])
      const result = await build(makeProblem({ pristine: [ALL_PASS] }), makeArtifact(SPEC))
      expect(result).toMatchObject({
        status: 'failed',
        reason: null,
        hidden: { passed: 3, total: 3, flaky: [], failed: [] },
        assumptions: 1,
        usage: { total: 110 }
      })
      expect(hiddenRuns('demo', 'pristine')).toBe(2)
    },
    SLOW_TEST_MS
  )

  it(
    'a builder that hits its invocation deadline still runs the hidden command',
    async () => {
      // 90 min x 0.004 is a 21.6 s deadline; commands keep 3.6 s, plenty for a local git.
      vi.stubEnv('HARNU_BAKEOFF_TIMEOUT_SCALE', '0.004')
      setScenario([
        { hangMs: 90_000, reply: 'never', writes: [{ path: 'impl.txt', content: 'partial\n' }] }
      ])
      const result = await build(makeProblem({ pristine: [ALL_PASS] }), makeArtifact(SPEC))
      expect(result.status).toBe('failed')
      expect(result.hidden.passed).toBe(3)
      expect(read(join(unitDirOf(), 'build/implementation.patch'))).toContain('impl.txt')
    },
    SLOW_TEST_MS
  )

  it.each([
    ['an empty directory', (): string => makeArtifact({})],
    ['a missing directory', (): string => join(tmp, 'no-artifact')]
  ])(
    'an empty artifact runs no builder session and writes not-run (%s)',
    async (_name, artifact) => {
      setScenario([])
      const problem = makeProblem({ pristine: [ALL_PASS] })
      const result = await build(problem, artifact())
      expect(result).toMatchObject({
        status: 'not-run',
        reason: 'empty-artifact',
        hidden: { passed: 0, total: 3, flaky: [] },
        assumptions: 0
      })
      expect(result.usage.total).toBe(0)
      // A resume reruns only the units whose file is missing, so this one is done.
      expect(readJson(join(unitDirOf(), 'build.json'))).toEqual(result)
      expect(jsonl(log)).toEqual([])
      expect(hiddenRuns('demo', 'pristine')).toBe(0)
      expect(setupRuns()).toBe(0)
      expect(existsSync(join(unitDirOf(), 'build-clone'))).toBe(false)
    },
    SLOW_TEST_MS
  )

  it(
    'a setup that fails returns the coded error and writes no build.json',
    async () => {
      setScenario([])
      const result = await build(
        makeProblem({ pristine: [ALL_PASS], setup: ['exit 3'] }),
        makeArtifact(SPEC)
      )
      expect(result.code).toBe('SETUP_FAILED')
      expect(existsSync(join(unitDirOf(), 'build.json'))).toBe(false)
      expect(jsonl(log)).toEqual([])
    },
    SLOW_TEST_MS
  )

  it(
    'killAll discards the build, records its usage and leaves it to a resume',
    async () => {
      const { killAll, resetInterrupted } = await import('../scripts/eval/bakeoff/claude.mjs')
      const problem = makeProblem({ pristine: [ALL_PASS] })
      const artifact = makeArtifact(SPEC)
      setScenario([{ hangMs: 90_000, reply: 'never' }])

      const running = build(problem, artifact)
      await vi.waitFor(() => expect(jsonl(log)).toHaveLength(1), {
        timeout: 60_000,
        interval: 50
      })
      await killAll()
      const interrupted = await running

      const unit = unitDirOf()
      expect(interrupted).toEqual({ status: 'interrupted' })
      expect(existsSync(join(unit, 'build.json'))).toBe(false)
      expect(hiddenRuns('demo', 'pristine')).toBe(0)
      expect(readJson(join(unit, 'build/discarded.json'))).toEqual([
        {
          unit: 'demo/harnu-spec/r1/build',
          phase: 'build',
          contestant: 'harnu-spec',
          usage: expect.objectContaining({ total: 110 })
        }
      ])
      expect(readdirSync(join(unit, 'discarded/1/builder'))).toHaveLength(1)
      expect(existsSync(join(unit, 'transcripts/builder'))).toBe(false)

      // The resume starts over in the same unit directory and keeps the discarded usage.
      resetInterrupted()
      setScenario([{ reply: 'done' }])
      const resumed = await build(problem, artifact)
      expect(resumed.status).toBe('done')
      expect(resumed.usage.total).toBe(110)
      expect(readJson(join(unit, 'build/discarded.json'))).toHaveLength(1)
    },
    SLOW_TEST_MS
  )
})

describe('parseJunit', () => {
  const load = async (): Promise<Json> => import('../scripts/eval/bakeoff/junit.mjs')

  it('reads every status and names a test classname::name', async () => {
    const { parseJunit } = await load()
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- a comment with <testcase name="ghost"/> -->
<testsuites>
  <testsuite name="outer"><testsuite name="inner">
    <testcase classname="c" name="ok" time="0.1"/>
    <testcase classname="c" name="out"><system-out><![CDATA[</testcase><failure/>]]></system-out></testcase>
    <testcase classname="c" name="bad"><failure message="x">y</failure></testcase>
    <testcase classname="c" name="err"><error message="x"/></testcase>
    <testcase classname="c" name="skip"><skipped/></testcase>
    <testcase classname="a &amp; b" name='q "x" &lt;1&#62;'/>
  </testsuite></testsuite>
</testsuites>
`
    expect(parseJunit(xml)).toEqual({
      testcases: [
        { name: 'c::ok', status: 'passed' },
        { name: 'c::out', status: 'passed' },
        { name: 'c::bad', status: 'failed' },
        { name: 'c::err', status: 'error' },
        { name: 'c::skip', status: 'skipped' },
        { name: 'a & b::q "x" <1>', status: 'passed' }
      ]
    })
  })

  it('accepts a single testsuite root and a suite with no testcases', async () => {
    const { parseJunit } = await load()
    expect(parseJunit('<testsuite name="s" tests="0"></testsuite>')).toEqual({ testcases: [] })
    expect(parseJunit('\uFEFF<testsuites/>\n')).toEqual({ testcases: [] })
  })

  it.each([
    ['empty', ''],
    ['not XML', 'pytest: command not found'],
    ['truncated', '<testsuites><testsuite><testcase name="a"/>'],
    ['cut inside a tag', '<testsuites><testcase name="a'],
    ['mismatched tags', '<testsuites><testsuite></testsuites></testsuite>'],
    ['another root', '<html><testcase name="a"/></html>'],
    ['two roots', '<testsuites/><testsuites/>'],
    ['text after the root', '<testsuites/>trailing'],
    ['a testcase with no name', '<testsuites><testcase classname="c"/></testsuites>'],
    ['an unterminated comment', '<testsuites><!-- </testsuites>']
  ])('reports %s as JUNIT_CORRUPT', async (_name, xml) => {
    const { parseJunit } = await load()
    expect(parseJunit(xml)).toMatchObject({ code: 'JUNIT_CORRUPT' })
  })

  it('finds a collection failure by the message of an error child', async () => {
    const { hasCollectionError } = await load()
    const wrap = (inner: string): string =>
      `<testsuites><testcase classname="" name="t">${inner}</testcase></testsuites>`
    expect(hasCollectionError(wrap('<error message="Collection failure">trace</error>'))).toBe(true)
    expect(hasCollectionError(wrap('<error>error while collecting</error>'))).toBe(true)
    expect(hasCollectionError(wrap('<error><![CDATA[error while collecting]]></error>'))).toBe(true)
    // A traceback that merely imports `collections` is not a collection failure.
    expect(
      hasCollectionError(wrap('<error message="boom">from collections import x</error>'))
    ).toBe(false)
    expect(hasCollectionError(wrap('<failure message="collection"/>'))).toBe(false)
  })
})

const codes = (result: Json): string[] => result.defects.map((d: { code: string }) => d.code)

async function validate(problem: Json): Promise<Json> {
  const { validateProblem } = await import('../scripts/eval/bakeoff/validate.mjs')
  return validateProblem(problem, roots)
}

describe('validateProblem (AC-11)', () => {
  it(
    'accepts a suite that fails on pristine and passes on the reference',
    async () => {
      const problem = makeProblem(validPlan())
      const result = await validate(problem)
      expect(result).toMatchObject({ ok: true, testSet: TEST_SET, defects: [] })
      expect(result.key).toMatch(/^[0-9a-f]{64}$/)
      expect(hiddenRuns('demo', 'pristine')).toBe(1)
      expect(hiddenRuns('demo', 'fixed')).toBe(3)
      expect(readJson(join(roots.cache, 'validation', `${result.key}.json`))).toEqual(result)
      expect(readdirSync(join(roots.cache, 'validation'))).toEqual([`${result.key}.json`])
    },
    SLOW_TEST_MS
  )

  it(
    'validation rejects a passable-by-default or flaky suite',
    async () => {
      const passable = await validate(
        makeProblem({ id: 'passable', pristine: [ALL_PASS], fixed: [ALL_PASS] })
      )
      expect(passable.ok).toBe(false)
      expect(passable.testSet).toEqual([])
      expect(codes(passable)).toEqual(['PRISTINE_PASSES'])
      expect(passable.defects[0].tests).toEqual(TEST_SET)

      const flaky = await validate(
        makeProblem({
          id: 'flaky',
          pristine: validPlan().pristine,
          fixed: [ALL_PASS, ALL_PASS, { cases: { a: 'pass', b: 'fail', c: 'pass' } }]
        })
      )
      expect(flaky.ok).toBe(false)
      expect(flaky.testSet).toEqual([])
      expect(codes(flaky)).toEqual(['REFERENCE_FLAKY'])
      expect(flaky.defects[0].tests).toEqual(['hidden::b'])
      expect(hiddenRuns('flaky', 'fixed')).toBe(3)
    },
    SLOW_TEST_MS
  )

  it.each<[string, HiddenRun, string]>([
    ['missing JUnit XML', { xml: 'missing', exit: 1 }, 'PRISTINE_JUNIT_MISSING'],
    ['corrupt JUnit XML', { xml: 'corrupt', exit: 1 }, 'PRISTINE_JUNIT_CORRUPT'],
    ['zero testcases', { cases: {}, exit: 1 }, 'PRISTINE_NO_TESTCASES'],
    ['no failure testcase', { cases: { a: 'skip', b: 'pass' } }, 'PRISTINE_NO_FAILURE'],
    ['only error testcases', { cases: { a: 'error' } }, 'PRISTINE_NO_FAILURE'],
    [
      'a collection failure',
      { cases: { a: 'collect', b: 'fail' }, exit: 2 },
      'PRISTINE_COLLECTION_FAILURE'
    ]
  ])(
    'fails a pristine run with %s',
    async (_name, run, code) => {
      const result = await validate(makeProblem({ pristine: [run] }))
      expect(result.ok).toBe(false)
      expect(codes(result)).toEqual([code])
    },
    SLOW_TEST_MS
  )

  const GO_OUTPUT = './hidden_test.go:4:2: undefined: NewThing\nFAIL\texample [build failed]\n'

  it(
    'a compile failure that matches the pattern passes the pristine check with no XML',
    async () => {
      const result = await validate(
        makeProblem({
          pristine: [{ xml: 'missing', exit: 1, stdout: GO_OUTPUT }],
          compileErrorPattern: 'undefined: |build failed'
        })
      )
      expect(result).toMatchObject({ ok: true, testSet: TEST_SET, defects: [] })
    },
    SLOW_TEST_MS
  )

  it(
    'the same compile output fails the check when the pattern does not match',
    async () => {
      const result = await validate(
        makeProblem({
          pristine: [{ xml: 'missing', exit: 1, stdout: GO_OUTPUT }],
          compileErrorPattern: 'SyntaxError'
        })
      )
      expect(result.ok).toBe(false)
      expect(codes(result)).toEqual(['PRISTINE_JUNIT_MISSING'])
    },
    SLOW_TEST_MS
  )

  it(
    'a matching pattern does not excuse a run that exits zero',
    async () => {
      const result = await validate(
        makeProblem({
          pristine: [{ xml: 'missing', exit: 0, stdout: GO_OUTPUT }],
          compileErrorPattern: 'undefined: '
        })
      )
      expect(codes(result)).toEqual(['PRISTINE_JUNIT_MISSING'])
    },
    SLOW_TEST_MS
  )

  it(
    'a matching pattern does not excuse a run that reported passing testcases',
    async () => {
      const result = await validate(
        makeProblem({
          pristine: [{ ...ALL_PASS, exit: 1, stdout: GO_OUTPUT }],
          fixed: [ALL_PASS],
          compileErrorPattern: 'undefined: '
        })
      )
      expect(codes(result)).toEqual(['PRISTINE_PASSES'])
    },
    SLOW_TEST_MS
  )

  it(
    'a matching pattern does not excuse a collection failure reported as a testcase',
    async () => {
      const result = await validate(
        makeProblem({
          pristine: [{ cases: { a: 'collect' }, exit: 2, stdout: 'ImportError: no module\n' }],
          compileErrorPattern: 'ImportError'
        })
      )
      expect(codes(result)).toEqual(['PRISTINE_COLLECTION_FAILURE'])
    },
    SLOW_TEST_MS
  )

  it.each<[string, HiddenRun[], string, string[]]>([
    [
      'a test that fails on every run',
      [{ cases: { a: 'fail', b: 'pass', c: 'pass' } }],
      'REFERENCE_FAILED',
      ['hidden::a']
    ],
    [
      'a skipped test',
      [{ cases: { a: 'skip', b: 'pass', c: 'pass' } }],
      'REFERENCE_FAILED',
      ['hidden::a']
    ],
    [
      'a test that vanishes on one run',
      [ALL_PASS, { cases: { a: 'pass', b: 'pass' } }, ALL_PASS],
      'REFERENCE_FLAKY',
      ['hidden::c']
    ],
    ['missing XML', [ALL_PASS, { xml: 'missing', exit: 1 }], 'REFERENCE_JUNIT_MISSING', []],
    ['corrupt XML', [{ xml: 'corrupt', exit: 1 }], 'REFERENCE_JUNIT_CORRUPT', []],
    ['zero testcases', [{ cases: {} }], 'REFERENCE_NO_TESTCASES', []]
  ])(
    'fails a reference run with %s',
    async (_name, fixed, code, tests) => {
      const result = await validate(makeProblem({ pristine: validPlan().pristine, fixed }))
      expect(result.ok).toBe(false)
      expect(codes(result)).toEqual([code])
      expect(result.defects[0].tests ?? []).toEqual(tests)
      expect(result.testSet).toEqual([])
    },
    SLOW_TEST_MS
  )

  it(
    'fails a problem whose existing suite fails on the reference',
    async () => {
      const result = await validate(makeProblem({ ...validPlan(), test: 'exit 4' }))
      expect(result.ok).toBe(false)
      expect(codes(result)).toEqual(['EXISTING_SUITE_FAILED'])
      expect(result.testSet).toEqual([])
    },
    SLOW_TEST_MS
  )

  it(
    'fails a problem whose reference patch does not apply',
    async () => {
      const problem = makeProblem(validPlan())
      writeFileSync(join(problem.dir, 'hidden/reference.patch'), 'not a patch\n')
      const result = await validate(problem)
      expect(result.ok).toBe(false)
      expect(codes(result)).toEqual(['REFERENCE_PATCH_FAILED'])
    },
    SLOW_TEST_MS
  )

  it(
    'fails a problem whose setup exits non-zero, without running its suite',
    async () => {
      const result = await validate(makeProblem({ ...validPlan(), setup: ['exit 9'] }))
      expect(result.ok).toBe(false)
      expect(codes(result)).toEqual(['SETUP_FAILED'])
      expect(hiddenRuns('demo', 'pristine')).toBe(0)
    },
    SLOW_TEST_MS
  )

  it.each<[string, Partial<ProblemOptions>, string]>([
    ['setup', { setup: ['sleep 30'] }, 'SETUP_TIMEOUT'],
    ['test', { test: 'sleep 30' }, 'TEST_TIMEOUT']
  ])(
    'fails a problem whose %s reaches the validation limit',
    async (_name, options, code) => {
      // 5 min x 0.02 is 6 s, against 18 s for the git and hidden commands.
      vi.stubEnv('HARNU_BAKEOFF_TIMEOUT_SCALE', '0.02')
      const started = Date.now()
      const result = await validate(makeProblem({ ...validPlan(), ...options }))
      expect(result.ok).toBe(false)
      expect(codes(result)).toEqual([code])
      expect(Date.now() - started).toBeLessThan(25_000)
    },
    SLOW_TEST_MS
  )

  it(
    'with an unchanged key runs no command; a problem file or the versions output reruns it',
    async () => {
      const versionFile = join(tmp, 'version.txt')
      writeFileSync(versionFile, '1.0\n')
      const problem = makeProblem({ ...validPlan(), versions: `cat ${versionFile}` })
      const ran = (): number[] => [setupRuns(), hiddenRuns('demo', 'pristine')]

      const first = await validate(problem)
      expect(first.ok).toBe(true)
      expect(ran()).toEqual([2, 1])

      expect(await validate(problem)).toEqual(first)
      expect(ran()).toEqual([2, 1])

      // `review` writes only `provenance`: neither the hash nor the key moves.
      const stamped = readJson(join(problem.dir, 'problem.json'))
      stamped.provenance.reviewedAt = '2026-11-09T12:00:00.000Z'
      stamped.provenance.reviewedBy = 'someone'
      writeFileSync(join(problem.dir, 'problem.json'), `${JSON.stringify(stamped, null, 2)}\n`)
      expect(await validate({ ...stamped, dir: problem.dir })).toEqual(first)
      expect(ran()).toEqual([2, 1])

      writeFileSync(join(problem.dir, 'request.md'), 'A changed request.\n')
      const changedFile = await validate(problem)
      expect(changedFile.key).not.toBe(first.key)
      expect(ran()).toEqual([4, 2])

      writeFileSync(versionFile, '2.0\n')
      const changedVersions = await validate(problem)
      expect(changedVersions.key).not.toBe(changedFile.key)
      expect(ran()).toEqual([6, 3])
    },
    SLOW_TEST_MS
  )

  it(
    'caches a failed validation too',
    async () => {
      const problem = makeProblem({ pristine: [ALL_PASS], fixed: [ALL_PASS] })
      const first = await validate(problem)
      expect(first.ok).toBe(false)
      expect(await validate(problem)).toEqual(first)
      expect(hiddenRuns('demo', 'pristine')).toBe(1)
    },
    SLOW_TEST_MS
  )

  it(
    'a holdout problem is cached under the work root',
    async () => {
      const problem = makeProblem({
        ...validPlan(),
        id: 'secret',
        split: 'holdout',
        root: roots.holdout
      })
      const result = await validate(problem)
      expect(existsSync(join(roots.work, 'validation', `${result.key}.json`))).toBe(true)
      expect(existsSync(join(roots.cache, 'validation'))).toBe(false)
    },
    SLOW_TEST_MS
  )
})

describe('validateCommand (AC-11)', () => {
  function context(): Json {
    const out = { stdout: '', stderr: '' }
    return {
      out,
      ctx: {
        roots,
        models: {},
        stdin: null,
        env: {},
        stdout: { write: (text: string) => (out.stdout += text) },
        stderr: { write: (text: string) => (out.stderr += text) }
      }
    }
  }

  const devRoot = (): string => join(roots.repo, 'scripts/eval/bakeoff/corpus/dev')

  async function command(args: Json, ctx: Json): Promise<Json> {
    const { validateCommand } = await import('../scripts/eval/bakeoff/validate.mjs')
    return validateCommand({ positional: [], ...args }, ctx)
  }

  it(
    'on a dev problem names the problem and the tests',
    async () => {
      makeProblem({ id: 'good-one', root: devRoot(), ...validPlan() })
      makeProblem({
        id: 'bad-one',
        root: devRoot(),
        pristine: [ALL_PASS],
        fixed: [ALL_PASS]
      })
      const { out, ctx } = context()
      const code = await command({ split: 'dev' }, ctx)
      expect(code).toBe(2)
      expect(out.stderr).toContain('bad-one')
      expect(out.stderr).toContain('hidden::a')
      expect(out.stderr).toContain('PRISTINE_PASSES')
      expect(out.stderr).toContain(`details in ${join(roots.cache, 'validation')}`)
      expect(out.stdout).toContain('good-one')
    },
    SLOW_TEST_MS
  )

  it(
    'on a passing dev corpus exits 0, and --problems selects',
    async () => {
      makeProblem({ id: 'good-one', root: devRoot(), ...validPlan() })
      makeProblem({ id: 'other', root: devRoot(), pristine: [ALL_PASS], fixed: [ALL_PASS] })
      const { ctx } = context()
      expect(await command({ split: 'dev', problems: 'good-one' }, ctx)).toBe(0)
      expect(hiddenRuns('other', 'pristine')).toBe(0)
      const unknown = await command({ split: 'dev', problems: ['nope'] }, ctx)
      expect(unknown).toMatchObject({ code: 'PROBLEM_UNKNOWN' })
    },
    SLOW_TEST_MS
  )

  it(
    'on a holdout problem shows only a count and writes the details under the work root',
    async () => {
      makeProblem({ id: 'hold-good', split: 'holdout', root: roots.holdout, ...validPlan() })
      const bad = makeProblem({
        id: 'hold-bad',
        split: 'holdout',
        root: roots.holdout,
        pristine: [ALL_PASS],
        fixed: [ALL_PASS]
      })
      const { out, ctx } = context()
      const code = await command({ split: 'holdout' }, ctx)
      expect(code).toBe(2)
      const terminal = out.stdout + out.stderr
      expect(terminal).toContain('1 of 2 holdout problems failed validation')
      for (const secret of ['hold-bad', 'hold-good', 'hidden::', 'PRISTINE_PASSES', bad.dir]) {
        expect(terminal).not.toContain(secret)
      }
      const details = readdirSync(join(roots.work, 'validation')).map((name) =>
        readJson(join(roots.work, 'validation', name))
      )
      const failed = details.filter((d) => !d.ok)
      expect(failed).toHaveLength(1)
      expect(failed[0].defects[0].tests).toEqual(TEST_SET)
    },
    SLOW_TEST_MS
  )

  it(
    'a holdout problem the loader refuses is only counted',
    async () => {
      const broken = makeProblem({
        id: 'hold-broken',
        split: 'holdout',
        root: roots.holdout,
        ...validPlan()
      })
      rmSync(join(broken.dir, 'request.md'))
      const { out, ctx } = context()
      expect(await command({ split: 'holdout' }, ctx)).toBe(2)
      const terminal = out.stdout + out.stderr
      expect(terminal).toContain('1 of 1 holdout problems failed validation')
      expect(terminal).not.toContain('hold-broken')
      expect(terminal).not.toContain('request.md')
    },
    SLOW_TEST_MS
  )

  it('refuses --problems on the holdout before any work', async () => {
    const { ctx } = context()
    expect(await command({ split: 'holdout', problems: 'x' }, ctx)).toMatchObject({
      code: 'PROBLEMS_ON_HOLDOUT'
    })
  })

  it(
    'names a problem the dev loader refuses',
    async () => {
      const broken = makeProblem({ id: 'dev-broken', root: devRoot(), ...validPlan() })
      rmSync(join(broken.dir, 'request.md'))
      const { out, ctx } = context()
      expect(await command({ split: 'dev' }, ctx)).toBe(2)
      expect(out.stderr).toContain('dev-broken')
      expect(out.stderr).toContain('request.md')
    },
    SLOW_TEST_MS
  )
})
