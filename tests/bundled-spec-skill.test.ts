/**
 * T601 S-3 (card T666) — the `spec` skill shell: triage first, the `check` verb, the catalog
 * row, and the staging that carries the vendored checker into any session.
 *
 * A skill is prose, so what is graded is the contract its text states (stable anchors: headings,
 * the verbatim funnel table, door and tier bullets, verb invocations, fenced command lines) and
 * the data it leans on (the real checker, staged by the real staging shell). Each check is a
 * pure function over the texts; every `it` runs it on the shipped files, where it must report
 * nothing, and on the mutated-text fixtures in `tests/fixtures/spec-skill/triage/mutations.json`,
 * where it must report something — so a check that stopped looking would fail here.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { it, expect, vi } from 'vitest'

import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'

const h = vi.hoisted(() => ({ userDataDir: '', appPath: '', home: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.appPath
  },
  ipcMain: { handle: (): void => {} }
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>()
  return { ...actual, homedir: (): string => h.home, default: { ...actual, homedir: () => h.home } }
})

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILL_DIR = path.join(REPO_ROOT, 'resources', 'skills', 'skills', 'spec')
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'spec-skill')
const SPEC = path.join(REPO_ROOT, 'docs', 'specs', '2026-11-harnu-spec', 'spec.md')

const readOr = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const flat = (s: string): string => s.replace(/\s+/g, ' ')

interface Docs {
  skill: string
  catalog: string
  userDoc: string
}

const realDocs = (): Docs => ({
  skill: readOr(path.join(SKILL_DIR, 'SKILL.md')),
  catalog: readOr(path.join(REPO_ROOT, 'resources', 'skills', 'CATALOG.md')),
  userDoc: readOr(path.join(REPO_ROOT, 'docs', 'user', 'bundled-skills.md'))
})

interface Mutation {
  target: keyof Docs
  find?: string
  pattern?: string
  replace: string
  why: string
}

const MUTATIONS = JSON.parse(
  readFileSync(path.join(FIXTURES, 'triage', 'mutations.json'), 'utf8')
) as Record<string, Mutation[]>

/** Apply one mutation; throws when its anchor is gone, so a fixture cannot silently go stale. */
function mutate(docs: Docs, m: Mutation): Docs {
  const text = docs[m.target]
  let next: string
  if (m.pattern != null) {
    const re = new RegExp(m.pattern)
    if (!re.test(text)) throw new Error(`mutation anchor /${m.pattern}/ not found (${m.why})`)
    next = text.replace(re, m.replace)
  } else {
    if (!text.includes(m.find!)) throw new Error(`mutation anchor not found: ${m.find} (${m.why})`)
    next = text.replace(m.find!, m.replace)
  }
  return { ...docs, [m.target]: next }
}

/** The real texts pass `check`; every mutation of its group fails it. */
function expectCheck(group: string, check: (d: Docs) => string[]): void {
  const docs = realDocs()
  expect(check(docs)).toEqual([])
  const mutations = MUTATIONS[group]
  expect(mutations.length).toBeGreaterThan(0)
  for (const m of mutations) {
    expect(check(mutate(docs, m)), `mutation should fail: ${m.why}`).not.toEqual([])
  }
}

// ---- Text helpers -----------------------------------------------------------------------------

/** The `## ` sections in order, each with its heading line and body lines. */
function sections(md: string): { heading: string; lines: string[] }[] {
  const out: { heading: string; lines: string[] }[] = []
  let inFence = false
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence
    if (!inFence && /^## /.test(line)) out.push({ heading: line, lines: [line] })
    else if (out.length > 0) out[out.length - 1].lines.push(line)
  }
  return out
}

/** The section whose heading matches, as text ('' when missing). */
function section(md: string, heading: RegExp): string {
  return (
    sections(md)
      .find((s) => heading.test(s.heading))
      ?.lines.join('\n') ?? ''
  )
}

