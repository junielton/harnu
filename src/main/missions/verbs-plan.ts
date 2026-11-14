/**
 * Missions v4 S-13 (AC-33, AC-34) — the plan verbs: milestone, step, criterion, link, log.
 *
 * Handlers for `mission_add_milestone`, `mission_add_step`, `mission_add_ac`, `mission_link` and
 * `mission_log`, written and tested through this module's API. Nothing calls them until S-24
 * registers them, so no operator or agent sees a change. Every one goes through S-11's one write path
 * (`writeMission`: the lock, the guard, the caps and the copy on first write), so none of them can
 * touch a v3 file, and the repo root is resolved there from whatever folder the caller works in.
 *
 * - **A plan only grows.** An agent adds a milestone, a step, a criterion or a link and never removes
 *   or rewrites one (spec "Facts, and who is trusted": the agent can add to a plan and never shrink
 *   it). The verbs here only append; {@link writePlanChange} also refuses, for a session, any change
 *   that drops or rewrites what the plan already held (`PLAN_ADD_ONLY`).
 * - **A step added after work started needs a reason.** "Started" is S-7's state, not a second
 *   definition: some step reads anything but `todo`.
 * - **Who calls is an input** (`Actor`): this transport has no per-session identity; S-24 and S-25
 *   supply it. A milestone, a step and a criterion are the leader's (`lead`); a link and a Log entry
 *   are any attached session's (`write`).
 * - **A link is one of five kinds** (`session`, `pr`, `worktree`, `url`, `doc`). A page or report link
 *   (`url`, `doc`) is an `http(s)` address or a path inside the repo. A step's card is `step.card`,
 *   written only by dispatch (S-26), so `card` is not a link kind.
 * - **A pull request on a step's branch attaches by itself** ({@link planPrLinks},
 *   {@link attachFoundPrs}). The finder of pull requests is chapter 2's observer; calling this from its
 *   pass is slice S-16's.
 *
 * A refusal is `{ ok: false, code, error }` with `error` = `CODE: what to do`, and never carries the
 * refused text. Electron-free.
 */

import { lstatSync, realpathSync } from 'node:fs'
import * as path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { repoRoot } from '../data-dir'
import { guardMission, type Actor, type Need } from './guard'
import {
  CRITERION_BY,
  FACTS,
  LINK_KINDS,
  type AcceptanceCriterion,
  type CriterionBy,
  type Fact,
  type LinkKind,
  type Milestone,
  type MissionLink,
  type MissionV4,
  type StepV4,
  type WithUnknownKeys
} from './model'
import { readMissionRecord, type RecordChange } from './record-store'
import { deriveStepState, type StepInput } from './state'
import { writeMission, type MissionWrite, type WriteCode } from './write'

// ---- Results ---------------------------------------------------------------------

export type PlanCode =
  WriteCode | 'REASON_REQUIRED' | 'NO_CRITERION' | 'STEP_NOT_FOUND' | 'BAD_LINK' | 'PLAN_ADD_ONLY'

export interface PlanRefusal {
  ok: false
  code: PlanCode
  /** `CODE: what to do`; names where, and never carries the refused text. */
  error: string
}

export type PlanResult<T> = ({ ok: true } & T) | PlanRefusal

/** What a refusal thrown inside a change looks like to the store: it keeps its `code`. */
class PlanError extends Error {
  constructor(
    readonly code: PlanCode,
    message: string
  ) {
    super(`${code}: ${message}`)
  }
}

const refusalOf = (code: PlanCode, message: string): PlanRefusal => ({
  ok: false,
  code,
  error: `${code}: ${message}`
})

/** Run one plan write and hand back what the change reported once it has landed. */
async function run<T extends object>(
  folder: string,
  missionId: string,
  actor: Actor,
  need: Exclude<Need, 'read'>,
  change: (record: MissionV4, log: string) => { next: RecordChange; out: T }
): Promise<PlanResult<T>> {
  // The store may run `change` again on a compare-and-swap retry; the run that lands is the last one.
  let out: T | undefined
  const written = await writePlanChange(folder, missionId, actor, need, (record, log) => {
    const r = change(record, log)
    out = r.out
    return r.next
  })
  if (!written.ok) return written as PlanRefusal
  return { ok: true, ...(out as T) }
}

