/**
 * Campaign ch.6 part 2 (T610, AC-6.4) — `delivery-verifier` re-runs the named checks at the
 * PR head in a clean worktree and leaves an EVIDENCE BUNDLE under
 * `.harnu/evidence/<missionId>/<stepId>/`, linked on the step (a `worktree` link). Prose
 * assertions on the shipped model-facing file, the same posture as
 * `delivery-verifier-rubrics.test.ts`.
 *
 * Missions v4 S-30: the link is `mission_link` (the scoped verifier holds it), it comes before the
 * settle call instead of before `mission_verify_step`, and the v3 `verifier` gate that read it is not
 * the v4 reader, so the old gate pin is gone. What chapter 4 added stays pinned here: the exact
 * folder, the verifier's own `verify/` subfolder, a `README.md` in every folder, the builder's files
 * left alone, and a free port before one is opened.
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
const flat = (s: string): string => s.replace(/\s+/g, ' ')

/** Where the verifier keeps a step's evidence bundle, relative to the repo root. */
const evidenceBundleDir = (missionId: string, stepId: string): string =>
  `.harnu/evidence/${missionId}/${stepId}`

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
    expect(headings[at + 1]).toMatch(/^## Step 4 — Record, and say who$/)
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
    // The path the skill teaches is the path the code names.
    expect(evidenceBundleDir('<missionId>', '<stepId>')).toBe(
      '.harnu/evidence/<missionId>/<stepId>'
    )
    expect(s).toMatch(/test output/)
    expect(s).toMatch(/screenshots?/)
    expect(s).toMatch(/console/)
  })

  it('links the bundle on the step as a worktree link, before settling', () => {
    const s = section('Step 3 — Re-run the checks and keep the evidence')
    expect(s).toMatch(/mission_link\(/)
    expect(s).not.toMatch(/mission_link_child/)
    expect(s).toMatch(/kind: 'worktree'/)
    expect(s).toMatch(/Link the folder before you settle/)
  })

  it("keeps its own files under verify/ and leaves the builder's files alone", () => {
    const s = section('Step 3 — Re-run the checks and keep the evidence')
    expect(s).toContain('`.harnu/evidence/<missionId>/<stepId>/verify/`')
    expect(s).toMatch(/the builder's files in the step folder stay the builder's/)
  })

  it('gives every evidence folder a README, and opens no port it did not see free', () => {
    const s = section('Step 3 — Re-run the checks and keep the evidence')
    expect(s).toMatch(/every evidence folder a `README\.md`/)
    expect(s).toMatch(/Pick a free port before you open one/)
  })

  it('the last step is settled the same way, by a session that built none of the steps', () => {
    const s = section('Step 4 — Record, and say who')
    expect(s).toMatch(/Check the whole mission against Done when/)
    expect(s).toMatch(/a session that built none of the steps/)
  })

  it('the bundle path stays out of git: it is evidence, not source', () => {
    const s = section('Step 3 — Re-run the checks and keep the evidence')
    expect(s).toMatch(/never commit/i)
  })
})
