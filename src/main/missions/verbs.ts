/**
 * Missions v4 S-24 (AC-66, AC-67) — the dispatch: which format a call is, and the v4 verbs behind it.
 *
 * S-12, S-13 and S-14 wrote the v4 handlers (`verbs-read.ts`, `verbs-plan.ts`, `verbs-state.ts`) and
 * took the caller as an argument. This module is what the MCP layer calls to reach them, beside the v3
 * handlers, which stay as they are until S-40. It owns three things and nothing else:
 *
 * 1. **Which format a call is** ({@link shapeOf}). A name only v4 has (`mission_add_milestone`,
 *    `mission_add_ac`, `mission_link`, `mission_set_done_when`, `mission_settle_ac`,
 *    `mission_attach`) is v4. A kept name is v4 when it carries an argument only v4 has (`doneWhen`,
 *    `milestones`, `criteria`, `blockerId`, …), v3 when it carries one only v3 has (`declaredEnd`,
 *    `verification`, `reason`/`index` on a blocker, …), and a call that carries both is refused. A kept
 *    name that takes the same arguments in both formats (`mission_log`, `mission_request_close`, a
 *    blocker set without `ask`) serves the record in the format it is in and never converts it: only a
 *    v4-only verb or argument converts a v3 mission (the copy is S-9's, on its first write).
 * 2. **One format at a time** ({@link formatOf}, {@link v3Refusal}). A mission that has a v4 record is
 *    a v4 mission, and the v3 file is a snapshot nobody writes: a v3-shaped verb aimed at it is refused
 *    `MISSION_IS_V4` with the v4 verb to use, and writes nothing.
 * 3. **Running a v4 verb** ({@link runV4}): the arguments of the catalog become the arguments of the
 *    S-12 to S-14 handlers, with the caller as an {@link Actor} the MCP layer built from the
 *    transport. The facts a verb reads (card column, pull request, CI) are computed here from
 *    `deps.inputsFor`, on the server: a call never supplies them (an `inputs` or `siblingRoots`
 *    argument is not read), and the roots a mission is looked for in come from the folder.
 *
 * Electron-free; what it reads of the outside world (the facts, memory) comes in through
 * {@link V4Deps}. Writes only through the S-11 write path the handlers use.
 */

import { repoRoot } from '../data-dir'
import { listMissionRows, type Actor } from './guard'
import type { AcceptanceCriterion, MissionV4 } from './model'
import { listMissionRecords, readMissionRecord } from './record-store'
import type { StepInput } from './state'
import { addCriterion, addLink, addMilestone, addStep, logMission } from './verbs-plan'
import { missionCreate, missionGet, type RecallEntry } from './verbs-read'
import {
  askToAttach,
  clearBlocker,
  requestClose,
  setBlocker,
  settleCriterion,
  stageDoneWhen
} from './verbs-state'

// ---- The verbs -------------------------------------------------------------------------

/** The v4 verbs that exist in v4 alone: a call to one is always v4-shaped. */
export const V4_ONLY_OPS = [
  'mission_add_milestone',
  'mission_add_ac',
  'mission_link',
  'mission_set_done_when',
  'mission_settle_ac',
  'mission_attach'
] as const

/** The kept names that take both shapes. */
export const SHARED_OPS = [
  'mission_create',
  'mission_get',
  'mission_list',
  'mission_add_step',
  'mission_log',
  'mission_set_blocker',
  'mission_clear_blocker',
  'mission_request_close'
] as const

export type V4OnlyOp = (typeof V4_ONLY_OPS)[number]
export type SharedOp = (typeof SHARED_OPS)[number]
export type V4Op = V4OnlyOp | SharedOp

export const isV4OnlyOp = (op: string): op is V4OnlyOp =>
  (V4_ONLY_OPS as readonly string[]).includes(op)

/** What a verb answers: `error` is `CODE: what to do`; a success carries `ok: true` and the op. */
export type VerbOutcome =
  { ok: true; op: string; [key: string]: unknown } | { ok: false; code: string; error: string }