// ---- A plan only grows -----------------------------------------------------------

const planFieldsOf = (s: StepV4): unknown => ({
  title: s.title,
  milestone: s.milestone,
  optional: s.optional ?? false,
  waitsFor: s.waitsFor ?? null
})

const criterionFieldsOf = (c: AcceptanceCriterion): unknown => ({
  text: c.text,
  by: c.by,
  fact: c.fact,
  person: c.person
})

/** The ids of `before` appear in `after` in the same relative order (insertions are fine). */
function keepsOrder(before: readonly string[], after: readonly string[]): boolean {
  let at = -1
  for (const id of before) {
    const i = after.indexOf(id)
    if (i <= at) return false
    at = i
  }
  return true
}

/**
 * What a session may never do to a plan (spec: "the agent can add to a plan and never shrink it"): no
 * milestone, step or criterion is removed, reordered or rewritten. What a step or a criterion
 * accumulates (links, blockers, a stamp, a card, `startedAt`) is not the plan and is not judged here.
 */
function checkAddOnly(before: MissionV4, after: MissionV4): void {
  const refuse = (what: string, at: string): never => {
    throw new PlanError(
      'PLAN_ADD_ONLY',
      `a plan only grows: ${what} was removed, moved or rewritten (at ${at}). Add a new one instead; only the operator changes what the plan already holds.`
    )
  }
  for (const m of before.milestones) {
    const now = after.milestones.find((x) => x.id === m.id)
    if (!now || !isDeepStrictEqual(now, m)) refuse(`milestone ${m.id}`, `milestone ${m.id}`)
  }
  if (
    !keepsOrder(
      before.milestones.map((m) => m.id),
      after.milestones.map((m) => m.id)
    )
  ) {
    refuse('the order of the milestones', 'the milestones')
  }
  for (const s of before.steps) {
    const now = after.steps.find((x) => x.id === s.id)
    if (!now || !isDeepStrictEqual(planFieldsOf(now), planFieldsOf(s))) {
      refuse(`step ${s.id}`, `step ${s.id}`)
    }
    for (const c of s.acs) {
      const nowC = now?.acs.find((x) => x.id === c.id)
      if (!nowC || !isDeepStrictEqual(criterionFieldsOf(nowC), criterionFieldsOf(c))) {
        refuse(`criterion ${c.id}`, `step ${s.id} criterion ${c.id}`)
      }
    }
    if (
      now &&
      !keepsOrder(
        s.acs.map((c) => c.id),
        now.acs.map((c) => c.id)
      )
    ) {
      refuse(`the order of the criteria of step ${s.id}`, `step ${s.id} criteria`)
    }
  }
  if (
    !keepsOrder(
      before.steps.map((s) => s.id),
      after.steps.map((s) => s.id)
    )
  ) {
    refuse('the order of the steps', 'the steps')
  }
}

/**
 * The write every plan verb goes through: S-11's {@link writeMission}, and for a session the add-only
 * rule on top. Exported as the seam that proves the rule (a change that shrinks the plan is refused
 * `PLAN_ADD_ONLY` and stores nothing); the operator's own hand is not judged here, its doors are S-15's.
 */
export async function writePlanChange(
  folder: string,
  missionId: string,
  actor: Actor,
  need: Exclude<Need, 'read'>,
  change: (record: MissionV4, log: string) => RecordChange | Promise<RecordChange>
): Promise<Exclude<MissionWrite, { ok: false }> | PlanRefusal> {
  const result = await writeMission(folder, missionId, actor, need, async (record, log) => {
    const next = await change(record, log)
    if (actor.kind === 'session') checkAddOnly(record, next.record)
    return next
  })
  return result as Exclude<MissionWrite, { ok: false }> | PlanRefusal
}

// ---- Step ids: the new ones, and the old ones a v3 campaign had --------------------

