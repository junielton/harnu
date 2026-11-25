/**
 * T676 S-1 — the bake-off harness's corpus loader, holdout containment, target
 * checkout and limits (`scripts/eval/bakeoff/{corpus,paths,checkout,limits}.mjs`).
 * Every git operation runs against throwaway repositories; nothing reaches the
 * network and no `claude` is started.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const FIXTURE = resolve(__dirname, 'fixtures/eval-bakeoff/s1/good-problem')
const PATHS_MODULE = resolve(__dirname, '../scripts/eval/bakeoff/paths.mjs')

let tmp: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bakeoff-s1-')))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(tmp, { recursive: true, force: true })
})

/** Git with the hook-injected variables removed, so a pre-push run stays in its repo. */
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

function commitFile(repo: string, name: string): string {
  writeFileSync(join(repo, name), `${name}\n`)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', name)
  return git(repo, 'rev-parse', 'HEAD')
}

interface ProblemJson {
  id: string
  split: string
  kind: string
  versions?: string
  target: Record<string, string>
  hidden: Record<string, unknown>
  provenance: Record<string, unknown>
}

/** A copy of the valid fixture under `<tmp>/<rootName>/<dir>`, with `edit` applied to its JSON. */
function problemCopy(
  edit: (p: ProblemJson) => void = () => {},
  { rootName = 'root', dir = 'good-problem' } = {}
): { root: string; dir: string } {
  const root = join(tmp, rootName)
  const target = join(root, dir)
  cpSync(FIXTURE, target, { recursive: true })
  const file = join(target, 'problem.json')
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  edit(parsed)
  writeFileSync(file, JSON.stringify(parsed, null, 2))
  return { root, dir: target }
}

interface Defect {
  name: string
  split?: 'dev' | 'holdout'
  forRun?: boolean
  edit?: (p: ProblemJson) => void
  message?: RegExp
  mutate?: (dir: string) => void
  expected: { code: string; file: string; field: string | null }
}

const JSON_FILE = 'good-problem/problem.json'

const DEFECTS: Defect[] = [
  {
    name: 'id differs from its directory',
    edit: (p) => void (p.id = 'other-id'),
    expected: { code: 'ID_MISMATCH', file: JSON_FILE, field: 'id' }
  },
  {
    name: 'split differs from its root',
    edit: (p) => void (p.split = 'holdout'),
    expected: { code: 'SPLIT_MISMATCH', file: JSON_FILE, field: 'split' }
  },
  {
    name: 'kind outside the enum',
    edit: (p) => void (p.kind = 'chore'),
    expected: { code: 'KIND_INVALID', file: JSON_FILE, field: 'kind' }
  },
  {
    name: 'commit is not 40 hex',
    edit: (p) => void (p.target.commit = 'abc123'),
    expected: { code: 'COMMIT_INVALID', file: JSON_FILE, field: 'target.commit' }
  },
  {
    name: 'versions missing',
    edit: (p) => void delete p.versions,
    expected: { code: 'FIELD_MISSING', file: JSON_FILE, field: 'versions' }
  },
  {
    name: 'compileErrorPattern missing',
    edit: (p) => void delete p.hidden.compileErrorPattern,
    expected: { code: 'FIELD_MISSING', file: JSON_FILE, field: 'hidden.compileErrorPattern' }
  },
  {
    name: 'compileErrorPattern does not compile',
    edit: (p) => void (p.hidden.compileErrorPattern = '('),
    expected: { code: 'FIELD_MISSING', file: JSON_FILE, field: 'hidden.compileErrorPattern' },
    message: /does not compile/
  },
  {
    name: 'a setup entry is not a command string',
    edit: (p) => void (p as unknown as { setup: unknown[] }).setup.push(1),
    expected: { code: 'FIELD_MISSING', file: JSON_FILE, field: 'setup' },
    message: /string/
  },
  ...[
    'pick.md',
    'request.md',
    'answer-sheet.md',
    'hidden/atoms.md',
    'hidden/check.hidden.js',
    'hidden/reference.patch'
  ].map((f): Defect => ({
    name: `${f} missing`,
    mutate: (dir) => rmSync(join(dir, f)),
    expected: {
      code: 'FILE_MISSING',
      file: `good-problem/${f}`,
      field: f === 'hidden/check.hidden.js' ? 'hidden.files' : null
    }
  })),
  {
    name: 'atoms.md has no atom id',
    mutate: (dir) => writeFileSync(join(dir, 'hidden/atoms.md'), '# Atoms\n\nNo table here.\n'),
    expected: { code: 'ATOMS_EMPTY', file: 'good-problem/hidden/atoms.md', field: null }
  },
  {
    name: 'atoms.md has a row whose id is malformed',
    mutate: (dir) =>
      writeFileSync(join(dir, 'hidden/atoms.md'), '| id |\n| --- |\n| R-1 |\n| lowercase-2 |\n'),
    expected: { code: 'ATOMS_EMPTY', file: 'good-problem/hidden/atoms.md', field: null }
  },
  {
    name: 'holdout problem not authored in the sandbox',
    split: 'holdout',
    edit: (p) => {
      p.split = 'holdout'
      p.provenance.sandbox = false
    },
    expected: { code: 'NOT_SANDBOXED', file: JSON_FILE, field: 'provenance.sandbox' }
  },
  {
    name: 'unreviewed problem loaded for a run',
    forRun: true,
    edit: (p) => void (p.provenance.reviewedAt = null),
    expected: { code: 'NOT_REVIEWED', file: JSON_FILE, field: 'provenance.reviewedAt' }
  },
  {
    name: 'problem.json is not JSON',
    mutate: (dir) => writeFileSync(join(dir, 'problem.json'), '{ nope'),
    expected: { code: 'JSON_INVALID', file: JSON_FILE, field: null }
  }
]

