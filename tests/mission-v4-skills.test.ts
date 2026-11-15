/**
 * Missions v4 · S-32 · AC-77 — the guard over every bundled skill: they speak v4.
 *
 * S-28 to S-31 rewrote the skills one by one and each pinned its own text. This is the guard
 * across all of them, so a skill added or edited later cannot bring a retired word back:
 *
 * - (a) no skill file names a verb the fate table removes, and none says a retired phrase;
 * - (b) the tick's first line and the child report's header are exactly as the code parses them;
 * - (c) the hand-off is the operator's decision, and no skill tells anyone to paste a resume prompt;
 * - (d) CATALOG.md is v23 and each changed skill's row equals its SKILL.md description;
 * - (e) every `mission_…` name the skills write is registered in the MCP catalog.
 *
 * These are text pins on model-facing files. A SKILL.md ships as read and nothing compiles it, so a pin
 * shows what the text says; it cannot show a model follows it (the behaviour evals of S-33 grade that).
 * The third place that forbade a hand-off, the awareness doc, is not a skill: it is S-36's, and its pin
 * lives there (AC-77's clause about it is proved at S-36, not here).
 *
 * What was chosen:
 * - "chapter" is ordinary prose and is allowed; a chapter as a record (`chapterId`, "Chapter 3 of 9",
 *   "Ch. 3") is not. "campaign" is banned in any form.
 * - The removed verbs are the fate table's (spec, "Verb fate table"): renamed, replaced, merged or
 *   removed. `mission_update_step` stays (it is "keep, shrink").
 * - A mention is not a use, but only the one reference line that lists the words a title may not
 *   contain (writing-contract.md) may quote a banned phrase, and the guard checks that line by name.
 *
 * Each assertion lives in `problemsOf`, a pure function over the skills' text. The real text must produce
 * no problem, and every fault in `FAULTS` (one planted in the text per assertion) must produce one: a pin
 * that cannot fail proves nothing. The retired words are built from parts so this file does not contain them.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILLS_ROOT = path.join(REPO_ROOT, 'resources', 'skills')
const SKILLS = path.join(SKILLS_ROOT, 'skills')

/** Collapse Prettier's line wrapping so a sentence matches whatever its breaks. */
const flat = (s: string): string => s.replace(/\s+/g, ' ')
const j = (...p: string[]): string => p.join('')

// ---- The text under guard -----------------------------------------------------------------------

/** Every model-read text file of every skill (SKILL.md, references, agents), by path under `skills/`. */
function skillTexts(): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'scripts' && e.name !== 'node_modules') walk(full)
      } else if (e.name.endsWith('.md')) {
        out[path.relative(SKILLS, full)] = readFileSync(full, 'utf8')
      }
    }
  }
  walk(SKILLS)
  return out
}

/** The skills whose text changed since catalog v22: their catalog row is the SKILL.md description. */
const CHANGED = [
  'mission',
  'status',
  'report-back',
  'orchestrate-delivery',
  'delivery-verifier',
  'delivery-watchdog',
  'spec',
  'one-by-one',
  'grill-me',
  'step-by-step',
  'your-move',
  'draft-to-prompt'
] as const

interface World {
  /** Skill files by path under `resources/skills/skills/`. */
  texts: Record<string, string>
  /** `resources/skills/CATALOG.md`. */
  catalog: string
  /** The verbs the MCP catalog registers. */
  registered: ReadonlySet<string>
}

const real = (): World => ({
  texts: skillTexts(),
  catalog: readFileSync(path.join(SKILLS_ROOT, 'CATALOG.md'), 'utf8'),
  registered: new Set(MCP_TOOLS.map((t) => t.name))
})

// ---- (a) what is gone ---------------------------------------------------------------------------

