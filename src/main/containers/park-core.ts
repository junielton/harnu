/**
 * Pure core of the pause ("park") executor (autonomous cleanup U3.4): reading `docker compose
 * config`, the rules that keep a stack out of an unattended pause, and the `down` argv. No I/O and
 * no Electron: the shell (`park-shell.ts`) hands in what docker said.
 *
 * Which stacks to pause, and when, is the policy (U3.5). This file is the action: bring a stack
 * down without touching its volumes, and record everything needed to bring it back.
 */

import { parseInspect, summarizeDockerError, type InspectedContainer } from './containers-core'
import { composeUpCommand } from './containers-journal'
import type {
  Actor,
  ComposeRestoreFacts,
  ContainersSnapshot,
  PausedRecord,
  StackRow,
  Tombstone,
  Verdict
} from './containers-wire'

// ---- docker compose config ---------------------------------------------------------

/** A service as `docker compose config --format json` reports it, reduced to what a restore needs. */
export interface ComposeService {
  profiles: string[]
  /** True when the service has a `build:` section. */
  build: boolean
}

export type ComposeServices = Record<string, ComposeService>

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * Parses `docker compose config --format json`. Null for anything that is not a services map: a
 * restore command built from a guess would be worse than none, so the caller must refuse.
 */
export function parseComposeConfig(stdout: string): ComposeServices | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const services = asRecord(asRecord(parsed)?.services)
  if (!services) return null
  const out: ComposeServices = {}
  for (const [name, raw] of Object.entries(services)) {
    const svc = asRecord(raw)
    const profiles = svc?.profiles
    out[name] = {
      profiles: Array.isArray(profiles)
        ? profiles.filter((p): p is string => typeof p === 'string')
        : [],
      build: svc?.build !== undefined && svc.build !== null
    }
  }
  return out
}

/**
 * The facts a restore command needs. The profiles are the ones the running services belong to; the
 * restored set is every service without a profile plus the ones in an active profile, and
 * `--build` is needed when any of THEM builds.
 */
export function composeFactsFor(args: {
  project: string | null
  workingDir: string
  configFiles: readonly string[]
  envFile: string | null
  services: ComposeServices
  runningServices: readonly string[]
}): ComposeRestoreFacts {
  const running = new Set(args.runningServices)
  const active = new Set<string>()
  for (const [name, svc] of Object.entries(args.services)) {
    if (running.has(name)) for (const p of svc.profiles) active.add(p)
  }
  const restored = Object.values(args.services).filter(
    (svc) => svc.profiles.length === 0 || svc.profiles.some((p) => active.has(p))
  )
  return {
    project: args.project,
    workingDir: args.workingDir,
    configFiles: [...args.configFiles],
    profiles: [...active].sort(),
    envFile: args.envFile,
    hasBuild: restored.some((svc) => svc.build)
  }
}

/**
 * `docker compose … config --format json` for a stack, with every profile switched on so the
 * services of inactive profiles are listed too. Global flags come before the subcommand.
 */
export function composeConfigArgs(f: {
  project: string | null
  workingDir: string
  configFiles: readonly string[]
  envFile: string | null
}): string[] {
  return [
    'compose',
    ...(f.project ? ['-p', f.project] : []),
    '--project-directory',
    f.workingDir,
    ...f.configFiles.flatMap((file) => ['-f', file]),
    ...(f.envFile ? ['--env-file', f.envFile] : []),
    '--profile',
    '*',
    'config',
    '--format',
    'json'
  ]
}

/**
 * `docker compose -p P --project-directory WD [-f F]… down` (spec §4 U3 "Park"). Never `-v`,
 * `--volumes` or `--rmi`: a pause removes containers and the network, nothing else. Profiles need
 * no flag here — `down` removes a project's containers of every profile.
 */
export function pauseDownArgs(facts: ComposeRestoreFacts): string[] {
  return [
    'compose',
    ...(facts.project ? ['-p', facts.project] : []),
    '--project-directory',
    facts.workingDir,
    ...facts.configFiles.flatMap((file) => ['-f', file]),
    'down'
  ]
}

// ---- what may be paused -------------------------------------------------------------

/**
 * Only an idle stack of a worktree: `zombie` (past the threshold) and `pending` (idle, not yet a
 * zombie). `unknown` and `protected` are never touched; `active` has a working session; `orphan`
 * has lost its directory, which `compose down` needs and the restore command points at.
 */
export function isPausableVerdict(verdict: Verdict): boolean {
  return verdict === 'zombie' || verdict === 'pending'
}

/**
 * Database images and the paths they keep their data on (spec §4 U3 "Park"). One list: a stack that
 * runs one of these with no mount on its data path keeps its data in the container layer, which
 * `compose down` deletes. Includes the common `bitnami` layouts.
 */