it('loader validates a problem and names every defect', async () => {
  const { loadCorpus } = await import('../scripts/eval/bakeoff/corpus.mjs')

  // A valid problem loads, with `dir`, and the holdout repo's private files are not problems.
  const good = problemCopy()
  mkdirSync(join(good.root, '.rounds', 'r1'), { recursive: true })
  mkdirSync(join(good.root, '.git'))
  writeFileSync(join(good.root, 'README.md'), 'not a problem\n')
  const loaded = loadCorpus(good.root, { split: 'dev', forRun: true })
  expect(loaded.errors).toEqual([])
  expect(loaded.problems).toHaveLength(1)
  expect(loaded.problems[0]).toMatchObject({ id: 'good-problem', kind: 'feature', dir: good.dir })

  // A relative root works too, and `dir` still comes back absolute.
  const relativeRoot = relative(process.cwd(), good.root)
  const viaRelative = loadCorpus(relativeRoot, { split: 'dev' })
  expect(viaRelative.errors).toEqual([])
  expect(viaRelative.problems[0].dir).toBe(good.dir)

  // Each defect alone gives exactly one error, with its code, file and field.
  for (const [i, d] of DEFECTS.entries()) {
    const { root, dir } = problemCopy(d.edit, { rootName: `defect-${i}` })
    d.mutate?.(dir)
    const result = loadCorpus(root, { split: d.split ?? 'dev', forRun: d.forRun ?? false })
    expect(result.errors, d.name).toHaveLength(1)
    expect(result.errors[0], d.name).toMatchObject(d.expected)
    expect(result.errors[0].message, d.name).toEqual(expect.any(String))
    if (d.message) expect(result.errors[0].message, d.name).toMatch(d.message)
    expect(result.problems, d.name).toEqual([])
  }

  // Several defects on one problem are all reported, not only the first.
  const many = problemCopy(
    (p) => {
      p.kind = 'chore'
      delete p.versions
    },
    { rootName: 'many' }
  )
  rmSync(join(many.dir, 'pick.md'))
  expect(
    loadCorpus(many.root, { split: 'dev' })
      .errors.map((e: { code: string }) => e.code)
      .sort()
  ).toEqual(['FIELD_MISSING', 'FILE_MISSING', 'KIND_INVALID'])

  // `reviewedAt` null is only refused for a run; a dev problem needs no sandbox stamp.
  const unreviewed = problemCopy(
    (p) => {
      p.provenance.reviewedAt = null
      p.provenance.sandbox = false
    },
    { rootName: 'unreviewed' }
  )
  expect(loadCorpus(unreviewed.root, { split: 'dev' }).errors).toEqual([])

  // An inline target needs its source directory and no commit.
  const inline = problemCopy((p) => void (p.target = { inline: 'source' }), { rootName: 'inline' })
  expect(loadCorpus(inline.root, { split: 'dev' }).errors).toMatchObject([
    { code: 'FILE_MISSING', file: 'good-problem/source', field: 'target.inline' }
  ])
  mkdirSync(join(inline.dir, 'source'))
  expect(loadCorpus(inline.root, { split: 'dev' }).errors).toEqual([])

  // An id outside the alphabet is refused even when it equals its directory.
  const badId = problemCopy((p) => void (p.id = '_round'), { rootName: 'bad-id', dir: '_round' })
  expect(loadCorpus(badId.root, { split: 'dev' }).errors).toMatchObject([
    { code: 'ID_MISMATCH', field: 'id' }
  ])

  // A root that does not exist is a returned error, never a throw.
  expect(loadCorpus(join(tmp, 'absent'), { split: 'dev' })).toMatchObject({
    problems: [],
    errors: [{ code: 'FILE_MISSING' }]
  })
})

