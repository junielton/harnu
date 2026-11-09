/**
 * The `eval:bakeoff` entry point: parses the command line, checks everything that can be refused
 * before any token is spent, and dispatches through one table. "The CLI" in
 * `docs/specs/2026-11-07-bakeoff-harness/spec.md` is the contract.
 *
 * Later slices add a command by creating the module its row names, never by editing this file.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveModel } from './claude.mjs'
import { repoRoundDir, resolveRoots, unitsRoot } from './paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUND_FILE = 'round.json'
const MAX_ROUND_ID_TRIES = 120

/** Each command names the module and handler that implement it. */
export const COMMANDS = {
  run: { module: 'round.mjs', handler: 'runCommand' },
  resume: { module: 'round.mjs', handler: 'resumeCommand' },
  report: { module: 'report.mjs', handler: 'reportCommand' },
  compare: { module: 'compare.mjs', handler: 'compareCommand' },
  validate: { module: 'validate.mjs', handler: 'validateCommand' },
  list: { module: 'list.mjs', handler: 'listCommand' },
  'author-sandbox': { module: 'author.mjs', handler: 'authorSandboxCommand' },
  'author-import': { module: 'author.mjs', handler: 'authorImportCommand' },
  review: { module: 'author.mjs', handler: 'reviewCommand' }
}

const SPLITS = new Set(['dev', 'holdout'])
const OPTIONAL_SPLIT = new Set(['run', 'validate', 'list'])
const REQUIRED_SPLIT = new Set(['author-sandbox', 'author-import', 'review'])
const ROUND_SPLIT = new Set(['resume', 'report'])

const VALUE_FLAGS = {
  '--split': 'split',
  '--after': 'after',
  '--problems': 'problems',
  '--skill-ref': 'skillRef',
  '--repeats': 'repeats',
  '--judges': 'judges',
  '--model': 'model',
  '--operator-model': 'operatorModel',
  '--judge-model': 'judgeModel',
  '--budget': 'budget',
  '--jobs': 'jobs',
  '--seed': 'seed',
  '--repo': 'repo',
  '--commit': 'commit',
  '--pick': 'pick',
  '--reference': 'reference'
}
const BOOLEAN_FLAGS = { '--with-tlc': 'withTlc', '--dry-run': 'dryRun' }
const INTEGER_FIELDS = ['repeats', 'judges', 'budget', 'jobs']

const RUN_DEFAULTS = {
  split: 'dev',
  after: null,
  problems: null,
  withTlc: false,
  skillRef: 'HEAD',
  repeats: 2,
  judges: 3,
  model: 'opus',
  operatorModel: 'sonnet',
  judgeModel: 'sonnet',
  budget: 400_000_000,
  jobs: null,
  seed: null,
  dryRun: false
}
const DRY_RUN_OVERRIDES = {
  split: 'dev',
  after: null,
  withTlc: false,
  model: 'haiku',
  operatorModel: 'haiku',
  judgeModel: 'haiku',
  repeats: 1,
  judges: 1,
  budget: 10_000_000
}

const coded = (code, message) => ({ code, message })
const isCoded = (value) => typeof value === 'object' && value !== null && 'code' in value

/** The flags and positionals of a command line, or a coded error. */
function parseFlags(argv) {
  const args = { positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg in BOOLEAN_FLAGS) {
      args[BOOLEAN_FLAGS[arg]] = true
    } else if (arg in VALUE_FLAGS) {
      if (i + 1 >= argv.length) return coded('BAD_FLAG', `${arg} needs a value.`)
      args[VALUE_FLAGS[arg]] = argv[++i]
    } else if (arg.startsWith('--')) {
      return coded('BAD_FLAG', `Unknown flag: ${arg}.`)
    } else {
      args.positional.push(arg)
    }
  }
  for (const field of INTEGER_FIELDS) {
    if (args[field] === undefined) continue
    const value = Number(args[field])
    if (!Number.isSafeInteger(value) || value < 1) {
      return coded('BAD_FLAG', `--${field} must be a positive integer.`)
    }
    args[field] = value
  }
  return args
}

/** The split check of `main`, made before dispatch so it holds while a module is still absent. */
function checkSplit(command, args) {
  const given = args.split
  if (OPTIONAL_SPLIT.has(command) && (given === undefined || SPLITS.has(given))) return null
  if (OPTIONAL_SPLIT.has(command) || (REQUIRED_SPLIT.has(command) && !SPLITS.has(given))) {
    return coded('SPLIT_REQUIRED', '--split must be exactly dev or holdout.')
  }
  return null
}

/** The handler of a table row, or null while its module or export does not exist yet. */
async function loadHandler({ module, handler }) {
  const path = join(HERE, module)
  if (!existsSync(path)) return null
  const loaded = await import(/* @vite-ignore */ pathToFileURL(path).href)
  return typeof loaded[handler] === 'function' ? loaded[handler] : null
}

/** A round's split, for the commands that name a round rather than a split. */
function splitOfRound(command, args, env) {
  const devRoots = resolveRoots({ split: 'dev', env })
  if (isCoded(devRoots)) return devRoots
  if (!ROUND_SPLIT.has(command) || !args.positional[0]) return 'dev'
  try {
    const path = join(repoRoundDir(devRoots, args.positional[0]), ROUND_FILE)
    return JSON.parse(readFileSync(path, 'utf8')).split === 'holdout' ? 'holdout' : 'dev'
  } catch {
    return 'dev'
  }
}