const refuse = (code: string, message: string): VerbOutcome => ({
  ok: false,
  code,
  error: `${code}: ${message}`
})

// ---- Which format a call is ------------------------------------------------------------

/** `v4` and `v3` name a format; `either` is a call that reads the same in both; `mixed` is refused. */
export type Shape = 'v4' | 'v3' | 'either' | 'mixed'

const has = (args: Record<string, unknown>, ...keys: string[]): boolean =>
  keys.some((k) => args[k] !== undefined)

const stepsOf = (args: Record<string, unknown>): Array<Record<string, unknown>> =>
  Array.isArray(args.steps)
    ? args.steps.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    : []

/** The arguments each kept name carries in one format alone. */
function marks(op: string, args: Record<string, unknown>): { v4: boolean; v3: boolean } {
  switch (op) {
    case 'mission_create': {
      const steps = stepsOf(args)
      return {
        v4:
          has(args, 'doneWhen', 'milestones', 'links') ||
          steps.some((s) => has(s, 'criteria', 'milestone', 'optional', 'waitsFor')),
        v3:
          has(args, 'declaredEnd', 'campaignId', 'chapterId', 'steward', 'linkedCard', 'scope') ||
          steps.some((s) => has(s, 'verification'))
      }
    }
    case 'mission_add_step':
      return {
        v4: has(args, 'criteria', 'milestone', 'optional', 'waitsFor'),
        v3: has(args, 'verification', 'required', 'discoveredFrom', 'edges', 'decision')
      }
    case 'mission_set_blocker':
      return { v4: has(args, 'ask', 'clearsWhen'), v3: false }
    case 'mission_clear_blocker':
      return { v4: has(args, 'blockerId'), v3: has(args, 'reason', 'index') }
    case 'mission_log':
      return { v4: false, v3: args.kind === 'steward' }
    case 'mission_get':
      return { v4: false, v3: has(args, 'ownerSessionId') }
    default:
      return { v4: false, v3: false }
  }
}

/** The format of one call, from its name and the arguments it carries. */
export function shapeOf(op: string, args: Record<string, unknown>): Shape {
  if (isV4OnlyOp(op)) return 'v4'
  const m = marks(op, args)
  if (m.v4 && m.v3) return 'mixed'
  return m.v4 ? 'v4' : m.v3 ? 'v3' : 'either'
}

/** The refusal for a call that mixes the two shapes: it says which arguments belong to which. */
export function mixedRefusal(op: string): VerbOutcome {
  return refuse(
    'BAD_ARGS',
    `${op} takes the v3 shape or the v4 shape, not both. v3: declaredEnd, steps with verification, scope, campaignId, chapterId, steward. v4: doneWhen, milestones, steps with criteria, links, milestone, waitsFor, blockerId, ask, clearsWhen. Pass one set.`
  )
}

// ---- One format at a time --------------------------------------------------------------

export type Format = 'v4' | 'v3' | 'none'

/**
 * The format a mission is in: `v4` once it has a v4 record (a converted v3 mission and a converted
 * campaign included, by any id it has had), `v3` while only a v3 file holds it, `none` when no record
 * of this repo has the id. Never writes.
 */
export async function formatOf(folder: string, id: string): Promise<Format> {
  const read = await readMissionRecord(repoRoot(folder), id)
  if (!read.ok) return 'none'
  return read.source === 'v4' ? 'v4' : 'v3'
}