/** The `{ step, id }` rows of `legacyV3.stepIds` (a list of rows, or an old → new map). */
function legacyStepRows(record: MissionV4): Array<{ step: string; id: string }> {
  const raw = (record.legacyV3 as WithUnknownKeys<Record<string, unknown>> | undefined)?.stepIds
  if (Array.isArray(raw)) {
    return raw.flatMap((r: unknown) => {
      const row = r as { step?: unknown; id?: unknown } | null
      return typeof row?.step === 'string' && typeof row.id === 'string'
        ? [{ step: row.step, id: row.id }]
        : []
    })
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).flatMap(([step, id]) =>
      typeof id === 'string' ? [{ step, id }] : []
    )
  }
  return []
}

type StepLookup =
  { ok: true; id: string } | { ok: false; reason: 'unknown' | 'ambiguous'; candidates: string[] }

/**
 * The step a caller means: the id the record has, else the one a v3 campaign had (`legacyV3.stepIds`,
 * old → new). An old id that two chapters both used is ambiguous and names the new ids.
 */
function findStep(record: MissionV4, given: string): StepLookup {
  if (record.steps.some((s) => s.id === given)) return { ok: true, id: given }
  const candidates = [
    ...new Set(
      legacyStepRows(record)
        .filter((r) => r.step === given && record.steps.some((s) => s.id === r.id))
        .map((r) => r.id)
    )
  ]
  if (candidates.length === 1) return { ok: true, id: candidates[0] }
  return { ok: false, reason: candidates.length > 1 ? 'ambiguous' : 'unknown', candidates }
}

function resolveStep(record: MissionV4, given: unknown): string {
  if (typeof given !== 'string' || given === '') {
    throw new PlanError('BAD_ARGS', 'a step id is required.')
  }
  const found = findStep(record, given)
  if (found.ok) return found.id
  const have = record.steps.map((s) => s.id).join(', ') || 'none'
  throw new PlanError(
    'STEP_NOT_FOUND',
    found.reason === 'ambiguous'
      ? `${record.id} has no step ${given}, and the old id means more than one now: ${found.candidates.join(', ')}. Name the new id.`
      : `${record.id} has no step ${given}. Its steps: ${have}.`
  )
}

// ---- Shared input checks ------------------------------------------------------------

function requireText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlanError('BAD_ARGS', `${what} is required.`)
  }
  return value
}

/** The next `<prefix>-<n>`: one more than the highest in use, so an id is never reused. */
function nextId(prefix: string, used: readonly string[]): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`)
  const top = used.reduce((max, id) => Math.max(max, Number(re.exec(id)?.[1] ?? 0)), 0)
  return `${prefix}-${top + 1}`
}

// ---- Criteria -------------------------------------------------------------------------

export interface CriterionInput {
  text: string
  by: CriterionBy
  /** Required when `by` is `fact`, and only then. */
  fact?: Fact
  /** Required when `by` is `person`: who approves. Only then. */
  person?: string
}

function buildCriterion(input: CriterionInput, id: string): AcceptanceCriterion {
  const text = requireText(input?.text, 'a criterion text')
  if (!(CRITERION_BY as readonly string[]).includes(input.by)) {
    throw new PlanError(
      'BAD_ARGS',
      `a criterion is settled by one of ${CRITERION_BY.join(', ')}, not ${JSON.stringify(input.by)}.`
    )
  }
  if (input.by === 'fact') {
    if (!(FACTS as readonly string[]).includes(input.fact as string)) {
      throw new PlanError(
        'BAD_ARGS',
        `a criterion settled by a fact names the fact: one of ${FACTS.join(', ')}.`
      )
    }
  } else if (input.fact !== undefined) {
    throw new PlanError('BAD_ARGS', 'a fact is named only on a criterion settled by a fact.')
  }
  if (input.by === 'person') {
    requireText(input.person, 'the person who approves')
  } else if (input.person !== undefined) {
    throw new PlanError('BAD_ARGS', 'a person is named only on a criterion settled by a person.')
  }
  return {
    id,
    text,
    by: input.by,
    ...(input.by === 'fact' ? { fact: input.fact } : {}),
    ...(input.by === 'person' ? { person: (input.person as string).trim() } : {})
  }
}

// ---- Links ------------------------------------------------------------------------------

const MAX_REF = 500
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/

const pageRuleMessage = (kind: string): string =>
  `a ${kind} link is an http(s) address or a path inside the repo, not another scheme, an absolute path, or a path that leaves the repo with .. or through a symlink. Pass an address like https://example.com/report or a path like docs/specs/x/spec.md.`

