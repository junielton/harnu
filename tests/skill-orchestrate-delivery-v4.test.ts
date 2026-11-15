/**
 * Missions v4 · S-29 · AC-71 — the bundled `orchestrate-delivery` skill plans milestones and steps
 * with criteria, never a campaign or a chapter, hands over by attach and the operator's hand-off,
 * and is under 700 lines (from 1,225).
 *
 * These are text pins on a model-facing file: a SKILL.md ships as read and nothing compiles it. A
 * pin shows what the text says. It cannot show that a model follows it; the behaviour scenarios
 * (S-33) grade that. What a pin CAN do is stay tied to the code: the verb names come from the MCP
 * catalog, the payloads in the skill are parsed against the real verb schemas, and the writing
 * contract it loads is a file that exists.
 *
 * Every check is a function over the skill's text. The shipped text must report nothing, and an
 * inline mutation that says the opposite (a steward that dispatches, a campaign, a hand-off nobody
 * may start) must report something, so a check that stopped looking would fail here.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'
import { MCP_TOOLS, toolByName } from '../src/main/mcp/tool-catalog'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILLS = path.join(REPO_ROOT, 'resources', 'skills', 'skills')
const SKILL_FILE = path.join(SKILLS, 'orchestrate-delivery', 'SKILL.md')
const read = (): string => readFileSync(SKILL_FILE, 'utf8')

/** AC-71's line: under 700. The operator's ask (less information in a small space) is the tighter cap. */
const AC_LINE_CAP = 700
const SMALL_LINE_CAP = 550

/** Collapse Prettier's line wrapping so a sentence matches whatever its breaks. */
const flat = (s: string): string => s.replace(/\s+/g, ' ')

/** The text of one heading's section, up to the next heading of the same or a higher level. */
function section(md: string, heading: RegExp): string {
  const lines = md.split('\n')
  let inFence = false
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) inFence = !inFence
    if (inFence) continue
    const h = /^(#{1,6})\s/.exec(line)
    if (start === -1) {
      if (h && heading.test(line)) {
        start = i
        level = h[1].length
      }
    } else if (h && h[1].length <= level) {
      return lines.slice(start, i).join('\n')
    }
  }
  return start === -1 ? '' : lines.slice(start).join('\n')
}

