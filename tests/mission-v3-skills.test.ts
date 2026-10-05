/**
 * T385 (Mission v3 S4) — the bundled delivery skills carry the v3 rules
 * (spec `docs/specs/2026-10-01-mission-v3/spec.md` §3.11, AC-11).
 *
 * Prose assertions on model-facing files, like `mission-v2-skills.test.ts`: a
 * SKILL.md ships as-is and each regression is invisible at runtime — a status
 * card that recounts proof instead of rendering the server's position, a sign-off
 * turned into a step, an owner that keeps ticking a mission the operator already
 * ended. The behavior is graded by the eval scenarios in
 * `scripts/eval/mission-behavior/scenarios/`; these guards keep the text those
 * scenarios exercise from drifting.
 */
import { readdirSync, readFileSync } from 'node:fs'
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

const ALL = ['status', 'mission', 'orchestrate-delivery', 'delivery-verifier', 'delivery-watchdog']

const SKILLS_ROOT = path.join(REPO_ROOT, 'resources', 'skills', 'skills')

/** Every file under `resources/skills/skills/**` — SKILL.md files and their references. */
function everySkillFile(dir = SKILLS_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? everySkillFile(path.join(dir, e.name)) : [path.join(dir, e.name)]
  )
}
const OWNERS = ['mission', 'orchestrate-delivery']

