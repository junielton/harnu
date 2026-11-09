/**
 * T676 S-3 — the bake-off's judges: `scripts/eval/bakeoff/{anonymize,judge}.mjs` against the fake
 * `claude` in `tests/fixtures/eval-bakeoff/fake-claude.mjs`. No model is ever called.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  existsSync,
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
import { dirname, join, resolve } from 'node:path'

const FAKE = resolve(__dirname, 'fixtures/eval-bakeoff/fake-claude.mjs')
const LISTING_FAKE = resolve(__dirname, 'fixtures/eval-bakeoff/s3/listing-claude.mjs')
const PROBLEM_DIR = resolve(__dirname, 'fixtures/eval-bakeoff/s3/problem')
const SCORE_SHEET = resolve(__dirname, '../scripts/eval/bakeoff/prompts/score-sheet.md')
const S10_SCORE_SHEET = resolve(
  __dirname,
  '../docs/specs/2026-11-harnu-spec/bakeoff/judges/score-sheet.md'
)
const PROBLEM = { id: 'fixture-problem', dir: PROBLEM_DIR }
const ROUND_ID = 'round-20261109-1900'
const SLOW_TEST_MS = 120_000

const ALL_IDS = ['harnu-spec', 'superpowers', 'tlc-spec-driven']
const HARNU_TELLS = ['harnu:spec', 'harnu', 'Goldfish', 'Elephant']
const SUPERPOWERS_TELLS = ['superpowers', 'brainstorming', 'writing-plans']
const TLC_TELLS = ['tlc-spec-driven', 'tlc']
const ALL_TELLS = [...HARNU_TELLS, ...SUPERPOWERS_TELLS, ...TLC_TELLS]
const ANY_TELL = /harnu|goldfish|elephant|superpowers|brainstorming|writing-plans|tlc-spec|\btlc\b/i
const ZERO_USAGE = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 }
const ONE_MESSAGE = { input: 100, cacheWrite: 0, cacheRead: 0, output: 10, total: 110 }

/** Parsed JSON: the shapes under test are asserted field by field below. */
type Json = ReturnType<typeof JSON.parse>

/** One scripted invocation of the fake `claude`. */
interface Entry {
  reply?: string
  noResult?: boolean
  hangMs?: number
}

interface Invocation {
  cwd: string
  argv: string[]
}

/** Exact bytes, so the front matter and line-ending cases stay what they claim to be. */
const ARTIFACT: Record<string, string> = {
  'a-first.md': 'Plain first file.\n',
  'atlc-lib/notes.md': 'Text\n---\nA rule below line one stays, and atlc-lib keeps its name.\n',
  'b-no-newline.md': 'no trailing newline',
  'docs/alpha.md': 'Sorted by its real path.\n',
  'docs/harnu/tlc-plan.md': 'The plan.\n',
  'docs/spec.md': [
    '---',
    'name: harnu:spec',
    'tool: Goldfish',
    '---',
    '',
    '# Spec written with Harnu',
    '',
    'The HARNU:SPEC method, the goldfish rule, the ELEPHANT note.',
    'Brainstorming found nothing. Writing-Plans came next. SuperPowers again.',
    'TLC says tlc-spec-driven and TLC-SPEC-DRIVEN.',
    ''
  ].join('\n'),
  'unclosed.md': '---\nNo closing line, so nothing is stripped.\n',
  'win.md': '---\r\ntitle: CRLF\r\n---\r\nBody after a CRLF front matter.\r\n'
}

const ALL_TELLS_BUNDLE = [
  '=== file: a-first.md ===\nPlain first file.\n',
  '=== file: atlc-lib/notes.md ===\nText\n---\nA rule below line one stays, and atlc-lib keeps its name.\n',
  '=== file: b-no-newline.md ===\nno trailing newline\n',
  '=== file: docs/alpha.md ===\nSorted by its real path.\n',
  '=== file: docs/[tool]/[tool]-plan.md ===\nThe plan.\n',
  [
    '=== file: docs/spec.md ===',
    '',
    '# Spec written with [tool]',
    '',
    'The [tool] method, the [tool] rule, the [tool] note.',
    '[tool] found nothing. [tool] came next. [tool] again.',
    '[tool] says [tool] and [tool].',
    ''
  ].join('\n'),
  '=== file: unclosed.md ===\n---\nNo closing line, so nothing is stripped.\n',
  '=== file: win.md ===\nBody after a CRLF front matter.\r\n'
].join('\n')

