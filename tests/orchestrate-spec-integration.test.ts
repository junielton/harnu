/**
 * T601 S-7 (card T671) — `orchestrate-delivery` consumes the spec-born mission (S-5) and the
 * derive planner (S-6).
 *
 * - AC-25: Phase 1 adopts the mission whose links name the spec (`mission_list`, then
 *   `mission_get`) instead of a second mission, asks to join with `mission_attach` when another session
 *   leads it, and adds one step per slice with `mission_add_step` (criteria, milestone and a reason).
 * - AC-26: Phase 2 runs the planner found as the sibling `../spec/scripts/spec-derive.mjs` of its
 *   own base directory (with `harnu:spec` off it keeps the Wave A hand derivation and says so),
 *   executes the plan with `create_card` / `update_card`, writes the `spec-slice: S-n` marker
 *   with each card, keeps the envelope its own, and hands the `card` rows to the wave's
 *   bookkeeping unit (D-3). Phase 2 names no `derive` verb.
 * - AC-27: each open D-n that gates a slice becomes an operator blocker (`mission_set_blocker`) on
 *   exactly the gated slices' steps, written to the writing contract; a D-n gating nothing gets none;
 *   the slices no open D-n gates are dispatched.
 *
 * Missions v4 S-29: the skill speaks v4, so the slice step is a titled step with criteria (an id such as
 * `S-2` at the edge of a title is refused by the writing contract) and the decision node is an operator
 * blocker (D-17). The planner, the marker and the card map are unchanged.
 *
 * A skill is prose, so what is graded is the contract its text states (sub-section headings,
 * fenced payloads parsed against the real verb schemas, fenced command lines) plus the data it
 * leans on (the real planner at the path the text names, run over the fixtures under
 * `tests/fixtures/spec-derive/`). Every check runs on the shipped text, where it must report
 * nothing, and on inline mutations of it, where it must report something — so a check that
 * stopped looking would fail here.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { expect, it } from 'vitest'
import type { z } from 'zod'

import { parseSpec } from '../resources/skills/skills/spec/scripts/spec-check-core.mjs'
import {
  applyBlock,
  findBlock,
  planDerive
} from '../resources/skills/skills/spec/scripts/spec-derive-core.mjs'
import { toolByName } from '../src/main/mcp/tool-catalog'
import { CAPS, checkBlockerReason, checkTitleEdge } from '../src/main/missions/contract'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILL_BASE = path.join(REPO_ROOT, 'resources', 'skills', 'skills', 'orchestrate-delivery')
const SKILL_FILE = path.join(SKILL_BASE, 'SKILL.md')
const FIX = path.join(REPO_ROOT, 'tests', 'fixtures', 'spec-derive')
const SPEC_REL = 'tests/fixtures/spec-derive/spec.md'
const GATED = path.join(FIX, 'gated.md')

const read = (p: string): string => readFileSync(p, 'utf8')
const flat = (s: string): string => s.replace(/\s+/g, ' ')

// ---- Text helpers -----------------------------------------------------------------------------

/** The lines of `md` from the heading matching `re` up to the next heading of the same or a higher level. */
function sectionOf(md: string, re: RegExp): string {
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
      if (h && re.test(line)) {
        start = i
        level = h[1].length
      }
    } else if (h && h[1].length <= level) {
      return lines.slice(start, i).join('\n')
    }
  }
  return start === -1 ? '' : lines.slice(start).join('\n')
}

