/**
 * T601 S-4 (card T668), AC-15 — three recorded authoring runs of the `spec` skill.
 *
 * Each run under `tests/fixtures/spec-skill/authoring/runs/<name>/` is one session that followed
 * the skill's Medium-and-up procedure on one recorded input: a brainstorm, a scope-task report
 * and a PRD. A run commits its input (`input.md`), its session note (`session.md`) and what it
 * wrote, as a repo tree under `repo/` (the spec at `docs/specs/YYYY-MM-DD-<slug>/spec.md`, and for
 * a Complex run the PRD and ADR at their tracked paths). `run.json` names the files and how the
 * input lists its requests.
 *
 * The proof is the real checker on the real output: each `repo/` tree is copied into a fresh git
 * repo, every file is added (so the header paths are tracked as they would be in the PR), and the
 * vendored `spec-check.mjs` must exit 0 with no finding. The session note must record exactly one
 * checker run and that it was clean, so "first run" is what was recorded, not what was re-tried.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, promises as fs, readdirSync, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect, it } from 'vitest'

import { parseSpec } from '../resources/skills/skills/spec/scripts/spec-check-core.mjs'
import { parseHeader } from '../resources/skills/skills/spec/scripts/spec-gate-core.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const CHECKER = path.join(
  REPO_ROOT,
  'resources',
  'skills',
  'skills',
  'spec',
  'scripts',
  'spec-check.mjs'
)
const RUNS = path.join(REPO_ROOT, 'tests', 'fixtures', 'spec-skill', 'authoring', 'runs')

interface Run {
  kind: 'brainstorm' | 'scope-task' | 'prd'
  input: string
  session: string
  spec: string
  tier: 'medium' | 'large' | 'complex'
  requests: { heading: string; item: string }
}

const runs = (): { name: string; dir: string; run: Run }[] =>
  existsSync(RUNS)
    ? readdirSync(RUNS, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const dir = path.join(RUNS, e.name)
          const run = JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8')) as Run
          return { name: e.name, dir, run }
        })
    : []

/** The lines of the `## <heading>` section of a markdown text. */
function sectionLines(md: string, heading: string): string[] {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`)
  if (start === -1) return []
  const out: string[] = []
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) out.push(lines[i])
  return out
}

/** Copy `repo/` into a fresh git repo with every file added, and run the checker there. */
async function checkInFreshRepo(
  repoDir: string,
  spec: string
): Promise<ReturnType<typeof spawnSync>> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-spec-authoring-'))
  await fs.cp(repoDir, tmp, { recursive: true })
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd: tmp, stdio: 'ignore' })
  }
  git('init', '-q')
  git('add', '-A')
  const env = { ...process.env }
  delete env.GATE_TRACKED_FILES
  return spawnSync(process.execPath, [CHECKER, spec], { cwd: tmp, env, encoding: 'utf8' })
}

it('recorded authoring runs pass the gate and the checks', async () => {
  const all = runs()
  expect(all.map((r) => r.run.kind).sort()).toEqual(['brainstorm', 'prd', 'scope-task'])

  for (const { name, dir, run } of all) {
    const where = `run ${name}`
    // The input, the session note and the spec are committed.
    for (const f of [run.input, run.session, path.join('repo', run.spec)]) {
      expect(existsSync(path.join(dir, f)), `${where}: ${f} is committed`).toBe(true)
    }
    expect(run.spec, `${where}: the spec path`).toMatch(
      /^docs\/specs\/\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\/spec\.md$/
    )

    // At least as many atoms as the input lists requests.
    const input = readFileSync(path.join(dir, run.input), 'utf8')
    const item = new RegExp(run.requests.item)
    const requests = sectionLines(input, run.requests.heading).filter((l) => item.test(l))
    expect(requests.length, `${where}: the input lists its requests`).toBeGreaterThan(0)
    const specText = readFileSync(path.join(dir, 'repo', run.spec), 'utf8')
    const parsed = parseSpec(specText)
    expect(parsed.atoms.length, `${where}: atoms vs requests`).toBeGreaterThanOrEqual(
      requests.length
    )

    // The tier the run chose, still a draft at hand-over.
    const header = parseHeader(specText).header
    expect(header?.tier, `${where}: tier`).toBe(run.tier)
    expect(header?.status, `${where}: status`).toBe('draft')

    // The real checker, in a fresh repo holding only what the run wrote: clean.
    const result = await checkInFreshRepo(path.join(dir, 'repo'), run.spec)
    expect(result.stdout, `${where}: checker findings`).toBe('')
    expect(result.status, `${where}: checker exit`).toBe(0)

    // The session note: the triage answer names the tier, facts come before decisions, and the
    // checker ran exactly once, clean.
    const session = readFileSync(path.join(dir, run.session), 'utf8')
    const tierWord = run.tier[0].toUpperCase() + run.tier.slice(1)
    expect(session, `${where}: triage answer`).toMatch(
      new RegExp(`^Door: .+ · Tier: ${tierWord} — .+\\.`, 'm')
    )
    const order = ['## Triage', '## Facts', '## Decisions', '## Check'].map((h) =>
      session.split('\n').findIndex((l) => l.trim() === h)
    )
    expect(
      order.every((i) => i !== -1),
      `${where}: session headings ${order}`
    ).toBe(true)
    expect(
      [...order].sort((a, b) => a - b),
      `${where}: session order`
    ).toEqual(order)
    const runsOfChecker = session.split('\n').filter((l) => /^\$ node \S*spec-check\.mjs /.test(l))
    expect(runsOfChecker, `${where}: checker runs recorded`).toEqual([
      `$ node <skill directory>/scripts/spec-check.mjs ${run.spec}`
    ])
    expect(sectionLines(session, 'Check').join('\n'), `${where}: first run clean`).toContain(
      `spec-check: ${run.spec} is clean`
    )

    // A Complex run carries its PRD (and ADR, when it records one) at tracked paths it wrote.
    if (run.tier === 'complex') {
      expect(header?.prd, `${where}: prd`).toMatch(/^docs\/prds\/[A-Z]+\d+-[a-z0-9-]+\.md$/)
      for (const field of ['prd', 'adr', 'mockup'] as const) {
        const p = header?.[field]
        if (p) expect(existsSync(path.join(dir, 'repo', p)), `${where}: ${field} ${p}`).toBe(true)
      }
    }
  }
})
