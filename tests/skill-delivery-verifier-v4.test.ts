/**
 * Missions v4 · S-30 · AC-72 — the bundled `delivery-verifier` settles criteria one by one on the step through
 * the scoped verb `mission_settle_ac`, and `delivery-watchdog` has no steward half: it is the read-only sweep and
 * nothing else.
 *
 * These are text pins on two model-facing files: a SKILL.md ships as read and nothing compiles it. A pin shows
 * what the text says. It cannot show that a model follows it; the behaviour scenarios (S-33) grade that. What a
 * pin CAN do is stay tied to the code: the verb names come from the MCP catalog, the verbs a verifier is told it
 * holds are the ones the scoped credential grants, the payload in the skill is parsed against the real verb
 * schema, and the evidence folder is the path the code names.
 *
 * Every check is a function over the skill's text. The shipped text must report nothing, and an inline mutation
 * that says the opposite (a verifier that records a verdict on the step, a watchdog that dispatches, a sweep that
 * reports quiet for a read it could not make) must report that very problem, so a check that stopped looking
 * would fail here.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'
import { evidenceBundleDir } from '../src/main/mission-gates'
import { MCP_TOOLS, toolByName } from '../src/main/mcp/tool-catalog'
import { SCOPED_VERBS } from '../src/main/mcp/scope'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILLS = path.join(REPO_ROOT, 'resources', 'skills', 'skills')
const readSkill = (name: string): string =>
  readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8')

/** The operator asked for less information in a small space: both skills were far longer before S-30. */
const VERIFIER_LINE_CAP = 300
const WATCHDOG_LINE_CAP = 110

/** Collapse Prettier's line wrapping so a sentence matches whatever its breaks. */
const flat = (s: string): string => s.replace(/\s+/g, ' ')

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

/** The sentences of a text, once its line wrapping is collapsed. */
const sentences = (text: string): string[] => flat(text).split(/(?<=[.!?])\s+/)

const VERB_SHAPED =
  /(?<![A-Za-z0-9])(?:(?:mission|campaign)_[a-z]+(?:_[a-z]+)*|rebase_stack(?:_[a-z]+)*|plan_mission(?:_[a-z]+)*)(?![A-Za-z0-9])/g

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

/** What the v3 delivery taught, by the names the spec's fate table lists. Never the plain word "chapter". */
const V3_NAMES = [
  /campaign_[a-z]+/,
  /campaignId|chapterId/,
  /declaredEnd|declared end|fixed end/i,
  /Delivered and verified/,
  /decision node/i,
  /derived\.|youItems|closeReadiness/,
  /\bledger\b/i,
  /needs-human/,
  /"verification"/,
  /legacy|goal file/i
]

