/**
 * Guided walks: settling the mission criteria a closed run answered (T787, amends spec D-2, V-12 and M-3).
 *
 * This is the ONE place in `src/main/walk/` that reaches the operator's door `markCriterion`, and only the
 * app calls it: no MCP verb gains a way to settle a criterion (NG-4 and AC-9 stay true). It runs once, when a
 * mission-source run goes from not `ended` to `ended`, and settles a criterion only when two independent
 * signals agree: the operator's Done and the agent's own read-only check ({@link planSettle}).
 *
 * What it never settles: a `session` criterion (a second session's, through `mission_settle_ac`), a `person`
 * one (someone else's approval), a `fact` one (Harnu reads it), one already settled, and anything of a closed
 * or removed mission. A failed write leaves that criterion open as a Mark done link; the run ends regardless.
 */
import { repoRoot } from '../data-dir'
import { markCriterion } from '../missions/doors'
import type { AcceptanceCriterion, MissionV4 } from '../missions/model'
import { readMissionRecord } from '../missions/record-store'
import type { Run } from '../../shared/walk-machine'
import type { WalkScript } from '../../shared/walk-schema'
import { planSettle } from '../../shared/walk-settle'

/** The step a source's criterion belongs to: inside the source's own scope first, else only when unique. */
function stepOf(
  record: MissionV4,
  source: Extract<WalkScript['source'], { kind: 'mission' }>,
  criterionId: string
): { stepId: string; criterion: AcceptanceCriterion } | null {
  const has = (s: MissionV4['steps'][number]): AcceptanceCriterion | undefined =>
    s.acs.find((a) => a.id === criterionId)
  const inScope = record.steps.filter((s) =>
    source.scope === 'step'
      ? s.id === source.id
      : source.scope === 'milestone'
        ? s.milestone === source.id
        : true
  )
  const found = (steps: MissionV4['steps']): { stepId: string; criterion: AcceptanceCriterion }[] =>
    steps.flatMap((s) => {
      const c = has(s)
      return c ? [{ stepId: s.id, criterion: c }] : []
    })
  const scoped = found(inScope)
  if (scoped.length === 1) return scoped[0]
  if (scoped.length > 1) return null
  const anywhere = found(record.steps)
  return anywhere.length === 1 ? anywhere[0] : null
}

/**
 * Settle what the ended `run` of `walk` verified. Returns the ids of the criteria it settled (empty for any
 * other source, a closed or missing mission, or when no check closed on two signals).
 */
export async function settleRunEnd(
  folder: string,
  walk: { walkId: string; script: WalkScript },
  runId: string,
  run: Run
): Promise<string[]> {
  const src = walk.script.source
  if (src.kind !== 'mission') return []
  const answers = walk.script.checks.flatMap((c) =>
    c.criterion ? [{ checkId: c.id, criterionId: c.criterion }] : []
  )
  const plan = planSettle(run, answers)
  if (plan.length === 0) return []

  const root = repoRoot(folder)
  const read = await readMissionRecord(root, src.missionId).catch(() => null)
  if (!read || !read.ok || read.record.status === 'closed') return []

  const settled: string[] = []
  for (const p of plan) {
    const at = stepOf(read.record, src, p.criterionId)
    // an operator criterion only, and one nobody settled yet; a fact is Harnu's to read
    if (!at || at.criterion.by !== 'operator' || at.criterion.settled) continue
    const res = await markCriterion(root, src.missionId, {
      stepId: at.stepId,
      criterionId: p.criterionId,
      evidence: p.evidence,
      via: { walkId: walk.walkId, runId, checkId: p.checkId }
    }).catch(() => null)
    if (res?.ok && res.changed) settled.push(p.criterionId)
  }
  return settled
}
