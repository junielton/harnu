/**
 * Thin shell of the Docker facts (U3.2): runs READ-ONLY docker queries and hands the output to the
 * pure cores (`docker-networks-core`, `docker-capacity-core`, `docker-activity-core`). No decision
 * lives here.
 *
 * Every docker call goes through an injected `DockerRunner`, which is `runDocker` from
 * `containers-shell.ts` in production (it carries the user's login-shell PATH) and a recording fake
 * in tests. The only verbs used are `ps`, `inspect`, `info`, `stats --no-stream`, `network ls|inspect`,
 * `context inspect` and `compose … config`; nothing here starts, stops, removes or creates anything.
 * This file imports no Electron code, so it also runs from a plain Node script.
 */

import { promises as fs } from 'node:fs'
import {
  COMPOSE_PROJECT_LABEL,
  parseInspect,
  summarizeDockerError,
  type InspectedContainer
} from './containers-core'
import {
  computeBridgeCapacity,
  detectEngineKind,
  parseDaemonPools,
  type BridgeCapacity,
  type DockerInfoFacts,
  type EngineFacts
} from './docker-capacity-core'
import {
  DEFAULT_ACTIVITY_THRESHOLDS,
  computeStackActivity,
  parseStatsSample,
  type ActivityThresholds,
  type StackActivity,
  type StatsSample
} from './docker-activity-core'
import {
  composeProjectsOf,
  externalNetworkNamesOf,
  parseNetworkInspect,
  planEmptyComposeNetworks,
  type DockerNetworkFact,
  type EmptyNetworkPlan,
  type ExternalDeclarations
} from './docker-networks-core'

// ---- injection --------------------------------------------------------------------------------

export interface DockerRunOptions {
  windowsHide: true
  timeout: number
  maxBuffer: number
}

/** The shape of `runDocker` in `containers-shell.ts`: pass it straight in. */
export type DockerRunner = (
  args: readonly string[],
  opts: DockerRunOptions
) => Promise<{ stdout: string }>

export interface FactsDeps {
  run: DockerRunner
  /** Text of a file, or null when it does not exist. Other failures throw. */
  readFile?: (path: string) => Promise<string | null>
  fileExists?: (path: string) => Promise<boolean>
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export type DockerFactsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { kind: 'docker-unavailable' | 'failed'; message: string } }

const PROBE: Omit<DockerRunOptions, 'windowsHide'> = { timeout: 10_000, maxBuffer: 1 << 20 }
const SCAN: Omit<DockerRunOptions, 'windowsHide'> = { timeout: 90_000, maxBuffer: 64 << 20 }
const STATS: Omit<DockerRunOptions, 'windowsHide'> = { timeout: 30_000, maxBuffer: 16 << 20 }
const COMPOSE_CONFIG: Omit<DockerRunOptions, 'windowsHide'> = {
  timeout: 30_000,
  maxBuffer: 8 << 20
}

const INSPECT_CHUNK = 100
const COMPOSE_CONCURRENCY = 4
const DAEMON_JSON = '/etc/docker/daemon.json'
const DEFAULT_SAMPLE_GAP_MS = 5_000

async function docker(
  deps: FactsDeps,
  args: readonly string[],
  limits: Omit<DockerRunOptions, 'windowsHide'>
): Promise<string> {
  return (await deps.run(args, { windowsHide: true, ...limits })).stdout
}

const DAEMON_DOWN =
  /cannot connect to the docker daemon|is the docker daemon running|error during connect|permission denied while trying to connect/i

function failure(err: unknown): {
  ok: false
  error: { kind: 'docker-unavailable' | 'failed'; message: string }
} {
  const message = summarizeDockerError(err)
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown } | null
  const haystack = `${typeof e?.stderr === 'string' ? e.stderr : ''} ${typeof e?.message === 'string' ? e.message : ''}`
  const down = e?.code === 'ENOENT' || DAEMON_DOWN.test(haystack)
  return { ok: false, error: { kind: down ? 'docker-unavailable' : 'failed', message } }
}

async function guard<T>(fn: () => Promise<T>): Promise<DockerFactsResult<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return failure(err)
  }
}

const defaultReadFile = async (path: string): Promise<string | null> => {
  try {
    return await fs.readFile(path, 'utf8')
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return null
    throw err
  }
}

const defaultFileExists = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

// ---- inventories --------------------------------------------------------------------------------

