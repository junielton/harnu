/**
 * Imperative shell of Docker housekeeping (T442): runs each argv the pure
 * `housekeeping-core.ts` planned, one at a time and independently, so a failed
 * command never stops the rest. Bytes of a failed command count as 0 and its
 * one-line reason lands in `errors`.
 *
 * env-bound (`docker` via the Containers shell) ⇒ e2e-only per ADR-0001,
 * except the injectable `deps.run` path, which the unit test covers.
 */

import { summarizeDockerError } from '../containers/containers-core'
import {
  housekeepingArgv,
  parseReclaimed,
  type HousekeepingPlan,
  type HousekeepingResult
} from './housekeeping-core'

export interface HousekeepingDeps {
  /** Runs one docker invocation (argv without the leading `docker`). */
  run: (argv: readonly string[]) => Promise<{ stdout: string }>
  /** Size of each planned volume, when the caller knows it; `volume rm` prints none. */
  volumeBytes?: ReadonlyMap<string, number | null>
}

/** A prune can run for minutes on a large cache. */
const HOUSEKEEPING_OPTS = { windowsHide: true, timeout: 600_000, maxBuffer: 4 << 20 } as const

/** Imported lazily so unit tests never load the Electron-bound scan shell. */
async function dockerRun(argv: readonly string[]): Promise<{ stdout: string }> {
  const { runDocker } = await import('../containers/containers-shell')
  return runDocker(argv, HOUSEKEEPING_OPTS)
}

export async function runHousekeeping(
  plan: HousekeepingPlan,
  deps: HousekeepingDeps = { run: dockerRun }
): Promise<HousekeepingResult> {
  const result: HousekeepingResult = {
    buildCacheBytes: 0,
    imageBytes: 0,
    volumeBytes: 0,
    errors: []
  }
  for (const argv of housekeepingArgv(plan)) {
    try {
      const { stdout } = await deps.run(argv)
      if (argv[0] === 'builder') result.buildCacheBytes += parseReclaimed(stdout)
      else if (argv[0] === 'image') result.imageBytes += parseReclaimed(stdout)
      else result.volumeBytes += deps.volumeBytes?.get(argv[2]) ?? 0
    } catch (err) {
      result.errors.push(`docker ${argv.join(' ')}: ${summarizeDockerError(err)}`)
    }
  }
  return result
}
