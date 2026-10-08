// Runs one headless process for the advisor and always lets go of it: the prompt goes in on stdin,
// stdout comes back, and a process that overruns its time is sent SIGTERM and, if it ignores that,
// SIGKILL after a short grace. The promise settles either way, so a child that traps SIGTERM cannot
// hang the advisor's queue. It starts one process, never retries, and imports nothing from electron.

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

const DEFAULT_GRACE_MS = 5000
const DEFAULT_STDOUT_MAX = 4 << 20

export interface RunSupervisedOptions {
  /** The folder to run in; the OS temp dir when null. */
  cwd: string | null
  env: Record<string, string>
  /** The prompt. Written to the child's stdin, never passed as an argument. */
  stdin: string
  /** After this long the child gets SIGTERM. */
  timeoutMs: number
  /** After SIGTERM, how long before SIGKILL. */
  graceMs?: number
  /** Stdout beyond this is dropped. */
  maxStdout?: number
  /** Called with the child's pid once it started (for tests and diagnostics). */
  onSpawn?(pid: number): void
}

/**
 * Resolves with the child's stdout when it exited 0 with output, and with null on anything else: a
 * non-zero exit, no output, a missing binary, or a timeout (whatever it had printed is discarded).
 */
export function runSupervised(
  cmd: string,
  args: string[],
  o: RunSupervisedOptions
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false
    let timedOut = false
    let stdout = ''
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(termTimer)
      clearTimeout(killTimer)
      resolve(value)
    }

    const child = spawn(cmd, args, {
      cwd: o.cwd ?? tmpdir(),
      env: o.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    if (child.pid !== undefined) o.onSpawn?.(child.pid)

    const cap = o.maxStdout ?? DEFAULT_STDOUT_MAX
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < cap) stdout += d.toString()
    })
    child.stderr?.resume() // drained, never read: a full pipe would stall the child
    child.stdin?.on('error', () => {}) // the child may exit before it reads everything
    child.stdin?.end(o.stdin)

    const termTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(null) // killed: settle even if the exit event never comes
      }, o.graceMs ?? DEFAULT_GRACE_MS)
    }, o.timeoutMs)

    child.on('error', () => finish(null))
    child.on('exit', () => {
      if (timedOut) finish(null)
    })
    child.on('close', (code) => finish(!timedOut && code === 0 && stdout.trim() ? stdout : null))
  })
}
