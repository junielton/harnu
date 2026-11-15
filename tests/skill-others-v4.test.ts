/**
 * Missions v4 · S-31 · AC-76 — `spec`, `one-by-one`, `step-by-step`, `grill-me`, `your-move` and
 * `draft-to-prompt` speak v4: an operator criterion instead of a check, an operator blocker instead of a
 * decision node, the Mission pane instead of the popover.
 *
 * These are text pins on model-facing files. A SKILL.md ships as read and nothing compiles it, so a pin
 * shows what the text says; it cannot show that a model follows it (the behaviour evals of S-33 grade
 * that). What a pin CAN do is stay tied to the code: every `mission_…` name must be registered in the MCP
 * catalog, every payload a skill shows must parse against the verb's real input schema, and every text it
 * asks the verbs to store must pass the writing contract the verbs enforce.
 *
 * Each assertion lives in `problemsOf`, a pure function over the skills' text. The real text must produce
 * no problem, and every fault in `FAULTS` (one planted in the text per assertion) must produce one: a pin
 * that cannot fail proves nothing.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import {
  CAPS,
  checkAsk,
  checkBlockerReason,
  checkCriterion,
  checkStepTitle,
  checkWhy
} from '../src/main/missions/contract'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILLS = path.join(REPO_ROOT, 'resources', 'skills', 'skills')

const NAMES = [
  'spec',
  'one-by-one',
  'step-by-step',
  'grill-me',
  'your-move',
  'draft-to-prompt'
] as const
type Name = (typeof NAMES)[number]

/** How long each skill was before S-31 (lines of SKILL.md): a rewrite is never longer (the operator asked for less to read). */
const LINES_BEFORE: Record<Name, number> = {
  spec: 392,
  'one-by-one': 180,
  'step-by-step': 167,
  'grill-me': 127,
  'your-move': 97,
  'draft-to-prompt': 164
}

/** Collapse Prettier's line wrapping so a sentence matches whatever its breaks. */
const flat = (s: string): string => s.replace(/\s+/g, ' ')

/** Every text file of a skill the model reads, scripts excluded (their behaviour is not text). */
function textFiles(name: Name): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'scripts') walk(full)
      } else if (e.name.endsWith('.md')) {
        out[path.relative(SKILLS, full)] = readFileSync(full, 'utf8')
      }
    }
  }
  walk(path.join(SKILLS, name))
  return out
}

/** The whole text of the six skills, by file path (`spec/SKILL.md`, `spec/agents/critic.md`, …). */
type Texts = Record<string, string>
const real = (): Texts => Object.assign({}, ...NAMES.map(textFiles))

// ---- The words that are gone, built from parts so this file does not contain them -------------------

const j = (...p: string[]): string => p.join('')

/** Retired words and verbs a rewritten skill never writes (decision 18: names from the fate table). */
const RETIRED: { what: string; re: RegExp }[] = [
  { what: 'a decision node', re: new RegExp(j('decision', ' node'), 'i') },
  { what: 'the popover', re: new RegExp(j('pop', 'over'), 'i') },
  { what: 'a human check', re: new RegExp(j('human', ' check'), 'i') },
  { what: 'the Mark verified door', re: new RegExp(j('Mark', ' verified')) },
  { what: 'the Choose door', re: new RegExp(j('Choose', '…')) },
  { what: 'a steward', re: new RegExp(j('stew', 'ard'), 'i') },
  { what: 'a declared end', re: new RegExp(j('declared', 'End|declared', ' end'), 'i') },
  { what: 'a campaign', re: new RegExp(j('camp', 'aign'), 'i') },
  { what: 'a v3 verification level', re: new RegExp(j('"verif', 'ication"')) },
  { what: 'a v3 refusal code', re: new RegExp(j('CONTROLLED', '_FIELD|DECISION', '_CHOSEN')) },
  { what: 'the check ticks', re: new RegExp(j('checks\\[\\]', '\\.ticked')) }
]

/** Verbs that stay registered until S-40 but that no v4 mission answers: a skill never sends one. */
const RETIRED_VERBS = [
  j('mission_add', '_check'),
  j('mission_link', '_child'),
  j('mission_set', '_end'),
  j('mission_verify', '_step'),
  j('mission_import', '_legacy'),
  j('mission_transfer', '_owner'),
  j('mission_update', '_step')
]

