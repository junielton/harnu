/**
 * Runs the isolated Haiku calls: one `claude -p` child per attempt.
 *
 * Two kinds of call share one runner and one concurrency cap: `detect` (the frozen gate v1
 * prompt: is anything waiting on the operator?) and `enrich` (a second prompt that completes
 * the candidates the detector found). Not `runHaiku`: that helper passes the prompt in argv,
 * runs from the home directory and has no isolation flags. These calls read untrusted segment
 * text, so they get no tools, no settings, no MCP and no project files around them (cwd is an
 * empty directory), and the prompt travels on stdin. Concurrency is capped at half the cores
 * and the children run at low priority: the operator keeps working while they run.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import * as os from 'node:os'
import type { Verdict } from './core'
import {
  buildJudgeArgs,
  judgeConcurrency,
  parseEnrichment,
  parseVerdict,
  type EnrichedCard
} from './gate'

export type JudgeOutcome =
  | { ok: true; verdict: Verdict; costUsd: number; durationMs: number }
  | { ok: false; reason: string }

export type EnrichOutcome =
  | { ok: true; cards: EnrichedCard[]; costUsd: number; durationMs: number }
  | { ok: false; reason: string }

export interface JudgeRunner {
  detect(input: string): Promise<JudgeOutcome>
  enrich(input: string): Promise<EnrichOutcome>
  /** Kill live children and refuse new work (app quit). */
  closeAll(): void
}

const ATTEMPTS = 3
const ATTEMPT_TIMEOUT_MS = 120_000
const RETRY_DELAY_MS = 4_000

type Parsed<T> = { ok: true; value: T; costUsd: number } | { ok: false; reason: string }

export function createJudgeRunner(deps: {
  binary: () => Promise<string>
  detectPath: string
  enrichPath: string
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

  /** One child: stdout on success, a reason on failure. */
  async function attempt(
    input: string,
    promptPath: string
  ): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
    let bin: string
    try {
      bin = await deps.binary()
    } catch (e) {
      return { ok: false, reason: `claude binary not found: ${(e as Error).message}` }
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = (o: { ok: true; stdout: string } | { ok: false; reason: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(o)
      }
      let child: ChildProcess
      try {
        child = spawn(bin, buildJudgeArgs(promptPath), {
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
        finish(
          code === 0 || stdout.trim() !== ''
            ? { ok: true, stdout }
            : { ok: false, reason: `exit ${code}: ${stderr.trim() || 'no output'}` }
        )
      })
      child.stdin?.end(input)
    })
  }

  /** Up to 3 attempts, a growing delay between them, under the shared concurrency cap. */
  async function call<T>(
    input: string,
    promptPath: string,
    parse: (stdout: string) => Parsed<T> | { ok: false; reason: string }
  ): Promise<
    { ok: true; value: T; costUsd: number; durationMs: number } | { ok: false; reason: string }
  > {
    if (closed) return { ok: false, reason: 'judge closed' }
    await acquire()
    try {
      const started = Date.now()
      let last = 'no attempt'
      for (let n = 1; n <= ATTEMPTS; n++) {
        if (closed) return { ok: false, reason: 'judge closed' }
        const out = await attempt(input, promptPath)
        const parsed = out.ok ? parse(out.stdout) : out
        if (parsed.ok) {
          return { ...parsed, durationMs: Date.now() - started }
        }
        last = parsed.reason
        if (n < ATTEMPTS) await delay(RETRY_DELAY_MS * n)
      }
      return { ok: false, reason: last }
    } finally {
      release()
    }
  }

  return {
    async detect(input) {
      const out = await call(input, deps.detectPath, (s) => {
        const p = parseVerdict(s)
        return p.ok ? { ok: true, value: p.verdict, costUsd: p.costUsd } : p
      })
      return out.ok
        ? { ok: true, verdict: out.value, costUsd: out.costUsd, durationMs: out.durationMs }
        : out
    },
    async enrich(input) {
      const out = await call(input, deps.enrichPath, (s) => {
        const p = parseEnrichment(s)
        return p.ok ? { ok: true, value: p.cards, costUsd: p.costUsd } : p
      })
      return out.ok
        ? { ok: true, cards: out.value, costUsd: out.costUsd, durationMs: out.durationMs }
        : out
    },
    closeAll() {
      closed = true
      for (const c of children) c.kill('SIGKILL')
      children.clear()
    }
  }
}