const offLimitsMessage = (kind: string): string =>
  `a ${kind} link never points into .git, .harnu or node_modules. Pass the document or page itself: a path like docs/specs/x/spec.md, or an http(s) address.`

/** The folders a page or report link never points into, whatever the case or the spelling. */
const OFF_LIMITS = new Set(['.git', '.harnu', 'node_modules'])
const touchesOffLimits = (p: string): boolean =>
  p.split(/[\\/]/).some((segment) => OFF_LIMITS.has(segment.toLowerCase()))

/** `candidate` relative to the repo root (`''` for the root itself), or null when it lies outside. */
function relativeInside(rootReal: string, candidate: string): string | null {
  const rel = path.relative(rootReal, candidate)
  const inside =
    rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  return inside ? rel : null
}

/**
 * Where a repo-relative path really is, relative to the repo, once every symlink and `..` is resolved
 * physically; null when it leaves the repo. A path that does not exist yet is judged by its deepest
 * existing ancestor, and one that cannot be proven inside (it holds `..` and is not there, or it is a
 * dangling symlink) is null.
 */
function resolveInsideRepo(root: string, ref: string): string | null {
  let rootReal: string
  try {
    rootReal = realpathSync(root)
  } catch {
    return null
  }
  const normalized = ref.replace(/\\/g, '/')
  const full = path.resolve(rootReal, normalized)
  try {
    return relativeInside(rootReal, realpathSync(full))
  } catch {
    // not there, or a symlink that leads nowhere: fall through
  }
  if (normalized.split('/').includes('..')) return null
  for (let cur = full; ; cur = path.dirname(cur)) {
    try {
      lstatSync(cur)
    } catch {
      if (path.dirname(cur) === cur) return null
      continue
    }
    try {
      return relativeInside(rootReal, realpathSync(cur))
    } catch {
      return null
    }
  }
}

function checkPageRef(root: string, kind: string, ref: string): void {
  const refuse = (): never => {
    throw new PlanError('BAD_LINK', pageRuleMessage(kind))
  }
  if (SCHEME_RE.test(ref)) {
    // Only `http(s)://host` passes: a one-letter scheme is a Windows drive, an absolute path.
    if (!/^https?:\/\/[^/\\\s?#]/i.test(ref)) refuse()
    let url: URL
    try {
      url = new URL(ref)
    } catch {
      return refuse()
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.hostname === '' ||
      url.username !== '' ||
      url.password !== '' ||
      /\s/.test(ref)
    ) {
      refuse()
    }
    return
  }
  if (/^[/\\~]/.test(ref)) refuse()
  if (touchesOffLimits(ref)) throw new PlanError('BAD_LINK', offLimitsMessage(kind))
  const real = resolveInsideRepo(root, ref)
  if (real === null) refuse()
  // A symlink inside the repo can lead into .git as well: judge where the path really is.
  if (touchesOffLimits(real as string)) throw new PlanError('BAD_LINK', offLimitsMessage(kind))
}

/** Judge one link; returns it as it is stored (a pull request is its number). */
function checkLink(root: string, kind: unknown, ref: unknown): MissionLink {
  if (kind === 'card') {
    throw new PlanError(
      'BAD_LINK',
      "card is not a link kind: a step's card is written only when the step is dispatched, so dispatch the step instead."
    )
  }
  if (typeof kind !== 'string' || !(LINK_KINDS as readonly string[]).includes(kind)) {
    throw new PlanError(
      'BAD_LINK',
      `a link is one of ${LINK_KINDS.join(', ')}: pass one of ${LINK_KINDS.join(', ')} as kind.`
    )
  }
  if (typeof ref !== 'string' || ref === '' || ref.length > MAX_REF || CONTROL_RE.test(ref)) {
    throw new PlanError(
      'BAD_LINK',
      `a ${kind} link names where it points: pass it on one line, in at most ${MAX_REF} characters.`
    )
  }
  switch (kind as LinkKind) {
    case 'pr': {
      const m = /^#?([1-9]\d{0,8})$/.exec(ref)
      if (!m)
        throw new PlanError(
          'BAD_LINK',
          'a pr link is the number of a pull request: pass the pull request number, like 256.'
        )
      return { kind: 'pr', ref: m[1] }
    }
    case 'session':
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ref)) {
        throw new PlanError(
          'BAD_LINK',
          'a session link is the id of a Claude session: pass the id of the session (like 3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10), not its name.'
        )
      }
      return { kind: 'session', ref }
    case 'worktree':
      if (SCHEME_RE.test(ref) && !/^[A-Za-z]:/.test(ref)) {
        throw new PlanError(
          'BAD_LINK',
          'a worktree link is a path: pass the folder of the checkout, not an address.'
        )
      }
      return { kind: 'worktree', ref }
    case 'url':
    case 'doc':
      if (ref !== ref.trim()) throw new PlanError('BAD_LINK', pageRuleMessage(kind))
      checkPageRef(root, kind, ref)
      return { kind: kind as LinkKind, ref }
  }
}