function commonProblems(skill: string, name: string): string[] {
  const out: string[] = []
  const parsed = parseSkillFrontmatter(skill, name)
  if (parsed?.name !== name) out.push(`the name is not ${name}`)
  if (!parsed || /[.!?]\s+[A-Z"]/.test(parsed.description))
    out.push('the description is not one sentence')
  const registered = new Set(MCP_TOOLS.map((t) => t.name))
  const named = new Set(skill.match(VERB_SHAPED) ?? [])
  for (const verb of named) if (!registered.has(verb)) out.push(`${verb} is not registered`)
  for (const verb of RETIRED_VERBS) if (named.has(verb)) out.push(`${verb} is named`)
  for (const re of V3_NAMES) if (re.test(skill)) out.push(`names a retired v3 thing: ${re}`)
  if (/steward/i.test(skill)) out.push('names a steward: there is none')
  return out
}

function verifierProblems(skill: string): string[] {
  const out = commonProblems(skill, 'delivery-verifier')
  const all = flat(skill)
  const named = new Set(skill.match(VERB_SHAPED) ?? [])

  // The verbs: the scoped verifier's own, all named, and the payload is the real shape.
  for (const verb of SCOPED_VERBS.verifier)
    if (!named.has(verb)) out.push(`the verifier verb ${verb} is not named`)
  if (
    !/you hold a scoped credential with `mission_get`, `mission_link`, `mission_log`, `mission_set_blocker` and `mission_settle_ac`/.test(
      all
    )
  )
    out.push('the scoped credential does not list the verifier verbs')
  if (!/Never pass a `sessionId`: the credential's id is used/.test(all))
    out.push('a scoped verifier may pass a session id')
  if (!/A subagent passes the leader's, from its prompt, never its own `agent-<…>` id/.test(all))
    out.push('a subagent verifier has no session id to pass')
  if (!/`mission_attach` asks to join, never to lead/.test(all))
    out.push('NOT_ATTACHED has no way out')
  out.push(
    ...verbSchemaProblems(
      'mission_settle_ac',
      jsonFences(skill).find((p) => 'criterionId' in p)
    )
  )

  // Settling: one at a time, only by: session, never the builder, never a sign-off, never a step verdict.
  if (!/Settle one criterion per call/.test(all)) out.push('criteria are not settled one per call')
  if (!/Only a criterion with `by: session` is yours to settle/.test(all))
    out.push('a verifier may settle a criterion that is not by: session')
  if (
    !/A `fact` settles itself/.test(all) ||
    !/ticked by the operator in the Mission pane/.test(all)
  )
    out.push('who settles the other criteria is not said')
  if (!/a second session or another person, never the one who built the step/.test(all))
    out.push('the verifier is not a second session or another person')
  if (!/a self-check never settles it/.test(all)) out.push('a builder may settle its own step')
  if (!/A sign-off is an operator or person criterion, never your verdict/.test(all))
    out.push('a sign-off is not an operator or person criterion')
  if (!/`mission_add_ac`/.test(all)) out.push('the leader is not told to add the sign-off')
  if (!/\*\*Unmet\*\*[^*]*Settle nothing: `mission_log` one line, `unmet <criterionId>:/.test(all))
    out.push('an unmet criterion is not logged and left open')
  if (!/\*\*Blocked\*\*[^*]*`mission_set_blocker` on the step/.test(all))
    out.push('a blocked criterion is not a blocker on the step')
  if (!/The first settlement stands \(`ALREADY_SETTLED`\)/.test(all))
    out.push('ALREADY_SETTLED is not read')
  if (!/A visual criterion with no capture is never settled/.test(all))
    out.push('a visual criterion may settle with no capture')
  if (!/A criterion that comes back unmet twice is the operator's decision/.test(all))
    out.push('unmet twice is not the operator')
  if (!/Never settle a criterion that is not `by: session`/.test(all))
    out.push('the boundaries allow settling any criterion')
  if (!/Write nothing else on the step, and never a verdict of your own for it/.test(all))
    out.push('a verdict of its own on the step is not refused')

  // Evidence: the exact folder, the verifier's own subfolder, a README, free port, a planted fault.
  if (!all.includes('**exact folder** `.harnu/evidence/<missionId>/<stepId>`'))
    out.push('the evidence folder is not the exact one')
  if (evidenceBundleDir('<missionId>', '<stepId>') !== '.harnu/evidence/<missionId>/<stepId>')
    out.push('the evidence path the skill teaches is not the one the code names')
  if (!all.includes('`.harnu/evidence/<missionId>/<stepId>/verify/`'))
    out.push('the verifier keeps its evidence outside verify/')
  if (!/the builder's files in the step folder stay the builder's/.test(all))
    out.push("the builder's evidence files may be edited")
  if (!/\*\*every evidence folder a `README\.md`\*\*/.test(all))
    out.push('an evidence folder may have no README')
  if (!/Never commit any of it/.test(all)) out.push('evidence may be committed')
  if (!/\*\*Pick a free port before you open one\*\*/.test(all) || !/listen on port 0/.test(all))
    out.push('a verifier may open a port it did not see free')
  if (!/Plant a fault against the code the proof replaces/.test(all))
    out.push('the verifier is not asked to plant a fault')
  if (!/clean worktree/.test(all) || !/headRefOid/.test(all))
    out.push('the checks are not re-run at the PR head in a clean worktree')
  if (!/Link the folder before you settle/.test(all) || !/kind: 'worktree'/.test(all))
    out.push('the evidence folder is not linked on the step')

  // The rubrics, the report, what the code parses, and the contract it loads.
  for (const kind of ['code', 'UI', 'research', 'decision'])
    if (!skill.includes(`\n### Rubric — ${kind}\n`)) out.push(`no rubric for ${kind}`)
  if (!/Detect your browser tools before grading/.test(all)) out.push('no browser-tools detection')
  if (!/## Step 5 — The Delivery Report/.test(skill) || !/## 👀 Check by hand/.test(skill))
    out.push('the Delivery Report is missing')
  if (!/`status` skill's six-line glance card/.test(all)) out.push('the report has no status card')
  if (!all.includes('Report for session <owner uuid> · mission <missionId> · step <stepId>'))
    out.push('the child report header is missing')
  if (!/Load `\.\.\/mission\/references\/writing-contract\.md`/.test(all))
    out.push('the writing contract is not loaded')
  if (!existsSync(path.join(SKILLS, 'mission', 'references', 'writing-contract.md')))
    out.push('the writing contract reference does not exist')
  if (!/Done is a property of the environment, not of the transcript/.test(all))
    out.push('the blind rule is missing')

  if (skill.split('\n').length > VERIFIER_LINE_CAP) out.push('the verifier is too long')
  return out
}

function watchdogProblems(skill: string): string[] {
  const out = commonProblems(skill, 'delivery-watchdog')
  const all = flat(skill)
  const named = new Set(skill.match(VERB_SHAPED) ?? [])

  // No steward half: no mode, no write, no dispatch, no nudge, no rebase.
  for (const verb of named)
    if (verb !== 'mission_list' && verb !== 'mission_get')
      out.push(`names a mission verb it cannot call: ${verb}`)
  for (const re of [
    /create_session/,
    /message_session/,
    /rebase_stack/,
    /role: 'verifier'/,
    /Two modes/i,
    /tick of a mission/i
  ])
    if (re.test(skill)) out.push(`still has a steward half: ${re}`)
  if (!/You cannot dispatch, nudge a session, write to a mission or move a card/.test(all))
    out.push('the sweep does not say what it cannot do')
  if (!/`mission_list`, `mission_get`, `get_session`, `get_fleet`, `list_worktrees`/.test(all))
    out.push('the reads it can reach are not listed')
  if (!/no `git` and no `gh`/.test(all)) out.push('the sweep may be told to run a shell command')
  if (
    !all.includes('`mission_list({ folder })`') ||
    !all.includes('`mission_get({ folder, missionId })`')
  )
    out.push('the two mission reads are not named in their shape')

  // The S-25 finding: a read it could not make is never reported as quiet.
  if (!/\*\*Could not read is not quiet\.\*\*/.test(all)) out.push('no could-not-read rule')
  if (!/write `could not read: <the verb and its refusal>` in the run result and stop/.test(all))
    out.push('a missing verb is not reported as could not read')
  if (!/A tick can start before Harnu's verbs are connected/.test(all))
    out.push('the first-boot case is not said')
  for (const s of sentences(skill))
    if (
      /nothing in flight|nothing stuck/i.test(s) &&
      !/never|nothing in flight", notify nothing/i.test(s)
    )
      out.push(`says quiet without a read: ${s.slice(0, 60)}`)
  if (!/No open mission, and the list itself read/.test(all))
    out.push('"nothing in flight" is not tied to a list that was read')

  // v4 reads, the findings, the keys and the one notification.
  for (const field of [
    'progress.headline',
    'waiting',
    '`sessions`',
    '`lastTransitionAt`',
    '`raisedAt`'
  ])
    if (!all.includes(field)) out.push(`does not read ${field}`)
  for (const finding of [
    '**A. Stalled.**',
    '**B. Pushed, clean, no PR.**',
    '**C. The operator is the blocker.**'
  ])
    if (!all.includes(finding)) out.push(`missing finding ${finding}`)
  if (!/`main-failing`/.test(all)) out.push('a red main is not a finding')
  if (!/hibernated[^.]*not stalled/.test(all)) out.push('a parked session reads as stalled')
  for (const key of [':stalled@', ':no-pr@', ':blocked@', ':main-failing@'])
    if (!all.includes(key)) out.push(`no dedup key ${key}`)
  if (!/`seen: <key>, <key>, …`/.test(all) || !/`Last run: …`/.test(all))
    out.push('the seen line and Last run are missing')
  if (!/At most \*\*one\*\* `notify` per tick/.test(all))
    out.push('more than one notification per tick')
  if (!/Never re-notify a finding whose key is unchanged/.test(all))
    out.push('a finding may repeat')
  if (!/older mission <title>/.test(all)) out.push('an older mission is not named')

  if (skill.split('\n').length > WATCHDOG_LINE_CAP) out.push('the watchdog is too long')
  return out
}

interface Mutation {
  find: string
  replace: string
  /** A fragment of the problem this text must report. */
  reports: string
}

/** Replace the first match of `find`, whatever its case and the line wrapping its spaces fall on. */
function mutate(text: string, m: Mutation): string {
  const re = new RegExp(m.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'), 'i')
  if (!re.test(text)) throw new Error(`mutation anchor not found: ${m.find} (${m.reports})`)
  return text.replace(re, () => m.replace)
}

describe('the verifier settles criteria one by one, and the watchdog has no steward half', () => {
  it('the verifier settles criteria one by one on the step through mission_settle_ac', () => {
    expect(verifierProblems(readSkill('delivery-verifier'))).toEqual([])
  })

  it('the watchdog is the read-only sweep and has no steward half', () => {
    expect(watchdogProblems(readSkill('delivery-watchdog'))).toEqual([])
  })

  it('both skills are as small as the operator asked', () => {
    expect(readSkill('delivery-verifier').split('\n').length).toBeLessThanOrEqual(VERIFIER_LINE_CAP)
    expect(readSkill('delivery-watchdog').split('\n').length).toBeLessThanOrEqual(WATCHDOG_LINE_CAP)
  })

  it('every verifier pin fails on a text that says the opposite', () => {
    const skill = readSkill('delivery-verifier')
    const mutations: Mutation[] = [
      {
        find: 'Only a criterion with `by: session` is yours to settle',
        replace: 'Every criterion of the step is yours to settle',
        reports: 'may settle a criterion that is not by: session'
      },
      {
        find: 'a second session or another person, never the one who built the step',
        replace: 'the session that built the step',
        reports: 'not a second session or another person'
      },
      {
        find: 'a self-check never settles it',
        replace: 'a self-check settles it',
        reports: 'may settle its own step'
      },
      {
        find: 'A sign-off is an operator or person criterion, never your verdict',
        replace: 'A sign-off is your verdict: record it as needs-human',
        reports: 'sign-off'
      },
      {
        find: 'Settle nothing: `mission_log` one line',
        replace: 'Settle it anyway: `mission_log` one line',
        reports: 'unmet criterion is not logged'
      },
      {
        find: 'A visual criterion with no capture is never settled',
        replace: 'A visual criterion with no capture is settled from the code',
        reports: 'settle with no capture'
      },
      {
        find: 'Write nothing else on the step, and never a verdict of your own for it',
        replace: 'Record a verdict for the step with mission_verify_step',
        reports: 'verdict of its own'
      },
      {
        find: 'the **exact folder** `.harnu/evidence/<missionId>/<stepId>`',
        replace: 'a folder of your choice',
        reports: 'not the exact one'
      },
      {
        find: "the builder's files in the step folder stay the builder's",
        replace: "the builder's files in the step folder are yours to tidy",
        reports: 'builder'
      },
      {
        find: '**every evidence folder a `README.md`**',
        replace: 'a README only when you have time',
        reports: 'no README'
      },
      {
        find: '**Pick a free port before you open one**',
        replace: 'Reuse the debug port you know',
        reports: 'port it did not see free'
      },
      {
        find: 'Plant a fault against the code the proof replaces',
        replace: 'Trust a green proof',
        reports: 'plant a fault'
      },
      {
        find: 'Link the folder before you settle',
        replace: 'Do not link the folder',
        reports: 'not linked on the step'
      },
      {
        find: "Never pass a `sessionId`: the credential's id is used",
        replace: 'Pass a `sessionId` of your choice: it is used',
        reports: 'may pass a session id'
      },
      {
        find: 'Load `../mission/references/writing-contract.md`',
        replace: 'Write as you like',
        reports: 'writing contract is not loaded'
      },
      {
        find: '`mission_attach` asks to join, never to lead',
        replace: '`mission_transfer_owner` asks to lead',
        reports: 'mission_transfer_owner is named'
      },
      {
        find: 'The record is the settle call itself',
        replace: 'The record is the step verdict, `mission_verify_step`, with needs-human',
        reports: 'names a retired v3 thing'
      },
      {
        find: 'Keep every output short.',
        replace: 'A steward reads every output.',
        reports: 'names a steward'
      }
    ]
    for (const m of mutations) {
      const problems = verifierProblems(mutate(skill, m)).join('\n')
      expect(problems, `a verifier text that says "${m.replace}"`).toContain(m.reports)
    }
  })

  it('every watchdog pin fails on a text that says the opposite', () => {
    const skill = readSkill('delivery-watchdog')
    const mutations: Mutation[] = [
      {
        find: 'You cannot dispatch, nudge a session, write to a mission or move a card',
        replace: 'The steward dispatches, nudges a session and rebases a stack',
        reports: 'names a steward'
      },
      {
        find: 'write `could not read: <the verb and its refusal>` in the run result and stop',
        replace: 'write "nothing in flight" in the run result and stop',
        reports: 'could not read'
      },
      {
        find: 'Never write "nothing in flight" or "nothing stuck" for a read you could not make',
        replace: 'Write "nothing in flight" or "nothing stuck" when a read failed',
        reports: 'says quiet without a read'
      },
      {
        find: 'No open mission, and the list itself read: write "nothing in flight", notify nothing.',
        replace: 'No open mission: write "nothing in flight", notify nothing.',
        reports: 'not tied to a list that was read'
      },
      {
        find: 'At most **one** `notify` per tick',
        replace: 'One `notify` per finding',
        reports: 'more than one notification'
      },
      {
        find: 'Never re-notify a finding whose key is unchanged',
        replace: 'Re-notify every finding each tick',
        reports: 'a finding may repeat'
      },
      {
        find: 'none `hibernated` (a parked session is not stalled)',
        replace: 'none `working`',
        reports: 'parked session reads as stalled'
      },
      {
        find: "A tick can start before Harnu's verbs are connected",
        replace: 'A tick always has its verbs',
        reports: 'first-boot case'
      },
      {
        find: 'no `git` and no `gh`',
        replace: 'a `git log` and a `gh pr view` when you need them',
        reports: 'shell command'
      },
      {
        find: '`mission_list({ folder })` returns one row',
        replace: '`mission_list({ folder })` then `mission_log` writes one row',
        reports: 'names a mission verb it cannot call: mission_log'
      }
    ]
    for (const m of mutations) {
      const problems = watchdogProblems(mutate(skill, m)).join('\n')
      expect(problems, `a watchdog text that says "${m.replace}"`).toContain(m.reports)
    }
  })
})
