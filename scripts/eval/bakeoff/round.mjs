/**
 * A round: every unit of one split, scheduled under `--jobs` and the token cap, resumable from
 * what is on disk. "A unit", "Round files" and "Budget" in
 * `docs/specs/2026-11-07-bakeoff-harness/spec.md` are the contract.
 *
 * On a holdout round nothing that reaches the terminal or the repo names a problem: counters only.
 * A unit's coded error is reported by its `code` and `message`, never its `detail`.
 */
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { canStart, spentTokens } from './budget.mjs'
import { runBuild, shellQuote } from './build.mjs'
import { runProblemCommand } from './checkout.mjs'
import { killAll } from './claude.mjs'
import { runContestant } from './contestant-run.mjs'
import { contestants as registry, resolveTool, selectContestants } from './contestants.mjs'
import { contentHash, loadCorpus } from './corpus.mjs'
import { runJudge } from './judge.mjs'
import { privateRoundDir, repoRoundDir, unitsRoot, validationRoot } from './paths.mjs'
import { validateProblem } from './validate.mjs'

const EXIT = { done: 0, aborted: 3, interrupted: 130 }
const DEV_CORPUS = 'scripts/eval/bakeoff/corpus/dev'
const DRY_RUN_CORPUS = 'scripts/eval/bakeoff/fixtures/dry-run'
const HARNU_SPEC = 'harnu-spec'
const RESULT_FILE = { contestant: 'contestant.json', build: 'build.json' }

const coded = (code, message) => ({ code, message })
const isCoded = (value) => typeof value === 'object' && value !== null && 'code' in value
const jobsCeiling = () => Math.max(1, Math.floor(availableParallelism() / 2))
const say = (stream, line) => stream.write(`${line}\n`)
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

