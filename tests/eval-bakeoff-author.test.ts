/**
 * T676 S-7 — the author sandbox (D-7): `author-sandbox`, `author-import` and `review`
 * in `scripts/eval/bakeoff/author.mjs`. Every repository here is a throwaway one and
 * no `claude` is started: the headless authoring command is only printed.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
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
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'

const REPO = resolve(__dirname, '..')
const AUTHOR_MODULE = resolve(REPO, 'scripts/eval/bakeoff/author.mjs')
const PATHS_MODULE = resolve(REPO, 'scripts/eval/bakeoff/paths.mjs')
const RUN_MODULE = resolve(REPO, 'scripts/eval/bakeoff/run.mjs')
const AUTHOR_PROMPT = resolve(REPO, 'scripts/eval/bakeoff/prompts/author.md')

const AUTHORING_COMMAND =
  'claude -p --model opus --tools Read,Write,Edit,Bash,Glob,Grep --allowedTools Read,Write,Edit,Bash,Glob,Grep --setting-sources project --max-turns 200'
const AUTHORING_PROMPT =
  'Read AUTHORING.md and do what it says. Stop when every file it lists exists.'

/** One path per entry of the exclusion list, so each entry is proven to be applied. */
const EXCLUDED_PATHS = [
  'resources/skills/skills/spec/SKILL.md',
  'docs/specs/2026-11-harnu-spec/spec.md',
  'docs/specs/2026-11-07-bakeoff-harness/spec.md',
  'docs/specs/TEMPLATE.md',
  'docs/prds/T601-spec.md',
  'docs/prds/T676-bakeoff-harness.md',
  'docs/adr/0025-bakeoff-harness.md',
  'docs/harnu-features.md',
  'docs/user/bundled-skills.md',
  'docs/dev/bakeoff.md',
  'docs/lessons/testing/006-eval.md',
  '.harnu/memory/hot.md',
  'CHANGELOG.md',
  'scripts/eval/bakeoff/run.mjs',
  'tests/eval-bakeoff-author.test.ts',
  'tests/fixtures/eval-bakeoff/fake-claude.mjs',
  'tests/fixtures/spec-check/good.md',
  'tests/fixtures/spec-skill/good.md',
  'tests/spec-check.test.ts',
  'tests/bundled-spec-skill.test.ts',
  'tests/orchestrate-spec-integration.test.ts'
]
const KEPT_PATHS = ['src/index.ts', 'docs/user/agent-control.md', 'docs/prds/T700-other.md']

const DENY_TERMS = ['harnu:spec', 'Goldfish', 'Elephant', 'spec-check']

let tmp: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bakeoff-s7-')))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args
    ],
    { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
}

