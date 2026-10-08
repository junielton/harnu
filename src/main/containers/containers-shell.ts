/**
 * Imperative shell of the Containers feature: the ONLY file that spawns
 * `docker` (ADR-0014 §2). It gathers what docker reports, what Harnu knows
 * about its folders and sessions, and what git says about each attributed
 * path, and hands all of it to the pure `containers-core.ts`. No decision
 * logic lives here.
 *
 * env-bound (`child_process` + `node:fs` + the fleet model) ⇒ e2e-only per
 * ADR-0001; every parser it relies on is unit-tested in the core.
 */

import { execFile, type ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { spawnEnvOnce } from '../appimage-env'
import { getFleetFolders } from '../fleet-model'
import { readUserProjects } from '../user-projects'
import { getTaskStates } from '../hook-bridge'
import { liveSessionKeys } from '../pty'
import {
  COMPOSE_WORKING_DIR_LABEL,
  attributedPaths,
  buildSnapshot,
  harnuStopTimes,
  parseDfVolumes,
  parseEchoedIds,
  parseGitDirs,
  parseInspect,
  parseStats,
  statProvesGone,
  summarizeDockerError,
  unavailableSnapshot,
  type GitCheckout,
  type InspectedContainer,
  type KnownFolder
} from './containers-core'
import { bucketLookup } from '../gc/gc-buckets'
import type { DockerBatchResult } from './containers-actions'
import type { ContainersSnapshot, Tombstone } from './containers-wire'

const execFileAsync = promisify(execFile)

/** Every docker command carries a timeout and a buffer bound. */
const PROBE_OPTS = { windowsHide: true, timeout: 10_000, maxBuffer: 1 << 20 } as const
/** `inspect`, `stats` and `system df -v` can be slow and large with many containers (PRD §9). */
const SCAN_OPTS = { windowsHide: true, timeout: 90_000, maxBuffer: 64 << 20 } as const
/** A stop waits out each container's grace period; compose stacks stop in parallel. */
const ACT_OPTS = { windowsHide: true, timeout: 180_000, maxBuffer: 4 << 20 } as const
/** One `git rev-parse` per attributed path. */
const GIT_OPTS = { windowsHide: true, timeout: 10_000, maxBuffer: 1 << 20 } as const

/** Ids per `docker inspect` call, so argv stays well under any platform limit. */
const INSPECT_CHUNK = 100
const GIT_CONCURRENCY = 8
const RECENT_LIMIT = 50

/**
 * Spawns a tool with the user's login-shell PATH (BUG-34): a Dock-launched
 * macOS build inherits launchd's minimal PATH, where a bare `docker` is ENOENT.
 */
async function runTool(
  file: 'docker' | 'git',
  args: readonly string[],
  opts: Omit<ExecFileOptions, 'env'>
): Promise<{ stdout: string }> {
  return execFileAsync(file, [...args], {
    ...opts,
    encoding: 'utf8',
    env: await spawnEnvOnce()
  })
}

export function runDocker(
  args: readonly string[],
  opts: Omit<ExecFileOptions, 'env'>
): Promise<{ stdout: string }> {
  return runTool('docker', args, opts)
}

/**
 * Git's answer for each attributed path: main checkout or linked worktree.
 * Null — not a repo, git missing, a timeout — reads as "unproven", which the
 * core classifies protected: a failed probe can never make a zombie.
 */
async function gitCheckouts(paths: readonly string[]): Promise<Map<string, GitCheckout | null>> {
  const out = new Map<string, GitCheckout | null>()
  for (let i = 0; i < paths.length; i += GIT_CONCURRENCY) {
    await Promise.all(
      paths.slice(i, i + GIT_CONCURRENCY).map(async (p) => {
        try {
          const { stdout } = await runTool(
            'git',
            ['-C', p, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
            GIT_OPTS
          )
          out.set(p, parseGitDirs(stdout))
        } catch {
          out.set(p, null)
        }
      })
    )
  }
  return out
}

/** Stdout of a failed docker call, when it produced any (a partial result). */
function stdoutOf(err: unknown): string {
  const out = (err as { stdout?: unknown } | null)?.stdout
  return typeof out === 'string' ? out : ''
}

/** Null when the daemon answers; otherwise the one-line reason it doesn't. */
async function probeDocker(): Promise<string | null> {
  try {
    await runDocker(['version', '--format', '{{.Server.Version}}'], PROBE_OPTS)
    return null
  } catch (err) {
    return summarizeDockerError(err)
  }
}

/**
 * Every container on the machine, inspected. By default a failed `docker inspect` chunk is
 * tolerated and its survivors kept (the Containers scan relies on that). With `strict` the
 * error is rethrown instead: the listing is then incomplete, and a caller that must not act
 * on a partial picture has to treat it as unknown.
 */
export async function inspectAll(opts: { strict?: boolean } = {}): Promise<InspectedContainer[]> {
  const { stdout } = await runDocker(['ps', '-aq', '--no-trunc'], SCAN_OPTS)
  const ids = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const out: InspectedContainer[] = []
  for (let i = 0; i < ids.length; i += INSPECT_CHUNK) {
    const chunk = ids.slice(i, i + INSPECT_CHUNK)
    try {
      out.push(...parseInspect((await runDocker(['inspect', ...chunk], SCAN_OPTS)).stdout))
    } catch (err) {
      if (opts.strict) throw err
      // A container removed between `ps` and `inspect` fails the call, but
      // docker still prints the ones it found.
      out.push(...parseInspect(stdoutOf(err)))
    }
  }
  return out
}

async function memoryById(): Promise<Map<string, number>> {
  try {
    const { stdout } = await runDocker(
      ['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}'],
      SCAN_OPTS
    )
    return parseStats(stdout)
  } catch {
    return new Map() // RAM unmeasured: rows show no figure rather than a wrong one
  }
}

async function volumeFacts(): Promise<ReturnType<typeof parseDfVolumes>> {
  try {
    const { stdout } = await runDocker(
      ['system', 'df', '-v', '--format', '{{json .Volumes}}'],
      SCAN_OPTS
    )
    return parseDfVolumes(stdout)
  } catch {
    return new Map()
  }
}

// ---- Harnu's folders and sessions ------------------------------------------------

function sessionActivityAt(s: { fileMtime?: number; modified?: string }): number | null {
  const times = [s.fileMtime ?? 0, Date.parse(s.modified ?? '') || 0].filter((t) => t > 0)
  return times.length > 0 ? Math.max(...times) : null
}

/**
 * Every folder Harnu knows (fleet + pinned), with its last session activity and
 * its live session. No git meta: main vs worktree is asked of git per
 * attributed path ({@link gitCheckouts}), not per folder. "Live" is Reaper's `computeLiveFolders`
 * predicate (PRD §3.3): `working` or `needs-input`, with a running PTY.
 */
async function knownFolders(): Promise<KnownFolder[]> {
  const [fleet, pinned] = await Promise.all([getFleetFolders(), readUserProjects()])
  const taskStates = getTaskStates()
  const live = liveSessionKeys()
  const byPath = new Map<string, KnownFolder>()

  for (const f of fleet) {
    let lastActivityAt: number | null = null
    let liveSessionId: string | null = null
    for (const s of f.sessions) {
      const at = sessionActivityAt(s)
      if (at !== null && (lastActivityAt === null || at > lastActivityAt)) lastActivityAt = at
      const state = taskStates.get(s.sessionId)
      if (
        !liveSessionId &&
        (state === 'working' || state === 'needs-input') &&
        live.has(s.sessionId)
      ) {
        liveSessionId = s.sessionId
      }
    }
    byPath.set(f.path, { path: f.path, lastActivityAt, liveSessionId })
  }
  for (const p of pinned.projects) {
    if (!byPath.has(p.path)) {
      byPath.set(p.path, { path: p.path, lastActivityAt: null, liveSessionId: null })
    }
  }
  return [...byPath.values()]
}

async function existingPaths(paths: Iterable<string>): Promise<Set<string>> {
  const out = new Set<string>()
  await Promise.all(
    [...new Set(paths)].map(async (p) => {
      try {
        await fs.stat(p)
        out.add(p)
      } catch (err) {
        // Only a missing entry is gone; an unreadable path stays unproven.
        if (!statProvesGone(err)) out.add(p)
      }
    })
  )
  return out
}

// ---- the scan ---------------------------------------------------------------------

export interface ScanRequest {
  zombieAfterDays: number
  /** The whole journal, newest first: `recent[]` and the "Harnu stopped it" clock rule. */
  journal: Tombstone[]
  now: number
}

/** One full scan. Never throws: a docker failure is an unavailable snapshot. */
export async function scanContainers(req: ScanRequest): Promise<ContainersSnapshot> {
  const recent = req.journal.slice(0, RECENT_LIMIT)
  const dockerError = await probeDocker()
  if (dockerError) return unavailableSnapshot(dockerError, req.now, req.zombieAfterDays, recent)

  let containers: InspectedContainer[]
  try {
    containers = await inspectAll()
  } catch (err) {
    return unavailableSnapshot(summarizeDockerError(err), req.now, req.zombieAfterDays, recent)
  }
  const [memById, volumes, folders] = await Promise.all([
    memoryById(),
    volumeFacts(),
    knownFolders()
  ])
  const candidates = [
    ...folders.map((f) => f.path),
    ...containers.flatMap((c) => c.labels[COMPOSE_WORKING_DIR_LABEL] ?? [])
  ]
  const existing = await existingPaths(candidates)
  const attributed = attributedPaths(containers, folders, process.platform).filter((p) =>
    existing.has(p)
  )
  const checkouts = await gitCheckouts(attributed)
  // Real locations of the folders stacks are attributed to, for the GC bucket feed, which is
  // keyed on real paths. A folder that does not resolve is looked up as written.
  const realOf = new Map<string, string>()
  await Promise.all(
    attributed.map(async (p) => {
      try {
        realOf.set(p, await fs.realpath(p))
      } catch {
        // looked up by its spelling
      }
    })
  )

  return buildSnapshot({
    containers,
    memById,
    volumes,
    folders,
    pathExists: (p) => existing.has(p),
    gitCheckout: (p) => checkouts.get(p) ?? null,
    harnuStoppedAt: harnuStopTimes(req.journal),
    now: req.now,
    zombieAfterDays: req.zombieAfterDays,
    recent,
    platform: process.platform,
    // The last GC snapshot's bucket: a worktree stack reads zombie as soon as its branch is dead.
    inheritedBucketOf: bucketLookup(realOf)
  })
}

// ---- actions --------------------------------------------------------------------

async function batch(args: readonly string[], targets: string[]): Promise<DockerBatchResult> {
  if (targets.length === 0) return { done: [], error: null }
  try {
    const { stdout } = await runDocker([...args, ...targets], ACT_OPTS)
    return { done: parseEchoedIds(stdout, targets), error: null }
  } catch (err) {
    return { done: parseEchoedIds(stdoutOf(err), targets), error: summarizeDockerError(err) }
  }
}

/** The docker half of the action function's deps. None of them ever passes `--force`. */
export const dockerActions = {
  stop: (ids: string[]): Promise<DockerBatchResult> => batch(['stop'], ids),
  start: (ids: string[]): Promise<DockerBatchResult> => batch(['start'], ids),
  removeContainers: (ids: string[]): Promise<DockerBatchResult> => batch(['rm'], ids),
  removeVolumes: (names: string[]): Promise<DockerBatchResult> => batch(['volume', 'rm'], names)
}