const triageOf = (skill: string): string => section(skill, /^## Triage\s*$/)

/** The funnel table rows (`| You arrive with` header first), as raw lines. */
function funnelLines(md: string): string[] {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => /^\| You arrive with\s+\|/.test(l))
  if (start === -1) return []
  const out: string[] = []
  for (let i = start; i < lines.length && lines[i].startsWith('|'); i++) out.push(lines[i])
  return out
}

const cells = (row: string): string[] =>
  row
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim())

/** `- <kinds> → \`<door>\`<tail>` bullets of the Small path. */
function smallBullets(triage: string): { kinds: string[]; door: string; tail: string }[] {
  const out: { kinds: string[]; door: string; tail: string }[] = []
  for (const line of triage.split('\n')) {
    const m = /^- (.+?) → `([^`]+)`(.*)$/.exec(line)
    if (m) out.push({ kinds: m[1].split(', ').map((k) => k.trim()), door: m[2], tail: m[3] })
  }
  return out
}

/** `- \`<complexity>\`[, …][ with …] → **<Tier>** — <reason>` bullets of the tier pick. */
function tierBullets(
  triage: string
): { complexities: string[]; qualifier: string; tier: string; reason: string }[] {
  const out: { complexities: string[]; qualifier: string; tier: string; reason: string }[] = []
  for (const line of triage.split('\n')) {
    const m = /^- ((?:`\w+`(?:, )?)+)( with [^→]+)? → \*\*(\w+)\*\* — (.+)$/.exec(line)
    if (!m) continue
    out.push({
      complexities: [...m[1].matchAll(/`(\w+)`/g)].map((x) => x[1]),
      qualifier: (m[2] ?? '').trim(),
      tier: m[3],
      reason: m[4].trim()
    })
  }
  return out
}

// ---- Checks (each returns its problems; [] is a pass) ------------------------------------------

interface SmallEntry {
  id: string
  entry: string
  kind: string
  door: string
  tier: string
  adr: boolean
}
interface TierEntry {
  id: string
  entry: string
  complexity: string
  records: boolean
  tier: string
}

const SMALL_ENTRIES = JSON.parse(
  readFileSync(path.join(FIXTURES, 'triage', 'small-entries.json'), 'utf8')
) as SmallEntry[]
const TIER_ENTRIES = JSON.parse(
  readFileSync(path.join(FIXTURES, 'triage', 'tier-entries.json'), 'utf8')
) as TierEntry[]

/** AC-9: the funnel table verbatim, and every Small fixture ends at its door with nothing run. */
function smallDoorProblems({ skill }: Docs): string[] {
  const problems: string[] = []
  const triage = triageOf(skill)
  if (!triage) return ['no `## Triage` section']

  const table = funnelLines(triage)
  const specTable = funnelLines(readFileSync(SPEC, 'utf8'))
  if (specTable.length !== 10) problems.push('the spec funnel table could not be read')
  if (table.join('\n') !== specTable.join('\n'))
    problems.push('the triage funnel table is not the spec table verbatim')
  const doors = new Map<string, string[]>()
  for (const row of table.slice(2)) {
    const [door, first, becomes] = cells(row)
    if (!first) problems.push(`door "${door}" has no first step`)
    if (!becomes) problems.push(`door "${door}" has no "becomes" cell`)
    doors.set(door, [first, becomes])
  }

  const f = flat(triage)
  if (!/\*\*Small ends here\.\*\*/.test(f)) problems.push('no "Small ends here." anchor')
  for (const ban of ['no spec file', 'no mission', 'no sub-agent', 'no lint run', 'no tool call']) {
    if (!f.toLowerCase().includes(ban)) problems.push(`the Small path does not say "${ban}"`)
  }
  if (!/Tier: Small/.test(f)) problems.push('the Small answer does not name the tier')

  const bullets = smallBullets(triage)
  for (const e of SMALL_ENTRIES) {
    const hits = bullets.filter((b) => b.kinds.includes(e.kind))
    if (hits.length !== 1) {
      problems.push(`${e.id}: ${hits.length} Small bullets name "${e.kind}"`)
      continue
    }
    const [hit] = hits
    if (hit.door !== e.door) problems.push(`${e.id}: door is ${hit.door}, expected ${e.door}`)
    if (!doors.has(hit.door)) problems.push(`${e.id}: door "${hit.door}" is not a funnel row`)
    if (e.adr && !(/\bADR\b/.test(hit.tail) && /never a spec/.test(hit.tail)))
      problems.push(`${e.id}: an architectural question is not sent to an ADR`)
    if (!e.adr && /\bspec\b/.test(hit.tail)) problems.push(`${e.id}: a Small door leads to a spec`)
  }
  return problems
}

