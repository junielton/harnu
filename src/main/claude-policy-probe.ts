/**
 * The policy probe's one shell (T389 P1W4 §7.6): runs `claude plugin test <staged dir>` at most
 * once per boot and per CLI binary, lazily on the first candidate for "the mod did not say hello"
 * and never on the spawn path, then hands the output to the pure classifier. P4W1 and P4W3 reuse
 * it. Detection is read-only: nothing is retried, re-staged or worked around (SEC-9f), and the
 * output is never logged, only its class.
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { sanitizeSpawnEnv } from './appimage-env'
import { claudeVersionSync, resolveClaudePath } from './claude-cli'
import { classifyPolicyProbe, type PolicyProbeClass } from './claude-policy-probe-core'

const TIMEOUT_MS = 15_000

export interface PolicyProbeDeps {
  /** The staged directory the sessions load, or null when nothing was staged yet. */
  stagedDir(): string | null
  binary(): Promise<string | null>
  /** The CLI version string, so a CLI update re-probes. */
  versionKey(): string
  /** Runs the binary and returns everything it printed; a non-zero exit is NOT an error here. */
  run(bin: string, args: string[]): Promise<string>
  log?(line: string): void
}

export interface PolicyProbe {
  /** The class for the current binary, or null until the probe ran. */
  result(): PolicyProbeClass | null
  /** Single-flight: one run per binary and per boot. */
  ensure(): Promise<PolicyProbeClass | null>
  /** How many times the binary was actually run (LV-P1W4-c reads it). */
  runs(): number
}

export function createPolicyProbe(deps: PolicyProbeDeps): PolicyProbe {
  const done = new Map<string, PolicyProbeClass>()
  let inFlight: { key: string; promise: Promise<PolicyProbeClass | null> } | null = null
  let runs = 0
  const keyOf = (bin: string): string => `${bin}@${deps.versionKey()}`
  let lastKey: string | null = null

  return {
    result: () => (lastKey !== null ? (done.get(lastKey) ?? null) : null),
    runs: () => runs,
    ensure() {
      if (inFlight) return inFlight.promise
      const promise = (async (): Promise<PolicyProbeClass | null> => {
        const dir = deps.stagedDir()
        const bin = await deps.binary()
        if (!dir || !bin) return null
        const key = keyOf(bin)
        lastKey = key
        const known = done.get(key)
        if (known) return known
        runs++
        let output = ''
        try {
          output = await deps.run(bin, ['plugin', 'test', dir])
        } catch {
          output = ''
        }
        const cls = classifyPolicyProbe(output)
        done.set(key, cls)
        deps.log?.(`[companion] policy probe: ${cls}`)
        return cls
      })().finally(() => {
        inFlight = null
      })
      inFlight = { key: 'one', promise }
      return promise
    }
  }
}

function runClaude(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd: homedir(),
        timeout: TIMEOUT_MS,
        maxBuffer: 1 << 20,
        env: sanitizeSpawnEnv(process.env, { execPath: process.execPath })
      },
      // `plugin test` exits 1 when it finds nothing to run: the output is the answer either way.
      (err, stdout, stderr) =>
        resolve(
          String(stdout) + String(stderr) + (err && !stdout && !stderr ? String(err.message) : '')
        )
    )
  })
}

/** The app's one probe; `host.ts` supplies the staged directory. */
export function createAppPolicyProbe(stagedDir: () => string | null): PolicyProbe {
  return createPolicyProbe({
    stagedDir,
    binary: resolveClaudePath,
    versionKey: () => claudeVersionSync()?.raw ?? 'unknown',
    run: runClaude,
    log: (l) => console.info(l)
  })
}
