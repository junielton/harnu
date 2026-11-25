/**
 * Missions v4 · S-28 · AC-73, AC-74, AC-75 — the bundled `mission`, `status` and `report-back` skills
 * speak v4, and the writing contract ships as a reference the mission-writing skills load.
 *
 * These are text pins on model-facing files: a SKILL.md ships as read, and nothing compiles it. A pin
 * shows what the text says. It cannot show that a model follows it; the behaviour scenarios (S-33)
 * grade that. What a pin CAN do is stay tied to the code: the verb names come from the MCP catalog and
 * the writing contract's rules come from `src/main/missions/contract.ts`, so the reference cannot
 * drift from what the verbs refuse.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import {
  BLOCKER_REASON_MIN_WORDS,
  CAPS,
  CRITERION_MIN_WORDS,
  INTERNAL_WORDS,
  STATE_WORDS,
  checkBlockerReason,
  checkCriterion,
  checkStepTitle,
  checkTitleEdge,
  type ContractResult
} from '../src/main/missions/contract'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILLS = path.join(REPO_ROOT, 'resources', 'skills', 'skills')
const read = (...p: string[]): string => readFileSync(path.join(SKILLS, ...p), 'utf8')

/** Collapse Prettier's line wrapping so a sentence matches whatever its breaks. */
const flat = (s: string): string => s.replace(/\s+/g, ' ')

/** The text of one `## ` section (heading line excluded), up to the next `## `. */
function section(raw: string, heading: string): string {
  const start = raw.indexOf(`\n## ${heading}`)
  expect(start, `section "## ${heading}"`).toBeGreaterThan(-1)
  const next = raw.indexOf('\n## ', start + 4)
  return raw.slice(start, next === -1 ? undefined : next)
}

const mission = read('mission', 'SKILL.md')
const status = read('status', 'SKILL.md')
const reportBack = read('report-back', 'SKILL.md')
const REFERENCE = path.join('mission', 'references', 'writing-contract.md')

/** The v4 verbs the mission skill names (the spec's sixteen, minus the two it never calls itself). */
const V4_VERBS = [
  'mission_create',
  'mission_get',
  'mission_list',
  'mission_add_milestone',
  'mission_add_step',
  'mission_add_ac',
  'mission_link',
  'mission_log',
  'mission_set_blocker',
  'mission_clear_blocker',
  'mission_set_done_when',
  'mission_settle_ac',
  'mission_attach',
  'mission_request_close',
  'rebase_stack'
]

/** Verbs that stay registered until S-40 but that no v4 mission answers: a skill never sends one. */
const RETIRED_VERBS = [
  'mission_link_child',
  'mission_set_end',
  'mission_verify_step',
  'mission_add_check',
  'mission_import_legacy',
  'mission_transfer_owner',
  'mission_update_step'
]

const VERB_SHAPED =
  /(?<![A-Za-z0-9])(?:(?:mission|campaign)_[a-z]+(?:_[a-z]+)*|rebase_stack(?:_[a-z]+)*|plan_mission(?:_[a-z]+)*)(?![A-Za-z0-9])/g

