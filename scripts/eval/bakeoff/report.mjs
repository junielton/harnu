/**
 * The report of one round, rebuilt from its unit files: "The report" and "Round files" in
 * `docs/specs/2026-11-07-bakeoff-harness/spec.md` are the contract.
 *
 * A dev report names problems. A holdout report and everything it prints carry per-contestant
 * aggregates only; the per-problem numbers go to the private `problems.json`. Neither file holds a
 * timestamp, so regenerating one is byte-identical.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { privateRoundDir, repoRoundDir, unitsRoot } from './paths.mjs'
import { rollup } from './usage-rollup.mjs'

const coded = (code, message) => ({ code, message })
const isCoded = (value) => typeof value === 'object' && value !== null && 'code' in value
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const average = (values) => values.reduce((sum, v) => sum + v, 0) / values.length
const NOT_AVAILABLE = 'n/a'
const formatNumber = (value) => (isNumber(value) ? value.toFixed(2) : NOT_AVAILABLE)

const CONFOUNDS = [
  'Bundles keep their structure: contestant names are replaced and front matter is stripped, but the structural shape of an artifact (an acceptance-criteria table, a plan checklist) can still identify the method to a judge.',
  'Judges run from a neutral directory, but the default work root path contains the word `harnu` for every contestant alike, so it cannot say which contestant is being scored.',
  'Real-CLI `--resume` behaviour and "no MCP server loads under `--strict-mcp-config`" are first exercised by the dry run; rounds that use a fake `claude` prove neither.',
  'The operator is simulated from a written answer sheet, so a question the sheet does not cover gets its default answer rather than a human judgement.',
  'Judges share one model and read one contestant at a time; their scores are not calibrated against a human grader.',
  'Hidden tests measure one reference behaviour: a spec that legitimately decides otherwise scores lower.',
  'Run-to-run spread comes from few repeats, so it is a coarse noise estimate, not a statistical test.'
]

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const aside = `${path}.tmp-${randomUUID()}`
  writeFileSync(aside, text)
  renameSync(aside, path)
}

const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`

/** A judge's scores count only when it read an artifact or found it empty; never when it failed. */
function judgeMean(judges, pick) {
  const values = judges.map((judge) => (judge.scores ? pick(judge.scores) : null)).filter(isNumber)
  return values.length === 0 ? null : average(values)
}

const percentOf = (part, whole) => (isNumber(part) && whole > 0 ? (part / whole) * 100 : null)
const shareOf = (part, whole) => (isNumber(part) && whole > 0 ? part / whole : null)

/** What the method itself cost: the measurement's judges are in the budget section only. */
function methodTokens(run, field) {
  if (run.contestant === null) return null
  const { contestant, operator } = run.contestant.usage
  return (contestant[field] ?? 0) + (operator[field] ?? 0) + (run.build?.usage?.[field] ?? 0)
}

const contestantField = (field) => (run) => run.contestant?.[field] ?? null

