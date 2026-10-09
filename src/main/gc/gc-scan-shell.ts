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
  listAllWorktreePaths,
  listLockedWorktreePaths
} from '../reaper/scanner-shell'
import { inspectAll, runDocker } from '../containers/containers-shell'
import { journalFile, readJournal as readContainersJournal } from '../containers/containers-journal'
import {
  COMPOSE_WORKING_DIR_LABEL,
  attributionRung,
  groupStacks,
  harnuStopTimes,
  normalizePath,
  parseDfVolumes,
  type InspectedContainer,
  type KnownFolder,
  type VolumeFact
} from '../containers/containers-core'
import {
  buildBundles,
  containerFolderPaths,
  staleReleases,
  withDockerBlind,
  type CanonicalPath
} from './bundle-core'
import {
  dockerDaemonDown,
  dockerIsUnavailable,
  findForeignCheckouts,
  resolveRealPaths
} from './gc-shell'
import { collectForeignCheckouts, explainFailedWalks } from './gc-foreign'
import { lockedItemIds } from './gc-locked'
import { sessionsFromFleet } from './gc-sessions'
import {
  attributeBySlug,
  fsTranscriptProbe,
  mergeActivityFolders,
  scanTranscripts,
  withGraceUnknown
} from './gc-transcripts'
import {
  buildDirExists,
  foldersForBundles,
  existenceCandidates,
  hiddenWhenCandidates,
  orphanVolumeItems,
  toHousekeepingVolumes,
  volumeGuards,
  type OrphanVolumeItem
} from './gc-housekeeping-input'
import { planHousekeeping } from './housekeeping-core'
import { scanProjectFiles, type FsProbe, type ProjectFile } from './gc-project-files'
import {
  NO_DOCKER_CARD,
  dockerCardFacts,
  withOrphanVolumesHidden,
  type GcDockerCard
} from './gc-docker-card'
import type { GcGather } from './gc-cycle'
import { judgeKeeps, type StaleKeep } from './gc-keep'
import type { GcPrefs } from './gc-prefs'

/** A gather plus what only the snapshot needs. */
export interface GcGathered extends GcGather {
  scannedAt: number
  /** Real paths of everything the bundles were built from; the Containers feed is keyed on them. */
  canonical: CanonicalPath
  df: Map<string, VolumeFact>
  /** False when docker was absent or down, so `df` and the container list say nothing. */
  dockerAvailable: boolean
  /** The Docker card's figures; null inside when docker could not answer. */
  docker: GcDockerCard
  orphanVolumes: OrphanVolumeItem[]
  /** Keep marks whose branch fate has changed since; the caller clears them from the prefs. */
  staleKeeps: StaleKeep[]
  /** Releases whose bundle is gone or no longer strongly merged; the caller clears them. */
  staleReleases: string[]
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
/** The filesystem as the project-file walk sees it: names, kinds, and small text files only. */
const fsProbe: FsProbe = {
  readdir: async (dir) =>
    (await fs.readdir(dir, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isDir: e.isDirectory()
    })),
  readFile: readSmall
}

