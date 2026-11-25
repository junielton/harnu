/**
 * Guided walks: the four core verbs (spec S-2): `walk_open`, `walk_extend`, `walk_report`, `walk_get`.
 *
 * Pure over an injected {@link WalkVerbEnv}, so the verbs are tested without Electron; `tool-handlers.ts`
 * builds the real env (the folder's board, the mission record, the known folders) and wraps each result as
 * the ACK `browser_set_data` and its siblings return.
 *
 * What NO verb here can do (NG-4, AC-9): take a command to run, press Done, Back, Skip or Failed, re-run a
 * walk, export or delete one, or settle a criterion. The operator's outcomes are the pane's (S-3); this
 * file does not import the service's `operate`, and nothing here reaches `markCriterion`. (T787: the APP, not
 * a verb, settles the criteria two signals verified when a mission-source run closes; see `walk-settle.ts`.)
 */
import type { WalkProbe } from '../../shared/walk-schema'
import type { MissionFacts } from '../../shared/walk-source'
import type { WalkService } from '../walk/walk-service'

export interface WalkVerbEnv {
  service: WalkService
  /** The reads a script's source needs (the board, the mission record), made before validating. */
  probeFor(source: unknown): Promise<WalkProbe>
}

export type WalkVerbResult = { ok: boolean } & Record<string, unknown>

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const bad = (message: string): WalkVerbResult => ({
  ok: false,
  error: { code: 'BAD_ARGS', message }
})

/** The mission facts a walk may rely on, from a mission record: its milestones, and each step's criteria. */
export function missionFactsOf(record: {
  milestones: { id: string }[]
  steps: { id: string; milestone?: string; acs: { id: string }[] }[]
}): MissionFacts {
  return {
    milestones: record.milestones.map((m) => m.id),
    steps: record.steps.map((s) => ({
      id: s.id,
      milestone: s.milestone ?? null,
      criteria: s.acs.map((a) => a.id)
    }))
  }
}

/** `walk_open { folder, sessionId?, script }`. */
export async function walkOpen(
  args: Record<string, unknown>,
  env: WalkVerbEnv
): Promise<WalkVerbResult> {
  if (!isObj(args.script)) return bad('script is required: one JSON object.')
  const sessionId =
    typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : undefined
  const probe = await env.probeFor(args.script.source)
  const res = await env.service.open({
    ...(sessionId ? { sessionId } : {}),
    script: args.script,
    probe
  })
  return { ...res, op: 'walk_open' }
}

/** `walk_extend { folder, walkId, checkId, more?, extra?, simpler? }` or `{ folder, walkId, append }`. */
export async function walkExtend(
  args: Record<string, unknown>,
  env: WalkVerbEnv
): Promise<WalkVerbResult> {
  if (typeof args.walkId !== 'string' || args.walkId.length === 0) return bad('walkId is required.')
  const probe = await env.probeFor(undefined)
  const res = await env.service.extend({
    walkId: args.walkId,
    ...(typeof args.checkId === 'string' ? { checkId: args.checkId } : {}),
    ...(args.more !== undefined ? { more: args.more } : {}),
    ...(args.extra !== undefined ? { extra: args.extra } : {}),
    ...(args.simpler !== undefined ? { simpler: args.simpler } : {}),
    ...(args.append !== undefined ? { append: args.append } : {}),
    ...(typeof args.expectRev === 'number' ? { expectRev: args.expectRev } : {}),
    probe
  })
  return { ...res, op: 'walk_extend' }
}

/** `walk_report { folder, walkId, runId?, checkId, kind, result, evidence }` or `{ ..., kind: 'correction', text }`. */
export async function walkReport(
  args: Record<string, unknown>,
  env: WalkVerbEnv
): Promise<WalkVerbResult> {
  if (typeof args.walkId !== 'string' || args.walkId.length === 0) return bad('walkId is required.')
  if (typeof args.checkId !== 'string' || args.checkId.length === 0)
    return bad('checkId is required.')
  const common = {
    walkId: args.walkId,
    checkId: args.checkId,
    ...(typeof args.runId === 'string' ? { runId: args.runId } : {})
  }
  if (args.kind === 'correction') {
    if (typeof args.text !== 'string') return bad('a correction needs its text.')
    const res = await env.service.report({ ...common, kind: 'correction', text: args.text })
    return { ...res, op: 'walk_report' }
  }
  if (args.kind !== undefined && args.kind !== 'check') return bad('kind is check or correction.')
  if (args.result !== 'pass' && args.result !== 'fail')
    return bad('a check report needs result: pass or fail.')
  if (typeof args.evidence !== 'string') return bad('a check report needs its evidence.')
  const res = await env.service.report({
    ...common,
    kind: 'check',
    result: args.result,
    evidence: args.evidence
  })
  return { ...res, op: 'walk_report' }
}

/** `walk_get { folder, walkId }` or `{ folder, source }`: the read to make after a compaction. */
export async function walkGet(
  args: Record<string, unknown>,
  env: WalkVerbEnv
): Promise<WalkVerbResult> {
  const hasId = typeof args.walkId === 'string' && args.walkId.length > 0
  const hasSource = args.source !== undefined
  if (hasId === hasSource) return bad('send walkId or source, not both and not neither.')
  const res = hasId
    ? await env.service.get({ walkId: args.walkId as string })
    : await env.service.getBySource({ source: args.source })
  return { ...res, op: 'walk_get' }
}
