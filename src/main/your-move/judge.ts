/**
 * Runs the isolated Haiku judge: one `claude -p` child per attempt.
 *
 * Not `runHaiku`: that helper passes the prompt in argv, runs from the home directory and
 * has no isolation flags. The judge reads untrusted segment text, so it gets no tools, no
 * settings, no MCP and no project files around it (cwd is an empty directory), and the
 * prompt travels on stdin. Concurrency is capped at half the cores and the children run at
 * low priority: the operator keeps working while it runs.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import * as os from 'node:os'
import type { Verdict } from './core'
import { buildJudgeArgs, judgeConcurrency, parseVerdict } from './gate'

export type JudgeOutcome =
  | { ok: true; verdict: Verdict; costUsd: number; durationMs: number }
  | { ok: false; reason: string }

export interface JudgeRunner {
  run(input: string): Promise<JudgeOutcome>
  /** Kill live children and refuse new work (app quit). */
  closeAll(): void
}

const ATTEMPTS = 3
const ATTEMPT_TIMEOUT_MS = 120_000
const RETRY_DELAY_MS = 4_000

export function createJudgeRunner(deps: {
  binary: () => Promise<string>
  gatePath: string
  emptyDir: string
  env: NodeJS.ProcessEnv
  cores: number
  delay?: (ms: number) => Promise<void>
}): JudgeRunner {
  const limit = judgeConcurrency(deps.cores)
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const children = new Set<ChildProcess>()
  const waiters: (() => void)[] = []
  let active = 0
  let closed = false

  async function acquire(): Promise<void> {
    if (active < limit) {
      active++
      return
    }
    await new Promise<void>((resolve) => waiters.push(resolve))
  }

  function release(): void {
    const next = waiters.shift()
    if (next)
      next() // the slot passes straight to the next waiter
    else active--
  }

  async function attempt(input: string): Promise<JudgeOutcome> {
    const started = Date.now()
    let bin: string
    try {
      bin = await deps.binary()
    } catch (e) {
      return { ok: false, reason: `claude binary not found: ${(e as Error).message}` }
    }
    return new Promise<JudgeOutcome>((resolve) => {
      let settled = false
      const finish = (o: JudgeOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(o)
      }
      let child: ChildProcess
      try {
        child = spawn(bin, buildJudgeArgs(deps.gatePath), {
          cwd: deps.emptyDir,
          env: {
            ...deps.env,
            CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'
          },
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (e) {
        resolve({ ok: false, reason: `spawn failed: ${(e as Error).message}` })
        return
      }
      children.add(child)
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ ok: false, reason: 'timeout' })
      }, ATTEMPT_TIMEOUT_MS)
      try {
        if (child.pid !== undefined) os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW)
      } catch {
        /* priority is a courtesy */
      }
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
      child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-500)))
      child.stdin?.on('error', () => undefined) // EPIPE when the child dies early
      child.on('error', (e) => {
        children.delete(child)
        finish({ ok: false, reason: `spawn failed: ${e.message}` })
      })
      child.on('close', (code) => {
        children.delete(child)
        const parsed = parseVerdict(stdout)
        if (parsed.ok) {
          finish({
            ok: true,
            verdict: parsed.verdict,
            costUsd: parsed.costUsd,
            durationMs: Date.now() - started
          })
        } else {
          finish({
            ok: false,
            reason: code === 0 ? parsed.reason : `exit ${code}: ${stderr.trim() || parsed.reason}`
          })
        }
      })
      child.stdin?.end(input)
    })
  }

  return {
    async run(input) {
      if (closed) return { ok: false, reason: 'judge closed' }
      await acquire()
      try {
        let last: JudgeOutcome = { ok: false, reason: 'no attempt' }
        for (let n = 1; n <= ATTEMPTS; n++) {
          if (closed) return { ok: false, reason: 'judge closed' }
          last = await attempt(input)
          if (last.ok) return last
          if (n < ATTEMPTS) await delay(RETRY_DELAY_MS * n)
        }
        return last
      } finally {
        release()
      }
    },
    closeAll() {
      closed = true
      for (const c of children) c.kill('SIGKILL')
      children.clear()
    }
  }
}
