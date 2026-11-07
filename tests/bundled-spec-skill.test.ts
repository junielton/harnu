/**
 * T601 S-3 (card T666) — the `spec` skill shell: triage first, the `check` verb, the catalog
 * row, and the staging that carries the vendored checker into any session.
 * T601 S-4 (card T668) — the Medium-and-up authoring text: facts before decisions, open D-n
 * rows left open, the Goldfish review before the approval question, amendment-only edits once a
 * slice has a card, the Complex bundle at tracked paths, and the template's four conventions (D-1).
 *
 * A skill is prose, so what is graded is the contract its text states (stable anchors: headings,
 * the verbatim funnel table, door and tier bullets, verb invocations, fenced command lines) and
 * the data it leans on (the real checker, staged by the real staging shell). Each check is a
 * pure function over the texts; every `it` runs it on the shipped files, where it must report
 * nothing, and on the mutated-text fixtures in `tests/fixtures/spec-skill/triage/mutations.json`
 * (S-3) and `tests/fixtures/spec-skill/authoring/mutations.json` (S-4), where it must report something — so a check that stopped looking would fail here.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { it, expect, vi } from 'vitest'

import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'
import {
  checkSpecFile,
  parseSpec
} from '../resources/skills/skills/spec/scripts/spec-check-core.mjs'
import { parseHeader } from '../resources/skills/skills/spec/scripts/spec-gate-core.mjs'

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
  template: string
}

const realDocs = (): Docs => ({
  skill: readOr(path.join(SKILL_DIR, 'SKILL.md')),
  catalog: readOr(path.join(REPO_ROOT, 'resources', 'skills', 'CATALOG.md')),
  userDoc: readOr(path.join(REPO_ROOT, 'docs', 'user', 'bundled-skills.md')),
  template: readOr(path.join(REPO_ROOT, 'docs', 'specs', 'TEMPLATE.md'))
})

interface Mutation {
  target: keyof Docs
  find?: string
  pattern?: string
  replace: string
  why: string
}

const readMutations = (group: string): Record<string, Mutation[]> =>
  JSON.parse(readFileSync(path.join(FIXTURES, group, 'mutations.json'), 'utf8')) as Record<
    string,
    Mutation[]
  >

const MUTATIONS = { ...readMutations('triage'), ...readMutations('authoring') }

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

// ---- S-4: the authoring text (Medium and up) ---------------------------------------------------

const mediumOf = (skill: string): string => section(skill, /^## Medium and up\s*$/)

/** The numbered steps of the authoring procedure, in order: `N. **Label.** …` plus its lines. */
function authoringSteps(skill: string): { n: number; label: string; text: string }[] {
  const out: { n: number; label: string; text: string }[] = []
  let current: { n: number; label: string; lines: string[] } | null = null
  const close = (): void => {
    if (current) out.push({ n: current.n, label: current.label, text: current.lines.join('\n') })
    current = null
  }
  for (const line of mediumOf(skill).split('\n')) {
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

/** The bodies of the fenced blocks of a text. */
function fences(md: string): string[] {
  const out: string[] = []
  let body: string[] | null = null
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (body) {
        out.push(body.join('\n'))
        body = null
      } else body = []
    } else if (body) body.push(line)
  }
  return out
}

const stepIndex = (steps: { label: string }[], label: RegExp): number =>
  steps.findIndex((s) => label.test(s.label))

/** The stage table rows (`| Tier    | Stage 1` header first), as raw lines. */
function stageTableLines(md: string): string[] {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => /^\| Tier\s+\| Stage 1/.test(l))
  if (start === -1) return []
  const out: string[] = []
  for (let i = start; i < lines.length && lines[i].startsWith('|'); i++) out.push(lines[i])
  return out
}

/** AC-16: facts first, then decisions one at a time through one-by-one; open rows stay open. */
function authoringOrderProblems({ skill }: Docs): string[] {
  const problems: string[] = []
  const steps = authoringSteps(skill)
  if (steps.length === 0) return ['no numbered authoring procedure under "## Medium and up"']
  steps.forEach((s, i) => {
    if (s.n !== i + 1) problems.push(`step "${s.label}" is numbered ${s.n}, expected ${i + 1}`)
  })
  const facts = stepIndex(steps, /^Facts first$/)
  const decisions = stepIndex(steps, /^Decisions, one at a time$/)
  if (facts !== 0) problems.push('the first authoring step is not "Facts first"')
  if (decisions === -1) problems.push('no "Decisions, one at a time" step')
  else if (facts !== -1 && decisions < facts) problems.push('decisions are asked before facts')
  const factText = facts === -1 ? '' : flat(steps[facts].text)
  for (const [what, re] of [
    ['`memory_query`', /`memory_query`/],
    ['the lessons', /lessons/i],
    ['the code', /\bcode\b/]
  ] as const) {
    if (!re.test(factText)) problems.push(`"Facts first" does not look up ${what}`)
  }
  const decText = decisions === -1 ? '' : flat(steps[decisions].text)
  if (!/`harnu:one-by-one`/.test(decText)) problems.push('decisions do not go through one-by-one')
  if (!/one question per message/.test(decText)) problems.push('decisions are not one per message')
  if (!/unanswered D-n stays `open`/.test(decText))
    problems.push('an unanswered D-n is not kept open')
  if (!/default/.test(decText)) problems.push('an open D-n does not show its default')
  if (!/never [^.]*`declined`/.test(decText)) problems.push('an open D-n may be written declined')
  if (!/never [^.]*`resolved`/.test(decText)) problems.push('an open D-n may be written resolved')

  const rows = fences(mediumOf(skill))
    .flatMap((f) => f.split('\n'))
    .filter((l) => /^\| D-n /.test(l))
    .map(cells)
  if (rows.length !== 1) problems.push(`${rows.length} fenced D-n example rows (expected 1)`)
  else {
    const [, question, options, def, status] = rows[0]
    if (!question || !options) problems.push('the D-n example row has no question or options')
    if (!def) problems.push('the D-n example row shows no default')
    if (status !== 'open') problems.push(`the D-n example row's status is "${status}", not open`)
  }
  return problems
}

