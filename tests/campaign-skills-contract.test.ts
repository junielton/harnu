/**
 * Campaign chapter 3b (T606) — the bundled delivery skills produce and consume the
 * Campaign record (spec `docs/specs/2026-10-30-campaign/spec.md` §6, §8 AC-4).
 *
 * Prose assertions on model-facing files, like `mission-v3-skills.test.ts`: a SKILL.md
 * ships as-is, and a regression (an orchestrator that opens loose missions for a
 * three-chapter delivery, a tick that shells out to `gh pr view` for what `mission_get`
 * already carries, a status card that recounts chapters) is invisible at runtime. The
 * behavior itself is graded by the `campaign-declare`, `campaign-prereq-order` and
 * `tick-red-gate` eval scenarios; these guards keep the text those scenarios exercise
 * from drifting, and keep what T603 reworked (boot templates, done conditions) in place.
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

describe('mission (tick) reads gates and the ledger, not gh or the fleet (AC-3b.2)', () => {
  const raw = flat(readSkill('mission'))

  it('reads gates and ledger from mission_get', () => {
    expect(raw).toMatch(/derived\.steps\[\]\.gates|`gates`/)
    expect(raw).toContain('ledger')
  })

  it('does not tell the tick to shell out for dispatch state', () => {
    expect(raw).not.toMatch(/plus `gh` for what the mission does not link/)
    expect(raw).toMatch(/zero `gh pr view`|never `gh pr view`|no `gh pr view`/i)
  })

  it('opens a side step on a red gate', () => {
    expect(raw).toMatch(/red gate[^.]*(side step|required: false)/i)
    expect(raw).toContain('discoveredFrom')
  })

  it('escalates to the You lane with age and risk, and never claims a verdict', () => {
    expect(raw).toMatch(/age and (the )?risk/i)
    expect(raw).toMatch(/never (claim|writes?) a verdict|gates? (are|is) facts?,? not a verdict/i)
  })
})

describe('status renders the campaign headline and the first You item (AC-3b.3)', () => {
  const raw = flat(readSkill('status'))

  it('reads the campaign from campaign_get and renders Ch. N/M · Step a/b', () => {
    expect(raw).toContain('campaign_get')
    expect(raw).toMatch(/Ch\. \d+\/\d+ · Step \d+\/\d+/)
  })

  it('never recounts chapters', () => {
    expect(raw).toMatch(/never recount (the )?chapters?/i)
  })
})

describe('report-back reads outcome and the ledger, and links the campaign (AC-3b.3)', () => {
  const raw = flat(readSkill('report-back'))

  it('reads outcome and the ledger for the rail', () => {
    expect(raw).toContain('`outcome`')
    expect(raw).toMatch(/`ledger`|the ledger/)
  })

  it('links the campaign in the links block', () => {
    expect(raw).toMatch(/campaign/i)
    expect(raw).toMatch(/campaign_get/)
  })
})
