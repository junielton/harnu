/**
 * T676 S-7 — corpus v1, the six committed dev problems of
 * `scripts/eval/bakeoff/corpus/dev/`. Reads committed files only: no network, no
 * target checkout. Their actual validation is AC-24, a script proof.
 */
import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = resolve(__dirname, '..')
const CORPUS = resolve(REPO, 'scripts/eval/bakeoff/corpus/dev')
const CORPUS_MODULE = resolve(REPO, 'scripts/eval/bakeoff/corpus.mjs')
const S10 = resolve(REPO, 'docs/specs/2026-11-harnu-spec/bakeoff')
const P1 = 'sqlite-utils-json-key'
const RECONSTRUCTED_REFERENCE_SHA256 =
  'daa790468d8a2f29e56ab3c280972b9120e759a61c0e1dbd8c9cfa73966a94fc'

interface Problem {
  id: string
  kind: string
  language: string
  dir: string
  target: { repo: string; commit: string }
  hidden: { files: string[]; compileErrorPattern: string }
  provenance: {
    authoredAt: string
    authoredBy: string
    sandbox: boolean
    reviewedAt: string | null
    reviewedBy: string | null
  }
}

async function loadDev(): Promise<Problem[]> {
  const { loadCorpus } = await import(/* @vite-ignore */ pathToFileURL(CORPUS_MODULE).href)
  const { problems, errors } = loadCorpus(CORPUS, { split: 'dev' })
  expect(errors).toEqual([])
  return problems
}

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

/** The quoted text under "## The request", unquoted. */
function s10Request(): string {
  const text = readFileSync(join(S10, 'input/feature-request.md'), 'utf8')
  const section = text.slice(text.indexOf('## The request') + '## The request'.length)
  return `${section
    .split('\n')
    .filter((line) => line.startsWith('>'))
    .map((line) => line.replace(/^> ?/, ''))
    .join('\n')
    .trim()}\n`
}

it('dev corpus v1 matches the slot table', async () => {
  const problems = await loadDev()
  const slots = problems.map((p) => `${p.language} ${p.kind}`).sort()
  expect(slots).toEqual(
    [
      'python feature',
      'python bug',
      'typescript feature',
      'typescript refactor',
      'go bug',
      'go refactor'
    ].sort()
  )
  expect(problems.find((p) => p.language === 'python' && p.kind === 'feature')?.id).toBe(P1)
  expect(new Set(problems.map((p) => p.target.repo)).size).toBe(6)
})

it('the S-10 input is migrated byte for byte', async () => {
  const problem = (await loadDev()).find((p) => p.id === P1)
  expect(problem).toBeDefined()
  const dir = (problem as Problem).dir
  expect(problem?.target).toEqual({
    repo: 'https://github.com/simonw/sqlite-utils',
    commit: '9c66bafa52ae23d40499c74b0db3b635bcddb876'
  })
  for (const [mine, theirs] of [
    ['answer-sheet.md', 'input/answer-sheet.md'],
    ['hidden/atoms.md', 'hidden/atoms.md'],
    ['hidden/test_hidden_bakeoff.py', 'hidden/test_hidden_bakeoff.py']
  ]) {
    expect(sha256(join(dir, mine)), mine).toBe(sha256(join(S10, theirs)))
  }
  // The one deviation from byte-for-byte (spec Amendments): the S-10 reference.patch is compacted
  // `rtk git diff` output, which `git apply` refuses, so validation could never pass with it. P1
  // carries the patch rebuilt from that file by restoring the leading context it dropped.
  expect(sha256(join(dir, 'hidden/reference.patch'))).toBe(RECONSTRUCTED_REFERENCE_SHA256)
  expect(readFileSync(join(dir, 'request.md'), 'utf8')).toBe(s10Request())
  expect(problem?.hidden.compileErrorPattern).toBe('(ImportError|ModuleNotFoundError|SyntaxError)')
  expect(problem?.provenance).toMatchObject({
    authoredAt: '2026-11-07T15:09:11-03:00',
    authoredBy: 'T601 S-10 orchestrator',
    sandbox: false
  })
  // AC-26 stamps these after merge; the operator's review changes nothing else here.
  expect(
    typeof problem?.provenance.reviewedAt === 'string' || problem?.provenance.reviewedAt === null
  ).toBe(true)
  expect(
    typeof problem?.provenance.reviewedBy === 'string' || problem?.provenance.reviewedBy === null
  ).toBe(true)
})

it('the six dev problems carry a pick log and P2-P6 were authored in the sandbox', async () => {
  const problems = await loadDev()
  expect(problems).toHaveLength(6)
  for (const problem of problems) {
    const pick = readFileSync(join(problem.dir, 'pick.md'), 'utf8')
    expect(pick.trim().length, `${problem.id}/pick.md`).toBeGreaterThan(0)
    if (problem.id === P1) {
      expect(pick, 'P1 records the S-10 hand-pick').toMatch(/#489/)
      continue
    }
    expect(problem.provenance.sandbox, problem.id).toBe(true)
    for (const section of [/candidates/i, /rule/i, /date/i, /chosen/i]) {
      expect(pick, `${problem.id}/pick.md`).toMatch(section)
    }
    expect(pick, `${problem.id}/pick.md`).toContain(problem.target.commit)
  }
})