/**
 * The number of the pull request a `pr` link names, however it was written: `302`, `#302`,
 * `owner/repo#302` (what a v3 mission kept) or a pull request address. Null when it names none.
 */
function prNumberOf(ref: string): string | null {
  const m =
    /^(?:[\w.-]+\/[\w.-]+)?#?(\d+)$/.exec(ref.trim()) ??
    /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\/?(?:[?#].*)?$/i.exec(ref.trim())
  return m ? String(Number(m[1])) : null
}

const sameLink = (a: MissionLink, b: MissionLink): boolean => {
  if (a.kind !== b.kind) return false
  if (a.kind === 'pr') {
    const [x, y] = [prNumberOf(a.ref), prNumberOf(b.ref)]
    if (x !== null && y !== null) return x === y
  }
  return a.ref === b.ref
}

// ---- The Log -------------------------------------------------------------------------------

/** The three kinds of Log entry the verbs write (`steward` is gone). */
export const LOG_KINDS = ['note', 'decision', 'surprise'] as const
export type LogKind = (typeof LOG_KINDS)[number]

/** The most characters one Log entry holds: the Log is the history, not a place for a document. */
export const MAX_LOG_NOTE = 4000

/**
 * The Log with one entry appended: `### <time> · <kind>[ · <step>]` and the text. Every line break a
 * reader may recognise is made a plain one first, and a line that starts with `#` is escaped, so the
 * text of a note or a reason can never forge an entry of another kind (the summary's Decided part and
 * the stall reader read the headings).
 */
function appendLogEntry(
  log: string,
  kind: LogKind,
  stepId: string | undefined,
  text: string
): string {
  const lead = log === '' || log.endsWith('\n') ? '' : '\n'
  const body = text
    // Every character a reader may take for a line break becomes one, so no line hides after a bare
    // CR, U+0085, U+2028, U+2029, VT or FF where the escape below would not see it.
    // eslint-disable-next-line no-control-regex
    .replace(/\r\n?|[\u0085\u2028\u2029\u000b\u000c]/g, '\n')
    .trimEnd()
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? `\\${line.trimStart()}` : line))
    .join('\n')
  const heading = `### ${new Date().toISOString()} · ${kind}${stepId ? ` · ${stepId}` : ''}`
  return `${log}${lead}\n${heading}\n\n${body}\n`
}

// ---- mission_add_milestone ------------------------------------------------------------------

export interface AddMilestoneArgs {
  missionId: string
  /** 45 characters at most (the writing contract, judged on write). */
  title: string
  optional?: boolean
  waitsFor?: string | null
}

/** Append a milestone, last in plan order. The leader's. */
export function addMilestone(
  folder: string,
  actor: Actor,
  args: AddMilestoneArgs
): Promise<PlanResult<{ milestoneId: string; totalMilestones: number }>> {
  return run(folder, args.missionId, actor, 'lead', (record, log) => {
    const title = requireText(args.title, 'a milestone title')
    const milestone: Milestone = {
      id: nextId(
        'mls',
        record.milestones.map((m) => m.id)
      ),
      title,
      optional: args.optional === true,
      waitsFor:
        typeof args.waitsFor === 'string' && args.waitsFor.trim() !== ''
          ? args.waitsFor.trim()
          : null
    }
    const milestones = [...record.milestones, milestone]
    return {
      next: { record: { ...record, milestones }, log },
      out: { milestoneId: milestone.id, totalMilestones: milestones.length }
    }
  })
}