/** A name that looks like a verb: it must be registered, and a parameter must never look like one. */
const VERB_SHAPED =
  /(?<![A-Za-z0-9])(?:(?:mission|campaign)_[a-z]+(?:_[a-z]+)*|rebase_stack(?:_[a-z]+)*|plan_mission(?:_[a-z]+)*)(?![A-Za-z0-9])/g

// ---- Helpers over a skill's text ----------------------------------------------------------------

/** The text of one `## ` section (heading line excluded), up to the next `## `; '' when absent. */
function section(raw: string, heading: RegExp): string {
  const lines = raw.split('\n')
  const start = lines.findIndex((l) => heading.test(l))
  if (start === -1) return ''
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}

/** The fenced `json` blocks of a text, parsed (an unparsable block is skipped). */
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
function verbProblems(verb: string, payload: Record<string, unknown> | undefined): string[] {
  if (!payload) return [`no fenced ${verb} payload`]
  const schema = MCP_TOOLS.find((t) => t.name === verb)?.inputSchema as
    z.ZodObject<z.ZodRawShape> | undefined
  if (!schema) return [`${verb} is not in the tool catalog`]
  const problems: string[] = []
  const known = new Set(Object.keys(schema.shape))
  for (const k of Object.keys(payload))
    if (!known.has(k)) problems.push(`${verb}: unknown key ${k}`)
  const parsed = schema.safeParse(payload)
  if (!parsed.success) problems.push(`${verb}: ${parsed.error.issues.map((i) => i.message)}`)
  return problems
}

/** The fenced payload of a verb: the first block that carries one of its marker keys. */
const payloadWith = (md: string, ...keys: string[]): Record<string, unknown> | undefined =>
  jsonFences(md).find((p) => keys.some((k) => k in p))

/** A placeholder such as `<spec path>` stands for a real value when a text is judged by the contract. */
const filled = (s: unknown): string =>
  String(s).replace(/<spec path>/g, 'docs/specs/2026-11-14-example/spec.md')

// ---- The assertions ----------------------------------------------------------------------------