it('hidden.dest must stay inside the checkout', async () => {
  const { loadCorpus } = await import('../scripts/eval/bakeoff/corpus.mjs')
  const load = (dest: string, rootName: string): Record<string, unknown> => {
    const { root } = problemCopy((p) => void (p.hidden.dest = dest), { rootName })
    return loadCorpus(root, { split: 'dev' })
  }

  for (const [i, dest] of [
    '../outside/',
    '..',
    'tests/../../outside/',
    '/tmp/outside/'
  ].entries()) {
    expect(load(dest, `escape-${i}`), dest).toMatchObject({
      problems: [],
      errors: [{ code: 'FILE_MISSING', file: JSON_FILE, field: 'hidden.dest' }]
    })
  }

  for (const [i, dest] of ['tests/', './tests/unit/', '.', 'a/../tests/', '..tests/'].entries()) {
    expect(load(dest, `inside-${i}`), dest).toMatchObject({ errors: [] })
  }
})

it('content hash ignores provenance and follows every other byte', async () => {
  const { contentHash } = await import('../scripts/eval/bakeoff/corpus.mjs')
  const base = problemCopy(undefined, { rootName: 'a' })
  const hash = contentHash(base.dir)
  expect(hash).toMatch(/^[0-9a-f]{64}$/)

  const reviewed = problemCopy((p) => void (p.provenance.reviewedBy = 'someone else'), {
    rootName: 'b'
  })
  expect(contentHash(reviewed.dir)).toBe(hash)

  const edited = problemCopy(undefined, { rootName: 'c' })
  writeFileSync(join(edited.dir, 'hidden/atoms.md'), '| id |\n| --- |\n| R-1 |\n')
  expect(contentHash(edited.dir)).not.toBe(hash)

  const renamed = problemCopy(undefined, { rootName: 'd' })
  renameSync(join(renamed.dir, 'pick.md'), join(renamed.dir, 'pick2.md'))
  expect(contentHash(renamed.dir)).not.toBe(hash)
})

/** A real repository with a linked worktree, holding its own copy of `paths.mjs`. */
async function repoWithLinkedWorktree(): Promise<{
  main: string
  worktree: string
  resolveRoots: (o: { split: string; env: Record<string, string> }) => Record<string, unknown>
  outside: string
}> {
  const main = join(tmp, 'main')
  mkdirSync(main)
  git(main, 'init', '-qb', 'main')
  commitFile(main, 'a.txt')
  const worktree = join(tmp, 'linked')
  git(main, 'worktree', 'add', '-q', worktree, '-b', 'wt')
  const copy = join(worktree, 'scripts/eval/bakeoff/paths.mjs')
  mkdirSync(dirname(copy), { recursive: true })
  copyFileSync(PATHS_MODULE, copy)
  const { resolveRoots } = await import(/* @vite-ignore */ pathToFileURL(copy).href)
  const outside = join(tmp, 'outside')
  mkdirSync(outside)
  return { main, worktree, resolveRoots, outside }
}

