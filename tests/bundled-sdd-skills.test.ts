/**
 * T602 — `one-by-one`, `grill-me` and `step-by-step`, promoted from personal skills
 * to bundled Harnu skills whose answers persist (in the spec, in project memory, as
 * mission checks) instead of dying in the transcript.
 *
 * Same silent-breakage guards as `bundled-report-skills.test.ts` (parse, no personal
 * path, catalog + user-doc rows, English only), plus:
 *  - AC-2: a before/after fixture spec — the documented row transform touches only
 *    the open `D-n` rows' status cell, and the memory line has the documented shape;
 *  - AC-3: grill-me's placement rules and closing list are in the text;
 *  - AC-4: a mission fixture — `mission_add_check`'s own core (`applyAddCheck`) run
 *    twice with the same labels adds no duplicate and never ticks.
 * A skill is prose, so what is graded is the contract the text states and the data
 * contract it leans on; the conversational behavior itself is reviewed by hand.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'
import { applyAddCheck, buildMissionFileContent, type Mission } from '../src/main/mission-core'

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

  it('refuses to decide, and never writes chosen itself', () => {
    const f = flat(skill)
    expect(f).toMatch(/You never answer a decision yourself/)
    expect(f).toMatch(/You never write `chosen`/)
    expect(f).toContain('CONTROLLED_FIELD')
    expect(f).toMatch(/Choose…/)
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

describe('step-by-step — every action is a check, none is ticked (AC-4)', () => {
  const skill = read(SKILLS, 'step-by-step', 'SKILL.md')
  const f = flat(skill)

  it('adds each action with mission_add_check, deduped by label', () => {
    expect(skill).toMatch(/mission_add_check\(\{ folder, missionId, stepId/)
    expect(f).toMatch(/dedupes by label/)
    expect(f).toMatch(/Re-running with the same list adds nothing/)
  })

  it('never ticks a check and holds that as a hard gate', () => {
    expect(f).toMatch(/Never tick a check/)
    expect(f).toMatch(/never describe a check as done because the operator said "done" in chat/)
    expect(skill).not.toMatch(/ticked:\s*true/)
  })

  it('reports unticked checks from mission_get, not from the chat', () => {
    expect(f).toContain('steps[].checks[].ticked')
    expect(f).toMatch(/Checks still unticked/)
  })

  const mission = (): Mission => {
    const at = '2026-10-31T10:00:00.000Z'
    const m: Mission = {
      id: 'mnt-0000abcd',
      slug: 'fixture',
      folder: '/repo',
      owner: { sessionId: '11111111-2222-4333-8444-555555555555', folder: '/repo' },
      status: 'active',
      declaredEnd: { kind: 'other', target: 'actions done', evidence: 'checks ticked' },
      steps: [
        {
          id: 'stp-1',
          ordinal: 1,
          kind: 'custom',
          title: 'Ship the tunnel',
          verification: 'human',
          proof: 'unproven',
          links: [],
          blockers: []
        },
        {
          id: 'stp-2',
          ordinal: 2,
          kind: 'fixed-end',
          title: 'Delivered and verified',
          verification: 'verifier',
          proof: 'unproven',
          links: [],
          blockers: []
        }
      ],
      blockers: [],
      openQuestions: [],
      createdAt: at,
      updatedAt: at,
      provenance: { author: 'agent', at }
    }
    buildMissionFileContent(m) // the fixture must be a valid mission
    return m
  }

  it('re-running the same list adds no duplicate and never ticks (mission fixture)', () => {
    const labels = [
      'Create the Access service token (Cloudflare)',
      'Point the DNS route at the tunnel',
      'Create the Access service token (Cloudflare)' // the list repeats itself
    ]
    let m = mission()
    for (const l of labels) m = applyAddCheck(m, 'stp-1', l, 'agent', '2026-10-31T10:01:00.000Z')
    const first = m.steps[0].checks!
    expect(first.map((c) => c.label)).toEqual([labels[0], labels[1]])

    // A second pass over the same list — different case and spacing included.
    for (const l of labels) m = applyAddCheck(m, 'stp-1', ` ${l.toUpperCase()}  `, 'agent', 'x')
    expect(m.steps[0].checks).toEqual(first)
    expect(m.steps[0].checks!.every((c) => c.ticked === undefined)).toBe(true)
    expect(m.steps[0].checks!.every((c) => c.source === 'agent')).toBe(true)
  })
})