function resolveCommandRoots(command, args, env) {
  // A dry run is always dev, whatever `--split` says.
  if (args.split !== undefined && !args.dryRun) return resolveRoots({ split: args.split, env })
  const split = splitOfRound(command, args, env)
  return isCoded(split) ? split : resolveRoots({ split, env })
}

/**
 * The refusal when the judge would be the contestant's own model (S-10 rubric step 4).
 *
 * @param {string} contestantId a full model id
 * @param {string} judgeId a full model id
 * @param {{ dryRun: boolean }} options
 * @returns {null | { code: string, message: string }}
 */
export function assertJudgeModel(contestantId, judgeId, { dryRun }) {
  if (dryRun || contestantId !== judgeId) return null
  return coded('JUDGE_MODEL_SAME', 'The judge model must differ from the contestant model.')
}

/** The UTC start time, `YYYYMMDD-HHMMSS`. */
function stampOf(ms) {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`
}

/** Takes a round id by creating its directory: two rounds started in one second stay apart. */
function claimRoundId(roots) {
  mkdirSync(dirname(repoRoundDir(roots, 'x')), { recursive: true })
  const start = Date.now()
  for (let offset = 0; offset < MAX_ROUND_ID_TRIES; offset++) {
    const roundId = stampOf(start + offset * 1000)
    try {
      mkdirSync(repoRoundDir(roots, roundId))
      return roundId
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
  throw new Error('No free round id.')
}

/** The model probes' usage: they belong to no unit, so no other task ever writes this file. */
function recordProbes(roots, split, roundId, probes) {
  const dir = join(unitsRoot(roots, split, roundId), '_round')
  mkdirSync(dir, { recursive: true })
  const entries = probes.map((usage) => ({
    unit: null,
    phase: 'model-probe',
    contestant: null,
    usage
  }))
  writeFileSync(join(dir, 'discarded.json'), `${JSON.stringify(entries, null, 2)}\n`)
}

/** Fills `run`'s arguments, applies the dry run's overrides and spends the model probes. */
async function prepareRun(rawArgs, ctx) {
  const merged = { ...RUN_DEFAULTS, ...rawArgs }
  const args = merged.dryRun ? { ...merged, ...DRY_RUN_OVERRIDES } : merged

  const { preflightRun } = await import('./round.mjs')
  const refused = await preflightRun(args, ctx)
  if (refused !== null) return refused

  const names = [args.model, args.operatorModel, args.judgeModel]
  const resolved = await resolveModel(names)
  if (isCoded(resolved)) return resolved
  const models = {
    contestant: resolved.ids[args.model],
    operator: resolved.ids[args.operatorModel],
    judge: resolved.ids[args.judgeModel]
  }
  const refusedJudge = assertJudgeModel(models.contestant, models.judge, args)
  if (refusedJudge !== null) return refusedJudge

  const roundId = claimRoundId(ctx.roots)
  recordProbes(ctx.roots, args.split, roundId, resolved.probes)
  return { args: { ...args, roundId }, models }
}

/** Runs the table's `report` row. While its module is absent no report is written. */
async function writeRoundReport(roundId, ctx) {
  const report = await loadHandler(COMMANDS.report)
  if (report === null) return
  const result = await report({ positional: [roundId] }, ctx)
  if (result !== 0) {
    const what = isCoded(result) ? `${result.code}: ${result.message}` : `exit ${result}`
    ctx.stderr.write(`The report was not written (${what}).\n`)
  }
}

function printRefusal(error, stderr) {
  stderr.write(`${error.code}: ${error.message}\n`)
  return 2
}

/** A claimed round id whose round never started leaves no empty directory behind. */
function releaseRoundId(roots, roundId) {
  if (existsSync(join(repoRoundDir(roots, roundId), ROUND_FILE))) return
  try {
    rmdirSync(repoRoundDir(roots, roundId))
  } catch {
    /* it holds something else */
  }
}

/**
 * @param {string[]} argv the command line after the entry point
 * @returns {Promise<number>} the exit code
 */
export async function main(argv) {
  const { stdout, stderr, stdin, env } = process
  const [command, ...rest] = argv
  const row = COMMANDS[command]
  if (row === undefined) {
    return printRefusal(coded('USAGE', `Commands: ${Object.keys(COMMANDS).join(', ')}.`), stderr)
  }

  const parsed = parseFlags(rest)
  if (isCoded(parsed)) return printRefusal(parsed, stderr)
  const refusedSplit = checkSplit(command, parsed)
  if (refusedSplit !== null) return printRefusal(refusedSplit, stderr)

  const handler = await loadHandler(row)
  if (handler === null) {
    return printRefusal(coded('NOT_YET', `${command} is not implemented yet.`), stderr)
  }

  const roots = resolveCommandRoots(command, parsed, env)
  if (isCoded(roots)) return printRefusal(roots, stderr)

  const ctx = { roots, models: null, stdout, stderr, stdin, env }
  ctx.writeRoundReport = (roundId) => writeRoundReport(roundId, ctx)

  let args = parsed
  if (command === 'run') {
    const prepared = await prepareRun(parsed, ctx)
    if (isCoded(prepared)) return printRefusal(prepared, stderr)
    args = prepared.args
    ctx.models = prepared.models
  }

  const result = await handler(args, ctx)
  if (command === 'run') releaseRoundId(roots, args.roundId)
  return isCoded(result) ? printRefusal(result, stderr) : result
}

function isEntryPoint() {
  const entry = process.argv[1]
  if (!entry) return false
  // vite-node leaves its own binary in argv[1].
  if (/^vite-node(\.m?js)?$/.test(basename(entry))) return true
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isEntryPoint()) process.exit(await main(process.argv.slice(2)))
