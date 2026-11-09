/**
 * Proves a problem's hidden suite before any round spends tokens on it: it must fail on the
 * pristine target and pass, stably, on the reference patch. See "Validation" in
 * `docs/specs/2026-11-07-bakeoff-harness/spec.md`.
 *
 * A failed holdout problem is detailed only in its `<key>.json` under the work root: the terminal
 * gets a count, never an id, a label or a test name.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { copyHiddenFiles, runHiddenCommand, shellQuote } from './build.mjs'
import { checkoutTarget, runProblemCommand } from './checkout.mjs'
import { contentHash, loadCorpus } from './corpus.mjs'
import { hasCollectionError, passedNames } from './junit.mjs'
import { limits } from './limits.mjs'
import { validationRoot } from './paths.mjs'

const REFERENCE_RUNS = 3

const DETAIL_CHARS = 4000

/** `extra` is `{ tests }` or `{ detail }`: the output, kept only in the private `<key>.json`. */
const defect = (code, message, extra = {}) => ({ code, message, ...extra })
const coded = (code, message) => ({ code, message })
const outputTail = (run) => (run.stdout + run.stderr).slice(-DETAIL_CHARS)

/** A `.json` result, or null when it is absent, unreadable, or not to be trusted as a verdict. */
function readCached(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed.transient ? null : parsed
  } catch {
    return null
  }
}