let tmp: string
let projects: string
let log: string
let promptLog: string
let scenarioPath: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bakeoff-s3-')))
  projects = join(tmp, 'projects')
  log = join(tmp, 'invocations.jsonl')
  promptLog = join(tmp, 'prompts.jsonl')
  scenarioPath = join(tmp, 'scenario.json')
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

/** Scripts the next invocations, restarting the fake's cursor. */
function setScenario(entries: Entry[]): void {
  writeFileSync(scenarioPath, JSON.stringify(entries))
  rmSync(join(projects, '.fake-claude-cursor'), { force: true })
}

function jsonLines(path: string): Json[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const invocations = (): Invocation[] => jsonLines(log)
const prompts = (): string[] => jsonLines(promptLog).map((line) => line.prompt)

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'))

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

/** Where the spec puts a round's units, under a work root that is `tmp` here. */
const unitsRoot = (): string => join(tmp, 'rounds', ROUND_ID, 'units')

/** The arguments of `runJudge` for one unit, with its artifact on disk. */
function judgeArgs(overrides: Json = {}, files: Record<string, string> = ARTIFACT): Json {
  const contestant = overrides.contestant ?? { id: 'harnu-spec' }
  const repeat = overrides.repeat ?? 1
  const unitDir = join(unitsRoot(), PROBLEM.id, contestant.id, `r${repeat}`)
  const artifactDir = join(unitDir, 'artifact')
  writeTree(artifactDir, files)
  return {
    problem: PROBLEM,
    contestant,
    repeat,
    n: 1,
    unitDir,
    artifactDir,
    tells: ALL_TELLS,
    seed: 'seed-a',
    contestantIds: ALL_IDS,
    model: 'judge-model-id',
    ...overrides
  }
}

function replyBody(label: string, overrides: Json = {}): Json {
  return {
    spec: label,
    atoms: { 'R-1': 'covered', 'R-2': 'partial', 'O-1': 'contradicted', 'X-9': 'covered' },
    decisions_left: ['first decision', 'second decision'],
    contradictions: ['a vs b'],
    acceptance_criteria: { total: 4, executable: 3 },
    builder_guesses: ['a guess'],
    notes: 'Short.',
    ...overrides
  }
}

const fenced = (body: Json): string => '```json\n' + JSON.stringify(body, null, 2) + '\n```'
const validReply = (label: string, overrides: Json = {}): string =>
  `Scored below.\n\n${fenced(replyBody(label, overrides))}\n`

const SCORES = {
  coverage: 1.5,
  coverageMax: 4,
  decisionsLeft: 2,
  contradictions: 1,
  acTotal: 4,
  acExecutable: 3,
  builderGuesses: 1
}

it(
  'bundles carry no tell of any contestant and labels follow the seed',
  async () => {
    const { buildBundle, assignLabels } = await import('../scripts/eval/bakeoff/anonymize.mjs')
    const { runJudge } = await import('../scripts/eval/bakeoff/judge.mjs')

    const artifactDir = join(tmp, 'artifact')
    writeTree(artifactDir, ARTIFACT)

    // Sorted by the real path, headers included, every front matter gone, every tell replaced.
    const bundle = buildBundle(artifactDir, ALL_TELLS)
    expect(bundle).toBe(ALL_TELLS_BUNDLE)
    const withoutInnocentWord = bundle.replaceAll('atlc-lib', '')
    expect(withoutInnocentWord).not.toMatch(ANY_TELL)
    expect(bundle).toContain('atlc-lib')

    // A tell of a contestant not in the round stays; the selected ones still go.
    const twoContestants = buildBundle(artifactDir, [...HARNU_TELLS, ...SUPERPOWERS_TELLS])
    expect(twoContestants).toContain('=== file: docs/[tool]/tlc-plan.md ===')
    expect(twoContestants).toContain('TLC says tlc-spec-driven and TLC-SPEC-DRIVEN.')
    expect(twoContestants).not.toMatch(/harnu|goldfish|elephant|superpowers|brainstorming/i)

    // The tells are matched longest first: `harnu:spec` is one replacement, not `[tool]:spec`.
    expect(bundle).not.toContain('[tool]:spec')
    expect(bundle).not.toContain('[tool]-spec-driven')
    expect(buildBundle(artifactDir, [...ALL_TELLS].reverse())).toBe(ALL_TELLS_BUNDLE)

    // Pinned from an independent implementation of Judging's shuffle.
    expect(assignLabels('seed-a', PROBLEM.id, 1, ALL_IDS)).toEqual({
      P: 'tlc-spec-driven',
      Q: 'superpowers',
      R: 'harnu-spec'
    })
    expect(assignLabels('seed-b', PROBLEM.id, 1, ALL_IDS)).toEqual({
      P: 'harnu-spec',
      Q: 'superpowers',
      R: 'tlc-spec-driven'
    })
    expect(assignLabels('seed-a', PROBLEM.id, 2, ALL_IDS)).toEqual({
      P: 'harnu-spec',
      Q: 'tlc-spec-driven',
      R: 'superpowers'
    })
    expect(assignLabels('seed-a', PROBLEM.id, 1, ALL_IDS.slice(0, 2))).toEqual({
      P: 'superpowers',
      Q: 'harnu-spec'
    })
    // The ids are sorted first, so the order they arrive in cannot change the outcome.
    expect(assignLabels('seed-a', PROBLEM.id, 1, [...ALL_IDS].reverse())).toEqual(
      assignLabels('seed-a', PROBLEM.id, 1, ALL_IDS)
    )

    // The label names the bundle in the judge's output and the private mapping.
    setScenario([{ reply: validReply('R') }, { reply: validReply('R') }])
    const args = judgeArgs()
    const first = await runJudge(args)
    const second = await runJudge({ ...args, n: 2 })
    expect(first.label).toBe('R')
    expect(second.label).toBe('R')
    const bundleFile = readFileSync(join(args.unitDir, 'judge-1/bundle.md'), 'utf8')
    expect(bundleFile).toBe(`Bundle label: R\n${ALL_TELLS_BUNDLE}`)
    const labelsPath = join(unitsRoot(), PROBLEM.id, 'labels-r1.json')
    const labelsBytes = readFileSync(labelsPath, 'utf8')
    expect(JSON.parse(labelsBytes)).toEqual(assignLabels('seed-a', PROBLEM.id, 1, ALL_IDS))
    expect(readdirSync(dirname(labelsPath)).filter((f) => f.includes('.tmp'))).toEqual([])

    // A sibling contestant of the same repeat gets its own label and the same bytes.
    setScenario([{ reply: validReply('P') }])
    const sibling = await runJudge(judgeArgs({ contestant: { id: 'tlc-spec-driven' } }))
    expect(sibling.label).toBe('P')
    expect(readFileSync(labelsPath, 'utf8')).toBe(labelsBytes)
  },
  SLOW_TEST_MS
)

it(
  'judges score blind and a broken reply is not-run',
  async () => {
    const { runJudge } = await import('../scripts/eval/bakeoff/judge.mjs')
    setScenario([
      { reply: validReply('R') },
      { reply: 'I liked it.' },
      { reply: 'Still no block.' },
      { reply: 'Not this time.' },
      { reply: validReply('R') }
    ])
    const args = judgeArgs()

    // A clean judge: fresh session, no tools, the judge model, and the prompt in order.
    const good = await runJudge(args)
    expect(good).toEqual({
      status: 'done',
      reason: null,
      label: 'R',
      raw: validReply('R'),
      parsed: replyBody('R'),
      scores: SCORES,
      usage: ONE_MESSAGE
    })
    expect(readJson(join(args.unitDir, 'judge-1.json'))).toEqual(good)

    const [first] = invocations()
    expect(dirname(realpathSync(dirname(first.cwd)))).toBe(tmp)
    expect(flag(first.argv, '--model')).toBe('judge-model-id')
    expect(flag(first.argv, '--max-turns')).toBe('2')
    expect(flag(first.argv, '--tools')).toBe('')
    expect(first.argv).not.toContain('--allowedTools')
    expect(first.argv).not.toContain('--add-dir')
    expect(first.argv).not.toContain('--resume')
    const firstSession = flag(first.argv, '--session-id') as string
    expect(firstSession).toMatch(/^[0-9a-f-]{36}$/)
    expect(readdirSync(join(args.unitDir, 'judge-1'))).toEqual(['bundle.md'])
    expect(existsSync(join(args.unitDir, `transcripts/judge-1/${firstSession}.jsonl`))).toBe(true)
    expect(existsSync(join(args.unitDir, 'judge-1.stream.jsonl'))).toBe(true)

    const sheet = readFileSync(SCORE_SHEET, 'utf8').trim()
    const atoms = readFileSync(join(PROBLEM_DIR, 'hidden/atoms.md'), 'utf8').trim()
    const bundle = readFileSync(join(args.unitDir, 'judge-1/bundle.md'), 'utf8').trim()
    const [prompt] = prompts()
    expect(prompt).toBe(`${sheet}\n\n${atoms}\n\n${bundle}`)
    expect(prompt.indexOf('# Judge score sheet')).toBe(0)
    expect(prompt.indexOf('| id ')).toBeGreaterThan(prompt.indexOf('## Output'))
    expect(prompt.indexOf('Bundle label: R')).toBeGreaterThan(prompt.indexOf('| O-2'))
    expect(prompt).not.toContain(tmp)
    expect(prompt.replaceAll('atlc-lib', '')).not.toMatch(ANY_TELL)

    // A reply with no valid block is retried once in a fresh session, then recorded not-run.
    const broken = await runJudge({ ...args, n: 2 })
    expect(broken).toEqual({
      status: 'not-run',
      reason: 'invalid-reply',
      label: 'R',
      raw: 'Still no block.',
      parsed: null,
      scores: null,
      usage: ONE_MESSAGE
    })
    expect(readJson(join(args.unitDir, 'judge-2.json'))).toEqual(broken)
    const [, attemptOne, attemptTwo] = invocations()
    const discardedSession = flag(attemptOne.argv, '--session-id') as string
    const keptSession = flag(attemptTwo.argv, '--session-id') as string
    expect(discardedSession).not.toBe(keptSession)
    expect(attemptTwo.argv).not.toContain('--resume')
    expect(readdirSync(join(args.unitDir, 'judge-2')).sort()).toEqual([
      'bundle.md',
      'discarded.json'
    ])
    expect(readJson(join(args.unitDir, 'judge-2/discarded.json'))).toEqual([
      {
        unit: 'fixture-problem/harnu-spec/r1/judge-2',
        phase: 'judge',
        contestant: 'harnu-spec',
        usage: ONE_MESSAGE
      }
    ])
    expect(existsSync(join(args.unitDir, `discarded/1/judge-2/${discardedSession}.jsonl`))).toBe(
      true
    )
    expect(existsSync(join(args.unitDir, 'discarded/1/judge-2.stream.jsonl'))).toBe(true)
    expect(readdirSync(join(args.unitDir, 'transcripts/judge-2'))).toEqual([`${keptSession}.jsonl`])

    // One bad reply followed by a good one is a done judge, its first attempt still spent.
    const recovered = await runJudge({ ...args, n: 3 })
    expect(recovered).toMatchObject({ status: 'done', reason: null, scores: SCORES })
    expect(recovered.usage).toEqual(ONE_MESSAGE)
    expect(readJson(join(args.unitDir, 'judge-3/discarded.json'))).toHaveLength(1)
    expect(invocations()).toHaveLength(5)

    // An empty artifact runs no session, is not-run, and counts coverage 0 with the rest n/a.
    const emptyArgs = judgeArgs({ contestant: { id: 'superpowers' } }, {})
    mkdirSync(emptyArgs.artifactDir, { recursive: true })
    const empty = await runJudge(emptyArgs)
    expect(empty).toEqual({
      status: 'not-run',
      reason: 'empty-artifact',
      label: 'Q',
      raw: null,
      parsed: null,
      scores: {
        coverage: 0,
        coverageMax: 4,
        decisionsLeft: null,
        contradictions: null,
        acTotal: null,
        acExecutable: null,
        builderGuesses: null
      },
      usage: ZERO_USAGE
    })
    expect(readJson(join(emptyArgs.unitDir, 'judge-1.json'))).toEqual(empty)
    expect(invocations()).toHaveLength(5)
    expect(existsSync(join(emptyArgs.unitDir, 'judge-1/bundle.md'))).toBe(false)

    // A missing artifact directory is the same empty artifact.
    const missingArgs = judgeArgs({ contestant: { id: 'tlc-spec-driven' }, repeat: 2 }, {})
    expect((await runJudge(missingArgs)).reason).toBe('empty-artifact')
  },
  SLOW_TEST_MS
)

it(
  'each judge session runs in a neutral directory holding the bundle alone',
  async () => {
    const listings = join(tmp, 'listings.jsonl')
    vi.stubEnv('HARNU_BAKEOFF_CLAUDE_BIN', LISTING_FAKE)
    vi.stubEnv('S3_LISTING_LOG', listings)
    const { runJudge } = await import('../scripts/eval/bakeoff/judge.mjs')
    setScenario([{ reply: validReply('R') }, { reply: 'broken' }, { reply: validReply('R') }])
    const args = judgeArgs()

    await runJudge(args)
    await runJudge({ ...args, n: 2 })

    const seen = invocations()
    expect(seen).toHaveLength(3)
    for (const { cwd } of seen) {
      for (const id of ALL_IDS) expect(cwd).not.toContain(id)
      expect(cwd).not.toContain(PROBLEM.id)
      expect(cwd).not.toContain(ROUND_ID)
      expect(cwd).toMatch(new RegExp(`^${tmp}/judge-cwd/[0-9a-f-]{36}$`))
    }
    expect(new Set(seen.map((i) => i.cwd)).size).toBe(3)

    const held = jsonLines(listings)
    const expected = readFileSync(join(args.unitDir, 'judge-1/bundle.md'), 'utf8')
    expect(held.map((l) => l.files)).toEqual([['bundle.md'], ['bundle.md'], ['bundle.md']])
    expect(held.map((l) => l.bundle)).toEqual([expected, expected, expected])

    // Removed after each session; every result still lands under the unit.
    expect(readdirSync(join(tmp, 'judge-cwd'))).toEqual([])
    expect(existsSync(join(args.unitDir, 'judge-1.json'))).toBe(true)
    expect(readdirSync(join(args.unitDir, 'judge-1'))).toEqual(['bundle.md'])
    expect(readdirSync(join(args.unitDir, 'transcripts/judge-1'))).toHaveLength(1)
    expect(readJson(join(args.unitDir, 'judge-2/discarded.json'))).toHaveLength(1)
    expect(readdirSync(join(args.unitDir, 'discarded/1/judge-2'))).toHaveLength(1)
  },
  SLOW_TEST_MS
)

it(
  'a reply counts only by the schema of Judging',
  async () => {
    const { runJudge } = await import('../scripts/eval/bakeoff/judge.mjs')
    const body = (overrides: Json): string => `${fenced(replyBody('R', overrides))}\n`
    const invalid: [string, Entry][] = [
      ['JSON with no fence', { reply: JSON.stringify(replyBody('R')) }],
      ['a fence of another language', { reply: fenced(replyBody('R')).replace('json', 'js') }],
      ['malformed JSON', { reply: '```json\n{ "spec": \n```\n' }],
      ['an array', { reply: '```json\n[]\n```\n' }],
      ['an unterminated fence', { reply: '```json\n{}\n' }],
      ['two blocks', { reply: `${fenced(replyBody('R'))}\n${fenced(replyBody('R'))}\n` }],
      ['text after the block', { reply: `${fenced(replyBody('R'))}\nOne more thing.\n` }],
      ['a label of another bundle', { reply: body({ spec: 'P' }) }],
      ['an unknown verdict', { reply: body({ atoms: { 'R-1': 'mostly' } }) }],
      ['a bad verdict on an unknown id', { reply: body({ atoms: { 'X-9': 'mostly' } }) }],
      ['atoms that are a list', { reply: body({ atoms: ['covered'] }) }],
      ['decisions that are not a list', { reply: body({ decisions_left: 'none' }) }],
      ['a contradiction that is not a string', { reply: body({ contradictions: [1] }) }],
      ['guesses that are not strings', { reply: body({ builder_guesses: [null] }) }],
      [
        'a fractional total',
        { reply: body({ acceptance_criteria: { total: 1.5, executable: 1 } }) }
      ],
      [
        'more executable than total',
        { reply: body({ acceptance_criteria: { total: 1, executable: 2 } }) }
      ],
      [
        'a negative executable',
        { reply: body({ acceptance_criteria: { total: 1, executable: -1 } }) }
      ],
      ['no acceptance criteria', { reply: body({ acceptance_criteria: undefined }) }],
      ['no notes', { reply: body({ notes: undefined }) }],
      ['no result event', { noResult: true, reply: fenced(replyBody('R')) }]
    ]
    const args = judgeArgs()
    let n = 0
    for (const [name, entry] of invalid) {
      n += 1
      setScenario([entry, { reply: validReply('R') }])
      const before = invocations().length
      const result = await runJudge({ ...args, n })
      expect(invocations().length - before, name).toBe(2)
      expect(result.status, name).toBe('done')
      expect(readJson(join(args.unitDir, `judge-${n}/discarded.json`)), name).toHaveLength(1)
    }

    const valid: [string, string][] = [
      ['a block alone', `${fenced(replyBody('R'))}\n`],
      ['trailing blank lines', `${fenced(replyBody('R'))}\n\n  \n`],
      ['backticks inside a string', `${fenced(replyBody('R', { notes: 'See ``` here.' }))}\n`],
      ['another fence before it', '```text\nscratch\n```\n\n' + `${fenced(replyBody('R'))}\n`],
      ['an empty atoms object', `${fenced(replyBody('R', { atoms: {} }))}\n`]
    ]
    for (const [name, reply] of valid) {
      n += 1
      setScenario([{ reply }])
      const before = invocations().length
      const result = await runJudge({ ...args, n })
      expect(invocations().length - before, name).toBe(1)
      expect(result.status, name).toBe('done')
    }
  },
  SLOW_TEST_MS
)

it('scores count every atom id, covered 1, partial 0.5, anything else 0', async () => {
  const { scoreReply } = await import('../scripts/eval/bakeoff/judge.mjs')
  const parsed = replyBody('P', {
    atoms: {
      'R-1': 'partial',
      'R-2': 'partial',
      'R-3': 'missing',
      'R-4': 'contradicted',
      'Z-1': 'covered'
    }
  })
  expect(scoreReply(parsed, ['R-1', 'R-2', 'R-3', 'R-4', 'R-5'])).toEqual({
    coverage: 1,
    coverageMax: 5,
    decisionsLeft: 2,
    contradictions: 1,
    acTotal: 4,
    acExecutable: 3,
    builderGuesses: 1
  })
})

it('the score sheet is the S-10 sheet with its one edit', () => {
  const source = readFileSync(S10_SCORE_SHEET, 'utf8')
  const from = 'For every atom in `atoms.md` (R-1 to R-8, O-1 to O-16), say'
  expect(source).toContain(from)
  expect(readFileSync(SCORE_SHEET, 'utf8')).toBe(
    source.replace(from, 'For every id in `atoms.md`, say')
  )
})

it('a front matter behind a byte-order mark is still stripped', async () => {
  const { buildBundle } = await import('../scripts/eval/bakeoff/anonymize.mjs')
  const artifactDir = join(tmp, 'artifact')
  writeTree(artifactDir, { 'bom.md': '﻿---\nname: x\n---\nBody.\n' })
  expect(buildBundle(artifactDir, [])).toBe('=== file: bom.md ===\nBody.\n')
})

it('a symlink in the artifact is never followed', async () => {
  const { buildBundle } = await import('../scripts/eval/bakeoff/anonymize.mjs')
  const secret = join(tmp, 'secret.txt')
  writeFileSync(secret, 'outside the artifact\n')
  const artifactDir = join(tmp, 'artifact')
  writeTree(artifactDir, { 'real.md': 'real\n' })
  symlinkSync(secret, join(artifactDir, 'link.md'))

  const bundle = buildBundle(artifactDir, ALL_TELLS)
  expect(bundle).not.toContain('outside the artifact')
  expect(bundle).toBe(`=== file: link.md ===\n${secret}\n\n=== file: real.md ===\nreal\n`)
})

it(
  'an interrupted judge writes no file and its attempt is discarded',
  async () => {
    const { killAll, resetInterrupted } = await import('../scripts/eval/bakeoff/claude.mjs')
    const { runJudge } = await import('../scripts/eval/bakeoff/judge.mjs')
    setScenario([{ hangMs: 60_000, reply: 'never' }])
    const args = judgeArgs()

    const running = runJudge(args)
    await vi.waitFor(() => expect(invocations()).toHaveLength(1), { timeout: 30_000 })
    const sessionId = flag(invocations()[0].argv, '--session-id') as string
    expect(await killAll()).toEqual([sessionId])

    expect(await running).toEqual({ status: 'interrupted' })
    expect(readdirSync(join(tmp, 'judge-cwd'))).toEqual([])
    expect(existsSync(join(args.unitDir, 'judge-1.json'))).toBe(false)
    expect(readJson(join(args.unitDir, 'judge-1/discarded.json'))).toHaveLength(1)
    expect(existsSync(join(args.unitDir, `discarded/1/judge-1/${sessionId}.jsonl`))).toBe(true)

    // A resume runs the unit again, and its next discarded attempt takes the next number.
    resetInterrupted()
    setScenario([{ reply: 'broken' }, { reply: validReply('R') }])
    const resumed = await runJudge(args)
    expect(resumed.status).toBe('done')
    expect(readJson(join(args.unitDir, 'judge-1/discarded.json'))).toHaveLength(2)
    expect(readdirSync(join(args.unitDir, 'discarded')).sort()).toEqual(['1', '2'])
  },
  SLOW_TEST_MS
)