// ---- mission_add_step -----------------------------------------------------------------------

export interface AddStepArgs {
  missionId: string
  /** 50 characters at most, and it starts with a verb (the writing contract). */
  title: string
  /** Required when the mission has milestones. */
  milestone?: string
  /** Place the step right after this one; omitted, it goes last. */
  afterStepId?: string
  /** At least one. */
  acs: CriterionInput[]
  links?: Array<{ kind: string; ref: string }>
  optional?: boolean
  waitsFor?: string | null
  /** Required once work has started (S-7's state: some step is not to do). */
  reason?: string
  /** What the caller read about each step (pull request, card column, a worker): see `StepInput`. */
  inputs?: Readonly<Record<string, StepInput>>
}

/** Whether work has started: S-7's state says some step is anything but to do. */
function workStarted(record: MissionV4, inputs: AddStepArgs['inputs']): boolean {
  return record.steps.some((s) => deriveStepState(s, inputs?.[s.id]).state !== 'todo')
}

/** Add a step, with its criteria and links. The leader's. No card: a step has one only when dispatched. */
export function addStep(
  folder: string,
  actor: Actor,
  args: AddStepArgs
): Promise<
  PlanResult<{ stepId: string; criterionIds: string[]; totalSteps: number; started: boolean }>
> {
  const root = repoRoot(folder)
  return run(folder, args.missionId, actor, 'lead', (record, log) => {
    const title = requireText(args.title, 'a step title')
    if (!Array.isArray(args.acs) || args.acs.length === 0) {
      throw new PlanError(
        'NO_CRITERION',
        'a step has at least one criterion: a fact that is true when the step is done.'
      )
    }
    const acs = args.acs.map((c, i) => buildCriterion(c, `ac-${i + 1}`))
    const links = (args.links ?? []).reduce<MissionLink[]>((all, l) => {
      const checked = checkLink(root, l?.kind, l?.ref)
      return all.some((x) => sameLink(x, checked)) ? all : [...all, checked]
    }, [])

    const started = workStarted(record, args.inputs)
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    if (reason.length > MAX_LOG_NOTE) {
      throw new PlanError(
        'BAD_ARGS',
        `a reason is at most ${MAX_LOG_NOTE} characters (this one is ${reason.length}): say why in a few lines and link the document.`
      )
    }
    if (started && reason === '') {
      throw new PlanError(
        'REASON_REQUIRED',
        'work has started on this mission, so a new step says why it is needed now (reason).'
      )
    }

    let at = record.steps.length
    if (args.afterStepId !== undefined) {
      at = record.steps.findIndex((s) => s.id === resolveStep(record, args.afterStepId)) + 1
    }
    const id = nextId(
      'stp',
      record.steps.map((s) => s.id)
    )
    const added: StepV4 = {
      id,
      ...(args.milestone !== undefined ? { milestone: args.milestone } : {}),
      title,
      ...(args.optional !== undefined ? { optional: args.optional } : {}),
      acs,
      links,
      blockers: [],
      ...(args.waitsFor !== undefined
        ? { waitsFor: typeof args.waitsFor === 'string' ? args.waitsFor.trim() || null : null }
        : {})
    }
    const steps = [...record.steps.slice(0, at), added, ...record.steps.slice(at)]
    return {
      next: {
        record: { ...record, steps },
        log: started
          ? appendLogEntry(log, 'note', id, `Added ${id} after work started. Reason: ${reason}`)
          : log
      },
      out: { stepId: id, criterionIds: acs.map((c) => c.id), totalSteps: steps.length, started }
    }
  })
}

// ---- mission_add_ac -----------------------------------------------------------------------

export interface AddCriterionArgs extends CriterionInput {
  missionId: string
  /** The step's id; an id a v3 campaign had resolves to the new one. */
  stepId: string
}

