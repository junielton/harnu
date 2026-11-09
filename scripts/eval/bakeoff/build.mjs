/**
 * The build test: one builder session implements a contestant's artifact in a fresh checkout,
 * then the hidden suite, which the builder never saw, is copied in and run twice. See "The build"
 * in `docs/specs/2026-11-07-bakeoff-harness/spec.md`.
 */
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  appendFileSync
} from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkoutTarget, runProblemCommand } from './checkout.mjs'
import { moveTranscripts, runClaude } from './claude.mjs'
import { parseJunit, passedNames } from './junit.mjs'
import { limits } from './limits.mjs'
import { sumUsage } from './usage.mjs'

const BUILDER_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']
const PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'prompts', 'builder.md')
const ZERO_USAGE = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 }
const HIDDEN_RUNS = 2

export const shellQuote = (text) => `'${text.replaceAll("'", `'\\''`)}'`

/** Fills `{{NAME}}` in one pass: text pasted in from a value is never itself expanded. */
const fill = (template, values) =>
  template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name) => values[name] ?? whole)

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const aside = `${path}.tmp-${randomUUID()}`
  writeFileSync(aside, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(aside, path)
}

/** Every file of the artifact as a sorted relative path; none when the directory is absent. */
function artifactFiles(artifactDir) {
  let entries
  try {
    entries = readdirSync(artifactDir, { recursive: true, withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(artifactDir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
}

/** Copy the problem's hidden files to `hidden.dest` in `clone`, over anything already there. */
export function copyHiddenFiles(problem, clone) {
  for (const file of problem.hidden.files) {
    cpSync(join(problem.dir, 'hidden', file), join(clone, problem.hidden.dest, file))
  }
}

/**
 * Run the hidden command once, writing its JUnit XML to `junitPath` (outside the clone).
 *
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, xml: string | null, junit: object | null }>}
 *   `xml` and `junit` are null when no file was written; `junit` may be a coded error
 */
export async function runHiddenCommand(problem, clone, junitPath) {
  rmSync(junitPath, { force: true })
  const run = await runProblemCommand(problem.hidden.cmd, clone, {
    timeoutMs: limits.commandMs,
    env: { BAKEOFF_JUNIT: junitPath }
  })
  const xml = existsSync(junitPath) ? readFileSync(junitPath, 'utf8') : null
  return { ...run, xml, junit: xml === null ? null : parseJunit(xml) }
}

const readable = (junit) => junit !== null && !('code' in junit)

/** Score the validated test set from the hidden runs; see "The build". */
function scoreHidden(testSet, junits) {
  const runs = junits.map((junit) => (readable(junit) ? passedNames(junit.testcases) : null))
  const failed = []
  const flaky = []
  for (const name of testSet) {
    const results = runs.map((run) => run?.get(name) === true)
    if (results.every(Boolean)) continue
    failed.push(name)
    // An unreadable run fails everything, which says nothing about this test's stability.
    if (results.some(Boolean) && runs.every((run) => run !== null)) flaky.push(name)
  }
  return { passed: testSet.length - failed.length, total: testSet.length, flaky, failed }
}

/** Runs a git command in the clone. Identity and signing come from the clone's own config. */
const gitIn = (clone, command) =>
  runProblemCommand(`git ${command}`, clone, {
    timeoutMs: limits.commandMs,
    env: { GIT_LITERAL_PATHSPECS: '1' }
  })

/**
 * Hides what `setup` left (a virtualenv, `node_modules`) from `git add -A`, so neither the
 * builder's commit nor the implementation patch carries it.
 */
async function excludeSetupOutput(clone) {
  const status = await gitIn(clone, 'status --porcelain -z')
  const patterns = status.stdout
    .split('\0')
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => `/${entry.slice(3).replace(/[\\*?[! #]/g, '\\$&')}`)
  if (patterns.length === 0) return
  mkdirSync(join(clone, '.git/info'), { recursive: true })
  appendFileSync(join(clone, '.git/info/exclude'), `${patterns.join('\n')}\n`)
}

/** Copies the artifact in and commits it, with any tracked file `setup` rewrote. */
async function commitSpecBundle(clone, artifactDir, paths) {
  for (const command of [
    'config user.name bakeoff',
    'config user.email bakeoff@example.invalid',
    'config commit.gpgsign false'
  ]) {
    await gitIn(clone, command)
  }
  await excludeSetupOutput(clone)
  for (const path of paths) {
    cpSync(join(artifactDir, path), join(clone, path), { verbatimSymlinks: true })
  }
  const add = await gitIn(clone, `add -f -- ${paths.map(shellQuote).join(' ')}`)
  if (add.exitCode !== 0) return null
  await gitIn(clone, 'add -u')
  const commit = await gitIn(clone, "commit -q --allow-empty -m 'spec bundle'")
  if (commit.exitCode !== 0) return null
  const head = await gitIn(clone, 'rev-parse HEAD')
  return head.exitCode === 0 ? head.stdout.trim() : null
}

/** Saves what the builder changed against the spec bundle, committed by it or not. */
async function captureImplementation(clone, buildDir, specCommit) {
  // A killed `git commit` leaves this behind, and it would make the staging below fail.
  rmSync(join(clone, '.git/index.lock'), { force: true })
  await gitIn(clone, 'add -A')
  const patch = await gitIn(clone, `diff --cached --binary ${specCommit}`)
  writeFileSync(join(buildDir, 'implementation.patch'), patch.stdout)
  const stat = await gitIn(clone, `diff --cached --stat ${specCommit}`)
  return stat.stdout.trim()
}

/** Copies `ASSUMPTIONS.md` out and counts its numbered items; 0 when the file is missing. */
function captureAssumptions(clone, buildDir) {
  const source = join(clone, 'ASSUMPTIONS.md')
  if (!existsSync(source)) return 0
  cpSync(source, join(buildDir, 'ASSUMPTIONS.md'))
  return readFileSync(source, 'utf8').match(/^\d+\. /gm)?.length ?? 0
}

/** The per-attempt files of a previous, interrupted build. Its discarded usage stays. */
function clearAttempt(unitDir, buildDir) {
  rmSync(join(unitDir, 'build-clone'), { recursive: true, force: true })
  rmSync(join(unitDir, 'transcripts', 'builder'), { recursive: true, force: true })
  if (!existsSync(buildDir)) return
  for (const name of readdirSync(buildDir)) {
    if (name !== 'discarded.json') rmSync(join(buildDir, name), { recursive: true, force: true })
  }
}

function nextDiscardNumber(unitDir) {
  const root = join(unitDir, 'discarded')
  if (!existsSync(root)) return 1
  return Math.max(0, ...readdirSync(root).map((n) => Number.parseInt(n, 10) || 0)) + 1
}

/** Moves an interrupted session's evidence aside and appends its usage to the unit's own file. */
function discardAttempt({ problem, unitDir }, buildDir, sessionId) {
  const dest = join(unitDir, 'discarded', String(nextDiscardNumber(unitDir)))
  const builderDir = join(dest, 'builder')
  moveTranscripts([sessionId], builderDir)
  mkdirSync(dest, { recursive: true })
  const stream = join(buildDir, 'stream.jsonl')
  if (existsSync(stream)) renameSync(stream, join(dest, 'stream.jsonl'))

  const contestant = basename(dirname(unitDir))
  const file = join(buildDir, 'discarded.json')
  const entries = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  entries.push({
    unit: `${problem.id}/${contestant}/${basename(unitDir)}/build`,
    phase: 'build',
    contestant,
    usage: sumUsage(builderDir)
  })
  writeJsonAtomic(file, entries)
}

/**
 * Run one build to its end and write `build.json`.
 *
 * Returns that object. Two cases write no file, so a resume runs the unit again: a checkout or
 * setup that could not be prepared (the coded error is returned) and a `killAll`, which returns
 * `{ status: 'interrupted' }` after discarding the attempt.
 *
 * @param {object} args `{ problem, unitDir, artifactDir, roots, model, testSet }`
 * @returns {Promise<object>}
 */
export async function runBuild(args) {
  const { problem, unitDir, artifactDir, roots, model, testSet } = args
  const started = Date.now()
  const buildDir = join(unitDir, 'build')
  const clone = join(unitDir, 'build-clone')
  const finish = (result) => {
    writeJsonAtomic(join(unitDir, 'build.json'), result)
    return result
  }

  const paths = artifactFiles(artifactDir)
  if (paths.length === 0) {
    return finish({
      status: 'not-run',
      reason: 'empty-artifact',
      hidden: { passed: 0, total: testSet.length, flaky: [], failed: [...testSet] },
      existing: { exitCode: null },
      assumptions: 0,
      diffstat: '',
      usage: { ...ZERO_USAGE },
      wallMs: 0
    })
  }

  clearAttempt(unitDir, buildDir)
  mkdirSync(buildDir, { recursive: true })
  const checkout = await checkoutTarget(problem, clone, { cacheRoot: roots.cache })
  if ('code' in checkout) return checkout
  const specCommit = await commitSpecBundle(clone, artifactDir, paths)
  if (specCommit === null) {
    return { code: 'CHECKOUT_FAILED', message: 'The artifact could not be committed.' }
  }

  const sessionId = randomUUID()
  const session = await runClaude({
    role: 'builder',
    prompt: fill(readFileSync(PROMPT_PATH, 'utf8').trim(), {
      ARTIFACT_PATHS: paths.join('\n'),
      TEST_COMMAND: problem.test
    }),
    cwd: clone,
    model,
    tools: BUILDER_TOOLS,
    addDirs: [],
    sessionId,
    deadlineMs: limits.invocationMs.builder,
    maxTurns: limits.maxTurns.builder,
    streamPath: join(buildDir, 'stream.jsonl')
  })
  if (session.interrupted) {
    discardAttempt(args, buildDir, sessionId)
    return { status: 'interrupted' }
  }

  const transcripts = join(unitDir, 'transcripts', 'builder')
  moveTranscripts([sessionId], transcripts)
  const diffstat = await captureImplementation(clone, buildDir, specCommit)
  const assumptions = captureAssumptions(clone, buildDir)

  // The builder has ended: only now may the hidden files exist in its clone.
  copyHiddenFiles(problem, clone)
  const junits = []
  for (let run = 1; run <= HIDDEN_RUNS; run++) {
    const { junit } = await runHiddenCommand(problem, clone, join(buildDir, `hidden-${run}.xml`))
    junits.push(junit)
  }

  const existing = await runProblemCommand(problem.test, clone, { timeoutMs: limits.commandMs })
  writeFileSync(join(buildDir, 'existing-suite.txt'), existing.stdout + existing.stderr)

  return finish({
    status: session.status === 'result' ? 'done' : 'failed',
    reason: null,
    hidden: scoreHidden(testSet, junits),
    existing: { exitCode: existing.exitCode },
    assumptions,
    diffstat,
    usage: sumUsage(transcripts),
    wallMs: Date.now() - started
  })
}