function writeResult(path, value) {
  const aside = `${path}.tmp-${randomUUID()}`
  writeFileSync(aside, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(aside, path)
}

/**
 * A fresh checkout with `setup` run under the validation limit.
 *
 * @returns {Promise<{ dir: string } | { defect: object, transient?: boolean }>}
 */
async function preparedCheckout(problem, dest, roots) {
  const checkout = await checkoutTarget(problem, dest, { cacheRoot: roots.cache, setup: false })
  if ('code' in checkout) {
    // A network failure says nothing about the problem, so it must not stick to its key.
    const detail = checkout.detail
    return { defect: defect(checkout.code, checkout.message, { detail }), transient: true }
  }
  for (const [i, cmd] of problem.setup.entries()) {
    const run = await runProblemCommand(cmd, dest, { timeoutMs: limits.validationMs })
    const place = `Setup command ${i + 1} of ${problem.setup.length}`
    if (run.timedOut) return { defect: defect('SETUP_TIMEOUT', `${place} reached the limit.`) }
    if (run.exitCode !== 0) {
      const detail = outputTail(run)
      return { defect: defect('SETUP_FAILED', `${place} exited ${run.exitCode}.`, { detail }) }
    }
  }
  return { dir: dest }
}

const namesWithStatus = (testcases, status) =>
  [...new Set(testcases.filter((t) => t.status === status).map((t) => t.name))].sort()

/** The one defect of a pristine run, or null when the suite fails the way it must. */
function pristineDefect(problem, run) {
  const compileError = new RegExp(problem.hidden.compileErrorPattern)
  // Only a run that reported no testcase can be a compile failure: one that reported any is
  // judged by them, or a suite that passes on pristine could exit 1 and print the pattern.
  const noTestcases = run.junit === null || 'code' in run.junit || run.junit.testcases.length === 0
  const matches = compileError.test(run.stdout) || compileError.test(run.stderr)
  if (run.exitCode !== 0 && noTestcases && matches) return null
  if (run.junit === null) {
    const detail = outputTail(run)
    return defect('PRISTINE_JUNIT_MISSING', 'No JUnit XML was written.', { detail })
  }
  if ('code' in run.junit) return defect('PRISTINE_JUNIT_CORRUPT', 'The JUnit XML is corrupt.')
  if (hasCollectionError(run.xml)) {
    return defect('PRISTINE_COLLECTION_FAILURE', 'The hidden suite failed at collection.')
  }
  const { testcases } = run.junit
  if (testcases.length === 0) {
    return defect('PRISTINE_NO_TESTCASES', 'The hidden suite reported no testcase.')
  }
  if (testcases.some((t) => t.status === 'failed')) return null
  if (testcases.every((t) => t.status === 'passed')) {
    const tests = namesWithStatus(testcases, 'passed')
    return defect('PRISTINE_PASSES', 'The hidden suite passes on the pristine checkout.', { tests })
  }
  return defect('PRISTINE_NO_FAILURE', 'No hidden test has a failure on the pristine checkout.')
}

async function checkPristine(problem, dir, junitPath) {
  copyHiddenFiles(problem, dir)
  return pristineDefect(problem, await runHiddenCommand(problem, dir, junitPath))
}

/** Judges the reference runs: `{ defect }` or `{ testSet }`. */
function judgeReferenceRuns(runs) {
  for (const run of runs) {
    const { junit } = run
    if (junit === null) {
      const detail = outputTail(run)
      return {
        defect: defect('REFERENCE_JUNIT_MISSING', 'A reference run wrote no JUnit XML.', { detail })
      }
    }
    if ('code' in junit) {
      return { defect: defect('REFERENCE_JUNIT_CORRUPT', 'A reference run wrote corrupt XML.') }
    }
    if (junit.testcases.length === 0) {
      return { defect: defect('REFERENCE_NO_TESTCASES', 'A reference run reported no testcase.') }
    }
  }
  const perRun = runs.map((run) => passedNames(run.junit.testcases))
  const names = [...new Set(perRun.flatMap((run) => [...run.keys()]))].sort()
  const passes = (name) => perRun.map((run) => run.get(name) === true)
  const flipped = names.filter((name) => {
    const results = passes(name)
    return results.some(Boolean) && !results.every(Boolean)
  })
  if (flipped.length > 0) {
    const message = 'A test flipped across the reference runs.'
    return { defect: defect('REFERENCE_FLAKY', message, { tests: flipped }) }
  }
  const failing = names.filter((name) => !passes(name).some(Boolean))
  if (failing.length > 0) {
    const message = 'A test fails on the reference patch.'
    return { defect: defect('REFERENCE_FAILED', message, { tests: failing }) }
  }
  return { testSet: names }
}

/** Applies the reference, runs the hidden command 3 times, then the target's own suite. */
async function checkReference(problem, dir, scratch) {
  const patch = join(problem.dir, 'hidden', 'reference.patch')
  const apply = await runProblemCommand(`git apply ${shellQuote(patch)}`, dir)
  if (apply.exitCode !== 0) {
    const detail = outputTail(apply)
    return {
      defect: defect('REFERENCE_PATCH_FAILED', 'The reference patch does not apply.', { detail })
    }
  }
  copyHiddenFiles(problem, dir)

  const runs = []
  for (let n = 1; n <= REFERENCE_RUNS; n++) {
    runs.push(await runHiddenCommand(problem, dir, join(scratch, `reference-${n}.xml`)))
  }
  const judged = judgeReferenceRuns(runs)
  if (judged.defect) return judged

  const suite = await runProblemCommand(problem.test, dir, { timeoutMs: limits.validationMs })
  if (suite.timedOut)
    return { defect: defect('TEST_TIMEOUT', 'The test command reached the limit.') }
  if (suite.exitCode !== 0) {
    const message = `The existing suite exited ${suite.exitCode}.`
    return { defect: defect('EXISTING_SUITE_FAILED', message, { detail: outputTail(suite) }) }
  }
  return judged
}

/** Runs every check of a stale key. */
async function runChecks(problem, roots, scratch) {
  const defects = []
  const pristine = await preparedCheckout(problem, join(scratch, 'pristine'), roots)
  if ('defect' in pristine) {
    return { defects: [pristine.defect], testSet: [], transient: pristine.transient === true }
  }
  const pristineFault = await checkPristine(problem, pristine.dir, join(scratch, 'pristine.xml'))
  if (pristineFault !== null) defects.push(pristineFault)

  const reference = await preparedCheckout(problem, join(scratch, 'reference'), roots)
  if ('defect' in reference) {
    defects.push(reference.defect)
    return { defects, testSet: [], transient: reference.transient === true }
  }
  const judged = await checkReference(problem, reference.dir, scratch)
  if (judged.defect) defects.push(judged.defect)
  return { defects, testSet: defects.length === 0 ? judged.testSet : [], transient: false }
}

/**
 * Validate one problem, running its commands only when its cache key is stale.
 *
 * @param {object} problem a parsed `problem.json` plus `dir`
 * @param {object} roots
 * @returns {Promise<{ ok: boolean, key: string, testSet: string[], defects: { code: string, message: string, tests?: string[] }[] }>}
 */
export async function validateProblem(problem, roots) {
  const root = validationRoot(roots, problem.split)
  mkdirSync(root, { recursive: true })
  const scratch = join(root, `.scratch-${randomUUID()}`)
  mkdirSync(scratch)
  try {
    // Before any `setup`, so it can only name what is already on the machine.
    const versions = await runProblemCommand(problem.versions, scratch)
    const key = createHash('sha256')
      .update(contentHash(problem.dir))
      .update(versions.stdout)
      .digest('hex')
    const resultPath = join(root, `${key}.json`)
    const cached = readCached(resultPath)
    if (cached !== null) return cached

    const checked =
      versions.exitCode === 0
        ? await runChecks(problem, roots, scratch)
        : {
            defects: [
              defect('VERSIONS_FAILED', `The versions command exited ${versions.exitCode}.`)
            ],
            testSet: [],
            transient: false
          }
    const result = {
      ok: checked.defects.length === 0,
      key,
      testSet: checked.testSet,
      defects: checked.defects
    }
    writeResult(resultPath, checked.transient ? { ...result, transient: true } : result)
    return result
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function say(stream, line) {
  if (typeof stream === 'function') stream(`${line}\n`)
  else stream.write(`${line}\n`)
}

const selectionOf = (problems) =>
  typeof problems === 'string' ? problems.split(',').filter(Boolean) : (problems ?? null)

/** The problem directory an error of `loadCorpus` belongs to. */
const problemOfError = (error) => error.file.split(/[\\/]/)[0]

function describeDefect(id, { code, message, tests }) {
  const names = tests && tests.length > 0 ? ` (${tests.join(', ')})` : ''
  return `${id}: ${code}: ${message}${names}`
}

/**
 * `validate [--split] [--problems]`: validation only.
 *
 * @param {object} args `{ split, problems, positional }`
 * @param {object} ctx `{ roots, stdout, stderr }`
 * @returns {Promise<number | { code: string, message: string }>}
 */
export async function validateCommand(args, ctx) {
  const split = args.split ?? 'dev'
  const isHoldout = split === 'holdout'
  const selection = selectionOf(args.problems)
  if (isHoldout && selection !== null) {
    return coded('PROBLEMS_ON_HOLDOUT', '--problems is refused with --split holdout.')
  }
  const { roots } = ctx
  if (isHoldout && !roots.holdout) {
    return coded('HOLDOUT_UNSET', 'A holdout split needs HARNU_BAKEOFF_HOLDOUT.')
  }
  const root = isHoldout ? roots.holdout : join(roots.repo, 'scripts/eval/bakeoff/corpus/dev')

  const { problems, errors } = loadCorpus(root, { split })
  const brokenIds = [...new Set(errors.map(problemOfError))]
  if (selection !== null) {
    const known = new Set([...problems.map((p) => p.id), ...brokenIds])
    const unknown = selection.filter((id) => !known.has(id))
    if (unknown.length > 0)
      return coded('PROBLEM_UNKNOWN', `Unknown problem: ${unknown.join(', ')}.`)
  }
  const selected = (id) => selection === null || selection.includes(id)
  const toValidate = problems.filter((p) => selected(p.id))
  const refused = errors.filter((e) => selected(problemOfError(e)))
  const refusedIds = brokenIds.filter(selected)

  if (!isHoldout) {
    for (const error of refused) say(ctx.stderr, `${error.code}: ${error.message} [${error.file}]`)
  }

  let failed = refusedIds.length
  const total = toValidate.length + refusedIds.length
  for (const [i, problem] of toValidate.entries()) {
    const result = await validateProblem(problem, roots)
    if (!result.ok) failed += 1
    if (isHoldout) {
      say(ctx.stderr, `problem ${i + 1}/${toValidate.length} checked`)
    } else if (result.ok) {
      say(ctx.stdout, `${problem.id}: ok (${result.testSet.length} tests)`)
    } else {
      for (const entry of result.defects) say(ctx.stderr, describeDefect(problem.id, entry))
      say(
        ctx.stderr,
        `${problem.id}: details in ${join(validationRoot(roots, split), `${result.key}.json`)}`
      )
    }
  }

  if (failed > 0) {
    say(ctx.stderr, `${failed} of ${total} ${split} problems failed validation`)
    return 2
  }
  say(ctx.stdout, `${total} of ${total} ${split} problems validated`)
  return 0
}