/** A git repository holding `files` in one commit; returns its path and head sha. */
function makeRepo(name: string, files: Record<string, string>): { dir: string; sha: string } {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeTree(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') }
}

type Roots = {
  repo: string
  mainCheckout: string
  cache: string
  work: string
  holdout: string | null
}

function fakeRoots(repo: string): Roots {
  return {
    repo,
    mainCheckout: repo,
    cache: join(tmp, 'cache'),
    work: join(tmp, 'work'),
    holdout: join(tmp, 'holdout')
  }
}

function fakeCtx(
  roots: Roots,
  stdin = ''
): {
  ctx: Record<string, unknown>
  out: () => string
  err: () => string
} {
  let out = ''
  let err = ''
  const ctx = {
    roots,
    models: null,
    stdin: Readable.from([stdin]),
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: { write: (s: string) => ((err += s), true) },
    env: {}
  }
  return { ctx, out: () => out, err: () => err }
}

async function author(): Promise<{
  authorSandboxCommand: (a: unknown, c: unknown) => Promise<unknown>
  authorImportCommand: (a: unknown, c: unknown) => Promise<unknown>
  reviewCommand: (a: unknown, c: unknown) => Promise<unknown>
}> {
  return import(/* @vite-ignore */ pathToFileURL(AUTHOR_MODULE).href)
}

/** A small JavaScript target whose suite passes, and a hidden suite that needs `double`. */
function jsTarget(): { dir: string; sha: string } {
  return makeRepo('target', {
    'package.json': '{ "type": "module" }\n',
    'index.js': 'export const identity = (x) => x\n',
    'test/index.test.js':
      "import test from 'node:test'\nimport assert from 'node:assert'\nimport { identity } from '../index.js'\ntest('identity', () => assert.equal(identity(1), 1))\n"
  })
}

const HIDDEN_TEST =
  "import test from 'node:test'\nimport assert from 'node:assert'\nimport * as m from '../index.js'\ntest('double', () => assert.equal(m.double?.(2), 4))\n"
const REFERENCE_PATCH = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1 +1,2 @@
 export const identity = (x) => x
+export const double = (x) => x * 2
`

/** Fills `out/<id>/` of a built sandbox the way a finished authoring session leaves it. */
function finishAuthoring(sandbox: string, id: string): void {
  const out = join(sandbox, 'out', id)
  const problem = JSON.parse(readFileSync(join(out, 'problem.json'), 'utf8'))
  Object.assign(problem, {
    kind: 'feature',
    language: 'javascript',
    setup: [],
    versions: 'node --version',
    test: 'node --test test/index.test.js',
    hidden: {
      files: ['double.hidden.test.js'],
      dest: 'test/',
      cmd: 'node --test --test-reporter=junit --test-reporter-destination="$BAKEOFF_JUNIT" test/double.hidden.test.js',
      compileErrorPattern: '(SyntaxError|Cannot find module)'
    }
  })
  problem.provenance = { ...problem.provenance, authoredAt: '2026-11-09T00:00:00Z' }
  writeTree(out, {
    'problem.json': `${JSON.stringify(problem, null, 2)}\n`,
    'request.md': 'Add double.\n',
    'answer-sheet.md': '- **G-1** (open-ended): "Nothing else."\n',
    'hidden/atoms.md': '| id | atom |\n| --- | --- |\n| A-1 | doubles |\n',
    'hidden/double.hidden.test.js': HIDDEN_TEST
  })
}

async function buildSandbox(
  roots: Roots,
  split: 'dev' | 'holdout',
  id: string,
  target: { dir: string; sha: string },
  pickText = 'picked by the rule\n'
): Promise<{ sandbox: string; code: unknown; stdout: string }> {
  const { authorSandboxCommand } = await author()
  const pick = join(tmp, `${id}.pick.md`)
  writeFileSync(pick, pickText)
  const { ctx, out } = fakeCtx(roots)
  const code = await authorSandboxCommand(
    { positional: [id], split, repo: target.dir, commit: target.sha, pick },
    ctx
  )
  const base =
    split === 'dev' ? join(roots.cache, 'authoring') : join(roots.holdout!, '.rounds/authoring')
  return { sandbox: join(base, id), code, stdout: out() }
}

/** Every file under `dir`, relative to it, skipping any directory named in `skip`. */
function walk(dir: string, skip: string[] = [], base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return skip.includes(entry.name) ? [] : walk(full, skip, base)
    return [relative(base, full)]
  })
}

const codeOf = (result: unknown): string | null =>
  typeof result === 'object' && result !== null && 'code' in result
    ? (result as { code: string }).code
    : null

it('the author sandbox has no skill files and import stamps it', async () => {
  const repo = makeRepo('repo', {
    ...Object.fromEntries(EXCLUDED_PATHS.map((p) => [p, 'skill\n'])),
    ...Object.fromEntries(KEPT_PATHS.map((p) => [p, 'kept\n']))
  })
  const target = jsTarget()
  const roots = fakeRoots(repo.dir)
  const { authorSandboxCommand, authorImportCommand } = await author()

  // --pick is required and must hold something.
  const missing = fakeCtx(roots)
  const noPick = await authorSandboxCommand(
    {
      positional: ['p-one'],
      split: 'dev',
      repo: target.dir,
      commit: target.sha,
      pick: join(tmp, 'nope')
    },
    missing.ctx
  )
  expect(codeOf(noPick)).toBe('PICK_MISSING')
  const empty = join(tmp, 'empty.md')
  writeFileSync(empty, '')
  const emptyCtx = fakeCtx(roots)
  expect(
    codeOf(
      await authorSandboxCommand(
        { positional: ['p-one'], split: 'dev', repo: target.dir, commit: target.sha, pick: empty },
        emptyCtx.ctx
      )
    )
  ).toBe('PICK_MISSING')

  // The sandbox: harnu/ without any excluded path, target/ at the pin, a prefilled out/<id>/.
  const { sandbox, code, stdout } = await buildSandbox(roots, 'dev', 'p-one', target, 'the pick\n')
  expect(code).toBe(0)
  expect(sandbox).toBe(join(roots.cache, 'authoring/p-one'))
  for (const p of EXCLUDED_PATHS) expect(existsSync(join(sandbox, 'harnu', p)), p).toBe(false)
  for (const p of KEPT_PATHS) expect(existsSync(join(sandbox, 'harnu', p)), p).toBe(true)
  expect(git(join(sandbox, 'target'), 'rev-parse', 'HEAD')).toBe(target.sha)
  const prefilled = JSON.parse(readFileSync(join(sandbox, 'out/p-one/problem.json'), 'utf8'))
  expect(prefilled.id).toBe('p-one')
  expect(prefilled.split).toBe('dev')
  expect(prefilled.target).toEqual({ repo: target.dir, commit: target.sha })
  expect(prefilled.provenance.reviewedAt).toBeNull()
  expect(readFileSync(join(sandbox, 'out/p-one/pick.md'), 'utf8')).toBe('the pick\n')
  expect(readFileSync(join(sandbox, 'AUTHORING.md'), 'utf8')).toBe(
    readFileSync(AUTHOR_PROMPT, 'utf8')
  )
  expect(stdout).toContain(AUTHORING_COMMAND)
  expect(stdout).toContain(AUTHORING_PROMPT)

  finishAuthoring(sandbox, 'p-one')
  const referenceFile = join(tmp, 'p-one.reference.patch')
  writeFileSync(referenceFile, REFERENCE_PATCH)

  // No reference patch, no import.
  const noRef = fakeCtx(roots)
  expect(
    codeOf(
      await authorImportCommand(
        { positional: ['p-one'], split: 'dev', reference: join(tmp, 'nope') },
        noRef.ctx
      )
    )
  ).toBe('REFERENCE_MISSING')

  // A sandbox still holding an excluded path is refused and nothing lands in the corpus.
  const corpus = join(repo.dir, 'scripts/eval/bakeoff/corpus/dev')
  const tainted = join(sandbox, 'harnu/resources/skills/skills/spec/SKILL.md')
  mkdirSync(dirname(tainted), { recursive: true })
  writeFileSync(tainted, 'skill\n')
  const taintedCtx = fakeCtx(roots)
  const refused = await authorImportCommand(
    { positional: ['p-one'], split: 'dev', reference: referenceFile },
    taintedCtx.ctx
  )
  expect(codeOf(refused)).toBe('SANDBOX_NOT_CLEAN')
  expect(existsSync(join(corpus, 'p-one'))).toBe(false)
  rmSync(join(sandbox, 'harnu/resources'), { recursive: true })

  // A clean one lands, stamped, with the reference added and validated.
  const importCtx = fakeCtx(roots)
  const imported = await authorImportCommand(
    { positional: ['p-one'], split: 'dev', reference: referenceFile },
    importCtx.ctx
  )
  expect(imported, importCtx.err()).toBe(0)
  const landed = JSON.parse(readFileSync(join(corpus, 'p-one/problem.json'), 'utf8'))
  expect(landed.provenance.sandbox).toBe(true)
  expect(landed.provenance.reviewedAt).toBeNull()
  expect(readFileSync(join(corpus, 'p-one/hidden/reference.patch'), 'utf8')).toBe(REFERENCE_PATCH)
  // The reference patch never enters the sandbox directory.
  expect(existsSync(join(sandbox, 'out/p-one/hidden/reference.patch'))).toBe(false)
  expect(walk(sandbox, ['harnu', 'target', '.git'])).not.toContain('reference.patch')

  // A holdout problem lands only under the holdout clone.
  const hidden = await buildSandbox(roots, 'holdout', 'h-one', target)
  expect(hidden.code).toBe(0)
  expect(hidden.sandbox).toBe(join(roots.holdout!, '.rounds/authoring/h-one'))
  finishAuthoring(hidden.sandbox, 'h-one')
  const holdoutCtx = fakeCtx(roots)
  const holdoutImport = await authorImportCommand(
    { positional: ['h-one'], split: 'holdout', reference: referenceFile },
    holdoutCtx.ctx
  )
  expect(holdoutImport, holdoutCtx.err()).toBe(0)
  expect(existsSync(join(roots.holdout!, 'h-one/hidden/reference.patch'))).toBe(true)
  expect(existsSync(join(repo.dir, 'scripts/eval/bakeoff/corpus/holdout'))).toBe(false)
  expect(existsSync(join(corpus, 'h-one'))).toBe(false)

  // `main` refuses all three commands without a split, before any work.
  const { main } = await import(/* @vite-ignore */ pathToFileURL(RUN_MODULE).href)
  const stderr: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  })
  for (const argv of [
    ['author-import', 'p-one', '--reference', referenceFile],
    ['author-sandbox', 'p-one', '--repo', target.dir, '--commit', target.sha, '--pick', empty],
    ['review', 'p-one']
  ]) {
    stderr.length = 0
    expect(await main(argv)).toBe(2)
    expect(stderr.join('')).toContain('SPLIT_REQUIRED')
  }
}, 60_000)

it('a failed re-import puts back the problem it replaced', async () => {
  const repo = makeRepo('repo', { 'src/index.ts': 'kept\n' })
  const target = jsTarget()
  const roots = fakeRoots(repo.dir)
  const { authorImportCommand } = await author()
  const { sandbox } = await buildSandbox(roots, 'dev', 'p-two', target)
  finishAuthoring(sandbox, 'p-two')
  const good = join(tmp, 'good.patch')
  writeFileSync(good, REFERENCE_PATCH)
  const args = (reference: string): Record<string, unknown> => ({
    positional: ['p-two'],
    split: 'dev',
    reference
  })

  const first = fakeCtx(roots)
  expect(await authorImportCommand(args(good), first.ctx), first.err()).toBe(0)
  const dest = join(repo.dir, 'scripts/eval/bakeoff/corpus/dev/p-two')
  const before = readFileSync(join(dest, 'problem.json'), 'utf8')

  // A reference patch that does not apply fails validation; the first import must survive it.
  const bad = join(tmp, 'bad.patch')
  writeFileSync(bad, 'not a patch\n')
  const second = fakeCtx(roots)
  expect(codeOf(await authorImportCommand(args(bad), second.ctx))).not.toBeNull()
  expect(readFileSync(join(dest, 'problem.json'), 'utf8')).toBe(before)
  expect(readFileSync(join(dest, 'hidden/reference.patch'), 'utf8')).toBe(REFERENCE_PATCH)
}, 60_000)

it('the sandbox build survives a quote in the path it extracts into', async () => {
  const repo = makeRepo('repo', { 'src/index.ts': 'kept\n' })
  const target = jsTarget()
  const roots = { ...fakeRoots(repo.dir), cache: join(tmp, "o'brien", 'cache') }
  const { sandbox, code } = await buildSandbox(roots, 'dev', 'p-quote', target)
  expect(code).toBe(0)
  expect(existsSync(join(sandbox, 'harnu/src/index.ts'))).toBe(true)
}, 60_000)

it('the built author sandbox holds no deny-list term', async () => {
  const { resolveRoots } = await import(/* @vite-ignore */ pathToFileURL(PATHS_MODULE).href)
  const roots = resolveRoots({
    split: 'dev',
    env: {
      HOME: process.env.HOME,
      HARNU_BAKEOFF_CACHE: join(tmp, 'cache'),
      HARNU_BAKEOFF_WORK: join(tmp, 'work')
    }
  })
  expect(codeOf(roots)).toBeNull()

  const target = makeRepo('target', { 'README.md': 'Goldfish lives only in the target.\n' })
  const { sandbox, code } = await buildSandbox(roots, 'dev', 'deny-probe', target)
  expect(code).toBe(0)

  const hits: string[] = []
  for (const rel of walk(sandbox, ['target'])) {
    let bytes: Buffer
    try {
      bytes = readFileSync(join(sandbox, rel))
    } catch {
      continue
    }
    for (const term of DENY_TERMS) if (bytes.includes(term)) hits.push(`${rel}: ${term}`)
  }
  expect(
    hits,
    `The built sandbox names the skill in these files:\n${hits.join('\n')}\nA PR adding a doc that names the skill extends the exclusion list (EXCLUSIONS in scripts/eval/bakeoff/author.mjs) in the same PR.`
  ).toEqual([])
}, 120_000)

function reviewedProblem(roots: Roots, id: string): string {
  const dir = join(roots.repo, 'scripts/eval/bakeoff/corpus/dev', id)
  writeTree(dir, {
    'problem.json': `${JSON.stringify(
      {
        id,
        split: 'dev',
        provenance: {
          authoredAt: 'x',
          authoredBy: 'y',
          sandbox: true,
          reviewedAt: null,
          reviewedBy: null
        }
      },
      null,
      2
    )}\n`,
    'request.md': 'THE REQUEST TEXT\n',
    'answer-sheet.md': 'THE ANSWER SHEET\n',
    'hidden/atoms.md': 'THE ATOMS\n'
  })
  return dir
}

it('review stamps provenance only on yes', async () => {
  const repo = makeRepo('repo', { 'README.md': 'x\n' })
  git(repo.dir, 'config', 'user.name', 'A Reviewer')
  const roots = fakeRoots(repo.dir)
  const { reviewCommand } = await author()
  const dir = reviewedProblem(roots, 'p-two')
  const read = (): { provenance: Record<string, unknown> } =>
    JSON.parse(readFileSync(join(dir, 'problem.json'), 'utf8'))

  const no = fakeCtx(roots, 'n\n')
  expect(await reviewCommand({ positional: ['p-two'], split: 'dev' }, no.ctx)).toBe(0)
  expect(no.out()).toContain('THE REQUEST TEXT')
  expect(no.out()).toContain('THE ANSWER SHEET')
  expect(no.out()).toContain('THE ATOMS')
  expect(read().provenance.reviewedAt).toBeNull()
  expect(read().provenance.reviewedBy).toBeNull()

  const yes = fakeCtx(roots, 'y\n')
  expect(await reviewCommand({ positional: ['p-two'], split: 'dev' }, yes.ctx)).toBe(0)
  const stamped = read().provenance
  expect(stamped.reviewedBy).toBe('A Reviewer')
  expect(Number.isNaN(Date.parse(String(stamped.reviewedAt)))).toBe(false)
  expect(stamped.authoredAt).toBe('x')
  expect(stamped.sandbox).toBe(true)

  const { main } = await import(/* @vite-ignore */ pathToFileURL(RUN_MODULE).href)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['review', 'p-two'])).toBe(2)
}, 30_000)