/** Retired phrases (decision 18), plus the chapter-as-record forms. */
const RETIRED: { what: string; re: RegExp }[] = [
  { what: 'a decision node', re: new RegExp(j('decision', ' node'), 'i') },
  { what: 'the popover', re: new RegExp(j('pop', 'over'), 'i') },
  { what: 'steward mode', re: new RegExp(j('stew', 'ard mode'), 'i') },
  { what: 'a fixed end', re: new RegExp(j('fixed', ' end'), 'i') },
  { what: 'a merge batch', re: new RegExp(j('merge', ' batch'), 'i') },
  { what: 'a campaign', re: new RegExp(j('camp', 'aign'), 'i') },
  { what: 'a chapter id', re: new RegExp(j('chapter', '_?Id'), 'i') },
  { what: 'a chapter count', re: new RegExp(j('\\bChapter \\d+ ', 'of \\d+'), 'i') },
  { what: 'a chapter number', re: new RegExp(j('\\bCh', '\\. ?\\d')) }
]

/** The verbs the fate table removes (renamed, replaced, merged or removed), built from parts. */
const REMOVED_VERBS = [
  j('mission_link', '_child'),
  j('mission_set', '_end'),
  j('mission_verify', '_step'),
  j('mission_add', '_check'),
  j('mission_import', '_legacy'),
  j('mission_transfer', '_owner'),
  j('camp', 'aign_create'),
  j('camp', 'aign_add_chapter'),
  j('camp', 'aign_get'),
  j('camp', 'aign_list'),
  j('camp', 'aign_request_close'),
  j('camp', 'aign_transfer_owner')
]

/** The one reference line that may quote the words a title may not contain. */
const QUOTES_BANNED_WORDS = /Internal words are refused anywhere in a title/

/** The steward is gone: a skill may say there is none, never rely on one. */
const NO_STEWARD = /\b(?:no|without a|never a) steward\b/i

function retiredProblems(texts: Record<string, string>): string[] {
  const out: string[] = []
  for (const [file, raw] of Object.entries(texts)) {
    raw.split('\n').forEach((line, i) => {
      const at = `${file}:${i + 1}`
      const exempt = QUOTES_BANNED_WORDS.test(line)
      if (!exempt) {
        for (const { what, re } of RETIRED) if (re.test(line)) out.push(`${at} says ${what}`)
      }
      for (const verb of REMOVED_VERBS) {
        if (new RegExp(`(?<![A-Za-z0-9])${verb}(?![A-Za-z0-9])`).test(line)) {
          out.push(`${at} names the removed verb ${verb}`)
        }
      }
    })
    // A steward may only be named to say there is none (a sentence, not a line: Prettier wraps).
    for (const sentence of flat(raw).split(/(?<=[.!?])\s+/)) {
      if (/\bsteward/i.test(sentence) && !NO_STEWARD.test(sentence)) {
        out.push(`${file} relies on a steward: "${sentence.slice(0, 60)}"`)
      }
    }
  }
  return out
}

// ---- (b) the two lines code parses --------------------------------------------------------------

const TICK_LINE = '/harnu:mission tick · <missionId>'
const TICK_EXAMPLE = /^\/harnu:mission tick · mnt-[0-9a-f]{8}$/m
const REPORT_HEADER = 'Report for session <owner uuid> · mission <missionId> · step <stepId>'

function parsedLinesProblems(texts: Record<string, string>): string[] {
  const out: string[] = []
  const mission = texts[path.join('mission', 'SKILL.md')] ?? ''
  if (!mission.split('\n').includes(TICK_LINE))
    out.push(`mission/SKILL.md lost the line ${TICK_LINE}`)
  if (!TICK_EXAMPLE.test(mission))
    out.push('mission/SKILL.md has no tick line with a real mission id')
  for (const skill of ['delivery-verifier', 'orchestrate-delivery']) {
    const f = flat(texts[path.join(skill, 'SKILL.md')] ?? '')
    if (!f.includes(REPORT_HEADER)) out.push(`${skill}/SKILL.md lost the header ${REPORT_HEADER}`)
  }
  return out
}

