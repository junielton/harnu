/**
 * T601 S-9 (card T669) — the Goldfish review of the `spec` skill: the staged reviewers, their
 * persona files under `agents/`, the paths-only spawn payload, the paraphrase-first comprehension
 * report, the readiness zero-decision rule, the `critics.md` lint of `spec-check`, the no-code
 * check before the approval question, and the records the review leaves in Harnu (a `mission_log`
 * per disposition, a `memory_append` per resolved decision).
 *
 * The skill and its personas are prose, so what is graded is the contract their text states
 * (stable anchors: headings, the verbatim stage table, persona file names, fenced payloads parsed
 * against the real verb schemas, a fenced shell check run in a real git repo) and the code they
 * lean on (the real `critics.md` lint, on the fixtures under `tests/fixtures/spec-skill/review/`).
 * Each text check is a pure function over the texts; every `it` runs it on the shipped files,
 * where it must report nothing, and on the mutated-text fixtures in
 * `tests/fixtures/spec-skill/review/mutations.json`, where it must report something.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, promises as fs, mkdtempSync, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect, it, vi } from 'vitest'
import type { z } from 'zod'

import {
  checkCritics,
  parseCritics,
  parseSpec
} from '../resources/skills/skills/spec/scripts/spec-check-core.mjs'
import { toolByName } from '../src/main/mcp/tool-catalog'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => os.tmpdir(), getAppPath: (): string => '' },
  ipcMain: { handle: (): void => {} }
}))

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILL_DIR = path.join(REPO_ROOT, 'resources', 'skills', 'skills', 'spec')
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'spec-skill', 'review')
const CHECKER = path.join(SKILL_DIR, 'scripts', 'spec-check.mjs')
const SPEC = path.join(REPO_ROOT, 'docs', 'specs', '2026-11-harnu-spec', 'spec.md')

const PERSONAS = ['comprehension', 'critic', 'readiness', 'overhead', 'traceability'] as const
type Persona = (typeof PERSONAS)[number]

const readOr = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const flat = (s: string): string => s.replace(/\s+/g, ' ')

type Docs = { skill: string } & Record<Persona, string>

const realDocs = (): Docs => {
  const docs = { skill: readOr(path.join(SKILL_DIR, 'SKILL.md')) } as Docs
  for (const p of PERSONAS) docs[p] = readOr(path.join(SKILL_DIR, 'agents', `${p}.md`))
  return docs
}

interface Mutation {
  target: keyof Docs
  find?: string
  pattern?: string
  replace: string
  why: string
}

const MUTATIONS = JSON.parse(readFileSync(path.join(FIXTURES, 'mutations.json'), 'utf8')) as Record<
  string,
  Mutation[]
>

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

/** The `## ` sections in order, each with its heading line and body lines (fences respected). */
function sections(md: string): { heading: string; lines: string[] }[] {
  const out: { heading: string; lines: string[] }[] = []
  let inFence = false
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (!inFence && /^## /.test(line)) out.push({ heading: line, lines: [line] })
    else if (out.length > 0) out[out.length - 1].lines.push(line)
  }
  return out
}

const section = (md: string, heading: RegExp): string =>
  sections(md)
    .find((s) => heading.test(s.heading))
    ?.lines.join('\n') ?? ''