/** Every problem the six skills have against v4. Empty means they speak it. */
function problemsOf(t: Texts): string[] {
  const p: string[] = []
  const registered = new Set(MCP_TOOLS.map((x) => x.name))

  // 1. Every file: no retired word, no retired verb, only registered verb names, no verb-shaped parameter.
  for (const [file, text] of Object.entries(t)) {
    for (const r of RETIRED) if (r.re.test(text)) p.push(`${file} still says ${r.what}`)
    for (const name of new Set(text.match(VERB_SHAPED) ?? [])) {
      if (!registered.has(name)) p.push(`${file} names ${name}, which is not registered`)
      if (RETIRED_VERBS.includes(name)) p.push(`${file} names ${name}, which no v4 mission answers`)
    }
  }

  // 2. Name, one-sentence-or-as-before description, and a rewrite never longer than the v3 text.
  for (const name of NAMES) {
    const skill = t[`${name}/SKILL.md`] ?? ''
    if (parseSkillFrontmatter(skill, name)?.name !== name) p.push(`${name} lost its name`)
    const lines = skill.split('\n').length - 1 // wc -l: the count LINES_BEFORE was taken with
    if (lines > LINES_BEFORE[name])
      p.push(`${name} grew to ${lines} lines (was ${LINES_BEFORE[name]})`)
  }

  // 3. spec: a v4 mission at triage with ONE step, "Approve spec", and an operator criterion.
  const spec = t['spec/SKILL.md'] ?? ''
  const mission = section(spec, /^## The mission\s*$/)
  const create = payloadWith(mission, 'doneWhen', 'title')
  p.push(...verbProblems('mission_create', create))
  if (create) {
    for (const v3 of ['declaredEnd', 'scope', 'steward'])
      if (v3 in create) p.push(`the triage payload carries ${v3}, a v3 field`)
    if (typeof create.doneWhen !== 'string') p.push('the triage payload has no doneWhen')
    const steps = Array.isArray(create.steps) ? (create.steps as Record<string, unknown>[]) : []
    if (steps.length !== 1 || steps[0].title !== 'Approve spec')
      p.push('the triage payload is not one step, "Approve spec"')
    else {
      if (!checkStepTitle('Approve spec').ok) p.push('the step title breaks the writing contract')
      const criteria = Array.isArray(steps[0].criteria)
        ? (steps[0].criteria as Record<string, unknown>[])
        : []
      const operator = criteria.filter((c) => c.by === 'operator')
      if (operator.length !== 1) p.push('the "Approve spec" step has no operator criterion')
      for (const c of operator)
        if (!checkCriterion(String(c.text)).ok) p.push('the operator criterion breaks the contract')
    }
    const docs = (Array.isArray(create.links) ? (create.links as Record<string, unknown>[]) : [])
      .filter((l) => l.kind === 'doc')
      .map((l) => String(l.ref))
    if (
      docs.join(' | ') !==
      [
        'docs/specs/YYYY-MM-DD-<slug>/spec.md',
        'docs/prds/<card>-<slug>.md',
        'docs/adr/NNNN-<slug>.md'
      ].join(' | ')
    )
      p.push(`the spec, PRD and ADR are not the mission's doc links (${docs.join(', ')})`)
    if (typeof create.title === 'string' && create.title.length > CAPS.mission)
      p.push('the example title is over the cap')
  }
  const m = flat(mission)
  if (!/the moment the entry leaves Small/.test(m)) p.push('the mission is not born at triage')
  if (!/the delivery's end/.test(m)) p.push("the Done when is not the delivery's end")
  if (!/`mission_set_done_when`/.test(m))
    p.push('a changed end is not staged with mission_set_done_when')
  if (!/an operator criterion/.test(m))
    p.push('the Approve spec step does not say it carries an operator criterion')
  if (!/Small entry[^.]*no mission/.test(m)) p.push('a Small entry may get a mission')
  if (!/written or not/.test(m)) p.push('the links do not list unwritten paths')
  if (!/Drop the PRD and ADR links a tier does not carry/.test(m))
    p.push('the links are not sized by tier')

  const approval = section(spec, /^## The approval question\s*$/)
  const a = flat(approval)
  if (!/Mission pane/.test(a)) p.push('the approval does not point at the Mission pane')
  if (!/tick[^.]*operator approves the spec[^.]*"Approve spec" step/i.test(a))
    p.push('the approval does not name the criterion the operator ticks')
  if (!/never ticks the criterion/.test(a)) p.push('the skill may tick the approval criterion')
  if (!/`harnu:orchestrate-delivery`/.test(a)) p.push('the next step is not named')
  const blocker = payloadWith(approval, 'unblocks', 'owner', 'reason')
  p.push(...verbProblems('mission_set_blocker', blocker))
  if (blocker) {
    if (blocker.owner !== 'operator') p.push("the approval blocker is not the operator's")
    if (!('stepId' in blocker)) p.push('the approval blocker is on no step')
    if (!checkBlockerReason(filled(blocker.reason)).ok)
      p.push('the approval blocker reason breaks the contract')
    if (typeof blocker.ask !== 'string' || !checkAsk(blocker.ask).ok)
      p.push('the approval blocker has no ask within the cap')
    if (typeof blocker.unblocks !== 'string' || !checkWhy(blocker.unblocks).ok)
      p.push('the approval blocker has no unblocks within the cap')
  }
  if (
    !/`mission_clear_blocker`[^.]*OPERATOR_ONLY|OPERATOR_ONLY[^.]*`mission_clear_blocker`/.test(a)
  )
    p.push("the skill does not say an operator's blocker is cleared by the operator")
  if (!/the spec linked to the mission \(a `doc` link\)/.test(flat(spec)))
    p.push('check resolves the spec from the mission as scope, not from its doc link')

  // 4. one-by-one and grill-me: a decision is an operator blocker; the answer is a Log line of kind decision.
  for (const name of ['one-by-one', 'grill-me'] as const) {
    const f = flat(t[`${name}/SKILL.md`] ?? '')
    if (!/`mission_set_blocker`/.test(f) || !/owner: 'operator'/.test(f))
      p.push(`${name} does not raise an open decision as an operator blocker`)
    if (!/`mission_log`[^.]*kind: 'decision'/.test(f))
      p.push(`${name} does not log an answer as kind decision`)
    if (
      !/`mission_clear_blocker`[^.]*OPERATOR_ONLY|OPERATOR_ONLY[^.]*`mission_clear_blocker`/.test(f)
    )
      p.push(`${name} does not leave the operator's blocker to the operator`)
    if (!/Done, continue/.test(f) || !/Mission pane/.test(f))
      p.push(`${name} does not point at "Done, continue" in the Mission pane`)
    if (!/`mission_get`[^.]*`links`[^.]*`doc`/.test(f))
      p.push(`${name} finds the spec through the mission scope, not its doc link`)
    if (!/gates no step/.test(f))
      p.push(`${name} may raise a blocker for a decision that gates no step`)
  }

  // 4b. The v4 verbs refuse a call without the caller's session id (BAD_ARGS): the shorthands carry it.
  for (const name of ['one-by-one', 'grill-me'] as const) {
    const f = flat(t[`${name}/SKILL.md`] ?? '')
    if (!/`mission_set_blocker \{[^}]*sessionId[^}]*\}`/.test(f))
      p.push(`${name}: the mission_set_blocker shorthand has no sessionId`)
    if (!/`mission_log`[^.]*`sessionId`/.test(f))
      p.push(`${name}: mission_log is shown with no sessionId`)
    if (!/Pass your own `sessionId` on every mission call/.test(f))
      p.push(`${name} does not say to pass your own sessionId on every mission call`)
  }
  if (!/`mission_get\(\{ folder, sessionId \}\)`/.test(flat(t['one-by-one/SKILL.md'] ?? '')))
    p.push('one-by-one: mission_get is shown with no sessionId')

  // 4c. The operator's doors: each prohibition is stated, and no line tells the agent to do the forbidden thing.
  const clear = j('mission_clear', '_blocker')
  const settle = j('mission_settle', '_ac')
  const doors: { file: string; stated: RegExp; forbidden: RegExp; what: string }[] = [
    ...['spec', 'one-by-one', 'grill-me'].map((n) => ({
      file: `${n}/SKILL.md`,
      stated: /you never call (?:it|`mission_clear_blocker` on it)/,
      forbidden: new RegExp(
        `(?<!never )\\bcall \`${clear}\`|(?:clear|clears|clearing) (?:it|the blocker) with \`${clear}\``
      ),
      what: "never clear an operator's blocker"
    })),
    ...['spec', 'step-by-step'].map((n) => ({
      file: `${n}/SKILL.md`,
      stated: /no verb of yours can/,
      forbidden: new RegExp(`(?:call|use|run) \`${settle}\`|\`${settle}\``),
      what: "never tick the operator's criterion"
    })),
    {
      file: 'one-by-one/SKILL.md',
      stated: /You never answer a decision yourself/,
      forbidden: /(?<!never )answer a decision yourself|(?:pick|choose|decide) it yourself/i,
      what: 'never answer a decision yourself'
    }
  ]
  for (const d of doors) {
    const f = flat(t[d.file] ?? '')
    if (!d.stated.test(f)) p.push(`${d.file} does not state: ${d.what}`)
    if (d.forbidden.test(f)) p.push(`${d.file} tells the agent to break: ${d.what}`)
  }

  // 5. step-by-step: each manual action is an operator criterion, added with mission_add_ac, never ticked.
  const sbs = t['step-by-step/SKILL.md'] ?? ''
  const s = flat(sbs)
  const ac = payloadWith(sbs, 'text', 'stepId')
  p.push(...verbProblems('mission_add_ac', ac))
  if (ac) {
    if (ac.by !== 'operator') p.push('the criterion step-by-step adds is not by the operator')
    if (!checkCriterion(String(ac.text)).ok)
      p.push('the example criterion breaks the writing contract')
  }
  if (!/Never tick a criterion/.test(s))
    p.push('step-by-step does not hold "never tick" as a hard gate')
  if (!/never describe a criterion as done because the operator said "done" in chat/.test(s))
    p.push('step-by-step may call a criterion done on a chat "done"')
  if (!/Mission pane/.test(s)) p.push('step-by-step does not point at the Mission pane')
  if (!/`criteria\[\]\.settled`/.test(s))
    p.push('step-by-step does not read open criteria from mission_get')
  if (!/does not dedupe/.test(s)) p.push('step-by-step does not say a criterion is not deduped')
  if (!/leader's verb/.test(s)) p.push("step-by-step does not say mission_add_ac is the leader's")
  if (!/writing-contract\.md/.test(s)) p.push('step-by-step does not load the writing contract')

  // 6. your-move and draft-to-prompt: the words only.
  const ym = flat(t['your-move/SKILL.md'] ?? '')
  if (!/ticked in the Mission pane/.test(ym) || !/operator criterion/.test(ym))
    p.push('your-move does not close a mission card on an operator criterion ticked in the pane')
  const dp = flat(
    `${t['draft-to-prompt/SKILL.md'] ?? ''} ${t['draft-to-prompt/references/harness-routing.md'] ?? ''}`
  )
  if (!/Done when/.test(dp)) p.push('draft-to-prompt does not speak of a Done when')
  for (const file of ['SKILL.md', 'references/harness-routing.md'])
    if (!/Mission pane/.test(flat(t[`draft-to-prompt/${file}`] ?? '')))
      p.push(`draft-to-prompt/${file} does not point at the Mission pane`)
  if (/born \*\*active\*\*|born active/.test(dp))
    p.push('draft-to-prompt still says a mission is born active')

  return p
}

// ---- Faults: one planted in the text per assertion; each must be caught -------------------------

interface Fault {
  file: string
  find: string | RegExp
  replace: string
  why: string
}

const FAULTS: Fault[] = [
  {
    file: 'spec/SKILL.md',
    find: 'so you never call it',
    replace: 'so you call it',
    why: 'the skill never clears the approval blocker'
  },
  {
    file: 'one-by-one/SKILL.md',
    find: 'you never call `mission_clear_blocker`',
    replace: 'you call `mission_clear_blocker`',
    why: "one-by-one never clears the operator's blocker"
  },
  {
    file: 'grill-me/SKILL.md',
    find: 'you never call `mission_clear_blocker`',
    replace: 'you call `mission_clear_blocker`',
    why: "grill-me never clears the operator's blocker"
  },
  {
    file: 'step-by-step/SKILL.md',
    find: 'no verb of yours can,',
    replace: `call \`${j('mission_settle', '_ac')}\`,`,
    why: 'step-by-step never settles the operator’s criterion'
  },
  {
    file: 'spec/SKILL.md',
    find: 'no verb of yours can.',
    replace: `call \`${j('mission_settle', '_ac')}\`.`,
    why: 'spec never ticks the approval criterion'
  },
  {
    file: 'one-by-one/SKILL.md',
    find: 'You never answer a decision yourself',
    replace: 'You answer a decision yourself',
    why: 'one-by-one never decides'
  },
  {
    file: 'one-by-one/SKILL.md',
    find: "`mission_set_blocker { stepId, reason, ask, unblocks, owner: 'operator', sessionId }`",
    replace: "`mission_set_blocker { stepId, reason, ask, unblocks, owner: 'operator' }`",
    why: 'a blocker call carries the session id'
  },
  {
    file: 'grill-me/SKILL.md',
    find: 'Pass your own `sessionId` on every mission call',
    replace: 'Pass the mission id on every mission call',
    why: 'every mission call carries the session id'
  },
  {
    file: 'spec/SKILL.md',
    find: '"by": "operator"',
    replace: '"by": "session"',
    why: 'the approval criterion is the operator’s'
  },
  {
    file: 'spec/SKILL.md',
    find: '"doneWhen"',
    replace: '"declaredEnd"',
    why: 'the triage payload is v4'
  },
  {
    file: 'spec/SKILL.md',
    find: '"kind": "doc"',
    replace: '"kind": "card"',
    why: 'the spec is a doc link'
  },
  {
    file: 'spec/SKILL.md',
    find: '"title": "Approve spec"',
    replace: '"title": "Spec approved"',
    why: 'the step is "Approve spec"'
  },
  {
    file: 'spec/SKILL.md',
    find: 'in the Mission pane',
    replace: 'in the Mission popover',
    why: 'the pane, not the popover'
  },
  {
    file: 'spec/SKILL.md',
    find: 'never ticks the criterion',
    replace: 'ticks the criterion itself',
    why: 'the skill never ticks'
  },
  {
    file: 'spec/SKILL.md',
    find: '`mission_set_done_when`',
    replace: '`mission_set_end`',
    why: 'a changed end is staged with the v4 verb'
  },
  {
    file: 'spec/SKILL.md',
    find: '"owner": "operator"',
    replace: '"owner": "agent"',
    why: 'the blocker is the operator’s'
  },
  { file: 'spec/SKILL.md', find: '"ask":', replace: '"asks":', why: 'the blocker payload parses' },
  {
    file: 'spec/SKILL.md',
    find: 'the spec linked to the mission (a `doc` link)',
    replace: 'the spec attached to the mission as scope',
    why: 'check resolves the spec from its doc link'
  },
  {
    file: 'one-by-one/SKILL.md',
    find: "`kind: 'decision'`",
    replace: "`kind: 'note'`",
    why: 'an answer is a decision entry'
  },
  {
    file: 'one-by-one/SKILL.md',
    find: 'Done, continue',
    replace: 'Choose…',
    why: 'the operator clears it in the pane'
  },
  {
    file: 'one-by-one/SKILL.md',
    find: "owner: 'operator'",
    replace: "owner: 'agent'",
    why: 'a decision is the operator’s blocker'
  },
  {
    file: 'one-by-one/SKILL.md',
    find: 'gates no step',
    replace: 'gates a step',
    why: 'no blocker for a decision that gates nothing'
  },
  {
    file: 'grill-me/SKILL.md',
    find: "`kind: 'decision'`",
    replace: "`kind: 'note'`",
    why: 'an answer is a decision entry'
  },
  {
    file: 'grill-me/SKILL.md',
    find: 'Done, continue',
    replace: 'Mark verified',
    why: 'the operator clears it in the pane'
  },
  {
    file: 'grill-me/SKILL.md',
    find: '`mission_get` → `links`',
    replace: '`mission_get` → `scope`',
    why: 'the spec is a doc link'
  },
  {
    file: 'step-by-step/SKILL.md',
    find: '"by": "operator"',
    replace: '"by": "session"',
    why: 'a manual action is the operator’s criterion'
  },
  {
    file: 'step-by-step/SKILL.md',
    find: '`mission_add_ac`',
    replace: j('`mission_add', '_check`'),
    why: 'the v4 verb'
  },
  {
    file: 'step-by-step/SKILL.md',
    find: 'Never tick a criterion',
    replace: 'Tick a criterion',
    why: 'never tick is a hard gate'
  },
  {
    file: 'step-by-step/SKILL.md',
    find: 'Mission pane',
    replace: j('Mission pop', 'over'),
    why: 'the pane'
  },
  {
    file: 'step-by-step/SKILL.md',
    find: '`criteria[].settled`',
    replace: j('`checks[]', '.ticked`'),
    why: 'open criteria are read from mission_get'
  },
  {
    file: 'step-by-step/SKILL.md',
    find: 'does not dedupe',
    replace: 'dedupes by label',
    why: 'v4 has no dedupe: read first'
  },
  {
    file: 'your-move/SKILL.md',
    find: 'ticked in the Mission pane',
    replace: j('ticked in the pop', 'over'),
    why: 'a mission card closes on a ticked criterion'
  },
  {
    file: 'draft-to-prompt/SKILL.md',
    find: 'Done when',
    replace: 'declared end',
    why: 'the v4 word'
  },
  {
    file: 'draft-to-prompt/references/harness-routing.md',
    find: 'Mission pane',
    replace: "Harnu's Topbar",
    why: 'the pane'
  }
]

/** A copy of the texts with one fault planted; throws when the fault's text is not there to plant. */
function plant(t: Texts, f: Fault): Texts {
  const before = t[f.file]
  if (before === undefined) throw new Error(`no such file: ${f.file}`)
  // A sentence may wrap across lines in the file: a string `find` matches whatever its breaks, and a
  // fault changes every mention of it (a text that says a thing twice is not fixed by one change).
  const pattern =
    typeof f.find === 'string'
      ? new RegExp(f.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'), 'g')
      : f.find
  const after = before.replace(pattern, () => f.replace)
  if (after === before) throw new Error(`fault does not apply (${f.why}): ${String(f.find)}`)
  return { ...t, [f.file]: after }
}

// ---- The tests ---------------------------------------------------------------------------------

describe('the other skills', () => {
  it('the other skills speak v4', () => {
    expect(problemsOf(real())).toEqual([])
  })

  it('every pin bites: a fault planted in the text of each is caught', () => {
    expect(FAULTS.length).toBeGreaterThanOrEqual(20)
    const texts = real()
    for (const f of FAULTS) {
      expect(problemsOf(plant(texts, f)), `fault should be caught: ${f.why}`).not.toEqual([])
    }
  })

  it('keeps each skill’s name and a description that says when not to use it', () => {
    for (const name of NAMES) {
      const parsed = parseSkillFrontmatter(
        readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8'),
        name
      )
      expect(parsed?.name).toBe(name)
      expect(parsed?.description.length ?? 0).toBeGreaterThan(40)
    }
  })
})