/** The fenced `json` blocks of a text, parsed (an unparsable block is no payload). */
function jsonFences(md: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let body: string[] | null = null
  let lang = ''
  for (const line of md.split('\n')) {
    const open = /^\s*```(\S*)/.exec(line)
    if (open) {
      if (body) {
        if (lang === 'json') {
          try {
            const parsed: unknown = JSON.parse(body.join('\n'))
            if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>)
          } catch {
            // an unparsable block is no payload
          }
        }
        body = null
      } else {
        body = []
        lang = open[1]
      }
    } else if (body) body.push(line)
  }
  return out
}

/** A payload's problems against a verb's real input schema: unknown keys, or a failed parse. */
function verbSchemaProblems(verb: string, payload: Record<string, unknown> | undefined): string[] {
  if (!payload) return [`no fenced ${verb} payload`]
  const schema = toolByName(verb)?.inputSchema as z.ZodTypeAny | undefined
  if (!schema) return [`${verb} is not in the tool catalog`]
  const def = (schema as unknown as { _def: { schema?: z.ZodObject<z.ZodRawShape> } })._def
  const object = (def.schema ?? schema) as z.ZodObject<z.ZodRawShape>
  const known = new Set(Object.keys(object.shape ?? {}))
  const problems = Object.keys(payload)
    .filter((k) => !known.has(k))
    .map((k) => `${verb}: unknown key ${k}`)
  const result = schema.safeParse(payload)
  if (!result.success) problems.push(`${verb}: ${result.error.issues.map((i) => i.message)}`)
  return problems
}

/** The v4 verbs the skill names (the verbs a leader of a delivery calls). */
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
  'mission_attach',
  'mission_request_close',
  'rebase_stack',
  'create_session',
  'submit_manifest'
]

/** Registered until S-40 but refused by (or meaningless to) a v4 mission: a skill never sends one. */
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

/** What the v3 delivery taught, by the names the spec's fate table lists. Never the plain word "chapter". */
const V3_NAMES = [
  /campaign_[a-z]+/,
  /campaignId|chapterId/,
  /PREREQ_MISSING/,
  /delivery map|delivery-map/i,
  /declaredEnd|declared end|fixed end/i,
  /Delivered and verified/,
  /decision node/i,
  /derived\.|youItems|closeReadiness/,
  /\bledger\b/i,
  /needs-human/,
  /"verification"/,
  /no context threshold|stand down because/i,
  /legacy|goal file/i
]

function v4Problems(skill: string): string[] {
  const out: string[] = []
  const all = flat(skill)
  const parsed = parseSkillFrontmatter(skill, 'orchestrate-delivery')
  if (parsed?.name !== 'orchestrate-delivery') out.push('the name is not orchestrate-delivery')
  if (!parsed || /[.!?]\s+[A-Z"]/.test(parsed.description))
    out.push('the description is not one sentence')

  // The verbs: all named, all registered, none retired, no campaign verb.
  const registered = new Set(MCP_TOOLS.map((t) => t.name))
  const named = new Set(skill.match(VERB_SHAPED) ?? [])
  for (const verb of V4_VERBS) {
    if (!registered.has(verb)) out.push(`${verb} is not registered`)
    if (!skill.includes(verb)) out.push(`${verb} is not named`)
  }
  for (const verb of named) if (!registered.has(verb)) out.push(`${verb} is not registered`)
  for (const verb of RETIRED_VERBS) if (named.has(verb)) out.push(`${verb} is named`)
  for (const re of V3_NAMES) if (re.test(skill)) out.push(`names a retired v3 thing: ${re}`)

  // The plan: stages are milestones, criteria on steps, the milestone shapes differ.
  if (!/A stage of the objective is a milestone/.test(all)) out.push('a stage is not a milestone')
  if (!/`mission_create` takes the milestone's title/.test(all))
    out.push('mission_create does not take the milestone title')
  if (!/`mission_add_step` takes its id \(`mls-<n>`\)/.test(all))
    out.push('mission_add_step does not take the milestone id')
  if (!/Every step carries at least one criterion/.test(all)) out.push('a step needs a criterion')
  if (!/A sign-off is an operator criterion \(`by: 'operator'`\), never a step/.test(all))
    out.push('a sign-off is not an operator criterion')
  if (!/never edited after dispatch/i.test(all) || !/a new criterion/.test(all))
    out.push('criteria are not frozen after dispatch')
  if (
    !/Check the whole mission against Done when"?\*{0,2}, with a second session criterion/.test(all)
  )
    out.push('the last step (D-21) is not planned')
  if (!/Load `\.\.\/mission\/references\/writing-contract\.md`/.test(all))
    out.push('the writing contract is not loaded')
  if (!existsSync(path.join(SKILLS, 'mission', 'references', 'writing-contract.md')))
    out.push('the writing contract reference does not exist')
  const create = jsonFences(skill).find((p) => 'doneWhen' in p && 'milestones' in p)
  out.push(...verbSchemaProblems('mission_create', create))

  // Dispatch: through the verbs that bind the step.
  if (!/`create_session` with `missionId` and `stepId`/.test(all))
    out.push('dispatch is not create_session with missionId and stepId')
  if (!/ACK carries `card` and `worker`/.test(all)) out.push('the dispatch ACK is not read')
  if (!/`submit_manifest`[^.]*`missionId`[^.]*`stepId`/.test(all))
    out.push('submit_manifest does not carry the step')
  if (!/`role: 'verifier'`/.test(all)) out.push('a verifier is not started with role verifier')
  if (!all.includes('`.harnu/evidence/<missionId>/<stepId>`') || !/README/.test(all))
    out.push('the verifier evidence folder and its README are not named')
  if (!/There is no steward/.test(all)) out.push('does not say there is no steward')
  if (/steward (dispatches|wakes|ticks|rebases)/i.test(all)) out.push('a steward does a job')
  if (!/dispatch the verifiers, nudge a stalled worker and call `rebase_stack`/.test(all))
    out.push('the leader does not own what the steward did')
  if (!/never pushes/i.test(all)) out.push('rebase_stack is not said to never push')

  // What this delivery learned.
  if (!/change of instructions[^.]*delta file the message names/i.test(all))
    out.push('a change of instructions is not a delta file')
  if (!/sign-off is its own operator criterion/.test(all))
    out.push('a visual sign-off is not apart')
  if (!/merges `origin\/main` into its branch before it opens the PR/.test(all))
    out.push('the shipper does not merge origin/main first')
  // Said twice on purpose: in the exit sequence and in the shipper's boot template, which is pasted alone.
  if ((all.match(/never rebase a pushed branch/gi) ?? []).length < 2)
    out.push(
      'a pushed branch may be rebased (the exit sequence and the shipper template both say not)'
    )
  if (!/never use, copy or link the operator's Claude credentials/i.test(all))
    out.push('the operator credentials are not forbidden')
  if (!/must fail against the code it replaces/.test(all))
    out.push('a proof need not fail against the code it replaces')
  // Asked of both: the executor plants it before the test is green, the verifier plants it again.
  if (!/executor plants a fault first/.test(all))
    out.push('the executor is not asked to plant a fault')
  if (!/plant a fault against the code the proof replaces/.test(all))
    out.push('the verifier is not asked to plant a fault')
  if (!/Stack each unit on the previous branch/.test(all) || !/runtime dependency/.test(all))
    out.push('stacking is not stated')

  // What a dispatched packet and a tick keep, because code or a skill parses it. The tick first line
  // lives in the `mission` skill alone (its own pins hold it byte for byte): here it is a pointer, never a copy.
  if (
    !/starts with the one fixed first line the `mission` skill defines/.test(all) ||
    !/The tick prompt's first line/.test(all)
  )
    out.push('the tick first line is not pointed at')
  if (skill.includes('/harnu:mission tick ·')) out.push('the tick first line is restated here')
  if (!all.includes('Report for session <owner uuid> · mission <missionId> · step <stepId>'))
    out.push('the child report header is missing')
  if (!/Honest exit clause/.test(all) || !/Never quietly drop an AC/.test(all))
    out.push('the honest exit clause is missing')

  // Rules the older v2 and v3 suites held on this skill and that still hold in v4 (those suites no longer read it).
  for (const heading of [
    /^## Phase 1 — Plan\s*$/m,
    /^### The spec-born mission\s*$/m,
    /^## Phase 2 — Cards and dispatch\s*$/m,
    /^### Cards from a spec — the derive planner\s*$/m,
    /^### Open decisions become operator blockers\s*$/m,
    /^### Done conditions — checkable by the worker alone\s*$/m,
    /^### Boot templates by role\s*$/m,
    /^## Phase 3 — Monitor\s*$/m,
    /^## Hand-off\s*$/m,
    /^## Phase 4 — Verify each unit, per criterion\s*$/m,
    /^## Phase 5 — Delivery report\s*$/m
  ])
    if (!heading.test(skill)) out.push(`no section ${heading}`)
  if (!/Create the mission now, without asking/.test(all))
    out.push('the mission is not created at once')
  if (!/1 unit = 1 PR = 1 step/.test(all) || !/Sub-phases[^.]*go to the Log/.test(all))
    out.push('one step per deliverable is not stated')
  if (!/Never make "a message was delivered to another session" a done condition/.test(all))
    out.push('a delivered message may be a done condition')
  if (!/Invoke `\/dtk:ship`/.test(all) || !/open the PR only, never merge/.test(all))
    out.push('the shipper template is missing')
  if (!/Invoke `land-prs`/.test(all) || !/Invoke `\/dtk:review-peer`/.test(all))
    out.push('the lander or reviewer template is missing')
  // The heartbeat keeps three layers: it solves being woken, not state.
  if (!/notify_when_idle: true/.test(all) || !/push subscription per worker/.test(all))
    out.push('no push subscription per worker')
  if (!/`\/harnu:delivery-watchdog`/.test(all) || !/`observe` mode/.test(all))
    out.push('no watchdog worker')
  if (!/Arm the ticks yourself, before you report the dispatch/.test(all))
    out.push('the ticks are not armed')
  if (!/On `MISSION_CLOSED`, stop the loop/.test(all))
    out.push('the loop does not stop on MISSION_CLOSED')
  // The return address: a stable id, resolved at send time, never broadcast, the file first.
  if (!/your stable session id/.test(all)) out.push('the return address has no stable session id')
  if (!/right before every send/.test(all)) out.push('the leader is not resolved at send time')
  if (!/never broadcast/.test(all)) out.push('a report may be broadcast')
  if (!/Write `\.harnu\/REPORT\.md` first, always, then send/.test(all))
    out.push('the report file is not first')
  // An operator wait is a blocker, the Done when is re-scoped the same turn, stacked PRs are retargeted.
  if (
    !/A turn that ends waiting on the operator raises that blocker first/.test(all) ||
    !all.includes("`mission_set_blocker { owner: 'operator' }`")
  )
    out.push('a wait on the operator is not a blocker')
  if (!/call `mission_set_done_when` in the same turn/.test(all))
    out.push('Done when is not re-scoped at once')
  if (
    !all.includes('gh pr edit <n> --base <default branch>') ||
    !all.includes('gh pr view <n> --json baseRefName')
  )
    out.push('stacked PRs are not retargeted before the merge handoff')
  if (!/`mission_request_close`/.test(all) || !/refused `STEPS_OPEN`/.test(all))
    out.push('the close request and its refusal are not stated')
  if (!/`mission_settle_ac \{ stepId, criterionId, evidence \}`/.test(all))
    out.push('criteria are not settled with mission_settle_ac')

  // The hand-off is the operator's.
  const handoff = flat(section(skill, /^## Hand-off\s*$/))
  if (!/only the operator starts a hand-off/i.test(handoff))
    out.push('hand-off: operator starts it')
  if (!/never switches itself/i.test(handoff)) out.push('hand-off: the leader never switches')
  if (!/one line in its reply and one `mission_log` note/.test(handoff))
    out.push('hand-off: one line and one mission_log')
  if (!/starts from the summary/i.test(handoff))
    out.push('hand-off: a fresh session starts from the summary')
  if (!/no resume prompt is ever pasted/i.test(handoff)) out.push('hand-off: no resume prompt')
  if (!/`mission_attach`/.test(handoff)) out.push('hand-off: another session attaches')
  return out
}

interface Mutation {
  find: string
  replace: string
  why: string
}

/** Replace the first match of `find`, whatever its case and the line wrapping its spaces fall on. */
function mutate(text: string, m: Mutation): string {
  const re = new RegExp(m.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'), 'i')
  if (!re.test(text)) throw new Error(`mutation anchor not found: ${m.find} (${m.why})`)
  return text.replace(re, () => m.replace)
}

describe('the skill speaks v4', () => {
  it('the skill speaks v4: milestones, steps with criteria, attach, the hand-off, no campaign', () => {
    expect(v4Problems(read())).toEqual([])
  })

  it('is under 700 lines (AC-71) and as small as the operator asked', () => {
    const lines = read().split('\n').length
    expect(lines, 'AC-71: under 700 lines').toBeLessThan(AC_LINE_CAP)
    expect(lines, 'the operator asked for less in a small space').toBeLessThanOrEqual(
      SMALL_LINE_CAP
    )
  })

  it('every pin fails on a text that says the opposite', () => {
    const skill = read()
    const mutations: Mutation[] = [
      {
        find: 'There is no steward',
        replace: 'The steward dispatches the verifier',
        why: 'a steward does the routine'
      },
      {
        find: 'A stage of the objective is a milestone',
        replace: 'A stage of the objective is a campaign chapter',
        why: 'stages are milestones'
      },
      {
        find: 'Only the operator starts a hand-off',
        replace: 'the leader starts a hand-off when it feels long',
        why: 'the hand-off is the operator'
      },
      {
        find: 'no resume prompt is ever pasted',
        replace: 'a resume prompt is pasted into the new session',
        why: 'no resume prompt'
      },
      {
        find: '`mission_add_step` takes its id (`mls-<n>`)',
        replace: '`mission_add_step` takes its title',
        why: 'the id shape of a step'
      },
      {
        find: 'Check the whole mission against Done when',
        replace: 'Delivered and verified',
        why: 'the last step, D-21'
      },
      {
        find: '`create_session` with `missionId` and `stepId`',
        replace: '`create_session` with a prePrompt',
        why: 'dispatch binds the step'
      },
      {
        find: "never use, copy or link the operator's Claude credentials",
        replace: "borrow the operator's Claude credentials when a session needs a login",
        why: 'credentials are never used'
      },
      {
        find: 'never rebase a pushed branch',
        replace: 'rebase a pushed branch when it is behind',
        why: 'no rebase of a pushed branch'
      },
      {
        find: 'the one fixed first line the `mission` skill defines',
        replace: 'a first line of your own',
        why: 'the tick first line is parsed by code and defined once'
      },
      {
        find: 'mission_attach',
        replace: 'mission_transfer_owner',
        why: 'hand over by attach, not by a transfer'
      }
    ]
    for (const m of mutations)
      expect(v4Problems(mutate(skill, m)), `should fail: ${m.why}`).not.toEqual([])
  })
})