const reviewOf = (skill: string): string => section(skill, /^## Goldfish review\s*$/)

/** The fenced blocks of a text, with their info string. */
function fences(md: string): { lang: string; body: string }[] {
  const out: { lang: string; body: string }[] = []
  let current: { lang: string; lines: string[] } | null = null
  for (const line of md.split('\n')) {
    const m = /^\s*```(\S*)/.exec(line)
    if (m) {
      if (current) {
        out.push({ lang: current.lang, body: current.lines.join('\n') })
        current = null
      } else current = { lang: m[1], lines: [] }
    } else if (current) current.lines.push(line)
  }
  return out
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

/** The stage table rows (`| Tier    | Stage 1` header first), as raw lines. */
function stageTableLines(md: string): string[] {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => /^\| Tier\s+\| Stage 1/.test(l))
  if (start === -1) return []
  const out: string[] = []
  for (let i = start; i < lines.length && lines[i].startsWith('|'); i++) out.push(lines[i])
  return out
}

/** The numbered authoring steps under "## Medium and up": `N. **Label.** …` plus its lines. */
function authoringSteps(skill: string): { n: number; label: string; text: string }[] {
  const out: { n: number; label: string; text: string }[] = []
  let current: { n: number; label: string; lines: string[] } | null = null
  const close = (): void => {
    if (current) out.push({ n: current.n, label: current.label, text: current.lines.join('\n') })
    current = null
  }
  for (const line of section(skill, /^## Medium and up\s*$/).split('\n')) {
    const m = /^(\d+)\. \*\*([^*]+?)\.?\*\*/.exec(line)
    if (m) {
      close()
      current = { n: Number(m[1]), label: m[2], lines: [line] }
    } else if (current && (/^\s+\S/.test(line) || line.trim() === '')) current.lines.push(line)
    else close()
  }
  close()
  return out
}

/** The persona table of the review section: reviewer → { persona, reading }. */
function personaTable(review: string): Map<string, { persona: string; reading: string }> {
  const out = new Map<string, { persona: string; reading: string }>()
  const lines = review.split('\n')
  const start = lines.findIndex((l) => /^\| Reviewer\s+\| Persona\s+\| Reading list/.test(l))
  if (start === -1) return out
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const [reviewer, persona, reading] = cells(lines[i])
    out.set(reviewer, { persona: persona.replace(/`/g, ''), reading })
  }
  return out
}

/** The one fenced JSON payload of `text` that has `key`, parsed (null when absent or unparsable). */
function payloadWith(text: string, key: string): Record<string, unknown> | null {
  for (const f of fences(text)) {
    if (f.lang !== 'json') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(f.body)
    } catch {
      continue
    }
    if (parsed && typeof parsed === 'object' && key in parsed)
      return parsed as Record<string, unknown>
  }
  return null
}

/** A payload's problems against a verb's real input schema: unknown keys, or a failed parse. */
function schemaProblems(verb: string, payload: Record<string, unknown> | null): string[] {
  if (!payload) return [`no fenced ${verb} payload`]
  const schema = toolByName(verb)?.inputSchema as z.ZodObject<z.ZodRawShape> | undefined
  if (!schema) return [`${verb} is not in the tool catalog`]
  const problems: string[] = []
  const known = new Set(Object.keys(schema.shape))
  for (const k of Object.keys(payload))
    if (!known.has(k)) problems.push(`${verb}: unknown key ${k}`)
  const result = schema.safeParse(payload)
  if (!result.success) problems.push(`${verb}: ${result.error.issues.map((i) => i.message)}`)
  return problems
}

// ---- AC-32: stages ----------------------------------------------------------------------------

function stageProblems({ skill }: Docs): string[] {
  const problems: string[] = []
  const review = reviewOf(skill)
  if (!review) return ['no "## Goldfish review" section']
  const table = stageTableLines(review)
  const specTable = stageTableLines(readFileSync(SPEC, 'utf8'))
  if (specTable.length !== 5) problems.push('the spec stage table could not be read')
  if (table.join('\n') !== specTable.join('\n'))
    problems.push('the stage table is not the spec table verbatim')
  for (const row of table.slice(2)) {
    const [tier, s1, s2, s3, n] = cells(row)
    const reviewers = [s1, ...s2.split(','), s3].map((s) => s.trim()).filter((s) => s && s !== '—')
    if (Number(n) !== reviewers.length)
      problems.push(`${tier}: ${n} sub-agents for ${reviewers.length} reviewers`)
    if (Number(n) > 5) problems.push(`${tier}: more than five sub-agents`)
  }
  const f = flat(review)
  if (!/in order/.test(f) || !/in parallel/.test(f))
    problems.push('stage order and in-stage parallelism are not stated')
  if (!/at most five sub-agents/.test(f)) problems.push('no five-sub-agent cap per round')
  if (!/One re-review per stage/.test(f)) problems.push('no one-re-review-per-stage bound')
  if (!/a Small entry spawns none/.test(f)) problems.push('a Small entry may spawn a reviewer')
  // Every reviewer of the table has a persona row.
  const personas = personaTable(review)
  for (const name of [
    'comprehension',
    'hostile critic',
    'overhead lens',
    'traceability lens',
    'implementation readiness'
  ]) {
    if (!personas.has(name)) problems.push(`no persona row for ${name}`)
  }
  return problems
}

