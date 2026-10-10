// Pure reduction of the workspace-GC job events (`gc:jobs`, `gc:progress`, `gc:done`) into what the
// Cleanup screen draws: the hero's progress chip, each block's busy/done/failed state, the footer
// pill and the completion toast. No DOM, no Vue — unit-tested in tests/gc-jobs.test.ts.

import type { GcItemResult, GcJobDone, GcJobInfo, GcJobProgress } from '../../../main/gc/gc-wire'
import type { GcStep } from '../../../main/gc/pipeline-core'

/** The engine's reason for refusing an item whose facts moved after the operator confirmed. */
export const CHANGED_SINCE_CONFIRM = 'changed-since-confirm'

/**
 * Every reason the engine gives for not cleaning an item, as the result's `error`: the up-front refusals of
 * `gc:clean` (`gc-manual.ts`, `refusalFor`), the pre-flight re-probe's reasons (`gc-shell.ts`
 * `reprobe`, halted at `reprobe`, nothing changed) and the one the pipeline reports mid-run
 * (`changed-mid-run`, where earlier steps may already have run). Each has a human sentence in the
 * catalog, so a raw code is never shown. `unknown-item` is a refresh away: the id is not in the gather.
 */
export const REFUSAL_CODES = [
  // up front, from gc:clean
  'changed-since-confirm',
  'work-changed-since-confirm',
  'work-unreadable',
  'needs-confirmation',
  'missing-expected',
  'no-longer-orphan',
  'kept',
  'never-clean',
  'main-checkout',
  'in-use',
  'unsupported-kind',
  'unknown-item',
  // the pre-flight re-probe
  'tip-unknown',
  'protected-now',
  'changed-since-scan',
  'grace-not-elapsed',
  'not-ready',
  'path-unresolved',
  'stack-present',
  'docker-unavailable',
  'scan-blind',
  'probe-failed',
  'nested-worktree',
  'check-failed',
  'shared-stack',
  'head-moved',
  'not-harvestable',
  'session-open',
  'unpushed',
  'volume-in-use',
  'dirty',
  'foreign-checkout',
  'cannot-unregister',
  // mid-run
  'changed-mid-run'
] as const
export type RefusalCode = (typeof REFUSAL_CODES)[number]

/** The refusal code of a failed result, or null when it failed for another reason (a step error). */
export function refusalOf(r: Pick<GcItemResult, 'ok' | 'error'>): RefusalCode | null {
  if (r.ok) return null
  const error = (r.error ?? '').trim()
  // `probe-failed: <message>` and `cannot-unregister: <message>` carry the engine's text after the code;
  // the code is what is known.
  const code = error.split(':')[0].trim()
  return REFUSAL_CODES.find((c) => c === code) ?? null
}

/** Refusals that are the operator's own settings: they are not something that needs the operator. */
const OWN_CHOICE: ReadonlySet<RefusalCode> = new Set(['kept', 'never-clean'])

/** Whether a failed item still needs the operator: everything except their own `kept` / `never-clean`. */
export function needsAction(refusal: RefusalCode | null): boolean {
  return refusal === null || !OWN_CHOICE.has(refusal)
}

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
  /** Failed items that were refused up front, by code. */
  refusals: Partial<Record<RefusalCode, number>>
  /** How many items were refused (any code). */
  refused: number
}

export function doneSummary(d: GcJobDone): DoneSummary {
  const cleaned = d.results.filter((r) => r.ok).length
  const failed = d.results.length - cleaned
  const refusals: DoneSummary['refusals'] = {}
  for (const r of d.results) {
    const code = refusalOf(r)
    if (code) refusals[code] = (refusals[code] ?? 0) + 1
  }
  const refused = Object.values(refusals).reduce((a, n) => a + (n ?? 0), 0)
  let tone: DoneSummary['tone'] = 'success'
  if (failed > 0 || d.error) tone = 'warning'
  else if (d.results.length === 0 && d.freedBytes === 0) tone = 'none'
  return { tone, cleaned, failed, freedBytes: d.freedBytes, refusals, refused }
}

export interface ItemFailure {
  step: GcStep | null
  error: string
  /** Set when the item was refused before anything ran. */
  refusal: RefusalCode | null
}

export function failureFor(s: JobsState, id: string): ItemFailure | null {
  for (const j of Object.values(s.jobs)) {
    const r = j.results.find((x) => x.id === id && !x.ok)
    if (r) {
      return {
        step: r.haltedAt,
        error: r.error ?? '',
        refusal: refusalOf(r)
      }
    }
  }
  return null
}

/**
 * Where an item stopped, from what the engine reported and nothing else. The engine tells us ONE step and
 * why — not which steps before it ran — so this never reconstructs a history: no "✓ archive", and no volume
 * step at all (a worktree clean never removes a volume).
 *
 * - `refused`: halted at the pre-flight re-probe with a code the catalog knows. Nothing was changed.
 * - `stopped`: halted at a pipeline step (`refusal` set when the reason is a known code, e.g.
 *   `changed-mid-run`; earlier steps may have run, so this is never "nothing was changed").
 * - `unknown`: no step reported.
 */
export type Halt =
  | { kind: 'refused'; refusal: RefusalCode }
  | { kind: 'unchanged'; reason: string }
  | { kind: 'stopped'; step: GcStep; error: string; refusal: RefusalCode | null }
  | { kind: 'unknown'; error: string }

export function haltOf(f: ItemFailure): Halt {
  if (f.step === 'reprobe') {
    return f.refusal
      ? { kind: 'refused', refusal: f.refusal }
      : { kind: 'unchanged', reason: f.error }
  }
  if (f.step) return { kind: 'stopped', step: f.step, error: f.error, refusal: f.refusal }
  return { kind: 'unknown', error: f.error }
}

export type PillState =
  | { kind: 'running'; done: number; total: number }
  | { kind: 'attention'; count: number }
  | { kind: 'idle' }

export function pillState(s: JobsState, needsReview: number): PillState {
  const r = runningJob(s)
  if (r) return { kind: 'running', done: r.done, total: r.total }
  if (needsReview > 0) return { kind: 'attention', count: needsReview }
  return { kind: 'idle' }
}