it('holdout and cache paths inside the repo are refused after realpath', async () => {
  const { main, worktree, resolveRoots, outside } = await repoWithLinkedWorktree()
  const base = { HOME: join(tmp, 'home'), XDG_CACHE_HOME: join(outside, 'xdg') }
  const cache = join(outside, 'cache')
  const holdout = join(outside, 'holdout')
  mkdirSync(holdout)
  const goodEnv = {
    ...base,
    HARNU_BAKEOFF_CACHE: cache,
    HARNU_BAKEOFF_WORK: join(outside, 'work'),
    HARNU_BAKEOFF_HOLDOUT: holdout
  }

  // Links that sit outside the repo and resolve into it.
  symlinkSync(worktree, join(outside, 'to-worktree'))
  symlinkSync(join(main, 'not-created-yet'), join(outside, 'dangling-to-main'))
  const insideCases = [
    worktree,
    main,
    join(worktree, 'sub/dir'),
    join(main, 'sub/dir'),
    join(outside, 'to-worktree'),
    join(outside, 'to-worktree', 'deeper'),
    join(outside, 'dangling-to-main')
  ]
  for (const p of insideCases) {
    expect(
      resolveRoots({ split: 'holdout', env: { ...goodEnv, HARNU_BAKEOFF_HOLDOUT: p } }),
      `holdout ${p}`
    ).toMatchObject({ code: 'HOLDOUT_INSIDE_REPO', message: expect.any(String) })
    expect(
      resolveRoots({ split: 'dev', env: { ...goodEnv, HARNU_BAKEOFF_CACHE: p } }),
      `cache ${p}`
    ).toMatchObject({ code: 'CACHE_INSIDE_REPO', message: expect.any(String) })
  }

  // The work root is held apart from the repo roots, the cache and the holdout clone.
  symlinkSync(holdout, join(outside, 'to-holdout'))
  for (const p of [
    worktree,
    join(main, 'w'),
    cache,
    join(cache, 'w'),
    holdout,
    join(holdout, 'w'),
    join(outside, 'to-holdout', 'w')
  ]) {
    expect(
      resolveRoots({ split: 'holdout', env: { ...goodEnv, HARNU_BAKEOFF_WORK: p } }),
      `work ${p}`
    ).toMatchObject({ code: 'WORK_NOT_CONTAINED' })
  }

  // A holdout split needs the variable; a dev split does not.
  const { HARNU_BAKEOFF_HOLDOUT: _unset, ...noHoldout } = goodEnv
  expect(resolveRoots({ split: 'holdout', env: noHoldout })).toMatchObject({
    code: 'HOLDOUT_UNSET'
  })
  expect(resolveRoots({ split: 'dev', env: noHoldout })).toMatchObject({ holdout: null })

  // A holdout path outside both roots is accepted and comes back as its realpath.
  expect(
    resolveRoots({
      split: 'holdout',
      env: { ...goodEnv, HARNU_BAKEOFF_HOLDOUT: join(outside, 'to-holdout') }
    })
  ).toEqual({
    repo: worktree,
    mainCheckout: main,
    cache,
    work: join(outside, 'work'),
    holdout
  })

  // The defaults live under the XDG cache home, or ~/.cache without one.
  expect(resolveRoots({ split: 'dev', env: base })).toMatchObject({
    cache: join(outside, 'xdg/harnu-bakeoff/cache'),
    work: join(outside, 'xdg/harnu-bakeoff/work')
  })
  expect(resolveRoots({ split: 'dev', env: { HOME: base.HOME } })).toMatchObject({
    cache: join(base.HOME, '.cache/harnu-bakeoff/cache'),
    work: join(base.HOME, '.cache/harnu-bakeoff/work')
  })
}, 30_000)

it('derived paths follow the table of where things are written', async () => {
  const { unitsRoot, validationRoot, authoringRoot, repoRoundDir, privateRoundDir } =
    await import('../scripts/eval/bakeoff/paths.mjs')
  const roots = { repo: '/r', mainCheckout: '/m', cache: '/c', work: '/w', holdout: '/h' }
  expect(unitsRoot(roots, 'dev', 'R1')).toBe('/c/rounds/R1/units')
  expect(unitsRoot(roots, 'holdout', 'R1')).toBe('/w/rounds/R1/units')
  expect(validationRoot(roots, 'dev')).toBe('/c/validation')
  expect(validationRoot(roots, 'holdout')).toBe('/w/validation')
  expect(authoringRoot(roots, 'dev')).toBe('/c/authoring')
  expect(authoringRoot(roots, 'holdout')).toBe('/h/.rounds/authoring')
  expect(repoRoundDir(roots, 'R1')).toBe('/m/.harnu/eval/bakeoff/R1')
  expect(privateRoundDir(roots, 'R1')).toBe('/h/.rounds/R1')
})

