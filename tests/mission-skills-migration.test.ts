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

import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'

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

describe('mission — rewired onto the mission_* verbs (AC-S8-1)', () => {
  const raw = readSkill('mission')

  it('still parses as the bundled `mission` skill', () => {
    expect(parseSkillFrontmatter(raw, 'mission')?.name).toBe('mission')
  })

  it('maps every mission operation to its verb', () => {
    for (const verb of [
      'mission_create',
      'mission_get',
      'mission_add_step',
      'mission_update_step',
      'mission_link_child',
      'mission_log',
      'mission_set_blocker',
      'mission_clear_blocker',
      'mission_set_end',
      'mission_verify_step',
      'mission_request_close',
      'mission_import_legacy',
      'mission_add_check'
    ]) {
      expect(raw, verb).toContain(verb)
    }
  })

  it('reads a tick from ONE mission_get instead of the four-source hand-assembly', () => {
    const tick = section(raw, '`mission` — one tick')
    expect(tick).toContain('mission_get({ folder, ownerSessionId')
    // The old step 2 polled the fleet and every approval by hand; the projection
    // carries both now. get_session survives only to prove a spawn in flight.
    expect(tick).not.toMatch(/`get_fleet` \(executor sessions/)
    expect(tick).not.toContain('`get_approval` for each pending approval id')
  })

  it('reads the stall flag instead of re-deriving it', () => {
    expect(raw).toContain('derived.stale')
    expect(raw).toMatch(/Do not re-derive a stall/)
  })

  it('never ends a mission itself — the operator does (Mission v3 §3.5)', () => {
    expect(raw).toMatch(/Only the operator ends a mission/)
    expect(raw).toMatch(/the close itself is theirs/)
  })

  it('passes the real session id, explicitly on an import', () => {
    expect(raw).toMatch(/scratchpad directory you were given ends in it/)
    expect(raw).toMatch(/mission_import_legacy\(\{ folder, legacyPath, sessionId: <your own/)
    expect(raw).toMatch(/always pass your own `sessionId` explicitly/)
  })

  it('never lets a session verify its own step', () => {
    expect(raw).toMatch(/The verifying session\s+must not be the step's author/)
  })
})

describe('mission — child reporting is a hard rule (AC-S8-5)', () => {
  const rules = section(readSkill('mission'), 'Child reporting — hard rules')

  it('is stated as rules, not suggestions', () => {
    expect(rules).toMatch(/These rules are not advice/)
    expect(rules).toMatch(/must hold, every send/)
  })

  it('addresses the owner by stable session id, resolved at send time', () => {
    expect(rules).toMatch(/Your owner is a session id, not a name/)
    expect(rules).toMatch(/Resolve the name at send time, every time/)
    expect(rules).toMatch(/Call `ListAgents` immediately\s+before sending/)
    expect(rules).toMatch(/Never reuse a name from an earlier turn/)
  })

  it('forbids broadcasting when the owner is unreachable', () => {
    expect(rules).toMatch(/\*\*Never broadcast\.\*\*/)
    expect(rules).toMatch(/to any session other than your owner/)
    expect(rules).toMatch(/Owner unreachable → stop, do not spread/)
  })

  it('tells the owner to recognize reports by id, and to re-announce a changed name', () => {
    expect(rules).toMatch(/A report is yours when it names your session id/)
    expect(rules).toMatch(/Re-announce when your name changes/)
    expect(rules).toContain('message_session({ sessionId')
  })
})

describe('status — reads missions through mission_list / mission_get (AC-S8-1)', () => {
  const raw = readSkill('status')
  const sources = section(raw, 'Where the facts come from')

  it('builds every mission front from the two read verbs', () => {
    expect(sources).toContain('mission_list({ folder })')
    expect(sources).toContain('mission_get({ folder,')
  })

  it('takes the bar and the `you` line from the mission instead of re-deriving them', () => {
    // Mission v3 §3.1: the bar is the server's `derived.progress`, not the
    // deprecated `steps: { total, verified, claimed }` counts.
    expect(raw).toContain('derived.progress')
    expect(sources).toMatch(/`you` line, verbatim/)
    expect(raw).toContain('derived.stale')
  })

  it('reads a legacy goal file only when no mission covers it', () => {
    expect(sources).toMatch(/only the ones no mission covers/)
    expect(sources).toMatch(/`mission: mnt-…`/)
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
