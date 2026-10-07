// Pure worktree bundle builder and bucket rules (design: workspace-gc §3–§4).
// A bundle joins one Reaper worktree item with the Docker stacks that run from it and the
// session that works in it, then puts it in exactly one bucket. No I/O — every decision is
// unit-tested in tests/gc-bundle-core.test.ts.

import { resolveDetachedFate, resolveFate, type FateResult } from './fate-core'
import type { BranchFacts, ReapItem } from '../reaper/reaper-core'
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  isInside,
  lastContainerEvent,
  normalizePath,
  type InspectedContainer,
  type StackGroup,
  type VolumeFact
} from '../containers/containers-core'

const DAY_MS = 86_400_000

export type SessionPresence = 'working' | 'needs-input' | 'open-idle' | 'none'
export type Bucket = 'corpse' | 'decide' | 'alive'
export type DecideCode =
  | 'dirty'
  | 'unpushed'
  | 'open-idle-session'
  | 'closed-unmerged'
  | 'remote-gone'
  | 'detached'
  | 'unknown-fate'
  | 'weak-merge-signal'
  | 'shared-stack'
  | 'cleanup-failed'

/** `detail` is one English sentence with the concrete fact; the renderer translates by `code`. */
export interface DecideReason {
  code: DecideCode
  detail: string
}

export interface BundleFacts {
  item: ReapItem
  fate: FateResult
  session: SessionPresence
  lastSignOfLifeAt: number | null
  /** Stacks attributed ONLY to this worktree. */
  stackIds: string[]
  /** Stacks that also run from somewhere outside this worktree. */
  sharedStackIds: string[]
  ownedVolumes: string[]
  depsBytes: number | null
  keep: boolean
  neverClean: boolean
  isMainCheckout: boolean
  /**
   * The local tip the fate was judged on (the checked-out commit for a detached worktree).
   * The reprobe refuses if HEAD moved since, because a strong merge proof covers only this
   * commit. Null or absent when unknown, and then the reprobe refuses (`tip-unknown`).
   */
  localTip?: string | null
  /**
   * The grace window (in days) the bundle was bucketed with. The reprobe re-checks it at
   * execution time, so a bundle without it is never cleaned.
   */
  graceDays?: number
}

