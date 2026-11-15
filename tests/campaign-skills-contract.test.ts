/**
 * Campaign chapter 3b (T606) — the bundled delivery skills produce and consume the
 * Campaign record (spec `docs/specs/2026-10-30-campaign/spec.md` §6, §8 AC-4).
 *
 * Prose assertions on model-facing files, like `mission-v3-skills.test.ts`: a SKILL.md
 * ships as-is, and a regression (an orchestrator that opens loose missions for a
 * three-chapter delivery) is invisible at runtime. The behavior itself is graded by the
 * `campaign-declare` and `campaign-prereq-order` eval scenarios; these guards keep the text
 * those scenarios exercise from drifting, and keep what T603 reworked (boot templates, done
 * conditions) in place.
 *
 * Missions v4 S-28 rewrote `mission`, `status` and `report-back`: they no longer read gates, a
 * ledger or a campaign, so their three describes moved to `tests/skill-mission-v4.test.ts`.
 * What is left pins `orchestrate-delivery` only; S-29 rewrites that skill and deletes this suite.
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

/** Collapse Prettier's line wrapping so a sentence matches whatever its breaks. */
const flat = (s: string): string => s.replace(/\s+/g, ' ')

describe('orchestrate-delivery declares a campaign for a multi-chapter objective (AC-3b.1)', () => {
  const raw = flat(readSkill('orchestrate-delivery'))

  it('declares ONE campaign with chapters and their consumes / produces tokens', () => {
    expect(raw).toContain('campaign_create')
    expect(raw).toMatch(/more than one chapter/i)
    expect(raw).toContain('consumes')
    expect(raw).toContain('produces')
  })

  it('details only the next chapter to steps and binds its mission to the campaign', () => {
    expect(raw).toMatch(/rolling wave/i)
    expect(raw).toMatch(/only the next chapter/i)
    expect(raw).toContain('campaignId')
    expect(raw).toContain('chapterId')
  })

  it('re-orders on PREREQ_MISSING and never forces', () => {
    expect(raw).toContain('PREREQ_MISSING')
    expect(raw).toMatch(/re-?order/i)
    expect(raw).toMatch(/never (pass )?`?force/i)
  })

  it('files a detour as a side step, not a new mission', () => {
    expect(raw).toMatch(/mission_add_step[^.]*required: false/)
    expect(raw).toContain('discoveredFrom')
  })

  it('freezes ID’d acceptance criteria before dispatch', () => {
    expect(raw).toMatch(/frozen[^.]*acceptance criteria|acceptance criteria[^.]*frozen/i)
  })

  it('keeps the mission-only path for single-chapter work', () => {
    expect(raw).toMatch(/single[- ]chapter[^.]*mission/i)
  })

  it('keeps what T603 reworked: the done conditions and the per-role boot templates', () => {
    expect(raw).toContain('Done conditions — checkable by the worker alone')
    expect(raw).toContain('Boot templates by role')
  })
})
