/**
 * Authoring a corpus problem without ever showing its author the skill under test (D-7, rule 7).
 *
 * `author-sandbox` builds an isolated directory: a copy of this repository minus every file that
 * names or describes the skill, the pinned target, and a skeleton of the problem. The authoring
 * session runs there. `author-import` copies the finished problem into its corpus root, adds the
 * reference patch the session never saw, stamps it and validates it. `review` is the operator's
 * reading of the answer sheet. "The author sandbox" in
 * `docs/specs/2026-11-07-bakeoff-harness/spec.md` is the contract.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { checkoutTarget, runProblemCommand } from './checkout.mjs'
import { loadCorpus } from './corpus.mjs'
import { authoringRoot } from './paths.mjs'
import { validateProblem } from './validate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const AUTHOR_PROMPT = join(HERE, 'prompts', 'author.md')
const DEV_CORPUS = 'scripts/eval/bakeoff/corpus/dev'
const ID_RE = /^[a-z0-9-]+$/

const AUTHORING_COMMAND =
  'claude -p --model opus --tools Read,Write,Edit,Bash,Glob,Grep --allowedTools Read,Write,Edit,Bash,Glob,Grep --setting-sources project --max-turns 200'
const AUTHORING_PROMPT =
  'Read AUTHORING.md and do what it says. Stop when every file it lists exists.'

/**
 * Paths of this repository that name or describe the skill. A rule, not a snapshot: a PR that adds
 * a doc naming the skill extends this list in the same PR, and a test greps the built sandbox.
 */
export const EXCLUSIONS = [
  'resources/skills/**',
  'docs/specs/**',
  'docs/prds/T601*',
  'docs/prds/T676*',
  'docs/adr/0025-bakeoff-harness.md',
  'docs/harnu-features.md',
  'docs/user/bundled-skills.md',
  'docs/dev/bakeoff.md',
  'docs/lessons/**',
  '.harnu/**',
  'CHANGELOG.md',
  'scripts/eval/bakeoff/**',
  'tests/eval-bakeoff-*',
  'tests/fixtures/eval-bakeoff/**',
  'tests/fixtures/spec-check/**',
  'tests/fixtures/spec-skill/**',
  'tests/spec-*.test.ts',
  'tests/bundled-spec-skill.test.ts',
  'tests/orchestrate-spec-integration.test.ts'
]

const coded = (code, message) => ({ code, message })
const say = (stream, line) => stream.write(`${line}\n`)

function globToRegExp(glob) {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*$/, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace('\u0000', '.*')
  return new RegExp(`^${body}$`)
}

const EXCLUSION_RES = EXCLUSIONS.map(globToRegExp)
const isExcluded = (rel) => EXCLUSION_RES.some((re) => re.test(rel))

/** Every file and symlink under `dir`, as POSIX-style paths relative to it. */
function listTree(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? listTree(full, base) : [relative(base, full).split(sep).join('/')]
  })
}

/** Removes every directory under `dir` left empty, deepest first. */
function pruneEmptyDirs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    pruneEmptyDirs(full)
    if (readdirSync(full).length === 0) rmdirSync(full)
  }
}