export interface WorktreeBundle extends BundleFacts {
  bucket: Bucket
  reason: DecideReason | null
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * The project name Compose gives a folder when none is set: its basename, lowercased, with
 * every character outside [a-z0-9_-] dropped. The S4 housekeeping module has its own copy,
 * which is not reachable from this branch, hence this duplicate.
 */
export function composeDefaultProject(path: string): string {
  const base =
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  return base.toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

/**
 * Named volumes only the bundle's stacks use. A volume that a container outside the bundle
 * also mounts is never listed: removing it would pull data from under a stack we do not own.
 * Bind mounts have no volume name, so they never qualify.
 *
 * With `volumes`, the rule buildSnapshot applies also holds: a volume whose own compose
 * project label differs from the project of a bundle stack mounting it belongs to that other
 * project (declared `external` here), even while that project's containers are down. A
 * missing fact or an unlabelled volume is kept, as buildSnapshot keeps it.
 *
 * A volume's project (its own label, else the project of the bundle stack mounting it) must
 * also be unique to the bundle. It is not when a container outside the bundle, running or
 * stopped, carries that project, nor when the project is the Compose default name of one of
 * `otherFolders`: a main checkout that shares the project and ran `compose down` has no
 * container left, yet the volume is still its data.
 */
export function ownedVolumes(
  bundleStacks: readonly StackGroup[],
  allContainers: readonly InspectedContainer[],
  volumes?: ReadonlyMap<string, VolumeFact>,
  otherFolders: readonly string[] = []
): string[] {
  const inBundle = new Set<string>()
  const projectsOf = new Map<string, Set<string>>()
  const otherProject = new Set<string>()
  for (const s of bundleStacks) {
    for (const c of s.containers) {
      inBundle.add(c.id)
      for (const m of c.mounts) {
        if (m.type !== 'volume' || !m.name) continue
        const projects = projectsOf.get(m.name) ?? new Set<string>()
        projectsOf.set(m.name, projects)
        const project = volumes?.get(m.name)?.project
        if (project != null && project !== s.project) otherProject.add(m.name)
        const own = project ?? s.project
        if (own) projects.add(own)
      }
    }
  }
  const names = new Set(projectsOf.keys())
  for (const name of otherProject) names.delete(name)
  const foreignProjects = new Set<string>()
  for (const folder of otherFolders) {
    const project = composeDefaultProject(folder)
    if (project) foreignProjects.add(project)
  }
  for (const c of allContainers) {
    if (inBundle.has(c.id)) continue
    for (const m of c.mounts) if (m.name) names.delete(m.name)
    const project = c.labels[COMPOSE_PROJECT_LABEL]
    if (project) foreignProjects.add(project)
  }
  for (const name of [...names]) {
    if ([...projectsOf.get(name)!].some((p) => foreignProjects.has(p))) names.delete(name)
  }
  return [...names].sort()
}

const FATE_DECISIONS: Record<
  Exclude<FateResult['fate'], 'merged' | 'open'>,
  { code: DecideCode; detail: string }
> = {
  'closed-unmerged': {
    code: 'closed-unmerged',
    detail: 'The pull request was closed without being merged.'
  },
  'remote-gone': {
    code: 'remote-gone',
    detail: 'The remote branch is gone and no pull request records a merge.'
  },
  detached: {
    code: 'detached',
    detail: 'This worktree has a detached HEAD, so there is no branch to judge.'
  },
  unknown: {
    code: 'unknown-fate',
    detail: 'The state of the branch could not be determined (GitHub or the remote did not answer).'
  }
}

/**
 * First matching rule wins (master plan rules 1–11). Anything that could be someone's live
 * work is `alive`; anything uncertain is `decide`; only a strongly merged, clean, idle
 * worktree past its grace window is a `corpse`.
 */
export function bucketOf(
  f: BundleFacts,
  now: number,
  graceDays: number
): { bucket: Bucket; reason: DecideReason | null } {
  const alive = { bucket: 'alive' as const, reason: null }
  const decide = (code: DecideCode, detail: string): { bucket: Bucket; reason: DecideReason } => ({
    bucket: 'decide',
    reason: { code, detail }
  })

  if (f.isMainCheckout || f.neverClean) return alive
  if (f.session === 'working' || f.session === 'needs-input') return alive
  if (f.fate.fate === 'open') return alive
  // No sign of life at all is "unknown age", which must not read as "old enough". Neither
  // is a NaN, infinite or negative input: each would make the comparison below false.
  const known = (n: number | null): n is number => Number.isFinite(n) && (n as number) >= 0
  if (!known(f.lastSignOfLifeAt) || !known(graceDays) || !known(now)) return alive
  if (now - f.lastSignOfLifeAt < graceDays * DAY_MS) return alive
  if (f.keep) return alive

  if (f.session === 'open-idle')
    return decide('open-idle-session', 'A session is still open in this worktree, though idle.')
  // Only a session read as exactly `none` can be a corpse; anything else is not proven idle.
  if (f.session !== 'none')
    return decide('open-idle-session', 'The session state of this worktree is unknown.')

  if (f.sharedStackIds.length > 0) {
    const n = f.sharedStackIds.length
    return decide(
      'shared-stack',
      `${plural(n, 'other stack')} also ${n === 1 ? 'uses' : 'use'} this worktree: ${f.sharedStackIds.join(', ')}.`
    )
  }

  if (f.fate.fate !== 'merged') {
    const d = FATE_DECISIONS[f.fate.fate]
    return decide(d.code, d.detail)
  }

  if (!f.fate.strong)
    return decide(
      'weak-merge-signal',
      f.fate.signal === 'gh-merged'
        ? 'Merged by gh-merged, but the local tip differs from the PR head.'
        : `Merged only by the inferred signal ${f.fate.signal ?? 'unknown'}.`
    )

  const blockers = f.item.blockers
  if (blockers.includes('dirty') || blockers.includes('unpushed')) {
    const hit = ['dirty', 'unpushed'].filter((b) => blockers.includes(b))
    const detail = `${plural(hit.length, 'blocker')}: ${hit.join(', ')}.`
    return decide(hit[0] === 'dirty' ? 'dirty' : 'unpushed', detail)
  }
  // No blocker is not proof of clean: a status probe that failed leaves no blocker either.
  // Only a green local-clean checkpoint shows the tracked files were read and clean.
  if (f.item.checkpoints.find((c) => c.id === 'local-clean')?.state !== 'green')
    return decide('dirty', 'The working tree could not be verified clean.')

  return { bucket: 'corpse', reason: null }
}

export interface BuildBundlesInput {
  items: ReapItem[]
  /** Facts and the real local tip per item id. Missing entry → fate `unknown` (fail closed). */
  fateInputs: Map<string, { facts: BranchFacts; localTip: string | null }>
  stacks: StackGroup[]
  /** Path the shell attributed a stack to, by stack id. */
  stackPaths: Map<string, string>
  containers: InspectedContainer[]
  sessions: Map<string, { presence: SessionPresence; lastActivityAt: number | null }>
  keep: Set<string>
  neverClean: Set<string>
  now: number
  graceDays: number
  /** Containers Harnu itself stopped; their stop is not a sign of life. */
  harnuStoppedAt?: ReadonlyMap<string, number>
  /** Volume facts from `docker system df -v`, for the cross-project rule in ownedVolumes. */
  volumes?: ReadonlyMap<string, VolumeFact>
  /**
   * Folders Harnu knows besides the items' own paths and repo paths (sidebar folders, say).
   * A volume whose project is the Compose default name of any of them is never owned.
   */
  knownFolders?: string[]
}

/** Merge time from the `pr-merged` checkpoint detail; anything that is not a date is ignored. */
function mergedAtOf(item: ReapItem): number | null {
  const detail = item.checkpoints.find((c) => c.id === 'pr-merged')?.detail
  if (!detail) return null
  const t = Date.parse(detail)
  return Number.isFinite(t) ? t : null
}

/**
 * Every folder one container touches: its compose working dir AND the source of each bind
 * mount. A stack run from elsewhere that bind-mounts a worktree still uses it, so trashing
 * the folder would pull files from under a running container. The builder and the
 * execution-time reprobe both call this, so a stack the scan attributed to a worktree is
 * seen by the reprobe through the same rule. Empty means nothing ties it to a folder.
 */
export function containerFolders(c: InspectedContainer, platform: string): string[] {
  const out = new Set<string>()
  const dir = c.labels[COMPOSE_WORKING_DIR_LABEL]
  if (dir) out.add(normalizePath(dir, platform))
  for (const m of c.mounts) {
    if (m.type === 'bind' && m.source) out.add(normalizePath(m.source, platform))
  }
  return [...out]
}

/**
 * Every folder a stack runs from: each container's folders plus the path the shell
 * attributed it to. `groupStacks` merges by compose project NAME, so two worktrees with
 * the same project name arrive as one stack with several working dirs.
 */
function stackFolders(
  stack: StackGroup,
  stackPaths: Map<string, string>,
  platform: string
): string[] {
  const out = new Set<string>()
  for (const c of stack.containers) for (const d of containerFolders(c, platform)) out.add(d)
  const attributed = stackPaths.get(stack.id)
  if (attributed) out.add(normalizePath(attributed, platform))
  return [...out]
}

const PRESENCE_RANK: Record<SessionPresence, number> = {
  none: 0,
  'open-idle': 1,
  'needs-input': 2,
  working: 2
}

type SessionEntry = BuildBundlesInput['sessions'] extends Map<string, infer V> ? V : never

/**
 * Every session that works in the worktree or in any folder under it: a session started in
 * `WT/api` is as alive as one in `WT`. The strongest presence wins and the latest activity
 * is kept. Containment is by path segment, so a sibling `WT-other` never counts.
 */
function sessionOf(
  sessions: BuildBundlesInput['sessions'],
  path: string,
  platform: string
): SessionEntry | undefined {
  let out: SessionEntry | undefined
  for (const [folder, s] of sessions) {
    if (!isInside(normalizePath(folder, platform), path)) continue
    const activity = [out?.lastActivityAt ?? null, s.lastActivityAt].filter(
      (t): t is number => t !== null
    )
    out = {
      presence:
        out && PRESENCE_RANK[out.presence] >= PRESENCE_RANK[s.presence] ? out.presence : s.presence,
      lastActivityAt: activity.length > 0 ? Math.max(...activity) : null
    }
  }
  return out
}

export function buildBundles(input: BuildBundlesInput): WorktreeBundle[] {
  const platform = process.platform
  const stoppedByHarnu = input.harnuStoppedAt ?? new Map<string, number>()

  const folders = input.items
    .filter((i) => (i.kind === 'worktree' || i.kind === 'detached-worktree') && i.path)
    .map((item) => ({ item, path: normalizePath(item.path as string, platform) }))

  // A stack is exclusive to a bundle only if EVERY folder it runs from is inside that
  // bundle. If a stack touches a bundle but also runs from outside it, or two bundles both
  // claim it outright (nested paths), nobody may remove it: it is shared.
  const exclusive = new Map<string, StackGroup[]>()
  const shared = new Map<string, string[]>()
  for (const stack of input.stacks) {
    const dirs = stackFolders(stack, input.stackPaths, platform)
    if (dirs.length === 0) continue
    const full: string[] = []
    const partial: string[] = []
    for (const f of folders) {
      const inside = dirs.filter((d) => isInside(d, f.path)).length
      if (inside === dirs.length) full.push(f.item.id)
      else if (inside > 0) partial.push(f.item.id)
    }
    if (full.length === 1 && partial.length === 0) {
      exclusive.set(full[0]!, [...(exclusive.get(full[0]!) ?? []), stack])
    } else {
      for (const id of [...full, ...partial]) shared.set(id, [...(shared.get(id) ?? []), stack.id])
    }
  }

  const neverClean = new Set([...input.neverClean].map((p) => normalizePath(p, platform)))

  // Every folder that could share a compose project with a bundle: each item's checkout and
  // its repo's main checkout, plus whatever else the caller knows about.
  const knownFolders = new Set(
    [
      ...input.items.flatMap((i) => (i.path ? [i.path, i.repoPath] : [i.repoPath])),
      ...(input.knownFolders ?? [])
    ].map((p) => normalizePath(p, platform))
  )

  return folders.map(({ item, path }) => {
    const fateInput = input.fateInputs.get(item.id)
    const fate: FateResult =
      item.kind === 'detached-worktree'
        ? resolveDetachedFate()
        : fateInput
          ? resolveFate(fateInput.facts, fateInput.localTip)
          : { fate: 'unknown', signal: null, strong: false }

    const stacks = exclusive.get(item.id) ?? []
    // Normalized, so a trailing slash must not hide a session, and a session in a subfolder
    // counts too.
    const session = sessionOf(input.sessions, path, platform)
    const events = lastContainerEvent(
      stacks.flatMap((s) => s.containers),
      stoppedByHarnu
    )
    const signs = [mergedAtOf(item), session?.lastActivityAt ?? null, events].filter(
      (t): t is number => t !== null
    )

    const facts: BundleFacts = {
      item,
      fate,
      session: session?.presence ?? 'none',
      lastSignOfLifeAt: signs.length > 0 ? Math.max(...signs) : null,
      stackIds: stacks.map((s) => s.id),
      sharedStackIds: shared.get(item.id) ?? [],
      ownedVolumes: ownedVolumes(
        stacks,
        input.containers,
        input.volumes,
        [...knownFolders].filter((f) => f !== path)
      ),
      depsBytes: item.hydration?.reclaimableBytes ?? null,
      keep: input.keep.has(item.id),
      neverClean: neverClean.has(path) || neverClean.has(normalizePath(item.repoPath, platform)),
      isMainCheckout: path === normalizePath(item.repoPath, platform),
      localTip:
        item.kind === 'detached-worktree' ? (item.headSha ?? null) : (fateInput?.localTip ?? null),
      graceDays: input.graceDays
    }
    return { ...facts, ...bucketOf(facts, input.now, input.graceDays) }
  })
}
