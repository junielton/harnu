/**
 * T369 AC-S8-3 — `report-back` and `draft-to-prompt`, promoted from personal
 * skills to bundled Harnu skills.
 *
 * The same three silent-breakage guards `read-aloud-skill.test.ts` holds for its
 * skill: the shipped SKILL.md must parse (a malformed frontmatter drops the skill
 * with nothing red anywhere), must carry no personal absolute path (it ships to
 * every machine), and must be listed both in the catalog the Settings panel reads
 * and in the user doc. A promoted copy must also have left its personal origin
 * behind: English-only (CLAUDE.md language policy) and no operator's name.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILLS = path.join(REPO_ROOT, 'resources', 'skills', 'skills')
const read = (...p: string[]): string => readFileSync(path.join(...p), 'utf8')

describe.each(['report-back', 'draft-to-prompt'])('%s — bundled (AC-S8-3)', (name) => {
  const raw = read(SKILLS, name, 'SKILL.md')

  it('parses into a BundledSkill whose name matches its directory', () => {
    const parsed = parseSkillFrontmatter(raw, name)
    expect(parsed?.name).toBe(name)
    expect(parsed!.description.length).toBeGreaterThan(0)
  })

  it('carries no personal absolute path', () => {
    expect(raw).not.toMatch(/\/(home|Users)\/[A-Za-z0-9._-]+\//)
  })

  it('is listed in the catalog and in docs/user/bundled-skills.md', () => {
    const row = new RegExp(`^\\|\\s*\`${name}\`\\s*\\|`, 'm')
    expect(read(REPO_ROOT, 'resources', 'skills', 'CATALOG.md')).toMatch(row)
    expect(read(REPO_ROOT, 'docs', 'user', 'bundled-skills.md')).toMatch(row)
  })

  it('left its personal origin behind — English, no operator name', () => {
    expect(raw).not.toMatch(/Junielton/i)
    // The Portuguese words the personal copy used as labels and triggers.
    expect(raw).not.toMatch(/\b(você|aberto|nada, pode seguir|resume o que foi feito)\b/)
  })
})

describe('report-back — speaks the same ledger as status', () => {
  const raw = read(SKILLS, 'report-back', 'SKILL.md')

  it('prints the `you` line with the same success token as the status card', () => {
    expect(raw).toContain("— nothing, you're clear")
    expect(read(SKILLS, 'status', 'SKILL.md')).toContain("— nothing, you're clear")
  })

  it('builds a mission bar from mission_get, not a goal file', () => {
    expect(raw).toContain('mission_get')
    expect(raw).not.toContain('.harnu/goals/')
    expect(raw).not.toContain('.capy/goals/')
  })
})

it('keeps the bundle free of a stray non-skill directory', () => {
  expect(existsSync(path.join(SKILLS, 'report-back', 'IDEAS.md'))).toBe(false)
})

describe('draft-to-prompt — adapted to the bundle', () => {
  const skill = read(SKILLS, 'draft-to-prompt', 'SKILL.md')
  const routing = read(SKILLS, 'draft-to-prompt', 'references', 'harness-routing.md')

  it('ships its reference file, which carries no personal path either', () => {
    expect(routing).not.toMatch(/\/(home|Users)\/[A-Za-z0-9._-]+\//)
  })

  it('boots the mission stack on the bundled skills, not a personal goal skill', () => {
    expect(skill).toContain('harnu:mission')
    expect(routing).toContain('harnu:mission')
    expect(`${skill}\n${routing}`).not.toMatch(/goal skill|\.(harnu|harnu)\/GOAL\.md/)
  })

  it('never writes a dollar sign before a digit (the loader substitutes $N)', () => {
    expect(`${skill}\n${routing}`).not.toMatch(/\$\d/)
  })
})