function parseIds(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/**
 * Every container (or only the running ones), inspected. Strict: a failed `inspect` chunk throws,
 * because every consumer here would otherwise decide on a partial picture.
 */
export async function listContainers(
  deps: FactsDeps,
  opts: { runningOnly?: boolean } = {}
): Promise<InspectedContainer[]> {
  const ids = parseIds(
    await docker(deps, ['ps', opts.runningOnly ? '-q' : '-aq', '--no-trunc'], SCAN)
  )
  const out: InspectedContainer[] = []
  for (let i = 0; i < ids.length; i += INSPECT_CHUNK) {
    out.push(
      ...parseInspect(await docker(deps, ['inspect', ...ids.slice(i, i + INSPECT_CHUNK)], SCAN))
    )
  }
  return out
}

/** Every docker network, inspected. Strict, like `listContainers`. */
export async function listNetworks(deps: FactsDeps): Promise<DockerNetworkFact[]> {
  const ids = parseIds(await docker(deps, ['network', 'ls', '-q', '--no-trunc'], PROBE))
  const out: DockerNetworkFact[] = []
  for (let i = 0; i < ids.length; i += INSPECT_CHUNK) {
    out.push(
      ...parseNetworkInspect(
        await docker(deps, ['network', 'inspect', ...ids.slice(i, i + INSPECT_CHUNK)], SCAN)
      )
    )
  }
  return out
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// ---- engine -------------------------------------------------------------------------------------

async function engineFacts(deps: FactsDeps): Promise<EngineFacts> {
  const env = deps.env ?? process.env
  const info = JSON.parse(
    await docker(deps, ['info', '--format', '{{json .}}'], PROBE)
  ) as DockerInfoFacts

  let dockerHost: string | null = env.DOCKER_HOST?.trim() || null
  if (dockerHost === null) {
    const host: unknown = JSON.parse(
      await docker(
        deps,
        ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
        PROBE
      )
    )
    dockerHost = typeof host === 'string' && host ? host : null
  }
  return detectEngineKind({ platform: deps.platform ?? process.platform, dockerHost, info })
}

/** Which engine Harnu is talking to, and whether its address pools are readable from here. */
export function readEngineFacts(deps: FactsDeps): Promise<DockerFactsResult<EngineFacts>> {
  return guard(() => engineFacts(deps))
}

// ---- empty compose networks -----------------------------------------------------------------------

async function resolveExternals(
  deps: FactsDeps,
  containers: readonly InspectedContainer[]
): Promise<ExternalDeclarations> {
  const fileExists = deps.fileExists ?? defaultFileExists
  const names = new Set<string>()
  const unresolved: string[] = []

  await mapLimit(composeProjectsOf(containers), COMPOSE_CONCURRENCY, async (ref) => {
    if (ref.configFiles.length === 0) {
      unresolved.push(ref.project)
      return
    }
    const present = await Promise.all(ref.configFiles.map((f) => fileExists(f)))
    // Files gone: nobody can `compose up` this stack, so it declares nothing that can break.
    if (present.every((p) => !p)) return
    if (present.some((p) => !p)) {
      unresolved.push(ref.project)
      return
    }
    try {
      const stdout = await docker(
        deps,
        [
          'compose',
          '--profile',
          '*',
          '-p',
          ref.project,
          ...(ref.workingDir ? ['--project-directory', ref.workingDir] : []),
          ...ref.configFiles.flatMap((f) => ['-f', f]),
          'config',
          '--format',
          'json'
        ],
        COMPOSE_CONFIG
      )
      const external = externalNetworkNamesOf(stdout)
      if (external === null) unresolved.push(ref.project)
      else for (const n of external) names.add(n)
    } catch {
      unresolved.push(ref.project)
    }
  })
  return { names, unresolvedProjects: unresolved.sort() }
}

/**
 * Compose networks with no container attached (running or stopped) and not declared external by
 * any stack on the machine (C8). The compose files are only read when there is a candidate; any
 * stack whose config cannot be resolved holds every candidate back.
 */
export function readEmptyComposeNetworks(
  deps: FactsDeps
): Promise<DockerFactsResult<EmptyNetworkPlan>> {
  return guard(async () => {
    // Networks first: any container attaching to a network in this snapshot already exists by the
    // time containers are read, so a network `compose up` creates mid-scan is never taken for empty.
    const networks = await listNetworks(deps)
    const containers = await listContainers(deps)

    const first = planEmptyComposeNetworks({
      networks,
      containers,
      externals: { names: new Set(), unresolvedProjects: [] }
    })
    if (first.garbage.length === 0) return first

    return planEmptyComposeNetworks({
      networks,
      containers,
      externals: await resolveExternals(deps, containers)
    })
  })
}

// ---- bridge capacity --------------------------------------------------------------------------------

/** `{ total, used, free }` bridge-network slots, or `known: false` with the reason (C11). */
export function readBridgeCapacity(deps: FactsDeps): Promise<DockerFactsResult<BridgeCapacity>> {
  return guard(async () => {
    const engine = await engineFacts(deps)
    if (!engine.capacityKnown) {
      return { known: false, reason: engine.reason ?? 'The engine is not a native Linux engine.' }
    }

    let daemonJson: string | null
    try {
      daemonJson = await (deps.readFile ?? defaultReadFile)(DAEMON_JSON)
    } catch (err) {
      return {
        known: false,
        reason: `Cannot read ${DAEMON_JSON}: ${(err as { message?: string }).message ?? String(err)}`
      }
    }
    const pools = parseDaemonPools(daemonJson)
    if ('error' in pools) return { known: false, reason: pools.error }

    return computeBridgeCapacity({ ...pools, networks: await listNetworks(deps) })
  })
}

// ---- activity ---------------------------------------------------------------------------------------

async function sampleStats(deps: FactsDeps): Promise<StatsSample> {
  const stdout = await docker(
    deps,
    ['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}'],
    STATS
  )
  return parseStatsSample(stdout, (deps.now ?? Date.now)())
}

/**
 * CPU and IO of each running compose stack between two `docker stats --no-stream` samples
 * `sampleGapMs` apart, aggregated by compose project (risk 10: idle session ≠ unused stack).
 */
export function readStackActivity(
  deps: FactsDeps,
  opts: { sampleGapMs?: number; thresholds?: ActivityThresholds } = {}
): Promise<DockerFactsResult<StackActivity[]>> {
  return guard(async () => {
    const running = await listContainers(deps, { runningOnly: true })
    const projectOf = new Map<string, string>()
    for (const c of running) {
      const project = c.labels[COMPOSE_PROJECT_LABEL]
      if (project) projectOf.set(c.id, project)
    }
    if (projectOf.size === 0) return []

    const first = await sampleStats(deps)
    await (deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(
      opts.sampleGapMs ?? DEFAULT_SAMPLE_GAP_MS
    )
    const second = await sampleStats(deps)
    return computeStackActivity({
      first,
      second,
      projectOf,
      thresholds: opts.thresholds ?? DEFAULT_ACTIVITY_THRESHOLDS
    })
  })
}
