/**
 * T377 (Mission v2 S4) — the bundled delivery skills carry the rules the first
 * real orchestration was missing (spec `docs/specs/2026-09-29-mission-v2/spec.md`
 * §3.2–§3.6, §4 "Skills").
 *
 * Prose assertions on model-facing files, like `mission-skills-migration.test.ts`:
 * a SKILL.md ships as-is and each regression is invisible at runtime — an owner
 * that goes back to authoring the end alone after dispatch, a wait on the
 * operator that stays silent in the transcript, a close the owner is told it
 * cannot produce. The behavior itself is graded by the eval scenarios in
 * `scripts/eval/mission-behavior/scenarios/` (AC-9); these guards keep the text
 * those scenarios exercise from drifting.
 *
 * Missions v4 S-28 rewrote the `mission` skill and S-29 `orchestrate-delivery`, so their describes (the
 * v2 end, blocker and close rules) are gone; `tests/skill-mission-v4.test.ts` and
 * `tests/skill-orchestrate-delivery-v4.test.ts` pin their v4 text. `delivery-verifier` stays pinned here
 * until S-30 rewrites it and deletes this suite. The two checks over the shared list below still hold
 * for the v4 text of every skill in it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

function readSkill(name: string): string {
  return readFileSync(
    path.join(REPO_ROOT, 'resources', 'skills', 'skills', name, 'SKILL.md'),
    'utf8'
  )
}

/** The text of one `## ` section (heading line excluded), up to the next `## `. */
function section(raw: string, heading: string): string {
  const start = raw.indexOf(`\n## ${heading}`)
  expect(start, `section "## ${heading}"`).toBeGreaterThan(-1)
  const next = raw.indexOf('\n## ', start + 4)
  return raw.slice(start, next === -1 ? undefined : next)
}

/** Collapse Prettier's line wrapping so a sentence matches whatever its breaks. */
const flat = (s: string): string => s.replace(/\s+/g, ' ')

const DELIVERY_SKILLS = ['orchestrate-delivery', 'mission', 'delivery-verifier']

describe('no skill promises what the code does not enforce (§3.2, AC-4)', () => {
  it.each(DELIVERY_SKILLS)('%s never says a draft blocks dispatch', (name) => {
    const raw = flat(readSkill(name))
    expect(raw).not.toMatch(/never tell the operator it is running before they approved it/)
    expect(raw).not.toMatch(/nothing runs until/i)
  })

  it.each(DELIVERY_SKILLS)('%s never demands an end verifier the owner cannot produce', (name) => {
    const raw = flat(readSkill(name))
    expect(raw).not.toMatch(/get an independent verification first/)
    expect(raw).not.toMatch(/must be `verified` by a session that did not author it/)
  })
})

// Missions v4 S-29: the `orchestrate-delivery` skill speaks v4. Its v2 rules that still hold (the mission is
// created at once, a wait on the operator is a blocker, the Done when is re-scoped in the same turn, stacked PRs
// are retargeted, the close is requested and never done) are pinned against the v4 text in
// tests/skill-orchestrate-delivery-v4.test.ts; the rest (the end question, closeReadiness) is gone with v3.

describe('delivery-verifier — the end wording (§3.5)', () => {
  it('leaves the fixed end to the orchestrator, after the per-unit verdicts', () => {
    const raw = flat(readSkill('delivery-verifier'))
    expect(raw).toMatch(
      /The fixed end \(`Delivered and verified`\) is the orchestrator's to verify/
    )
    expect(raw).toMatch(/after the per-unit verdicts/)
    expect(raw).toContain('closeReadiness')
  })
})
