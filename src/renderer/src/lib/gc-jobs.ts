// Pure reduction of the workspace-GC job events (`gc:jobs`, `gc:progress`, `gc:done`) into what the
// Cleanup screen draws: the hero's progress chip, each block's busy/done/failed state, the footer
// pill and the completion toast. No DOM, no Vue — unit-tested in tests/gc-jobs.test.ts.

import type { GcItemResult, GcJobDone, GcJobInfo, GcJobProgress } from '../../../main/gc/gc-wire'
import type { GcStep } from '../../../main/gc/pipeline-core'

/** The engine's reason for refusing an item whose facts moved after the operator confirmed. */
export const CHANGED_SINCE_CONFIRM = 'changed-since-confirm'

export interface JobView {
  jobId: string
  kind: 'manual' | 'autopilot'
  state: 'queued' | 'running' | 'done'
  done: number
  total: number
  freedBytes: number
  current: string | null
  results: GcItemResult[]
  error: string | null
}

export interface JobsState {
  jobs: Record<string, JobView>
}

export const emptyJobs = (): JobsState => ({ jobs: {} })

const finished = (j: JobView | undefined): boolean => j?.state === 'done'

function put(s: JobsState, job: JobView): JobsState {
  return { jobs: { ...s.jobs, [job.jobId]: job } }
}

/** Re-attach after the view or the renderer reloaded: `gc:jobs` is the truth for live jobs. */
export function attachJobs(s: JobsState, infos: readonly GcJobInfo[]): JobsState {
  let next = s
  for (const i of infos) {
    // A done event already landed here; a stale `running` row must not reopen it.
    if (finished(next.jobs[i.jobId]) && i.state !== 'done') continue
    next = put(next, { ...i, results: [...i.results] })
  }
  return next
}

export function applyProgress(s: JobsState, p: GcJobProgress): JobsState {
  const prev = s.jobs[p.jobId]
  if (finished(prev)) return s
  return put(s, {
    jobId: p.jobId,
    kind: prev?.kind ?? 'manual',
    state: 'running',
    done: p.done,
    total: p.total,
    freedBytes: p.freedBytes,
    current: p.current,
    results: [...p.results],
    error: null
  })
}

export function applyDone(s: JobsState, d: GcJobDone): JobsState {
  return put(s, {
    jobId: d.jobId,
    kind: d.kind,
    state: 'done',
    done: d.done,
    total: d.total,
    freedBytes: d.freedBytes,
    current: null,
    results: [...d.results],
    error: d.error
  })
}

/** Forget ended jobs, once the snapshot has been refreshed and their blocks are back (or gone). */
export function dropFinished(s: JobsState): JobsState {
  const jobs: Record<string, JobView> = {}
  for (const [id, j] of Object.entries(s.jobs)) if (!finished(j)) jobs[id] = j
  return { jobs }
}

/** The job the chip shows: one that runs, else the first that waits. */
export function runningJob(
  s: JobsState
): { jobId: string; done: number; total: number; freedBytes: number } | null {
  const live = Object.values(s.jobs).filter((j) => j.state !== 'done')
  const j = live.find((x) => x.state === 'running') ?? live[0]
  return j ? { jobId: j.jobId, done: j.done, total: j.total, freedBytes: j.freedBytes } : null
}

export type BlockJobState = 'busy' | 'done' | 'failed'

/** Per block: the item in flight is busy, finished ones done or failed. Queued blocks are untouched. */
export function blockStates(s: JobsState): Map<string, BlockJobState> {
  const out = new Map<string, BlockJobState>()
  for (const j of Object.values(s.jobs)) {
    for (const r of j.results) out.set(r.id, r.ok ? 'done' : 'failed')
    if (j.state === 'running' && j.current) out.set(j.current, 'busy')
  }
  return out
}

export interface DoneSummary {
  tone: 'success' | 'warning' | 'none'
  cleaned: number
  failed: number
  freedBytes: number
  changedSinceConfirm: number
}

const isChangedSinceConfirm = (r: GcItemResult): boolean =>
  !r.ok && (r.error ?? '').includes(CHANGED_SINCE_CONFIRM)

export function doneSummary(d: GcJobDone): DoneSummary {
  const cleaned = d.results.filter((r) => r.ok).length
  const failed = d.results.length - cleaned
  const changedSinceConfirm = d.results.filter(isChangedSinceConfirm).length
  let tone: DoneSummary['tone'] = 'success'
  if (failed > 0 || d.error) tone = 'warning'
  else if (d.results.length === 0 && d.freedBytes === 0) tone = 'none'
  return { tone, cleaned, failed, freedBytes: d.freedBytes, changedSinceConfirm }
}

export interface ItemFailure {
  step: GcStep | null
  error: string
  changedSinceConfirm: boolean
}

export function failureFor(s: JobsState, id: string): ItemFailure | null {
  for (const j of Object.values(s.jobs)) {
    const r = j.results.find((x) => x.id === id && !x.ok)
    if (r) {
      return {
        step: r.haltedAt,
        error: r.error ?? '',
        changedSinceConfirm: isChangedSinceConfirm(r)
      }
    }
  }
  return null
}

/** The pipeline order (design: workspace-gc §4), without the pre-flight and the bookkeeping steps. */
export const PIPELINE_STEPS: readonly GcStep[] = [
  'stop-stack',
  'rm-containers',
  'rm-volumes',
  'archive',
  'drop-deps',
  'trash',
  'prune',
  'branch-delete'
]

export interface StepRow {
  step: GcStep
  state: 'ok' | 'failed' | 'todo'
}

/** What ran before the halt, what failed, and what never started. Empty when the step is unknown. */
export function stepProgress(haltedAt: GcStep | null): StepRow[] {
  if (!haltedAt) return []
  const at = PIPELINE_STEPS.indexOf(haltedAt)
  // A halt in the pre-flight reprobe means nothing destructive ran.
  return PIPELINE_STEPS.map((step, i) => ({
    step,
    state: at === -1 ? 'todo' : i < at ? 'ok' : i === at ? 'failed' : 'todo'
  }))
}

export type PillState =
  | { kind: 'running'; done: number; total: number }
  | { kind: 'attention'; count: number }
  | { kind: 'idle' }

export function pillState(s: JobsState, needsYou: number): PillState {
  const r = runningJob(s)
  if (r) return { kind: 'running', done: r.done, total: r.total }
  if (needsYou > 0) return { kind: 'attention', count: needsYou }
  return { kind: 'idle' }
}
