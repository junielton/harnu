/**
 * T369 (Mission progress S8) — the bundled delivery skills, migrated onto the
 * `mission_*` verbs.
 *
 * These are prose assertions on model-facing files, like `read-aloud-skill.test.ts`:
 * a SKILL.md is the artifact that ships, nothing compiles it, and each way it can
 * regress is invisible at runtime — a skill that quietly goes back to parsing
 * `.capy/goals/` by hand, a child told to reuse a cached SendMessage name, or a
 * watchdog that re-derives a stall `mission_get` already computes. Each guard
 * names the acceptance criterion it holds (AC-S8-1, AC-S8-5).
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

/** The text of one `## ` section (heading line excluded), up to the next `## `. */
function section(raw: string, heading: string): string {
  const start = raw.indexOf(`\n## ${heading}`)
  expect(start, `section "## ${heading}"`).toBeGreaterThan(-1)
  const next = raw.indexOf('\n## ', start + 4)
  return raw.slice(start, next === -1 ? undefined : next)
}

// Missions v4 S-28: the `mission` skill speaks the v4 verbs now. Its verb mapping, its single
// mission_get read, its session-id rules and its "never verify your own step" rule moved to
// tests/skill-mission-v4.test.ts; the child-reporting rules below are pinned against the v4 text.

describe('mission — child reporting is a hard rule (AC-S8-5)', () => {
  const rules = flat(section(readSkill('mission'), 'Child reporting'))

  it('is stated as rules, not suggestions', () => {
    expect(rules).toMatch(/they are rules, not advice/)
  })

  it('addresses the leader by stable session id, resolved at send time', () => {
    expect(rules).toMatch(/A name is not an identity/)
    expect(rules).toMatch(/your leader is a session id, not a name/)
    expect(rules).toMatch(
      /Call `ListAgents` right before every send and send only to a name you just saw listed/
    )
  })

  it('names the leader in the report itself, by id', () => {
    expect(rules).toContain('Report for session <owner uuid> · mission <missionId> · step <stepId>')
  })

  it('forbids broadcasting when the leader is unreachable', () => {
    expect(rules).toMatch(/If the leader is unreachable, write `\.harnu\/REPORT\.md` first/)
    expect(rules).toMatch(/Never send the report to any other session/)
  })

  it('tells the leader to recognize reports by id, and to re-announce a changed name', () => {
    expect(rules).toMatch(/A report that names your session id is yours/)
    expect(rules).toMatch(/When your name changes/)
    expect(rules).toContain('message_session')
  })
})

describe('status — reads missions through mission_list / mission_get (AC-S8-1)', () => {
  const raw = readSkill('status')
  const sources = section(raw, 'Where the facts come from')

  it('builds every mission front from the two read verbs', () => {
    expect(sources).toContain('mission_list({ folder })')
    expect(sources).toContain('mission_get({ folder,')
  })

  it('takes the headline and the `you` line from the mission instead of re-deriving them', () => {
    // Missions v4: the headline is `progress.headline`, and the operator's line is `next`.
    expect(raw).toContain('progress.headline')
    expect(flat(sources)).toMatch(/`next` from `mission_get`: its `ask`/)
  })
})

describe('orchestrate-delivery — stall comes from the mission (AC-S8-1)', () => {
  const raw = readSkill('orchestrate-delivery')

  it('retires its own 3-tick stall heuristic in favour of derived.stale', () => {
    expect(raw).not.toMatch(/across 3 consecutive ticks/)
    expect(raw).toMatch(/stall is not yours to compute — it is `mission_get`'s `derived.stale`/)
  })

  it('declares the delivery as a Mission through the verbs', () => {
    for (const verb of [
      'mission_create',
      'mission_add_step',
      'mission_link_child',
      'mission_verify_step',
      'mission_request_close'
    ]) {
      expect(raw, verb).toContain(verb)
    }
    expect(raw).not.toContain('.harnu/goals/<session8>-<slug>.md')
    expect(raw).not.toContain('.capy/goals/<session8>-<slug>.md')
  })

  it('keeps the three-layer heartbeat (it solves being woken, not state)', () => {
    expect(raw).toMatch(/Layer 1 — a push subscription/)
    expect(raw).toMatch(/Layer 3 — a watchdog on Harnu's Scheduler/)
  })

  it('gives executors a stable-id return address and forbids broadcast (AC-S8-5)', () => {
    expect(raw).toMatch(/your stable session id/)
    expect(raw).toMatch(/resolve at send time/)
    expect(raw).toMatch(/never broadcast/)
  })
})

describe('delivery-watchdog — reads the mission instead of hand-coded shapes (AC-S8-1)', () => {
  const raw = readSkill('delivery-watchdog')

  it('finds deliveries with the two read verbs an observe tick is allowed', () => {
    expect(raw).toContain('mission_list({ folder })')
    expect(raw).toContain('mission_get({ folder, missionId })')
    expect(raw).not.toMatch(/Read `<repo>\/\.(capy|harnu)\/goals\/\*\.md`\. No goal files/)
  })

  it('takes the stall from derived.stale instead of 3x a guessed cadence', () => {
    expect(raw).toContain('`derived.stale` is `true`')
    expect(raw).not.toMatch(/three times the stated cadence/)
  })

  it('reads blockers from the mission', () => {
    expect(raw).toMatch(/open blocker whose `owner` is `operator`/)
  })

  it('retires the `## Watchdog` card-block dedup', () => {
    expect(raw).toMatch(/`## Watchdog` block to\s+the card is retired/)
    expect(raw).not.toContain('update_card')
    expect(raw).toMatch(/seen: <key>/)
  })
})