/** Report order; each picks one run's value, or null for a value that does not exist. */
const MEASURES = [
  {
    key: 'hiddenPassRate',
    title: 'Hidden-test pass rate (%)',
    value: (run) => percentOf(run.build?.hidden?.passed, run.build?.hidden?.total)
  },
  {
    key: 'coverage',
    title: 'Coverage (% of atoms, judge mean)',
    value: (run) => judgeMean(run.judges, (s) => percentOf(s.coverage, s.coverageMax))
  },
  {
    key: 'decisionsLeft',
    title: 'Decisions left to the implementer (judge mean)',
    value: (run) => judgeMean(run.judges, (s) => s.decisionsLeft)
  },
  {
    key: 'contradictions',
    title: 'Contradictions (judge mean)',
    value: (run) => judgeMean(run.judges, (s) => s.contradictions)
  },
  {
    key: 'executableShare',
    title: 'Executable-proof share (judge mean)',
    value: (run) => judgeMean(run.judges, (s) => shareOf(s.acExecutable, s.acTotal))
  },
  {
    key: 'builderGuesses',
    title: 'Builder guesses (judge mean)',
    value: (run) => judgeMean(run.judges, (s) => s.builderGuesses)
  },
  {
    key: 'assumptions',
    title: 'Assumptions logged (builder)',
    value: (run) => run.build?.assumptions ?? null
  },
  {
    key: 'tokensTotal',
    title: 'Tokens per run, total (spec and build)',
    value: (run) => methodTokens(run, 'total')
  },
  {
    key: 'tokensOutput',
    title: 'Tokens per run, output (spec and build)',
    value: (run) => methodTokens(run, 'output')
  },
  { key: 'wallMs', title: 'Wall time (ms)', value: contestantField('wallMs') },
  { key: 'operatorTurns', title: 'Operator turns', value: contestantField('operatorTurns') },
  { key: 'subAgents', title: 'Sub-agents spawned', value: contestantField('subAgents') },
  { key: 'specLines', title: 'Spec lines', value: contestantField('specLines') },
  { key: 'specWords', title: 'Spec words', value: contestantField('specWords') }
]

/** One run's result files; a unit that never finished reads as null. */
function readRun(root, problem, contestantId, repeat, judgeCount) {
  const dir = join(root, problem, contestantId, `r${repeat}`)
  const judges = []
  for (let n = 1; n <= judgeCount; n++) {
    const judge = readJsonOrNull(join(dir, `judge-${n}.json`))
    if (judge !== null) judges.push(judge)
  }
  return {
    problem,
    contestantId,
    repeat,
    contestant: readJsonOrNull(join(dir, 'contestant.json')),
    judges,
    build: readJsonOrNull(join(dir, 'build.json'))
  }
}

function aggregate(values) {
  const present = values.filter(isNumber)
  if (present.length === 0) return { mean: null, spread: null }
  return { mean: average(present), spread: Math.max(...present) - Math.min(...present) }
}

function loadRuns(round, problems, contestants, root) {
  const runs = []
  for (const problem of problems) {
    for (const contestantId of contestants) {
      for (let repeat = 1; repeat <= round.repeats; repeat++) {
        runs.push(readRun(root, problem, contestantId, repeat, round.judges))
      }
    }
  }
  return runs
}

/** One row per problem and contestant: every run's value, the mean and the spread. */
function measureRows(measure, problems, contestants, runs) {
  return problems.flatMap((problem) =>
    contestants.map((contestant) => {
      const values = runs
        .filter((run) => run.problem === problem && run.contestantId === contestant)
        .map((run) => measure.value(run))
      return { problem, contestant, values, ...aggregate(values) }
    })
  )
}

/** Mean of the problem means, mean of the problem spreads, over the problems with a value. */
function summaryRows(rows, contestants) {
  return contestants.map((contestant) => {
    const scored = rows.filter((row) => row.contestant === contestant && isNumber(row.mean))
    const hasRows = scored.length > 0
    return {
      contestant,
      mean: hasRows ? average(scored.map((row) => row.mean)) : null,
      spread: hasRows ? average(scored.map((row) => row.spread)) : null,
      n: scored.length
    }
  })
}

function runsTable(runs, contestants) {
  return contestants.map((contestant) => {
    const own = runs.filter((run) => run.contestantId === contestant)
    const withStatus = (status) => own.filter((run) => run.contestant?.status === status).length
    return {
      contestant,
      done: withStatus('done'),
      incomplete: withStatus('incomplete'),
      failed: withStatus('failed'),
      judgesInvalidReply: own
        .flatMap((run) => run.judges)
        .filter((judge) => judge.status === 'not-run' && judge.reason === 'invalid-reply').length,
      flakyHiddenTests: own.reduce((sum, run) => sum + (run.build?.hidden?.flaky?.length ?? 0), 0)
    }
  })
}

