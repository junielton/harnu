/**
 * Missions v4 (S-24, S-40) — the v4 verbs behind the MCP layer.
 *
 * S-12, S-13 and S-14 wrote the v4 handlers (`verbs-read.ts`, `verbs-plan.ts`, `verbs-state.ts`) and
 * took the caller as an argument. This module is what the MCP layer calls to reach them. It owns one
 * thing: **running a v4 verb** ({@link runV4}): the arguments of the catalog become the arguments of
 * the S-12 to S-14 handlers, with the caller as an {@link Actor} the MCP layer built from the
 * transport. The facts a verb reads (card column, pull request, CI) are computed here from
 * `deps.inputsFor`, on the server: a call never supplies them (an `inputs` or `siblingRoots` argument
 * is not read), and the roots a mission is looked for in come from the folder.
 *
 * Until S-40 this module also decided which of two formats a call was (v3-shaped or v4-shaped) and
 * refused a v3-shaped verb aimed at a mission that had a v4 record. The v3 handlers are gone, so every
 * verb is v4: a mission still held in a v3 file is read in memory and its first write converts it by
 * copy (the copy is S-9's), and a call carrying an argument only v3 had is refused by the catalog's
 * schema before it reaches here.
 *
 * Electron-free; what it reads of the outside world (the facts, memory) comes in through
 * {@link V4Deps}. Writes only through the S-11 write path the handlers use.
 */

import { repoRoot } from '../data-dir'
import { buildersOf, leaderOf, listMissionRows, type Actor } from './guard'
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

/** The verbs the fate table adds (a rename, a merge or a replacement of a v3 verb). */
export const V4_ONLY_OPS = [
  'mission_add_milestone',
  'mission_add_ac',
  'mission_link',
  'mission_set_done_when',
  'mission_settle_ac',
  'mission_attach'
] as const

/** The kept names (the fate table's keep, reshape and narrow rows). */
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

/** What a verb answers: `error` is `CODE: what to do`; a success carries `ok: true` and the op. */
export type VerbOutcome =
  { ok: true; op: string; [key: string]: unknown } | { ok: false; code: string; error: string }

const refuse = (code: string, message: string): VerbOutcome => ({
  ok: false,
  code,
  error: `${code}: ${message}`
})

const stepsOf = (args: Record<string, unknown>): Array<Record<string, unknown>> =>
  Array.isArray(args.steps)
    ? args.steps.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    : []

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
 * The session ids that built the step without a `session` link on it: the leader, when no other session
 * is linked to the step (it did the step itself, so what it says of it is a self-check, never a second
 * session's word). A step a worker is linked to was not built by the leader, which settles it as a
 * second session. Nothing else is added: a call never names its builders.
 */
async function leaderBuilds(
  folder: string,
  missionId: string,
  stepId: string | undefined,
  actor: Actor
): Promise<string[]> {
  if (actor.kind !== 'session' || stepId === undefined) return []
  const record = await recordOf(folder, missionId)
  if (!record || leaderOf(record) !== actor.sessionId) return []
  return buildersOf(record, stepId).length === 0 ? [actor.sessionId] : []
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
      // Every open record, whatever file holds it: a mission still in a v3 file is one mission of the list.
      const open = records.filter((r) => r.record.status === 'open')
      const byMission: Record<string, Record<string, StepInput>> = {}
      await Promise.all(
        open.map(async (r) => {
          byMission[r.record.id] = await deps.inputsFor(root, r.record)
        })
      )
      const sourceOf = new Map(open.map((r) => [r.record.id, r.source]))
      const rows = (await listMissionRows(folder, actor, byMission)).filter((r) =>
        sourceOf.has(r.id)
      )
      return {
        ok: true,
        op,
        missions: rows.map((r) => ({ ...r, format: sourceOf.get(r.id) === 'v4' ? 'v4' : 'v3' }))
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
        evidence: need('evidence') as string,
        extraBuilders: await leaderBuilds(folder, missionId as string, need('stepId'), actor)
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
