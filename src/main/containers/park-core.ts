/**
 * Pure core of the pause ("park") executor (autonomous cleanup U3.4): reading `docker compose
 * config`, the rules that keep a stack out of an unattended pause, and the `down` argv. No I/O and
 * no Electron: the shell (`park-shell.ts`) hands in what docker said.
 *
 * Which stacks to pause, and when, is the policy (U3.5). This file is the action: bring a stack
 * down without touching its volumes, and record everything needed to bring it back.
 */

import type { InspectedContainer } from './containers-core'
import type { ComposeRestoreFacts, Verdict } from './containers-wire'

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