export const DATABASE_IMAGES: Readonly<Record<string, readonly string[]>> = {
  postgres: ['/var/lib/postgresql/data', '/bitnami/postgresql'],
  postgresql: ['/var/lib/postgresql/data', '/bitnami/postgresql'],
  mysql: ['/var/lib/mysql', '/bitnami/mysql'],
  mariadb: ['/var/lib/mysql', '/bitnami/mariadb'],
  mongo: ['/data/db', '/bitnami/mongodb'],
  mongodb: ['/data/db', '/bitnami/mongodb'],
  redis: ['/data', '/bitnami/redis/data'],
  elasticsearch: ['/usr/share/elasticsearch/data', '/bitnami/elasticsearch'],
  opensearch: ['/usr/share/opensearch/data'],
  rabbitmq: ['/var/lib/rabbitmq', '/bitnami/rabbitmq']
}

/** `docker.io/library/postgres:16@sha256:…` → `postgres`. */
function imageName(image: string): string {
  const last = image.split('/').pop() ?? image
  return (last.split('@')[0] ?? last).split(':')[0] ?? last
}

const ANONYMOUS_VOLUME = /^[0-9a-f]{64}$/

/** True when `dest` is `dataPath`, a parent of it, or a path inside it. */
function covers(dest: string, dataPath: string): boolean {
  const d = dest.replace(/\/+$/, '')
  return d === dataPath || dataPath.startsWith(`${d}/`) || d.startsWith(`${dataPath}/`)
}

/**
 * Why this stack must not be paused without the operator's say-so, or null when it may be. Two
 * shapes: a container with an anonymous volume (docker names it with a bare 64-hex id and nothing
 * else refers to it), or a database image with no volume or bind mount on its data path. Autonomous
 * pausing never touches either.
 */
export function confirmOnlyReason(containers: readonly InspectedContainer[]): string | null {
  for (const c of containers) {
    if (c.mounts.some((m) => m.type === 'volume' && m.name && ANONYMOUS_VOLUME.test(m.name))) {
      return `${c.name} mounts an anonymous volume`
    }
    const dataPaths = DATABASE_IMAGES[imageName(c.image)]
    if (!dataPaths) continue
    const kept = c.mounts.some((m) =>
      dataPaths.some((p) => m.destination && covers(m.destination, p))
    )
    if (!kept) return `${c.name} runs ${c.image}, a database, with no volume on its data path`
  }
  return null
}

// ---- the executor -------------------------------------------------------------------

/** What the planner decided on (U3.5): the stack, the exact containers and the verdict it saw. */
export interface PauseDecision {
  stack: string
  containerIds: string[]
  verdict: Verdict
  /**
   * How long the planner saw the stack idle ("idle 3 h"), for the journal's one-sentence reason. Not
   * a fact the pause is bound to: the re-probe never compares it.
   */
  idle?: string
}

export interface PauseDeps {
  /** A scan started after the call arrived: the pause is judged on a fresh picture. */
  scan(): Promise<ContainersSnapshot>
  /** Runs `docker <args>` (no shell); rejects on a non-zero exit. */
  run(args: readonly string[]): Promise<{ stdout: string }>
  appendTombstone(t: Tombstone): Promise<void>
  now(): number
}

export type PauseCode =
  | 'DOCKER_UNAVAILABLE'
  | 'STACK_NOT_FOUND'
  | 'NOT_COMPOSE'
  | 'CHANGED_SINCE_DECIDED'
  | 'NOT_PAUSABLE'
  | 'CONFIRM_ONLY'
  | 'CONFIG_UNREADABLE'
  | 'DOWN_FAILED'
  | 'JOURNAL_FAILED'

export type PauseOutcome =
  | { ok: true; outcome: 'paused'; record: PausedRecord; tombstone: Tombstone }
  | {
      ok: false
      /** `refused`: nothing ran. `confirm-required`: nothing ran, and only the operator may pause it. */
      outcome: 'refused' | 'confirm-required' | 'failed'
      code: PauseCode
      message: string
      /** Present when the stack is down but could not be journaled: the way back is still here. */
      record?: PausedRecord
    }

function refuse(code: PauseCode, message: string): PauseOutcome {
  return { ok: false, outcome: 'refused', code, message }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((id, i) => id === right[i])
}

/** "Paused `x` — idle 3 h · bring back: `cmd`": the line the digest and the Activity feed read. */
function pauseReason(name: string, idle: string | undefined, restoreCommand: string): string {
  return `Paused \`${name}\`${idle ? ` — ${idle}` : ''} · bring back: \`${restoreCommand}\``
}

const CHANGED = 'the stack changed since decided; nothing was paused'

