/**
 * `compare <baseline> <candidate>`: the acceptance verdict for two rounds of one split, for
 * `harnu-spec` only. "The acceptance rule" and "Freshness" in
 * `docs/specs/2026-11-07-bakeoff-harness/spec.md` are the contract.
 *
 * On a holdout comparison nothing printed names a problem: aggregates and counters only. A
 * refusal (exit 2) writes nothing.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { privateRoundDir, repoRoundDir } from './paths.mjs'

const HARNU_SPEC = 'harnu-spec'
const FLOOR_POINTS = 2
/** Pass rates are doubles: a gain of exactly the tolerance can land a hair to either side of it. */
const EPSILON_POINTS = 1e-9
const MAX_ACCEPTED_USES = 3
const COMPARED_MODELS = ['contestant', 'operator', 'judge']

const coded = (code, message) => ({ code, message })
const isCoded = (value) => typeof value === 'object' && value !== null && 'code' in value
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length
const fixed2 = (value) => value.toFixed(2)

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
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

/** The first field the rule compares on which the rounds differ, or null. */
function firstDifference(base, cand) {
  for (const model of COMPARED_MODELS) {
    if (base.models[model] !== cand.models[model]) return `models.${model}`
  }
  if (base.judges !== cand.judges) return 'judges'
  if (base.repeats !== cand.repeats) return 'repeats'
  const contestants = [...new Set([...Object.keys(base.pins), ...Object.keys(cand.pins)])].sort()
  for (const id of contestants) {
    if (id !== HARNU_SPEC && base.pins[id] !== cand.pins[id]) return `pins.${id}`
  }
  return null
}

/** Per problem: real id, content hash, and `harnu-spec`'s unrounded hidden pass rate. */
function devProblems(roundDir, round) {
  const report = readJsonOrNull(join(roundDir, 'report.json'))
  if (report === null) return coded('REPORT_MISSING', `Round ${round.roundId} has no report.json.`)
  const rows = new Map(
    report.measures.hiddenPassRate.rows
      .filter((row) => row.contestant === HARNU_SPEC)
      .map((row) => [row.problem, row])
  )
  return round.problems.map((problem) => ({
    id: problem.id,
    hash: problem.contentHash,
    mean: rows.get(problem.id)?.mean ?? null,
    spread: rows.get(problem.id)?.spread ?? null
  }))
}

function holdoutProblems(roots, round) {
  const state = readJsonOrNull(join(privateRoundDir(roots, round.roundId), 'problems.json'))
  if (state === null) {
    return coded('ROUND_NOT_FOUND', `Round ${round.roundId} has no state in this holdout clone.`)
  }
  return state.problems.map((problem) => {
    const measure = problem.contestants[HARNU_SPEC]?.measures?.hiddenPassRate
    return {
      id: problem.id,
      hash: problem.contentHash,
      mean: measure?.mean ?? null,
      spread: measure?.spread ?? null
    }
  })
}

function problemsOf(roundDir, round, roots) {
  const problems =
    round.split === 'holdout' ? holdoutProblems(roots, round) : devProblems(roundDir, round)
  if (isCoded(problems)) return problems
  return problems.every((p) => p.mean === null)
    ? coded('REPORT_MISSING', `Round ${round.roundId} has no scores; run report first.`)
    : problems
}

/** The problems of both rounds with the same real id, the same hash and a score in each. */
function sharedPairs(baseProblems, candProblems) {
  const candidates = new Map(candProblems.map((p) => [p.id, p]))
  const pairs = []
  for (const base of baseProblems) {
    const cand = candidates.get(base.id)
    if (cand && cand.hash === base.hash && base.mean !== null && cand.mean !== null) {
      pairs.push({ base, cand })
    }
  }
  return pairs
}

const incomplete = (fields) => ({
  ...fields,
  verdict: 'incomplete',
  gain: null,
  spread: null,
  shared: []
})

/**
 * @param {string} baselineRoundId
 * @param {string} candidateRoundId
 * @param {{ roots: object }} ctx
 * @returns {{ verdict: string, gain: number | null, spread: number | null, shared: string[],
 *   split: string, baselineSkillSha: string, candidateSkillSha: string, baseline: object | null,
 *   candidate: object | null } | { code: string, message: string }} `shared` holds content hashes,
 *   never a problem id
 */