/** What to use instead of a v3 verb on a v4 mission. */
const WAY_OUT: Record<string, string> = {
  mission_link_child:
    'mission_link (kinds session, pr, worktree, url, doc; leave stepId out to link the mission itself)',
  mission_add_step: 'mission_add_step with criteria (and milestone) instead of verification',
  mission_update_step:
    'nothing in v4 yet: add what is missing with mission_add_step, mission_add_ac or mission_link, or tell the operator',
  mission_verify_step: 'mission_settle_ac (one criterion, with the evidence you saw)',
  mission_set_end: 'mission_set_done_when (it stages the new Done when for the operator)',
  mission_add_check:
    'mission_add_ac with by: operator (a check is a criterion the operator settles)',
  mission_transfer_owner:
    'mission_attach to ask to join; the operator changes who leads, from the Mission pane',
  mission_clear_blocker: 'mission_clear_blocker with blockerId (mission_get lists each blocker id)',
  mission_log: 'mission_log with kind note, decision or surprise',
  mission_create: 'mission_add_milestone on the mission, or a new mission_create with the v4 shape',
  campaign_create: 'mission_create with milestones',
  campaign_add_chapter: 'mission_add_milestone',
  campaign_get: 'mission_get',
  campaign_list: 'mission_list',
  campaign_request_close: 'mission_request_close',
  campaign_transfer_owner: 'mission_attach to ask to join; the operator changes who leads'
}

/**
 * The refusal for a v3-shaped verb aimed at a mission that has a v4 record: the code is
 * `MISSION_IS_V4`, the sentence names the verb to use, and nothing was written. It never carries the
 * text of the refused call.
 */
export function v3Refusal(op: string, id: string): VerbOutcome {
  const use = WAY_OUT[op] ?? 'the v4 form of this verb (mission_get shows the mission as it is now)'
  return refuse(
    'MISSION_IS_V4',
    `${id} is a v4 mission now (it has a v4 record), so ${op}, a v3 verb, no longer reaches it and nothing was written. Use ${use}.`
  )
}

// ---- Running a v4 verb -----------------------------------------------------------------

/** What a verb reads from the outside world: both are the MCP layer's, so this module stays pure. */
export interface V4Deps {
  /**
   * Each step's facts (pull request, CI, card column, a worker working) for `record`, gathered on the
   * server. A call never supplies them. A source that cannot be read leaves its fact out (absent is
   * not false).
   */
  inputsFor: (root: string, record: MissionV4) => Promise<Record<string, StepInput>>
  /** Memory entries that watch this scope, for `mission_create`'s ACK; `[]` when there are none. */
  recall?: (folder: string, query: { paths: string[]; topics: string[] }) => Promise<RecallEntry[]>
}

type Args = Record<string, unknown>

const str = (a: Args, key: string): string | undefined =>
  typeof a[key] === 'string' ? (a[key] as string) : undefined

/** A criterion as the plan verbs take it: the same defaults `mission_create` applies. */
function criterionOf(raw: unknown): Record<string, unknown> {
  const spec = typeof raw === 'string' ? { text: raw } : (raw as Record<string, unknown>)
  const by =
    spec.by ?? (spec.fact !== undefined ? 'fact' : spec.person !== undefined ? 'person' : 'session')
  return {
    text: spec.text,
    by,
    ...(spec.fact !== undefined ? { fact: spec.fact } : {}),
    ...(spec.person !== undefined ? { person: spec.person } : {})
  }
}

const done = <T extends object>(op: string, result: { ok: true } & T): VerbOutcome => {
  const { ok: _ok, ...rest } = result
  return { ok: true, op, ...rest }
}
const failed = (r: { ok: false; code: string; error: string }): VerbOutcome => ({
  ok: false,
  code: r.code,
  error: r.error
})

/** The record a call names, for the facts it needs; `null` when it cannot be read (the verb says why). */
async function recordOf(folder: string, id: string | undefined): Promise<MissionV4 | null> {
  if (id === undefined) return null
  const read = await readMissionRecord(repoRoot(folder), id)
  return read.ok ? read.record : null
}

async function inputsOf(
  folder: string,
  id: string | undefined,
  deps: V4Deps
): Promise<Record<string, StepInput>> {
  const record = await recordOf(folder, id)
  return record ? await deps.inputsFor(repoRoot(folder), record) : {}
}

/**
 * Run one v4 verb as `actor`. `args` are the catalog's, already checked for type; this module judges
 * what they mean. Never throws.
 */