/** A readable, non-empty regular file? */
function hasContent(path) {
  try {
    const stat = statSync(path)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

/** `git archive HEAD` of the repository, extracted into `dest`, minus the exclusion list. */
async function extractHarnu(repo, dest) {
  mkdirSync(dest, { recursive: true })
  const scratch = mkdtempSync(join(dirname(dest), '.archive-'))
  const tarball = join(scratch, 'head.tar')
  try {
    const archive = await runProblemCommand(
      `git archive --format=tar --output='${tarball}' HEAD`,
      repo
    )
    if (archive.exitCode !== 0)
      return coded('ARCHIVE_FAILED', `git archive failed: ${archive.stderr}`)
    const extract = await runProblemCommand(`tar -xf '${tarball}' -C '${dest}'`, repo)
    if (extract.exitCode !== 0) return coded('ARCHIVE_FAILED', `tar failed: ${extract.stderr}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  for (const rel of listTree(dest)) {
    if (isExcluded(rel)) rmSync(join(dest, rel), { force: true })
  }
  pruneEmptyDirs(dest)
  return null
}

function checkId(id) {
  if (typeof id === 'string' && ID_RE.test(id)) return null
  return coded('ID_INVALID', 'The problem id must match [a-z0-9-]+.')
}

/**
 * `author-sandbox <id> --split <dev|holdout> --repo <url> --commit <sha> --pick <file>`.
 *
 * @param {object} args `{ positional, split, repo, commit, pick }`
 * @param {object} ctx `{ roots, stdout }`
 * @returns {Promise<number | { code: string, message: string }>}
 */
export async function authorSandboxCommand(args, ctx) {
  const [id] = args.positional
  const invalid = checkId(id)
  if (invalid !== null) return invalid
  if (!args.repo || !args.commit) return coded('USAGE', '--repo and --commit are required.')
  if (!args.pick || !hasContent(args.pick)) {
    return coded('PICK_MISSING', 'The --pick file is missing or empty.')
  }

  const { roots } = ctx
  const sandbox = join(authoringRoot(roots, args.split), id)
  if (existsSync(sandbox)) {
    return coded('SANDBOX_EXISTS', `The sandbox already exists: ${sandbox}. Remove it to rebuild.`)
  }

  mkdirSync(sandbox, { recursive: true })
  const failed = await extractHarnu(roots.repo, join(sandbox, 'harnu'))
  if (failed !== null) return failed

  const target = { repo: args.repo, commit: args.commit }
  const checkout = await checkoutTarget({ target, setup: [] }, join(sandbox, 'target'), {
    cacheRoot: roots.cache,
    setup: false
  })
  if ('code' in checkout) return coded(checkout.code, `${checkout.message} ${checkout.detail}`)

  const out = join(sandbox, 'out', id)
  mkdirSync(out, { recursive: true })
  const skeleton = {
    id,
    split: args.split,
    target,
    provenance: { reviewedAt: null, reviewedBy: null }
  }
  writeFileSync(join(out, 'problem.json'), `${JSON.stringify(skeleton, null, 2)}\n`)
  copyFileSync(args.pick, join(out, 'pick.md'))
  copyFileSync(AUTHOR_PROMPT, join(sandbox, 'AUTHORING.md'))

  say(ctx.stdout, `Sandbox: ${sandbox}`)
  say(ctx.stdout, 'Run this from the sandbox directory, with the prompt below on stdin:')
  say(ctx.stdout, AUTHORING_COMMAND)
  say(ctx.stdout, AUTHORING_PROMPT)
  return 0
}

/** The corpus root of a split: the private clone for the holdout, this repository for dev. */
function corpusRoot(roots, split) {
  return split === 'holdout' ? roots.holdout : join(roots.repo, DEV_CORPUS)
}

/** Stamps what only the import can vouch for; the session's own provenance fields are kept. */
function stampImported(problemDir) {
  const path = join(problemDir, 'problem.json')
  let problem
  try {
    problem = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return // the loader reports it, with the file's name
  }
  problem.provenance = {
    authoredAt: new Date().toISOString(),
    authoredBy: 'bake-off author sandbox session',
    ...problem.provenance,
    sandbox: true,
    reviewedAt: null,
    reviewedBy: null
  }
  writeFileSync(path, `${JSON.stringify(problem, null, 2)}\n`)
}

/**
 * `author-import <id> --split <dev|holdout> --reference <file>`. A problem that does not load and
 * validate is taken back out of the corpus: the sandbox still holds it for the next attempt.
 *
 * @param {object} args `{ positional, split, reference }`
 * @param {object} ctx `{ roots, stdout, stderr }`
 * @returns {Promise<number | { code: string, message: string }>}
 */
export async function authorImportCommand(args, ctx) {
  const [id] = args.positional
  const invalid = checkId(id)
  if (invalid !== null) return invalid
  if (!args.reference || !hasContent(args.reference)) {
    return coded('REFERENCE_MISSING', 'The --reference file is missing or empty.')
  }

  const { roots } = ctx
  const sandbox = join(authoringRoot(roots, args.split), id)
  const out = join(sandbox, 'out', id)
  if (!existsSync(join(out, 'problem.json'))) {
    return coded('SANDBOX_MISSING', `No finished problem in ${sandbox}.`)
  }
  const tainted = existsSync(join(sandbox, 'harnu'))
    ? listTree(join(sandbox, 'harnu')).filter(isExcluded)
    : []
  if (tainted.length > 0) {
    return coded('SANDBOX_NOT_CLEAN', `The sandbox holds excluded paths: ${tainted.join(', ')}.`)
  }

  const root = corpusRoot(roots, args.split)
  const dest = join(root, id)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  cpSync(out, dest, { recursive: true })
  mkdirSync(join(dest, 'hidden'), { recursive: true })
  copyFileSync(args.reference, join(dest, 'hidden', 'reference.patch'))
  stampImported(dest)

  const { problems, errors } = loadCorpus(root, { split: args.split })
  const own = errors.filter((e) => e.file.split(/[\\/]/)[0] === id)
  if (own.length > 0) {
    for (const error of own) say(ctx.stderr, `${error.code}: ${error.message} [${error.file}]`)
    rmSync(dest, { recursive: true, force: true })
    return coded('IMPORT_INVALID', `${id} does not load.`)
  }

  const result = await validateProblem(
    problems.find((p) => p.id === id),
    roots
  )
  if (!result.ok) {
    for (const defect of result.defects) {
      const names = defect.tests?.length ? ` (${defect.tests.join(', ')})` : ''
      say(ctx.stderr, `${id}: ${defect.code}: ${defect.message}${names}`)
    }
    rmSync(dest, { recursive: true, force: true })
    return coded('VALIDATION_FAILED', `${id} failed validation; see the lines above.`)
  }
  say(ctx.stdout, `${id}: imported and validated (${result.testSet.length} tests)`)
  return 0
}

/** The first line of a stream, or `''` when it ends first. */
function firstLine(stream) {
  return new Promise((done) => {
    const reader = createInterface({ input: stream })
    let answered = false
    const finish = (line) => {
      if (answered) return
      answered = true
      reader.close()
      done(line)
    }
    reader.once('line', finish)
    reader.once('close', () => finish(''))
  })
}

/**
 * `review <id> --split <dev|holdout>`: prints what the operator must read and, on `y`, stamps
 * `provenance.reviewedAt` and `reviewedBy`, the only fields it writes.
 *
 * @param {object} args `{ positional, split }`
 * @param {object} ctx `{ roots, stdout, stdin }`
 * @returns {Promise<number | { code: string, message: string }>}
 */
export async function reviewCommand(args, ctx) {
  const [id] = args.positional
  const invalid = checkId(id)
  if (invalid !== null) return invalid

  const dir = join(corpusRoot(ctx.roots, args.split), id)
  const problemPath = join(dir, 'problem.json')
  if (!existsSync(problemPath)) return coded('PROBLEM_UNKNOWN', `Unknown problem: ${id}.`)

  for (const [title, rel] of [
    ['REQUEST', 'request.md'],
    ['ANSWER SHEET', 'answer-sheet.md'],
    ['ATOMS', 'hidden/atoms.md']
  ]) {
    say(ctx.stdout, `===== ${title} =====`)
    say(ctx.stdout, readFileSync(join(dir, rel), 'utf8'))
  }
  ctx.stdout.write('Stamp this problem as reviewed? [y/N] ')

  const answer = await firstLine(ctx.stdin)
  if (!/^y(es)?$/i.test(answer.trim())) {
    say(ctx.stdout, 'Not stamped.')
    return 0
  }

  const user = await runProblemCommand('git config user.name', ctx.roots.repo)
  const reviewedBy = user.stdout.trim()
  if (reviewedBy === '') return coded('GIT_USER_MISSING', 'git config user.name is not set.')

  const problem = JSON.parse(readFileSync(problemPath, 'utf8'))
  problem.provenance = { ...problem.provenance, reviewedAt: new Date().toISOString(), reviewedBy }
  writeFileSync(problemPath, `${JSON.stringify(problem, null, 2)}\n`)
  say(ctx.stdout, `Stamped ${id} as reviewed by ${reviewedBy}.`)
  return 0
}
