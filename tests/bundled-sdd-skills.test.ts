/**
 * T602 — `one-by-one`, `grill-me` and `step-by-step`, promoted from personal skills
 * to bundled Harnu skills whose answers persist (in the spec, in project memory, as
 * mission criteria and blockers) instead of dying in the transcript.
 *
 * Same silent-breakage guards as `bundled-report-skills.test.ts` (parse, no personal
 * path, catalog + user-doc rows, English only), plus:
 *  - AC-2: a before/after fixture spec — the documented row transform touches only
 *    the open `D-n` rows' status cell, and the memory line has the documented shape;
 *  - AC-3: grill-me's placement rules and closing list are in the text;
 *  - AC-4: step-by-step adds each action as an operator criterion and never ticks one
 *    (Missions v4 S-31 moved this from the v3 check; its payload is parsed in
 *    `skill-others-v4.test.ts`).
 * A skill is prose, so what is graded is the contract the text states and the data
 * contract it leans on; the conversational behavior itself is reviewed by hand.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILLS = path.join(REPO_ROOT, 'resources', 'skills', 'skills')
const read = (...p: string[]): string => readFileSync(path.join(...p), 'utf8')
const flat = (s: string): string => s.replace(/\s+/g, ' ')

const NAMES = ['one-by-one', 'grill-me', 'step-by-step'] as const

describe.each(NAMES)('%s — bundled (AC-1, AC-5)', (name) => {
  const raw = read(SKILLS, name, 'SKILL.md')

  it('parses into a BundledSkill whose name matches its directory', () => {
    const parsed = parseSkillFrontmatter(raw, name)
    expect(parsed?.name).toBe(name)
    expect(parsed!.description.length).toBeGreaterThan(0)
  })

  it('is listed in the catalog and in docs/user/bundled-skills.md', () => {
    const row = new RegExp(`^\\|\\s*\`${name}\`\\s*\\|`, 'm')
    expect(read(REPO_ROOT, 'resources', 'skills', 'CATALOG.md')).toMatch(row)
    expect(read(REPO_ROOT, 'docs', 'user', 'bundled-skills.md')).toMatch(row)
  })

  it('carries no personal path, no operator name and no Portuguese', () => {
    expect(raw).not.toMatch(/\/(home|Users)\/[A-Za-z0-9._-]+\//)
    expect(raw).not.toMatch(/Junielton/i)
    expect(raw).not.toMatch(/\b(você|desembola)\b/)
  })

  it('never writes a dollar sign before a digit (the loader substitutes $N)', () => {
    expect(raw).not.toMatch(/\$\d/)
  })

  it('points at the bundled sister skills, not personal ones', () => {
    expect(raw).not.toMatch(/tw-deploy-guide/)
    expect(raw).not.toMatch(/\bCapy\b/)
  })
})

describe('the catalog marker moved with the content', () => {
  it('is past v12, the state this card forked from', () => {
    const catalog = read(REPO_ROOT, 'resources', 'skills', 'CATALOG.md')
    const marker = /^<!-- harnu-skills v(\d+) /.exec(catalog)
    expect(marker).not.toBeNull()
    expect(Number(marker![1])).toBeGreaterThan(12)
  })
})

describe('one-by-one — resolved rows persist (AC-2)', () => {
  const skill = read(SKILLS, 'one-by-one', 'SKILL.md')
  const before = read(REPO_ROOT, 'tests', 'fixtures', 'one-by-one', 'spec-before.md')
  const after = read(REPO_ROOT, 'tests', 'fixtures', 'one-by-one', 'spec-after.md')

  /** The Open decisions rows as cell arrays, keyed by D-n. */
  const rows = (md: string): Map<string, string[]> => {
    const out = new Map<string, string[]>()
    for (const line of md.split('\n')) {
      const cells = line.split('|').map((c) => c.trim())
      if (cells.length > 5 && /^D-\d+$/.test(cells[1])) out.set(cells[1], cells.slice(1, -1))
    }
    return out
  }
  const RESOLVED = /^resolved · .+ · \d{4}-\d{2}-\d{2}$/

  it('the skill states the exact status-cell shape the fixture uses', () => {
    expect(skill).toContain('resolved · <chosen option> · <YYYY-MM-DD>')
  })

  it('the fixture starts with exactly two open rows and ends with none', () => {
    const open = (md: string): string[] =>
      [...rows(md)].filter(([, c]) => c[c.length - 1] === 'open').map(([id]) => id)
    expect(open(before)).toEqual(['D-1', 'D-2'])
    expect(open(after)).toEqual([])
  })

  it('only the open rows changed, and only their status cell', () => {
    const b = rows(before)
    const a = rows(after)
    expect([...a.keys()]).toEqual([...b.keys()])
    for (const [id, cells] of b) {
      const next = a.get(id)!
      if (cells[cells.length - 1] === 'open') {
        expect(next.slice(0, -1)).toEqual(cells.slice(0, -1))
        expect(next[next.length - 1]).toMatch(RESOLVED)
      } else {
        expect(next).toEqual(cells)
      }
    }
    // Every line outside the table is byte-identical.
    // Prettier re-pads table separators, so compare them without width.
    const prose = (md: string): string[] =>
      md
        .split('\n')
        .filter((l) => !/^\| D-\d/.test(l))
        .map((l) => l.replace(/-+/g, '-').replace(/\s+/g, ' '))
    expect(prose(after)).toEqual(prose(before))
  })

  it('records one structured decisions line per resolved D-n, in the stated shape', () => {
    expect(skill).toMatch(/memory_append\(\{ folder, page: "decisions"/)
    expect(flat(skill)).toContain(
      'D-3 resolved · <chosen option> · <YYYY-MM-DD> · spec: <repo-relative spec path> · why:'
    )
  })

  it('refuses to decide, and never clears the operator’s blocker itself', () => {
    const f = flat(skill)
    expect(f).toMatch(/You never answer a decision yourself/)
    expect(f).toMatch(/you never call `mission_clear_blocker` on it \(refused `OPERATOR_ONLY`\)/)
    expect(f).toMatch(/Done, continue/)
  })

  it('serves one question per message and creates the whole list first', () => {
    const f = flat(skill)
    expect(f).toMatch(/One item per message\. Exactly one\./)
    expect(f).toMatch(/The whole queue exists before the first question/)
  })
})