/** Add a criterion to a step, after its last. The leader's. */
export function addCriterion(
  folder: string,
  actor: Actor,
  args: AddCriterionArgs
): Promise<PlanResult<{ stepId: string; criterionId: string; totalCriteria: number }>> {
  return run(folder, args.missionId, actor, 'lead', (record, log) => {
    const stepId = resolveStep(record, args.stepId)
    const target = record.steps.find((s) => s.id === stepId) as StepV4
    const criterion = buildCriterion(
      args,
      nextId(
        'ac',
        target.acs.map((c) => c.id)
      )
    )
    const steps = record.steps.map((s) =>
      s.id === stepId ? { ...s, acs: [...s.acs, criterion] } : s
    )
    return {
      next: { record: { ...record, steps }, log },
      out: { stepId, criterionId: criterion.id, totalCriteria: target.acs.length + 1 }
    }
  })
}

// ---- mission_link ---------------------------------------------------------------------------

export interface AddLinkArgs {
  missionId: string
  /** The step to link; omitted, the link is the mission's. */
  stepId?: string
  /** One of `session`, `pr`, `worktree`, `url`, `doc`. */
  kind: string
  ref: string
}

/** Link a session, pull request, worktree, page or document to a step or to the mission. Idempotent. */
export function addLink(
  folder: string,
  actor: Actor,
  args: AddLinkArgs
): Promise<PlanResult<{ stepId?: string; link: MissionLink; added: boolean }>> {
  const root = repoRoot(folder)
  return run<{ stepId?: string; link: MissionLink; added: boolean }>(
    folder,
    args.missionId,
    actor,
    'write',
    (record, log) => {
      const stepId = args.stepId === undefined ? undefined : resolveStep(record, args.stepId)
      const link = checkLink(root, args.kind, args.ref)
      const have =
        stepId === undefined
          ? record.links
          : (record.steps.find((s) => s.id === stepId) as StepV4).links
      if (have.some((l) => sameLink(l, link))) {
        return { next: { record, log }, out: { ...(stepId ? { stepId } : {}), link, added: false } }
      }
      const next: MissionV4 =
        stepId === undefined
          ? { ...record, links: [...record.links, link] }
          : {
              ...record,
              steps: record.steps.map((s) =>
                s.id === stepId ? { ...s, links: [...s.links, link] } : s
              )
            }
      return {
        next: { record: next, log },
        out: { ...(stepId ? { stepId } : {}), link, added: true }
      }
    }
  )
}

// ---- mission_log ------------------------------------------------------------------------------

export interface LogArgs {
  missionId: string
  /** `note` (default), `decision` or `surprise`. */
  kind?: string
  stepId?: string
  note: string
}

/** Append one entry to the mission's Log. Any attached session's. Nothing earlier is rewritten. */
export function logMission(
  folder: string,
  actor: Actor,
  args: LogArgs
): Promise<PlanResult<{ stepId?: string }>> {
  return run(folder, args.missionId, actor, 'write', (record, log) => {
    const kind = args.kind ?? 'note'
    if (!(LOG_KINDS as readonly string[]).includes(kind)) {
      throw new PlanError('BAD_ARGS', `a Log entry is one of ${LOG_KINDS.join(', ')}.`)
    }
    const note = requireText(args.note, 'a note')
    if (note.length > MAX_LOG_NOTE) {
      throw new PlanError(
        'BAD_ARGS',
        `a Log entry is at most ${MAX_LOG_NOTE} characters (this one is ${note.length}): say the decision and link the document.`
      )
    }
    const stepId = args.stepId === undefined ? undefined : resolveStep(record, args.stepId)
    return {
      next: { record, log: appendLogEntry(log, kind as LogKind, stepId, note) },
      out: stepId ? { stepId } : {}
    }
  })
}

// ---- A pull request attaches to its step by itself ----------------------------------------------

/**
 * A pull request found for a mission's step, as a plain value: its number and state, and the step it
 * was found for (`stepId`) or the branch it was found on (`branch`, matched to a step through the
 * `StepBranches` the caller hands over). The finder is chapter 2's observer.
 */
export interface FoundPr {
  stepId?: string
  branch?: string
  number: number
  state: 'open' | 'closed' | 'merged'
}

/** Each step's branch, by step id: what the caller knows from the step's card or worktree. */
export type StepBranches = Readonly<Record<string, string>>

export type SkipReason = 'bad-number' | 'closed' | 'no-step' | 'ambiguous-branch' | 'already-linked'

export interface PrLinkPlan {
  add: Array<{ stepId: string; link: MissionLink }>
  skipped: Array<{ number: number; reason: SkipReason }>
}