function detailsOf(runs) {
  return runs
    .filter((run) => run.contestant !== null)
    .map((run) => ({
      problem: run.problem,
      contestant: run.contestantId,
      repeat: run.repeat,
      failedHiddenTests: run.build?.hidden?.failed ?? [],
      judgeNotes: run.judges
        .map((judge) => judge.parsed?.notes)
        .filter((note) => typeof note === 'string')
    }))
}

function budgetOf(round, root) {
  const { cap, spent } = round.budget
  return { cap, spent, remaining: cap - spent, status: round.status, ...rollup(root) }
}

const table = (header, rows) =>
  [header, header.map(() => '---'), ...rows].map((cells) => `| ${cells.join(' | ')} |`)

function measureSection(report, measure, repeats) {
  const { rows, summary } = report.measures[measure.key]
  const lines = [`## ${measure.title}`, '']
  if (rows === undefined) {
    const body = summary.map((s) => [
      s.contestant,
      formatNumber(s.mean),
      formatNumber(s.spread),
      formatNumber(s.n)
    ])
    lines.push(...table(['contestant', 'mean', 'spread', 'n'], body))
  } else {
    const repeatLabels = Array.from({ length: repeats }, (_, i) => `r${i + 1}`)
    const body = rows.map((row) => [
      row.problem,
      row.contestant,
      ...row.values.map(formatNumber),
      formatNumber(row.mean),
      formatNumber(row.spread)
    ])
    const summaryBody = summary.map((s) => [
      '(summary)',
      s.contestant,
      ...repeatLabels.map(() => ''),
      formatNumber(s.mean),
      formatNumber(s.spread)
    ])
    lines.push(
      ...table(
        ['problem', 'contestant', ...repeatLabels, 'mean', 'spread'],
        [...body, ...summaryBody]
      )
    )
  }
  lines.push('')
  return lines
}

function headerLines(report) {
  const models = Object.entries(report.models).map(([role, id]) => `- models.${role}: ${id}`)
  const pins = Object.entries(report.pins).map(([id, sha]) => `- pins.${id}: ${sha}`)
  return [
    `# Bake-off report: ${report.roundId}`,
    '',
    `- split: ${report.split}`,
    `- status: ${report.status}`,
    `- dryRun: ${report.dryRun}`,
    ...models,
    ...pins,
    ''
  ]
}

function runsLines(report) {
  const body = report.runs.map((row) => [
    row.contestant,
    formatNumber(row.done),
    formatNumber(row.incomplete),
    formatNumber(row.failed),
    formatNumber(row.judgesInvalidReply),
    formatNumber(row.flakyHiddenTests)
  ])
  const header = ['contestant', 'done', 'incomplete', 'failed', 'judges invalid reply', 'flaky']
  return ['## Runs', '', ...table(header, body), '']
}

function budgetLines({ budget }) {
  const rowsOf = (object) => Object.entries(object).map(([name, n]) => [name, formatNumber(n)])
  return [
    '## Budget',
    '',
    `- cap: ${formatNumber(budget.cap)}`,
    `- spent: ${formatNumber(budget.spent)}`,
    `- remaining: ${formatNumber(budget.remaining)}`,
    `- status: ${budget.status}`,
    '',
    ...table(['phase', 'tokens'], rowsOf(budget.byPhase)),
    '',
    ...table(['contestant', 'tokens'], rowsOf(budget.byContestant)),
    ''
  ]
}

const oneLine = (text) => text.replace(/\s+/g, ' ').trim()

/** Dev only: which hidden tests failed and what the judges said, run by run. */
function detailsLines(details) {
  const lines = ['## Details', '']
  for (const detail of details) {
    lines.push(`### ${detail.problem} · ${detail.contestant} · r${detail.repeat}`, '')
    for (const name of detail.failedHiddenTests) lines.push(`- failed: ${oneLine(name)}`)
    for (const note of detail.judgeNotes) lines.push(`- judge note: ${oneLine(note)}`)
    lines.push('')
  }
  return lines
}

