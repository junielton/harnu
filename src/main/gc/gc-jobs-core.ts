// Serial background-job queue for workspace-GC cleaning (design: workspace-gc §4, operator
// decision "manual clean is a background job"). Pure bookkeeping around an injected `run`:
// `submit` returns a job id at once, jobs run one at a time in submission order, and every
// item streams a progress event before one terminal done event. The autopilot cycle goes
// through the same queue, so a manual clean during a cycle waits instead of running beside it.

import type { GcItemResult } from './pipeline-core'

export type JobKind = 'manual' | 'autopilot'
export type JobState = 'queued' | 'running' | 'done'

/** Streamed on `gc:progress` after each finished item. */
export interface GcJobProgress {
  jobId: string
  done: number
  total: number
  freedBytes: number
  /** The item that runs next, or null after the last one. */
  current: string | null
  /** Every result so far, oldest first. */
  results: GcItemResult[]
}

/** Streamed once on `gc:done` when a job ends, however it ended. */
export interface GcJobDone {
  jobId: string
  kind: JobKind
  done: number
  total: number
  freedBytes: number
  results: GcItemResult[]
  /** Set when the run threw; the results so far are still reported. */
  error: string | null
}

/** One row of `gc:jobs`, enough for a reloaded renderer to re-attach. */
export interface GcJobInfo {
  jobId: string
  kind: JobKind
  state: JobState
  done: number
  total: number
  freedBytes: number
  /** The item in flight (running) or next (between items); null when not running. */
  current: string | null
  results: GcItemResult[]
  error: string | null
}

/** What a run calls as it works. */
export interface JobReporter {
  onStart(id: string): void
  onItem(result: GcItemResult): void
}

export interface JobQueueDeps {
  newId(): string
  emitProgress(p: GcJobProgress): void
  emitDone(d: GcJobDone): void
  /** Awaited before each job starts, inside `around` when there is one. */
  beforeRun?(): Promise<void>
  /**
   * Wraps the whole of a job (`beforeRun` and the run). gc-ipc passes the Reaper's op chain,
   * so a cleaning job and a Reaper sweep or dehydrate never run destructive work at once.
   */
  around?(work: () => Promise<void>): Promise<void>
}

export interface JobQueue {
  /** Returns at once; `finished` resolves (never rejects) when the job ends. */
  submit(
    kind: JobKind,
    ids: readonly string[],
    run: (reporter: JobReporter) => Promise<GcItemResult[]>
  ): { jobId: string; finished: Promise<GcJobDone> }
  jobs(): GcJobInfo[]
  /** True while a job runs or waits. */
  busy(): boolean
  /** Resolves once nothing runs or waits. */
  idle(): Promise<void>
}

const HISTORY = 5

interface Job extends GcJobInfo {
  ids: readonly string[]
  run: (reporter: JobReporter) => Promise<GcItemResult[]>
  settle: (d: GcJobDone) => void
}

const sumFreed = (results: readonly GcItemResult[]): number =>
  results.reduce((sum, r) => sum + r.freedBytes, 0)

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createJobQueue(deps: JobQueueDeps): JobQueue {
  const waiting: Job[] = []
  const history: Job[] = []
  let running: Job | null = null
  let idleWaiters: Array<() => void> = []

  const info = (j: Job): GcJobInfo => ({
    jobId: j.jobId,
    kind: j.kind,
    state: j.state,
    done: j.done,
    total: j.total,
    freedBytes: j.freedBytes,
    current: j.state === 'running' ? j.current : null,
    results: [...j.results],
    error: j.error
  })

  const execute = async (job: Job): Promise<void> => {
    const reporter: JobReporter = {
      onStart: (id) => {
        job.current = id
      },
      onItem: (result) => {
        job.results.push(result)
        job.done = job.results.length
        job.freedBytes = sumFreed(job.results)
        job.current = job.ids[job.done] ?? null
        deps.emitProgress({
          jobId: job.jobId,
          done: job.done,
          total: job.total,
          freedBytes: job.freedBytes,
          current: job.current,
          results: [...job.results]
        })
      }
    }
    const work = async (): Promise<void> => {
      await deps.beforeRun?.()
      await job.run(reporter)
    }
    try {
      await (deps.around ? deps.around(work) : work())
    } catch (err) {
      job.error = messageOf(err)
    }
    job.state = 'done'
    job.current = null
    const done: GcJobDone = {
      jobId: job.jobId,
      kind: job.kind,
      done: job.done,
      total: job.total,
      freedBytes: job.freedBytes,
      results: [...job.results],
      error: job.error
    }
    history.push(job)
    while (history.length > HISTORY) history.shift()
    deps.emitDone(done)
    job.settle(done)
  }

  const pump = (): void => {
    if (running) return
    const next = waiting.shift()
    if (!next) {
      const waiters = idleWaiters
      idleWaiters = []
      for (const w of waiters) w()
      return
    }
    running = next
    next.state = 'running'
    void execute(next).finally(() => {
      running = null
      pump()
    })
  }

  return {
    submit(kind, ids, run) {
      let settle!: (d: GcJobDone) => void
      const finished = new Promise<GcJobDone>((resolve) => {
        settle = resolve
      })
      const job: Job = {
        jobId: deps.newId(),
        kind,
        state: 'queued',
        done: 0,
        total: ids.length,
        freedBytes: 0,
        current: null,
        results: [],
        error: null,
        ids,
        run,
        settle
      }
      waiting.push(job)
      pump()
      return { jobId: job.jobId, finished }
    },
    jobs: () => [...(running ? [running] : []), ...waiting, ...history].map(info),
    busy: () => running !== null || waiting.length > 0,
    idle: () =>
      running === null && waiting.length === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => idleWaiters.push(resolve))
  }
}