/**
 * Which `pr` links the found pull requests add, and which they skip and why. Pure: it reads only the
 * record and its arguments. A pull request attaches to the step it was found for (an id a v3 campaign
 * had resolves to the new one), else to the one step whose branch it is on; a closed pull request
 * counts as none, as in S-7, so it never attaches; one a step already carries, or that appears twice,
 * is added once.
 */
export function planPrLinks(
  record: MissionV4,
  found: readonly FoundPr[],
  branches: StepBranches = {}
): PrLinkPlan {
  const plan: PrLinkPlan = { add: [], skipped: [] }
  const carried = new Set<string>(
    record.steps.flatMap((s) =>
      s.links.filter((l) => l.kind === 'pr').map((l) => `${s.id}#${prNumberOf(l.ref) ?? l.ref}`)
    )
  )
  const byBranch = new Map<string, string[]>()
  for (const [given, branch] of Object.entries(branches)) {
    const step = findStep(record, given)
    if (step.ok) byBranch.set(branch, [...(byBranch.get(branch) ?? []), step.id])
  }
  for (const pr of found) {
    const skip = (reason: SkipReason): void => void plan.skipped.push({ number: pr.number, reason })
    if (!Number.isInteger(pr.number) || pr.number < 1) {
      skip('bad-number')
      continue
    }
    if (pr.state === 'closed') {
      skip('closed')
      continue
    }
    let stepId: string | undefined
    if (pr.stepId !== undefined) {
      const step = findStep(record, pr.stepId)
      if (step.ok) stepId = step.id
    } else if (pr.branch !== undefined) {
      const owners = [...new Set(byBranch.get(pr.branch) ?? [])]
      if (owners.length > 1) {
        skip('ambiguous-branch')
        continue
      }
      stepId = owners[0]
    }
    if (stepId === undefined) {
      skip('no-step')
      continue
    }
    const key = `${stepId}#${pr.number}`
    if (carried.has(key)) {
      skip('already-linked')
      continue
    }
    carried.add(key)
    plan.add.push({ stepId, link: { kind: 'pr', ref: String(pr.number) } })
  }
  return plan
}

/**
 * Attach the found pull requests to their steps, once. The caller is Harnu itself (the observer pass),
 * and Harnu's own call is `{ kind: 'harnu' }`: S-11's guard treats it as it treats the operator, and
 * only its name differs, so nothing records that the operator did what Harnu did. A session the
 * mission knows may call it too; a system worker is read only. A pass
 * with nothing to add writes nothing, and so never creates the v4 copy of a mission that exists only as
 * v3. Idempotent: a second pass over the same pull requests adds none.
 */
export async function attachFoundPrs(
  folder: string,
  actor: Actor,
  missionId: string,
  found: readonly FoundPr[],
  branches: StepBranches = {}
): Promise<
  PlanResult<{ added: Array<{ stepId: string; ref: string }>; skipped: PrLinkPlan['skipped'] }>
> {
  const peek = await readMissionRecord(repoRoot(folder), missionId)
  if (!peek.ok) return refusalOf(peek.code as PlanCode, peek.error.replace(/^[A-Z_]+: /, ''))
  const access = guardMission(peek.record, actor, 'write')
  if (!access.ok) return refusalOf(access.code, access.error.replace(/^[A-Z_]+: /, ''))
  if (peek.record.status === 'closed') {
    return refusalOf(
      'MISSION_CLOSED',
      `${missionId} is closed; its pull requests are not attached.`
    )
  }
  const first = planPrLinks(peek.record, found, branches)
  if (first.add.length === 0) return { ok: true, added: [], skipped: first.skipped }

  return run(folder, missionId, actor, 'write', (record, log) => {
    const plan = planPrLinks(record, found, branches)
    const steps = record.steps.map((s) => {
      const links = plan.add.filter((a) => a.stepId === s.id).map((a) => a.link)
      return links.length > 0 ? { ...s, links: [...s.links, ...links] } : s
    })
    return {
      next: { record: { ...record, steps }, log },
      out: {
        added: plan.add.map((a) => ({ stepId: a.stepId, ref: a.link.ref })),
        skipped: plan.skipped
      }
    }
  })
}