// ---- (c) the hand-off is the operator's ---------------------------------------------------------

/** The two skills that forbade a hand-off before v4 (`orchestrate-delivery` and `mission`). */
const HANDOFF_SKILLS = ['mission', 'orchestrate-delivery'] as const

function handoffProblems(texts: Record<string, string>): string[] {
  const out: string[] = []
  for (const skill of HANDOFF_SKILLS) {
    const f = flat(texts[path.join(skill, 'SKILL.md')] ?? '')
    const section = /## Hand-off (.*?)(?: ## |$)/.exec(f)?.[1] ?? ''
    if (!section) out.push(`${skill}/SKILL.md has no Hand-off section`)
    if (!/Only the operator starts a hand-off/.test(section)) {
      out.push(`${skill}: the Hand-off section does not say only the operator starts it`)
    }
    if (!/The leader never switches itself/.test(section)) {
      out.push(`${skill}: the Hand-off section does not say the leader never switches itself`)
    }
    if (!/no resume prompt is ever pasted/.test(section)) {
      out.push(`${skill}: the Hand-off section does not say no resume prompt is ever pasted`)
    }
    if (/forbid|never (?:hand|switch) off|not allowed to hand/i.test(section)) {
      out.push(`${skill}: the Hand-off section still forbids a hand-off`)
    }
  }
  for (const [file, raw] of Object.entries(texts)) {
    const f = flat(raw)
    // "resume prompt" is only ever named to say none is pasted.
    for (const m of f.matchAll(/resume prompt/gi)) {
      const around = f.slice(Math.max(0, m.index - 12), m.index + 40)
      if (!/no resume prompt is ever pasted/.test(around)) {
        out.push(`${file} mentions a resume prompt other than "no resume prompt is ever pasted"`)
      }
    }
    if (/paste (?:it|the|a|this) (?:hand-?off|resume|handover) prompt/i.test(f)) {
      out.push(`${file} tells someone to paste a resume prompt`)
    }
    if (/stand down (?:at|when|once)/i.test(f)) out.push(`${file} tells the leader to stand down`)
  }
  return out
}

// ---- (d) the catalog ----------------------------------------------------------------------------

/** Quotes and whitespace do not count: Prettier and YAML both rewrite them. */
const norm = (s: string): string =>
  flat(s).replace(/\\\|/g, '|').replace(/[“”"]/g, "'").replace(/[‘’]/g, "'").trim()

/** The Entries table: skill name → description cell. */
function catalogRows(catalog: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of catalog.split('\n')) {
    const m = /^\|\s*`([a-z-]+)`\s*\|\s*(.*?)\s*\|\s*$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

function catalogProblems(texts: Record<string, string>, catalog: string): string[] {
  const out: string[] = []
  const version = /^<!-- harnu-skills (v\d+) \(\d{4}-\d{2}-\d{2}\) -->/.exec(catalog)?.[1]
  if (version !== 'v23') out.push(`CATALOG.md is ${version ?? 'unversioned'}, not v23`)
  const rows = catalogRows(catalog)
  for (const name of CHANGED) {
    const fm = parseSkillFrontmatter(texts[path.join(name, 'SKILL.md')] ?? '', name)
    const row = rows[name]
    if (!fm) out.push(`${name}/SKILL.md has no readable frontmatter`)
    else if (row === undefined) out.push(`CATALOG.md has no row for ${name}`)
    else if (norm(row) !== norm(fm.description)) {
      out.push(`CATALOG.md row for ${name} differs from its SKILL.md description`)
    }
  }
  return out
}

// ---- (e) every verb is registered ---------------------------------------------------------------

/** A name that looks like a verb: `mission_<word>`, `rebase_stack`, `plan_mission`. */
const VERB_SHAPED =
  /(?<![A-Za-z0-9])(?:mission_[a-z]+(?:_[a-z]+)*|rebase_stack(?:_[a-z]+)*|plan_mission(?:_[a-z]+)*)(?![A-Za-z0-9])/g

function verbProblems(texts: Record<string, string>, registered: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const [file, raw] of Object.entries(texts)) {
    raw.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(VERB_SHAPED)) {
        if (!registered.has(m[0]))
          out.push(`${file}:${i + 1} names ${m[0]}, which is not registered`)
      }
    })
  }
  return out
}