function readJsonOrNull(path) {
  try {
    return readJson(path)
  } catch {
    return null
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const aside = `${path}.tmp-${randomUUID()}`
  writeFileSync(aside, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(aside, path)
}

async function resolveCommit(repo, ref) {
  const run = await runProblemCommand(
    `git rev-parse --verify --quiet ${shellQuote(`${ref}^{commit}`)}`,
    repo
  )
  return run.exitCode === 0 ? run.stdout.trim() : null
}

/** Holdout gate: the skill may only be confirmed on the holdout after dev accepted it. */
async function checkDevAccepted(args, roots) {
  const refused = (why) => coded('DEV_NOT_ACCEPTED', `A holdout round ${why}.`)
  if (!args.after) return refused('needs --after <accepted dev round id>')
  const compare = readJsonOrNull(join(repoRoundDir(roots, args.after), 'compare.json'))
  if (compare === null) return refused('needs a dev round with a compare.json')
  if (compare.split !== 'dev' || compare.verdict !== 'accepted') {
    return refused('needs a dev compare whose verdict is accepted')
  }
  const sha = await resolveCommit(roots.repo, args.skillRef)
  if (sha === null || ![compare.baselineSkillSha, compare.candidateSkillSha].includes(sha)) {
    return refused('must run a skill the dev compare accepted or used as its baseline')
  }
  return null
}

/**
 * Everything `run` can refuse without spending a token, so `main` calls it before the probes.
 *
 * @param {object} args the filled `run` flags
 * @param {object} ctx
 * @returns {Promise<null | { code: string, message: string }>}
 */
export async function preflightRun(args, ctx) {
  if (args.split !== 'holdout') return null
  if (args.problems !== null && args.problems !== undefined) {
    return coded('PROBLEMS_ON_HOLDOUT', '--problems is refused with --split holdout.')
  }
  return checkDevAccepted(args, ctx.roots)
}

const selectionOf = (problems) =>
  typeof problems === 'string' ? problems.split(',').filter(Boolean) : (problems ?? null)

function corpusRootOf(split, dryRun, roots) {
  if (dryRun) return join(roots.repo, DRY_RUN_CORPUS)
  return split === 'holdout' ? roots.holdout : join(roots.repo, DEV_CORPUS)
}

const problemOfError = (error) => error.file.split(/[\\/]/)[0]

/**
 * The round's problems, loaded and validated, or an exit code / coded error.
 *
 * @param {{ split: string, dryRun: boolean, wanted: string[] | null }} options
 */
async function loadValidated({ split, dryRun, wanted }, ctx, isStopped) {
  const { roots, stderr } = ctx
  const isHoldout = split === 'holdout'
  const { problems, errors } = loadCorpus(corpusRootOf(split, dryRun, roots), {
    split,
    forRun: true
  })

  const brokenIds = [...new Set(errors.map(problemOfError))]
  if (wanted !== null) {
    const known = new Set([...problems.map((p) => p.id), ...brokenIds])
    const unknown = wanted.filter((id) => !known.has(id))
    if (unknown.length > 0) {
      return coded(
        'PROBLEM_UNKNOWN',
        isHoldout ? 'A problem of the round is gone.' : `Unknown problem: ${unknown.join(', ')}.`
      )
    }
  }
  const selected = (id) => wanted === null || wanted.includes(id)
  const usable = problems.filter((p) => selected(p.id))
  const broken = brokenIds.filter(selected)
  if (!isHoldout) {
    for (const error of errors.filter((e) => selected(problemOfError(e)))) {
      say(stderr, `${error.code}: ${error.message} [${error.file}]`)
    }
  }
  const total = usable.length + broken.length
  if (total === 0) return coded('CORPUS_EMPTY', `The ${split} corpus has no problem to run.`)

  let failed = broken.length
  const validated = []
  for (const problem of usable) {
    if (isStopped()) return EXIT.interrupted
    const result = await validateProblem(problem, roots)
    if (result.ok) {
      validated.push({ ...problem, testSet: result.testSet })
      continue
    }
    failed += 1
    if (!isHoldout) {
      for (const d of result.defects) say(stderr, `${problem.id}: ${d.code}: ${d.message}`)
      say(
        stderr,
        `${problem.id}: details in ${join(validationRoot(roots, split), `${result.key}.json`)}`
      )
    }
  }
  if (failed > 0) {
    say(stderr, `${failed} of ${total} ${split} problems failed validation`)
    return 2
  }
  return validated
}

/** Every unit of the round, in schedule order: per problem, contestant and repeat. */
function buildUnits(round) {
  const units = []
  for (const problem of round.problems) {
    for (const contestant of round.contestants) {
      for (let repeat = 1; repeat <= round.repeats; repeat++) {
        const unitDir = join(round.unitsRoot, problem.id, contestant.id, `r${repeat}`)
        const tuple = { problem, contestant, repeat, unitDir }
        const prefix = `${problem.id}/${contestant.id}/r${repeat}`
        const judges = Array.from({ length: round.judges }, (_, i) => ({
          id: `${prefix}/judge-${i + 1}`,
          kind: 'judge',
          n: i + 1,
          tuple,
          file: `judge-${i + 1}.json`
        }))
        const contestantUnit = {
          id: `${prefix}/contestant`,
          kind: 'contestant',
          tuple,
          file: RESULT_FILE.contestant,
          needs: []
        }
        const buildUnit = {
          id: `${prefix}/build`,
          kind: 'build',
          tuple,
          file: RESULT_FILE.build,
          needs: judges
        }
        for (const judge of judges) judge.needs = [contestantUnit]
        for (const unit of [contestantUnit, ...judges, buildUnit]) {
          unit.state = existsSync(join(unitDir, unit.file)) ? 'done' : 'pending'
          units.push(unit)
        }
      }
    }
  }
  return units
}

const unitRows = (units) => units.map((u) => ({ unit: u.id, state: u.state }))

/** Writes the round's state: `round.json`, and on a holdout round the private `problems.json`. */
function saveRound(round) {
  const isHoldout = round.split === 'holdout'
  writeJsonAtomic(round.roundFile, {
    roundId: round.roundId,
    split: round.split,
    status: round.status,
    dryRun: round.dryRun,
    args: isHoldout ? 'redacted' : round.args,
    seed: round.seed,
    repeats: round.repeats,
    judges: round.judges,
    models: round.models,
    pins: round.pins,
    budget: { cap: round.cap, spent: round.spent },
    problems: isHoldout
      ? []
      : round.problems.map(({ id, contentHash: hash }) => ({ id, contentHash: hash })),
    units: isHoldout ? [] : unitRows(round.units),
    startedAt: round.startedAt,
    finishedAt: round.finishedAt
  })
  if (isHoldout) {
    // Read back rather than rebuilt: the reporter owns each contestant's `measures`.
    const file = join(round.privateDir, 'problems.json')
    const current = readJson(file)
    writeJsonAtomic(file, { ...current, units: unitRows(round.units) })
  }
}

function writePrivateFiles(round) {
  const labels = {}
  const problems = round.problems.map((problem, i) => {
    const label = `H-${i + 1}`
    labels[label] = problem.id
    return {
      id: problem.id,
      label,
      contentHash: problem.contentHash,
      contestants: Object.fromEntries(round.contestants.map((c) => [c.id, {}]))
    }
  })
  writeJsonAtomic(join(round.privateDir, 'labels.json'), labels)
  writeJsonAtomic(join(round.privateDir, 'problems.json'), {
    roundId: round.roundId,
    args: round.args,
    problems,
    units: unitRows(round.units)
  })
}

async function runUnit(unit, round) {
  const { problem, contestant, repeat, unitDir } = unit.tuple
  const artifactDir = join(unitDir, 'artifact')
  switch (unit.kind) {
    case 'contestant':
      return runContestant({
        problem,
        contestant,
        repeat,
        unitDir,
        roots: round.roots,
        skillRef: round.pins[HARNU_SPEC],
        answerSheetPath: join(problem.dir, 'answer-sheet.md'),
        model: round.models.contestant,
        operatorModel: round.models.operator
      })
    case 'judge':
      return runJudge({
        problem,
        contestant,
        repeat,
        n: unit.n,
        unitDir,
        artifactDir,
        tells: round.contestants.flatMap((c) => c.tells),
        seed: round.seed,
        contestantIds: round.contestants.map((c) => c.id),
        model: round.models.judge
      })
    default:
      return runBuild({
        problem,
        unitDir,
        artifactDir,
        roots: round.roots,
        model: round.models.contestant,
        testSet: problem.testSet
      })
  }
}

/** Runs units until none is left or a stop reason lands, then waits for the ones in flight. */
function schedule(round, ctx, signal) {
  const { units, jobs } = round
  const total = units.length
  const isHoldout = round.split === 'holdout'
  let doneCount = units.filter((u) => u.state === 'done').length
  let active = 0

  const isReady = (unit) =>
    unit.state === 'pending' && unit.needs.every((need) => need.state === 'done')

  return new Promise((resolve) => {
    const finishUnit = (unit, result, error) => {
      active -= 1
      if (error) {
        unit.state = 'pending'
        signal.stop ??= 'error'
        signal.error ??= isHoldout
          ? coded('UNIT_FAILED', 'A unit crashed.')
          : coded('UNIT_FAILED', `${unit.id}: ${error.message}`)
      } else if (isCoded(result)) {
        unit.state = 'pending'
        signal.stop ??= 'error'
        signal.error ??= coded(result.code, result.message)
      } else if (result.status === 'interrupted') {
        unit.state = 'pending'
      } else {
        unit.state = 'done'
        doneCount += 1
        say(ctx.stdout, `unit ${doneCount}/${total} done${isHoldout ? '' : ` (${unit.id})`}`)
      }
      round.spent = spentTokens(round.unitsRoot)
      saveRound(round)
      pump()
    }

    const startUnit = (unit) => {
      unit.state = 'running'
      active += 1
      saveRound(round)
      runUnit(unit, round).then(
        (result) => finishUnit(unit, result, null),
        (error) => finishUnit(unit, null, error)
      )
    }

    function pump() {
      while (active < jobs && signal.stop === null) {
        const unit = units.find(isReady)
        if (unit === undefined) break
        round.spent = spentTokens(round.unitsRoot)
        if (!canStart(round.spent, round.cap)) {
          signal.stop = 'budget'
          break
        }
        startUnit(unit)
      }
      if (active === 0) resolve()
    }
    pump()
  })
}

/** Ends the round on a status and returns its exit code. */
async function finishRound(round, ctx, signal) {
  const end = (status) => {
    round.status = status
    round.finishedAt = new Date().toISOString()
    round.spent = spentTokens(round.unitsRoot)
    saveRound(round)
  }
  if (signal.stop === 'interrupted') {
    end('interrupted')
    return EXIT.interrupted
  }
  if (signal.stop === 'error') {
    // No status names a failed round: it stopped short and `resume` picks it up.
    end('interrupted')
    return signal.error
  }
  end(signal.stop === 'budget' ? 'aborted-budget' : 'done')
  await ctx.writeRoundReport(round.roundId)
  return signal.stop === 'budget' ? EXIT.aborted : EXIT.done
}

/** Runs what is left of a round, with Ctrl-C ending the sessions and discarding their attempts. */
async function executeRound(round, ctx, signal) {
  await schedule(round, ctx, signal)
  return finishRound(round, ctx, signal)
}

function installInterrupt() {
  const signal = { stop: null, error: null }
  const onInterrupt = () => {
    // Outranks a budget stop or a unit's error: the operator asked to end it now.
    signal.stop = 'interrupted'
    void killAll()
  }
  process.once('SIGINT', onInterrupt)
  return { signal, remove: () => process.removeListener('SIGINT', onInterrupt) }
}

function clampJobs(requested, stderr) {
  const ceiling = jobsCeiling()
  if (requested === null || requested === undefined) return ceiling
  if (requested <= ceiling) return requested
  say(stderr, `--jobs ${requested} is above this machine's ceiling; using ${ceiling}.`)
  return ceiling
}

/** Resolves every contestant's sha now, so all units and a later resume use the same tools. */
async function resolvePins(contestants, args, roots, root) {
  const pins = {}
  for (const contestant of contestants) {
    const dest = join(root, '_round', `pin-${randomUUID()}`)
    try {
      const tool = await resolveTool(contestant, {
        skillRef: args.skillRef,
        repo: roots.repo,
        cacheRoot: roots.cache,
        dest
      })
      if (isCoded(tool)) return tool
      pins[contestant.id] = tool.sha
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  }
  return pins
}

const recordedArgs = (args, jobs) => ({
  problems: selectionOf(args.problems),
  withTlc: args.withTlc,
  skillRef: args.skillRef,
  repeats: args.repeats,
  judges: args.judges,
  model: args.model,
  operatorModel: args.operatorModel,
  judgeModel: args.judgeModel,
  budget: args.budget,
  jobs,
  seed: args.seed,
  dryRun: args.dryRun,
  after: args.after
})

/**
 * `run [flags]`: validate, then run every unit, then write the report.
 *
 * @param {object} args the filled flags, with the `roundId` `main` claimed
 * @param {object} ctx
 * @returns {Promise<number | { code: string, message: string }>}
 */
export async function runCommand(args, ctx) {
  const { roots } = ctx
  const { split, dryRun, roundId } = args
  const jobs = clampJobs(args.jobs, ctx.stderr)
  const contestants = dryRun
    ? registry.filter((c) => c.id === HARNU_SPEC)
    : selectContestants({ withTlc: args.withTlc })
  const root = unitsRoot(roots, split, roundId)

  const interrupt = installInterrupt()
  try {
    const validated = await loadValidated(
      { split, dryRun, wanted: selectionOf(args.problems) },
      ctx,
      () => interrupt.signal.stop !== null
    )
    if (isCoded(validated) || typeof validated === 'number') return validated

    const pins = await resolvePins(contestants, args, roots, root)
    if (isCoded(pins)) return pins

    const round = {
      roundId,
      split,
      dryRun,
      roots,
      contestants,
      args: recordedArgs(args, jobs),
      seed: args.seed ?? createHash('sha256').update(roundId).digest('hex'),
      repeats: args.repeats,
      judges: args.judges,
      models: ctx.models,
      pins,
      problems: validated.map((p) => ({ ...p, contentHash: contentHash(p.dir) })),
      unitsRoot: root,
      roundFile: join(repoRoundDir(roots, roundId), 'round.json'),
      privateDir: split === 'holdout' ? privateRoundDir(roots, roundId) : null,
      cap: args.budget,
      spent: spentTokens(root),
      status: 'running',
      jobs,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      units: []
    }
    round.units = buildUnits(round)
    if (split === 'holdout') writePrivateFiles(round)
    saveRound(round)
    return await executeRound(round, ctx, interrupt.signal)
  } finally {
    interrupt.remove()
  }
}

/**
 * `resume <round-id> [--budget <tokens>]`: rerun the units without a result file.
 *
 * @param {object} args
 * @param {object} ctx
 * @returns {Promise<number | { code: string, message: string }>}
 */
export async function resumeCommand(args, ctx) {
  const { roots } = ctx
  const roundId = args.positional[0]
  if (!roundId) return coded('USAGE', 'resume needs a round id.')
  const saved = readJsonOrNull(join(repoRoundDir(roots, roundId), 'round.json'))
  if (saved === null) return coded('ROUND_NOT_FOUND', `No round ${roundId}.`)

  const isHoldout = saved.split === 'holdout'
  const privateDir = isHoldout ? privateRoundDir(roots, roundId) : null
  const privateState = isHoldout ? readJsonOrNull(join(privateDir, 'problems.json')) : null
  if (isHoldout && privateState === null) {
    return coded('ROUND_NOT_FOUND', `Round ${roundId} has no private state in this holdout clone.`)
  }
  const recorded = isHoldout ? privateState.args : saved.args
  const hashes = isHoldout ? privateState.problems : saved.problems

  const interrupt = installInterrupt()
  try {
    const validated = await loadValidated(
      { split: saved.split, dryRun: saved.dryRun, wanted: hashes.map((p) => p.id) },
      ctx,
      () => interrupt.signal.stop !== null
    )
    if (isCoded(validated) || typeof validated === 'number') return validated

    const expected = new Map(hashes.map((p) => [p.id, p.contentHash]))
    const problems = validated.map((p) => ({ ...p, contentHash: contentHash(p.dir) }))
    if (problems.some((p) => p.contentHash !== expected.get(p.id))) {
      return coded('CORPUS_CHANGED', 'A problem of this round changed since the round started.')
    }

    const round = {
      roundId,
      split: saved.split,
      dryRun: saved.dryRun,
      roots,
      contestants: registry.filter((c) => c.id in saved.pins),
      args: recorded,
      seed: saved.seed,
      repeats: saved.repeats,
      judges: saved.judges,
      models: saved.models,
      pins: saved.pins,
      problems,
      unitsRoot: unitsRoot(roots, saved.split, roundId),
      roundFile: join(repoRoundDir(roots, roundId), 'round.json'),
      privateDir,
      cap: Math.max(saved.budget.cap, args.budget ?? 0),
      spent: 0,
      status: 'running',
      jobs: Math.min(recorded.jobs, jobsCeiling()),
      startedAt: saved.startedAt,
      finishedAt: null,
      units: []
    }
    round.units = buildUnits(round)
    round.spent = spentTokens(round.unitsRoot)
    saveRound(round)
    return await executeRound(round, ctx, interrupt.signal)
  } finally {
    interrupt.remove()
  }
}