/** AC-10: the tier fixtures map to Medium, Large and Complex, each with a one-line reason. */
function tierProblems({ skill }: Docs): string[] {
  const problems: string[] = []
  const triage = triageOf(skill)
  const bullets = tierBullets(triage)
  for (const e of TIER_ENTRIES) {
    const hits = bullets.filter(
      (b) => b.complexities.includes(e.complexity) && (b.qualifier !== '') === e.records
    )
    if (hits.length !== 1) {
      problems.push(`${e.id}: ${hits.length} tier bullets match`)
      continue
    }
    const [hit] = hits
    if (hit.tier !== e.tier) problems.push(`${e.id}: tier is ${hit.tier}, expected ${e.tier}`)
    if (hit.reason.length < 10) problems.push(`${e.id}: no one-line reason`)
    if (e.records && !/D-n/.test(hit.qualifier) && !/non-goal/.test(hit.qualifier))
      problems.push(`${e.id}: Large does not name a D-n or a non-goal`)
  }
  const f = flat(triage)
  if (!/Tier: <tier> — <reason>/.test(f)) problems.push('the tier answer carries no reason slot')
  if (!/One word overrides it/.test(f)) problems.push('no one-word override')
  for (const w of ['small', 'medium', 'large', 'complex']) {
    if (!f.includes(`\`${w}\``)) problems.push(`override word \`${w}\` is not listed`)
  }
  return problems
}