// ---- The assertions and the faults --------------------------------------------------------------

type Check = 'retired' | 'lines' | 'handoff' | 'catalog' | 'verbs'

function problemsOf(w: World): Record<Check, string[]> {
  return {
    retired: retiredProblems(w.texts),
    lines: parsedLinesProblems(w.texts),
    handoff: handoffProblems(w.texts),
    catalog: catalogProblems(w.texts, w.catalog),
    verbs: verbProblems(w.texts, w.registered)
  }
}

const MISSION = path.join('mission', 'SKILL.md')
const ORCH = path.join('orchestrate-delivery', 'SKILL.md')
const VERIFIER = path.join('delivery-verifier', 'SKILL.md')

/** Edit one file of the real text. */
const edit = (w: World, file: string, fn: (s: string) => string): World => ({
  ...w,
  texts: { ...w.texts, [file]: fn(w.texts[file] ?? '') }
})

/** One planted fault per assertion: the check named must report at least one problem on it. */
const FAULTS: { name: string; check: Check; make: (w: World) => World }[] = [
  ...[
    j('decision', ' node'),
    j('the pop', 'over'),
    j('stew', 'ard mode'),
    j('the fixed', ' end'),
    j('a merge', ' batch'),
    j('a camp', 'aign'),
    j('chapter', 'Id'),
    j('Chapter 3 ', 'of 9')
  ].map((phrase) => ({
    name: `a skill says "${phrase}"`,
    check: 'retired' as const,
    make: (w: World) => edit(w, MISSION, (s) => `${s}\nWatch ${phrase} on the way.\n`)
  })),
  ...REMOVED_VERBS.map((verb) => ({
    name: `a skill names ${verb}`,
    check: 'retired' as const,
    make: (w: World) => edit(w, 'status/SKILL.md', (s) => `${s}\nCall ${verb} now.\n`)
  })),
  {
    name: 'a reference outside the one exempt line quotes a banned word',
    check: 'retired',
    make: (w) =>
      edit(
        w,
        path.join('mission', 'references', 'writing-contract.md'),
        (s) => `${s}\nThe ${j('fixed', ' end')} is back.\n`
      )
  },
  {
    name: 'a skill relies on a steward',
    check: 'retired',
    make: (w) =>
      edit(w, ORCH, (s) => `${s}\nThe ${j('stew', 'ard')} will nudge a stalled worker.\n`)
  },
  {
    name: 'the tick first line is reworded',
    check: 'lines',
    make: (w) => edit(w, MISSION, (s) => s.replace(TICK_LINE, '/harnu:mission tick - <missionId>'))
  },
  {
    name: 'the tick example has no mission id',
    check: 'lines',
    make: (w) => edit(w, MISSION, (s) => s.replace(/mnt-[0-9a-f]{8}/, 'mnt-xyz'))
  },
  {
    name: 'the child report header is reworded',
    check: 'lines',
    make: (w) => edit(w, VERIFIER, (s) => s.replace('Report for session', 'Report of session'))
  },
  {
    name: 'the mission skill forbids a hand-off again',
    check: 'handoff',
    make: (w) =>
      edit(w, MISSION, (s) =>
        s.replace('Only the operator starts a hand-off', 'A hand-off is forbidden')
      )
  },
  {
    name: 'the orchestrate skill lets the leader switch itself',
    check: 'handoff',
    make: (w) =>
      edit(w, ORCH, (s) =>
        s.replace(/The leader never\s+switches itself/, 'The leader may switch itself')
      )
  },
  {
    name: 'a skill tells someone to paste a resume prompt',
    check: 'handoff',
    make: (w) => edit(w, ORCH, (s) => `${s}\nThen paste the resume prompt into the new session.\n`)
  },
  {
    name: 'the Hand-off section drops the no-resume-prompt rule',
    check: 'handoff',
    make: (w) =>
      edit(w, MISSION, (s) => s.replace('no resume prompt is ever pasted', 'a note is pasted'))
  },
  {
    name: 'the catalog is still v22',
    check: 'catalog',
    make: (w) => ({ ...w, catalog: w.catalog.replace(/harnu-skills v23/, 'harnu-skills v22') })
  },
  {
    name: 'a changed skill row differs from its description',
    check: 'catalog',
    make: (w) => ({
      ...w,
      catalog: w.catalog.replace(
        /^(\| `status`\s*\| )(.*?)(\s*\|)$/m,
        '$1Something else entirely.$3'
      )
    })
  },
  {
    name: 'a changed skill has no row',
    check: 'catalog',
    make: (w) => ({ ...w, catalog: w.catalog.replace(/^\| `one-by-one`.*\n/m, '') })
  },
  {
    name: 'a skill names a verb nobody registers',
    check: 'verbs',
    make: (w) => edit(w, 'status/SKILL.md', (s) => `${s}\nCall mission_frobnicate.\n`)
  }
]