it('stages follow the tier table and cap at five', () => {
  expectCheck('stages', stageProblems)
})

// ---- AC-33: personas and the spawn payload ----------------------------------------------------

/** The first paragraph after the `# ` title. */
function opening(md: string): string {
  const lines = md.split('\n')
  const title = lines.findIndex((l) => /^# /.test(l))
  if (title === -1) return ''
  const out: string[] = []
  for (let i = title + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      if (out.length > 0) break
      continue
    }
    if (/^#/.test(lines[i])) break
    out.push(lines[i])
  }
  return out.join(' ')
}

function personaProblems(docs: Docs): string[] {
  const problems: string[] = []
  for (const p of PERSONAS) {
    const text = docs[p]
    if (!text) {
      problems.push(`agents/${p}.md is missing`)
      continue
    }
    const open = opening(text)
    if (!/read-only/.test(open)) problems.push(`${p}: the opening has no read-only mandate`)
    if (!/no history/.test(open)) problems.push(`${p}: the opening has no no-history mandate`)
    if (!/conversation/.test(open)) problems.push(`${p}: the opening does not rule out the chat`)
    const output = section(text, /^## Output\s*$/)
    if (!output) problems.push(`${p}: no "## Output" section`)
    for (const sev of ['Blocker', 'Major', 'Nit']) {
      if (!output.includes(`\`${sev}\``)) problems.push(`${p}: the output does not define ${sev}`)
    }
    const table = fences(output).some((f) =>
      f.body.split('\n').some((l) => /^\| severity\s+\|/.test(l))
    )
    if (!table) problems.push(`${p}: the report template has no severity column`)
  }

  const review = reviewOf(docs.skill)
  const personas = personaTable(review)
  for (const [reviewer, { persona }] of personas) {
    const name = /^agents\/([a-z]+)\.md$/.exec(persona)?.[1]
    if (!name || !(PERSONAS as readonly string[]).includes(name))
      problems.push(`${reviewer}: persona ${persona} is not one of the shipped files`)
  }
  const f = flat(review)
  if (!/`subagent_type: "general-purpose"`/.test(f))
    problems.push('a reviewer is not a general-purpose sub-agent')
  if (!/never `fork`/.test(f)) problems.push('a fork is not ruled out')
  if (!/absolute paths and nothing else/.test(f)) problems.push('the prompt is not paths only')
  const spawn = fences(review).find((x) => /^Persona: /m.test(x.body))
  if (!spawn) return [...problems, 'no fenced spawn prompt']
  const lines = spawn.body.split('\n').filter((l) => l.trim())
  const keys = lines.map((l) => /^([A-Za-z ]+): /.exec(l)?.[1])
  if (keys.join(',') !== 'Persona,Spec,Reading list')
    problems.push(`the spawn prompt lines are ${keys.join(', ')}`)
  const pathList = /^<absolute path[^<>]*>(?:, <absolute path[^<>]*>)*$/
  for (const l of lines) {
    const value = l.replace(/^[A-Za-z ]+: /, '')
    if (!pathList.test(value)) problems.push(`the spawn prompt carries more than paths: ${l}`)
  }
  return problems
}

it('personas exist and the spawn payload carries paths only', () => {
  expectCheck('personas', personaProblems)
})

// ---- AC-34: comprehension ---------------------------------------------------------------------

function comprehensionProblems(docs: Docs): string[] {
  const problems: string[] = []
  const report = fences(section(docs.comprehension, /^## Output\s*$/)).find((x) =>
    /^## /m.test(x.body)
  )
  const headings = (report?.body ?? '')
    .split('\n')
    .filter((l) => /^## /.test(l))
    .map((l) => l.slice(3).trim())
  if (headings[0] !== 'What this proposes' || headings[1] !== 'How the system works, per this spec')
    problems.push(`the comprehension report opens with: ${headings.slice(0, 2).join(' | ')}`)

  const review = reviewOf(docs.skill)
  const row = personaTable(review).get('comprehension')
  if (!row || !/^none\b/.test(row.reading)) problems.push('comprehension gets a reading list')
  const f = flat(review)
  if (!/compare the paraphrase with your intent/.test(f))
    problems.push('the Elephant does not compare the paraphrase with intent')
  if (!/a wrong paraphrase is a finding/.test(f))
    problems.push('a wrong paraphrase is not recorded as a finding')
  return problems
}

it('comprehension is paraphrase-first and reads the spec alone', () => {
  expectCheck('comprehension', comprehensionProblems)
})

// ---- AC-35: readiness -------------------------------------------------------------------------

function readinessProblems({ readiness }: Docs): string[] {
  const problems: string[] = []
  if (!/zero-decision rule/.test(readiness)) problems.push('no zero-decision rule')
  const lines = readiness.split('\n')
  const blockerLine = (re: RegExp): boolean => lines.some((l) => re.test(l) && /`Blocker`/.test(l))
  if (!blockerLine(/design choice/))
    problems.push('a slice that leaves a design choice is not a Blocker')
  if (!blockerLine(/`files-may-touch`.*concrete path|concrete path.*`files-may-touch`/))
    problems.push('a files-may-touch that is not a concrete path is not a Blocker')
  return problems
}

it('readiness fails a slice that leaves a decision', () => {
  expectCheck('readiness', readinessProblems)
})

// ---- AC-36: the critics.md lint ----------------------------------------------------------------

const CRITICS = path.join(FIXTURES, 'critics')
const fixtureSpec = parseSpec(readFileSync(path.join(CRITICS, 'spec.md'), 'utf8'))
const lint = (name: string): { line: number; rule: string; message: string }[] =>
  checkCritics(parseCritics(readFileSync(path.join(CRITICS, name), 'utf8')), fixtureSpec)

it('critics lint rejects undisposed findings, weak contests and missing reviewers', async () => {
  expect(lint('clean.md')).toEqual([])

  const undisposed = lint('undisposed.md')
  expect(undisposed.map((f) => f.rule)).toEqual([
    'undisposed-finding',
    'undisposed-finding',
    'undisposed-finding',
    'undisposed-finding'
  ])
  expect(undisposed.map((f) => f.message.split(' ')[0])).toEqual(['F-1', 'F-2', 'F-3', 'F-4'])
  expect(undisposed[1].message).toMatch(/D-7/)
  expect(undisposed[2].message).toMatch(/NG-9/)

  expect(lint('weak-contest.md').map((f) => [f.rule, f.message.split(' ')[0]])).toEqual([
    ['weak-contest', 'F-1'],
    ['weak-contest', 'F-2']
  ])
  const gap = lint('comprehension-contest.md')
  expect(gap.map((f) => f.rule)).toEqual(['weak-contest'])
  expect(gap[0].message).toMatch(/comprehension/)

  const notRun = lint('not-run.md')
  expect(notRun.map((f) => f.rule)).toEqual(['reviewer-not-run'])
  expect(notRun[0].message).toMatch(/readiness/)
  // The line points at the reviewer's row.
  const notRunLines = readFileSync(path.join(CRITICS, 'not-run.md'), 'utf8').split('\n')
  expect(notRunLines[notRun[0].line - 1]).toMatch(/^\| readiness /)

  // A free-form critics.md (the one this feature's own spec carries) is not in the review shape:
  // it is reported as information, never as a finding.
  const legacy = parseCritics(
    readFileSync(path.join(REPO_ROOT, 'docs', 'specs', '2026-11-harnu-spec', 'critics.md'), 'utf8')
  )
  expect(legacy.structured).toBe(false)

  // The critics.md shape the skill documents is the shape the lint reads.
  const template = fences(reviewOf(realDocs().skill)).find((x) => /^## Reviewers$/m.test(x.body))
  expect(template, 'a fenced critics.md template').toBeDefined()
  const parsedTemplate = parseCritics(template!.body)
  expect(parsedTemplate.structured).toBe(true)
  expect(parsedTemplate.reviewers.length).toBeGreaterThan(0)
  expect(parsedTemplate.findings.length).toBeGreaterThan(0)
  expect(template!.body).toMatch(/model/)
  expect(template!.body).toMatch(/`CLAUDE\.md` may reach the reviewer/)

  // The CLI reads critics.md beside the spec, prints its findings and exits 1.
  for (const [name, rule, exit] of [
    ['clean.md', null, 0],
    ['undisposed.md', 'undisposed-finding', 1],
    ['weak-contest.md', 'weak-contest', 1],
    ['not-run.md', 'reviewer-not-run', 1]
  ] as const) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-spec-critics-'))
    await fs.copyFile(path.join(CRITICS, 'spec.md'), path.join(dir, 'spec.md'))
    await fs.copyFile(path.join(CRITICS, name), path.join(dir, 'critics.md'))
    const r = spawnSync(process.execPath, [CHECKER, path.join(dir, 'spec.md')], {
      cwd: dir,
      env: { ...process.env, GATE_TRACKED_FILES: '' },
      encoding: 'utf8'
    })
    expect(r.status, `${name}: exit`).toBe(exit)
    if (rule) expect(r.stdout, name).toMatch(new RegExp(`critics\\.md:\\d+ \\[${rule}\\] `))
    else expect(r.stdout, name).toBe('')
  }
})

// ---- AC-37: the no-code check ------------------------------------------------------------------

const BUNDLE = {
  '<spec directory>': 'docs/specs/2026-11-07-badge',
  '<prd>': 'docs/prds/T900-badge.md',
  '<adr>': 'docs/adr/0900-badge.md',
  '<mockup folder>': 'docs/design/badge/'
}

/** Run the section's fenced check in a fresh repo; returns the paths it prints. */
function runNoCodeCheck(command: string, stray: boolean): string[] {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'harnu-spec-nocode-'))
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], {
      cwd: dir,
      encoding: 'utf8'
    }).trim()
  const write = (rel: string, text = 'x\n'): void => {
    execFileSync('mkdir', ['-p', path.dirname(path.join(dir, rel))])
    execFileSync('sh', ['-c', `printf '%s' "$1" > "$2"`, 'sh', text, path.join(dir, rel)])
  }
  git('init', '-q')
  write('README.md')
  write('src/app.ts')
  git('add', '-A')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  write(`${BUNDLE['<spec directory>']}/spec.md`)
  write(`${BUNDLE['<spec directory>']}/critics.md`)
  write(BUNDLE['<prd>'])
  write(BUNDLE['<adr>'])
  write(`${BUNDLE['<mockup folder>']}screen-1.html`)
  write('.harnu/out/note.md')
  git('add', BUNDLE['<prd>'])
  if (stray) {
    write('README.md', 'changed\n')
    write('src/stray.ts')
  }
  let cmd = command.replaceAll('<base>', base)
  for (const [k, v] of Object.entries(BUNDLE)) cmd = cmd.replaceAll(k, v)
  const r = spawnSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8' })
  return r.stdout.split('\n').filter(Boolean)
}