describe('no skill carries the retired approval ceremony (§3.4)', () => {
  it.each(ALL)('%s has no draft / Approve / MISSION_DRAFT wording', (name) => {
    const raw = flat(readSkill(name))
    expect(raw).not.toContain('MISSION_DRAFT')
    expect(raw).not.toMatch(/`draft`/)
    expect(raw).not.toMatch(/\b(is a|in|a) draft\b/i)
    expect(raw).not.toMatch(/Approve click|their Approve|operator's Approve/)
    expect(raw).not.toMatch(/approves? it into `active`/)
    expect(raw).not.toMatch(/approve (it|its end|the end|the mission)\b/i)
    expect(raw).not.toMatch(/mission approval/i)
    expect(raw).not.toMatch(/has not started/)
  })

  // Every bundled file, references included: a skill that hands an agent a
  // template (draft-to-prompt's harness routing) teaches the lifecycle too. The
  // patterns are mission-scoped, because "a draft" is ordinary prose elsewhere.
  it.each(everySkillFile().map((f) => path.relative(SKILLS_ROOT, f)))(
    '%s describes no mission draft or approval step',
    (rel) => {
      const raw = flat(readFileSync(path.join(SKILLS_ROOT, rel), 'utf8'))
      expect(raw).not.toContain('MISSION_DRAFT')
      expect(raw).not.toContain('Scope confirmed')
      expect(raw).not.toMatch(/born (as )?a \**draft/i)
      expect(raw).not.toMatch(/approves? (it|the mission|its end) in (Harnu's |the )?Topbar/i)
      expect(raw).not.toMatch(/Approve click|their Approve|operator's Approve/)
      expect(raw).not.toMatch(/approves? it into `active`/)
      expect(raw).not.toMatch(/mission approval/i)
    }
  )

  it.each(ALL)('%s never names the legacy fixed start as a step', (name) => {
    expect(readSkill(name)).not.toContain('Scope confirmed')
  })
})

describe('no skill recounts progress (§3.1, §3.11)', () => {
  it.each(ALL)('%s carries no "steps proven" recount', (name) => {
    const raw = flat(readSkill(name))
    expect(raw).not.toMatch(/steps proven/i)
    expect(raw).not.toMatch(/`verified\/total` as the count/)
  })

  it.each(['status', 'mission', 'orchestrate-delivery', 'delivery-watchdog'])(
    '%s reads derived.progress',
    (name) => {
      expect(readSkill(name)).toContain('derived.progress')
    }
  )
})

describe('the shadow phase is retired (§3.11, closes T371)', () => {
  it.each(ALL)('%s carries no mirror / shadow / divergence wording', (name) => {
    const raw = flat(readSkill(name))
    expect(raw).not.toMatch(/shadow phase/i)
    expect(raw).not.toMatch(/divergence checker/i)
    expect(raw).not.toMatch(/\bmirror\b/i)
  })

  it('the mission skill description no longer promises a mirrored goal file', () => {
    const head = readSkill('mission').split('\n---\n')[0]
    expect(head).not.toMatch(/mirrored/)
  })
})

describe('status — renders the server progress once (§3.11, V3-13)', () => {
  const raw = readSkill('status')
  const all = flat(raw)

  it('renders derived.progress and the `you` list as-is, never recounting', () => {
    expect(all).toMatch(/`derived\.progress` is the bar — render it, never recount it/)
    expect(all).toContain('Step N of M · V verified · L left behind')
    expect(all).toContain('youItems')
    expect(all).toMatch(/`you` line, verbatim/)
  })

  it('no longer builds the bar from the deprecated step counts', () => {
    expect(all).not.toMatch(
      /`mission_list` returns `steps: \{ total, verified, claimed \}` per mission: one cell per step/
    )
    expect(all).toMatch(/deprecated/)
  })

  it('states the one-print rule', () => {
    expect(all).toMatch(/Each of the six lines prints exactly once per front/)
    expect(all).toMatch(/A mission is one front/)
  })

  it('every example card prints each label at most once, and no Progress line', () => {
    const blocks = [...raw.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1])
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(block).not.toMatch(/^\S?\s*progress\b/im)
      // A blank line separates fronts; within one front each label is printed once.
      for (const card of block.split(/\n\s*\n/)) {
        for (const label of ['now', 'done', 'next', 'you', 'open']) {
          const hits = card.split('\n').filter((l) => new RegExp(`^.{2}${label}\\s`).test(l))
          expect(hits.length, `"${label}" in:\n${card}`).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('every example honors the gutter rule: `?` on an open line with content, `⚑` on an owed you line', () => {
    const blocks = [...raw.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1])
    for (const line of blocks.join('\n').split('\n')) {
      const m = /^(.) (open|you) {2,}(.*)$/.exec(line)
      if (!m) continue
      const [, gutter, label, value] = m
      const empty = value.startsWith('—')
      if (label === 'open') expect(gutter, line).toBe(empty ? ' ' : '?')
      if (label === 'you') expect(gutter, line).toBe(empty ? ' ' : '⚑')
    }
  })

  it('has a mission example whose header is the server headline', () => {
    expect(raw).toMatch(/Step \d+ of \d+ · \d+ verified/)
  })
})

describe.each(OWNERS)('%s — the v3 owner rules (§3.11)', (name) => {
  const raw = flat(readSkill(name))

  it('one step per deliverable: 1 unit = 1 PR = 1 step', () => {
    expect(raw).toContain('1 unit = 1 PR = 1 step')
    expect(raw).toMatch(/Sub-phases go to the Log/)
  })

  it('sign-offs become checks, not steps', () => {
    expect(raw).toMatch(/sign-offs become checks/i)
    expect(raw).toContain('mission_add_check')
  })

  it('declares the plan with mission_create { steps }', () => {
    expect(raw).toContain('mission_create { steps }')
    expect(raw).toMatch(/the end question in chat is the agreement/i)
  })

  it('never links a session only to change a proof label', () => {
    expect(raw).toMatch(
      /Never link a session to a step only to change its proof label; link the sessions that built it/
    )
  })

  it('stops the loop on MISSION_CLOSED', () => {
    expect(raw).toMatch(/On `MISSION_CLOSED`, stop the loop/)
  })

  it('speaks the pill headline', () => {
    expect(raw).toContain('Step N of M')
    expect(raw).toContain('derived.progress')
  })
})

describe('mission — the tick surfaces what the server derived (§3.9, AC-9)', () => {
  const tick = flat(section(readSkill('mission'), '`mission` — one tick'))

  it('reads the progress object instead of recounting', () => {
    expect(tick).toContain('derived.progress')
  })

  it('surfaces unprovable existence steps', () => {
    expect(tick).toContain('derived.progress.unprovable')
    expect(tick).toMatch(/can never be proven — link its PR or path/)
  })

  it('stops on a closed mission', () => {
    expect(tick).toContain('MISSION_CLOSED')
  })
})

describe('delivery-verifier — needs-human becomes a check (§3.6)', () => {
  const raw = flat(readSkill('delivery-verifier'))

  it('passes checkLabel with a needs-human verdict, which adds a check', () => {
    expect(raw).toContain('checkLabel')
    expect(raw).toMatch(/`needs-human` creates a check on the step/)
    expect(raw).toMatch(/the step reads `done`/)
  })
})

describe('delivery-watchdog — reads progress, no draft skip (§3.11)', () => {
  const raw = flat(readSkill('delivery-watchdog'))
  const tick = flat(section(readSkill('delivery-watchdog'), 'The tick'))

  it('reads derived.progress from mission_get', () => {
    expect(tick).toContain('derived.progress')
  })

  it('keeps every non-closed mission that is not delivered', () => {
    expect(tick).toMatch(/Keep the missions whose `status` is `active`/)
    expect(raw).not.toMatch(/has not started/)
  })
})
