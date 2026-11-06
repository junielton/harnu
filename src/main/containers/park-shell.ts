/**
 * Imperative shell of the pause executor (autonomous cleanup U3.4): the real `docker` calls behind
 * {@link pauseStack} and behind the restore facts a stop or removal journals. No decision logic
 * lives here; `park-core.ts` owns every rule.
 *
 * env-bound (`child_process`) ⇒ e2e-only per ADR-0001.
 */

import { composeConfigArgs, composeFactsFor, parseComposeConfig } from './park-core'
import { runDocker } from './containers-shell'
import type { HintFacts } from './containers-journal'
import type { StackRow } from './containers-wire'

/** A `compose down` waits out each container's grace period; the config probe is quick. */
const PAUSE_OPTS = { windowsHide: true, timeout: 180_000, maxBuffer: 4 << 20 } as const

/** Runs `docker <args>` for the pause executor. Rejects on a non-zero exit. */
export function pauseRun(args: readonly string[]): Promise<{ stdout: string }> {
  return runDocker(args, PAUSE_OPTS)
}

/**
 * What `docker compose config` knows about how a stack starts — the profiles of its running
 * services and whether a restored service builds — for the restore hint of a stop or a removal.
 * Null for a standalone container, an unknown directory, or a config compose cannot read: the hint
 * then carries only what the labels say.
 */
export async function readRestoreFacts(stack: StackRow): Promise<HintFacts | null> {
  const workingDir = stack.attribution.path
  if (stack.kind !== 'compose' || !workingDir) return null
  const base = {
    project: stack.project,
    workingDir,
    configFiles: stack.compose?.configFiles ?? [],
    envFile: stack.compose?.envFile ?? null
  }
  try {
    const { stdout } = await pauseRun(composeConfigArgs(base))
    const services = parseComposeConfig(stdout)
    if (!services) return null
    const facts = composeFactsFor({
      ...base,
      services,
      runningServices: stack.containers.flatMap((c) => (c.service ? [c.service] : []))
    })
    return {
      configFiles: facts.configFiles,
      profiles: facts.profiles,
      envFile: facts.envFile,
      hasBuild: facts.hasBuild
    }
  } catch {
    return null
  }
}