function noCodeProblems({ skill }: Docs): string[] {
  const problems: string[] = []
  const sec = section(skill, /^## Before the approval question\s*$/)
  if (!sec) return ['no "## Before the approval question" section']
  const sh = fences(sec).find((x) => x.lang === 'sh' && /<base>/.test(x.body))
  if (!sh) return [...problems, 'no fenced shell check']
  const command = sh.body.trim()
  const withStray = runNoCodeCheck(command, true)
  if (withStray.join(',') !== 'README.md,src/stray.ts')
    problems.push(`the check printed ${withStray.join(', ') || 'nothing'} for two stray paths`)
  const clean = runNoCodeCheck(command, false)
  if (clean.length > 0) problems.push(`the check printed ${clean.join(', ')} for a clean bundle`)

  const f = flat(sec)
  for (const part of ['spec directory', 'PRD', 'ADR', 'mockup folder'])
    if (!f.includes(part)) problems.push(`the bundle does not name the ${part}`)
  if (!/stop/i.test(f) || !/name every path/.test(f))
    problems.push('a path outside the bundle does not stop the skill, named')
  if (!/always runs/.test(f)) problems.push('the check does not always run (D-10)')
  if (!/`orchestrator_arm`/.test(f) || !/spawned for an agent/.test(f))
    problems.push('the guard is not armed in an agent-spawned session (D-10)')
  if (!toolByName('orchestrator_arm')) problems.push('orchestrator_arm is not a real verb')

  const steps = authoringSteps(skill)
  const approval = steps.find((s) => /^Approval question$/.test(s.label))
  if (!approval || !/^7\. \*\*Approval question\.\*\* Run the no-code check/.test(approval.text))
    problems.push('the approval step does not open with the no-code check')
  return problems
}

it('no-code check stops on a path outside the bundle', () => {
  expectCheck('noCode', noCodeProblems)
})

// ---- AC-38: dispositions on the Approve spec step -------------------------------------------

function dispositionProblems({ skill }: Docs): string[] {
  const review = reviewOf(skill)
  const payload = payloadWith(review, 'missionId')
  const problems = schemaProblems('mission_log', payload)
  if (payload && !('stepId' in payload)) problems.push('the mission_log payload has no stepId')
  if (payload && payload.kind !== 'decision') problems.push('the example kind is not decision')
  const f = flat(review)
  if (!/"Approve spec" step/.test(f)) problems.push('the log is not on the "Approve spec" step')
  if (!/one `mission_log`/.test(f)) problems.push('a disposition is not one mission_log')
  if (!/`kind: 'decision'`/.test(f) || !/`'surprise'`[^.]*changed the design/.test(f))
    problems.push('decision / surprise kinds are not stated')
  if (!/`Blocker`[^.]*open[^.]*the approval question is not asked/.test(f))
    problems.push('an open Blocker does not hold the approval question')
  return problems
}

it('dispositions are logged on the approve step and a blocker holds the question', () => {
  expectCheck('dispositions', dispositionProblems)
})

// ---- AC-39: resolved decisions in memory ------------------------------------------------------

function decisionProblems({ skill }: Docs): string[] {
  const review = reviewOf(skill)
  const payload = payloadWith(review, 'page')
  const problems = schemaProblems('memory_append', payload)
  if (payload) {
    if (payload.page !== 'decisions') problems.push('the page is not decisions')
    if (!Array.isArray(payload.watches) || payload.watches.length === 0)
      problems.push('no watches list')
  }
  const f = flat(review)
  if (!/one `memory_append` to `decisions`/.test(f))
    problems.push('a resolved D-n is not one memory_append to decisions')
  if (!/`watches` lists the `files-may-touch` of the slices whose `gated-by:` names it/.test(f))
    problems.push('watches is not the files-may-touch of the gated slices')
  return problems
}

it('resolved decisions land in memory with watches', () => {
  expectCheck('decisions', decisionProblems)
})