/** A source repository of three commits; the middle one is the pin. */
function sourceRepo(): { source: string; pinned: string; later: string } {
  const source = join(tmp, 'source')
  mkdirSync(source)
  git(source, 'init', '-qb', 'main')
  commitFile(source, 'first.txt')
  const pinned = commitFile(source, 'pinned.txt')
  const later = commitFile(source, 'future.txt')
  return { source, pinned, later }
}

/**
 * Puts a logging `nice` first on PATH. Reading the niceness alone proves nothing
 * when the test runner is itself under `nice -n 19`: the child inherits 19 anyway.
 */
function logNiceCalls(): string {
  const real = execFileSync('sh', ['-c', 'command -v nice'], { encoding: 'utf8' }).trim()
  const bin = join(tmp, 'bin')
  const log = join(tmp, 'nice.log')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'nice'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`,
    { mode: 0o755 }
  )
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  return log
}

const SETUP_PROBE =
  'nice > probe-nice; printf "%s|%s|%s" "$GOMAXPROCS" "$PYTEST_ADDOPTS" "$npm_config_jobs" > probe-env'

it('checkout pins the commit, drops the remote and reuses the mirror', async () => {
  const { checkoutTarget } = await import('../scripts/eval/bakeoff/checkout.mjs')
  const { source, pinned, later } = sourceRepo()
  const cacheRoot = join(tmp, 'cache')
  const problem = { target: { repo: source, commit: pinned }, setup: [SETUP_PROBE] }
  const niceLog = logNiceCalls()

  const dest = join(tmp, 'clone-1')
  expect(await checkoutTarget(problem, dest, { cacheRoot })).toEqual({ dir: dest, commit: pinned })
  const niceCalls = readFileSync(niceLog, 'utf8').trim().split('\n')
  expect(niceCalls).toContain(`-n 19 sh -c ${SETUP_PROBE}`)
  for (const call of niceCalls) expect(call).toMatch(/^-n 19 /)
  expect(git(dest, 'rev-parse', 'HEAD')).toBe(pinned)
  expect(git(dest, 'remote')).toBe('')
  expect(existsSync(join(dest, 'pinned.txt'))).toBe(true)
  expect(existsSync(join(dest, 'future.txt'))).toBe(false)
  // Nothing after the pin is reachable from the clone: the real fix cannot leak.
  expect(() => git(dest, 'cat-file', '-e', later)).toThrow()
  // Nor does the clone say where the mirror (which holds those commits) lives.
  expect(existsSync(join(dest, '.git/FETCH_HEAD'))).toBe(false)
  expect(readFileSync(join(dest, '.git/config'), 'utf8')).not.toContain(cacheRoot)

  // `setup` ran under nice 19 with the single-thread variables.
  expect(readFileSync(join(dest, 'probe-nice'), 'utf8').trim()).toBe('19')
  expect(readFileSync(join(dest, 'probe-env'), 'utf8')).toBe('1|-p no:xdist|1')

  // One mirror, named by the URL's sha256.
  const url = createHash('sha256').update(source).digest('hex')
  expect(readdirSync(join(cacheRoot, 'mirrors'))).toEqual([`${url}.git`])

  // The second call is served by the mirror: the source is gone, and setup can be skipped.
  renameSync(source, join(tmp, 'source-moved'))
  const dest2 = join(tmp, 'clone-2')
  expect(await checkoutTarget(problem, dest2, { cacheRoot, setup: false })).toEqual({
    dir: dest2,
    commit: pinned
  })
  expect(git(dest2, 'remote')).toBe('')
  expect(existsSync(join(dest2, 'probe-nice'))).toBe(false)

  // An inline target is a fresh repository whose one commit holds source/.
  const problemDir = join(tmp, 'inline-problem')
  mkdirSync(join(problemDir, 'source/lib'), { recursive: true })
  writeFileSync(join(problemDir, 'source/lib/a.js'), 'export const a = 1\n')
  writeFileSync(join(problemDir, 'source/.gitignore'), 'lib/\n')
  const inlineDest = join(tmp, 'inline-clone')
  const inline = await checkoutTarget(
    { dir: problemDir, target: { inline: 'source' }, setup: [] },
    inlineDest,
    { cacheRoot }
  )
  expect(inline).toEqual({ dir: inlineDest, commit: git(inlineDest, 'rev-parse', 'HEAD') })
  expect(git(inlineDest, 'rev-list', '--count', 'HEAD')).toBe('1')
  expect(git(inlineDest, 'remote')).toBe('')
  expect(git(inlineDest, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'lib/a.js'])

  // A setup that fails, and a pin the mirror cannot produce, are coded errors with no leak.
  expect(
    await checkoutTarget({ ...problem, setup: ['exit 3'] }, join(tmp, 'clone-3'), { cacheRoot })
  ).toMatchObject({ code: 'SETUP_FAILED', message: expect.any(String) })
  const missing = await checkoutTarget(
    { target: { repo: source, commit: 'f'.repeat(40) }, setup: [] },
    join(tmp, 'clone-4'),
    { cacheRoot }
  )
  expect(missing).toMatchObject({ code: 'CHECKOUT_FAILED' })
  expect(missing.message).not.toContain(source)

  // `setup` is bounded by the command timeout of the Limits table.
  vi.stubEnv('HARNU_BAKEOFF_TIMEOUT_SCALE', '0.005')
  const started = Date.now()
  const timedOut = await checkoutTarget(
    { dir: problemDir, target: { inline: 'source' }, setup: ['sleep 60; touch too-late'] },
    join(tmp, 'clone-5'),
    { cacheRoot }
  )
  expect(timedOut).toMatchObject({ code: 'SETUP_FAILED' })
  expect(Date.now() - started).toBeLessThan(30_000)
  expect(existsSync(join(tmp, 'clone-5', 'too-late'))).toBe(false)
}, 90_000)

it('concurrent checkouts of one URL share a single complete mirror', async () => {
  const { checkoutTarget } = await import('../scripts/eval/bakeoff/checkout.mjs')
  const { source, pinned } = sourceRepo()
  const cacheRoot = join(tmp, 'cache')
  const problem = { target: { repo: source, commit: pinned }, setup: [] }
  const results = await Promise.all(
    [1, 2, 3].map((n) => checkoutTarget(problem, join(tmp, `c-${n}`), { cacheRoot }))
  )
  for (const r of results) expect(r).toMatchObject({ commit: pinned })
  expect(readdirSync(join(cacheRoot, 'mirrors'))).toHaveLength(1)
}, 60_000)

it('a pin newer than the mirror is fetched into it', async () => {
  const { checkoutTarget } = await import('../scripts/eval/bakeoff/checkout.mjs')
  const { source, pinned } = sourceRepo()
  const cacheRoot = join(tmp, 'cache')
  const first = { target: { repo: source, commit: pinned }, setup: [] }
  expect(await checkoutTarget(first, join(tmp, 'c-1'), { cacheRoot })).toMatchObject({
    commit: pinned
  })
  const newer = commitFile(source, 'newer.txt')
  expect(
    await checkoutTarget({ ...first, target: { repo: source, commit: newer } }, join(tmp, 'c-2'), {
      cacheRoot
    })
  ).toMatchObject({ commit: newer })
  expect(readdirSync(join(cacheRoot, 'mirrors'))).toHaveLength(1)
}, 30_000)

it('a checkout refuses a destination that already holds files', async () => {
  const { checkoutTarget } = await import('../scripts/eval/bakeoff/checkout.mjs')
  const { source, pinned } = sourceRepo()
  const dest = join(tmp, 'occupied')
  mkdirSync(dest)
  writeFileSync(join(dest, 'keep.txt'), 'x')
  expect(
    await checkoutTarget({ target: { repo: source, commit: pinned }, setup: [] }, dest, {
      cacheRoot: join(tmp, 'cache')
    })
  ).toMatchObject({ code: 'CHECKOUT_FAILED' })
  expect(readdirSync(dest)).toEqual(['keep.txt'])

  // A destination that is a file is a coded error too, never a throw.
  const file = join(dest, 'keep.txt')
  expect(
    await checkoutTarget({ target: { repo: source, commit: pinned }, setup: [] }, file, {
      cacheRoot: join(tmp, 'cache')
    })
  ).toMatchObject({ code: 'CHECKOUT_FAILED' })
}, 30_000)

it('a problem command reports its exit and is killed with its children at the timeout', async () => {
  const { runProblemCommand } = await import('../scripts/eval/bakeoff/checkout.mjs')
  const ok = await runProblemCommand('echo out; echo err >&2; echo "$EXTRA"; exit 4', tmp, {
    env: { EXTRA: 'extra-value' }
  })
  expect(ok).toMatchObject({ exitCode: 4, timedOut: false })
  expect(ok.stdout).toBe('out\nextra-value\n')
  expect(ok.stderr).toBe('err\n')
  expect(ok.ms).toEqual(expect.any(Number))

  // The caller cannot override the CPU variables.
  const capped = await runProblemCommand('printf "%s" "$GOMAXPROCS"', tmp, {
    env: { GOMAXPROCS: '8' }
  })
  expect(capped.stdout).toBe('1')

  // Long enough for a niced shell to start and write the pid on a loaded machine.
  const killed = await runProblemCommand('sleep 60 & echo $! > child.pid; wait', tmp, {
    timeoutMs: 1_000
  })
  expect(killed.timedOut).toBe(true)
  expect(killed.exitCode).not.toBe(0)
  const pid = Number(readFileSync(join(tmp, 'child.pid'), 'utf8'))
  // Polled: the pipes close while the child is still exiting, and `kill(pid, 0)` succeeds
  // until it is reaped (measured: gone within 10 ms). A real survivor sleeps past this bound.
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
    timeout: 5_000,
    interval: 20
  })

  const noCwd = await runProblemCommand('true', join(tmp, 'absent'), {})
  expect(noCwd.exitCode).not.toBe(0)
  expect(noCwd.timedOut).toBe(false)
}, 30_000)

it('a problem command is not told where the holdout, work or cache roots are', async () => {
  const { runProblemCommand } = await import('../scripts/eval/bakeoff/checkout.mjs')
  const names = ['HARNU_BAKEOFF_HOLDOUT', 'HARNU_BAKEOFF_WORK', 'HARNU_BAKEOFF_CACHE']
  for (const name of names) vi.stubEnv(name, `/secret/${name}`)
  const printAll = names.map((name) => `echo "${name}=\${${name}-unset}"`).join('; ')
  const expected = names.map((name) => `${name}=unset\n`).join('')

  expect((await runProblemCommand(printAll, tmp, {})).stdout).toBe(expected)

  // Not even when a caller passes them in.
  const env = Object.fromEntries(names.map((name) => [name, `/secret/${name}`]))
  expect((await runProblemCommand(printAll, tmp, { env })).stdout).toBe(expected)
})

it.skipIf(process.platform !== 'linux')(
  'a daemon that left the process group cannot hold a timed-out command open',
  async () => {
    const { runProblemCommand } = await import('../scripts/eval/bakeoff/checkout.mjs')
    const r = await runProblemCommand('setsid sleep 8 & wait', tmp, { timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(r.ms).toBeLessThan(6_000)
  },
  30_000
)

it('limits scale the time limits and leave the counts alone', async () => {
  const { limits } = await import('../scripts/eval/bakeoff/limits.mjs')
  const MIN = 60_000
  const counts = {
    operatorExchanges: 12,
    strayReplies: 3,
    retries: { noResult: 1, invalidJudgeReply: 1 },
    maxTurns: { contestant: 200, operator: 2, judge: 2, builder: 300 }
  }
  const expectTimes = (f: number): void => {
    expect({ ...limits.invocationMs }).toEqual({
      contestant: Math.round(45 * MIN * f),
      operator: Math.round(5 * MIN * f),
      judge: Math.round(15 * MIN * f),
      builder: Math.round(90 * MIN * f)
    })
    expect(limits.runMs).toBe(Math.round(150 * MIN * f))
    expect(limits.commandMs).toBe(Math.round(15 * MIN * f))
    expect(limits.validationMs).toBe(Math.round(5 * MIN * f))
    expect(limits).toMatchObject(counts)
  }

  vi.stubEnv('HARNU_BAKEOFF_TIMEOUT_SCALE', '')
  expectTimes(1)

  // The scale is read at each access, so a value taken earlier cannot go stale.
  const invocation = limits.invocationMs
  vi.stubEnv('HARNU_BAKEOFF_TIMEOUT_SCALE', '0.01')
  expectTimes(0.01)
  expect(invocation.judge).toBe(9_000)

  vi.unstubAllEnvs()
  delete process.env.HARNU_BAKEOFF_TIMEOUT_SCALE
  expectTimes(1)
})