/** AC-17: the Goldfish review runs after `check` and before the approval question; no builder-check. */
function reviewProblems({ skill }: Docs): string[] {
  const problems: string[] = []
  const steps = authoringSteps(skill)
  const check = stepIndex(steps, /^Check$/)
  const review = stepIndex(steps, /^Goldfish review$/)
  const approval = stepIndex(steps, /^Approval question$/)
  if (check === -1) problems.push('no "Check" step')
  if (review === -1) problems.push('no "Goldfish review" step')
  if (approval === -1) problems.push('no "Approval question" step')
  const n = (i: number): number => steps[i].n
  if (review !== -1 && approval !== -1 && (review > approval || n(review) > n(approval)))
    problems.push('the approval question is asked before the Goldfish review')
  if (check !== -1 && review !== -1 && (check > review || n(check) > n(review)))
    problems.push('the Goldfish review runs before the spec is checked')
  if (/builder[- ]check/i.test(skill)) problems.push('the text still describes a builder-check')

  const sec = section(skill, /^## Goldfish review\s*$/)
  if (!sec) return [...problems, 'no "## Goldfish review" section']
  const table = stageTableLines(sec)
  const specTable = stageTableLines(readFileSync(SPEC, 'utf8'))
  if (specTable.length !== 5) problems.push('the spec stage table could not be read')
  if (table.join('\n') !== specTable.join('\n'))
    problems.push('the review stage table is not the spec table verbatim')
  const f = flat(sec)
  if (!/fresh sub-agent/.test(f)) problems.push('a reviewer is not a fresh sub-agent')
  if (!/only the files it is handed/.test(f))
    problems.push('a reviewer may read more than its files')
  if (!/in order/.test(f) || !/in parallel/.test(f))
    problems.push('the stage order and the in-stage parallelism are not stated')
  return problems
}

/** AC-18: once any slice has a card, the spec changes by appended Amendments rows only. */
function amendmentProblems({ skill }: Docs): string[] {
  const problems: string[] = []
  const sec = section(skill, /^## Once a slice has a card\s*$/)
  if (!sec) return ['no "## Once a slice has a card" section']
  const f = flat(sec)
  if (!/kind `card`/.test(f)) problems.push('the Amendments `card` row is not a trigger')
  if (!/`spec-slice: S-n`/.test(f) || !/`spec:` names this spec/.test(f))
    problems.push('a `spec-slice` marker on a card naming the spec is not a trigger')
  if (!/append/i.test(f) || !/Amendments/.test(f)) problems.push('changes are not appended rows')
  if (!/never edit the body above/i.test(f)) problems.push('the body above may still be edited')
  if (!/delta/.test(f) || !/executor/.test(f)) problems.push('no delta to the affected executor')
  if (!/`SendMessage`|`message_session`/.test(f)) problems.push('the delta has no named channel')
  const rows = fences(sec)
    .flatMap((x) => x.split('\n'))
    .filter((l) => /^\| YYYY-MM-DD /.test(l))
    .map(cells)
  if (rows.length !== 1 || rows[0].length !== 4 || rows[0][1] !== 'amendment')
    problems.push('no fenced four-column `amendment` row')
  return problems
}

const COMPLEX_HEADER = {
  prd: 'docs/prds/<card>-<slug>.md',
  adr: 'docs/adr/NNNN-<slug>.md',
  mockup: 'docs/design/<slug>/'
}

/** A minimal complex spec under `header`, with every placeholder made concrete. */
function complexSpec(header: string): string {
  const concrete = header
    .replaceAll('<card>', 'T900')
    .replaceAll('<slug>', 'example')
    .replaceAll('NNNN', '0900')
  return `${concrete}
# Example

## Problem

- R-1 The example works.

## Slices

### S-1 · Example

- depends-on: —
- substrate: worktree
- files-may-touch: \`src/example.ts\`
- produces: example
- consumes: —
- acs: AC-1

## Acceptance criteria

| id   | statement          | proof                             | refines/inherits | covers |
| ---- | ------------------ | --------------------------------- | ---------------- | ------ |
| AC-1 | The example works. | test:tests/example.test.ts::works | —                | R-1    |
`
}

/** AC-19: the Complex bundle — PRD, ADR only on a decision, mockup only with UI, tracked paths. */
function complexPathProblems({ skill }: Docs): string[] {
  const problems: string[] = []
  const sec = section(skill, /^## The Complex bundle\s*$/)
  if (!sec) return ['no "## The Complex bundle" section']
  const f = flat(sec)
  for (const p of Object.values(COMPLEX_HEADER)) {
    if (!f.includes(`\`${p}\``)) problems.push(`the bundle does not name \`${p}\``)
  }
  if (!/only when [^.]*architectural decision/.test(f))
    problems.push('the ADR is not conditional on an architectural decision')
  if (!/mockup folder\*\*, only when [^.]*\bUI\b/.test(f))
    problems.push('the mockup is not conditional on UI')
  if (!/tracked/.test(f)) problems.push('the bundle paths are not required to be tracked')
  if (!/never [^.]*`\.harnu\/out\/`/.test(f))
    problems.push('the gitignored scratch directory is not ruled out')

  const blocks = fences(sec).filter((b) => /^---\n[\s\S]*\n---$/.test(b.trim()))
  if (blocks.length !== 1)
    return [...problems, `${blocks.length} fenced header blocks (expected 1)`]
  const header = `${blocks[0].trim()}\n`
  const { header: parsed } = parseHeader(header)
  if (parsed?.status !== 'draft') problems.push('the header example is not a draft')
  if (parsed?.tier !== 'complex') problems.push('the header example is not tier complex')
  for (const [field, want] of Object.entries(COMPLEX_HEADER)) {
    if (parsed?.[field] !== want) problems.push(`header \`${field}\` is ${parsed?.[field]}`)
  }
  const spec = complexSpec(header)
  const concrete = parseHeader(spec).header ?? {}
  const tracked = [concrete.prd, concrete.adr, `${concrete.mockup}index.html`].filter(Boolean)
  const clean = checkSpecFile(spec, 'docs/specs/2026-11-07-example/spec.md', tracked)
  if (clean.length > 0)
    problems.push(`the header fails the gate: ${clean.map((x) => x.rule).join(', ')}`)
  return problems
}

/** D-1: the template adopts `gated-by:`, `NG-n` bullets, `existing:` tokens and `card` rows. */
function templateProblems({ template }: Docs): string[] {
  const problems: string[] = []
  if (!template) return ['docs/specs/TEMPLATE.md is missing']
  const parsed = parseSpec(template)
  const decisionIds = new Set(parsed.decisions.map((d) => d.id))
  const gated = parsed.slices.filter((s) => s.gatedBy.length > 0)
  if (gated.length === 0) problems.push('no slice carries `gated-by:`')
  for (const s of gated)
    for (const d of s.gatedBy)
      if (!decisionIds.has(d)) problems.push(`${s.id} is gated by ${d}, which is not a D-n row`)
  if (!parsed.nonGoals.some((n) => n.cites.length > 0))
    problems.push('no `NG-n` bullet cites an atom')
  if (!parsed.slices.some((s) => s.consumes.some((c) => c.startsWith('existing:'))))
    problems.push('no `existing:` token')
  if (parsed.cards.length === 0) problems.push('no Amendments row of kind `card`')

  const comment = /<!--[\s\S]*?-->/.exec(template)?.[0] ?? ''
  for (const word of ['gated-by:', 'NG-', 'existing:', '`card`']) {
    if (!comment.includes(word)) problems.push(`the how-to comment does not explain ${word}`)
  }
  const approved = template.replace(/^status:.*$/m, 'status: approved')
  const tracked = [
    'docs/prds/example.md',
    'docs/adr/0000-example.md',
    'docs/design/example/index.html'
  ]
  const findings = checkSpecFile(approved, 'docs/specs/TEMPLATE.md', tracked)
  if (findings.length > 0)
    problems.push(`the template fails spec check: ${findings.map((x) => x.rule).join(', ')}`)
  return problems
}

it('authoring looks facts up and leaves unanswered decisions open', () => {
  expectCheck('authoringOrder', authoringOrderProblems)
})

it('authoring runs the builder-check and the complex lens critics', () => {
  expectCheck('review', reviewProblems)
})

it('a dispatched spec changes only by amendment', () => {
  expectCheck('amendment', amendmentProblems)
})

it('complex entries get tracked prd, adr and mockup paths', () => {
  expectCheck('complexPaths', complexPathProblems)
})

it('the template adopts the four conventions (D-1)', () => {
  expectCheck('template', templateProblems)
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