describe('skills speak v4', () => {
  const w = real()
  const problems = problemsOf(w)

  it('guards a real, non-trivial text', () => {
    expect(Object.keys(w.texts).length).toBeGreaterThanOrEqual(14)
    expect(Object.keys(w.texts)).toContain(MISSION)
    expect(w.registered.has('mission_get')).toBe(true)
    expect(Object.keys(catalogRows(w.catalog)).length).toBeGreaterThanOrEqual(CHANGED.length)
  })

  it('(a) no skill names a removed verb or says a retired phrase', () => {
    expect(problems.retired).toEqual([])
  })

  it('(b) the tick first line and the child report header are unchanged', () => {
    expect(problems.lines).toEqual([])
  })

  it('(c) the operator decides a hand-off, and no resume prompt is ever pasted', () => {
    expect(problems.handoff).toEqual([])
  })

  it('(d) the catalog is v23 and each changed skill row equals its description', () => {
    expect(problems.catalog).toEqual([])
  })

  it('(e) every mission verb a skill names is registered', () => {
    expect(problems.verbs).toEqual([])
  })

  it('(f) the skills user page speaks v4 too, with no steward and no hand-off by the leader', () => {
    const page = readFileSync(path.join(REPO_ROOT, 'docs', 'user', 'bundled-skills.md'), 'utf8')
    const file = 'docs/user/bundled-skills.md'
    expect(retiredProblems({ [file]: page })).toEqual([])
    expect(flat(page)).toMatch(/Only you start a hand-off/)
    expect(flat(page)).toMatch(/the leader never switches itself/)
    // The page bites like the skills do: a retired phrase, or a steward relied on, is a problem.
    const bad = `${page}\nUse the ${j('pop', 'over')}. The ${j('stew', 'ard')} will nudge.\n`
    expect(retiredProblems({ [file]: bad }).length).toBe(2)
  })

  it.each(FAULTS)('a planted fault bites: $name', ({ check, make }) => {
    expect(problemsOf(make(w))[check].length).toBeGreaterThan(0)
  })

  it('a planted fault bites only its own assertion where it is local', () => {
    const faulted = problemsOf(
      edit(w, 'status/SKILL.md', (s) => `${s}\nCall mission_frobnicate.\n`)
    )
    expect(faulted.catalog).toEqual(problems.catalog)
    expect(faulted.handoff).toEqual(problems.handoff)
  })
})