export function compareRounds(baselineRoundId, candidateRoundId, ctx) {
  const { roots } = ctx
  const baseDir = repoRoundDir(roots, baselineRoundId)
  const candDir = repoRoundDir(roots, candidateRoundId)
  const base = readJsonOrNull(join(baseDir, 'round.json'))
  const cand = readJsonOrNull(join(candDir, 'round.json'))
  if (base === null) return coded('ROUND_NOT_FOUND', `No round ${baselineRoundId}.`)
  if (cand === null) return coded('ROUND_NOT_FOUND', `No round ${candidateRoundId}.`)

  if (base.split !== cand.split) return coded('ROUNDS_DIFFER', 'The rounds differ on split.')

  const fields = {
    split: base.split,
    baselineSkillSha: base.pins[HARNU_SPEC],
    candidateSkillSha: cand.pins[HARNU_SPEC],
    baseline: null,
    candidate: null
  }
  if (base.dryRun || cand.dryRun || base.status !== 'done' || cand.status !== 'done') {
    return incomplete(fields)
  }

  const differs = firstDifference(base, cand)
  if (differs !== null) return coded('ROUNDS_DIFFER', `The rounds differ on ${differs}.`)

  const isHoldout = base.split === 'holdout'
  if (isHoldout && roots.holdout === null) {
    return coded('HOLDOUT_UNSET', 'A holdout comparison needs HARNU_BAKEOFF_HOLDOUT.')
  }

  const baseProblems = problemsOf(baseDir, base, roots)
  if (isCoded(baseProblems)) return baseProblems
  const candProblems = problemsOf(candDir, cand, roots)
  if (isCoded(candProblems)) return candProblems
  const pairs = sharedPairs(baseProblems, candProblems)
  if (pairs.length === 0) {
    return coded('NO_SHARED_PROBLEMS', 'The rounds share no problem with the same content.')
  }

  const summaryOf = (pick) => ({
    mean: mean(pairs.map((pair) => pick(pair).mean)),
    spread: mean(pairs.map((pair) => pick(pair).spread)),
    n: pairs.length
  })
  const baseline = summaryOf((pair) => pair.base)
  const candidate = summaryOf((pair) => pair.cand)
  const gain = mean(pairs.map(({ base: b, cand: c }) => c.mean - b.mean))
  const spread = Math.max(baseline.spread, candidate.spread, FLOOR_POINTS)
  const accepted = isHoldout ? gain >= -spread - EPSILON_POINTS : gain > spread + EPSILON_POINTS
  return {
    ...fields,
    baseline,
    candidate,
    verdict: accepted ? 'accepted' : 'rejected',
    gain,
    spread,
    shared: pairs.map((pair) => pair.base.hash).sort()
  }
}

/** Counts an accepted holdout pair once and warns when a problem has been used too often. */
function recordHoldoutUse(pair, shared, ctx) {
  const file = join(ctx.roots.holdout, '.rounds', 'usage.json')
  const usage = readJsonOrNull(file) ?? { counts: {}, pairs: [] }
  if (!usage.pairs.includes(pair)) {
    for (const hash of shared) usage.counts[hash] = (usage.counts[hash] ?? 0) + 1
    usage.pairs.push(pair)
    writeJsonAtomic(file, usage)
  }
  const overused = shared.filter((hash) => usage.counts[hash] > MAX_ACCEPTED_USES).length
  if (overused > 0) {
    const noun = overused === 1 ? 'problem' : 'problems'
    ctx.stdout.write(
      `warning: ${overused} holdout ${noun} used in more than ${MAX_ACCEPTED_USES} accepted comparisons; author a fresh one.\n`
    )
  }
}

function printResult(result, ctx) {
  const { stdout } = ctx
  stdout.write(`split: ${result.split}\n`)
  if (result.verdict !== 'incomplete') {
    const line = (name, side) =>
      `${HARNU_SPEC} ${name}: mean ${fixed2(side.mean)} spread ${fixed2(side.spread)} n ${side.n}\n`
    stdout.write(line('baseline', result.baseline))
    stdout.write(line('candidate', result.candidate))
    const noun = result.split === 'holdout' ? 'delta' : 'gain'
    stdout.write(`${noun} ${fixed2(result.gain)}, tolerance ${fixed2(result.spread)}\n`)
  }
  stdout.write(`verdict: ${result.verdict}\n`)
}

/**
 * @param {{ positional: string[] }} args
 * @param {object} ctx
 * @returns {number | { code: string, message: string }}
 */
export function compareCommand(args, ctx) {
  const [baseline, candidate] = args.positional
  if (!baseline || !candidate) return coded('USAGE', 'compare needs two round ids.')

  const result = compareRounds(baseline, candidate, ctx)
  if (isCoded(result)) return result

  writeJsonAtomic(join(repoRoundDir(ctx.roots, candidate), 'compare.json'), {
    split: result.split,
    verdict: result.verdict,
    baseline,
    candidate,
    baselineSkillSha: result.baselineSkillSha,
    candidateSkillSha: result.candidateSkillSha
  })
  printResult(result, ctx)
  if (result.split === 'holdout' && result.verdict === 'accepted') {
    recordHoldoutUse(`${baseline}:${candidate}`, result.shared, ctx)
  }
  return result.verdict === 'accepted' ? 0 : 1
}