/**
 * Brings one compose stack down — containers and network, never its volumes — and journals how to
 * bring it back. The decision is bound to the facts it was made on (spec §5): the stack is
 * re-probed right before acting and any difference refuses with "changed since decided".
 *
 * Order: fresh scan → same stack, same containers, same verdict, a pausable verdict → `docker
 * inspect` for the confirm-only rules → `docker compose config` for the restore facts → `down` →
 * one `stop` tombstone carrying the {@link PausedRecord}. Nothing runs `down` until every earlier
 * step has passed, so a refusal never leaves a half-paused stack.
 *
 * A stack that is down but unjournaled returns `JOURNAL_FAILED` with its record: the restore
 * command is never lost silently.
 */
export async function pauseStack(
  decision: PauseDecision,
  actor: Actor,
  deps: PauseDeps
): Promise<PauseOutcome> {
  const snap = await deps.scan()
  if (!snap.dockerAvailable) return refuse('DOCKER_UNAVAILABLE', snap.dockerError)

  const stack: StackRow | undefined = snap.stacks.find((s) => s.id === decision.stack)
  if (!stack) return refuse('STACK_NOT_FOUND', 'no such stack in the current scan')
  if (stack.kind !== 'compose') {
    return refuse('NOT_COMPOSE', 'only a compose stack can be paused')
  }
  if (
    !sameIds(
      decision.containerIds,
      stack.containers.map((c) => c.id)
    ) ||
    stack.verdict !== decision.verdict
  ) {
    return refuse('CHANGED_SINCE_DECIDED', CHANGED)
  }
  const workingDir = stack.attribution.path
  if (!isPausableVerdict(stack.verdict) || !workingDir) {
    return refuse('NOT_PAUSABLE', `a ${stack.verdict} stack is never paused`)
  }

  let inspected: InspectedContainer[]
  try {
    inspected = parseInspect((await deps.run(['inspect', ...decision.containerIds])).stdout)
  } catch (err) {
    return refuse('DOCKER_UNAVAILABLE', summarizeDockerError(err))
  }
  if (inspected.length !== decision.containerIds.length) {
    return refuse('CHANGED_SINCE_DECIDED', CHANGED)
  }
  const confirm = confirmOnlyReason(inspected)
  if (confirm) {
    return { ok: false, outcome: 'confirm-required', code: 'CONFIRM_ONLY', message: confirm }
  }

  const base = {
    project: stack.project,
    workingDir,
    configFiles: stack.compose?.configFiles ?? [],
    envFile: stack.compose?.envFile ?? null
  }
  let services: ComposeServices | null
  try {
    const { stdout } = await deps.run(composeConfigArgs(base))
    services = parseComposeConfig(stdout)
  } catch (err) {
    return refuse(
      'CONFIG_UNREADABLE',
      `docker compose config failed, so no restore command can be built: ${summarizeDockerError(err)}`
    )
  }
  if (!services) {
    return refuse(
      'CONFIG_UNREADABLE',
      'docker compose config listed no services; nothing was paused'
    )
  }

  const facts = composeFactsFor({
    ...base,
    services,
    runningServices: stack.containers.flatMap((c) => (c.service ? [c.service] : []))
  })
  const record: PausedRecord = {
    ...facts,
    ports: [...stack.ports].sort((a, b) => a - b),
    restoreCommand: composeUpCommand(facts),
    pausedAt: deps.now()
  }

  try {
    await deps.run(pauseDownArgs(facts))
  } catch (err) {
    return {
      ok: false,
      outcome: 'failed',
      code: 'DOWN_FAILED',
      message: `docker compose down failed: ${summarizeDockerError(err)}`
    }
  }

  const tombstone: Tombstone = {
    at: record.pausedAt,
    actor,
    verb: 'stop',
    stacks: [
      {
        stack: stack.id,
        name: stack.name,
        path: stack.attribution.path,
        containerIds: [...decision.containerIds],
        freed: { ramBytes: stack.ramBytes, ports: record.ports, volumes: [], volumeBytes: 0 },
        paused: record
      }
    ],
    restoreHint: record.restoreCommand,
    // Only Cleanup's own pauses carry a reason; the operator and agent lines stay as they were.
    ...(actor === 'autopilot'
      ? { reason: pauseReason(stack.name, decision.idle, record.restoreCommand) }
      : {})
  }
  try {
    await deps.appendTombstone(tombstone)
  } catch (err) {
    return {
      ok: false,
      outcome: 'failed',
      code: 'JOURNAL_FAILED',
      message: `the stack is paused but the journal write failed: ${err instanceof Error ? err.message : String(err)}`,
      record
    }
  }
  return { ok: true, outcome: 'paused', record, tombstone }
}