function renderMarkdown(report) {
  const lines = [
    ...headerLines(report),
    ...MEASURES.flatMap((measure) => measureSection(report, measure, report.repeats)),
    ...runsLines(report),
    ...budgetLines(report),
    '## Confounds',
    '',
    ...report.confounds.map((text) => `- ${text}`),
    ''
  ]
  if (report.details !== undefined) lines.push(...detailsLines(report.details))
  return `${lines.join('\n').trimEnd()}\n`
}

/** Sets each contestant's `measures` in the private file and leaves every other key as it was. */
function writePrivateMeasures(file, state, perMeasure) {
  const next = {
    ...state,
    problems: state.problems.map((problem) => ({
      ...problem,
      contestants: Object.fromEntries(
        Object.entries(problem.contestants).map(([id, entry]) => {
          const measures = Object.fromEntries(
            MEASURES.map(({ key }) => {
              const row = perMeasure[key].find(
                (r) => r.problem === problem.id && r.contestant === id
              )
              return [key, { values: row.values, mean: row.mean, spread: row.spread }]
            })
          )
          return [id, { ...entry, measures }]
        })
      )
    }))
  }
  writeAtomic(file, jsonText(next))
}

/**
 * @param {string} roundId
 * @param {{ roots: object }} ctx
 * @returns {{ mdPath: string, jsonPath: string } | { code: string, message: string }}
 */
export function writeReport(roundId, ctx) {
  const { roots } = ctx
  const dir = repoRoundDir(roots, roundId)
  const round = readJsonOrNull(join(dir, 'round.json'))
  if (round === null) return coded('ROUND_NOT_FOUND', `No round ${roundId}.`)

  const isHoldout = round.split === 'holdout'
  const privateFile = isHoldout ? join(privateRoundDir(roots, roundId), 'problems.json') : null
  const privateState = isHoldout ? readJsonOrNull(privateFile) : null
  if (isHoldout && privateState === null) {
    return coded('ROUND_NOT_FOUND', `Round ${roundId} has no state in this holdout clone.`)
  }

  const problems = (isHoldout ? privateState.problems : round.problems).map((p) => p.id)
  const contestants = Object.keys(round.pins).sort()
  const root = unitsRoot(roots, round.split, roundId)
  const runs = loadRuns(round, problems, contestants, root)

  const perMeasure = Object.fromEntries(
    MEASURES.map((measure) => [measure.key, measureRows(measure, problems, contestants, runs)])
  )
  const measures = Object.fromEntries(
    MEASURES.map(({ key }) => [
      key,
      {
        ...(isHoldout ? {} : { rows: perMeasure[key] }),
        summary: summaryRows(perMeasure[key], contestants)
      }
    ])
  )

  const report = {
    roundId: round.roundId,
    split: round.split,
    status: round.status,
    dryRun: round.dryRun,
    models: round.models,
    pins: round.pins,
    repeats: round.repeats,
    judges: round.judges,
    measures,
    runs: runsTable(runs, contestants),
    ...(isHoldout ? {} : { details: detailsOf(runs) }),
    budget: budgetOf(round, root),
    confounds: CONFOUNDS
  }

  if (isHoldout) writePrivateMeasures(privateFile, privateState, perMeasure)
  const mdPath = join(dir, 'report.md')
  const jsonPath = join(dir, 'report.json')
  writeAtomic(jsonPath, jsonText(report))
  writeAtomic(mdPath, renderMarkdown(report))
  return { mdPath, jsonPath }
}

/**
 * @param {{ positional: string[] }} args
 * @param {object} ctx
 * @returns {number | { code: string, message: string }}
 */
export function reportCommand(args, ctx) {
  const roundId = args.positional[0]
  if (!roundId) return coded('USAGE', 'report needs a round id.')
  const written = writeReport(roundId, ctx)
  if (isCoded(written)) return written
  const round = readJsonOrNull(join(repoRoundDir(ctx.roots, roundId), 'round.json'))
  if (round.split !== 'holdout') ctx.stdout.write(`report written: ${written.mdPath}\n`)
  return 0
}