export async function runV4(
  op: V4Op,
  folder: string,
  actor: Actor,
  args: Args,
  deps: V4Deps
): Promise<VerbOutcome> {
  const missionId = str(args, 'missionId')
  const need = (key: string): string | undefined => str(args, key)
  const missing = (...keys: string[]): VerbOutcome | null => {
    const lack = keys.filter((k) => need(k) === undefined || need(k) === '')
    return lack.length > 0 ? refuse('BAD_ARGS', `${op} needs ${lack.join(', ')}.`) : null
  }

  switch (op) {
    case 'mission_create': {
      const made = await missionCreate(
        folder,
        actor,
        {
          title: args.title as string,
          doneWhen: args.doneWhen as string,
          ...(args.milestones !== undefined ? { milestones: args.milestones as never } : {}),
          steps: (args.steps ?? []) as never,
          ...(args.links !== undefined ? { links: args.links as never } : {})
        },
        {
          recall: await (deps.recall?.(folder, {
            paths: ((args.links as Array<{ kind: string; ref: string }> | undefined) ?? [])
              .filter((l) => l.kind === 'doc' || l.kind === 'worktree')
              .map((l) => l.ref),
            topics: [
              String(args.title ?? ''),
              ...stepsOf(args).map((s) => String(s.title ?? ''))
            ].filter((t) => t !== '')
          }) ?? Promise.resolve([]))
        }
      )
      return made.ok ? done(op, made) : failed(made)
    }

    case 'mission_get': {
      let id = missionId ?? (actor.kind === 'worker' ? actor.missionId : undefined)
      if (id === undefined) {
        // No id: the mission the session is attached to. Read once to learn which, then again with its facts.
        const first = await missionGet(folder, actor, {})
        if (!first.ok) return failed(first)
        id = first.id
      }
      const inputs = await inputsOf(folder, id, deps)
      const detail = await missionGet(folder, actor, { missionId: id }, { inputs })
      return detail.ok ? done(op, detail) : failed(detail)
    }

    case 'mission_list': {
      const root = repoRoot(folder)
      const { records } = await listMissionRecords(root)
      const v4 = records.filter((r) => r.source === 'v4' && r.record.status === 'open')
      const byMission: Record<string, Record<string, StepInput>> = {}
      await Promise.all(
        v4.map(async (r) => {
          byMission[r.record.id] = await deps.inputsFor(root, r.record)
        })
      )
      const ids = new Set(v4.map((r) => r.record.id))
      const rows = (await listMissionRows(folder, actor, byMission)).filter((r) => ids.has(r.id))
      return {
        ok: true,
        op,
        missions: rows.map((r) => ({ ...r, format: 'v4' as const }))
      }
    }

    case 'mission_add_milestone': {
      const lack = missing('missionId', 'title')
      if (lack) return lack
      const r = await addMilestone(folder, actor, {
        missionId: missionId as string,
        title: args.title as string,
        ...(args.optional !== undefined ? { optional: args.optional as boolean } : {}),
        ...(args.waitsFor !== undefined ? { waitsFor: args.waitsFor as string | null } : {})
      })
      return r.ok ? done(op, r) : failed(r)
    }

    case 'mission_add_step': {
      const lack = missing('missionId', 'title')
      if (lack) return lack
      const criteria = Array.isArray(args.criteria) ? args.criteria : []
      const r = await addStep(folder, actor, {
        missionId: missionId as string,
        title: args.title as string,
        ...(need('milestone') !== undefined ? { milestone: need('milestone') } : {}),
        ...(need('afterStepId') !== undefined ? { afterStepId: need('afterStepId') } : {}),
        acs: criteria.map(criterionOf) as never,
        ...(args.links !== undefined ? { links: args.links as never } : {}),
        ...(args.optional !== undefined ? { optional: args.optional as boolean } : {}),
        ...(args.waitsFor !== undefined ? { waitsFor: args.waitsFor as string | null } : {}),
        ...(need('reason') !== undefined ? { reason: need('reason') } : {}),
        inputs: await inputsOf(folder, missionId, deps)
      })
      return r.ok ? done(op, r) : failed(r)
    }

    case 'mission_add_ac': {
      const lack = missing('missionId', 'stepId', 'text')
      if (lack) return lack
      const c = criterionOf({
        text: args.text,
        by: args.by,
        fact: args.fact,
        person: args.person
      })
      const r = await addCriterion(folder, actor, {
        missionId: missionId as string,
        stepId: need('stepId') as string,
        ...(c as { text: string; by: AcceptanceCriterion['by'] })
      })
      return r.ok ? done(op, r) : failed(r)
    }

    case 'mission_link': {
      const lack = missing('missionId')
      if (lack) return lack
      const link = (args.link ?? {}) as { kind?: unknown; ref?: unknown }
      const r = await addLink(folder, actor, {
        missionId: missionId as string,
        ...(need('stepId') !== undefined ? { stepId: need('stepId') } : {}),
        kind: String(link.kind ?? ''),
        ref: String(link.ref ?? '')
      })
      return r.ok ? done(op, r) : failed(r)
    }

    case 'mission_log': {
      const lack = missing('missionId', 'note')
      if (lack) return lack
      const r = await logMission(folder, actor, {
        missionId: missionId as string,
        ...(need('kind') !== undefined ? { kind: need('kind') } : {}),
        ...(need('stepId') !== undefined ? { stepId: need('stepId') } : {}),
        note: need('note') as string
      })
      return r.ok ? done(op, r) : failed(r)
    }

    case 'mission_set_blocker': {
      const lack = missing('missionId', 'reason')
      if (lack) return lack
      const r = await setBlocker(folder, actor, {
        missionId: missionId as string,
        ...(need('stepId') !== undefined ? { stepId: need('stepId') } : {}),
        reason: need('reason') as string,
        ...(need('ask') !== undefined ? { ask: need('ask') } : {}),
        ...(need('unblocks') !== undefined ? { unblocks: need('unblocks') } : {}),
        owner: args.owner as 'agent' | 'operator',
        ...(args.clearsWhen !== undefined ? { clearsWhen: args.clearsWhen as never } : {})
      })
      return r.ok ? done(op, r) : failed(r)
    }

    case 'mission_clear_blocker': {
      const lack = missing('missionId', 'blockerId')
      if (lack) return lack
      const r = await clearBlocker(folder, actor, {
        missionId: missionId as string,
        blockerId: need('blockerId') as string
      })
      return r.ok ? done(op, r) : failed(r)
    }

    case 'mission_set_done_when': {
      const lack = missing('missionId', 'doneWhen', 'reason')
      if (lack) return lack
      const r = await stageDoneWhen(folder, actor, {
        missionId: missionId as string,
        doneWhen: need('doneWhen') as string,
        reason: need('reason') as string
      })
      return r.ok ? done(op, r) : failed(r)
    }

    case 'mission_settle_ac': {
      const lack = missing('missionId', 'stepId', 'criterionId', 'evidence')
      if (lack) return lack
      const r = await settleCriterion(folder, actor, {
        missionId: missionId as string,
        stepId: need('stepId') as string,
        criterionId: need('criterionId') as string,
        evidence: need('evidence') as string
      })
      return r.ok ? done(op, r) : failed(r)
    }

    case 'mission_request_close': {
      const lack = missing('missionId')
      if (lack) return lack
      const r = await requestClose(folder, actor, {
        missionId: missionId as string,
        inputs: await inputsOf(folder, missionId, deps)
      })
      return r.ok ? done(op, r) : failed(r)
    }

    case 'mission_attach': {
      const lack = missing('missionId')
      if (lack) return lack
      const r = await askToAttach(folder, actor, { missionId: missionId as string })
      return r.ok ? done(op, r) : failed(r)
    }
  }
}