describe('grill-me — everything raised is placed or listed (AC-3)', () => {
  const skill = read(SKILLS, 'grill-me', 'SKILL.md')
  const f = flat(skill)

  it('places each item as a D-n row, an Amendments row or a non-goal', () => {
    expect(f).toMatch(/\*\*Open decisions\*\* table/)
    expect(f).toMatch(/\*\*`## Amendments`\*\* table/)
    expect(f).toMatch(/non-goals/)
  })

  it('writes append-only, never rewording an existing row', () => {
    expect(f).toMatch(/Append-only on the spec/)
  })

  it('ends with the written / could-not-place lists, re-reading the file first', () => {
    expect(f).toContain('Written to the spec:')
    expect(f).toContain('Could not place:')
    expect(f).toMatch(/re-read the spec before sending/)
    expect(f).toMatch(/Nothing is enacted/)
  })

  it('asks one question at a time with a recommendation', () => {
    expect(f).toMatch(/One question at a time/)
    expect(f).toMatch(/Every question carries your recommended answer/)
  })
})

describe('step-by-step — every action is an operator criterion, none is ticked (AC-4)', () => {
  const skill = read(SKILLS, 'step-by-step', 'SKILL.md')
  const f = flat(skill)

  it('adds each action with mission_add_ac, by the operator, and reads before adding', () => {
    expect(f).toMatch(/`mission_add_ac`/)
    expect(f).toMatch(/"by": "operator"/)
    expect(f).toMatch(/Harnu does not dedupe a criterion/)
    expect(f).toMatch(/read the step's criteria first/)
  })

  it('never ticks a criterion and holds that as a hard gate', () => {
    expect(f).toMatch(/Never tick a criterion/)
    expect(f).toMatch(/never describe a criterion as done because the operator said "done" in chat/)
    expect(skill).not.toMatch(/settled:\s*true/)
  })

  it('reports open criteria from mission_get, not from the chat', () => {
    expect(f).toContain('`criteria[].settled` on each step')
    expect(f).toMatch(/Criteria still open/)
  })
})
