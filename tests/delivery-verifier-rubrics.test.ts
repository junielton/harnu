/**
 * T369 AC-S8-4 — `delivery-verifier` grades with one rubric per deliverable kind
 * (design §6, decision 9), not one generic rubric branching on a string compare.
 *
 * One test per kind: each asserts the rubric exists as its own section AND carries
 * the evidence rule that only that kind has — so a rubric collapsed into a
 * shared paragraph, or copied from another kind, fails here. Prose assertions on
 * the shipped model-facing file, the same posture as `read-aloud-skill.test.ts`.
 *
 * Missions v4 S-30: the rubrics keep their kinds and their evidence rules; what moved is how a criterion is
 * recorded (a settle through `mission_settle_ac`, no step verdict) and what a screen nobody could capture
 * becomes (an open criterion, not `needs-human`). The sections are read with their line wrapping collapsed.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const RAW = readFileSync(
  path.join(REPO_ROOT, 'resources', 'skills', 'skills', 'delivery-verifier', 'SKILL.md'),
  'utf8'
)

/** Collapse Prettier's line wrapping so a sentence matches whatever its breaks. */
const flat = (s: string): string => s.replace(/\s+/g, ' ')

/** One `### Rubric — <kind>` section, up to the next `###`/`##` heading. */
function rubric(kind: string): string {
  const start = RAW.indexOf(`\n### Rubric — ${kind}\n`)
  expect(start, `### Rubric — ${kind}`).toBeGreaterThan(-1)
  const rest = RAW.slice(start + 1)
  const end = rest.search(/\n#{2,3} /)
  return end === -1 ? rest : rest.slice(0, end)
}

const KINDS = ['code', 'UI', 'research', 'decision'] as const

describe('delivery-verifier — four distinct rubrics (AC-S8-4)', () => {
  it('still parses as the bundled skill', () => {
    expect(parseSkillFrontmatter(RAW, 'delivery-verifier')?.name).toBe('delivery-verifier')
  })

  it('has exactly one rubric section per kind, each with its own body', () => {
    const headings = RAW.match(/^### Rubric — .+$/gm) ?? []
    expect(headings).toEqual(KINDS.map((k) => `### Rubric — ${k}`))
    const bodies = KINDS.map((k) =>
      rubric(k)
        .replace(/^### .*\n/, '')
        .trim()
    )
    expect(new Set(bodies).size).toBe(KINDS.length)
    for (const body of bodies) expect(body.length).toBeGreaterThan(300)
  })

  it('code — proves behavior with commits, the PR base, gates and tests that ran', () => {
    const r = flat(rubric('code'))
    expect(r).toContain('git diff <base>...<head>')
    expect(r).toContain('statusCheckRollup')
    expect(r).toMatch(/tests ran after the last edit/)
    expect(r).toMatch(/code that looks right/)
  })

  it('UI — needs a capture, and leaves the criterion open when no browser tools exist', () => {
    const r = flat(rubric('UI'))
    expect(r).toMatch(/capture/)
    expect(r).toMatch(/Detect your browser tools before grading/)
    expect(r).toMatch(/every visual criterion stays open/)
    expect(r).toMatch(/never a silent settle/)
    expect(r).not.toMatch(/needs-human/)
  })

  it('research — answers each declared question, with sources, one question per call', () => {
    const r = flat(rubric('research'))
    expect(r).toMatch(/Grade one declared question per call/)
    expect(r).toMatch(/carries a source/)
    expect(r).toMatch(/No declared questions → `blocked`/)
  })

  it('decision — a record with options, choice, rationale and who decided', () => {
    const r = flat(rubric('decision'))
    expect(r).toMatch(/options that were actually considered/)
    expect(r).toMatch(/the rationale, tied to\s+the options/)
    expect(r).toMatch(/who made\s+it/)
    expect(r).toMatch(/record shows the operator made it/)
  })

  it('routes each declared kind to its rubric, and `other` never to a prose `met`', () => {
    for (const k of ['`code`', '`ui`', '`research`', '`decision`']) expect(RAW).toContain(`| ${k}`)
    expect(RAW).toMatch(/`other` has no rubric of its own/)
  })

  it('records a criterion with mission_settle_ac, never as the builder of the step', () => {
    const all = flat(RAW)
    expect(all).toContain('Call `mission_settle_ac` with the exact evidence')
    expect(all).toMatch(/a second session or another person, never the one who built the step/)
    expect(all).toMatch(/a self-check never settles it/)
    expect(all).not.toContain('mission_verify_step')
  })
})
