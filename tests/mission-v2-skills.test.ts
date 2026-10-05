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

describe('orchestrate-delivery — the Mission v2 rules (§3.2–§3.6)', () => {
  const raw = readSkill('orchestrate-delivery')
  const phase1 = flat(section(raw, 'Phase 1 — Topology'))

  it('creates the mission in Phase 1, before any dispatch, with the end agreed up front', () => {
    expect(phase1).toContain('mission_create')
    expect(phase1).toMatch(/before any dispatch/)
    expect(phase1).toMatch(
      /confirm it with the operator in ONE AskUserQuestion — the proposal is the recommended option/
    )
    expect(phase1).toMatch(/Pass the spec \/ PRD \/ ADR paths as\s+`scope`/)
    // Mission v3 §3.4 retired the Approve click; tests/mission-v3-skills.test.ts pins its absence.
    expect(phase1).toMatch(/The answer comes before the first dispatch\./)
    expect(phase1).toMatch(
      /write no packet, create no session and link no child until the operator has answered/
    )
  })

  it('no longer creates the mission in Phase 3', () => {
    const phase3 = flat(section(raw, 'Phase 3 — Monitor'))
    expect(phase3).not.toMatch(/The mission is born `draft`: tell the operator it waits/)
    expect(phase3).toMatch(/The mission you declared in Phase 1/)
  })

  it('raises an operator-owned blocker on every turn that ends waiting on the operator', () => {
    const resume = flat(section(raw, 'Resume — every turn re-arms'))
    expect(resume).toMatch(/A turn that ends waiting on the operator raises a blocker/)
    expect(resume).toContain("mission_set_blocker { owner: 'operator'")
    expect(resume).toMatch(/every 30 minutes/)
    expect(resume).toContain('mission_clear_blocker')
  })

  it('re-scopes the end in the same turn the operator changes the rule', () => {
    expect(flat(raw)).toMatch(
      /changes how the delivery ends \(merge policy, target branch, what counts as done\), call `mission_set_end` in the same turn/
    )
  })

  it('retargets stacked PRs before handing merges to the operator', () => {
    const phase2 = flat(section(raw, 'Phase 2 — Cards and dispatch'))
    expect(phase2).toContain('gh pr edit <n> --base <default branch>')
    expect(phase2).toContain('gh pr view <n> --json baseRefName')
  })

  it('closes by verifying the end itself, reading closeReadiness, then requesting the close', () => {
    const phase4 = flat(section(raw, 'Phase 4 — Verify each unit, per acceptance criterion'))
    expect(phase4).toMatch(
      /verify the fixed end \(`Delivered and verified`\) yourself with `mission_verify_step` \(you built none of the steps, so it lands `verified`\)/
    )
    expect(phase4).toMatch(
      /read `closeReadiness` on `mission_get`, and call `mission_request_close`/
    )
    expect(phase4).toContain('RESCOPE_PENDING')
  })
})

describe('mission — the Mission v2 rules (§3.2–§3.5)', () => {
  const raw = readSkill('mission')

  // Mission v3 §3.4: there is no draft to dispatch around or to approve, so the
  // v2 "dispatch may run before approval" and "keep coordinating a draft" rules
  // are retired — tests/mission-v3-skills.test.ts pins the absence of that wording.
  it('never idles a tick on a waiting mission', () => {
    const tick = flat(section(raw, '`mission` — one tick'))
    expect(tick).not.toMatch(/and nothing else this tick/)
  })

  it('creates the mission with scope, the end confirmed in one question', () => {
    const set = flat(section(raw, '`mission set <objective>`'))
    expect(set).toMatch(/scope\?/)
    expect(set).toMatch(/confirm it with the operator in ONE AskUserQuestion/)
  })

  it('raises an operator-owned blocker next to the blocker row', () => {
    const tick = flat(section(raw, '`mission` — one tick'))
    expect(tick).toMatch(/A turn that ends waiting on the operator raises a blocker/)
    expect(tick).toContain("mission_set_blocker { owner: 'operator'")
    expect(tick).toMatch(/every 30 minutes/)
  })

  it('re-scopes on a rule change with mission_set_end', () => {
    expect(flat(raw)).toMatch(
      /changed how the delivery ends\*\* \(merge policy, target branch, what counts as done\) → `mission_set_end` in the same turn/
    )
  })

  it('`mission done` has the owner verify the end, read closeReadiness, then request the close', () => {
    const done = flat(section(raw, '`mission done`'))
    expect(done).toMatch(/verify the fixed end \(`Delivered and verified`\) yourself/)
    expect(done).toMatch(/you built none of the steps, so it lands `verified`/)
    expect(done).toContain('closeReadiness')
    expect(done).toContain('RESCOPE_PENDING')
    expect(done).toMatch(/the close itself is theirs/)
  })
})

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
