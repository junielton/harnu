import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseSkillFrontmatter } from '../../src/main/bundled-skills-core'

/**
 * `harnu:your-move`: the bundled skill that teaches a session when the ball is the operator's
 * and how to file a card. The skill improves card quality; the judge is the guarantee, so the
 * skill must say that too. The marker thresholds are the ones found on this branch before U3
 * bumped them (features v131, catalog v19).
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const read = (...p: string[]): string => readFileSync(path.join(ROOT, ...p), 'utf8')
const SKILL = read('resources', 'skills', 'skills', 'your-move', 'SKILL.md')

const KINDS = ['decide', 'go_no_go', 'provide', 'do', 'check']

describe('harnu:your-move skill', () => {
  it('frontmatter name equals the directory and description names when not to use it', () => {
    const parsed = parseSkillFrontmatter(SKILL, 'your-move')
    expect(parsed?.name).toBe('your-move')
    expect(parsed?.description).toMatch(/Do NOT use/)
  })

  it('mentions all five kinds, your_move, and the end-of-turn test', () => {
    for (const kind of KINDS) expect(SKILL).toContain(`\`${kind}\``)
    expect(SKILL).toContain('your_move')
    expect(SKILL).toContain('if the operator never comes back, does this still get done?')
  })

  it('teaches a self-contained card, that the verb cannot close, and that the judge is the guarantee', () => {
    expect(SKILL).toMatch(/self-contained/i)
    expect(SKILL).toMatch(/D-9/)
    expect(SKILL).toMatch(/cannot close/i)
    expect(SKILL).toMatch(/judge/i)
    expect(SKILL).toMatch(/cardId/)
  })

  it('keeps its sections in the order the spec gives', () => {
    const at = (needle: string): number => SKILL.indexOf(needle)
    const order = [
      'if the operator never comes back',
      '`go_no_go`',
      'self-contained',
      'cannot close',
      'guarantee'
    ].map(at)
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('uses only the neutral vocabulary and carries no personal path', () => {
    expect(SKILL).not.toMatch(/\/(home|Users)\/[A-Za-z0-9._-]+\//)
    expect(SKILL).toMatch(/PROJ-231|Acme|org\/proj\/www/)
  })
})

describe('contracts for the verb and the skill', () => {
  it('the catalog marker is greater than v19 and lists your-move', () => {
    const catalog = read('resources', 'skills', 'CATALOG.md')
    const marker = /<!-- harnu-skills v(\d+) /.exec(catalog)
    expect(Number(marker?.[1])).toBeGreaterThan(19)
    expect(catalog).toMatch(/^\|\s*`your-move`\s*\|/m)
  })

  it('docs/user/bundled-skills.md lists your-move', () => {
    expect(read('docs', 'user', 'bundled-skills.md')).toMatch(/^\|\s*`your-move`\s*\|/m)
  })

  it('docs/harnu-features.md marker is greater than v131 and documents cardId, the cap and YOUR_MOVE_OFF', () => {
    const doc = read('docs', 'harnu-features.md')
    const marker = /<!-- harnu-features v(\d+) /.exec(doc)
    expect(Number(marker?.[1])).toBeGreaterThan(131)
    expect(doc).toContain('your_move')
    expect(doc).toContain('cardId')
    expect(doc).toContain('YOUR_MOVE_OFF')
    expect(doc).toContain('YOUR_MOVE_RATE_LIMIT')
    expect(doc).toMatch(/30 /)
  })

  it('the agent doc states what actually guarantees a card: the judge, not the skill', () => {
    const doc = read('docs', 'harnu-features.md')
    expect(doc).toMatch(/two detector runs and an enrichment call/i)
    expect(doc).toMatch(/harnu:your-move/)
  })

  it('docs/user/agent-control.md describes the verb for a person', () => {
    const doc = read('docs', 'user', 'agent-control.md')
    expect(doc).toContain('your_move')
    expect(doc).toMatch(/cannot close/i)
  })
})