describe('the mission skill', () => {
  it('the mission skill speaks v4 and states the proactive rule', () => {
    // It still parses, keeps its name, and its description is ONE sentence.
    const parsed = parseSkillFrontmatter(mission, 'mission')
    expect(parsed?.name).toBe('mission')
    expect(parsed!.description).not.toMatch(/[.!?]\s+[A-Z"]/)

    // The v4 verbs are named, and nothing the catalog does not register, and nothing v4 refuses.
    const registered = new Set(MCP_TOOLS.map((t) => t.name))
    for (const verb of V4_VERBS) {
      expect(registered.has(verb), `${verb} is registered`).toBe(true)
      expect(mission, verb).toContain(verb)
    }
    const named = new Set(mission.match(VERB_SHAPED) ?? [])
    for (const verb of named) expect(registered.has(verb), `${verb} is registered`).toBe(true)
    for (const verb of RETIRED_VERBS) expect(named.has(verb), `${verb} is not named`).toBe(false)
    expect([...named].filter((v) => v.startsWith('campaign_'))).toEqual([])

    // The two shapes that differ: a title at creation, the id afterwards.
    const all = flat(mission)
    expect(all).toMatch(/`mission_create` takes the milestone's title/)
    expect(all).toMatch(/`mission_add_step` takes its id \(`mls-<n>`\)/)

    // The v3 model is gone from the text: no declared end, campaign, chapter headline, legacy import.
    // (The steward is judged in its own test: the skill says there is none.)
    expect(mission).not.toMatch(/declaredEnd|campaign|Ch\. N\/M|mission_import|legacy/i)

    // The tick keeps its first line, byte for byte: code parses it.
    expect(mission).toContain('/harnu:mission tick · <missionId>')
    expect(mission).toContain('U+00B7')
    expect(mission).toMatch(/\/harnu:mission tick · mnt-[0-9a-f]{8}\n/)
    expect(all).toMatch(/Harnu mod draws each tick as a live card/)

    // The child report header, which code parses too.
    expect(all).toContain('Report for session <owner uuid> · mission <missionId> · step <stepId>')

    // The proactive rule (decision 22): create the mission before the first step, without asking.
    const rule = flat(section(mission, 'When to create one'))
    expect(rule).toMatch(/At the first sign of multi-step work/i)
    expect(rule).toMatch(/create the mission before the first step, without asking/i)
    expect(rule).toMatch(/more than one pull request|more than one PR/i)
    expect(rule).toMatch(/You lead it/)
    expect(rule).toMatch(/A one-line question creates none/i)
  })

  it('intake rules', () => {
    const intake = flat(section(mission, 'Task intake'))
    expect(intake).toMatch(/a door any skill can use/i)
    // The QA criteria become the build step's criteria (each a sentence, by the default settler).
    expect(intake).toMatch(/the QA criteria become the build step's criteria/i)
    expect(intake).toContain('mission_add_step')
    expect(intake).toContain('mission_add_ac')
    // A line that says what is not expected is a note, never a criterion.
    expect(intake).toMatch(/a line that says what is not expected becomes a note/i)
    expect(intake).toContain('mission_log')
    // An empty group pulls nothing, and is flagged.
    expect(intake).toMatch(/an empty group pulls nothing and is flagged/i)
    // The task's links become mission links.
    expect(intake).toMatch(/the task's links become mission links/i)
    expect(intake).toContain('mission_link')
  })

  it('the hand-off belongs to the operator: the leader never switches itself, no resume prompt', () => {
    const handoff = flat(section(mission, 'Hand-off'))
    expect(handoff).toMatch(/only the operator starts a hand-off/i)
    expect(handoff).toMatch(/never switches itself/i)
    expect(handoff).toMatch(/starts from the summary/i)
    expect(handoff).toMatch(/no resume prompt is ever pasted/i)
    expect(handoff).toContain('mission_attach')
    expect(handoff).toMatch(/asks the operator for a hand-off/i)
    // The v3 rule it replaces: "there is no context threshold at which you stop owning the mission".
    expect(flat(mission)).not.toMatch(/no context threshold|never writes a resume prompt/i)
  })

  it('knows the sessions Harnu spawns and what a dispatch attaches', () => {
    const all = flat(mission)
    expect(all).toMatch(/worker.*verifier.*observer/i)
    expect(all).toMatch(/never pass a `sessionId`/i)
    // A dispatch binds the step's card and attaches the session; the ACK says so.
    expect(all).toMatch(/`card` and `worker`/)
  })

  it('the tick reads one mission_get, never gh or the fleet, and keeps the doors shut', () => {
    const tick = flat(section(mission, 'One tick'))
    expect(tick).toContain('mission_get({ folder, missionId, sessionId })')
    expect(tick).toMatch(/Make no `gh pr view` call and no `get_fleet` call/)
    // A second session settles; the builder only self-checks, and a self-check is never proof.
    expect(tick).toMatch(/A second session settles each criterion \(`mission_settle_ac`/)
    expect(tick).toMatch(/only self-checks, and that is never proof/)
    expect(tick).toMatch(/twice unmet is the operator's decision/)
    // A turn that ends waiting on the operator raises an operator-owned blocker first.
    expect(tick).toMatch(/A turn that ends waiting on the operator/)
    expect(tick).toContain("owner: 'operator'")
    // A red gate is a side step; the doors stay the operator's; a closed mission stops the loop.
    expect(tick).toMatch(/A red gate[^.]*optional step/)
    expect(tick).toMatch(/Never cross the doors/)
    expect(tick).toContain('MISSION_CLOSED')
    expect(tick).toMatch(/stop the loop and report/)
  })

  it('has no steward: the leader coordinates and rebases a step itself', () => {
    const all = flat(mission)
    expect(all).toMatch(/There is no steward/)
    expect(all).toContain('rebase_stack')
    expect(all).toMatch(/never pushes/i)
  })

  it('is shorter than the v3 skill it replaces, and says every output stays short', () => {
    expect(mission.split('\n').length).toBeLessThanOrEqual(330)
    expect(flat(mission)).toMatch(/Every output stays short/i)
  })

  it('every `mission_…` name in the three skills is registered, and none is a parameter name', () => {
    const registered = new Set(MCP_TOOLS.map((t) => t.name))
    for (const text of [mission, status, reportBack]) {
      for (const name of text.match(VERB_SHAPED) ?? []) {
        expect(registered.has(name), name).toBe(true)
      }
    }
  })
})

/** A markdown table's data rows as cells, under the line that starts with `heading`. */
function tableUnder(raw: string, heading: string): string[][] {
  const lines = raw.split('\n')
  const start = lines.findIndex((l) => l.startsWith(heading))
  expect(start, `heading "${heading}"`).toBeGreaterThan(-1)
  const rows: string[][] = []
  let seenTable = false
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('|')) {
      seenTable = true
      rows.push(
        line
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim())
      )
    } else if (seenTable) break
  }
  // Drop the header row and the separator row.
  return rows.slice(2)
}

/** Every backticked token of a cell. */
const ticks = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])

function refused(result: ContractResult, code: string): void {
  expect(result.ok, `refused with ${code}`).toBe(false)
  if (!result.ok) expect(result.code).toBe(code)
}

describe('the writing contract reference', () => {
  it('the writing contract is bundled', () => {
    // It ships at a fixed path inside the mission skill, and the skill loads it.
    expect(existsSync(path.join(SKILLS, REFERENCE))).toBe(true)
    const ref = read(REFERENCE)
    expect(mission).toContain('references/writing-contract.md')
    expect(flat(mission)).toMatch(/read `references\/writing-contract\.md`/)

    // It points at nothing outside Harnu: no personal skill, no personal path.
    expect(ref).not.toMatch(/action-brief/i)
    expect(ref).not.toMatch(/\/(home|Users)\/[A-Za-z0-9._-]+\//)

    // The caps table IS the code's caps.
    const caps = Object.fromEntries(
      tableUnder(ref, '## Caps').map(([key, n]) => [ticks(key)[0], Number(n)])
    )
    expect(caps).toEqual(CAPS)

    // The checkable-rules table has the five rules, in the spec's order, each with one bad and one
    // good example, and every example behaves the way the verbs behave.
    const rules = tableUnder(ref, '## Checkable rules')
    expect(rules).toHaveLength(5)
    const [edge, criterion, blocker, internal, state] = rules
    const examples = (row: string[]): { bad: string[]; good: string[] } => ({
      bad: ticks(row[1]),
      good: ticks(row[2])
    })

    // 1. An id or number is not the start or end of a title.
    expect(edge[0]).toMatch(/^An id or number/)
    for (const form of ['T685', '#256', 'PROJ-231', 'stp-3', 'mls-2']) {
      expect(edge[0], form).toContain(`\`${form}\``)
      refused(checkTitleEdge(`${form} Run the tool`), 'TITLE_EDGE_ID')
      refused(checkTitleEdge(`Run the tool (${form})`), 'TITLE_EDGE_ID')
    }
    for (const bad of examples(edge).bad) refused(checkStepTitle(bad), 'TITLE_EDGE_ID')
    expect(examples(edge).bad.length).toBeGreaterThanOrEqual(2)
    for (const good of examples(edge).good) expect(checkStepTitle(good).ok).toBe(true)

    // 2. A criterion has at least CRITERION_MIN_WORDS words.
    expect(criterion[0]).toMatch(/^A criterion/)
    expect(criterion[0]).toContain(`${CRITERION_MIN_WORDS} words`)
    for (const bad of examples(criterion).bad) refused(checkCriterion(bad), 'CRITERION_TOO_SHORT')
    for (const good of examples(criterion).good) expect(checkCriterion(good).ok).toBe(true)

    // 3. A blocker reason has at least BLOCKER_REASON_MIN_WORDS words and one exact reference.
    expect(blocker[0]).toMatch(/^A blocker/)
    expect(blocker[0]).toContain(`${BLOCKER_REASON_MIN_WORDS} words`)
    for (const bad of examples(blocker).bad)
      refused(checkBlockerReason(bad), 'BLOCKER_REASON_VAGUE')
    for (const good of examples(blocker).good) expect(checkBlockerReason(good).ok).toBe(true)

    // 4. Internal words are refused: the list is the code's list, exactly.
    expect(internal[0]).toMatch(/^Internal words/)
    expect(new Set(ticks(internal[0]))).toEqual(new Set(INTERNAL_WORDS))
    for (const bad of examples(internal).bad) refused(checkStepTitle(bad), 'INTERNAL_WORD')
    for (const good of examples(internal).good) expect(checkStepTitle(good).ok).toBe(true)

    // 5. A title is never only a state word: the list is the code's list, exactly.
    expect(state[0]).toMatch(/^A milestone or step title/)
    expect(new Set(ticks(state[0]))).toEqual(new Set(STATE_WORDS))
    for (const bad of examples(state).bad) refused(checkStepTitle(bad), 'STATE_WORD_TITLE')
    for (const good of examples(state).good) expect(checkStepTitle(good).ok).toBe(true)

    // The verbs refuse and never rewrite: the reference says so.
    expect(flat(ref)).toMatch(/Harnu never cuts or rewrites (a|your) text/i)
  })
})

describe('status', () => {
  it('renders the v4 headline the way the pane does, with no campaign and no verb that does not exist', () => {
    const parsed = parseSkillFrontmatter(status, 'status')
    expect(parsed?.name).toBe('status')
    const all = flat(status)

    // The headline is Harnu's, read from the rows and the mission, never recounted.
    expect(all).toContain('mission_list')
    expect(all).toContain('mission_get')
    expect(all).toMatch(/`headline`/)
    expect(all).toMatch(/\d+ of \d+ (steps|milestones) done/)
    expect(all).toMatch(/never recount/i)
    // The operator's line is the first waiting item.
    expect(all).toMatch(/`waiting`/)
    expect(all).toMatch(/`next`/)

    // The v3 headline and the campaign link are gone, and so is the verb that never existed.
    expect(status).not.toMatch(/Ch\. \d|campaign|get_board|derived\.progress|youItems|Step N of M/)
    expect(status).not.toContain('.harnu/goals')
    // It still answers in six lines.
    expect(all).toMatch(/Six lines\. No seventh\./)
    expect(all).toContain("— nothing, you're clear")
  })

  it('never recounts the headline and prints no second count beside it', () => {
    const all = flat(status)
    expect(all).toMatch(/Never recount steps by their state/)
    expect(all).toMatch(/never print a second count beside it/)
    // The operator's line is Harnu's `next`, never an item the skill derived.
    expect(all).toMatch(/never an item you derived yourself/)
  })

  it('is shorter than before', () => {
    expect(status.split('\n').length).toBeLessThanOrEqual(260)
  })
})

describe('report-back', () => {
  it('keeps its shape and drops the campaign wording and the chapter headline', () => {
    const parsed = parseSkillFrontmatter(reportBack, 'report-back')
    expect(parsed?.name).toBe('report-back')
    expect(reportBack).not.toMatch(/Ch\. N\/M|campaign|Campaign|chapter/)
    expect(reportBack).not.toContain('.harnu/goals/')

    // The shape is unchanged: a flat rail, the gutter ledger, the links, a summary of at most 3 lines.
    const all = flat(reportBack)
    expect(all).toContain('A flat rail')
    expect(all).toContain("— nothing, you're clear")
    expect(all).toMatch(/at most 3 (plain )?(lines|sentences)/i)
    expect(reportBack).toContain('mission_get')
    // A v4 read carries `summary`, `steps` and `next`; it has no Harnu ledger, so the skill names none.
    expect(all).toMatch(/`summary`/)
    expect(all).toMatch(/`next`/)
    expect(all).not.toMatch(/Harnu wrote itself|`ledger`/)
    // The headline of a mission is the one Harnu gives.
    expect(all).toMatch(/`headline`/)
  })
})