/** Files and whether a cap cut the scan short: `truncated` fails closed downstream. */
async function scanFolder(p: string): Promise<{ files: ProjectFile[]; truncated: boolean }> {
  const scanned = await scanProjectFiles(p, fsProbe)
  return { files: scanned.files, truncated: scanned.truncated }
}

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
  /** The CLI is there but the daemon did not answer: what is "none" here was really "unseen". */
  blind: boolean
}> {
  try {
    const containers = await inspectAll({ strict: true })
    return { containers, df: await strictVolumeFacts(), available: true, blind: false }
  } catch (err) {
    if (dockerIsUnavailable(err)) {
      return { containers: [], df: new Map(), available: false, blind: dockerDaemonDown(err) }
    }
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

/** The tip each release was made at; a mark that recorded none is left out and never applies. */
function releasedTipsOf(prefs: GcPrefs): Map<string, string> {
  const tips = new Map<string, string>()
  for (const [id, from] of Object.entries(prefs.releasedFrom)) {
    if (from.localTip) tips.set(id, from.localTip)
  }
  return tips
}

/** The folders among `paths` that are gone. An unreadable one is not gone: it stays. */
async function missingFolders(paths: readonly string[]): Promise<Set<string>> {
  const gone = new Set<string>()
  await Promise.all(
    [...new Set(paths)].map(async (p) => {
      try {
        await fs.stat(p)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') gone.add(p)
      }
    })
  )
  return gone
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

  const [{ containers, df, available, blind }, sets, fleet, known, journal, lockedPaths] =
    await Promise.all([
      dockerPicture(),
      computeFolderSets(),
      getFleetFolders(),
      everyKnownFolder(repoPaths, itemPaths),
      readContainersJournal(journalFile(app.getPath('userData'))),
      listLockedWorktreePaths(repoPaths)
    ])

  // Sessions on real paths: the folders of every running session and every item are read
  // through their real locations, so a session reached through a symlink still counts.
  // Every folder of the transcript index, whoever wrote it (a headless `claude -p` run, a
  // Scheduler worker, a legacy index gone stale), so grace counts any terminal under the
  // worktree, outside Harnu included, and a session parked a while ago.
  const transcripts = await scanTranscripts(fsTranscriptProbe(), Date.now())
  // A transcript whose folder cannot be told still tells something: its project slug. It counts
  // for every worktree that slug could belong to, as either spelling of the path.
  const slugCandidates =
    transcripts.bySlug.length === 0
      ? []
      : [...itemPaths, ...(await Promise.all(itemPaths.map((p) => fs.realpath(p).catch(() => p))))]
  const activity = mergeActivityFolders(
    mergeActivityFolders(fleet, transcripts.folders),
    attributeBySlug(transcripts.bySlug, slugCandidates)
  )
  const sessionCanonical = await resolveRealPaths(
    [...itemPaths, ...activity.map((f) => f.path), ...sets.live, ...sets.inUse],
    (p) => fs.realpath(p)
  )
  const sessions = sessionsFromFleet(activity, sets, sessionCanonical)

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
        compose: await readComposeFile(p),
        // Subfolders too: docker/compose.yml pins a project just as the root one does.
        ...(await scanFolder(p))
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
      ...guards.knownFolders,
      ...lockedPaths
    ],
    (p) => fs.realpath(p)
  )

  // Is another checkout (a worktree of another repo, a plain clone) hiding inside a worktree?
  // One walk per worktree on its real path; a walk that fails leaves the worktree out of the
  // answers, so it can never be ready, and its cause is named in the review reason.
  const foreign = await collectForeignCheckouts(items, canonical, (p) => findForeignCheckouts(p))

  // Only folders that cannot pose as a worktree nested in a bundle (see foldersForBundles).
  const bundleFolders = foldersForBundles(guards.knownFolders, itemPaths, repoPaths)

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
    knownFolders: bundleFolders,
    protectedProjects: guards.protectedProjects,
    canonical,
    foreignCheckouts: foreign.found,
    released: new Map(Object.entries(prefs.released)),
    releasedTips: releasedTipsOf(prefs),
    // Git's own lock: such a worktree cannot be unregistered, so it is review, not ready.
    locked: lockedItemIds(items, lockedPaths, canonical, process.platform)
  }
  // A Keep mark holds only while the fate it was made under still holds: judge the fates
  // first, then rebuild with the marks that are still valid.
  let bundles = buildBundles({ ...input, keep: new Set() })
  const { keep, stale: staleKeeps } = judgeKeeps(bundles, prefs.keep)
  if (keep.size > 0) bundles = buildBundles({ ...input, keep })
  bundles = explainFailedWalks(bundles, foreign.failed)
  // An unreadable transcripts root says nothing about recent activity: nothing is ready.
  if (transcripts.rootUnreadable) bundles = withGraceUnknown(bundles)
  // A daemon that was down at this scan says nothing about the stacks: no bundle was judged on them.
  if (blind) bundles = withDockerBlind(bundles)

  // A release is dropped only when its bundle is in this gather and no longer strongly merged,
  // so a branch that reopens does not come back pre-released. A gather that cannot see the
  // bundle (app start, before the first scan) leaves the mark alone.
  // The cleaned case also needs the disk: only the folders of marks whose bundle is absent
  // from a repo that WAS scanned are looked at, and only "not found" counts as gone.
  const scannedRepos = new Set(repoPaths.map((p) => normalizePath(p, process.platform)))
  const inGather = new Set(bundles.map((b) => b.item.id))
  const missingPaths = await missingFolders(
    Object.keys(prefs.released).flatMap((id) => {
      const from = prefs.releasedFrom[id]
      const scanned = from && scannedRepos.has(normalizePath(from.repoPath, process.platform))
      return from && scanned && !inGather.has(id) ? [from.path] : []
    })
  )
  const staleReleaseIds = staleReleases(bundles, prefs.released, {
    scannedRepos,
    from: prefs.releasedFrom,
    missingPaths
  })
  const volumes = toHousekeepingVolumes(df)
  const housekeeping = {
    volumes,
    containers,
    dirExists,
    knownFolders: known,
    protectedProjects: guards.protectedProjects,
    rememberedDirs,
    protectAllProjects: guards.unresolved
  }
  const orphanNames = planHousekeeping(
    { cacheMaxAgeDays: 0, danglingImages: false, orphanVolumes: true },
    volumes,
    containers,
    dirExists,
    known,
    guards.protectedProjects,
    rememberedDirs,
    guards.unresolved
  ).orphanVolumes

  return {
    bundles,
    housekeeping,
    scannedAt: now,
    canonical,
    df,
    dockerAvailable: available,
    // With docker absent there are no volumes to hide, so the card carries no explanation.
    docker: available
      ? withOrphanVolumesHidden(docker, hiddenWhenCandidates(guards.hidden, volumes, containers))
      : docker,
    orphanVolumes: orphanVolumeItems(orphanNames, df),
    staleKeeps,
    staleReleases: staleReleaseIds
  }
}
