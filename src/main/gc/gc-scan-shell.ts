// Gathers everything a GC cycle and the `gc:snapshot` read need (design: workspace-gc §3.1):
// the last Reaper scan, the Docker picture, the sessions per folder and the prefs, joined into
// worktree bundles. It reuses both existing scans and invents no new probing.
//
// env-bound (electron, docker, git, node:fs) ⇒ e2e-only per ADR-0001; every decision it feeds
// is made by the pure cores, which are unit-tested.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { getFleetFolders } from '../fleet-model'
import { readUserProjects } from '../user-projects'
import {
  computeFolderSets,
  lastFateInputs,
  lastSnapshot,
  listAllWorktreePaths
} from '../reaper/scanner-shell'
import { inspectAll, runDocker } from '../containers/containers-shell'
import { journalFile, readJournal as readContainersJournal } from '../containers/containers-journal'
import {
  COMPOSE_WORKING_DIR_LABEL,
  attributionRung,
  groupStacks,
  harnuStopTimes,
  parseDfVolumes,
  type InspectedContainer,
  type KnownFolder,
  type VolumeFact
} from '../containers/containers-core'
import { buildBundles, containerFolderPaths } from './bundle-core'
import { dockerIsUnavailable, resolveRealPaths } from './gc-shell'
import { sessionsFromFleet } from './gc-sessions'
import {
  buildDirExists,
  existenceCandidates,
  orphanVolumeItems,
  toHousekeepingVolumes,
  volumeGuards,
  type OrphanVolumeItem
} from './gc-housekeeping-input'
import { planHousekeeping } from './housekeeping-core'
import { NO_DOCKER_CARD, dockerCardFacts, type GcDockerCard } from './gc-docker-card'
import type { GcGather } from './gc-cycle'
import { judgeKeeps, type StaleKeep } from './gc-keep'
import type { GcPrefs } from './gc-prefs'

/** A gather plus what only the snapshot needs. */
export interface GcGathered extends GcGather {
  scannedAt: number
  df: Map<string, VolumeFact>
  /** False when docker was absent or down, so `df` and the container list say nothing. */
  dockerAvailable: boolean
  /** The Docker card's figures; null inside when docker could not answer. */
  docker: GcDockerCard
  orphanVolumes: OrphanVolumeItem[]
  /** Keep marks whose branch fate has changed since; the caller clears them from the prefs. */
  staleKeeps: StaleKeep[]
}

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']
const SMALL_FILE = 256 * 1024
const DF_OPTS = { windowsHide: true, timeout: 90_000, maxBuffer: 64 << 20 } as const

async function readSmall(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > SMALL_FILE) return undefined
    return await fs.readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/** The compose file a folder would use, read cheaply; the first one that exists wins. */
