/**
 * Campaign ch.6 part 2 (T610, AC-6.4) — `delivery-verifier` re-runs the named checks at the
 * PR head in a clean worktree and leaves an EVIDENCE BUNDLE under
 * `.harnu/evidence/<missionId>/<stepId>/`, linked on the step with `mission_link_child`
 * (a `worktree` link). The `verifier` gate reads that link, so the skill must say so —
 * for a unit step and for the fixed end. Prose assertions on the shipped model-facing file,
 * the same posture as `delivery-verifier-rubrics.test.ts`.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'
import { evidenceBundleDir } from '../src/main/mission-gates'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const RAW = readFileSync(
  path.join(REPO_ROOT, 'resources', 'skills', 'skills', 'delivery-verifier', 'SKILL.md'),
  'utf8'
)
const flat = (s: string): string => s.replace(/\s+/g, ' ')

/** The text of one `## ` section (heading line excluded), up to the next `## `. */
function section(heading: string): string {
  const start = RAW.indexOf(`\n## ${heading}`)
  expect(start, `section "## ${heading}"`).toBeGreaterThan(-1)
  const next = RAW.indexOf('\n## ', start + 4)
  return flat(RAW.slice(start, next === -1 ? undefined : next))
}

describe('delivery-verifier — the evidence bundle (AC-6.4)', () => {
  it('still parses as the bundled skill', () => {
    expect(parseSkillFrontmatter(RAW, 'delivery-verifier')?.name).toBe('delivery-verifier')
  })

  it('has its own section, between grading and recording', () => {
    const headings = RAW.match(/^## .+$/gm) ?? []
    const at = headings.indexOf('## Step 3 — Re-run the checks and keep the evidence')
    expect(at).toBeGreaterThan(-1)
    expect(headings[at - 1]).toMatch(/^## The rubrics$/)
    expect(headings[at + 1]).toMatch(/^## Step 4 — Record on the card and on the mission step$/)
  })

  it('re-runs the named checks at the PR head in a clean worktree', () => {
    const s = section('Step 3 — Re-run the checks and keep the evidence')
    expect(s).toMatch(/re-run/i)
    expect(s).toMatch(/PR head/)
    expect(s).toMatch(/clean worktree/)
    expect(s).toMatch(/headRefOid/)
  })

  it('stores test output, screenshots and console under the bundle directory', () => {
    const s = section('Step 3 — Re-run the checks and keep the evidence')
    expect(s).toContain('.harnu/evidence/<missionId>/<stepId>/')
    // The path the skill teaches is the path the gate reads.
    expect(evidenceBundleDir('<missionId>', '<stepId>')).toBe(
      '.harnu/evidence/<missionId>/<stepId>'
    )
    expect(s).toMatch(/test output/)
    expect(s).toMatch(/screenshots?/)
    expect(s).toMatch(/console/)
  })

  it('links the bundle on the step as a worktree link — before recording the verdict', () => {
    const s = section('Step 3 — Re-run the checks and keep the evidence')
    expect(s).toMatch(/mission_link_child/)
    expect(s).toMatch(/kind: 'worktree'/)
    expect(s).toMatch(/before\W+you call `mission_verify_step`/)
  })

  it('says what the gate does without it: verified with no bundle link reads running, not green', () => {
    const s = section('Step 3 — Re-run the checks and keep the evidence')
    expect(s).toMatch(/verifier. gate/)
    expect(s).toMatch(/no bundle link reads `running`/)
    expect(s).toMatch(/not `green`/)
  })

  it('the fixed end needs its bundle too, linked by whoever verifies it', () => {
    const s = section('Step 4 — Record on the card and on the mission step')
    expect(s).toMatch(/fixed end/i)
    expect(s).toMatch(/evidence bundle/)
  })

  it('the bundle path stays out of git: it is evidence, not source', () => {
    const s = section('Step 3 — Re-run the checks and keep the evidence')
    expect(s).toMatch(/never commit/i)
  })
})