const phase1Of = (skill: string): string => sectionOf(skill, /^## Phase 1 — Plan\s*$/)
const phase2Of = (skill: string): string => sectionOf(skill, /^## Phase 2 — Cards and dispatch\s*$/)
const adoptOf = (skill: string): string =>
  sectionOf(phase1Of(skill), /^### The spec-born mission\s*$/)
const plannerOf = (skill: string): string =>
  sectionOf(phase2Of(skill), /^### Cards from a spec — the derive planner\s*$/)
const decisionsOf = (skill: string): string =>
  sectionOf(phase2Of(skill), /^### Open decisions become operator blockers\s*$/)

/** The fenced blocks of a text: `{ lang, body }`, in order. */
function fences(md: string): { lang: string; body: string }[] {
  const out: { lang: string; body: string }[] = []
  let body: string[] | null = null
  let lang = ''
  for (const line of md.split('\n')) {
    const open = /^\s*```(\S*)/.exec(line)
    if (open) {
      if (body) {
        out.push({ lang, body: body.join('\n') })
        body = null
      } else {
        body = []
        lang = open[1]
      }
    } else if (body) body.push(line)
  }
  return out
}

/** The fenced `json` blocks of a text, parsed (unparsable blocks are skipped). */
function jsonFences(md: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const f of fences(md)) {
    if (f.lang !== 'json') continue
    try {
      const parsed: unknown = JSON.parse(f.body)
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>)
    } catch {
      // an unparsable block is no payload
    }
  }
  return out
}

/** A payload's problems against a verb's real input schema: unknown keys, or a failed parse. */
function verbSchemaProblems(verb: string, payload: Record<string, unknown> | undefined): string[] {
  if (!payload) return [`no fenced ${verb} payload`]
  const schema = toolByName(verb)?.inputSchema as z.ZodTypeAny | undefined
  if (!schema) return [`${verb} is not in the tool catalog`]
  const problems: string[] = []
  // A refined object is a ZodEffects: its shape is one level in.
  const def = (schema as unknown as { _def: { schema?: z.ZodObject<z.ZodRawShape> } })._def
  const object = (def.schema ?? schema) as z.ZodObject<z.ZodRawShape>
  const known = new Set(Object.keys(object.shape ?? {}))
  for (const k of Object.keys(payload))
    if (!known.has(k)) problems.push(`${verb}: unknown key ${k}`)
  const result = schema.safeParse(payload)
  if (!result.success) problems.push(`${verb}: ${result.error.issues.map((i) => i.message)}`)
  return problems
}

interface Mutation {
  find?: string
  pattern?: string
  replace: string
  why: string
}

/** Apply one mutation; throws when its anchor is gone, so a mutation cannot silently go stale. */
function mutate(text: string, m: Mutation): string {
  if (m.pattern != null) {
    const re = new RegExp(m.pattern)
    if (!re.test(text)) throw new Error(`mutation anchor /${m.pattern}/ not found (${m.why})`)
    return text.replace(re, m.replace)
  }
  if (!text.includes(m.find!)) throw new Error(`mutation anchor not found: ${m.find} (${m.why})`)
  return text.replace(m.find!, m.replace)
}

/** The shipped skill passes `check`; every mutation fails it. */
function expectCheck(check: (skill: string) => string[], mutations: Mutation[]): void {
  const skill = read(SKILL_FILE)
  expect(check(skill)).toEqual([])
  expect(mutations.length).toBeGreaterThan(0)
  for (const m of mutations) {
    expect(check(mutate(skill, m)), `mutation should fail: ${m.why}`).not.toEqual([])
  }
}

// ---- AC-25: Phase 1 adopts the spec-born mission ----------------------------------------------

function adoptProblems(skill: string): string[] {
  const sec = adoptOf(skill)
  if (!sec) return ['no "### The spec-born mission" section in Phase 1']
  const f = flat(sec)
  const problems: string[] = []
  const list = f.indexOf('`mission_list')
  const get = f.indexOf('`mission_get`')
  if (list === -1 || get === -1 || get < list)
    problems.push('the mission is not found with `mission_list` then `mission_get`')
  if (!/until one's `links` name the spec/.test(f))
    problems.push('the adopted mission is not the one whose links name the spec')
  if (!/never open a second/.test(f)) problems.push('Phase 1 may still open a second mission')
  if (!/`mission_add_step`/.test(f))
    problems.push('the slice steps are not added with mission_add_step')
  if (!/Add one step per slice/.test(f)) problems.push('not one step per slice')
  if (!/`stepId`/.test(f)) problems.push('the slice → step map (stepId) is not kept')
  if (!/`mission_attach`/.test(f) || !/the hand-off/.test(f))
    problems.push('another session leading it is not handled by attach and the hand-off')
  if (!/NOT_ATTACHED/.test(f)) problems.push('the refusal of an unattached session is not named')
  if (!/With no mission naming the spec/.test(f) || !/`mission_link \{/.test(f))
    problems.push('no fallback when no mission names the spec (create it and link the spec)')

  const payload = jsonFences(sec).find((p) => 'criteria' in p && 'milestone' in p)
  problems.push(...verbSchemaProblems('mission_add_step', payload))
  if (payload) {
    if (typeof payload.reason !== 'string' || payload.reason.length === 0)
      problems.push('the slice step carries no reason')
    if (typeof payload.title !== 'string' || /^S-/.test(payload.title))
      problems.push(
        'the slice step title starts with the slice id, which the writing contract refuses'
      )
    else if (!checkTitleEdge(payload.title).ok)
      problems.push('the slice step title breaks the id-at-the-edge rule')
    if (!Array.isArray(payload.criteria) || payload.criteria.length === 0)
      problems.push('the slice step carries no criterion')
  }
  // The step titles the skill asks for are short and carry no id at either edge.
  if (!/an id like `S-2` is refused at either edge of a title/.test(f))
    problems.push('the skill does not warn that a slice id cannot open a step title')
  return problems
}

it('phase 1 adopts the spec-born mission', () => {
  expectCheck(adoptProblems, [
    {
      pattern: '`mission_list([^`]*)`([^]*?)`mission_get`',
      replace: '`mission_get`$2`mission_list$1`',
      why: 'mission_list comes before mission_get'
    },
    {
      pattern: 'you adopt that one and never open a\\s+second',
      replace: 'you adopt that one and open a second',
      why: 'no second mission'
    },
    {
      pattern: '"reason": "[^"]*",?\\s*',
      replace: '',
      why: 'the slice step carries a reason'
    },
    {
      find: '"milestone": "<mls-… of the slice\'s stage>"',
      replace: '"milestone": 3',
      why: 'the payload must parse against mission_add_step'
    },
    {
      find: '"title": "<the slice\'s title as a verb phrase>"',
      replace: '"title": "S-n · <slice title>"',
      why: 'a title opening with the slice id is refused by the writing contract'
    },
    {
      find: 'ask to\n   join with `mission_attach`',
      replace: 'ask to\n   join with a transfer',
      why: 'another leader is handled by attach'
    }
  ])
})

// ---- AC-26: Phase 2 runs the planner and hands the card map to a unit -------------------------

const PLANNER_CMD_RE =
  /node\s+(<[^>]*base directory[^>]*>)\/\.\.\/spec\/scripts\/spec-derive\.mjs\s+\S+\s+--board\s+\S+/

function plannerProblems(skill: string): string[] {
  const sec = plannerOf(skill)
  if (!sec) return ['no "### Cards from a spec — the derive planner" section in Phase 2']
  const f = flat(sec)
  const problems: string[] = []

  const cmd = fences(sec).find((b) => PLANNER_CMD_RE.test(b.body))
  if (!cmd)
    problems.push(
      'no fenced `node <base directory>/../spec/scripts/spec-derive.mjs <spec> --board <file>`'
    )
  if (!/base directory/.test(f))
    problems.push('the planner is not found from the skill base directory')
  if (!existsSync(path.join(SKILL_BASE, '..', 'spec', 'scripts', 'spec-derive.mjs')))
    problems.push('the sibling ../spec/scripts/spec-derive.mjs does not exist')

  if (!/`harnu:spec` switched off/.test(f) || !/hand derivation/.test(f))
    problems.push('with harnu:spec off the hand derivation is not kept')
  if (!/the derive planner was unavailable/.test(f))
    problems.push('the fallback does not say the planner was unavailable')

  if (!/`\.harnu\/memory\/roadmap\/`/.test(f))
    problems.push('the board file is not built from the roadmap cards')
  if (!/`create_card`/.test(f) || !/`update_card`/.test(f))
    problems.push('the plan is not executed with create_card and update_card')
  if (!/`spec-slice: S-n`/.test(f) || !/every card/.test(f))
    problems.push('the `spec-slice: S-n` marker is not written with every card')
  if (!/envelope/.test(f) || !/the planner never touches/.test(f))
    problems.push('the envelope is not left to the orchestrator')
  if (!/`replaceBody`/.test(f) || !/no splice/.test(f) || !/between the markers/.test(f))
    problems.push('an update does not swap the marked span and send the whole body as replaceBody')
  if (!/`refuse`/.test(f) || !/back to the spec/.test(f))
    problems.push('a refused slice is not sent back to the spec')
  if (!/`skip`/.test(f)) problems.push('skip entries are not handled')
  if (!/`card` rows/.test(f) || !/bookkeeping unit/.test(f) || !/D-3/.test(f))
    problems.push('the card rows are not handed to the wave bookkeeping unit (D-3)')
  if (!/cannot edit the spec/.test(f))
    problems.push('the hand-off does not say why (a promoted orchestrator cannot edit the spec)')

  const create = jsonFences(sec).find((p) => 'body' in p && 'title' in p)
  problems.push(...verbSchemaProblems('create_card', create))
  if (create) {
    const body = String(create.body)
    if (!/^spec-slice: S-n\n/.test(body))
      problems.push('the create_card body does not open with the marker')
    if (!/<block>/.test(body)) problems.push('the create_card body does not carry the plan block')
    if (!('spec' in create)) problems.push('the created card does not name its spec')
  }
  const update = jsonFences(sec).find((p) => 'slug' in p && 'replaceBody' in p)
  problems.push(...verbSchemaProblems('update_card', update))

  // Phase 2 names no `derive` verb: the planner is a script, not a verb of any skill.
  const p2 = phase2Of(skill)
  if (/`(?:harnu:)?spec derive`|\/(?:harnu:)?spec derive\b|`derive`/.test(p2))
    problems.push('Phase 2 names a derive verb')
  return problems
}

it('phase 2 runs the planner and hands the card map to a unit', () => {
  expectCheck(plannerProblems, [
    {
      find: '/../spec/scripts/spec-derive.mjs',
      replace: '/scripts/spec-derive.mjs',
      why: 'the planner is the sibling ../spec/scripts/spec-derive.mjs'
    },
    {
      find: 'the derive planner was unavailable',
      replace: 'nothing',
      why: 'the fallback says the planner was unavailable'
    },
    {
      find: 'bookkeeping unit',
      replace: 'verifier',
      why: 'the card rows go to the bookkeeping unit'
    },
    {
      find: '"replaceBody":',
      replace: '"body":',
      why: 'the update payload must parse against update_card'
    },
    {
      find: '### Cards from a spec — the derive planner',
      replace: '### Cards from a spec — the derive planner\n\nRun `harnu:spec derive` first.',
      why: 'Phase 2 names no derive verb'
    },
    {
      find: 'the planner never touches',
      replace: 'the planner rewrites',
      why: "the envelope stays the orchestrator's"
    }
  ])

  // The planner the text names, run the way the text runs it: create, then a second pass is
  // empty; an AC change is an update that swaps only the marked span, then a third pass is empty.
  const cli = path.join(SKILL_BASE, '..', 'spec', 'scripts', 'spec-derive.mjs')
  const tmp = mkdtempSync(path.join(tmpdir(), 'orch-spec-'))
  try {
    const boardFile = path.join(tmp, 'board.json')
    writeFileSync(boardFile, '[]')
    const run = spawnSync(process.execPath, [cli, SPEC_REL, '--board', boardFile], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    })
    expect(run.status, run.stderr).toBe(0)
    const first = JSON.parse(run.stdout) as {
      create: { slice: string; title: string; block: string }[]
      update: unknown[]
    }
    expect(first.create.map((c) => c.slice)).toEqual(['S-1', 'S-2', 'S-3'])

    const skill = read(SKILL_FILE)
    const sec = plannerOf(skill)
    const template = jsonFences(sec).find((p) => 'body' in p && 'title' in p)!
    const envelope = '\n\n## Honest exit clause\n\nReport `AC-n: unmet` with the reason.\n'
    const board = first.create.map((c, i) => {
      const body = String(template.body)
        .replace('S-n', c.slice)
        .replace('<block>', c.block)
        .replace(/\n\n<envelope[^>]*>\s*$/, envelope)
      const payload = { ...template, title: c.title, body, spec: SPEC_REL, folder: REPO_ROOT }
      expect(verbSchemaProblems('create_card', payload)).toEqual([])
      return { slug: `card-${i + 1}`, status: 'backlog', title: c.title, body, spec: SPEC_REL }
    })
    const spec = read(path.join(FIX, 'spec.md'))
    expect(planDerive(spec, SPEC_REL, board)).toEqual({
      create: [],
      update: [],
      skip: [],
      refuse: []
    })

    const changed = spec.replace(
      'Exports stream rows as they are read — never the whole table.',
      'Exports stream rows as they are read, in pages — never the whole table.'
    )
    const second = planDerive(changed, SPEC_REL, board) as {
      update: { slug: string; slice: string; block: string }[]
    }
    expect(second.update.map((u) => u.slice)).toEqual(['S-1'])
    const u = second.update[0]
    const card = board.find((c) => c.slug === u.slug)!
    const next = applyBlock(card.body, u.slice, u.block)
    const before = findBlock(card.body, u.slice) as { start: number; end: number }
    expect(next.slice(0, before.start)).toBe(card.body.slice(0, before.start))
    expect(next.endsWith(card.body.slice(before.end))).toBe(true)
    const updateTemplate = jsonFences(sec).find((p) => 'slug' in p && 'replaceBody' in p)!
    expect(
      verbSchemaProblems('update_card', {
        ...updateTemplate,
        folder: REPO_ROOT,
        slug: u.slug,
        replaceBody: next
      })
    ).toEqual([])
    card.body = next
    expect(planDerive(changed, SPEC_REL, board)).toEqual({
      create: [],
      update: [],
      skip: [],
      refuse: []
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ---- AC-27: open decisions become operator blockers on only their slices' steps -------------------

/** The options cell of each Open decisions row, split at `;`. */
function decisionOptions(spec: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const sec = sectionOf(spec, /^## Open decisions\s*$/)
  for (const line of sec.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (!/^D-\d+$/.test(cells[1] ?? '')) continue
    out.set(
      cells[1],
      cells[3]
        .split(';')
        .map((o) => o.trim())
        .filter(Boolean)
    )
  }
  return out
}

/**
 * The documented rule, applied to a spec: one blocker per (open D-n, step of a slice it gates), filled
 * from the skill's own payload template; the slices no open D-n gates go out.
 */
function decisionBlockers(
  template: Record<string, unknown>,
  specText: string,
  specPath: string,
  stepBySlice: Map<string, string>
): { blockers: Record<string, unknown>[]; dispatched: string[] } {
  const parsed = parseSpec(specText) as {
    slices: { id: string; title: string; gatedBy: string[] }[]
    decisions: { id: string; status: string; question: string }[]
  }
  const options = decisionOptions(specText)
  const open = parsed.decisions.filter((d) => /^open\b/i.test(d.status))
  const blockers: Record<string, unknown>[] = []
  for (const d of open) {
    for (const slice of parsed.slices.filter((x) => x.gatedBy.includes(d.id))) {
      blockers.push({
        ...template,
        stepId: stepBySlice.get(slice.id),
        reason: `${specPath} leaves open ${d.id}: ${d.question} Options: ${(options.get(d.id) ?? []).join(' or ')}`,
        ask: `Choose ${d.id}, then say done`,
        unblocks: slice.title
      })
    }
  }
  const openIds = new Set(open.map((d) => d.id))
  const dispatched = parsed.slices
    .filter((s) => !s.gatedBy.some((id) => openIds.has(id)))
    .map((s) => s.id)
  return { blockers, dispatched }
}

function decisionProblems(skill: string): string[] {
  const sec = decisionsOf(skill)
  if (!sec) return ['no "### Open decisions become operator blockers" section in Phase 2']
  const f = flat(sec)
  const problems: string[] = []
  const payload = jsonFences(sec).find((p) => 'reason' in p && 'ask' in p)
  problems.push(...verbSchemaProblems('mission_set_blocker', payload))
  if (payload) {
    if (payload.owner !== 'operator') problems.push('the decision blocker is not the operator’s')
    if (typeof payload.stepId !== 'string') problems.push('the decision blocker is on no step')
  }
  if (!/open D-n that gates a slice is an operator blocker/.test(f))
    problems.push('only open D-n rows become blockers is not stated')
  if (!/`gated-by:`/.test(f)) problems.push("the steps are not read from the slices' gated-by")
  if (!/exactly the steps of the slices whose `gated-by:` names it/.test(f))
    problems.push("the blockers are not exactly the gated slices' steps")
  if (!/gates no slice gets no blocker/.test(f))
    problems.push('a D-n that gates no slice may get a blocker')
  if (!/no open D-n gates are dispatched/.test(f))
    problems.push('the slices no open D-n gates are not dispatched')
  if (!/split at `;`/.test(f)) problems.push("the options are not the row's options cell")
  if (!/so is clearing an operator-owned blocker/.test(f))
    problems.push("the clearing is not left to the operator's door")
  if (!/`mission_log \{ kind: 'decision', stepId \}`/.test(f))
    problems.push('the choice is not recorded as a decision log entry')
  if (!/`submit_manifest`/.test(f)) problems.push('the held slices are not dispatched once chosen')
  if (!/voids its stamp/.test(f) || !/fresh `submit_manifest`/.test(f))
    problems.push('editing a stamped ready card must void its stamp and require a fresh manifest')
  return problems
}

it('open decisions become operator blockers that hold only their slices', () => {
  expectCheck(decisionProblems, [
    {
      find: '"owner": "operator"',
      replace: '"owner": "agent"',
      why: 'the decision blocker is the operator’s'
    },
    {
      find: '"stepId": "<stp-… of a gated slice>"',
      replace: '"stepId": 4',
      why: 'the payload must parse against mission_set_blocker'
    },
    {
      find: 'gates no slice gets no blocker',
      replace: 'gates no slice gets a blocker anyway',
      why: 'a D-n gating no slice gets no blocker'
    },
    {
      find: 'no open D-n gates are dispatched',
      replace: 'no open D-n gates wait as well',
      why: 'un-gated slices are dispatched'
    },
    {
      find: 'voids its stamp',
      replace: 'leaves its stamp valid',
      why: 'editing a stamped ready card voids its manifest stamp'
    },
    {
      find: 'fresh `submit_manifest`',
      replace: 'previous manifest',
      why: 'a card whose stamp was voided needs a fresh manifest'
    },
    {
      find: 'so is clearing an operator-owned blocker',
      replace: 'and you clear the blocker',
      why: 'clearing an operator-owned blocker is the operator’s'
    }
  ])

  // The rule over a spec with one open D-n gating two slices, one gating none, one resolved.
  const skill = read(SKILL_FILE)
  const template = jsonFences(decisionsOf(skill)).find((p) => 'reason' in p && 'ask' in p)!
  const stepBySlice = new Map([
    ['S-1', 'stp-2'],
    ['S-2', 'stp-3'],
    ['S-3', 'stp-4']
  ])
  const { blockers, dispatched } = decisionBlockers(template, read(GATED), SPEC_REL, stepBySlice)
  expect(blockers.map((b) => b.stepId)).toEqual(['stp-3', 'stp-4'])
  for (const b of blockers) {
    expect(
      verbSchemaProblems('mission_set_blocker', {
        ...b,
        folder: REPO_ROOT,
        missionId: 'mnt-0000abcd',
        sessionId: '1cad4914-43cc-4e13-82d6-c505ebc03993'
      })
    ).toEqual([])
    // What the skill asks for is what the writing contract accepts: a reason with an exact reference
    // (the spec path), an ask and an unblocks within their caps.
    expect(checkBlockerReason(String(b.reason)), String(b.reason)).toEqual({ ok: true })
    expect(String(b.ask).length).toBeLessThanOrEqual(CAPS.ask)
    expect(String(b.unblocks).length).toBeLessThanOrEqual(CAPS.why)
  }
  expect(dispatched).toEqual(['S-1'])

  // The derive fixture: its one open D-n gates S-3 alone.
  const derive = decisionBlockers(template, read(path.join(FIX, 'spec.md')), SPEC_REL, stepBySlice)
  expect(derive.blockers.map((b) => b.stepId)).toEqual(['stp-4'])
  expect(derive.dispatched).toEqual(['S-1', 'S-2'])
})