async function readComposeFile(dir: string): Promise<string | undefined> {
  for (const name of COMPOSE_FILES) {
    const text = await readSmall(path.join(dir, name))
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * `docker system df -v`, strict: a failure throws when docker is up. A missing volume fact
 * would make a volume another compose project created look owned, so "could not read" must
 * stop the gather rather than read as "no facts".
 */
async function strictVolumeFacts(): Promise<Map<string, VolumeFact>> {
  const { stdout } = await runDocker(
    ['system', 'df', '-v', '--format', '{{json .Volumes}}'],
    DF_OPTS
  )
  return parseDfVolumes(stdout)
}

/** Containers and volume facts; both empty when docker is genuinely absent or down. */
async function dockerPicture(): Promise<{
  containers: InspectedContainer[]
  df: Map<string, VolumeFact>
  available: boolean
}> {
  try {
    const containers = await inspectAll({ strict: true })
    return { containers, df: await strictVolumeFacts(), available: true }
  } catch (err) {
    if (dockerIsUnavailable(err)) return { containers: [], df: new Map(), available: false }
    throw err
  }
}

/** Every folder Harnu knows, hidden ones and every worktree of every repo included. */
async function everyKnownFolder(repoPaths: string[], itemPaths: string[]): Promise<string[]> {
  const [fleet, pinned, worktrees] = await Promise.all([
    getFleetFolders(),
    readUserProjects(),
    listAllWorktreePaths(repoPaths)
  ])
  return [
    ...new Set([
      ...fleet.map((f) => f.path),
      ...pinned.projects.map((p) => p.path),
      ...(pinned.hiddenPaths ?? []),
      ...repoPaths,
      ...itemPaths,
      ...worktrees
    ])
  ]
}

export async function gatherGc(
  prefs: GcPrefs,
  now: number,
  /** Compose project → folders a cleaned worktree ran from (gc-leftovers.ts). */
  rememberedDirs: ReadonlyMap<string, readonly string[]> = new Map()
): Promise<GcGathered> {
  const snap = lastSnapshot()
  const items = snap?.repos.flatMap((r) => r.items) ?? []
  const repoPaths = snap?.repos.map((r) => r.repoPath) ?? []
  const itemPaths = items.flatMap((i) => (i.path ? [i.path] : []))

  const [{ containers, df, available }, sets, fleet, known, journal] = await Promise.all([
    dockerPicture(),
    computeFolderSets(),
    getFleetFolders(),
    everyKnownFolder(repoPaths, itemPaths),
    readContainersJournal(journalFile(app.getPath('userData')))
  ])

  // Sessions on real paths: the folders of every running session and every item are read
  // through their real locations, so a session reached through a symlink still counts.
  const sessionCanonical = await resolveRealPaths(
    [...itemPaths, ...fleet.map((f) => f.path), ...sets.live, ...sets.inUse],
    (p) => fs.realpath(p)
  )
  // Every folder of the transcript index, so grace counts any terminal under the worktree,
  // outside Harnu included, and a session parked a while ago.
  const sessions = sessionsFromFleet(fleet, sets, sessionCanonical)

  // Read-only listings for the Docker card; skipped, not guessed, when docker is absent.
  const docker = available
    ? await dockerCardFacts((argv) =>
        runDocker(argv, { windowsHide: true, timeout: 60_000, maxBuffer: 8 << 20 })
      )
    : NO_DOCKER_CARD

  // Housekeeping facts first: the bundle builder needs them too. Existence fails closed and
  // explicit project names come from the files, exactly as for the orphan planner.
  const workingDirs = containers.flatMap((c) => c.labels[COMPOSE_WORKING_DIR_LABEL] ?? [])
  const dirExists = await buildDirExists(
    existenceCandidates({ known, workingDirs, remembered: rememberedDirs }),
    (p) => fs.stat(p)
  )
  const sources = await Promise.all(
    known
      .filter((p) => dirExists(p))
      .map(async (p) => ({
        path: p,
        env: await readSmall(path.join(p, '.env')),
        compose: await readComposeFile(p)
      }))
  )
  const guards = volumeGuards(sources, dirExists)

  const stacks = groupStacks(containers)
  const knownForStacks: KnownFolder[] = itemPaths.map((p) => ({
    path: p,
    lastActivityAt: null,
    liveSessionId: null
  }))
  const stackPaths = new Map<string, string>()
  for (const s of stacks) {
    const { path: attributed } = attributionRung(s.containers, knownForStacks, process.platform)
    if (attributed) stackPaths.set(s.id, attributed)
  }

  // Real paths of everything the bundle builder compares, read once: a symlink or a `..`
  // would otherwise hide that two spellings are the same folder. A path that does not
  // resolve keeps its bundle out of the ready bucket (path-unresolved).
  const canonical = await resolveRealPaths(
    [
      ...itemPaths,
      ...repoPaths,
      ...[...containers, ...stacks.flatMap((s) => s.containers)].flatMap(containerFolderPaths),
      ...sessions.keys(),
      ...stackPaths.values(),
      ...prefs.neverClean,
      ...guards.knownFolders
    ],
    (p) => fs.realpath(p)
  )

  const input = {
    items,
    fateInputs: lastFateInputs(),
    stacks,
    stackPaths,
    containers,
    sessions,
    neverClean: new Set(prefs.neverClean),
    harnuStoppedAt: harnuStopTimes(journal),
    now,
    graceDays: prefs.graceDays,
    volumes: df,
    // A volume is owned only when no other folder may share its project (delta 1, item 1).
    knownFolders: guards.knownFolders,
    protectedProjects: guards.protectedProjects,
    canonical
  }
  // A Keep mark holds only while the fate it was made under still holds: judge the fates
  // first, then rebuild with the marks that are still valid.
  let bundles = buildBundles({ ...input, keep: new Set() })
  const { keep, stale: staleKeeps } = judgeKeeps(bundles, prefs.keep)
  if (keep.size > 0) bundles = buildBundles({ ...input, keep })

  const volumes = toHousekeepingVolumes(df)
  const housekeeping = {
    volumes,
    containers,
    dirExists,
    knownFolders: known,
    protectedProjects: guards.protectedProjects,
    rememberedDirs
  }
  const orphanNames = planHousekeeping(
    { cacheMaxAgeDays: 0, danglingImages: false, orphanVolumes: true },
    volumes,
    containers,
    dirExists,
    known,
    guards.protectedProjects,
    rememberedDirs
  ).orphanVolumes

  return {
    bundles,
    housekeeping,
    scannedAt: now,
    df,
    dockerAvailable: available,
    docker,
    orphanVolumes: orphanVolumeItems(orphanNames, df),
    staleKeeps
  }
}