/** AC-11: Triage is the first section, at most 40 lines, and holds nothing of Medium-and-up. */
function shapeProblems({ skill }: Docs): string[] {
  const problems: string[] = []
  const all = sections(skill)
  if (all[0]?.heading.trim() !== '## Triage') problems.push('the first section is not Triage')
  const body = skill.replace(/^---\n[\s\S]*?\n---\n/, '')
  const beforeTriage = body.slice(0, Math.max(0, body.indexOf('\n## Triage\n')))
  if (/^#{2,} /m.test(beforeTriage)) problems.push('a heading sits before Triage')

  const lines = (all[0]?.lines ?? []).slice()
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length === 0 || lines.length > 40)
    problems.push(`the triage section is ${lines.length} lines (at most 40)`)

  const triage = lines.join('\n')
  for (const leak of [
    /mission_\w+/,
    /open_file/,
    /spec-check\.mjs/,
    /memory_append/,
    /Agent tool|sub-agent spawn/i
  ]) {
    if (leak.test(triage)) problems.push(`the triage section names ${leak}`)
  }
  if (!/\*\*Small ends here\.\*\*/.test(triage)) problems.push('the Small path is not in triage')
  if (!all.slice(1).some((s) => /^## Medium and up\b/.test(s.heading)))
    problems.push('no later "## Medium and up" section')
  return problems
}

/** AC-12: the description says every-entry / most-end-Small; exactly two verbs, no derive/close. */
function descriptionProblems({ skill }: Docs): string[] {
  const problems: string[] = []
  const parsed = parseSkillFrontmatter(skill, 'spec')
  if (parsed?.name !== 'spec') return ['the frontmatter does not parse as `spec`']
  const d = parsed.description
  if (!/called at every entry/i.test(d)) problems.push('the description does not say every entry')
  if (!/most calls end Small/.test(d)) problems.push('the description does not say most end Small')

  const invoked = new Set([...skill.matchAll(/\/harnu:spec\s+([^\s`'"]+)/g)].map((m) => m[1]))
  const expected = new Set(['<entry>', 'check'])
  if ([...invoked].sort().join() !== [...expected].sort().join())
    problems.push(`verbs invoked: ${[...invoked].join(', ')}`)

  const verbs = section(skill, /^## Verbs\s*$/)
    .split('\n')
    .filter((l) => /^- `\/harnu:spec/.test(l))
    .map((l) => /^- `([^`]+)`/.exec(l)![1])
  if (verbs.join(' | ') !== '/harnu:spec <entry> | /harnu:spec check [--cards]')
    problems.push(`the Verbs section lists: ${verbs.join(' | ')}`)
  if (sections(skill).some((s) => /\b(derive|close)\b/i.test(s.heading)))
    problems.push('a heading names derive or close')
  return problems
}

/** AC-13: parses, catalog row, user-doc row, no personal path, catalog marker at least v14. */
function registeredProblems({ skill, catalog, userDoc }: Docs): string[] {
  const problems: string[] = []
  if (parseSkillFrontmatter(skill, 'spec')?.name !== 'spec') problems.push('does not parse')
  const row = /^\|\s*`spec`\s*\|\s*\S/m
  if (!row.test(catalog)) problems.push('no `spec` row in CATALOG.md')
  if (!row.test(userDoc)) problems.push('no `spec` row in docs/user/bundled-skills.md')
  if (/\/(home|Users)\/[A-Za-z0-9._-]+\//.test(skill)) problems.push('a personal path')
  if (/Junielton/i.test(skill)) problems.push('an operator name')
  if (/\$\d/.test(skill)) problems.push('a dollar sign before a digit (the loader substitutes it)')
  const marker = /^<!-- harnu-skills v(\d+) /.exec(catalog)
  if (!marker || Number(marker[1]) < 14) problems.push('the catalog marker is below v14')
  return problems
}

/** AC-14: the check section names the staged command, the base directory and the path rule. */
function checkVerbProblems({ skill }: Docs): string[] {
  const problems: string[] = []
  const sec = section(skill, /^## `check \[--cards\]`\s*$/)
  if (!sec) return ['no "## `check [--cards]`" section']
  const lines = sec.split('\n').map((l) => l.trim())
  for (const cmd of [
    'node <skill directory>/scripts/spec-check.mjs <spec-path>',
    'node <skill directory>/scripts/spec-check.mjs <spec-path> --cards'
  ]) {
    if (!lines.includes(cmd)) problems.push(`missing command line: ${cmd}`)
  }
  const f = flat(sec)
  if (!/skill directory is the base directory/.test(f))
    problems.push('does not say the skill directory is the base directory')
  if (!/when this skill loads/.test(f)) problems.push('does not say when the session is told')
  if (!/\*\*Resolving `<spec-path>`\*\*/.test(f)) problems.push('no path-resolution rule')
  if (!/mission as scope/.test(f)) problems.push('path rule skips the mission scope')
  if (!/changed on the branch/.test(f)) problems.push('path rule skips the branch diff')
  if (!/ask/i.test(f)) problems.push('path rule never asks')
  if (/by[ -]hand|manually|\b(grep|awk|sed|rg)\b/i.test(f))
    problems.push('the check section carries a by-hand variant')
  if (!existsSync(path.join(SKILL_DIR, 'scripts', 'spec-check.mjs')))
    problems.push('the named script is not in the skill directory')
  return problems
}

// ---- The proofs --------------------------------------------------------------------------------

it('triage ends the small doors without a spec', () => {
  expectCheck('smallDoors', smallDoorProblems)
})

it('triage picks the tier and states the reason', () => {
  expectCheck('tiers', tierProblems)
})

it('the small path is first and short', () => {
  expectCheck('shape', shapeProblems)
})

it('description states every-entry and two verbs only', () => {
  expectCheck('description', descriptionProblems)
})

it('registered in the catalog and the user doc', () => {
  expectCheck('registered', registeredProblems)
})

it('the check verb names the staged command', () => {
  expectCheck('checkVerb', checkVerbProblems)
})

// ---- AC-31: the real staging shell, then the staged checker from a directory with no Harnu file

async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(root, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(path.relative(root, path.join(e.parentPath, e.name)))
  }
  return out.sort()
}

it('staging copies scripts beside SKILL.md and the staged checker runs anywhere', async () => {
  const tmp = (p: string): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), p))
  h.userDataDir = await tmp('harnu-spec-ud-')
  h.appPath = await tmp('harnu-spec-app-')
  h.home = await tmp('harnu-spec-home-')

  // A resources tree holding the REAL spec skill (and the real plugin manifest and catalog).
  const res = path.join(REPO_ROOT, 'resources', 'skills')
  const base = path.join(h.appPath, 'resources', 'skills')
  await fs.mkdir(path.join(base, '.claude-plugin'), { recursive: true })
  await fs.copyFile(
    path.join(res, '.claude-plugin', 'plugin.json'),
    path.join(base, '.claude-plugin', 'plugin.json')
  )
  await fs.copyFile(path.join(res, 'CATALOG.md'), path.join(base, 'CATALOG.md'))
  const src = path.join(base, 'skills', 'spec')
  await fs.cp(SKILL_DIR, src, { recursive: true })
  // Until S-9 ships the personas, a fixture stands in so the copy of `agents/` is exercised.
  if (!existsSync(path.join(SKILL_DIR, 'agents'))) {
    await fs.cp(path.join(FIXTURES, 'staging', 'agents'), path.join(src, 'agents'), {
      recursive: true
    })
  }
  await fs.writeFile(
    path.join(h.userDataDir, 'bundled-skills.json'),
    JSON.stringify({ version: 1, enabled: { spec: true }, userLevelInstall: {} }),
    'utf8'
  )

  vi.resetModules()
  const m = await import('../src/main/bundled-skills')
  const staged = await m.stageSkillsForFolder(await tmp('harnu-spec-folder-'))
  expect(staged?.enabled).toEqual(['spec'])
  const stagedSkill = path.join(staged!.dir, 'skills', 'spec')

  const want = await filesUnder(src)
  expect(want).toContain('SKILL.md')
  expect(want.some((f) => f.startsWith(`scripts${path.sep}`))).toBe(true)
  expect(want.some((f) => f.startsWith(`agents${path.sep}`))).toBe(true)
  expect(await filesUnder(stagedSkill)).toEqual(want)
  for (const f of want) {
    expect(
      (await fs.readFile(path.join(stagedSkill, f))).equals(await fs.readFile(path.join(src, f)))
    ).toBe(true)
  }
  expect(stagedSkill.startsWith(REPO_ROOT)).toBe(false)

  // Run the staged checker from a fresh directory outside any repo, with no Harnu file in it.
  const anywhere = await tmp('harnu-spec-anywhere-')
  await fs.copyFile(path.join(FIXTURES, 'staging', 'clean-spec.md'), path.join(anywhere, 'spec.md'))
  await fs.copyFile(
    path.join(FIXTURES, 'staging', 'defective-spec.md'),
    path.join(anywhere, 'defective.md')
  )
  expect((await fs.readdir(anywhere)).sort()).toEqual(['defective.md', 'spec.md'])
  expect(() =>
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: anywhere, stdio: 'ignore' })
  ).toThrow()

  const env = { ...process.env }
  delete env.GATE_TRACKED_FILES
  const run = (...args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [path.join(stagedSkill, 'scripts', 'spec-check.mjs'), ...args], {
      cwd: anywhere,
      env,
      encoding: 'utf8'
    })

  const clean = run('spec.md')
  expect(clean.stdout).toBe('')
  expect(clean.status).toBe(0)

  const defective = run('defective.md')
  expect(defective.status).toBe(1)
  expect(defective.stdout).toMatch(/^defective\.md:\d+ \[missing-producer\] /m)
  expect(defective.stdout).toMatch(/^defective\.md:\d+ \[uncovered-atom\] /m)

  expect(run('missing.md').status).toBe(2)
  expect(run().status).toBe(2)
})
