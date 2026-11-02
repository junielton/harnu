/**
 * T611 U1 — the ONE place Harnu spawns `gh`.
 *
 * Every `gh` call spends the operator's personal GitHub budget, so every call goes through
 * {@link runGh}: it is counted per consumer and per resource (feeds the budget tracker), spawned with
 * the user's login-shell PATH (`spawnEnvOnce`, BUG-34 / BUG-101), refused while the budget is spent
 * (reads only — writes are operator gestures and never throttled, D-6), and a rate-limit error in
 * `gh`'s stderr marks the budget `exhausted` immediately (AC-9) instead of waiting for the next poll.
 *
 * `tests/gh-runner-no-direct-spawn.test.ts` fails on any other `gh` spawn in `src/main`.
 * Spec: docs/specs/2026-11-02-github-rate-limit/spec.md.
 */

import { execFile } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { promisify } from 'node:util'
import { spawnEnvOnce } from './appimage-env'
import { isRateLimitStderr, type GhConsumer, type GhResource } from './github-budget-core'
import { githubBudget } from './github-budget-tracker'

const execFileAsync = promisify(execFile)

export interface GhRunOptions {
  /** Who is spending (the default; {@link withGhConsumer} can re-attribute a whole call tree). */
  consumer: GhConsumer
  /** Which GitHub bucket the call draws from. GraphQL calls count as one point each (D-3). */
  resource: GhResource
  cwd?: string
  timeout?: number
  maxBuffer?: number
  windowsHide?: boolean
  /** Written to the child's stdin (a review body must not travel as an argument). */
  stdin?: string
  /** An operator gesture (review, merge, viewed-state mutation): never throttled. */
  write?: boolean
}

export interface GhResult {
  stdout: string
  stderr: string
}

/** Thrown instead of spawning when the budget is spent and the call is a throttled read. */
export class GhThrottledError extends Error {
  readonly code = 'GH_THROTTLED'
  readonly stderr = 'Harnu paused GitHub reads: the API budget is spent until it resets.'
  readonly stdout = ''
  constructor() {
    super('GH_THROTTLED: the GitHub API budget is spent; serving the last known value.')
    this.name = 'GhThrottledError'
  }
}

export function isGhThrottled(err: unknown): err is GhThrottledError {
  return (
    err instanceof GhThrottledError ||
    (!!err && typeof err === 'object' && (err as { code?: unknown }).code === 'GH_THROTTLED')
  )
}

const consumerScope = new AsyncLocalStorage<GhConsumer>()

/**
 * Attribute every `gh` call made inside `fn` to `consumer`, whatever tag the call site carries.
 * The mission derive is shared by the pill, the steward and the merge batch; the caller that
 * started the work is the one that spent the budget.
 */
export function withGhConsumer<T>(consumer: GhConsumer, fn: () => Promise<T>): Promise<T> {
  return consumerScope.run(consumer, fn)
}

/** Resource of a `gh` invocation, for the generic carriers that receive arbitrary argv. */
export function inferGhResource(args: readonly string[]): GhResource {
  if (args[0] === 'api') return args[1] === 'graphql' ? 'graphql' : 'rest'
  if (args[0] === 'run' || args[0] === 'workflow') return 'rest'
  // `pr`, `repo`, `issue`, `search` … are GraphQL under the hood.
  return 'graphql'
}

/** `gh pr merge|review|comment|close|ready|edit` … are writes: operator gestures. */
export function inferGhWrite(args: readonly string[]): boolean {
  return (
    args[0] === 'pr' && ['merge', 'review', 'comment', 'close', 'ready', 'edit'].includes(args[1])
  )
}

function bookkeep(err: unknown): void {
  const stderr = err && typeof err === 'object' ? (err as { stderr?: unknown }).stderr : ''
  if (typeof stderr === 'string' && isRateLimitStderr(stderr)) githubBudget.markExhausted()
}

/**
 * Run `gh <args>`. Resolves like `execFile` (stdout + stderr as utf8) and rejects like it too: the
 * error carries `code`, `killed`, `signal`, `stdout` and `stderr`, so the existing
 * `classifyGhFailure` callers keep working.
 */
export async function runGh(args: readonly string[], opts: GhRunOptions): Promise<GhResult> {
  if (opts.write !== true && githubBudget.state() === 'exhausted') throw new GhThrottledError()
  const consumer = consumerScope.getStore() ?? opts.consumer
  // Counted when spawned: a call that fails still reached GitHub far enough to be charged.
  githubBudget.record(consumer, opts.resource)
  const env = await spawnEnvOnce()
  const common = {
    cwd: opts.cwd,
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
    windowsHide: opts.windowsHide ?? true,
    encoding: 'utf8' as const,
    env
  }
  try {
    if (opts.stdin === undefined) {
      const { stdout, stderr } = await execFileAsync('gh', [...args], common)
      return { stdout: String(stdout), stderr: String(stderr ?? '') }
    }
    return await new Promise<GhResult>((resolve, reject) => {
      const child = execFile('gh', [...args], common, (err, stdout, stderr) => {
        if (err)
          reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
        else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
      // `gh` can exit before the body is written (bad auth, no such PR): EPIPE on this stream is
      // not the story, the callback above carries the real reason.
      child.stdin?.on('error', () => {})
      child.stdin?.end(opts.stdin)
    })
  } catch (err) {
    bookkeep(err)
    throw err
  }
}

/**
 * `gh api rate_limit`, for the budget poller only. It does not count against GitHub's REST limit,
 * so it is neither counted here nor held back while the budget is spent.
 */
export async function runGhBudgetProbe(timeoutMs = 15_000): Promise<GhResult> {
  const { stdout, stderr } = await execFileAsync('gh', ['api', 'rate_limit'], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1 << 20,
    encoding: 'utf8',
    env: await spawnEnvOnce()
  })
  return { stdout: String(stdout), stderr: String(stderr ?? '') }
}
